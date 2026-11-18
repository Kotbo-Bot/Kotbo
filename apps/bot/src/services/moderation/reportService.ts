import { type Client, type Guild, type User, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type TextChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS, truncate } from '../../utils/embeds.js';
import { getRaidProtectionConfig } from './raidProtectionService.js';
import type { MemberReport } from '@prisma/client';

const reportCooldowns = new Map<string, number>(); // `${guildId}:${userId}` -> timestamp du dernier report

export type CreateReportResult =
  | { ok: true; report: MemberReport }
  | { ok: false; error: 'DISABLED' | 'NO_CHANNEL' | 'COOLDOWN' | 'SELF_REPORT'; retryInSec?: number };

export async function createMemberReport(params: {
  client: Client;
  guild: Guild;
  reporter: User;
  targetId: string;
  reason: string;
  channelId?: string;
  messageId?: string;
  messageContent?: string;
}): Promise<CreateReportResult> {
  const { client, guild, reporter, targetId, reason } = params;

  const config = await getRaidProtectionConfig(guild.id);
  if (!config?.reportsEnabled) return { ok: false, error: 'DISABLED' };
  if (!config.reportsChannelId) return { ok: false, error: 'NO_CHANNEL' };
  if (targetId === reporter.id) return { ok: false, error: 'SELF_REPORT' };

  // Anti-abus : cooldown par membre
  const cooldownKey = `${guild.id}:${reporter.id}`;
  const last = reportCooldowns.get(cooldownKey) ?? 0;
  const elapsed = (Date.now() - last) / 1000;
  if (elapsed < config.reportsCooldownSec) {
    return { ok: false, error: 'COOLDOWN', retryInSec: Math.ceil(config.reportsCooldownSec - elapsed) };
  }
  reportCooldowns.set(cooldownKey, Date.now());

  const report = await prisma.memberReport.create({
    data: {
      guildId: guild.id,
      reporterId: reporter.id,
      targetId,
      reason,
      channelId: params.channelId ?? null,
      messageId: params.messageId ?? null,
      messageContent: params.messageContent ? truncate(params.messageContent, 1000) : null,
    },
  });

  await postReportToStaffChannel(client, guild, config.reportsChannelId, report, config.reportsAnonymous).catch((err) =>
    logger.error('Reports', `Impossible de poster le report ${report.id}`, err)
  );

  return { ok: true, report };
}

async function postReportToStaffChannel(client: Client, guild: Guild, channelId: string, report: MemberReport, anonymous: boolean): Promise<void> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🚩 Nouveau signalement')
    .addFields(
      { name: 'Membre signalé', value: `<@${report.targetId}> (\`${report.targetId}\`)`, inline: true },
      { name: 'Signalé par', value: anonymous ? '🕵️ Anonyme' : `<@${report.reporterId}>`, inline: true },
      { name: 'Raison', value: truncate(report.reason, 1024), inline: false },
    )
    .setFooter({ text: `Report ID: ${report.id}` })
    .setTimestamp();

  if (report.messageId && report.channelId) {
    embed.addFields({
      name: 'Message concerné',
      value: `[Aller au message](https://discord.com/channels/${guild.id}/${report.channelId}/${report.messageId})${report.messageContent ? `\n>>> ${truncate(report.messageContent, 500)}` : ''}`,
      inline: false,
    });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rprot:report_resolve:${report.id}`).setLabel('Traité').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`rprot:report_dismiss:${report.id}`).setLabel('Rejeter').setStyle(ButtonStyle.Secondary).setEmoji('🗑️'),
  );

  await (channel as TextChannel).send({ embeds: [embed], components: [row] });
}

/** Marque un report comme traité ou rejeté (boutons staff). */
export async function handleReportDecision(guildId: string, reportId: string, handledById: string, resolved: boolean): Promise<MemberReport | null> {
  const report = await prisma.memberReport.findFirst({ where: { id: reportId, guildId } });
  if (!report || report.status !== 'PENDING') return null;

  return prisma.memberReport.update({
    where: { id: reportId },
    data: {
      status: resolved ? 'RESOLVED' : 'DISMISSED',
      handledById,
      handledAt: new Date(),
    },
  });
}

/** Statistiques rapides pour l'affichage staff. */
export async function getReportStats(guildId: string): Promise<{ pending: number; resolved: number; dismissed: number }> {
  const grouped = await prisma.memberReport.groupBy({
    by: ['status'],
    where: { guildId },
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  return {
    pending: byStatus.PENDING ?? 0,
    resolved: byStatus.RESOLVED ?? 0,
    dismissed: byStatus.DISMISSED ?? 0,
  };
}
