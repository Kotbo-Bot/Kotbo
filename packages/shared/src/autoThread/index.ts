/**
 * Fils automatiques : forme d'une configuration, évaluation d'un message et
 * construction du nom du fil.
 *
 * Le bot applique ces règles à chaque message, le dashboard les édite et en
 * montre l'aperçu : un seul contrat évite que les deux divergent. Tout ici est
 * pur (pas de discord.js) : le bot traduit le message en `AutoThreadFacts`.
 */

// ── Vocabulaire ─────────────────────────────────────────────────────────────

/** Messages qui ouvrent un fil. `custom` lit l'arbre de conditions. */
export const AUTO_THREAD_TRIGGERS = ['all', 'text', 'links', 'media', 'custom'] as const;
export type AutoThreadTrigger = (typeof AUTO_THREAD_TRIGGERS)[number];

export const AUTO_THREAD_CONDITION_TYPES = [
  'always',
  'has_text',
  'has_link',
  'has_media',
  'has_attachment',
  'contains',
  'starts_with',
  'matches_regex',
  'min_length',
  'max_length',
  'author_has_role',
  'author_is',
  'is_bot',
  'is_webhook',
  'is_reply',
] as const;
export type AutoThreadConditionType = (typeof AUTO_THREAD_CONDITION_TYPES)[number];

/** Ce que la condition attend comme valeur, pour que le formulaire sache quoi afficher. */
export type AutoThreadConditionValueKind = 'none' | 'text' | 'regex' | 'number' | 'roles' | 'users';

export const AUTO_THREAD_CONDITION_VALUE_KIND: Record<AutoThreadConditionType, AutoThreadConditionValueKind> = {
  always: 'none',
  has_text: 'none',
  has_link: 'none',
  has_media: 'none',
  has_attachment: 'none',
  contains: 'text',
  starts_with: 'text',
  matches_regex: 'regex',
  min_length: 'number',
  max_length: 'number',
  author_has_role: 'roles',
  author_is: 'users',
  is_bot: 'none',
  is_webhook: 'none',
  is_reply: 'none',
};

export interface AutoThreadConditionRule {
  kind: 'rule';
  type: AutoThreadConditionType;
  /** Texte, motif ou nombre selon le type. */
  value?: string;
  /** Rôles ou membres, selon le type. */
  ids?: string[];
  negate?: boolean;
}

export interface AutoThreadConditionGroup {
  kind: 'group';
  /** `all` : toutes les conditions ; `any` : au moins une. */
  op: 'all' | 'any';
  negate?: boolean;
  children: AutoThreadCondition[];
}

export type AutoThreadCondition = AutoThreadConditionRule | AutoThreadConditionGroup;

export const AUTO_THREAD_NAMING_MODES = ['first_line', 'author', 'author_first_line', 'date', 'custom'] as const;
export type AutoThreadNamingMode = (typeof AUTO_THREAD_NAMING_MODES)[number];

export const AUTO_THREAD_NAMING_RULE_TYPES = ['template', 'first_line', 'embed_title', 'regex'] as const;
export type AutoThreadNamingRuleType = (typeof AUTO_THREAD_NAMING_RULE_TYPES)[number];

export interface AutoThreadNamingRule {
  type: AutoThreadNamingRuleType;
  /** `template` : modèle avec placeholders ; `regex` : motif dont le premier groupe sert de titre. */
  value?: string;
}

export const AUTO_THREAD_RENAME_PERMISSIONS = ['moderators', 'author_and_moderators', 'everyone'] as const;
export type AutoThreadRenamePermission = (typeof AUTO_THREAD_RENAME_PERMISSIONS)[number];

export const AUTO_THREAD_REJECT_ACTIONS = ['keep', 'warn', 'delete'] as const;
export type AutoThreadRejectAction = (typeof AUTO_THREAD_REJECT_ACTIONS)[number];

/** Durées d'archivage que Discord accepte, en minutes. */
export const AUTO_THREAD_ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;

export const AUTO_THREAD_PLACEHOLDERS = [
  '{displayName}',
  '{username}',
  '{firstLine}',
  '{content}',
  '{embedTitle}',
  '{channel}',
  '{date}',
  '{time}',
  '{count}',
] as const;

export const AUTO_THREAD_LIMITS = {
  name: 80,
  conditionNodes: 20,
  conditionDepth: 3,
  conditionText: 200,
  conditionIds: 25,
  namingRules: 5,
  namingValue: 100,
  rejectMessage: 500,
  rejectDelayMin: 5,
  rejectDelayMax: 3600,
  threadName: 100,
} as const;

