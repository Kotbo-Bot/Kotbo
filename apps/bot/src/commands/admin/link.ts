import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { COLORS, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, localized, localizedChoice, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import {
  createLinkInvite,
  acceptLinkInvite,
  createDirectGroup,
  addGroupMember,
  getGroup,
  inspectRelayPermissions,
  listGroupsForGuild,
  needsMessageMapping,
  removeGroup,
  removeGroupMember,
  updateGroupConfig,
  type LinkGroup,
  type LinkMemberMode,
} from '../../services/features/channelLinkService.js';
import { isGuildActivated } from '../../utils/activation.js';
import { isLinkGuestGuild } from '../../services/features/channelLinkGuestService.js';
import { INVITE_SOURCE, recordBotInvite } from '../../services/analytics/inviteService.js';

const MODE_KEYS: Record<LinkMemberMode, string> = {
  BOTH: 'lnk_choice_both',
  SEND_ONLY: 'lnk_choice_send_only',
  RECEIVE_ONLY: 'lnk_choice_receive_only',
};
const MODE_CHOICES = Object.entries(MODE_KEYS).map(([value, key]) => localizedChoice(key, value));

const RELAY_MODE_CHOICES = [
  localizedChoice('lnk_choice_webhook', 'WEBHOOK'),
  localizedChoice('lnk_choice_embed', 'EMBED'),
];

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

const data = localized(new SlashCommandBuilder(), 'lnk')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    localized(sub, 'lnk_invite')
      .addChannelOption((opt) =>
        localized(opt, 'lnk_opt_invite_channel').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addStringOption((opt) => localized(opt, 'lnk_opt_bridge'))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_participation_invite').addChoices(...MODE_CHOICES))
      .addIntegerOption((opt) =>
        localized(opt, 'lnk_opt_uses').setMinValue(1).setMaxValue(25))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_mode').addChoices(...RELAY_MODE_CHOICES))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_server_invite')),
  )
  .addSubcommand((sub) =>
    localized(sub, 'lnk_accept')
      .addStringOption((opt) => localized(opt, 'lnk_opt_code').setRequired(true))
      .addChannelOption((opt) =>
        localized(opt, 'lnk_opt_accept_channel').addChannelTypes(...TEXT_CHANNELS).setRequired(true)),
  )
  .addSubcommand((sub) =>
    localized(sub, 'lnk_channels')
      .addChannelOption((opt) =>
        localized(opt, 'lnk_opt_source_first').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addChannelOption((opt) =>
        localized(opt, 'lnk_opt_target_second').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_participation_source').addChoices(...MODE_CHOICES))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_mode').addChoices(...RELAY_MODE_CHOICES))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_update_topic'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_topic_link'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_threads_sync'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_polls_default')),
  )
  .addSubcommand((sub) =>
    localized(sub, 'lnk_direct')
      .addChannelOption((opt) =>
        localized(opt, 'lnk_opt_source_here').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addStringOption((opt) => localized(opt, 'lnk_opt_target_server').setRequired(true))
      .addStringOption((opt) => localized(opt, 'lnk_opt_target_channel_id').setRequired(true))
      .addStringOption((opt) => localized(opt, 'lnk_opt_bridge_name_optional'))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_participation_here').addChoices(...MODE_CHOICES))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_mode').addChoices(...RELAY_MODE_CHOICES))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_update_topic'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_topic_link'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_threads_sync'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_polls_default')),
  )
  .addSubcommand((sub) =>
    localized(sub, 'lnk_add')
      .addStringOption((opt) => localized(opt, 'lnk_opt_id').setRequired(true))
      .addStringOption((opt) => localized(opt, 'lnk_opt_server').setRequired(true))
      .addStringOption((opt) => localized(opt, 'lnk_opt_channel_id').setRequired(true))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_participation_add').addChoices(...MODE_CHOICES))
      .addStringOption((opt) =>
        localized(opt, 'lnk_opt_mode').addChoices(...RELAY_MODE_CHOICES)),
  )
  .addSubcommand((sub) =>
    localized(sub, 'lnk_leave')
      .addStringOption((opt) => localized(opt, 'lnk_opt_id').setRequired(true))
      .addChannelOption((opt) =>
        localized(opt, 'lnk_opt_leave_channel').addChannelTypes(...TEXT_CHANNELS).setRequired(true)),
  )
  .addSubcommand((sub) => localized(sub, 'lnk_list'))
  .addSubcommand((sub) => localized(sub, 'lnk_status'))
  .addSubcommand((sub) =>
    localized(sub, 'lnk_remove')
      .addStringOption((opt) => localized(opt, 'lnk_opt_remove_id').setRequired(true)),
  )
  .addSubcommand((sub) =>
    localized(sub, 'lnk_config')
      .addStringOption((opt) => localized(opt, 'lnk_opt_id').setRequired(true))
      .addStringOption((opt) => localized(opt, 'lnk_opt_name'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_text'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_images'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_embeds'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_reactions'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_edits'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_deletes'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_active'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_threads'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_polls'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_pins'))
      .addBooleanOption((opt) => localized(opt, 'lnk_opt_auto_topic')),
  );

