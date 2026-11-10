import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { OverwriteType, PermissionFlagsBits, type VoiceChannel } from 'discord.js';

// La base est une mémoire : ce que enregistrer écrit, lire le relit (vraie forme JSON, aller-retour).
let base = new Map<string, unknown>();
type Cle = { guildId: string; userId: string };
const cle = (w: Cle) => `${w.guildId}:${w.userId}`;
const prismaMock = {
  memberProfile: {
    findUnique: mock(async ({ where }: { where: { guildId_userId: Cle } }) => {
      const v = base.get(cle(where.guildId_userId));
      return v === undefined ? null : { tempVoiceSavedSettings: v };
    }),
    upsert: mock(async ({ where, update }: { where: { guildId_userId: Cle }; update: { tempVoiceSavedSettings: unknown } }) => {
      base.set(cle(where.guildId_userId), JSON.parse(JSON.stringify(update.tempVoiceSavedSettings)));
      return {};
    }),
    updateMany: mock(async ({ where }: { where: Cle }) => {
      if (base.has(cle(where))) base.set(cle(where), null);
      return { count: 1 };
    }),
  },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock }));
}

const {
  capturerReglages, embedRecapReglages, enregistrerReglagesPerso,
  lireReglagesPerso, normaliserReglagesPerso, oublierReglagesPerso,
} = await import('../../events/tempVoiceReglagesPerso.js');

const GUILD = '100000000000000000';
const PROPRIO = '200000000000000000';
const AMI = '300000000000000000';
const BLOQUE = '310000000000000000';
const BOT = '999000000000000000';
const View = PermissionFlagsBits.ViewChannel;
const Connect = PermissionFlagsBits.Connect;

type Entree = { id: string; type: OverwriteType; allow: bigint; deny: bigint };

/** Faux salon en lecture seule : la capture ne lit que les surcharges. L'application se teste sur le banc (tempVoiceReglagesParcours). */
function salon(nom: string, limite: number, init: Array<{ id: string; type: OverwriteType; allow?: bigint; deny?: bigint }>) {
  const etat = new Map<string, Entree>(init.map((s) => [s.id, { id: s.id, type: s.type, allow: s.allow ?? 0n, deny: s.deny ?? 0n }]));
  const vue = (e?: Entree) => e && ({
    id: e.id, type: e.type,
    allow: { has: (b: bigint) => (e.allow & b) === b },
    deny: { has: (b: bigint) => (e.deny & b) === b },
  });
  const cache = {
    get: (id: string) => vue(etat.get(id)),
    [Symbol.iterator]: function* () { for (const [id, e] of etat) yield [id, vue(e)] as const; },
  };
  return {
    channel: { id: 'c', name: nom, userLimit: limite, guild: { id: GUILD, members: { me: { id: BOT } } }, permissionOverwrites: { cache } } as unknown as VoiceChannel,
  };
}

const source = () => salon('Salon de Lune', 5, [
  { id: GUILD, type: OverwriteType.Role, deny: Connect },
  { id: PROPRIO, type: OverwriteType.Member, allow: Connect },
  { id: AMI, type: OverwriteType.Member, allow: Connect },
  { id: BLOQUE, type: OverwriteType.Member, deny: View | Connect },
  { id: BOT, type: OverwriteType.Member, allow: Connect },
]);

beforeEach(() => { base = new Map(); });

describe('capture -> enregistrement -> lecture', () => {
  test('capture nom, limite, verrou, bloqués, autorisés, visibilité ; la base les rend à l identique', async () => {
    const r = capturerReglages(source().channel, PROPRIO, 'prive', 'inVoice');
    expect(r).toEqual({ nom: 'Salon de Lune', limite: 5, verrouille: true, visibilite: 'prive', bloques: [BLOQUE], autorises: [AMI], modeEcriture: 'inVoice' });

    await enregistrerReglagesPerso(GUILD, PROPRIO, r);
    expect(await lireReglagesPerso(GUILD, PROPRIO)).toEqual(r);
  });
});

describe('normaliserReglagesPerso', () => {
  test('rejette ids non numériques, limite hors bornes, nom trop long ; null si pas un objet', () => {
    expect(normaliserReglagesPerso('{corrompu')).toBeNull();
    expect(normaliserReglagesPerso(null)).toBeNull();
    expect(normaliserReglagesPerso([1])).toBeNull();
    const r = normaliserReglagesPerso({
      nom: 'x'.repeat(101), limite: 100, verrouille: 'oui', visibilite: 'zzz',
      bloques: ['123', 'abc', 42, '1; DROP'], autorises: ['456', '123'], modeEcriture: 'nimporte',
    })!;
    expect(r).toEqual({ nom: null, limite: 0, verrouille: false, visibilite: 'tous', bloques: ['123'], autorises: ['456'], modeEcriture: null });
    expect(normaliserReglagesPerso({ limite: 1.5 })!.limite).toBe(0);
  });
});

describe('oublier', () => {
  test('enregistrer puis oublier => lire donne null', async () => {
    await enregistrerReglagesPerso(GUILD, PROPRIO, capturerReglages(source().channel, PROPRIO, 'tous', null));
    expect(await lireReglagesPerso(GUILD, PROPRIO)).not.toBeNull();
    await oublierReglagesPerso(GUILD, PROPRIO);
    expect(await lireReglagesPerso(GUILD, PROPRIO)).toBeNull();
  });
});

describe('embedRecapReglages', () => {
  test('mentions <@id> et limite 0 => illimité', () => {
    const e = embedRecapReglages({ nom: 'N', limite: 0, verrouille: false, visibilite: 'acces', bloques: [BLOQUE], autorises: [], modeEcriture: null }, 'fr').toJSON();
    const v = (e.fields ?? []).map((f) => f.value);
    expect(v).toContain(`<@${BLOQUE}>`);
    expect(v).toContain('Illimité');
  });
});
