/**
 * Blocs de modules du site communautaire.
 *
 * Un bloc de module est un nœud `module` du document, d'attributs
 * `{ module, config }`. Ce catalogue dit, pour chacun : sa catégorie dans le
 * menu `/` de l'éditeur, le module du bot dont il dépend (éteint = bloc masqué
 * sur le site, signalé dans l'éditeur), s'il a besoin du visiteur connecté, et
 * comment ramener sa configuration à des valeurs sûres.
 *
 * Les libellés vivent dans les fichiers de messages du dashboard et du bot,
 * sous `site_module_<clé>`.
 */

export const SITE_MODULE_CATEGORIES = ['vitrine', 'demarches', 'engagement', 'membre', 'contenus', 'discord'] as const;
export type SiteModuleCategory = (typeof SITE_MODULE_CATEGORIES)[number];

export const SITE_LEADERBOARD_VARIANTS = ['xp', 'prestige', 'reputation', 'season', 'economy'] as const;
export const SITE_CLAN_VARIANTS = ['leveling', 'rpg'] as const;
export const SITE_GIVEAWAY_FILTERS = ['active', 'ended', 'all'] as const;
export const SITE_STAFF_LAYOUTS = ['grid', 'org'] as const;
export const SITE_LIST_LAYOUTS = ['cards', 'list'] as const;
export const SITE_SUGGESTION_FILTERS = ['open', 'accepted', 'all'] as const;
/** Chiffres que le bloc « Chiffres clés » sait calculer ; `custom` = valeur saisie. */
export const SITE_KEY_STAT_METRICS = ['members', 'online', 'boosts', 'channels', 'messages30d', 'voiceHours30d', 'joined30d', 'wikiPages', 'blogArticles', 'custom'] as const;
export type SiteKeyStatMetric = (typeof SITE_KEY_STAT_METRICS)[number];

interface ModuleSpec {
  category: SiteModuleCategory;
  /** Clé du registre de modules du bot. Nul = toujours disponible. */
  botModule: string | null;
  /** Le bloc n'a de sens que pour un membre connecté (rendu côté client). */
  needsViewer: boolean;
  /** Le bloc agit (écrit) au nom du visiteur. */
  interactive: boolean;
  /** Le bloc affiche des données qui changent en direct (rafraîchies par le script). */
  live: boolean;
  defaults: Record<string, unknown>;
}

const SNOWFLAKE = /^\d{17,20}$/;
const CUID = /^[a-z0-9]{20,32}$/i;

