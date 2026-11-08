import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, Message, MessageFlags, TextChannel, PermissionFlagsBits, type ButtonInteraction } from 'discord.js';
import { logger } from '../utils/logger.js';
import { resolveLogChannel } from '../utils/logChannel.js';
import { errorEmbed } from '../utils/embeds.js';
import { getCachedGuild } from '../utils/cache.js';
import {
  registerWarnSanction,
  registerKickSanction,
  registerBanSanction,
  registerSoftbanSanction,
  registerTimeoutSanction,
  registerJailSanction,
} from '../services/moderation/sanctionService.js';
import { isJailConfigured } from '../services/moderation/jailService.js';
import { formatMinutes } from '../services/moderation/autoSanction.js';

type GuildConfig = NonNullable<Awaited<ReturnType<typeof getCachedGuild>>>;
import { generateTranscript } from '../services/features/transcriptService.js';
import { getDashboardUrl } from '../api/shared.js';
import { mirrorModlogToStaffServer } from '../services/staff/staffServerService.js';
import { recordScamImagesFromMessage } from '../services/moderation/scamFilterService.js';
import { recordScamSignals } from '../services/moderation/scamDatasetService.js';
import { scheduleScamDatasetBackfill } from '../services/moderation/scamBackfillService.js';
import { INVITE_SOURCE, recordBotInvite } from '../services/analytics/inviteService.js';
import { notifyJoinBlocked } from '../services/notifications/notifyService.js';

// ── Délai avant sanction ────────────────────────────────────────────────────
//
// Avec un délai, le message est retiré et le membre mentionné dans le salon
// piège avec un bouton « C'était une erreur ». Sans clic à temps, la sanction
// tombe. Un membre qui poste le même message ailleurs pendant le délai est
// sanctionné tout de suite : c'est la signature des robots de spam.
// shortcut: délais gardés en mémoire du shard, un redémarrage pendant le délai les perd (au pire 5 min sans sanction).

type PendingGrace = {
  channelId: string;
  content: string;
  noticeId: string | null;
  timer: ReturnType<typeof setTimeout>;
  finalize: () => Promise<void>;
};

const pendingGrace = new Map<string, PendingGrace>();

function graceKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function settleGrace(key: string, punishNow: boolean): Promise<void> {
  const pending = pendingGrace.get(key);
  if (!pending) return;
  pendingGrace.delete(key);
  clearTimeout(pending.timer);
  if (punishNow) await pending.finalize();
}

async function startGrace(client: Client, message: Message, seconds: number, finalize: () => Promise<void>): Promise<void> {
  const key = graceKey(message.guild!.id, message.author.id);
  if (pendingGrace.has(key)) {
    // Deuxième message dans le salon piège pendant le délai : pas un accident.
    await message.delete().catch(() => null);
    await settleGrace(key, true);
    return;
  }
  const content = normalizeContent(message.content);
  // Le message est retiré, mais l'objet garde ses pièces jointes : le jeu de
  // données les lira si la sanction tombe.
  await message.delete().catch(() => null);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`hp:mistake:${message.author.id}`).setLabel("C'était une erreur").setStyle(ButtonStyle.Secondary),
  );
  const notice = await (message.channel as TextChannel)
    .send({
      content: `<@${message.author.id}> ce salon est un piège à robots : personne ne doit y écrire. Si c'était une erreur, clique sur le bouton dans les ${seconds >= 60 ? `${seconds / 60} minute${seconds >= 120 ? 's' : ''}` : `${seconds} secondes`}, sinon une sanction s'appliquera.`,
      components: [row],
      allowedMentions: { users: [message.author.id] },
    })
    .catch(() => null);
  const timer = setTimeout(() => {
    void settleGrace(key, true).finally(() => notice?.delete().catch(() => null));
  }, seconds * 1000);
  pendingGrace.set(key, {
    channelId: message.channelId,
    content,
    noticeId: notice?.id ?? null,
    timer,
    finalize: async () => {
      await notice?.delete().catch(() => null);
      await finalize();
    },
  });
}

