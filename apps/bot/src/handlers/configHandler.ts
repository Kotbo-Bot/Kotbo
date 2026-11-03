import {
  type ChannelSelectMenuInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  MessageFlags,
} from 'discord.js';
import { isModulePaused } from '@kotbo/contracts';
import prisma from '../utils/db.js';
import {
  sendMainConfigPanel,
  sendNewsConfigSectionPanel,
  sendCodePoliceConfig,
  sendDailyAlgoConfig,
  sendGitHubReleasesConfig,
  sendStatusConfig,
  sendAdvancedLogsConfig,
  buildSetTimeModal,
  buildSetReposModal,
} from '../panels/generalConfigPanel.js';
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { replyOrFollowUp } from '../utils/interactionResponses.js';
import { toggleGuildBoolean } from '../utils/prismaToggles.js';
import { invalidateCodePoliceEnabledCache } from '../events/codePolice.js';

async function replyConfigError(interaction: ButtonInteraction | ModalSubmitInteraction | ChannelSelectMenuInteraction): Promise<void> {
  await replyOrFollowUp(interaction, {
    embeds: [errorEmbed('Erreur', 'Une erreur est survenue')],
    flags: [MessageFlags.Ephemeral],
  });
}

type ConfigInteraction =
  | ButtonInteraction
  | ModalSubmitInteraction
  | ChannelSelectMenuInteraction
  | StringSelectMenuInteraction;

/**
 * Le Daily Algo est en pause : un ancien panneau encore affiché sur Discord
 * garde ses boutons, qui ne doivent plus rien écrire. Renvoie `true` quand
 * l'interaction a été refusée.
 */
async function refusePausedDailyAlgo(interaction: ConfigInteraction, id: string): Promise<boolean> {
  if (!id.includes(':daily-algo') || !isModulePaused('daily_algo')) return false;
  await replyOrFollowUp(interaction, {
    embeds: [errorEmbed('Daily Algo', 'Le Daily Algo est en pause : il ne peut pas être configuré pour le moment.')],
    flags: [MessageFlags.Ephemeral],
  });
  return true;
}

export async function handleConfigSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const value = interaction.values[0]!;
  if (await refusePausedDailyAlgo(interaction, value)) return;

  switch (value) {
    case 'cfg:section:code-police':
      await sendCodePoliceConfig(interaction, guildId);
      break;
    case 'cfg:section:daily-algo':
      await sendDailyAlgoConfig(interaction, guildId);
      break;
    case 'cfg:section:github-releases':
      await sendGitHubReleasesConfig(interaction, guildId);
      break;
    case 'cfg:section:status':
      await sendStatusConfig(interaction, guildId);
      break;
    case 'cfg:section:advanced-logs':
      await sendAdvancedLogsConfig(interaction, guildId);
      break;
    case 'cfg:section:news':
      await sendNewsConfigSectionPanel(interaction, guildId);
      break;
    case 'cfg:section:main':
      await sendMainConfigPanel(interaction, guildId);
      break;
  }
}

