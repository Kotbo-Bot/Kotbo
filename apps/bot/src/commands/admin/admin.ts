import { isModulePaused } from '@kotbo/contracts';
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
import { publicErrorMessage } from '../../utils/publicError.js';
import { getEffectiveLocale, localized, localizedChoice } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';



const data = localized(new SlashCommandBuilder(), 'adm')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => localized(sub, 'adm_info'));

// Daily Algo en pause : ses sous-commandes ne sont pas declarees, et donc
// pas deployees.
const DAILY_ALGO_PAUSED = isModulePaused('daily_algo');
if (!DAILY_ALGO_PAUSED) {
  data
    .addSubcommand(sub =>
      localized(sub, 'adm_add_algo')
        .addStringOption(option => localized(option, 'adm_opt_title').setRequired(true))
        .addStringOption(option => localized(option, 'adm_opt_question').setRequired(true))
        .addStringOption(option => localized(option, 'adm_opt_solution').setRequired(true))
        .addStringOption(option =>
          localized(option, 'adm_opt_difficulty')
            .addChoices(
              localizedChoice('adm_choice_easy', 'facile'),
              localizedChoice('adm_choice_medium', 'moyen'),
              localizedChoice('adm_choice_hard', 'difficile'),
            )
            .setRequired(true),
        )
    )
    .addSubcommand(sub =>
      localized(sub, 'adm_algo_channel')
        .addChannelOption(option => localized(option, 'adm_opt_algo_channel').setRequired(true))
    );
}

