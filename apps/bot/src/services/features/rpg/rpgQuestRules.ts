/**
 * Conditions et récompenses libres des quêtes.
 *
 * Aucun accès base ni Discord : ce que le dashboard enregistre est borné ici, et ce que le
 * moteur évalue à chaque action l'est ici aussi, pour rester vérifiable en test.
 */

export const QUEST_MAX_LIST = 25;
export const QUEST_MAX_REWARDS = 8;
export const QUEST_MESSAGE_MAX = 1500;
export const QUEST_ROLE_MAX_HOURS = 24 * 365;
export const QUEST_ITEM_MAX_QUANTITY = 1000;
export const QUEST_LEVEL_XP_MAX = 1_000_000;

// ── Conditions ────────────────────────────────────────────────────────────

export interface QuestConditions {
  /** L'action doit avoir lieu dans l'un de ces salons (un fil compte pour son salon parent). */
  channelIds?: string[];
  excludeChannelIds?: string[];
  /** Catégories de salons ; un fil compte pour la catégorie de son salon parent. */
  categoryIds?: string[];
  /** Le membre doit porter au moins l'un de ces rôles. */
  roleIds?: string[];
  excludeRoleIds?: string[];
  /** Messages seulement. */
  minLength?: number;
  /** Messages seulement : au moins un de ces mots, sans tenir compte de la casse. */
  keywords?: string[];
  requireAttachment?: boolean;
  requireLink?: boolean;
  requireMention?: boolean;
  /** Jours de la semaine acceptés, 0 = dimanche, dans le fuseau du serveur. */
  weekdays?: number[];
  /** Plage horaire [de, à[ dans le fuseau du serveur ; `de` > `à` passe minuit. */
  hourFrom?: number;
  hourTo?: number;
}

/** Ce que l'action apporte pour être jugée ; un champ absent n'est jamais reproché. */
export interface QuestContext {
  channelId?: string | null;
  categoryId?: string | null;
  content?: string;
  attachmentCount?: number;
  mentionCount?: number;
  /** `undefined` : le moteur ira les chercher si une condition de rôle l'exige. */
  roleIds?: readonly string[];
}

function ids(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.filter((v): v is string => typeof v === 'string' && /^\d{15,25}$/.test(v)))];
  return out.length > 0 ? out.slice(0, QUEST_MAX_LIST) : undefined;
}

function ints(value: unknown, min: number, max: number): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n >= min && n <= max))];
  return out.length > 0 ? out : undefined;
}

function boundedInt(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.trunc(n)) : undefined;
}

/**
 * Nettoie des conditions venues du réseau : rien d'inconnu ne passe, et une clé vide
 * disparaît. L'ancien champ texte `keyword` des quêtes communautaires devient `keywords`.
 */
