/**
 * analyticsAlertsService.ts
 *
 * Alertes sur seuil d'Analytics, évaluées toutes les 5 minutes par le cron
 * `analytics-alerts`. Une règle compare une mesure à un seuil absolu
 * (au-dessus, en dessous) ou à sa valeur habituelle (baisse ou hausse en %) :
 *   - pas de l'heure : la dernière heure complète contre la moyenne de la
 *     même heure sur les 7 jours d'avant ;
 *   - pas du jour : la veille contre la moyenne des 7 jours d'avant ;
 *   - pas de la semaine : les 7 derniers jours contre les 7 d'avant ;
 *   - rythme d'un salon : messages des 30 dernières minutes ramenés à l'heure,
 *     lus dans la fenêtre temps réel ;
 *   - score Pulse : le snapshot de la veille contre la moyenne des 7 d'avant,
 *     attendu tant que le cron Pulse ne l'a pas écrit.
 * Chaque période n'est évaluée qu'une fois (`lastPeriodKey`), et une règle
 * déclenchée se tait pendant `cooldownHours`.
 */

import { EmbedBuilder, type Client } from 'discord.js';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { isGuildActivated } from '../../utils/activation.js';
import { isAnalyticsCollectionEnabled } from './analyticsConsent.js';
import { liveSnapshot } from './analyticsLiveService.js';

export const ALERT_METRICS = ['messages', 'voiceMinutes', 'activeMembers', 'joins', 'leaves', 'netJoins', 'sanctions', 'channelRate', 'unansweredRate', 'pulseScore'] as const;
export const ALERT_CONDITIONS = ['drop_pct', 'rise_pct', 'above', 'below'] as const;
export const ALERT_WINDOWS = ['hour', 'day', 'week'] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];
export type AlertWindow = (typeof ALERT_WINDOWS)[number];

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ── Règles pures ───────────────────────────────────────────────────────────

/** Période à évaluer : la dernière heure ou le dernier jour complet (UTC). */
export function periodKeyOf(window: AlertWindow, metric: AlertMetric, now: number): string {
  if (metric === 'channelRate') {
    const slot = Math.floor(now / (30 * 60 * 1000));
    return `live:${slot}`;
  }
  if (window === 'hour') {
    const hour = new Date(Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS);
    return hour.toISOString().slice(0, 13);
  }
  const yesterday = keyOf(now - DAY_MS);
  return window === 'week' ? `${yesterday}:w` : yesterday;
}

export function evaluateCondition(condition: AlertCondition, threshold: number, value: number, baseline: number | null): boolean {
  switch (condition) {
    case 'above':
      return value > threshold;
    case 'below':
      return value < threshold;
    case 'drop_pct':
      return baseline !== null && baseline > 0 && ((baseline - value) / baseline) * 100 >= threshold;
    case 'rise_pct':
      return baseline !== null && baseline > 0 && ((value - baseline) / baseline) * 100 >= threshold;
  }
}

export function inCooldown(lastTriggeredAt: Date | null, cooldownHours: number, now: number): boolean {
  return lastTriggeredAt !== null && now - lastTriggeredAt.getTime() < cooldownHours * HOUR_MS;
}

/** Les mesures qui n'ont pas de sens au pas de l'heure (pas tenues heure par heure). */
export function supportsWindow(metric: AlertMetric, window: AlertWindow): boolean {
  if (metric === 'channelRate') return window === 'hour';
  if (window === 'hour') return ['messages', 'voiceMinutes', 'activeMembers', 'joins', 'leaves', 'netJoins'].includes(metric);
  return true;
}

// ── Lecture des mesures ────────────────────────────────────────────────────

type Reading = { value: number; baseline: number | null };

const DAILY_COLUMN: Partial<Record<AlertMetric, string>> = {
  messages: 'messagesCount',
  voiceMinutes: 'voiceMinutes',
  joins: 'membersJoined',
  leaves: 'membersLeft',
  sanctions: 'sanctionsCount',
};

