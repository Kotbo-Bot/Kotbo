/**
 * Logique pure de l'automod des tags : correspondance des règles, détection
 * d'imitation du tag du serveur, choix de la réponse la plus forte et seuils
 * de vague. Aucun accès Discord ni base : testable seule.
 */

import { TAG_PRESET_LISTS, isTagPresetCategory } from '@kotbo/shared';

export const TAG_ACTIONS = ['ALERT', 'DM', 'TICKET', 'ROLE', 'WARN', 'TIMEOUT', 'JAIL', 'KICK', 'SOFTBAN', 'BAN'] as const;
export type TagAction = (typeof TAG_ACTIONS)[number];

/** Ordre de gravité : sert à garder la réponse la plus forte quand plusieurs s'appliquent. */
const SEVERITY: Record<TagAction, number> = {
  ALERT: 0, DM: 1, TICKET: 2, ROLE: 3, WARN: 4, TIMEOUT: 5, JAIL: 6, KICK: 7, SOFTBAN: 8, BAN: 9,
};

export function normalizeTagAction(value: unknown, fallback: TagAction = 'ALERT'): TagAction {
  return TAG_ACTIONS.includes(value as TagAction) ? (value as TagAction) : fallback;
}

export function isSanctionAction(action: TagAction): boolean {
  return SEVERITY[action] >= SEVERITY.WARN;
}

export type TagTrigger =
  | 'JOIN' | 'TAG_CHANGE' | 'RESCAN' | 'WAVE' | 'NEW_ACCOUNT' | 'MASS_ADOPT'
  | 'IMPERSONATION' | 'SHARED_LIST' | 'PRESET_LIST' | 'ALLOWLIST' | 'ESCALATION';

export type DisplayedTag = { guildId: string; tag: string | null };

export type RuleLike = {
  id: string;
  name: string;
  enabled: boolean;
  effect: string;
  targetType: string;
  targetGuildId: string | null;
  pattern: string | null;
  matchMode: string;
  action: string;
  durationMin: number | null;
  roleId: string | null;
  message: string | null;
  escalateAfterMin: number | null;
  escalateAction: string | null;
  escalateDurationMin: number | null;
  expiresAt: Date | null;
};

export type ConfigLike = {
  allowlistOnly: boolean;
  allowlistAction: string;
  allowlistDurationMin: number | null;
  sharedListEnabled: boolean;
  sharedListAction: string;
  sharedListDurationMin: number | null;
  newAccountEnabled: boolean;
  newAccountDays: number;
  newAccountScope: string;
  newAccountAction: string;
  newAccountDurationMin: number | null;
  impersonationEnabled: boolean;
  impersonationAction: string;
  impersonationDurationMin: number | null;
  /** Catégories de listes prédéfinies activées ; vide = détection éteinte. */
  presetCategories: string[];
  presetAction: string;
  presetDurationMin: number | null;
  /** Tags retirés des listes par le serveur (faux positifs). */
  presetExcluded: string[];
};

export type TagHit = {
  trigger: TagTrigger;
  action: TagAction;
  durationMin: number | null;
  rule: RuleLike | null;
  roleId: string | null;
  message: string | null;
  escalateAfterMin: number | null;
  escalateAction: TagAction | null;
  escalateDurationMin: number | null;
};

// Lettres d'autres alphabets et chiffres qui se lisent comme des lettres latines.
const CONFUSABLES: Record<string, string> = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'l',
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't',
  'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p',
  'τ': 't', 'κ': 'k', 'ι': 'i', 'β': 'b', 'ε': 'e',
};

/** Squelette d'un tag : minuscules, sans accents, homoglyphes ramenés au latin, I/l confondus. */
export function tagSkeleton(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split('')
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join('')
    .replace(/i/g, 'l')
    .replace(/[^a-z0-9]/g, '');
}

