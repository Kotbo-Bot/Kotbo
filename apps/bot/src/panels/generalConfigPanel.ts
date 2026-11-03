import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type SelectMenuInteraction,
} from 'discord.js';
import { isModulePaused } from '@kotbo/contracts';
import prisma from '../utils/db.js';
import { errorEmbed } from '../utils/embeds.js';
import { acknowledgeInteraction, renderPanelTarget } from '../utils/interactionResponses.js';

type PanelInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | SelectMenuInteraction
  | ChannelSelectMenuInteraction
  | ModalSubmitInteraction;

function formatToggleState(enabled: boolean): string {
  return enabled ? '🟢 Activé' : '⚪ Désactivé';
}

function formatChannel(channelId?: string | null, fallback = 'Aucun'): string {
  return channelId ? `<#${channelId}>` : fallback;
}

function formatRole(roleId?: string | null, fallback = 'Aucun'): string {
  return roleId ? `<@&${roleId}>` : fallback;
}

function formatDigestFrequency(frequency: string): string {
  return frequency === 'WEEKLY' ? 'Hebdomadaire' : 'Quotidien';
}

export async function sendMainConfigPanel(
  interaction: PanelInteraction,
  guildId: string
): Promise<void> {
  await acknowledgeInteraction(interaction);
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    include: { feeds: { select: { enabled: true } } },
  });
  
  if (!guild) {
    await renderPanelTarget(interaction, {
      embeds: [errorEmbed('Erreur', 'Serveur non trouvé dans la base de données')],
      flags: 64,
    });
    return;
  }

  const feedCount = guild.feeds.length;
  const activeFeeds = guild.feeds.filter((feed) => feed.enabled).length;

  // Daily Algo en pause : ni son etat, ni sa section ne s'affichent.
  const dailyAlgoPaused = isModulePaused('daily_algo');

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🧭 Dashboard de configuration Kotbo')
    .setDescription("Vue d'ensemble du serveur. Ouvre une section ci-dessous pour ajuster un module précis.")
    .addFields(
      {
        name: "📰 Flux d'actualité",
        value: `RSS : ${activeFeeds}/${feedCount}\nYouTube : ${formatToggleState(guild.youtubeEnabled)}\nDigest : ${formatToggleState(guild.digestEnabled)}\nTraduction : ${formatToggleState(guild.translationEnabled)}`,
        inline: true,
      },
      {
        name: '🚨 Automatisations',
        value: `Police du code : ${formatToggleState(guild.codePoliceEnabled)}\n${dailyAlgoPaused ? '' : `Daily Algo : ${formatToggleState(guild.dailyAlgoEnabled)}\n`}Releases GitHub : ${formatToggleState(guild.githubReleasesEnabled)}\nLogs avancés : ${formatChannel(guild.logChannelId, 'Non configuré')}`,
        inline: true,
      },
      {
        name: '📌 Salons & accès',
        value: `Public : ${formatChannel(guild.publicChannelId)}\nDigest : ${formatChannel(guild.digestChannelId ?? guild.publicChannelId)}\nYouTube : ${formatChannel(guild.youtubeChannelId ?? guild.nathanChannelId)}\nLogs : ${formatChannel(guild.logChannelId, 'Non configuré')}\n\n/status : ${guild.statusCheckChannelId ? `<#${guild.statusCheckChannelId}>` : 'Aucune restriction'}`,
        inline: true,
      },
      ...(dailyAlgoPaused ? [] : [{
        name: '📚 Daily Algo',
        value: guild.dailyAlgoEnabled
          ? `${guild.dailyAlgoTime} UTC\nDéfi : ${formatChannel(guild.dailyAlgoChannelId, 'Non configuré')}\nValidation : ${formatChannel(guild.dailyAlgoValidationChannelId, 'Non configuré')}`
          : 'Désactivé',
        inline: true,
      }]),
      {
        name: '📦 Releases GitHub',
        value: guild.githubReleasesEnabled
          ? `${guild.githubRepositories.length} dépôt${guild.githubRepositories.length > 1 ? 's' : ''}\nSalon : ${formatChannel(guild.githubReleasesChannelId, 'Non configuré')}`
          : 'Désactivé',
        inline: true,
      },
      {
        name: '🛡️ Encadrement',
        value: `Rôle modérateur : ${formatRole(guild.moderatorRoleId)}\nFréquence digest : ${formatDigestFrequency(guild.digestFrequency)}`,
        inline: true,
      }
    )
    .setFooter({ text: 'Kotbo · Tableau de bord de configuration' })
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('config:feeds').setLabel('📰 Flux').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cfg:section:code-police').setLabel('🚨 Code').setStyle(ButtonStyle.Secondary),
    ...(dailyAlgoPaused
      ? []
      : [new ButtonBuilder().setCustomId('cfg:section:daily-algo').setLabel('📚 Daily Algo').setStyle(ButtonStyle.Secondary)]),
    new ButtonBuilder().setCustomId('cfg:section:github-releases').setLabel('📦 GitHub').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:section:status').setLabel('🌐 /status').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('config:channels').setLabel('📌 Salons').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:section:advanced-logs').setLabel('🧾 Logs').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('config:set_mod_role').setLabel('🛡️ Rôle mod').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('config:set_yt_channel').setLabel('📺 Salon YT').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary),
  );

  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: [row1, row2],
  });
}

