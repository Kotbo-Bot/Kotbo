import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { errorContainer, infoContainer, kotboContainer, successContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import prisma from '../../utils/db.js';
import { upsertRetryingRace } from '../../utils/upsertRetry.js';
import { logger } from '../../utils/logger.js';
import { getModuleStatsSummary, getModuleActivationStats, getModuleUsageStats, getModulePerformanceStats , KOTBO_MODULES, type KotboModule } from '../../services/analytics/moduleStatsService.js';
import { separator, v2Message } from '@arcscord/components';



const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Commandes administrateur')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub
      .setName('info')
      .setDescription('Affiche les informations de configuration actuelles')
  )
  .addSubcommand(sub =>
    sub
      .setName('add-daily-algo')
      .setDescription('Ajoute un nouveau problème dans la banque Daily Algo')
      .addStringOption(option =>
        option
          .setName('titre')
          .setDescription('Titre du problème')
          .setRequired(true),
      )
      .addStringOption(option =>
        option
          .setName('question')
          .setDescription('Énoncé du Daily Algo')
          .setRequired(true),
      )
      .addStringOption(option =>
        option
          .setName('solution')
          .setDescription('Solution attendue')
          .setRequired(true),
      )
      .addStringOption(option =>
        option
          .setName('difficulte')
          .setDescription('Niveau de difficulté')
          .addChoices(
            { name: 'Facile', value: 'facile' },
            { name: 'Moyen', value: 'moyen' },
            { name: 'Difficile', value: 'difficile' },
          )
          .setRequired(true),
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('set-algo-channel')
      .setDescription('Définit le salon pour le Daily Algo')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Le salon des défis quotidiens')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('set-releases-channel')
      .setDescription('Définit le salon pour les releases GitHub')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Le salon des releases GitHub')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('stats')
      .setDescription('Affiche les statistiques globales et des modules')
      .addStringOption(option =>
        option
          .setName('type')
          .setDescription('Type de statistiques')
          .setRequired(true)
          .addChoices(
            { name: 'Global', value: 'global' },
            { name: 'Modules', value: 'modules' },
            { name: 'Activation', value: 'activation' },
            { name: 'Usage', value: 'usage' },
            { name: 'Performance', value: 'performance' },
          )
      )
      .addIntegerOption(option =>
        option
          .setName('period')
          .setDescription('Période en jours (défaut: 30)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(365)
      )
      // Filtre lu par les types `usage` et `performance`. Autocomplétion plutôt
      // que `addChoices` : Discord plafonne les choix à 25 et la liste des
      // modules Kotbo dépasse ce seuil.
      .addStringOption(option =>
        option
          .setName('module')
          .setDescription('Restreindre à un seul module (types Usage et Performance)')
          .setRequired(false)
          .setAutocomplete(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('rescan-stats')
      .setDescription("Scrapper l'historique des messages pour initialiser les statistiques")
      .addBooleanOption(option =>
        option
          .setName('forcer')
          .setDescription('Forcer le re-scrap complet (recommencer à zéro)')
          .setRequired(false)
      )
  );

function isKotboModule(value: string | null): value is KotboModule {
  return value !== null && (KOTBO_MODULES as readonly string[]).includes(value);
}

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'module') {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.toLowerCase();
  const matches = KOTBO_MODULES
    .filter(moduleName => moduleName.toLowerCase().includes(query))
    .slice(0, 25)
    .map(moduleName => ({ name: moduleName, value: moduleName }));

  await interaction.respond(matches);
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand() as string;
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer('Erreur', 'Cette commande doit être utilisée dans un serveur.'),
    ));
    return;
  }

  await upsertRetryingRace(() => prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } }));

  if (subcommand === 'info') {
    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        dailyAlgoChannelId: true,
        dailyAlgoValidationChannelId: true,
        dailyAlgoEnabled: true,
        dailyAlgoTime: true,
        githubReleasesChannelId: true,
        githubReleasesEnabled: true,
        githubRepositories: true,
      },
    });

    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      kotboContainer({
        color: 'info',
        title: `${E.settings} Configuration actuelle`,
        fields: [
          'Paramètres persistés en base de données',
          separator({ divider: true, spacing: 'small' }),
          `**Salon Daily Algo**\n${guild?.dailyAlgoChannelId ? `<#${guild.dailyAlgoChannelId}>` : `${E.error} Non configuré`}`,
          `**Salon validation Daily Algo**\n${guild?.dailyAlgoValidationChannelId ? `<#${guild.dailyAlgoValidationChannelId}>` : `${E.error} Non configuré`}`,
          `**Salon releases GitHub**\n${guild?.githubReleasesChannelId ? `<#${guild.githubReleasesChannelId}>` : `${E.error} Non configuré`}`,
          `**Daily Algo**\n${guild?.dailyAlgoEnabled ? `${E.success} Activé (${guild.dailyAlgoTime} UTC)` : `${E.error} Désactivé`}`,
          `**Releases GitHub**\n${guild?.githubReleasesEnabled ? `${E.success} Activé (${guild.githubRepositories.length} repos)` : `${E.error} Désactivé`}`,
        ],
      }),
    ));
  } else if (subcommand === 'add-daily-algo') {
    const titre = interaction.options.getString('titre', true).trim();
    const question = interaction.options.getString('question', true).trim();
    const solution = interaction.options.getString('solution', true).trim();
    const difficulte = interaction.options.getString('difficulte', true).trim();

    const existing = await prisma.dailyAlgoProblem.findFirst({
      where: {
        title: titre,
        language: 'fr',
      },
    });

    if (existing) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        infoContainer('Daily Algo déjà présent', `Le problème **${titre}** existe déjà dans la banque française.`),
      ));
      return;
    }

    await prisma.dailyAlgoProblem.create({
      data: {
        title: titre,
        description: question,
        solution,
        difficulty: difficulte,
        language: 'fr',
        functionName: 'solve',
        functionArgs: [{ name: 'input', type: 'unknown' }],
        unitTests: [{ name: 'placeholder', args: [null], expected: null }],
        allowedLanguages: ['javascript', 'typescript', 'python'],
      },
    });

    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer('Daily Algo ajouté', `Le problème **${titre}** a été ajouté à la banque et pourra être sélectionné une seule fois.`),
    ));
  } else if (subcommand === 'set-algo-channel') {
    const channel = interaction.options.getChannel('channel', true);

    if (channel.type !== 0 && channel.type !== 5) { // 5 = GUILD_NEWS (announce channel)
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer('Erreur', 'Le salon doit être un salon texte'),
      ));
      return;
    }

    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer('Salon Daily Algo configuré', `Le Daily Algo sera publié dans ${channel.toString()}`),
    ));

    await prisma.guild.update({
      where: { id: guildId },
      data: { dailyAlgoChannelId: channel.id },
    });
  } else if (subcommand === 'set-releases-channel') {
    const channel = interaction.options.getChannel('channel', true);

    if (channel.type !== 0 && channel.type !== 5) { // 5 = GUILD_NEWS (announce channel)
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer('Erreur', 'Le salon doit être un salon texte'),
      ));
      return;
    }

    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer('Salon releases GitHub configuré', `Les releases GitHub seront publiées dans ${channel.toString()}`),
    ));

    await prisma.guild.update({
      where: { id: guildId },
      data: { githubReleasesChannelId: channel.id },
    });

  } else if (subcommand === 'stats') {
    const type = interaction.options.getString('type', true);
    const period = interaction.options.getInteger('period') || 30;
    // L'autocomplétion n'empêche pas la saisie libre : on ne garde que les noms
    // réellement connus, sinon le filtre ne renverrait jamais rien.
    const requestedModule = interaction.options.getString('module');
    const moduleName = isKotboModule(requestedModule) ? requestedModule : undefined;

    if (requestedModule && !moduleName) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer('Module inconnu', `\`${requestedModule}\` ne fait pas partie des modules Kotbo.`),
      ));
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      if (type === 'global') {
        const guilds = await prisma.guild.findMany({ select: { id: true } });
        const guildCount = guilds.length;

        const totalMembers = await prisma.memberProfile.groupBy({
          by: ['guildId'],
          _count: true,
        });
        const userCount = totalMembers.reduce((acc, g) => acc + g._count, 0);

        const activeSanctions = await prisma.sanction.count({ where: { status: 'ACTIVE' } });
        const dailyAlgoSubmissions = await prisma.dailyAlgoSubmission.count();

        const uptime = Math.floor(process.uptime());
        const uptimeHours = Math.floor(uptime / 3600);
        const uptimeMinutes = Math.floor((uptime % 3600) / 60);
        const uptimeSeconds = uptime % 60;

        const memoryUsage = process.memoryUsage();
        const memoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} Statistiques Globales Kotbo`,
            fields: [
              `Période: ${period} jours`,
              separator({ divider: true, spacing: 'small' }),
              `**Serveurs**\n${guildCount}`,
              `**Utilisateurs**\n${userCount}`,
              `**Sanctions actives**\n${activeSanctions}`,
              `**Submissions Daily Algo**\n${dailyAlgoSubmissions}`,
              `**Uptime**\n${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`,
              `**Mémoire**\n${memoryMB} MB`,
            ],
          }),
        ));
      } else if (type === 'modules') {
        const summary = await getModuleStatsSummary({ guildId, periodDays: period });

        const lines = summary.topModules.slice(0, 10).map((m, i) =>
          `**${i + 1}. ${m.moduleName}**\nUtilisation: ${m.totalUsage} | Temps moyen: ${Math.round(m.avgExecutionTimeMs)}ms | Erreurs: ${Math.round(m.errorRate)}%`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} Statistiques des Modules`,
            fields: [
              `Période: ${period} jours | Top 10 modules`,
              separator({ divider: true, spacing: 'small' }),
              ...lines,
            ],
          }),
        ));
      } else if (type === 'activation') {
        const activation = await getModuleActivationStats(guildId);
        const enabledCount = activation.filter(a => a.enabled).length;
        const disabledCount = activation.length - enabledCount;

        const lines = activation.slice(0, 15).map(a =>
          `**${a.moduleName}**\n${a.enabled ? `${E.success} Activé` : `${E.error} Désactivé`}`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} Activation des Modules`,
            fields: [
              `${E.success} Activés: ${enabledCount} | ${E.error} Désactivés: ${disabledCount}`,
              separator({ divider: true, spacing: 'small' }),
              ...lines,
            ],
          }),
        ));
      } else if (type === 'usage') {
        const usage = await getModuleUsageStats({ guildId, moduleName, periodDays: period });

        const groupedByModule = new Map<string, { totalUsage: number; commandExecutions: number; apiCalls: number; eventTriggers: number }>();
        for (const u of usage) {
          const existing = groupedByModule.get(u.moduleName) || { totalUsage: 0, commandExecutions: 0, apiCalls: 0, eventTriggers: 0 };
          existing.totalUsage += u.totalUsage;
          existing.commandExecutions += u.commandExecutions;
          existing.apiCalls += u.apiCalls;
          existing.eventTriggers += u.eventTriggers;
          groupedByModule.set(u.moduleName, existing);
        }

        const sorted = Array.from(groupedByModule.entries())
          .map(([moduleName, stats]) => ({ moduleName, ...stats }))
          .sort((a, b) => b.totalUsage - a.totalUsage)
          .slice(0, 15);

        const lines = sorted.map((m, i) =>
          `**${i + 1}. ${m.moduleName}**\nTotal: ${m.totalUsage} | Cmd: ${m.commandExecutions} | API: ${m.apiCalls} | Events: ${m.eventTriggers}`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} Utilisation des Modules`,
            fields: [
              `Période: ${period} jours${moduleName ? ` | Module: ${moduleName}` : ''}`,
              separator({ divider: true, spacing: 'small' }),
              ...lines,
            ],
          }),
        ));
      } else if (type === 'performance') {
        const performance = await getModulePerformanceStats({ guildId, moduleName, periodDays: period });

        const groupedByModule = new Map<string, { avgExecutionTimeMs: number; totalExecutions: number; errorCount: number; errorRate: number }>();
        for (const p of performance) {
          const existing = groupedByModule.get(p.moduleName) || { avgExecutionTimeMs: 0, totalExecutions: 0, errorCount: 0, errorRate: 0 };
          existing.avgExecutionTimeMs = (existing.avgExecutionTimeMs * existing.totalExecutions + p.avgExecutionTimeMs * p.totalExecutions) / (existing.totalExecutions + p.totalExecutions);
          existing.totalExecutions += p.totalExecutions;
          existing.errorCount += p.errorCount;
          existing.errorRate = (existing.errorCount / existing.totalExecutions) * 100;
          groupedByModule.set(p.moduleName, existing);
        }

        const sorted = Array.from(groupedByModule.entries())
          .map(([moduleName, stats]) => ({ moduleName, ...stats }))
          .sort((a, b) => b.totalExecutions - a.totalExecutions)
          .slice(0, 15);

        const lines = sorted.map((m, i) =>
          `**${i + 1}. ${m.moduleName}**\nExécutions: ${m.totalExecutions} | Temps moyen: ${Math.round(m.avgExecutionTimeMs)}ms | Erreurs: ${Math.round(m.errorRate)}%`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} Performance des Modules`,
            fields: [
              `Période: ${period} jours${moduleName ? ` | Module: ${moduleName}` : ''}`,
              separator({ divider: true, spacing: 'small' }),
              ...lines,
            ],
          }),
        ));
      }
    } catch (err) {
      logger.error('AdminCommand', 'Error fetching stats:', err);
      await interaction.editReply(v2Message(
        errorContainer('Erreur', 'Impossible de récupérer les statistiques.'),
      ));
    }
  } else if (subcommand === 'rescan-stats') {
    const force = interaction.options.getBoolean('forcer') ?? false;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const { startHistoricalScraping } = await import('../../services/analytics/messageScraperService.js');
      await startHistoricalScraping(interaction.client, guildId, force);

      await interaction.editReply(v2Message(
        successContainer(
          'Scan des Statistiques Lancé',
          `Le scraping historique des messages a été démarré avec succès en arrière-plan.\n\n${E.arrow} **Mode forcé :** ${force ? 'Oui (recommencer à zéro)' : 'Non'}\n${E.arrow} Vous pouvez suivre l'avancement dans les logs ou via le statut en base de données.`,
        ),
      ));
    } catch (err) {
      console.error('Error starting historical scraping from admin:', err);
      await interaction.editReply(v2Message(
        errorContainer('Erreur', `Impossible de démarrer le scraping : ${err instanceof Error ? err.message : String(err)}`),
      ));
    }
  }
}

export const adminCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
