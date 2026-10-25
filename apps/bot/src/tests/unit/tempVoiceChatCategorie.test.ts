/**
 * Le chat d'un salon temporaire face à sa catégorie, à ses rôles et à ceux qui
 * sont en vocal, rejoué sur le banc (vrai discord.js, faux Discord) :
 *
 * - C : « mon ami est en vocal avec moi et ne peut pas écrire » — un test par
 *   scénario plausible, en panneau V1 et V2. Le verdict est le droit EFFECTIF
 *   d'écrire, calculé comme Discord sur l'état du faux serveur.
 * - A : « Hérité » suit les changements de la catégorie (écouteur, balayage,
 *   démarrage), une ligne de journal par catégorie et par vague.
 * - B : la règle se pose par rôle, les rôles administrateurs ne sont jamais
 *   touchés, et une exception par membre se règle depuis sa fiche.
 * - D : une navigation montre au plus deux messages, le panneau public et UN
 *   sous-panneau éphémère par membre, réécrit d'une porte à l'autre, avec
 *   « Retour » à chaque niveau.
 * - E : le propriétaire change le mode alors qu'un présent a une exception que
 *   ce mode contredit : un MP (Appliquer / Garder / Ne plus demander).
 */
import { describe, expect, mock, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import { Events, PermissionFlagsBits, type Client } from 'discord.js';

import { completeModuleMock } from '../helpers/moduleMock.js';
import { FauxDiscord, IDS, clesBrutes, suivreEcouteurs, textesVisibles } from '../helpers/bancDiscord.js';

type Brut = Record<string, any>;

const base = {
  salons: new Map<string, Record<string, unknown>>(),
  reglages: null as Record<string, unknown> | null,
  /** `tempVoiceWriteNoAsk` des profils, clé `${guildId}:${userId}`. */
  profils: new Map<string, unknown>(),
};

const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async () => (base.reglages ? { ...base.reglages } : null)),
    upsert: mock(async () => ({})),
  },
  tempVoiceAccessRequestConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
  dashboardAuditLog: { create: mock(async () => ({})) },
  memberProfile: {
    findUnique: mock(async (a: { where: { guildId_userId: { guildId: string; userId: string } } }) => {
      const cle = `${a.where.guildId_userId.guildId}:${a.where.guildId_userId.userId}`;
      return base.profils.has(cle) ? { tempVoiceWriteNoAsk: structuredClone(base.profils.get(cle)) } : null;
    }),
    upsert: mock(async (a: { where: { guildId_userId: { guildId: string; userId: string } }; update: { tempVoiceWriteNoAsk: unknown } }) => {
      base.profils.set(`${a.where.guildId_userId.guildId}:${a.where.guildId_userId.userId}`, structuredClone(a.update.tempVoiceWriteNoAsk));
      return {};
    }),
  },
  tempVoiceChannel: {
    findMany: mock(async () => [...base.salons.values()].map((s) => ({ ...s }))),
    findUnique: mock(async (a: { where: { id: string } }) => { const s = base.salons.get(a.where.id); return s ? { ...s } : null; }),
    create: mock(async (a: { data: Record<string, unknown> }) => {
      const ligne = { roleId: null, writeMode: null, renameHistory: [], accessRequests: [], ...a.data };
      base.salons.set(String(a.data.id), ligne);
      return ligne;
    }),
    update: mock(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      const s = base.salons.get(a.where.id);
      if (!s) throw new Error('Record to update not found');
      Object.assign(s, a.data);
      return { ...s };
    }),
    delete: mock(async (a: { where: { id: string } }) => { base.salons.delete(a.where.id); return {}; }),
  },
};

let configServeur: Record<string, unknown> = {};
interface LigneJournal { type: string; acteur: string; salons: string[]; champs: Array<{ name: string; value: string }> }
const journal: LigneJournal[] = [];

const mocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), {
    getCachedGuild: mock(async () => ({ ...configServeur })),
    cache: { invalidateGuild: mock(async () => undefined) },
  })],
  ['../../utils/logDispatch', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/logDispatch.ts'), {
    sendLogEmbed: mock(async (
      _g: unknown,
      embed: { toJSON: () => { fields?: Array<{ name: string; value: string }> } },
      type: string, _c: unknown, tag: string, salons: string[],
    ) => {
      journal.push({ type, acteur: tag, salons, champs: embed.toJSON().fields ?? [] });
    }),
  })],
];
for (const [relatif, fabrique] of mocks) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

const tv = await import('../../events/tempVoice.js');
const { logger } = await import('../../utils/logger.js');
const m = await import('../../lib/paraglide/messages.js');
(logger as unknown as Record<string, unknown>).info = () => undefined;
const avertissements: string[] = [];
{
  const warn = logger.warn.bind(logger);
  (logger as unknown as Record<string, unknown>).warn = (...a: unknown[]) => {
    avertissements.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    return (warn as (...b: unknown[]) => unknown)(...a);
  };
}
if (process.env.BANC_LOG) for (const n of ["warn", "error"] as const) { const o = logger[n].bind(logger); (logger as unknown as Record<string, unknown>)[n] = (...a: unknown[]) => { console.log("LOG", n, ...a); return (o as (...b: unknown[]) => unknown)(...a); }; }
(logger as unknown as Record<string, unknown>).success = () => undefined;

let maintenant = Date.now();
function avancer(ms: number) {
  maintenant += ms;
  setSystemTime(new Date(maintenant));
}

// ─── Scène ───

const P = PermissionFlagsBits;
const CAT = '900000000000000020';
const AMI = IDS.CIBLE;
const ROLE_MEMBRE = '900000000000000205';
const ENVOI = P.SendMessages.toString();
type Format = 'V1' | 'V2';
const FORMATS: Format[] = ['V1', 'V2'];

/** Catégorie où plus personne n'écrit : @everyone refusé (le rôle du bot garde l'écriture, comme sur un vrai serveur). */
const CAT_MUETTE: Brut[] = [
  { id: IDS.GUILD, type: 0, allow: '0', deny: ENVOI },
  { id: IDS.ROLE_BOT, type: 0, allow: ENVOI, deny: '0' },
];

interface Options {
  format: Format;
  /** Réglage `textChat` du générateur (défaut : « Hérité »). */
  textChat?: string;
  categorie?: Brut[];
  autoAllow?: string[];
  rolesAmi?: string[];
  /** Rôles supplémentaires du serveur. */
  roles?: Brut[];
  /** L'ami rejoint le salon dès sa création. */
  amiPresent?: boolean;
  langue?: 'fr' | 'en';
  mode?: 'CLASSIC' | 'FLAT';
  /** Appelé sur le monde juste avant que le propriétaire rejoigne le générateur. */
  avantCreation?: (w: FauxDiscord) => void;
}

interface Scene { monde: FauxDiscord; client: Client; salonId: string; enCours: Array<Promise<unknown>>; tv: typeof tv }

async function monter(o: Options): Promise<Scene> {
  base.salons.clear();
  base.profils.clear();
  base.reglages = {
    guildId: IDS.GUILD,
    canRename: true, canChangeLimit: true, canLock: true, canChangeWriteMode: true,
    canReserve: true, canKickOrBan: true, canTransfer: true,
    panelMode: o.mode ?? 'CLASSIC', panelComponents: o.format, stateLayout: 'GRID3', stateColors: 'NEUTRAL',
    reservationFallbackMode: 'ANY_ROLE', reservableRoleIds: [], panelCompactMode: false,
  };
  configServeur = {
    tempVoiceEnabled: true,
    tempVoiceChannelId: IDS.GEN,
    tempVoiceCategoryId: CAT,
    tempVoiceNameTemplate: 'Salon de {user}',
    tempVoiceDefaults: { textChat: o.textChat ?? 'inherit', autoAllowRoleIds: o.autoAllow ?? [] },
    moderatorRoleId: IDS.ROLE_MOD,
    language: o.langue ?? 'fr',
  };
  const w = new FauxDiscord({ latenceRestMs: 20, langueDiscord: 'fr' });
  for (const r of o.roles ?? []) w.roles.push({ color: 0, hoist: false, managed: false, mentionable: false, flags: 0, permissions: '0', position: 1, ...r });
  if (o.rolesAmi) w.membres.get(AMI)!.roles = [...o.rolesAmi];
  w.ajouterCategorie(CAT, o.categorie ?? []);
  const client = w.creerClient();
  const enCours = suivreEcouteurs(client);
  tv.registerTempVoiceListener(client);
  const avant = new Set(tv.tempChannels.keys());
  avancer(1_500);
  o.avantCreation?.(w);
  w.bouger(IDS.PROPRIO, IDS.GEN);
  await w.calme(enCours);
  const salonId = [...tv.tempChannels.keys()].find((id) => !avant.has(id));
  if (!salonId) throw new Error('salon non créé');
  if (o.amiPresent !== false) {
    avancer(1_500);
    w.bouger(AMI, salonId);
    await w.calme(enCours);
  }
  return { monde: w, client, salonId, enCours, tv };
}

/** Une interaction de composant par le vrai chemin discord.js, porteur éphémère fabriqué. */
async function cliquer(sc: Scene, customId: string, values?: string[], acteur: string = IDS.PROPRIO): Promise<void> {
  avancer(1_500);
  const w = sc.monde;
  const composant = values
    ? { type: 3, custom_id: customId, options: values.map((v) => ({ label: v, value: v })) }
    : { type: 2, style: 2, custom_id: customId, label: 'x' };
  const porteur = w.creerMessage(sc.salonId, { flags: 64, components: [{ type: 1, components: [composant] }] }, {
    interaction_metadata: { id: '1', type: 3, user: w.membres.get(acteur)!.user, authorizing_integration_owners: {} },
  });
  const brut = w.interactionBrute({ customId, genre: values ? 'menuTexte' : 'bouton', acteur, channelId: sc.salonId, message: porteur, values });
  (sc.client as unknown as { actions: { InteractionCreate: { handle: (d: unknown) => void } } }).actions.InteractionCreate.handle(brut);
  await w.calme(sc.enCours);
}

const choisirMode = (sc: Scene, mode: string) => cliquer(sc, 'tempvoice:mode_select', [mode]);
const ecrit = (sc: Scene, id: string) => sc.monde.peutEcrire(sc.salonId, id);

