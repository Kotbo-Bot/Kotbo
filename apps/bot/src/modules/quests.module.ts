/**
 * Quêtes - abonné au bus d'événements.
 *
 * Seul endroit qui traduit l'activité du serveur (messages, vocal, concours, niveaux...) en
 * progression de quêtes. Les actions du RPG passent, elles, par `trackRpgObjective`.
 */

import type { Client } from 'discord.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import { guildHasQuestObjective, trackRpgQuest } from '../services/features/rpg/rpgQuestService.js';
import type { QuestContext } from '../services/features/rpg/rpgQuestRules.js';
import prisma from '../utils/db.js';
import { cache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

const MODULE_NAME = 'economy';
const DAY_MS = 86_400_000;
const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Contexte d'un salon : un fil compte pour son salon parent, et la catégorie est celle du parent. */
function channelContext(client: Client, guildId: string, channelId: string): QuestContext {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  if (!channel) return { channelId };
  const base = channel.isThread() ? channel.parent : channel;
  return { channelId: base?.id ?? channelId, categoryId: base?.parentId ?? null };
}

/**
 * Série de jours d'activité et jours actifs sur la semaine, lus dans les statistiques
 * quotidiennes. Calculé une seule fois par membre et par jour, au premier message.
 */
async function trackDailyPresence(client: Client, guildId: string, userId: string, now: number): Promise<void> {
  const flag = `quests:presence:${guildId}:${userId}:${dayKey(now)}`;
  if (await cache.get(flag)) return;
  await cache.set(flag, 1, 26 * 3600);

  const [streakWanted, daysWanted] = await Promise.all([
    guildHasQuestObjective(guildId, 'ACTIVE_STREAK'),
    guildHasQuestObjective(guildId, 'ACTIVE_DAYS'),
  ]);
  if (!streakWanted && !daysWanted) return;

  const rows = await prisma.memberDailyStat.findMany({
    where: { guildId, userId, dateKey: { gte: dayKey(now - 60 * DAY_MS) } },
    select: { dateKey: true },
  });
  // Aujourd'hui compte d'office : la statistique du jour n'est peut-être pas encore écrite.
  const active = new Set(rows.map((row) => row.dateKey)).add(dayKey(now));

  let streak = 0;
  while (active.has(dayKey(now - streak * DAY_MS))) streak += 1;
  let weekDays = 0;
  for (let i = 0; i < 7; i += 1) if (active.has(dayKey(now - i * DAY_MS))) weekDays += 1;

  if (streakWanted) await trackRpgQuest(client, guildId, userId, 'ACTIVE_STREAK', streak);
  if (daysWanted) await trackRpgQuest(client, guildId, userId, 'ACTIVE_DAYS', weekDays);
}

export function registerQuestsBusSubscribers(client: Client): void {
  subscribeForModule(MODULE_NAME, 'message:new', async (payload) => {
    if (payload.isBot || payload.isCommand || payload.isInteraction) return;

    const context: QuestContext = {
      ...channelContext(client, payload.guildId, payload.channelId),
      content: payload.content ?? '',
      attachmentCount: payload.attachmentCount ?? 0,
      mentionCount: (payload.content?.match(/<@[!&]?\d+>/g) ?? []).length,
    };
    await trackRpgQuest(client, payload.guildId, payload.authorId, 'SEND_MESSAGES', 1, context);
    if (payload.hasReference) {
      await trackRpgQuest(client, payload.guildId, payload.authorId, 'REPLY_MESSAGES', 1, context);
    }
    await trackDailyPresence(client, payload.guildId, payload.authorId, payload.timestamp ?? Date.now());
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'voice:leave', async (payload) => {
    const minutes = Math.floor((payload.durationMs ?? 0) / 60_000);
    if (minutes <= 0) return;
    await trackRpgQuest(client, payload.guildId, payload.userId, 'VOICE_MINUTES', minutes, channelContext(client, payload.guildId, payload.channelId));
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'reaction:add', async (payload) => {
    await trackRpgQuest(client, payload.guildId, payload.userId, 'REACT_MESSAGES', 1, channelContext(client, payload.guildId, payload.channelId));
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'thread:create', async (payload) => {
    if (!payload.creatorId) return;
    await trackRpgQuest(client, payload.guildId, payload.creatorId, 'CREATE_THREADS', 1, channelContext(client, payload.guildId, payload.channelId));
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'reputation:given', async (payload) => {
    await trackRpgQuest(client, payload.guildId, payload.giverId, 'GIVE_REP', 1,
      payload.channelId ? channelContext(client, payload.guildId, payload.channelId) : {});
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'giveaway:entry', async (payload) => {
    await trackRpgQuest(client, payload.guildId, payload.userId, 'GIVEAWAYS_JOINED', 1, channelContext(client, payload.guildId, payload.channelId));
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'giveaway:winner', async (payload) => {
    await trackRpgQuest(client, payload.guildId, payload.userId, 'GIVEAWAYS_WON', 1, channelContext(client, payload.guildId, payload.channelId));
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'level:up', async (payload) => {
    await trackRpgQuest(client, payload.guildId, payload.userId, 'LEVEL_REACHED', payload.level);
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'ticket:created', async (payload) => {
    await trackRpgQuest(client, payload.guildId, payload.userId, 'TICKETS_OPENED', 1);
  }, MODULE_NAME);

  subscribeForModule(MODULE_NAME, 'suggestion:created', async (payload) => {
    await trackRpgQuest(client, payload.guildId, payload.userId, 'SUGGESTIONS_SENT', 1, channelContext(client, payload.guildId, payload.channelId));
  }, MODULE_NAME);

  // L'invitation compte quand le nouveau est un vrai membre, pour celui qui l'a invité.
  subscribeForModule(MODULE_NAME, 'member:join:invite', async (payload) => {
    if (payload.isBot || !payload.inviterId || payload.inviterId === payload.userId) return;
    await trackRpgQuest(client, payload.guildId, payload.inviterId, 'INVITES', 1);
  }, MODULE_NAME);

  logger.info('Modules', `Quêtes enregistrées sur le bus d'events.`);
}
