/**
 * shieldService.ts - Shield, le niveau d'alerte du serveur.
 *
 * Cinq niveaux, du 5 (« Tout va bien ») au 1 (« Catastrophe »). Chaque niveau
 * applique un ensemble de mesures, cumulatives en descendant :
 *
 *   5  vérification Discord moyenne
 *   4  captcha activé s'il est configuré, sinon vérification élevée
 *   3  vérification maximale, captcha pour tous les arrivants, MP fermés
 *   2  + captcha gelé (les arrivants attendent) ; sans captcha, mode raid
 *   1  + verrouillage du serveur (@everyone ne peut plus écrire ni parler)
 *
 * Le niveau ne change jamais seul. Shield mémorise ce qu'il a lui-même activé
 * (shieldState) : remonter vers 5 ne défait que ça, jamais ce que le staff
 * avait activé à la main avant l'alerte.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  GuildVerificationLevel,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
} from 'discord.js';
import { Prisma, type RaidProtectionConfig } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import { getCachedGuild } from '../../utils/cache.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import {
  activateRaidMode,
  deactivateRaidMode,
  disableDmLock,
  enableDmLock,
  getRaidProtectionConfig,
  upsertRaidProtectionConfig,
} from './raidProtectionService.js';
import { releaseFrozenCaptchas } from './captchaService.js';

export type ShieldLevel = 1 | 2 | 3 | 4 | 5;

export const SHIELD_LEVELS: Record<ShieldLevel, { name: string; emoji: string; color: number; summary: string }> = {
  5: { name: 'Tout va bien', emoji: '🔵', color: 0x3b82f6, summary: 'Vérification Discord moyenne, rien d\'autre.' },
  4: { name: 'Vigilance', emoji: '🟢', color: 0x22c55e, summary: 'Captcha activé s\'il est configuré, sinon vérification Discord élevée.' },
  3: { name: 'Alerte', emoji: '🟡', color: 0xeab308, summary: 'Vérification maximale, captcha pour tous les arrivants, MP fermés.' },
  2: { name: 'Critique', emoji: '🔴', color: 0xef4444, summary: 'Niveau 3 + captcha gelé. Sans captcha : mode raid.' },
  1: { name: 'Catastrophe', emoji: '⚪', color: 0xf5f5f5, summary: 'Niveau 2 + verrouillage du serveur.' },
};

/** Permissions retirées à @everyone au niveau 1. */
const LOCK_BITS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendVoiceMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseApplicationCommands,
];

type ShieldState = {
  /** Niveau de vérification avant la première alerte. */
  verificationBefore?: GuildVerificationLevel;
  captchaEnabled?: boolean;
  dmLock?: boolean;
  raidMode?: boolean;
  /** Permissions retirées à @everyone (bitfield en chaîne). */
  lockedBits?: string;
};

export function isShieldLevel(value: unknown): value is ShieldLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

export function captchaConfigured(config: RaidProtectionConfig | null): boolean {
  return Boolean(config?.captchaChannelId && config?.captchaUnverifiedRoleId);
}

/** Le captcha est-il gelé (arrivants retenus derrière la porte) ? */
export function isCaptchaFrozen(config: RaidProtectionConfig | null): boolean {
  return Boolean(config && config.shieldLevel <= 2 && captchaConfigured(config));
}

function targetVerification(level: ShieldLevel, hasCaptcha: boolean): GuildVerificationLevel {
  if (level <= 3) return GuildVerificationLevel.VeryHigh;
  if (level === 4 && !hasCaptcha) return GuildVerificationLevel.High;
  return GuildVerificationLevel.Medium;
}

export type ShieldResult = { previous: ShieldLevel; level: ShieldLevel; warnings: string[] };

/**
 * Applique un niveau. Chaque mesure est tentée indépendamment : une permission
 * manquante pour l'une ne bloque pas les autres, elle remonte en avertissement.
 */
