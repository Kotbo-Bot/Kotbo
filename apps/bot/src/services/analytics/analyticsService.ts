import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isAnalyticsCollectionEnabled } from './analyticsConsent.js';

/**
 * Helper to get the date string (YYYY-MM-DD) in a specific timezone or UTC
 */
export const getDateKey = (date: Date = new Date()): string => {
  return date.toISOString().split('T')[0];
};

/**
 * Helper to get the current hour (0-23)
 */
export const getHourKey = (date: Date = new Date()): number => {
  return date.getUTCHours();
};

// ============================================================================
// IN-MEMORY BUFFER MAPS
// ============================================================================

const guildDailyStatsBuffer = new Map<string, {
  messagesCount?: number;
  voiceMinutes?: number;
  voiceSessionsCount?: number;
  membersJoined?: number;
  membersLeft?: number;
  reactionsCount?: number;
}>();

const guildHourlyStatsBuffer = new Map<string, {
  messagesCount?: number;
  voiceMinutes?: number;
  joinsCount?: number;
  leavesCount?: number;
  reactionsCount?: number;
  threadsCount?: number;
}>();

const channelDailyStatsBuffer = new Map<string, {
  messagesCount?: number;
  voiceMinutes?: number;
}>();

const memberDailyStatsBuffer = new Map<string, {
  messagesCount?: number;
  voiceMinutes?: number;
  reactionsCount?: number;
  threadsCreated?: number;
  repliesCount?: number;
}>();

const channelDailyAuthors = new Map<string, Set<string>>();

// ============================================================================
// BUFFERING HELPERS
// ============================================================================

function queueGuildDaily(guildId: string, dateKey: string, increments: Record<string, number>) {
  const key = `${guildId}:${dateKey}`;
  const existing = guildDailyStatsBuffer.get(key) || {};
  for (const [col, val] of Object.entries(increments)) {
    const counters = existing as Record<string, number>;
    counters[col] = (counters[col] || 0) + val;
  }
  guildDailyStatsBuffer.set(key, existing);
}

function queueGuildHourly(guildId: string, dateKey: string, hour: number, increments: Record<string, number>) {
  const key = `${guildId}:${dateKey}:${hour}`;
  const existing = guildHourlyStatsBuffer.get(key) || {};
  for (const [col, val] of Object.entries(increments)) {
    const counters = existing as Record<string, number>;
    counters[col] = (counters[col] || 0) + val;
  }
  guildHourlyStatsBuffer.set(key, existing);
}

function queueChannelDaily(guildId: string, channelId: string, dateKey: string, increments: Record<string, number>) {
  const key = `${guildId}:${channelId}:${dateKey}`;
  const existing = channelDailyStatsBuffer.get(key) || {};
  for (const [col, val] of Object.entries(increments)) {
    const counters = existing as Record<string, number>;
    counters[col] = (counters[col] || 0) + val;
  }
  channelDailyStatsBuffer.set(key, existing);
}

function queueMemberDaily(guildId: string, userId: string, dateKey: string, increments: Record<string, number>) {
  const key = `${guildId}:${userId}:${dateKey}`;
  const existing = memberDailyStatsBuffer.get(key) || {};
  for (const [col, val] of Object.entries(increments)) {
    const counters = existing as Record<string, number>;
    counters[col] = (counters[col] || 0) + val;
  }
  memberDailyStatsBuffer.set(key, existing);
}

// ============================================================================
// FLUSH PROCESSORS
// ============================================================================

/**
 * Chaque flush écrivait un `upsert` par ligne bufferisée, le tout dans un
 * `$transaction` unique : un serveur actif ouvrait ainsi une transaction de
 * plusieurs milliers d'instructions toutes les 60 s, et les quatre partaient
 * en parallèle. Le pool saturait, Postgres refusait d'ouvrir la transaction
 * suivante (`P2028`) et le CPU partait en vrille sur des lots rejoués.
 *
 * Ici, une table se flushe en deux instructions par lot, quel que soit le
 * nombre de lignes : `createMany` crée les lignes manquantes à zéro, puis un
 * seul `UPDATE ... FROM (VALUES ...)` applique les compteurs.
 */

type BulkKeyColumn = { name: string; type: 'text' | 'int' };

