/**
 * Simulation de règles de modération sur des messages passés.
 *
 * Les évaluateurs reprennent à l'identique les tests du filtre en service
 * (`autoModService`, `scamFilterService`) : une simulation qui jugerait
 * autrement que le bot rassurerait à tort. Là où l'historique ne contient pas
 * l'information dont le bot dispose en direct (mentions de rôles, permission
 * de mentionner @everyone), l'écart est assumé et annoncé par `approximate`.
 *
 * Ce fichier ne touche ni la base ni Discord : il reçoit des messages, rend
 * des correspondances. Le chargement vit dans `ruleSimulationService`.
 */
import type { RaidProtectionConfig } from '@prisma/client';
import { getUppercasePercentage } from './capsDetection.js';

/**
 * Détecteur d'arnaques injecté : `scamFilterService` charge l'OCR et la
 * criminalistique d'images, bien trop lourds pour un module de calcul pur.
 */
export type ScamDetector = (content: string, config: RaidProtectionConfig) => { matched: true; domain?: string; pattern: string } | { matched: false };

export type SimulatedRule =
  | { kind: 'spam'; limit: number; intervalSeconds: number }
  | { kind: 'links'; whitelist: string[] }
  | { kind: 'caps'; thresholdPercent: number; minLength: number }
  | { kind: 'emojis'; limit: number }
  | { kind: 'mentions'; limit: number }
  | { kind: 'everyone' }
  | { kind: 'keywords'; keywords: string[]; allowList: string[] }
  | { kind: 'regex'; pattern: string }
  | { kind: 'scam'; whitelist: string[]; customDomains: string[] };

export type SimulatedRuleKind = SimulatedRule['kind'];

export interface SimulatedMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
  mentionCount: number;
  createdAt: Date;
}

export interface RuleMatch {
  /** Raison lisible, comme celle qu'écrirait le bot dans la sanction. */
  detail: string;
  /** Passages à surligner dans le contenu, en indices [début, fin[. */
  highlights: Array<[number, number]>;
}

/** Règles dont la simulation ne peut pas reproduire exactement le bot. */
export const APPROXIMATE_KINDS: ReadonlySet<SimulatedRuleKind> = new Set(['mentions', 'everyone', 'spam']);

export class RuleSimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleSimulationError';
  }
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const stringList = (value: unknown, maxItems = 1000, maxLength = 200): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= maxLength)
      .slice(0, maxItems)
    : [];

/** Imbrication de quantificateurs : la forme classique d'une regex qui s'emballe. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;
export const MAX_REGEX_LENGTH = 300;

/** Valide une règle reçue du dashboard. Lève `RuleSimulationError` si elle est inutilisable. */
export function parseSimulatedRule(raw: unknown): SimulatedRule {
  const body = (raw ?? {}) as Record<string, unknown>;
  switch (body.kind) {
    case 'spam':
      return { kind: 'spam', limit: clampInt(body.limit, 2, 50, 5), intervalSeconds: clampInt(body.intervalSeconds, 1, 60, 5) };
    case 'links':
      return { kind: 'links', whitelist: stringList(body.whitelist).map((d) => d.toLowerCase()) };
    case 'caps':
      return { kind: 'caps', thresholdPercent: clampInt(body.thresholdPercent, 20, 100, 80), minLength: clampInt(body.minLength, 1, 200, 10) };
    case 'emojis':
      return { kind: 'emojis', limit: clampInt(body.limit, 1, 100, 10) };
    case 'mentions':
      return { kind: 'mentions', limit: clampInt(body.limit, 1, 100, 5) };
    case 'everyone':
      return { kind: 'everyone' };
    case 'keywords': {
      const keywords = stringList(body.keywords).map((k) => k.toLowerCase());
      if (keywords.length === 0) throw new RuleSimulationError('Ajoute au moins un mot à tester.');
      return { kind: 'keywords', keywords, allowList: stringList(body.allowList).map((k) => k.toLowerCase()) };
    }
    case 'regex': {
      const pattern = typeof body.pattern === 'string' ? body.pattern : '';
      if (!pattern) throw new RuleSimulationError('Saisis une expression régulière.');
      if (pattern.length > MAX_REGEX_LENGTH) throw new RuleSimulationError(`L'expression dépasse ${MAX_REGEX_LENGTH} caractères.`);
      if (NESTED_QUANTIFIER.test(pattern)) throw new RuleSimulationError('Quantificateurs imbriqués refusés : cette expression risque de bloquer le bot.');
      try {
        new RegExp(pattern, 'iu');
      } catch (err) {
        throw new RuleSimulationError(`Expression invalide : ${err instanceof Error ? err.message : String(err)}`);
      }
      return { kind: 'regex', pattern };
    }
    case 'scam':
      return {
        kind: 'scam',
        whitelist: stringList(body.whitelist).map((d) => d.toLowerCase()),
        customDomains: stringList(body.customDomains).map((d) => d.toLowerCase()),
      };
    default:
      throw new RuleSimulationError('Type de règle inconnu.');
  }
}

