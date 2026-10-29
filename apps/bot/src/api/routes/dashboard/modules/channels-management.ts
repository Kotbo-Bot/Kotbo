/** Routes dashboard du module `channels-management`. */
import { updateGuildStats } from '../../../../events/stats.js';
import { readStatsConfig } from '../../../../services/analytics/statsConfig.js';
import { cache } from '../../../../utils/cache.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { RENAME_TIMEOUT_MS, settleWithin } from '../../../../utils/discord.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { isDeepStrictEqual } from 'node:util';
import { ChannelType, PermissionFlagsBits, type Guild, type VoiceChannel } from 'discord.js';
import { sendLogEmbed } from '../../../../utils/logDispatch.js';
import { construireEmbedReglagesVocaux } from '../../../../utils/tempVoiceReglagesLog.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { honeypotChannelName, provisionHoneypotChannel } from '../../../../services/moderation/honeypotProvisioning.js';
import {
  CHANNEL_PATCHES,
  MAX_ADDITIONAL_GENERATORS,
  categoryOverwriteFor,
  normalizeTempVoiceGeneratorsInput,
  resolveReservationRoleId,
  restoreFromCategory,
  categoryTrustPatch,
  normalizeTempVoicePolicy,
  dispositionNative,
} from '../../../../services/features/tempVoiceService.js';
import { readWordStatsEnabled, startWordStatsBackfillIfTurnedOn, type ModuleRouteContext } from './_shared.js';
import type { Prisma } from '@prisma/client';
import {
  TEMP_VOICE_CLAIM_WHO,
  TEMP_VOICE_HANDOVER_DELAY_BOUNDS,
  TEMP_VOICE_OWNER_MENTION_DEFAULT,
  TEMP_VOICE_OWNER_MENTION_PLACEMENTS,
  TEMP_VOICE_OWNERSHIP_DEFAULTS,
  diffReglagesVocaux,
  lignesDiffReglages,
  type ChangementReglage,
  type LangueDiff,
  type NomsLisibles,
  type ReglagesVocaux,
  type TempVoiceClaimWho,
  type TempVoiceOwnerMentionPlacement,
  type TempVoiceOwnershipSettings,
} from '@kotbo/shared';

import { jsonFailure } from '../../../shared/failure.js';

// Une liste d'identifiants se compare comme un ensemble, un objet vide vaut une absence :
// la page renvoie l'un ou l'autre sans que la valeur ait changé.
function memeValeur(avant: unknown, apres: unknown): boolean {
  const norme = (v: unknown) => (Array.isArray(v) ? [...v].sort() : v && typeof v === 'object' && Object.keys(v).length === 0 ? null : v ?? null);
  return isDeepStrictEqual(norme(avant), norme(apres));
}
/**
 * Fonctionnalites qui se reglent salon par salon, et le champ de la guilde qui
 * les porte. Toutes se ramenent a deux formes : une liste d'identifiants a
 * laquelle le salon appartient ou non, ou un champ unique qui pointe le salon
 * elu. La vue « Par salon » les manipule sans connaitre le detail de chacune.
 */
const CHANNEL_FEATURES = {
  autoThread: { kind: 'list', field: 'autoThreadChannels', label: 'Fils automatiques' },
  logIgnored: { kind: 'list', field: 'logIgnoredChannelIds', label: 'Exclu des logs' },
  honeypot: { kind: 'single', field: 'honeypotChannelId', label: 'Salon piège' },
  funCounting: { kind: 'single', field: 'funCountingChannelId', label: 'Comptage' },
  funOneWordStory: { kind: 'single', field: 'funOneWordStoryChannelId', label: 'Histoire à un mot' },
  funGuessNumber: { kind: 'single', field: 'funGuessNumberChannelId', label: 'Devine le nombre' },
  funWordChain: { kind: 'single', field: 'funWordChainChannelId', label: 'Chaîne de mots' },
  funEmojiRiddle: { kind: 'single', field: 'funEmojiRiddleChannelId', label: 'Rébus emoji' },
  funNeverSay: { kind: 'single', field: 'funNeverSayChannelId', label: 'Ni oui ni non' },
  funEmojiOnly: { kind: 'single', field: 'funEmojiOnlyChannelId', label: 'Emoji uniquement' },
  funImageOfDay: { kind: 'single', field: 'funImageOfDayChannelId', label: 'Image du jour' },
  funConfession: { kind: 'single', field: 'funConfessionChannelId', label: 'Confessions' },
} as const;

type ChannelFeatureKey = keyof typeof CHANNEL_FEATURES;

const CHANNEL_FEATURE_KEYS = Object.keys(CHANNEL_FEATURES) as ChannelFeatureKey[];

/** Colonnes a lire pour connaitre l'etat de toutes les fonctionnalites. */
const CHANNEL_FEATURE_SELECT = Object.fromEntries(
  CHANNEL_FEATURE_KEYS.map((key) => [CHANNEL_FEATURES[key].field, true]),
) as Record<string, true>;

/**
 * Demandes d'accès à un salon verrouillé/réservé, et permissions du staff sur
 * les salons temporaires qui ne sont pas les siens. Deux tables séparées
 * (`TempVoiceAccessRequestConfig` / `TempVoiceModPermissionsConfig`,
 * packages/database/prisma/temp-voice-access.prisma), une ligne par serveur :
 * un serveur qui n'a jamais ouvert l'onglet n'en a pas. L'absence doit se lire
 * comme les défauts du schéma, jamais comme des zéros — sans quoi un
 * `enabled` absent relu `false` alors que le schéma dit `true` changerait le
 * comportement sans que rien ne le signale (piège déjà payé une fois dans ce
 * dépôt sur `tempVoiceDefaults`/`normalizeTempVoicePolicy`).
 */
type TempVoiceAccessResponders = 'OWNER' | 'OWNER_AND_STAFF';
type TempVoiceAccessNotifyVia = 'VOICE' | 'DM' | 'CHANNEL';
type TempVoiceReservationOverflow = 'ASK' | 'NOTHING' | 'MOVE' | 'DISCONNECT';
/**
 * Présentation du panneau de gestion, configurable par serveur. Mêmes
 * valeurs que `MODES_PANNEAU`/`DISPOSITIONS_ETAT`/`TEINTES_ETAT`/
 * `JEUX_COMPOSANTS`/`REPLIS_RESERVATION` dans `tempVoiceService.ts` — ce
 * fichier suit l'habitude déjà prise ci-dessus de déclarer ses types en
 * local plutôt que de les importer.
 */
type TempVoicePanelMode = 'CLASSIC' | 'FLAT';
type TempVoiceStateLayout = 'GRID3' | 'GRID2' | 'TABLE' | 'CARDS';
type TempVoiceStateColors = 'NEUTRAL' | 'DARK' | 'LIGHT';
type TempVoicePanelComponents = 'V1' | 'V2';
type TempVoiceReservationFallbackMode = 'MEMBERS' | 'ANY_ROLE' | 'FORBIDDEN';

const TEMP_VOICE_ACCESS_RESPONDERS: readonly TempVoiceAccessResponders[] = ['OWNER', 'OWNER_AND_STAFF'];
const TEMP_VOICE_ACCESS_NOTIFY_VIA: readonly TempVoiceAccessNotifyVia[] = ['VOICE', 'DM', 'CHANNEL'];
const TEMP_VOICE_RESERVATION_OVERFLOW: readonly TempVoiceReservationOverflow[] = ['ASK', 'NOTHING', 'MOVE', 'DISCONNECT'];
const TEMP_VOICE_PANEL_MODE: readonly TempVoicePanelMode[] = ['CLASSIC', 'FLAT'];
const TEMP_VOICE_STATE_LAYOUT: readonly TempVoiceStateLayout[] = ['GRID3', 'GRID2', 'TABLE', 'CARDS'];
const TEMP_VOICE_STATE_COLORS: readonly TempVoiceStateColors[] = ['NEUTRAL', 'DARK', 'LIGHT'];
const TEMP_VOICE_PANEL_COMPONENTS: readonly TempVoicePanelComponents[] = ['V1', 'V2'];
const TEMP_VOICE_RESERVATION_FALLBACK_MODE: readonly TempVoiceReservationFallbackMode[] = ['MEMBERS', 'ANY_ROLE', 'FORBIDDEN'];
/** Plafond d'un menu de sélection de rôle Discord : au-delà, le bot ne pourrait pas les afficher. */
const MAX_RESERVABLE_ROLES = 25;

interface TempVoiceAccessRequestConfigView {
  enabled: boolean;
  responders: TempVoiceAccessResponders;
  notifyVia: TempVoiceAccessNotifyVia;
  notifyChannelId: string | null;
  requestExpiresMinutes: number;
  denyCooldownMinutes: number;
}

interface TempVoiceModPermissionsConfigView extends TempVoiceOwnershipSettings {
  canRename: boolean;
  canChangeLimit: boolean;
  canLock: boolean;
  canChangeWriteMode: boolean;
  canKickOrBan: boolean;
  canReserve: boolean;
  canTransfer: boolean;
  /**
   * Pas une permission modérateur : un choix de présentation des
   * sous-panneaux éphémères. Défaut `false` (comportement livré), à l'inverse
   * des sept permissions ci-dessus qui valent `true` par défaut.
   */
  panelCompactMode: boolean;
  /**
   * Rôles proposés dans le menu « Réserver le salon ». Vide — n'importe quel
   * rôle du serveur (comportement livré). Non vide — seuls ces rôles sont
   * proposés.
   */
  reservableRoleIds: string[];
  /**
   * Sort des personnes déjà dans le salon qui n'ont pas le rôle au moment où
   * il est réservé. `ASK` pose la question au propriétaire.
   */
  reservationOverflow: TempVoiceReservationOverflow;
  /** Salon vers lequel déplacer quand la décision est `MOVE`. */
  reservationFallbackChannelId: string | null;
  /** Portes séparées (CLASSIC) ou tout sur un écran (FLAT). Défaut `CLASSIC`. */
  panelMode: TempVoicePanelMode;
  /** Mise en page des six valeurs d'état. Seule GRID3 en V1 est native. Défaut `GRID3`. */
  stateLayout: TempVoiceStateLayout;
  /** Palette de l'image d'état ; sans effet pour GRID3 en V1. Défaut `NEUTRAL`. */
  stateColors: TempVoiceStateColors;
  /** Embed classique (V1) ou Components V2 (V2, rendu actuel). Défaut `V2`. */
  panelComponents: TempVoicePanelComponents;
  /**
   * Bouton « Réserver » pour qui n'a aucun rôle réservable. Défaut `ANY_ROLE`.
   * Même nom que la colonne Prisma `reservationFallbackMode` et que le champ
   * envoyé/lu par le dashboard (moderation.ts, ChannelsManagement.svelte) :
   * aucune traduction de nom entre la vue et la base.
   */
  reservationFallbackMode: TempVoiceReservationFallbackMode;
  /**
   * L'interrupteur de secours de la personnalisation par générateur, lu par
   * `presentationParGenerateurActive` (tempVoiceService.ts). Défaut `false` :
   * au déploiement, aucun serveur existant ne change de comportement. Le
   * couper IGNORE les surcharges des générateurs (`Guild.tempVoiceGenerators`),
   * il ne les EFFACE PAS.
   */
  perGeneratorPresentation: boolean;
  /**
   * Où se trouve la mention qui notifie le propriétaire à la création du salon
   * (panneau / message au-dessus / aucune). Défaut `panel`. Lu par le bot dans
   * cette même ligne que `panelMode`/`panelComponents`.
   */
  ownerMentionPlacement: TempVoiceOwnerMentionPlacement;
}

/** `@default` du modèle Prisma `TempVoiceAccessRequestConfig`. */
const TEMP_VOICE_ACCESS_REQUEST_DEFAULTS: TempVoiceAccessRequestConfigView = {
  enabled: false,
  responders: 'OWNER_AND_STAFF',
  notifyVia: 'VOICE',
  notifyChannelId: null,
  requestExpiresMinutes: 10,
  denyCooldownMinutes: 10,
};

/**
 * Embed Discord des changements vocaux faits depuis le dashboard, dans la langue
 * du serveur, par le chemin commun des logs (`voice_panel`). Un échec d'envoi ne
 * remonte jamais : l'enregistrement est déjà fait.
 */
async function envoyerEmbedReglagesVocaux(
  discordGuild: Guild | null | undefined,
  guildId: string,
  auditUser: string,
  diffDans: (langue: LangueDiff) => ChangementReglage[],
): Promise<void> {
  if (!discordGuild) return;
  try {
    const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
    const lignes = lignesDiffReglages(diffDans(locale));
    const embed = construireEmbedReglagesVocaux(lignes, auditUser, locale);
    if (!embed) return;
    await sendLogEmbed(discordGuild, embed, 'voice_panel', undefined, auditUser, [], {
      details: lignes.join('\n').slice(0, 4000),
      channelId: null,
    });
  } catch (err) {
    logger.warn('ChannelsManagementAPI', `Embed des réglages vocaux non envoyé (guilde ${guildId}) :`, err);
  }
}