type BulkRow = {
  keys: Array<string | number>;
  counters: Record<string, number>;
  overwrites?: Record<string, number>;
};

type BulkTarget = {
  label: string;
  table: string;
  keys: BulkKeyColumn[];
  counterColumns: readonly string[];
  overwriteColumns?: readonly string[];
  createMany: (data: Array<Record<string, string | number>>) => Prisma.PrismaPromise<unknown>;
};

const ANALYTICS_CHUNK_SIZE =
  Number.parseInt(process.env.ANALYTICS_CHUNK_SIZE ?? '200', 10) || 200;

/**
 * `maxWait` vaut 2 s par défaut côté Prisma : sous charge, l'attente d'une
 * connexion libre dépassait ce délai et le lot entier était perdu avant même
 * d'avoir touché la base. On laisse au pool le temps de se dégager.
 */
const ANALYTICS_TX_MAX_WAIT_MS =
  Number.parseInt(process.env.ANALYTICS_TX_MAX_WAIT_MS ?? '15000', 10) || 15000;
const ANALYTICS_TX_TIMEOUT_MS =
  Number.parseInt(process.env.ANALYTICS_TX_TIMEOUT_MS ?? '30000', 10) || 30000;

async function flushBulkChunk(target: BulkTarget, chunk: BulkRow[]): Promise<void> {
  const overwriteColumns = target.overwriteColumns ?? [];
  const columnTypes = [
    ...target.keys.map((key) => key.type),
    ...target.counterColumns.map(() => 'int' as const),
    ...overwriteColumns.map(() => 'int' as const),
  ];

  const params: unknown[] = [];
  const tuples = chunk.map((row) => {
    const base = params.length;
    params.push(
      ...row.keys,
      ...target.counterColumns.map((col) => row.counters[col] ?? 0),
      ...overwriteColumns.map((col) => row.overwrites?.[col] ?? 0),
    );
    return `(${columnTypes.map((type, index) => `$${base + 1 + index}::${type}`).join(', ')})`;
  });

  const valueColumns = [
    ...target.keys.map((key) => key.name),
    ...target.counterColumns,
    ...overwriteColumns,
  ]
    .map((col) => `"${col}"`)
    .join(', ');

  const setClause = [
    ...target.counterColumns.map((col) => `"${col}" = m."${col}" + v."${col}"`),
    ...overwriteColumns.map((col) => `"${col}" = v."${col}"`),
  ].join(', ');

  const whereClause = target.keys
    .map((key) => `m."${key.name}" = v."${key.name}"`)
    .join(' AND ');

  await prisma.$transaction(
    [
      // Les lignes absentes sont créées à zéro d'abord : l'UPDATE qui suit n'a
      // alors plus qu'à incrémenter, sans avoir à générer d'`id` cuid ni
      // d'`updatedAt` en SQL brut.
      target.createMany(
        chunk.map((row) => {
          const data: Record<string, string | number> = {};
          target.keys.forEach((key, index) => {
            data[key.name] = row.keys[index]!;
          });
          return data;
        }),
      ),
      prisma.$executeRawUnsafe(
        `UPDATE ${target.table} AS m
       SET ${setClause}, "updatedAt" = NOW()
       FROM (VALUES ${tuples.join(', ')}) AS v(${valueColumns})
       WHERE ${whereClause}`,
        ...params,
      ),
    ],
    { maxWait: ANALYTICS_TX_MAX_WAIT_MS, timeout: ANALYTICS_TX_TIMEOUT_MS },
  );
}

async function flushBulk(target: BulkTarget, rows: BulkRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += ANALYTICS_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + ANALYTICS_CHUNK_SIZE);
    await flushBulkChunk(target, chunk).catch((error) => {
      logger.error('Analytics', `Error flushing ${target.label} batch (offset ${i}):`, error);
    });
  }
}

/**
 * Une ligne sans aucun compteur non nul ne mérite ni création ni UPDATE : on
 * la laisse tomber ici plutôt que d'alourdir le lot.
 */
