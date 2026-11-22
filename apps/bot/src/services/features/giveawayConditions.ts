/**
 * Conditions de participation propres à un giveaway.
 *
 * Module pur : aucune lecture en base ni appel Discord. Les données du membre
 * arrivent dans `ConditionSubject`, les compteurs (messages, vocal, vote…) par
 * des `ConditionResolvers` injectés. Le service les branche sur la base ; les
 * tests les remplacent par des constantes.
 *
 * Logique : toutes les conditions sont obligatoires (ET), sauf celles qui
 * partagent un `group` : un groupe est satisfait dès qu'une des siennes l'est.
 */

export const MAX_CONDITIONS = 15;
const MAX_ROLES = 25;
const MAX_TEXT = 64;
const SNOWFLAKE = /^\d{15,25}$/;

export const CONDITION_PERIODS = ['total', '7d', '30d', 'since_start'] as const;
export type ConditionPeriod = (typeof CONDITION_PERIODS)[number];

export const PERIOD_STATS = ['messages', 'voice_minutes'] as const;
export type PeriodStat = (typeof PERIOD_STATS)[number];

/** Compteurs sans période : lus tels quels (invitations restées incluses). */
export const FLAT_STATS = ['invites', 'level', 'xp', 'coins', 'reputation'] as const;
export type FlatStat = (typeof FLAT_STATS)[number];

type Base = {
  /** Même valeur = même groupe « au moins une ». Absent = obligatoire. */
  group?: string;
};

export type GiveawayCondition = Base & (
  | { type: 'roles_all' | 'roles_any' | 'roles_none'; roleIds: string[] }
  | { type: 'account_age' | 'member_age'; days: number }
  | { type: 'booster'; mode: 'required' | 'excluded' }
  | { type: 'avatar' | 'banner' | 'server_tag' | 'topgg_vote' }
  | { type: 'nickname_contains' | 'status_contains'; text: string }
  | { type: PeriodStat; min: number; period: ConditionPeriod }
  | { type: FlatStat; min: number }
  | { type: 'in_guild'; guildId: string }
);

export type ConditionType = GiveawayCondition['type'];

/** Ce que le service sait du membre au clic, tel que Discord le transmet. */
export type ConditionSubject = {
  userId: string;
  guildId: string;
  roleIds: string[];
  accountCreatedAt: Date | null;
  joinedAt: Date | null;
  /** `null` = inconnu : une donnée absente laisse passer, jamais l'inverse. */
  isBooster: boolean | null;
  hasAvatar: boolean | null;
  hasBanner: boolean | null;
  hasServerTag: boolean | null;
  nickname: string | null;
  /** `undefined` quand l'intent Presences est absent : la condition ne se pose alors pas. */
  customStatus: string | null | undefined;
  /** Début du giveaway, pour la période `since_start`. */
  startedAt: Date;
};

export type ConditionResolvers = {
  periodStat: (stat: PeriodStat, period: ConditionPeriod, since: Date) => Promise<number | null>;
  flatStat: (stat: FlatStat) => Promise<number | null>;
  hasVotedTopgg: () => Promise<boolean | null>;
  isInGuild: (guildId: string) => Promise<boolean | null>;
};

export type ConditionFailure = {
  condition: GiveawayCondition;
  /** Renseigné si l'échec est celui d'un groupe entier. */
  group?: string;
};

export type ConditionsResult = { allowed: boolean; failures: ConditionFailure[] };

const DAY_MS = 86_400_000;
const daysSince = (date: Date, now = Date.now()) => (now - date.getTime()) / DAY_MS;
const containsText = (haystack: string | null | undefined, needle: string) =>
  (haystack ?? '').toLowerCase().includes(needle.toLowerCase());

/** Vrai = remplie, faux = manquante, `null` = donnée inconnue (laisse passer). */
async function check(
  c: GiveawayCondition,
  s: ConditionSubject,
  r: ConditionResolvers,
): Promise<boolean | null> {
  switch (c.type) {
    case 'roles_all': return c.roleIds.every((id) => s.roleIds.includes(id));
    case 'roles_any': return c.roleIds.some((id) => s.roleIds.includes(id));
    case 'roles_none': return !c.roleIds.some((id) => s.roleIds.includes(id));
    case 'account_age': return s.accountCreatedAt ? daysSince(s.accountCreatedAt) >= c.days : null;
    case 'member_age': return s.joinedAt ? daysSince(s.joinedAt) >= c.days : null;
    case 'booster': return s.isBooster === null ? null : (c.mode === 'required') === s.isBooster;
    case 'avatar': return s.hasAvatar;
    case 'banner': return s.hasBanner;
    case 'server_tag': return s.hasServerTag;
    case 'nickname_contains': return s.nickname === null ? null : containsText(s.nickname, c.text);
    case 'status_contains': return s.customStatus === undefined ? null : containsText(s.customStatus, c.text);
    case 'topgg_vote': return r.hasVotedTopgg();
    case 'in_guild': return r.isInGuild(c.guildId);
    case 'messages':
    case 'voice_minutes': {
      const value = await r.periodStat(c.type, c.period, s.startedAt);
      return value === null ? null : value >= c.min;
    }
    default: {
      const value = await r.flatStat(c.type);
      return value === null ? null : value >= c.min;
    }
  }
}