/**
 * `@default` du modèle Prisma `TempVoiceModPermissionsConfig`.
 *
 * ATTENTION — SIX AUTRES COPIES de ces valeurs existent. Seules celles de la passation et
 * de la mention du propriétaire sont comparées (test « F » de
 * `channelsManagementVocal.test.ts`) — ajouter un réglage ou une valeur ici SEUL ne donne pas une
 * fonctionnalité à moitié livrée, ça donne un 400 à l'autre bout :
 *
 *  1. `packages/database/prisma/temp-voice-access.prisma` — les `@default(...)`
 *     du modèle et le commentaire qui liste les valeurs admises (colonnes
 *     `String`, sans enum : la base accepte n'importe quoi, elle n'arbitre pas).
 *  2. `apps/bot/src/services/features/tempVoiceService.ts` — `PRESENTATION_PAR_DEFAUT`
 *     et les listes `MODES_PANNEAU`/`DISPOSITIONS_ETAT`/`TEINTES_ETAT`/
 *     `JEUX_COMPOSANTS`/`REPLIS_RESERVATION` lues par
 *     `normaliserReglagesPresentation` : une valeur qu'elles ne connaissent pas
 *     retombe sur le défaut, le panneau rend autre chose que ce qui est écrit
 *     en base, et rien ne le signale.
 *  3. `apps/dashboard/src/lib/api/moderation.ts` — les unions littérales du type
 *     `tempVoiceModPermissions` : seul garde-fou de typage entre la page et
 *     cette route.
 *  4. `apps/dashboard/src/pages/ChannelsManagement.svelte` — les `<option>` des
 *     sélecteurs et les défauts de `config` : ce qu'un administrateur peut
 *     réellement choisir.
 *  5. `packages/shared/src/tempVoice/types.ts` — `TEMP_VOICE_OWNERSHIP_DEFAULTS`
 *     (passation) et `TEMP_VOICE_OWNER_MENTION_DEFAULT` : ce fichier, la page et
 *     le bot s'en servent, c'est la seule copie qu'on n'écrit pas deux fois.
 *  6. `apps/dashboard/src/lib/demo/generated/prismaDefaults.ts` — la démo, générée
 *     depuis le schéma par `bun scripts/demo-prisma-defaults.mjs` : la relancer
 *     après toute modification du schéma, ne jamais l'éditer à la main.
 *
 * Et dans CE fichier : les cinq listes `TEMP_VOICE_*` juste au-dessus, qui
 * décident du rejet 400 dans `normalizeTempVoiceModPermissionsInput`. Une
 * sixième valeur (ou un sixième réglage) ajoutée ici et nulle part ailleurs se
 * paie donc deux fois : la page ne la propose jamais, et si un appel API la
 * porte quand même, elle est écrite puis rendue au défaut par le bot. Dans le
 * sens inverse — proposée par la page, absente des listes `TEMP_VOICE_*` — la
 * page entière échoue en 400 au moment d'enregistrer.
 */
const TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS: TempVoiceModPermissionsConfigView = {
  canRename: true,
  canChangeLimit: true,
  canLock: true,
  canChangeWriteMode: true,
  canKickOrBan: true,
  canReserve: true,
  canTransfer: true,
  // Pas une permission : le comportement livré est l'éphémère multiple, donc
  // `false`, contrairement aux sept permissions ci-dessus qui valent `true`.
  panelCompactMode: false,
  reservableRoleIds: [],
  reservationOverflow: 'ASK',
  reservationFallbackChannelId: null,
  panelMode: 'CLASSIC',
  stateLayout: 'GRID3',
  stateColors: 'NEUTRAL',
  panelComponents: 'V2',
  reservationFallbackMode: 'ANY_ROLE',
  perGeneratorPresentation: false,
  ownerMentionPlacement: TEMP_VOICE_OWNER_MENTION_DEFAULT,
  ...TEMP_VOICE_OWNERSHIP_DEFAULTS,
};

/**
 * Ligne absente = jamais configuré : on rend les défauts du schéma pour que
 * la page affiche l'état réel plutôt que des cases vides (même contrat que
 * `normalizeTempVoicePolicy` pour `tempVoiceDefaults`, juste au-dessus dans ce
 * fichier).
 */
function viewTempVoiceAccessRequestConfig(
  row: {
    enabled: boolean;
    responders: string;
    notifyVia: string;
    notifyChannelId: string | null;
    requestExpiresMinutes: number;
    denyCooldownMinutes: number;
  } | null,
): TempVoiceAccessRequestConfigView {
  if (!row) return { ...TEMP_VOICE_ACCESS_REQUEST_DEFAULTS };
  return {
    enabled: row.enabled,
    responders: TEMP_VOICE_ACCESS_RESPONDERS.includes(row.responders as TempVoiceAccessResponders)
      ? (row.responders as TempVoiceAccessResponders)
      : TEMP_VOICE_ACCESS_REQUEST_DEFAULTS.responders,
    notifyVia: TEMP_VOICE_ACCESS_NOTIFY_VIA.includes(row.notifyVia as TempVoiceAccessNotifyVia)
      ? (row.notifyVia as TempVoiceAccessNotifyVia)
      : TEMP_VOICE_ACCESS_REQUEST_DEFAULTS.notifyVia,
    notifyChannelId: row.notifyChannelId,
    requestExpiresMinutes: row.requestExpiresMinutes,
    // Le bot lit 0 comme 1 minute ; la page doit montrer ce qui s'applique.
    denyCooldownMinutes: Math.max(MIN_DENY_COOLDOWN_MINUTES, row.denyCooldownMinutes),
  };
}

function viewTempVoiceModPermissionsConfig(
  row: {
    canRename: boolean;
    canChangeLimit: boolean;
    canLock: boolean;
    canChangeWriteMode: boolean;
    canKickOrBan: boolean;
    canReserve: boolean;
    canTransfer: boolean;
    panelCompactMode: boolean;
    reservableRoleIds: string[];
    reservationOverflow: string;
    reservationFallbackChannelId: string | null;
    panelMode: string;
    stateLayout: string;
    stateColors: string;
    panelComponents: string;
    reservationFallbackMode: string;
    perGeneratorPresentation: boolean;
    ownerMentionPlacement?: string;
    handoverDmEnabled: boolean;
    handoverDelaySeconds: number;
    claimEmbedEnabled: boolean;
    claimWho: string;
    moderatorClaimOverride: boolean;
    deleteWhenEmpty: boolean;
  } | null,
): TempVoiceModPermissionsConfigView {
  if (!row) return { ...TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS };
  return {
    canRename: row.canRename,
    canChangeLimit: row.canChangeLimit,
    canLock: row.canLock,
    canChangeWriteMode: row.canChangeWriteMode,
    canKickOrBan: row.canKickOrBan,
    canReserve: row.canReserve,
    canTransfer: row.canTransfer,
    panelCompactMode: row.panelCompactMode,
    reservableRoleIds: row.reservableRoleIds,
    reservationOverflow: TEMP_VOICE_RESERVATION_OVERFLOW.includes(row.reservationOverflow as TempVoiceReservationOverflow)
      ? (row.reservationOverflow as TempVoiceReservationOverflow)
      : TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS.reservationOverflow,
    reservationFallbackChannelId: row.reservationFallbackChannelId,
    panelMode: TEMP_VOICE_PANEL_MODE.includes(row.panelMode as TempVoicePanelMode)
      ? (row.panelMode as TempVoicePanelMode)
      : TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS.panelMode,
    stateLayout: TEMP_VOICE_STATE_LAYOUT.includes(row.stateLayout as TempVoiceStateLayout)
      ? (row.stateLayout as TempVoiceStateLayout)
      : TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS.stateLayout,
    stateColors: TEMP_VOICE_STATE_COLORS.includes(row.stateColors as TempVoiceStateColors)
      ? (row.stateColors as TempVoiceStateColors)
      : TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS.stateColors,
    panelComponents: TEMP_VOICE_PANEL_COMPONENTS.includes(row.panelComponents as TempVoicePanelComponents)
      ? (row.panelComponents as TempVoicePanelComponents)
      : TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS.panelComponents,
    reservationFallbackMode: TEMP_VOICE_RESERVATION_FALLBACK_MODE.includes(row.reservationFallbackMode as TempVoiceReservationFallbackMode)
      ? (row.reservationFallbackMode as TempVoiceReservationFallbackMode)
      : TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS.reservationFallbackMode,
    perGeneratorPresentation: row.perGeneratorPresentation === true,
    ownerMentionPlacement: TEMP_VOICE_OWNER_MENTION_PLACEMENTS.includes(row.ownerMentionPlacement as TempVoiceOwnerMentionPlacement)
      ? (row.ownerMentionPlacement as TempVoiceOwnerMentionPlacement)
      : TEMP_VOICE_OWNER_MENTION_DEFAULT,
    handoverDmEnabled: row.handoverDmEnabled,
    handoverDelaySeconds: row.handoverDelaySeconds,
    claimEmbedEnabled: row.claimEmbedEnabled,
    claimWho: TEMP_VOICE_CLAIM_WHO.includes(row.claimWho as TempVoiceClaimWho)
      ? (row.claimWho as TempVoiceClaimWho)
      : TEMP_VOICE_OWNERSHIP_DEFAULTS.claimWho,
    moderatorClaimOverride: row.moderatorClaimOverride,
    deleteWhenEmpty: row.deleteWhenEmpty,
  };
}

/**
 * Refus d'une requête : le texte français (`error`, repli) et un `code` stable
 * que le dashboard traduit (apps/dashboard/src/lib/api/errors.ts, clés
 * `api_err_tv_*`). `params` porte les valeurs que le message traduit insère.
 * Tout code posé ici doit avoir sa clé dans les deux fichiers de messages du
 * dashboard : un test le vérifie.
 */
export interface TvFailure {
  error: string;
  code: string;
  params?: Record<string, string | number>;
}

/** Réponse d'erreur de cette route : même forme partout, `code` toujours présent. */
function tvError(res: ModuleRouteContext['res'], status: number, failure: TvFailure | string, code?: string): void {
  json(res, status, typeof failure === 'string' ? { error: failure, code } : failure);
}

/** Valeur hors liste fermée. `expected` est la liste, séparée par « | ». */
function choiceFailure(label: string, key: string, value: unknown, allowed: readonly string[]): TvFailure {
  const expected = allowed.join(' | ');
  return {
    error: panelSettingError(label, key, value, expected),
    code: 'tv_setting_invalid_choice',
    params: { field: key, value: String(value).slice(0, 40), expected },
  };
}

/** Nombre entier hors bornes. `unit` : « minutes », « secondes ». */
function rangeFailure(label: string, key: string, value: unknown, unit: string, min: number, max: number): TvFailure {
  return {
    error: panelSettingError(label, key, value, `un nombre entier de ${unit}, de ${min} à ${max}`),
    code: 'tv_setting_invalid_range',
    params: { field: key, value: String(value).slice(0, 40), min, max },
  };
}

/** Borne basse de « silence après un refus » : le bot lit 0 comme 1 minute. */
const MIN_DENY_COOLDOWN_MINUTES = 1;

/**
 * Valide le payload entrant pour `tempVoiceAccessRequest`. Même esprit que la
 * validation de `honeypotSanction` un peu plus bas dans ce fichier : un champ
 * hors des valeurs admises rejette toute la requête plutôt que de descendre
 * une valeur inventée jusqu'à la base ou jusqu'à l'appel Discord.
 */
function normalizeTempVoiceAccessRequestInput(
  raw: unknown,
): { data: Partial<TempVoiceAccessRequestConfigView> } | TvFailure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // Français comme les autres messages de cette route : c'est le repli que la
    // page affiche quand le `code` n'a pas de traduction. `panelSettingError`
    // est déclarée plus bas dans le fichier — une déclaration de fonction,
    // donc hissée.
    return {
      error: 'tempVoiceAccessRequest : objet attendu. Rien n\'a été enregistré.',
      code: 'tv_object_expected',
      params: { field: 'tempVoiceAccessRequest' },
    };
  }
  const body = raw as Record<string, unknown>;
  const data: Partial<TempVoiceAccessRequestConfigView> = {};

  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
    data.enabled = body.enabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'responders')) {
    if (!TEMP_VOICE_ACCESS_RESPONDERS.includes(body.responders as TempVoiceAccessResponders)) {
      return choiceFailure('Répondants', 'responders', body.responders, TEMP_VOICE_ACCESS_RESPONDERS);
    }
    data.responders = body.responders as TempVoiceAccessResponders;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notifyVia')) {
    if (!TEMP_VOICE_ACCESS_NOTIFY_VIA.includes(body.notifyVia as TempVoiceAccessNotifyVia)) {
      return choiceFailure('Cible de notification', 'notifyVia', body.notifyVia, TEMP_VOICE_ACCESS_NOTIFY_VIA);
    }
    data.notifyVia = body.notifyVia as TempVoiceAccessNotifyVia;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notifyChannelId')) {
    const value = body.notifyChannelId;
    const id = typeof value === 'string' ? value.trim() : '';
    // Vide ou absent : pas de salon dédié. Une valeur qui n'est pas un
    // identifiant de salon est refusée plutôt qu'écrite telle quelle.
    if (value !== null && value !== undefined && value !== '' && !isPlausibleSnowflake(id)) {
      return snowflakeFailure('Salon dédié aux demandes', 'notifyChannelId', value);
    }
    data.notifyChannelId = id || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'requestExpiresMinutes')) {
    const n = Math.floor(Number(body.requestExpiresMinutes));
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      return rangeFailure('Expiration de la demande', 'requestExpiresMinutes', body.requestExpiresMinutes, 'minutes', 1, 1440);
    }
    data.requestExpiresMinutes = n;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'denyCooldownMinutes')) {
    const n = Math.floor(Number(body.denyCooldownMinutes));
    // Pas de 0 : le bot lit 0 comme 1 minute, la page afficherait donc un délai
    // que personne n'applique.
    if (!Number.isFinite(n) || n < MIN_DENY_COOLDOWN_MINUTES || n > 1440) {
      return rangeFailure('Délai après un refus', 'denyCooldownMinutes', body.denyCooldownMinutes, 'minutes', MIN_DENY_COOLDOWN_MINUTES, 1440);
    }
    data.denyCooldownMinutes = n;
  }

  return { data };
}

