/**
 * banHygieneService.ts
 *
 * Analyse la liste des bans de chaque serveur et détecte les comptes que
 * Discord a supprimés (username `deleted_user_…`). Le staff est notifié une
 * seule fois par compte, avec un bouton pour nettoyer la liste en débannissant
 * ces comptes - un compte supprimé ne pouvant de toute façon jamais revenir.
 *
 * Opt-out par serveur via guild.banHygieneEnabled.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isGuildActivated } from '../../utils/activation.js';
import { queueAuditLog } from '../../utils/auditLogger.js';
import { notifyMany } from '../notifications/notifyService.js';

const SCAN_PAGE_SIZE = 1000;
const MAX_LISTED_IN_EMBED = 15;

/** Discord renomme les comptes supprimés en deleted_user_<hex> (legacy : "Deleted User"). */
export function isDeletedAccount(username: string): boolean {
  return /^deleted_user_[0-9a-f]+$/i.test(username) || /^deleted user/i.test(username);
}

async function fetchAllBans(guild: Guild): Promise<Array<{ userId: string; username: string }>> {
  const results: Array<{ userId: string; username: string }> = [];
  let after: string | undefined;

  // L'API pagine par 1000 : on boucle jusqu'à une page incomplète.
  for (;;) {
    const page = await guild.bans.fetch({ limit: SCAN_PAGE_SIZE, after });
    for (const ban of page.values()) {
      results.push({ userId: ban.user.id, username: ban.user.username });
    }
    if (page.size < SCAN_PAGE_SIZE) break;
    after = [...page.keys()].sort().at(-1);
    if (!after) break;
  }

  return results;
}

/**
 * Scanne les bans d'une guilde et enregistre les comptes supprimés nouvellement
 * détectés. Retourne les nouveaux enregistrements (déjà notifiés exclus).
 */
export async function scanGuildBans(
  client: Client,
  guildId: string,
): Promise<Array<{ userId: string; userTag: string | null }>> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return [];

  const bans = await fetchAllBans(guild).catch((err) => {
    logger.warn('BanHygiene', `Impossible de lister les bans de ${guildId}:`, err);
    return null;
  });
  if (!bans) return [];

  const deleted = bans.filter((b) => isDeletedAccount(b.username));
  if (deleted.length === 0) return [];

  const known = await prisma.banHygieneRecord.findMany({
    where: { guildId, userId: { in: deleted.map((d) => d.userId) } },
    select: { userId: true },
  });
  const knownIds = new Set(known.map((k) => k.userId));

  const fresh = deleted.filter((d) => !knownIds.has(d.userId));
  if (fresh.length === 0) return [];

  await prisma.banHygieneRecord.createMany({
    data: fresh.map((d) => ({ guildId, userId: d.userId, userTag: d.username })),
    skipDuplicates: true,
  });

  return fresh.map((d) => ({ userId: d.userId, userTag: d.username }));
}

async function notifyStaff(
  client: Client,
  guildId: string,
  fresh: Array<{ userId: string; userTag: string | null }>,
): Promise<void> {
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { logChannelId: true, verificationLogChannelId: true },
  });
  const channelId = guildConfig?.logChannelId || guildConfig?.verificationLogChannelId;

  const totalPending = await prisma.banHygieneRecord.count({
    where: { guildId, unbannedAt: null },
  });

  const listed = fresh
    .slice(0, MAX_LISTED_IN_EMBED)
    .map((d) => `• \`${d.userId}\`${d.userTag ? ` (${d.userTag})` : ''}`)
    .join('\n');
  const overflow = fresh.length > MAX_LISTED_IN_EMBED ? `\n… et ${fresh.length - MAX_LISTED_IN_EMBED} autre(s).` : '';

  const embed = new EmbedBuilder()
    .setTitle('🧹 Hygiène des bans - comptes supprimés détectés')
    .setColor(0x5865f2)
    .setDescription(
      `${fresh.length} compte(s) banni(s) ont été **supprimés par Discord** et ne pourront jamais revenir.\n\n${listed}${overflow}\n\nDébannir ces comptes rend la liste de bans plus lisible, sans aucun risque.`,
    )
    .addFields({ name: 'Total nettoyable', value: `${totalPending} compte(s)`, inline: true })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('banhygiene:purge')
      .setLabel(`Nettoyer la liste (${totalPending})`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🧹'),
    new ButtonBuilder()
      .setCustomId('banhygiene:ignore')
      .setLabel('Ignorer')
      .setStyle(ButtonStyle.Secondary),
  );

  if (channelId) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
    if (channel && channel.type === ChannelType.GuildText) {
      await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
    }
  }

  await prisma.banHygieneRecord.updateMany({
    where: { guildId, userId: { in: fresh.map((f) => f.userId) }, notifiedAt: null },
    data: { notifiedAt: new Date() },
  });

  // Notification dashboard aux managers
  const managers = await prisma.staffMember.findMany({
    where: { guildId, grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] } },
  }).catch(() => []);

  await notifyMany(managers.map((m) => m.userId), {
    guildId,
    kind: 'moderation.ban_hygiene',
    title: '🧹 Comptes bannis supprimés détectés',
    message: `${fresh.length} compte(s) banni(s) sont des comptes supprimés par Discord. La liste de bans peut être nettoyée.`,
    link: '/sanctions',
    dm: false,
  });
}

/** Cron quotidien : scanne toutes les guildes actives avec l'hygiène activée. */
export async function runBanHygieneScan(client: Client): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: { banHygieneEnabled: true },
    select: { id: true },
  });

  for (const g of guilds) {
    if (!isGuildActivated(g.id)) continue;
    try {
      const fresh = await scanGuildBans(client, g.id);
      if (fresh.length > 0) {
        logger.info('BanHygiene', `${fresh.length} compte(s) supprimé(s) détecté(s) dans les bans de ${g.id}.`);
        await notifyStaff(client, g.id, fresh);
      }
    } catch (err) {
      logger.error('BanHygiene', `Erreur du scan pour ${g.id}:`, err);
    }
  }
}

/** Bouton "Nettoyer" : débannit tous les comptes supprimés enregistrés. */
export async function handleBanHygieneButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  if (interaction.customId === 'banhygiene:ignore') {
    await interaction.update({ components: [] }).catch(() => null);
    return;
  }

  await interaction.deferUpdate();

  const pending = await prisma.banHygieneRecord.findMany({
    where: { guildId, unbannedAt: null },
  });

  let cleaned = 0;
  for (const record of pending) {
    const ok = await interaction.guild.members
      .unban(record.userId, `Hygiène des bans : compte supprimé par Discord (nettoyage par @${interaction.user.tag})`)
      .then(() => true)
      .catch(() => false);

    // Marquer traité même si le déban échoue (déjà débanni à la main, etc.)
    await prisma.banHygieneRecord.update({
      where: { id: record.id },
      data: { unbannedAt: new Date() },
    }).catch(() => null);

    if (ok) cleaned++;
  }

  queueAuditLog({
    guildId,
    user: `@${interaction.user.tag}`,
    action: 'Nettoyage des bans (comptes supprimés)',
    context: interaction.guild.name,
    module: 'Modération',
    eventType: 'Manuel',
    details: `${cleaned}/${pending.length} compte(s) supprimé(s) débanni(s) pour nettoyer la liste.`,
  });

  await interaction.editReply({
    content: `🧹 Nettoyage terminé : **${cleaned}** compte(s) supprimé(s) retiré(s) de la liste de bans${cleaned < pending.length ? ` (${pending.length - cleaned} déjà absents)` : ''}.`,
    embeds: [],
    components: [],
  }).catch(() => null);
}
