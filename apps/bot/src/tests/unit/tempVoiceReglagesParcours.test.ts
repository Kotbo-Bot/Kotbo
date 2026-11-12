/**
 * « Mes réglages » du panneau vocal, sur le VRAI parcours : menu de la section
 * Propriété, application à la création et au transfert, journal voice_panel.
 * Harnais repris de tempVoiceVisibilitePanneau.test.ts (lui-même de tempVoiceBanc.test.ts).
 */
import { afterAll, describe, expect, mock, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import { PermissionFlagsBits, type Client } from 'discord.js';

import { completeModuleMock } from '../helpers/moduleMock.js';
import {
  FauxDiscord,
  IDS,
  trouverComposant,
  suivreEcouteurs,
  type AppelRest,
} from '../helpers/bancDiscord.js';

// ─── Base de données et cache simulés, au temps virtuel du monde courant ───

let monde: FauxDiscord | null = null;
const coutBase = () => { if (monde) monde.horloge += 40; };

const base = {
  salons: new Map<string, Record<string, unknown>>(),
  reglages: null as Record<string, unknown> | null,
  demandes: null as Record<string, unknown> | null,
  /** `tempVoiceWriteNoAsk` des profils, clé `${guildId}:${userId}`. */
  profils: new Map<string, unknown>(),
};

/** `tempVoiceSavedSettings` des profils, clé `${guildId}:${userId}` ; jamais vidé par reglerBase. */
const sauves = new Map<string, unknown>();

const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async () => { coutBase(); return base.reglages ? { ...base.reglages } : null; }),
    upsert: mock(async (a: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      coutBase();
      base.reglages = base.reglages ? { ...base.reglages, ...a.update } : { ...a.create };
      return base.reglages;
    }),
  },
  tempVoiceAccessRequestConfig: {
    findUnique: mock(async () => { coutBase(); return base.demandes ? { ...base.demandes } : null; }),
    upsert: mock(async () => ({})),
  },
  // Seulement pour la route du dashboard (PATCH des réglages) du test de bout en bout.
  guild: { findUnique: mock(async () => ({ ...configServeur })), update: mock(async () => ({})) },
  dashboardAuditLog: { create: mock(async () => ({})) },
  memberProfile: {
    findUnique: mock(async (a: { where: { guildId_userId: { guildId: string; userId: string } }; select?: Record<string, boolean> }) => {
      coutBase();
      const cle = `${a.where.guildId_userId.guildId}:${a.where.guildId_userId.userId}`;
      if (a.select?.tempVoiceSavedSettings) return sauves.has(cle) ? { tempVoiceSavedSettings: structuredClone(sauves.get(cle)) } : null;
      return base.profils.has(cle) ? { tempVoiceWriteNoAsk: structuredClone(base.profils.get(cle)) } : null;
    }),
    upsert: mock(async (a: { where: { guildId_userId: { guildId: string; userId: string } }; update: Record<string, unknown> }) => {
      coutBase();
      const cle = `${a.where.guildId_userId.guildId}:${a.where.guildId_userId.userId}`;
      if ('tempVoiceSavedSettings' in a.update) sauves.set(cle, structuredClone(a.update.tempVoiceSavedSettings));
      else base.profils.set(cle, structuredClone(a.update.tempVoiceWriteNoAsk));
      return {};
    }),
    updateMany: mock(async (a: { where: { guildId: string; userId: string } }) => {
      coutBase();
      sauves.delete(`${a.where.guildId}:${a.where.userId}`);
      return { count: 1 };
    }),
  },
  tempVoiceChannel: {
    findMany: mock(async () => { coutBase(); return [...base.salons.values()].map((s) => ({ ...s })); }),
    findUnique: mock(async (a: { where: { id: string } }) => { coutBase(); const s = base.salons.get(a.where.id); return s ? { ...s } : null; }),
    create: mock(async (a: { data: Record<string, unknown> }) => {
      coutBase();
      const ligne = { roleId: null, writeMode: null, renameHistory: [], accessRequests: [], ...a.data };
      base.salons.set(String(a.data.id), ligne);
      return ligne;
    }),
    update: mock(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      coutBase();
      const s = base.salons.get(a.where.id);
      if (!s) throw new Error('Record to update not found');
      Object.assign(s, a.data);
      return { ...s };
    }),
    delete: mock(async (a: { where: { id: string } }) => { coutBase(); base.salons.delete(a.where.id); return {}; }),
  },
};

let configServeur: Record<string, unknown> = {};
/** Lectures de la configuration du serveur : une par cible jugée « staff ou non ». */
let lecturesConfig = 0;

interface LigneJournal {
  type: string;
  acteur: string;
  salons: string[];
  champs: Array<{ name: string; value: string }>;
  titre?: string;
  pied?: string;
  audit?: { details?: string; channelId?: string | null };
}
const journal: LigneJournal[] = [];

const mocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), {
    getCachedGuild: mock(async () => { lecturesConfig += 1; if (monde) monde.horloge += 2; return { ...configServeur }; }),
    cache: { invalidateGuild: mock(async () => undefined) },
  })],
  ['../../utils/logDispatch', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/logDispatch.ts'), {
    sendLogEmbed: mock(async (
      _g: unknown,
      embed: { toJSON: () => { fields?: Array<{ name: string; value: string }>; title?: string; footer?: { text: string } } },
      type: string, _c: unknown, tag: string, salons: string[], audit?: LigneJournal['audit'],
    ) => {
      const e = embed.toJSON();
      journal.push({ type, acteur: tag, salons, champs: e.fields ?? [], titre: e.title, pied: e.footer?.text, audit });
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

// Les erreurs que le code avale (`.catch(() => null)` puis un log) restent visibles ici.
const avertissements: string[] = [];
for (const niveau of ['warn', 'error'] as const) {
  const original = logger[niveau].bind(logger);
  (logger as unknown as Record<string, unknown>)[niveau] = (...a: unknown[]) => {
    avertissements.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    return (original as (...b: unknown[]) => unknown)(...a);
  };
}
(logger as unknown as Record<string, unknown>).info = () => undefined;
(logger as unknown as Record<string, unknown>).success = () => undefined;

/**
 * Temps réel figé et avancé à chaque clic : l'anti-rebond du panneau public
 * (une réécriture par seconde) laisse alors partir la réécriture tout de suite,
 * et sa charge est validée dans la cellule qui l'a provoquée.
 */
let maintenant = Date.now();
function avancer(ms: number) {
  maintenant += ms;
  setSystemTime(new Date(maintenant));
}

// ─── Scène ───

type Langue = 'fr' | 'en';
type Format = 'V1' | 'V2';
type ModePanneau = 'CLASSIC' | 'FLAT';

interface OptionsScene {
  langue: Langue;
  format: Format;
  mode: ModePanneau;
  /** Réglages modérateur tous fermés (« admins seulement »). */
  droitsFermes?: boolean;
  demandes?: boolean;
  repli?: string;
  /** Mode compact : un seul éphémère réécrit sur place. */
  compact?: boolean;
  latenceRestMs?: number;
  /** `ownerMentionPlacement` de la ligne de réglages ; absent = colonne d'avant la migration. */
  mention?: string;
  /** Modèle de nom du serveur (défaut du banc : un modèle personnalisé). */
  modeleNom?: string;
  /** Salon de repli des membres sans le rôle réservé. */
  repliSalon?: string;
  /** Ne pas réécrire la base : un test l'a déjà préparée (et modifiée par la route du dashboard). */
  garderBase?: boolean;
  /** `reglagesPerso` du générateur (absent = défaut, activé). */
  reglagesPerso?: boolean;
  /** `visibilite` du générateur (absent = défaut, visible par tous). */
  visibilite?: string;
  /** Le salon naît d'un générateur additionnel (`tempVoiceGenerators`), pas du principal. */
  additionnel?: boolean;
  /** Retouche le monde avant que le propriétaire n'entre dans le générateur. */
  avantCreation?: (m: FauxDiscord) => void;
  /** Surcharges de la catégorie du générateur (absent = pas de catégorie). */
  categorie?: Brut[];
}

const GEN2 = '900000000000000011';
const CAT = '900000000000000012';

interface Scene {
  monde: FauxDiscord;
  client: Client;
  salonId: string;
  panneauId: string;
  enCours: Array<Promise<unknown>>;
  opts: OptionsScene;
}

function reglerBase(opts: OptionsScene) {
  const ouvert = !opts.droitsFermes;
  base.reglages = {
    guildId: IDS.GUILD,
    canRename: ouvert, canChangeLimit: ouvert, canLock: ouvert, canChangeWriteMode: ouvert,
    canReserve: ouvert, canKickOrBan: ouvert, canTransfer: ouvert,
    panelMode: opts.mode,
    panelComponents: opts.format,
    stateLayout: 'GRID3',
    stateColors: 'NEUTRAL',
    reservationFallbackMode: opts.repli ?? 'ANY_ROLE',
    // Repli MEMBERS : il ne joue que si le serveur a des rôles réservables que la personne n'a pas.
    reservableRoleIds: opts.repli === 'MEMBERS' ? [IDS.ROLE_RESA] : [],
    panelCompactMode: opts.compact === true,
    ...(opts.mention ? { ownerMentionPlacement: opts.mention } : {}),
    ...(opts.repliSalon ? { reservationFallbackChannelId: opts.repliSalon } : {}),
  };
  base.profils.clear();
  base.demandes = opts.demandes
    ? { guildId: IDS.GUILD, enabled: true, responders: 'OWNER_AND_STAFF', notifyVia: 'VOICE', notifyChannelId: null, requestExpiresMinutes: 10, denyCooldownMinutes: 10 }
    : null;
  configServeur = {
    tempVoiceEnabled: true,
    tempVoiceChannelId: IDS.GEN,
    tempVoiceCategoryId: opts.categorie ? CAT : null,
    tempVoiceNameTemplate: opts.modeleNom ?? 'Salon de {user}',
    tempVoiceGenerators: opts.additionnel ? [{ channelId: GEN2, nameTemplate: 'Salon de {user}' }] : [],
    tempVoiceDefaults: {
      ...(opts.reglagesPerso === undefined ? {} : { reglagesPerso: opts.reglagesPerso }),
      ...(opts.visibilite ? { visibilite: opts.visibilite } : {}),
    },
    moderatorRoleId: IDS.ROLE_MOD,
    language: opts.langue,
  };
}

/** Monte un monde, crée le salon par le générateur, fait entrer les autres. */
async function monterScene(opts: OptionsScene): Promise<Scene> {
  if (!opts.garderBase) reglerBase(opts);
  const m = new FauxDiscord({ latenceRestMs: opts.latenceRestMs ?? Number(process.env.BANC_LATENCE ?? 150), langueDiscord: opts.langue === 'fr' ? 'fr' : 'en-US' });
  monde = m;
  if (opts.additionnel) m.salons.set(GEN2, m.salonBrut(GEN2, '➕ Autre générateur', []));
  if (opts.categorie) m.ajouterCategorie(CAT, opts.categorie);
  const client = m.creerClient();
  const enCours = suivreEcouteurs(client);
  tv.registerTempVoiceListener(client);

  const avant = new Set(tv.tempChannels.keys());
  // Chaque arrivée un peu plus tard que la précédente : l'anti-rebond du panneau
  // ne laisse ainsi aucun minuteur réel en attente derrière la scène.
  opts.avantCreation?.(m);
  avancer(1_500);
  m.bouger(IDS.PROPRIO, opts.additionnel ? GEN2 : IDS.GEN);
  await m.calme(enCours);
  const salonId = [...tv.tempChannels.keys()].find((id) => !avant.has(id));
  if (!salonId) throw new Error(`Salon non créé : ${avertissements.slice(-3).join(' | ')} ${JSON.stringify(m.appels.map((a) => [a.methode, a.route, a.erreur]))}`);
  for (const id of [IDS.AUTORISE, IDS.STAFF, IDS.INCONNU, IDS.ADMIN, IDS.CIBLE]) {
    avancer(1_500);
    m.bouger(id, salonId);
    await m.calme(enCours);
  }
  avancer(1_500);
  m.poserSurchargeDirecte(salonId, IDS.AUTORISE, 1, PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect);
  await m.calme(enCours);
  // Le panneau porte des composants : en `message`, la mention seule est postée au-dessus.
  const panneau = [...m.messages.values()].find((msg) => msg.channel_id === salonId && !(msg.flags & 64) && msg.components.length);
  if (!panneau) throw new Error(`Panneau non posté : ${avertissements.slice(-3).join(' | ')}`);
  return { monde: m, client, salonId, panneauId: panneau.id, enCours, opts };
}

type Brut = Record<string, any>;

async function cliquer(sc: Scene, clic: { customId: string; genre: 'bouton' | 'menuTexte' | 'menuMembres'; acteur: string; values?: string[]; porteur: Brut | null }) {
  avancer(1_500);
  const debut = journal.length;
  const brut = sc.monde.interactionBrute({ ...clic, channelId: clic.porteur?.channel_id ?? sc.salonId, message: clic.porteur, locale: sc.opts.langue === 'fr' ? 'fr' : 'en-US' });
  (sc.client as unknown as { actions: { InteractionCreate: { handle: (d: unknown) => void } } }).actions.InteractionCreate.handle(brut);
  await sc.monde.calme(sc.enCours);
  return journal.slice(debut);
}

/** Le dernier message qui porte ce composant (sous-panneau éphémère ou panneau public). */
function porteurDe(sc: Scene, customId: string): Brut | null {
  return [...sc.monde.messages.values()].reverse().find((msg) => trouverComposant(msg, customId)) ?? null;
}

/** Le menu Visibilité tel que la personne le voit : à plat sur le public, sinon dans « Salon ». */
async function menuVisibilite(sc: Scene): Promise<{ porteur: Brut; menu: Brut }> {
  if (sc.opts.mode === 'CLASSIC') {
    await cliquer(sc, { customId: 'tempvoice:salon', genre: 'bouton', acteur: IDS.PROPRIO, porteur: sc.monde.messages.get(sc.panneauId)! });
  }
  const porteur = sc.opts.mode === 'FLAT' ? sc.monde.messages.get(sc.panneauId)! : porteurDe(sc, 'tempvoice:visibility_select');
  const menu = trouverComposant(porteur, 'tempvoice:visibility_select');
  if (!porteur || !menu) throw new Error('Menu Visibilité absent');
  return { porteur, menu };
}

async function choisir(sc: Scene, valeur: string) {
  const { porteur } = await menuVisibilite(sc);
  return cliquer(sc, { customId: 'tempvoice:visibility_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: [valeur], porteur });
}

const VUE = PermissionFlagsBits.ViewChannel;
function surcharge(sc: Scene, id: string): { allow: bigint; deny: bigint } {
  const o = (sc.monde.salons.get(sc.salonId)!.permission_overwrites as Brut[]).find((x) => x.id === id);
  return { allow: BigInt(o?.allow ?? 0), deny: BigInt(o?.deny ?? 0) };
}
const cache = (sc: Scene, id: string) => (surcharge(sc, id).deny & VUE) !== 0n;
const voitExpres = (sc: Scene, id: string) => (surcharge(sc, id).allow & VUE) !== 0n;

const cle = (id: string) => `${IDS.GUILD}:${id}`;
const BLOQUE = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect;
const salonBrut = (sc: Scene) => sc.monde.salons.get(sc.salonId)! as Brut;

/** Ouvre « Propriété » (bouton du panneau public, dans les deux modes) et rend le sous-panneau. */
async function ouvrirPropriete(sc: Scene, acteur = IDS.PROPRIO): Promise<Brut | null> {
  await cliquer(sc, { customId: 'tempvoice:propriete', genre: 'bouton', acteur, porteur: sc.monde.messages.get(sc.panneauId)! });
  return porteurDe(sc, 'tempvoice:transfer');
}

async function mesReglages(sc: Scene, valeur: 'save' | 'apply' | 'forget') {
  const porteur = await ouvrirPropriete(sc);
  if (!trouverComposant(porteur, 'tempvoice:saved_select')) throw new Error('Menu « Mes réglages » absent');
  return cliquer(sc, { customId: 'tempvoice:saved_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: [valeur], porteur });
}

async function transferer(sc: Scene, cible: string) {
  await ouvrirPropriete(sc);
  await cliquer(sc, { customId: 'tempvoice:transfer', genre: 'bouton', acteur: IDS.PROPRIO, porteur: porteurDe(sc, 'tempvoice:transfer') });
  return cliquer(sc, { customId: 'tempvoice:transfer_select', genre: 'menuMembres', acteur: IDS.PROPRIO, values: [cible], porteur: porteurDe(sc, 'tempvoice:transfer_select') });
}

const reglagesDe = (o: Record<string, unknown> = {}) => ({
  nom: 'Repaire perso', limite: 7, verrouille: false, visibilite: 'tous', bloques: [IDS.CIBLE], autorises: [], modeEcriture: null, ...o,
});
const contient = (lignes: LigneJournal[], texte: string) => lignes.some((l) => JSON.stringify(l).includes(texte));

afterAll(() => setSystemTime());

describe('Mes réglages — menu de la section Propriété', () => {
  for (const mode of ['CLASSIC', 'FLAT'] as const) {
    test(`${mode} : présent pour le propriétaire, trois options avec emoji et description`, async () => {
      sauves.clear();
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode });
      const p0 = await ouvrirPropriete(sc);
      const menu = trouverComposant(p0, "tempvoice:saved_select");
      const options = (menu?.options ?? []) as Brut[];
      expect(options.map((o) => o.value)).toEqual(['save', 'apply', 'forget']);
      expect(options.every((o) => typeof o.description === 'string' && o.description.length > 0)).toBe(true);
      expect(options.map((o) => String(o.label).slice(0, 2))).toEqual(['💾', '♻️'.slice(0, 2), '🗑️'.slice(0, 2)]);
    });
    test(`${mode} : absent si reglagesPerso = false`, async () => {
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode, reglagesPerso: false });
      const porteur = await ouvrirPropriete(sc);
      expect(trouverComposant(porteur, 'tempvoice:transfer')).toBeTruthy();
      expect(trouverComposant(porteur, 'tempvoice:saved_select')).toBeFalsy();
    });
  }
});

describe('Mes réglages — enregistrer, appliquer, oublier', () => {
  test('save capture le salon, apply le remet sur un nouveau salon, forget efface ; chaque action journalisée', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    sc.monde.poserSurchargeDirecte(sc.salonId, IDS.CIBLE, 1, 0n, BLOQUE);
    await choisir(sc, 'prive');
    const logSave = (await mesReglages(sc, 'save')).filter((l) => l.type === 'voice_panel');
    expect(logSave).toHaveLength(1);
    expect(JSON.stringify(logSave[0].champs)).toContain('tempvoice:saved_select');
    const enregistre = sauves.get(cle(IDS.PROPRIO)) as Brut;
    expect(enregistre.bloques).toContain(IDS.CIBLE);
    expect(enregistre.visibilite).toBe('prive');

    // Nouveau salon, réglages sur la base reprise : on retire le blocage, apply le remet.
    const sc2 = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', garderBase: true });
    sc2.monde.poserSurchargeDirecte(sc2.salonId, IDS.CIBLE, 1, 0n, 0n);
    await sc2.monde.calme(sc2.enCours);
    expect(cache(sc2, IDS.CIBLE)).toBe(false);
    const logApply = (await mesReglages(sc2, 'apply')).filter((l) => l.type === 'voice_panel');
    expect(logApply).toHaveLength(1);
    expect(cache(sc2, IDS.CIBLE)).toBe(true);
    expect(cache(sc2, IDS.GUILD)).toBe(true);
    expect(tv.tempChannels.get(sc2.salonId)?.visibility).toBe('prive');

    const logForget = (await mesReglages(sc2, 'forget')).filter((l) => l.type === 'voice_panel');
    expect(logForget).toHaveLength(1);
    expect(sauves.has(cle(IDS.PROPRIO))).toBe(false);
  });

  test('apply sans réglages : « Aucun réglage enregistré »', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'FLAT' });
    const lignes = await mesReglages(sc, 'apply');
    expect(contient(lignes, m.panel_tempvoice_saved_none({}, { locale: 'fr' }))).toBe(true);
  });
});

