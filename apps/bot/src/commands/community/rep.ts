import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { errorContainer, kotboContainer } from '../../utils/embeds.js';
import { E, rankEmoji } from '../../utils/emojis.js';
import { getReputation, getReputationLeaderboard } from '../../services/community/reputationService.js';
import { recordRep } from '../../services/community/reputationActions.js';
import { repRefusalText } from '../../services/community/reputationMessages.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { separator, v2Message } from '@arcscord/components'
import { getEffectiveLocale, getCommandMetadata, type BotLocale } from '../../utils/i18n.js';
import { REPUTATION_PERIODS, isReputationPeriod, type ReputationPeriod } from '@kotbo/shared';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b2_rep');
const giveMeta = getCommandMetadata('b2_rep_give');
const checkMeta = getCommandMetadata('b2_rep_check');
const topMeta = getCommandMetadata('b2_rep_top');

const PERIOD_LABEL: Record<ReputationPeriod, (locale: BotLocale) => string> = {
  week: (locale) => m.b2_rep_period_week({}, { locale }),
  month: (locale) => m.b2_rep_period_month({}, { locale }),
  all: (locale) => m.b2_rep_period_all({}, { locale }),
};

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub.setName(giveMeta.name)
      .setNameLocalizations(giveMeta.nameLocalizations)
      .setDescription(giveMeta.description)
      .setDescriptionLocalizations(giveMeta.descriptionLocalizations)
      .addUserOption((opt) => opt
        .setName('membre')
        .setDescription(m.b2_rep_give_opt_membre({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.b2_rep_give_opt_membre({}, { locale: 'fr' }) })
        .setRequired(true))
      .addStringOption((opt) => opt
        .setName('raison')
        .setDescription(m.b2_rep_give_opt_raison({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.b2_rep_give_opt_raison({}, { locale: 'fr' }) })))
  .addSubcommand((sub) =>
    sub.setName(checkMeta.name)
      .setNameLocalizations(checkMeta.nameLocalizations)
      .setDescription(checkMeta.description)
      .setDescriptionLocalizations(checkMeta.descriptionLocalizations)
      .addUserOption((opt) => opt
        .setName('membre')
        .setDescription(m.b2_rep_check_opt_membre({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.b2_rep_check_opt_membre({}, { locale: 'fr' }) })))
  .addSubcommand((sub) =>
    sub.setName(topMeta.name)
      .setNameLocalizations(topMeta.nameLocalizations)
      .setDescription(topMeta.description)
      .setDescriptionLocalizations(topMeta.descriptionLocalizations)
      .addStringOption((opt) => opt
        .setName('periode')
        .setDescription(m.b2_rep_top_opt_periode({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.b2_rep_top_opt_periode({}, { locale: 'fr' }) })
        .addChoices(...REPUTATION_PERIODS.map((period) => ({
          name: PERIOD_LABEL[period]('en'),
          name_localizations: { fr: PERIOD_LABEL[period]('fr') },
          value: period,
        })))));

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;
  const locale = await getEffectiveLocale(interaction);

  if (subcommand === 'give') {
    const target = interaction.options.getUser('membre', true);
    const reason = interaction.options.getString('raison') ?? undefined;

    const result = await recordRep(interaction.client, {
      guildId,
      giverId: interaction.user.id,
      receiverId: target.id,
      reason,
      receiverIsBot: target.bot,
      channelId: interaction.channelId,
    });

    if (!result.success) {
      await interaction.reply({
        components: [errorContainer(m.b2_rep_impossible({}, { locale }), await repRefusalText(guildId, result.code, locale))],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply(v2Message(
      kotboContainer({
        color: 'success',
        title: `${E.star} ${m.b2_rep_give_title({}, { locale })}`,
        fields: [
          m.b2_rep_give_field({ from: `<@${interaction.user.id}>`, to: `<@${target.id}>` }, { locale }) + (reason ? `\n${E.dot} *${reason}*` : ''),
        ],
        footerTitle: m.b2_rep_give_footer({ user: `<@${target.id}>`, total: result.newTotal }, { locale })
      })
    ));
  }

  if (subcommand === 'check') {
    const target = interaction.options.getUser('membre') ?? interaction.user;
    const profile = await getReputation(guildId, target.id);

    await interaction.reply(v2Message(
      { allowedMentions: { parse: [] } },
      kotboContainer({
        color: 'primary',
        title: `${E.star} ${m.b2_rep_reputation({}, { locale })} · <@${target.id}>`,
        titleThumbnail: { url: target.displayAvatarURL() },
        fields: [
          separator({ divider: true, spacing: 'small' }),
          [
            `${E.arrow} **${m.b2_rep_total({}, { locale })}** · **${profile.totalRep}** rep`,
            `${E.arrow} **${m.b2_rep_rank({}, { locale })}** · #${profile.rank}`,
            `${E.arrow} **${m.b2_rep_votes_left({}, { locale })}** · ${Math.max(0, profile.dailyLimit - profile.votesGivenToday)}/${profile.dailyLimit}`,
          ].join('\n'),
        ],
        footerTitle: m.b2_rep_reputation({}, { locale })
      })
    ));
  }

  if (subcommand === 'top') {
    await interaction.deferReply();
    const rawPeriod = interaction.options.getString('periode');
    const period: ReputationPeriod = isReputationPeriod(rawPeriod) ? rawPeriod : 'all';
    const lb = await getReputationLeaderboard(guildId, 10, period);
    const title = `${E.trophy} ${m.b2_rep_leaderboard_title({}, { locale })} · ${PERIOD_LABEL[period](locale)}`;

    if (lb.entries.length === 0) {
      await interaction.editReply(v2Message(
        kotboContainer({
          color: 'dark',
          title,
          fields: [
            `${E.info} ${period === 'all' ? m.b2_rep_leaderboard_empty({}, { locale }) : m.b2_rep_leaderboard_empty_period({}, { locale })}`,
          ],
          footerTitle: m.b2_rep_reputation({}, { locale })
        })
      ));
      return;
    }

    const lines = lb.entries.map((e) => {
      const medal = rankEmoji(e.rank);
      return `${medal} <@${e.userId}> - **${e.totalRep}** rep`;
    });

    await interaction.editReply(v2Message(
      { allowedMentions: { parse: [] } },
      kotboContainer({
        color: 'primary',
        title,
        fields: [
          separator({ divider: true, spacing: 'small' }),
          lines.join('\n'),
        ],
        footerTitle: m.b2_rep_leaderboard_footer({ count: lb.totalVoters }, { locale })
      })
    ));
  }
}

export const repCommand = { data, execute } satisfies SlashCommandDefinition;
