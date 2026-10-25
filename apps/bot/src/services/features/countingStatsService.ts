import { EmbedBuilder, type Client, type Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import { COLORS } from '../../utils/embeds.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import { logger } from '../../utils/logger.js';
import * as m from '../../lib/paraglide/messages.js';

/** Une erreur coûte autant que cent bons nombres. */
export const COUNTING_MISTAKE_PENALTY = 100;
/** Le message d'état est reposté quand le salon est resté calme ce temps-là. */
const STATUS_IDLE_MS = 10 * 60 * 1000;
const PROGRESS_SEGMENTS = 12;
const MEDALS = ['🥇', '🥈', '🥉'];

export async function recordCountingSuccess(guildId: string, userId: string, number: number) {
  await Promise.all([
    prisma.funGameState.updateMany({
      where: { guildId, countingRecord: { lt: number } },
      data: { countingRecord: number },
    }),
    prisma.funCountingPlayer.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, correct: 1, score: 1 },
      update: { correct: { increment: 1 }, score: { increment: 1 } },
    }),
  ]);
}

export async function recordCountingMistake(guildId: string, userId: string) {
  await prisma.funCountingPlayer.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, failed: 1, score: -COUNTING_MISTAKE_PENALTY },
    update: { failed: { increment: 1 }, score: { decrement: COUNTING_MISTAKE_PENALTY } },
  });
}

function progressBar(current: number, record: number): string {
  if (record <= 0) return '';
  const filled = Math.min(PROGRESS_SEGMENTS, Math.round((current / record) * PROGRESS_SEGMENTS));
  return `\`${'█'.repeat(filled)}${'░'.repeat(PROGRESS_SEGMENTS - filled)}\` **${current}/${record}**`;
}

function relative(date: Date | null, locale: BotLocale): string {
  return date ? `<t:${Math.floor(date.getTime() / 1000)}:R>` : m.counting_never({}, { locale });
}

function footer(embed: EmbedBuilder, guild: Guild, label: string) {
  return embed.setFooter({ text: `${guild.name} | ${label}`, iconURL: guild.iconURL() ?? undefined }).setTimestamp();
}

async function loadCounting(guildId: string, top: number) {
  const [state, players] = await Promise.all([
    prisma.funGameState.findUnique({ where: { guildId } }),
    prisma.funCountingPlayer.findMany({ where: { guildId }, orderBy: { score: 'desc' }, take: top }),
  ]);
  return { state, players };
}

export async function buildCountingStatusEmbed(guild: Guild, locale: BotLocale) {
  const { state, players } = await loadCounting(guild.id, 3);
  const current = state?.countingCurrent ?? 0;
  const record = state?.countingRecord ?? 0;
  const nextMilestone = (Math.floor(current / 100) + 1) * 100;

  const lines = [
    `## 🔢 ${m.counting_status_current({ current }, { locale })}`,
    `### 🏆 ${m.counting_status_record({ record }, { locale })}`,
    '',
    `⏭️ ${m.counting_status_next({ milestone: nextMilestone, remaining: nextMilestone - current }, { locale })}`,
  ];
  if (players.length > 0) {
    lines.push('', `🏆 **${m.counting_status_top({}, { locale })}**`);
    players.forEach((p, i) => lines.push(`${MEDALS[i]} <@${p.userId}> **${m.counting_points({ score: p.score }, { locale })}**`));
  }
  const bar = progressBar(current, record);
  if (bar) lines.push('', bar);

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(m.counting_status_title({}, { locale }))
    .setDescription(lines.join('\n'))
    .addFields(
      {
        name: m.counting_status_last_counter({}, { locale }),
        value: state?.countingLastUserId ? `<@${state.countingLastUserId}>` : '-',
        inline: true,
      },
      { name: m.counting_status_last_update({}, { locale }), value: relative(state?.countingUpdatedAt ?? null, locale), inline: true },
    );
  return footer(embed, guild, m.counting_status_footer({}, { locale }));
}

export async function buildCountingStatsEmbed(guild: Guild, userId: string, channelId: string | null, locale: BotLocale) {
  const [{ state, players }, me] = await Promise.all([
    loadCounting(guild.id, 10),
    prisma.funCountingPlayer.findUnique({ where: { guildId_userId: { guildId: guild.id, userId } } }),
  ]);

  const lines: string[] = [
    m.counting_stats_current({ current: state?.countingCurrent ?? 0 }, { locale }),
    m.counting_stats_record({ record: state?.countingRecord ?? 0 }, { locale }),
  ];
  if (channelId) lines.push('', m.counting_stats_channel({ channel: `<#${channelId}>` }, { locale }));
  lines.push(
    '',
    m.counting_stats_last_activity({ when: relative(state?.countingUpdatedAt ?? null, locale) }, { locale }),
    '',
    `## ${m.counting_stats_user_title({ user: `<@${userId}>` }, { locale })}`,
    m.counting_stats_user_score({ points: m.counting_points({ score: me?.score ?? 0 }, { locale }) }, { locale }),
    m.counting_stats_user_correct({ count: me?.correct ?? 0 }, { locale }),
    m.counting_stats_user_failed({ count: me?.failed ?? 0 }, { locale }),
  );
  if (players.length > 0) {
    lines.push('', `## ${m.counting_stats_top_title({}, { locale })}`);
    players.forEach((p, i) =>
      lines.push(
        `${i + 1}. <@${p.userId}> ${m.counting_stats_top_line({ points: m.counting_points({ score: p.score }, { locale }), correct: p.correct, failed: p.failed }, { locale })}`,
      ),
    );
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📊 ${m.counting_stats_title({}, { locale })}`)
    .setDescription(lines.join('\n'));
  return footer(embed, guild, m.counting_stats_footer({}, { locale }));
}

// shortcut: minuteurs en mémoire, un redémarrage annule le prochain repost ; le nombre suivant le reprogramme.
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Reporte la publication de l'état tant que le salon de comptage est actif. */
export function scheduleCountingStatus(client: Client, guildId: string, channelId: string) {
  clearTimeout(statusTimers.get(guildId));
  statusTimers.set(
    guildId,
    setTimeout(() => {
      statusTimers.delete(guildId);
      postCountingStatus(client, guildId, channelId).catch((err) =>
        logger.error('Fun', `Publication de l'état du comptage impossible pour ${guildId} :`, err),
      );
    }, STATUS_IDLE_MS),
  );
}

async function postCountingStatus(client: Client, guildId: string, channelId: string) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable() || channel.isDMBased()) return;

  const locale = await resolveGuildLocale(guildId, channel.guild.preferredLocale);
  const embed = await buildCountingStatusEmbed(channel.guild, locale);
  const previous = await prisma.funGameState.findUnique({ where: { guildId }, select: { countingStatusMessageId: true } });
  if (previous?.countingStatusMessageId) {
    await channel.messages.delete(previous.countingStatusMessageId).catch(() => null);
  }

  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  await prisma.funGameState.update({ where: { guildId }, data: { countingStatusMessageId: sent.id } });
}
