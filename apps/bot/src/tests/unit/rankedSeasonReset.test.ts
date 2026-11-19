// Base simulée avec les garanties de Postgres et de Prisma : réplique en retard
// sur la primaire, transaction interactive annulée en entier passé son délai.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { resolveRankedTier } from '@kotbo/shared';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = 'guilde-classee';

type MemberRow = {
  id: string;
  guildId: string;
  userId: string;
  rp: number;
  peakRp: number;
  bestStreak: number;
  tierKey: string | null;
  peakTierKey: string | null;
  previousTierKey: string | null;
  lastDecayDate: Date | null;
};

let members: MemberRow[] = [];
/** Lignes figées par la réplique, en retard sur la primaire ; `null` quand elle est à jour. */
let replique: MemberRow[] | null = null;

function member(index: number, rp: number): MemberRow {
  const tier = resolveRankedTier(rp).key;
  return {
    id: `membre-${index}`,
    guildId: GUILD_ID,
    userId: `user-${String(index).padStart(4, '0')}`,
    rp,
    peakRp: rp,
    bestStreak: 0,
    tierKey: tier,
    peakTierKey: tier,
    previousTierKey: null,
    lastDecayDate: null,
  };
}

type RpFilter = { gt?: number; gte?: number; lt?: number; lte?: number };

function matchesRp(row: MemberRow, where: { guildId?: string; rp?: RpFilter; tierKey?: { not: string } }): boolean {
  if (where.guildId !== undefined && row.guildId !== where.guildId) return false;
  if (where.tierKey !== undefined && row.tierKey === where.tierKey.not) return false;
  if (where.rp?.gt !== undefined && !(row.rp > where.rp.gt)) return false;
  if (where.rp?.gte !== undefined && !(row.rp >= where.rp.gte)) return false;
  if (where.rp?.lt !== undefined && !(row.rp < where.rp.lt)) return false;
  if (where.rp?.lte !== undefined && !(row.rp <= where.rp.lte)) return false;
  return true;
}

const lireMembres = (lignes: () => MemberRow[]) =>
  mock(async (args: { where: { guildId: string; rp?: RpFilter }; take?: number }) =>
    lignes()
      .filter((row) => matchesRp(row, args.where))
      .sort((a, b) => b.rp - a.rp || a.userId.localeCompare(b.userId))
      .slice(0, args.take ?? lignes().length)
      .map((row) => ({ ...row })));

/** Seule requête brute attendue ; toute autre échoue au lieu d'être ignorée. */
const REDUCTION_SOFT = 'UPDATE "ranked_members" SET "rp" = floor("rp" * ?::float8), "peakRp" = floor("rp" * ?::float8), '
  + '"peakTierKey" = NULL, "previousTierKey" = NULL, "lastDecayDate" = NULL WHERE "guildId" = ? AND "rp" > 0';

/** Un aller-retour vers la base, et le délai par défaut d'une transaction interactive Prisma. */
const ALLER_RETOUR_MS = 1;
const DELAI_TRANSACTION_MS = 5_000;

