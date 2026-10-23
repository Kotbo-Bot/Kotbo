/**
 * Pulse - score de santé quotidien d'un serveur.
 *
 * Deux corrections structurelles par rapport à la version précédente :
 *
 * - **Les snapshots portent sur un jour terminé.** Le cron tourne à 03h00
 *   Europe/Paris, soit 01h/02h UTC. L'ancienne version calculait le snapshot du
 *   jour UTC *courant*, qui ne contenait alors qu'une ou deux heures de données :
 *   le score d'activité était systématiquement écrasé. On calcule désormais le
 *   dernier jour complet (J-1), et l'aperçu « aujourd'hui » est exposé à part,
 *   marqué comme partiel.
 *
 * - **Les entrées/sorties sont groupées.** `runPulseForAllGuilds` faisait 5
 *   requêtes par serveur en série. On charge maintenant toutes les guildes en un
 *   nombre fixe de requêtes, puis on écrit par lots.
 */
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import type { Client } from 'discord.js';
import {
  toDateKey,
  shiftDateKey,
  lastCompleteDateKey,
  dateKeyBounds,
  dateKeyRange,
  dateKeyWeekday,
} from './dateKeys.js';
import {
  computePulseBreakdown,
  generateAlerts,
  median,
  percentileRank,
  trendAgainst,
  PULSE_MODEL_VERSION,
  type PulseAlert,
  type PulseBaseline,
  type PulseFactor,
  type PulseReference,
  type PulseScoreInput,
} from './pulseScoring.js';
import { getBumpStatus, type BumpStatus } from '../integrations/bumpDetectionService.js';

/** Fenêtre de référence servant à calculer les médianes du serveur. */
const BASELINE_DAYS = 28;
/** Nombre de jours d'historique renvoyés au dashboard. */
const HISTORY_DAYS = 30;
/** Taille des lots d'écriture (une transaction par lot). */
const WRITE_CHUNK = 25;

export interface PulseSnapshotView {
  dateKey: string;
  score: number;
  activityScore: number;
  moderationScore: number;
  growthScore: number;
  engagementScore: number;
  healthScore: number;
  trend: string;
  trendDelta: number;
  alerts: PulseAlert[];
  /** Vrai si le jour n'est pas terminé (aperçu « aujourd'hui »). */
  partial: boolean;
  /** Fiabilité du diagnostic (0-100), `null` pour un snapshot relu sans recalcul. */
  confidence: number | null;
  /** Facteurs du score avec leur impact en points, vide pour un snapshot relu. */
  factors: PulseFactor[];
}

export interface PulseBenchmark {
  /** Part des serveurs comparables moins bien notés, 0-100. */
  percentile: number;
  peers: number;
  minMembers: number;
  maxMembers: number;
}

export type PulseHistoryPoint = PulseMetrics & {
  dateKey: string;
  score: number;
  activityScore: number;
  moderationScore: number;
  growthScore: number;
  engagementScore: number;
  healthScore: number;
  alerts: PulseAlert[];
};

export interface PulseMetrics {
  totalMessages: number;
  totalVoiceMinutes: number;
  activeMembers: number;
  totalMembers: number;
  membersJoined: number;
  membersLeft: number;
  sanctionsCount: number;
  ticketsResolved: number;
  ticketsOpen: number;
  channelsHealthy: number;
  channelsUnhealthy: number;
}

export interface PulseData {
  /** Faux quand aucun snapshot n'existe : le dashboard doit afficher un état vide. */
  hasData: boolean;
  current: PulseSnapshotView;
  /** Aperçu du jour en cours, recalculé à la volée. `null` si pas de données. */
  today: (PulseSnapshotView & { metrics: PulseMetrics }) | null;
  history: PulseHistoryPoint[];
  metrics: PulseMetrics;
  /** État du rappel de bump auto-détecté, `null` si aucun bump n'a jamais été observé. */
  bumpStatus: BumpStatus | null;
  /** Rang face aux serveurs Kotbo de taille comparable, `null` sans assez de pairs. */
  benchmark: PulseBenchmark | null;
  modelVersion: number;
}

const EMPTY_METRICS: PulseMetrics = {
  totalMessages: 0,
  totalVoiceMinutes: 0,
  activeMembers: 0,
  totalMembers: 0,
  membersJoined: 0,
  membersLeft: 0,
  sanctionsCount: 0,
  ticketsResolved: 0,
  ticketsOpen: 0,
  channelsHealthy: 0,
  channelsUnhealthy: 0,
};

