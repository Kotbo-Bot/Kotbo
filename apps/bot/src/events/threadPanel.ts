/**
 * Interactions des panneaux de discussion, toutes préfixées `tpanel:`.
 *
 *   open:<panel>:<bouton>   bouton du panneau → formulaire
 *   form:<panel>:<bouton>   formulaire envoyé → création du fil
 *   manage | close | resolve | claim       boutons du message de départ
 *   act                     menu « Gérer » → action ou écran suivant
 *   m:<action>              modals (renommer, épingler)
 *   s:<action> | u:<action> menus de valeurs et de membres
 *   join:<fil>              « Demander à rejoindre » un fil privé
 *   jr:<ok|no|ban>:<membre> réponse du propriétaire à une demande
 *
 * Écoute aussi les messages des fils pour retirer les bannis qui y écrivent :
 * dans un fil public, n'importe qui peut revenir.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import { THREAD_PANEL_SLOWMODE_SECONDS, type ThreadPanelAnswer } from '@kotbo/shared';
import {
  THREAD_ACTIONS,
  THREAD_ACTION_LABELS,
  THREAD_PANEL_PREFIX,
  availableThreadActions,
  buildThreadPanelModal,
  canRunThreadAction,
  checkThreadPanelOpen,
  createPanelThread,
  getPanelThread,
  getThreadBans,
  isThreadClaimable,
  loadThreadPanel,
  runThreadAction,
  threadPanelParent,
  threadStanding,
  tr,
  type ThreadAction,
  type ThreadActionContext,
  type ThreadActionResult,
} from '../services/features/threadPanelService.js';
import { getEffectiveLocale, type BotLocale } from '../utils/i18n.js';
import { logger } from '../utils/logger.js';

type PanelInteraction =
  | ButtonInteraction<'cached'>
  | ModalSubmitInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'>
  | UserSelectMenuInteraction<'cached'>;

const EPHEMERAL = { flags: [MessageFlags.Ephemeral] as const };

/** Demandes d'accès en attente, `fil:membre` : une seule à la fois par membre. */
const pendingRequests = new Set<string>();

