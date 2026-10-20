/**
 * BANC D'INTERACTIONS : un vrai `Client` discord.js branché sur un faux Discord.
 *
 * - Le REST est intercepté à la source (`client.rest.request`) : aucune requête
 *   réseau, chaque appel est routé vers `FauxDiscord.traiter`, qui applique les
 *   règles de l'API (acquittement unique, 3 s, jetons de webhook, salon supprimé,
 *   validation des charges) et ENREGISTRE l'appel avec son verdict.
 * - Les interactions naissent de charges gateway brutes (type 3 / type 5) passées
 *   à `client.actions.InteractionCreate.handle` : `reply`, `deferReply`,
 *   `showModal`… sont les vraies méthodes discord.js (et celles de `patchV2`).
 * - Le faux Discord rejoue la passerelle comme le vrai : `CHANNEL_UPDATE` après
 *   une surcharge, `VOICE_STATE_UPDATE` après un déplacement, `CHANNEL_DELETE`.
 * - Horloge virtuelle : chaque appel REST / base coûte du temps simulé ; un
 *   acquittement au-delà de 3 s après la création de l'interaction prend 10062.
 *
 * Aucune dépendance au module testé : le fichier de test monte ses mocks puis
 * importe le code de production.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  Client,
  ClientApplication,
  ClientUser,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';

// ─── Identifiants du serveur simulé ───
export const IDS = {
  GUILD: '900000000000000001',
  APP: '900000000000000002',
  BOT: '900000000000000002',
  GEN: '900000000000000010',
  PROPRIO: '900000000000000100',
  AUTORISE: '900000000000000101',
  STAFF: '900000000000000102',
  INCONNU: '900000000000000103',
  ADMIN: '900000000000000104',
  CIBLE: '900000000000000105',
  DEHORS: '900000000000000106',
  PROPRIO_SERVEUR: '900000000000000199',
  ROLE_MOD: '900000000000000201',
  ROLE_ADMIN: '900000000000000202',
  ROLE_BOT: '900000000000000203',
  ROLE_RESA: '900000000000000204',
} as const;

const P = PermissionFlagsBits;
const bits = (...b: bigint[]) => b.reduce((a, x) => a | x, 0n).toString();
const PERMS_EVERYONE = bits(P.ViewChannel, P.Connect, P.Speak, P.SendMessages, P.ReadMessageHistory, P.UseVAD, P.Stream, P.EmbedLinks, P.AttachFiles);
const PERMS_BOT = bits(
  P.ManageChannels, P.ManageRoles, P.MoveMembers, P.ViewChannel, P.Connect, P.Speak, P.SendMessages,
  P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.MuteMembers, P.DeafenMembers, P.UseVAD, P.Stream,
);

/** Codes d'erreur que le faux Discord sait rendre, avec leur statut HTTP. */
const ERREURS: Record<number, [number, string]> = {
  10003: [404, 'Unknown Channel'],
  10007: [404, 'Unknown Member'],
  10008: [404, 'Unknown Message'],
  10015: [404, 'Unknown Webhook'],
  10062: [404, 'Unknown interaction'],
  40032: [400, 'Target user is not connected to voice.'],
  40060: [400, 'Interaction has already been acknowledged.'],
  50007: [403, 'Cannot send messages to this user'],
  50035: [400, 'Invalid Form Body'],
  0: [404, 'Route non simulée par le banc'],
};

export interface AppelRest {
  methode: string;
  route: string;
  corps: unknown;
  /** Instant virtuel de l'appel. */
  t: number;
  erreur?: { code: number; message: string };
  /** Interaction concernée (callback / webhook), si c'en est un. */
  interactionId?: string;
  /** Type de callback (4 reply, 5 deferReply, 6 deferUpdate, 7 update, 9 modal). */
  typeCallback?: number;
  /** Violations de charge relevées sur cet appel. */
  violations: string[];
  /** Message NEUF que cet appel a fait apparaître (réponse, « réfléchit… », followUp). */
  cree?: string;
}

interface EtatInteraction {
  id: string;
  token: string;
  t0: number;
  acquittee: boolean;
  typeAck?: number;
  /** `deferReply` posé et jamais résolu = « réfléchit… » pour toujours. */
  enAttente: boolean;
  /** Message porteur du composant (deferUpdate / update l'éditent). */
  messageId?: string;
  messageEphemere: boolean;
  /** Message `@original` (réponse ou message porteur après deferUpdate). */
  originalId?: string;
  /** Fenêtre ouverte par `showModal`. */
  modale?: Brut;
  /** Erreurs côté discord.js (InteractionAlreadyReplied, InteractionNotReplied). */
  refusLocaux: string[];
}

type Brut = Record<string, any>;

let compteurId = 1n;
/** Snowflake neuf, unique dans le process. */
export function nouvelId(): string {
  compteurId += 1n;
  return (920000000000000000n + compteurId).toString();
}

function utilisateurBrut(id: string, nom: string, bot = false): Brut {
  return { id, username: nom, discriminator: '0', global_name: nom, avatar: null, bot };
}

export interface OptionsMonde {
  langueDiscord?: 'fr' | 'en-US';
  latenceRestMs?: number;
}

/**
 * Le faux Discord : état serveur (salons, messages, membres, états vocaux) et
 * journal de chaque appel. Un monde = un serveur, un client.
 */
