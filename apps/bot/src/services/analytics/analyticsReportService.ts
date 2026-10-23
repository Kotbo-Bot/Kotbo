/**
 * analyticsReportService.ts
 *
 * Rapports d'Analytics planifiés : chaque semaine (les 7 derniers jours) ou
 * chaque mois (le mois civil écoulé), envoyés dans un salon et/ou en MP aux
 * membres choisis, à l'heure locale du serveur. Le cron `analytics-reports`
 * passe toutes les 5 minutes et envoie ce qui est dû (`nextRunAt`).
 */

import { EmbedBuilder, type Client } from 'discord.js';
import { resolveGuildTimezone, zonedTimeToInstant } from '../../utils/timezone.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';
import * as m from '../../lib/paraglide/messages.js';
import { isGuildActivated } from '../../utils/activation.js';
import { isAnalyticsCollectionEnabled } from './analyticsConsent.js';
import { addDays, parseRange, type AnalyticsScope, type DateRange } from './contentAnalyticsService.js';
import { getActivityInsights, getActivityRankings } from './activityInsightsService.js';
import { getModerationTrends } from './sectionInsightsService.js';
import { getResponseTimes } from './conversationInsightsService.js';
import { BucketZoner } from './zonedBuckets.js';

export const REPORT_SECTIONS = ['kotbo_work', 'overview', 'top_members', 'top_channels', 'anomalies', 'moderation', 'responses'] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const DEFAULT_SECTIONS: ReportSection[] = ['kotbo_work', 'overview', 'top_members', 'top_channels', 'anomalies'];

const EMPTY_SCOPE: AnalyticsScope = { channelIds: null, userIds: null, excludeUserIds: [], channelFilter: null, roleFilter: null, excludeStaff: false };

interface ScheduleTiming { frequency: string; weekday: number; monthDay: number; hour: number }

/** Prochain envoi strictement après `from`, à l'heure locale du serveur. */
export function computeNextRun(s: ScheduleTiming, timezone: string, from: Date): Date {
  const local = new BucketZoner(timezone).fromDate(from);
  for (let i = 0; i <= 62; i += 1) {
    const key = addDays(local.dateKey, i);
    const [y, mo, d] = key.split('-').map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const due = s.frequency === 'monthly' ? d === s.monthDay : weekday === s.weekday;
    if (!due) continue;
    const instant = zonedTimeToInstant(Date.UTC(y, mo - 1, d, s.hour), timezone);
    if (instant.getTime() > from.getTime()) return instant;
  }
  // Inatteignable avec des réglages valides ; repli d'une semaine pour ne pas boucler.
  return new Date(from.getTime() + 7 * 24 * 3600 * 1000);
}

/** Période couverte : les 7 jours d'avant, ou le mois civil écoulé. */
export function reportRange(frequency: string, localToday: string): DateRange {
  if (frequency === 'monthly') {
    const [y, mo] = localToday.split('-').map(Number) as [number, number];
    const end = new Date(Date.UTC(y, mo - 1, 0)).toISOString().slice(0, 10);
    const start = `${end.slice(0, 7)}-01`;
    return parseRange(new URLSearchParams({ startDate: start, endDate: end }));
  }
  const end = addDays(localToday, -1);
  return parseRange(new URLSearchParams({ startDate: addDays(end, -6), endDate: end }));
}

const nf = (locale: BotLocale) => new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 1 });

