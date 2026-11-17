import type { ContextCommandDefinition, SlashCommandDefinition } from '../../commands.js';
import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getDashboardUrl } from '../../api/shared.js';
import {
  createVerificationSessionRecord,
  buildVerificationUrl,
  buildVerificationEmbed,
} from '../../services/moderation/securityVerificationService.js';
import { deliverVerification } from '../../services/moderation/verificationDeliveryService.js';
import { isVerificationRequestSpam, VERIFICATION_SPAM_MESSAGE } from '../../services/moderation/verificationSpamGuard.js';
import { queueAuditLog } from '../../utils/auditLogger.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b1_reqverif');
const contextMeta = getCommandMetadata('b1_reqverif_context');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((option) =>
    option
      .setName('membre')
      .setDescription(m.b1_reqverif_opt_membre({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b1_reqverif_opt_membre({}, { locale: 'fr' }) })
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('raison')
      .setDescription(m.b1_reqverif_opt_raison({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b1_reqverif_opt_raison({}, { locale: 'fr' }) })
      .setRequired(false)
  );

const contextData = new ContextMenuCommandBuilder()
  .setName(contextMeta.name)
  .setNameLocalizations(contextMeta.nameLocalizations)
  .setType(ApplicationCommandType.User)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

async function execute(interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ Cette commande doit être exécutée sur un serveur.", flags: ["Ephemeral"] });
    return;
  }

  await interaction.deferReply({ flags: ["Ephemeral"] });

  if (await isVerificationRequestSpam(interaction.client, {
    guildId,
    guildName: interaction.guild?.name || 'Serveur',
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
  })) {
    await interaction.editReply({ content: VERIFICATION_SPAM_MESSAGE });
    return;
  }

  const targetUser = interaction.isChatInputCommand()
    ? interaction.options.getUser('membre', true)
    : interaction.targetUser;

  const reason = (interaction.isChatInputCommand() ? interaction.options.getString('raison') : null) || 'Vérification de sécurité forcée par le staff.';

  try {
    const member = await interaction.guild?.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      await interaction.editReply({ content: "❌ Membre introuvable sur ce serveur." });
      return;
    }

    if (targetUser.bot) {
      await interaction.editReply({ content: "❌ Impossible de demander la vérification d'un bot." });
      return;
    }

    // 1. Create verification session (and token)
    const verification = await createVerificationSessionRecord(guildId, targetUser.id);

    // 2. Timeout the member on Discord
    const TIMEOUT_DURATION = 28 * 24 * 60 * 60 * 1000; // 28 days
    let timeoutSuccess = true;
    await member.timeout(TIMEOUT_DURATION, `Vérification requise par @${interaction.user.tag}`).catch((err) => {
      logger.error('RequestVerificationCommand', `Failed to timeout ${targetUser.id}:`, err);
      timeoutSuccess = false;
    });

    // 3. Send DM to the user
    const dashboardUrl = getDashboardUrl();
    const verifyUrl = buildVerificationUrl(dashboardUrl, guildId, verification.token);
    const guildConfig = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        verificationEmbedTitle: true,
        verificationEmbedDesc: true,
        verificationEmbedColor: true,
      },
    });
    
    const embedTitle = guildConfig?.verificationEmbedTitle || "Vérification de sécurité";
    const embedDesc = guildConfig?.verificationEmbedDesc || "Vous devez vérifier votre identité pour regagner l'accès au serveur.";
    const embedColor = guildConfig?.verificationEmbedColor || "#5865F2";
    
    const { embed, row } = buildVerificationEmbed(
      interaction.guild?.name || 'Serveur',
      embedTitle,
      embedDesc,
      embedColor,
      verifyUrl
    );

    // Repli automatique (thread privé ou ticket) si les MP sont fermés + notification staff.
    const delivery = await deliverVerification({
      client: interaction.client,
      guildId,
      user: targetUser,
      member,
      embed,
      row,
      reason,
      verificationId: verification.id,
    });
    const { dmSent, fallbackChannelId, fallbackKind } = delivery;

    // 4. Log in audit log
    const deliveryDetail = dmSent
      ? 'DM envoyé: Oui.'
      : fallbackChannelId
        ? `DM envoyé: Non (MP fermés). Repli: ${fallbackKind === 'THREAD' ? 'thread privé' : 'ticket'} <#${fallbackChannelId}>.`
        : 'DM envoyé: Non (MP fermés). Repli: aucun (échec de création).';
    const auditDetails = `Vérification forcée pour @${targetUser.username} (${targetUser.id}). Raison: ${reason}. ${deliveryDetail} Timeout appliqué: ${timeoutSuccess ? 'Oui' : 'Non (Échec permissions)'}.`;

    queueAuditLog({
      guildId,
      user: `@${interaction.user.tag}`,
      action: 'Demande de vérification forcée',
      context: interaction.guild?.name || 'Serveur',
      details: auditDetails,
      module: 'Sanctions',
      eventType: 'Manuel',
    });

    let msg = `✅ Demande de vérification envoyée avec succès à <@${targetUser.id}>.`;
    if (!timeoutSuccess) msg += "\n⚠️ Attention : Le bot n'a pas pu appliquer le Timeout sur l'utilisateur (permissions insuffisantes).";
    if (!dmSent && fallbackChannelId) {
      msg += `\n📪 Les MP du membre sont fermés : le lien a été posté dans ${fallbackKind === 'THREAD' ? 'un thread privé' : 'un ticket'} <#${fallbackChannelId}>.`;
    } else if (!dmSent) {
      msg += "\n⚠️ Attention : Le message privé (DM) n'a pas pu être envoyé (MP fermés) et aucun salon de repli n'a pu être créé. Configure un salon de vérification depuis le dashboard.";
    }

    await interaction.editReply({ content: msg });
  } catch (err) {
    logger.error('RequestVerificationCommand', 'Error processing request verification:', err);
    await interaction.editReply({ content: "❌ Une erreur est survenue lors de l'envoi de la demande de vérification." });
  }
}

export const requestVerificationCommand = { data, execute } satisfies SlashCommandDefinition;
export const requestVerificationContextCommand = { data: contextData, execute } satisfies ContextCommandDefinition;
