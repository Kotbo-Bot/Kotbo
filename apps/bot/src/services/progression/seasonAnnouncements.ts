/**
 * Annonces d'ouverture et de clôture d'une saison, dans le salon réglé sur
 * elle. Une annonce qui échoue est journalisée et n'empêche rien.
 */
import { EmbedBuilder, type Client } from 'discord.js';
import type { PlannedSeasonReward, SeasonReward } from '@kotbo/shared';
import { COLORS } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const PODIUM_SIZE = 3;

interface AnnouncedSeason {
  guildId: string;
  number: number;
  name: string;
  endDate: Date;
  announceChannelId: string | null;
}

/** Horodatage Discord : affiché dans la langue et le fuseau de chaque lecteur. */
function discordDate(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:D>`;
}

function rewardText(reward: { roleId: string | null; coins: number }, locale: BotLocale): string {
  return [
    reward.roleId ? `<@&${reward.roleId}>` : null,
    reward.coins > 0 ? m.b2_season_reward_coins({ coins: reward.coins.toLocaleString(locale) }, { locale }) : null,
  ].filter(Boolean).join(' + ');
}

export function seasonStartDescription(season: AnnouncedSeason, rewards: readonly SeasonReward[], topRoleId: string | null, locale: BotLocale): string {
  const lines = [m.b2_season_start_body({ date: discordDate(season.endDate) }, { locale })];
  if (rewards.length > 0 || topRoleId) {
    lines.push('', `**${m.b2_season_rewards_heading({}, { locale })}**`);
    if (topRoleId) lines.push(m.b2_season_top_role_line({ role: `<@&${topRoleId}>` }, { locale }));
    for (const reward of rewards) lines.push(`#${reward.rank} · ${rewardText(reward, locale)}`);
  }
  return lines.join('\n');
}

export function seasonEndDescription(
  standings: ReadonlyArray<{ userId: string; rank: number; xp: number }>,
  plan: readonly PlannedSeasonReward[],
  locale: BotLocale,
): string {
  if (standings.length === 0) return m.b2_season_end_empty({}, { locale });

  const lines = standings.slice(0, PODIUM_SIZE).map((entry) =>
    m.b2_season_end_line({ rank: entry.rank, user: `<@${entry.userId}>`, xp: entry.xp.toLocaleString(locale) }, { locale }));
  if (plan.length > 0) {
    lines.push('', `**${m.b2_season_rewards_given_heading({}, { locale })}**`);
    for (const entry of plan) lines.push(`<@${entry.userId}> · ${rewardText(entry, locale)}`);
  }
  return lines.join('\n');
}

async function send(client: Client, season: AnnouncedSeason, title: string, description: string): Promise<void> {
  if (!season.announceChannelId) return;
  const guild = client.guilds.cache.get(season.guildId);
  const channel = guild?.channels.cache.get(season.announceChannelId);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('Season', `Salon d'annonce ${season.announceChannelId} introuvable ou fermé au bot sur ${season.guildId}`);
    return;
  }
  const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle(title).setDescription(description);
  // Les mentions d'un embed ne notifient personne : rien à neutraliser de plus.
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    logger.warn('Season', `Annonce de saison impossible dans ${season.announceChannelId}`, err);
  });
}

export async function announceSeasonStart(client: Client, season: AnnouncedSeason, rewards: readonly SeasonReward[], topRoleId: string | null): Promise<void> {
  if (!season.announceChannelId) return;
  const locale = await resolveGuildLocale(season.guildId, client.guilds.cache.get(season.guildId)?.preferredLocale);
  await send(
    client,
    season,
    m.b2_season_start_title({ number: season.number, name: season.name }, { locale }),
    seasonStartDescription(season, rewards, topRoleId, locale),
  );
}

export async function announceSeasonEnd(
  client: Client,
  season: AnnouncedSeason,
  standings: ReadonlyArray<{ userId: string; rank: number; xp: number }>,
  plan: readonly PlannedSeasonReward[],
): Promise<void> {
  if (!season.announceChannelId) return;
  const locale = await resolveGuildLocale(season.guildId, client.guilds.cache.get(season.guildId)?.preferredLocale);
  await send(
    client,
    season,
    m.b2_season_end_title({ number: season.number, name: season.name }, { locale }),
    seasonEndDescription(standings, plan, locale),
  );
}