export async function sendNewsConfigSectionPanel(
  interaction: PanelInteraction,
  guildId: string
): Promise<void> {
  await acknowledgeInteraction(interaction);
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    include: { feeds: true },
  });

  if (!guild) {
    await renderPanelTarget(interaction, {
      embeds: [errorEmbed('Erreur', 'Serveur non trouvé dans la base de données')],
      flags: 64,
    });
    return;
  }

  const activeFeeds = guild.feeds.filter((f) => f.enabled).length;

  const embed = new EmbedBuilder()
    .setColor(0x3a86ff)
    .setTitle("📰 Flux d'actualité - Menu de section")
    .setDescription('Choisis une fonctionnalité pour ouvrir son panneau détaillé.')
    .addFields(
      {
        name: '📡 Flux RSS',
        value: `${activeFeeds}/${guild.feeds.length} actifs`,
        inline: true,
      },
      {
        name: '▶️ YouTube',
        value: guild.youtubeEnabled ? '✅ Activé' : '❌ Désactivé',
        inline: true,
      },
      {
        name: '📅 Digest',
        value: guild.digestEnabled ? `✅ ${guild.digestTime}` : '❌ Désactivé',
        inline: true,
      },
      {
        name: '🌐 Traduction',
        value: guild.translationEnabled ? `✅ -> ${guild.defaultTranslateTo}` : '❌ Désactivée',
        inline: true,
      },
      {
        name: '🛡️ Modération News',
        value: guild.moderatorRoleId ? `<@&${guild.moderatorRoleId}>` : 'Administrateurs uniquement',
        inline: true,
      },
      {
        name: '📺 Salon YouTube',
        value: guild.youtubeChannelId ? `<#${guild.youtubeChannelId}>` : 'Par défaut',
        inline: true,
      },
    )
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('config:feeds').setLabel('📡 Flux RSS').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('config:youtube_panel').setLabel('▶️ YouTube').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('config:digest').setLabel('📅 Digest').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('config:translation').setLabel('🌐 Traduction').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('config:keywords').setLabel('🔑 Mots-clés').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('config:set_mod_role').setLabel('🛡️ Rôle Mod').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('config:set_yt_channel').setLabel('📺 Salon YT').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:back:main').setLabel('← Menu général').setStyle(ButtonStyle.Secondary),
  );

  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: [row1, row2],
  });
}

export async function sendCodePoliceConfig(
  interaction: PanelInteraction,
  guildId: string
): Promise<void> {
  await acknowledgeInteraction(interaction);
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setColor(0xff006e)
    .setTitle('🚨 Police du code')
    .setDescription('Détecte les messages qui ressemblent à du code brut et les reformate automatiquement pour les rendre lisibles.')
    .addFields(
      {
        name: 'Statut',
        value: guild.codePoliceEnabled ? '🟢 **Activée**' : '⚪ **Désactivée**',
        inline: true,
      },
      {
        name: 'Détection',
        value: 'Cherche les mots-clés de code et la syntaxe typique des langages courants.',
        inline: true,
      },
      {
        name: 'Action',
        value: "Le message est reposté dans un bloc de code puis l'original est supprimé.",
        inline: false,
      },
      {
        name: 'Bon réflexe',
        value: 'Ajoute trois backticks autour du code ou précise le langage pour une coloration syntaxique plus propre.',
        inline: false,
      }
    );

  const toggleBtn = new ButtonBuilder()
    .setCustomId('cfg:toggle:code-police')
    .setLabel(guild.codePoliceEnabled ? 'Désactiver la police' : 'Activer la police')
    .setStyle(guild.codePoliceEnabled ? ButtonStyle.Danger : ButtonStyle.Success);

  const backBtn = new ButtonBuilder()
    .setCustomId('cfg:back:main')
    .setLabel('← Tableau de bord')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(toggleBtn, backBtn);

  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: [row],
  });
}