describe('Mes réglages — à la création', () => {
  test('le bloqué enregistré n\'a pas la vue DÈS la création (surcharge dans le POST)', async () => {
    reglerBase({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    sauves.clear();
    sauves.set(cle(IDS.PROPRIO), reglagesDe());
    const debut = journal.length;
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', garderBase: true });
    const creation = sc.monde.appels.find((a) => a.methode === 'POST' && /\/guilds\/\d+\/channels$/.test(a.route)) as AppelRest;
    const ow = ((creation.corps as Brut).permission_overwrites as Brut[]).find((o) => o.id === IDS.CIBLE);
    expect((BigInt(ow?.deny ?? 0) & VUE) !== 0n).toBe(true);
    expect(cache(sc, IDS.CIBLE)).toBe(true);
    expect(salonBrut(sc).name).toBe('Repaire perso');
    expect(salonBrut(sc).user_limit).toBe(7);
    expect(contient(journal.slice(debut), 'appliqués à la création')).toBe(true);
  });

  test('reglagesPerso = false : rien appliqué à la création', async () => {
    reglerBase({ langue: 'fr', format: 'V2', mode: 'CLASSIC', reglagesPerso: false });
    sauves.clear();
    sauves.set(cle(IDS.PROPRIO), reglagesDe());
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', garderBase: true, reglagesPerso: false });
    expect(cache(sc, IDS.CIBLE)).toBe(false);
    expect(salonBrut(sc).name).not.toBe('Repaire perso');
  });
});

describe('Visibilité du générateur et staff', () => {
  test('générateur « Privé », sans réglages enregistrés : caché à @everyone dès la création, le staff garde la vue', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', visibilite: 'prive' });
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(voitExpres(sc, IDS.ROLE_MOD)).toBe(true);
    expect(voitExpres(sc, IDS.PROPRIO)).toBe(true);
  });

  test('menu Visibilité → Privé : le staff garde la vue', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    expect(voitExpres(sc, IDS.ROLE_MOD)).toBe(false);
    await choisir(sc, 'prive');
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(voitExpres(sc, IDS.ROLE_MOD)).toBe(true);
  });
});

