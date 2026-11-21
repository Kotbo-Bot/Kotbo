/**
 * Cœur du système Ranked : conversion de l'activité en RP, séries, paliers.
 *
 * Ce service ne compte rien lui-même. Il est greffé sur le pipeline d'XP :
 * `addXp` lui transmet l'XP réellement accordée, et il en dérive du RP. Tous
 * les garde-fous déjà en place (cooldown, salons/rôles exclus, plafond
 * quotidien d'XP) protègent donc le RP sans être réimplémentés.
 *
 * Le RP a en revanche son propre stockage, parce qu'il redescend (decay, reset
 * de saison) là où l'XP ne peut que monter.
 */

import type { Client, Guild as DiscordGuild, GuildMember } from 'discord.js';
import type { RankedConfig, RankedMember } from '@prisma/client';
import {
  computeRpGain,
  computeStreakUpdate,
  compareRankedTiers,
  grantedWithinDailyRpCap,
  isStreakAlive,
  rankedDayKey,
  rankedProgress,
  rankedTierByKey,
  resolveRankedTier,
  streakFlames,
  streakMultiplier,
  type RankedLadder,
  type RankedLadderEntry,
  type RpSource,
} from '@kotbo/shared';
import prisma, { prismaRead } from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import { logger } from '../../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';
import {
  getGuildLadder,
  getRankedConfigSafe,
  getTierRoles,
  streakConfigFromRankedConfig,
} from './rankedConfigService.js';
import { getActiveEventMultiplier, creditEventBonus } from './rankedEventService.js';

const LOG_TAG = 'RankedService';

export async function getOrCreateRankedMember(guildId: string, userId: string): Promise<RankedMember> {
  const existing = await prismaRead.rankedMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
  if (existing) return existing;

  await upsertRetryingRace(() => prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } }));
  return upsertRetryingRace(() => prisma.rankedMember.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: {},
    create: { guildId, userId },
  }));
}

/**
 * Décompte `amount` du plafond de RP quotidien et renvoie la part accordable.
 *
 * Même sens de lecture que le plafond d'XP : on incrémente d'abord, on demande
 * ensuite ce qui tenait sous le plafond. Deux gains concurrents ne peuvent donc
 * pas le franchir ensemble, ce qu'un « je lis puis j'écris » autoriserait.
 */
async function consumeDailyRpAllowance(guildId: string, userId: string, amount: number, cap: number): Promise<number> {
  if (cap <= 0) return amount;

  const dateKey = rankedDayKey();

  // `not` seul laisserait passer les lignes à NULL : en SQL `NULL <> 'x'` n'est
  // pas vrai. Les deux cas sont donc listés.
  await prisma.rankedMember.updateMany({
    where: { guildId, userId, OR: [{ dailyRpDate: null }, { dailyRpDate: { not: dateKey } }] },
    data: { dailyRp: 0, dailyReactions: 0, dailyRpDate: dateKey },
  });

  const counter = await prisma.rankedMember.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: { dailyRp: { increment: amount } },
    create: { guildId, userId, dailyRp: amount, dailyRpDate: dateKey },
  });

  if (counter.dailyRp <= cap) return amount;

  await prisma.rankedMember.update({
    where: { guildId_userId: { guildId, userId } },
    data: { dailyRp: cap },
  }).catch(() => null);

  return grantedWithinDailyRpCap(counter.dailyRp, amount, cap);
}

/**
 * Décompte une réaction du quota quotidien. Renvoie `false` si le quota est
 * épuisé - sans quoi un membre pourrait spammer les réactions sur un vieux
 * message pour grimper sans jamais écrire.
 */
async function consumeReactionAllowance(guildId: string, userId: string, cap: number): Promise<boolean> {
  if (cap <= 0) return true;

  const dateKey = rankedDayKey();

  await prisma.rankedMember.updateMany({
    where: { guildId, userId, OR: [{ dailyRpDate: null }, { dailyRpDate: { not: dateKey } }] },
    data: { dailyRp: 0, dailyReactions: 0, dailyRpDate: dateKey },
  });

  const counter = await prisma.rankedMember.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: { dailyReactions: { increment: 1 } },
    create: { guildId, userId, dailyReactions: 1, dailyRpDate: dateKey },
  });

  return counter.dailyReactions <= cap;
}