export async function sendDailyAlgoConfig(
  interaction: PanelInteraction,
  guildId: string
): Promise<void> {
  await acknowledgeInteraction(interaction);
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setColor(0xffbe0b)
    .setTitle('📚 Configuration - Daily Algo')
    .setDescription('Défis algorithmiques quotidiens avec validation manuelle des réponses')
    .addFields(
      {
        name: 'Statut',
        value: guild.dailyAlgoEnabled ? '✅ **Activé**' : '❌ **Désactivé**',
        inline: false,
      },
      {
        name: 'Canal du défi',
        value: guild.dailyAlgoChannelId ? `<#${guild.dailyAlgoChannelId}>` : '❌ Non configuré',
        inline: false,
      },
      {
        name: 'Canal de validation',
        value: guild.dailyAlgoValidationChannelId ? `<#${guild.dailyAlgoValidationChannelId}>` : '❌ Non configuré',
        inline: false,
      },
      {
        name: 'Heure',
        value: `⏰ **${guild.dailyAlgoTime}** UTC`,
        inline: false,
      }
    );

  const toggleBtn = new ButtonBuilder()
    .setCustomId('cfg:toggle:daily-algo')
    .setLabel(guild.dailyAlgoEnabled ? 'Désactiver' : 'Activer')
    .setStyle(guild.dailyAlgoEnabled ? ButtonStyle.Danger : ButtonStyle.Success);

  const timeBtn = new ButtonBuilder()
    .setCustomId('cfg:modal:daily-algo:time')
    .setLabel("🕐 Changer l'heure")
    .setStyle(ButtonStyle.Primary);

  const clearChannelBtn = new ButtonBuilder()
    .setCustomId('cfg:clear:daily-algo:channel')
    .setLabel('🧹 Retirer le salon du défi')
    .setStyle(ButtonStyle.Danger);

  const clearValidationBtn = new ButtonBuilder()
    .setCustomId('cfg:clear:daily-algo:validation-channel')
    .setLabel('🧹 Retirer le salon de validation')
    .setStyle(ButtonStyle.Danger);

  const backBtn = new ButtonBuilder()
    .setCustomId('cfg:back:main')
    .setLabel('← Retour')
    .setStyle(ButtonStyle.Secondary);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('cfg:select:daily-algo:channel')
    .setPlaceholder('Choisir le salon du défi Daily Algo')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);

  const validationSelect = new ChannelSelectMenuBuilder()
    .setCustomId('cfg:select:daily-algo:validation-channel')
    .setPlaceholder('Choisir le salon de validation des réponses')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(toggleBtn, timeBtn, backBtn);
  const row2 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect);
  const row3 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(validationSelect);
  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(clearChannelBtn, clearValidationBtn);

  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: [row1, row2, row3, row4],
  });
}