export class FauxDiscord {
  horloge = 0;
  latenceRestMs: number;
  appels: AppelRest[] = [];
  salons = new Map<string, Brut>();
  messages = new Map<string, Brut>();
  membres = new Map<string, Brut>();
  roles: Brut[];
  etatsVocaux = new Map<string, string>();
  interactions = new Map<string, EtatInteraction>();
  /** Les objets discord.js des interactions envoyées, par identifiant. */
  objetsInteraction = new Map<string, Brut>();
  /** Messages créés ou édités, dans l'ordre : le résultat d'un clic s'y lit. */
  touches: string[] = [];
  /** Salons privés ouverts par `createDM`. */
  mp = new Set<string>();
  /** Membres aux MP fermés : tout envoi dans leur salon privé reçoit 50007. */
  mpFermes = new Set<string>();
  /** Salon à supprimer après N appels qui le modifient (scénario « salon supprimé pendant l'action »). */
  supprimerApres: { salonId: string; n: number } | null = null;
  /** Ce qui reste à rejouer côté passerelle (CHANNEL_UPDATE…). */
  private passerelle: Array<Promise<unknown>> = [];
  client!: Client;
  activite = 0;
  /** Défauts du banc lui-même (passerelle rejouée qui lève) : jamais imputés au code testé. */
  erreursBanc: string[] = [];
  langueDiscord: string;

  constructor(opts: OptionsMonde = {}) {
    this.latenceRestMs = opts.latenceRestMs ?? 120;
    this.langueDiscord = opts.langueDiscord ?? 'fr';
    this.roles = [
      { id: IDS.GUILD, name: '@everyone', permissions: PERMS_EVERYONE, position: 0 },
      { id: IDS.ROLE_MOD, name: 'Modération', permissions: '0', position: 3 },
      { id: IDS.ROLE_ADMIN, name: 'Administration', permissions: bits(P.Administrator), position: 4 },
      { id: IDS.ROLE_BOT, name: 'Kotbo', permissions: PERMS_BOT, position: 5, managed: true },
      { id: IDS.ROLE_RESA, name: 'Réservable', permissions: '0', position: 1 },
    ].map((r) => ({ color: 0, hoist: false, managed: false, mentionable: false, flags: 0, ...r }));

    const membre = (id: string, nom: string, roles: string[] = [], bot = false) =>
      this.membres.set(id, { user: utilisateurBrut(id, nom, bot), roles, joined_at: '2024-01-01T00:00:00.000Z', deaf: false, mute: false, flags: 0, nick: null });
    membre(IDS.BOT, 'Kotbo', [IDS.ROLE_BOT], true);
    membre(IDS.PROPRIO, 'proprio');
    membre(IDS.AUTORISE, 'autorise');
    membre(IDS.STAFF, 'staff', [IDS.ROLE_MOD]);
    membre(IDS.INCONNU, 'inconnu');
    membre(IDS.ADMIN, 'admin', [IDS.ROLE_ADMIN]);
    membre(IDS.CIBLE, 'cible');
    membre(IDS.DEHORS, 'dehors');
    membre(IDS.PROPRIO_SERVEUR, 'fondateur');

    this.salons.set(IDS.GEN, this.salonBrut(IDS.GEN, '➕ Créer un salon', []));
  }

  salonBrut(id: string, nom: string, surcharges: Brut[]): Brut {
    return {
      id, type: 2, guild_id: IDS.GUILD, name: nom, position: 0, permission_overwrites: surcharges,
      parent_id: null, bitrate: 64000, user_limit: 0, rtc_region: null, nsfw: false, rate_limit_per_user: 0, last_message_id: null,
    };
  }

  private etatVocalBrut(userId: string, channelId: string | null): Brut {
    return {
      guild_id: IDS.GUILD, channel_id: channelId, user_id: userId, session_id: `s-${userId}`,
      deaf: false, mute: false, self_deaf: false, self_mute: false, self_video: false, suppress: false,
      request_to_speak_timestamp: null, member: this.membres.get(userId),
    };
  }