async function bouger(sc: Scene, id: string, vers: string | null) {
  avancer(1_500);
  sc.monde.bouger(id, vers);
  await sc.monde.calme(sc.enCours);
}

let generation = 0;
/** Nouveau module, nouveau client : seul ce qui est sur Discord et en base survit. */
async function redemarrer(sc: Scene): Promise<Scene> {
  generation += 1;
  const tv2 = (await import(`../../events/tempVoice.ts?chat-categorie=${generation}`)) as typeof tv;
  const client = sc.monde.creerClient();
  const enCours = suivreEcouteurs(client);
  tv2.registerTempVoiceListener(client);
  client.emit(Events.ClientReady, client as never);
  await sc.monde.calme(enCours);
  return { ...sc, client, enCours, tv: tv2 };
}

// ─── C : l'ami présent en vocal ───

describe('C — l\'ami présent en vocal écrit, l\'absent non', () => {
  for (const format of FORMATS) {
    test(`C1 ${format} — « en vocal » choisi alors que l'ami est déjà là`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE });
      await choisirMode(sc, 'inVoice');
      expect(ecrit(sc, AMI)).toBe(true);
      expect(ecrit(sc, IDS.PROPRIO)).toBe(true);
      expect(ecrit(sc, IDS.INCONNU)).toBe(false);
    });

    test(`C2 ${format} — l'ami arrive après, puis repart`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE, amiPresent: false });
      await choisirMode(sc, 'inVoice');
      expect(ecrit(sc, AMI)).toBe(false);
      await bouger(sc, AMI, sc.salonId);
      expect(ecrit(sc, AMI)).toBe(true);
      await bouger(sc, AMI, null);
      expect(ecrit(sc, AMI)).toBe(false);
    });

    test(`C3 ${format} — salon créé directement « en vocal », l'ami suit`, async () => {
      const sc = await monter({ format, textChat: 'inVoice' });
      expect(sc.tv.tempChannels.get(sc.salonId)?.modeEcriture).toBe('inVoice');
      expect(ecrit(sc, AMI)).toBe(true);
      expect(ecrit(sc, IDS.PROPRIO)).toBe(true);
      expect(ecrit(sc, IDS.INCONNU)).toBe(false);
    });

    test(`C4 ${format} — ami absent du cache des membres (seulement dans les états vocaux)`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE });
      sc.client.guilds.cache.get(IDS.GUILD)!.members.cache.delete(AMI);
      await choisirMode(sc, 'inVoice');
      expect(ecrit(sc, AMI)).toBe(true);
    });

    test(`C5 ${format} — redémarrage du bot, l'ami entré pendant l'arrêt`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE, amiPresent: false });
      await choisirMode(sc, 'inVoice');
      // Entrée pendant que le bot est hors ligne : seul le faux serveur la connaît.
      sc.monde.etatsVocaux.set(AMI, sc.salonId);
      const sc2 = await redemarrer(sc);
      expect(ecrit(sc2, AMI)).toBe(true);
      // Et le départ, traité par le nouveau processus, la retire.
      await bouger(sc2, AMI, null);
      expect(ecrit(sc2, AMI)).toBe(false);
    });

    test(`C5b ${format} — redémarrage, l'ami présent avant et après`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE });
      await choisirMode(sc, 'inVoice');
      const sc2 = await redemarrer(sc);
      expect(ecrit(sc2, AMI)).toBe(true);
      await bouger(sc2, AMI, null);
      expect(ecrit(sc2, AMI)).toBe(false);
    });

    test(`C6 ${format} — Hérité puis « en vocal »`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE, textChat: 'open' });
      await choisirMode(sc, 'inherit');
      expect(ecrit(sc, AMI)).toBe(false);
      await choisirMode(sc, 'inVoice');
      expect(ecrit(sc, AMI)).toBe(true);
      expect(ecrit(sc, IDS.INCONNU)).toBe(false);
    });

    test(`C7 ${format} — transfert de propriété avec l'ami présent`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE });
      await bouger(sc, IDS.STAFF, sc.salonId);
      await choisirMode(sc, 'inVoice');
      await cliquer(sc, `tempvoice:m_transfer:${IDS.STAFF}`);
      expect(sc.tv.tempChannels.get(sc.salonId)?.creatorId).toBe(IDS.STAFF);
      expect(ecrit(sc, AMI)).toBe(true);
      expect(ecrit(sc, IDS.PROPRIO)).toBe(true);
      expect(ecrit(sc, IDS.STAFF)).toBe(true);
      // Transfert à l'ami lui-même.
      await cliquer(sc, `tempvoice:m_transfer:${AMI}`, undefined, IDS.STAFF);
      expect(ecrit(sc, AMI)).toBe(true);
      expect(ecrit(sc, IDS.STAFF)).toBe(true);
    });

    test(`C8 ${format} — l'ami porte un rôle autorisé d'office`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE, autoAllow: [IDS.ROLE_RESA], rolesAmi: [IDS.ROLE_RESA] });
      await choisirMode(sc, 'inVoice');
      expect(ecrit(sc, AMI)).toBe(true);
      await bouger(sc, AMI, null);
      // Le rôle autorisé d'office écrit dans tous les modes sauf « Personne ».
      expect(ecrit(sc, AMI)).toBe(true);
    });

    test(`C9 ${format} — « Tout le monde » dans une catégorie qui refuse l'écriture à @everyone`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE });
      expect(ecrit(sc, AMI)).toBe(false);
      await choisirMode(sc, 'everyone');
      expect(ecrit(sc, AMI)).toBe(true);
    });

    test(`C9b ${format} — « Tout le monde » quand la catégorie refuse l'écriture au RÔLE de l'ami`, async () => {
      const sc = await monter({
        format,
        roles: [{ id: ROLE_MEMBRE, name: 'Membre' }],
        rolesAmi: [ROLE_MEMBRE],
        categorie: [{ id: ROLE_MEMBRE, type: 0, allow: '0', deny: ENVOI }],
      });
      expect(ecrit(sc, AMI)).toBe(false);
      // Le bot ne lève jamais un refus posé par le serveur sur un rôle : ce rôle
      // peut être une sanction (« Muted »). L'ami écrit par une exception de sa fiche.
      await choisirMode(sc, 'everyone');
      expect(ecrit(sc, AMI)).toBe(false);
      await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, ['allow']);
      expect(ecrit(sc, AMI)).toBe(true);
    });

    test(`C10 ${format} — ami « Autorisé » dans une catégorie muette, puis « en vocal »`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE });
      await cliquer(sc, `tempvoice:m_trust:${AMI}`);
      await choisirMode(sc, 'inVoice');
      expect(ecrit(sc, AMI)).toBe(true);
      await bouger(sc, AMI, null);
      expect(ecrit(sc, AMI)).toBe(false);
      await bouger(sc, AMI, sc.salonId);
      expect(ecrit(sc, AMI)).toBe(true);
    });

    test(`C11 ${format} — « en vocal » puis l'ami est « Autorisé » hors du salon, puis entre`, async () => {
      const sc = await monter({ format, amiPresent: false });
      await choisirMode(sc, 'inVoice');
      await cliquer(sc, `tempvoice:m_trust:${AMI}`);
      expect(ecrit(sc, AMI)).toBe(false);
      await bouger(sc, AMI, sc.salonId);
      expect(ecrit(sc, AMI)).toBe(true);
    });
  }
});

describe('C — l\'ami entre pendant que le mode se pose', () => {
  for (const format of FORMATS) {
    test(`C12 ${format} — entrée en vocal reçue entre deux appels du changement de mode`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE, amiPresent: false });
      const w = sc.monde;
      const traiter = w.traiter.bind(w);
      let arme = true;
      // Au premier PUT de surcharge du changement de mode, l'ami entre : la liste
      // des présents est déjà prise, et le mode n'est pas encore mémorisé.
      w.traiter = async (o: Brut) => {
        if (arme && String(o.method) === 'PUT' && String(o.fullRoute).includes('/permissions/')) {
          arme = false;
          w.bouger(AMI, sc.salonId);
        }
        return traiter(o);
      };
      await choisirMode(sc, 'inVoice');
      expect(arme).toBe(false);
      expect(ecrit(sc, AMI)).toBe(true);
    });
  }
});

// ─── A : « Hérité » suit sa catégorie ───

const CAT2 = '900000000000000021';
const GEN2 = '900000000000000011';

interface Monde2 { sc: Scene; salonsCat: string[]; salonsCat2: string[] }

/** Deux catégories, cinq salons « Hérité » (trois + deux), le chat ouvert partout. */
async function monterCategories(format: Format = 'V2'): Promise<Monde2> {
  base.salons.clear();
  journal.length = 0;
  base.reglages = {
    guildId: IDS.GUILD,
    canRename: true, canChangeLimit: true, canLock: true, canChangeWriteMode: true,
    canReserve: true, canKickOrBan: true, canTransfer: true,
    panelMode: 'CLASSIC', panelComponents: format, stateLayout: 'GRID3', stateColors: 'NEUTRAL',
    reservationFallbackMode: 'ANY_ROLE', reservableRoleIds: [], panelCompactMode: false,
  };
  configServeur = {
    tempVoiceEnabled: true,
    tempVoiceChannelId: IDS.GEN,
    tempVoiceCategoryId: CAT,
    tempVoiceNameTemplate: 'Salon de {user}',
    tempVoiceDefaults: { textChat: 'inherit' },
    tempVoiceGenerators: [{ channelId: GEN2, categoryId: CAT2, textChat: 'inherit' }],
    moderatorRoleId: IDS.ROLE_MOD,
    language: 'fr',
  };
  const w = new FauxDiscord({ latenceRestMs: 20, langueDiscord: 'fr' });
  w.roles.push({ id: ROLE_MEMBRE, name: 'Membre', color: 0, hoist: false, managed: false, mentionable: false, flags: 0, permissions: '0', position: 1 });
  w.membres.get(AMI)!.roles = [ROLE_MEMBRE];
  // La catégorie ouvre l'écriture au rôle Membre, et le rôle Administration y est réglé : jamais touché.
  const ouverte: Brut[] = [
    { id: ROLE_MEMBRE, type: 0, allow: ENVOI, deny: '0' },
    { id: IDS.ROLE_ADMIN, type: 0, allow: '0', deny: ENVOI },
    { id: IDS.ROLE_BOT, type: 0, allow: ENVOI, deny: '0' },
  ];
  w.ajouterCategorie(CAT, ouverte);
  w.ajouterCategorie(CAT2, ouverte);
  w.salons.set(GEN2, { ...w.salonBrut(GEN2, '➕ Créer (2)', []), parent_id: CAT2 });
  const client = w.creerClient();
  const enCours = suivreEcouteurs(client);
  tv.registerTempVoiceListener(client);
  const creer = async (proprio: string, gen: string): Promise<string> => {
    const avant = new Set(tv.tempChannels.keys());
    avancer(1_500);
    w.bouger(proprio, gen);
    await w.calme(enCours);
    const id = [...tv.tempChannels.keys()].find((x) => !avant.has(x));
    if (!id) throw new Error(`salon de ${proprio} non créé`);
    return id;
  };
  const salonsCat = [await creer(IDS.PROPRIO, IDS.GEN), await creer(IDS.AUTORISE, IDS.GEN), await creer(IDS.STAFF, IDS.GEN)];
  const salonsCat2 = [await creer(IDS.INCONNU, GEN2), await creer(IDS.DEHORS, GEN2)];
  avancer(1_500);
  w.bouger(AMI, salonsCat[0]);
  await w.calme(enCours);
  return { sc: { monde: w, client, salonId: salonsCat[0], enCours, tv }, salonsCat, salonsCat2 };
}