const UNHEALTHY_ALERT_TYPES = ['SPLIT_SUGGESTED', 'ARCHIVE_SUGGESTED', 'MERGE_SUGGESTED'] as const;

// ---------------------------------------------------------------------------
// Chargement groupé des entrées
// ---------------------------------------------------------------------------

type DailyRow = {
  guildId: string;
  dateKey: string;
  totalMembers: number;
  totalBots: number;
  totalHumans: number;
  messagesCount: number;
  voiceMinutes: number;
  activeMembers: number;
  activeVoiceMembers: number;
  membersJoined: number;
  membersLeft: number;
  sanctionsCount: number;
};

const DAILY_SELECT = {
  guildId: true,
  dateKey: true,
  totalMembers: true,
  totalBots: true,
  totalHumans: true,
  messagesCount: true,
  voiceMinutes: true,
  activeMembers: true,
  activeVoiceMembers: true,
  membersJoined: true,
  membersLeft: true,
  sanctionsCount: true,
} as const;

/**
 * Effectif humain d'un jour. `totalHumans` peut être à 0 sur d'anciennes lignes
 * écrites avant que la colonne existe : on retombe alors sur `totalMembers - totalBots`.
 */
function resolveHumans(row: Pick<DailyRow, 'totalHumans' | 'totalMembers' | 'totalBots'>): number {
  if (row.totalHumans > 0) return row.totalHumans;
  const derived = row.totalMembers - row.totalBots;
  return derived > 0 ? derived : row.totalMembers;
}

/**
 * Médianes du serveur sur les jours précédant `dateKey` (le jour évalué est
 * exclu, sinon il tirerait sa propre référence vers lui).
 */
function referenceOf(rows: DailyRow[]): (PulseReference & { samples: number }) | null {
  const messagesPerHuman: number[] = [];
  const voicePerHuman: number[] = [];
  const participation: number[] = [];

  for (const row of rows) {
    const humans = resolveHumans(row);
    if (humans <= 0) continue;
    messagesPerHuman.push(row.messagesCount / humans);
    voicePerHuman.push(row.voiceMinutes / humans);
    participation.push(row.activeMembers / humans);
  }

  if (messagesPerHuman.length === 0) return null;
  return {
    messagesPerHuman: median(messagesPerHuman),
    voicePerHuman: median(voicePerHuman),
    participationRate: median(participation),
    samples: messagesPerHuman.length,
  };
}

function buildBaseline(rows: DailyRow[], dateKey: string): PulseBaseline | null {
  const previous = rows.filter((r) => r.dateKey < dateKey);
  const all = referenceOf(previous);
  if (!all) return null;
  const weekday = dateKeyWeekday(dateKey);
  const { samples, ...reference } = all;
  return {
    ...reference,
    sampleDays: samples,
    sameWeekday: referenceOf(previous.filter((r) => dateKeyWeekday(r.dateKey) === weekday)),
  };
}

/** Arrivées et départs des 7 jours finissant à `dateKey` (jours sans ligne exclus). */
function weekFlow(rows: DailyRow[], dateKey: string): PulseScoreInput['week'] {
  const from = shiftDateKey(-6, new Date(`${dateKey}T00:00:00.000Z`));
  const inWeek = rows.filter((r) => r.dateKey >= from && r.dateKey <= dateKey);
  if (inWeek.length === 0) return null;
  return {
    joined: inWeek.reduce((sum, r) => sum + r.membersJoined, 0),
    left: inWeek.reduce((sum, r) => sum + r.membersLeft, 0),
    days: inWeek.length,
  };
}

interface GuildPulseContext {
  daily: DailyRow[];
  ticketsOpen: number;
  ticketsResolved: number;
  channelsUnhealthy: number;
  totalChannels: number;
  /** Scores des jours précédents, du plus récent au plus ancien (7 au plus). */
  previousScores: number[];
  audience: PulseScoreInput['audience'];
  responses: PulseScoreInput['responses'];
  toxicity: PulseScoreInput['toxicity'];
}

/**
 * Charge, en un nombre fixe de requêtes, tout ce qui est nécessaire pour calculer
 * le snapshot de `dateKey` sur l'ensemble des `guildIds`.
 */