export type RpDeltaResult = {
  rpBefore: number;
  rpAfter: number;
  granted: number;
  tierBefore: RankedLadderEntry;
  tierAfter: RankedLadderEntry;
  /** > 0 promotion, < 0 rétrogradation, 0 palier inchangé. */
  tierShift: number;
  streakDays: number;
};

/**
 * Applique un mouvement de RP et en tire toutes les conséquences : palier,
 * pic de saison, rôles, annonce, journal.
 *
 * Point de passage unique de toute écriture de RP (activité, événement, decay,
 * ajustement staff), pour qu'aucune source ne puisse contourner le plancher à
 * zéro ni oublier de synchroniser les rôles de palier.
 */
export async function applyRpDelta(
  guildId: string,
  userId: string,
  delta: number,
  client: Client | null,
  options: { source: RpSource; detail?: string; announce?: boolean; log?: boolean } = { source: 'manual' },
): Promise<RpDeltaResult | null> {
  if (!Number.isFinite(delta) || delta === 0) return null;

  const ladder = await getGuildLadder(guildId);
  const before = await getOrCreateRankedMember(guildId, userId);

  const rpBefore = Math.max(0, before.rp);
  const rpAfter = Math.max(0, rpBefore + Math.floor(delta));
  const granted = rpAfter - rpBefore;
  if (granted === 0) return null;

  const tierBefore = resolveRankedTier(rpBefore, ladder);
  const tierAfter = resolveRankedTier(rpAfter, ladder);
  const tierShift = compareRankedTiers(tierBefore.key, tierAfter.key, ladder);

  const peakRp = Math.max(before.peakRp, rpAfter);
  const peakTierKey = peakRp === rpAfter && tierShift > 0 ? tierAfter.key : (before.peakTierKey ?? tierBefore.key);

  const updated = await prisma.rankedMember.update({
    where: { guildId_userId: { guildId, userId } },
    data: {
      rp: rpAfter,
      peakRp,
      peakTierKey,
      tierKey: tierAfter.key,
      // Le « précédent » ne bouge qu'au changement de palier : sinon il
      // afficherait le palier courant dès le premier RP gagné après une
      // promotion, et la carte perdrait sa valeur de repère.
      previousTierKey: tierShift !== 0 ? tierBefore.key : before.previousTierKey,
      totalRpEarned: granted > 0 ? { increment: granted } : undefined,
    },
  });

  if (options.log !== false) {
    await prisma.rankedRpLog.create({
      data: { guildId, userId, delta: granted, rpAfter, source: options.source, detail: options.detail ?? null },
    }).catch(() => null);
  }

  if (client && tierShift !== 0) {
    await syncTierRoles(guildId, userId, tierAfter.key, client).catch(() => null);
    if (options.announce !== false) {
      await announceTierChange(guildId, userId, tierBefore, tierAfter, tierShift, client, rpAfter).catch(() => null);
    }
  }

  return {
    rpBefore,
    rpAfter,
    granted,
    tierBefore,
    tierAfter,
    tierShift,
    streakDays: updated.streakDays,
  };
}

/**
 * Fait avancer la série du membre pour aujourd'hui et renvoie le nombre de
 * jours consécutifs à utiliser comme multiplicateur.
 *
 * Idempotente dans la journée : appelée à chaque message, elle n'écrit que
 * lorsque le jour change réellement.
 */