/**
 * Identifiant Discord plausible. Même borne que `isSnowflake` (non exportée)
 * dans `tempVoiceService.ts` : un salon/rôle réel s'y conforme toujours, une
 * valeur inventée dans le corps de la requête ne passe pas.
 */
function isPlausibleSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function snowflakeFailure(label: string, key: string, value: unknown): TvFailure {
  return {
    error: `${label} (${key}) : « ${String(value).slice(0, 40)} » n'est pas un identifiant Discord valide. Rien n'a été enregistré.`,
    code: 'tv_snowflake_invalid',
    params: { field: key, value: String(value).slice(0, 40) },
  };
}

/** `null`, absent ou vide valent « aucun » ; sinon un identifiant Discord plausible. */
function readOptionalSnowflake(value: unknown, label: string, key: string): { value: string | null } | TvFailure {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value === 'string' && isPlausibleSnowflake(value.trim())) return { value: value.trim() };
  return snowflakeFailure(label, key, value);
}

/**
 * Message de refus d'un réglage à valeur imposée : les cinq réglages de
 * présentation du panneau, et les champs à liste fermée ou à bornes de
 * `tempVoiceAccessRequest`. Il nomme le champ, la valeur refusée et le fait que
 * rien n'a été enregistré : ces champs voyagent dans le même PATCH que toute la
 * page (autoThread, stats, honeypot), donc un refus annule aussi leur
 * enregistrement. Sans la valeur dans le message, un dashboard plus récent que
 * le bot ferait échouer la page sur une cause illisible.
 *
 * Rédigé en français, comme les autres messages d'erreur des routes du
 * dashboard : la page affiche `res.error` tel quel (`handleSave`).
 *
 * `expected` borne la valeur attendue quand la liste n'est pas fermée (un
 * nombre dans un intervalle). La valeur reçue est tronquée à 40 caractères :
 * elle vient du corps de la requête, donc d'un appelant qui peut y mettre
 * n'importe quelle longueur.
 */
function panelSettingError(label: string, key: string, value: unknown, expected?: string): string {
  const seen = typeof value === 'string' ? value : String(value);
  const suffix = expected ? ` (attendu : ${expected})` : '';
  return `${label} (${key}) : « ${seen.slice(0, 40)} » n'est pas une valeur valide${suffix}. Rien n'a été enregistré.`;
}

/**
 * Valide le payload entrant pour `tempVoiceModPermissions`. Trois régimes,
 * volontairement différents, parce que ce qu'une valeur invalide coûte n'est
 * pas le même selon le champ :
 *
 *  - les sept permissions et `panelCompactMode` — booléens, `!== true` vaut
 *    `false` ;
 *  - `reservableRoleIds`, `reservationOverflow`, `reservationFallbackChannelId`
 *    — SANITISÉS : une valeur hors liste retombe sur un défaut sûr, jamais sur
 *    une valeur qui agit (pas de déplacement ni de déconnexion que personne
 *    n'a choisis), plutôt que de rejeter tout le PATCH pour un champ optionnel ;
 *  - `panelMode`, `stateLayout`, `stateColors`, `panelComponents`,
 *    `reservationFallbackMode` — REJETÉS : une valeur hors union renvoie
 *    `{ error }`, donc un 400, donc AUCUNE écriture. Divergence assumée avec
 *    le régime précédent : ces cinq champs ne décident d'aucune action, ils
 *    décident de l'apparence du panneau. Les rabattre en silence sur le défaut
 *    se lirait comme un réglage qui ne s'enregistre pas — l'administrateur
 *    choisit `FLAT`, la page annonce « enregistré », le panneau reste
 *    `CLASSIC`, et rien ne le signale. Le message nomme le champ ET la valeur
 *    refusée (`panelSettingError`).
 *
 * La vue, la colonne Prisma et le dashboard nomment tous le cinquième champ
 * `reservationFallbackMode` — c'est ce nom que le spread `create:` de l'upsert
 * envoie à Prisma, un alias dans la vue ferait écrire une colonne inconnue.
 * L'ancien nom `reservationFallback` est accepté ici, et ici seulement, puis
 * traduit vers la colonne : sans ça une requête qui le porte serait ignorée en
 * silence.
 *
 * Exportée : un test unitaire l'appelle directement.
 */
export function normalizeTempVoiceModPermissionsInput(
  raw: unknown,
): { data: Partial<TempVoiceModPermissionsConfigView> } | TvFailure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      error: 'tempVoiceModPermissions : objet attendu. Rien n\'a été enregistré.',
      code: 'tv_object_expected',
      params: { field: 'tempVoiceModPermissions' },
    };
  }
  const body = raw as Record<string, unknown>;
  const data: Partial<TempVoiceModPermissionsConfigView> = {};
  // Type resserré aux seules clés booléennes : `keyof TempVoiceModPermissionsConfigView`
  // couvre aussi `reservableRoleIds`/`reservationOverflow`/`reservationFallbackChannelId`
  // depuis leur ajout, et écrire via une clé union dont les types de valeur
  // divergent (boolean vs string[] vs string|null) fait échouer le typecheck.
  const boolKeys: Array<
    | 'canRename'
    | 'canChangeLimit'
    | 'canLock'
    | 'canChangeWriteMode'
    | 'canKickOrBan'
    | 'canReserve'
    | 'canTransfer'
    | 'panelCompactMode'
    | 'perGeneratorPresentation'
    | 'handoverDmEnabled'
    | 'claimEmbedEnabled'
    | 'moderatorClaimOverride'
    | 'deleteWhenEmpty'
  > = [
    'canRename',
    'canChangeLimit',
    'canLock',
    'canChangeWriteMode',
    'canKickOrBan',
    'canReserve',
    'canTransfer',
    'panelCompactMode',
    // Interrupteur de secours : régime booléen comme `panelCompactMode`
    // au-dessus, pas régime REJET comme les cinq réglages de présentation
    // ci-dessous — une valeur qui n'est pas `true` vaut `false`, jamais un 400.
    'perGeneratorPresentation',
    // Les quatre interrupteurs de la passation, même régime booléen.
    'handoverDmEnabled',
    'claimEmbedEnabled',
    'moderatorClaimOverride',
    'deleteWhenEmpty',
  ];
  for (const key of boolKeys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      data[key] = body[key] === true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'reservableRoleIds')) {
    // Pas d'erreur 400 sur un tableau malformé : comme `normalizeRoleIds`
    // (tempVoiceService.ts) pour `autoAllowRoleIds`, on sanitise plutôt que
    // de rejeter tout le PATCH pour un seul champ optionnel.
    const value = body.reservableRoleIds;
    const ids = Array.isArray(value) ? value.filter(isPlausibleSnowflake) : [];
    data.reservableRoleIds = [...new Set(ids)].slice(0, MAX_RESERVABLE_ROLES);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'reservationOverflow')) {
    // Une valeur inconnue retombe sur `ASK`, jamais sur une valeur qui agit :
    // une entrée invalide ne doit jamais se traduire par un déplacement ou
    // une déconnexion que personne n'a choisis.
    data.reservationOverflow = TEMP_VOICE_RESERVATION_OVERFLOW.includes(
      body.reservationOverflow as TempVoiceReservationOverflow,
    )
      ? (body.reservationOverflow as TempVoiceReservationOverflow)
      : 'ASK';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'reservationFallbackChannelId')) {
    const value = body.reservationFallbackChannelId;
    const id = typeof value === 'string' ? value.trim() : '';
    if (value !== null && value !== undefined && value !== '' && !isPlausibleSnowflake(id)) {
      return snowflakeFailure('Salon de repli', 'reservationFallbackChannelId', value);
    }
    data.reservationFallbackChannelId = id || null;
  }

  // Cinq réglages de présentation du panneau, régime REJET — le pourquoi est
  // au-dessus de la fonction, avec la divergence assumée face aux champs
  // sanitisés juste ci-dessus. Cinq blocs explicites plutôt qu'une table :
  // c'est la forme déjà tenue par tout ce fichier, et écrire dans `data` par
  // une clé union dont les types de valeur divergent casse le typecheck (même
  // piège que `boolKeys`).
  if (Object.prototype.hasOwnProperty.call(body, 'panelMode')) {
    if (!TEMP_VOICE_PANEL_MODE.includes(body.panelMode as TempVoicePanelMode)) {
      return choiceFailure('Mode du panneau', 'panelMode', body.panelMode, TEMP_VOICE_PANEL_MODE);
    }
    data.panelMode = body.panelMode as TempVoicePanelMode;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'stateLayout')) {
    if (!TEMP_VOICE_STATE_LAYOUT.includes(body.stateLayout as TempVoiceStateLayout)) {
      return choiceFailure('Disposition des états', 'stateLayout', body.stateLayout, TEMP_VOICE_STATE_LAYOUT);
    }
    data.stateLayout = body.stateLayout as TempVoiceStateLayout;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'stateColors')) {
    if (!TEMP_VOICE_STATE_COLORS.includes(body.stateColors as TempVoiceStateColors)) {
      return choiceFailure('Palette des états', 'stateColors', body.stateColors, TEMP_VOICE_STATE_COLORS);
    }
    data.stateColors = body.stateColors as TempVoiceStateColors;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'panelComponents')) {
    if (!TEMP_VOICE_PANEL_COMPONENTS.includes(body.panelComponents as TempVoicePanelComponents)) {
      return choiceFailure('Composants du panneau', 'panelComponents', body.panelComponents, TEMP_VOICE_PANEL_COMPONENTS);
    }
    data.panelComponents = body.panelComponents as TempVoicePanelComponents;
  }
  // Seul endroit où `reservationFallback` (ancien nom) est traduit vers la
  // colonne `reservationFallbackMode`. Le nom canonique gagne s'il est présent.
  const fallbackKey = Object.prototype.hasOwnProperty.call(body, 'reservationFallbackMode')
    ? 'reservationFallbackMode'
    : 'reservationFallback';
  if (Object.prototype.hasOwnProperty.call(body, fallbackKey)) {
    const value = body[fallbackKey];
    if (!TEMP_VOICE_RESERVATION_FALLBACK_MODE.includes(value as TempVoiceReservationFallbackMode)) {
      return choiceFailure('Repli de la réservation', fallbackKey, value, TEMP_VOICE_RESERVATION_FALLBACK_MODE);
    }
    data.reservationFallbackMode = value as TempVoiceReservationFallbackMode;
  }

  // Passation : même régime REJET que la présentation — un délai ou un choix
  // ramené en silence sur le défaut se lirait comme un réglage perdu.
  if (Object.prototype.hasOwnProperty.call(body, 'claimWho')) {
    if (!TEMP_VOICE_CLAIM_WHO.includes(body.claimWho as TempVoiceClaimWho)) {
      return choiceFailure('Qui peut récupérer le salon', 'claimWho', body.claimWho, TEMP_VOICE_CLAIM_WHO);
    }
    data.claimWho = body.claimWho as TempVoiceClaimWho;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'handoverDelaySeconds')) {
    const { min, max } = TEMP_VOICE_HANDOVER_DELAY_BOUNDS;
    const n = body.handoverDelaySeconds;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      return rangeFailure('Délai de passation', 'handoverDelaySeconds', n, 'secondes', min, max);
    }
    data.handoverDelaySeconds = n;
  }

  // Mention du propriétaire : même régime REJET — une valeur hors liste
  // ramenée en silence sur `panel` se lirait comme un réglage qui ne s'enregistre pas.
  if (Object.prototype.hasOwnProperty.call(body, 'ownerMentionPlacement')) {
    if (!TEMP_VOICE_OWNER_MENTION_PLACEMENTS.includes(body.ownerMentionPlacement as TempVoiceOwnerMentionPlacement)) {
      return choiceFailure('Mention du propriétaire', 'ownerMentionPlacement', body.ownerMentionPlacement, TEMP_VOICE_OWNER_MENTION_PLACEMENTS);
    }
    data.ownerMentionPlacement = body.ownerMentionPlacement as TempVoiceOwnerMentionPlacement;
  }

  return { data };
}

/**
 * Valide les surcharges de présentation portées par CHAQUE générateur
 * (`tempVoiceGenerators[i].panelMode`/`stateLayout`/`stateColors`/
 * `panelComponents`/`reservationFallbackMode`), AVANT
 * `normalizeTempVoiceGeneratorsInput` (tempVoiceService.ts).
 *
 * Ce dernier les lit avec `lireSurchargesPresentation`, qui traite une valeur
 * hors énumération comme ABSENTE plutôt que comme une erreur — le bon choix
 * pour le RENDU d'un salon existant (un réglage fautif ne doit jamais
 * empêcher un panneau de sortir), le mauvais choix pour l'ÉCRITURE depuis le
 * dashboard : un administrateur qui choisit une valeur invalide croirait
 * l'avoir enregistrée alors qu'elle a été silencieusement ignorée — exactement
 * le bug que `panelSettingError` existe pour éviter au niveau serveur.
 *
 * Donc deux régimes différents pour la même donnée selon le sens : tolérant
 * en lecture (tempVoiceService.ts), REJETÉ ici en écriture. `null` et absent
 * valent tous deux « hérite du serveur » et ne sont jamais rejetés — seule une
 * valeur PRÉSENTE et hors énumération l'est.
 */