export function normalizeQuestConditions(input: unknown): QuestConditions | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: QuestConditions = {};

  const set = <K extends keyof QuestConditions>(key: K, value: QuestConditions[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };

  set('channelIds', ids(raw.channelIds));
  set('excludeChannelIds', ids(raw.excludeChannelIds));
  set('categoryIds', ids(raw.categoryIds));
  set('roleIds', ids(raw.roleIds));
  set('excludeRoleIds', ids(raw.excludeRoleIds));
  set('minLength', boundedInt(raw.minLength, 1, 4000));

  const keywordSource = Array.isArray(raw.keywords)
    ? raw.keywords
    : typeof raw.keyword === 'string' ? raw.keyword.split(',') : [];
  const keywords = keywordSource
    .map((k) => (typeof k === 'string' ? k.trim().slice(0, 60) : ''))
    .filter(Boolean)
    .slice(0, QUEST_MAX_LIST);
  if (keywords.length > 0) out.keywords = keywords;

  if (raw.requireAttachment === true) out.requireAttachment = true;
  if (raw.requireLink === true) out.requireLink = true;
  if (raw.requireMention === true) out.requireMention = true;

  const weekdays = ints(raw.weekdays, 0, 6);
  if (weekdays && weekdays.length < 7) out.weekdays = weekdays;

  const from = boundedInt(raw.hourFrom, 0, 23);
  const to = boundedInt(raw.hourTo, 0, 23);
  if (from !== undefined && to !== undefined && from !== to) {
    out.hourFrom = from;
    out.hourTo = to;
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function readQuestConditions(value: unknown): QuestConditions {
  return normalizeQuestConditions(value) ?? {};
}

export function conditionsNeedRoles(conditions: QuestConditions): boolean {
  return Boolean(conditions.roleIds?.length || conditions.excludeRoleIds?.length);
}

const LINK_PATTERN = /https?:\/\/\S+/i;

/** Jour de la semaine et heure dans un fuseau ; UTC si le fuseau est inconnu. */
export function zonedClock(now: Date, timeZone: string): { weekday: number; hour: number } {
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(now);
    const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (weekday >= 0 && Number.isFinite(hour)) return { weekday, hour };
  } catch {
    // Fuseau inconnu : on retombe sur UTC plutôt que de refuser toute action.
  }
  return { weekday: now.getUTCDay(), hour: now.getUTCHours() };
}

/** Vrai si l'action satisfait toutes les conditions. */
export function questConditionsMet(
  conditions: QuestConditions,
  context: QuestContext,
  options: { now?: Date; timeZone?: string } = {},
): boolean {
  const { channelId, categoryId } = context;

  if (conditions.channelIds && channelId && !conditions.channelIds.includes(channelId)) return false;
  if (conditions.channelIds && !channelId) return false;
  if (conditions.excludeChannelIds && channelId && conditions.excludeChannelIds.includes(channelId)) return false;
  if (conditions.categoryIds && !(categoryId && conditions.categoryIds.includes(categoryId))) return false;

  if (conditions.roleIds) {
    const roles = context.roleIds ?? [];
    if (!conditions.roleIds.some((id) => roles.includes(id))) return false;
  }
  if (conditions.excludeRoleIds) {
    const roles = context.roleIds ?? [];
    if (conditions.excludeRoleIds.some((id) => roles.includes(id))) return false;
  }

  const { content } = context;
  if (content !== undefined) {
    if (conditions.minLength && content.trim().length < conditions.minLength) return false;
    if (conditions.keywords) {
      const lower = content.toLowerCase();
      if (!conditions.keywords.some((k) => lower.includes(k.toLowerCase()))) return false;
    }
    if (conditions.requireLink && !LINK_PATTERN.test(content)) return false;
  }
  if (conditions.requireAttachment && (context.attachmentCount ?? 0) < 1) return false;
  if (conditions.requireMention && (context.mentionCount ?? 0) < 1) return false;

  if (conditions.weekdays || conditions.hourFrom !== undefined) {
    const { weekday, hour } = zonedClock(options.now ?? new Date(), options.timeZone ?? 'UTC');
    if (conditions.weekdays && !conditions.weekdays.includes(weekday)) return false;
    if (conditions.hourFrom !== undefined && conditions.hourTo !== undefined) {
      const { hourFrom: from, hourTo: to } = conditions;
      const inside = from < to ? hour >= from && hour < to : hour >= from || hour < to;
      if (!inside) return false;
    }
  }

  return true;
}

// ── Récompenses ───────────────────────────────────────────────────────────

export type QuestReward =
  | { type: 'LEVEL_XP'; amount: number }
  | { type: 'ROLE'; roleId: string; durationHours?: number }
  | { type: 'ITEM'; itemId: string; quantity: number }
  | { type: 'GIVEAWAY_ENTRY'; giveawayId: string }
  | { type: 'MESSAGE'; content: string; channelId?: string };

export const QUEST_REWARD_TYPES = ['LEVEL_XP', 'ROLE', 'ITEM', 'GIVEAWAY_ENTRY', 'MESSAGE'] as const;

function snowflake(value: unknown): string | null {
  return typeof value === 'string' && /^\d{15,25}$/.test(value) ? value : null;
}

/** Une récompense inconnue ou incomplète est écartée : mieux vaut en perdre une qu'en verser une fausse. */
export function normalizeQuestRewards(input: unknown): QuestReward[] | null {
  if (!Array.isArray(input)) return null;
  const out: QuestReward[] = [];

  for (const entry of input.slice(0, QUEST_MAX_REWARDS)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;

    switch (raw.type) {
      case 'LEVEL_XP': {
        const amount = boundedInt(raw.amount, 1, QUEST_LEVEL_XP_MAX);
        if (amount) out.push({ type: 'LEVEL_XP', amount });
        break;
      }
      case 'ROLE': {
        const roleId = snowflake(raw.roleId);
        if (!roleId) break;
        const durationHours = boundedInt(raw.durationHours, 1, QUEST_ROLE_MAX_HOURS);
        out.push(durationHours ? { type: 'ROLE', roleId, durationHours } : { type: 'ROLE', roleId });
        break;
      }
      case 'ITEM': {
        const itemId = typeof raw.itemId === 'string' ? raw.itemId.trim().slice(0, 40) : '';
        const quantity = boundedInt(raw.quantity, 1, QUEST_ITEM_MAX_QUANTITY) ?? 1;
        if (itemId) out.push({ type: 'ITEM', itemId, quantity });
        break;
      }
      case 'GIVEAWAY_ENTRY': {
        const giveawayId = typeof raw.giveawayId === 'string' ? raw.giveawayId.trim().slice(0, 40) : '';
        if (giveawayId) out.push({ type: 'GIVEAWAY_ENTRY', giveawayId });
        break;
      }
      case 'MESSAGE': {
        const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, QUEST_MESSAGE_MAX) : '';
        if (!content) break;
        const channelId = snowflake(raw.channelId);
        out.push(channelId ? { type: 'MESSAGE', content, channelId } : { type: 'MESSAGE', content });
        break;
      }
    }
  }

  return out.length > 0 ? out : null;
}

export function readQuestRewards(value: unknown): QuestReward[] {
  return normalizeQuestRewards(value) ?? [];
}

/** Variables d'un message de récompense : {user}, {quest}, {target}. */
export function renderQuestMessage(template: string, vars: { userId: string; quest: string; target: number }): string {
  return template
    .replaceAll('{user}', `<@${vars.userId}>`)
    .replaceAll('{quest}', vars.quest)
    .replaceAll('{target}', String(vars.target));
}