async function dailyValues(guildId: string, metric: AlertMetric, start: string, end: string, channelId: string | null): Promise<Map<string, number>> {
  if (metric === 'activeMembers') {
    const rows = await prismaRead.$queryRaw<Array<{ dateKey: string; v: number }>>`
      SELECT "dateKey", COUNT(DISTINCT "userId")::int AS v FROM "member_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}
        AND ("messagesCount" > 0 OR "voiceMinutes" > 0)
      GROUP BY "dateKey"
    `;
    return new Map(rows.map((r) => [r.dateKey, r.v]));
  }
  if (metric === 'messages' && channelId) {
    const rows = await prismaRead.channelDailyStat.findMany({
      where: { guildId, channelId, dateKey: { gte: start, lte: end } },
      select: { dateKey: true, messagesCount: true },
    });
    return new Map(rows.map((r) => [r.dateKey, r.messagesCount]));
  }
  const rows = await prismaRead.guildDailyStat.findMany({
    where: { guildId, dateKey: { gte: start, lte: end } },
    select: { dateKey: true, messagesCount: true, voiceMinutes: true, membersJoined: true, membersLeft: true, sanctionsCount: true },
  });
  return new Map(rows.map((r) => {
    if (metric === 'netJoins') return [r.dateKey, r.membersJoined - r.membersLeft];
    const column = DAILY_COLUMN[metric] as keyof typeof r;
    return [r.dateKey, Number(r[column] ?? 0)];
  }));
}

async function unansweredRate(guildId: string, start: string, end: string): Promise<number | null> {
  const rows = await prismaRead.$queryRaw<Array<{ a: number; u: number }>>`
    SELECT COALESCE(SUM("answered"), 0)::int AS a, COALESCE(SUM("unanswered"), 0)::int AS u
    FROM "channel_response_daily_stats" WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}
  `;
  const r = rows[0];
  if (!r || r.a + r.u === 0) return null;
  return Math.round((r.u / (r.a + r.u)) * 1000) / 10;
}

/**
 * Score Pulse quotidien. `undefined` tant que le snapshot de la veille n'est
 * pas écrit (le cron Pulse passe vers 1 h UTC) : la période reste à évaluer.
 */
async function pulseScoreReading(guildId: string, window: AlertWindow, now: number): Promise<Reading | null | undefined> {
  const rows = await prismaRead.pulseSnapshot.findMany({
    where: { guildId, dateKey: { gte: keyOf(now - 15 * DAY_MS), lte: keyOf(now - DAY_MS) } },
    select: { dateKey: true, score: true },
  });
  const byKey = new Map(rows.map((r) => [r.dateKey, r.score]));
  if (!byKey.has(keyOf(now - DAY_MS))) return undefined;
  const mean = (from: number, to: number): number | null => {
    const values = Array.from({ length: to - from + 1 }, (_, i) => byKey.get(keyOf(now - (from + i) * DAY_MS))).filter((v): v is number => v !== undefined);
    return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
  };
  if (window === 'week') {
    const value = mean(1, 7);
    return value === null ? null : { value: Math.round(value * 10) / 10, baseline: mean(8, 14) };
  }
  return { value: byKey.get(keyOf(now - DAY_MS))!, baseline: mean(2, 8) };
}

async function readMetric(client: Client, rule: { guildId: string; metric: string; window: string; channelId: string | null }, now: number): Promise<Reading | null | undefined> {
  const metric = rule.metric as AlertMetric;
  const window = rule.window as AlertWindow;

  if (metric === 'pulseScore') return pulseScoreReading(rule.guildId, window, now);

  if (metric === 'channelRate') {
    if (!rule.channelId) return null;
    const snapshot = liveSnapshot(client, rule.guildId, now);
    const inWindow = snapshot.channels.find((c) => c.channelId === rule.channelId)?.messages ?? 0;
    return { value: inWindow * 2, baseline: null };
  }

  if (window === 'hour') {
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
    const hour = new Date(hourStart).getUTCHours();
    const keys = Array.from({ length: 8 }, (_, i) => keyOf(hourStart - i * DAY_MS));
    const rows = await prismaRead.guildHourlyStat.findMany({
      where: { guildId: rule.guildId, hour, dateKey: { in: keys } },
      select: { dateKey: true, messagesCount: true, voiceMinutes: true, joinsCount: true, leavesCount: true, activeMembers: true },
    });
    const pick = (r: (typeof rows)[number]) =>
      metric === 'messages' ? r.messagesCount
        : metric === 'voiceMinutes' ? r.voiceMinutes
          : metric === 'joins' ? r.joinsCount
            : metric === 'leaves' ? r.leavesCount
              : metric === 'netJoins' ? r.joinsCount - r.leavesCount
                : r.activeMembers;
    const byKey = new Map(rows.map((r) => [r.dateKey, pick(r)]));
    const previous = keys.slice(1).map((k) => byKey.get(k) ?? 0);
    return { value: byKey.get(keys[0]!) ?? 0, baseline: previous.reduce((s, v) => s + v, 0) / previous.length };
  }

  const yesterday = keyOf(now - DAY_MS);
  if (metric === 'unansweredRate') {
    const span = window === 'week' ? 7 : 1;
    const curStart = keyOf(now - span * DAY_MS);
    const prevEnd = keyOf(now - (span + 1) * DAY_MS);
    const prevStart = keyOf(now - (window === 'week' ? 14 : 8) * DAY_MS);
    const value = await unansweredRate(rule.guildId, curStart, yesterday);
    if (value === null) return null;
    return { value, baseline: await unansweredRate(rule.guildId, prevStart, prevEnd) };
  }

  const start = keyOf(now - 15 * DAY_MS);
  const values = await dailyValues(rule.guildId, metric, start, yesterday, rule.channelId);
  const day = (offset: number) => values.get(keyOf(now - offset * DAY_MS)) ?? 0;
  if (window === 'day') {
    const previous = Array.from({ length: 7 }, (_, i) => day(i + 2));
    return { value: day(1), baseline: previous.reduce((s, v) => s + v, 0) / 7 };
  }
  // Semaine : les membres actifs se dédoublonnent sur la fenêtre entière.
  if (metric === 'activeMembers') {
    const distinct = async (from: string, to: string) => {
      const rows = await prismaRead.$queryRaw<Array<{ v: number }>>`
        SELECT COUNT(DISTINCT "userId")::int AS v FROM "member_daily_stats"
        WHERE "guildId" = ${rule.guildId} AND "dateKey" >= ${from} AND "dateKey" <= ${to}
          AND ("messagesCount" > 0 OR "voiceMinutes" > 0)
      `;
      return rows[0]?.v ?? 0;
    };
    return {
      value: await distinct(keyOf(now - 7 * DAY_MS), yesterday),
      baseline: await distinct(keyOf(now - 14 * DAY_MS), keyOf(now - 8 * DAY_MS)),
    };
  }
  const sum = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => day(from + i)).reduce((s, v) => s + v, 0);
  return { value: sum(1, 7), baseline: sum(8, 14) };
}

