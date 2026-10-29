import { EmbedBuilder, PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { RaidProtectionConfig } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import { notifyJoinBlocked } from '../notifications/notifyService.js';
import { registerBanSanction, registerJailSanction, registerKickSanction } from './sanctionService.js';
import { isJailConfigured } from './jailService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// JAIL : quarantaine jusqu'à l'âge requis ; TEMPBAN : banni jusqu'à cette date.
type GuardAction = 'ALERT' | 'KICK' | 'BAN' | 'JAIL' | 'TEMPBAN';
const GUARD_ACTIONS: GuardAction[] = ['ALERT', 'KICK', 'BAN', 'JAIL', 'TEMPBAN'];

export function computeAccountAgeCutoff(value: number, unit: string, now = new Date()): Date {
  if (unit === 'MONTHS') {
    // setMonth seul déborde : le 31 mars moins un mois donnerait le 3 mars.
    const cutoff = new Date(now);
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - value);
    const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
    cutoff.setUTCDate(Math.min(day, lastDay));
    return cutoff;
  }
  return new Date(now.getTime() - value * DAY_MS);
}

/** Date à laquelle un compte créé à `createdAt` atteint l'âge requis. */
export function accountAgeReachedAt(createdAt: number, value: number, unit: string): Date {
  if (unit === 'MONTHS') {
    const reached = new Date(createdAt);
    const day = reached.getUTCDate();
    reached.setUTCDate(1);
    reached.setUTCMonth(reached.getUTCMonth() + value);
    const lastDay = new Date(Date.UTC(reached.getUTCFullYear(), reached.getUTCMonth() + 1, 0)).getUTCDate();
    reached.setUTCDate(Math.min(day, lastDay));
    return reached;
  }
  return new Date(createdAt + value * DAY_MS);
}