async function touchStreak(member: RankedMember, config: RankedConfig): Promise<number> {
  const today = rankedDayKey();
  if (member.lastActiveDate === today) return member.streakDays;

  const update = computeStreakUpdate(
    {
      streakDays: member.streakDays,
      bestStreak: member.bestStreak,
      lastActiveDate: member.lastActiveDate,
      freezes: member.streakFreezes,
    },
    today,
    streakConfigFromRankedConfig(config),
  );

  await prisma.rankedMember.update({
    where: { guildId_userId: { guildId: member.guildId, userId: member.userId } },
    data: {
      streakDays: update.streakDays,
      bestStreak: update.bestStreak,
      lastActiveDate: update.lastActiveDate,
      streakFreezes: update.freezes,
    },
  }).catch(() => null);

  return update.streakDays;
}

/**
 * Point d'entrée depuis `addXp` : convertit l'XP accordée en RP.
 *
 * Volontairement silencieuse en cas d'erreur - elle tourne sur le chemin d'un
 * message, une panne du classement ne doit pas faire échouer le gain d'XP.
 */
export async function creditRpFromXp(
  guildId: string,
  userId: string,
  xpGranted: number,
  client: Client | null,
  source: Extract<RpSource, 'text' | 'voice'> = 'text',
): Promise<void> {
  try {
    if (xpGranted <= 0) return;

    const config = await getRankedConfigSafe(guildId);
    if (!config || !config.enabled || config.rpPerXp <= 0) return;

    const member = await getOrCreateRankedMember(guildId, userId);
    const streakDays = config.streakEnabled ? await touchStreak(member, config) : member.streakDays;
    const event = await getActiveEventMultiplier(guildId, source);

    const gain = computeRpGain({
      xpGranted,
      rpPerXp: config.rpPerXp,
      streakDays: config.streakEnabled ? streakDays : 0,
      eventMultiplier: event.multiplier,
      streakConfig: streakConfigFromRankedConfig(config),
    });
    if (gain.finalRp <= 0) return;

    const allowed = await consumeDailyRpAllowance(guildId, userId, gain.finalRp, config.dailyRpCap);
    if (allowed <= 0) return;

    const result = await applyRpDelta(guildId, userId, allowed, client, { source, detail: event.eventId ?? undefined });

    // Le bilan d'événement ne compte que le surplus dû au multiplicateur : c'est
    // ce chiffre que le staff regarde pour juger si l'événement a fonctionné.
    if (result && event.eventId && event.multiplier > 1) {
      const bonusShare = Math.round(allowed * (1 - 1 / event.multiplier));
      await creditEventBonus(event.eventId, bonusShare, userId).catch(() => null);
    }
  } catch (err) {
    logger.error(LOG_TAG, `Crédit de RP impossible pour ${userId} sur ${guildId}:`, err);
  }
}

/**
 * RP d'une réaction ajoutée. Seule source qui ne passe pas par l'XP : le
 * pipeline de leveling ne récompense pas les réactions, alors qu'un « Reaction
 * Storm » en a besoin.
 */