// ── Envoi ──────────────────────────────────────────────────────────────────

function metricLabel(metric: AlertMetric, locale: BotLocale): string {
  const o = { locale };
  return {
    messages: m.anr_metric_messages({}, o),
    voiceMinutes: m.anr_metric_voice({}, o),
    activeMembers: m.anr_metric_active({}, o),
    joins: m.anr_metric_joins({}, o),
    leaves: m.anr_metric_leaves({}, o),
    netJoins: m.anr_metric_net_joins({}, o),
    sanctions: m.anr_metric_sanctions({}, o),
    channelRate: m.anr_metric_channel_rate({}, o),
    unansweredRate: m.anr_metric_unanswered({}, o),
    pulseScore: m.anr_metric_pulse_score({}, o),
  }[metric];
}

const fmt = (v: number, locale: BotLocale) => (Math.round(v * 10) / 10).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US');

export function describeAlert(
  rule: { name: string; metric: string; condition: string; threshold: number; window: string; channelId: string | null },
  reading: Reading,
  locale: BotLocale,
): string {
  const o = { locale };
  const metric = rule.metric as AlertMetric;
  const unit = metric === 'unansweredRate' ? ' %' : metric === 'pulseScore' ? '/100' : '';
  const value = `${fmt(reading.value, locale)}${unit}`;
  const period = rule.window === 'hour' ? m.anr_period_hour({}, o) : rule.window === 'week' ? m.anr_period_week({}, o) : m.anr_period_day({}, o);
  const head = m.anr_alert_value({ metric: metricLabel(metric, locale), period, value }, o);
  if (rule.condition === 'drop_pct' || rule.condition === 'rise_pct') {
    const base = reading.baseline ?? 0;
    const change = base > 0 ? ((reading.value - base) / base) * 100 : 0;
    return `${head}\n${m.anr_alert_versus({ change: `${change > 0 ? '+' : ''}${fmt(change, locale)} %`, baseline: `${fmt(base, locale)}${unit}` }, o)}`;
  }
  return `${head}\n${m.anr_alert_threshold({ op: rule.condition === 'above' ? '>' : '<', threshold: `${fmt(rule.threshold, locale)}${unit}` }, o)}`;
}

async function deliver(client: Client, rule: { guildId: string; name: string; notifyChannelId: string | null; notifyUserIds: string[] }, description: string, locale: BotLocale): Promise<boolean> {
  const guild = client.guilds.cache.get(rule.guildId);
  if (!guild) return false;
  const embed = new EmbedBuilder()
    .setTitle(m.anr_alert_title({ name: rule.name }, { locale }))
    .setDescription(description)
    .setColor(0xe8a33d)
    .setFooter({ text: m.anr_alert_footer({ guild: guild.name }, { locale }) })
    .setTimestamp();
  let delivered = false;
  if (rule.notifyChannelId) {
    const channel = guild.channels.cache.get(rule.notifyChannelId);
    if (channel?.isTextBased() && 'send' in channel) {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => (delivered = true)).catch((err) => logger.warn('AnalyticsAlerts', `Salon d'alerte injoignable (${rule.notifyChannelId}) :`, err));
    }
  }
  for (const userId of rule.notifyUserIds.slice(0, 10)) {
    // Seuls des membres encore présents reçoivent l'alerte en MP.
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    await member.send({ embeds: [embed] }).then(() => (delivered = true)).catch(() => undefined);
  }
  return delivered;
}