/** Bouton « C'était une erreur » : seul le membre concerné peut s'en servir. */
export async function handleHoneypotMistake(interaction: ButtonInteraction): Promise<void> {
  const userId = interaction.customId.split(':')[2];
  if (interaction.user.id !== userId || !interaction.guildId) {
    await interaction.reply({ content: 'Ce bouton ne te concerne pas.', flags: [MessageFlags.Ephemeral] });
    return;
  }
  const key = graceKey(interaction.guildId, userId);
  if (!pendingGrace.has(key)) {
    await interaction.reply({ content: 'Trop tard : le délai est écoulé.', flags: [MessageFlags.Ephemeral] });
    return;
  }
  await settleGrace(key, false);
  await interaction.reply({ content: "C'est noté, aucune sanction. N'écris plus dans ce salon.", flags: [MessageFlags.Ephemeral] });
  await interaction.message.delete().catch(() => null);
}

/**
 * Sanction d'un membre piégé : ses images et son texte rejoignent le jeu de
 * données d'arnaques, puis la sanction configurée tombe et est journalisée.
 */
async function punish(client: Client, message: Message, guildConfig: GuildConfig, transcriptLink: string | null): Promise<void> {
  const guild = message.guild!;
  const author = message.author;
  const member = message.member!;
  const channelId = message.channelId;
  try {
      // Enregistre les hash des images postées dans la base d'images scam
      // (le filtre anti-scam pourra ensuite les bloquer partout) - AVANT la
      // suppression du message, tant que les URLs CDN sont encore valides.
      if (message.attachments.size > 0) {
        await recordScamImagesFromMessage(message, 'HONEYPOT').catch((err) =>
          logger.error('Honeypot', `Enregistrement des images scam impossible (${guild.id}):`, err)
        );
      }

      // Domaines et texte du message : le filtre anti-scam reconnaîtra ensuite la
      // même campagne (même domaine, même texte recopié) sur ce serveur, puis sur
      // tous une fois le seuil de promotion atteint.
      if (message.content) {
        await recordScamSignals(guild.id, message.content, 'HONEYPOT').catch((err) =>
          logger.error('Honeypot', `Enregistrement des signaux scam impossible (${guild.id}):`, err)
        );
      }

      // Delete the message immediately to prevent spam spread
      await message.delete().catch(() => null);

      let reason = 'Kotbo Honeypot: Sent a message in the restricted honeypot channel (possible hacked account / spam bot).';
      if (transcriptLink) {
        reason += `\nProof/Transcript: ${transcriptLink}`;
      }

      const target = { id: author.id, tag: author.tag };
      const moderator = { id: client.user!.id, tag: client.user!.tag };
      const evidenceLinks = transcriptLink ? [transcriptLink] : [];

      const sanctionType = guildConfig.honeypotSanction || 'TIMEOUT';

      // null = permanente pour BAN et JAIL, 28 jours (plafond Discord) pour un timeout.
      const durationMin = guildConfig.honeypotDurationMin ?? null;
      const durationLabel = durationMin ? formatMinutes(durationMin) : 'permanent';
      let actionText = 'exclu temporairement (Timeout 28 jours)';
      let logTitle = '🚨 Détection Honeypot : Timeout appliqué';

      // Reinvite logic (for KICK or SOFTBAN)
      let inviteUrl: string | null = null;
      if ((sanctionType === 'KICK' || sanctionType === 'SOFTBAN') && guildConfig.honeypotReinvite) {
        try {
          const targetChannel = (guildConfig.publicChannelId ? guild.channels.cache.get(guildConfig.publicChannelId) : null) ||
                                guild.systemChannel ||
                                guild.rulesChannel ||
                                guild.channels.cache.find(c => c.isTextBased() && c.type === 0 && c.permissionsFor(client.user!)?.has('CreateInstantInvite'));
          if (targetChannel && 'createInvite' in targetChannel && typeof targetChannel.createInvite === 'function') {
            const invite = await targetChannel.createInvite({
              maxAge: 24 * 60 * 60,
              maxUses: 1,
              reason: 'Kotbo Honeypot: Automatic reinvite'
            });
            inviteUrl = invite.url;
            await recordBotInvite(invite, INVITE_SOURCE.honeypot());
          }
        } catch (err) {
          logger.error('Honeypot', `Impossible de créer une invitation automatique pour la guilde ${guild.id}:`, err);
        }

        if (inviteUrl) {
          const actionVerb = sanctionType === 'KICK' ? 'exclu' : 'exclu temporairement (softban)';
          await notifyJoinBlocked(
            guild.id,
            author.id,
            `Bonjour, vous avez été ${actionVerb} de **${guild.name}** car vous avez envoyé un message dans un salon piège (Honeypot).\n` +
              `S'il s'agit d'une erreur, vous pouvez rejoindre à nouveau le serveur en utilisant ce lien d'invitation unique (valable 24h) : ${inviteUrl}`,
            inviteUrl,
          );
        }
      }

      if (sanctionType === 'BAN') {
        await member.ban({
          deleteMessageSeconds: 60 * 60 * 24, // Delete messages from past 24 hours
          reason,
        });
        await registerBanSanction({
          guildId: guild.id,
          target,
          moderator,
          reason,
          client,
          evidenceLinks,
          temporaryDurationMs: durationMin ? durationMin * 60_000 : undefined,
        }).catch(() => null);

        actionText = durationMin ? `banni du serveur (${durationLabel})` : 'banni du serveur (permanent)';
        logTitle = '🚨 Détection Honeypot : Compte banni';
        logger.warn('Honeypot', `Utilisateur banni car il a écrit dans le salon honeypot : ${author.tag} (${author.id})`);
      } else if (sanctionType === 'KICK') {
        await member.kick(reason);
        await registerKickSanction({
          guildId: guild.id,
          target,
          moderator,
          reason,
          client,
          evidenceLinks,
        }).catch(() => null);

        actionText = 'exclu (kick)';
        logTitle = '🚨 Détection Honeypot : Compte exclu';
        logger.warn('Honeypot', `Utilisateur exclu car il a écrit dans le salon honeypot : ${author.tag} (${author.id})`);
      } else if (sanctionType === 'SOFTBAN') {
        await member.ban({
          deleteMessageSeconds: 60 * 60 * 24 * 7,
          reason,
        });
        await guild.members.unban(author.id, 'Kotbo Honeypot: Softban (unban after message purge)').catch(() => null);
        await registerSoftbanSanction({
          guildId: guild.id,
          target,
          moderator,
          reason,
          client,
          evidenceLinks,
        }).catch(() => null);

        actionText = 'softban (ban + déban immédiat)';
        logTitle = '🚨 Détection Honeypot : Softban appliqué';
        logger.warn('Honeypot', `Utilisateur softban car il a écrit dans le salon honeypot : ${author.tag} (${author.id})`);
      } else if (sanctionType === 'WARN') {
        await registerWarnSanction({
          guildId: guild.id,
          target,
          moderator,
          reason,
          client,
          evidenceLinks,
        }).catch(() => null);

        actionText = 'averti (warn)';
        logTitle = '🚨 Détection Honeypot : Avertissement appliqué';
        logger.warn('Honeypot', `Utilisateur averti car il a écrit dans le salon honeypot : ${author.tag} (${author.id})`);
      } else if (sanctionType === 'JAIL' && (await isJailConfigured(guild))) {
        await registerJailSanction({
          guildId: guild.id,
          target,
          moderator,
          reason,
          durationMs: durationMin ? durationMin * 60_000 : null,
          member,
          source: 'HONEYPOT',
          client,
          evidenceLinks,
        }).catch(() => null);

        actionText = `mis en quarantaine (${durationLabel})`;
        logTitle = '🚨 Détection Honeypot : Quarantaine appliquée';
        logger.warn('Honeypot', `Utilisateur mis en quarantaine car il a écrit dans le salon honeypot : ${author.tag} (${author.id})`);
      } else {
        // TIMEOUT (et repli d'un Jail sans rôle configuré)
        const durationMs = Math.min(durationMin ?? 28 * 24 * 60, 28 * 24 * 60 - 1) * 60_000;
        await registerTimeoutSanction({
          guildId: guild.id,
          target,
          moderator,
          reason,
          durationMs,
          member,
          client,
          evidenceLinks,
        }).catch(() => null);

        actionText = 'exclu temporairement (Timeout 28 jours)';
        logTitle = '🚨 Détection Honeypot : Timeout appliqué';
        logger.warn('Honeypot', `Utilisateur mis en timeout car il a écrit dans le salon honeypot : ${author.tag} (${author.id})`);
      }

      // Log the action in the server logs channel
      let embedDescription = `L'utilisateur **${author.tag}** (<@${author.id}>) a été ${actionText} car il a écrit dans le salon piège <#${channelId}>.\n\n` +
        `**Message supprimé :**\n\`\`\`\n${message.content.slice(0, 1000) || '[Pas de texte/média]'}\n\`\`\``;

      if (transcriptLink) {
        embedDescription += `\n\n**Transcription (Preuve) :**\n🌐 [Consulter le transcript](${transcriptLink})`;
      }
      const embed = errorEmbed(logTitle, embedDescription);

      const logChannel = await resolveLogChannel(guild, guildConfig.logChannelId, 'Honeypot');
      if (logChannel) {
        await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
      }

      await mirrorModlogToStaffServer(client, guild.id, embed);
  } catch (err) {
    logger.error('Honeypot', `Sanction honeypot impossible (${guild.id}) :`, err);
  }
}