/** La catégorie ferme l'écriture à @everyone et au rôle Membre, et l'annonce (CHANNEL_UPDATE). */
function fermerCategorie(w: FauxDiscord, cat: string, annoncer = true) {
  const nouvelles: Brut[] = [
    { id: IDS.GUILD, type: 0, allow: '0', deny: ENVOI },
    { id: ROLE_MEMBRE, type: 0, allow: '0', deny: ENVOI },
    { id: IDS.ROLE_ADMIN, type: 0, allow: '0', deny: ENVOI },
    { id: IDS.ROLE_BOT, type: 0, allow: ENVOI, deny: '0' },
  ];
  if (annoncer) w.remplacerSurcharges(cat, nouvelles);
  else w.salons.get(cat)!.permission_overwrites = structuredClone(nouvelles);
}

const lignesCategorie = () => journal.filter((j) => j.type === 'voice_panel' && j.champs.some((c) => c.value === m.log_tempvoice_reason_category_changed({}, { locale: 'fr' })));
const champJ = (j: LigneJournal, nom: string) => j.champs.find((c) => c.name === nom)?.value ?? '';

/** Compte les PUT de surcharge en vol à chaque instant (latence réelle de 5 ms par appel). */
function compterEnVol(w: FauxDiscord) {
  const traiter = w.traiter.bind(w);
  const etat = { enVol: 0, max: 0, puts: [] as string[] };
  w.traiter = async (o: Brut) => {
    const put = String(o.method) === 'PUT' && String(o.fullRoute).includes('/permissions/');
    if (!put) return traiter(o);
    etat.puts.push(String(o.fullRoute));
    etat.enVol += 1;
    etat.max = Math.max(etat.max, etat.enVol);
    // Compté comme activité : le banc n'est pas « calme » tant qu'un appel est en vol.
    w.activite += 1;
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await traiter(o);
    } finally {
      etat.enVol -= 1;
      w.activite -= 1;
    }
  };
  return etat;
}

describe('A — « Hérité » suit les changements de sa catégorie', () => {
  test('A1 — la catégorie ferme l\'écriture : ses 3 salons « Hérité » suivent, un à la fois, une ligne de journal', async () => {
    const { sc, salonsCat, salonsCat2 } = await monterCategories();
    const w = sc.monde;
    // Un salon au mode mémorisé (« Tout le monde ») ne suit pas la catégorie.
    await cliquer({ ...sc, salonId: salonsCat[2] }, 'tempvoice:mode_select', ['everyone'], IDS.STAFF);
    expect(sc.tv.tempChannels.get(salonsCat[2])?.modeEcriture).toBe('everyone');
    for (const id of salonsCat) expect(w.peutEcrire(id, AMI)).toBe(true);
    const connectAvant = w.salons.get(salonsCat[0])!.permission_overwrites.find((o: Brut) => o.id === IDS.PROPRIO);
    const vol = compterEnVol(w);
    journal.length = 0;

    fermerCategorie(w, CAT);
    await w.calme(sc.enCours);

    // Les deux salons « Hérité » de la catégorie suivent, pour @everyone comme pour le rôle Membre.
    expect(w.peutEcrire(salonsCat[0], AMI)).toBe(false);
    expect(w.peutEcrire(salonsCat[1], IDS.INCONNU)).toBe(false);
    expect(w.peutEcrire(salonsCat[2], AMI)).toBe(true);
    // L'autre catégorie n'a pas bougé.
    for (const id of salonsCat2) expect(w.peutEcrire(id, IDS.INCONNU)).toBe(true);
    // Débit : jamais deux PUT simultanés, et rien sur le rôle administrateur ni sur un membre.
    expect(vol.max).toBe(1);
    expect(vol.puts.some((r) => r.endsWith(`/permissions/${IDS.ROLE_ADMIN}`))).toBe(false);
    expect(vol.puts.every((r) => r.endsWith(`/permissions/${IDS.GUILD}`) || r.endsWith(`/permissions/${ROLE_MEMBRE}`))).toBe(true);
    // Seul SendMessages a changé : la surcharge du propriétaire est intacte.
    expect(w.salons.get(salonsCat[0])!.permission_overwrites.find((o: Brut) => o.id === IDS.PROPRIO)).toEqual(connectAvant);
    // Journal : UNE ligne pour la catégorie, acteur Système, motif, avant → après.
    const lignes = lignesCategorie();
    expect(lignes).toHaveLength(1);
    const L = { locale: 'fr' as const };
    expect(lignes[0].acteur).toBe(m.log_tempvoice_system({}, L));
    expect(lignes[0].salons).toContain(CAT);
    expect(champJ(lignes[0], m.log_tempvoice_field_adjusted_channels({}, L))).toBe(`<#${salonsCat[0]}>, <#${salonsCat[1]}>`);
    expect(champJ(lignes[0], m.log_tempvoice_field_before({}, L))).toContain(`**<@&${ROLE_MEMBRE}>** — ${m.log_tempvoice_val_chat_allow({}, L)}`);
    expect(champJ(lignes[0], m.log_tempvoice_field_after({}, L))).toContain(`**@everyone** — ${m.log_tempvoice_val_chat_deny({}, L)}`);
    expect(clesBrutes(lignes[0].champs.flatMap((c) => [c.name, c.value]))).toEqual([]);
    // Les panneaux des salons ajustés sont redessinés.
    expect(w.appels.some((a) => a.methode === 'PATCH' && a.route.startsWith(`/channels/${salonsCat[0]}/messages/`))).toBe(true);
  });

  test('A1 — une mise à jour de la catégorie qui ne touche pas l\'écriture ne déclenche rien', async () => {
    const { sc } = await monterCategories();
    const w = sc.monde;
    const avant = w.appels.length;
    journal.length = 0;
    w.salons.get(CAT)!.name = 'Renommée';
    w.remplacerSurcharges(CAT, w.salons.get(CAT)!.permission_overwrites);
    await w.calme(sc.enCours);
    expect(w.mutations(avant).filter((a) => a.route.includes('/permissions/'))).toEqual([]);
    expect(lignesCategorie()).toHaveLength(0);
  });

  test('A1 — un salon « Hérité » verrouillé garde son refus pour @everyone', async () => {
    const { sc, salonsCat } = await monterCategories();
    const w = sc.monde;
    await cliquer(sc, 'tempvoice:bascule_verrou');
    // La catégorie rouvre tout : le verrou, lui, refuse toujours.
    w.remplacerSurcharges(CAT, [{ id: IDS.GUILD, type: 0, allow: ENVOI, deny: '0' }, { id: IDS.ROLE_BOT, type: 0, allow: ENVOI, deny: '0' }]);
    await w.calme(sc.enCours);
    const everyone = w.salons.get(salonsCat[0])!.permission_overwrites.find((o: Brut) => o.id === IDS.GUILD);
    expect((BigInt(everyone.deny) & P.SendMessages) === P.SendMessages).toBe(true);
    expect((BigInt(everyone.deny) & P.Connect) === P.Connect).toBe(true);
  });

  test('A2 — le balayage rattrape un écart, ne PUT rien quand tout est aligné, minuterie unique et arrêtée', async () => {
    const { sc, salonsCat } = await monterCategories();
    const w = sc.monde;
    // Un écart que personne n'a annoncé : la surcharge du salon a été changée à la main.
    w.poserSurchargeDirecte(salonsCat[1], IDS.GUILD, 0, 0n, P.SendMessages);
    await w.calme(sc.enCours);
    expect(w.peutEcrire(salonsCat[1], IDS.INCONNU)).toBe(false);
    journal.length = 0;
    const avant = w.appels.length;
    expect(await tv.balayerEcritureHeritee(sc.client)).toBe(1);
    await w.calme(sc.enCours);
    const puts = w.mutations(avant).filter((a) => a.methode === 'PUT');
    expect(puts.map((a) => a.route)).toEqual([`/channels/${salonsCat[1]}/permissions/${IDS.GUILD}`]);
    expect(lignesCategorie()).toHaveLength(1);
    expect(w.peutEcrire(salonsCat[1], IDS.INCONNU)).toBe(true);
    // Deuxième passe : tout est aligné, aucun appel.
    const apres = w.appels.length;
    expect(await tv.balayerEcritureHeritee(sc.client)).toBe(0);
    expect(w.mutations(apres).filter((a) => a.methode === 'PUT')).toEqual([]);

    // La minuterie : une seule, toutes les 5 minutes, remplacée au redémarrage et arrêtée proprement.
    const vrais = { set: globalThis.setInterval, clear: globalThis.clearInterval };
    const poses: Array<{ ms: number; fn: () => void; id: ReturnType<typeof setInterval> }> = [];
    const effaces: unknown[] = [];
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const id = vrais.set(() => undefined, 1 << 30);
      poses.push({ ms, fn, id });
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => { effaces.push(id); vrais.clear(id); }) as typeof clearInterval;
    try {
      sc.client.emit(Events.ClientReady, sc.client as never);
      await w.calme(sc.enCours);
      // Deux minuteries de 5 minutes au démarrage : la nôtre (posée la première) et la purge des demandes.
      const balayages = poses.filter((p) => p.ms === tv.BALAYAGE_ECRITURE_MS);
      expect(balayages).toHaveLength(2);
      // Le rappel de la minuterie fait la même réconciliation.
      w.poserSurchargeDirecte(salonsCat[0], ROLE_MEMBRE, 0, P.SendMessages, 0n);
      w.poserSurchargeDirecte(salonsCat[0], IDS.GUILD, 0, 0n, 0n);
      await w.calme(sc.enCours);
      balayages[0].fn();
      await w.calme(sc.enCours);
      expect(bitDe(w, salonsCat[0], IDS.GUILD)).toBe(null);
      tv.arreterBalayageEcriture();
      expect(effaces).toContain(balayages[0].id);
    } finally {
      globalThis.setInterval = vrais.set;
      globalThis.clearInterval = vrais.clear;
      tv.arreterBalayageEcriture();
    }
  });

  test('A3 — catégorie changée pendant l\'arrêt : réalignée au démarrage, une ligne de journal', async () => {
    const { sc, salonsCat } = await monterCategories();
    const w = sc.monde;
    fermerCategorie(w, CAT, false);
    journal.length = 0;
    const sc2 = await redemarrer(sc);
    try {
      expect(w.peutEcrire(salonsCat[0], AMI)).toBe(false);
      expect(w.peutEcrire(salonsCat[2], IDS.STAFF)).toBe(false);
      expect(lignesCategorie()).toHaveLength(1);
    } finally {
      sc2.tv.arreterBalayageEcriture();
    }
  });

  test('A — choisir « Hérité » recopie la catégorie (un salon créé ne la suit plus de lui-même)', async () => {
    const sc = await monter({ format: 'V2', categorie: CAT_MUETTE, textChat: 'open' });
    expect(ecrit(sc, AMI)).toBe(true);
    await choisirMode(sc, 'inherit');
    expect(ecrit(sc, AMI)).toBe(false);
  });
});

