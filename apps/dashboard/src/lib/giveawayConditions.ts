/**
 * Conditions de participation d'un giveaway, côté dashboard. Même forme que
 * `GiveawayCondition` du bot (apps/bot/.../giveawayConditions.ts), mais à plat :
 * un formulaire édite un seul objet dont seuls certains champs servent selon `type`.
 * Le serveur revalide tout : ce module sert à l'écran, pas de garde.
 */

export const CONDITION_TYPES = [
  'roles_all', 'roles_any', 'roles_none', 'account_age', 'member_age', 'booster', 'avatar', 'banner',
  'server_tag', 'topgg_vote', 'nickname_contains', 'status_contains', 'messages', 'voice_minutes',
  'invites', 'level', 'xp', 'coins', 'reputation', 'in_guild',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const CONDITION_PERIODS = ['total', '7d', '30d', 'since_start'] as const;
export type ConditionPeriod = (typeof CONDITION_PERIODS)[number];

export type GiveawayConditionDraft = {
  type: ConditionType;
  roleIds?: string[];
  days?: number;
  min?: number;
  period?: ConditionPeriod;
  mode?: 'required' | 'excluded';
  text?: string;
  guildId?: string;
  guildName?: string;
  group?: string;
};

export const ROLE_TYPES: ConditionType[] = ['roles_all', 'roles_any', 'roles_none'];
export const DAYS_TYPES: ConditionType[] = ['account_age', 'member_age'];
export const MIN_TYPES: ConditionType[] = ['messages', 'voice_minutes', 'invites', 'level', 'xp', 'coins', 'reputation'];
export const PERIOD_TYPES: ConditionType[] = ['messages', 'voice_minutes'];
export const TEXT_TYPES: ConditionType[] = ['nickname_contains', 'status_contains'];

/** Valeurs de départ d'un type : seuls les champs qu'il utilise sont posés. */
export function defaultCondition(type: ConditionType, group?: string): GiveawayConditionDraft {
  const base: GiveawayConditionDraft = { type, ...(group ? { group } : {}) };
  if (ROLE_TYPES.includes(type)) base.roleIds = [];
  if (DAYS_TYPES.includes(type)) base.days = 30;
  if (MIN_TYPES.includes(type)) base.min = 1;
  if (PERIOD_TYPES.includes(type)) base.period = 'total';
  if (type === 'booster') base.mode = 'required';
  if (TEXT_TYPES.includes(type)) base.text = '';
  if (type === 'in_guild') base.guildId = '';
  return base;
}

/** Vrai quand le serveur accepterait la condition. Sinon la ligne est signalée et non enregistrée. */
export function isConditionComplete(c: GiveawayConditionDraft): boolean {
  if (ROLE_TYPES.includes(c.type)) return (c.roleIds?.length ?? 0) > 0;
  if (DAYS_TYPES.includes(c.type)) return Number.isInteger(c.days) && (c.days ?? 0) >= 1;
  if (MIN_TYPES.includes(c.type)) return Number.isInteger(c.min) && (c.min ?? 0) >= 1;
  if (TEXT_TYPES.includes(c.type)) return !!c.text?.trim();
  if (c.type === 'in_guild') return /^\d{15,25}$/.test(c.guildId ?? '');
  return true;
}

/**
 * Charge utile envoyée à l'API : uniquement les champs du type, conditions
 * complètes seulement. Un groupe vide est omis.
 */
export function conditionsPayload(list: GiveawayConditionDraft[]): GiveawayConditionDraft[] {
  return list.filter(isConditionComplete).map((c) => {
    const out: GiveawayConditionDraft = { ...defaultCondition(c.type) };
    for (const key of Object.keys(out) as Array<keyof GiveawayConditionDraft>) {
      (out as Record<string, unknown>)[key] = c[key];
    }
    if (c.type === 'in_guild' && c.guildName) out.guildName = c.guildName;
    const group = c.group?.trim();
    if (group) out.group = group;
    return out;
  });
}

/** Filtre du serveur (onglet Configuration) traduit en conditions de départ. */
export function conditionsFromServerFilter(cfg: {
  requiredRoleIds?: string[];
  blockedRoleIds?: string[];
  minAccountAgeDays?: number;
  minMemberAgeDays?: number;
  minLevel?: number;
}): GiveawayConditionDraft[] {
  const list: GiveawayConditionDraft[] = [];
  if (cfg.requiredRoleIds?.length) list.push({ type: 'roles_any', roleIds: [...cfg.requiredRoleIds] });
  if (cfg.blockedRoleIds?.length) list.push({ type: 'roles_none', roleIds: [...cfg.blockedRoleIds] });
  if (cfg.minAccountAgeDays) list.push({ type: 'account_age', days: cfg.minAccountAgeDays });
  if (cfg.minMemberAgeDays) list.push({ type: 'member_age', days: cfg.minMemberAgeDays });
  if (cfg.minLevel) list.push({ type: 'level', min: cfg.minLevel });
  return list;
}
