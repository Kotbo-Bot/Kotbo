import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { MODULE_REGISTRY } from '@kotbo/contracts';
import { errorEmbed, COLORS, baseEmbed } from '../../utils/embeds.js';
import prisma from '../../utils/db.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import { getModuleStates } from '../../services/core/moduleGate.js';
import * as m from '../../lib/paraglide/messages.js';
import botPackageJson from '../../../package.json';

const meta = getCommandMetadata('c6_info');

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}j`);
  parts.push(`${hours}h`, `${minutes}m`, `${seconds}s`);
  return parts.join(' ');
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [errorEmbed(m.c6_info_no_guild_title({}, { locale }), m.c6_info_no_guild_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const states = await getModuleStates(guildId);

  // Les modules socle sont toujours là : seuls ceux que le serveur a choisis comptent.
  const activeModules = MODULE_REGISTRY
    .filter((mod) => !mod.core && states[mod.key] !== false)
    .map((mod) => mod.name);

  const uptime = process.uptime();
  const memory = process.memoryUsage();

  const guildCreated = interaction.guild?.createdTimestamp
    ? `<t:${Math.floor(interaction.guild.createdTimestamp / 1000)}:R>`
    : m.c6_info_unknown({}, { locale });

  const embed = baseEmbed(COLORS.info, { user: interaction.user })
    .setTitle(m.c6_info_title({}, { locale }))
    .setDescription(m.c6_info_desc({}, { locale }))
    .setThumbnail(interaction.client.user?.displayAvatarURL() ?? null)
    .addFields(
      {
        name: m.c6_info_field_runtime_title({}, { locale }),
        value: m.c6_info_field_runtime_body({
          version: botPackageJson.version,
          node: process.version,
          uptime: formatUptime(uptime),
          ping: interaction.client.ws.ping,
          heapUsed: formatMb(memory.heapUsed),
          heapTotal: formatMb(memory.heapTotal),
          guildCount: interaction.client.guilds.cache.size,
          userCount: interaction.client.users.cache.size,
        }, { locale }),
        inline: true,
      },
      {
        name: m.c6_info_field_server_title({}, { locale }),
        value: m.c6_info_field_server_body({
          name: interaction.guild?.name ?? m.c6_info_unknown({}, { locale }),
          created: guildCreated,
          memberCount: interaction.guild?.memberCount ?? 0,
        }, { locale }),
        inline: true,
      },
      {
        name: m.c6_info_field_modules_title({ count: activeModules.length }, { locale }),
        value: activeModules.length
          ? truncate(activeModules.join(' • '), 1024)
          : m.c6_info_no_modules({}, { locale }),
        inline: false,
      },
    )
    .setFooter({ text: m.c6_info_footer({}, { locale }), iconURL: interaction.guild?.iconURL() ?? undefined })
    .setTimestamp();

  if (states.daily_algo) {
    const [runs, submissions] = await Promise.all([
      prisma.dailyAlgoRun.count({ where: { guildId } }),
      prisma.dailyAlgoSubmission.count({ where: { run: { guildId } } }),
    ]);
    embed.addFields({
      name: m.c6_info_field_metrics_title({}, { locale }),
      value: m.c6_info_field_metrics_body({ runs, submissions }, { locale }),
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

export const infoCommand = { data, execute } satisfies SlashCommandDefinition;