function bitDe(w: FauxDiscord, salonId: string, cible: string): boolean | null {
  const o = (w.salons.get(salonId)!.permission_overwrites as Brut[]).find((x) => x.id === cible);
  if (!o) return null;
  if ((BigInt(o.deny) & P.SendMessages) === P.SendMessages) return false;
  if ((BigInt(o.allow) & P.SendMessages) === P.SendMessages) return true;
  return null;
}

// ─── B : la règle par rôle, l'exception par membre ───

describe('B — règle par rôle, rôles administrateurs ignorés, exception par membre', () => {
  test('B1 — aucun mode ne pose ni ne retire rien sur un rôle administrateur', async () => {
    const sc = await monter({
      format: 'V2',
      categorie: [...CAT_MUETTE, { id: IDS.ROLE_ADMIN, type: 0, allow: '0', deny: ENVOI }],
    });
    const avant = sc.monde.appels.length;
    for (const mode of ['everyone', 'inVoice', 'ownerOnly', 'nobody', 'inherit']) await choisirMode(sc, mode);
    expect(sc.monde.mutations(avant).filter((a) => a.route.endsWith(`/permissions/${IDS.ROLE_ADMIN}`))).toEqual([]);
    expect(bitDe(sc.monde, sc.salonId, IDS.ROLE_ADMIN)).toBe(false);
  });

  test('B2 — « Personne » : un rôle que la catégorie autorise n\'écrit plus ; « Hérité » le lui rend', async () => {
    const sc = await monter({
      format: 'V2',
      roles: [{ id: ROLE_MEMBRE, name: 'Membre' }],
      rolesAmi: [ROLE_MEMBRE],
      categorie: [...CAT_MUETTE, { id: ROLE_MEMBRE, type: 0, allow: ENVOI, deny: '0' }],
    });
    expect(ecrit(sc, AMI)).toBe(true);
    await choisirMode(sc, 'nobody');
    expect(ecrit(sc, AMI)).toBe(false);
    await choisirMode(sc, 'inherit');
    expect(ecrit(sc, AMI)).toBe(true);
  });

  for (const format of FORMATS) {
    test(`B3 ${format} — exception « Ne peut pas écrire » : seul ce membre change, et elle survit aux modes, aux allers-retours et au redémarrage`, async () => {
      const sc = await monter({ format });
      await bouger(sc, IDS.INCONNU, sc.salonId);
      await choisirMode(sc, 'everyone');
      const avant = sc.monde.appels.length;
      journal.length = 0;
      await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, ['deny']);
      const puts = sc.monde.mutations(avant).filter((a) => a.methode === 'PUT');
      expect(puts.map((a) => a.route)).toEqual([`/channels/${sc.salonId}/permissions/${AMI}`]);
      expect(ecrit(sc, AMI)).toBe(false);
      expect(ecrit(sc, IDS.INCONNU)).toBe(true);
      // Journal : une ligne, avant → après sur l'écriture de l'ami.
      const L = { locale: 'fr' as const };
      const ligne = journal.filter((j) => j.type === 'voice_panel');
      expect(ligne).toHaveLength(1);
      expect(champJ(ligne[0], m.log_tempvoice_field_after({}, L))).toContain(m.log_tempvoice_val_chat_deny({}, L));
      expect(champJ(ligne[0], m.log_tempvoice_field_before({}, L))).toContain(m.log_tempvoice_val_chat_follow({}, L));

      await choisirMode(sc, 'inVoice');
      expect(ecrit(sc, AMI)).toBe(false);
      await bouger(sc, AMI, null);
      await bouger(sc, AMI, sc.salonId);
      expect(ecrit(sc, AMI)).toBe(false);
      expect(ecrit(sc, IDS.INCONNU)).toBe(true);
      const sc2 = await redemarrer(sc);
      try {
        expect(sc2.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toEqual({ [AMI]: false });
        expect(ecrit(sc2, AMI)).toBe(false);
        // « Suivre le salon » : il redevient un présent ordinaire du mode « en vocal ».
        await cliquer(sc2, `tempvoice:m_ecrire:${AMI}`, ['follow']);
        expect(ecrit(sc2, AMI)).toBe(true);
        await bouger(sc2, AMI, null);
        expect(ecrit(sc2, AMI)).toBe(false);
      } finally {
        sc2.tv.arreterBalayageEcriture();
      }
    });

    test(`B4 ${format} — exception « Peut écrire » en « Personne » : elle n'est ni coupée par le mode ni effacée au démarrage`, async () => {
      const sc = await monter({ format, categorie: CAT_MUETTE });
      await choisirMode(sc, 'nobody');
      await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, ['allow']);
      expect(ecrit(sc, AMI)).toBe(true);
      await choisirMode(sc, 'ownerOnly');
      expect(ecrit(sc, AMI)).toBe(true);
      await bouger(sc, AMI, null);
      const sc2 = await redemarrer(sc);
      try {
        expect(ecrit(sc2, AMI)).toBe(true);
      } finally {
        sc2.tv.arreterBalayageEcriture();
      }
    });
  }

  test('B5 — la fiche porte le menu d\'écriture (fr/en, sans clé brute), pas pour le propriétaire', async () => {
    for (const langue of ['fr', 'en'] as const) {
      const sc = await monter({ format: 'V2', langue });
      const avant = sc.monde.appels.length;
      await cliquer(sc, 'tempvoice:membre_ici', [AMI]);
      const corps = sc.monde.appels.slice(avant).map((a) => (a.corps as Brut)?.data ?? a.corps).filter(Boolean);
      const menu = JSON.stringify(corps).includes(`tempvoice:m_ecrire:${AMI}`);
      expect(menu).toBe(true);
      const textes = corps.flatMap((c: Brut) => textesVisibles(c));
      expect(clesBrutes(textes)).toEqual([]);
      expect(JSON.stringify(corps)).toContain(langue === 'fr' ? 'Ne peut pas écrire' : 'Cannot write');
      const avant2 = sc.monde.appels.length;
      await cliquer(sc, 'tempvoice:membre_ici', [IDS.PROPRIO]);
      expect(JSON.stringify(sc.monde.appels.slice(avant2).map((a) => a.corps))).not.toContain('tempvoice:m_ecrire:');
    }
  });
});

// ─── D : au plus deux messages par navigation ───

interface ResultatClic { crees: string[]; publicEdite: boolean; erreurs: string[]; violations: string[] }

const panneauPublic = (sc: Scene): Brut =>
  [...sc.monde.messages.values()].find((x) => x.channel_id === sc.salonId && !(x.flags & 64) && x.components.length)!;

/** Qui a cliqué, par interaction : les éphémères se comptent par personne. */
const acteurs = new Map<string, string>();

/** Clic sur un message réel (panneau public ou sous-panneau), par le vrai chemin discord.js. */
async function cliquerSur(
  sc: Scene,
  porteur: Brut,
  customId: string,
  o: { values?: string[]; acteur?: string; modale?: Record<string, string> } = {},
): Promise<ResultatClic> {
  avancer(1_500);
  const w = sc.monde;
  const debut = w.appels.length;
  const publicId = panneauPublic(sc).id;
  const acteur = o.acteur ?? IDS.PROPRIO;
  const brut = w.interactionBrute({
    customId,
    genre: o.modale ? 'modale' : o.values ? 'menuTexte' : 'bouton',
    acteur,
    channelId: sc.salonId,
    message: structuredClone(porteur),
    values: o.values,
    champs: o.modale,
  });
  acteurs.set(String(brut.id), acteur);
  (sc.client as unknown as { actions: { InteractionCreate: { handle: (d: unknown) => void } } }).actions.InteractionCreate.handle(brut);
  await w.calme(sc.enCours);
  const appels = w.appels.slice(debut);
  return {
    crees: appels.flatMap((a) => (a.cree ? [a.cree] : [])),
    publicEdite: appels.some((a) => a.methode === 'PATCH' && a.route.endsWith(`/messages/${publicId}`)),
    erreurs: appels.filter((a) => a.erreur).map((a) => `${a.route} ${a.erreur!.code}`),
    violations: appels.flatMap((a) => a.violations),
  };
}

/** Éphémères encore visibles, par membre : créés par une interaction, jamais supprimés. */
function visibles(sc: Scene): Record<string, number> {
  const n: Record<string, number> = {};
  for (const a of sc.monde.appels) {
    const msg = a.cree ? sc.monde.messages.get(a.cree) : null;
    if (!msg || !(msg.flags & 64) || !a.interactionId) continue;
    const qui = acteurs.get(a.interactionId) ?? '?';
    n[qui] = (n[qui] ?? 0) + 1;
  }
  return n;
}