export async function handleConfigButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const customId = interaction.customId;
  if (await refusePausedDailyAlgo(interaction, customId)) return;

  try {
    if (customId === 'cfg:back:main') {
      await sendMainConfigPanel(interaction, guildId);
    } else if (customId === 'cfg:section:news') {
      await sendNewsConfigSectionPanel(interaction, guildId);
    } else if (customId === 'cfg:section:code-police') {
      await sendCodePoliceConfig(interaction, guildId);
    } else if (customId === 'cfg:section:daily-algo') {
      await sendDailyAlgoConfig(interaction, guildId);
    } else if (customId === 'cfg:section:github-releases') {
      await sendGitHubReleasesConfig(interaction, guildId);
    } else if (customId === 'cfg:section:status') {
      await sendStatusConfig(interaction, guildId);
    } else if (customId === 'cfg:section:advanced-logs') {
      await sendAdvancedLogsConfig(interaction, guildId);
    } else if (customId === 'cfg:refresh') {
      await sendMainConfigPanel(interaction, guildId);
    } else if (customId === 'cfg:toggle:code-police') {
      await interaction.deferUpdate();
      const next = await toggleGuildBoolean(guildId, 'codePoliceEnabled');
      if (next === null) return;

      invalidateCodePoliceEnabledCache(guildId);

      await interaction.followUp({
        embeds: [
          successEmbed(
            'Police du code',
            next ? 'La Police du code est désormais activée.' : 'La Police du code est désormais désactivée.'
          ),
        ],
        flags: [MessageFlags.Ephemeral],
      });

      await sendCodePoliceConfig(interaction, guildId);
    } else if (customId === 'cfg:toggle:daily-algo') {
      await interaction.deferUpdate();
      const next = await toggleGuildBoolean(guildId, 'dailyAlgoEnabled');
      if (next === null) return;

      await interaction.followUp({
        embeds: [
          successEmbed(
            'Daily Algo',
            `✅ ${next ? 'Activé' : 'Désactivé'}`
          ),
        ],
        flags: [MessageFlags.Ephemeral],
      });

      await sendDailyAlgoConfig(interaction, guildId);
    } else if (customId === 'cfg:toggle:github-releases') {
      await interaction.deferUpdate();
      const next = await toggleGuildBoolean(guildId, 'githubReleasesEnabled');
      if (next === null) return;

      await interaction.followUp({
        embeds: [
          successEmbed(
            'Releases GitHub',
            `✅ ${next ? 'Activé' : 'Désactivé'}`
          ),
        ],
        flags: [MessageFlags.Ephemeral],
      });

      await sendGitHubReleasesConfig(interaction, guildId);
    } else if (customId === 'cfg:modal:daily-algo:time') {
      const modal = await buildSetTimeModal();
      await interaction.showModal(modal);
    } else if (customId === 'cfg:modal:github-releases:repos') {
      const modal = await buildSetReposModal();
      await interaction.showModal(modal);
    } else if (customId === 'cfg:clear:daily-algo:channel') {
      await interaction.deferUpdate();
      await prisma.guild.update({ where: { id: guildId }, data: { dailyAlgoChannelId: null } });
      await interaction.followUp({ embeds: [successEmbed('Daily Algo', 'Salon supprimé.')], flags: [MessageFlags.Ephemeral] });
      await sendDailyAlgoConfig(interaction, guildId);
    } else if (customId === 'cfg:clear:daily-algo:validation-channel') {
      await interaction.deferUpdate();
      await prisma.guild.update({ where: { id: guildId }, data: { dailyAlgoValidationChannelId: null } });
      await interaction.followUp({ embeds: [successEmbed('Daily Algo', 'Salon de validation supprimé.')], flags: [MessageFlags.Ephemeral] });
      await sendDailyAlgoConfig(interaction, guildId);
    } else if (customId === 'cfg:clear:github-releases:channel') {
      await interaction.deferUpdate();
      await prisma.guild.update({ where: { id: guildId }, data: { githubReleasesChannelId: null } });
      await interaction.followUp({ embeds: [successEmbed('Releases GitHub', 'Salon supprimé.')], flags: [MessageFlags.Ephemeral] });
      await sendGitHubReleasesConfig(interaction, guildId);
    } else if (customId === 'cfg:clear:status:channel') {
      await interaction.deferUpdate();
      await prisma.guild.update({ where: { id: guildId }, data: { statusCheckChannelId: null } });
      await interaction.followUp({ embeds: [successEmbed('Vérificateur de statut', 'Restriction supprimée.')], flags: [MessageFlags.Ephemeral] });
      await sendStatusConfig(interaction, guildId);
    } else if (customId === 'cfg:clear:advanced-logs:channel') {
      await interaction.deferUpdate();
      await prisma.guild.update({ where: { id: guildId }, data: { logChannelId: null } });
      await interaction.followUp({ embeds: [successEmbed('Logs avancés', 'Salon de logs supprimé.')], flags: [MessageFlags.Ephemeral] });
      await sendAdvancedLogsConfig(interaction, guildId);
    }
  } catch (error) {
    logger.error('ConfigHandler', 'Erreur lors du traitement du bouton de configuration :', error);
    await replyConfigError(interaction);
  }
}

