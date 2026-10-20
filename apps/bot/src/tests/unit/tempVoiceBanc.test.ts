/**
 * BANC D'INTERACTIONS du panneau des salons vocaux temporaires.
 *
 * Ce que ce fichier remplace : le test « à la main » dans Discord. Un vrai
 * `Client` discord.js (REST intercepté, passerelle rejouée) reçoit des charges
 * gateway brutes ; le code de production répond par les vraies méthodes
 * discord.js et `patchV2` ; le faux Discord (`helpers/bancDiscord.ts`) applique
 * les règles de l'API et garde la trace de chaque appel.
 *
 * Le salon et son panneau public sont créés par le VRAI chemin : un membre
 * rejoint le générateur, l'écouteur crée le salon et poste le panneau. On clique
 * ensuite sur les composants de ce message, ou sur un sous-panneau éphémère.
 */
import { afterAll, describe, expect, mock, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import { Events, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';

import { completeModuleMock } from '../helpers/moduleMock.js';
import {
  FauxDiscord,
  IDS,
  clesBrutes,
  trouverComposant,
  horsLangue,
  suivreEcouteurs,
  textesVisibles,
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
    findUnique: mock(async (a: { where: { guildId_userId: { guildId: string; userId: string } } }) => {
      coutBase();
      const cle = `${a.where.guildId_userId.guildId}:${a.where.guildId_userId.userId}`;
      return base.profils.has(cle) ? { tempVoiceWriteNoAsk: structuredClone(base.profils.get(cle)) } : null;
    }),
    upsert: mock(async (a: { where: { guildId_userId: { guildId: string; userId: string } }; update: { tempVoiceWriteNoAsk: unknown } }) => {
      coutBase();
      base.profils.set(`${a.where.guildId_userId.guildId}:${a.where.guildId_userId.userId}`, structuredClone(a.update.tempVoiceWriteNoAsk));
      return {};
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
    getCachedGuild: mock(async () => { if (monde) monde.horloge += 2; return { ...configServeur }; }),
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
type ModeChat = 'inherit' | 'everyone' | 'inVoice' | 'ownerOnly' | 'nobody';
type Role = 'proprietaire' | 'autorise' | 'staff' | 'staffSansDroits' | 'inconnu' | 'admin';

const ACTEUR: Record<Role, string> = {
  proprietaire: IDS.PROPRIO,
  autorise: IDS.AUTORISE,
  staff: IDS.STAFF,
  staffSansDroits: IDS.STAFF,
  inconnu: IDS.INCONNU,
  admin: IDS.ADMIN,
};

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
}

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
    tempVoiceCategoryId: null,
    tempVoiceNameTemplate: opts.modeleNom ?? 'Salon de {user}',
    tempVoiceDefaults: {},
    moderatorRoleId: IDS.ROLE_MOD,
    language: opts.langue,
  };
}

/** Monte un monde, crée le salon par le générateur, fait entrer les autres. */
async function monterScene(opts: OptionsScene): Promise<Scene> {
  if (!opts.garderBase) reglerBase(opts);
  const m = new FauxDiscord({ latenceRestMs: opts.latenceRestMs ?? Number(process.env.BANC_LATENCE ?? 150), langueDiscord: opts.langue === 'fr' ? 'fr' : 'en-US' });
  monde = m;
  const client = m.creerClient();
  const enCours = suivreEcouteurs(client);
  tv.registerTempVoiceListener(client);

  const avant = new Set(tv.tempChannels.keys());
  // Chaque arrivée un peu plus tard que la précédente : l'anti-rebond du panneau
  // ne laisse ainsi aucun minuteur réel en attente derrière la scène.
  avancer(1_500);
  m.bouger(IDS.PROPRIO, IDS.GEN);
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

type Genre = 'bouton' | 'menuTexte' | 'menuMembres' | 'menuRoles' | 'modale';
type Brut = Record<string, any>;

interface Clic {
  customId: string;
  genre: Genre;
  acteur: string;
  values?: string[];
  champs?: Record<string, string>;
  /** Message porteur du composant (charge brute), `null` pour une fenêtre ouverte sans message. */
  porteur: Brut | null;
  ageMs?: number;
}

interface Rapport {
  appels: AppelRest[];
  interactionId: string;
  acks: number;
  erreursDiscord: string[];
  refusLocaux: string[];
  violations: string[];
  textes: string[];
  enAttente: boolean;
  journal: LigneJournal[];
  mutations: AppelRest[];
  avertissements: string[];
  horlogeAck: number | null;
  erreursBanc: string[];
  /** Messages créés ou édités par ce clic, du plus ancien au plus récent. */
  touches: string[];
  modale: Brut | null;
  /** Les interactions simultanées (double clic). */
  autres?: Rapport[];
  /** Éphémères encore visibles, par membre, depuis le début de la scène. */
  ephemeresVisibles: Record<string, number>;
}

function composantPublic(sc: Scene, customId: string): Brut | null {
  return trouverComposant(sc.monde.messages.get(sc.panneauId), customId);
}

/**
 * Un message porteur fabriqué : un sous-panneau éphémère (ce qu'ouvre une
 * porte), ou un ANCIEN panneau public V1 (d'avant la refonte, pour les anciens
 * identifiants). Utilisé seulement quand le parcours réel n'y mène pas.
 */
function porteurFabrique(sc: Scene, clic: Omit<Clic, 'porteur'>, ephemere: boolean, mp = false): Brut {
  const m = sc.monde;
  if (mp) {
    const bouton = { type: 2, style: 2, custom_id: clic.customId, label: 'x' };
    return m.creerMessage(m.canalMp(clic.acteur), { flags: 0, components: [{ type: 1, components: [bouton] }] });
  }
  const type = { bouton: 2, menuTexte: 3, menuMembres: 5, menuRoles: 6, modale: 2 }[clic.genre];
  const composant = type === 2
    ? { type: 2, style: 2, custom_id: clic.customId, label: 'x' }
    : { type, custom_id: clic.customId, ...(type === 3 ? { options: (clic.values ?? ['x']).map((v) => ({ label: v, value: v })) } : {}) };
  return m.creerMessage(
    sc.salonId,
    { flags: ephemere ? 64 : 0, content: ephemere ? '' : `<@${IDS.PROPRIO}>`, components: [{ type: 1, components: [composant] }] },
    ephemere ? { interaction_metadata: { id: '1', type: 3, user: m.membres.get(clic.acteur)!.user, authorizing_integration_owners: {} } } : {},
  );
}


/** Envoie l'interaction par le vrai chemin discord.js et attend que tout soit retombé. */
async function cliquer(sc: Scene, clic: Clic, opts: { simultanes?: Clic[] } = {}): Promise<Rapport> {
  avancer(1_500);
  const m = sc.monde;
  monde = m;
  const debut = { appels: m.appels.length, journal: journal.length, avert: avertissements.length, touches: m.touches.length };
  const langue = sc.opts.langue === 'fr' ? 'fr' : 'en-US';
  const bruts = [clic, ...(opts.simultanes ?? [])].map((c) => m.interactionBrute({ ...c, channelId: c.porteur?.channel_id ?? sc.salonId, message: c.porteur, locale: langue }));

  const actions = (sc.client as unknown as { actions: { InteractionCreate: { handle: (d: unknown) => void } } }).actions;
  const emit = sc.client.emit.bind(sc.client);
  (sc.client as unknown as { emit: (...a: unknown[]) => boolean }).emit = (ev: unknown, ...args: unknown[]) => {
    if (ev === Events.InteractionCreate) m.instrumenter(args[0] as Brut);
    return emit(ev as never, ...(args as never[]));
  };
  for (const brut of bruts) actions.InteractionCreate.handle(brut);
  (sc.client as unknown as { emit: unknown }).emit = emit;
  await m.calme(sc.enCours);
  const r = rapporter(sc, bruts[0].id as string, debut);
  r.autres = bruts.slice(1).map((x) => rapporter(sc, x.id as string, debut));
  return r;
}

function rapporter(sc: Scene, interactionId: string, debut: { appels: number; journal: number; avert: number; touches: number }): Rapport {
  const m = sc.monde;
  const appels = m.appels.slice(debut.appels);
  const etat = m.etatInteraction(interactionId)!;
  const aMoi = appels.filter((a) => a.interactionId === interactionId);
  const callbacks = aMoi.filter((a) => a.typeCallback !== undefined);
  const textes = appels.flatMap((a) => textesVisibles(
    (a.typeCallback !== undefined ? (a.corps as { data?: unknown })?.data : a.corps) as Record<string, unknown>,
  ));
  const premierAck = callbacks.find((a) => !a.erreur);
  return {
    appels,
    interactionId,
    acks: callbacks.filter((a) => !a.erreur).length,
    erreursDiscord: appels.filter((a) => a.erreur).map((a) => `${a.methode} ${a.route.replace(/jeton-\d+/, 'TOKEN')} → ${a.erreur!.code} ${a.erreur!.message}`),
    refusLocaux: etat.refusLocaux,
    violations: appels.flatMap((a) => a.violations.map((v) => `${a.methode} ${a.route.replace(/jeton-\d+/, 'TOKEN')} : ${v}`)),
    textes,
    enAttente: etat.enAttente,
    journal: journal.slice(debut.journal),
    mutations: m.mutations(debut.appels),
    avertissements: avertissements.slice(debut.avert),
    horlogeAck: premierAck ? premierAck.t - etat.t0 : null,
    erreursBanc: m.erreursBanc.splice(0),
    touches: m.touches.slice(debut.touches),
    modale: etat.modale ?? null,
    ephemeresVisibles: ephemeresVisibles(m),
  };
}

/** Chaque éphémère créé par une interaction et toujours là, compté pour la personne qui a cliqué. */
function ephemeresVisibles(m: FauxDiscord): Record<string, number> {
  const parMembre: Record<string, number> = {};
  for (const a of m.appels) {
    const msg = a.cree ? m.messages.get(a.cree) : null;
    if (!msg || !(msg.flags & 64) || !a.interactionId) continue;
    const qui = String(m.objetsInteraction.get(a.interactionId)?.user?.id ?? '?');
    parMembre[qui] = (parMembre[qui] ?? 0) + 1;
  }
  return parMembre;
}

// ─── Les invariants de chaque cellule ───

/** Actions que l'écouteur ouvre à tous (miroir de `ACTIONS_OUVERTES` de tempVoice.ts). */
const ACTIONS_OUVERTES = new Set(['claim', 'reclamer', 'demander', 'propriete', 'ecr_appliquer', 'ecr_garder', 'ecr_jamais']);

function problemes(r: Rapport, ctx: { langue: Langue; acteur: string; salonId: string; action: string; refusAttendu: boolean }): string[] {
  const p: string[] = [...r.erreursBanc.map((e) => `BANC : ${e}`)];
  if (r.acks !== 1) p.push(`${r.acks} acquittement(s) initial(aux) au lieu d'un`);
  for (const e of r.erreursDiscord) p.push(`erreur Discord : ${e}`);
  for (const e of r.refusLocaux) p.push(`refus discord.js : ${e}`);
  for (const v of r.violations) p.push(`charge invalide : ${v}`);
  if (r.enAttente) p.push('« réfléchit… » jamais résolu');
  // Une navigation = le panneau public + UN sous-panneau éphémère par membre.
  for (const [qui, n] of Object.entries(r.ephemeresVisibles)) {
    if (n > 1) p.push(`${n} éphémères visibles pour ${qui} (au plus un sous-panneau)`);
  }
  for (const c of clesBrutes(r.textes)) p.push(c);
  for (const c of horsLangue(r.textes, ctx.langue)) p.push(`langue : ${c}`);
  const lignes = r.journal.filter((j) => j.type === 'voice_panel');
  if (lignes.length !== 1) p.push(`${lignes.length} log(s) voice_panel au lieu d'un`);
  else {
    // Le journal est écrit dans la langue du serveur : noms de champs et valeurs.
    const L = { locale: ctx.langue };
    const champ = (n: string) => lignes[0].champs.find((c) => c.name === n)?.value ?? '';
    const issue = champ(m.log_tempvoice_field_outcome({}, L));
    if (!champ(m.log_tempvoice_field_member({}, L)).includes(`<@${ctx.acteur}>`)) p.push(`log voice_panel sans le bon membre (${champ(m.log_tempvoice_field_member({}, L))})`);
    if (!champ(m.log_tempvoice_field_channel({}, L)).includes(`<#${ctx.salonId}>`) || !lignes[0].salons.includes(ctx.salonId)) p.push('log voice_panel sans le bon salon');
    if (issue === m.log_tempvoice_outcome_error({}, L)) p.push(`l'action a levé : ${r.avertissements.filter((a) => a.includes('Erreur')).join(' | ').slice(0, 300)}`);
    if (ctx.refusAttendu && issue !== m.log_tempvoice_outcome_refused({}, L)) p.push(`refus attendu, issue « ${issue || 'aucune'} »`);
    for (const c of horsLangue(lignes[0].champs.flatMap((x) => [x.name, x.value]), ctx.langue)) p.push(`log en ${ctx.langue} : ${c}`);
    for (const c of clesBrutes(lignes[0].champs.flatMap((x) => [x.name, x.value]))) p.push(`log : ${c}`);
  }
  if (ctx.refusAttendu && r.mutations.length) p.push(`refusé mais Discord modifié : ${r.mutations.map((a) => `${a.methode} ${a.route}`).join(', ')}`);
  return p;
}

/// ─── Matrice ───

interface Etape { customId: string; genre: Genre; values?: string[]; acteur?: string; ancien?: boolean }

interface CasAction {
  customId: string;
  genre: Genre;
  values?: string[];
  champs?: Record<string, string>;
  /** Les clics qui mènent au composant (sous-panneau, fenêtre, carte). */
  chemin?: Etape[];
  /** Ancien identifiant : il vit sur un panneau public d'avant la refonte. */
  ancien?: boolean;
  /** Demandes d'accès activées sur le serveur. */
  demandes?: boolean;
  /** Repli de réservation réglé (`MEMBERS` fait proposer des personnes). */
  repli?: string;
  /** Le composant vit dans un MP du bot à la personne qui clique. */
  mp?: boolean;
  /** Le propriétaire a déjà choisi « Ne plus demander » pour la cible. */
  nePlusDemander?: boolean;
  /** Ce que l'action doit avoir fait quand elle est permise ; `null` = fait. */
  effet?: (sc: Scene, r: Rapport) => string | null;
}

const SALON: Etape = { customId: 'tempvoice:salon', genre: 'bouton' };
const MEMBRES: Etape = { customId: 'tempvoice:membres', genre: 'bouton' };
const PROPRIETE: Etape = { customId: 'tempvoice:propriete', genre: 'bouton' };
const REGLAGES: Etape = { customId: 'tempvoice:reglages', genre: 'bouton' };
const RESERVE: Etape = { customId: 'tempvoice:reserve', genre: 'bouton' };
const fiche = (id: string): Etape => ({ customId: 'tempvoice:membre_ici', genre: 'menuTexte', values: [id] });

/** Une écriture REST sur ce chemin du salon, dont le corps passe ce filtre. */
const ecrit = (methode: string, fin: string, filtre: (corps: Brut) => boolean = () => true) => (sc: Scene, r: Rapport) =>
  r.appels.some((x) => x.methode === methode && x.route === `/channels/${sc.salonId}${fin}` && !x.erreur && filtre((x.corps ?? {}) as Brut))
    ? null
    : `aucun ${methode} ${fin || '(salon)'} conforme`;
const refuse = (corps: Brut, bit: bigint) => (BigInt(corps.deny ?? '0') & bit) === bit;
const accorde = (corps: Brut, bit: bigint) => (BigInt(corps.allow ?? '0') & bit) === bit;
const membreDeconnecte = (id: string) => (_sc: Scene, r: Rapport) =>
  r.appels.some((x) => x.methode === 'PATCH' && x.route === `/guilds/${IDS.GUILD}/members/${id}` && (x.corps as Brut)?.channel_id === null && !x.erreur)
    ? null : `${id} non déconnecté`;
const proprietaireDevient = (id: string) => (sc: Scene) =>
  tv.tempChannels.get(sc.salonId)?.creatorId === id ? null : `propriétaire = ${tv.tempChannels.get(sc.salonId)?.creatorId}, attendu ${id}`;
const C = PermissionFlagsBits.Connect;

const CAS: CasAction[] = [
  { customId: 'tempvoice:salon', genre: 'bouton' },
  { customId: 'tempvoice:membres', genre: 'bouton' },
  { customId: 'tempvoice:propriete', genre: 'bouton' },
  { customId: 'tempvoice:reglages', genre: 'bouton' },
  { customId: 'tempvoice:demander', genre: 'bouton' },
  { customId: 'tempvoice:bascule_verrou', genre: 'bouton', chemin: [SALON], effet: ecrit('PUT', `/permissions/${IDS.GUILD}`, (c) => refuse(c, C)) },
  { customId: 'tempvoice:limit', genre: 'bouton', chemin: [SALON] },
  { customId: 'tempvoice:limit_modal', genre: 'modale', champs: { value: '5' }, chemin: [SALON, { customId: 'tempvoice:limit', genre: 'bouton' }], effet: ecrit('PATCH', '', (c) => c.user_limit === 5) },
  { customId: 'tempvoice:rename', genre: 'bouton', chemin: [SALON] },
  { customId: 'tempvoice:rename_modal', genre: 'modale', champs: { value: 'Salon renommé' }, chemin: [SALON, { customId: 'tempvoice:rename', genre: 'bouton' }], effet: ecrit('PATCH', '', (c) => c.name === 'Salon renommé') },
  { customId: 'tempvoice:reserve', genre: 'bouton', chemin: [SALON] },
  { customId: 'tempvoice:reserve_select', genre: 'menuRoles', values: [IDS.ROLE_RESA], chemin: [SALON, RESERVE], effet: ecrit('PUT', `/permissions/${IDS.ROLE_RESA}`, (c) => accorde(c, C)) },
  { customId: 'tempvoice:reserve_membres', genre: 'menuMembres', values: [IDS.CIBLE], chemin: [SALON, RESERVE], repli: 'MEMBERS' },
  {
    customId: 'tempvoice:mode_select', genre: 'menuTexte', values: ['ownerOnly'], chemin: [SALON],
    effet: (sc) => (tv.tempChannels.get(sc.salonId)?.modeEcriture === 'ownerOnly' ? null : `mode = ${tv.tempChannels.get(sc.salonId)?.modeEcriture}`),
  },
  { customId: 'tempvoice:reglages_mod', genre: 'menuTexte', values: ['renommer', 'limite'], chemin: [SALON, REGLAGES] },
  { customId: 'tempvoice:membre_ici', genre: 'menuTexte', values: [IDS.CIBLE], chemin: [MEMBRES] },
  { customId: 'tempvoice:membre_select', genre: 'menuMembres', values: [IDS.CIBLE], chemin: [MEMBRES] },
  { customId: `tempvoice:m_kick:${IDS.CIBLE}`, genre: 'bouton', chemin: [MEMBRES, fiche(IDS.CIBLE)], effet: membreDeconnecte(IDS.CIBLE) },
  { customId: `tempvoice:m_ban:${IDS.CIBLE}`, genre: 'bouton', chemin: [MEMBRES, fiche(IDS.CIBLE)], effet: ecrit('PUT', `/permissions/${IDS.CIBLE}`, (c) => refuse(c, C)) },
  { customId: `tempvoice:m_trust:${IDS.CIBLE}`, genre: 'bouton', chemin: [MEMBRES, fiche(IDS.CIBLE)], effet: ecrit('PUT', `/permissions/${IDS.CIBLE}`, (c) => accorde(c, C)) },
  { customId: `tempvoice:m_untrust:${IDS.AUTORISE}`, genre: 'bouton', chemin: [MEMBRES, fiche(IDS.AUTORISE)] },
  { customId: `tempvoice:m_transfer:${IDS.CIBLE}`, genre: 'bouton', chemin: [MEMBRES, fiche(IDS.CIBLE)], effet: proprietaireDevient(IDS.CIBLE) },
  { customId: `tempvoice:m_ecrire:${IDS.CIBLE}`, genre: 'menuTexte', values: ['deny'], chemin: [MEMBRES, fiche(IDS.CIBLE)], effet: ecrit('PUT', `/permissions/${IDS.CIBLE}`, (c) => refuse(c, PermissionFlagsBits.SendMessages)) },
  // « Redemander » : sur la fiche, seulement pour le propriétaire qui a choisi « Ne plus demander ».
  { customId: `tempvoice:m_redemander:${IDS.CIBLE}`, genre: 'bouton', chemin: [MEMBRES, fiche(IDS.CIBLE)], nePlusDemander: true },
  // MP au propriétaire après un changement de mode qui contredit une exception (porteur : le MP).
  ...(['ecr_appliquer', 'ecr_garder', 'ecr_jamais'] as const).map((a): CasAction => ({
    customId: `tempvoice:${a}:${IDS.CIBLE}:SALON`, genre: 'bouton', mp: true,
    chemin: [{ customId: `tempvoice:m_ecrire:${IDS.CIBLE}`, genre: 'menuTexte', values: ['deny'], acteur: IDS.PROPRIO, ancien: true }],
  })),
  { customId: 'tempvoice:claim', genre: 'bouton', chemin: [PROPRIETE] },
  ...(['resa_rien', 'resa_deplacer', 'resa_deconnecter'] as const).map((a): CasAction => ({
    customId: `tempvoice:${a}`, genre: 'bouton',
    chemin: [SALON, RESERVE, { customId: 'tempvoice:reserve_select', genre: 'menuRoles', values: [IDS.ROLE_RESA] }],
  })),
  ...(['demande_ok', 'demande_non', 'demande_ban'] as const).map((a): CasAction => ({
    customId: `tempvoice:${a}:${IDS.DEHORS}:SALON`, genre: 'bouton', demandes: true,
    chemin: [
      { ...SALON, acteur: IDS.PROPRIO },
      { customId: 'tempvoice:bascule_verrou', genre: 'bouton', acteur: IDS.PROPRIO },
      // Le panneau public ne se redessine qu'une seconde après le verrou (anti-rebond réel, minuteur non
      // simulé) : le bouton « Demander » est pris sur un panneau public fabriqué.
      { customId: 'tempvoice:demander', genre: 'bouton', acteur: IDS.DEHORS, ancien: true },
    ],
  })),
  // Départ du propriétaire : message « Récupérer le salon » posté dans le chat du salon, et son annulation.
  { customId: 'tempvoice:reclamer', genre: 'bouton', ancien: true },
  { customId: `tempvoice:reclam_annuler:${IDS.INCONNU}:SALON`, genre: 'bouton', ancien: true },
  // MP de passation au propriétaire parti : le menu des présents (porteur fabriqué dans le salon).
  { customId: `tempvoice:leader:${IDS.PROPRIO}:SALON`, genre: 'menuTexte', values: [IDS.CIBLE], ancien: true },
  { customId: 'tempvoice:transfer_select', genre: 'menuMembres', values: [IDS.CIBLE], chemin: [PROPRIETE, { customId: 'tempvoice:transfer', genre: 'bouton' }], effet: proprietaireDevient(IDS.CIBLE) },
  { customId: 'tempvoice:trust_select', genre: 'menuMembres', values: [IDS.CIBLE], chemin: [{ customId: 'tempvoice:trust', genre: 'bouton', ancien: true }], effet: ecrit('PUT', `/permissions/${IDS.CIBLE}`, (c) => accorde(c, C)) },
  { customId: 'tempvoice:kick_select', genre: 'menuMembres', values: [IDS.CIBLE], chemin: [{ customId: 'tempvoice:kick', genre: 'bouton', ancien: true }], effet: membreDeconnecte(IDS.CIBLE) },
  { customId: 'tempvoice:ban_select', genre: 'menuMembres', values: [IDS.CIBLE], chemin: [{ customId: 'tempvoice:ban', genre: 'bouton', ancien: true }], effet: ecrit('PUT', `/permissions/${IDS.CIBLE}`, (c) => refuse(c, C)) },
  // Anciens identifiants, encore acceptés.
  { customId: 'tempvoice:lock', genre: 'bouton', ancien: true, effet: ecrit('PUT', `/permissions/${IDS.GUILD}`, (c) => refuse(c, C)) },
  { customId: 'tempvoice:unlock', genre: 'bouton', ancien: true, effet: ecrit('PUT', `/permissions/${IDS.GUILD}`) },
  { customId: 'tempvoice:chat', genre: 'bouton', ancien: true },
  { customId: 'tempvoice:kick', genre: 'bouton', ancien: true },
  { customId: 'tempvoice:ban', genre: 'bouton', ancien: true },
  { customId: 'tempvoice:trust', genre: 'bouton', ancien: true },
  { customId: 'tempvoice:transfer', genre: 'bouton', chemin: [PROPRIETE] },
];

const action = (customId: string) => customId.split(':')[1];
const GENRE_PAR_TYPE: Record<number, Genre> = { 2: 'bouton', 3: 'menuTexte', 5: 'menuMembres', 6: 'menuRoles' };

/** Le dernier message touché par le clic précédent qui porte ce composant. */
function chercher(sc: Scene, customId: string, touches: string[]): Brut | null {
  for (const id of [...touches].reverse()) {
    const msg = sc.monde.messages.get(id);
    if (trouverComposant(msg, customId)) return msg!;
  }
  return null;
}

/** Le clic tel que l'interface réelle le permet : type du composant trouvé, valeurs parmi ses options. */
function clicSur(
  customId: string,
  base: { genre: Genre; values?: string[]; champs?: Record<string, string> },
  acteur: string,
  porteur: Brut | null,
  mode: ModePanneau,
): Clic {
  const comp = trouverComposant(porteur, customId);
  let genre = comp ? GENRE_PAR_TYPE[comp.type as number] ?? base.genre : base.genre;
  // Porteur fabriqué : en FLAT, les sélecteurs de personnes sont des menus des présents.
  if (!comp && base.genre === 'menuMembres' && mode === 'FLAT' && !customId.endsWith('membre_select')) genre = 'menuTexte';
  let values = base.values;
  if (comp?.type === 3 && values) {
    const options = (comp.options as Brut[]).map((o) => o.value as string);
    values = values.filter((v) => options.includes(v));
    if (!values.length) values = options.slice(0, 1);
  }
  return { customId, genre: base.genre === 'modale' ? 'modale' : genre, acteur, values, champs: base.champs, porteur };
}

type Origine = 'parcours' | 'public' | 'fabrique';

/** Suit le chemin réel jusqu'au composant ; à défaut, un porteur fabriqué. */
async function parcourir(sc: Scene, cas: CasAction, acteur: string): Promise<{ clic: Clic; origine: Origine }> {
  const id = cas.customId.replace('SALON', sc.salonId);
  const mode = sc.opts.mode;
  const panneau = () => sc.monde.messages.get(sc.panneauId) ?? null;
  let touches: string[] = [];
  let dernierPorteur: Brut | null = null;
  let modale: Brut | null = null;
  for (const e of cas.chemin ?? []) {
    const qui = e.acteur ?? acteur;
    const porteur = chercher(sc, e.customId, touches)
      ?? (composantPublic(sc, e.customId) ? panneau() : null)
      ?? (e.ancien ? porteurFabrique(sc, { ...e, acteur: qui }, false) : null);
    if (!porteur) continue;
    const r = await cliquer(sc, clicSur(e.customId, e, qui, porteur, mode));
    tracer(`  étape ${e.customId} par ${qui}`, r);
    touches = r.touches;
    modale = r.modale;
    dernierPorteur = porteur;
  }
  if (cas.genre === 'modale') {
    return modale?.custom_id === id
      ? { clic: clicSur(id, cas, acteur, dernierPorteur, mode), origine: 'parcours' }
      // Une fenêtre vient toujours d'un composant : sans parcours jusqu'à elle
      // (refus en route), elle est soumise depuis le dernier message atteint.
      : { clic: clicSur(id, cas, acteur, (touches.length ? sc.monde.messages.get(touches.at(-1)!) : null) ?? dernierPorteur, mode), origine: 'fabrique' };
  }
  const trouve = chercher(sc, id, touches);
  if (trouve) return { clic: clicSur(id, cas, acteur, trouve, mode), origine: 'parcours' };
  if (composantPublic(sc, id)) return { clic: clicSur(id, cas, acteur, panneau(), mode), origine: 'public' };
  const fabrique = porteurFabrique(sc, { ...cas, customId: id, acteur }, !cas.ancien && !cas.mp, cas.mp);
  return { clic: clicSur(id, cas, acteur, fabrique, mode), origine: 'fabrique' };
}

interface Coord { customId: string; format: Format; mode: ModePanneau; role: Role; langue: Langue }
interface Cellule extends Coord { origine: Origine; problemes: string[] }
const bilan: Cellule[] = [];
/** Combinaisons où la réécriture du panneau public a été vue (et validée) dans la cellule. */
const reecritures = new Set<string>();

const PEUT_TOUT: Role[] = ['proprietaire', 'staff', 'admin'];

function tracer(titre: string, r: Rapport) {
  if (!process.env.BANC_TRACE) return;
  const lignes = r.appels.map((a) => [a.methode, a.route.replace(/jeton-\d+/, 'T'), a.typeCallback ?? '', a.erreur ? `ERR ${a.erreur.code}` : '', JSON.stringify(a.corps ?? '').slice(0, 220)].join(' '));
  console.log(['', `### ${titre}`, ...lignes, `TEXTES ${JSON.stringify(r.textes).slice(0, 500)}`].join('\n'));
}

async function executerCellule(cas: CasAction, c: Omit<Coord, 'customId'>): Promise<Cellule> {
  const sc = await monterScene({ langue: c.langue, format: c.format, mode: c.mode, droitsFermes: c.role === 'staffSansDroits', demandes: cas.demandes, repli: cas.repli });
  if (cas.nePlusDemander) base.profils.set(`${IDS.GUILD}:${IDS.PROPRIO}`, [IDS.CIBLE]);
  const { clic, origine } = await parcourir(sc, cas, ACTEUR[c.role]);
  const r = await cliquer(sc, clic);
  tracer(`${clic.customId} ${c.format} ${c.mode} ${c.role} ${c.langue} (${origine}, ${clic.genre})`, r);
  const nom = action(clic.customId);
  const refusAttendu = (c.role === 'inconnu' || c.role === 'autorise') && !ACTIONS_OUVERTES.has(nom);
  const p = problemes(r, { langue: c.langue, acteur: ACTEUR[c.role], salonId: sc.salonId, action: nom, refusAttendu });
  for (const x of r.appels) {
    const cibleId = x.route.match(new RegExp(`^/channels/${sc.salonId}/messages/([0-9]+)$`))?.[1];
    if (x.methode !== 'PATCH' || !cibleId || cibleId === sc.panneauId) continue;
    const ressemble = ['tempvoice:propriete', 'tempvoice:bascule_verrou'].some((id) => trouverComposant(x.corps as Brut, id));
    if (ressemble) p.push(`panneau réécrit sur un AUTRE message (${(sc.monde.messages.get(cibleId)?.components ?? []).length ? 'qui portait ses propres boutons' : 'vide'})`);
  }
  if (c.format === 'V1' && (sc.monde.messages.get(sc.panneauId)?.flags ?? 0) & (1 << 15)) p.push('panneau public passé en Components V2 alors que le réglage est V1');
  if (cas.effet && PEUT_TOUT.includes(c.role) && (nom !== 'reglages_mod' || c.role === 'admin')) {
    const manque = cas.effet(sc, r);
    if (manque) p.push(`effet absent : ${manque}`);
  }
  if (r.appels.some((a) => a.methode === 'PATCH' && a.route === `/channels/${sc.salonId}/messages/${sc.panneauId}`)) reecritures.add(`${cas.customId}|${c.format}|${c.mode}`);
  return { customId: cas.customId, ...c, origine, problemes: p };
}

const FORMATS: Format[] = ['V1', 'V2'];
const MODES: ModePanneau[] = ['CLASSIC', 'FLAT'];
const ROLES: Role[] = ['proprietaire', 'autorise', 'staff', 'staffSansDroits', 'inconnu', 'admin'];
const LANGUES: Langue[] = ['fr', 'en'];

/**
 * Cellules qui échouent à cause du code de PRODUCTION, et pourquoi.
 * `test.failing` : le test passe tant que le défaut est là, et casse le jour où
 * il est corrigé — retirer alors la ligne.
 */
const DEFAUTS_CONNUS: Array<{ id: string; motif: string; touche: (c: Coord) => boolean }> = [
  // Vide à ce jour : toute la matrice passe. (D4, clés i18n leader_/claim_ absentes, a été
  // corrigé pendant l'écriture du banc par le travail en cours sur la propriété.)
];

const defautConnu = (c: Coord) => DEFAUTS_CONNUS.find((d) => d.touche(c)) ?? null;

describe('Le banc lui-même', () => {
  test('toutes les actions du journal sont dans la matrice', () => {
    expect([...new Set(CAS.map((c) => action(c.customId)))].sort()).toEqual(Object.keys(tv.LIBELLES_ACTIONS_PANNEAU).sort());
  });

  test('le panneau public est posté par le vrai chemin, sans charge invalide', async () => {
    for (const format of FORMATS) for (const mode of MODES) {
      const sc = await monterScene({ langue: 'fr', format, mode });
      const panneau = sc.monde.messages.get(sc.panneauId)!;
      expect(Boolean(panneau.flags & (1 << 15))).toBe(format === 'V2');
      expect(sc.monde.appels.filter((a) => a.violations.length || a.erreur).map((a) => [a.route, a.violations, a.erreur])).toEqual([]);
    }
  });

  test('les règles de Discord sont appliquées (garde-fou contre un banc complaisant)', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const porteur = sc.monde.messages.get(sc.panneauId)!;
    // Identifiant hors module : l'écouteur l'ignore, on pilote l'objet discord.js à la main.
    const r1 = await cliquer(sc, { customId: 'banc:essai', genre: 'bouton', acteur: IDS.PROPRIO, porteur });
    const i = sc.monde.objetsInteraction.get(r1.interactionId)!;
    await i.editReply({ content: 'trop tôt' }).catch(() => null);
    await i.reply({ content: 'un', flags: 64 });
    await i.reply({ content: 'deux', flags: 64 }).catch(() => null);
    await sc.client.rest.post(`/interactions/${i.id}/${i.token}/callback`, { body: { type: 4, data: { content: 'trois' } }, auth: false }).catch(() => null);
    expect(sc.monde.etatInteraction(i.id)!.refusLocaux).toEqual(['editReply : InteractionNotReplied', 'reply : InteractionAlreadyReplied']);
    expect(sc.monde.appels.at(-1)?.erreur?.code).toBe(40060);

    const r2 = await cliquer(sc, { customId: 'banc:vieux', genre: 'bouton', acteur: IDS.PROPRIO, porteur, ageMs: 3_500 });
    const vieille = sc.monde.objetsInteraction.get(r2.interactionId)!;
    await vieille.deferReply({ flags: 64 }).catch(() => null);
    await vieille.followUp({ content: 'x', flags: 64 }).catch(() => null);
    expect(sc.monde.appels.slice(-1).map((a) => a.erreur?.code)).toEqual([10062]);
    expect(sc.monde.etatInteraction(vieille.id)!.refusLocaux).toEqual(['followUp : InteractionNotReplied']);

    const r3 = await cliquer(sc, { customId: 'banc:public', genre: 'bouton', acteur: IDS.PROPRIO, porteur });
    const pub = sc.monde.objetsInteraction.get(r3.interactionId)!;
    await pub.deferUpdate();
    await pub.editReply({ content: 'panneau écrasé' }).catch(() => null);
    expect(sc.monde.appels.at(-1)?.violations.join()).toContain('PUBLIC');
  });

  test('validation, clés brutes et langue détectent ce qu\'elles doivent', async () => {
    const { validerMessage, validerModale } = await import('../helpers/bancDiscord.js');
    expect(validerMessage({ flags: 1 << 15, content: 'x' }, null)).toContain('content interdit avec IS_COMPONENTS_V2');
    expect(validerMessage({ components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'a'.repeat(101), label: 'x' }] }] }, null).length).toBeGreaterThan(0);
    expect(validerMessage({ components: [{ type: 1, components: [{ type: 3, custom_id: 'm', options: [] }] }] }, null).join()).toContain('0 option');
    expect(validerMessage({ embeds: [{ description: 'x'.repeat(4097) }] }, null)).toHaveLength(1);
    expect(validerMessage({ content: '<@1>' }, null)).toContain('mention envoyée sans allowed_mentions');
    expect(validerModale({ custom_id: 'm', title: 'x'.repeat(46), components: [] })).toHaveLength(2);
    expect(clesBrutes(['panel_tempvoice_btn_back', 'Bonjour {name}', 'undefined'])).toHaveLength(3);
    expect(horsLangue(['Only the channel owner can do that.'], 'fr').length).toBeGreaterThan(0);
  });
});