const contient = (msg: Brut | undefined, customId: string) => JSON.stringify(msg?.components ?? []).includes(`"${customId}"`);
const MODES_D = ['CLASSIC', 'FLAT'] as const;

describe('D — le panneau public et UN sous-panneau par membre', () => {
  for (const format of FORMATS) for (const mode of MODES_D) {
    test(`D1 ${format} ${mode} — porte publique : un sous-panneau s'ouvre, le panneau public n'est pas touché`, async () => {
      const sc = await monter({ format, mode });
      const r = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon');
      expect(r.erreurs).toEqual([]);
      expect(r.violations).toEqual([]);
      expect(r.publicEdite).toBe(false);
      expect(r.crees).toHaveLength(1);
      expect(sc.monde.messages.get(r.crees[0])!.flags & 64).toBe(64);
      expect(contient(sc.monde.messages.get(r.crees[0]), 'tempvoice:rename')).toBe(true);
    });

    test(`D2 ${format} ${mode} — une autre porte publique : un sous-panneau neuf, l'ancien supprimé`, async () => {
      const sc = await monter({ format, mode });
      const sous = (await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon')).crees[0];
      const r2 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:membres');
      expect(r2.erreurs).toEqual([]);
      expect(r2.crees).toHaveLength(1);
      expect(r2.publicEdite).toBe(false);
      expect(sc.monde.messages.has(sous)).toBe(false);
      // Le fil de navigation : le titre est celui de la porte choisie.
      expect(textesVisibles(sc.monde.messages.get(r2.crees[0])).join(' ')).toContain(m.panel_tempvoice_who_title({}, { locale: 'fr' }));
      const r3 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:propriete');
      expect(r3.crees).toHaveLength(1);
      expect(visibles(sc)).toEqual({ [IDS.PROPRIO]: 1 });
    });
  }

  test('D3 — jeton expiré (> 14 min) : un nouveau sous-panneau, sans tenter de supprimer l\'ancien', async () => {
    const sc = await monter({ format: 'V2' });
    const r1 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon');
    avancer(tv.DUREE_SOUS_PANNEAU_MS + 60_000);
    const r2 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:membres');
    expect(r2.erreurs).toEqual([]);
    expect(r2.crees).toHaveLength(1);
    expect(r2.crees[0]).not.toBe(r1.crees[0]);
    const r3 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon');
    expect(r3.crees).toHaveLength(1);
    expect(sc.monde.messages.has(r2.crees[0])).toBe(false);
    expect(contient(sc.monde.messages.get(r3.crees[0]), 'tempvoice:rename')).toBe(true);
  });

  test('D3b — sous-panneau fermé par la personne (10008) : un nouveau s\'ouvre', async () => {
    const sc = await monter({ format: 'V2' });
    const r1 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon');
    sc.monde.messages.delete(r1.crees[0]);
    const r2 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:membres');
    // Seule erreur admise : la suppression de l'ancien, déjà fermé (10008), ignorée par le code.
    expect(r2.erreurs.filter((e) => !e.endsWith(' 10008'))).toEqual([]);
    expect(r2.crees).toHaveLength(1);
    expect(visibles(sc)).toEqual({ [IDS.PROPRIO]: 1 });
  });

  test('D3c — sous-panneau ignoré côté client (encore là pour l\'API) : le clic en rouvre un visible', async () => {
    const sc = await monter({ format: 'V2' });
    const r1 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon');
    // « Ignorer ce message » n'envoie rien au bot : le message existe toujours côté API.
    const r2 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon');
    expect(r2.erreurs).toEqual([]);
    expect(r2.crees).toHaveLength(1);
    expect(r2.crees[0]).not.toBe(r1.crees[0]);
    expect(sc.monde.messages.has(r1.crees[0])).toBe(false);
    expect(visibles(sc)).toEqual({ [IDS.PROPRIO]: 1 });
  });

  for (const format of FORMATS) {
    test(`D4 ${format} — « Retour » à chaque niveau, toujours dans le même sous-panneau`, async () => {
      const sc = await monter({ format });
      const w = sc.monde;
      const sous = (await cliquerSur(sc, panneauPublic(sc), 'tempvoice:membres')).crees[0];
      // [porte, chemin vers le niveau inférieur depuis la porte]
      const niveaux: Array<[string, Array<[string, { values?: string[]; modale?: Record<string, string> }]>]> = [
        ['tempvoice:membres', [['tempvoice:membre_ici', { values: [AMI] }]]],
        ['tempvoice:membres', [['tempvoice:membre_ici', { values: [AMI] }], [`tempvoice:m_trust:${AMI}`, {}]]],
        ['tempvoice:salon', [['tempvoice:bascule_verrou', {}]]],
        ['tempvoice:salon', [['tempvoice:rename_modal', { modale: { value: 'Nouveau nom' } }]]],
        ['tempvoice:propriete', [['tempvoice:transfer', {}]]],
      ];
      for (const [porte, chemin] of niveaux) {
        await cliquerSur(sc, w.messages.get(sous)!, porte);
        for (const [composant, options] of chemin) {
          const r = await cliquerSur(sc, w.messages.get(sous)!, composant, options);
          // Le panneau public, lui, se redessine après une action : c'est attendu.
          expect({ composant, erreurs: r.erreurs, violations: r.violations, crees: r.crees })
            .toEqual({ composant, erreurs: [], violations: [], crees: [] });
          // Le niveau inférieur s'affiche dans le sous-panneau, avec « Retour » vers sa porte.
          expect({ composant, retour: contient(w.messages.get(sous), porte) }).toEqual({ composant, retour: true });
        }
        const retour = await cliquerSur(sc, w.messages.get(sous)!, porte);
        expect(retour.crees).toEqual([]);
        expect({ porte, retourSurLaPorte: contient(w.messages.get(sous), porte) }).toEqual({ porte, retourSurLaPorte: false });
      }
      expect(visibles(sc)).toEqual({ [IDS.PROPRIO]: 1 });
    });
  }

  test('D4b — un refus remplace le sous-panneau et garde « Retour »', async () => {
    const sc = await monter({ format: 'V2' });
    const w = sc.monde;
    const sous = (await cliquerSur(sc, panneauPublic(sc), 'tempvoice:propriete', { acteur: AMI })).crees[0];
    const r = await cliquerSur(sc, w.messages.get(sous)!, 'tempvoice:transfer', { acteur: AMI });
    expect(r.crees).toEqual([]);
    expect(textesVisibles(w.messages.get(sous)).join(' ')).toContain(m.panel_tempvoice_err_owner_only({}, { locale: 'fr' }));
    expect(contient(w.messages.get(sous), 'tempvoice:propriete')).toBe(true);
    expect(visibles(sc)).toEqual({ [AMI]: 1 });
  });

  test('D5 — deux membres : deux sous-panneaux, chacun remplace le sien', async () => {
    const sc = await monter({ format: 'V2' });
    const a = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon');
    const b = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:propriete', { acteur: AMI });
    expect(a.crees).toHaveLength(1);
    expect(b.crees).toHaveLength(1);
    expect(a.crees[0]).not.toBe(b.crees[0]);
    const a2 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:membres');
    const b2 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:propriete', { acteur: AMI });
    expect([a2.crees.length, b2.crees.length]).toEqual([1, 1]);
    expect(textesVisibles(sc.monde.messages.get(a2.crees[0])).join(' ')).toContain(m.panel_tempvoice_who_title({}, { locale: 'fr' }));
    expect(visibles(sc)).toEqual({ [IDS.PROPRIO]: 1, [AMI]: 1 });
  });

  test('D6 — départ du salon : le sous-panneau est oublié, le retour en ouvre un neuf', async () => {
    const sc = await monter({ format: 'V2' });
    const r1 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:propriete', { acteur: AMI });
    await bouger(sc, AMI, null);
    await bouger(sc, AMI, sc.salonId);
    const r2 = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:propriete', { acteur: AMI });
    expect(r2.crees).toHaveLength(1);
    expect(r2.crees[0]).not.toBe(r1.crees[0]);
  });
});

// ─── Contradicteur : chemins que la passe ne couvrait pas ───

const ROLE_MUET = '900000000000000206';

describe('R — revue adversariale', () => {
  for (const mode of ['everyone', 'inVoice', 'ownerOnly']) {
    test(`R1 ${mode} — un refus d'écrire du serveur sur un rôle de sanction n'est jamais levé par un mode`, async () => {
      const sc = await monter({
        format: 'V2',
        roles: [{ id: ROLE_MUET, name: 'Muted' }],
        rolesAmi: [ROLE_MUET],
        categorie: [{ id: ROLE_MUET, type: 0, allow: '0', deny: ENVOI }],
      });
      expect(ecrit(sc, IDS.INCONNU)).toBe(true);
      await choisirMode(sc, mode);
      expect(bitDe(sc.monde, sc.salonId, ROLE_MUET)).toBe(false);
      if (mode !== 'inVoice') expect(ecrit(sc, AMI)).toBe(false);
    });
  }

  test('R2 — exception par membre : ni la catégorie, ni le balayage, ni le redémarrage ne l’écrasent', async () => {
    const { sc, salonsCat } = await monterCategories();
    const w = sc.monde;
    await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, ['allow']);
    const avant = w.appels.length;
    fermerCategorie(w, CAT);
    await w.calme(sc.enCours);
    expect(w.peutEcrire(salonsCat[0], IDS.INCONNU)).toBe(false);
    expect(w.peutEcrire(salonsCat[0], AMI)).toBe(true);
    await tv.balayerEcritureHeritee(sc.client);
    await w.calme(sc.enCours);
    expect(w.peutEcrire(salonsCat[0], AMI)).toBe(true);
    expect(w.mutations(avant).some((a) => a.route.endsWith(`/permissions/${AMI}`))).toBe(false);

    await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, ['deny']);
    w.remplacerSurcharges(CAT, [{ id: IDS.GUILD, type: 0, allow: ENVOI, deny: '0' }, { id: ROLE_MEMBRE, type: 0, allow: ENVOI, deny: '0' }, { id: IDS.ROLE_BOT, type: 0, allow: ENVOI, deny: '0' }]);
    await w.calme(sc.enCours);
    expect(w.peutEcrire(salonsCat[0], IDS.INCONNU)).toBe(true);
    expect(w.peutEcrire(salonsCat[0], AMI)).toBe(false);
    const sc2 = await redemarrer(sc);
    try {
      expect(w.peutEcrire(salonsCat[0], AMI)).toBe(false);
      await sc2.tv.balayerEcritureHeritee(sc2.client);
      await w.calme(sc2.enCours);
      expect(w.peutEcrire(salonsCat[0], AMI)).toBe(false);
    } finally {
      sc2.tv.arreterBalayageEcriture();
    }
  });

  for (const format of FORMATS) {
    test(`R3 ${format} — « Autoriser » un membre en exception ne lui rend pas l'écriture refusée`, async () => {
      const sc = await monter({ format });
      await choisirMode(sc, 'everyone');
      await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, ['deny']);
      expect(ecrit(sc, AMI)).toBe(false);
      await cliquer(sc, `tempvoice:m_trust:${AMI}`);
      expect(ecrit(sc, AMI)).toBe(false);
      await cliquer(sc, 'tempvoice:trust_select', [AMI]);
      expect(ecrit(sc, AMI)).toBe(false);
      for (const mode of ['nobody', 'inVoice', 'everyone']) {
        await choisirMode(sc, mode);
        expect({ mode, ecrit: ecrit(sc, AMI) }).toEqual({ mode, ecrit: false });
      }
    });
  }

  test('R4 — fenêtre ouverte depuis le sous-panneau puis fermée : la porte publique remplace le sous-panneau, sans en laisser deux', async () => {
    const sc = await monter({ format: 'V2' });
    const w = sc.monde;
    const sous = (await cliquerSur(sc, panneauPublic(sc), 'tempvoice:salon')).crees[0];
    const modale = await cliquerSur(sc, w.messages.get(sous)!, 'tempvoice:rename');
    expect(modale.erreurs).toEqual([]);
    const r = await cliquerSur(sc, panneauPublic(sc), 'tempvoice:membres');
    expect(r.erreurs).toEqual([]);
    expect(r.crees).toHaveLength(1);
    expect(w.messages.has(sous)).toBe(false);
    expect(textesVisibles(w.messages.get(r.crees[0])).join(' ')).toContain(m.panel_tempvoice_who_title({}, { locale: 'fr' }));
    expect(visibles(sc)).toEqual({ [IDS.PROPRIO]: 1 });
  });
});