describe('Mes réglages — au transfert', () => {
  test('le nouveau propriétaire a des réglages : le salon prend les siens', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    sauves.set(cle(IDS.AUTORISE), reglagesDe({ nom: 'Chez Autorise', limite: 4, bloques: [IDS.INCONNU] }));
    const lignes = await transferer(sc, IDS.AUTORISE);
    expect(tv.tempChannels.get(sc.salonId)?.creatorId).toBe(IDS.AUTORISE);
    expect(salonBrut(sc).name).toBe('Chez Autorise');
    expect(salonBrut(sc).user_limit).toBe(4);
    expect(cache(sc, IDS.INCONNU)).toBe(true);
    expect(contient(lignes, 'appliqués au transfert')).toBe(true);
    expect(lignes.some((l) => l.type === 'voice_panel' && JSON.stringify(l.champs).includes('tempvoice:transfer_select'))).toBe(true);
  });

  test('sans réglages : le salon garde ceux du précédent', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    sc.monde.poserSurchargeDirecte(sc.salonId, IDS.CIBLE, 1, 0n, BLOQUE);
    await sc.monde.calme(sc.enCours);
    const nom = salonBrut(sc).name;
    const lignes = await transferer(sc, IDS.AUTORISE);
    expect(tv.tempChannels.get(sc.salonId)?.creatorId).toBe(IDS.AUTORISE);
    expect(salonBrut(sc).name).toBe(nom);
    expect(cache(sc, IDS.CIBLE)).toBe(true);
    expect(contient(lignes, 'appliqués au transfert')).toBe(false);
  });

  test('reglagesPerso = false : rien appliqué au transfert', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', reglagesPerso: false });
    sauves.set(cle(IDS.AUTORISE), reglagesDe({ nom: 'Chez Autorise' }));
    const nom = salonBrut(sc).name;
    await transferer(sc, IDS.AUTORISE);
    expect(tv.tempChannels.get(sc.salonId)?.creatorId).toBe(IDS.AUTORISE);
    expect(salonBrut(sc).name).toBe(nom);
  });
});