/** Un tag imite-t-il celui du serveur ? Le vrai tag (même serveur) n'est jamais une imitation. */
export function isImpersonatingTag(tag: DisplayedTag, ownGuildId: string, ownTag: string | null): boolean {
  if (!ownTag || !tag.tag || tag.guildId === ownGuildId) return false;
  const a = tagSkeleton(tag.tag);
  return a.length > 0 && a === tagSkeleton(ownTag);
}

function patternMatches(pattern: string, mode: string, tag: string): boolean {
  if (mode === 'REGEX') {
    if (pattern.length > 200) return false;
    try {
      return new RegExp(pattern, 'iu').test(tag);
    } catch {
      return false;
    }
  }
  const t = tag.toLowerCase();
  const p = pattern.toLowerCase();
  if (mode === 'CONTAINS') return t.includes(p) || tagSkeleton(tag).includes(tagSkeleton(pattern));
  return t === p || (tagSkeleton(tag) !== '' && tagSkeleton(tag) === tagSkeleton(pattern));
}

/**
 * Entrée des listes prédéfinies qui correspond au tag, ou null. Un code en
 * lettres compte aussi sous ses imitations ; un code chiffré seulement tel quel.
 */
export function matchPresetTag(tag: string, categories: readonly string[], excluded: readonly string[]): string | null {
  const shown = tag.trim().toUpperCase();
  if (!shown || excluded.some((entry) => entry.toUpperCase() === shown)) return null;
  for (const category of categories) {
    if (!isTagPresetCategory(category)) continue;
    for (const entry of TAG_PRESET_LISTS[category]) {
      if (excluded.some((ex) => ex.toUpperCase() === entry)) continue;
      const matches = /\d/.test(entry) ? shown === entry : patternMatches(entry, 'EXACT', tag);
      if (matches) return entry;
    }
  }
  return null;
}

export function isRuleActive(rule: RuleLike, now = Date.now()): boolean {
  return rule.enabled && (!rule.expiresAt || rule.expiresAt.getTime() > now);
}

export function ruleMatches(rule: RuleLike, tag: DisplayedTag, now = Date.now()): boolean {
  if (!isRuleActive(rule, now)) return false;
  if (rule.targetType === 'SERVER') return Boolean(rule.targetGuildId) && rule.targetGuildId === tag.guildId;
  if (rule.targetType === 'TEXT') return Boolean(rule.pattern && tag.tag) && patternMatches(rule.pattern!, rule.matchMode, tag.tag!);
  return false;
}

/** Le tag est-il explicitement autorisé (règle « autoriser ») ? */
export function isAllowed(rules: RuleLike[], tag: DisplayedTag, now = Date.now()): boolean {
  return rules.some((rule) => rule.effect === 'ALLOW' && ruleMatches(rule, tag, now));
}

function hit(trigger: TagTrigger, action: string, durationMin: number | null, extra: Partial<TagHit> = {}): TagHit {
  return {
    trigger,
    action: normalizeTagAction(action),
    durationMin,
    rule: null,
    roleId: null,
    message: null,
    escalateAfterMin: null,
    escalateAction: null,
    escalateDurationMin: null,
    ...extra,
  };
}

function strongest(hits: TagHit[]): TagHit | null {
  return hits.reduce<TagHit | null>((best, h) => (!best || SEVERITY[h.action] > SEVERITY[best.action] ? h : best), null);
}

export type DecideContext = {
  tag: DisplayedTag;
  trigger: TagTrigger;
  ownGuildId: string;
  ownTag: string | null;
  accountAgeDays: number;
  sharedFlagged: boolean;
  now?: number;
};

/**
 * Choisit la réponse à un tag affiché. Le tag du serveur lui-même et un tag
 * autorisé explicitement ne déclenchent jamais rien ; sinon la réponse la plus
 * forte parmi les règles « bloquer » et les détections l'emporte.
 */