describe('Matrice : customId × format × mode × rôle × langue', () => {
  for (const cas of CAS) {
    describe(cas.customId.replace(/\d{18}/g, 'ID').replace(':SALON', ''), () => {
      for (const format of FORMATS) for (const mode of MODES) for (const role of ROLES) for (const langue of LANGUES) {
        const coord: Coord = { customId: cas.customId, format, mode, role, langue };
        const defaut = defautConnu(coord);
        (defaut ? test.failing : test)(`${format} ${mode} ${role} ${langue}${defaut ? ` — DÉFAUT ${defaut.id}` : ''}`, async () => {
          const c = await executerCellule(cas, coord);
          bilan.push(c);
          expect(c.problemes).toEqual([]);
        });
      }
    });
  }
});

// ─── Modes de chat ───

const MODES_CHAT: ModeChat[] = ['inherit', 'everyone', 'inVoice', 'ownerOnly', 'nobody'];
const CAS_CHAT = CAS.filter((c) => ['bascule_verrou', 'lock', 'unlock', 'chat', 'mode_select', 'trust_select', 'm_trust', 'reserve_select'].includes(action(c.customId)));

async function poserModeChat(sc: Scene, mode: ModeChat) {
  const base = { customId: 'tempvoice:mode_select', genre: 'menuTexte' as Genre, acteur: IDS.PROPRIO, values: [mode] };
  const r = await cliquer(sc, { ...base, porteur: porteurFabrique(sc, base, true) });
  if (r.erreursDiscord.length || r.violations.length) throw new Error(`mode ${mode} non posé : ${[...r.erreursDiscord, ...r.violations].join(' | ')}`);
}