  /** Un vrai `Client` discord.js, sans connexion, dont le REST passe par ce faux Discord. */
  creerClient(): Client {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] });
    (client.rest as unknown as { request: (o: Brut) => Promise<unknown> }).request = (o) => this.traiter(o);
    const c = client as unknown as Brut;
    c.user = new (ClientUser as unknown as new (cl: Client, d: Brut) => ClientUser)(client, utilisateurBrut(IDS.BOT, 'Kotbo', true));
    client.users.cache.set(IDS.BOT, client.user as never);
    c.application = new (ClientApplication as unknown as new (cl: Client, d: Brut) => ClientApplication)(client, { id: IDS.APP });
    (client.guilds as unknown as { _add: (d: Brut) => unknown })._add({
      id: IDS.GUILD, name: 'Serveur du banc', icon: null, owner_id: IDS.PROPRIO_SERVEUR, unavailable: false,
      preferred_locale: this.langueDiscord, roles: this.roles, emojis: [], stickers: [], features: [],
      channels: [...this.salons.values()], members: [...this.membres.values()],
      voice_states: [...this.etatsVocaux].map(([u, ch]) => this.etatVocalBrut(u, ch)),
      threads: [], presences: [], stage_instances: [], guild_scheduled_events: [], member_count: this.membres.size, large: false,
    } as never);
    this.client = client;
    return client;
  }

  /** Rejoue un événement de passerelle, de façon asynchrone comme le vrai. */
  private differer(fn: () => void): void {
    this.passerelle.push(new Promise<void>((r) => setImmediate(() => {
      try { fn(); } catch (e) { this.erreursBanc.push(`passerelle : ${(e as Error).message}`); } finally { r(); }
    })));
  }

  /** Un membre rejoint (ou quitte, `null`) un salon vocal : VOICE_STATE_UPDATE réel. */
  bouger(userId: string, channelId: string | null): void {
    if (channelId) this.etatsVocaux.set(userId, channelId);
    else this.etatsVocaux.delete(userId);
    const actions = (this.client as unknown as { actions: Brut }).actions;
    actions.VoiceStateUpdate.handle(this.etatVocalBrut(userId, channelId));
  }

  /** Une catégorie (type 4) et ses surcharges ; annoncée par CHANNEL_CREATE si le client existe. */
  ajouterCategorie(id: string, surcharges: Brut[]): void {
    const brut: Brut = { ...this.salonBrut(id, 'Catégorie', surcharges), type: 4 };
    delete brut.bitrate;
    delete brut.user_limit;
    this.salons.set(id, brut);
    if (this.client) this.differer(() => (this.client as unknown as { actions: Brut }).actions.ChannelCreate.handle(structuredClone(brut)));
  }

  /** Remplace toutes les surcharges d'un salon (ou d'une catégorie) et l'annonce par CHANNEL_UPDATE. */
  remplacerSurcharges(salonId: string, surcharges: Brut[]): void {
    const salon = this.salons.get(salonId);
    if (!salon) return;
    salon.permission_overwrites = structuredClone(surcharges);
    this.annoncerSalon(salonId);
  }

  /**
   * `SendMessages` effectif dans ce salon, calculé comme Discord sur l'état du
   * faux serveur (et non sur le cache du client) : rôles, Administrateur, puis
   * @everyone, rôles (refus puis accords) et membre.
   */
  peutEcrire(salonId: string, userId: string): boolean {
    const salon = this.salons.get(salonId);
    const membre = this.membres.get(userId);
    if (!salon || !membre) return false;
    const roles = membre.roles as string[];
    const role = (id: string) => this.roles.find((r) => r.id === id);
    let perms = BigInt(role(IDS.GUILD)!.permissions);
    for (const id of roles) perms |= BigInt(role(id)?.permissions ?? '0');
    if ((perms & P.Administrator) === P.Administrator) return true;
    const surcharge = (id: string) => (salon.permission_overwrites as Brut[]).find((o) => o.id === id);
    const appliquer = (o: Brut | undefined) => { if (o) perms = (perms & ~BigInt(o.deny)) | BigInt(o.allow); };
    appliquer(surcharge(IDS.GUILD));
    let allow = 0n;
    let deny = 0n;
    for (const id of roles) {
      const o = surcharge(id);
      if (o) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
    }
    perms = (perms & ~deny) | allow;
    appliquer(surcharge(userId));
    return (perms & P.SendMessages) === P.SendMessages;
  }

  /** Pose une surcharge côté serveur et la fait connaître par CHANNEL_UPDATE. */
  poserSurchargeDirecte(salonId: string, cible: string, type: 0 | 1, allow: bigint, deny = 0n): void {
    const salon = this.salons.get(salonId);
    if (!salon) return;
    salon.permission_overwrites = salon.permission_overwrites.filter((o: Brut) => o.id !== cible);
    salon.permission_overwrites.push({ id: cible, type, allow: allow.toString(), deny: deny.toString() });
    this.annoncerSalon(salonId);
  }

  private annoncerSalon(salonId: string): void {
    const brut = this.salons.get(salonId);
    if (!brut) return;
    const copie = structuredClone(brut);
    // Comme le gestionnaire CHANNEL_UPDATE de la passerelle : l'action met le
    // cache à jour, puis l'événement est émis avec l'ancien et le nouveau salon.
    this.differer(() => {
      const { old, updated } = (this.client as unknown as { actions: Brut }).actions.ChannelUpdate.handle(copie) ?? {};
      if (old && updated) this.client.emit(Events.ChannelUpdate, old, updated);
    });
  }

  supprimerSalon(salonId: string): void {
    const brut = this.salons.get(salonId);
    if (!brut) return;
    this.salons.delete(salonId);
    for (const [u, ch] of this.etatsVocaux) if (ch === salonId) this.etatsVocaux.delete(u);
    this.differer(() => (this.client as unknown as { actions: Brut }).actions.ChannelDelete.handle(brut));
  }

  /** Attend que plus rien ne bouge : passerelle rejouée, écouteurs finis, REST au repos. */
  async calme(enCours: Array<Promise<unknown>> = []): Promise<void> {
    let stables = 0;
    let dernier = -1;
    for (let tour = 0; tour < 400 && stables < 4; tour += 1) {
      await Promise.allSettled([...enCours, ...this.passerelle]);
      await new Promise((r) => setImmediate(r));
      const marque = this.appels.length + this.activite + this.passerelle.length + enCours.length;
      stables = marque === dernier ? stables + 1 : 0;
      dernier = marque;
    }
  }

  // ─── Interactions ───

  /** Charge gateway brute d'une interaction de composant (type 3) ou de fenêtre (type 5). */
  interactionBrute(p: {
    customId: string;
    genre: 'bouton' | 'menuTexte' | 'menuMembres' | 'menuRoles' | 'modale';
    acteur: string;
    channelId: string;
    message?: Brut | null;
    values?: string[];
    champs?: Record<string, string>;
    locale?: string;
    ageMs?: number;
  }): Brut {
    const id = nouvelId();
    const token = `jeton-${id}`;
    const membre: Brut = structuredClone(this.membres.get(p.acteur) ?? {});
    membre.permissions = p.acteur === IDS.ADMIN ? bits(P.Administrator) : PERMS_EVERYONE;
    const salon = this.salons.get(p.channelId);
    // Un clic dans un salon privé : ni serveur ni membre, seulement l'utilisateur.
    const enMp = this.mp.has(p.channelId);
    const typeComposant = { bouton: 2, menuTexte: 3, menuMembres: 5, menuRoles: 6, modale: 0 }[p.genre];
    const data: Brut = p.genre === 'modale'
      ? {
          custom_id: p.customId,
          components: Object.entries(p.champs ?? { value: '' }).map(([cid, value]) => ({
            type: 1, components: [{ type: 4, custom_id: cid, value }],
          })),
        }
      : { custom_id: p.customId, component_type: typeComposant, ...(p.values ? { values: p.values } : {}) };
    if (p.genre === 'menuMembres' && p.values) {
      data.resolved = {
        users: Object.fromEntries(p.values.filter((v) => this.membres.has(v)).map((v) => [v, this.membres.get(v)!.user])),
        members: Object.fromEntries(p.values.filter((v) => this.membres.has(v)).map((v) => {
          const { user: _u, ...reste } = this.membres.get(v)!;
          return [v, { ...reste, permissions: PERMS_EVERYONE }];
        })),
      };
    }
    if (p.genre === 'menuRoles' && p.values) {
      data.resolved = { roles: Object.fromEntries(p.values.map((v) => [v, this.roles.find((r) => r.id === v) ?? { id: v }])) };
    }
    this.interactions.set(id, {
      id, token, t0: this.horloge - (p.ageMs ?? 0), acquittee: false, enAttente: false,
      messageId: p.message?.id, messageEphemere: Boolean((p.message?.flags ?? 0) & 64), refusLocaux: [],
    });
    return {
      id, application_id: IDS.APP, type: p.genre === 'modale' ? 5 : 3, token, version: 1,
      ...(enMp ? {} : { guild_id: IDS.GUILD, guild_locale: this.langueDiscord }), channel_id: p.channelId,
      channel: enMp
        ? { id: p.channelId, type: 1, recipients: [membre.user] }
        : salon ? { id: p.channelId, type: 2, guild_id: IDS.GUILD, name: salon.name } : { id: p.channelId, type: 2 },
      ...(enMp ? { user: membre.user } : { member: membre, user: undefined }), data, locale: p.locale ?? 'fr',
      app_permissions: PERMS_BOT, entitlements: [], authorizing_integration_owners: { 0: IDS.GUILD }, context: enMp ? 1 : 0,
      ...(p.message ? { message: structuredClone(p.message) } : {}),
    };
  }

  /** Note un refus de discord.js lui-même (deuxième acquittement, édition à vide) : il n'atteint pas le REST. */
  noterRefusLocal(interactionId: string, message: string): void {
    this.interactions.get(interactionId)?.refusLocaux.push(message);
  }

  etatInteraction(id: string): EtatInteraction | undefined {
    return this.interactions.get(id);
  }

  // ─── Routeur REST ───

  async traiter(o: Brut): Promise<unknown> {
    const methode = String(o.method);
    const route = String(o.fullRoute);
    // Discord reçoit du JSON : les BitField et bigint passent par leur forme sérialisée.
    if (o.body !== undefined) o = { ...o, body: JSON.parse(JSON.stringify(o.body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) };
    const appel: AppelRest = { methode, route, corps: o.body, t: this.horloge, violations: [] };
    this.horloge += route.includes('/callback') || route.startsWith('/webhooks') ? 60 : this.latenceRestMs;
    this.appels.push(appel);
    this.activite += 1;
    try {
      return this.router(methode, route, o, appel);
    } catch (e) {
      if (e instanceof RefusDiscord) {
        appel.erreur = { code: e.code, message: e.message };
        const [statut, texte] = ERREURS[e.code] ?? [400, e.message];
        throw new DiscordAPIError({ code: e.code, message: `${texte}${e.detail ? ` (${e.detail})` : ''}` } as never, e.code, statut, methode, route, { body: o.body, files: o.files } as never);
      }
      throw e;
    } finally {
      this.activite -= 1;
    }
  }

  private router(methode: string, route: string, o: Brut, appel: AppelRest): unknown {
    let r: RegExpMatchArray | null;

    // Interactions
    if ((r = route.match(/^\/interactions\/(\d+)\/([^/]+)\/callback$/))) return this.callback(r[1], o.body, appel);
    if ((r = route.match(/^\/webhooks\/(\d+)\/([^/]+)(?:\/messages\/([^/?]+))?$/))) return this.webhook(methode, r[2], r[3] ? decodeURIComponent(r[3]) : null, o.body, appel);

    // Salons
    if ((r = route.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/))) {
      const salon = this.salonVivant(r[1], true);
      salon.permission_overwrites = salon.permission_overwrites.filter((s: Brut) => s.id !== r![2]);
      if (methode === 'PUT') {
        salon.permission_overwrites.push({ id: r[2], type: o.body?.type ?? 1, allow: String(o.body?.allow ?? '0'), deny: String(o.body?.deny ?? '0') });
      }
      this.annoncerSalon(r[1]);
      return undefined;
    }
    if ((r = route.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      this.salonVivant(r[1], methode !== 'GET');
      const msg = this.messages.get(r[2]);
      if (!msg || msg.channel_id !== r[1]) throw new RefusDiscord(10008);
      if (methode === 'GET') return structuredClone(msg);
      if (methode === 'PATCH') return this.editerMessage(msg, o.body, appel);
      if (methode === 'DELETE') { this.messages.delete(r[2]); return undefined; }
    }
    if ((r = route.match(/^\/channels\/(\d+)\/messages$/))) {
      if (methode === 'GET') {
        this.salonVivant(r[1], false);
        return [...this.messages.values()].filter((m) => m.channel_id === r![1] && !(m.flags & 64)).reverse().slice(0, 50).map((m) => structuredClone(m));
      }
      if (methode === 'POST') {
        if (!this.salons.has(r[1]) && !this.mp.has(r[1])) throw new RefusDiscord(10003);
        if (this.mp.has(r[1]) && this.mpFermes.has(this.destinataireMp(r[1]))) throw new RefusDiscord(50007);
        appel.violations.push(...validerMessage(o.body, null));
        return structuredClone(this.creerMessage(r[1], o.body));
      }
    }
    if ((r = route.match(/^\/channels\/(\d+)$/))) {
      if (methode === 'GET') return structuredClone(this.salonVivant(r[1], false));
      const salon = this.salonVivant(r[1], true);
      if (methode === 'PATCH') {
        const b = o.body ?? {};
        if (typeof b.name === 'string') {
          if (b.name.length < 1 || b.name.length > 100) appel.violations.push(`nom de salon de ${b.name.length} caractères`);
          salon.name = b.name;
        }
        if (typeof b.user_limit === 'number') {
          if (b.user_limit < 0 || b.user_limit > 99) appel.violations.push(`limite ${b.user_limit} hors 0..99`);
          salon.user_limit = b.user_limit;
        }
        return structuredClone(salon);
      }
      if (methode === 'DELETE') { this.supprimerSalon(r[1]); return structuredClone(salon); }
    }
    if ((r = route.match(/^\/guilds\/(\d+)\/channels$/)) && methode === 'POST') {
      const id = nouvelId();
      const b = o.body ?? {};
      const salon = this.salonBrut(id, b.name, (b.permission_overwrites ?? []).map((s: Brut) => ({ id: s.id, type: s.type, allow: String(s.allow ?? '0'), deny: String(s.deny ?? '0') })));
      salon.user_limit = b.user_limit ?? 0;
      salon.parent_id = b.parent_id ?? null;
      this.salons.set(id, salon);
      return structuredClone(salon);
    }

    // Membres
    if ((r = route.match(/^\/guilds\/(\d+)\/members\/(\d+)$/))) {
      const membre = this.membres.get(r[2]);
      if (!membre) throw new RefusDiscord(10007);
      if (methode === 'GET') return structuredClone(membre);
      if (methode === 'PATCH') {
        if ('channel_id' in (o.body ?? {})) {
          if (!this.etatsVocaux.has(r[2])) throw new RefusDiscord(40032);
          const vers = o.body.channel_id as string | null;
          if (vers && !this.salons.has(vers)) throw new RefusDiscord(10003);
          const id = r[2];
          if (vers) this.etatsVocaux.set(id, vers); else this.etatsVocaux.delete(id);
          this.differer(() => this.bouger(id, vers));
        }
        return structuredClone(membre);
      }
    }

    // Messages privés
    if (route === '/users/@me/channels' && methode === 'POST') {
      const dest = String(o.body?.recipient_id);
      const id = this.canalMp(dest);
      return { id, type: 1, recipients: [this.membres.get(dest)?.user ?? utilisateurBrut(dest, 'x')], last_message_id: null };
    }

    throw new RefusDiscord(0, `${methode} ${route}`);
  }

  /** Le salon privé du bot avec ce membre (ouvert s'il ne l'était pas). */
  canalMp(userId: string): string {
    const id = (BigInt(userId) + 7n).toString();
    this.mp.add(id);
    return id;
  }

  destinataireMp(salonId: string): string {
    return (BigInt(salonId) - 7n).toString();
  }

  /** Salon existant, sinon 10003 ; compte les modifications pour le scénario de suppression. */
  private salonVivant(id: string, modification: boolean): Brut {
    const salon = this.salons.get(id);
    if (!salon) {
      if (this.mp.has(id)) return { id, type: 1 };
      throw new RefusDiscord(10003);
    }
    if (modification && this.supprimerApres?.salonId === id) {
      this.supprimerApres.n -= 1;
      if (this.supprimerApres.n < 0) {
        this.supprimerSalon(id);
        throw new RefusDiscord(10003);
      }
    }
    return salon;
  }

  creerMessage(channelId: string, corps: Brut, extra: Brut = {}): Brut {
    const id = nouvelId();
    const msg: Brut = {
      id, channel_id: channelId, guild_id: IDS.GUILD, author: utilisateurBrut(IDS.BOT, 'Kotbo', true),
      content: corps?.content ?? '', embeds: corps?.embeds ?? [], components: corps?.components ?? [],
      flags: Number(corps?.flags ?? 0), timestamp: new Date(0).toISOString(), edited_timestamp: null,
      tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], pinned: false, type: 0,
      ...extra,
    };
    this.messages.set(id, msg);
    this.touches.push(id);
    return msg;
  }

  private editerMessage(msg: Brut, corps: Brut, appel: AppelRest): Brut {
    appel.violations.push(...validerMessage(corps, msg));
    if (corps && 'content' in corps) msg.content = corps.content ?? '';
    if (corps && 'embeds' in corps) msg.embeds = corps.embeds ?? [];
    if (corps && 'components' in corps) msg.components = corps.components ?? [];
    if (corps && 'flags' in corps && corps.flags !== undefined) msg.flags = (msg.flags & 64) | Number(corps.flags);
    msg.edited_timestamp = new Date(0).toISOString();
    this.touches.push(msg.id);
    return structuredClone(msg);
  }

  private callback(interactionId: string, corps: Brut, appel: AppelRest): unknown {
    const it = this.interactions.get(interactionId);
    appel.interactionId = interactionId;
    appel.typeCallback = corps?.type;
    if (!it) throw new RefusDiscord(10062);
    if (it.acquittee) throw new RefusDiscord(40060);
    if (appel.t - it.t0 > 3_000) throw new RefusDiscord(10062, `acquittement à ${appel.t - it.t0} ms`);
    const data = corps?.data ?? {};
    switch (corps?.type) {
      case 4: {
        appel.violations.push(...validerMessage(data, null));
        if (!(Number(data.flags ?? 0) & 64)) appel.violations.push('réponse PUBLIQUE (type 4 sans drapeau éphémère)');
        it.originalId = this.creerMessage(this.salonDe(it), data).id;
        appel.cree = it.originalId;
        break;
      }
      case 5:
        if (!(Number(data.flags ?? 0) & 64)) appel.violations.push('« réfléchit… » PUBLIC (type 5 sans drapeau éphémère)');
        it.originalId = this.creerMessage(this.salonDe(it), { flags: Number(data.flags ?? 0) }).id;
        appel.cree = it.originalId;
        it.enAttente = true;
        break;
      case 6:
        if (!it.messageId) appel.violations.push('deferUpdate sans message porteur');
        it.originalId = it.messageId;
        break;
      case 7: {
        const cible = it.messageId ? this.messages.get(it.messageId) : null;
        if (!cible) throw new RefusDiscord(10008);
        // Un MP n'est lu que par son destinataire : le réécrire au clic est la règle.
        if (!(cible.flags & 64) && !this.mp.has(cible.channel_id)) appel.violations.push('update() réécrit un message PUBLIC');
        this.editerMessage(cible, data, appel);
        it.originalId = cible.id;
        break;
      }
      case 9:
        appel.violations.push(...validerModale(data));
        it.modale = data;
        break;
      default:
        appel.violations.push(`type de callback inattendu ${corps?.type}`);
    }
    it.acquittee = true;
    it.typeAck = corps?.type;
    return undefined;
  }

  private salonDe(it: EtatInteraction): string {
    const porteur = it.messageId ? this.messages.get(it.messageId) : null;
    return porteur?.channel_id ?? 'ephemere';
  }

  private webhook(methode: string, token: string, messageId: string | null, corps: Brut, appel: AppelRest): unknown {
    const it = [...this.interactions.values()].find((i) => i.token === token);
    appel.interactionId = it?.id;
    if (!it || !it.acquittee) throw new RefusDiscord(10015, 'interaction non acquittée');
    if (methode === 'POST') {
      appel.violations.push(...validerMessage(corps, null));
      if (it.enAttente) {
        // Discord : après deferReply, le premier followUp REMPLACE « réfléchit… ».
        it.enAttente = false;
        const msg = this.messages.get(it.originalId!)!;
        return structuredClone(this.editerMessage(msg, corps, { ...appel, violations: [] }));
      }
      if (!(Number(corps?.flags ?? 0) & 64)) appel.violations.push('followUp PUBLIC (sans drapeau éphémère)');
      const cree = this.creerMessage(this.salonDe(it), corps);
      appel.cree = cree.id;
      return structuredClone(cree);
    }
    const id = messageId === '@original' ? it.originalId : messageId;
    const msg = id ? this.messages.get(id) : null;
    if (!msg) throw new RefusDiscord(10008, `message ${messageId} introuvable (acquittement ${it.typeAck})`);
    if (methode === 'GET') return structuredClone(msg);
    if (methode === 'PATCH') {
      // Un MP n'est lu que par son destinataire, comme pour update().
      if (!(msg.flags & 64) && !this.mp.has(msg.channel_id) && msg.author?.id === IDS.BOT && msg.components?.length) {
        appel.violations.push('editReply réécrit un message PUBLIC (le panneau du salon ?)');
      }
      it.enAttente = false;
      return this.editerMessage(msg, corps, appel);
    }
    if (methode === 'DELETE') { this.messages.delete(msg.id); return undefined; }
    throw new RefusDiscord(0, `${methode} webhook`);
  }

  /** Branche le suivi des refus locaux de discord.js sur une interaction. */
  instrumenter(interaction: Brut): void {
    this.objetsInteraction.set(interaction.id, interaction);
    for (const nom of ['reply', 'deferReply', 'deferUpdate', 'update', 'showModal', 'editReply', 'followUp']) {
      const original = interaction[nom];
      if (typeof original !== 'function') continue;
      interaction[nom] = (...args: unknown[]) => Promise.resolve()
        .then(() => original.apply(interaction, args))
        .catch((e: { code?: string; message?: string }) => {
          if (e?.code === 'InteractionAlreadyReplied' || e?.code === 'InteractionNotReplied') {
            this.noterRefusLocal(interaction.id, `${nom} : ${e.code}`);
          }
          throw e;
        });
    }
  }

  /** Les appels qui ont modifié Discord (hors interactions et lectures). */
  mutations(depuis = 0): AppelRest[] {
    return this.appels.slice(depuis).filter((a) => a.methode !== 'GET' && !a.interactionId && !a.route.startsWith('/users/@me'));
  }
}

