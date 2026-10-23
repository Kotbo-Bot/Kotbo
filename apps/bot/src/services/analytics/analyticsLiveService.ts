/**
 * analyticsLiveService.ts
 *
 * Temps réel d'Analytics : compteurs minute par minute des 30 dernières
 * minutes, en mémoire, pour chaque serveur qui collecte ses analytics. Rien
 * n'est écrit en base ; un redémarrage repart de zéro (`since` le dit).
 *
 * Diffusion : les pages Analytics ouvertes s'abonnent par WebSocket au sujet
 * `analytics-live:<guildId>` (droit de lecture vérifié à l'abonnement, cf.
 * dashboardApi.ts). Toutes les 5 secondes, chaque serveur suivi par au moins
 * un onglet reçoit un instantané, seulement s'il a changé.
 */

import type { Client } from 'discord.js';
import { logger } from '../../utils/logger.js';

export const LIVE_WINDOW_MINUTES = 30;
const PUBLISH_INTERVAL_MS = 5_000;
const MINUTE_MS = 60_000;

interface MinuteBucket {
  messages: number;
  joins: number;
  leaves: number;
  authors: Set<string>;
  channels: Map<string, number>;
}

/** Fenêtre glissante d'un serveur. Pure : l'horloge est passée en argument. */
export class LiveWindow {
  private buckets = new Map<number, MinuteBucket>();

  private bucket(at: number): MinuteBucket {
    const minute = Math.floor(at / MINUTE_MS);
    let b = this.buckets.get(minute);
    if (!b) {
      b = { messages: 0, joins: 0, leaves: 0, authors: new Set(), channels: new Map() };
      this.buckets.set(minute, b);
    }
    return b;
  }

  message(channelId: string, authorId: string, at: number): void {
    const b = this.bucket(at);
    b.messages += 1;
    b.authors.add(authorId);
    b.channels.set(channelId, (b.channels.get(channelId) ?? 0) + 1);
  }

  join(at: number): void {
    this.bucket(at).joins += 1;
  }

  leave(at: number): void {
    this.bucket(at).leaves += 1;
  }

  /** Oublie ce qui sort de la fenêtre. Rend vrai si la fenêtre est vide. */
  prune(now: number): boolean {
    const oldest = Math.floor(now / MINUTE_MS) - LIVE_WINDOW_MINUTES + 1;
    for (const minute of this.buckets.keys()) if (minute < oldest) this.buckets.delete(minute);
    return this.buckets.size === 0;
  }

  summary(now: number) {
    const current = Math.floor(now / MINUTE_MS);
    const minutes: Array<{ at: string; messages: number; joins: number; leaves: number }> = [];
    const authors = new Set<string>();
    const channels = new Map<string, number>();
    let messages = 0;
    let joins = 0;
    let leaves = 0;
    let last5 = 0;
    for (let i = LIVE_WINDOW_MINUTES - 1; i >= 0; i -= 1) {
      const minute = current - i;
      const b = this.buckets.get(minute);
      minutes.push({ at: new Date(minute * MINUTE_MS).toISOString(), messages: b?.messages ?? 0, joins: b?.joins ?? 0, leaves: b?.leaves ?? 0 });
      if (!b) continue;
      messages += b.messages;
      joins += b.joins;
      leaves += b.leaves;
      if (i < 5) last5 += b.messages;
      for (const a of b.authors) authors.add(a);
      for (const [c, n] of b.channels) channels.set(c, (channels.get(c) ?? 0) + n);
    }
    return {
      minutes,
      messages,
      joins,
      leaves,
      authors: authors.size,
      perMinute: Math.round((last5 / 5) * 10) / 10,
      channels: [...channels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    };
  }
}

const windows = new Map<string, LiveWindow>();
const subscribers = new Map<string, number>();
const lastPayload = new Map<string, string>();
const startedAt = new Date().toISOString();

function windowOf(guildId: string): LiveWindow {
  let w = windows.get(guildId);
  if (!w) {
    w = new LiveWindow();
    windows.set(guildId, w);
  }
  return w;
}

export function liveMessage(guildId: string, channelId: string, authorId: string, at = Date.now()): void {
  windowOf(guildId).message(channelId, authorId, at);
}

export function liveJoin(guildId: string, at = Date.now()): void {
  windowOf(guildId).join(at);
}

export function liveLeave(guildId: string, at = Date.now()): void {
  windowOf(guildId).leave(at);
}

/**
 * Résumé de la fenêtre d'un serveur sans la créer : nul quand rien n'a été
 * compté depuis 30 minutes (ou que le serveur ne collecte pas).
 */
export function peekLiveSummary(guildId: string, now = Date.now()): ReturnType<LiveWindow['summary']> | null {
  const w = windows.get(guildId);
  return w ? w.summary(now) : null;
}

export function addLiveSubscriber(guildId: string): void {
  subscribers.set(guildId, (subscribers.get(guildId) ?? 0) + 1);
}

export function removeLiveSubscriber(guildId: string): void {
  const n = (subscribers.get(guildId) ?? 1) - 1;
  if (n <= 0) {
    subscribers.delete(guildId);
    lastPayload.delete(guildId);
  } else {
    subscribers.set(guildId, n);
  }
}

export const liveTopic = (guildId: string) => `analytics-live:${guildId}`;

/** Instantané d'un serveur : compteurs de la fenêtre, vocal et présence actuels. */
export function liveSnapshot(client: Client, guildId: string, now = Date.now()) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const summary = windowOf(guildId).summary(now);
  const voiceByChannel = new Map<string, number>();
  let voiceNow = 0;
  for (const state of guild?.voiceStates.cache.values() ?? []) {
    if (!state.channelId || state.member?.user.bot) continue;
    voiceNow += 1;
    voiceByChannel.set(state.channelId, (voiceByChannel.get(state.channelId) ?? 0) + 1);
  }
  let onlineNow = 0;
  for (const presence of guild?.presences.cache.values() ?? []) {
    if (presence.status !== 'offline' && !presence.user?.bot) onlineNow += 1;
  }
  const channelName = (id: string) => {
    const c = guild?.channels.cache.get(id);
    return c?.name ?? null;
  };
  return {
    type: 'analytics_live',
    guildId,
    at: new Date(now).toISOString(),
    since: startedAt,
    windowMinutes: LIVE_WINDOW_MINUTES,
    ...summary,
    channels: summary.channels.map(([channelId, messages]) => ({ channelId, name: channelName(channelId), messages })),
    voiceNow,
    voiceChannels: [...voiceByChannel.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([channelId, members]) => ({ channelId, name: channelName(channelId), members })),
    onlineNow,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Lance la diffusion. `publish` est le `server.publish` du WebSocket du dashboard. */
export function startLivePublisher(client: Client, publish: (topic: string, payload: string) => void): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const [guildId, w] of windows) {
      if (w.prune(now) && !subscribers.has(guildId)) windows.delete(guildId);
    }
    for (const guildId of subscribers.keys()) {
      try {
        const snapshot = liveSnapshot(client, guildId, now);
        // L'horodatage change à chaque tour : on compare sans lui.
        const { at: _at, ...comparable } = snapshot;
        const key = JSON.stringify(comparable);
        if (lastPayload.get(guildId) === key) continue;
        lastPayload.set(guildId, key);
        publish(liveTopic(guildId), JSON.stringify(snapshot));
      } catch (err) {
        logger.warn('AnalyticsLive', `Instantané impossible pour ${guildId} :`, err);
      }
    }
  }, PUBLISH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