/**
 * Sous-commandes accessibles à un serveur sans code d'activation.
 *
 * `/link` franchit la garde d'activation (voir `GATE_EXEMPT_COMMANDS` dans
 * index.ts) pour qu'un serveur invité puisse rejoindre un pont sans code, puis
 * le consulter et le quitter. Il ne gagne pas pour autant le droit d'ouvrir des
 * ponts pour son propre compte : `invite`, `channels`, `direct` et `add`
 * restent réservés aux serveurs disposant d'une licence.
 */
const SUBCOMMANDS_WITHOUT_ACTIVATION = new Set(['accept', 'list', 'remove', 'leave', 'status']);

function readMode(value: string | null, fallback: LinkMemberMode = 'BOTH'): LinkMemberMode {
  return value === 'SEND_ONLY' || value === 'RECEIVE_ONLY' || value === 'BOTH' ? value : fallback;
}

/** Le mode symétrique de celui choisi pour le salon d'origine. */
function mirrorMode(mode: LinkMemberMode): LinkMemberMode {
  if (mode === 'SEND_ONLY') return 'RECEIVE_ONLY';
  if (mode === 'RECEIVE_ONLY') return 'SEND_ONLY';
  return 'BOTH';
}

function modeIcon(mode: string) {
  if (mode === 'SEND_ONLY') return '→';
  if (mode === 'RECEIVE_ONLY') return '←';
  return '↔️';
}

const yesNo = (value: boolean) => (value ? '✅' : '❌');

function describeMembers(group: LinkGroup, interaction: ChatInputCommandInteraction, locale: BotLocale): string {
  return group.members
    .map((member) => {
      const isLocal = member.guildId === interaction.guildId;
      const guild = interaction.client.guilds.cache.get(member.guildId);
      const channelLabel = isLocal ? `<#${member.channelId}>` : `#${guild?.channels.cache.get(member.channelId)?.name ?? member.channelId}`;
      const guildLabel = isLocal ? m.lnk_this_server({}, { locale }) : `**${guild?.name ?? member.guildId}**`;
      const paused = member.enabled ? '' : m.lnk_paused({}, { locale });
      return `${modeIcon(member.mode)} ${channelLabel} - ${guildLabel}${paused}`;
    })
    .join('\n');
}

const EMBED_DESCRIPTION_LIMIT = 4096;

/**
 * Discord rejette l'embed entier au-dela de 4096 caracteres : sur un serveur qui
 * cumule les ponts, la liste doit se couper plutot que de ne rien afficher.
 */
function clampDescription(text: string, locale: BotLocale): string {
  if (text.length <= EMBED_DESCRIPTION_LIMIT) return text;
  const suffix = m.lnk_list_truncated({}, { locale });
  return `${text.slice(0, EMBED_DESCRIPTION_LIMIT - suffix.length)}${suffix}`;
}