export async function setShieldLevel(guild: Guild, level: ShieldLevel, actorId: string): Promise<ShieldResult> {
  const config = (await getRaidProtectionConfig(guild.id)) ?? (await upsertRaidProtectionConfig(guild.id, {}));
  const previous = (isShieldLevel(config.shieldLevel) ? config.shieldLevel : 5) as ShieldLevel;
  const state: ShieldState = { ...((config.shieldState as ShieldState | null) ?? {}) };
  const warnings: string[] = [];
  const me = guild.members.me;
  const hasCaptcha = captchaConfigured(config);

  // ── Vérification Discord ──────────────────────────────────────────────
  if (me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    if (state.verificationBefore === undefined && level < 5) state.verificationBefore = guild.verificationLevel;
    const target =
      level === 5 ? state.verificationBefore ?? GuildVerificationLevel.Medium : targetVerification(level, hasCaptcha);
    if (guild.verificationLevel !== target) {
      await guild.setVerificationLevel(target, `Shield ${level}`).catch((err) => {
        warnings.push('Niveau de vérification non modifié (une règle Discord l\'empêche peut-être).');
        logger.warn('Shield', `Vérification non modifiée sur ${guild.id}: ${String(err)}`);
      });
    }
    if (level === 5) delete state.verificationBefore;
  } else {
    warnings.push('Permission « Gérer le serveur » manquante : la vérification Discord n\'a pas été changée.');
  }

  // ── Captcha ───────────────────────────────────────────────────────────
  const wantCaptcha = level <= 4 && hasCaptcha;
  if (wantCaptcha && !config.captchaEnabled) {
    await upsertRaidProtectionConfig(guild.id, { captchaEnabled: true });
    state.captchaEnabled = true;
  } else if (!wantCaptcha && state.captchaEnabled) {
    await upsertRaidProtectionConfig(guild.id, { captchaEnabled: false });
    delete state.captchaEnabled;
  }
  if (level <= 3 && !hasCaptcha) {
    warnings.push('Captcha non configuré (salon et rôle) : Shield renforce la vérification à la place.');
  }

  // ── Fermeture des MP ──────────────────────────────────────────────────
  const wantDmLock = level <= 3;
  if (wantDmLock && !config.dmLockEnabled) {
    if (!guild.features.includes('COMMUNITY')) {
      warnings.push('La fermeture des MP demande le mode Communauté.');
    } else {
      await enableDmLock(guild, null).catch(() => warnings.push('Fermeture des MP impossible (permission « Gérer le serveur » ?).'));
      state.dmLock = true;
    }
  } else if (!wantDmLock && state.dmLock) {
    await disableDmLock(guild).catch(() => null);
    delete state.dmLock;
  }

  // ── Mode raid (seulement sans captcha) ───────────────────────────────
  const wantRaid = level <= 2 && !hasCaptcha;
  const fresh = await getRaidProtectionConfig(guild.id);
  if (wantRaid && !fresh?.raidModeActive) {
    await activateRaidMode(guild, fresh ?? config, true, actorId);
    state.raidMode = true;
  } else if (!wantRaid && state.raidMode) {
    await deactivateRaidMode(guild).catch(() => null);
    delete state.raidMode;
  }

  // ── Verrouillage du serveur ───────────────────────────────────────────
  const everyone = guild.roles.everyone;
  if (level === 1 && !state.lockedBits) {
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      warnings.push('Permission « Gérer les rôles » manquante : le serveur n\'a pas été verrouillé.');
    } else {
      const removed = new PermissionsBitField(LOCK_BITS).bitfield & everyone.permissions.bitfield;
      await everyone
        .setPermissions(everyone.permissions.remove(LOCK_BITS), 'Shield 1 : verrouillage du serveur')
        .then(() => (state.lockedBits = removed.toString()))
        .catch((err) => {
          warnings.push('Verrouillage impossible.');
          logger.warn('Shield', `Verrouillage impossible sur ${guild.id}: ${String(err)}`);
        });
      const leaks = rolesThatCanStillTalk(guild);
      if (leaks.length > 0) warnings.push(`Ces rôles gardent la parole : ${leaks.map((r) => `<@&${r}>`).join(', ')}.`);
    }
  } else if (level > 1 && state.lockedBits) {
    // On ne rend que ce que Shield a retiré : une permission retirée à la
    // main pendant l'alerte reste retirée.
    await everyone
      .setPermissions(everyone.permissions.add(BigInt(state.lockedBits)), `Shield ${level} : fin du verrouillage`)
      .then(() => delete state.lockedBits)
      .catch(() => warnings.push('Le verrouillage n\'a pas pu être levé : vérifie les permissions de @everyone.'));
  }

  await upsertRaidProtectionConfig(guild.id, {
    shieldLevel: level,
    // Prisma refuse null pour une colonne JSON : DbNull vide la colonne.
    shieldState: (Object.keys(state).length > 0 ? state : Prisma.DbNull) as never,
    shieldChangedAt: new Date(),
    shieldChangedBy: actorId,
  });

  // Le captcha dégèle en quittant les niveaux 2 et 1 : les arrivants retenus
  // reçoivent leur défi.
  if (previous <= 2 && level > 2 && hasCaptcha) {
    void releaseFrozenCaptchas(guild).catch((err) => logger.warn('Shield', `Dégel du captcha incomplet (${guild.id}): ${String(err)}`));
  }

  if (previous !== level) {
    await logLevelChange(guild, previous, level, actorId);
    void refreshShieldDisplays(guild).catch(() => null);
  }
  logger.warn('Shield', `${guild.id} : Shield ${previous} → ${level} par ${actorId}${warnings.length ? ` (${warnings.length} avertissement(s))` : ''}`);
  return { previous, level, warnings };
}

