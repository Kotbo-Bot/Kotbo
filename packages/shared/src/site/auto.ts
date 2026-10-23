/**
 * Site qui se tient à jour seul : annonces Discord recopiées dans le blog,
 * pages des modules créées à leur activation, résumé de la semaine publié
 * chaque semaine. Réglages rangés dans `settings.auto` du site.
 */

export interface SiteAutoSettings {
  announcements: {
    enabled: boolean;
    /** Salons dont les messages deviennent des articles. */
    channelIds: string[];
    /** Étiquette posée sur ces articles. */
    tag: string;
    /** En dessous, le message reste sur Discord (un « gg » n'est pas un article). */
    minLength: number;
  };
  modulePages: { enabled: boolean };
  weeklySummary: {
    enabled: boolean;
    /** 0 = dimanche … 6 = samedi, heure de Paris. */
    weekday: number;
    hour: number;
  };
}

export const DEFAULT_SITE_AUTO: SiteAutoSettings = {
  announcements: { enabled: false, channelIds: [], tag: 'annonce', minLength: 80 },
  modulePages: { enabled: false },
  weeklySummary: { enabled: false, weekday: 1, hour: 9 },
};

const SNOWFLAKE = /^\d{17,20}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function normalizeSiteAuto(raw: unknown): SiteAutoSettings {
  const input = isRecord(raw) ? raw : {};
  const a = isRecord(input.announcements) ? input.announcements : {};
  const p = isRecord(input.modulePages) ? input.modulePages : {};
  const w = isRecord(input.weeklySummary) ? input.weeklySummary : {};
  const tag = typeof a.tag === 'string' ? a.tag.trim().toLowerCase().replace(/[^a-z0-9à-ÿ-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) : '';
  return {
    announcements: {
      enabled: a.enabled === true,
      channelIds: Array.isArray(a.channelIds) ? [...new Set(a.channelIds.filter((id): id is string => typeof id === 'string' && SNOWFLAKE.test(id)))].slice(0, 10) : [],
      tag: tag || DEFAULT_SITE_AUTO.announcements.tag,
      minLength: int(a.minLength, 0, 2000, DEFAULT_SITE_AUTO.announcements.minLength),
    },
    modulePages: { enabled: p.enabled === true },
    weeklySummary: {
      enabled: w.enabled === true,
      weekday: int(w.weekday, 0, 6, DEFAULT_SITE_AUTO.weeklySummary.weekday),
      hour: int(w.hour, 0, 23, DEFAULT_SITE_AUTO.weeklySummary.hour),
    },
  };
}

/** Semaine ISO d'une date (`2026-W41`), pour ne publier qu'un résumé par semaine. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Titre et corps d'un article tiré d'une annonce : la première ligne (titre
 * Markdown, gras ou phrase) devient le titre, le reste le corps.
 */
export function splitAnnouncement(content: string, fallbackTitle: string): { title: string; body: string } {
  const lines = content.replace(/\r\n/g, '\n').trim().split('\n');
  const first = (lines[0] ?? '').trim();
  const heading = first.match(/^#{1,3}\s+(.+)$/) ?? first.match(/^\*\*(.+?)\*\*$/) ?? first.match(/^__(.+?)__$/);
  if (heading) return { title: heading[1].trim().slice(0, 140), body: lines.slice(1).join('\n').trim() };
  if (first.length > 0 && first.length <= 100 && lines.length > 1) return { title: first.replace(/[*_~`]/g, '').trim(), body: lines.slice(1).join('\n').trim() };
  return { title: fallbackTitle, body: content.trim() };
}
