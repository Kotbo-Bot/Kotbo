/**
 * Jeu de données d'arnaques alimenté par le honeypot : enregistrement local,
 * promotion en global au-delà de GLOBAL_PROMOTION_GUILDS serveurs, et
 * correspondance (domaine avec sous-domaines, texte copié-collé).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

type Row = Record<string, any>;

/** Table en mémoire qui implémente juste ce que le service appelle. */
function fakeTable() {
  const rows: Row[] = [];
  let nextId = 1;
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not;
      return row[key] === value;
    });

  return {
    rows,
    findMany: async ({ where, select, distinct }: Row = {}) => {
      let found = rows.filter((r) => matches(r, where));
      if (distinct?.[0]) {
        const seen = new Set<unknown>();
        found = found.filter((r) => (seen.has(r[distinct[0]]) ? false : (seen.add(r[distinct[0]]), true)));
      }
      return select ? found.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : found;
    },
    findFirst: async ({ where }: Row) => rows.find((r) => matches(r, where)) ?? null,
    create: async ({ data }: Row) => {
      const row = { id: String(nextId++), hits: 1, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: Row) => {
      const row = rows.find((r) => r.id === where.id)!;
      if (data.hits?.increment) row.hits += data.hits.increment;
      return row;
    },
  };
}

const prismaMock = {
  scamDomain: fakeTable(),
  scamTextSample: fakeTable(),
  scamImageHash: fakeTable(),
};
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} };

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({ default: prismaMock }));
  mock.module(path.resolve(import.meta.dir, `../../utils/logger.${extension}`), () => ({
    logger: silentLogger,
    default: silentLogger,
  }));
}

const {
  GLOBAL_PROMOTION_GUILDS,
  clearScamDatasetCaches,
  findKnownScamDomain,
  findKnownScamText,
  promoteImageIfWidespread,
  recordScamSignals,
} = await import('../../services/moderation/scamDatasetService.js');

const FAKE_GIVEAWAY =
  'MrBeast is giving away $3,500 to everyone who registers on his crypto casino. Go to sedowin.com and enter promo code TAKE, hurry limited time';

beforeEach(() => {
  prismaMock.scamDomain.rows.length = 0;
  prismaMock.scamTextSample.rows.length = 0;
  prismaMock.scamImageHash.rows.length = 0;
  clearScamDatasetCaches();
});

describe('recordScamSignals', () => {
  test('enregistre le domaine et le texte d’un message piégé', async () => {
    const result = await recordScamSignals('g1', FAKE_GIVEAWAY);

    expect(result.domains).toEqual(['sedowin.com']);
    expect(result.textRecorded).toBe(true);
    expect(prismaMock.scamDomain.rows).toHaveLength(1);
    expect(prismaMock.scamTextSample.rows[0].signals).toContain('promo_code');
  });

  test('enregistre un faux recrutement, qui n’a pourtant aucun domaine', async () => {
    const text =
      "Infos pour les personnes sans emploi : il vous suffit d'un ordinateur pour générer un revenu convenable. " +
      'Envoyez-moi un message privé en précisant votre nationalité.';
    const result = await recordScamSignals('g1', text);

    expect(result).toEqual({ domains: [], textRecorded: true });
    expect(prismaMock.scamTextSample.rows[0].signals).toEqual(expect.arrayContaining(['income_promise', 'dm_lure']));
    expect(await findKnownScamText('g1', text.replace('ordinateur', 'ORDINATEUR'))).toBe(true);
  });

  test('incrémente le compteur au lieu de dupliquer', async () => {
    await recordScamSignals('g1', FAKE_GIVEAWAY);
    await recordScamSignals('g1', FAKE_GIVEAWAY);

    expect(prismaMock.scamDomain.rows).toHaveLength(1);
    expect(prismaMock.scamDomain.rows[0].hits).toBe(2);
  });

  test('n’apprend ni domaine courant ni message générique', async () => {
    const result = await recordScamSignals('g1', 'regarde https://youtube.com/watch?v=1');
    expect(result).toEqual({ domains: [], textRecorded: false });

    await recordScamSignals('g1', 'hello tout le monde, bien le bonjour à tous les membres du serveur');
    expect(prismaMock.scamTextSample.rows).toHaveLength(0);
  });

  test('l’OCR n’enregistre pas un bruit de lecture qui ressemble à un domaine', async () => {
    const result = await recordScamSignals('g1', 'x w.to y m.in sedowin.com', 'OCR');
    expect(result.domains).toEqual(['sedowin.com']);
  });
});