function delta(now: number, prev: number, locale: BotLocale): string {
  if (prev === 0) return now === 0 ? '=' : m.anr_new({}, { locale });
  const pct = ((now - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return '=';
  return `${pct > 0 ? '▲ +' : '▼ '}${nf(locale).format(pct)} %`;
}

function duration(sec: number | null, locale: BotLocale): string {
  if (sec === null) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${nf(locale).format(sec / 3600)} h`;
}

/** Bornes UTC d'une periode de rapport, comme les autres sections. */
const rangeDates = (range: DateRange) => ({
  gte: new Date(`${range.start}T00:00:00Z`),
  lte: new Date(`${range.end}T23:59:59.999Z`),
});

/**
 * Ce que le bot a fait sur la periode, en chiffres : le rapport rappelle la
 * valeur de l'outil avec les resultats du serveur lui-meme, au lieu de ne
 * montrer que l'activite des membres. Seules les lignes non nulles s'affichent.
 */
export async function getKotboWork(client: Client, guildId: string, range: DateRange) {
  const createdAt = rangeDates(range);
  const botId = client.user?.id ?? null;
  const [spam, aegis, sanctions, tickets] = await Promise.all([
    prisma.spamDetectionSample.count({ where: { guildId, createdAt, shadow: false, action: { not: 'NONE' } } }),
    prisma.aegisDetection.count({ where: { guildId, createdAt, action: { notIn: ['NONE', 'REVIEW'] }, status: { not: 'DISMISSED' } } }),
    botId ? prisma.sanction.count({ where: { guildId, createdAt, moderatorUserId: botId } }) : Promise.resolve(0),
    prisma.ticket.count({ where: { guildId, closedAt: createdAt } }),
  ]);
  return { spam, aegis, sanctions, tickets };
}

export async function buildReportEmbed(client: Client, guildId: string, frequency: string, sections: ReportSection[], locale: BotLocale, timezone: string): Promise<EmbedBuilder> {
  const guild = client.guilds.cache.get(guildId);
  const today = new BucketZoner(timezone).fromDate(new Date()).dateKey;
  const range = reportRange(frequency, today);
  const o = { locale };
  const n = nf(locale);
  const embed = new EmbedBuilder()
    .setTitle(frequency === 'monthly' ? m.anr_report_title_month({ guild: guild?.name ?? '' }, o) : m.anr_report_title_week({ guild: guild?.name ?? '' }, o))
    .setDescription(m.anr_report_period({ start: range.start, end: range.end }, o))
    .setColor(0x6366f1)
    .setTimestamp();

  const wants = new Set(sections.length > 0 ? sections : DEFAULT_SECTIONS);

  if (wants.has('kotbo_work')) {
    const work = await getKotboWork(client, guildId, range).catch((error) => {
      logger.warn(`[AnalyticsReport] Bilan Kotbo indisponible pour ${guildId}: ${String(error)}`);
      return null;
    });
    const lines = work
      ? [
          work.spam > 0 ? m.anr_work_spam({ n: n.format(work.spam) }, o) : null,
          work.aegis > 0 ? m.anr_work_aegis({ n: n.format(work.aegis) }, o) : null,
          work.sanctions > 0 ? m.anr_work_sanctions({ n: n.format(work.sanctions) }, o) : null,
          work.tickets > 0 ? m.anr_work_tickets({ n: n.format(work.tickets) }, o) : null,
        ].filter((line) => line !== null)
      : [];
    if (lines.length > 0) {
      embed.addFields({ name: m.anr_work_title({}, o), value: lines.map((line) => `• ${line}`).join('\n') });
    }
  }
  const activity = wants.has('overview') || wants.has('anomalies') ? await getActivityInsights(client, guildId, range, EMPTY_SCOPE) : null;

  if (activity && wants.has('overview')) {
    const k = activity.kpis;
    embed.addFields(
      { name: m.anr_metric_messages({}, o), value: `**${n.format(k.messages.value)}** · ${delta(k.messages.value, k.messages.previous, locale)}`, inline: true },
      { name: m.anr_metric_active({}, o), value: `**${n.format(k.activeMembers.value)}** · ${delta(k.activeMembers.value, k.activeMembers.previous, locale)}`, inline: true },
      { name: m.anr_metric_voice({}, o), value: `**${n.format(Math.round(k.voiceMinutes.value / 60))} h** · ${delta(k.voiceMinutes.value, k.voiceMinutes.previous, locale)}`, inline: true },
      { name: m.anr_metric_net_joins({}, o), value: `**${k.netJoins.value > 0 ? '+' : ''}${n.format(k.netJoins.value)}** (${m.anr_joins_leaves({ joined: n.format(k.joined), left: n.format(k.left) }, o)})`, inline: true },
    );
  }

  if (wants.has('top_members')) {
    const top = await getActivityRankings(client, guildId, range, EMPTY_SCOPE, 'messages', 'members', 5);
    if (top.items.length > 0) {
      embed.addFields({
        name: m.anr_top_members({}, o),
        value: top.items.map((i, idx) => `${idx + 1}. <@${i.id}> — ${n.format(i.value)}`).join('\n'),
      });
    }
  }

  if (wants.has('top_channels')) {
    const top = await getActivityRankings(client, guildId, range, EMPTY_SCOPE, 'messages', 'channels', 5);
    if (top.items.length > 0) {
      embed.addFields({
        name: m.anr_top_channels({}, o),
        value: top.items.map((i, idx) => `${idx + 1}. ${i.deleted ? m.anr_deleted_channel({}, o) : `<#${i.id}>`} — ${n.format(i.value)}`).join('\n'),
      });
    }
  }

  if (activity && wants.has('anomalies') && activity.anomalies.length > 0) {
    embed.addFields({
      name: m.anr_anomalies({}, o),
      value: activity.anomalies
        .slice(0, 5)
        .map((a) => {
          const what = a.metric === 'messages' ? m.anr_metric_messages({}, o) : m.anr_metric_voice({}, o);
          const arrow = a.direction === 'up' ? '▲' : '▼';
          const where = a.driver ? ` · <#${a.driver.channelId}>` : '';
          return `${arrow} ${a.dateKey} — ${what} : ${n.format(a.value)} (~${n.format(a.expected)})${where}`;
        })
        .join('\n'),
    });
  }

  if (wants.has('moderation')) {
    const mod = await getModerationTrends(client, guildId, range);
    embed.addFields({ name: m.anr_metric_sanctions({}, o), value: `**${n.format(mod.total)}** · ${delta(mod.total, mod.previousTotal, locale)}`, inline: true });
  }

  if (wants.has('responses')) {
    const resp = await getResponseTimes(client, guildId, range, EMPTY_SCOPE);
    if (resp.total.turns > 0) {
      embed.addFields({
        name: m.anr_responses({}, o),
        value: m.anr_responses_value({ median: duration(resp.total.medianSec, locale), unanswered: resp.total.unansweredRate === null ? '—' : `${n.format(resp.total.unansweredRate)} %` }, o),
        inline: true,
      });
    }
  }

  let origin = process.env.DASHBOARD_URL ?? '';
  try {
    origin = getCurrentInstance().dashboardOrigin;
  } catch {
    /* hors contexte d'instance : DASHBOARD_URL */
  }
  if (origin) embed.addFields({ name: '​', value: m.anr_report_link({ url: `${origin.replace(/\/$/, '')}/analytics` }, o) });
  return embed;
}

