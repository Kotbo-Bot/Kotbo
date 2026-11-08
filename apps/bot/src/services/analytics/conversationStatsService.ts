/**
 * conversationStatsService.ts
 *
 * Collecte des stats de conversation, vidée en base avec le même flush groupé
 * que les autres analytics :
 *   - interactions : qui répond à qui (réponse Discord) et qui mentionne qui,
 *     un compteur par paire et par jour (member_interaction_daily_stats) ;
 *   - temps de réponse par salon (channel_response_daily_stats).
 *
 * Un « tour » commence quand un membre prend la parole dans un salon. Il est
 * répondu dès qu'un autre membre écrit dans le même salon (ou fil) dans les
 * 6 heures ; sinon il compte comme resté sans réponse. Les messages qu'un
 * membre enchaîne seul prolongent son tour, ils n'en ouvrent pas un nouveau.
 *
 * Aucun contenu n'est gardé : seulement des identifiants et des compteurs.
 * La collecte suit `Guild.analyticsEnabled` (vérifié par l'appelant).
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from './analyticsBulkFlush.js';

export const RESPONSE_WINDOW_MS = 6 * 3600 * 1000;

export type ResponseBucket = 'under1m' | 'under5m' | 'under15m' | 'under1h' | 'under6h';

export function delayBucket(seconds: number): ResponseBucket {
  if (seconds < 60) return 'under1m';
  if (seconds < 300) return 'under5m';
  if (seconds < 900) return 'under15m';
  if (seconds < 3600) return 'under1h';
  return 'under6h';
}

export type TurnEvent =
  | { kind: 'answered'; guildId: string; statsChannelId: string; dateKey: string; delaySec: number }
  | { kind: 'unanswered'; guildId: string; statsChannelId: string; dateKey: string };

interface PendingTurn {
  guildId: string;
  statsChannelId: string;
  authorId: string;
  at: number;
}

/**
 * Tours de parole en attente, un par salon. Sans état partagé ni base : les
 * événements rendus sont déposés dans les tampons par l'appelant.
 */
export class ResponseTracker {
  private pending = new Map<string, PendingTurn>();

  onMessage(guildId: string, channelId: string, statsChannelId: string, authorId: string, at: number): TurnEvent[] {
    const events: TurnEvent[] = [];
    const turn = this.pending.get(channelId);
    if (turn && turn.authorId === authorId && at - turn.at <= RESPONSE_WINDOW_MS) return events;
    if (turn) {
      const dateKey = new Date(turn.at).toISOString().slice(0, 10);
      const delay = at - turn.at;
      events.push(
        delay <= RESPONSE_WINDOW_MS
          ? { kind: 'answered', guildId, statsChannelId: turn.statsChannelId, dateKey, delaySec: Math.max(0, Math.round(delay / 1000)) }
          : { kind: 'unanswered', guildId, statsChannelId: turn.statsChannelId, dateKey },
      );
    }
    this.pending.set(channelId, { guildId, statsChannelId, authorId, at });
    return events;
  }

  /** Clôt les tours restés sans réponse plus de 6 heures. */
  sweep(now: number): TurnEvent[] {
    const events: TurnEvent[] = [];
    for (const [channelId, turn] of this.pending) {
      if (now - turn.at <= RESPONSE_WINDOW_MS) continue;
      events.push({ kind: 'unanswered', guildId: turn.guildId, statsChannelId: turn.statsChannelId, dateKey: new Date(turn.at).toISOString().slice(0, 10) });
      this.pending.delete(channelId);
    }
    return events;
  }

  /** Un salon supprimé ou un serveur quitté n'a plus de tour à suivre. */
  forget(predicate: (turn: PendingTurn) => boolean): void {
    for (const [channelId, turn] of this.pending) if (predicate(turn)) this.pending.delete(channelId);
  }

  get size(): number {
    return this.pending.size;
  }
}

// ── Tampons ────────────────────────────────────────────────────────────────