async function loadPulseContexts(
  client: Client,
  guildIds: string[],
  dateKey: string,
): Promise<Map<string, GuildPulseContext>> {
  const contexts = new Map<string, GuildPulseContext>();
  if (guildIds.length === 0) return contexts;

  const { end: dayEnd, start: dayStart } = dateKeyBounds(dateKey);
  const windowStartKey = shiftDateKey(-BASELINE_DAYS, new Date(`${dateKey}T00:00:00.000Z`));
  const monthStartKey = shiftDateKey(-(BASELINE_DAYS - 1), new Date(`${dateKey}T00:00:00.000Z`));

  const [dailyRows, openTickets, resolvedTickets, healthAlerts, previousSnapshots, channelRows, audienceRows, responseRows, toxicityRows] =
    await Promise.all([
      prismaRead.guildDailyStat.findMany({
        where: { guildId: { in: guildIds }, dateKey: { gte: windowStartKey, lte: dateKey } },
        select: DAILY_SELECT,
        orderBy: { dateKey: 'asc' },
      }),
      // Backlog tel qu'il était à la fin du jour évalué, pas tel qu'il est maintenant.
      // Une demande refusée n'a jamais donné de ticket et ne se ferme donc
      // jamais : sans l'exclure, elle gonflerait le backlog indéfiniment.
      prismaRead.ticket.groupBy({
        by: ['guildId'],
        where: {
          guildId: { in: guildIds },
          status: { not: 'REJECTED' },
          createdAt: { lt: dayEnd },
          OR: [{ closedAt: null }, { closedAt: { gte: dayEnd } }],
        },
        _count: { _all: true },
      }),
      prismaRead.ticket.groupBy({
        by: ['guildId'],
        where: { guildId: { in: guildIds }, closedAt: { gte: dayStart, lt: dayEnd } },
        _count: { _all: true },
      }),
      prismaRead.channelHealthAlert.groupBy({
        by: ['guildId'],
        where: {
          guildId: { in: guildIds },
          status: 'PENDING',
          type: { in: [...UNHEALTHY_ALERT_TYPES] },
          createdAt: { lt: dayEnd },
        },
        _count: { _all: true },
      }),
      // Dernier snapshot antérieur : on remonte jusqu'à 7 jours pour que la
      // tendance reste calculable après une coupure du bot.
      prismaRead.pulseSnapshot.findMany({
        where: {
          guildId: { in: guildIds },
          dateKey: { in: dateKeyRange(shiftDateKey(-1, new Date(`${dateKey}T00:00:00.000Z`)), 7) },
        },
        select: { guildId: true, dateKey: true, score: true },
        orderBy: { dateKey: 'desc' },
      }),
      // Nombre de salons connus, pour les guildes absentes du cache (sharding).
      prismaRead.channelDailyStat.groupBy({
        by: ['guildId', 'channelId'],
        where: { guildId: { in: guildIds }, dateKey: { gte: windowStartKey, lte: dateKey } },
      }),
      // Adhérence : actifs distincts du jour et des 28 jours (texte ou vocal).
      prismaRead.$queryRaw<Array<{ guildId: string; daily: number; monthly: number }>>`
        SELECT "guildId",
          COUNT(DISTINCT "userId") FILTER (WHERE "dateKey" = ${dateKey})::int AS daily,
          COUNT(DISTINCT "userId")::int AS monthly
        FROM "member_daily_stats"
        WHERE "guildId" = ANY(${guildIds}) AND "dateKey" >= ${monthStartKey} AND "dateKey" <= ${dateKey}
          AND ("messagesCount" > 0 OR "voiceMinutes" > 0)
        GROUP BY "guildId"
      `,
      prismaRead.channelResponseDailyStat.groupBy({
        by: ['guildId'],
        where: { guildId: { in: guildIds }, dateKey },
        _sum: { answered: true, unanswered: true, under1m: true, under5m: true, under15m: true },
      }),
      prismaRead.aegisMemberDailyStat.groupBy({
        by: ['guildId'],
        where: { guildId: { in: guildIds }, dateKey },
        _sum: { analyzed: true, toxic: true },
      }),
    ]);

  const dailyByGuild = new Map<string, DailyRow[]>();
  for (const row of dailyRows) {
    const list = dailyByGuild.get(row.guildId);
    if (list) list.push(row as DailyRow);
    else dailyByGuild.set(row.guildId, [row as DailyRow]);
  }

  const toCount = (rows: Array<{ guildId: string; _count: { _all: number } }>) =>
    new Map(rows.map((r) => [r.guildId, r._count._all]));

  const openMap = toCount(openTickets as any);
  const resolvedMap = toCount(resolvedTickets as any);
  const unhealthyMap = toCount(healthAlerts as any);

  // Trié par dateKey décroissant : chaque liste va du plus récent au plus ancien.
  const previousMap = new Map<string, number[]>();
  for (const snap of previousSnapshots) {
    const list = previousMap.get(snap.guildId);
    if (list) list.push(snap.score);
    else previousMap.set(snap.guildId, [snap.score]);
  }

  const audienceMap = new Map(audienceRows.map((r) => [r.guildId, { daily: r.daily, monthly: r.monthly }]));
  const responseMap = new Map(
    responseRows.map((r) => [
      r.guildId,
      {
        answered: r._sum.answered ?? 0,
        unanswered: r._sum.unanswered ?? 0,
        fast: (r._sum.under1m ?? 0) + (r._sum.under5m ?? 0) + (r._sum.under15m ?? 0),
      },
    ]),
  );
  const toxicityMap = new Map(toxicityRows.map((r) => [r.guildId, { analyzed: r._sum.analyzed ?? 0, toxic: r._sum.toxic ?? 0 }]));

  const dbChannelCount = new Map<string, number>();
  for (const row of channelRows as Array<{ guildId: string }>) {
    dbChannelCount.set(row.guildId, (dbChannelCount.get(row.guildId) ?? 0) + 1);
  }

  for (const guildId of guildIds) {
    const cached = client.guilds.cache.get(guildId);
    const cachedChannels = cached
      ? cached.channels.cache.filter((c) => c.isTextBased() && !c.isThread()).size
      : 0;

    contexts.set(guildId, {
      daily: dailyByGuild.get(guildId) ?? [],
      ticketsOpen: openMap.get(guildId) ?? 0,
      ticketsResolved: resolvedMap.get(guildId) ?? 0,
      channelsUnhealthy: unhealthyMap.get(guildId) ?? 0,
      // Le cache Discord est la source la plus juste ; sinon on retombe sur les
      // salons vus dans les stats (guilde sur un autre shard, cache non peuplé).
      totalChannels: cachedChannels > 0 ? cachedChannels : (dbChannelCount.get(guildId) ?? 0),
      previousScores: previousMap.get(guildId) ?? [],
      audience: audienceMap.get(guildId) ?? null,
      responses: responseMap.get(guildId) ?? null,
      toxicity: toxicityMap.get(guildId) ?? null,
    });
  }

  return contexts;
}