// ─── Correctifs de la relecture : chaque cas rejoue le parcours sur le banc ───

const P = PermissionFlagsBits;
const a = (sc: Scene, id: string, bit: bigint) => (surcharge(sc, id).allow & bit) !== 0n;
const refuse = (sc: Scene, id: string, bit: bigint) => (surcharge(sc, id).deny & bit) !== 0n;
const estEnVocal = (sc: Scene, id: string) => sc.monde.etatsVocaux.get(id) === sc.salonId;

/** Remplace une réponse du faux Discord : `null` laisse passer la requête. */
function intercepter(m: FauxDiscord, fn: (o: Brut) => Promise<unknown> | null) {
  const traiter = m.traiter.bind(m);
  m.traiter = (o: Brut) => fn(o) ?? traiter(o);
}
const estRenommage = (o: Brut) => o.method === 'PATCH' && /^\/channels\/\d+$/.test(String(o.fullRoute)) && typeof o.body?.name === 'string';

/** Salon créé avec des réglages enregistrés (base remise à neuf, puis réglages posés). */
async function creerAvec(r: Record<string, unknown>, opts: Partial<OptionsScene> = {}) {
  const o: OptionsScene = { langue: 'fr', format: 'V2', mode: 'CLASSIC', ...opts };
  reglerBase(o);
  sauves.clear();
  sauves.set(cle(IDS.PROPRIO), reglagesDe(r));
  return monterScene({ ...o, garderBase: true });
}

describe('Réglages enregistrés — générateur additionnel', () => {
  test('suit la visibilité du serveur', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', additionnel: true, visibilite: 'prive' });
    expect(tv.tempChannels.get(sc.salonId)?.generateurId).toBe(GEN2);
    expect(cache(sc, IDS.GUILD)).toBe(true);
  });

  test('applique les réglages enregistrés', async () => {
    const sc = await creerAvec({}, { additionnel: true });
    expect(cache(sc, IDS.CIBLE)).toBe(true);
    expect(salonBrut(sc).name).toBe('Repaire perso');
  });

  test('additionnel, réglages par personne coupés au serveur : rien appliqué', async () => {
    const sc = await creerAvec({}, { additionnel: true, reglagesPerso: false });
    expect(salonBrut(sc).name).not.toBe('Repaire perso');
  });
});