export async function sendGitHubReleasesConfig(
  interaction: PanelInteraction,
  guildId: string
): Promise<void> {
  await acknowledgeInteraction(interaction);
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return;

  const repoList = guild.githubRepositories.join('\n• ');

  const embed = new EmbedBuilder()
    .setColor(0x8338ec)
    .setTitle('📦 Configuration - Releases GitHub')
    .setDescription('Notifications de nouvelles releases GitHub')
    .addFields(
      {
        name: 'Statut',
        value: guild.githubReleasesEnabled ? '✅ **Activé**' : '❌ **Désactivé**',
        inline: false,
      },
      {
        name: 'Canal',
        value: guild.githubReleasesChannelId ? `<#${guild.githubReleasesChannelId}>` : '❌ Non configuré',
        inline: false,
      },
      {
        name: `Dépôts surveillés (${guild.githubRepositories.length})`,
        value: `• ${repoList}`,
        inline: false,
      }
    );

  const toggleBtn = new ButtonBuilder()
    .setCustomId('cfg:toggle:github-releases')
    .setLabel(guild.githubReleasesEnabled ? 'Désactiver' : 'Activer')
    .setStyle(guild.githubReleasesEnabled ? ButtonStyle.Danger : ButtonStyle.Success);

  const reposBtn = new ButtonBuilder()
    .setCustomId('cfg:modal:github-releases:repos')
    .setLabel('📚 Gérer les dépôts')
    .setStyle(ButtonStyle.Primary);

  const clearChannelBtn = new ButtonBuilder()
    .setCustomId('cfg:clear:github-releases:channel')
    .setLabel('🧹 Retirer le salon')
    .setStyle(ButtonStyle.Danger);

  const backBtn = new ButtonBuilder()
    .setCustomId('cfg:back:main')
    .setLabel('← Retour')
    .setStyle(ButtonStyle.Secondary);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('cfg:select:github-releases:channel')
    .setPlaceholder('Choisir le salon des releases GitHub')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(toggleBtn, reposBtn, clearChannelBtn, backBtn);
  const row2 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect);

  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: [row1, row2],
  });
}

export async function sendStatusConfig(interaction: PanelInteraction, guildId: string): Promise<void> {
  await acknowledgeInteraction(interaction);
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setColor(0x06d6a0)
    .setTitle('🌐 Configuration - Vérificateur de statut')
    .setDescription('Personnalise le comportement de la commande /status')
    .addFields(
      {
        name: 'Salon autorisé (optionnel)',
        value: guild.statusCheckChannelId ? `<#${guild.statusCheckChannelId}>` : 'Aucune restriction',
        inline: false,
      },
      {
        name: 'Comportement',
        value: guild.statusCheckChannelId
          ? 'La commande /status est limitée à ce salon.'
          : 'La commande /status est utilisable dans tous les salons.',
        inline: false,
      },
    );

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('cfg:clear:status:channel').setLabel('🧹 Retirer la restriction').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('cfg:back:main').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('cfg:select:status:channel')
      .setPlaceholder('Choisir le salon autorisé pour /status')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1),
  );

  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: [row1, row2],
  });
}

export async function sendAdvancedLogsConfig(interaction: PanelInteraction, guildId: string): Promise<void> {
  await acknowledgeInteraction(interaction);
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return;

  const isEnabled = !!guild.logChannelId;

  const embed = new EmbedBuilder()
    .setColor(0x1d3557)
    .setTitle('🧾 Configuration - Logs avancés')
    .setDescription('Journalisation détaillée des événements Discord : suppression/édition de messages, vocal, arrivées et départs.')
    .addFields(
      {
        name: 'Salon de logs',
        value: guild.logChannelId ? `<#${guild.logChannelId}>` : '❌ Non configuré',
        inline: false,
      },
      {
        name: 'Événements couverts',
        value: '• Message supprimé (auteur, salon, contenu, pièces jointes, acteur probable)\n• Message modifié (avant/après)\n• Connexion/déconnexion/changement de salon vocal avec durée\n• Arrivée/départ des membres',
        inline: false,
      },
      {
        name: 'Statut',
        value: isEnabled
          ? '🟢 Actif (les logs sont envoyés dans le salon sélectionné)'
          : '⚪ Inactif (sélectionne un salon pour activer)',
        inline: false,
      },
    );

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('cfg:clear:advanced-logs:channel')
      .setLabel('🧹 Retirer le salon de logs')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('cfg:back:main').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('cfg:select:advanced-logs:channel')
      .setPlaceholder('Choisir le salon des logs avancés')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1),
  );

  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: [row1, row2],
  });
}

export async function buildSetTimeModal(): Promise<ModalBuilder> {
  return new ModalBuilder()
    .setCustomId('cfg:modal:daily-algo:time')
    .setTitle("Configurer l'heure - Daily Algo")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('time')
          .setLabel('Heure (HH:MM UTC)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 09:00')
          .setRequired(true)
      )
    );
}

export async function buildSetReposModal(): Promise<ModalBuilder> {
  return new ModalBuilder()
    .setCustomId('cfg:modal:github-releases:repos')
    .setTitle('Configurer les dépôts GitHub')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('repos')
          .setLabel('Dépôts (un par ligne)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('facebook/react\ndocker/compose\nmicrosoft/typescript')
          .setRequired(true)
      )
    );
}
