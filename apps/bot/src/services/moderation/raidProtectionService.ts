import { type Client, type Guild, type GuildMember, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type TextChannel, PermissionFlagsBits } from 'discord.js';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { notifyJoinBlocked } from '../notifications/notifyService.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import type { RaidProtectionConfig } from '@prisma/client';

// Fenêtre max des incident actions Discord (invites/DMs pause) : 24h.
// On renouvelle par cron tant que le lock est actif.
const INCIDENT_ACTION_MAX_MS = 24 * 60 * 60 * 1000;

// ── Config (cache 60s, même pattern que getCachedGuild) ───────────────────────

export async function getRaidProtectionConfig(guildId: string): Promise<RaidProtectionConfig | null> {
  const cacheKey = `guild:${guildId}:raidprotection`;
  let config = await cache.get<RaidProtectionConfig>(cacheKey);
  if (!config) {
    config = await prisma.raidProtectionConfig.findUnique({ where: { guildId } });
    if (config) await cache.set(cacheKey, config, 60);
  }
  return config;
}

export async function upsertRaidProtectionConfig(
  guildId: string,
  data: Partial<Omit<RaidProtectionConfig, 'guildId' | 'createdAt' | 'updatedAt'>>
): Promise<RaidProtectionConfig> {
  const config = await prisma.raidProtectionConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });
  await cache.delete(`guild:${guildId}:raidprotection`);
  return config;
}

// ── Anti-raid : suivi des arrivées (fenêtre glissante en mémoire) ─────────────

const recentJoins = new Map<string, number[]>(); // guildId -> timestamps

/**
 * Enregistre une arrivée et déclenche le raid mode si le seuil est franchi.
 * Retourne true si un raid vient d'être détecté.
 */
export async function trackJoinAndDetectRaid(member: GuildMember, config: RaidProtectionConfig): Promise<boolean> {
  if (!config.antiRaidEnabled) return false;

  const now = Date.now();
  const windowMs = config.antiRaidJoinWindowSec * 1000;
  const timestamps = recentJoins.get(member.guild.id) ?? [];
  const pruned = timestamps.filter((t) => now - t < windowMs);
  pruned.push(now);
  recentJoins.set(member.guild.id, pruned);

  if (config.raidModeActive) return false; // Déjà en raid mode
  if (pruned.length < config.antiRaidJoinThreshold) return false;

  await activateRaidMode(member.guild, config, false);
  return true;
}

export async function activateRaidMode(guild: Guild, config: RaidProtectionConfig, manual: boolean, activatedBy?: string): Promise<void> {
  await upsertRaidProtectionConfig(guild.id, {
    raidModeActive: true,
    raidModeActivatedAt: new Date(),
    raidModeManual: manual,
  });

  // Action automatique selon la config
  if (config.antiRaidAction === 'LOCK') {
    await enableJoinLock(guild, null).catch((err) =>
      logger.error('RaidProtection', `Impossible d'activer le join lock pour ${guild.id}`, err)
    );
  }

  logger.warn('RaidProtection', `Raid mode activé sur ${guild.name} (${guild.id}) - ${manual ? 'manuel' : 'automatique'}`);
  await sendRaidAlert(guild, config, manual, activatedBy);
}

export async function deactivateRaidMode(guild: Guild, config?: RaidProtectionConfig | null): Promise<void> {
  const cfg = config ?? (await getRaidProtectionConfig(guild.id));
  await upsertRaidProtectionConfig(guild.id, {
    raidModeActive: false,
    raidModeActivatedAt: null,
    raidModeManual: false,
  });

  // Si le join lock a été posé par le raid mode (pas explicitement demandé), on le lève
  if (cfg && cfg.antiRaidAction === 'LOCK' && !cfg.joinLockEnabled) {
    await disableJoinLock(guild).catch(() => null);
  }
  recentJoins.delete(guild.id);
  logger.info('RaidProtection', `Raid mode désactivé sur ${guild.name} (${guild.id})`);
}

