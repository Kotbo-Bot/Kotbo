/**
 * Bornes et fenêtres des quêtes RPG.
 *
 * Aucun accès base : ces règles décident de ce qu'un objectif veut dire et de quand il se
 * remet à zéro, et doivent rester vérifiables en test.
 */

import { asRpgTeamMode } from './rpgTeamResolver.js';
import {
  normalizeQuestConditions,
  normalizeQuestRewards,
  type QuestConditions,
  type QuestReward,
} from './rpgQuestRules.js';

export const RPG_QUEST_OBJECTIVES = [
  'MONSTER_KILLS',
  'BOSS_KILLS',
  'RAID_ASSAULTS',
  'RAID_DAMAGE',
  'ITEMS_LOOTED',
  'FISH_CAUGHT',
  'ITEMS_CRAFTED',
  'UPGRADES_SUCCEEDED',
  'SHOP_PURCHASES',
  'BLACK_MARKET_PURCHASES',
  'COINS_SPENT',
  'ADVENTURES_COMPLETED',
  'DAILY_CLAIMS',
  'TOWER_FLOORS',
  'TOWER_MONSTER_KILLS',
  'TOWER_BOSS_KILLS',
  'SEND_MESSAGES',
  'REPLY_MESSAGES',
  'VOICE_MINUTES',
  'REACT_MESSAGES',
  'CREATE_THREADS',
  'GIVE_REP',
  'WIN_GAME',
  'EARN_COINS',
  'GIVEAWAYS_JOINED',
  'GIVEAWAYS_WON',
  'LEVEL_REACHED',
  'XP_EARNED',
  'ACTIVE_STREAK',
  'ACTIVE_DAYS',
  'INVITES',
  'TICKETS_OPENED',
  'SUGGESTIONS_SENT',
  'QUESTS_COMPLETED',
] as const;
export type RpgQuestObjective = (typeof RPG_QUEST_OBJECTIVES)[number];

/**
 * Objectifs qui se lisent comme un état et non comme un compteur : « atteindre le niveau 10 »,
 * « 7 jours d'affilée ». L'action en donne la valeur courante, la quête garde la plus haute.
 */
export const ABSOLUTE_QUEST_OBJECTIVES: ReadonlySet<string> = new Set(['LEVEL_REACHED', 'ACTIVE_STREAK', 'ACTIVE_DAYS']);

export const RPG_QUEST_SCOPES = ['MEMBER', 'TEAM'] as const;
export type RpgQuestScope = (typeof RPG_QUEST_SCOPES)[number];

export const QUEST_NAME_MAX = 60;
export const QUEST_DESCRIPTION_MAX = 300;

export const QUEST_TARGET_RANGE = { min: 1, max: 1_000_000 } as const;
/** D'une heure à un mois : en deçà rien n'est jouable, au delà plus personne ne suit. */
export const QUEST_WINDOW_RANGE = { min: 1, max: 720 } as const;
export const QUEST_REWARD_RANGE = { min: 0, max: 1_000_000 } as const;
export const QUEST_CLAN_POINTS_RANGE = { min: 0, max: 100_000 } as const;

const MS_PER_HOUR = 60 * 60 * 1000;

export function isRpgQuestObjective(value: unknown): value is RpgQuestObjective {
  return typeof value === 'string' && (RPG_QUEST_OBJECTIVES as readonly string[]).includes(value);
}

export function isRpgQuestScope(value: unknown): value is RpgQuestScope {
  return typeof value === 'string' && (RPG_QUEST_SCOPES as readonly string[]).includes(value);
}

export function clampInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(parsed)));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Numéro de la fenêtre en cours, aligné sur l'époque.
 *
 * Toutes les équipes courent ainsi la même horloge : une fenêtre qui démarrerait au premier
 * coup de chaque équipe donnerait à chacune sa propre échéance, et leurs résultats ne
 * seraient plus comparables. Vingt-quatre heures tombent sur minuit UTC, six heures sur 00,
 * 06, 12 et 18.
 */
export function questWindowKey(windowHours: number, now: Date = new Date()): string {
  const hours = clampInt(windowHours, QUEST_WINDOW_RANGE, 24);
  return String(Math.floor(now.getTime() / (hours * MS_PER_HOUR)));
}

/** Début et fin de la fenêtre en cours, pour l'annoncer au joueur. */
export function questWindowBounds(windowHours: number, now: Date = new Date()): { startsAt: Date; endsAt: Date } {
  const hours = clampInt(windowHours, QUEST_WINDOW_RANGE, 24);
  const span = hours * MS_PER_HOUR;
  const startsAt = new Date(Math.floor(now.getTime() / span) * span);
  return { startsAt, endsAt: new Date(startsAt.getTime() + span) };
}