// ── Évaluation ─────────────────────────────────────────────────────────────

export async function runAnalyticsAlerts(client: Client, now = Date.now()): Promise<void> {
  const rules = await prisma.analyticsAlertRule.findMany({ where: { enabled: true }, take: 5000 });
  for (const rule of rules) {
    if (!client.guilds.cache.has(rule.guildId)) continue;
    const metric = rule.metric as AlertMetric;
    const window = rule.window as AlertWindow;
    if (!ALERT_METRICS.includes(metric) || !ALERT_WINDOWS.includes(window) || !supportsWindow(metric, window)) continue;
    const periodKey = periodKeyOf(window, metric, now);
    if (rule.lastPeriodKey === periodKey) continue;
    try {
      if (!isGuildActivated(rule.guildId) || !(await isAnalyticsCollectionEnabled(rule.guildId))) continue;
      const reading = await readMetric(client, rule, now);
      if (reading === undefined) continue;
      await prisma.analyticsAlertRule.update({ where: { id: rule.id }, data: { lastPeriodKey: periodKey } });
      if (!reading) continue;
      if (!evaluateCondition(rule.condition as AlertCondition, rule.threshold, reading.value, reading.baseline)) continue;
      if (inCooldown(rule.lastTriggeredAt, rule.cooldownHours, now)) continue;

      const locale = await resolveGuildLocale(rule.guildId, client.guilds.cache.get(rule.guildId)?.preferredLocale);
      const delivered = await deliver(client, rule, describeAlert(rule, reading, locale), locale);
      await prisma.$transaction([
        prisma.analyticsAlertRule.update({ where: { id: rule.id }, data: { lastTriggeredAt: new Date(now) } }),
        prisma.analyticsAlertEvent.create({ data: { guildId: rule.guildId, ruleId: rule.id, periodKey, value: reading.value, baseline: reading.baseline, delivered } }),
      ]);
    } catch (err) {
      logger.error('AnalyticsAlerts', `Évaluation impossible pour la règle ${rule.id} :`, err);
    }
  }
}

// ── Saisie ─────────────────────────────────────────────────────────────────

export const ALERT_RULES_PER_GUILD_MAX = 30;
const SNOWFLAKE_RE = /^\d{17,20}$/;

export interface AlertRuleInput {
  name: string;
  metric: AlertMetric;
  condition: AlertCondition;
  threshold: number;
  window: AlertWindow;
  channelId: string | null;
  notifyChannelId: string | null;
  notifyUserIds: string[];
  enabled: boolean;
  cooldownHours: number;
}

export function validateAlertRule(body: Record<string, unknown>): AlertRuleInput | string {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) return 'name';
  const metric = body.metric as AlertMetric;
  if (!ALERT_METRICS.includes(metric)) return 'metric';
  const condition = body.condition as AlertCondition;
  if (!ALERT_CONDITIONS.includes(condition)) return 'condition';
  const window = body.window as AlertWindow;
  if (!ALERT_WINDOWS.includes(window) || !supportsWindow(metric, window)) return 'window';
  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1_000_000) return 'threshold';
  const snowflake = (v: unknown) => (typeof v === 'string' && SNOWFLAKE_RE.test(v) ? v : null);
  const channelId = snowflake(body.channelId);
  if (metric === 'channelRate' && !channelId) return 'channelId';
  const notifyChannelId = snowflake(body.notifyChannelId);
  const notifyUserIds = Array.isArray(body.notifyUserIds)
    ? [...new Set(body.notifyUserIds.filter((v): v is string => typeof v === 'string' && SNOWFLAKE_RE.test(v)))].slice(0, 10)
    : [];
  if (!notifyChannelId && notifyUserIds.length === 0) return 'recipients';
  const cooldown = Math.round(Number(body.cooldownHours ?? (window === 'hour' ? 1 : 24)));
  return {
    name,
    metric,
    condition,
    threshold,
    window,
    channelId,
    notifyChannelId,
    notifyUserIds,
    enabled: body.enabled !== false,
    cooldownHours: Number.isFinite(cooldown) ? Math.min(24 * 14, Math.max(1, cooldown)) : 24,
  };
}
