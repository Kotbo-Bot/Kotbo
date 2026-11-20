/**
 * Suites d'un passage à la une pour l'auteur : gains (XP, pièces), rôles des
 * paliers, message privé, et l'événement qui lance les workflows. Elles ne
 * partent qu'une fois par message ; un retrait par le staff les reprend, et
 * l'annulation de ce retrait les rejoue.
 *
 * Chaque suite est tolérante : un message privé fermé ou un rôle impossible
 * à donner ne doit jamais empêcher la publication ni les autres suites.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type GuildMember } from 'discord.js';
import type { StarboardConfig, StarboardEntry } from '@prisma/client';
import { kotboEventBus } from '@kotbo/core';
import { readStarboardTiers, type StarboardRemovalReason } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { grantMemberGains, reclaimMemberGains, type MemberGains } from '../progression/memberRewards.js';
import { grantReachedTiers, revokeLostTiers } from '../community/reputationTierService.js';

const SCOPE = 'Starlight';
const GAINS_CONTEXT = { scope: SCOPE, reason: 'de mise à la une' };

type EffectsConfig = Pick<StarboardConfig, 'guildId' | 'rewardXp' | 'rewardCoins' | 'tiers' | 'notifyAuthor'>;

/** Messages de l'auteur passés à la une, hors ceux retirés par le staff : base des paliers. */
export function countFeaturedMessages(guildId: string, authorId: string): Promise<number> {
  return prisma.starboardEntry.count({ where: { guildId, authorId, blockedAt: null } });
}

async function fetchMember(client: Client, guildId: string, userId: string): Promise<GuildMember | null> {
  const guild = client.guilds.cache.get(guildId);
  return guild ? guild.members.fetch(userId).catch(() => null) : null;
}

function gainsLine(gains: MemberGains, locale: BotLocale): string | null {
  const parts = [
    ...(gains.xp > 0 ? [m.starboard_dm_gain_xp({ xp: gains.xp }, { locale })] : []),
    ...(gains.coins > 0 ? [m.starboard_dm_gain_coins({ coins: gains.coins }, { locale })] : []),
  ];
  return parts.length > 0 ? m.starboard_dm_gains({ gains: parts.join(', ') }, { locale }) : null;
}

async function notifyAuthor(member: GuildMember, entry: StarboardEntry, gains: MemberGains): Promise<void> {
  const locale = await resolveGuildLocale(member.guild.id, member.guild.preferredLocale);
  const messageUrl = `https://discord.com/channels/${entry.guildId}/${entry.channelId}/${entry.messageId}`;
  const embed = new EmbedBuilder()
    .setTitle(m.starboard_dm_title({}, { locale }))
    .setDescription([
      m.starboard_dm_body({ server: member.guild.name, channel: `<#${entry.channelId}>`, score: entry.score }, { locale }),
      gainsLine(gains, locale),
    ].filter(Boolean).join('\n\n'));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(m.starboard_jump_button({}, { locale })).setURL(messageUrl),
  );
  // Messages privés fermés : courant, pas une erreur.
  await member.send({ embeds: [embed], components: [row] }).catch(() => null);
}

/**
 * Premier passage à la une d'un message (ou de nouveau après un retrait
 * annulé) : gains gardés sur l'entrée pour pouvoir les reprendre, paliers,
 * message privé si le serveur le veut, puis l'événement des workflows.
 */
export async function onEntryFeatured(client: Client, config: EffectsConfig, entry: StarboardEntry): Promise<void> {
  if (entry.rewardedAt) return;

  const gains = await grantMemberGains(
    client,
    entry.guildId,
    entry.authorId,
    { xp: config.rewardXp, coins: config.rewardCoins },
    { ...GAINS_CONTEXT, channelId: entry.channelId },
  );
  await prisma.starboardEntry.update({
    where: { id: entry.id },
    data: { rewardedAt: new Date(), xpGranted: gains.xp, coinsGranted: gains.coins },
  });

  const featuredCount = await countFeaturedMessages(entry.guildId, entry.authorId);
  const tiers = readStarboardTiers(config.tiers);
  const member = tiers.length > 0 || config.notifyAuthor ? await fetchMember(client, entry.guildId, entry.authorId) : null;

  if (member && tiers.length > 0) {
    const locale = await resolveGuildLocale(entry.guildId, member.guild.preferredLocale);
    await grantReachedTiers(member, tiers, featuredCount, m.starboard_tier_audit_reason({}, { locale }), SCOPE)
      .catch((err) => logger.warn(SCOPE, `Paliers de ${entry.authorId} non appliqués`, err));
  }
  if (member && config.notifyAuthor) await notifyAuthor(member, entry, gains);

  if (entry.starMessageId && entry.starChannelId) {
    kotboEventBus.publish('starboard:featured', {
      guildId: entry.guildId,
      entryId: entry.id,
      authorId: entry.authorId,
      channelId: entry.channelId,
      messageId: entry.messageId,
      starChannelId: entry.starChannelId,
      starMessageId: entry.starMessageId,
      score: entry.score,
      featuredCount,
      timestamp: Date.now(),
    });
  }
}

/**
 * Retrait par le staff : les gains versés sont repris et le message ne compte
 * plus pour les paliers. L'entrée redevient « non payée » : annuler le retrait
 * rejoue ses suites.
 */
export async function onEntryBlocked(client: Client, config: EffectsConfig, entry: StarboardEntry): Promise<void> {
  if (entry.rewardedAt && (entry.xpGranted > 0 || entry.coinsGranted > 0)) {
    await reclaimMemberGains(client, entry.guildId, entry.authorId, { xp: entry.xpGranted, coins: entry.coinsGranted }, GAINS_CONTEXT);
  }
  if (entry.rewardedAt) {
    await prisma.starboardEntry.update({ where: { id: entry.id }, data: { rewardedAt: null, xpGranted: 0, coinsGranted: 0 } });
  }

  const tiers = readStarboardTiers(config.tiers);
  if (tiers.length === 0) return;
  const member = await fetchMember(client, entry.guildId, entry.authorId);
  if (!member) return;
  const locale = await resolveGuildLocale(entry.guildId, member.guild.preferredLocale);
  await revokeLostTiers(member, tiers, await countFeaturedMessages(entry.guildId, entry.authorId), m.starboard_tier_audit_lost({}, { locale }), SCOPE)
    .catch((err) => logger.warn(SCOPE, `Paliers de ${entry.authorId} non recalculés`, err));
}

/** Un message affiché quitte la une : l'événement des workflows dit pourquoi. */
export function publishEntryRemoved(entry: StarboardEntry, reason: StarboardRemovalReason): void {
  kotboEventBus.publish('starboard:removed', {
    guildId: entry.guildId,
    entryId: entry.id,
    authorId: entry.authorId,
    channelId: entry.channelId,
    messageId: entry.messageId,
    reason,
    score: entry.score,
    timestamp: Date.now(),
  });
}