export const SITE_MODULES = {
  // Vitrine
  staff: { category: 'vitrine', botModule: 'staff_directory', needsViewer: false, interactive: false, live: false, defaults: { layout: 'grid', hierarchyIds: [] } },
  rules: { category: 'vitrine', botModule: 'regulation', needsViewer: false, interactive: false, live: false, defaults: {} },
  news: { category: 'vitrine', botModule: 'news', needsViewer: false, interactive: false, live: false, defaults: { limit: 6, layout: 'cards' } },
  partners: { category: 'vitrine', botModule: null, needsViewer: false, interactive: false, live: false, defaults: { items: [] } },
  serverStats: { category: 'vitrine', botModule: null, needsViewer: false, interactive: false, live: true, defaults: {} },
  keyStats: {
    category: 'vitrine',
    botModule: null,
    needsViewer: false,
    interactive: false,
    live: false,
    defaults: { items: [{ metric: 'members', label: '', value: '' }, { metric: 'online', label: '', value: '' }, { metric: 'messages30d', label: '', value: '' }] },
  },

  // Démarches
  appeal: { category: 'demarches', botModule: 'ban_appeals', needsViewer: true, interactive: true, live: false, defaults: {} },
  recruitment: { category: 'demarches', botModule: 'recruitment', needsViewer: false, interactive: true, live: false, defaults: { formIds: [] } },
  form: { category: 'demarches', botModule: 'custom_forms', needsViewer: false, interactive: true, live: false, defaults: { formId: '' } },
  ticket: { category: 'demarches', botModule: 'tickets', needsViewer: true, interactive: true, live: true, defaults: {} },
  suggestions: { category: 'demarches', botModule: 'suggestions', needsViewer: false, interactive: true, live: false, defaults: { limit: 10, filter: 'open', allowSubmit: true } },

  // Engagement
  leaderboard: { category: 'engagement', botModule: 'leveling', needsViewer: false, interactive: false, live: false, defaults: { variant: 'xp', limit: 10 } },
  clans: { category: 'engagement', botModule: 'clans', needsViewer: false, interactive: false, live: false, defaults: { variant: 'leveling', limit: 10 } },
  giveaways: { category: 'engagement', botModule: 'giveaways', needsViewer: false, interactive: true, live: true, defaults: { filter: 'active', limit: 6 } },
  events: { category: 'engagement', botModule: 'events', needsViewer: false, interactive: true, live: false, defaults: { limit: 6, layout: 'cards' } },
  seasons: { category: 'engagement', botModule: 'seasons', needsViewer: false, interactive: false, live: false, defaults: { limit: 10 } },
  marketplace: { category: 'engagement', botModule: 'marketplace', needsViewer: false, interactive: true, live: false, defaults: { limit: 12 } },
  starboard: { category: 'engagement', botModule: 'starboard', needsViewer: false, interactive: false, live: false, defaults: { limit: 6 } },
  vote: { category: 'engagement', botModule: null, needsViewer: true, interactive: true, live: false, defaults: {} },
  voteLeaderboard: { category: 'engagement', botModule: null, needsViewer: false, interactive: false, live: false, defaults: { limit: 10 } },
  shop: { category: 'engagement', botModule: 'economy', needsViewer: false, interactive: true, live: false, defaults: { category: '' } },
  profile: { category: 'membre', botModule: null, needsViewer: true, interactive: false, live: false, defaults: {} },
  memberSettings: { category: 'membre', botModule: null, needsViewer: true, interactive: true, live: false, defaults: {} },
  memberRewards: { category: 'membre', botModule: null, needsViewer: true, interactive: false, live: false, defaults: {} },
  memberInventory: { category: 'membre', botModule: 'economy', needsViewer: true, interactive: false, live: false, defaults: {} },
  memberPurchases: { category: 'membre', botModule: 'economy', needsViewer: true, interactive: true, live: false, defaults: {} },
  memberQuests: { category: 'membre', botModule: 'quests', needsViewer: true, interactive: false, live: false, defaults: {} },
  memberApplications: { category: 'membre', botModule: null, needsViewer: true, interactive: false, live: false, defaults: {} },

  // Contenus
  wikiIndex: { category: 'contenus', botModule: null, needsViewer: false, interactive: false, live: false, defaults: { parentId: '' } },
  blogList: { category: 'contenus', botModule: null, needsViewer: false, interactive: false, live: false, defaults: { limit: 6, tag: '', layout: 'cards' } },
  search: { category: 'contenus', botModule: null, needsViewer: false, interactive: false, live: false, defaults: {} },
  changelog: { category: 'contenus', botModule: null, needsViewer: false, interactive: false, live: false, defaults: { days: 30, limit: 15 } },

  // Discord en direct
  members: { category: 'discord', botModule: null, needsViewer: false, interactive: false, live: true, defaults: {} },
  join: { category: 'discord', botModule: null, needsViewer: false, interactive: false, live: false, defaults: { label: '' } },
  voice: { category: 'discord', botModule: null, needsViewer: false, interactive: false, live: true, defaults: {} },
  channelFeed: { category: 'discord', botModule: null, needsViewer: false, interactive: false, live: true, defaults: { channelId: '', limit: 5 } },
} as const satisfies Record<string, ModuleSpec>;

export type SiteModuleKey = keyof typeof SITE_MODULES;
export const SITE_MODULE_KEYS = Object.keys(SITE_MODULES) as SiteModuleKey[];

export function isSiteModuleKey(value: unknown): value is SiteModuleKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SITE_MODULES, value);
}