describe('Matrice : mode de chat × action qui en dépend (propriétaire, staff)', () => {
  for (const cas of CAS_CHAT) for (const chat of MODES_CHAT) for (const format of FORMATS) for (const mode of MODES) for (const role of ['proprietaire', 'staff'] as Role[]) for (const langue of LANGUES) {
    const coord: Coord = { customId: `${cas.customId} [chat ${chat}]`, format, mode, role, langue };
    const defaut = defautConnu(coord);
    (defaut ? test.failing : test)(`${action(cas.customId)} · chat ${chat} · ${format} ${mode} ${role} ${langue}${defaut ? ` — DÉFAUT ${defaut.id}` : ''}`, async () => {
      const sc = await monterScene({ langue, format, mode });
      await poserModeChat(sc, chat);
      const valeurs = action(cas.customId) === 'mode_select' ? [chat === 'everyone' ? 'nobody' : 'everyone'] : cas.values;
      const { clic, origine } = await parcourir(sc, { ...cas, values: valeurs }, ACTEUR[role]);
      const r = await cliquer(sc, clic);
      tracer(`${coord.customId} ${format} ${mode} ${role} ${langue}`, r);
      const p = problemes(r, { langue, acteur: ACTEUR[role], salonId: sc.salonId, action: action(clic.customId), refusAttendu: false });
      bilan.push({ ...coord, origine, problemes: p });
      expect(p).toEqual([]);
    });
  }
});