/** Rôles autres que @everyone qui gardent l'écriture pendant un verrouillage. */
function rolesThatCanStillTalk(guild: Guild): string[] {
  return guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed && r.permissions.has(PermissionFlagsBits.SendMessages) && !r.permissions.has(PermissionFlagsBits.ManageMessages) && r.members.size > 0)
    .map((r) => r.id)
    .slice(0, 10);
}

async function logLevelChange(guild: Guild, previous: ShieldLevel, level: ShieldLevel, actorId: string): Promise<void> {
  const guildConfig = await getCachedGuild(guild.id);
  const channel = await resolveLogChannel(guild, guildConfig?.logChannelId, 'Shield');
  if (!channel) return;
  const meta = SHIELD_LEVELS[level];
  const verb = level < previous ? 'monté' : 'descendu';
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} Shield ${level} : ${meta.name}`)
    .setDescription(`Le **niveau de danger** est ${verb} de ${previous} à ${level} par <@${actorId}>.\n${meta.summary}`)
    .setTimestamp();
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
}

// ── Panneau et salon de statut ──────────────────────────────────────────────

export function buildShieldPanel(level: ShieldLevel) {
  const meta = SHIELD_LEVELS[level];
  const legend = ([5, 4, 3, 2, 1] as ShieldLevel[])
    .map((l) => `${SHIELD_LEVELS[l].emoji} **Shield ${l}** · ${SHIELD_LEVELS[l].name}${l === level ? ' ◀' : ''}\n${SHIELD_LEVELS[l].summary}`)
    .join('\n\n');
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} Niveau actuel : Shield ${level} · ${meta.name}`)
    .setDescription(`${legend}\n\nLe niveau ne change jamais seul. Revenir à 5 annule ce que Shield avait activé, sans toucher à ce que l'équipe avait mis en place.`)
    .setFooter({ text: 'Accès au salon = droit de changer le niveau.' });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ([5, 4, 3, 2, 1] as ShieldLevel[]).map((l) =>
      new ButtonBuilder()
        .setCustomId(`shield:set:${l}`)
        .setLabel(`${l}`)
        .setEmoji(SHIELD_LEVELS[l].emoji)
        .setStyle(l === level ? ButtonStyle.Primary : l <= 2 ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(l === level)
    )
  );
  return { embeds: [embed], components: [row] };
}

/** Un salon de panneau ne doit pas être visible de tout le serveur. */
export function isStaffOnlyChannel(channel: GuildBasedChannel): boolean {
  return !channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
}