// ── Mots-clés, avec la sémantique des filtres natifs de Discord ─────────────
//
// `chat`   : le mot entier          → « chat », « Chat ! », pas « chaton »
// `*chat`  : un mot qui finit ainsi → « tchat », « chat »
// `chat*`  : un mot qui commence ainsi → « chaton », « chat »
// `*chat*` : n'importe où           → « achats »

const WORD = '[\\p{L}\\p{N}_]';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function keywordToRegex(keyword: string): RegExp | null {
  const trimmed = keyword.trim().toLowerCase();
  const prefixWild = trimmed.startsWith('*');
  const suffixWild = trimmed.endsWith('*') && trimmed.length > 1;
  const core = trimmed.replace(/^\*+|\*+$/g, '');
  if (!core) return null;
  const start = prefixWild ? `${WORD}*` : `(?<!${WORD})`;
  const end = suffixWild ? `${WORD}*` : `(?!${WORD})`;
  return new RegExp(`${start}${escapeRegex(core)}${end}`, 'giu');
}

function compileKeywords(keywords: string[]): RegExp[] {
  return keywords.map(keywordToRegex).filter((regex): regex is RegExp => regex !== null);
}

export interface CompiledRule {
  rule: SimulatedRule;
  test: (message: SimulatedMessage) => RuleMatch | null;
}

const INVITE_REGEX = /(discord\.(gg|io|me|li)\/.+|discord\.com\/invite\/.+)/gi;
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI = /[\u{1F300}-\u{1F9FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{1F1E6}-\u{1F1FF}]/gu;

function allMatches(regex: RegExp, content: string, limit = 10): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const global = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
  global.lastIndex = 0;
  for (const match of content.matchAll(global)) {
    if (match.index === undefined || match[0].length === 0) continue;
    ranges.push([match.index, match.index + match[0].length]);
    if (ranges.length >= limit) break;
  }
  return ranges;
}

/**
 * Prépare une règle. Pour une règle d'arnaque, `scam` porte la configuration
 * anti-arnaque du serveur (dont seuls les domaines autorisés et bloqués sont
 * remplacés par ceux de la règle simulée) et le détecteur du filtre.
 */
