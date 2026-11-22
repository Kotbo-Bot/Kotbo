/**
 * Analytics Module - Bus-based subscriber
 *
 * Subscribes to KotboEventBus events and delegates to the existing
 * analytics + staff services. Runs independently of other modules;
 * if this module throws, leveling/moderation/etc. are unaffected.
 */

import type { Client } from 'discord.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import {
  trackMessage,
  trackVoiceSession,
  trackMemberJoin,
  trackMemberLeave,
  trackReaction,
  trackThreadCreation,
  trackReply,
} from '../services/analytics/analyticsService.js';
import { trackGhostSignal } from '../services/analytics/ghostActivityTracker.js';
import { logStaffVoiceSession } from '../services/staff/staffLeadershipService.js';
import { recordVoiceJoin, recordVoiceLeave } from '../services/moderation/dc/voiceTracking.js';
import { logger } from '../utils/logger.js';

const MODULE_NAME = 'analytics';

export function registerAnalyticsBusSubscribers(client: Client): void {
  // ── Messages ──────────────────────────────────────────────────
  subscribeForModule('analytics', 'message:new', async (payload) => {
    if (payload.isBot) return;

    await trackMessage(payload.guildId, payload.channelId, payload.authorId);
    if (payload.hasReference) {
      await trackReply(payload.guildId, payload.authorId);
    }
  }, MODULE_NAME);

  // ── Voice Sessions ────────────────────────────────────────────
  subscribeForModule('analytics', 'voice:join', async (payload) => {
    await logStaffVoiceSession(
      payload.guildId,
      payload.userId,
      payload.channelId,
      payload.channelName,
      new Date(payload.timestamp),
    );
    // Timeline vocale pour la détection de double comptes (alternance de présence).
    void recordVoiceJoin(payload.guildId, payload.userId, payload.channelId, new Date(payload.timestamp));
  }, MODULE_NAME);

  subscribeForModule('analytics', 'voice:leave', async (payload) => {
    await logStaffVoiceSession(
      payload.guildId,
      payload.userId,
      payload.channelId,
      payload.channelName,
      payload.joinTimestamp ? new Date(payload.joinTimestamp) : new Date(),
      new Date(payload.timestamp),
    );

    // Ferme la session vocale dans la timeline DC.
    void recordVoiceLeave(
      payload.guildId,
      payload.userId,
      payload.channelId,
      payload.joinTimestamp ? new Date(payload.joinTimestamp) : new Date(payload.timestamp),
      new Date(payload.timestamp),
    );

    if (payload.durationMs && payload.durationMs > 0) {
      const durationMinutes = Math.floor(payload.durationMs / 60000);
      if (durationMinutes > 0) {
        await trackVoiceSession(payload.guildId, payload.userId, durationMinutes, payload.channelId);
      }
    }
  }, MODULE_NAME);

  subscribeForModule('analytics', 'voice:move', async (payload) => {
    const now = new Date(payload.timestamp);
    await logStaffVoiceSession(
      payload.guildId,
      payload.userId,
      payload.fromChannelId,
      payload.fromChannelName,
      payload.joinTimestamp ? new Date(payload.joinTimestamp) : now,
      now,
    );
    await logStaffVoiceSession(
      payload.guildId,
      payload.userId,
      payload.toChannelId,
      payload.toChannelName,
      now,
    );

    // Timeline DC : ferme l'ancien salon, ouvre le nouveau.
    void recordVoiceLeave(
      payload.guildId,
      payload.userId,
      payload.fromChannelId,
      payload.joinTimestamp ? new Date(payload.joinTimestamp) : now,
      now,
    );
    void recordVoiceJoin(payload.guildId, payload.userId, payload.toChannelId, now);

    if (payload.joinTimestamp) {
      const durationMs = Date.now() - payload.joinTimestamp;
      const durationMinutes = Math.floor(durationMs / 60000);
      if (durationMinutes > 0) {
        await trackVoiceSession(payload.guildId, payload.userId, durationMinutes, payload.fromChannelId);
      }
    }
  }, MODULE_NAME);

  // ── Members ───────────────────────────────────────────────────
  subscribeForModule('analytics', 'member:join', async (payload) => {
    if (payload.isBot) return;
    await trackMemberJoin(payload.guildId);
  }, MODULE_NAME);

  subscribeForModule('analytics', 'member:leave', async (payload) => {
    if (payload.isBot) return;
    await trackMemberLeave(payload.guildId);
  }, MODULE_NAME);

  // ── Reactions ─────────────────────────────────────────────────
  subscribeForModule('analytics', 'reaction:add', async (payload) => {
    await trackReaction(payload.guildId, payload.userId);
    // Ghost Analyzer : réagir sans écrire est le signal typique du spectateur
    trackGhostSignal(payload.guildId, payload.userId, 'reaction');
  }, MODULE_NAME);

  // ── Threads ───────────────────────────────────────────────────
  subscribeForModule('analytics', 'thread:create', async (payload) => {
    if (payload.creatorId) {
      await trackThreadCreation(payload.guildId, payload.creatorId);
    }
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}
