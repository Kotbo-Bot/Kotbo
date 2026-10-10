import { Client, Events, Message, TextChannel, PermissionFlagsBits } from 'discord.js';
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
} from '../services/moderation/sanctionService.js';
import { generateTranscript } from '../services/features/transcriptService.js';
import { getDashboardUrl } from '../api/shared.js';
import { mirrorModlogToStaffServer } from '../services/staff/staffServerService.js';
import { recordScamImagesFromMessage } from '../services/moderation/scamFilterService.js';
import { recordScamSignals } from '../services/moderation/scamDatasetService.js';
import { scheduleScamDatasetBackfill } from '../services/moderation/scamBackfillService.js';
import { INVITE_SOURCE, recordBotInvite } from '../services/analytics/inviteService.js';

export function registerHoneypotListener(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    const { guild, author, member, channelId } = message;
    if (!guild || !member || author.bot) return;

    try {
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
          try {
            const actionVerb = sanctionType === 'KICK' ? 'exclu' : 'exclu temporairement (softban)';
            await member.send(
              `Bonjour, vous avez été ${actionVerb} de **${guild.name}** car vous avez envoyé un message dans un salon piège (Honeypot).\n` +
              `S'il s'agit d'une erreur, vous pouvez rejoindre à nouveau le serveur en utilisant ce lien d'invitation unique (valable 24h) : ${inviteUrl}`
            );
          } catch (err) {
            logger.warn('Honeypot', `Impossible d'envoyer le message de réinvitation en DM à ${author.tag} (${author.id}) :`, err);
          }
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
        }).catch(() => null);

        actionText = 'banni du serveur';
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
      } else {
        // TIMEOUT
        const durationMs = 28 * 24 * 60 * 60 * 1000;
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
      logger.error('Honeypot', `Erreur lors de la gestion du message dans le honeypot (${guild?.id}) :`, err);
    }
  });

  // Ce que le honeypot a piégé avant l'ajout des domaines, textes et OCR
  // rejoint le jeu de données (une fois par instance).
  scheduleScamDatasetBackfill(client.shard?.ids);

  logger.success('Honeypot', 'Écouteur Honeypot enregistré');
}