export async function handleConfigModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const customId = interaction.customId;
  if (await refusePausedDailyAlgo(interaction, customId)) return;

  try {
    if (customId === 'cfg:modal:daily-algo:time') {
      await interaction.deferUpdate();
      const time = interaction.fields.getTextInputValue('time');

      // Validate time format HH:MM
      if (!/^([0-1]\d|2[0-3]):([0-5]\d)$/.test(time)) {
        await interaction.followUp({
          embeds: [errorEmbed('Format invalide', 'Utilise le format HH:MM (ex: 09:00)')],
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      await prisma.guild.update({
        where: { id: guildId },
        data: { dailyAlgoTime: time },
      });

      await interaction.followUp({
        embeds: [successEmbed('Daily Algo', `Heure configurée : ${time} UTC`)],
        flags: [MessageFlags.Ephemeral],
      });

      await sendDailyAlgoConfig(interaction, guildId);
    } else if (customId === 'cfg:modal:github-releases:repos') {
      await interaction.deferUpdate();
      const reposText = interaction.fields.getTextInputValue('repos');
      const repos = reposText
        .split('\n')
        .map(r => r.trim())
        .filter(r => r.length > 0 && r.includes('/'));

      if (repos.length === 0) {
        await interaction.followUp({
          embeds: [errorEmbed('Erreur', 'Au moins un dépôt est requis (format : owner/repo)')],
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      await prisma.guild.update({
        where: { id: guildId },
        data: { githubRepositories: repos },
      });

      await interaction.followUp({
        embeds: [successEmbed('Releases GitHub', `${repos.length} dépôts configurés`)],
        flags: [MessageFlags.Ephemeral],
      });

      await sendGitHubReleasesConfig(interaction, guildId);
    }
  } catch (error) {
    logger.error('ConfigHandler', 'Erreur lors du traitement de la modal de configuration :', error);
    await replyConfigError(interaction);
  }
}

export async function handleConfigChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const customId = interaction.customId;
  const channelId = interaction.values[0]!;
  if (await refusePausedDailyAlgo(interaction, customId)) return;

  try {
    await interaction.deferUpdate();

    if (customId === 'cfg:select:daily-algo:channel') {
      await prisma.guild.update({ where: { id: guildId }, data: { dailyAlgoChannelId: channelId } });
      await interaction.followUp({ embeds: [successEmbed('Daily Algo', `Salon configuré : <#${channelId}>`)], flags: [MessageFlags.Ephemeral] });
      await sendDailyAlgoConfig(interaction, guildId);
      return;
    }

    if (customId === 'cfg:select:daily-algo:validation-channel') {
      await prisma.guild.update({ where: { id: guildId }, data: { dailyAlgoValidationChannelId: channelId } });
      await interaction.followUp({ embeds: [successEmbed('Daily Algo', `Salon de validation configuré : <#${channelId}>`)], flags: [MessageFlags.Ephemeral] });
      await sendDailyAlgoConfig(interaction, guildId);
      return;
    }

    if (customId === 'cfg:select:github-releases:channel') {
      await prisma.guild.update({ where: { id: guildId }, data: { githubReleasesChannelId: channelId } });
      await interaction.followUp({ embeds: [successEmbed('Releases GitHub', `Salon configuré : <#${channelId}>`)], flags: [MessageFlags.Ephemeral] });
      await sendGitHubReleasesConfig(interaction, guildId);
      return;
    }

    if (customId === 'cfg:select:status:channel') {
      await prisma.guild.update({ where: { id: guildId }, data: { statusCheckChannelId: channelId } });
      await interaction.followUp({ embeds: [successEmbed('Vérificateur de statut', `Salon autorisé : <#${channelId}>`)], flags: [MessageFlags.Ephemeral] });
      await sendStatusConfig(interaction, guildId);
      return;
    }

    if (customId === 'cfg:select:advanced-logs:channel') {
      await prisma.guild.update({ where: { id: guildId }, data: { logChannelId: channelId } });
      await interaction.followUp({ embeds: [successEmbed('Logs avancés', `Salon configuré : <#${channelId}>`)], flags: [MessageFlags.Ephemeral] });
      await sendAdvancedLogsConfig(interaction, guildId);
      return;
    }
  } catch (error) {
    logger.error('ConfigHandler', 'Erreur lors du traitement de la sélection de salon :', error);
    await replyConfigError(interaction);
  }
}