/**
 * Délai entre deux versements d'une même quête personnelle non répétable.
 *
 * Il se compte depuis le dernier versement et non depuis le début de la fenêtre : une quête
 * réglée sur six heures paierait sinon quatre fois par jour, et le verrou ne tiendrait que
 * pour celles déjà réglées sur vingt-quatre.
 */
export const QUEST_MEMBER_COOLDOWN_MS = 24 * MS_PER_HOUR;

export function isQuestOnCooldown(lastClaimedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastClaimedAt) return false;
  return now.getTime() - lastClaimedAt.getTime() < QUEST_MEMBER_COOLDOWN_MS;
}

export interface RpgQuestInput {
  name?: unknown;
  description?: unknown;
  emoji?: unknown;
  objective?: unknown;
  target?: unknown;
  scope?: unknown;
  teamMode?: unknown;
  windowHours?: unknown;
  rewardCoins?: unknown;
  rewardXp?: unknown;
  rewardClanPoints?: unknown;
  repeatable?: unknown;
  enabled?: unknown;
  /** Absent : la valeur enregistrée n'est pas touchée. `null` ou vide : elle est effacée. */
  conditions?: unknown;
  rewards?: unknown;
  prerequisiteQuestId?: unknown;
  activeFrom?: unknown;
  activeUntil?: unknown;
}

export interface NormalizedRpgQuest {
  name: string;
  description: string;
  emoji: string;
  objective: RpgQuestObjective;
  target: number;
  scope: RpgQuestScope;
  teamMode: string;
  windowHours: number;
  rewardCoins: number;
  rewardXp: number;
  rewardClanPoints: number;
  repeatable: boolean;
  enabled: boolean;
  conditions?: QuestConditions | null;
  rewards?: QuestReward[] | null;
  prerequisiteQuestId?: string | null;
  activeFrom?: Date | null;
  activeUntil?: Date | null;
}

function optionalDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type RpgQuestNormalizeResult =
  | { ok: true; value: NormalizedRpgQuest }
  | { ok: false; error: string };

export function normalizeRpgQuestInput(input: RpgQuestInput): RpgQuestNormalizeResult {
  const name = text(input.name);
  if (!name) return { ok: false, error: 'Le nom de la quête est obligatoire.' };
  if (name.length > QUEST_NAME_MAX) {
    return { ok: false, error: `Le nom de la quête ne peut pas dépasser ${QUEST_NAME_MAX} caractères.` };
  }

  const description = text(input.description).slice(0, QUEST_DESCRIPTION_MAX);
  if (!description) return { ok: false, error: 'La description de la quête est obligatoire.' };

  if (!isRpgQuestObjective(input.objective)) return { ok: false, error: 'Objectif de quête inconnu.' };

  const scope: RpgQuestScope = isRpgQuestScope(input.scope) ? input.scope : 'MEMBER';
  const teamMode = asRpgTeamMode(input.teamMode);

  return {
    ok: true,
    value: {
      name,
      description,
      emoji: text(input.emoji) || '📜',
      objective: input.objective,
      target: clampInt(input.target, QUEST_TARGET_RANGE, 10),
      scope,
      teamMode,
      windowHours: clampInt(input.windowHours, QUEST_WINDOW_RANGE, 24),
      rewardCoins: clampInt(input.rewardCoins, QUEST_REWARD_RANGE, 0),
      rewardXp: clampInt(input.rewardXp, QUEST_REWARD_RANGE, 0),
      // Une quête personnelle crédite le clan de celui qui la termine, comme le fait déjà
      // un monstre vaincu. Une quête d'équipe crédite l'équipe : son clan en mode clan, sa
      // guilde du jeu - en XP de guilde - en mode guilde RPG.
      rewardClanPoints: clampInt(input.rewardClanPoints, QUEST_CLAN_POINTS_RANGE, 0),
      // La répétition n'a de sens que pour une quête personnelle : une quête d'équipe se paie
      // déjà d'elle-même, et la laisser repartir en boucle ferait tourner la caisse du clan.
      // Un objectif d'état (niveau, série) ne se répète pas : la valeur ne repart jamais de zéro.
      repeatable: scope === 'MEMBER' && input.repeatable === true && !ABSOLUTE_QUEST_OBJECTIVES.has(input.objective),
      enabled: input.enabled !== false,
      ...(input.conditions !== undefined ? { conditions: normalizeQuestConditions(input.conditions) } : {}),
      ...(input.rewards !== undefined ? { rewards: normalizeQuestRewards(input.rewards) } : {}),
      ...(input.prerequisiteQuestId !== undefined
        ? { prerequisiteQuestId: text(input.prerequisiteQuestId).slice(0, 40) || null }
        : {}),
      ...(input.activeFrom !== undefined ? { activeFrom: optionalDate(input.activeFrom) } : {}),
      ...(input.activeUntil !== undefined ? { activeUntil: optionalDate(input.activeUntil) } : {}),
    },
  };
}