/**
 * Les permissions qui manquent au pont, dites à l'endroit où l'administrateur
 * vient de le manipuler. Sans ce rappel, le symptôme le plus courant - un emoji
 * d'un autre serveur réduit à `:nom:` par Discord faute de droit sur le salon
 * qui reçoit - n'a aucune explication visible.
 */
function describePermissionIssues(group: LinkGroup, interaction: ChatInputCommandInteraction, locale: BotLocale): string {
  const issues = inspectRelayPermissions(interaction.client, group);
  if (issues.length === 0) return '';

  const lines = issues.map((issue) => {
    const isLocal = issue.guildId === interaction.guildId;
    const guild = interaction.client.guilds.cache.get(issue.guildId);
    const channel = isLocal
      ? `<#${issue.channelId}>`
      : `#${guild?.channels.cache.get(issue.channelId)?.name ?? issue.channelId} (${guild?.name ?? issue.guildId})`;

    if (issue.channelMissing) return m.lnk_perm_channel_missing({ channel }, { locale });

    const parts: string[] = [];
    if (issue.bot.length > 0) parts.push(m.lnk_perm_bot({ perms: issue.bot.map((p) => p.label).join(', ') }, { locale }));
    if (issue.everyone.length > 0) parts.push(m.lnk_perm_everyone({ perms: issue.everyone.map((p) => p.label).join(', ') }, { locale }));

    return m.lnk_perm_missing({ channel, parts: parts.join(' ; ') }, { locale });
  });

  return `\n\n${m.lnk_perm_title({}, { locale })}\n${lines.join('\n')}`;
}

async function replyError(interaction: ChatInputCommandInteraction, locale: BotLocale, message: string) {
  await interaction.editReply({ embeds: [errorEmbed(m.lnk_error({}, { locale }), message)] });
}

async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });
  const locale = await getEffectiveLocale(interaction);

  if (
    interaction.guildId &&
    !isGuildActivated(interaction.guildId) &&
    !SUBCOMMANDS_WITHOUT_ACTIVATION.has(sub)
  ) {
    await interaction.editReply({
      embeds: [errorEmbed(m.lnk_not_activated_title({}, { locale }), m.lnk_not_activated_desc({}, { locale }))],
    });
    return;
  }

  switch (sub) {
    case 'invite':
      return handleInvite(interaction, locale);
    case 'accept':
      return handleAccept(interaction, locale);
    case 'channels':
      return handleSameServer(interaction, locale);
    case 'direct':
      return handleDirect(interaction, locale);
    case 'add':
      return handleAddMember(interaction, locale);
    case 'leave':
      return handleRemoveMember(interaction, locale);
    case 'list':
      return handleList(interaction, locale);
    case 'status':
      return handleStatus(interaction, locale);
    case 'remove':
      return handleRemove(interaction, locale);
    case 'config':
      return handleConfig(interaction, locale);
  }
}

function relayModeLabel(relayMode: 'WEBHOOK' | 'EMBED', locale: BotLocale): string {
  return relayMode === 'WEBHOOK' ? m.lnk_mode_webhook_mirror({}, { locale }) : 'Embed';
}