export interface AutoThreadConfigData {
  name: string;
  enabled: boolean;
  trigger: AutoThreadTrigger;
  conditions: AutoThreadCondition | null;
  namingMode: AutoThreadNamingMode;
  namingRules: AutoThreadNamingRule[];
  archiveMinutes: number;
  renamePermission: AutoThreadRenamePermission;
  allowBots: boolean;
  rejectAction: AutoThreadRejectAction;
  rejectDelaySeconds: number;
  rejectMessage: string | null;
}

export function defaultAutoThreadConfig(): AutoThreadConfigData {
  return {
    name: 'Configuration',
    enabled: true,
    trigger: 'all',
    conditions: null,
    namingMode: 'first_line',
    namingRules: [],
    archiveMinutes: 1440,
    renamePermission: 'moderators',
    allowBots: false,
    rejectAction: 'keep',
    rejectDelaySeconds: 60,
    rejectMessage: null,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Codes d'erreur : le dashboard les traduit, l'API les rend en clair. */
export type AutoThreadConfigError =
  | 'name_required'
  | 'conditions_too_large'
  | 'conditions_too_deep'
  | 'condition_value_required'
  | 'regex_invalid'
  | 'regex_unsafe'
  | 'naming_rules_too_many'
  | 'naming_rule_value_required';

export type AutoThreadConfigResult =
  | { ok: true; value: AutoThreadConfigData }
  | { ok: false; error: AutoThreadConfigError };

function pick<T extends string>(list: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === 'string' && (list as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Motifs qui font exploser le temps d'évaluation : un quantificateur appliqué
 * à un groupe qui en contient déjà un, `(a+)+`, `(.*)*`. Le motif est écrit par
 * un admin du serveur mais évalué sur chaque message : on refuse la forme
 * plutôt que d'espérer que personne ne l'écrive.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*{]/;

export function checkAutoThreadRegex(pattern: string): 'regex_invalid' | 'regex_unsafe' | null {
  if (!pattern || pattern.length > AUTO_THREAD_LIMITS.conditionText) return 'regex_invalid';
  if (NESTED_QUANTIFIER.test(pattern)) return 'regex_unsafe';
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch {
    return 'regex_invalid';
  }
}

function normalizeCondition(
  raw: unknown,
  depth: number,
  budget: { nodes: number },
): AutoThreadCondition | AutoThreadConfigError {
  if (!raw || typeof raw !== 'object') return 'condition_value_required';
  budget.nodes += 1;
  if (budget.nodes > AUTO_THREAD_LIMITS.conditionNodes) return 'conditions_too_large';
  const node = raw as Record<string, unknown>;
  const negate = node.negate === true;

  if (node.kind === 'group') {
    if (depth >= AUTO_THREAD_LIMITS.conditionDepth) return 'conditions_too_deep';
    const children: AutoThreadCondition[] = [];
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const normalized = normalizeCondition(child, depth + 1, budget);
      if (typeof normalized === 'string') return normalized;
      children.push(normalized);
    }
    return { kind: 'group', op: node.op === 'any' ? 'any' : 'all', negate, children };
  }

  const type = pick(AUTO_THREAD_CONDITION_TYPES, node.type, 'always');
  const kind = AUTO_THREAD_CONDITION_VALUE_KIND[type];
  const rule: AutoThreadConditionRule = { kind: 'rule', type, negate };

  if (kind === 'text' || kind === 'regex') {
    const value = typeof node.value === 'string' ? node.value.slice(0, AUTO_THREAD_LIMITS.conditionText) : '';
    if (!value.trim()) return 'condition_value_required';
    if (kind === 'regex') {
      const problem = checkAutoThreadRegex(value);
      if (problem) return problem;
    }
    rule.value = value;
  } else if (kind === 'number') {
    rule.value = String(clampInt(node.value, 0, 4000, 0));
  } else if (kind === 'roles' || kind === 'users') {
    const ids = (Array.isArray(node.ids) ? node.ids : [])
      .filter((id): id is string => typeof id === 'string' && SNOWFLAKE.test(id))
      .slice(0, AUTO_THREAD_LIMITS.conditionIds);
    if (ids.length === 0) return 'condition_value_required';
    rule.ids = [...new Set(ids)];
  }
  return rule;
}

function normalizeNamingRule(raw: unknown): AutoThreadNamingRule | AutoThreadConfigError {
  const node = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = pick(AUTO_THREAD_NAMING_RULE_TYPES, node.type, 'template');
  if (type === 'first_line' || type === 'embed_title') return { type };
  const value = typeof node.value === 'string' ? node.value.slice(0, AUTO_THREAD_LIMITS.namingValue) : '';
  if (!value.trim()) return 'naming_rule_value_required';
  if (type === 'regex') {
    const problem = checkAutoThreadRegex(value);
    if (problem) return problem;
  }
  return { type, value };
}

/** Valide une configuration venue du dashboard, d'un import JSON ou de la base. */
export function normalizeAutoThreadConfig(raw: unknown): AutoThreadConfigResult {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = defaultAutoThreadConfig();

  const name = typeof input.name === 'string' ? input.name.trim().slice(0, AUTO_THREAD_LIMITS.name) : base.name;
  if (!name) return { ok: false, error: 'name_required' };

  const trigger = pick(AUTO_THREAD_TRIGGERS, input.trigger, base.trigger);

  let conditions: AutoThreadCondition | null = null;
  if (input.conditions && typeof input.conditions === 'object') {
    const normalized = normalizeCondition(input.conditions, 0, { nodes: 0 });
    if (typeof normalized === 'string') {
      // Un arbre invalide ne bloque que s'il sert : en mode prédéfini, il est
      // simplement oublié.
      if (trigger === 'custom') return { ok: false, error: normalized };
    } else {
      conditions = normalized;
    }
  }

  const namingMode = pick(AUTO_THREAD_NAMING_MODES, input.namingMode, base.namingMode);
  const rawRules = Array.isArray(input.namingRules) ? input.namingRules : [];
  if (rawRules.length > AUTO_THREAD_LIMITS.namingRules) return { ok: false, error: 'naming_rules_too_many' };
  const namingRules: AutoThreadNamingRule[] = [];
  for (const rawRule of rawRules) {
    const rule = normalizeNamingRule(rawRule);
    if (typeof rule === 'string') {
      if (namingMode === 'custom') return { ok: false, error: rule };
      continue;
    }
    namingRules.push(rule);
  }

  const archiveMinutes = (AUTO_THREAD_ARCHIVE_MINUTES as readonly number[]).includes(Number(input.archiveMinutes))
    ? Number(input.archiveMinutes)
    : base.archiveMinutes;

  const rejectMessage = typeof input.rejectMessage === 'string'
    ? input.rejectMessage.trim().slice(0, AUTO_THREAD_LIMITS.rejectMessage) || null
    : null;

  return {
    ok: true,
    value: {
      name,
      enabled: input.enabled !== false,
      trigger,
      conditions,
      namingMode,
      namingRules,
      archiveMinutes,
      renamePermission: pick(AUTO_THREAD_RENAME_PERMISSIONS, input.renamePermission, base.renamePermission),
      allowBots: input.allowBots === true,
      rejectAction: pick(AUTO_THREAD_REJECT_ACTIONS, input.rejectAction, base.rejectAction),
      rejectDelaySeconds: clampInt(
        input.rejectDelaySeconds,
        AUTO_THREAD_LIMITS.rejectDelayMin,
        AUTO_THREAD_LIMITS.rejectDelayMax,
        base.rejectDelaySeconds,
      ),
      rejectMessage,
    },
  };
}

// ── Évaluation d'un message ─────────────────────────────────────────────────

export interface AutoThreadFacts {
  /** Texte du message, mentions déjà résolues en noms. */
  content: string;
  authorId: string;
  authorDisplayName: string;
  authorUsername: string;
  authorRoleIds: string[];
  isBot: boolean;
  isWebhook: boolean;
  isReply: boolean;
  attachmentCount: number;
  /** Images, vidéos et GIF, en pièce jointe ou en aperçu de lien. */
  mediaCount: number;
  /** Titre (ou à défaut description) du premier embed. */
  embedTitle: string;
  channelName: string;
  createdAt: Date;
}

const LINK = /https?:\/\/[^\s<>]+/i;

function hasText(facts: AutoThreadFacts): boolean {
  return facts.content.trim().length > 0;
}

function evaluateRule(rule: AutoThreadConditionRule, facts: AutoThreadFacts): boolean {
  const content = facts.content;
  const value = rule.value ?? '';
  switch (rule.type) {
    case 'always': return true;
    case 'has_text': return hasText(facts);
    case 'has_link': return LINK.test(content);
    case 'has_media': return facts.mediaCount > 0;
    case 'has_attachment': return facts.attachmentCount > 0;
    case 'contains': return content.toLowerCase().includes(value.toLowerCase());
    case 'starts_with': return content.trimStart().toLowerCase().startsWith(value.toLowerCase());
    case 'matches_regex': {
      if (checkAutoThreadRegex(value)) return false;
      return new RegExp(value, 'i').test(content.slice(0, 4000));
    }
    case 'min_length': return content.trim().length >= Number(value || 0);
    case 'max_length': return content.trim().length <= Number(value || 0);
    case 'author_has_role': return (rule.ids ?? []).some((id) => facts.authorRoleIds.includes(id));
    case 'author_is': return (rule.ids ?? []).includes(facts.authorId);
    case 'is_bot': return facts.isBot && !facts.isWebhook;
    case 'is_webhook': return facts.isWebhook;
    case 'is_reply': return facts.isReply;
  }
}

export function evaluateAutoThreadCondition(node: AutoThreadCondition, facts: AutoThreadFacts): boolean {
  let result: boolean;
  if (node.kind === 'group') {
    // Groupe vide : neutre, il accepte (un « tous » sans condition est vrai).
    result = node.children.length === 0
      ? true
      : node.op === 'any'
        ? node.children.some((child) => evaluateAutoThreadCondition(child, facts))
        : node.children.every((child) => evaluateAutoThreadCondition(child, facts));
  } else {
    result = evaluateRule(node, facts);
  }
  return node.negate ? !result : result;
}

/** La configuration accepte-t-elle ce message ? */
export function autoThreadAccepts(
  config: Pick<AutoThreadConfigData, 'trigger' | 'conditions'>,
  facts: AutoThreadFacts,
): boolean {
  switch (config.trigger) {
    case 'all': return true;
    case 'text': return hasText(facts);
    case 'links': return LINK.test(facts.content);
    case 'media': return facts.mediaCount > 0;
    case 'custom': return config.conditions ? evaluateAutoThreadCondition(config.conditions, facts) : true;
  }
}

/**
 * Le déclenchement accepte-t-il forcément tout message ? Le rejet n'a alors
 * jamais l'occasion de s'appliquer : le dashboard le grise et le dit.
 */
export function autoThreadAcceptsEverything(config: Pick<AutoThreadConfigData, 'trigger' | 'conditions'>): boolean {
  if (config.trigger === 'all') return true;
  if (config.trigger !== 'custom') return false;
  const node = config.conditions;
  if (!node) return true;
  if (node.kind === 'rule') return node.type === 'always' && !node.negate;
  return !node.negate && node.children.length === 0;
}

// ── Nom du fil ──────────────────────────────────────────────────────────────

export type AutoThreadLocale = 'fr' | 'en';

export interface AutoThreadNameContext {
  locale: AutoThreadLocale;
  /** Numéro du fil dans la configuration, pour {count}. */
  count: number;
  /** Fuseau des dates ; Paris par défaut, le public du bot étant francophone. */
  timeZone?: string;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Première ligne non vide, débarrassée de la mise en forme Markdown de tête. */
export function firstLineOf(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const clean = collapse(
      line
        .replace(/^\s*(#{1,3}\s+|>\s*|[-*]\s+|\d+\.\s+)/, '')
        .replace(/[*_~`|]+/g, ''),
    );
    if (clean) return clean;
  }
  return '';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatDate(date: Date, ctx: AutoThreadNameContext): { date: string; time: string } {
  const timeZone = ctx.timeZone ?? 'Europe/Paris';
  const locale = ctx.locale === 'fr' ? 'fr-FR' : 'en-GB';
  try {
    return {
      date: new Intl.DateTimeFormat(locale, { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date),
      time: new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' }).format(date),
    };
  } catch {
    return { date: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 16) };
  }
}

function placeholderValues(facts: AutoThreadFacts, ctx: AutoThreadNameContext): Record<string, string> {
  const { date, time } = formatDate(facts.createdAt, ctx);
  return {
    displayName: facts.authorDisplayName,
    username: facts.authorUsername,
    firstLine: firstLineOf(facts.content),
    content: collapse(facts.content),
    embedTitle: collapse(facts.embedTitle),
    channel: facts.channelName,
    date,
    time,
    count: String(ctx.count),
  };
}

/**
 * Remplit un modèle. Un placeholder inconnu reste tel quel ; un placeholder
 * connu mais vide fait échouer le modèle, pour que la règle suivante prenne le
 * relais plutôt que de produire « Bug : ».
 */
export function fillAutoThreadTemplate(
  template: string,
  facts: AutoThreadFacts,
  ctx: AutoThreadNameContext,
): string | null {
  const values = placeholderValues(facts, ctx);
  let missing = false;
  const filled = template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (!(key in values)) return whole;
    if (!values[key]) missing = true;
    return values[key];
  });
  if (missing) return null;
  return collapse(filled) || null;
}

function applyNamingRule(rule: AutoThreadNamingRule, facts: AutoThreadFacts, ctx: AutoThreadNameContext): string | null {
  switch (rule.type) {
    case 'first_line': return firstLineOf(facts.content) || null;
    case 'embed_title': return collapse(facts.embedTitle) || null;
    case 'template': return rule.value ? fillAutoThreadTemplate(rule.value, facts, ctx) : null;
    case 'regex': {
      if (!rule.value || checkAutoThreadRegex(rule.value)) return null;
      const match = new RegExp(rule.value, 'i').exec(facts.content.slice(0, 4000));
      if (!match) return null;
      return collapse(match[1] ?? match[0]) || null;
    }
  }
}

/** Nom du fil pour ce message. Le nom de l'auteur sert toujours de repli. */
export function buildAutoThreadName(
  config: Pick<AutoThreadConfigData, 'namingMode' | 'namingRules'>,
  facts: AutoThreadFacts,
  ctx: AutoThreadNameContext,
): string {
  const author = facts.authorDisplayName || facts.authorUsername || 'Discussion';
  const firstLine = firstLineOf(facts.content) || collapse(facts.embedTitle);
  let name: string | null = null;

  switch (config.namingMode) {
    case 'first_line':
      name = firstLine || null;
      break;
    case 'author':
      name = author;
      break;
    case 'author_first_line': {
      const prefix = ctx.locale === 'fr' ? `Fil de ${author}` : `Thread by ${author}`;
      name = firstLine ? `${prefix} - ${truncate(firstLine, 40)}` : prefix;
      break;
    }
    case 'date': {
      const { date } = formatDate(facts.createdAt, ctx);
      name = `${author} · ${date}`;
      break;
    }
    case 'custom':
      for (const rule of config.namingRules) {
        name = applyNamingRule(rule, facts, ctx);
        if (name) break;
      }
      break;
  }

  return truncate(collapse(name || author), AUTO_THREAD_LIMITS.threadName);
}

/** Message fictif de l'aperçu du dashboard. */
export function sampleAutoThreadFacts(locale: AutoThreadLocale): AutoThreadFacts {
  return {
    content: locale === 'fr'
      ? 'Une idée pour notre communauté\nEt si on organisait un tournoi chaque mois ? https://exemple.fr'
      : 'An idea for our community\nWhat about a monthly tournament? https://example.com',
    authorId: '100000000000000001',
    authorDisplayName: 'Alex',
    authorUsername: 'alex',
    authorRoleIds: [],
    isBot: false,
    isWebhook: false,
    isReply: false,
    attachmentCount: 0,
    mediaCount: 0,
    embedTitle: '',
    channelName: locale === 'fr' ? 'idées' : 'ideas',
    createdAt: new Date(Date.UTC(2026, 9, 10, 14, 30)),
  };
}

// ── Import / export ─────────────────────────────────────────────────────────

export const AUTO_THREAD_EXPORT_KIND = 'kotbo.autothread';

export interface AutoThreadExport {
  kind: typeof AUTO_THREAD_EXPORT_KIND;
  version: 1;
  config: AutoThreadConfigData;
}

export function exportAutoThreadConfig(config: AutoThreadConfigData): AutoThreadExport {
  return { kind: AUTO_THREAD_EXPORT_KIND, version: 1, config };
}

/**
 * Lit un export (ou une configuration nue). Le salon n'en fait pas partie :
 * importer change les règles du brouillon, pas l'endroit où il s'applique.
 */
export function parseAutoThreadImport(text: string): AutoThreadConfigResult | { ok: false; error: 'json_invalid' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json_invalid' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'json_invalid' };
  const wrapper = parsed as Record<string, unknown>;
  const body = wrapper.kind === AUTO_THREAD_EXPORT_KIND && wrapper.config ? wrapper.config : parsed;
  return normalizeAutoThreadConfig(body);
}