afterAll(() => {
  setSystemTime();
  if (!bilan.length) return;
  const parAction = new Map<string, { total: number; ok: number; origines: Record<string, number> }>();
  for (const b of bilan) {
    const k = b.customId.includes('[chat') ? `${action(b.customId).split(' ')[0]} (chat)` : action(b.customId);
    const e = parAction.get(k) ?? { total: 0, ok: 0, origines: {} };
    e.total += 1;
    if (!b.problemes.length) e.ok += 1;
    e.origines[b.origine] = (e.origines[b.origine] ?? 0) + 1;
    parAction.set(k, e);
  }
  const lignes = [...parAction].map(([k, e]) => `${k.padEnd(22)} ${String(e.ok).padStart(3)}/${e.total}  ${JSON.stringify(e.origines)}`);
  const uniques = new Map<string, { n: number; exemple: string }>();
  for (const b of bilan) for (const p of b.problemes) {
    const cle = `${action(b.customId)} | ${p.replace(/\d{17,20}/g, 'ID').replace(/« .*? »/g, '«…»').slice(0, 170)}`;
    const e = uniques.get(cle) ?? { n: 0, exemple: `${b.format} ${b.mode} ${b.role} ${b.langue} : ${p.slice(0, 240)}` };
    e.n += 1;
    uniques.set(cle, e);
  }
  // Le bilan ne s'affiche que sur demande : `BANC_TRACE=1`.
  if (process.env.BANC_TRACE) {
    // eslint-disable-next-line no-console
    console.log(`\nPanneau public réécrit et validé dans ${reecritures.size} combinaisons customId × format × mode`);
    // eslint-disable-next-line no-console
    console.log(`\nBILAN ${bilan.filter((b) => !b.problemes.length).length}/${bilan.length} cellules vertes\n${lignes.join('\n')}\n\nPROBLÈMES\n${[...uniques].sort((a, b) => b[1].n - a[1].n).map(([k, e]) => `${String(e.n).padStart(4)} × ${k}\n       ex. ${e.exemple}`).join('\n')}`);
  }
});