// ─── E : le MP au propriétaire quand le mode contredit une exception ───

/** Les MP reçus par ce membre, du plus ancien au plus récent. */
const mpDe = (sc: Scene, id: string = IDS.PROPRIO): Brut[] =>
  [...sc.monde.messages.values()].filter((x) => x.channel_id === sc.monde.canalMp(id));

const idsBoutons = (msg: Brut): string[] => {
  const ids: string[] = [];
  const parcourir = (cs: Brut[] = []) => { for (const c of cs) { if (c.custom_id) ids.push(c.custom_id); parcourir(c.components); } };
  parcourir(msg.components);
  return ids;
};
const boutonsDesactives = (msg: Brut): boolean[] => {
  const etats: boolean[] = [];
  const parcourir = (cs: Brut[] = []) => { for (const c of cs) { if (String(c.custom_id ?? '').startsWith('tempvoice:ecr_')) etats.push(Boolean(c.disabled)); parcourir(c.components); } };
  parcourir(msg.components);
  return etats;
};

/** Clic sur un bouton d'un MP, comme Discord l'envoie : salon privé, sans serveur ni membre. */
async function cliquerMp(sc: Scene, msg: Brut, action: string, acteur: string = IDS.PROPRIO): Promise<{ acks: number[]; texte: string; msg: Brut }> {
  avancer(1_500);
  const w = sc.monde;
  const customId = idsBoutons(msg).find((id) => id.startsWith(`tempvoice:${action}:`))!;
  const brut = w.interactionBrute({ customId, genre: 'bouton', acteur, channelId: msg.channel_id, message: msg });
  (sc.client as unknown as { actions: { InteractionCreate: { handle: (d: unknown) => void } } }).actions.InteractionCreate.handle(brut);
  await w.calme(sc.enCours);
  const acks = w.appels.filter((a) => a.interactionId === brut.id && a.typeCallback !== undefined && !a.erreur).map((a) => a.typeCallback as number);
  const apres = w.messages.get(msg.id)!;
  return { acks, texte: textesVisibles(apres).join(' '), msg: apres };
}

/** L'ami présent avec une exception, le mode « Hérité » d'une catégorie ouverte. */
async function monterException(o: Partial<Options> & { format: Format }, exception: 'allow' | 'deny' = 'deny'): Promise<Scene> {
  const sc = await monter({ ...o });
  await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, [exception]);
  journal.length = 0;
  return sc;
}

const lignesPanneau = (action: string) => journal.filter((j) => j.type === 'voice_panel'
  && j.champs.some((c) => c.value.includes(`tempvoice:${action}`)));

