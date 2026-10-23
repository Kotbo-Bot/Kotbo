/**
 * Welcome/Goodbye Module - Bus-based subscriber
 *
 * Handles member join/leave/boost events via the bus.
 * applyJoinAutoRole needs the full GuildMember object, so it fetches
 * from Discord cache/API as needed.
 *
 * Le rôle "tag de serveur" est géré par tagRoleService.ts / raidProtection.ts
 * (basé sur l'API officielle Discord, pas sur un pattern de pseudo).
 */

import type { Client } from 'discord.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import {
  handleGuildMemberAdd,
  handleGuildMemberRemove,
  handleGuildBoost,
  applyJoinAutoRole,
} from '../services/features/welcomeGoodbyeService.js';
import { handleWelcomeThread } from '../services/features/welcomeThreadService.js';
import { assignWelcomeVariant } from '../services/features/welcomeExperimentService.js';
import { checkMemberCountTriggers } from '../services/core/ctfTriggerService.js';
import { syncMemberClanFromDcLink, autoAssignClanOnJoin, awardClanPointsOnBoost } from '../services/community/clanService.js';
import { logger } from '../utils/logger.js';

const MODULE_NAME = 'welcome-goodbye';

export function registerWelcomeGoodbyeBusSubscribers(client: Client): void {
  // ── Member Join ───────────────────────────────────────────────
  subscribeForModule('welcome_goodbye', 'member:join', async (payload) => {
    if (payload.isBot) return;

    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    const member = guild.members.cache.get(payload.userId)
      ?? await guild.members.fetch(payload.userId).catch(() => null);
    if (!member) return;

    await applyJoinAutoRole(member);
    await syncMemberClanFromDcLink(payload.guildId, payload.userId, null);
    await autoAssignClanOnJoin(payload.guildId, member);
    // Version du test A/B d'accueil en cours, s'il y en a un.
    const variant = await assignWelcomeVariant(payload.guildId, payload.userId);
    await handleGuildMemberAdd(member, client, variant);
    if (variant?.threadEnabled !== false) await handleWelcomeThread(member, client);
    await checkMemberCountTriggers(guild, client);
  }, MODULE_NAME);

  // ── Member Leave ──────────────────────────────────────────────
  subscribeForModule('welcome_goodbye', 'member:leave', async (payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    const partialMember = {
      id: payload.userId,
      guild,
      displayName: payload.userTag.split('#')[0],
      user: { username: payload.userTag.split('#')[0] },
    };

    await handleGuildMemberRemove(partialMember, client);
  }, MODULE_NAME);

  // ── Member Update (boost detection) ───────────────────────────
  subscribeForModule('welcome_goodbye', 'member:update', async (payload) => {
    if (!payload.isBoosting) return;

    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    const member = guild.members.cache.get(payload.userId)
      ?? await guild.members.fetch(payload.userId).catch(() => null);
    if (!member) return;

    await handleGuildBoost(member, client);
    await awardClanPointsOnBoost(payload.guildId, member);
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}
