/**
 * Menu « Visibilité » du panneau vocal, sur le VRAI parcours : salon créé par le
 * générateur, clics rejoués par discord.js contre le faux Discord du banc.
 * Harnais repris de tempVoiceBanc.test.ts (mêmes mocks, même scène).
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

type Brut = Record<string, any>;

async function cliquer(sc: Scene, clic: { customId: string; genre: 'bouton' | 'menuTexte'; acteur: string; values?: string[]; porteur: Brut | null }) {
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

afterAll(() => setSystemTime());

describe('Visibilité — menu dans les deux modes', () => {
  for (const mode of ['CLASSIC', 'FLAT'] as const) {
    test(`${mode} : trois options, « Visible par tous » par défaut`, async () => {
      const sc = await monterScene({ langue: 'fr', format: 'V2', mode });
      const { menu } = await menuVisibilite(sc);
      expect((menu.options as Brut[]).map((o) => o.value)).toEqual(['tous', 'acces', 'prive']);
      expect((menu.options as Brut[]).every((o) => typeof o.description === 'string' && o.description.length > 0)).toBe(true);
      expect((menu.options as Brut[]).find((o) => o.default)?.value).toBe('tous');
    });
  }
});

describe('Visibilité — effets réels', () => {
  test('« Privé » : @everyone caché, propriétaire et autorisé voient, journal voice_panel, base écrite', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'CLASSIC' });
    const lignes = await choisir(sc, 'prive');
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(voitExpres(sc, IDS.PROPRIO)).toBe(true);
    expect(voitExpres(sc, IDS.AUTORISE)).toBe(true);
    const log = lignes.filter((l) => l.type === 'voice_panel');
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0].champs)).toContain('Privé (caché)');
    expect(base.salons.get(sc.salonId)?.visibility).toBe('prive');
    expect(tv.tempChannels.get(sc.salonId)?.visibility).toBe('prive');
  });

  test('carte : champs « Visibilité » et « Bloqués », valeur à jour', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'FLAT' });
    await choisir(sc, 'prive');
    avancer(5_000);
    await sc.monde.calme(sc.enCours);
    const textes = textesVisibles(sc.monde.messages.get(sc.panneauId)).join('\n');
    expect(textes).toContain('Visibilité');
    expect(textes).toContain('Bloqués');
    expect(textes).toContain('Privé (caché)');
  });

  test('« Suit l\'accès » : verrouiller cache le salon, rouvrir le montre', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'FLAT' });
    await choisir(sc, 'acces');
    expect(cache(sc, IDS.GUILD)).toBe(false);
    const verrou = () => cliquer(sc, { customId: 'tempvoice:bascule_verrou', genre: 'bouton', acteur: IDS.PROPRIO, porteur: sc.monde.messages.get(sc.panneauId)! });
    await verrou();
    expect(cache(sc, IDS.GUILD)).toBe(true);
    expect(voitExpres(sc, IDS.AUTORISE)).toBe(true);
    await verrou();
    expect(cache(sc, IDS.GUILD)).toBe(false);
  });

  test('un bloqué reste caché quelle que soit la visibilité', async () => {
    const sc = await monterScene({ langue: 'fr', format: 'V2', mode: 'FLAT' });
    sc.monde.poserSurchargeDirecte(sc.salonId, IDS.CIBLE, 1, 0n, VUE | PermissionFlagsBits.Connect);
    await sc.monde.calme(sc.enCours);
    for (const v of ['prive', 'acces', 'tous', 'prive']) {
      await choisir(sc, v);
      expect(cache(sc, IDS.CIBLE)).toBe(true);
      expect(voitExpres(sc, IDS.CIBLE)).toBe(false);
    }
  });
});