function validateGeneratorPresentationOverrides(raw: unknown): TvFailure | null {
  if (!Array.isArray(raw)) return null;

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const body = entry as Record<string, unknown>;
    const prefix = `Générateur n°${i + 1}`;

    if (
      Object.prototype.hasOwnProperty.call(body, 'panelMode') && body.panelMode != null
      && !TEMP_VOICE_PANEL_MODE.includes(body.panelMode as TempVoicePanelMode)
    ) {
      return choiceFailure(`${prefix} : mode du panneau`, 'panelMode', body.panelMode, TEMP_VOICE_PANEL_MODE);
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'stateLayout') && body.stateLayout != null
      && !TEMP_VOICE_STATE_LAYOUT.includes(body.stateLayout as TempVoiceStateLayout)
    ) {
      return choiceFailure(`${prefix} : disposition des états`, 'stateLayout', body.stateLayout, TEMP_VOICE_STATE_LAYOUT);
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'stateColors') && body.stateColors != null
      && !TEMP_VOICE_STATE_COLORS.includes(body.stateColors as TempVoiceStateColors)
    ) {
      return choiceFailure(`${prefix} : palette des états`, 'stateColors', body.stateColors, TEMP_VOICE_STATE_COLORS);
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'panelComponents') && body.panelComponents != null
      && !TEMP_VOICE_PANEL_COMPONENTS.includes(body.panelComponents as TempVoicePanelComponents)
    ) {
      return choiceFailure(`${prefix} : composants du panneau`, 'panelComponents', body.panelComponents, TEMP_VOICE_PANEL_COMPONENTS);
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'reservationFallbackMode') && body.reservationFallbackMode != null
      && !TEMP_VOICE_RESERVATION_FALLBACK_MODE.includes(body.reservationFallbackMode as TempVoiceReservationFallbackMode)
    ) {
      return choiceFailure(
        `${prefix} : repli de la réservation`,
        'reservationFallbackMode',
        body.reservationFallbackMode,
        TEMP_VOICE_RESERVATION_FALLBACK_MODE,
      );
    }
  }

  return null;
}

/** Clés du PATCH qui relèvent des salons vocaux temporaires (journal des changements). */
const VOICE_KEYS = [
  'tempVoiceEnabled',
  'tempVoiceChannelId',
  'tempVoiceCategoryId',
  'tempVoiceNameTemplate',
  'tempVoiceRequiredRoleId',
  'tempVoiceDefaults',
  'tempVoiceGenerators',
  'tempVoiceAccessRequest',
  'tempVoiceModPermissions',
] as const;

/** Clés du PATCH hors vocal qui s'écrivent dans `Guild` : la ligne générique du journal en dépend. */
const CLES_NON_VOCALES = [
  'autoThreadEnabled',
  'autoThreadChannels',
  'autoThreadBotsEnabled',
  'statsEnabled',
  'statsConfig',
  'honeypotEnabled',
  'honeypotChannelId',
  'honeypotSanction',
  'honeypotReinvite',
  'honeypotGraceSeconds',
  'honeypotDurationMin',
  'wordStatsEnabled',
] as const;

interface VoiceGuildRow {
  tempVoiceEnabled?: boolean;
  tempVoiceChannelId?: string | null;
  tempVoiceCategoryId?: string | null;
  tempVoiceNameTemplate?: string | null;
  tempVoiceRequiredRoleId?: string | null;
  tempVoiceDefaults?: unknown;
  tempVoiceGenerators?: unknown;
}

/**
 * État des réglages vocaux tel que `diffReglagesVocaux` le compare : politique
 * et générateurs normalisés comme à la lecture, les deux tables à leurs défauts
 * quand la ligne n'existe pas. `guild` absent (serveur jamais enregistré) donne
 * les défauts, pas un état vide.
 */
export function snapshotReglagesVocaux(
  guildId: string,
  guild: VoiceGuildRow | null | undefined,
  accessRow: Parameters<typeof viewTempVoiceAccessRequestConfig>[0],
  modRow: Parameters<typeof viewTempVoiceModPermissionsConfig>[0],
): ReglagesVocaux {
  return {
    tempVoiceEnabled: guild?.tempVoiceEnabled ?? false,
    tempVoiceChannelId: guild?.tempVoiceChannelId ?? null,
    tempVoiceCategoryId: guild?.tempVoiceCategoryId ?? null,
    tempVoiceNameTemplate: guild?.tempVoiceNameTemplate ?? '',
    tempVoiceRequiredRoleId: guild?.tempVoiceRequiredRoleId ?? null,
    tempVoiceDefaults: normalizeTempVoicePolicy(guild?.tempVoiceDefaults, guildId),
    tempVoiceGenerators: normalizeTempVoiceGeneratorsInput(guild?.tempVoiceGenerators, guildId, guild?.tempVoiceChannelId),
    tempVoiceModPermissions: viewTempVoiceModPermissionsConfig(modRow),
    tempVoiceAccessRequest: viewTempVoiceAccessRequestConfig(accessRow),
  };
}

/**
 * Un avis de l'enregistrement : `code` et `params` pour que le dashboard le dise
 * dans sa langue, `message` (français) en repli pour un code qu'il ne connaît pas.
 */
export interface NoticeVocale {
  code: string;
  params: Record<string, string | number>;
  message: string;
}

function avisVocal(code: string, params: Record<string, string | number>, message: string): NoticeVocale {
  return { code, params, message };
}

/**
 * Entrées de `tempVoiceGenerators` que la normalisation du serveur a écartées
 * (salon absent, déjà pris par le principal ou par un autre générateur, plafond
 * dépassé), dites en français. Sans cela la page remplaçait sa liste par celle
 * du serveur et la carte disparaissait sans un mot. Le numéro est celui que la
 * page affiche (le principal est le n°1).
 */
export function explainDroppedGenerators(
  input: unknown,
  kept: ReadonlyArray<{ channelId: string }>,
  mainChannelId?: string | null,
  nomSalon: (id: string) => string | undefined = () => undefined,
): NoticeVocale[] {
  if (!Array.isArray(input)) return [];
  const keptIds = new Set(kept.map((g) => g.channelId));
  const firstSeen = new Map<string, number>();
  const notices: NoticeVocale[] = [];
  input.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const n = index + 2;
    const id = (entry as Record<string, unknown>).channelId;
    if (index >= MAX_ADDITIONAL_GENERATORS) {
      notices.push(avisVocal('notice_tv_generator_cap', { n, max: MAX_ADDITIONAL_GENERATORS },
        `Le générateur n°${n} n'a pas été enregistré : le plafond de ${MAX_ADDITIONAL_GENERATORS} générateurs additionnels est atteint.`));
      return;
    }
    if (!isPlausibleSnowflake(id)) {
      notices.push(avisVocal('notice_tv_generator_no_channel', { n }, `Le générateur n°${n} n'a pas été enregistré : aucun salon vocal valide n'est choisi.`));
      return;
    }
    const name = nomSalon(id) ? `#${nomSalon(id)}` : id;
    const first = firstSeen.get(id);
    if (first !== undefined) {
      notices.push(avisVocal('notice_tv_generator_duplicate', { n, name, first },
        `Le générateur n°${n} n'a pas été enregistré : ${name} est déjà utilisé par le générateur n°${first}.`));
      return;
    }
    if (!keptIds.has(id)) {
      notices.push(
        id === mainChannelId
          ? avisVocal('notice_tv_generator_is_main', { n, name }, `Le générateur n°${n} n'a pas été enregistré : ${name} est déjà le générateur principal.`)
          : avisVocal('notice_tv_generator_not_kept', { n, name }, `Le générateur n°${n} n'a pas été enregistré : ${name} n'a pas été retenu par le serveur.`),
      );
      return;
    }
    firstSeen.set(id, n);
  });
  return notices;
}

