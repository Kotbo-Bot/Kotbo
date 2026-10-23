import {
  type Client,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import {
  getDailyAlgoButtonRow,
  getDailyAlgoSubmissionAvailability,
  getDailyAlgoSubmissionFeedbackForUser,
  queueDailyAlgoSubmission,
} from '../services/progression/dailyAlgoService.js';
import { replyOrFollowUp } from '../utils/interactionResponses.js';
import { publicErrorMessage } from '../utils/publicError.js';

function formatRankLabel(rank: number): string {
  if (rank === 1) return '🥇 1er';
  if (rank === 2) return '🥈 2ème';
  if (rank === 3) return '🥉 3ème';
  return `#${rank}`;
}

export function registerDailyAlgoHandlers(client: Client): void {
  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('daily-algo-submit:') && !interaction.customId.startsWith('daily-algo-why:')) return;

    if (interaction.customId.startsWith('daily-algo-why:')) {
      const runId = interaction.customId.split(':')[1];
      if (!runId) return;

      const feedback = await getDailyAlgoSubmissionFeedbackForUser(runId, interaction.user.id);
      if (!feedback) {
        await interaction.reply({
          content: "ℹ️ Tu n'as pas participé à ce Daily Algo.",
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      if (feedback.status === 'PENDING') {
        await interaction.reply({
          content: '⏳ Ta soumission est encore en attente de notation.',
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      if (feedback.status === 'REJECTED') {
        await interaction.reply({
          content: `❌ Ta soumission a été rejetée.${feedback.reviewFeedback ? `\n\n🗒️ **Retour du staff**\n${feedback.reviewFeedback}` : ''}`,
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      if (feedback.status === 'DISMISSED') {
        await interaction.reply({
          content: `🚫 Ta soumission a été jugée hors-sujet : elle ne rapporte pas de points, mais elle n'entraîne aucune sanction.${feedback.reviewFeedback ? `\n\n🗒️ **Retour du staff**\n${feedback.reviewFeedback}` : ''}`,
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      const details = `✅ ${feedback.scoreCorrectness ?? '-'}/5 · 💬 ${feedback.scoreComments ?? '-'}/5 · 📦 ${feedback.scoreCompactness ?? '-'}/5 · ⚡ ${feedback.scoreOptimization ?? '-'}/5 · 🧹 ${feedback.scoreReadability ?? '-'}/5`;
      const bonusLine = (feedback.speedBonusPoints ?? 0) > 0
        ? `\n**Bonus rapidité:** ⚡+${feedback.speedBonusPoints}`
        : '';
      await interaction.reply({
        content: `📊 **Pourquoi cette note ?**\n\n**Défi:** ${feedback.problemTitle}\n**Moyenne:** ${feedback.scoreFinal?.toFixed(1) ?? '-'} / 5\n**Total:** ${feedback.totalPoints ?? '-'} pts${bonusLine}\n\n${details}${feedback.reviewFeedback ? `\n\n🗒️ **Retour du staff**\n${feedback.reviewFeedback}` : ''}`,
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const runId = interaction.customId.split(':')[1];
    if (!runId) return;

    const availability = await getDailyAlgoSubmissionAvailability(runId);
    if (!availability.isOpen) {
      await interaction.message.edit({
        components: [getDailyAlgoButtonRow(runId, true)],
      }).catch(() => null);

      await interaction.reply({
        content: `⛔ ${availability.reason ?? 'Ce Daily Algo est clôturé.'}`,
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`daily-algo-solution:${runId}`)
      .setTitle('Solution du Daily Algo');

    const solutionInput = new TextInputBuilder()
      .setCustomId('solution-code')
      .setLabel('Ton code')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Colle ton code ici...')
      .setRequired(true)
      .setMaxLength(1900);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(solutionInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith('daily-algo-solution:')) return;

    const runId = interaction.customId.split(':')[1];
    if (!runId) return;

    const solutionCode = interaction.fields.getTextInputValue('solution-code');

    try {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      const result = await queueDailyAlgoSubmission({
        client,
        runId,
        authorId: interaction.user.id,
        authorName: interaction.user.globalName ?? interaction.user.username,
        solution: solutionCode,
      });

      const rankLabel = formatRankLabel(result.speedRank);

      await replyOrFollowUp(interaction, {
        content: `✅ **Solution enregistrée !**\n\nTu es le **${rankLabel}** à avoir soumis ta solution.\n\n⏳ Un membre du staff va noter ta réponse. Le classement sera mis à jour automatiquement !`,
        flags: [MessageFlags.Ephemeral],
      });
    } catch (error) {
      logger.error('DailyAlgo', 'Erreur lors du traitement de la soumission de solution :', error);
      const message = publicErrorMessage(error, 'Erreur lors de la soumission');
      await replyOrFollowUp(interaction, {
        content: `❌ ${message}`,
        flags: [MessageFlags.Ephemeral],
      });
    }
  });

  logger.success('DailyAlgo', 'Gestionnaires de bouton et de modal enregistrés');
}