describe('E — changement de mode : MP au propriétaire pour une exception présente', () => {
  for (const format of FORMATS) for (const langue of ['fr', 'en'] as const) {
    test(`E1 ${format} ${langue} — un MP concis, trois boutons, au bon format et dans la langue du serveur`, async () => {
      const sc = await monterException({ format, langue, categorie: CAT_MUETTE });
      await choisirMode(sc, 'everyone');
      const mps = mpDe(sc);
      expect(mps).toHaveLength(1);
      expect(idsBoutons(mps[0]).filter((id) => id.startsWith('tempvoice:ecr_'))).toEqual(
        ['ecr_appliquer', 'ecr_garder', 'ecr_jamais'].map((a) => `tempvoice:${a}:${AMI}:${sc.salonId}`),
      );
      expect(Boolean(mps[0].flags & (1 << 15))).toBe(format === 'V2');
      const textes = textesVisibles(mps[0]);
      expect(clesBrutes(textes)).toEqual([]);
      const L = { locale: langue };
      const mode = langue === 'fr' ? 'Tout le monde' : 'Everyone';
      expect(textes.join(' ')).toContain(m.panel_tempvoice_chat_exception_deny({}, L));
      expect(textes.join(' ')).toContain(mode);
      expect(textes.join(' ')).toContain(m.panel_tempvoice_chat_ask_never({}, L));
      // Le mode, lui, est posé pour tous les autres : l'exception n'a pas bougé.
      expect(ecrit(sc, IDS.PROPRIO)).toBe(true);
      expect(ecrit(sc, AMI)).toBe(false);
      expect(sc.monde.appels.filter((a) => a.violations.length).map((a) => a.violations)).toEqual([]);
    });
  }

  test('E2 — aucun MP : membre absent, mode qui ne change rien pour lui, même mode, catégorie, balayage, démarrage, modérateur', async () => {
    // Absent du vocal.
    let sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await bouger(sc, AMI, null);
    await choisirMode(sc, 'everyone');
    expect(mpDe(sc)).toHaveLength(0);

    // « Ne peut pas écrire » face à « Moi seul » et « Personne » : rien de différent pour lui.
    sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await choisirMode(sc, 'ownerOnly');
    await choisirMode(sc, 'nobody');
    // « Hérité » d'une catégorie muette : il n'écrirait pas non plus.
    await choisirMode(sc, 'inherit');
    expect(mpDe(sc)).toHaveLength(0);

    // Le même mode choisi de nouveau : l'exception a été posée contre lui, en connaissance de cause.
    sc = await monter({ format: 'V2', categorie: CAT_MUETTE });
    await choisirMode(sc, 'everyone');
    await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, ['deny']);
    await choisirMode(sc, 'everyone');
    expect(mpDe(sc)).toHaveLength(0);

    // Catégorie, balayage et démarrage : jamais de MP.
    const { sc: sc2, salonsCat } = await monterCategories();
    await cliquer(sc2, `tempvoice:m_ecrire:${AMI}`, ['allow']);
    fermerCategorie(sc2.monde, CAT);
    await sc2.monde.calme(sc2.enCours);
    await tv.balayerEcritureHeritee(sc2.client);
    const sc3 = await redemarrer(sc2);
    try {
      expect(sc2.monde.peutEcrire(salonsCat[0], AMI)).toBe(true);
      expect(mpDe(sc2)).toHaveLength(0);
    } finally {
      sc3.tv.arreterBalayageEcriture();
    }

    // Un modérateur change le mode : le propriétaire n'est pas questionné.
    sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await bouger(sc, IDS.STAFF, sc.salonId);
    await cliquer(sc, 'tempvoice:mode_select', ['everyone'], IDS.STAFF);
    expect(sc.tv.tempChannels.get(sc.salonId)?.modeEcriture).toBe('everyone');
    expect(mpDe(sc)).toHaveLength(0);
    expect(mpDe(sc, IDS.STAFF)).toHaveLength(0);
  });

  test('E2b — « Peut écrire » face à « Personne » : un MP ; le bouton « chat » de l\'ancien panneau aussi', async () => {
    const sc = await monterException({ format: 'V1', categorie: CAT_MUETTE }, 'allow');
    await choisirMode(sc, 'nobody');
    expect(mpDe(sc)).toHaveLength(1);
    expect(ecrit(sc, AMI)).toBe(true);
    const sc2 = await monterException({ format: 'V1' }, 'deny');
    await choisirMode(sc2, 'ownerOnly');
    await cliquer(sc2, 'tempvoice:chat');
    expect(sc2.tv.tempChannels.get(sc2.salonId)?.modeEcriture).toBe('everyone');
    expect(mpDe(sc2)).toHaveLength(1);
  });

  for (const format of FORMATS) {
    test(`E3 ${format} — « Appliquer » : l'exception part, il suit le salon tout de suite ; un seul acquittement ; journal avant → après`, async () => {
      const sc = await monterException({ format, categorie: CAT_MUETTE });
      await choisirMode(sc, 'everyone');
      const r = await cliquerMp(sc, mpDe(sc)[0], 'ecr_appliquer');
      expect(r.acks).toEqual([6]);
      expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toBeUndefined();
      expect(base.salons.get(sc.salonId)?.writeExceptions).toEqual({});
      expect(ecrit(sc, AMI)).toBe(true);
      expect(boutonsDesactives(r.msg)).toEqual([true, true, true]);
      expect(r.texte).toContain(m.panel_tempvoice_chat_ask_applied({ name: 'cible' }, { locale: 'fr' }));
      expect(Boolean(r.msg.flags & (1 << 15))).toBe(format === 'V2');
      const L = { locale: 'fr' as const };
      const lignes = lignesPanneau('ecr_appliquer');
      expect(lignes).toHaveLength(1);
      expect(champJ(lignes[0], m.log_tempvoice_field_member({}, L))).toContain(`<@${IDS.PROPRIO}>`);
      expect(champJ(lignes[0], m.log_tempvoice_field_action({}, L))).toBe(m.log_tempvoice_action_ecr_appliquer({}, L));
      expect(champJ(lignes[0], m.log_tempvoice_field_before({}, L))).toContain(m.log_tempvoice_val_chat_deny({}, L));
      expect(champJ(lignes[0], m.log_tempvoice_field_after({}, L))).toContain(m.log_tempvoice_val_chat_follow({}, L));
      // Ensuite, il suit vraiment le salon.
      await choisirMode(sc, 'ownerOnly');
      expect(ecrit(sc, AMI)).toBe(false);
    });

    test(`E4 ${format} — « Garder » : rien ne change, boutons désactivés, journalisé`, async () => {
      const sc = await monterException({ format, categorie: CAT_MUETTE });
      await choisirMode(sc, 'everyone');
      const avant = sc.monde.appels.length;
      const r = await cliquerMp(sc, mpDe(sc)[0], 'ecr_garder');
      expect(r.acks).toEqual([6]);
      expect(sc.monde.mutations(avant).filter((a) => a.route.includes('/permissions/'))).toEqual([]);
      expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toEqual({ [AMI]: false });
      expect(ecrit(sc, AMI)).toBe(false);
      expect(boutonsDesactives(r.msg)).toEqual([true, true, true]);
      expect(lignesPanneau('ecr_garder')).toHaveLength(1);
    });
  }

  for (const format of FORMATS) for (const mode of ['CLASSIC', 'FLAT'] as const) {
    test(`E5 ${format} ${mode} — « Ne plus demander » : persistant (redémarrage, futurs salons), « Redemander » sur la fiche le lève`, async () => {
      const sc = await monterException({ format, mode, categorie: CAT_MUETTE });
      await choisirMode(sc, 'everyone');
      const r = await cliquerMp(sc, mpDe(sc)[0], 'ecr_jamais');
      expect(r.acks).toEqual([6]);
      expect(base.profils.get(`${IDS.GUILD}:${IDS.PROPRIO}`)).toEqual([AMI]);
      expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toEqual({ [AMI]: false });
      const L = { locale: 'fr' as const };
      const ligne = lignesPanneau('ecr_jamais');
      expect(ligne).toHaveLength(1);
      expect(champJ(ligne[0], m.log_tempvoice_field_before({}, L))).toContain(`${m.log_tempvoice_state_chat_ask({ target: `<@${AMI}>` }, L)}** — ${m.log_tempvoice_val_yes({}, L)}`);
      expect(champJ(ligne[0], m.log_tempvoice_field_after({}, L))).toContain(m.log_tempvoice_val_no({}, L));

      // Plus de MP, même après un redémarrage.
      await choisirMode(sc, 'ownerOnly');
      await choisirMode(sc, 'everyone');
      const sc2 = await redemarrer(sc);
      try {
        await choisirMode(sc2, 'nobody');
        await cliquer(sc2, `tempvoice:m_ecrire:${AMI}`, ['allow']);
        await choisirMode(sc2, 'ownerOnly');
        expect(mpDe(sc2)).toHaveLength(1);

        // La fiche, vue par le propriétaire, porte « Redemander » ; vue par un autre, non.
        const avantFiche = sc2.monde.appels.length;
        await cliquer(sc2, 'tempvoice:membre_ici', [AMI]);
        const fiche = JSON.stringify(sc2.monde.appels.slice(avantFiche).map((a) => a.corps));
        expect(fiche).toContain(`tempvoice:m_redemander:${AMI}`);
        expect(fiche).toContain(m.panel_tempvoice_chat_ask_reset({}, L));
        await bouger(sc2, IDS.STAFF, sc2.salonId);
        const avantStaff = sc2.monde.appels.length;
        await cliquer(sc2, 'tempvoice:membre_ici', [AMI], IDS.STAFF);
        expect(JSON.stringify(sc2.monde.appels.slice(avantStaff).map((a) => a.corps))).not.toContain('m_redemander');
        // Un modérateur ne lève pas le choix du propriétaire.
        await cliquer(sc2, `tempvoice:m_redemander:${AMI}`, undefined, IDS.STAFF);
        expect(base.profils.get(`${IDS.GUILD}:${IDS.PROPRIO}`)).toEqual([AMI]);

        await cliquer(sc2, `tempvoice:m_redemander:${AMI}`);
        expect(base.profils.get(`${IDS.GUILD}:${IDS.PROPRIO}`)).toEqual([]);
        expect(lignesPanneau('m_redemander').length).toBeGreaterThan(0);
        const avantFiche2 = sc2.monde.appels.length;
        await cliquer(sc2, 'tempvoice:membre_ici', [AMI]);
        expect(JSON.stringify(sc2.monde.appels.slice(avantFiche2).map((a) => a.corps))).not.toContain('m_redemander');
        // Le choix levé : le MP revient.
        await choisirMode(sc2, 'nobody');
        expect(mpDe(sc2)).toHaveLength(2);
      } finally {
        sc2.tv.arreterBalayageEcriture();
      }
    });
  }

  test('E5b — « Ne plus demander » vaut pour les futurs salons du même propriétaire', async () => {
    const sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await choisirMode(sc, 'everyone');
    await cliquerMp(sc, mpDe(sc)[0], 'ecr_jamais');
    const choix = base.profils.get(`${IDS.GUILD}:${IDS.PROPRIO}`);
    // Un autre salon, plus tard : seul le profil du propriétaire en base est gardé.
    const sc2 = await monter({ format: 'V2', categorie: CAT_MUETTE });
    base.profils.set(`${IDS.GUILD}:${IDS.PROPRIO}`, choix);
    await cliquer(sc2, `tempvoice:m_ecrire:${AMI}`, ['deny']);
    await choisirMode(sc2, 'everyone');
    expect(mpDe(sc2)).toHaveLength(0);
  });

  test('E6 — le membre quitte le vocal avant le clic : rien ne change, boutons désactivés', async () => {
    const sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await choisirMode(sc, 'everyone');
    await bouger(sc, AMI, null);
    const avant = sc.monde.appels.length;
    const r = await cliquerMp(sc, mpDe(sc)[0], 'ecr_appliquer');
    expect(r.acks).toEqual([6]);
    expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toEqual({ [AMI]: false });
    expect(sc.monde.mutations(avant).filter((a) => a.route.includes('/permissions/'))).toEqual([]);
    expect(r.texte).toContain(m.panel_tempvoice_chat_ask_gone({ name: 'cible' }, { locale: 'fr' }));
    expect(boutonsDesactives(r.msg)).toEqual([true, true, true]);
    expect(champJ(lignesPanneau('ecr_appliquer')[0], m.log_tempvoice_field_outcome({}, { locale: 'fr' }))).toBe(m.log_tempvoice_outcome_refused({}, { locale: 'fr' }));
  });

  test('E7 — la propriété a changé avant le clic : rien ne change, boutons désactivés', async () => {
    const sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await bouger(sc, IDS.STAFF, sc.salonId);
    await choisirMode(sc, 'everyone');
    await cliquer(sc, `tempvoice:m_transfer:${IDS.STAFF}`);
    expect(sc.tv.tempChannels.get(sc.salonId)?.creatorId).toBe(IDS.STAFF);
    for (const action of ['ecr_appliquer', 'ecr_jamais']) {
      const r = await cliquerMp(sc, mpDe(sc)[0], action);
      expect(r.acks).toEqual([6]);
      expect(r.texte).toContain(m.panel_tempvoice_chat_ask_not_owner({}, { locale: 'fr' }));
      expect(boutonsDesactives(r.msg)).toEqual([true, true, true]);
    }
    expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toEqual({ [AMI]: false });
    expect(base.profils.size).toBe(0);
  });

  test('E7b — le salon a disparu avant le clic : réponse courte, boutons désactivés', async () => {
    const sc = await monterException({ format: 'V1', categorie: CAT_MUETTE });
    await choisirMode(sc, 'everyone');
    const mp = mpDe(sc)[0];
    sc.monde.supprimerSalon(sc.salonId);
    await sc.monde.calme(sc.enCours);
    const r = await cliquerMp(sc, mp, 'ecr_appliquer');
    expect(r.acks).toEqual([7]);
    expect(r.texte).toContain(m.panel_tempvoice_err_not_temp({}, { locale: 'fr' }));
    expect(boutonsDesactives(r.msg)).toEqual([true, true, true]);
    expect(Boolean(r.msg.flags & (1 << 15))).toBe(false);
  });

  test('E8 — MP fermés (50007) : silencieux, un avertissement au journal, le mode est posé', async () => {
    const sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    sc.monde.mpFermes.add(IDS.PROPRIO);
    avertissements.length = 0;
    journal.length = 0;
    await choisirMode(sc, 'everyone');
    expect(sc.monde.appels.some((a) => a.erreur?.code === 50007)).toBe(true);
    expect(mpDe(sc)).toHaveLength(0);
    expect(avertissements.some((a) => a.includes('50007'))).toBe(true);
    expect(sc.tv.tempChannels.get(sc.salonId)?.modeEcriture).toBe('everyone');
    const ligne = lignesPanneau('mode_select');
    expect(ligne).toHaveLength(1);
    expect(champJ(ligne[0], m.log_tempvoice_field_outcome({}, { locale: 'fr' }))).toBe('');
  });

  test('E9 — un nouveau changement réécrit le MP en attente, sans empilement ; deux membres = deux MP', async () => {
    const sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await bouger(sc, IDS.INCONNU, sc.salonId);
    await cliquer(sc, `tempvoice:m_ecrire:${IDS.INCONNU}`, ['allow']);
    await choisirMode(sc, 'everyone');
    const premiers = mpDe(sc);
    // AMI « ne peut pas écrire » contredit « Tout le monde » ; INCONNU « peut écrire », non.
    expect(premiers).toHaveLength(1);
    const posts = () => sc.monde.appels.filter((a) => a.methode === 'POST' && a.route === `/channels/${sc.monde.canalMp(IDS.PROPRIO)}/messages`).length;
    expect(posts()).toBe(1);
    await choisirMode(sc, 'inVoice');
    expect(mpDe(sc)).toHaveLength(1);
    expect(posts()).toBe(1);
    expect(sc.monde.appels.some((a) => a.methode === 'PATCH' && a.route === `/channels/${premiers[0].channel_id}/messages/${premiers[0].id}`)).toBe(true);
    // « Personne » : seul INCONNU (« peut écrire ») est contredit ; le MP d'AMI reste en attente.
    await choisirMode(sc, 'nobody');
    const parMembre = mpDe(sc).map((x) => idsBoutons(x).find((id) => id.startsWith('tempvoice:ecr_appliquer'))!.split(':')[2]).sort();
    expect(parMembre).toEqual([AMI, IDS.INCONNU].sort());
    expect(posts()).toBe(2);
  });
});