function thresholdLabel(value: number, unit: string): string {
  if (unit === 'MONTHS') return `${value} mois`;
  return `${value} jour${value > 1 ? 's' : ''}`;
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${Math.max(hours, 0)} h`;
  const days = Math.floor(ms / DAY_MS);
  return `${days} jour${days > 1 ? 's' : ''}`;
}

/**
 * Refoule les comptes Discord créés trop récemment. Retourne true quand le membre
 * a été expulsé ou banni, pour que la suite du parcours d'arrivée soit ignorée.
 */
export async function handleJoinAccountAgeGuard(member: GuildMember, config: RaidProtectionConfig): Promise<boolean> {
  if (!config.accountAgeGuardEnabled || config.accountAgeMinValue <= 0) return false;
  if (member.user.bot) return false;
  if ((config.accountAgeWhitelist ?? []).includes(member.id)) return false;

  const cutoff = computeAccountAgeCutoff(config.accountAgeMinValue, config.accountAgeMinUnit);
  if (member.user.createdTimestamp <= cutoff.getTime()) return false;

  const guild = member.guild;
  const me = guild.members.me;
  const requested: GuardAction = GUARD_ACTIONS.includes(config.accountAgeAction as GuardAction)
    ? (config.accountAgeAction as GuardAction)
    : 'ALERT';
  const reachedAt = accountAgeReachedAt(member.user.createdTimestamp, config.accountAgeMinValue, config.accountAgeMinUnit);

  // Sans la permission, on retombe sur l'alerte plutôt que d'échouer en silence.
  // Sans rôle Jail, la quarantaine devient un bannissement jusqu'à la même date.
  let action: GuardAction = requested;
  if (action === 'JAIL' && (!(await isJailConfigured(guild)) || !member.manageable)) action = 'TEMPBAN';
  if ((action === 'BAN' || action === 'TEMPBAN') && (!me?.permissions.has(PermissionFlagsBits.BanMembers) || !member.bannable)) action = 'ALERT';
  if (action === 'KICK' && (!me?.permissions.has(PermissionFlagsBits.KickMembers) || !member.kickable)) action = 'ALERT';

  const threshold = thresholdLabel(config.accountAgeMinValue, config.accountAgeMinUnit);
  const reason = `Compte Discord de moins de ${threshold} (protection anti-raid)`;
  const target = { id: member.id, tag: member.user.tag };
  const moderator = { id: member.client.user.id, tag: member.client.user.tag };

  // isSync coupe la synchronisation vers les comptes liés et les autres serveurs :
  // sans ça, bannir un double compte déclaré de bonne foi bannirait aussi le compte
  // principal. Il coupe aussi le MP au staff par sanction, qui inonderait pendant
  // un raid ; le salon d'alerte ci-dessous en tient lieu.
  try {
    if (action === 'JAIL' || action === 'TEMPBAN') {
      const when = `<t:${Math.floor(reachedAt.getTime() / 1000)}:F>`;
      await notifyJoinBlocked(
        guild.id,
        member.id,
        `${config.accountAgeMessage}\nTu pourras accéder à **${guild.name}** à partir du ${when}${action === 'TEMPBAN' ? ' : ton bannissement sera levé automatiquement.' : ', ta quarantaine sera levée automatiquement.'}`,
      );
    } else if (action !== 'ALERT') {
      await notifyJoinBlocked(guild.id, member.id, config.accountAgeMessage);
    }

    if (action === 'JAIL') {
      await registerJailSanction({
        guildId: guild.id,
        target,
        moderator,
        reason,
        durationMs: Math.max(60_000, reachedAt.getTime() - Date.now()),
        member,
        source: 'ACCOUNT_AGE',
      });
    } else if (action === 'TEMPBAN') {
      await member.ban({ reason });
      await registerBanSanction({ guildId: guild.id, target, moderator, reason, isSync: true, temporaryDurationMs: Math.max(60_000, reachedAt.getTime() - Date.now()) }).catch(() => null);
    } else if (action === 'BAN') {
      await member.ban({ reason });
      await registerBanSanction({ guildId: guild.id, target, moderator, reason, isSync: true }).catch(() => null);
    } else if (action === 'KICK') {
      await member.kick(reason);
      await registerKickSanction({ guildId: guild.id, target, moderator, reason, isSync: true }).catch(() => null);
    }
  } catch (err) {
    logger.error('AccountAgeGuard', `Action ${action} impossible pour ${member.id} sur ${guild.id}`, err);
    action = 'ALERT';
  }

  await sendAccountAgeAlert(member, config, requested, action, threshold);
  return action !== 'ALERT';
}

async function sendAccountAgeAlert(
  member: GuildMember,
  config: RaidProtectionConfig,
  requested: GuardAction,
  applied: GuardAction,
  threshold: string
): Promise<void> {
  if (!config.accountAgeAlertChannelId) return;
  const channel = await member.guild.channels.fetch(config.accountAgeAlertChannelId).catch(() => null);
  if (!channel?.isSendable()) return;

  const actionLabel: Record<GuardAction, string> = {
    ALERT: 'Signalé uniquement',
    KICK: 'Expulsé',
    BAN: 'Banni',
    JAIL: 'En quarantaine jusqu\'à l\'âge requis',
    TEMPBAN: 'Banni jusqu\'à l\'âge requis',
  };
  const createdAt = Math.floor(member.user.createdTimestamp / 1000);

  const embed = new EmbedBuilder()
    .setColor(applied === 'ALERT' ? COLORS.warning : COLORS.danger)
    .setTitle('Compte trop récent à l\'arrivée')
    .setDescription(`<@${member.id}> (\`${member.user.tag}\`) a rejoint avec un compte de moins de **${threshold}**.`)
    .addFields(
      { name: 'Compte créé', value: `<t:${createdAt}:R> (${formatAge(Date.now() - member.user.createdTimestamp)})`, inline: true },
      { name: 'Action', value: actionLabel[applied], inline: true },
    )
    .setFooter({ text: `ID : ${member.id}` })
    .setTimestamp();

  if (requested !== applied) {
    embed.addFields({
      name: 'Attention',
      value: `L'action configurée (${actionLabel[requested]}) n'a pas pu être appliquée : vérifie les permissions et la position du rôle du bot.`,
    });
  }

  await channel.send({ embeds: [embed] }).catch(() => null);
}