class RefusDiscord extends Error {
  constructor(public code: number, public detail?: string) {
    super(ERREURS[code]?.[1] ?? `Erreur ${code}`);
  }
}

// ─── Validation des charges, règles de l'API Discord ───

const V2 = 1 << 15;

/** Le composant de ce message qui porte ce custom_id. */
export function trouverComposant(message: Brut | null | undefined, customId: string): Brut | null {
  return aplatir(message?.components).find((c) => c.custom_id === customId) ?? null;
}

/** Tous les composants, imbriqués compris (rangées, conteneurs, sections, accessoires). */
function aplatir(composants: Brut[] | undefined): Brut[] {
  const tous: Brut[] = [];
  for (const c of composants ?? []) {
    if (!c) continue;
    tous.push(c);
    tous.push(...aplatir(c.components));
    if (c.accessory) tous.push(...aplatir([c.accessory]));
  }
  return tous;
}

function validerComposant(c: Brut, v: string[]): void {
  const id = c.custom_id as string | undefined;
  if (id !== undefined && (id.length < 1 || id.length > 100)) v.push(`custom_id de ${id.length} caractères : ${id.slice(0, 40)}`);
  switch (c.type) {
    case 2:
      if (c.style !== 5 && c.style !== 6 && !id) v.push('bouton sans custom_id');
      if (c.label !== undefined && String(c.label).length > 80) v.push(`label de bouton de ${String(c.label).length} caractères`);
      if (!c.label && !c.emoji) v.push('bouton sans label ni emoji');
      break;
    case 3: case 5: case 6: case 7: case 8: {
      if (c.placeholder !== undefined && String(c.placeholder).length > 150) v.push(`placeholder de ${String(c.placeholder).length} caractères`);
      const min = c.min_values ?? 1;
      const max = c.max_values ?? 1;
      if (min < 0 || min > 25 || max < 1 || max > 25 || min > max) v.push(`min/max_values incohérents (${min}/${max}) sur ${id}`);
      if (c.type === 3) {
        const n = (c.options ?? []).length;
        if (n < 1 || n > 25) v.push(`menu ${id} avec ${n} option(s) (1..25)`);
        if (max > n) v.push(`max_values ${max} > ${n} options sur ${id}`);
        for (const o of c.options ?? []) {
          if (!o.label || String(o.label).length > 100) v.push(`option de menu au label invalide (${String(o.label).length})`);
          if (!o.value || String(o.value).length > 100) v.push('option de menu à la valeur invalide');
          if (o.description && String(o.description).length > 100) v.push('description d\'option > 100');
        }
        const valeurs = (c.options ?? []).map((o: Brut) => o.value);
        if (new Set(valeurs).size !== valeurs.length) v.push(`valeurs d'options en double sur ${id}`);
        const defauts = (c.options ?? []).filter((o: Brut) => o.default).length;
        if (defauts > max) v.push(`${defauts} options par défaut pour max_values ${max}`);
      } else if ((c.default_values ?? []).length > max) {
        v.push(`${c.default_values.length} default_values pour max_values ${max}`);
      }
      break;
    }
    default:
  }
}