export function registerHoneypotListener(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    const { guild, author, member, channelId } = message;
    if (!guild || !member || author.bot) return;

    try {
      const pending = pendingGrace.get(graceKey(guild.id, author.id));
      if (pending && channelId !== pending.channelId && pending.content && normalizeContent(message.content) === pending.content) {
        await message.delete().catch(() => null);
        await settleGrace(graceKey(guild.id, author.id), true);
        return;
      }

      const guildConfig = await getCachedGuild(guild.id);

      if (!guildConfig || !guildConfig.honeypotEnabled || guildConfig.honeypotChannelId !== channelId) {
        return;
      }

      // Check if the user is staff or administrator to bypass the trap
      const isOwner = author.id === process.env.DISCORD_CLIENT_OWNER_ID;
      const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
      
      const hasStaffRole = (guildConfig.baseStaffRoleId && member.roles.cache.has(guildConfig.baseStaffRoleId)) ||
                            (guildConfig.moderatorRoleId && member.roles.cache.has(guildConfig.moderatorRoleId)) ||
                            (guildConfig.testStaffRoleId && member.roles.cache.has(guildConfig.testStaffRoleId));

      if (isOwner || isAdmin || hasStaffRole) {
        // Staff bypassed the trap
        return;
      }

      // 1. Generate the transcript of the honeypot channel (which includes the spammer's messages)
      let transcriptLink: string | null = null;
      try {
        const textChannel = message.channel as TextChannel;
        const transcriptData = await generateTranscript(textChannel);
        const dashboardUrl = getDashboardUrl();
        transcriptLink = `${dashboardUrl.replace(/\/$/, '')}/transcripts/${transcriptData.id}`;
      } catch (err) {
        logger.error('Honeypot', `Impossible de générer le transcript pour la détection honeypot dans la guilde ${guild.id}:`, err);
      }

      const graceSeconds = guildConfig.honeypotGraceSeconds ?? 0;
      if (graceSeconds > 0) {
        await startGrace(client, message, graceSeconds, () => punish(client, message, guildConfig, transcriptLink));
        return;
      }
      await punish(client, message, guildConfig, transcriptLink);
    } catch (err) {
      logger.error('Honeypot', `Erreur lors de la gestion du message dans le honeypot (${guild?.id}) :`, err);
    }
  });

  // Ce que le honeypot a piégé avant l'ajout des domaines, textes et OCR
  // rejoint le jeu de données (une fois par instance).
  scheduleScamDatasetBackfill(client.shard?.ids);

  logger.success('Honeypot', 'Écouteur Honeypot enregistré');
}
