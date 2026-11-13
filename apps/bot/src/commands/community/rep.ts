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
import { incrementQuestProgress } from '../../services/community/questService.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { separator, v2Message } from '@arcscord/components'
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b2_rep');
const giveMeta = getCommandMetadata('b2_rep_give');
const checkMeta = getCommandMetadata('b2_rep_check');
const topMeta = getCommandMetadata('b2_rep_top');

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
      .setDescriptionLocalizations(topMeta.descriptionLocalizations));

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
    });

    if (!result.success) {
      await interaction.reply({
        components: [errorContainer(m.b2_rep_impossible({}, { locale }), await repRefusalText(guildId, result.code, locale))],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    incrementQuestProgress(interaction.client, guildId, interaction.user.id, 'GIVE_REP', 1, interaction.channelId).catch(() => { });

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
    const lb = await getReputationLeaderboard(guildId, 10);

    if (lb.entries.length === 0) {
      await interaction.editReply(v2Message(
        kotboContainer({
          color: 'dark',
          title: `${E.trophy} ${m.b2_rep_leaderboard_title({}, { locale })}`,
          fields: [
            `${E.info} ${m.b2_rep_leaderboard_empty({}, { locale })}`,
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
        title: `${E.trophy} ${m.b2_rep_leaderboard_title({}, { locale })}`,
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