export function decideTag(config: ConfigLike, rules: RuleLike[], ctx: DecideContext): TagHit | null {
  const { tag } = ctx;
  if (tag.guildId === ctx.ownGuildId) return null;
  const now = ctx.now ?? Date.now();
  const recentAccount = config.newAccountEnabled && ctx.accountAgeDays < config.newAccountDays;
  if (isAllowed(rules, tag, now)) {
    // ANY : même un tag autorisé ne dispense pas un compte tout neuf.
    return recentAccount && config.newAccountScope === 'ANY'
      ? hit('NEW_ACCOUNT', config.newAccountAction, config.newAccountDurationMin)
      : null;
  }

  const hits: TagHit[] = [];
  for (const rule of rules) {
    if (rule.effect !== 'BLOCK' || !ruleMatches(rule, tag, now)) continue;
    hits.push(hit(ctx.trigger, rule.action, rule.durationMin, {
      rule,
      roleId: rule.roleId,
      message: rule.message,
      escalateAfterMin: rule.escalateAfterMin,
      escalateAction: rule.escalateAction ? normalizeTagAction(rule.escalateAction) : null,
      escalateDurationMin: rule.escalateDurationMin,
    }));
  }
  if (config.sharedListEnabled && ctx.sharedFlagged) {
    hits.push(hit('SHARED_LIST', config.sharedListAction, config.sharedListDurationMin));
  }
  if (config.presetCategories.length > 0 && tag.tag && matchPresetTag(tag.tag, config.presetCategories, config.presetExcluded)) {
    hits.push(hit('PRESET_LIST', config.presetAction, config.presetDurationMin));
  }
  if (config.allowlistOnly) {
    hits.push(hit('ALLOWLIST', config.allowlistAction, config.allowlistDurationMin));
  }
  if (recentAccount) {
    hits.push(hit('NEW_ACCOUNT', config.newAccountAction, config.newAccountDurationMin));
  }
  if (config.impersonationEnabled && isImpersonatingTag(tag, ctx.ownGuildId, ctx.ownTag)) {
    hits.push(hit('IMPERSONATION', config.impersonationAction, config.impersonationDurationMin));
  }
  return strongest(hits);
}

// ── Vagues d'arrivées ────────────────────────────────────────────────────────

export const WAVE_PRESETS = {
  SOFT: { threshold: 8, windowSec: 60 },
  NORMAL: { threshold: 5, windowSec: 120 },
  STRICT: { threshold: 3, windowSec: 300 },
} as const;
export type WavePreset = keyof typeof WAVE_PRESETS;

/**
 * Seuil de vague. FIXED : valeurs saisies. ADAPTIVE : le préréglage sert de
 * plancher, relevé quand le serveur reçoit beaucoup d'arrivées en temps normal
 * (trois fois le nombre d'arrivées attendues dans la fenêtre, plus deux).
 */
export function waveThreshold(
  config: { waveMode: string; wavePreset: string; waveThreshold: number; waveWindowSec: number },
  joinsPerDay: number,
): { threshold: number; windowSec: number } {
  if (config.waveMode === 'FIXED') {
    return { threshold: Math.max(2, config.waveThreshold), windowSec: Math.max(10, config.waveWindowSec) };
  }
  const preset = WAVE_PRESETS[(config.wavePreset as WavePreset) in WAVE_PRESETS ? (config.wavePreset as WavePreset) : 'NORMAL'];
  const expected = (Math.max(0, joinsPerDay) * preset.windowSec) / 86_400;
  return { threshold: Math.max(preset.threshold, Math.ceil(expected * 3) + 2), windowSec: preset.windowSec };
}

/** Remplace {user}, {tag}, {server} et {delay} dans le texte d'un ticket ou d'un MP. */
export function renderTagMessage(template: string, vars: { user: string; tag: string; server: string; delay: string }): string {
  return template
    .replace(/\{user\}/g, vars.user)
    .replace(/\{tag\}/g, vars.tag)
    .replace(/\{server\}/g, vars.server)
    .replace(/\{delay\}/g, vars.delay);
}