function formatDuration(seconds: number, locale: BotLocale): string {
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} min`;
  return tr(locale, `${seconds} s`, `${seconds}s`);
}

/** Message éphémère du menu : on le remplace ; ailleurs, on répond à part. */
async function respond(interaction: PanelInteraction, result: ThreadActionResult): Promise<void> {
  const content = `${result.ok ? '✅' : '❌'} ${result.message}`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components: [], embeds: [] });
  } else if (!interaction.isModalSubmit() && interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.update({ content, components: [], embeds: [] });
  } else {
    await interaction.reply({ content, ...EPHEMERAL });
  }
}

async function threadContext(interaction: PanelInteraction, locale: BotLocale): Promise<ThreadActionContext | null> {
  const thread = interaction.channel;
  const record = thread?.isThread() ? await getPanelThread(thread.id) : null;
  if (!thread?.isThread() || !record) {
    await respond(interaction, { ok: false, message: tr(locale, 'Ce fil n’a pas été ouvert par un panneau de discussion.', 'This thread wasn’t opened by a discussion panel.') });
    return null;
  }
  return { thread, member: interaction.member, record, locale };
}

/** Action immédiate : on accuse réception d'abord, fermer un fil peut prendre un instant. */
async function runAndRespond(interaction: PanelInteraction, ctx: ThreadActionContext, action: ThreadAction, values: string[] = []): Promise<void> {
  const fromMenu = !interaction.isModalSubmit() && interaction.message.flags.has(MessageFlags.Ephemeral);
  if (fromMenu) await interaction.deferUpdate();
  else await interaction.deferReply(EPHEMERAL);
  await respond(interaction, await runThreadAction(ctx, action, values));
}

// ── Menu « Gérer » ──────────────────────────────────────────────────────────

/** Contenu du menu « Gérer », partagé avec `/fil gérer`. */
export async function buildManageMenu(ctx: ThreadActionContext) {
  const { thread, member, record, locale } = ctx;
  const standing = threadStanding(member, record, thread);
  const panel = await loadThreadPanel(record.guildId, record.panelId);
  const button = panel?.data.buttons.find((b) => b.id === record.buttonId) ?? null;
  const actions = availableThreadActions(standing, record, thread, button);
  const claimable = !standing.isOwner && (await isThreadClaimable(thread, record, button));

  const lines = [
    tr(locale, `👑 Propriétaire : <@${record.ownerId}>`, `👑 Owner: <@${record.ownerId}>`),
    record.trustedIds.length ? tr(locale, `🤝 Confiance : ${record.trustedIds.map((id) => `<@${id}>`).join(', ')}`, `🤝 Trusted: ${record.trustedIds.map((id) => `<@${id}>`).join(', ')}`) : null,
    record.bannedIds.length ? tr(locale, `🚫 Bannis : ${record.bannedIds.length}`, `🚫 Banned: ${record.bannedIds.length}`) : null,
  ].filter(Boolean);

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (actions.length > 0) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${THREAD_PANEL_PREFIX}:act`)
        .setPlaceholder(tr(locale, 'Que veux-tu faire ?', 'What do you want to do?'))
        .addOptions(actions.map((action) => {
          const [fr, en, emoji] = THREAD_ACTION_LABELS[action];
          return { label: tr(locale, fr, en), value: action, emoji };
        })),
    ));
  } else {
    lines.push(claimable
      ? tr(locale, 'Le propriétaire n’est plus là : tu peux réclamer ce fil.', 'The owner is gone: you can claim this thread.')
      : tr(locale, 'Seuls le propriétaire, ses membres de confiance et les modérateurs gèrent ce fil.', 'Only the owner, their trusted members and moderators manage this thread.'));
  }
  if (claimable) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${THREAD_PANEL_PREFIX}:claim`).setLabel(tr(locale, 'Réclamer le fil', 'Claim the thread')).setEmoji('🙋').setStyle(ButtonStyle.Primary),
    ));
  }
  return { content: lines.join('\n'), components, allowedMentions: { parse: [] as never[] } };
}

/** Écran suivant d'une action choisie dans le menu. */
async function handleActionChoice(interaction: StringSelectMenuInteraction<'cached'>, ctx: ThreadActionContext): Promise<void> {
  const action = interaction.values[0] as ThreadAction;
  if (!(THREAD_ACTIONS as readonly string[]).includes(action)) return;
  const { thread, record, locale } = ctx;
  const t = (fr: string, en: string) => tr(locale, fr, en);

  if (action === 'rename' || action === 'pin') {
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(action === 'rename' ? 100 : 200);
    if (action === 'rename') input.setValue(thread.name);
    else input.setPlaceholder('https://discord.com/channels/…');
    await interaction.showModal(new ModalBuilder()
      .setCustomId(`${THREAD_PANEL_PREFIX}:m:${action}`)
      .setTitle(t(THREAD_ACTION_LABELS[action][0], THREAD_ACTION_LABELS[action][1]))
      .addLabelComponents(new LabelBuilder()
        .setLabel(action === 'rename' ? t('Nouveau nom', 'New name') : t('Lien ou identifiant du message', 'Message link or ID'))
        .setTextInputComponent(input)));
    return;
  }

  if (action === 'slowmode') {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${THREAD_PANEL_PREFIX}:s:slowmode`)
      .addOptions(THREAD_PANEL_SLOWMODE_SECONDS.map((seconds) => ({
        label: seconds ? formatDuration(seconds, locale) : t('Désactivé', 'Off'),
        value: String(seconds),
        default: thread.rateLimitPerUser === seconds,
      })));
    await interaction.update({ content: t('Délai entre deux messages :', 'Delay between two messages:'), components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    return;
  }

  if (action === 'tags') {
    const panel = await loadThreadPanel(record.guildId, record.panelId);
    const button = panel?.data.buttons.find((b) => b.id === record.buttonId);
    const parent = thread.parent;
    const tags = parent && (parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia) && button
      ? parent.availableTags.filter((tag) => button.forumChoiceTagIds.includes(tag.id)).slice(0, 25)
      : [];
    if (tags.length === 0) {
      await respond(interaction, { ok: false, message: t('Aucun tag à choisir pour ce post.', 'No tag to pick for this post.') });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${THREAD_PANEL_PREFIX}:s:tags`)
      .setMinValues(0)
      .setMaxValues(Math.min(tags.length, 5))
      .addOptions(tags.map((tag) => ({ label: tag.name, value: tag.id, default: thread.appliedTags.includes(tag.id) })));
    await interaction.update({ content: t('Tags du post :', 'Post tags:'), components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    return;
  }

  if (action === 'unban' || action === 'untrust') {
    const ids = (action === 'unban' ? record.bannedIds : record.trustedIds).slice(0, 25);
    const options = await Promise.all(ids.map(async (id) => {
      const target = thread.guild.members.cache.get(id) ?? (await thread.guild.members.fetch(id).catch(() => null));
      return { label: (target?.displayName ?? id).slice(0, 100), value: id };
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${THREAD_PANEL_PREFIX}:s:${action}`)
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options);
    await interaction.update({ content: t('Choisis les membres :', 'Pick the members:'), components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    return;
  }

  if (action === 'add' || action === 'remove' || action === 'ban' || action === 'trust' || action === 'transfer') {
    const select = new UserSelectMenuBuilder()
      .setCustomId(`${THREAD_PANEL_PREFIX}:u:${action}`)
      .setMinValues(1)
      .setMaxValues(action === 'transfer' ? 1 : 10);
    await interaction.update({
      content: action === 'transfer' ? t('À qui confier le fil ?', 'Who should own the thread?') : t('Choisis les membres :', 'Pick the members:'),
      components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
    });
    return;
  }

  await runAndRespond(interaction, ctx, action);
}

// ── Ouverture d'un fil ──────────────────────────────────────────────────────

async function handleOpen(interaction: ButtonInteraction<'cached'>, panelId: string, buttonId: string, locale: BotLocale): Promise<void> {
  const t = (fr: string, en: string) => tr(locale, fr, en);
  const panel = await loadThreadPanel(interaction.guildId, panelId);
  const button = panel?.data.buttons.find((b) => b.id === buttonId);
  if (!panel || !button) {
    await interaction.reply({ content: t('❌ Ce panneau n’existe plus.', '❌ This panel no longer exists.'), ...EPHEMERAL });
    return;
  }
  const refusal = await checkThreadPanelOpen(interaction.member, panel, button);
  if (refusal) {
    const text = refusal.code === 'disabled'
      ? t('Ce panneau est désactivé pour le moment.', 'This panel is disabled for now.')
      : refusal.code === 'roles'
        ? t('Ce bouton est réservé à certains rôles.', 'This button is restricted to some roles.')
        : refusal.code === 'cooldown'
          ? t(`Patiente encore ${formatDuration(refusal.seconds, locale)} avant d’ouvrir un autre fil.`, `Wait ${formatDuration(refusal.seconds, locale)} before opening another thread.`)
          : t(`Tu as déjà ${refusal.limit} fil${refusal.limit > 1 ? 's' : ''} ouvert${refusal.limit > 1 ? 's' : ''} avec ce bouton : ferme-en un d’abord.`, `You already have ${refusal.limit} open thread${refusal.limit > 1 ? 's' : ''} from this button: close one first.`);
    await interaction.reply({ content: `❌ ${text}`, ...EPHEMERAL });
    return;
  }
  await interaction.showModal(buildThreadPanelModal(panel.row.id, button, threadPanelParent(interaction.guild, panel, button), locale));
}

async function handleForm(interaction: ModalSubmitInteraction<'cached'>, panelId: string, buttonId: string, locale: BotLocale): Promise<void> {
  const t = (fr: string, en: string) => tr(locale, fr, en);
  await interaction.deferReply(EPHEMERAL);
  const panel = await loadThreadPanel(interaction.guildId, panelId);
  const button = panel?.data.buttons.find((b) => b.id === buttonId);
  if (!panel || !button) {
    await interaction.editReply(t('❌ Ce panneau a changé entre-temps : réessaie.', '❌ This panel changed in the meantime: try again.'));
    return;
  }
  // Deuxième contrôle : deux formulaires envoyés coup sur coup passeraient la limite.
  if (await checkThreadPanelOpen(interaction.member, panel, button)) {
    await interaction.editReply(t('❌ Tu ne peux plus ouvrir de fil avec ce bouton pour le moment.', '❌ You can’t open a thread with this button right now.'));
    return;
  }

  const title = interaction.fields.getTextInputValue('title').trim();
  const answers: ThreadPanelAnswer[] = button.fields.map((field) => ({
    label: field.label,
    value: interaction.fields.fields.has(`f_${field.id}`) ? interaction.fields.getTextInputValue(`f_${field.id}`) : '',
  }));
  const chosenTagIds = interaction.fields.fields.has('tags') ? [...interaction.fields.getStringSelectValues('tags')] : [];

  const result = await createPanelThread({ member: interaction.member, panel, button, title, answers, chosenTagIds, locale });
  if (result.ok) {
    await interaction.editReply(t(`✅ Ton fil est prêt : ${result.thread}`, `✅ Your thread is ready: ${result.thread}`));
    return;
  }
  const reason = {
    parent_missing: t('le salon prévu pour les fils n’existe plus', 'the channel set for threads no longer exists'),
    parent_invalid: t('le salon prévu ne peut pas accueillir ce type de fil', 'the channel set can’t host this kind of thread'),
    bot_permissions: t('le bot n’a pas les permissions pour créer des fils dans ce salon', 'the bot lacks permission to create threads in this channel'),
    failed: t('Discord a refusé la création', 'Discord refused to create it'),
  }[result.reason];
  await interaction.editReply(t(`❌ Impossible d’ouvrir le fil : ${reason}. Préviens un admin.`, `❌ Couldn’t open the thread: ${reason}. Let an admin know.`));
}

// ── Demandes d'accès aux fils privés ────────────────────────────────────────

async function handleJoinRequest(interaction: ButtonInteraction<'cached'>, threadId: string, locale: BotLocale): Promise<void> {
  const t = (fr: string, en: string) => tr(locale, fr, en);
  await interaction.deferReply(EPHEMERAL);
  const record = await getPanelThread(threadId);
  const thread = record ? await interaction.client.channels.fetch(threadId).catch(() => null) : null;
  if (!record || record.closedAt || !thread?.isThread()) {
    await interaction.editReply(t('❌ Ce fil est fermé.', '❌ This thread is closed.'));
    return;
  }
  if (record.bannedIds.includes(interaction.user.id)) {
    await interaction.editReply(t('❌ Tu ne peux pas rejoindre ce fil.', '❌ You can’t join this thread.'));
    return;
  }
  if (await thread.members.fetch({ member: interaction.user.id }).catch(() => null)) {
    await interaction.editReply(t(`Tu es déjà dans ce fil : ${thread}`, `You’re already in this thread: ${thread}`));
    return;
  }
  const key = `${threadId}:${interaction.user.id}`;
  if (pendingRequests.has(key)) {
    await interaction.editReply(t('Ta demande attend déjà une réponse.', 'Your request is already waiting for an answer.'));
    return;
  }

  // Pas de mention du demandeur : dans un fil privé, elle l'y ferait entrer.
  const who = `**${interaction.member.displayName}** (${interaction.user.tag})`;
  const sent = await thread.send({
    content: tr(locale, `<@${record.ownerId}> : ${who} demande à rejoindre le fil.`, `<@${record.ownerId}>: ${who} asks to join the thread.`),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${THREAD_PANEL_PREFIX}:jr:ok:${interaction.user.id}`).setLabel(t('Accepter', 'Accept')).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${THREAD_PANEL_PREFIX}:jr:no:${interaction.user.id}`).setLabel(t('Refuser', 'Decline')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${THREAD_PANEL_PREFIX}:jr:ban:${interaction.user.id}`).setLabel(t('Bannir', 'Ban')).setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { users: [record.ownerId] },
  }).catch(() => null);
  if (!sent) {
    await interaction.editReply(t('❌ Impossible de transmettre ta demande.', '❌ Couldn’t pass on your request.'));
    return;
  }
  pendingRequests.add(key);
  await interaction.editReply(t(`✅ Demande envoyée à <@${record.ownerId}>.`, `✅ Request sent to <@${record.ownerId}>.`));
}

async function handleJoinDecision(interaction: ButtonInteraction<'cached'>, decision: string, userId: string, ctx: ThreadActionContext): Promise<void> {
  const { thread, record, locale } = ctx;
  const t = (fr: string, en: string) => tr(locale, fr, en);
  if (!canRunThreadAction(threadStanding(interaction.member, record, thread), 'add')) {
    await interaction.reply({ content: t('❌ Seuls le propriétaire et ses membres de confiance répondent aux demandes.', '❌ Only the owner and their trusted members answer requests.'), ...EPHEMERAL });
    return;
  }
  await interaction.deferUpdate();
  pendingRequests.delete(`${thread.id}:${userId}`);

  let outcome: string;
  if (decision === 'ok') {
    const result = await runThreadAction(ctx, 'add', [userId]);
    outcome = result.ok && !record.bannedIds.includes(userId)
      ? t(`✅ <@${userId}> a rejoint le fil (accepté par ${interaction.member}).`, `✅ <@${userId}> joined the thread (accepted by ${interaction.member}).`)
      : `❌ ${result.message}`;
  } else if (decision === 'ban') {
    const result = await runThreadAction(ctx, 'ban', [userId]);
    outcome = result.ok ? t(`🚫 Demande refusée et membre banni du fil par ${interaction.member}.`, `🚫 Request declined and member banned by ${interaction.member}.`) : `❌ ${result.message}`;
  } else {
    outcome = t(`Demande refusée par ${interaction.member}.`, `Request declined by ${interaction.member}.`);
  }
  await interaction.editReply({ content: outcome, components: [], allowedMentions: { parse: [] } });
}

// ── Routage ─────────────────────────────────────────────────────────────────

async function route(interaction: PanelInteraction, locale: BotLocale): Promise<void> {
  const [, kind = '', a = '', b = ''] = interaction.customId.split(':');

  if (kind === 'open' && interaction.isButton()) return handleOpen(interaction, a, b, locale);
  if (kind === 'form' && interaction.isModalSubmit()) return handleForm(interaction, a, b, locale);
  if (kind === 'join' && interaction.isButton()) return handleJoinRequest(interaction, a, locale);

  const ctx = await threadContext(interaction, locale);
  if (!ctx) return;

  if (kind === 'manage' && interaction.isButton()) {
    await interaction.reply({ ...(await buildManageMenu(ctx)), ...EPHEMERAL });
    return;
  }
  if (kind === 'close' && interaction.isButton()) return runAndRespond(interaction, ctx, 'close');
  if (kind === 'resolve' && interaction.isButton()) return runAndRespond(interaction, ctx, 'resolve');
  if (kind === 'claim' && interaction.isButton()) return runAndRespond(interaction, ctx, 'claim');
  if (kind === 'jr' && interaction.isButton()) return handleJoinDecision(interaction, a, b, ctx);
  if (kind === 'act' && interaction.isStringSelectMenu()) return handleActionChoice(interaction, ctx);
  if (kind === 'm' && interaction.isModalSubmit() && (a === 'rename' || a === 'pin')) {
    return runAndRespond(interaction, ctx, a, [interaction.fields.getTextInputValue('value')]);
  }
  if (kind === 's' && interaction.isStringSelectMenu() && (a === 'slowmode' || a === 'tags' || a === 'unban' || a === 'untrust')) {
    return runAndRespond(interaction, ctx, a, [...interaction.values]);
  }
  if (kind === 'u' && interaction.isUserSelectMenu() && ['add', 'remove', 'ban', 'trust', 'transfer'].includes(a)) {
    return runAndRespond(interaction, ctx, a as ThreadAction, [...interaction.values]);
  }
}

export function registerThreadPanelListener(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) return;
    if (!interaction.customId.startsWith(`${THREAD_PANEL_PREFIX}:`) || !interaction.inCachedGuild()) return;
    const locale = await getEffectiveLocale(interaction);
    try {
      await route(interaction as PanelInteraction, locale);
    } catch (err) {
      logger.error('ThreadPanel', `Interaction ${interaction.customId} en échec`, err);
      const content = tr(locale, '❌ Une erreur est survenue, réessaie dans un instant.', '❌ Something went wrong, try again in a moment.');
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [] }).catch(() => null);
      else await interaction.reply({ content, ...EPHEMERAL }).catch(() => null);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || !message.channel.isThread() || message.author.bot) return;
    const banned = (await getThreadBans(message.guildId))[message.channelId];
    if (!banned?.includes(message.author.id)) return;
    await message.delete().catch(() => null);
    await message.channel.members.remove(message.author.id).catch(() => null);
  });

  logger.info('Modules', 'Panneaux de discussion : écoute des interactions enregistrée.');
}
