/**
 * `/starlight` : les auteurs les plus souvent à la une, et le bilan d'un
 * membre. Les messages retirés par le staff ne comptent pas.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { separator, v2Message } from '@arcscord/components';
import { STARBOARD_PERIODS, isStarboardPeriod, type StarboardPeriod } from '@kotbo/shared';
import { kotboContainer } from '../../utils/embeds.js';
import { getCommandMetadata, getEffectiveLocale, type BotLocale } from '../../utils/i18n.js';
import { getStarboardAuthorLeaderboard, getStarboardAuthorSummary } from '../../services/features/starboardDashboard.js';
import type { SlashCommandDefinition } from '../../commands.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('starlight_cmd');
const topMeta = getCommandMetadata('starlight_cmd_top');
const profileMeta = getCommandMetadata('starlight_cmd_profile');

const PERIOD_LABEL: Record<StarboardPeriod, (locale: BotLocale) => string> = {
  week: (locale) => m.starlight_period_week({}, { locale }),
  month: (locale) => m.starlight_period_month({}, { locale }),
  all: (locale) => m.starlight_period_all({}, { locale }),
};

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) => sub
    .setName(topMeta.name)
    .setNameLocalizations(topMeta.nameLocalizations)
    .setDescription(topMeta.description)
    .setDescriptionLocalizations(topMeta.descriptionLocalizations)
    .addStringOption((opt) => opt
      .setName('periode')
      .setDescription(m.starlight_cmd_top_opt_periode({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.starlight_cmd_top_opt_periode({}, { locale: 'fr' }) })
      .addChoices(...STARBOARD_PERIODS.map((period) => ({
        name: PERIOD_LABEL[period]('en'),
        name_localizations: { fr: PERIOD_LABEL[period]('fr') },
        value: period,
      })))))
  .addSubcommand((sub) => sub
    .setName(profileMeta.name)
    .setNameLocalizations(profileMeta.nameLocalizations)
    .setDescription(profileMeta.description)
    .setDescriptionLocalizations(profileMeta.descriptionLocalizations)
    .addUserOption((opt) => opt
      .setName('membre')
      .setDescription(m.starlight_cmd_profile_opt_membre({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.starlight_cmd_profile_opt_membre({}, { locale: 'fr' }) })));

async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const locale = await getEffectiveLocale(interaction);
  const footerTitle = m.starlight_footer({}, { locale });

  if (interaction.options.getSubcommand() === 'top') {
    await interaction.deferReply();
    const raw = interaction.options.getString('periode');
    const period: StarboardPeriod = isStarboardPeriod(raw) ? raw : 'month';
    const ranking = await getStarboardAuthorLeaderboard(guildId, period);
    const title = `${m.starlight_top_title({}, { locale })} · ${PERIOD_LABEL[period](locale)}`;

    const lines = ranking.map((row, index) =>
      m.starlight_top_line({ rank: index + 1, user: `<@${row.authorId}>`, count: row.count, best: row.bestScore }, { locale }));

    await interaction.editReply(v2Message(
      { allowedMentions: { parse: [] } },
      kotboContainer({
        color: ranking.length > 0 ? 'primary' : 'dark',
        title,
        fields: ranking.length > 0
          ? [separator({ divider: true, spacing: 'small' }), lines.join('\n')]
          : [m.starlight_top_empty({}, { locale })],
        footerTitle,
      }),
    ));
    return;
  }

  const target = interaction.options.getUser('membre') ?? interaction.user;
  const summary = await getStarboardAuthorSummary(guildId, target.id);
  const fields = summary.count > 0
    ? [
      separator({ divider: true, spacing: 'small' }),
      [
        m.starlight_profile_count({ count: summary.count }, { locale }),
        m.starlight_profile_best({ score: summary.bestScore ?? 0 }, { locale }),
        ...(summary.last ? [m.starlight_profile_last({ date: `<t:${Math.floor(summary.last.at.getTime() / 1000)}:R>`, url: summary.last.url }, { locale })] : []),
      ].join('\n'),
    ]
    : [m.starlight_profile_empty({ user: `<@${target.id}>` }, { locale })];

  await interaction.reply(v2Message(
    { allowedMentions: { parse: [] } },
    kotboContainer({
      color: 'primary',
      title: m.starlight_profile_title({ user: target.displayName }, { locale }),
      titleThumbnail: { url: target.displayAvatarURL() },
      fields,
      footerTitle,
    }),
  ));
}

export const starlightCommand = { data, execute } satisfies SlashCommandDefinition;