describe('Réglages enregistrés — ordre, verrou et visibilité', () => {
  test('verrouillé + Privé : Connect reste refusé, staff et bot gardent le salon, le propriétaire écrit', async () => {
    const sc = await creerAvec({ verrouille: true, visibilite: 'prive' });
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    expect(refuse(sc, IDS.GUILD, P.ViewChannel)).toBe(true);
    expect(a(sc, IDS.ROLE_MOD, P.ViewChannel) && a(sc, IDS.ROLE_MOD, P.Connect)).toBe(true);
    expect(a(sc, IDS.PROPRIO, P.SendMessages)).toBe(true);
    expect(sc.monde.peutEcrire(sc.salonId, IDS.BOT)).toBe(true);
    for (const bit of [P.ViewChannel, P.Connect, P.ManageChannels]) expect(a(sc, IDS.BOT, bit)).toBe(true);
  });

  test('Privé du générateur : le bot garde vue, connexion et gestion du salon', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', visibilite: 'prive' });
    for (const bit of [P.ViewChannel, P.Connect, P.ManageChannels]) expect(a(sc, IDS.BOT, bit)).toBe(true);
  });

  test('renommage refusé par Discord : visibilité et limite posées quand même, l échec est journalisé', async () => {
    avertissements.length = 0;
    const sc = await creerAvec({ visibilite: 'prive' }, {
      avantCreation: (m) => intercepter(m, (o) => (estRenommage(o) ? Promise.reject(new Error('Missing Permissions')) : null)),
    });
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(cache(sc, IDS.CIBLE)).toBe(true);
    expect(salonBrut(sc).user_limit).toBe(7);
    expect(avertissements.some((t) => t.includes('« nom »'))).toBe(true);
  });

  test('renommage sans réponse (limite de débit) : la limite passe, le salon est servi', async () => {
    // Borné : un renommage attendu sans fin retiendrait la création, et le test avec.
    const sc = await Promise.race([
      creerAvec({}, {
        avantCreation: (m) => intercepter(m, (o) => (estRenommage(o) ? new Promise(() => undefined) : null)),
      }),
      new Promise<never>((_, rejeter) => setTimeout(() => rejeter(new Error('création retenue par le renommage')), 10_000)),
    ]);
    expect(salonBrut(sc).user_limit).toBe(7);
    expect(cache(sc, IDS.CIBLE)).toBe(true);
  }, 15_000);

  test('salon réservé à un rôle : appliquer des réglages « ouvert » et « Privé » ne touche ni le verrou ni la visibilité', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    await cliquer(sc, { customId: 'tempvoice:reserve_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: [IDS.ROLE_RESA], porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(base.salons.get(sc.salonId)?.roleId).toBe(IDS.ROLE_RESA);
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ verrouille: false, visibilite: 'prive', bloques: [] }));
    await mesReglages(sc, 'apply');
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    expect(cache(sc, IDS.GUILD)).toBe(false);
    expect(tv.tempChannels.get(sc.salonId)?.visibility).toBe('tous');
  });

  test('salon réservé à des membres : appliquer des réglages « ouvert » et « Privé » ne touche ni le verrou ni la visibilité', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    await cliquer(sc, { customId: 'tempvoice:reserve_membres', genre: 'menuMembres', acteur: IDS.PROPRIO, values: [IDS.AUTORISE], porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ verrouille: false, visibilite: 'prive', bloques: [], autorises: [IDS.DEHORS] }));
    const lignes = await mesReglages(sc, 'apply');
    expect(contient(lignes, m.panel_tempvoice_saved_done_apply_reserved({}, { locale: 'fr' }))).toBe(true);
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    expect(cache(sc, IDS.GUILD)).toBe(false);
    expect(tv.tempChannels.get(sc.salonId)?.visibility).toBe('tous');
    // Les autorisés, eux, s'ajoutent : comme « Autoriser » sur un salon réservé.
    expect(a(sc, IDS.DEHORS, P.Connect)).toBe(true);
  });

  test('réglages enregistrés ouverts dans une catégorie fermée : Connect rendu = refus de la catégorie, jamais null', async () => {
    const o: OptionsScene = { langue: 'fr', format: 'V2', mode: 'CLASSIC', categorie: [
      { id: IDS.GUILD, type: 0, allow: '0', deny: P.Connect.toString() },
      { id: IDS.ROLE_BOT, type: 0, allow: P.Connect.toString(), deny: '0' },
    ] };
    reglerBase(o);
    sauves.clear();
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ verrouille: false, bloques: [] }));
    const sc = await monterScene({ ...o, garderBase: true });
    expect(salonBrut(sc).parent_id).toBe(CAT);
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    expect(a(sc, IDS.GUILD, P.Connect)).toBe(false);
  });
});

describe('Réglages enregistrés — mêmes règles que « Autoriser » et « Bannir »', () => {
  test('un staff bloqué ne l est pas, un bloqué présent est déconnecté', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    expect(estEnVocal(sc, IDS.CIBLE)).toBe(true);
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ bloques: [IDS.STAFF, IDS.CIBLE, IDS.PROPRIO] }));
    await mesReglages(sc, 'apply');
    expect(cache(sc, IDS.CIBLE)).toBe(true);
    expect(estEnVocal(sc, IDS.CIBLE)).toBe(false);
    expect(cache(sc, IDS.STAFF)).toBe(false);
    expect(estEnVocal(sc, IDS.STAFF)).toBe(true);
    expect(cache(sc, IDS.PROPRIO)).toBe(false);
  });

  test('« ceux en vocal » : un autorisé enregistré garde son droit après être passé dans le salon', async () => {
    const sc = await creerAvec({ bloques: [], autorises: [IDS.DEHORS], modeEcriture: 'inVoice' });
    expect(a(sc, IDS.DEHORS, P.Connect)).toBe(true);
    const avant = surcharge(sc, IDS.DEHORS);
    avancer(1_500);
    sc.monde.bouger(IDS.DEHORS, sc.salonId);
    await sc.monde.calme(sc.enCours);
    avancer(1_500);
    sc.monde.bouger(IDS.DEHORS, null);
    await sc.monde.calme(sc.enCours);
    expect(surcharge(sc, IDS.DEHORS)).toEqual(avant);
  });

  test('« ceux en vocal » : en sortir garde l’écriture d’un autorisé enregistré présent, comme « Autoriser »', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const panneau = sc.monde.messages.get(sc.panneauId)!;
    await cliquer(sc, { customId: 'tempvoice:mode_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: ['inVoice'], porteur: panneau });
    expect(tv.tempChannels.get(sc.salonId)?.modeEcriture).toBe('inVoice');
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ bloques: [], autorises: [IDS.DEHORS] }));
    await mesReglages(sc, 'apply');
    avancer(1_500);
    sc.monde.bouger(IDS.DEHORS, sc.salonId);
    await sc.monde.calme(sc.enCours);
    expect(a(sc, IDS.DEHORS, P.SendMessages)).toBe(true);
    await cliquer(sc, { customId: 'tempvoice:mode_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: ['everyone'], porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(tv.tempChannels.get(sc.salonId)?.modeEcriture).toBe('everyone');
    // Une présence perdrait son bit au changement de mode ; une autorisation ne bouge pas.
    expect(a(sc, IDS.DEHORS, P.SendMessages)).toBe(true);
    expect(a(sc, IDS.DEHORS, P.Connect)).toBe(true);
  });
});