async function sendReport(client: Client, schedule: { guildId: string; frequency: string; channelId: string | null; userIds: string[]; sections: string[] }): Promise<boolean> {
  const guild = client.guilds.cache.get(schedule.guildId);
  if (!guild) return false;
  const [locale, timezone] = await Promise.all([resolveGuildLocale(guild.id, guild.preferredLocale), resolveGuildTimezone(guild.id)]);
  const sections = schedule.sections.filter((s): s is ReportSection => (REPORT_SECTIONS as readonly string[]).includes(s));
  const embed = await buildReportEmbed(client, guild.id, schedule.frequency, sections, locale, timezone);
  let sent = false;
  if (schedule.channelId) {
    const channel = guild.channels.cache.get(schedule.channelId);
    if (channel?.isTextBased() && 'send' in channel) {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => (sent = true)).catch((err) => logger.warn('AnalyticsReports', `Salon de rapport injoignable (${schedule.channelId}) :`, err));
    }
  }
  for (const userId of schedule.userIds.slice(0, 10)) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    await member.send({ embeds: [embed] }).then(() => (sent = true)).catch(() => undefined);
  }
  return sent;
}

export async function runAnalyticsReports(client: Client, now = new Date()): Promise<void> {
  const due = await prisma.analyticsReportSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, take: 200 });
  for (const schedule of due) {
    if (!client.guilds.cache.has(schedule.guildId)) continue;
    try {
      const timezone = await resolveGuildTimezone(schedule.guildId);
      // La date suivante est posée avant l'envoi : un échec ne renvoie pas le rapport en boucle.
      await prisma.analyticsReportSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: computeNextRun(schedule, timezone, now) } });
      if (!isGuildActivated(schedule.guildId) || !(await isAnalyticsCollectionEnabled(schedule.guildId))) continue;
      if (await sendReport(client, schedule)) {
        await prisma.analyticsReportSchedule.update({ where: { id: schedule.id }, data: { lastSentAt: now } });
      }
    } catch (err) {
      logger.error('AnalyticsReports', `Rapport impossible pour ${schedule.id} :`, err);
    }
  }
}

/** Envoi immédiat, pour le bouton « Envoyer un essai » du dashboard. */
export async function sendReportNow(client: Client, scheduleId: string, guildId: string): Promise<boolean> {
  const schedule = await prisma.analyticsReportSchedule.findFirst({ where: { id: scheduleId, guildId } });
  if (!schedule) return false;
  return sendReport(client, schedule);
}

// ── Saisie ─────────────────────────────────────────────────────────────────

export const REPORT_SCHEDULES_PER_GUILD_MAX = 10;
const SNOWFLAKE_RE = /^\d{17,20}$/;

export interface ReportScheduleInput {
  frequency: 'weekly' | 'monthly';
  weekday: number;
  monthDay: number;
  hour: number;
  channelId: string | null;
  userIds: string[];
  sections: ReportSection[];
  enabled: boolean;
}

export function validateReportSchedule(body: Record<string, unknown>): ReportScheduleInput | string {
  const frequency = body.frequency === 'monthly' ? 'monthly' : body.frequency === 'weekly' ? 'weekly' : null;
  if (!frequency) return 'frequency';
  const int = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const channelId = typeof body.channelId === 'string' && SNOWFLAKE_RE.test(body.channelId) ? body.channelId : null;
  const userIds = Array.isArray(body.userIds)
    ? [...new Set(body.userIds.filter((v): v is string => typeof v === 'string' && SNOWFLAKE_RE.test(v)))].slice(0, 10)
    : [];
  if (!channelId && userIds.length === 0) return 'recipients';
  const sections = Array.isArray(body.sections)
    ? body.sections.filter((s): s is ReportSection => (REPORT_SECTIONS as readonly string[]).includes(s as string))
    : [];
  return {
    frequency,
    weekday: int(body.weekday, 0, 6, 1),
    monthDay: int(body.monthDay, 1, 28, 1),
    hour: int(body.hour, 0, 23, 9),
    channelId,
    userIds,
    sections: sections.length > 0 ? [...new Set(sections)] : DEFAULT_SECTIONS,
    enabled: body.enabled !== false,
  };
}