const prismaMock = {
  rankedConfig: { findUnique: mock(async () => ({ guildId: GUILD_ID, ladder: null })) },
  rankedMember: {
    findMany: lireMembres(() => members),
    update: mock(async ({ where, data }: { where: { id: string }; data: Partial<MemberRow> }) => {
      const row = members.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('membre introuvable');
      Object.assign(row, data);
      return { ...row };
    }),
    updateMany: mock(async ({ where, data }: { where: { guildId: string; rp?: RpFilter; tierKey?: { not: string } }; data: Partial<MemberRow> }) => {
      const hit = members.filter((row) => matchesRp(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }),
  },
  rankedSeasonEntry: { createMany: mock(async ({ data }: { data: unknown[] }) => ({ count: data.length })) },
  // Évaluée comme Postgres : sur les lignes courantes de la primaire, `peakRp` partant de l'ancien RP.
  $executeRaw: mock(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    const texte = sql.join('?').replace(/\s+/g, ' ').trim();
    if (texte !== REDUCTION_SOFT) throw new Error(`requête brute inattendue : ${texte}`);
    const [ratioRp, ratioPic, guildId] = values as [number, number, string];
    const hit = members.filter((row) => row.guildId === guildId && row.rp > 0);
    for (const row of hit) {
      const rp = row.rp;
      Object.assign(row, {
        rp: Math.floor(rp * ratioRp),
        peakRp: Math.floor(rp * ratioPic),
        peakTierKey: null,
        previousTierKey: null,
        lastDecayDate: null,
      });
    }
    return hit.length;
  }),
  // Chaque requête coûte un aller-retour ; passé le délai, Prisma refuse la
  // suivante et toute la transaction est annulée.
  $transaction: mock(async (fn: (tx: unknown) => unknown, options?: { timeout?: number }) => {
    const avant = structuredClone(members);
    const delai = options?.timeout ?? DELAI_TRANSACTION_MS;
    let ecoule = 0;
    const facture = <A extends unknown[], R>(requete: (...args: A) => R) => (...args: A): R => {
      ecoule += ALLER_RETOUR_MS;
      if (ecoule > delai) throw new Error(`Transaction already closed: timeout ${delai} ms dépassé`);
      return requete(...args);
    };
    const tx = {
      rankedMember: {
        findMany: facture(prismaMock.rankedMember.findMany),
        update: facture(prismaMock.rankedMember.update),
        updateMany: facture(prismaMock.rankedMember.updateMany),
      },
      rankedSeasonEntry: { createMany: facture(prismaMock.rankedSeasonEntry.createMany) },
      $executeRaw: facture(prismaMock.$executeRaw),
    };
    try {
      return await fn(tx);
    } catch (err) {
      members = avant;
      throw err;
    }
  }),
};

const repliqueMock = {
  rankedConfig: prismaMock.rankedConfig,
  rankedMember: { findMany: lireMembres(() => replique ?? members) },
};

const dbSource = path.resolve(import.meta.dir, '../../utils/db.ts');
for (const suffixe of ['.ts', '.js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db${suffixe}`), () =>
    completeModuleMock(dbSource, { default: prismaMock, prisma: prismaMock, prismaRead: repliqueMock }));
}

const { closeRankedSeason } = await import('../../services/progression/ranked/rankedSeasonService.js');

beforeEach(() => {
  // 500 membres en tête du classement, puis deux membres classés au-delà.
  members = Array.from({ length: 500 }, (_, index) => member(index, 3_000 + (500 - index)));
  members.push(member(500, 1_200), member(501, 400), member(502, 0));
  replique = null;
});

describe('remise à zéro soft d\'une saison RP', () => {
  test('les membres classés au-delà du 500e perdent aussi leur RP selon le ratio', async () => {
    const result = await closeRankedSeason(null, GUILD_ID, 'saison-1', { mode: 'SOFT', keepRatio: 0.25 });

    expect(members[500]).toMatchObject({ rp: 300, peakRp: 300, tierKey: resolveRankedTier(300).key, peakTierKey: null });
    expect(members[501].rp).toBe(100);
    // Le haut du classement suit toujours le même ratio.
    expect(members[0].rp).toBe(Math.floor(3_500 * 0.25));

    // L'archivage reste borné aux 500 premiers ; la remise à zéro couvre les 502 classés.
    expect(result).toMatchObject({ archived: 500, reset: 502 });
  });

  test('un gros serveur : la clôture tient dans le délai de la transaction', async () => {
    members.push(...Array.from({ length: 6_000 }, (_, index) => member(1_000 + index, 800 + index)));

    const result = await closeRankedSeason(null, GUILD_ID, 'saison-1', { mode: 'SOFT', keepRatio: 0.25 });

    expect(result.reset).toBe(6_502);
    const dernier = members[members.length - 1];
    expect(dernier).toMatchObject({ rp: Math.floor(6_799 * 0.25), tierKey: resolveRankedTier(Math.floor(6_799 * 0.25)).key });
    expect(members.every((row) => row.tierKey === resolveRankedTier(row.rp).key)).toBe(true);
  });

  test('le RP gagné depuis la dernière copie de la réplique est réduit, pas écrasé', async () => {
    // La réplique a figé le classement avant le dernier gain de user-0500.
    replique = structuredClone(members);
    members[500].rp = 2_000;

    await closeRankedSeason(null, GUILD_ID, 'saison-1', { mode: 'SOFT', keepRatio: 0.25 });

    expect(members[500]).toMatchObject({ rp: 500, peakRp: 500, tierKey: resolveRankedTier(500).key });
  });
});