export async function creditReactionRp(guildId: string, userId: string, client: Client | null): Promise<void> {
  try {
    const config = await getRankedConfigSafe(guildId);
    if (!config || !config.enabled || config.reactionRp <= 0) return;

    if (!(await consumeReactionAllowance(guildId, userId, config.reactionDailyCap))) return;

    const member = await getOrCreateRankedMember(guildId, userId);
    const streakDays = config.streakEnabled ? await touchStreak(member, config) : member.streakDays;
    const event = await getActiveEventMultiplier(guildId, 'reaction');

    const multiplier = (config.streakEnabled ? streakMultiplier(streakDays, streakConfigFromRankedConfig(config)) : 1)
      * event.multiplier;
    const amount = Math.max(1, Math.floor(config.reactionRp * multiplier));

    const allowed = await consumeDailyRpAllowance(guildId, userId, amount, config.dailyRpCap);
    if (allowed <= 0) return;

    const result = await applyRpDelta(guildId, userId, allowed, client, { source: 'reaction', detail: event.eventId ?? undefined });

    if (result && event.eventId && event.multiplier > 1) {
      const bonusShare = Math.round(allowed * (1 - 1 / event.multiplier));
      await creditEventBonus(event.eventId, bonusShare, userId).catch(() => null);
    }
  } catch (err) {
    logger.error(LOG_TAG, `Crédit de RP de réaction impossible pour ${userId} sur ${guildId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Rôles de palier
// ---------------------------------------------------------------------------

/**
 * Aligne les rôles Discord du membre sur son palier courant.
 *
 * En mode exclusif, tous les autres rôles de palier sont retirés : un membre
 * rétrogradé qui garderait son rôle Diamant viderait le classement de son sens.
 */
export async function syncTierRoles(guildId: string, userId: string, tierKey: string, client: Client): Promise<void> {
  const config = await getRankedConfigSafe(guildId);
  if (!config?.tierRolesEnabled) return;

  const mappings = await getTierRoles(guildId);
  if (mappings.length === 0) return;

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;
  const member = await discordGuild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const target = mappings.find((mapping) => mapping.tierKey === tierKey);
  const toAdd = target && !member.roles.cache.has(target.roleId) ? [target.roleId] : [];
  const toRemove = config.tierRolesExclusive
    ? mappings
        .filter((mapping) => mapping.tierKey !== tierKey && member.roles.cache.has(mapping.roleId))
        .map((mapping) => mapping.roleId)
    : [];

  if (toRemove.length > 0) {
    await member.roles.remove(toRemove).catch((err) =>
      logger.warn(LOG_TAG, `Retrait des rôles de palier impossible pour ${userId}:`, err));
  }
  if (toAdd.length > 0) {
    await member.roles.add(toAdd).catch((err) =>
      logger.warn(LOG_TAG, `Attribution du rôle de palier impossible pour ${userId}:`, err));
  }
}

/**
 * Variables acceptées par les messages d'annonce personnalisés.
 *
 * Le remplacement est littéral et borné à cette liste : le texte vient du
 * dashboard, donc d'une saisie, et ne doit pas pouvoir désigner autre chose que
 * ces quatre valeurs.
 */
export const RANKED_ANNOUNCE_VARIABLES = ['user', 'tier', 'from', 'rp'] as const;

export function renderRankedAnnounce(template: string, values: Record<typeof RANKED_ANNOUNCE_VARIABLES[number], string>): string {
  return template.replace(/\{(user|tier|from|rp)\}/g, (_match, key: keyof typeof values) => values[key]);
}

async function announceTierChange(
  guildId: string,
  userId: string,
  from: RankedLadderEntry,
  to: RankedLadderEntry,
  shift: number,
  client: Client,
  rp: number,
): Promise<void> {
  const config = await getRankedConfigSafe(guildId);
  if (!config?.announceChannelId) return;
  if (shift > 0 && !config.announcePromotions) return;
  if (shift < 0 && !config.announceDemotions) return;

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const channel = discordGuild.channels.cache.get(config.announceChannelId);
  if (!channel?.isTextBased()) return;

  const locale: BotLocale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
  // Le texte du serveur l'emporte quand il en a posé un ; sinon le message
  // traduit, qui reste la valeur par défaut de toute guilde.
  const custom = (shift > 0 ? config.announcePromotionMessage : config.announceDemotionMessage)?.trim();
  const content = custom
    ? renderRankedAnnounce(custom, {
        user: `<@${userId}>`,
        tier: to.name,
        from: from.name,
        rp: rp.toLocaleString('fr-FR'),
      })
    : shift > 0
      ? m.ranked_announce_promotion({ user: `<@${userId}>`, tier: to.name }, { locale })
      : m.ranked_announce_demotion({ user: `<@${userId}>`, from: from.name, tier: to.name }, { locale });

  await channel.send({ content, allowedMentions: { users: [userId] } }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export type RankedProfile = {
  guildId: string;
  userId: string;
  rp: number;
  peakRp: number;
  rank: number;
  totalRanked: number;
  streakDays: number;
  bestStreak: number;
  streakAlive: boolean;
  streakFlames: number;
  streakFreezes: number;
  totalRpEarned: number;
  ladder: RankedLadder;
  tier: RankedLadderEntry;
  previousTier: RankedLadderEntry | null;
  peakTier: RankedLadderEntry | null;
  nextTier: RankedLadderEntry | null;
  percent: number;
  rpRemaining: number;
};

/** Tout ce qu'affiche la carte de rang, en une lecture. */
export async function getRankedProfile(guildId: string, userId: string): Promise<RankedProfile> {
  const [ladder, config, member] = await Promise.all([
    getGuildLadder(guildId),
    getRankedConfigSafe(guildId),
    getOrCreateRankedMember(guildId, userId),
  ]);

  // Le rang se calcule par comptage plutôt qu'en chargeant le classement :
  // l'index `(guildId, rp)` répond sans rapatrier une ligne par membre.
  const [ahead, totalRanked] = await Promise.all([
    prismaRead.rankedMember.count({ where: { guildId, rp: { gt: member.rp } } }),
    prismaRead.rankedMember.count({ where: { guildId, rp: { gt: 0 } } }),
  ]);

  const progress = rankedProgress(member.rp, ladder);
  const today = rankedDayKey();

  return {
    guildId,
    userId,
    rp: member.rp,
    peakRp: member.peakRp,
    rank: ahead + 1,
    totalRanked,
    streakDays: member.streakDays,
    bestStreak: member.bestStreak,
    streakAlive: isStreakAlive(member.lastActiveDate, today, streakConfigFromRankedConfig(config)),
    streakFlames: streakFlames(member.streakDays),
    streakFreezes: member.streakFreezes,
    totalRpEarned: member.totalRpEarned,
    ladder,
    tier: progress.current,
    previousTier: rankedTierByKey(member.previousTierKey, ladder),
    peakTier: rankedTierByKey(member.peakTierKey, ladder) ?? progress.current,
    nextTier: progress.next,
    percent: progress.percent,
    rpRemaining: progress.rpRemaining,
  };
}

/** Historique récent des mouvements de RP, pour la courbe du dashboard. */
export async function getRankedHistory(guildId: string, userId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  return prismaRead.rankedRpLog.findMany({
    where: { guildId, userId, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { delta: true, rpAfter: true, source: true, createdAt: true },
    take: 500,
  });
}

/**
 * Ajustement manuel du staff. Passe par le même chemin que l'activité, donc
 * déclenche paliers, rôles et annonces comme un gain normal.
 */
export async function adjustMemberRp(
  guildId: string,
  userId: string,
  delta: number,
  client: Client | null,
  detail?: string,
): Promise<RpDeltaResult | null> {
  return applyRpDelta(guildId, userId, delta, client, { source: 'manual', detail });
}

/**
 * Recharge hebdomadaire des gels de série.
 *
 * Les gels sont ce qui rend la série tenable pour un membre qui a une vie hors
 * du serveur ; sans recharge, ils ne serviraient qu'une fois.
 */
export async function refillStreakFreezes(guildId: string): Promise<number> {
  const config = await getRankedConfigSafe(guildId);
  if (!config?.enabled || !config.streakEnabled || config.streakWeeklyFreezes <= 0) return 0;

  // Deux écritures plutôt qu'un `increment` suivi d'un clamp : un `updateMany`
  // ne sait pas plafonner, et repasser lire chaque ligne coûterait bien plus.
  const incremented = await prisma.rankedMember.updateMany({
    where: { guildId, streakFreezes: { lt: config.streakMaxFreezes } },
    data: { streakFreezes: { increment: config.streakWeeklyFreezes } },
  });

  await prisma.rankedMember.updateMany({
    where: { guildId, streakFreezes: { gt: config.streakMaxFreezes } },
    data: { streakFreezes: config.streakMaxFreezes },
  });

  return incremented.count;
}

/** Purge du journal : il n'alimente qu'une courbe de 90 jours. */
export async function purgeRankedLogs(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const deleted = await prisma.rankedRpLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return deleted.count;
}

/** Membre Discord encore présent ? Utilisé avant toute action sur ses rôles. */
export async function fetchGuildMemberSafe(guild: DiscordGuild, userId: string): Promise<GuildMember | null> {
  return guild.members.fetch(userId).catch(() => null);
}