async function handleInvite(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const channel = interaction.options.getChannel('channel', true);
  const groupId = interaction.options.getString('bridge');
  const memberMode = readMode(interaction.options.getString('participation'));
  const relayMode = (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED';
  const maxUses = interaction.options.getInteger('uses') ?? 1;
  const createServerInvite = interaction.options.getBoolean('server-invite') ?? false;

  if (groupId) {
    const group = await getGroup(groupId);
    if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
      await replyError(interaction, locale, m.lnk_bridge_not_found_here({}, { locale }));
      return;
    }
  }

  const invite = await createLinkInvite({
    guildId: interaction.guildId!,
    channelId: channel.id,
    createdByUserId: interaction.user.id,
    groupId,
    memberMode,
    relayMode,
    maxUses,
  });

  let serverInviteUrl = '';
  if (createServerInvite) {
    try {
      const guild = interaction.guild!;
      const targetChannel = guild.channels.cache.get(channel.id);
      if (targetChannel && 'createInvite' in targetChannel && typeof targetChannel.createInvite === 'function') {
        const discordInvite = await targetChannel.createInvite({
          maxAge: 24 * 60 * 60,
          maxUses: 5,
          reason: m.lnk_invite_reason({ channel: channel.id }, { locale }),
        });
        serverInviteUrl = discordInvite.url;
        // Le serveur distant n'est pas encore connu à ce stade de l'appairage.
        await recordBotInvite(discordInvite, INVITE_SOURCE.channelLinkPairing());
      }
    } catch {
      serverInviteUrl = '';
    }
  }

  const modeLabel = (m as any)[MODE_KEYS[memberMode]]({}, { locale }) as string;
  const description = [
    m.lnk_invite_code({ code: invite.code }, { locale }),
    m.lnk_invite_channel({ channel: `<#${channel.id}>` }, { locale }),
    groupId ? m.lnk_invite_bridge({ id: groupId }, { locale }) : m.lnk_invite_bridge_new({}, { locale }),
    m.lnk_invite_participation({ mode: modeLabel }, { locale }),
    m.lnk_mode_line({ mode: relayModeLabel(relayMode, locale) }, { locale }),
    m.lnk_invite_uses({ uses: maxUses }, { locale }),
    m.lnk_invite_expires({ date: `<t:${Math.floor(invite.expiresAt.getTime() / 1000)}:R>` }, { locale }),
    '',
    maxUses > 1
      ? m.lnk_invite_multi({ code: invite.code }, { locale })
      : m.lnk_invite_single({ code: invite.code }, { locale }),
  ];

  if (serverInviteUrl) {
    description.push('', m.lnk_invite_server_invite({ url: serverInviteUrl }, { locale }));
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(m.lnk_invite_title({}, { locale }))
    .setDescription(description.join('\n'))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleAccept(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const code = interaction.options.getString('code', true).trim().toUpperCase();
  const channel = interaction.options.getChannel('channel', true);

  const result = await acceptLinkInvite({
    code,
    targetGuildId: interaction.guildId!,
    targetChannelId: channel.id,
    updateTopic: true,
    includeTopicLink: true,
    client: interaction.client,
  });

  if ('error' in result) {
    await replyError(interaction, locale, result.error);
    return;
  }

  const lines = [
    m.lnk_accept_joined({ channel: `<#${channel.id}>` }, { locale }),
    '',
    describeMembers(result.group, interaction, locale),
    '',
    m.lnk_bridge_id({ id: result.group.id }, { locale }),
  ];

  // Ce serveur n'a pas de code : le préciser franchement évite qu'on croie
  // avoir activé Kotbo en entier en rejoignant un pont.
  if (!isGuildActivated(interaction.guildId!)) {
    lines.push('', m.lnk_accept_guest({}, { locale }), m.lnk_accept_guest_detail({}, { locale }));
  }

  await interaction.editReply({
    embeds: [successEmbed(
      m.lnk_accept_title({}, { locale }),
      lines.join('\n') + describePermissionIssues(result.group, interaction, locale),
    )],
  });
}

async function handleSameServer(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const sourceChannel = interaction.options.getChannel('source-channel', true);
  const targetChannel = interaction.options.getChannel('target-channel', true);
  const ownerMode = readMode(interaction.options.getString('participation'));
  const relayMode = (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED';
  const updateTopic = interaction.options.getBoolean('update-topic') ?? true;
  const includeTopicLink = interaction.options.getBoolean('topic-link') ?? true;

  if (sourceChannel.id === targetChannel.id) {
    await replyError(interaction, locale, m.lnk_same_channel({}, { locale }));
    return;
  }

  const result = await createDirectGroup({
    ownerGuildId: interaction.guildId!,
    ownerChannelId: sourceChannel.id,
    targets: [{ guildId: interaction.guildId!, channelId: targetChannel.id, mode: mirrorMode(ownerMode) }],
    createdByUserId: interaction.user.id,
    ownerMode,
    relayMode,
    relayThreads: interaction.options.getBoolean('threads') ?? false,
    relayPolls: interaction.options.getBoolean('polls') ?? false,
    updateTopic,
    includeTopicLink,
    client: interaction.client,
  });

  if ('error' in result) {
    await replyError(interaction, locale, result.error);
    return;
  }

  const topicInfo = updateTopic ? m.lnk_topic_updated({}, { locale }) : '';
  const embed = successEmbed(
    m.lnk_linked_title({}, { locale }),
    `${describeMembers(result, interaction, locale)}\n` +
    m.lnk_mode_line({ mode: relayModeLabel(relayMode, locale) }, { locale }) +
    topicInfo +
    `\n${m.lnk_id_line({ id: result.id }, { locale })}` +
    describePermissionIssues(result, interaction, locale),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleDirect(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const sourceChannel = interaction.options.getChannel('source-channel', true);
  const targetGuildId = interaction.options.getString('target-server', true);
  const targetChannelId = interaction.options.getString('target-channel', true);
  const ownerMode = readMode(interaction.options.getString('participation'));
  const relayMode = (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED';

  const targetGuild = interaction.client.guilds.cache.get(targetGuildId);
  if (!targetGuild) {
    await replyError(interaction, locale, m.lnk_bot_not_in_target({}, { locale }));
    return;
  }

  const targetChannel = targetGuild.channels.cache.get(targetChannelId);
  if (!targetChannel || !targetChannel.isTextBased()) {
    await replyError(interaction, locale, m.lnk_target_not_text({}, { locale }));
    return;
  }

  const result = await createDirectGroup({
    ownerGuildId: interaction.guildId!,
    ownerChannelId: sourceChannel.id,
    targets: [{ guildId: targetGuildId, channelId: targetChannelId, mode: mirrorMode(ownerMode) }],
    createdByUserId: interaction.user.id,
    name: interaction.options.getString('name'),
    ownerMode,
    relayMode,
    relayThreads: interaction.options.getBoolean('threads') ?? false,
    relayPolls: interaction.options.getBoolean('polls') ?? false,
    updateTopic: interaction.options.getBoolean('update-topic') ?? true,
    includeTopicLink: interaction.options.getBoolean('topic-link') ?? true,
    client: interaction.client,
  });

  if ('error' in result) {
    await replyError(interaction, locale, result.error);
    return;
  }

  const embed = successEmbed(
    m.lnk_direct_title({}, { locale }),
    `${describeMembers(result, interaction, locale)}\n\n` +
    `${m.lnk_mode_line({ mode: relayMode === 'WEBHOOK' ? 'Webhook' : 'Embed' }, { locale })}\n` +
    `${m.lnk_id_line({ id: result.id }, { locale })}\n\n` +
    m.lnk_direct_hint({ id: result.id }, { locale }) +
    describePermissionIssues(result, interaction, locale),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleAddMember(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const groupId = interaction.options.getString('id', true);
  const memberGuildId = interaction.options.getString('server', true);
  const memberChannelId = interaction.options.getString('channel', true);

  const group = await getGroup(groupId);
  if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
    await replyError(interaction, locale, m.lnk_bridge_not_found_here({}, { locale }));
    return;
  }

  const memberGuild = interaction.client.guilds.cache.get(memberGuildId);
  const memberChannel = memberGuild?.channels.cache.get(memberChannelId);
  if (!memberGuild || !memberChannel || !memberChannel.isTextBased()) {
    await replyError(interaction, locale, m.lnk_add_not_found({}, { locale }));
    return;
  }

  const result = await addGroupMember({
    groupId,
    guildId: memberGuildId,
    channelId: memberChannelId,
    addedByUserId: interaction.user.id,
    mode: readMode(interaction.options.getString('participation')),
    relayMode: (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED',
    client: interaction.client,
  });

  if ('error' in result) {
    await replyError(interaction, locale, result.error);
    return;
  }

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.lnk_add_title({}, { locale }),
        describeMembers(result, interaction, locale) + describePermissionIssues(result, interaction, locale),
      ),
    ],
  });
}

async function handleRemoveMember(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const groupId = interaction.options.getString('id', true);
  const channel = interaction.options.getChannel('channel', true);

  const group = await getGroup(groupId);
  const member = group?.members.find(
    (mb) => mb.guildId === interaction.guildId && mb.channelId === channel.id,
  );
  if (!group || !member) {
    await replyError(interaction, locale, m.lnk_leave_not_member({}, { locale }));
    return;
  }

  const remaining = await removeGroupMember(groupId, member.id, interaction.client);
  const channelLabel = `<#${channel.id}>`;

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.lnk_leave_title({}, { locale }),
        remaining
          ? `${m.lnk_leave_remaining({ channel: channelLabel, id: groupId }, { locale })}\n\n${describeMembers(remaining, interaction, locale)}`
          : m.lnk_leave_deleted({ channel: channelLabel }, { locale }),
      ),
    ],
  });
}