const SEP = '\u0001';
const MAX_BUFFERED_KEYS = 50_000;
const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const RESPONSE_COLUMNS = ['answered', 'unanswered', 'delaySumSec', 'under1m', 'under5m', 'under15m', 'under1h', 'under6h'] as const;
const INTERACTION_COLUMNS = ['replies', 'mentions'] as const;

type ResponseCounters = Partial<Record<(typeof RESPONSE_COLUMNS)[number], number>>;
type InteractionCounters = Partial<Record<(typeof INTERACTION_COLUMNS)[number], number>>;

const responseBuffer = new Map<string, ResponseCounters>();
const interactionBuffer = new Map<string, InteractionCounters>();
export const responseTracker = new ResponseTracker();

function add<T extends Record<string, number | undefined>>(buffer: Map<string, T>, key: string, counters: T): void {
  const current = (buffer.get(key) ?? {}) as Record<string, number>;
  for (const [col, value] of Object.entries(counters)) {
    if (value) current[col] = (current[col] ?? 0) + value;
  }
  buffer.set(key, current as T);
  if (responseBuffer.size + interactionBuffer.size >= MAX_BUFFERED_KEYS) void flushConversationStats();
}

export function queueTurnEvents(events: TurnEvent[]): void {
  for (const e of events) {
    const key = [e.guildId, e.dateKey, e.statsChannelId].join(SEP);
    if (e.kind === 'answered') add(responseBuffer, key, { answered: 1, delaySumSec: e.delaySec, [delayBucket(e.delaySec)]: 1 });
    else add(responseBuffer, key, { unanswered: 1 });
  }
}

export function queueInteraction(guildId: string, dateKey: string, userId: string, targetUserId: string, counters: InteractionCounters): void {
  if (userId === targetUserId) return;
  add(interactionBuffer, [guildId, dateKey, userId, targetUserId].join(SEP), counters);
}

const RESPONSE_TARGET: BulkTarget = {
  label: 'ChannelResponseDailyStats',
  table: 'channel_response_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'channelId', type: 'text' },
  ],
  counterColumns: RESPONSE_COLUMNS,
};

const INTERACTION_TARGET: BulkTarget = {
  label: 'MemberInteractionDailyStats',
  table: 'member_interaction_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'userId', type: 'text' },
    { name: 'targetUserId', type: 'text' },
  ],
  counterColumns: INTERACTION_COLUMNS,
};

async function runFlush(): Promise<void> {
  const responses = [...responseBuffer.entries()];
  responseBuffer.clear();
  const interactions = [...interactionBuffer.entries()];
  interactionBuffer.clear();

  const responseRows: BulkRow[] = [];
  for (const [key, data] of responses) {
    const row = buildBulkRow(key.split(SEP), RESPONSE_COLUMNS, data);
    if (row) responseRows.push(row);
  }
  const interactionRows: BulkRow[] = [];
  for (const [key, data] of interactions) {
    const row = buildBulkRow(key.split(SEP), INTERACTION_COLUMNS, data);
    if (row) interactionRows.push(row);
  }
  await flushBulk(RESPONSE_TARGET, responseRows);
  await flushBulk(INTERACTION_TARGET, interactionRows);
}

let flushInFlight: Promise<void> | null = null;

export async function flushConversationStats(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = runFlush()
    .catch((error) => logger.error('ConversationStats', 'Flush des stats de conversation impossible :', error))
    .finally(() => {
      flushInFlight = null;
    });
  return flushInFlight;
}

let timers: Array<ReturnType<typeof setInterval>> = [];

export function startConversationStatsFlusher(): void {
  if (timers.length > 0) return;
  timers = [
    setInterval(() => void flushConversationStats(), FLUSH_INTERVAL_MS),
    setInterval(() => queueTurnEvents(responseTracker.sweep(Date.now())), SWEEP_INTERVAL_MS),
  ];
  for (const timer of timers) if (typeof timer.unref === 'function') timer.unref();
  process.on('beforeExit', () => void flushConversationStats());
}

/** Taille des tampons, pour les tests. */
export function conversationBufferSizes(): { responses: number; interactions: number } {
  return { responses: responseBuffer.size, interactions: interactionBuffer.size };
}