/** Violations d'une charge de message (création, réponse, édition). `cible` = message édité. */
export function validerMessage(corps: Brut | null | undefined, cible: Brut | null): string[] {
  const v: string[] = [];
  if (!corps) return v;
  const flags = Number(corps.flags ?? 0) | (cible ? cible.flags & V2 : 0);
  const estV2 = Boolean(flags & V2);
  if (cible && cible.flags & V2 && corps.flags !== undefined && !(Number(corps.flags) & V2)) {
    v.push('édition qui retire IS_COMPONENTS_V2 (refusé par Discord)');
  }
  const composants = (corps.components ?? []) as Brut[];
  const tous = aplatir(composants);
  for (const c of tous) validerComposant(c, v);
  const ids = tous.map((c) => c.custom_id).filter(Boolean);
  if (new Set(ids).size !== ids.length) v.push(`custom_id en double : ${ids.join(', ')}`);

  if (estV2) {
    if (typeof corps.content === 'string' && corps.content.length > 0) v.push('content interdit avec IS_COMPONENTS_V2');
    if (Array.isArray(corps.embeds) && corps.embeds.length > 0) v.push('embeds interdits avec IS_COMPONENTS_V2');
    if (tous.length > 40) v.push(`${tous.length} composants (max 40 en V2)`);
    const texte = tous.filter((c) => c.type === 10).reduce((n, c) => n + String(c.content ?? '').length, 0);
    if (texte > 4000) v.push(`${texte} caractères de Text Display (max 4000)`);
  } else {
    if (composants.length > 5) v.push(`${composants.length} rangées (max 5)`);
    for (const r of composants) {
      if (r.type !== 1) { v.push(`composant de premier niveau de type ${r.type} sans IS_COMPONENTS_V2`); continue; }
      const enfants = (r.components ?? []) as Brut[];
      const menus = enfants.filter((c) => c.type !== 2).length;
      if (enfants.length === 0 || enfants.length > 5) v.push(`rangée de ${enfants.length} composants`);
      if (menus > 0 && enfants.length > 1) v.push('menu partageant sa rangée');
    }
    if (typeof corps.content === 'string' && corps.content.length > 2000) v.push(`content de ${corps.content.length} caractères`);
    const embeds = (corps.embeds ?? []) as Brut[];
    if (embeds.length > 10) v.push(`${embeds.length} embeds`);
    let total = 0;
    for (const e of embeds) {
      const t = String(e.title ?? ''); const d = String(e.description ?? '');
      if (t.length > 256) v.push(`titre d'embed de ${t.length}`);
      if (d.length > 4096) v.push(`description d'embed de ${d.length}`);
      if ((e.fields ?? []).length > 25) v.push(`${e.fields.length} champs d'embed`);
      total += t.length + d.length + String(e.footer?.text ?? '').length + String(e.author?.name ?? '').length;
      for (const f of e.fields ?? []) {
        if (!f.name || String(f.name).length > 256) v.push(`nom de champ invalide (${String(f.name ?? '').length})`);
        if (!f.value || String(f.value).length > 1024) v.push(`valeur de champ invalide (${String(f.value ?? '').length})`);
        total += String(f.name ?? '').length + String(f.value ?? '').length;
      }
    }
    if (total > 6000) v.push(`embeds de ${total} caractères au total`);
  }

  // Une mention envoyée sans `allowed_mentions` notifie au gré du texte.
  const mentionne = /<@[!&]?\d+>/.test(String(corps.content ?? '')) || tous.some((c) => c.type === 10 && /<@[!&]?\d+>/.test(String(c.content ?? '')));
  // Une édition ne notifie jamais : seule la création compte.
  if (mentionne && !cible && corps.allowed_mentions === undefined) v.push('mention envoyée sans allowed_mentions');
  return v;
}