async function handleList(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const groups = await listGroupsForGuild(interaction.guildId!);

  if (groups.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setDescription(m.lnk_list_empty({}, { locale }))],
    });
    return;
  }

  const blocks = groups.map((group) => {
    const statusIcon = group.enabled ? '🟢' : '🔴';
    const title = group.name ?? m.lnk_list_default_name({ count: group.members.length }, { locale });
    return `${statusIcon} **${title}** \`${group.id.slice(0, 8)}\`\n${describeMembers(group, interaction, locale)}`
      + describePermissionIssues(group, interaction, locale);
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(m.lnk_list_title({}, { locale }))
    .setDescription(clampDescription(blocks.join('\n\n'), locale))
    .setFooter({ text: m.lnk_list_footer({ count: groups.length }, { locale }) })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Rend lisible, pour un administrateur du serveur relié, ce que le bot fait
 * réellement chez lui. La question posée par les communautés attachées à leur
 * vie privée n'est pas « quelles options ai-je cochées » mais « qu'est-ce qui
 * est écrit quelque part » : c'est donc à cela que cet écran répond.
 */
async function handleStatus(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const guildId = interaction.guildId!;
  const activated = isGuildActivated(guildId);
  const groups = await listGroupsForGuild(guildId);
  const activeGroups = groups.filter((g) => g.enabled);

  if (activated) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(m.lnk_status_activated_title({}, { locale }))
      .setDescription(m.lnk_status_activated_desc({ active: activeGroups.length, total: groups.length }, { locale }))
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (!isLinkGuestGuild(guildId)) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle(m.lnk_status_idle_title({}, { locale }))
      .setDescription(m.lnk_status_idle_desc({}, { locale }))
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const storesMapping = activeGroups.some((g) => needsMessageMapping(g));
  const bridged = activeGroups.map((group) => describeMembers(group, interaction, locale)).join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(m.lnk_status_guest_title({}, { locale }))
    .setDescription(
      clampDescription(
        m.lnk_status_guest_desc({ bridged: bridged || m.lnk_status_no_active({}, { locale }) }, { locale }),
        locale,
      ),
    )
    .addFields(
      { name: m.lnk_status_does_title({}, { locale }), value: m.lnk_status_does({}, { locale }) },
      { name: m.lnk_status_doesnt_title({}, { locale }), value: m.lnk_status_doesnt({}, { locale }) },
      {
        name: m.lnk_status_stored_title({}, { locale }),
        value: storesMapping ? m.lnk_status_stored_mapping({}, { locale }) : m.lnk_status_stored_nothing({}, { locale }),
      },
      { name: m.lnk_status_stop_title({}, { locale }), value: m.lnk_status_stop({}, { locale }) },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const groupId = interaction.options.getString('id', true);

  const group = await getGroup(groupId);
  if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
    await replyError(interaction, locale, m.lnk_bridge_not_found_here({}, { locale }));
    return;
  }

  await removeGroup(groupId, interaction.client);

  await interaction.editReply({
    embeds: [successEmbed(m.lnk_removed_title({}, { locale }), m.lnk_removed_desc({ id: groupId }, { locale }))],
  });
}

async function handleConfig(interaction: ChatInputCommandInteraction, locale: BotLocale) {
  const groupId = interaction.options.getString('id', true);

  const group = await getGroup(groupId);
  if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
    await replyError(interaction, locale, m.lnk_bridge_not_found_here({}, { locale }));
    return;
  }

  const updates: Record<string, boolean | string | undefined> = {};
  const name = interaction.options.getString('name');
  const text = interaction.options.getBoolean('text');
  const images = interaction.options.getBoolean('images');
  const embeds = interaction.options.getBoolean('embeds');
  const reactions = interaction.options.getBoolean('reactions');
  const edits = interaction.options.getBoolean('edits');
  const deletes = interaction.options.getBoolean('deletes');
  const active = interaction.options.getBoolean('active');
  const threads = interaction.options.getBoolean('threads');
  const polls = interaction.options.getBoolean('polls');
  const pins = interaction.options.getBoolean('pins');
  const updateTopic = interaction.options.getBoolean('update-topic');

  if (name !== null) updates.name = name;
  if (text !== null) updates.relayText = text;
  if (images !== null) updates.relayImages = images;
  if (embeds !== null) updates.relayEmbeds = embeds;
  if (reactions !== null) updates.relayReactions = reactions;
  if (edits !== null) updates.relayEdits = edits;
  if (deletes !== null) updates.relayDeletes = deletes;
  if (active !== null) updates.enabled = active;
  if (threads !== null) updates.relayThreads = threads;
  if (polls !== null) updates.relayPolls = polls;
  if (pins !== null) updates.relayPins = pins;
  if (updateTopic !== null) updates.updateTopic = updateTopic;

  if (Object.keys(updates).length === 0) {
    await replyError(interaction, locale, m.lnk_config_nothing({}, { locale }));
    return;
  }

  const updated = await updateGroupConfig(groupId, updates as any);
  if (!updated) {
    await replyError(interaction, locale, m.lnk_bridge_not_found({}, { locale }));
    return;
  }

  const configLines = [
    m.lnk_cfg_text({ v: yesNo(updated.relayText) }, { locale }),
    m.lnk_cfg_images({ v: yesNo(updated.relayImages) }, { locale }),
    m.lnk_cfg_embeds({ v: yesNo(updated.relayEmbeds) }, { locale }),
    m.lnk_cfg_reactions({ v: yesNo(updated.relayReactions) }, { locale }),
    m.lnk_cfg_edits({ v: yesNo(updated.relayEdits) }, { locale }),
    m.lnk_cfg_deletes({ v: yesNo(updated.relayDeletes) }, { locale }),
    m.lnk_cfg_active({ v: yesNo(updated.enabled) }, { locale }),
    m.lnk_cfg_threads({ v: yesNo(updated.relayThreads) }, { locale }),
    m.lnk_cfg_polls({ v: yesNo(updated.relayPolls) }, { locale }),
    m.lnk_cfg_pins({ v: yesNo(updated.relayPins) }, { locale }),
    m.lnk_cfg_topic({ v: yesNo(updated.updateTopic) }, { locale }),
  ];

  const embed = successEmbed(
    m.lnk_config_title({}, { locale }),
    `${m.lnk_config_bridge({ id: groupId }, { locale })}\n\n${configLines.join('\n')}`,
  );

  await interaction.editReply({ embeds: [embed] });
}

export const linkCommand = { data, execute } satisfies SlashCommandDefinition;
