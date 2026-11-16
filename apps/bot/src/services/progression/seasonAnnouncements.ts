/**
 * Annonces d'ouverture, de rappel et de clôture d'une saison, dans le salon
 * réglé sur elle. Une annonce qui échoue est journalisée et n'empêche rien. Le texte est
 * construit par `@kotbo/shared`, comme l'aperçu du dashboard.
 */
import { EmbedBuilder, type Client } from 'discord.js';
import {
  seasonEndAnnouncement,
  seasonReminderAnnouncement,
  seasonStartAnnouncement,
  type PlannedSeasonReward,
  type SeasonAnnouncementLabels,
  type SeasonAnnouncementText,
  type SeasonReward,
} from '@kotbo/shared';
import { COLORS } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

interface AnnouncedSeason {
  guildId: string;
  number: number;
  name: string;
  endDate: Date;
  announceChannelId: string | null;
}

/** Gabarits dans la langue du serveur, trous compris : l'aperçu du dashboard les remplit. */
export function seasonAnnouncementLabels(locale: BotLocale): SeasonAnnouncementLabels {
  const o = { locale };
  return {
    locale,
    startTitle: m.b2_season_start_title({ number: '{number}', name: '{name}' }, o),
    startBody: m.b2_season_start_body({ date: '{date}' }, o),
    rewardsHeading: m.b2_season_rewards_heading({}, o),
    topRoleLine: m.b2_season_top_role_line({ role: '{role}' }, o),
    rewardCoins: m.b2_season_reward_coins({ coins: '{coins}' }, o),
    endTitle: m.b2_season_end_title({ number: '{number}', name: '{name}' }, o),
    endLine: m.b2_season_end_line({ rank: '{rank}', user: '{user}', xp: '{xp}' }, o),
    endEmpty: m.b2_season_end_empty({}, o),
    rewardsGivenHeading: m.b2_season_rewards_given_heading({}, o),
    reminderTitle: m.b2_season_reminder_title({ number: '{number}', name: '{name}' }, o),
    reminderBody: m.b2_season_reminder_body({ date: '{date}' }, o),
  };
}

/** Horodatage Discord : affiché dans la langue et le fuseau de chaque lecteur (`R` : « dans 12 heures »). */
function discordDate(date: Date, style: 'D' | 'R' = 'D'): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

type Standings = ReadonlyArray<{ userId: string; rank: number; xp: number }>;

function mentionStandings(standings: Standings, locale: BotLocale) {
  return standings.map((entry) => ({ rank: entry.rank, user: `<@${entry.userId}>`, xp: entry.xp.toLocaleString(locale) }));
}

function mentionReward(reward: { roleId: string | null; coins: number }, locale: BotLocale) {
  return {
    role: reward.roleId ? `<@&${reward.roleId}>` : null,
    coins: reward.coins > 0 ? reward.coins.toLocaleString(locale) : null,
  };
}

export function seasonStartText(season: AnnouncedSeason, rewards: readonly SeasonReward[], topRoleId: string | null, locale: BotLocale): SeasonAnnouncementText {
  return seasonStartAnnouncement(
    seasonAnnouncementLabels(locale),
    { number: season.number, name: season.name, date: discordDate(season.endDate) },
    rewards.map((reward) => ({ rank: reward.rank, ...mentionReward(reward, locale) })),
    topRoleId ? `<@&${topRoleId}>` : null,
  );
}

export function seasonReminderText(season: AnnouncedSeason, standings: Standings, locale: BotLocale): SeasonAnnouncementText {
  return seasonReminderAnnouncement(
    seasonAnnouncementLabels(locale),
    { number: season.number, name: season.name, date: discordDate(season.endDate, 'R') },
    mentionStandings(standings, locale),
  );
}

export function seasonEndText(
  season: Pick<AnnouncedSeason, 'number' | 'name'>,
  standings: Standings,
  plan: readonly PlannedSeasonReward[],
  locale: BotLocale,
): SeasonAnnouncementText {
  return seasonEndAnnouncement(
    seasonAnnouncementLabels(locale),
    season,
    mentionStandings(standings, locale),
    plan.map((entry) => ({ user: `<@${entry.userId}>`, ...mentionReward(entry, locale) })),
  );
}

async function send(client: Client, season: AnnouncedSeason, text: SeasonAnnouncementText): Promise<void> {
  if (!season.announceChannelId) return;
  // Le cron tourne dans un seul processus : le serveur peut ne pas être dans
  // son cache, d'où la lecture du salon par l'API en second recours.
  const channel = client.guilds.cache.get(season.guildId)?.channels.cache.get(season.announceChannelId)
    ?? await client.channels.fetch(season.announceChannelId).catch(() => null);
  // Un identifiant saisi à la main (MCP) peut viser le salon d'un autre serveur.
  const sameGuild = !!channel && 'guildId' in channel && channel.guildId === season.guildId;
  if (!channel || !sameGuild || !channel.isTextBased() || !channel.isSendable()) {
    logger.warn('Season', `Salon d'annonce ${season.announceChannelId} introuvable ou fermé au bot sur ${season.guildId}`);
    return;
  }
  const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle(text.title).setDescription(text.description);
  // Les mentions d'un embed ne notifient personne : rien à neutraliser de plus.
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    logger.warn('Season', `Annonce de saison impossible dans ${season.announceChannelId}`, err);
  });
}

function guildLocale(client: Client, guildId: string): Promise<BotLocale> {
  return resolveGuildLocale(guildId, client.guilds.cache.get(guildId)?.preferredLocale);
}

export async function announceSeasonStart(client: Client, season: AnnouncedSeason, rewards: readonly SeasonReward[], topRoleId: string | null): Promise<void> {
  if (!season.announceChannelId) return;
  await send(client, season, seasonStartText(season, rewards, topRoleId, await guildLocale(client, season.guildId)));
}

export async function announceSeasonReminder(client: Client, season: AnnouncedSeason, standings: Standings): Promise<void> {
  if (!season.announceChannelId) return;
  await send(client, season, seasonReminderText(season, standings, await guildLocale(client, season.guildId)));
}

export async function announceSeasonEnd(
  client: Client,
  season: AnnouncedSeason,
  standings: Standings,
  plan: readonly PlannedSeasonReward[],
): Promise<void> {
  if (!season.announceChannelId) return;
  await send(client, season, seasonEndText(season, standings, plan, await guildLocale(client, season.guildId)));
}