/**
 * Évalue toutes les conditions et rend **chaque** manquement, pas seulement le
 * premier : le membre voit en une fois ce qu'il lui reste à faire.
 */
export async function evaluateConditions(
  conditions: GiveawayCondition[],
  subject: ConditionSubject,
  resolvers: ConditionResolvers,
): Promise<ConditionsResult> {
  const results = await Promise.all(
    conditions.map(async (condition) => ({ condition, ok: (await check(condition, subject, resolvers)) !== false })),
  );

  const failures: ConditionFailure[] = [];
  const groups = new Map<string, typeof results>();
  for (const entry of results) {
    const group = entry.condition.group;
    if (!group) {
      if (!entry.ok) failures.push({ condition: entry.condition });
    } else {
      groups.set(group, [...(groups.get(group) ?? []), entry]);
    }
  }
  for (const [group, entries] of groups) {
    if (entries.some((e) => e.ok)) continue;
    for (const e of entries) failures.push({ condition: e.condition, group });
  }

  return { allowed: failures.length === 0, failures };
}

/** Borne basse de la période, en clef de jour `YYYY-MM-DD` (UTC). `null` = sans borne. */
export function periodStartKey(period: ConditionPeriod, startedAt: Date, now = new Date()): string | null {
  if (period === 'total') return null;
  const from = period === 'since_start'
    ? startedAt
    : new Date(now.getTime() - (period === '7d' ? 7 : 30) * DAY_MS);
  return from.toISOString().slice(0, 10);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  return text && text.length <= MAX_TEXT ? text : null;
}

function cleanRoles(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && SNOWFLAKE.test(x)))];
  return ids.length > 0 && ids.length <= MAX_ROLES ? ids : null;
}

const cleanInt = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

function normalizeOne(raw: unknown): GiveawayCondition | null {
  if (!isObject(raw) || typeof raw.type !== 'string') return null;
  const group = cleanText(raw.group) ?? undefined;
  const make = (c: GiveawayCondition | null) => (c ? (group ? { ...c, group } : c) : null);

  switch (raw.type) {
    case 'roles_all': case 'roles_any': case 'roles_none': {
      const roleIds = cleanRoles(raw.roleIds);
      return make(roleIds ? { type: raw.type, roleIds } : null);
    }
    case 'account_age': case 'member_age': {
      const days = cleanInt(raw.days, 1, 3650);
      return make(days ? { type: raw.type, days } : null);
    }
    case 'booster':
      return make(raw.mode === 'required' || raw.mode === 'excluded' ? { type: 'booster', mode: raw.mode } : null);
    case 'avatar': case 'banner': case 'server_tag': case 'topgg_vote':
      return make({ type: raw.type });
    case 'nickname_contains': case 'status_contains': {
      const text = cleanText(raw.text);
      return make(text ? { type: raw.type, text } : null);
    }
    case 'messages': case 'voice_minutes': {
      const min = cleanInt(raw.min, 1, 10_000_000);
      const period = CONDITION_PERIODS.find((p) => p === raw.period);
      return make(min && period ? { type: raw.type, min, period } : null);
    }
    case 'invites': case 'level': case 'xp': case 'coins': case 'reputation': {
      const min = cleanInt(raw.min, 1, 2_000_000_000);
      return make(min ? { type: raw.type, min } : null);
    }
    case 'in_guild': {
      const guildId = typeof raw.guildId === 'string' && SNOWFLAKE.test(raw.guildId) ? raw.guildId : null;
      return make(guildId ? { type: 'in_guild', guildId } : null);
    }
    default:
      return null;
  }
}

/**
 * Nettoie une liste reçue du dashboard, de la commande ou d'une clé MCP.
 * Une condition invalide est écartée plutôt que d'échouer en silence au clic :
 * `rejected` dit combien, pour que l'appelant puisse le signaler.
 */
export function normalizeConditions(raw: unknown): { conditions: GiveawayCondition[]; rejected: number } {
  if (!Array.isArray(raw)) return { conditions: [], rejected: raw == null ? 0 : 1 };
  const list = raw.slice(0, MAX_CONDITIONS).map(normalizeOne);
  const conditions = list.filter((c): c is GiveawayCondition => c !== null);
  return { conditions, rejected: raw.length - conditions.length };
}
