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
};

const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async () => (base.reglages ? { ...base.reglages } : null)),
    upsert: mock(async () => ({})),
  },
  tempVoiceAccessRequestConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
  dashboardAuditLog: { create: mock(async () => ({})) },
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
}

interface Scene { monde: FauxDiscord; client: Client; salonId: string; enCours: Array<Promise<unknown>>; tv: typeof tv }

async function monter(o: Options): Promise<Scene> {
  base.salons.clear();
  base.reglages = {
    guildId: IDS.GUILD,
    canRename: true, canChangeLimit: true, canLock: true, canChangeWriteMode: true,
    canReserve: true, canKickOrBan: true, canTransfer: true,
    panelMode: 'CLASSIC', panelComponents: o.format, stateLayout: 'GRID3', stateColors: 'NEUTRAL',
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
      await choisirMode(sc, 'everyone');
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