export function validerModale(d: Brut): string[] {
  const v: string[] = [];
  const titre = String(d.title ?? '');
  if (titre.length < 1 || titre.length > 45) v.push(`titre de fenêtre de ${titre.length} caractères (1..45)`);
  if (!d.custom_id || String(d.custom_id).length > 100) v.push('custom_id de fenêtre invalide');
  const rangees = (d.components ?? []) as Brut[];
  if (rangees.length < 1 || rangees.length > 5) v.push(`${rangees.length} rangées de fenêtre (1..5)`);
  for (const c of aplatir(rangees)) {
    if (c.type !== 4) continue;
    if (!c.label || String(c.label).length > 45) v.push(`label de saisie de ${String(c.label ?? '').length} caractères (max 45)`);
    if (c.placeholder && String(c.placeholder).length > 100) v.push(`placeholder de saisie de ${String(c.placeholder).length} (max 100)`);
    if (c.max_length !== undefined && (c.max_length < 1 || c.max_length > 4000)) v.push(`max_length ${c.max_length}`);
  }
  return v;
}

// ─── Textes visibles, clés brutes, langue ───

/** Tout ce qu'un humain lit dans une charge : contenu, embeds, Text Display, libellés, fenêtres. */
export function textesVisibles(corps: Brut | null | undefined): string[] {
  if (!corps) return [];
  const t: string[] = [];
  const pousser = (s: unknown) => { if (typeof s === 'string' && s.trim()) t.push(s); };
  pousser(corps.content);
  pousser(corps.title);
  for (const e of corps.embeds ?? []) {
    pousser(e.title); pousser(e.description); pousser(e.footer?.text); pousser(e.author?.name);
    for (const f of e.fields ?? []) { pousser(f.name); pousser(f.value); }
  }
  for (const c of aplatir(corps.components)) {
    pousser(c.content); pousser(c.label); pousser(c.placeholder);
    for (const o of c.options ?? []) { pousser(o.label); pousser(o.description); }
  }
  return t;
}