async function sendRaidAlert(guild: Guild, config: RaidProtectionConfig, manual: boolean, activatedBy?: string): Promise<void> {
  const channelId = config.antiRaidAlertChannelId;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const actionLabel: Record<string, string> = {
    LOCK: '🔒 Blocage des nouvelles arrivées (join lock)',
    CAPTCHA: '🤖 Captcha forcé pour tous les nouveaux membres',
    KICK: '👢 Expulsion automatique des nouveaux membres',
  };

  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('🚨 Raid détecté - Mode raid activé')
    .setDescription(
      manual
        ? `Le mode raid a été activé manuellement${activatedBy ? ` par <@${activatedBy}>` : ''}.`
        : `**${config.antiRaidJoinThreshold} membres** ont rejoint en moins de **${config.antiRaidJoinWindowSec}s**.`
    )
    .addFields(
      { name: 'Action appliquée', value: actionLabel[config.antiRaidAction] ?? config.antiRaidAction, inline: false },
      {
        name: 'Désactivation',
        value: manual
          ? 'Manuelle uniquement (`/protection raidmode off` ou bouton ci-dessous)'
          : `Automatique dans ${config.antiRaidAutoDisableMinutes} min, ou via le bouton ci-dessous`,
        inline: false,
      }
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rprot:raidmode_off:${guild.id}`)
      .setLabel('Désactiver le mode raid')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🛑')
  );

  await (channel as TextChannel).send({ embeds: [embed], components: [row] }).catch(() => null);
}

/** Cron : désactive les raid modes automatiques expirés. */
export async function autoDisableExpiredRaidModes(client: Client): Promise<void> {
  const actives = await prisma.raidProtectionConfig.findMany({
    where: { raidModeActive: true, raidModeManual: false, raidModeActivatedAt: { not: null } },
  });

  for (const config of actives) {
    const activatedAt = config.raidModeActivatedAt;
    if (!activatedAt) continue;
    const expiresAt = activatedAt.getTime() + config.antiRaidAutoDisableMinutes * 60 * 1000;
    if (Date.now() < expiresAt) continue;

    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) continue;
    await deactivateRaidMode(guild, config).catch((err) =>
      logger.error('RaidProtection', `Auto-disable raid mode échoué pour ${config.guildId}`, err)
    );
  }
}

// ── Join Lock / DM Lock (incident actions Discord, renouvelées par cron) ──────

type IncidentActionsEditable = Guild & {
  setIncidentActions?: (options: { invitesDisabledUntil?: Date | null; dmsDisabledUntil?: Date | null }) => Promise<unknown>;
};

async function applyIncidentActions(guild: Guild, invites: boolean, dms: boolean): Promise<void> {
  const editable = guild as IncidentActionsEditable;
  if (typeof editable.setIncidentActions !== 'function') {
    logger.warn('RaidProtection', 'setIncidentActions indisponible dans cette version de discord.js');
    return;
  }
  const until = new Date(Date.now() + INCIDENT_ACTION_MAX_MS);
  await editable.setIncidentActions({
    invitesDisabledUntil: invites ? until : null,
    dmsDisabledUntil: dms ? until : null,
  });
}

async function syncIncidentActions(guild: Guild): Promise<void> {
  const config = await getRaidProtectionConfig(guild.id);
  const invites = Boolean(config?.joinLockEnabled || (config?.raidModeActive && config?.antiRaidAction === 'LOCK'));
  const dms = Boolean(config?.dmLockEnabled);
  await applyIncidentActions(guild, invites, dms);
}

export async function enableJoinLock(guild: Guild, until: Date | null): Promise<void> {
  await upsertRaidProtectionConfig(guild.id, { joinLockEnabled: true, joinLockUntil: until });
  await syncIncidentActions(guild);
}

export async function disableJoinLock(guild: Guild): Promise<void> {
  await upsertRaidProtectionConfig(guild.id, { joinLockEnabled: false, joinLockUntil: null });
  await syncIncidentActions(guild);
}

export async function enableDmLock(guild: Guild, until: Date | null): Promise<void> {
  await upsertRaidProtectionConfig(guild.id, { dmLockEnabled: true, dmLockUntil: until });
  await syncIncidentActions(guild);
}

export async function disableDmLock(guild: Guild): Promise<void> {
  await upsertRaidProtectionConfig(guild.id, { dmLockEnabled: false, dmLockUntil: null });
  await syncIncidentActions(guild);
}

/**
 * Cron horaire : renouvelle les incident actions (plafonnées à 24h par Discord)
 * tant qu'un lock est actif, et lève les locks arrivés à échéance.
 */
export async function renewActiveLocks(client: Client): Promise<void> {
  const configs = await prisma.raidProtectionConfig.findMany({
    where: { OR: [{ joinLockEnabled: true }, { dmLockEnabled: true }] },
  });

  const now = Date.now();
  for (const config of configs) {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) continue;

    try {
      // Expiration programmée ?
      if (config.joinLockEnabled && config.joinLockUntil && config.joinLockUntil.getTime() <= now) {
        await disableJoinLock(guild);
        continue;
      }
      if (config.dmLockEnabled && config.dmLockUntil && config.dmLockUntil.getTime() <= now) {
        await disableDmLock(guild);
        continue;
      }
      await syncIncidentActions(guild);
    } catch (err) {
      logger.error('RaidProtection', `Renouvellement des locks échoué pour ${config.guildId}`, err);
    }
  }
}

/** Kick d'un membre arrivé pendant un join lock (filet de sécurité au-delà de la pause des invitations). */
export async function handleJoinDuringLock(member: GuildMember, config: RaidProtectionConfig): Promise<boolean> {
  const lockActive = config.joinLockEnabled || (config.raidModeActive && config.antiRaidAction === 'LOCK');
  if (!lockActive || !config.joinLockKick) return false;
  if (member.user.bot) return false;

  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.KickMembers)) return false;

  await notifyJoinBlocked(member.guild.id, member.id, config.joinLockMessage);
  await member.kick('Join lock actif (protection anti-raid)').catch(() => null);
  return true;
}

/** Kick auto pendant un raid mode configuré en action KICK. */
export async function handleJoinDuringRaidKick(member: GuildMember, config: RaidProtectionConfig): Promise<boolean> {
  if (!config.raidModeActive || config.antiRaidAction !== 'KICK') return false;
  if (member.user.bot) return false;

  await notifyJoinBlocked(member.guild.id, member.id, `**${member.guild.name}** est actuellement en mode protection anti-raid. Merci de réessayer plus tard.`);
  await member.kick('Raid mode actif - expulsion automatique').catch(() => null);
  return true;
}
