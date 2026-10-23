/**
 * Membres du site communautaire : récompenses de l'activité sur le site et
 * notifications en message privé.
 *
 * Les récompenses se versent dans l'économie du bot (pièces) et le leveling
 * (XP) ; un module éteint ne verse rien de sa part. Les montants sont fixes.
 */

export interface SiteRewardAmount {
  coins: number;
  xp: number;
}

export interface SiteRewardSettings {
  enabled: boolean;
  /** Première visite du jour, connecté : bonus par jour de série, plafonné. */
  daily: SiteRewardAmount & { streakBonus: number; streakCap: number };
  /** Commentaire, sujet ou réponse au forum, suggestion, inscription à un événement. */
  participation: SiteRewardAmount & { dailyCap: number };
  /** Page lue jusqu'au bout, une fois par page. */
  read: SiteRewardAmount & { dailyCap: number };
  /** Vote vérifié pour le serveur sur un site de classement. */
  vote: SiteRewardAmount & { streakBonus: number; streakCap: number };
}

export const DEFAULT_SITE_REWARDS: SiteRewardSettings = {
  enabled: true,
  daily: { coins: 10, xp: 5, streakBonus: 2, streakCap: 10 },
  participation: { coins: 5, xp: 3, dailyCap: 10 },
  read: { coins: 2, xp: 2, dailyCap: 10 },
  vote: { coins: 50, xp: 20, streakBonus: 5, streakCap: 10 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Réglages des récompenses : un seul choix, actif ou non. Les montants sont
 * ceux de `DEFAULT_SITE_REWARDS` (les réglages fins ont été retirés le
 * 2026-10-12 ; des montants encore stockés sont ignorés).
 */
export function normalizeSiteRewards(input: unknown): SiteRewardSettings {
  const raw = isRecord(input) ? input : {};
  return { ...DEFAULT_SITE_REWARDS, enabled: raw.enabled !== false };
}

/** Bonus de série : `streakBonus` par jour au-delà du premier, jusqu'à `streakCap` jours. */
export function siteStreakBonus(streak: number, streakBonus: number, streakCap: number): number {
  return Math.max(0, Math.min(streak - 1, streakCap)) * streakBonus;
}

export const SITE_NOTIFICATION_KINDS = ['comments', 'tickets', 'voteReminder'] as const;
export type SiteNotificationKind = (typeof SITE_NOTIFICATION_KINDS)[number];
export type SiteNotificationPrefs = Record<SiteNotificationKind, boolean>;

/** Tout est activé par défaut, sauf le rappel de vote qu'on choisit de recevoir. */
export const DEFAULT_SITE_NOTIFICATIONS: SiteNotificationPrefs = {
  comments: true,
  tickets: true,
  voteReminder: false,
};

export function normalizeSiteNotifications(input: unknown): SiteNotificationPrefs {
  const raw = isRecord(input) ? input : {};
  const out = { ...DEFAULT_SITE_NOTIFICATIONS };
  for (const kind of SITE_NOTIFICATION_KINDS) if (typeof raw[kind] === 'boolean') out[kind] = raw[kind] as boolean;
  return out;
}

/** Jour calendaire à Paris (`AAAA-MM-JJ`) : les séries suivent l'heure du serveur, pas UTC. */
export function siteDayKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Décalage de Paris par rapport à UTC, en minutes, à l'instant donné (60 ou 120). */
function parisOffsetMinutes(date: Date): number {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label ?? '');
  if (!match) return 60;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/** Minuit à Paris du jour en cours, en instant UTC (borne des plafonds quotidiens). */
export function siteDayStart(date: Date = new Date()): Date {
  const [y, m, d] = siteDayKey(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - parisOffsetMinutes(date) * 60_000);
}

/** Jour précédent d'une clé `AAAA-MM-JJ`. */
export function previousSiteDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