const MOTIFS_BRUTS: Array<[RegExp, string]> = [
  [/\b(?:panel_tempvoice|cm_tv|tempvoice)_[a-z0-9_]+\b/, 'clé i18n brute'],
  [/\{[a-zA-Z_][a-zA-Z0-9_]*\}/, 'paramètre {…} non remplacé'],
  [/\bundefined\b/, '« undefined »'],
  [/\[object Object\]/, '« [object Object] »'],
  [/\bNaN\b/, '« NaN »'],
];

export function clesBrutes(textes: string[]): string[] {
  const v: string[] = [];
  for (const s of textes) for (const [re, nom] of MOTIFS_BRUTS) if (re.test(s)) v.push(`${nom} : « ${s.slice(0, 90)} »`);
  return v;
}

const dossierMessages = path.resolve(import.meta.dir, '../../../messages');
const FR = JSON.parse(readFileSync(path.join(dossierMessages, 'fr.json'), 'utf8')) as Record<string, unknown>;
const EN = JSON.parse(readFileSync(path.join(dossierMessages, 'en.json'), 'utf8')) as Record<string, unknown>;

/** Sans emoji ni ponctuation de tête : « 🔒 Verrouillé » et « Verrouillé » se comparent. */
const nu = (s: string) => s.replace(/<a?:\w+:\d+>/g, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

function empreintes(source: Record<string, unknown>, autre: Record<string, unknown>) {
  const valeursAutre = new Set(Object.values(autre).filter((x): x is string => typeof x === 'string').map(nu));
  const textesAutre = Object.values(autre).filter((x): x is string => typeof x === 'string').join('\n');
  const exactes = new Map<string, string>();
  const fragments = new Map<string, string>();
  for (const [cle, val] of Object.entries(source)) {
    const traduit = autre[cle];
    if (typeof val !== 'string' || typeof traduit !== 'string' || val === traduit) continue;
    const net = nu(val);
    if (!/\{/.test(val) && net.length >= 3 && !valeursAutre.has(net)) exactes.set(net, cle);
    for (const morceau of val.split(/\{[^}]*\}/)) {
      const m = nu(morceau).replace(/[\s.:!?,;*_`]+$/u, '');
      if (m.length >= 14 && /\p{L}{4}/u.test(m) && !textesAutre.includes(m)) fragments.set(m, cle);
    }
  }
  return { exactes, fragments };
}
const EMPREINTES = { en: empreintes(EN, FR), fr: empreintes(FR, EN) };

/** Textes écrits dans l'AUTRE langue que celle du serveur. */
export function horsLangue(textes: string[], langue: 'fr' | 'en'): string[] {
  const etrangere = EMPREINTES[langue === 'fr' ? 'en' : 'fr'];
  const v: string[] = [];
  for (const s of textes) {
    for (const ligne of s.split('\n')) {
      const net = nu(ligne.replace(/\*\*|__|`|#+ /g, ''));
      const cle = etrangere.exactes.get(net);
      if (cle) { v.push(`${cle} en ${langue === 'fr' ? 'anglais' : 'français'} : « ${net.slice(0, 80)} »`); continue; }
      for (const [frag, k] of etrangere.fragments) {
        if (ligne.includes(frag)) { v.push(`${k} en ${langue === 'fr' ? 'anglais' : 'français'} : « ${frag.slice(0, 80)} »`); break; }
      }
    }
  }
  return v;
}

/** Inscrit le client sur les écouteurs de production en gardant la promesse de chaque appel. */
export function suivreEcouteurs(client: Client): Array<Promise<unknown>> {
  const enCours: Array<Promise<unknown>> = [];
  const c = client as unknown as Brut;
  for (const nom of ['on', 'once']) {
    const original = (Client.prototype as unknown as Brut)[nom];
    c[nom] = function (this: Client, evenement: string, ecouteur: (...a: unknown[]) => unknown) {
      return original.call(this, evenement, (...a: unknown[]) => {
        const p = Promise.resolve(ecouteur(...a));
        enCours.push(p.catch(() => undefined));
        return p;
      });
    };
  }
  return enCours;
}

export { Events };