// ─── Mode compact : un seul éphémère réécrit sur place (deferUpdate au lieu de deferReply) ───

describe('Matrice : mode compact × customId (propriétaire, fr)', () => {
  for (const cas of CAS) for (const format of FORMATS) for (const mode of MODES) {
    const coord: Coord = { customId: `${cas.customId} [compact]`, format, mode, role: 'proprietaire', langue: 'fr' };
    const defaut = defautConnu(coord);
    (defaut ? test.failing : test)(`${action(cas.customId)} · compact · ${format} ${mode}${defaut ? ` — DÉFAUT ${defaut.id}` : ''}`, async () => {
      const sc = await monterScene({ langue: 'fr', format, mode, compact: true, demandes: cas.demandes, repli: cas.repli });
      const { clic, origine } = await parcourir(sc, cas, IDS.PROPRIO);
      const r = await cliquer(sc, clic);
      tracer(`${coord.customId} ${format} ${mode}`, r);
      const p = problemes(r, { langue: 'fr', acteur: IDS.PROPRIO, salonId: sc.salonId, action: action(clic.customId), refusAttendu: false });
      if (cas.effet) { const manque = cas.effet(sc, r); if (manque) p.push(`effet absent : ${manque}`); }
      bilan.push({ ...coord, origine, problemes: p });
      expect(p).toEqual([]);
    });
  }
});

// ─── Réseau lent : l'acquittement tient-il les 3 s quand chaque appel REST en coûte 900 ms ? ───

describe('Réseau lent (900 ms par appel REST, 40 ms par lecture de base)', () => {
  for (const cas of CAS) {
    test(`${action(cas.customId)} : acquitté avant 3 s`, async () => {
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', latenceRestMs: 900, demandes: cas.demandes, repli: cas.repli });
      const { clic } = await parcourir(sc, cas, IDS.PROPRIO);
      const r = await cliquer(sc, clic);
      expect(r.erreursDiscord.filter((e) => e.includes('10062'))).toEqual([]);
      expect(r.acks).toBe(1);
      expect(r.horlogeAck ?? 0).toBeLessThanOrEqual(3_000);
    });
  }
});

// ─── Cas limites ───

const CAS_PAR_ACTION = (nom: string) => CAS.find((c) => action(c.customId) === nom)!;

describe('Cas limite : double clic (deux interactions identiques quasi simultanées)', () => {
  const DOUBLES = ['salon', 'bascule_verrou', 'limit_modal', 'rename_modal', 'mode_select', 'reserve_select', 'm_kick', 'transfer_select', 'lock', 'demande_ok'];
  for (const nom of DOUBLES) for (const mode of MODES) {
    test(`${nom} ${mode}`, async () => {
      const cas = CAS_PAR_ACTION(nom);
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode, demandes: cas.demandes });
      const { clic } = await parcourir(sc, cas, IDS.PROPRIO);
      const r = await cliquer(sc, clic, { simultanes: [{ ...clic }] });
      const tous = [r, ...(r.autres ?? [])];
      const p: string[] = [];
      for (const [i, x] of tous.entries()) {
        if (x.acks !== 1) p.push(`clic ${i + 1} : ${x.acks} acquittement(s)`);
        if (x.enAttente) p.push(`clic ${i + 1} : « réfléchit… » jamais résolu`);
        for (const e of x.refusLocaux) p.push(`clic ${i + 1} : ${e}`);
      }
      // A2 (D2) — le second « Expulser » vise un membre déjà déconnecté : Discord
      // répond 40032, et c'est « n'est plus en vocal » qu'on lit, pas un échec générique.
      const deja = nom === 'm_kick' ? r.erreursDiscord.filter((e) => e.includes('→ 40032 ')) : [];
      if (nom === 'm_kick' && !r.textes.some((t) => t.includes("n'est plus en vocal"))) p.push('second clic sans « n’est plus en vocal »');
      for (const e of r.erreursDiscord.filter((x) => !deja.includes(x))) p.push(`erreur Discord : ${e}`);
      if (deja.length > 1) p.push(`${deja.length} × 40032`);
      for (const v of r.violations) p.push(`charge invalide : ${v}`);
      const logs = r.journal.filter((j) => j.type === 'voice_panel').length;
      if (logs !== 2) p.push(`${logs} log(s) voice_panel pour deux clics`);
      tracer(`double ${nom} ${mode}`, r);
      expect(p).toEqual([]);
    });
  }
});