export function compileRule(
  rule: SimulatedRule,
  scam?: { config: RaidProtectionConfig | null; detect: ScamDetector },
): CompiledRule {
  switch (rule.kind) {
    case 'links':
      return {
        rule,
        test: (message) => {
          if (!new RegExp(INVITE_REGEX.source, 'i').test(message.content)) return null;
          if (rule.whitelist.some((domain) => message.content.includes(domain))) return null;
          return { detail: "Invitation Discord non autorisée", highlights: allMatches(/(discord\.(gg|io|me|li)|discord\.com\/invite)\/\S+/gi, message.content) };
        },
      };
    case 'caps':
      return {
        rule,
        test: (message) => {
          const percent = getUppercasePercentage(message.content, rule.minLength);
          if (percent === null || percent < rule.thresholdPercent) return null;
          return { detail: `${Math.round(percent)} % de majuscules`, highlights: [] };
        },
      };
    case 'emojis':
      return {
        rule,
        test: (message) => {
          const total = (message.content.match(CUSTOM_EMOJI) ?? []).length + (message.content.match(UNICODE_EMOJI) ?? []).length;
          if (total <= rule.limit) return null;
          return { detail: `${total} émojis`, highlights: [] };
        },
      };
    case 'mentions':
      return {
        rule,
        test: (message) => {
          if (message.mentionCount <= rule.limit) return null;
          return { detail: `${message.mentionCount} mentions`, highlights: allMatches(/<@!?\d+>/g, message.content, 20) };
        },
      };
    case 'everyone':
      return {
        rule,
        test: (message) => {
          const ranges = allMatches(/@(everyone|here)/gi, message.content);
          return ranges.length > 0 ? { detail: 'Mention @everyone ou @here', highlights: ranges } : null;
        },
      };
    case 'keywords': {
      const keywordRegexes = compileKeywords(rule.keywords);
      const allowRegexes = compileKeywords(rule.allowList);
      return {
        rule,
        test: (message) => {
          const content = message.content;
          const hits: Array<[number, number]> = [];
          const words: string[] = [];
          keywordRegexes.forEach((regex, index) => {
            for (const [start, end] of allMatches(regex, content)) {
              const hit = content.slice(start, end);
              // Un passage couvert par la liste d'autorisations ne compte pas,
              // comme dans le filtre natif.
              if (allowRegexes.some((allow) => allMatches(allow, hit, 1).length > 0)) continue;
              hits.push([start, end]);
              if (!words.includes(rule.keywords[index])) words.push(rule.keywords[index]);
            }
          });
          if (hits.length === 0) return null;
          return { detail: `Mot interdit : ${words.slice(0, 3).join(', ')}`, highlights: hits.sort((a, b) => a[0] - b[0]) };
        },
      };
    }
    case 'regex': {
      const regex = new RegExp(rule.pattern, 'giu');
      return {
        rule,
        test: (message) => {
          const ranges = allMatches(regex, message.content);
          return ranges.length > 0 ? { detail: 'Expression régulière', highlights: ranges } : null;
        },
      };
    }
    case 'scam': {
      if (!scam) throw new RuleSimulationError("Détecteur d'arnaques indisponible.");
      const detectScam = scam.detect;
      const config = {
        ...(scam.config ?? {}),
        scamFilterWhitelist: rule.whitelist,
        scamFilterCustomDomains: rule.customDomains,
      } as RaidProtectionConfig;
      return {
        rule,
        test: (message) => {
          const result = detectScam(message.content, config);
          if (!result.matched) return null;
          const highlights = result.domain ? allMatches(new RegExp(escapeRegex(result.domain), 'gi'), message.content) : [];
          return { detail: result.domain ? `Domaine suspect : ${result.domain}` : `Motif d'arnaque (${result.pattern.split(':')[0]})`, highlights };
        },
      };
    }
    case 'spam':
      // Le spam se juge sur une suite de messages, pas un message isolé :
      // voir `findSpamBursts`.
      return { rule, test: () => null };
  }
}

/**
 * Messages qui auraient déclenché l'anti-spam : plus de `limit` messages d'un
 * même auteur dans la fenêtre glissante. Attend des messages triés par date.
 */
export function findSpamBursts(messages: SimulatedMessage[], rule: Extract<SimulatedRule, { kind: 'spam' }>): Map<string, RuleMatch> {
  const windowMs = rule.intervalSeconds * 1000;
  const recentByAuthor = new Map<string, number[]>();
  const matches = new Map<string, RuleMatch>();
  for (const message of messages) {
    const at = message.createdAt.getTime();
    const recent = (recentByAuthor.get(message.authorId) ?? []).filter((time) => time > at - windowMs);
    recent.push(at);
    recentByAuthor.set(message.authorId, recent);
    if (recent.length > rule.limit) {
      matches.set(message.messageId, { detail: `${recent.length} messages en ${rule.intervalSeconds} s`, highlights: [] });
    }
  }
  return matches;
}

/**
 * Indice de faux positif, pour attirer l'œil du staff sur les exemples à
 * vérifier en premier. Ce n'est jamais un verdict.
 */
export function falsePositiveHint(message: SimulatedMessage, match: RuleMatch, isStaffAuthor: boolean): string | null {
  if (isStaffAuthor) return 'Écrit par un membre du staff';
  const content = message.content;
  const inCode = match.highlights.some(([start]) => {
    const before = content.slice(0, start);
    return (before.match(/```/g) ?? []).length % 2 === 1 || (before.match(/`/g) ?? []).length % 2 === 1;
  });
  if (inCode) return 'Dans un bloc de code';
  const inQuote = match.highlights.some(([start]) => {
    const lineStart = content.lastIndexOf('\n', start - 1) + 1;
    return content.slice(lineStart, lineStart + 2) === '> ';
  });
  if (inQuote) return 'Dans une citation';
  return null;
}