export async function handleChannelsManagementRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, moduleKey } = ctx;

  // GET /api/dashboard/guilds/:guildId/channels-management/by-channel
  //
  // Renvoie la liste des salons du serveur avec, pour chacun, les
  // fonctionnalites qui y sont actives. La page les reglait auparavant module
  // par module : savoir ce qui touchait un salon donne demandait de parcourir
  // cinq onglets.
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'by-channel' && method === 'GET') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        tvError(res, 404, 'Serveur Discord introuvable', 'tv_guild_not_found');
        return true;
      }
      if (guild.channels.cache.size === 0) await guild.channels.fetch().catch(() => null);

      const [config, stickies, tempVoiceGenerators] = await Promise.all([
        prisma.guild.findUnique({ where: { id: guildId }, select: CHANNEL_FEATURE_SELECT }),
        prisma.stickyMessage.findMany({ where: { guildId }, select: { channelId: true, enabled: true } }),
        prisma.guild
          .findUnique({ where: { id: guildId }, select: { tempVoiceGenerators: true, tempVoiceChannelId: true } })
          .then((g) => {
            const raw = Array.isArray(g?.tempVoiceGenerators) ? (g!.tempVoiceGenerators as unknown[]) : [];
            const ids = raw
              .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).channelId : null))
              .filter((id): id is string => typeof id === 'string');
            // Le generateur historique vit dans son propre champ : sans lui, un
            // serveur configure avant les generateurs multiples verrait le sien
            // disparaitre de la vue.
            if (g?.tempVoiceChannelId) ids.push(g.tempVoiceChannelId);
            return new Set(ids);
          }),
      ]);

      const stickyByChannel = new Map(stickies.map((s) => [s.channelId, s.enabled]));
      const record = (config ?? {}) as Record<string, unknown>;

      const featuresFor = (channelId: string) => {
        const active: string[] = [];
        for (const key of CHANNEL_FEATURE_KEYS) {
          const { kind, field } = CHANNEL_FEATURES[key];
          const value = record[field];
          const on = kind === 'list'
            ? Array.isArray(value) && (value as string[]).includes(channelId)
            : value === channelId;
          if (on) active.push(key);
        }
        if (stickyByChannel.has(channelId)) active.push('sticky');
        if (tempVoiceGenerators.has(channelId)) active.push('tempVoiceGenerator');
        return active;
      };

      const channels = Array.from(guild.channels.cache.values())
        .filter((ch) => ch.type !== ChannelType.GuildCategory && !ch.isThread())
        .map((ch) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
            ? 'voice'
            : ch.type === ChannelType.GuildForum ? 'forum' : 'text',
          categoryId: ch.parentId,
          categoryName: ch.parent?.name ?? null,
          position: 'rawPosition' in ch ? ch.rawPosition : 0,
          // `manageable` dit si le bot peut renommer ou supprimer ce salon : la
          // page grise les actions plutot que de les laisser echouer au clic.
          manageable: 'manageable' in ch ? ch.manageable : false,
          features: featuresFor(ch.id),
        }))
        .sort((a, b) => (a.categoryName ?? '').localeCompare(b.categoryName ?? '') || a.position - b.position);

      json(res, 200, {
        channels,
        features: Object.fromEntries(CHANNEL_FEATURE_KEYS.map((k) => [k, CHANNEL_FEATURES[k].label])),
      });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur GET by-channel:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des salons', 'ChannelsManagementAPI');
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channels-management/by-channel/:channelId
  // { feature, enabled }
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'by-channel' && method === 'PATCH') {
    try {
      const channelId = parts[6];
      const body = await readJsonBody<{ feature?: string; enabled?: boolean }>(req);
      const feature = body?.feature as ChannelFeatureKey | undefined;

      if (!feature || !CHANNEL_FEATURE_KEYS.includes(feature)) {
        tvError(res, 400, 'Fonctionnalité inconnue', 'tv_feature_unknown');
        return true;
      }

      const { kind, field, label } = CHANNEL_FEATURES[feature];
      const enabled = body?.enabled === true;

      if (feature === 'autoThread') {
        // Les fils automatiques vivent dans leurs configurations ; la liste de
        // la guilde n'en est que le miroir, recalcule par le service.
        const { setAutoThreadChannel } = await import('../../../../services/features/autoThreadService.js');
        await setAutoThreadChannel(guildId, channelId, enabled);
      } else if (kind === 'single') {
        // Un champ unique ne se « decoche » pas ailleurs : eteindre revient a
        // vider le champ, et l'allumer deplace la fonctionnalite sur ce salon.
        await prisma.guild.update({
          where: { id: guildId },
          data: { [field]: enabled ? channelId : null },
        });
      } else {
        const current = await prisma.guild.findUnique({ where: { id: guildId }, select: { [field]: true } });
        const list = Array.isArray((current as Record<string, unknown> | null)?.[field])
          ? ((current as Record<string, unknown>)[field] as string[])
          : [];
        const next = enabled
          ? Array.from(new Set([...list, channelId]))
          : list.filter((id) => id !== channelId);
        await prisma.guild.update({ where: { id: guildId }, data: { [field]: next } });
      }

      await pushAudit(guildId, {
        channelId,
        user: auditUser,
        action: `${enabled ? 'Activation' : 'Désactivation'} : ${label}`,
        context: getGuildName(client, guildId),
        module: 'Salons',
        eventType: 'Settings',
        details: `Salon ${channelId} · ${label} ${enabled ? 'activé' : 'désactivé'}`,
      });

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur PATCH by-channel:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour du salon', 'ChannelsManagementAPI');
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channels-management/channel/:channelId
  // { name } - renomme le salon Discord
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'channel' && method === 'PATCH') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      const channel = await guild?.channels.fetch(parts[6]).catch(() => null);
      if (!guild || !channel) {
        tvError(res, 404, 'Salon introuvable', 'tv_channel_not_found');
        return true;
      }
      if (!channel.manageable) {
        tvError(res, 403, 'Le bot ne peut pas modifier ce salon (permissions ou hiérarchie).', 'tv_channel_not_editable');
        return true;
      }

      const body = await readJsonBody<{ name?: string }>(req);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : '';
      if (!name) {
        tvError(res, 400, 'Nom de salon invalide', 'tv_channel_name_invalid');
        return true;
      }

      const previous = channel.name;
      await channel.setName(name, `Renommé depuis le dashboard par ${auditUser}`);

      await pushAudit(guildId, {
        channelId: channel.id,
        user: auditUser,
        action: 'Renommage de salon',
        context: getGuildName(client, guildId),
        module: 'Salons',
        eventType: 'Manuel',
        details: `#${previous} → #${name}`,
      });

      json(res, 200, { success: true, name });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur PATCH channel:', err);
      jsonFailure(res, err, 'Erreur lors du renommage du salon', 'ChannelsManagementAPI');
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/channels-management/channel/:channelId
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'channel' && method === 'DELETE') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      const channel = await guild?.channels.fetch(parts[6]).catch(() => null);
      if (!guild || !channel) {
        tvError(res, 404, 'Salon introuvable', 'tv_channel_not_found');
        return true;
      }
      if (!channel.manageable) {
        tvError(res, 403, 'Le bot ne peut pas supprimer ce salon (permissions ou hiérarchie).', 'tv_channel_not_deletable');
        return true;
      }

      const name = channel.name;
      await channel.delete(`Supprimé depuis le dashboard par ${auditUser}`);

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: 'Suppression de salon',
        context: getGuildName(client, guildId),
        module: 'Salons',
        eventType: 'Manuel',
        details: `#${name} (${parts[6]})`,
      });

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur DELETE channel:', err);
      jsonFailure(res, err, 'Erreur lors de la suppression du salon', 'ChannelsManagementAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channels-management/rescan-stats
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'rescan-stats' && method === 'POST') {
    try {
      const body = await readJsonBody<{ force?: boolean; forcer?: boolean }>(req);
      const force = !!(body?.force || body?.forcer);

      const { startHistoricalScraping } = await import('../../../../services/analytics/messageScraperService.js');
      await startHistoricalScraping(client, guildId, force);

      json(res, 200, { ok: true, message: 'Scraping historique lancé avec succès.' });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'POST rescan-stats error:', err);
      jsonFailure(res, err, 'Erreur lors du lancement du scraping', 'ChannelsManagementAPI');
    }
    return true;
  }

  // ── Sticky bot ─────────────────────────────────────────────────────────────
  // GET /api/dashboard/guilds/:guildId/channels-management/sticky
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'sticky' && method === 'GET') {
    try {
      const stickies = await prisma.stickyMessage.findMany({
        where: { guildId },
        orderBy: { createdAt: 'asc' },
        omit: { webhookToken: true },
      });
      json(res, 200, { stickies });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'GET sticky error:', err);
      jsonFailure(res, err, 'Erreur lors du chargement des messages sticky', 'ChannelsManagementAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channels-management/sticky (upsert par salon)
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'sticky' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        channelId?: string;
        enabled?: boolean;
        content?: string;
        embedEnabled?: boolean;
        embedTitle?: string | null;
        embedColor?: string;
        messageThreshold?: number;
        cooldownSeconds?: number;
        idleRepostMinutes?: number;
        jsonEnabled?: boolean;
        jsonPayload?: string | null;
        webhookEnabled?: boolean;
        webhookName?: string | null;
        webhookAvatarUrl?: string | null;
      }>(req);

      const channelId = (body?.channelId || '').trim();
      if (!channelId) {
        tvError(res, 400, 'Salon manquant', 'tv_sticky_channel_missing');
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId);
      const channel = discordGuild?.channels.cache.get(channelId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        tvError(res, 400, 'Salon textuel introuvable sur ce serveur', 'tv_sticky_channel_invalid');
        return true;
      }

      const { parseStickyJsonPayload, STICKY_JSON_MAX_LENGTH } =
        await import('../../../../services/features/stickyMessageService.js');

      const content = (body?.content ?? '').slice(0, 2000);
      const jsonEnabled = !!body?.jsonEnabled;
      const jsonPayload = typeof body?.jsonPayload === 'string' ? body.jsonPayload.slice(0, STICKY_JSON_MAX_LENGTH) : '';
      if (jsonEnabled) {
        const parsed = parseStickyJsonPayload(jsonPayload);
        if (!parsed.ok) {
          tvError(res, 400, { error: parsed.error, code: 'tv_sticky_json_invalid', params: { detail: parsed.error } });
          return true;
        }
      } else if (!content.trim()) {
        tvError(res, 400, 'Le message sticky ne peut pas être vide', 'tv_sticky_empty');
        return true;
      }

      // Discord refuse un nom de webhook qui contient « discord » ou « clyde ».
      const webhookEnabled = !!body?.webhookEnabled;
      const webhookName = (body?.webhookName ?? '').trim().slice(0, 80) || null;
      if (webhookName && /discord|clyde/i.test(webhookName)) {
        tvError(res, 400, 'Le nom du webhook ne peut pas contenir « discord » ni « clyde ».', 'tv_sticky_webhook_name');
        return true;
      }
      const avatarRaw = (body?.webhookAvatarUrl ?? '').trim();
      if (avatarRaw && (!/^https:\/\/\S+$/i.test(avatarRaw) || avatarRaw.length > 512)) {
        tvError(res, 400, 'L’avatar doit être une adresse https (512 caractères au maximum).', 'tv_sticky_avatar_invalid');
        return true;
      }
      const webhookAvatarUrl = avatarRaw || null;

      const threshold = Math.min(200, Math.max(1, Math.floor(Number(body?.messageThreshold ?? 5) || 5)));
      const cooldown = Math.min(3600, Math.max(0, Math.floor(Number(body?.cooldownSeconds ?? 10) || 0)));
      // Une semaine au plus : setTimeout plafonne vers 24 jours.
      const idleRepostMinutes = Math.min(10080, Math.max(0, Math.floor(Number(body?.idleRepostMinutes ?? 0) || 0)));
      const embedColor = /^#[0-9a-fA-F]{6}$/.test(body?.embedColor ?? '') ? body!.embedColor! : '#5865F2';

      const payload = {
        enabled: body?.enabled ?? true,
        content,
        embedEnabled: !!body?.embedEnabled,
        embedTitle: (body?.embedTitle || '').slice(0, 256) || null,
        embedColor,
        messageThreshold: threshold,
        cooldownSeconds: cooldown,
        idleRepostMinutes,
        jsonEnabled,
        jsonPayload: jsonPayload || null,
        webhookEnabled,
        webhookName,
        webhookAvatarUrl,
      };

      const previous = await prisma.stickyMessage.findUnique({
        where: { guildId_channelId: { guildId, channelId } },
      });

      const sticky = await prisma.stickyMessage.upsert({
        where: { guildId_channelId: { guildId, channelId } },
        create: { guildId, channelId, ...payload },
        update: payload,
      });

      const { clearStickyMessage, deleteStickyWebhook, invalidateStickyCache, repostSticky, resetStickyCounter } =
        await import('../../../../services/features/stickyMessageService.js');

      // Retour à l'identité du bot : le message affiché appartient au webhook,
      // que seul le webhook peut retirer. On le retire, puis le webhook.
      let current = sticky;
      if (previous?.webhookEnabled && !sticky.webhookEnabled) {
        await clearStickyMessage(client, previous);
        await deleteStickyWebhook(previous);
        current = await prisma.stickyMessage.update({
          where: { id: sticky.id },
          data: { lastMessageId: null, webhookId: null, webhookToken: null },
        });
      }

      await invalidateStickyCache(guildId);
      resetStickyCounter(channelId);

      if (!current.enabled) {
        // Désactivation : on retire le message encore affiché.
        await clearStickyMessage(client, current);
        await prisma.stickyMessage.update({
          where: { id: current.id },
          data: { lastMessageId: null },
        }).catch(() => null);
        await invalidateStickyCache(guildId);
      } else {
        // Publication immédiate : sans ça, rien n'apparaît avant le prochain
        // franchissement de seuil, ce qui donne l'impression d'un module cassé.
        const contentChanged = !previous
          || previous.content !== current.content
          || previous.embedEnabled !== current.embedEnabled
          || previous.embedTitle !== current.embedTitle
          || previous.embedColor !== current.embedColor
          || previous.jsonEnabled !== current.jsonEnabled
          || previous.jsonPayload !== current.jsonPayload
          || previous.webhookEnabled !== current.webhookEnabled
          || previous.webhookName !== current.webhookName
          || previous.webhookAvatarUrl !== current.webhookAvatarUrl
          || !previous.enabled;
        if (contentChanged) await repostSticky(client, current, { force: true });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: `Configuration du sticky de #${channel.name}`,
        context: getGuildName(client, guildId),
        module: 'Gestion des salons',
        eventType: 'Manuel',
        details: `Sticky ${sticky.enabled ? 'actif' : 'désactivé'}, ${idleRepostMinutes > 0 ? `renvoi ${idleRepostMinutes} min après le dernier message` : `renvoi tous les ${threshold} message(s)`}.`,
        channelId,
      });

      const { webhookToken: _token, ...publicSticky } = current;
      json(res, 200, { ok: true, sticky: publicSticky });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'POST sticky error:', err);
      jsonFailure(res, err, 'Erreur lors de l\'enregistrement du message sticky', 'ChannelsManagementAPI');
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/channels-management/sticky/:channelId
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'sticky' && method === 'DELETE') {
    const channelId = parts[6];
    try {
      const sticky = await prisma.stickyMessage.findUnique({
        where: { guildId_channelId: { guildId, channelId } },
      });
      if (!sticky) {
        tvError(res, 404, 'Sticky introuvable', 'tv_sticky_not_found');
        return true;
      }

      const { clearStickyMessage, deleteStickyWebhook, invalidateStickyCache } =
        await import('../../../../services/features/stickyMessageService.js');
      await clearStickyMessage(client, sticky);
      await deleteStickyWebhook(sticky);
      await prisma.stickyMessage.delete({ where: { id: sticky.id } });
      await invalidateStickyCache(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression d\'un message sticky',
        context: getGuildName(client, guildId),
        module: 'Gestion des salons',
        eventType: 'Manuel',
        details: `Sticky du salon ${channelId} supprimé.`,
        channelId,
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'DELETE sticky error:', err);
      jsonFailure(res, err, 'Erreur lors de la suppression du message sticky', 'ChannelsManagementAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channels-management/sticky/:channelId/repost
  if (moduleKey === 'channels-management' && parts.length === 8 && parts[5] === 'sticky' && parts[7] === 'repost' && method === 'POST') {
    const channelId = parts[6];
    try {
      const sticky = await prisma.stickyMessage.findUnique({
        where: { guildId_channelId: { guildId, channelId } },
      });
      if (!sticky || !sticky.enabled) {
        tvError(res, 404, 'Sticky introuvable ou désactivé', 'tv_sticky_not_found_or_off');
        return true;
      }

      const { repostSticky } = await import('../../../../services/features/stickyMessageService.js');
      const messageId = await repostSticky(client, sticky, { force: true });
      if (!messageId) {
        tvError(res, 502, 'Renvoi impossible (salon ou permissions).', 'tv_sticky_repost_failed');
        return true;
      }

      json(res, 200, { ok: true, messageId });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'POST sticky repost error:', err);
      jsonFailure(res, err, 'Erreur lors du renvoi du message sticky', 'ChannelsManagementAPI');
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/channels-management/temp-voice/channels
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'temp-voice' && parts[6] === 'channels' && method === 'GET') {
    try {
      const dbChannels = await prisma.tempVoiceChannel.findMany({
        where: { guildId }
      });

      const discordGuild = client.guilds.cache.get(guildId);

      // Serveur injoignable : ses salons ne sont pas en cache non plus. Conclure
      // « ils n'existent plus » effacerait tout le registre alors que les salons
      // sont bien vivants - plus rien ne les référencerait ensuite. Même règle
      // que le balayage au démarrage.
      if (!discordGuild || discordGuild.available === false) {
        json(res, 200, []);
        return true;
      }

      const activeChannels = [];

      for (const dbChan of dbChannels) {
        const channel = discordGuild.channels.cache.get(dbChan.id);
        if (channel && channel.type === ChannelType.GuildVoice) {
          const creatorMember = await discordGuild.members.fetch(dbChan.creatorId).catch(() => null);
          activeChannels.push({
            id: dbChan.id,
            name: channel.name,
            creatorId: dbChan.creatorId,
            creatorName: creatorMember?.displayName || 'Inconnu',
            creatorAvatar: creatorMember?.user.displayAvatarURL() || null,
            membersCount: channel.members.size,
            roleId: dbChan.roleId,
            createdAt: dbChan.createdAt
          });
        } else {
          // Clean up stale database entry
          await prisma.tempVoiceChannel.delete({ where: { id: dbChan.id } }).catch(() => null);
        }
      }

      json(res, 200, activeChannels);
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'GET active channels error:', err);
      jsonFailure(res, err, 'Erreur lors du chargement des salons actifs.', 'ChannelsManagementAPI');
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channels-management/temp-voice/channels/:channelId
  if (moduleKey === 'channels-management' && parts.length === 8 && parts[5] === 'temp-voice' && parts[6] === 'channels' && method === 'PATCH') {
    const channelId = parts[7];
    try {
      const body = await readJsonBody<{ name?: string; roleId?: string | null; action?: 'DELETE' }>(req);
      const discordGuild = client.guilds.cache.get(guildId);
      const channel = discordGuild?.channels.cache.get(channelId);

      if (!channel || channel.type !== ChannelType.GuildVoice) {
        tvError(res, 404, 'Salon introuvable.', 'tv_channel_not_found');
        return true;
      }

      const dbChan = await prisma.tempVoiceChannel.findUnique({
        where: { id: channelId }
      });

      if (!dbChan) {
        tvError(res, 404, 'Salon non enregistré.', 'tv_temp_channel_unregistered');
        return true;
      }

      // 1. Action Delete
      if (body?.action === 'DELETE') {
        const closedName = channel.name;

        // Supprimer d'abord : Discord éjecte les occupants de lui-même, alors
        // que les déconnecter laisse l'écouteur supprimer le salon avant nous.
        // Discord avant la base : purger l'état sans savoir si la suppression a
        // abouti laisserait un salon vivant que plus rien ne référence.
        // La raison nomme l'utilisateur du dashboard : sans elle, le journal
        // d'audit de Discord attribue la suppression au bot.
        const deleted = await channel.delete(`Fermé depuis le dashboard par ${auditUser}`).then(() => true).catch((err: unknown) => {
          // Salon déjà disparu : le résultat voulu est atteint, l'état suit.
          if ((err as { code?: number }).code === 10003) return true;
          logger.warn('ChannelsManagementAPI', `Impossible de supprimer le salon ${channelId} :`, err);
          return false;
        });

        if (!deleted) {
          tvError(res, 409, 'Discord a refusé la suppression du salon.', 'tv_discord_delete_refused');
          return true;
        }

        await prisma.tempVoiceChannel.delete({ where: { id: channelId } }).catch((err: unknown) => {
          logger.error('ChannelsManagementAPI', `Impossible de supprimer la ligne du salon ${channelId} :`, err);
        });

        // Also clean up from local memory cache
        const { tempChannels, oublierProprieteSalon } = await import('../../../../events/tempVoice.js');
        tempChannels.delete(channelId);
        // Une passation en cours s'arrête avec le salon : ni minuterie ni « délai écoulé ».
        oublierProprieteSalon(channel as VoiceChannel);

        await pushAudit(guildId, {
          user: auditUser,
          action: `Fermeture forcée du salon temporaire ${closedName}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: `Salon temporaire ${closedName} (${channelId}) supprimé par l'administrateur.`,
          channelId,
        });

        json(res, 200, { ok: true, message: 'Salon fermé avec succès.' });
        return true;
      }

      // 2. Action Update (Rename/Reserve)
      const data: Record<string, unknown> = {};

      if (body?.name !== undefined && body.name.trim() !== '') {
        const newName = body.name.trim();
        // discord.js met l'instance en cache a jour des le retour de `setName` :
        // relire `channel.name` ensuite donnerait le nouveau nom des deux cotes
        // de la flèche, et l'audit ne dirait plus rien.
        const formerName = channel.name;
        // Discord n'accepte que deux renommages par tranche de dix minutes, et
        // `@discordjs/rest` attend la fin de la fenêtre au lieu de rejeter :
        // sans borne, la requête HTTP resterait ouverte plusieurs minutes et le
        // navigateur abandonnerait avant d'avoir un verdict.
        const renamed = await settleWithin(
          channel.setName(newName, `Renommé depuis le dashboard par ${auditUser}`),
          RENAME_TIMEOUT_MS,
        );

        if (renamed.status === 'failed') {
          logger.warn('ChannelsManagementAPI', `Impossible de renommer le salon ${channelId} :`, renamed.error);
          tvError(res, 409, "Discord a refusé le renommage du salon.", 'tv_discord_rename_refused');
          return true;
        }

        if (renamed.status === 'pending') {
          json(res, 202, {
            ok: true,
            message: "Discord n'a pas confirmé le renommage : un salon ne peut changer de nom que deux fois par tranche de dix minutes. Le nouveau nom s'appliquera peut-être d'ici quelques minutes.",
          });
          return true;
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: `Renommer salon temporaire ${formerName} -> ${newName}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: `Renommé de ${formerName} à ${newName}.`,
          channelId,
        });
      }

      if (body?.roleId !== undefined) {
        // Le corps de la requête part dans une surcharge : le rôle doit exister
        // sur ce serveur et ne pas être @everyone, dont l'identifiant est celui
        // du serveur et passe donc la validation de format.
        const newRoleId = body.roleId
          ? resolveReservationRoleId(body.roleId, guildId, new Set(channel.guild.roles.cache.keys()))
          : null;

        if (body.roleId && !newRoleId) {
          tvError(res, 400, 'Rôle de réservation invalide', 'tv_reservation_role_invalid');
          return true;
        }

        // La catégorie fait foi : accorder sans la consulter ouvrirait le salon
        // a une cible qu'elle refuse.
        const rolePatch = newRoleId
          ? categoryTrustPatch(channel, channel.guild.roles.cache.get(newRoleId) ?? null)
          : null;
        if (newRoleId && !rolePatch) {
          tvError(res, 409, "La catégorie du salon refuse l'accès à ce rôle", 'tv_reservation_category_refused');
          return true;
        }

        // Sans ce retrait, les surcharges des rôles réservés s'accumulent, et
        // son échec doit remonter : l'ancien rôle garde sinon l'accès.
        const reason = `Réservation modifiée depuis le dashboard par ${auditUser}`;
        let previousCleared = true;
        if (dbChan.roleId && dbChan.roleId !== newRoleId) {
          previousCleared = await channel.permissionOverwrites
            .delete(dbChan.roleId, `Réservation précédente levée depuis le dashboard par ${auditUser}`)
            .then(() => true)
            .catch((err: unknown) => {
              logger.warn('ChannelsManagementAPI', `Impossible de lever la réservation précédente sur ${channelId} :`, err);
              return false;
            });
        }

        if (newRoleId && rolePatch) {
          // Le propriétaire n'est pas toujours en cache : le sauter le mettrait
          // dehors du salon que le verrou ferme juste après.
          const owner = channel.guild.members.cache.get(dbChan.creatorId)
            ?? await channel.guild.members.fetch(dbChan.creatorId).catch(() => null);
          const ownerPatch = categoryTrustPatch(channel, owner);

          // Les autorisations d'abord, le verrou ensuite : dans l'ordre inverse,
          // un appel refusé entre les deux laisse un salon fermé à tout le monde
          // et sans réservation.
          if (ownerPatch && owner) await channel.permissionOverwrites.edit(owner, ownerPatch, { reason });
          await channel.permissionOverwrites.edit(newRoleId, rolePatch, { reason });
          await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock, { reason });

          data.roleId = newRoleId;
        } else {
          // Même calcul que le panneau Discord : le droit revient à ce que porte
          // la catégorie, sans l'autoriser à tout le serveur.
          await channel.permissionOverwrites.edit(
            guildId,
            restoreFromCategory(CHANNEL_PATCHES.clearReservation, categoryOverwriteFor(channel, guildId)),
            { reason },
          );

          data.roleId = null;
        }

        await prisma.tempVoiceChannel.update({
          where: { id: channelId },
          data
        });

        // Ancien rôle → nouveau, par leur nom quand le cache le connaît.
        const roleLabel = (id: string | null) => (id ? `@${channel.guild.roles.cache.get(id)?.name ?? id}` : 'aucun');
        await pushAudit(guildId, {
          user: auditUser,
          action: newRoleId ? `Réservation du salon ${channel.name} pour ${roleLabel(newRoleId)}` : `Libération de la réservation du salon ${channel.name}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: `Rôle de réservation : ${roleLabel(dbChan.roleId)} → ${roleLabel(newRoleId)}. ${newRoleId ? `Accès restreint à ${roleLabel(newRoleId)}.` : 'Salon ouvert à tous.'}`,
          channelId,
        });

        // La surcharge du rôle précédent n'a pas pu être retirée : l'annoncer,
        // plutôt que de laisser la page afficher une exclusivité qui n'existe
        // pas.
        if (!previousCleared) {
          json(res, 200, {
            ok: true,
            message: "Salon mis à jour, mais la réservation précédente n'a pas pu être levée : l'ancien rôle garde l'accès.",
          });
          return true;
        }
      }

      json(res, 200, { ok: true, message: 'Salon mis à jour avec succès.' });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'PATCH active channel error:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour du salon.', 'ChannelsManagementAPI');
    }
    return true;
  }

  // GET/PATCH /api/dashboard/guilds/:guildId/channels-management
  if (moduleKey === 'channels-management' && parts.length === 5) {
    if (method === 'GET') {
      try {
        const [guild, tempVoiceAccessRequestConfig, tempVoiceModPermissionsConfig] = await Promise.all([
          prisma.guild.findUnique({
            where: { id: guildId },
            select: {
              autoThreadEnabled: true,
              autoThreadChannels: true,
              autoThreadBotsEnabled: true,
              statsEnabled: true,
              statsConfig: true,
              tempVoiceEnabled: true,
              tempVoiceChannelId: true,
              tempVoiceCategoryId: true,
              tempVoiceNameTemplate: true,
              tempVoiceRequiredRoleId: true,
              tempVoiceDefaults: true,
              tempVoiceGenerators: true,
              honeypotEnabled: true,
              honeypotChannelId: true,
              honeypotSanction: true,
              honeypotReinvite: true,
              honeypotGraceSeconds: true,
              honeypotDurationMin: true,
              wordStatsEnabled: true,
            },
          }),
          // Table séparée, une ligne par serveur : cf. `viewTempVoiceAccessRequestConfig`
          // pour ce que l'absence de ligne veut dire.
          prisma.tempVoiceAccessRequestConfig.findUnique({ where: { guildId } }),
          prisma.tempVoiceModPermissionsConfig.findUnique({ where: { guildId } }),
        ]);
        if (!guild) {
          tvError(res, 404, 'Serveur introuvable', 'tv_guild_not_found');
          return true;
        }
        json(res, 200, {
          autoThreadEnabled: guild.autoThreadEnabled,
          autoThreadChannels: guild.autoThreadChannels,
          autoThreadBotsEnabled: guild.autoThreadBotsEnabled,
          statsEnabled: guild.statsEnabled,
          statsConfig: guild.statsConfig,
          tempVoiceEnabled: guild.tempVoiceEnabled,
          tempVoiceChannelId: guild.tempVoiceChannelId,
          tempVoiceCategoryId: guild.tempVoiceCategoryId,
          tempVoiceNameTemplate: guild.tempVoiceNameTemplate,
          tempVoiceRequiredRoleId: guild.tempVoiceRequiredRoleId,
          // Toujours renvoyer une politique complète : la page n'a pas a
          // connaître les valeurs par défaut ni à gérer le cas « jamais
          // configuré », qui afficherait des cases vides au lieu de l'état réel.
          tempVoiceDefaults: normalizeTempVoicePolicy(guild.tempVoiceDefaults, guildId),
          // Même normalisation qu'à l'écriture, salon du principal compris : un
          // générateur enregistré avant ce réglage n'a aucune clé de politique,
          // et la page doit montrer ce que la sauvegarde gardera.
          tempVoiceGenerators: normalizeTempVoiceGeneratorsInput(
            guild.tempVoiceGenerators,
            guildId,
            guild.tempVoiceChannelId,
          ),
          honeypotEnabled: guild.honeypotEnabled,
          honeypotChannelId: guild.honeypotChannelId,
          honeypotSanction: guild.honeypotSanction,
          honeypotReinvite: guild.honeypotReinvite,
          honeypotGraceSeconds: guild.honeypotGraceSeconds,
          honeypotDurationMin: guild.honeypotDurationMin,
          wordStatsEnabled: guild.wordStatsEnabled,
          // Toujours les défauts du schéma quand la ligne n'existe pas encore :
          // le formulaire d'accès du dashboard n'a pas à savoir ce que « jamais
          // configuré » veut dire.
          tempVoiceAccessRequest: viewTempVoiceAccessRequestConfig(tempVoiceAccessRequestConfig),
          tempVoiceModPermissions: viewTempVoiceModPermissionsConfig(tempVoiceModPermissionsConfig),
        });
      } catch (err) {
        logger.error('ChannelsManagementAPI', 'GET config error:', err);
        jsonFailure(res, err, 'Erreur lors de la récupération de la configuration', 'ChannelsManagementAPI');
      }
      return true;
    }

    if (method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          autoThreadEnabled?: boolean;
          autoThreadChannels?: string[];
          autoThreadBotsEnabled?: boolean;
          statsEnabled?: boolean;
          statsConfig?: unknown;
          tempVoiceEnabled?: boolean;
          tempVoiceChannelId?: string | null;
          tempVoiceCategoryId?: string | null;
          // `unknown` : le corps vient d'un appelant quelconque, validé plus bas.
          tempVoiceNameTemplate?: unknown;
          tempVoiceRequiredRoleId?: string | null;
          tempVoiceDefaults?: unknown;
          tempVoiceGenerators?: unknown;
          tempVoiceAccessRequest?: unknown;
          tempVoiceModPermissions?: unknown;
          honeypotEnabled?: boolean;
          /** Demande au dashboard de creer le salon piege automatiquement. */
          createHoneypotChannel?: boolean;
          honeypotChannelId?: string | null;
          honeypotSanction?: string;
          honeypotReinvite?: boolean;
          honeypotGraceSeconds?: number;
          honeypotDurationMin?: number | null;
          wordStatsEnabled?: boolean;
        }>(req);

        if (!body) {
          tvError(res, 400, 'Payload invalide', 'tv_payload_invalid');
          return true;
        }

        const data: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
          data.autoThreadEnabled = !!body.autoThreadEnabled;
        }
        if (Array.isArray(body.autoThreadChannels)) {
          // Les salons armés sont portés par les configurations Auto-Thread :
          // la liste n'est que leur miroir, le service la recalcule.
          const { reconcileAutoThreadChannels } = await import('../../../../services/features/autoThreadService.js');
          const discordGuild = client.guilds.cache.get(guildId);
          await reconcileAutoThreadChannels(
            guildId,
            body.autoThreadChannels.filter((id): id is string => typeof id === 'string'),
            (id) => {
              const ch = discordGuild?.channels.cache.get(id);
              return !!ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement);
            },
          );
        }
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadBotsEnabled')) {
          data.autoThreadBotsEnabled = !!body.autoThreadBotsEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'statsEnabled')) {
          data.statsEnabled = !!body.statsEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'statsConfig')) {
          data.statsConfig = body.statsConfig;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceEnabled')) {
          data.tempVoiceEnabled = !!body.tempVoiceEnabled;
        }
        // Identifiants et gabarit validés ici, avant toute écriture : un `null`
        // ou un nombre dans `tempVoiceNameTemplate` faisait échouer l'update en
        // 500, et un identifiant quelconque était enregistré tel quel puis
        // relu comme un salon par le bot.
        for (const [key, label] of [
          ['tempVoiceChannelId', 'Salon générateur'],
          ['tempVoiceCategoryId', 'Catégorie des salons créés'],
          ['tempVoiceRequiredRoleId', 'Rôle requis'],
        ] as const) {
          if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
          const parsed = readOptionalSnowflake(body[key], label, key);
          if ('error' in parsed) {
            tvError(res, 400, parsed);
            return true;
          }
          data[key] = parsed.value;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceNameTemplate')) {
          const template = body.tempVoiceNameTemplate;
          if (typeof template !== 'string') {
            tvError(res, 400, {
              error: `Modèle de nom (tempVoiceNameTemplate) : « ${String(template).slice(0, 40)} » n'est pas un texte. Rien n'a été enregistré.`,
              code: 'tv_name_template_invalid',
              params: { value: String(template).slice(0, 40) },
            });
            return true;
          }
          // Même plafond que le modèle des générateurs additionnels.
          data.tempVoiceNameTemplate = template.trim().slice(0, 100);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceDefaults')) {
          data.tempVoiceDefaults = normalizeTempVoicePolicy(body.tempVoiceDefaults, guildId) as unknown as Prisma.InputJsonValue;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceGenerators')) {
          // Rejet AVANT normalisation : `normalizeTempVoiceGeneratorsInput`
          // (tempVoiceService.ts) traite une surcharge de présentation hors
          // énumération comme absente, ce qui écrirait « enregistré » côté page
          // sans que rien n'ait changé. Voir la doc de
          // `validateGeneratorPresentationOverrides` pour la divergence assumée
          // avec la lecture (rendu du panneau), qui reste tolérante.
          const presentationError = validateGeneratorPresentationOverrides(body.tempVoiceGenerators);
          if (presentationError) {
            tvError(res, 400, presentationError);
            return true;
          }
          // La page n'est qu'un client parmi d'autres (outils MCP, appels
          // directs) : sans validation ici, une limite de places aberrante ou un
          // identifiant de rôle invente descendrait jusqu'à l'appel Discord.
          data.tempVoiceGenerators = normalizeTempVoiceGeneratorsInput(
            body.tempVoiceGenerators,
            guildId,
            body.tempVoiceChannelId,
          ) as unknown as Prisma.InputJsonValue;
        }

        // Tables séparées (une ligne par serveur) : la validation se fait ici,
        // comme pour tempVoiceDefaults/tempVoiceGenerators juste au-dessus,
        // mais l'écriture est un upsert à part puisque `data` ne vise que
        // `Guild`. `null` = champ absent du corps, rien à écrire dessus.
        let tempVoiceAccessRequestData: Partial<TempVoiceAccessRequestConfigView> | null = null;
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceAccessRequest')) {
          const parsed = normalizeTempVoiceAccessRequestInput(body.tempVoiceAccessRequest);
          if ('error' in parsed) {
            tvError(res, 400, parsed);
            return true;
          }
          tempVoiceAccessRequestData = parsed.data;
        }

        /**
         * Réglages acceptés ET enregistrés, mais dont l'effet est nul dans la
         * combinaison obtenue. Ni une erreur (rien à corriger, la valeur est
         * valide) ni un silence (sinon le réglage paraît perdu) : la réponse les
         * porte, en français comme les erreurs, à côté de `ok: true`. Champ absent
         * quand il n'y a rien à dire, pour ne pas changer la forme de la réponse
         * dans le cas courant.
         */
        const notices: NoticeVocale[] = [];

        let tempVoiceModPermissionsData: Partial<TempVoiceModPermissionsConfigView> | null = null;
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceModPermissions')) {
          const parsed = normalizeTempVoiceModPermissionsInput(body.tempVoiceModPermissions);
          if ('error' in parsed) {
            tvError(res, 400, parsed);
            return true;
          }
          tempVoiceModPermissionsData = parsed.data;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'honeypotEnabled')) {
          data.honeypotEnabled = !!body.honeypotEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotChannelId')) {
          data.honeypotChannelId = body.honeypotChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotSanction')) {
          if (['WARN', 'KICK', 'TIMEOUT', 'BAN', 'SOFTBAN', 'JAIL'].includes(body.honeypotSanction as string)) {
            data.honeypotSanction = body.honeypotSanction;
          } else {
            tvError(res, 400, 'Type de sanction honeypot invalide', 'tv_honeypot_sanction_invalid');
            return true;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotReinvite')) {
          data.honeypotReinvite = !!body.honeypotReinvite;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotGraceSeconds')) {
          // 0, 30 s, 1, 2 ou 5 minutes : au-delà, un robot a tout le temps de nuire.
          const seconds = Math.floor(Number(body.honeypotGraceSeconds) || 0);
          data.honeypotGraceSeconds = [0, 30, 60, 120, 300].includes(seconds) ? seconds : 0;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotDurationMin')) {
          const minutes = body.honeypotDurationMin === null ? null : Math.floor(Number(body.honeypotDurationMin));
          data.honeypotDurationMin = minutes && minutes >= 1 ? Math.min(minutes, 365 * 24 * 60) : null;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'wordStatsEnabled')) {
          data.wordStatsEnabled = !!body.wordStatsEnabled;
        }

        // Capturé avant l'update : sert à détecter la bascule off → on plus bas.
        const wordStatsWasEnabled = Object.prototype.hasOwnProperty.call(body, 'wordStatsEnabled')
          ? await readWordStatsEnabled(guildId)
          : null;

        // État vocal d'AVANT l'écriture, pour le journal des changements. Lu
        // seulement quand le corps touche un réglage vocal.
        const touchesVoice = VOICE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
        const voiceBefore = touchesVoice
          ? await (async () => {
              const [guildRow, accessRow, modRow] = await Promise.all([
                prisma.guild.findUnique({
                  where: { id: guildId },
                  select: {
                    tempVoiceEnabled: true,
                    tempVoiceChannelId: true,
                    tempVoiceCategoryId: true,
                    tempVoiceNameTemplate: true,
                    tempVoiceRequiredRoleId: true,
                    tempVoiceDefaults: true,
                    tempVoiceGenerators: true,
                  },
                }),
                prisma.tempVoiceAccessRequestConfig.findUnique({ where: { guildId } }),
                prisma.tempVoiceModPermissionsConfig.findUnique({ where: { guildId } }),
              ]);
              return snapshotReglagesVocaux(guildId, guildRow, accessRow, modRow);
            })()
          : null;

        // État non vocal d'AVANT l'écriture : la ligne générique du journal ne
        // part que si une de ces valeurs a réellement changé.
        const touchesAutre = Object.keys(body).some((key) => !(VOICE_KEYS as readonly string[]).includes(key));
        const nonVocalAvant = touchesAutre
          ? await prisma.guild.findUnique({
            where: { id: guildId },
            select: Object.fromEntries(CLES_NON_VOCALES.map((key) => [key, true])),
          }).catch(() => null) as Record<string, unknown> | null
          : null;

        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);

        // Ce que le serveur a réellement tenté d'enregistrer, pour dire ce qu'il
        // écarte : la liste du corps, ou celle d'après création des salons vides.
        let generatorsTried: unknown = body.tempVoiceGenerators;

        if (discordGuild) {
          if (body.tempVoiceEnabled) {
            // Catégorie d'accueil partagee par tous les générateurs qui n'en
            // designent pas : une par générateur en laisserait autant que de
            // sauvegardes.
            const ensureDefaultCategory = async (): Promise<string | undefined> => {
              const existing = discordGuild.channels.cache.find(
                c => c.type === ChannelType.GuildCategory && c.name === '🔊 Salons Vocaux'
              );
              if (existing) return existing.id;
              const created = await discordGuild.channels.create({
                name: '🔊 Salons Vocaux',
                type: ChannelType.GuildCategory,
              }).catch(() => null);
              return created?.id;
            };

            if (!body.tempVoiceCategoryId) {
              const categoryId = await ensureDefaultCategory();
              if (categoryId) data.tempVoiceCategoryId = categoryId;
            }
            // Salon générateur : réutilisé avant d'être créé, comme la
            // catégorie juste au-dessus, sinon chaque sauvegarde en ajoute un.
            const ensureGeneratorChannel = async (parentId: string | undefined): Promise<string | undefined> => {
              const existing = discordGuild.channels.cache.find(
                c => c.type === ChannelType.GuildVoice
                  && c.name === '➕ Créer un salon'
                  && (!parentId || c.parentId === parentId)
              );
              if (existing) return existing.id;
              const created = await discordGuild.channels.create({
                name: '➕ Créer un salon',
                type: ChannelType.GuildVoice,
                parent: parentId,
              }).catch(() => null);
              return created?.id;
            };

            if (!body.tempVoiceChannelId) {
              const parentId = (data.tempVoiceCategoryId as string | undefined) || body.tempVoiceCategoryId || undefined;
              const channelId = await ensureGeneratorChannel(parentId);
              if (channelId) data.tempVoiceChannelId = channelId;
            }

            // Générateurs additionnels : la page peut laisser le salon vide
            // pour demander au bot de le créer.
            if (Array.isArray(body.tempVoiceGenerators)) {
              const resolvedGenerators: Array<Record<string, unknown>> = [];

              // Le plafond s'applique AVANT la création : appliqué au seul
              // enregistrement, il laisse créer autant de salons que d'entrées.
              for (const entry of body.tempVoiceGenerators.slice(0, MAX_ADDITIONAL_GENERATORS)) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
                const resolved: Record<string, unknown> = { ...(entry as Record<string, unknown>) };

                if (!resolved.categoryId) {
                  const categoryId = await ensureDefaultCategory();
                  if (categoryId) resolved.categoryId = categoryId;
                }

                if (!resolved.channelId) {
                  // Un générateur additionnel ne peut pas reprendre le salon du
                  // principal : le dedoublonnage l'ecarterait ensuite.
                  const parentId = typeof resolved.categoryId === 'string' ? resolved.categoryId : undefined;
                  const alreadyUsed = new Set(
                    [(data.tempVoiceChannelId as string | undefined) ?? body.tempVoiceChannelId, ...resolvedGenerators.map(g => g.channelId)]
                      .filter((id): id is string => typeof id === 'string'),
                  );
                  const existing = discordGuild.channels.cache.find(
                    c => c.type === ChannelType.GuildVoice
                      && c.name === '➕ Créer un salon'
                      && (!parentId || c.parentId === parentId)
                      && !alreadyUsed.has(c.id)
                  );
                  if (existing) {
                    resolved.channelId = existing.id;
                  } else {
                    const newVoice = await discordGuild.channels.create({
                      name: '➕ Créer un salon',
                      type: ChannelType.GuildVoice,
                      parent: parentId,
                    }).catch(() => null);
                    if (newVoice) resolved.channelId = newVoice.id;
                  }
                }

                resolvedGenerators.push(resolved);
              }

              generatorsTried = [...resolvedGenerators, ...body.tempVoiceGenerators.slice(MAX_ADDITIONAL_GENERATORS)];

              // La validation vient après la création, et non avant : un
              // générateur que la page laisse vide pour que le bot le crée n'a
              // pas encore d'identifiant, et serait écarté comme invalide.
              data.tempVoiceGenerators = normalizeTempVoiceGeneratorsInput(
                resolvedGenerators,
                guildId,
                (data.tempVoiceChannelId as string | undefined) ?? body.tempVoiceChannelId,
              ) as unknown as Prisma.InputJsonValue;
            }
          }

          if (body.honeypotEnabled && body.createHoneypotChannel) {
            const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
            const newHoneypot = await provisionHoneypotChannel(discordGuild, {
              name: honeypotChannelName(locale),
            }).catch(() => null);
            if (newHoneypot) {
              data.honeypotChannelId = newHoneypot.id;
            }
          }

          if (body.statsEnabled && body.statsConfig) {
            const sc = readStatsConfig(body.statsConfig);

            const needsMember = sc.memberChannelId === '' || sc.memberChannelId === null;
            const needsBot = sc.botChannelId === '' || sc.botChannelId === null;
            const needsRole = sc.roleChannelId === '' || sc.roleChannelId === null;
            const needsChannel = sc.channelChannelId === '' || sc.channelChannelId === null;
            const needsCategory = sc.categoryChannelId === '' || sc.categoryChannelId === null;
            const needsActivity = sc.activityChannelId === '' || sc.activityChannelId === null;
            const needsCustomStats = Array.isArray(sc.customStats) && sc.customStats.some((c) => c.enabled && !c.channelId);

            if (needsMember || needsBot || needsRole || needsChannel || needsCategory || needsActivity || needsCustomStats || !sc.categoryId) {
              let statsCatId: string | undefined = sc.categoryId || undefined;
              
              if (!statsCatId) {
                const existingStatsCat = discordGuild.channels.cache.find(
                  c => c.type === ChannelType.GuildCategory && c.name === '📊 Statistiques'
                );
                if (existingStatsCat) {
                  statsCatId = existingStatsCat.id;
                } else {
                  const newCat = await discordGuild.channels.create({
                    name: '📊 Statistiques',
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                      {
                        id: discordGuild.roles.everyone.id,
                        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages],
                      },
                    ],
                  }).catch(() => null);
                  if (newCat) statsCatId = newCat.id;
                }
              }

              const createStatChannel = async (defaultName: string, asCategory = false): Promise<string | undefined> => {
                if (asCategory) {
                  const ch = await discordGuild.channels.create({
                    name: defaultName,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                      {
                        id: discordGuild.roles.everyone.id,
                        deny: [PermissionFlagsBits.SendMessages],
                      },
                    ],
                  }).catch(() => null);
                  return ch?.id;
                }
                const ch = await discordGuild.channels.create({
                  name: defaultName,
                  type: ChannelType.GuildVoice,
                  parent: statsCatId,
                  permissionOverwrites: [
                    {
                      id: discordGuild.roles.everyone.id,
                      deny: [PermissionFlagsBits.Connect],
                    },
                  ],
                }).catch(() => null);
                return ch?.id;
              };

              const newSc = { ...sc };
              if (statsCatId) {
                newSc.categoryId = statsCatId;
              }

              if (needsMember) {
                const tpl = sc.memberTemplate || '👤 Members: {count}';
                newSc.memberChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.memberChannelId;
              }
              if (needsBot) {
                const tpl = sc.botTemplate || '🤖 Bots: {count}';
                newSc.botChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.botChannelId;
              }
              if (needsRole) {
                const tpl = sc.roleTemplate || '👑 Staff: {count}';
                newSc.roleChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.roleChannelId;
              }
              if (needsChannel) {
                const tpl = sc.channelTemplate || '💬 Channels: {count}';
                newSc.channelChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.channelChannelId;
              }
              if (needsCategory) {
                const tpl = sc.categoryTemplate || '📁 Categories: {count}';
                newSc.categoryChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.categoryChannelId;
              }
              if (needsActivity) {
                const tpl = sc.activityTemplate || '📈 Active 24h: {count}';
                newSc.activityChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.activityChannelId;
              }

              if (Array.isArray(sc.customStats)) {
                const updatedCustomStats = [];
                for (const custom of sc.customStats) {
                  const item = { ...custom };
                  if (item.enabled && !item.channelId) {
                    const tpl = item.template || 'Stat : {count}';
                    let initialName = tpl.replace('{count}', '…');
                    if (item.type === 'goal' && item.goalTarget) {
                      initialName = initialName.replace('{goal}', item.goalTarget.toString());
                    }
                    item.channelId = await createStatChannel(initialName, item.channelType === 'category') ?? '';
                  }
                  updatedCustomStats.push(item);
                }
                newSc.customStats = updatedCustomStats;
              }

              data.statsConfig = newSc;
            }
          }
        }

        await prisma.guild.update({
          where: { id: guildId },
          data,
        });

        // Tables séparées : un `upsert` par table, un serveur qui n'a jamais
        // ouvert l'onglet « Demandes d'accès » n'a pas de ligne. Le `create`
        // part des défauts du schéma pour que les champs non envoyés dans ce
        // PATCH (payload partiel) prennent la même valeur qu'une ligne jamais
        // configurée, pas un zéro.
        if (tempVoiceAccessRequestData) {
          await prisma.tempVoiceAccessRequestConfig.upsert({
            where: { guildId },
            create: { guildId, ...TEMP_VOICE_ACCESS_REQUEST_DEFAULTS, ...tempVoiceAccessRequestData },
            update: tempVoiceAccessRequestData,
          });
        }
        if (tempVoiceModPermissionsData) {
          const savedModPermissions = await prisma.tempVoiceModPermissionsConfig.upsert({
            where: { guildId },
            create: { guildId, ...TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS, ...tempVoiceModPermissionsData },
            update: tempVoiceModPermissionsData,
          });
          // `stateColors` ne teinte que l'image d'état, et GRID3 en V1 n'en
          // produit aucune (embed natif Discord). La valeur est enregistrée
          // quand même — la refuser en 400 casserait les appels API déjà en
          // place, et ce n'est pas une valeur invalide — mais la réponse le dit.
          // La protection n'existait que dans la page (le sélecteur est grisé
          // sur cette combinaison), donc tout autre appelant l'enregistrait en
          // silence et croyait avoir changé la teinte.
          //
          // Comparé au DÉFAUT, pas à `NEUTRAL` en dur : c'est ce qui distingue
          // une teinte CHOISIE d'une teinte jamais touchée. Sans ça, tout
          // enregistrement en GRID3 + V1 porterait le message, y compris celui
          // d'un serveur qui n'a jamais ouvert ce sélecteur.
          //
          // L'état LU est celui que l'upsert renvoie, pas le payload : un PATCH
          // partiel (juste `panelComponents: 'V1'`, par exemple) rend une teinte
          // inerte sans jamais nommer `stateColors`. Même règle que le rendu
          // (`dispositionNative`) et même normalisation que le GET
          // (`viewTempVoiceModPermissionsConfig`), pour qu'un message ne puisse
          // pas contredire ce que le panneau affiche.
          const effectif = viewTempVoiceModPermissionsConfig(savedModPermissions);
          if (
            dispositionNative({ disposition: effectif.stateLayout, composants: effectif.panelComponents })
            && effectif.stateColors !== TEMP_VOICE_MOD_PERMISSIONS_DEFAULTS.stateColors
          ) {
            notices.push(avisVocal(
              'notice_tv_state_colors_inert',
              { colors: effectif.stateColors },
              `stateColors="${effectif.stateColors}" a été enregistré mais n'a aucun effet visible : stateLayout=GRID3 avec panelComponents=V1 affiche l'embed natif de Discord, qui n'a pas d'image d'état à teinter. Passez panelComponents en V2, ou choisissez un autre stateLayout, pour que la palette s'applique.`,
            ));
          }
        }

        // Générateurs que la normalisation a écartés : le dire, sinon la carte de
        // la page disparaît à l'enregistrement sans explication.
        const nomSalon = (id: string): string | undefined => {
          try {
            return discordGuild?.channels?.cache?.get(id)?.name;
          } catch {
            return undefined;
          }
        };
        if (Array.isArray(generatorsTried) && Array.isArray(data.tempVoiceGenerators)) {
          notices.push(
            ...explainDroppedGenerators(
              generatorsTried,
              data.tempVoiceGenerators as unknown as Array<{ channelId: string }>,
              ('tempVoiceChannelId' in data ? data.tempVoiceChannelId : voiceBefore?.tempVoiceChannelId) as string | null | undefined,
              nomSalon,
            ),
          );
        }

        // Purge les caches préfixés guild:<id>: - config du bot (getCachedGuild)
        // et payloads d'analytics avancées, qui embarquent les toggles (ex.
        // wordStatsEnabled). Couvre aussi les deux upserts juste au-dessus :
        // sans ça, le dashboard continue d'afficher l'ancien état pendant toute
        // la durée du TTL.
        await cache.invalidateGuild(guildId);

        startWordStatsBackfillIfTurnedOn(guildId, wordStatsWasEnabled, data.wordStatsEnabled, 'ChannelsManagementAPI');

        // Journal des changements vocaux : UNE ligne d'audit, un champ par ligne
        // « champ : avant → après ». Rien quand aucun champ vocal n'a bougé.
        if (voiceBefore) {
          const voiceAfter: ReglagesVocaux = {
            ...voiceBefore,
            ...Object.fromEntries(VOICE_KEYS.filter((key) => key in data).map((key) => [key, data[key]])),
            ...(tempVoiceModPermissionsData
              ? { tempVoiceModPermissions: { ...(voiceBefore.tempVoiceModPermissions as object), ...tempVoiceModPermissionsData } }
              : {}),
            ...(tempVoiceAccessRequestData
              ? { tempVoiceAccessRequest: { ...(voiceBefore.tempVoiceAccessRequest as object), ...tempVoiceAccessRequestData } }
              : {}),
          };
          const nomRole = (id: string): string | undefined => {
            try {
              return discordGuild?.roles?.cache?.get(id)?.name;
            } catch {
              return undefined;
            }
          };
          const noms: NomsLisibles = { salon: nomSalon, role: nomRole };
          const changes = diffReglagesVocaux(voiceBefore, voiceAfter, noms);
          if (changes.length > 0) {
            await pushAudit(guildId, {
              user: auditUser,
              action: `Réglages vocaux modifiés (${changes.length})`,
              context: getGuildName(client, guildId),
              module: 'Gestion des salons',
              eventType: 'Manuel',
              details: lignesDiffReglages(changes).join('\n').slice(0, 4000),
              channelId: null,
            });
            await envoyerEmbedReglagesVocaux(discordGuild, guildId, auditUser, (langue) => diffReglagesVocaux(voiceBefore, voiceAfter, noms, langue));
          }
        }
        // Le reste du corps (fils auto, stats, honeypot...) garde la ligne générique,
        // quand une de ses valeurs a bougé : la page renvoie tout le corps à chaque
        // enregistrement, un réglage vocal seul ne doit pas la doubler. Une base
        // illisible avant l'écriture compte pour un changement.
        const apres: Record<string, unknown> = { ...data };
        if (Array.isArray(body.autoThreadChannels)) apres.autoThreadChannels = body.autoThreadChannels;
        const nonVocalChange = touchesAutre && (!nonVocalAvant
          || CLES_NON_VOCALES.some((key) => key in apres && !memeValeur(nonVocalAvant[key], apres[key])));
        if (nonVocalChange) {
          await pushAudit(guildId, {
            user: auditUser,
            action: 'Sauvegarde configuration Gestion des salons',
            context: getGuildName(client, guildId),
            module: 'Gestion des salons',
            eventType: 'Manuel',
            details: 'Configuration de la gestion des salons mise à jour.',
            channelId: null,
          });
        }

        if (body.statsEnabled) {
          updateGuildStats(client, guildId).catch((err) => 
            logger.error('ChannelsManagementAPI', `Erreur lors de la mise à jour des stats pour la guilde ${guildId} :`, err)
          );
        }

        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey: 'auto_thread' } },
            create: {
              guildId,
              featureKey: 'auto_thread',
              featureName: 'Gestion des salons',
              enabled: !!body.autoThreadEnabled,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
            },
            update: {
              enabled: !!body.autoThreadEnabled
            }
          });
        }

        json(res, 200, {
          ok: true,
          ...(notices.length ? { notices } : {}),
          resolved: {
            tempVoiceChannelId: data.tempVoiceChannelId,
            tempVoiceCategoryId: data.tempVoiceCategoryId,
            tempVoiceGenerators: data.tempVoiceGenerators,
            honeypotChannelId: data.honeypotChannelId,
            honeypotSanction: data.honeypotSanction,
            honeypotReinvite: data.honeypotReinvite,
            statsConfig: data.statsConfig,
            // Ce que le serveur a normalisé et gardé : la page le réapplique au
            // lieu de garder ce qu'elle a envoyé (un plafond de places ramené à
            // 99, un délai ramené dans ses bornes...).
            tempVoiceDefaults: data.tempVoiceDefaults,
            tempVoiceModPermissions: tempVoiceModPermissionsData
              ? { ...(voiceBefore?.tempVoiceModPermissions as object), ...tempVoiceModPermissionsData }
              : undefined,
            tempVoiceAccessRequest: tempVoiceAccessRequestData
              ? { ...(voiceBefore?.tempVoiceAccessRequest as object), ...tempVoiceAccessRequestData }
              : undefined,
          }
        });
      } catch (err) {
        logger.error('ChannelsManagementAPI', 'PATCH config error:', err);
        jsonFailure(res, err, 'Erreur lors de la mise à jour', 'ChannelsManagementAPI');
      }
      return true;
    }
  }

  return false;
}