function buildBulkRow(
  keys: Array<string | number>,
  counterColumns: readonly string[],
  data: Record<string, number | undefined>,
  overwrites?: Record<string, number>,
): BulkRow | null {
  const counters: Record<string, number> = {};
  let hasValue = false;

  for (const col of counterColumns) {
    const value = data[col];
    if (value) {
      counters[col] = value;
      hasValue = true;
    } else {
      counters[col] = 0;
    }
  }

  if (overwrites && Object.values(overwrites).some((value) => value > 0)) hasValue = true;
  if (!hasValue) return null;

  return { keys, counters, overwrites };
}

const GUILD_DAILY_COUNTERS = [
  'messagesCount',
  'voiceMinutes',
  'voiceSessionsCount',
  'membersJoined',
  'membersLeft',
  'reactionsCount',
] as const;

const GUILD_DAILY_TARGET: BulkTarget = {
  label: 'GuildDailyStats',
  table: 'guild_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
  ],
  counterColumns: GUILD_DAILY_COUNTERS,
  createMany: (data) =>
    prisma.guildDailyStat.createMany({ data: data as never, skipDuplicates: true }),
};

async function flushGuildDailyStats(): Promise<void> {
  const entries = [...guildDailyStatsBuffer.entries()];
  guildDailyStatsBuffer.clear();

  const rows: BulkRow[] = [];
  for (const [key, data] of entries) {
    const [guildId, dateKey] = key.split(':');
    if (!guildId || !dateKey) continue;
    const row = buildBulkRow([guildId, dateKey], GUILD_DAILY_COUNTERS, data);
    if (row) rows.push(row);
  }

  await flushBulk(GUILD_DAILY_TARGET, rows);
}

const GUILD_HOURLY_COUNTERS = [
  'messagesCount',
  'voiceMinutes',
  'joinsCount',
  'leavesCount',
  'reactionsCount',
  'threadsCount',
] as const;

const GUILD_HOURLY_TARGET: BulkTarget = {
  label: 'GuildHourlyStats',
  table: 'guild_hourly_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'hour', type: 'int' },
  ],
  counterColumns: GUILD_HOURLY_COUNTERS,
  createMany: (data) =>
    prisma.guildHourlyStat.createMany({ data: data as never, skipDuplicates: true }),
};

async function flushGuildHourlyStats(): Promise<void> {
  const entries = [...guildHourlyStatsBuffer.entries()];
  guildHourlyStatsBuffer.clear();

  const rows: BulkRow[] = [];
  for (const [key, data] of entries) {
    const [guildId, dateKey, hourStr] = key.split(':');
    if (!guildId || !dateKey || !hourStr) continue;
    const hour = Number.parseInt(hourStr, 10);
    if (Number.isNaN(hour)) continue;
    const row = buildBulkRow([guildId, dateKey, hour], GUILD_HOURLY_COUNTERS, data);
    if (row) rows.push(row);
  }

  await flushBulk(GUILD_HOURLY_TARGET, rows);
}

const CHANNEL_DAILY_COUNTERS = ['messagesCount', 'voiceMinutes'] as const;

const CHANNEL_DAILY_TARGET: BulkTarget = {
  label: 'ChannelDailyStats',
  table: 'channel_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'channelId', type: 'text' },
    { name: 'dateKey', type: 'text' },
  ],
  counterColumns: CHANNEL_DAILY_COUNTERS,
  // `uniqueAuthors` est un décompte du jour, pas un delta : il s'écrase.
  overwriteColumns: ['uniqueAuthors'],
  createMany: (data) =>
    prisma.channelDailyStat.createMany({ data: data as never, skipDuplicates: true }),
};

async function flushChannelDailyStats(): Promise<void> {
  const currentDateKey = getDateKey();
  for (const key of channelDailyAuthors.keys()) {
    if (!key.endsWith(currentDateKey)) {
      channelDailyAuthors.delete(key);
    }
  }

  const entries = [...channelDailyStatsBuffer.entries()];
  channelDailyStatsBuffer.clear();

  const rows: BulkRow[] = [];
  for (const [key, data] of entries) {
    const [guildId, channelId, dateKey] = key.split(':');
    if (!guildId || !channelId || !dateKey) continue;

    const uniqueAuthors = channelDailyAuthors.get(key)?.size ?? 0;
    const row = buildBulkRow(
      [guildId, channelId, dateKey],
      CHANNEL_DAILY_COUNTERS,
      data,
      { uniqueAuthors },
    );
    if (row) rows.push(row);
  }

  await flushBulk(CHANNEL_DAILY_TARGET, rows);
}