describe('promotion en global', () => {
  test('un domaine devient global au seuil de serveurs distincts', async () => {
    for (let i = 1; i < GLOBAL_PROMOTION_GUILDS; i++) await recordScamSignals(`g${i}`, FAKE_GIVEAWAY);
    expect(prismaMock.scamDomain.rows.some((r) => r.guildId === null)).toBe(false);

    await recordScamSignals(`g${GLOBAL_PROMOTION_GUILDS}`, FAKE_GIVEAWAY);
    const global = prismaMock.scamDomain.rows.filter((r) => r.guildId === null);
    expect(global).toHaveLength(1);
    expect(global[0].source).toBe('PROMOTED');
  });

  test('un seul serveur qui répète ne suffit pas', async () => {
    for (let i = 0; i < 10; i++) await recordScamSignals('g1', FAKE_GIVEAWAY);
    expect(prismaMock.scamDomain.rows.some((r) => r.guildId === null)).toBe(false);
  });

  test('ne crée pas de doublon global', async () => {
    for (let i = 1; i <= GLOBAL_PROMOTION_GUILDS + 2; i++) await recordScamSignals(`g${i}`, FAKE_GIVEAWAY);
    expect(prismaMock.scamDomain.rows.filter((r) => r.guildId === null)).toHaveLength(1);
  });

  test('une image vue sur assez de serveurs devient globale', async () => {
    for (let i = 1; i <= GLOBAL_PROMOTION_GUILDS; i++) {
      await prismaMock.scamImageHash.create({ data: { guildId: `g${i}`, hash: 'abc', phash: '0f0f' } });
    }
    await promoteImageIfWidespread('abc', '0f0f', 'scam.png');
    expect(prismaMock.scamImageHash.rows.filter((r) => r.guildId === null)).toHaveLength(1);
  });
});

describe('correspondance', () => {
  test('reconnaît un domaine appris sur le serveur, sous-domaine compris', async () => {
    await recordScamSignals('g1', FAKE_GIVEAWAY);

    expect(await findKnownScamDomain('g1', 'viens sur https://go.sedowin.com/x')).toBe('sedowin.com');
    expect(await findKnownScamDomain('g1', 'sedowin.com')).toBe('sedowin.com');
  });

  test('un domaine appris ailleurs ne vaut pas sans promotion', async () => {
    await recordScamSignals('g1', FAKE_GIVEAWAY);
    expect(await findKnownScamDomain('g2', 'https://sedowin.com')).toBeNull();
  });

  test('un domaine global protège tous les serveurs', async () => {
    for (let i = 1; i <= GLOBAL_PROMOTION_GUILDS; i++) await recordScamSignals(`g${i}`, FAKE_GIVEAWAY);
    expect(await findKnownScamDomain('autre-serveur', 'https://sedowin.com')).toBe('sedowin.com');
  });

  test('ne confond pas un domaine voisin', async () => {
    await recordScamSignals('g1', FAKE_GIVEAWAY);
    expect(await findKnownScamDomain('g1', 'https://notsedowin.com')).toBeNull();
  });

  test('reconnaît un texte recopié avec un autre montant et un autre lien', async () => {
    await recordScamSignals('g1', FAKE_GIVEAWAY);
    const variant =
      'mrbeast IS GIVING AWAY $9,000 to everyone who registers on his crypto casino. Go to https://other-site.xyz and enter promo code TAKE, hurry limited time';
    expect(await findKnownScamText('g1', variant)).toBe(true);
  });

  test('un texte court ne peut jamais correspondre', async () => {
    expect(await findKnownScamText('g1', 'hello')).toBe(false);
  });
});