describe('F — les deux restes de la revue', () => {
  for (const [mode, exception] of [['nobody', 'allow'], ['everyone', 'deny'], ['inVoice', 'deny']] as const) {
    test(`F1 ${mode} — lever le bannissement repose l'exception « ${exception} » (fiche, ancien menu)`, async () => {
      for (const lever of [`tempvoice:m_trust:${AMI}`, 'tempvoice:trust_select'] as const) {
        const sc = await monter({ format: 'V2', categorie: CAT_MUETTE });
        await choisirMode(sc, mode);
        await cliquer(sc, `tempvoice:m_ecrire:${AMI}`, [exception]);
        await cliquer(sc, `tempvoice:m_ban:${AMI}`);
        expect(bitDe(sc.monde, sc.salonId, AMI)).toBe(false);
        await cliquer(sc, lever, lever.endsWith('trust_select') ? [AMI] : undefined);
        await bouger(sc, AMI, sc.salonId);
        expect({ lever, ecrit: ecrit(sc, AMI) }).toEqual({ lever, ecrit: exception === 'allow' });
        expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toEqual({ [AMI]: exception === 'allow' });
      }
    });
  }

  for (const format of FORMATS) {
    test(`F2 ${format} — la pose initiale « en vocal » échoue : le salon reste « en vocal », pas « Hérité »`, async () => {
      let arme = false;
      const sc = await monter({
        format,
        textChat: 'inVoice',
        categorie: CAT_MUETTE,
        amiPresent: false,
        avantCreation: (w) => {
          const traiter = w.traiter.bind(w);
          arme = true;
          w.traiter = async (o: Brut) => {
            if (arme && String(o.method) === 'PUT' && String(o.fullRoute).includes('/permissions/')) {
              arme = false;
              throw new Error('panne simulée');
            }
            return traiter(o);
          };
        },
      });
      expect(arme).toBe(false);
      expect(sc.tv.tempChannels.get(sc.salonId)?.modeEcriture).toBe('inVoice');
      expect(base.salons.get(sc.salonId)?.writeMode).toBe('inVoice');
      // L'ami qui entre écrit, celui qui reste dehors non.
      await bouger(sc, AMI, sc.salonId);
      expect(ecrit(sc, AMI)).toBe(true);
      expect(ecrit(sc, IDS.INCONNU)).toBe(false);
      await bouger(sc, AMI, null);
      expect(ecrit(sc, AMI)).toBe(false);
    });
  }
});

// ─── V : vérification finale du MP au propriétaire ───

/** Lance plusieurs interactions sans attendre entre elles, puis attend le calme. */
async function rafale(sc: Scene, bruts: Brut[]): Promise<void> {
  avancer(1_500);
  for (const brut of bruts) (sc.client as unknown as { actions: { InteractionCreate: { handle: (d: unknown) => void } } }).actions.InteractionCreate.handle(brut);
  await sc.monde.calme(sc.enCours);
}
const brutMode = (sc: Scene, mode: string): Brut => {
  const w = sc.monde;
  const composant = { type: 3, custom_id: 'tempvoice:mode_select', options: [{ label: mode, value: mode }] };
  const porteur = w.creerMessage(sc.salonId, { flags: 64, components: [{ type: 1, components: [composant] }] }, {
    interaction_metadata: { id: '1', type: 3, user: w.membres.get(IDS.PROPRIO)!.user, authorizing_integration_owners: {} },
  });
  return w.interactionBrute({ customId: 'tempvoice:mode_select', genre: 'menuTexte', acteur: IDS.PROPRIO, channelId: sc.salonId, message: porteur, values: [mode] });
};
const brutMp = (sc: Scene, msg: Brut, action: string, acteur: string = IDS.PROPRIO): Brut => sc.monde.interactionBrute({
  customId: idsBoutons(msg).find((id) => id.startsWith(`tempvoice:${action}:`))!, genre: 'bouton', acteur, channelId: msg.channel_id, message: msg,
});
const acquittements = (sc: Scene, brut: Brut) => sc.monde.appels.filter((a) => a.interactionId === brut.id && a.typeCallback !== undefined && !a.erreur).map((a) => a.typeCallback as number);

describe('V — vérification finale du MP au propriétaire', () => {
  for (const format of FORMATS) {
    test(`V1 ${format} — deux changements de mode en rafale : un seul MP, réécrit`, async () => {
      const sc = await monterException({ format, categorie: CAT_MUETTE });
      await rafale(sc, [brutMode(sc, 'everyone'), brutMode(sc, 'inVoice')]);
      expect(sc.tv.tempChannels.get(sc.salonId)?.modeEcriture).toBe('inVoice');
      expect(mpDe(sc)).toHaveLength(1);
      // Le MP suivi est bien celui qui existe : un troisième changement le réécrit.
      const posts = () => sc.monde.appels.filter((a) => a.methode === 'POST' && a.route === `/channels/${sc.monde.canalMp(IDS.PROPRIO)}/messages`).length;
      await choisirMode(sc, 'everyone');
      expect(mpDe(sc)).toHaveLength(1);
      expect(posts()).toBe(1);
    });

    test(`V2 ${format} — « Appliquer » derrière une pose lente (> 3 s) : acquitté à temps, exception levée, boutons désactivés`, async () => {
      const sc = await monterException({ format, categorie: CAT_MUETTE });
      await choisirMode(sc, 'everyone');
      const traiter = sc.monde.traiter.bind(sc.monde);
      sc.monde.traiter = async (o: Brut) => {
        if (String(o.method) === 'PUT' && String(o.fullRoute).includes(`/permissions/${AMI}`)) sc.monde.horloge += 3_500;
        return traiter(o);
      };
      const r = await cliquerMp(sc, mpDe(sc)[0], 'ecr_appliquer');
      expect(sc.monde.appels.filter((a) => a.erreur?.code === 10062)).toEqual([]);
      expect(r.acks).toHaveLength(1);
      expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toBeUndefined();
      expect(boutonsDesactives(r.msg)).toEqual([true, true, true]);
      expect(r.texte).toContain(m.panel_tempvoice_chat_ask_applied({ name: 'cible' }, { locale: 'fr' }));
    });
  }

  test('V3 — double clic sur « Appliquer » : une seule levée, chaque clic acquitté une fois', async () => {
    const sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await choisirMode(sc, 'everyone');
    const mp = mpDe(sc)[0];
    const avant = sc.monde.appels.length;
    const [a, b] = [brutMp(sc, mp, 'ecr_appliquer'), brutMp(sc, mp, 'ecr_appliquer')];
    await rafale(sc, [a, b]);
    expect(acquittements(sc, a)).toHaveLength(1);
    expect(acquittements(sc, b)).toHaveLength(1);
    expect(sc.monde.appels.slice(avant).filter((x) => x.erreur).map((x) => x.erreur!.code)).toEqual([]);
    expect(sc.monde.mutations(avant).filter((x) => x.route.includes(`/permissions/${AMI}`)).length).toBeLessThanOrEqual(1);
    expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toBeUndefined();
    expect(ecrit(sc, AMI)).toBe(true);
  });

  test('V4 — un autre que le propriétaire clique le bouton (identifiant recopié) : refus, rien ne change, le MP du propriétaire reste suivi', async () => {
    const sc = await monterException({ format: 'V2', categorie: CAT_MUETTE });
    await choisirMode(sc, 'everyone');
    const mp = mpDe(sc)[0];
    for (const action of ['ecr_appliquer', 'ecr_jamais']) {
      const brut = brutMp(sc, mp, action, AMI);
      await rafale(sc, [brut]);
      expect(acquittements(sc, brut)).toHaveLength(1);
    }
    expect(sc.tv.tempChannels.get(sc.salonId)?.exceptionsEcriture).toEqual({ [AMI]: false });
    expect(base.profils.size).toBe(0);
    expect(mpDe(sc, AMI)).toHaveLength(0);
    await choisirMode(sc, 'inVoice');
    expect(mpDe(sc)).toHaveLength(1);
  });

  for (const langue of ['fr', 'en'] as const) {
    test(`V5 ${langue} — verdicts des trois boutons et refus : dans la langue du serveur, sans clé brute`, async () => {
      const L = { locale: langue };
      for (const [action, attendu] of [
        ['ecr_appliquer', m.panel_tempvoice_chat_ask_applied({ name: 'cible' }, L)],
        ['ecr_garder', m.panel_tempvoice_chat_ask_kept({ name: 'cible' }, L)],
        ['ecr_jamais', m.panel_tempvoice_chat_ask_never_done({ name: 'cible' }, L)],
      ] as const) {
        const sc = await monterException({ format: 'V2', langue, categorie: CAT_MUETTE });
        await choisirMode(sc, 'everyone');
        const r = await cliquerMp(sc, mpDe(sc)[0], action);
        expect(clesBrutes([r.texte])).toEqual([]);
        expect(r.texte).toContain(attendu);
      }
      const sc = await monterException({ format: 'V2', langue, categorie: CAT_MUETTE });
      await choisirMode(sc, 'everyone');
      await bouger(sc, AMI, null);
      const r = await cliquerMp(sc, mpDe(sc)[0], 'ecr_garder');
      expect(r.texte).toContain(m.panel_tempvoice_chat_ask_gone({ name: 'cible' }, L));
    });
  }
});