// ---------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------

interface ComputedSnapshot {
  guildId: string;
  dateKey: string;
  scores: ReturnType<typeof computePulseBreakdown>['scores'];
  factors: PulseFactor[];
  confidence: number;
  input: PulseScoreInput;
  alerts: PulseAlert[];
  trend: string;
  trendDelta: number;
  metrics: PulseMetrics;
}

function buildSnapshot(guildId: string, dateKey: string, ctx: GuildPulseContext): ComputedSnapshot {
  const dayRow = ctx.daily.find((r) => r.dateKey === dateKey) ?? null;
  const humans = dayRow ? resolveHumans(dayRow) : 0;

  const channelsUnhealthy = Math.min(ctx.channelsUnhealthy, ctx.totalChannels || ctx.channelsUnhealthy);
  const channelsHealthy = Math.max(0, ctx.totalChannels - channelsUnhealthy);

  const input: PulseScoreInput = {
    humans,
    totalMembers: dayRow?.totalMembers ?? 0,
    messages: dayRow?.messagesCount ?? 0,
    voiceMinutes: dayRow?.voiceMinutes ?? 0,
    activeMembers: dayRow?.activeMembers ?? 0,
    activeVoiceMembers: dayRow?.activeVoiceMembers ?? 0,
    membersJoined: dayRow?.membersJoined ?? 0,
    membersLeft: dayRow?.membersLeft ?? 0,
    sanctionsCount: dayRow?.sanctionsCount ?? 0,
    ticketsOpen: ctx.ticketsOpen,
    ticketsResolved: ctx.ticketsResolved,
    channelsHealthy,
    channelsUnhealthy,
    baseline: buildBaseline(ctx.daily, dateKey),
    week: weekFlow(ctx.daily, dateKey),
    audience: ctx.audience,
    responses: ctx.responses,
    toxicity: ctx.toxicity,
  };

  const { scores, factors, confidence } = computePulseBreakdown(input);
  const alerts = generateAlerts(scores, input);
  const { trend, delta: trendDelta } = trendAgainst(scores.score, ctx.previousScores);

  return {
    guildId,
    dateKey,
    scores,
    factors,
    confidence,
    input,
    alerts,
    trend,
    trendDelta,
    metrics: {
      totalMessages: input.messages,
      totalVoiceMinutes: input.voiceMinutes,
      activeMembers: input.activeMembers,
      totalMembers: input.totalMembers,
      membersJoined: input.membersJoined,
      membersLeft: input.membersLeft,
      sanctionsCount: input.sanctionsCount,
      ticketsResolved: input.ticketsResolved,
      ticketsOpen: input.ticketsOpen,
      channelsHealthy,
      channelsUnhealthy,
    },
  };
}