describe('« Suit l accès » après chaque changement de l entrée de @everyone', () => {
  const acces = () => monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', visibilite: 'acces' });

  test('réserver à un rôle cache le salon, lever la réservation le rend visible', async () => {
    sauves.clear();
    const sc = await acces();
    expect(cache(sc, IDS.GUILD)).toBe(false);
    const porteur = sc.monde.messages.get(sc.panneauId)!;
    await cliquer(sc, { customId: 'tempvoice:reserve_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: [IDS.ROLE_RESA], porteur });
    expect(cache(sc, IDS.GUILD)).toBe(true);
    await cliquer(sc, { customId: 'tempvoice:reserve_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: [], porteur });
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(false);
    expect(cache(sc, IDS.GUILD)).toBe(false);
  });

  test('réserver à des membres cache le salon', async () => {
    sauves.clear();
    const sc = await acces();
    await cliquer(sc, { customId: 'tempvoice:reserve_membres', genre: 'menuMembres', acteur: IDS.PROPRIO, values: [IDS.AUTORISE], porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    expect(cache(sc, IDS.GUILD)).toBe(true);
  });

  test('anciens boutons lock / unlock', async () => {
    sauves.clear();
    const sc = await acces();
    const porteur = sc.monde.messages.get(sc.panneauId)!;
    await cliquer(sc, { customId: 'tempvoice:lock', genre: 'bouton', acteur: IDS.PROPRIO, porteur });
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(sc.monde.peutEcrire(sc.salonId, IDS.BOT)).toBe(true);
    await cliquer(sc, { customId: 'tempvoice:unlock', genre: 'bouton', acteur: IDS.PROPRIO, porteur });
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(false);
    expect(cache(sc, IDS.GUILD)).toBe(false);
  });

  test('réservation posée puis levée depuis le dashboard', async () => {
    sauves.clear();
    const sc = await acces();
    expect((await patchDashboard(sc, { roleId: IDS.ROLE_RESA })).statusCode).toBe(200);
    await sc.monde.calme(sc.enCours);
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect((await patchDashboard(sc, { roleId: null })).statusCode).toBe(200);
    await sc.monde.calme(sc.enCours);
    expect(cache(sc, IDS.GUILD)).toBe(false);
  });
});

describe('« Mes réglages » — petits points', () => {
  test('fonction coupée par le serveur après l ouverture du menu : refus, rien enregistré', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const porteur = await ouvrirPropriete(sc);
    configServeur.tempVoiceDefaults = { reglagesPerso: false };
    const lignes = await cliquer(sc, { customId: 'tempvoice:saved_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: ['save'], porteur });
    expect(sauves.has(cle(IDS.PROPRIO))).toBe(false);
    expect(contient(lignes, m.panel_tempvoice_saved_disabled({}, { locale: 'fr' }))).toBe(true);
  });

  // L'entrée nominative que `garderEntreeStaff` pose à un staff qui verrouille (propriétaire du bot sans rôle staff).
  test('« Enregistrer » ne compte pas l entrée nominative d un staff parmi les autorisés', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    sc.monde.poserSurchargeDirecte(sc.salonId, IDS.STAFF, 1, P.ViewChannel | P.Connect);
    await sc.monde.calme(sc.enCours);
    await mesReglages(sc, 'save');
    const r = sauves.get(cle(IDS.PROPRIO)) as Brut;
    expect(r.autorises).toContain(IDS.AUTORISE);
    expect(r.autorises).not.toContain(IDS.STAFF);
  });

  test('visibilité du générateur persistée à la création', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', visibilite: 'prive' });
    expect(base.salons.get(sc.salonId)?.visibility).toBe('prive');
  });
});

describe('Réglages enregistrés — chaque cible à part, bloqués absents, mesures', () => {
  const ABSENT = '900000000000000177';
  const ABSENT2 = '900000000000000178'; // scan:ok (identifiant factice du banc)
  const routeSurcharge = (sc: Scene, id: string) => `/channels/${sc.salonId}/permissions/${id}`;
  const lecturesSalon = (sc: Scene, depuis: number) =>
    sc.monde.appels.slice(depuis).filter((x) => x.methode === 'GET' && x.route === `/channels/${sc.salonId}`).length;

  test('un bloqué refusé par Discord n arrête pas les suivants, ni un autorisé refusé les autres', async () => {
    sauves.clear();
    avertissements.length = 0;
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ bloques: [IDS.CIBLE, IDS.INCONNU], autorises: [IDS.AUTORISE, IDS.DEHORS] }));
    intercepter(sc.monde, (x) => (x.method === 'PUT' && [routeSurcharge(sc, IDS.CIBLE), routeSurcharge(sc, IDS.AUTORISE)].includes(String(x.fullRoute))
      ? Promise.reject(new Error('Missing Permissions'))
      : null));
    await mesReglages(sc, 'apply');
    expect(cache(sc, IDS.INCONNU)).toBe(true);
    expect(a(sc, IDS.DEHORS, P.Connect)).toBe(true);
    expect(avertissements.some((t) => t.includes(IDS.CIBLE) && t.includes('Missing Permissions'))).toBe(true);
    expect(salonBrut(sc).name).toBe('Repaire perso');
  });

  test('un bloqué parti du serveur reste bloqué par son identifiant, en un seul appel pour tous les absents', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const membres = sc.client.guilds.cache.get(IDS.GUILD)!.members;
    const lire = membres.fetch.bind(membres);
    const lectures: unknown[] = [];
    (membres as unknown as { fetch: unknown }).fetch = (o: unknown) => { lectures.push(o); return lire(o as never); };
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ bloques: [ABSENT, IDS.CIBLE, ABSENT2] }));
    await mesReglages(sc, 'apply');
    for (const id of [ABSENT, ABSENT2, IDS.CIBLE]) expect(cache(sc, id)).toBe(true);
    expect(lectures).toHaveLength(1);
    expect((lectures[0] as { user: string[] }).user).toEqual([ABSENT, ABSENT2]);
  });

  test('lecture des membres en échec : l id illisible est sauté (staff possible), le membre connu reste bloqué', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const membres = sc.client.guilds.cache.get(IDS.GUILD)!.members;
    (membres as unknown as { fetch: unknown }).fetch = () => Promise.reject(new Error('GuildMembersTimeout'));
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ bloques: [ABSENT, IDS.CIBLE] }));
    await mesReglages(sc, 'apply');
    expect(cache(sc, ABSENT)).toBe(false);
    expect(cache(sc, IDS.CIBLE)).toBe(true);
  });

  test('à la création, un bloqué absent n est pas dans le POST mais est bloqué juste après', async () => {
    const sc = await creerAvec({ bloques: [IDS.CIBLE, ABSENT] });
    const creation = sc.monde.appels.find((x) => x.methode === 'POST' && /\/guilds\/\d+\/channels$/.test(x.route)) as AppelRest;
    const ids = ((creation.corps as Brut).permission_overwrites as Brut[]).map((o) => o.id);
    expect(ids).toContain(IDS.CIBLE);
    expect(ids).not.toContain(ABSENT);
    expect(cache(sc, ABSENT)).toBe(true);
  });

  test('à la création, chaque bloqué n est jugé qu une fois', async () => {
    lecturesConfig = 0;
    await creerAvec({ bloques: [] });
    const sans = lecturesConfig;
    lecturesConfig = 0;
    await creerAvec({ bloques: [IDS.CIBLE, IDS.INCONNU] });
    expect(lecturesConfig - sans).toBe(2);
  });

  test('« Enregistrer » garde un staff que le propriétaire a autorisé lui-même', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    await cliquer(sc, { customId: 'tempvoice:trust_select', genre: 'menuMembres', acteur: IDS.PROPRIO, values: [IDS.STAFF], porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(a(sc, IDS.STAFF, P.Connect)).toBe(true);
    await mesReglages(sc, 'save');
    expect((sauves.get(cle(IDS.PROPRIO)) as Brut).autorises).toContain(IDS.STAFF);
  });

  test('« Appliquer » : une relecture par étape qui écrit, pas plus', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    sauves.set(cle(IDS.PROPRIO), reglagesDe({ verrouille: true, visibilite: 'prive', bloques: [IDS.CIBLE], autorises: [IDS.DEHORS] }));
    const porteur = await ouvrirPropriete(sc);
    const debut = sc.monde.appels.length;
    await cliquer(sc, { customId: 'tempvoice:saved_select', genre: 'menuTexte', acteur: IDS.PROPRIO, values: ['apply'], porteur });
    expect(cache(sc, IDS.GUILD)).toBe(true);
    // Entrée, bloqués, verrou (et l'écriture du bot qui le suit), autorisés, visibilité, panneau : chaque relecture suit une écriture.
    expect(lecturesSalon(sc, debut)).toBeLessThanOrEqual(7);
  });

  test('verrou en « Suit l accès » : relectures du salon bornées', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', visibilite: 'acces' });
    const debut = sc.monde.appels.length;
    await cliquer(sc, { customId: 'tempvoice:bascule_verrou', genre: 'bouton', acteur: IDS.PROPRIO, porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(sc.monde.peutEcrire(sc.salonId, IDS.BOT)).toBe(true);
    expect(lecturesSalon(sc, debut)).toBeLessThanOrEqual(5);
    const debut2 = sc.monde.appels.length;
    await cliquer(sc, { customId: 'tempvoice:bascule_verrou', genre: 'bouton', acteur: IDS.PROPRIO, porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(cache(sc, IDS.GUILD)).toBe(false);
    expect(lecturesSalon(sc, debut2)).toBeLessThanOrEqual(5);
  });

  test('verrou en « Suit l accès » sans CHANNEL_UPDATE : verrou et réouverture gardent les écritures qui les précèdent', async () => {
    sauves.clear();
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', visibilite: 'acces' });
    // Passerelle muette : seule une relecture forcée met le cache à jour.
    (sc.monde as unknown as { annoncerSalon: () => void }).annoncerSalon = () => {};
    // Un mode mémorisé : la réouverture rend l'écriture par une seconde écriture sur @everyone.
    tv.tempChannels.get(sc.salonId)!.modeEcriture = 'everyone';
    const ecrivaitAvant = sc.monde.peutEcrire(sc.salonId, IDS.INCONNU);
    await cliquer(sc, { customId: 'tempvoice:bascule_verrou', genre: 'bouton', acteur: IDS.PROPRIO, porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(true);
    expect(sc.monde.peutEcrire(sc.salonId, IDS.BOT)).toBe(true);
    await cliquer(sc, { customId: 'tempvoice:bascule_verrou', genre: 'bouton', acteur: IDS.PROPRIO, porteur: sc.monde.messages.get(sc.panneauId)! });
    expect(cache(sc, IDS.GUILD)).toBe(false);
    expect(refuse(sc, IDS.GUILD, P.Connect)).toBe(false);
    expect(sc.monde.peutEcrire(sc.salonId, IDS.INCONNU)).toBe(ecrivaitAvant);
  });
});

// ─── Route du dashboard, appelée avec le client du banc ───

async function patchDashboard(sc: Scene, corps: Record<string, unknown>) {
  const { IncomingMessage, ServerResponse } = await import('node:http');
  const { Socket } = await import('node:net');
  const { handleChannelsManagementRoutes } = await import('../../api/routes/dashboard/modules/channels-management.js');
  const { DASHBOARD_ACCESS_ADMIN } = await import('../../api/shared.js');
  const req = new IncomingMessage(new Socket());
  req.method = 'PATCH';
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(corps));
  req.push(null);
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  let code = 200;
  Object.defineProperty(res, 'statusCode', { get: () => code, set: (v: number) => { code = v; } });
  res.setHeader = () => res;
  res.writeHead = ((statut: number) => { code = statut; return res; }) as never;
  res.end = (() => res) as never;
  const route = `/api/dashboard/guilds/${IDS.GUILD}/channels-management/temp-voice/channels/${sc.salonId}`;
  await handleChannelsManagementRoutes({
    req, res, parts: route.split('/').filter(Boolean), url: new URL(`http://localhost${route}`), client: sc.client,
    user: { userId: IDS.ADMIN, username: 'admin' } as never, guildId: IDS.GUILD, access: DASHBOARD_ACCESS_ADMIN as never,
    method: 'PATCH', auditUser: 'admin (dashboard)', moduleKey: 'channels-management',
  });
  return res;
}