describe('Cas limite : interaction expirée (reçue 3,5 s après sa création)', () => {
  const EXPIREES = ['salon', 'bascule_verrou', 'limit', 'limit_modal', 'mode_select', 'm_kick', 'lock', 'reserve_select'];
  for (const nom of EXPIREES) {
    test(`${nom} : pas de plantage, pas d'acharnement`, async () => {
      const cas = CAS_PAR_ACTION(nom);
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
      const { clic } = await parcourir(sc, cas, IDS.PROPRIO);
      const r = await cliquer(sc, { ...clic, ageMs: 3_500 });
      tracer(`expirée ${nom}`, r);
      const callbacks = r.appels.filter((a) => a.typeCallback !== undefined);
      expect(r.acks).toBe(0);
      expect(callbacks.every((a) => a.erreur?.code === 10062)).toBe(true);
      // L'acquittement raté, et rien d'autre : aucune réponse vouée à 10062 n'est retentée.
      expect(callbacks.length).toBeLessThanOrEqual(1);
      expect(r.journal.filter((j) => j.type === 'voice_panel')).toHaveLength(1);
      expect(r.erreursBanc).toEqual([]);
    });
  }

  // A1 (D1) — Discord a affiché « Cette interaction a échoué » : la personne croit
  // que rien n'a été fait, et recliquera. L'action ne s'applique donc pas, et le
  // journal le dit.
  for (const nom of ['bascule_verrou', 'mode_select', 'lock', 'm_kick', 'limit_modal']) {
    test(`${nom} : aucune modification quand l'acquittement a échoué`, async () => {
      const cas = CAS_PAR_ACTION(nom);
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
      const { clic } = await parcourir(sc, cas, IDS.PROPRIO);
      const r = await cliquer(sc, { ...clic, ageMs: 3_500 });
      expect(r.mutations.filter((a) => !a.route.includes('/messages/')).map((a) => `${a.methode} ${a.route}`)).toEqual([]);
      const champs = r.journal.find((j) => j.type === 'voice_panel')!.champs;
      expect(champs.find((c) => c.name === 'Issue')?.value).toBe('Erreur');
      expect(champs.find((c) => c.name === 'Motif')?.value).toContain('Interaction expirée');
    });
  }
});

describe('Cas limite : salon supprimé pendant l\'action (10003 au premier appel qui le modifie)', () => {
  const SUPPRIMES = ['bascule_verrou', 'limit_modal', 'rename_modal', 'mode_select', 'reserve_select', 'm_trust', 'm_ban', 'trust_select', 'lock', 'unlock', 'chat'];
  for (const nom of SUPPRIMES) {
    test(`${nom} : une réponse propre, pas de « réfléchit… »`, async () => {
      const cas = CAS_PAR_ACTION(nom);
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
      const { clic } = await parcourir(sc, cas, IDS.PROPRIO);
      sc.monde.supprimerApres = { salonId: sc.salonId, n: 0 };
      const r = await cliquer(sc, clic);
      tracer(`supprimé ${nom}`, r);
      const p: string[] = [];
      if (r.acks !== 1) p.push(`${r.acks} acquittement(s)`);
      if (r.enAttente) p.push('« réfléchit… » jamais résolu');
      for (const e of r.refusLocaux) p.push(`refus discord.js : ${e}`);
      for (const v of r.violations) p.push(`charge invalide : ${v}`);
      // Hors 10003 / 10008 sur le salon disparu, aucune erreur.
      for (const e of r.erreursDiscord.filter((x) => !/→ 1000[38] /.test(x))) p.push(`erreur Discord : ${e}`);
      if (!r.erreursDiscord.some((x) => x.includes('10003'))) p.push('le scénario n\'a pas touché le salon');
      // La dernière chose lue par la personne ne doit pas annoncer une réussite.
      const dernier = r.appels.filter((a) => a.interactionId === r.interactionId && !a.erreur && a.methode !== 'GET').at(-1);
      const texte = textesVisibles((dernier?.typeCallback !== undefined ? (dernier?.corps as Brut)?.data : dernier?.corps) as Brut).join(' ');
      if (!/pas pu|impossible|échou|erreur|n'existe plus|introuvable|supprim/i.test(texte)) p.push(`réponse finale trompeuse : « ${texte.slice(0, 160)} »`);
      expect(p).toEqual([]);
    });
  }
});

describe('Cas limite : redémarrage du bot (nouveau client, cache vidé, relance depuis la base)', () => {
  let generation = 0;

  async function redemarrer(sc: Scene, reglages?: Partial<Record<string, unknown>>) {
    if (reglages) Object.assign(base.reglages!, reglages);
    // Un module neuf : tout l'état mémoire du module (salons, anti-rebond, registres) repart de zéro.
    generation += 1;
    const chemin = `../../events/tempVoice.ts?redemarrage=${generation}`;
    const tv2 = (await import(chemin)) as typeof tv;
    const client = sc.monde.creerClient();
    const enCours = suivreEcouteurs(client);
    tv2.registerTempVoiceListener(client);
    client.emit(Events.ClientReady, client as never);
    await sc.monde.calme(enCours);
    return { sc2: { ...sc, client, enCours } as Scene, tv2 };
  }

  for (const format of FORMATS) for (const mode of MODES) {
    test(`panneau ${format} ${mode} existant : relancé et cliquable`, async () => {
      const sc = await monterScene({ langue: 'fr', format, mode });
      const { sc2, tv2 } = await redemarrer(sc);
      expect(tv2.tempChannels.get(sc.salonId)?.creatorId).toBe(IDS.PROPRIO);
      const cas = CAS_PAR_ACTION('bascule_verrou');
      const { clic, origine } = await parcourir(sc2, cas, IDS.PROPRIO);
      expect(origine).not.toBe('fabrique');
      const r = await cliquer(sc2, clic);
      tracer(`redémarrage ${format} ${mode}`, r);
      expect(problemes(r, { langue: 'fr', acteur: IDS.PROPRIO, salonId: sc.salonId, action: 'bascule_verrou', refusAttendu: false })).toEqual([]);
      // Le panneau public a bien été réécrit après le clic, et accepté par Discord.
      const reecrit = r.appels.find((a) => a.methode === 'PATCH' && a.route === `/channels/${sc.salonId}/messages/${sc.panneauId}`);
      expect(reecrit?.erreur).toBeUndefined();
      expect(reecrit?.violations ?? []).toEqual([]);
    });
  }

  test('panneau V2 existant, réglage passé à V1 pendant l\'arrêt : la réécriture reste V2', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const { sc2 } = await redemarrer(sc, { panelComponents: 'V1' });
    const { clic } = await parcourir(sc2, CAS_PAR_ACTION('bascule_verrou'), IDS.PROPRIO);
    const r = await cliquer(sc2, clic);
    const reecrit = r.appels.find((a) => a.methode === 'PATCH' && a.route === `/channels/${sc.salonId}/messages/${sc.panneauId}`);
    expect(reecrit).toBeDefined();
    expect(reecrit!.violations).toEqual([]);
    expect(sc.monde.messages.get(sc.panneauId)!.flags & (1 << 15)).toBe(1 << 15);
  });

  test('salon supprimé pendant l\'arrêt : oublié au démarrage, son panneau répond proprement', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'FLAT' });
    sc.monde.salons.delete(sc.salonId);
    for (const [u, ch] of sc.monde.etatsVocaux) if (ch === sc.salonId) sc.monde.etatsVocaux.delete(u);
    const { tv2 } = await redemarrer(sc);
    expect(tv2.tempChannels.has(sc.salonId)).toBe(false);
    expect(base.salons.has(sc.salonId)).toBe(false);
  });
});

describe('Cas limite : la langue du serveur change entre deux clics', () => {
  test('fr → en : réponses, sous-panneau et panneau public suivent la nouvelle langue', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const premier = await cliquer(sc, clicSur('tempvoice:salon', { genre: 'bouton' }, IDS.PROPRIO, sc.monde.messages.get(sc.panneauId)!, 'CLASSIC'));
    expect(horsLangue(premier.textes, 'fr')).toEqual([]);
    const sousPanneau = chercher(sc, 'tempvoice:bascule_verrou', premier.touches)!;
    configServeur.language = 'en';
    const second = await cliquer(sc, clicSur('tempvoice:bascule_verrou', { genre: 'bouton' }, IDS.PROPRIO, sousPanneau, 'CLASSIC'));
    tracer('langue fr→en', second);
    expect(problemes(second, { langue: 'en', acteur: IDS.PROPRIO, salonId: sc.salonId, action: 'bascule_verrou', refusAttendu: false })).toEqual([]);
    const pub = textesVisibles(sc.monde.messages.get(sc.panneauId) as Brut);
    expect(horsLangue(pub, 'en')).toEqual([]);
  });

  test('en → fr sur le panneau plat', async () => {
    const sc = await monterScene({ langue: 'en', format: 'V1', mode: 'FLAT' });
    configServeur.language = 'fr';
    const r = await cliquer(sc, clicSur('tempvoice:bascule_verrou', { genre: 'bouton' }, IDS.PROPRIO, sc.monde.messages.get(sc.panneauId)!, 'FLAT'));
    expect(problemes(r, { langue: 'fr', acteur: IDS.PROPRIO, salonId: sc.salonId, action: 'bascule_verrou', refusAttendu: false })).toEqual([]);
    expect(horsLangue(textesVisibles(sc.monde.messages.get(sc.panneauId) as Brut), 'fr')).toEqual([]);
  });
});

