import { describe, expect, test } from 'bun:test';
import { OverwriteType, PermissionFlagsBits, type VoiceChannel } from 'discord.js';
import {
  appliquerVisibilite, autorisesDuSalon, bloquesDuSalon, normaliserVisibilite, planVisibilite, type Visibilite,
} from '../../events/tempVoiceVisibilite.js';

const EVERYONE = '100000000000000000';
const PROPRIO = '200000000000000000';
const AMI = '300000000000000000';
const BLOQUE = '310000000000000000';
const ROLE = '520000000000000000';
const BOT = '999000000000000000';
const View = PermissionFlagsBits.ViewChannel;
const Connect = PermissionFlagsBits.Connect;

const base = { everyoneId: EVERYONE, proprietaireId: PROPRIO, autorises: [AMI], bloques: [], rolesOffice: [ROLE] };

describe('planVisibilite', () => {
  const cas: Array<[Visibilite, boolean, boolean]> = [
    ['tous', false, true], ['tous', true, true],
    ['acces', false, true], ['acces', true, false],
    ['prive', false, false], ['prive', true, false],
  ];
  for (const [visibilite, verrouille, attendu] of cas) {
    test(`${visibilite} / ${verrouille ? 'verrouillé' : 'ouvert'} => everyone ${attendu}`, () => {
      expect(planVisibilite({ ...base, visibilite, verrouille }).everyoneVoit).toBe(attendu);
    });
  }

  test('caché : propriétaire, autorisés et rôles d\'office voient', () => {
    const r = planVisibilite({ ...base, visibilite: 'prive', verrouille: false });
    expect(r.voient.sort()).toEqual([AMI, PROPRIO, ROLE].sort());
  });

  test('propriétaire toujours visible en privé', () => {
    const r = planVisibilite({ ...base, visibilite: 'prive', verrouille: true, autorises: [], rolesOffice: [] });
    expect(r.voient).toEqual([PROPRIO]);
  });

  test('un bloqué ne voit jamais, même autorisé ou rôle d\'office', () => {
    for (const visibilite of ['tous', 'acces', 'prive'] as const) {
      const r = planVisibilite({ ...base, visibilite, verrouille: true, bloques: [AMI, ROLE] });
      expect(r.nevoientPas).toEqual([AMI, ROLE]);
      expect(r.voient).not.toContain(AMI);
      expect(r.voient).not.toContain(ROLE);
    }
  });
});

describe('normaliserVisibilite', () => {
  test('valeurs valides, inconnues et défaut', () => {
    expect(normaliserVisibilite('prive')).toBe('prive');
    expect(normaliserVisibilite('n’importe quoi')).toBe('tous');
    expect(normaliserVisibilite(undefined, 'acces')).toBe('acces');
  });
});

type Surch = { id: string; type: OverwriteType; allow?: bigint; deny?: bigint };
function faux(surcharges: Surch[], categorie: Surch[] = []) {
  const appels: Array<{ id: string; patch: Record<string, boolean | null>; type?: OverwriteType }> = [];
  const cache = new Map(surcharges.map((s) => [s.id, {
    id: s.id, type: s.type,
    allow: { has: (b: bigint) => ((s.allow ?? 0n) & b) === b },
    deny: { has: (b: bigint) => ((s.deny ?? 0n) & b) === b },
  }]));
  const parentCache = new Map(categorie.map((s) => [s.id, { id: s.id, type: s.type, allow: s.allow ?? 0n, deny: s.deny ?? 0n }]));
  const channel = {
    id: 'c1',
    guild: { id: EVERYONE, members: { me: { id: BOT } } },
    parent: categorie.length ? { permissionOverwrites: { cache: parentCache } } : null,
    permissionOverwrites: {
      cache,
      edit: async (id: string, patch: Record<string, boolean | null>, opts?: { type?: OverwriteType }) => {
        appels.push({ id, patch, type: opts?.type });
      },
    },
  } as unknown as VoiceChannel;
  return { channel, appels };
}

const sal = [
  { id: EVERYONE, type: OverwriteType.Role, deny: Connect },
  { id: PROPRIO, type: OverwriteType.Member, allow: Connect },
  { id: AMI, type: OverwriteType.Member, allow: Connect },
  { id: BLOQUE, type: OverwriteType.Member, deny: View },
  { id: BOT, type: OverwriteType.Member, allow: Connect },
];

describe('lecture du salon', () => {
  test('autorisés et bloqués, hors propriétaire et bot', () => {
    const { channel } = faux(sal);
    expect(autorisesDuSalon(channel, PROPRIO)).toEqual([AMI]);
    expect(bloquesDuSalon(channel)).toEqual([BLOQUE]);
  });
});

describe('appliquerVisibilite', () => {
  test('prive sur salon verrouillé : cache @everyone, montre les siens, bloque le banni', async () => {
    const { channel, appels } = faux(sal);
    await appliquerVisibilite(channel, 'prive', { proprietaireId: PROPRIO, rolesOffice: [ROLE] });
    expect(appels).toContainEqual({ id: EVERYONE, patch: { ViewChannel: false }, type: OverwriteType.Role });
    expect(appels).toContainEqual({ id: PROPRIO, patch: { ViewChannel: true }, type: OverwriteType.Member });
    expect(appels).toContainEqual({ id: AMI, patch: { ViewChannel: true }, type: OverwriteType.Member });
    expect(appels).toContainEqual({ id: ROLE, patch: { ViewChannel: true }, type: OverwriteType.Role });
    // BLOQUE a déjà deny ViewChannel : rien à écrire. Jamais de bit autre que ViewChannel.
    expect(appels.some((a) => a.id === BLOQUE)).toBe(false);
    expect(appels.every((a) => Object.keys(a.patch).join() === 'ViewChannel')).toBe(true);
  });

  test('tous sur salon caché : retire le refus de @everyone, n\'écrit rien d\'autre', async () => {
    const { channel, appels } = faux([{ id: EVERYONE, type: OverwriteType.Role, deny: View }]);
    await appliquerVisibilite(channel, 'tous', { proprietaireId: PROPRIO, rolesOffice: [] });
    expect(appels).toEqual([{ id: EVERYONE, patch: { ViewChannel: null }, type: OverwriteType.Role }]);
  });

  test('tous dans une catégorie qui cache le salon : rend le refus de la catégorie, pas null', async () => {
    const { channel, appels } = faux([{ id: EVERYONE, type: OverwriteType.Role, deny: View }], [{ id: EVERYONE, type: OverwriteType.Role, deny: View }]);
    await appliquerVisibilite(channel, 'acces', { proprietaireId: PROPRIO, rolesOffice: [] });
    // Déjà refusé, comme la catégorie : rien à réécrire, surtout pas un null qui ouvrirait le salon.
    expect(appels.some((a) => a.id === EVERYONE)).toBe(false);
  });

  test('rien ne change : aucun appel', async () => {
    const { channel, appels } = faux([]);
    await appliquerVisibilite(channel, 'tous', { proprietaireId: PROPRIO, rolesOffice: [] });
    expect(appels).toEqual([]);
  });

  test('un bloqué autorisé reste caché même en privé', async () => {
    const { channel, appels } = faux([
      { id: EVERYONE, type: OverwriteType.Role },
      { id: AMI, type: OverwriteType.Member, allow: Connect, deny: View },
    ]);
    await appliquerVisibilite(channel, 'prive', { proprietaireId: PROPRIO, rolesOffice: [] });
    expect(appels.some((a) => a.id === AMI && a.patch.ViewChannel === true)).toBe(false);
  });
});