export async function postShieldPanel(guild: Guild, channelId: string): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) return { ok: false, reason: 'Salon introuvable ou sans discussion.' };
  if (!isStaffOnlyChannel(channel)) return { ok: false, reason: 'Ce salon est visible par tout le serveur : choisis un salon réservé à l\'équipe.' };
  const config = await getRaidProtectionConfig(guild.id);
  const level = (isShieldLevel(config?.shieldLevel) ? config!.shieldLevel : 5) as ShieldLevel;

  // L'ancien panneau est retiré : deux panneaux se contrediraient.
  if (config?.shieldPanelChannelId && config.shieldPanelMessageId) {
    const old = await guild.channels.fetch(config.shieldPanelChannelId).catch(() => null);
    if (old?.isTextBased()) await old.messages.delete(config.shieldPanelMessageId).catch(() => null);
  }
  const message = await (channel as GuildTextBasedChannel).send(buildShieldPanel(level)).catch(() => null);
  if (!message) return { ok: false, reason: 'Kotbo ne peut pas écrire dans ce salon.' };
  await upsertRaidProtectionConfig(guild.id, { shieldPanelChannelId: channel.id, shieldPanelMessageId: message.id });
  return { ok: true, messageId: message.id };
}

/** Crée un salon #shield invisible pour @everyone, à ouvrir ensuite aux rôles de l'équipe. */
export async function createShieldPanelChannel(guild: Guild): Promise<string> {
  const channel = await guild.channels.create({
    name: 'shield',
    type: ChannelType.GuildText,
    topic: 'Niveau d\'alerte du serveur. Ouvre ce salon aux rôles de l\'équipe qui peuvent le changer.',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    ],
    reason: 'Shield : salon du panneau',
  });
  return channel.id;
}

/** Salon vocal de statut, à côté du panneau, avec ses permissions. Personne ne peut s'y connecter. */
export async function createShieldStatusChannel(guild: Guild): Promise<string> {
  const config = await getRaidProtectionConfig(guild.id);
  const panel = config?.shieldPanelChannelId ? guild.channels.cache.get(config.shieldPanelChannelId) : null;
  const level = (isShieldLevel(config?.shieldLevel) ? config!.shieldLevel : 5) as ShieldLevel;
  const overwrites = panel && 'permissionOverwrites' in panel ? [...panel.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type })) : [];
  const channel = await guild.channels.create({
    name: statusName(level),
    type: ChannelType.GuildVoice,
    parent: panel && 'parentId' in panel ? panel.parentId : undefined,
    permissionOverwrites: [
      ...overwrites.filter((o) => o.id !== guild.roles.everyone.id),
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect, ...(overwrites.some((o) => o.id === guild.roles.everyone.id) ? [PermissionFlagsBits.ViewChannel] : [])] },
    ],
    reason: 'Shield : salon de statut',
  });
  await upsertRaidProtectionConfig(guild.id, { shieldStatusChannelId: channel.id });
  return channel.id;
}

function statusName(level: ShieldLevel): string {
  return `${SHIELD_LEVELS[level].emoji} Shield ${level}`;
}

/**
 * Met à jour le panneau et le nom du salon de statut. Discord limite le
 * renommage d'un salon à deux fois toutes les dix minutes : le panneau reste
 * la référence, le salon de statut suit quand il peut.
 */
export async function refreshShieldDisplays(guild: Guild): Promise<void> {
  const config = await getRaidProtectionConfig(guild.id);
  if (!config) return;
  const level = (isShieldLevel(config.shieldLevel) ? config.shieldLevel : 5) as ShieldLevel;
  if (config.shieldPanelChannelId && config.shieldPanelMessageId) {
    const channel = await guild.channels.fetch(config.shieldPanelChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(config.shieldPanelMessageId).catch(() => null);
      await message?.edit(buildShieldPanel(level)).catch(() => null);
    }
  }
  if (config.shieldStatusChannelId) {
    const status = await guild.channels.fetch(config.shieldStatusChannelId).catch(() => null);
    if (status && 'setName' in status && status.name !== statusName(level)) {
      await Promise.race([status.setName(statusName(level), 'Shield').catch(() => null), new Promise((r) => setTimeout(r, 5_000))]);
    }
  }
}