// ─── Lot : mention du propriétaire, langue des panneaux, journal ───

// Chargés à l'usage : le service des panneaux tire tickets, règlement et auto-rôles.
const servicePanneaux = () => import('../../services/core/panelRerenderService.js');
const registreIntentions = () => import('../../services/moderation/voiceIntentRegistry.js');

/** Composants à plat, conteneurs compris. */
function aPlat(composants: unknown): Brut[] {
  return ((composants ?? []) as Brut[]).flatMap((c) => [c, ...aPlat(c.components), ...(c.accessory ? [c.accessory] : [])]);
}

/** Vrai si ce POST notifie la personne : mention dans le `content` ou un Text Display, et permise. */
function notifie(corps: Brut, id: string): boolean {
  const textes = [corps.content, ...aPlat(corps.components).filter((c) => c.type === 10).map((c) => c.content)];
  if (!textes.some((t) => typeof t === 'string' && t.includes(`<@${id}>`))) return false;
  const am = corps.allowed_mentions as Brut | undefined;
  return !am || (am.users ?? []).includes(id) || (am.parse ?? []).includes('users');
}

/** Mentions du propriétaire visibles dans le salon (messages publics, état courant). */
function mentionsVisibles(sc: Scene): number {
  return [...sc.monde.messages.values()]
    .filter((msg) => msg.channel_id === sc.salonId && !(msg.flags & 64))
    .flatMap((msg) => textesVisibles(msg))
    .reduce((n, t) => n + t.split(`<@${IDS.PROPRIO}>`).length - 1, 0);
}

describe('B — mention du propriétaire : une seule, là où le réglage la place', () => {
  const ATTENDU: Record<string, number> = { panel: 1, message: 1, none: 0, absent: 1 };
  for (const format of FORMATS) for (const mention of ['panel', 'message', 'none', 'absent']) {
    test(`${format} · ${mention} : ${ATTENDU[mention]} notification, une seule mention visible, avant et après réécriture`, async () => {
      const sc = await monterScene({ langue: 'fr', format, mode: 'CLASSIC', mention: mention === 'absent' ? undefined : mention });
      const postes = sc.monde.appels.filter((a) => a.methode === 'POST' && a.route === `/channels/${sc.salonId}/messages`);
      expect(postes.flatMap((a) => a.violations)).toEqual([]);
      expect(postes.filter((a) => notifie(a.corps as Brut, IDS.PROPRIO))).toHaveLength(ATTENDU[mention]);
      expect(postes).toHaveLength(mention === 'message' ? 2 : 1);
      expect(mentionsVisibles(sc)).toBe(1);

      const { clic } = await parcourir(sc, CAS_PAR_ACTION('bascule_verrou'), IDS.PROPRIO);
      const r = await cliquer(sc, clic);
      expect(r.appels.some((a) => a.methode === 'PATCH' && a.route === `/channels/${sc.salonId}/messages/${sc.panneauId}` && !a.erreur && !a.violations.length)).toBe(true);
      expect(mentionsVisibles(sc)).toBe(1);
    });
  }
});