export function getSiteModuleSpec(key: SiteModuleKey): ModuleSpec {
  return SITE_MODULES[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function ids(value: unknown, pattern: RegExp, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && pattern.test(v)))].slice(0, max);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function httpsUrl(value: unknown): string {
  const raw = text(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export interface SiteKeyStatItem {
  metric: SiteKeyStatMetric;
  /** Libellé affiché ; vide = libellé par défaut du chiffre. */
  label: string;
  /** Valeur saisie, pour `custom` seulement. */
  value: string;
}

export interface SitePartnerItem {
  name: string;
  description: string;
  logoUrl: string;
  url: string;
}

/** Configuration d'un bloc ramenée à des valeurs sûres et bornées. */
export function normalizeModuleConfig(key: SiteModuleKey, raw: unknown): Record<string, unknown> {
  const input = isRecord(raw) ? raw : {};
  switch (key) {
    case 'staff':
      return { layout: oneOf(input.layout, SITE_STAFF_LAYOUTS, 'grid'), hierarchyIds: ids(input.hierarchyIds, CUID) };
    case 'news':
      return { limit: int(input.limit, 1, 24, 6), layout: oneOf(input.layout, SITE_LIST_LAYOUTS, 'cards') };
    case 'partners': {
      const items: SitePartnerItem[] = (Array.isArray(input.items) ? input.items : [])
        .filter(isRecord)
        .slice(0, 48)
        .map((item) => ({
          name: text(item.name, 80),
          description: text(item.description, 400),
          logoUrl: httpsUrl(item.logoUrl).startsWith('https:') ? httpsUrl(item.logoUrl) : '',
          url: httpsUrl(item.url),
        }))
        .filter((item) => item.name);
      return { items };
    }
    case 'keyStats': {
      const items: SiteKeyStatItem[] = (Array.isArray(input.items) ? input.items : [])
        .filter(isRecord)
        .slice(0, 6)
        .map((item) => ({ metric: oneOf(item.metric, SITE_KEY_STAT_METRICS, 'members'), label: text(item.label, 40), value: text(item.value, 20) }))
        .filter((item) => item.metric !== 'custom' || (item.value && item.label));
      return { items };
    }
    case 'recruitment':
      return { formIds: ids(input.formIds, CUID) };
    case 'form':
      return { formId: CUID.test(String(input.formId ?? '')) ? String(input.formId) : '' };
    case 'suggestions':
      return {
        limit: int(input.limit, 1, 50, 10),
        filter: oneOf(input.filter, SITE_SUGGESTION_FILTERS, 'open'),
        allowSubmit: input.allowSubmit !== false,
      };
    case 'leaderboard':
      return { variant: oneOf(input.variant, SITE_LEADERBOARD_VARIANTS, 'xp'), limit: int(input.limit, 3, 100, 10) };
    case 'clans':
      return { variant: oneOf(input.variant, SITE_CLAN_VARIANTS, 'leveling'), limit: int(input.limit, 3, 50, 10) };
    case 'giveaways':
      return { filter: oneOf(input.filter, SITE_GIVEAWAY_FILTERS, 'active'), limit: int(input.limit, 1, 24, 6) };
    case 'events':
      return { limit: int(input.limit, 1, 24, 6), layout: oneOf(input.layout, SITE_LIST_LAYOUTS, 'cards') };
    case 'seasons':
      return { limit: int(input.limit, 3, 50, 10) };
    case 'marketplace':
      return { limit: int(input.limit, 1, 48, 12) };
    case 'starboard':
      return { limit: int(input.limit, 1, 24, 6) };
    case 'voteLeaderboard':
      return { limit: int(input.limit, 3, 50, 10) };
    case 'shop':
      return { category: text(input.category, 40) };
    case 'changelog':
      return { days: int(input.days, 7, 90, 30), limit: int(input.limit, 3, 50, 15) };
    case 'wikiIndex':
      return { parentId: CUID.test(String(input.parentId ?? '')) ? String(input.parentId) : '' };
    case 'blogList':
      return { limit: int(input.limit, 1, 24, 6), tag: text(input.tag, 40), layout: oneOf(input.layout, SITE_LIST_LAYOUTS, 'cards') };
    case 'join':
      return { label: text(input.label, 60) };
    case 'channelFeed':
      return { channelId: SNOWFLAKE.test(String(input.channelId ?? '')) ? String(input.channelId) : '', limit: int(input.limit, 1, 20, 5) };
    default:
      return {};
  }
}

/** Module du bot qui conditionne un bloc, en tenant compte de la variante. */
export function siteModuleBotDependency(key: SiteModuleKey, config: Record<string, unknown>): string | null {
  if (key === 'leaderboard') {
    switch (config.variant) {
      case 'prestige':
        return 'prestige';
      case 'reputation':
        return 'reputation';
      case 'season':
        return 'seasons';
      case 'economy':
        return 'economy';
      default:
        return 'leveling';
    }
  }
  if (key === 'clans' && config.variant === 'rpg') return 'economy';
  return SITE_MODULES[key].botModule;
}