data
  .addSubcommand(sub =>
    localized(sub, 'adm_releases_channel')
      .addChannelOption(option => localized(option, 'adm_opt_releases_channel').setRequired(true))
  )
  .addSubcommand(sub =>
    localized(sub, 'adm_stats')
      .addStringOption(option =>
        localized(option, 'adm_opt_type')
          .setRequired(true)
          .addChoices(
            localizedChoice('adm_choice_global', 'global'),
            localizedChoice('adm_choice_modules', 'modules'),
            localizedChoice('adm_choice_activation', 'activation'),
            localizedChoice('adm_choice_usage', 'usage'),
            localizedChoice('adm_choice_performance', 'performance'),
          )
      )
      .addIntegerOption(option =>
        localized(option, 'adm_opt_period').setRequired(false).setMinValue(1).setMaxValue(365)
      )
      // Filtre lu par les types `usage` et `performance`. Autocomplétion plutôt
      // que `addChoices` : Discord plafonne les choix à 25 et la liste des
      // modules Kotbo dépasse ce seuil.
      .addStringOption(option =>
        localized(option, 'adm_opt_module').setRequired(false).setAutocomplete(true)
      )
  )
  .addSubcommand(sub =>
    localized(sub, 'adm_rescan')
      .addBooleanOption(option => localized(option, 'adm_opt_force').setRequired(false))
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
  const locale = await getEffectiveLocale(interaction);
  const t = (key: string, params: Record<string, unknown> = {}) => (m as any)[key](params, { locale }) as string;
  const errTitle = t('adm_error');
  const notSet = `${E.error} ${t('adm_not_configured')}`;
  const onOff = (on: boolean, detail = '') => (on ? `${E.success} ${t('adm_enabled')}${detail}` : `${E.error} ${t('adm_disabled')}`);

  if (!guildId) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(errTitle, t('adm_guild_only')),
    ));
    return;
  }

  if (DAILY_ALGO_PAUSED && (subcommand === 'add-daily-algo' || subcommand === 'set-algo-channel')) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer('Daily Algo', t('adm_algo_paused')),
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
        title: `${E.settings} ${t('adm_info_title')}`,
        fields: [
          t('adm_info_subtitle'),
          separator({ divider: true, spacing: 'small' }),
          ...(DAILY_ALGO_PAUSED ? [] : [
            `**${t('adm_info_algo_channel')}**\n${guild?.dailyAlgoChannelId ? `<#${guild.dailyAlgoChannelId}>` : notSet}`,
            `**${t('adm_info_algo_validation')}**\n${guild?.dailyAlgoValidationChannelId ? `<#${guild.dailyAlgoValidationChannelId}>` : notSet}`,
          ]),
          `**${t('adm_info_releases_channel')}**\n${guild?.githubReleasesChannelId ? `<#${guild.githubReleasesChannelId}>` : notSet}`,
          ...(DAILY_ALGO_PAUSED ? [] : [
            `**Daily Algo**\n${onOff(!!guild?.dailyAlgoEnabled, ` (${guild?.dailyAlgoTime} UTC)`)}`,
          ]),
          `**${t('adm_info_releases')}**\n${onOff(!!guild?.githubReleasesEnabled, ` (${guild?.githubRepositories.length} repos)`)}`,
        ],
      }),
    ));
  } else if (subcommand === 'add-daily-algo') {
    const titre = interaction.options.getString('title', true).trim();
    const question = interaction.options.getString('question', true).trim();
    const solution = interaction.options.getString('solution', true).trim();
    const difficulte = interaction.options.getString('difficulty', true).trim();

    const existing = await prisma.dailyAlgoProblem.findFirst({
      where: {
        title: titre,
        language: 'fr',
      },
    });

    if (existing) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        infoContainer(t('adm_algo_exists_title'), t('adm_algo_exists_desc', { title: titre })),
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
      successContainer(t('adm_algo_added_title'), t('adm_algo_added_desc', { title: titre })),
    ));
  } else if (subcommand === 'set-algo-channel') {
    const channel = interaction.options.getChannel('channel', true);

    if (channel.type !== 0 && channel.type !== 5) { // 5 = GUILD_NEWS (announce channel)
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(errTitle, t('adm_not_text')),
      ));
      return;
    }

    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer(t('adm_algo_channel_set_title'), t('adm_algo_channel_set_desc', { channel: channel.toString() })),
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
        errorContainer(errTitle, t('adm_not_text')),
      ));
      return;
    }

    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer(t('adm_releases_set_title'), t('adm_releases_set_desc', { channel: channel.toString() })),
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
        errorContainer(t('adm_unknown_module_title'), t('adm_unknown_module_desc', { module: requestedModule })),
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
            title: `${E.stats} ${t('adm_global_title')}`,
            fields: [
              t('adm_period', { days: period }),
              separator({ divider: true, spacing: 'small' }),
              `**${t('adm_global_servers')}**\n${guildCount}`,
              `**${t('adm_global_users')}**\n${userCount}`,
              `**${t('adm_global_sanctions')}**\n${activeSanctions}`,
              `**${t('adm_global_submissions')}**\n${dailyAlgoSubmissions}`,
              `**Uptime**\n${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`,
              `**${t('adm_global_memory')}**\n${memoryMB} MB`,
            ],
          }),
        ));
      } else if (type === 'modules') {
        const summary = await getModuleStatsSummary({ guildId, periodDays: period });

        const lines = summary.topModules.slice(0, 10).map((mod, i) =>
          `**${i + 1}. ${mod.moduleName}**\n${t('adm_modules_line', { usage: mod.totalUsage, ms: Math.round(mod.avgExecutionTimeMs), errors: Math.round(mod.errorRate) })}`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} ${t('adm_modules_title')}`,
            fields: [
              t('adm_period_top', { days: period }),
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
          `**${a.moduleName}**\n${onOff(a.enabled)}`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} ${t('adm_activation_title')}`,
            fields: [
              `${E.success} ${t('adm_activation_summary', { enabled: enabledCount })} | ${E.error} ${t('adm_activation_summary_off', { disabled: disabledCount })}`,
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

        const lines = sorted.map((mod, i) =>
          `**${i + 1}. ${mod.moduleName}**\nTotal: ${mod.totalUsage} | Cmd: ${mod.commandExecutions} | API: ${mod.apiCalls} | Events: ${mod.eventTriggers}`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} ${t('adm_usage_title')}`,
            fields: [
              `${t('adm_period', { days: period })}${moduleName ? t('adm_period_module', { module: moduleName }) : ''}`,
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

        const lines = sorted.map((mod, i) =>
          `**${i + 1}. ${mod.moduleName}**\n${t('adm_performance_line', { runs: mod.totalExecutions, ms: Math.round(mod.avgExecutionTimeMs), errors: Math.round(mod.errorRate) })}`
        );

        await interaction.editReply(v2Message(
          kotboContainer({
            color: 'info',
            title: `${E.stats} ${t('adm_performance_title')}`,
            fields: [
              `${t('adm_period', { days: period })}${moduleName ? t('adm_period_module', { module: moduleName }) : ''}`,
              separator({ divider: true, spacing: 'small' }),
              ...lines,
            ],
          }),
        ));
      }
    } catch (err) {
      logger.error('AdminCommand', 'Error fetching stats:', err);
      await interaction.editReply(v2Message(
        errorContainer(errTitle, t('adm_stats_failed')),
      ));
    }
  } else if (subcommand === 'rescan-stats') {
    const force = interaction.options.getBoolean('force') ?? false;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const { startHistoricalScraping } = await import('../../services/analytics/messageScraperService.js');
      await startHistoricalScraping(interaction.client, guildId, force);

      await interaction.editReply(v2Message(
        successContainer(
          t('adm_rescan_title'),
          t('adm_rescan_desc', { arrow: E.arrow, forced: force ? t('adm_rescan_forced_yes') : t('adm_rescan_forced_no') }),
        ),
      ));
    } catch (err) {
      console.error('Error starting historical scraping from admin:', err);
      await interaction.editReply(v2Message(
        errorContainer(errTitle, t('adm_rescan_failed', { error: publicErrorMessage(err) })),
      ));
    }
  }
}

export const adminCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