describe('C — langue du serveur', () => {
  test('C1 — bascule fr → en : le panneau déjà posté est réécrit en anglais', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const avant = textesVisibles(sc.monde.messages.get(sc.panneauId));
    expect(avant).toContain(m.panel_tempvoice_tab_channel({}, { locale: 'fr' }));
    configServeur.language = 'en';
    avancer(1_500);
    const { rafraichirPanneauxVocaux } = await servicePanneaux();
    expect(rafraichirPanneauxVocaux(sc.client, IDS.GUILD)).toBe(1);
    await sc.monde.calme(sc.enCours);
    const apres = textesVisibles(sc.monde.messages.get(sc.panneauId));
    expect(apres).toContain(m.panel_tempvoice_tab_channel({}, { locale: 'en' }));
    expect(horsLangue(apres, 'en')).toEqual([]);
  });

  for (const langue of LANGUES) {
    test(`C2 — modèle de nom resté au défaut : nom dans la langue du serveur (${langue})`, async () => {
      const sc = await monterScene({ langue, format: 'V2', mode: 'CLASSIC', modeleNom: '🔊 Salon de {user}' });
      const nom = String(sc.monde.salons.get(sc.salonId)!.name);
      const pseudo = nom.replace(/^🔊 (Salon de )?/, '').replace(/'s channel$/, '');
      expect(nom).toBe(m.setup_template_voice_name({ user: pseudo }, { locale: langue }));
      expect(nom).toMatch(langue === 'fr' ? /^🔊 Salon de / : /'s channel$/);
    });
  }

  test('C2 — un modèle personnalisé reste tel quel, même en anglais', async () => {
    const sc = await monterScene({ langue: 'en', format: 'V2', mode: 'CLASSIC' });
    expect(String(sc.monde.salons.get(sc.salonId)!.name)).toMatch(/^Salon de /);
  });
});

/** La ligne `voice_panel` du clic, champs par nom. */
function ligneDuClic(r: Rapport): Record<string, string> {
  const lignes = r.journal.filter((j) => j.type === 'voice_panel');
  expect(lignes).toHaveLength(1);
  return Object.fromEntries(lignes[0].champs.map((c) => [c.name, c.value]));
}

async function clicJournal(opts: OptionsScene, nom: string, role: Role = 'proprietaire', values?: string[]) {
  const sc = await monterScene(opts);
  const cas = CAS_PAR_ACTION(nom);
  const { clic } = await parcourir(sc, values ? { ...cas, values } : cas, ACTEUR[role]);
  const r = await cliquer(sc, clic);
  return { sc, r, champs: ligneDuClic(r) };
}

describe('D — journal voice_panel, dans la langue du serveur', () => {
  for (const langue of LANGUES) {
    const L = { locale: langue };
    test(`D1 — verrouiller : Avant / Après ne listent que le verrou (${langue})`, async () => {
      const { champs } = await clicJournal({ langue, format: 'V2', mode: 'CLASSIC' }, 'bascule_verrou');
      const verrou = m.log_tempvoice_state_lock({}, L);
      const avant = champs[m.log_tempvoice_field_before({}, L)];
      const apres = champs[m.log_tempvoice_field_after({}, L)];
      expect(avant).toContain(`**${verrou}** — ${m.log_tempvoice_val_open({}, L)}`);
      expect(apres).toContain(`**${verrou}** — ${m.log_tempvoice_val_locked({}, L)}`);
      // Seul ce qui a changé : ni le nom, ni la limite, ni le propriétaire.
      for (const cle of [m.log_tempvoice_state_name({}, L), m.log_tempvoice_state_limit({}, L), m.log_tempvoice_state_owner({}, L)]) {
        expect(`${avant}
${apres}`).not.toContain(`**${cle}**`);
      }
      expect(champs[m.log_tempvoice_field_outcome({}, L)]).toBeUndefined();
    });
  }

  test('D1 — expulser : état de la cible avant / après', async () => {
    const { champs } = await clicJournal({ langue: 'fr', format: 'V2', mode: 'CLASSIC' }, 'm_kick');
    expect(champs.Avant).toContain(`<@${IDS.CIBLE}> en vocal** — oui`);
    expect(champs['Après']).toContain(`<@${IDS.CIBLE}> en vocal** — non`);
  });

  test('D1 — droit modérateur fermé : « Sans effet », motif = la réponse, pas d\'Avant/Après', async () => {
    const { champs } = await clicJournal({ langue: 'fr', format: 'V2', mode: 'CLASSIC', droitsFermes: true }, 'bascule_verrou', 'staffSansDroits');
    expect(champs.Issue).toBe('Sans effet');
    expect(champs.Motif).toBeTruthy();
    expect(champs.Avant).toBeUndefined();
  });

  test('D1 — le mode d\'écriture déjà en place, choisi à nouveau : « Sans effet »', async () => {
    const { champs } = await clicJournal({ langue: 'en', format: 'V2', mode: 'CLASSIC' }, 'mode_select', 'proprietaire', ['everyone']);
    expect(champs.Outcome).toBe('No effect');
  });

  test('D1 — garde propriétaire : « Refusée » ; navigation : ni Avant, ni Après, ni issue', async () => {
    const refus = await clicJournal({ langue: 'fr', format: 'V2', mode: 'CLASSIC' }, 'bascule_verrou', 'inconnu');
    expect(refus.champs.Issue).toBe('Refusée');
    const nav = await clicJournal({ langue: 'fr', format: 'V2', mode: 'CLASSIC' }, 'salon');
    expect(['Avant', 'Après', 'Issue'].filter((nom) => nom in nav.champs)).toEqual([]);
  });

  test('D2 — l\'audit en base garde valeur, après et réponse ; son salon est le salon vocal', async () => {
    const { r } = await clicJournal({ langue: 'fr', format: 'V2', mode: 'CLASSIC' }, 'limit_modal');
    const ligne = r.journal.find((j) => j.type === 'voice_panel')!;
    expect(ligne.audit?.channelId).toBe(ligne.salons[0]);
    expect(ligne.audit?.details).toContain('Valeur choisie: 5');
    expect(ligne.audit?.details).toContain('Après:');
    expect(ligne.audit?.details).toContain('Réponse au membre:');
  });

  test('D3 — la catégorie du salon accompagne le salon dans les sources du log', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const CATEGORIE = '900000000000000600';
    // Côté Discord et côté cache : une relecture du salon repasse par les deux.
    sc.monde.salons.get(sc.salonId)!.parent_id = CATEGORIE;
    (sc.client.channels.cache.get(sc.salonId) as unknown as { parentId: string | null }).parentId = CATEGORIE;
    const { clic } = await parcourir(sc, CAS_PAR_ACTION('salon'), IDS.PROPRIO);
    const r = await cliquer(sc, clic);
    expect(r.journal.find((j) => j.type === 'voice_panel')!.salons).toEqual([sc.salonId, CATEGORIE]);
  });

  test('D4 — débordement : membres touchés et salon de repli au journal', async () => {
    const REPLI = '900000000000000500';
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC', repliSalon: REPLI });
    sc.monde.salons.set(REPLI, sc.monde.salonBrut(REPLI, 'Repli', []));
    const { clic } = await parcourir(sc, CAS_PAR_ACTION('resa_deplacer'), IDS.PROPRIO);
    const champs = ligneDuClic(await cliquer(sc, clic));
    expect(champs['Membres touchés']).toContain(`<@${IDS.CIBLE}>`);
    expect(champs['Salon de repli']).toBe(`<#${REPLI}>`);
  });

  test('D5 — la proposition de débordement n\'écrase pas le verdict de la réservation', async () => {
    const { champs } = await clicJournal({ langue: 'fr', format: 'V2', mode: 'CLASSIC' }, 'reserve_select');
    expect(champs['Réponse au membre']).toContain(m.panel_tempvoice_reserved_ok({ role: IDS.ROLE_RESA }, { locale: 'fr' }));
  });

  for (const langue of LANGUES) {
    test(`D6 — création et suppression automatiques journalisées, acteur Système (${langue})`, async () => {
      const L = { locale: langue };
      const debut = journal.length;
      const sc = await monterScene({ langue, format: 'V2', mode: 'CLASSIC' });
      const creation = journal.slice(debut).find((j) => j.champs.some((c) => c.value === m.log_tempvoice_created({}, L)))!;
      expect(creation.acteur).toBe(m.log_tempvoice_system({}, L));
      const champs = Object.fromEntries(creation.champs.map((c) => [c.name, c.value]));
      expect(champs[m.log_tempvoice_field_trigger({}, L)]).toBe(`<@${IDS.PROPRIO}>`);
      expect(champs[m.log_tempvoice_field_generator({}, L)]).toBe(`<#${IDS.GEN}>`);
      expect(champs[m.log_tempvoice_field_initial_mode({}, L)]).toBeTruthy();

      const avantSortie = journal.length;
      for (const id of [IDS.PROPRIO, IDS.AUTORISE, IDS.STAFF, IDS.INCONNU, IDS.ADMIN, IDS.CIBLE]) {
        avancer(1_500);
        sc.monde.bouger(id, null);
        await sc.monde.calme(sc.enCours);
      }
      const suppression = journal.slice(avantSortie).find((j) => j.champs.some((c) => c.value === m.log_tempvoice_deleted({}, L)));
      expect(suppression).toBeDefined();
      const s = Object.fromEntries(suppression!.champs.map((c) => [c.name, c.value]));
      expect(s[m.log_tempvoice_field_reason({}, L)]).toBe(m.panel_tempvoice_audit_empty({}, L));
      expect(s[m.log_tempvoice_field_lifetime({}, L)]).toBeTruthy();
      expect(horsLangue(suppression!.champs.flatMap((c) => [c.name, c.value]), langue)).toEqual([]);
    });
  }

  test('D6 — création refusée faute de droits du bot : journalisée, en erreur', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const roleBot = sc.client.guilds.cache.get(IDS.GUILD)!.roles.cache.get(IDS.ROLE_BOT)!;
    (roleBot as unknown as { permissions: PermissionsBitField }).permissions = new PermissionsBitField(PermissionFlagsBits.ViewChannel);
    const debut = journal.length;
    avancer(1_500);
    sc.monde.bouger(IDS.DEHORS, IDS.GEN);
    await sc.monde.calme(sc.enCours);
    const refus = journal.slice(debut).find((j) => j.champs.some((c) => c.value === m.log_tempvoice_create_refused({}, { locale: 'fr' })));
    expect(refus).toBeDefined();
    const champs = Object.fromEntries(refus!.champs.map((c) => [c.name, c.value]));
    expect(champs['Déclenché par']).toBe(`<@${IDS.DEHORS}>`);
    expect(champs['Droits manquants']).toBeTruthy();
    expect(refus!.salons).toEqual([IDS.GEN]);
  });

  for (const langue of LANGUES) {
    test(`D7 — titre, pied et auteur annoncé au journal vocal dans la langue du serveur (${langue})`, async () => {
      const L = { locale: langue };
      const { prendreIntentionVocale, reinitialiserIntentionsVocales } = await registreIntentions();
      reinitialiserIntentionsVocales();
      const { r } = await clicJournal({ langue, format: 'V2', mode: 'CLASSIC' }, 'm_kick');
      const ligne = r.journal.find((j) => j.type === 'voice_panel')!;
      expect(ligne.titre).toBe(m.log_tempvoice_title({}, L));
      expect(ligne.pied).toBe(m.log_tempvoice_footer({ tag: ligne.acteur }, L));
      expect(horsLangue([ligne.titre!, ligne.pied!, ...ligne.champs.flatMap((c) => [c.name, c.value])], langue)).toEqual([]);
      // L'auteur que le journal vocal affichera pour cette déconnexion.
      expect(prendreIntentionVocale(IDS.GUILD, IDS.CIBLE, 'disconnect')?.libelle)
        .toBe(m.log_tempvoice_author_panel({ tag: ligne.acteur }, L));
    });
  }
});

describe('B — mention du propriétaire : du PATCH du dashboard au salon créé (bout en bout)', () => {
  // Attendu par réglage : [notifications, mentions visibles, mention dans le panneau ; « none » l'affiche sans notifier]
  const ATTENDU_PATCH: Array<['message' | 'none' | 'panel', number, number, number]> = [
    ['message', 1, 1, 0], ['none', 0, 1, 1], ['panel', 1, 1, 1],
  ];
  for (const format of FORMATS) for (const [mention, notifs, visibles, dansPanneau] of ATTENDU_PATCH) {
    test(`${format} · PATCH ${mention} puis création : ${notifs} notification, ${dansPanneau} mention dans le panneau`, async () => {
      // Ligne en base SANS mention : seul le PATCH réel peut poser le réglage.
      reglerBase({ langue: 'fr', format, mode: 'CLASSIC' });
      base.reglages = { ...base.reglages, ownerMentionPlacement: mention === 'panel' ? 'message' : 'panel' };
      const { handleChannelsManagementRoutes } = await import('../../api/routes/dashboard/modules/channels-management.js');
      const { IncomingMessage, ServerResponse } = await import('node:http');
      const { Socket } = await import('node:net');
      const req = new IncomingMessage(new Socket());
      req.method = 'PATCH';
      req.headers = { 'content-type': 'application/json' };
      req.push(JSON.stringify({ tempVoiceModPermissions: { ownerMentionPlacement: mention } }));
      req.push(null);
      const res = new ServerResponse(req) as InstanceType<typeof ServerResponse> & { code?: number };
      res.setHeader = () => res;
      res.writeHead = (c: number) => { res.code = c; return res; };
      res.end = (() => res) as never;
      const client = new FauxDiscord({ latenceRestMs: 0, langueDiscord: 'fr' }).creerClient();
      await handleChannelsManagementRoutes({
        req, res, parts: ['api', 'dashboard', 'guilds', IDS.GUILD, 'channels-management'],
        url: new URL('http://localhost/x'), client, user: { userId: 'u', username: 'Admin' } as never,
        guildId: IDS.GUILD, access: 'admin' as never, method: 'PATCH', auditUser: 'Toji (dashboard)', moduleKey: 'channels-management',
      });
      expect(res.code ?? 200).toBe(200);
      expect(base.reglages?.ownerMentionPlacement).toBe(mention);

      // Création par le vrai événement voiceStateUpdate, lue sur la ligne que le PATCH vient d'écrire.
      const sc = await monterScene({ langue: 'fr', format, mode: 'CLASSIC', garderBase: true });
      const publics = [...sc.monde.messages.values()].filter((msg) => msg.channel_id === sc.salonId && !(msg.flags & 64));
      const mentionsDe = (msg: Brut) => textesVisibles(msg).join(' ').split(`<@${IDS.PROPRIO}>`).length - 1;
      expect(publics.reduce((n, msg) => n + mentionsDe(msg), 0)).toBe(visibles);
      expect(mentionsDe(publics.find((msg) => msg.id === sc.panneauId)!)).toBe(dansPanneau);
      const postes = sc.monde.appels.filter((a) => a.methode === 'POST' && a.route === `/channels/${sc.salonId}/messages`);
      expect(postes.filter((a) => notifie(a.corps as Brut, IDS.PROPRIO))).toHaveLength(notifs);
    });
  }
});