const MEMBER_DAILY_COUNTERS = [
  'messagesCount',
  'voiceMinutes',
  'reactionsCount',
  'threadsCreated',
  'repliesCount',
] as const;

const MEMBER_DAILY_TARGET: BulkTarget = {
  label: 'MemberDailyStats',
  table: 'member_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'userId', type: 'text' },
    { name: 'dateKey', type: 'text' },
  ],
  counterColumns: MEMBER_DAILY_COUNTERS,
  createMany: (data) =>
    prisma.memberDailyStat.createMany({ data: data as never, skipDuplicates: true }),
};

async function flushMemberDailyStats(): Promise<void> {
  const entries = [...memberDailyStatsBuffer.entries()];
  memberDailyStatsBuffer.clear();

  const rows: BulkRow[] = [];
  for (const [key, data] of entries) {
    const [guildId, userId, dateKey] = key.split(':');
    if (!guildId || !userId || !dateKey) continue;
    const row = buildBulkRow([guildId, userId, dateKey], MEMBER_DAILY_COUNTERS, data);
    if (row) rows.push(row);
  }

  await flushBulk(MEMBER_DAILY_TARGET, rows);
}

/**
 * Les quatre flushes partaient ensemble et le minuteur en relançait un jeu
 * complet toutes les 60 s sans se soucier du précédent : sur une base lente,
 * les flushes s'empilaient et se disputaient le pool. Ils s'enchaînent
 * désormais, et un flush déjà en vol est rejoint plutôt que doublé.
 */
let flushInFlight: Promise<void> | null = null;

async function runAnalyticsFlush(): Promise<void> {
  await flushGuildDailyStats();
  await flushGuildHourlyStats();
  await flushChannelDailyStats();
  await flushMemberDailyStats();
}

export async function flushAllAnalyticsStats(): Promise<void> {
  if (flushInFlight) return flushInFlight;

  flushInFlight = runAnalyticsFlush()
    .catch((error) => {
      // Le minuteur appelle sans `await` : une exception qui remonterait ici
      // deviendrait un rejet non géré, donc un arrêt du bot.
      logger.error('Analytics', 'Error during analytics flush:', error);
    })
    .finally(() => {
      flushInFlight = null;
    });

  return flushInFlight;
}

/**
 * À 10 s, le flush repartait six fois par minute sur des compteurs à peine
 * remplis : Postgres passait plus de temps à ouvrir des transactions qu'à
 * écrire. À 60 s, les incréments d'un même membre s'agrègent en mémoire avant
 * d'atteindre la base. La contrepartie est la fenêtre de perte sur un crash
 * brutal — l'arrêt propre reste couvert par le `beforeExit` ci-dessous.
 */
const FLUSH_INTERVAL_MS =
  Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;

const flushInterval = setInterval(() => {
  void flushAllAnalyticsStats();
}, FLUSH_INTERVAL_MS);

// Final flush on process exit
process.on('beforeExit', () => {
  clearInterval(flushInterval);
  void flushAllAnalyticsStats();
});

// ============================================================================
// SERVICE EXPORTS (BUFFERED API)
// ============================================================================

/**
 * Increment message counts in analytics tables
 */
export const trackMessage = async (guildId: string, channelId: string, userId: string) => {
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();
  const hour = getHourKey();

  // 1. Queue Guild Daily Stat
  queueGuildDaily(guildId, dateKey, { messagesCount: 1 });

  // 2. Queue Guild Hourly Stat
  queueGuildHourly(guildId, dateKey, hour, { messagesCount: 1 });

  // 3. Queue Channel Daily Stat
  queueChannelDaily(guildId, channelId, dateKey, { messagesCount: 1 });

  // Track unique author
  const authorsKey = `${guildId}:${channelId}:${dateKey}`;
  let authorsSet = channelDailyAuthors.get(authorsKey);
  if (!authorsSet) {
    authorsSet = new Set<string>();
    channelDailyAuthors.set(authorsKey, authorsSet);
  }
  authorsSet.add(userId);

  // 4. Queue Member Daily Stat
  queueMemberDaily(guildId, userId, dateKey, { messagesCount: 1 });
};