function snapshotWriteData(snap: ComputedSnapshot) {
  return {
    score: snap.scores.score,
    activityScore: snap.scores.activityScore,
    moderationScore: snap.scores.moderationScore,
    growthScore: snap.scores.growthScore,
    engagementScore: snap.scores.engagementScore,
    healthScore: snap.scores.healthScore,
    totalMessages: snap.metrics.totalMessages,
    totalVoiceMinutes: snap.metrics.totalVoiceMinutes,
    activeMembers: snap.metrics.activeMembers,
    totalMembers: snap.metrics.totalMembers,
    membersJoined: snap.metrics.membersJoined,
    membersLeft: snap.metrics.membersLeft,
    sanctionsCount: snap.metrics.sanctionsCount,
    ticketsResolved: snap.metrics.ticketsResolved,
    ticketsOpen: snap.metrics.ticketsOpen,
    channelsHealthy: snap.metrics.channelsHealthy,
    channelsUnhealthy: snap.metrics.channelsUnhealthy,
    trend: snap.trend,
    trendDelta: snap.trendDelta,
    alerts: snap.alerts as any,
    modelVersion: PULSE_MODEL_VERSION,
  };
}

async function persistSnapshots(snapshots: ComputedSnapshot[]): Promise<void> {
  for (let i = 0; i < snapshots.length; i += WRITE_CHUNK) {
    const chunk = snapshots.slice(i, i + WRITE_CHUNK);
    try {
      await prisma.$transaction(
        chunk.map((snap) => {
          const data = snapshotWriteData(snap);
          return prisma.pulseSnapshot.upsert({
            where: { guildId_dateKey: { guildId: snap.guildId, dateKey: snap.dateKey } },
            create: { guildId: snap.guildId, dateKey: snap.dateKey, ...data },
            update: data,
          });
        }),
      );
    } catch (error) {
      // Un lot en échec ne doit pas faire tomber les autres : on réessaie ligne à ligne.
      logger.warn('Pulse', `Lot d'écriture en échec (${chunk.length} snapshots), reprise unitaire`, error);
      for (const snap of chunk) {
        const data = snapshotWriteData(snap);
        try {
          await prisma.pulseSnapshot.upsert({
            where: { guildId_dateKey: { guildId: snap.guildId, dateKey: snap.dateKey } },
            create: { guildId: snap.guildId, dateKey: snap.dateKey, ...data },
            update: data,
          });
        } catch (err) {
          logger.error('Pulse', `Écriture du snapshot ${snap.guildId}/${snap.dateKey} impossible:`, err);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/**
 * Calcule et enregistre le snapshot d'un serveur.
 *
 * @param dateKey Jour à évaluer. Par défaut le dernier jour **complet** (J-1).
 *                Le jour en cours n'est jamais persisté : il serait comparé à des
 *                journées entières et ferait plonger la tendance chaque matin.
 *                Pour l'afficher, voir {@link getPulseDashboardDataWithToday}.
 */
export async function computePulseSnapshot(
  client: Client,
  guildId: string,
  dateKey: string = lastCompleteDateKey(),
): Promise<void> {
  if (dateKey >= toDateKey()) {
    logger.warn('Pulse', `Snapshot ignoré pour ${guildId}: ${dateKey} n'est pas un jour terminé`);
    return;
  }

  try {
    const contexts = await loadPulseContexts(client, [guildId], dateKey);
    const ctx = contexts.get(guildId);
    if (!ctx) return;

    const snapshot = buildSnapshot(guildId, dateKey, ctx);
    await persistSnapshots([snapshot]);

    logger.debug('Pulse', `Snapshot ${dateKey} pour ${guildId}: score=${snapshot.scores.score}`);
  } catch (error) {
    logger.error('Pulse', `Erreur lors du calcul du pulse pour ${guildId}:`, error);
  }
}

/**
 * Recalcule les `days` derniers jours complets d'un serveur.
 *
 * Sert au bouton « Recalculer » du dashboard : les snapshots écrits par les
 * versions antérieures portaient sur une journée à peine entamée et sont donc
 * faux. Les rejouer sur le même jour, avec les données désormais complètes,
 * répare l'historique affiché.
 *
 * Les jours sont traités du plus ancien au plus récent pour que chaque tendance
 * soit calculée à partir d'un jour précédent déjà corrigé.
 */
export async function backfillPulseHistory(
  client: Client,
  guildId: string,
  days = 7,
): Promise<number> {
  const bounded = Math.min(Math.max(Math.trunc(days) || 1, 1), 30);
  const keys = dateKeyRange(lastCompleteDateKey(), bounded);

  let written = 0;
  for (const dateKey of keys) {
    try {
      const contexts = await loadPulseContexts(client, [guildId], dateKey);
      const ctx = contexts.get(guildId);
      if (!ctx) continue;
      await persistSnapshots([buildSnapshot(guildId, dateKey, ctx)]);
      written++;
    } catch (error) {
      logger.error('Pulse', `Backfill ${guildId}/${dateKey} en échec:`, error);
    }
  }

  return written;
}

/** Calcule et écrit le snapshot de `dateKey` pour `guildIds`, en un nombre fixe de lectures. */
async function computeForGuilds(client: Client, guildIds: string[], dateKey: string): Promise<number> {
  const contexts = await loadPulseContexts(client, guildIds, dateKey);
  const snapshots = guildIds
    .map((guildId) => {
      const ctx = contexts.get(guildId);
      return ctx ? buildSnapshot(guildId, dateKey, ctx) : null;
    })
    .filter((s): s is ComputedSnapshot => s !== null);
  await persistSnapshots(snapshots);
  return snapshots.length;
}

/**
 * Recalcule les snapshots des {@link HISTORY_DAYS} derniers jours écrits par un
 * modèle plus ancien que {@link PULSE_MODEL_VERSION}. Sans ça, la courbe mêlerait
 * deux barèmes et la comparaison entre serveurs opposerait des notes incompatibles.
 *
 * Les jours sont traités du plus ancien au plus récent : la tendance d'un jour
 * se calcule sur des jours précédents déjà recalculés.
 */
export async function upgradeStaleSnapshots(client: Client): Promise<number> {
  const stale = await prismaRead.pulseSnapshot.findMany({
    where: { dateKey: { gte: shiftDateKey(-HISTORY_DAYS), lt: toDateKey() }, modelVersion: { lt: PULSE_MODEL_VERSION } },
    select: { guildId: true, dateKey: true },
  });
  if (stale.length === 0) return 0;

  const byDate = new Map<string, string[]>();
  for (const row of stale) {
    const list = byDate.get(row.dateKey);
    if (list) list.push(row.guildId);
    else byDate.set(row.dateKey, [row.guildId]);
  }

  let written = 0;
  for (const dateKey of [...byDate.keys()].sort()) {
    try {
      written += await computeForGuilds(client, byDate.get(dateKey)!, dateKey);
    } catch (error) {
      logger.error('Pulse', `Mise à niveau des snapshots du ${dateKey} en échec:`, error);
    }
  }
  logger.info('Pulse', `${written} snapshots recalculés avec le modèle v${PULSE_MODEL_VERSION}`);
  return written;
}

/**
 * Recalcule le snapshot du dernier jour complet pour tous les serveurs, après
 * avoir remis à niveau l'historique éventuellement calculé par un ancien modèle.
 *
 * Coût : un nombre fixe de lectures (9) par jour traité, quel que soit le nombre
 * de guildes, puis une transaction d'écriture par lot de {@link WRITE_CHUNK}.
 */
export async function runPulseForAllGuilds(
  client: Client,
  dateKey: string = lastCompleteDateKey(),
): Promise<void> {
  if (dateKey >= toDateKey()) {
    logger.warn('Pulse', `Calcul groupé ignoré: ${dateKey} n'est pas un jour terminé`);
    return;
  }

  try {
    await upgradeStaleSnapshots(client);
  } catch (error) {
    logger.error('Pulse', 'Mise à niveau des anciens snapshots impossible:', error);
  }

  const started = Date.now();
  const guilds = await prismaRead.guild.findMany({ select: { id: true } });
  const guildIds = guilds.map((g) => g.id);
  if (guildIds.length === 0) return;

  try {
    const count = await computeForGuilds(client, guildIds, dateKey);
    logger.info('Pulse', `${count} snapshots calculés pour ${dateKey} en ${Date.now() - started}ms`);
  } catch (error) {
    logger.error('Pulse', `Erreur lors du calcul groupé du pulse (${dateKey}):`, error);
  }
}

function toView(snapshot: {
  dateKey: string;
  score: number;
  activityScore: number;
  moderationScore: number;
  growthScore: number;
  engagementScore: number;
  healthScore: number;
  trend: string;
  trendDelta: number;
  alerts: unknown;
}, partial: boolean): PulseSnapshotView {
  return {
    dateKey: snapshot.dateKey,
    score: snapshot.score,
    activityScore: snapshot.activityScore,
    moderationScore: snapshot.moderationScore,
    growthScore: snapshot.growthScore,
    engagementScore: snapshot.engagementScore,
    healthScore: snapshot.healthScore,
    trend: snapshot.trend,
    trendDelta: snapshot.trendDelta,
    alerts: Array.isArray(snapshot.alerts) ? (snapshot.alerts as PulseAlert[]) : [],
    partial,
    confidence: null,
    factors: [],
  };
}

/** Vue d'un snapshot recalculé à la volée : avec facteurs et confiance. */
function computedView(snap: ComputedSnapshot, partial: boolean): PulseSnapshotView {
  return {
    ...toView({ ...snap.scores, dateKey: snap.dateKey, trend: snap.trend, trendDelta: snap.trendDelta, alerts: snap.alerts }, partial),
    confidence: snap.confidence,
    factors: snap.factors,
  };
}

/**
 * Rang du serveur parmi ceux de taille comparable (de la moitié au double de
 * membres), sur le même jour et le même modèle. Seuls des scores sont lus :
 * aucune information sur les autres serveurs ne sort de cette fonction.
 */
async function loadBenchmark(guildId: string, dateKey: string, totalMembers: number, score: number): Promise<PulseBenchmark | null> {
  if (totalMembers <= 0) return null;
  const minMembers = Math.max(1, Math.floor(totalMembers / 2));
  const maxMembers = totalMembers * 2;
  const peers = await prismaRead.pulseSnapshot.findMany({
    where: {
      dateKey,
      modelVersion: PULSE_MODEL_VERSION,
      totalMembers: { gte: minMembers, lte: maxMembers },
      guildId: { not: guildId },
    },
    select: { score: true },
    take: 5000,
  });
  const percentile = percentileRank(score, peers.map((p) => p.score));
  return percentile === null ? null : { percentile, peers: peers.length, minMembers, maxMembers };
}

const METRIC_SELECT = {
  totalMessages: true,
  totalVoiceMinutes: true,
  activeMembers: true,
  totalMembers: true,
  membersJoined: true,
  membersLeft: true,
  sanctionsCount: true,
  ticketsResolved: true,
  ticketsOpen: true,
  channelsHealthy: true,
  channelsUnhealthy: true,
} as const;

function pickMetrics(row: PulseMetrics): PulseMetrics {
  return Object.fromEntries(Object.keys(METRIC_SELECT).map((k) => [k, row[k as keyof PulseMetrics]])) as unknown as PulseMetrics;
}

/**
 * Données du dashboard Pulse.
 *
 * `current` est le dernier jour **complet** enregistré ; `today` est un aperçu du
 * jour en cours recalculé à la volée (donc partiel, non persisté).
 */
export async function getPulseDashboardData(guildId: string): Promise<PulseData> {
  const [history, bumpStatus] = await Promise.all([
    prismaRead.pulseSnapshot.findMany({
      where: { guildId },
      orderBy: { dateKey: 'desc' },
      take: HISTORY_DAYS,
      select: {
        dateKey: true,
        score: true,
        activityScore: true,
        moderationScore: true,
        growthScore: true,
        engagementScore: true,
        healthScore: true,
        trend: true,
        trendDelta: true,
        alerts: true,
        ...METRIC_SELECT,
      },
    }),
    getBumpStatus(guildId),
  ]);

  const latest = history[0] ?? null;

  if (!latest) {
    return {
      hasData: false,
      current: toView(
        {
          dateKey: lastCompleteDateKey(),
          score: 0,
          activityScore: 0,
          moderationScore: 0,
          growthScore: 0,
          engagementScore: 0,
          healthScore: 0,
          trend: 'STABLE',
          trendDelta: 0,
          alerts: [],
        },
        false,
      ),
      today: null,
      history: [],
      metrics: { ...EMPTY_METRICS },
      bumpStatus,
      benchmark: null,
      modelVersion: PULSE_MODEL_VERSION,
    };
  }

  const todayKey = toDateKey();

  return {
    hasData: true,
    current: toView(latest, latest.dateKey === todayKey),
    today: null,
    history: history
      .slice()
      .reverse()
      .map((s) => ({
        dateKey: s.dateKey,
        score: s.score,
        activityScore: s.activityScore,
        moderationScore: s.moderationScore,
        growthScore: s.growthScore,
        engagementScore: s.engagementScore,
        healthScore: s.healthScore,
        alerts: Array.isArray(s.alerts) ? (s.alerts as unknown as PulseAlert[]) : [],
        ...pickMetrics(s),
      })),
    metrics: pickMetrics(latest),
    bumpStatus,
    benchmark: null,
    modelVersion: PULSE_MODEL_VERSION,
  };
}

/**
 * Variante complète, utilisée par le dashboard :
 *   - le dernier jour complet est recalculé à la volée, ce qui donne ses
 *     facteurs (« pourquoi ce score ») et sa confiance, que le snapshot stocké
 *     ne garde pas ;
 *   - l'aperçu (non persisté) du jour en cours est ajouté ;
 *   - le rang parmi les serveurs de même taille est lu.
 */
export async function getPulseDashboardDataWithToday(
  client: Client,
  guildId: string,
): Promise<PulseData> {
  const todayKey = toDateKey();
  const lastKey = lastCompleteDateKey();
  const [base, todayContexts, lastContexts] = await Promise.all([
    getPulseDashboardData(guildId),
    loadPulseContexts(client, [guildId], todayKey),
    loadPulseContexts(client, [guildId], lastKey),
  ]);

  let data = base;

  const lastCtx = lastContexts.get(guildId);
  if (lastCtx) {
    const snapshot = buildSnapshot(guildId, lastKey, lastCtx);
    const hasSignal = snapshot.metrics.totalMessages > 0 || snapshot.metrics.totalVoiceMinutes > 0 || snapshot.metrics.membersJoined > 0;
    if (base.hasData || hasSignal) {
      data = { ...data, hasData: true, current: computedView(snapshot, false), metrics: snapshot.metrics };
    }
  }

  const todayCtx = todayContexts.get(guildId);
  if (todayCtx) {
    const snapshot = buildSnapshot(guildId, todayKey, todayCtx);
    const hasSignal = snapshot.metrics.totalMessages > 0 || snapshot.metrics.totalVoiceMinutes > 0;
    if (hasSignal) {
      // Une journée entamée sera toujours « en baisse » face à une journée
      // entière, et « activité très faible » à 9 h est un artefact de l'heure :
      // l'aperçu n'a ni tendance ni alertes. La comparaison n'a de sens
      // qu'entre jours complets, c'est `current` qui la porte.
      const view = computedView({ ...snapshot, trend: 'STABLE', trendDelta: 0, alerts: [] }, true);
      data = { ...data, hasData: true, today: { ...view, metrics: snapshot.metrics } };
    }
  }

  if (data.hasData) {
    try {
      data = { ...data, benchmark: await loadBenchmark(guildId, data.current.dateKey, data.metrics.totalMembers, data.current.score) };
    } catch (error) {
      // Le rang est un bonus : son échec ne doit pas priver la page du reste.
      logger.warn('Pulse', `Comparaison aux serveurs de même taille impossible pour ${guildId}:`, error);
    }
  }

  return data;
}