/**
 * Increment voice minutes in analytics tables
 */
export const trackVoiceSession = async (guildId: string, userId: string, durationMinutes: number, channelId?: string) => {
  if (durationMinutes <= 0) return;
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();
  const hour = getHourKey();

  queueGuildDaily(guildId, dateKey, {
    voiceMinutes: durationMinutes,
    voiceSessionsCount: 1
  });

  queueGuildHourly(guildId, dateKey, hour, {
    voiceMinutes: durationMinutes
  });

  queueMemberDaily(guildId, userId, dateKey, {
    voiceMinutes: durationMinutes
  });

  if (channelId) {
    queueChannelDaily(guildId, channelId, dateKey, {
      voiceMinutes: durationMinutes
    });
  }
};

/**
 * Record a member join
 */
export const trackMemberJoin = async (guildId: string) => {
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();
  const hour = getHourKey();

  queueGuildDaily(guildId, dateKey, { membersJoined: 1 });
  queueGuildHourly(guildId, dateKey, hour, { joinsCount: 1 });
};

/**
 * Record a member leave
 */
export const trackMemberLeave = async (guildId: string) => {
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();
  const hour = getHourKey();

  queueGuildDaily(guildId, dateKey, { membersLeft: 1 });
  queueGuildHourly(guildId, dateKey, hour, { leavesCount: 1 });
};

/**
 * Track message reactions
 */
export const trackReaction = async (guildId: string, userId: string) => {
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();
  const hour = getHourKey();

  queueGuildDaily(guildId, dateKey, { reactionsCount: 1 });
  queueGuildHourly(guildId, dateKey, hour, { reactionsCount: 1 });
  queueMemberDaily(guildId, userId, dateKey, { reactionsCount: 1 });
};

/**
 * Track thread creation
 */
export const trackThreadCreation = async (guildId: string, userId: string) => {
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();
  const hour = getHourKey();

  queueGuildHourly(guildId, dateKey, hour, { threadsCount: 1 });
  queueMemberDaily(guildId, userId, dateKey, { threadsCreated: 1 });
};

/**
 * Track message reply
 */
export const trackReply = async (guildId: string, userId: string) => {
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();

  queueMemberDaily(guildId, userId, dateKey, { repliesCount: 1 });
};

/**
 * Snapshot server population (total members, online, offline, bots vs humans)
 */
export const snapshotServerPopulation = async (
  guildId: string, 
  stats: {
    totalMembers: number;
    onlineMembers: number;
    idleMembers: number;
    dndMembers: number;
    offlineMembers: number;
    totalBots: number;
    totalHumans: number;
    activeMembers?: number;
    activeVoiceMembers?: number;
  }
) => {
  if (!(await isAnalyticsCollectionEnabled(guildId))) return;

  const dateKey = getDateKey();

  const optionalFields = {
    ...(stats.activeMembers !== undefined ? { activeMembers: stats.activeMembers } : {}),
    ...(stats.activeVoiceMembers !== undefined ? { activeVoiceMembers: stats.activeVoiceMembers } : {}),
  };

  const populationData = {
    totalMembers: stats.totalMembers,
    onlineMembers: stats.onlineMembers,
    idleMembers: stats.idleMembers,
    dndMembers: stats.dndMembers,
    offlineMembers: stats.offlineMembers,
    totalBots: stats.totalBots,
    totalHumans: stats.totalHumans,
    ...optionalFields,
  };

  const hour = getHourKey();

  const [daily] = await Promise.all([
    prisma.guildDailyStat.upsert({
      where: { guildId_dateKey: { guildId, dateKey } },
      update: populationData,
      create: { guildId, dateKey, ...populationData },
    }),
    prisma.guildHourlyStat.upsert({
      where: { guildId_dateKey_hour: { guildId, dateKey, hour } },
      update: { onlineMembers: stats.onlineMembers },
      create: { guildId, dateKey, hour, onlineMembers: stats.onlineMembers },
    }),
  ]);

  if (stats.onlineMembers > daily.peakOnline) {
    await prisma.guildDailyStat.update({
      where: { id: daily.id },
      data: { peakOnline: stats.onlineMembers },
    });
  }
};
