import { Client, MessageFlags, PermissionFlagsBits, ThreadAutoArchiveDuration, type ButtonInteraction, type Guild, type Message } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import type { Suggestion } from '@prisma/client';
import {
  SUGGESTION_TITLE_MAX,
  crossedSuggestionThreshold,
  matchSuggestionCategory,
  suggestionRewardMove,
  isSuggestionStatus,
  isSuggestionVotingOpen,
  suggestionSubmitBlocker,
  suggestionThreadName,
  type SuggestionRefusalCode,
  type SuggestionStatus,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { publishGuildSignal } from '../site/siteLive.js';
import { logger } from '../../utils/logger.js';
import { UserFacingError } from '../../utils/userFacingError.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { getEffectiveLocale, resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { buildSuggestionMessage, buildSuggestionNotice, isSuggestionMessageFor } from './suggestionMessage.js';
import { suggestionMessageLabels, suggestionNoticeLabels, suggestionRefusalMessage } from './suggestionMessageLabels.js';
import { getSuggestionSettings, SUGGESTIONS_REALTIME_REASON, type SuggestionSettings } from './suggestionSettings.js';
import { grantMemberGains, reclaimMemberGains } from '../progression/memberRewards.js';

const GAINS_CONTEXT = { scope: 'Suggestions', reason: 'de suggestion acceptée' };

/** Membre que les réglages du serveur n'autorisent pas à proposer maintenant. */
export class SuggestionRefusedError extends UserFacingError {
  constructor(readonly code: SuggestionRefusalCode, message: string) {
    super(message);
  }
}

type SuggestionFeatureConfig = {
  featureKey?: string;
  enabled?: boolean;
  channelId?: string | null;
};

type FetchedChannel = NonNullable<Awaited<ReturnType<Client['channels']['fetch']>>>;

type RenderableSuggestion = Pick<
  Suggestion,
  'id' | 'guildId' | 'userId' | 'username' | 'title' | 'category' | 'content' | 'status' | 'responseText' | 'upvoters' | 'downvoters' | 'channelId' | 'messageId'
>;

function isSuggestionFeatureConfig(value: unknown): value is SuggestionFeatureConfig {
  return typeof value === 'object'
    && value !== null
    && (value as SuggestionFeatureConfig).featureKey === 'suggestions';
}

/** Une ancienne ligne au statut inconnu s'affiche comme en attente plutôt que de casser le message. */
function statusOf(suggestion: Pick<Suggestion, 'status'>): SuggestionStatus {
  return isSuggestionStatus(suggestion.status) ? suggestion.status : 'PENDING';
}

/** Prévient le dashboard et le site communautaire qu'une suggestion a bougé. */
function notifySuggestionsChanged(guildId: string): void {
  broadcastDashboardStateChange(guildId, SUGGESTIONS_REALTIME_REASON);
  publishGuildSignal(guildId, 'module:suggestions');
}

function suggestionMessageUrl(suggestion: Pick<Suggestion, 'guildId' | 'channelId' | 'messageId'>): string | null {
  return suggestion.channelId && suggestion.messageId
    ? `https://discord.com/channels/${suggestion.guildId}/${suggestion.channelId}/${suggestion.messageId}`
    : null;
}

async function fetchGuild(client: Client, guildId: string): Promise<Guild | null> {
  return client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
}

/** Message public d'une suggestion, dans la langue du serveur, avec la photo actuelle de l'auteur. */
async function renderSuggestion(guild: Guild, suggestion: RenderableSuggestion, voteWhileApproved: boolean) {
  const [member, locale] = await Promise.all([
    guild.members.fetch(suggestion.userId).catch(() => null),
    resolveGuildLocale(guild.id, guild.preferredLocale),
  ]);
  const status = statusOf(suggestion);
  return buildSuggestionMessage({
    id: suggestion.id,
    title: suggestion.title,
    category: suggestion.category,
    authorName: member?.displayName || suggestion.username,
    authorAvatarUrl: member?.user.displayAvatarURL({ size: 128 }) ?? null,
    content: suggestion.content,
    status,
    upvotes: suggestion.upvoters.length,
    downvotes: suggestion.downvoters.length,
    responseText: suggestion.responseText,
    votingOpen: isSuggestionVotingOpen(status, voteWhileApproved),
  }, suggestionMessageLabels(locale));
}

async function findSuggestionMessageInChannel(
  channel: FetchedChannel,
  suggestionId: string,
  messageId: string | null
): Promise<Message | null> {
  if (channel.isThread()) {
    const starterMessage = await channel.fetchStarterMessage().catch((e: unknown) => {
      logger.error('Suggestions', `Impossible de récupérer le message de départ du fil ${channel.id}:`, e);
      return null;
    });

    if (starterMessage && isSuggestionMessageFor(starterMessage, suggestionId)) {
      return starterMessage;
    }
  }

  if (!channel.isTextBased() || !('messages' in channel)) {
    return null;
  }

  if (messageId) {
    const storedMessage = await channel.messages.fetch(messageId).catch(() => null);
    if (storedMessage && isSuggestionMessageFor(storedMessage, suggestionId)) {
      return storedMessage;
    }
  }

  const recentMessages = await channel.messages.fetch({ limit: 100 }).catch((e: unknown) => {
    logger.error('Suggestions', `Impossible de rechercher le message de la suggestion ${suggestionId} dans ${channel.id}:`, e);
    return null;
  });

  return recentMessages?.find(message => isSuggestionMessageFor(message, suggestionId)) ?? null;
}

/** Message public retrouvé par le salon enregistré, hors de toute interaction. */
async function findStoredSuggestionMessage(client: Client, suggestion: RenderableSuggestion): Promise<Message | null> {
  if (!suggestion.channelId) return null;
  const channel = await client.channels.fetch(suggestion.channelId).catch(() => null);
  return channel ? findSuggestionMessageInChannel(channel, suggestion.id, suggestion.messageId) : null;
}

async function findSuggestionMessage(
  interaction: ButtonInteraction,
  suggestion: { id: string; channelId: string | null; messageId: string | null }
): Promise<Message | null> {
  if (isSuggestionMessageFor(interaction.message, suggestion.id)) {
    return interaction.message;
  }

  const candidateChannelIds = new Set<string>();
  if (suggestion.channelId) candidateChannelIds.add(suggestion.channelId);
  candidateChannelIds.add(interaction.channelId);

  const interactionChannel = interaction.channel;
  if (interactionChannel?.isThread()) {
    const starterMessage = await interactionChannel.fetchStarterMessage().catch(() => null);
    if (starterMessage && isSuggestionMessageFor(starterMessage, suggestion.id)) {
      return starterMessage;
    }
    if (interactionChannel.parentId) candidateChannelIds.add(interactionChannel.parentId);
  }

  for (const channelId of candidateChannelIds) {
    const channel = interaction.guild?.channels.cache.get(channelId)
      ?? await interaction.client.channels.fetch(channelId).catch(() => null);

    if (!channel) {
      logger.warn('Suggestions', `Channel ${channelId} introuvable pour la suggestion ${suggestion.id}`);
      continue;
    }

    const message = await findSuggestionMessageInChannel(channel, suggestion.id, suggestion.messageId);
    if (message) return message;

    if (channel.isThread() && channel.parentId && !candidateChannelIds.has(channel.parentId)) {
      candidateChannelIds.add(channel.parentId);
    }
  }

  return null;
}

type RefreshOutcome = 'edited' | 'failed' | 'missing';

/**
 * Redessine le message public à partir de la base : statut, compteurs, réponse
 * et état des boutons. `known` évite la recherche quand l'appelant tient déjà
 * le message.
 */
async function refreshSuggestionMessage(
  client: Client,
  suggestion: RenderableSuggestion,
  voteWhileApproved: boolean,
  known: Message | null = null,
): Promise<RefreshOutcome> {
  const message = known ?? await findStoredSuggestionMessage(client, suggestion);
  if (!message) return 'missing';
  const guild = message.guild ?? await fetchGuild(client, suggestion.guildId);
  if (!guild) return 'failed';

  try {
    await message.edit(await renderSuggestion(guild, suggestion, voteWhileApproved));
    // Épinglée au seuil de votes : la décision libère l'épingle.
    if (statusOf(suggestion) !== 'PENDING' && message.pinned) {
      await message.unpin().catch((e: unknown) => logger.warn('Suggestions', `Désépinglage de la suggestion ${suggestion.id} impossible:`, e));
    }
    if (suggestion.channelId !== message.channelId || suggestion.messageId !== message.id) {
      await prisma.suggestion.update({
        where: { id: suggestion.id },
        data: { channelId: message.channelId, messageId: message.id },
      });
    }
    return 'edited';
  } catch (e: unknown) {
    logger.error('Suggestions', `Impossible de mettre à jour le message de la suggestion ${suggestion.id}:`, e);
    return 'failed';
  }
}

/** Suggestions redessinées d'un coup : de quoi couvrir les récentes sans saturer l'API Discord. */
export const SUGGESTION_REFRESH_MAX = 100;

/**
 * Redessine les messages déjà publiés, les plus récents d'abord : après un
 * changement de réglage (`status: 'APPROVED'` quand l'ouverture des votes
 * change) ou pour passer les anciens messages au format actuel. Un à un, pour
 * rester sous la limite d'édition de Discord. Rend le nombre de messages édités.
 */
export async function refreshPublishedSuggestionMessages(
  client: Client,
  guildId: string,
  filter: { status?: SuggestionStatus } = {},
): Promise<number> {
  const [suggestions, { voteWhileApproved }] = await Promise.all([
    prisma.suggestion.findMany({
      where: { guildId, messageId: { not: null }, ...(filter.status ? { status: filter.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: SUGGESTION_REFRESH_MAX,
    }),
    getSuggestionSettings(guildId),
  ]);
  let edited = 0;
  for (const suggestion of suggestions) {
    if (await refreshSuggestionMessage(client, suggestion, voteWhileApproved) === 'edited') edited += 1;
  }
  return edited;
}

/** Nombre de messages que `refreshPublishedSuggestionMessages` reprendra. */
export async function countPublishedSuggestionMessages(guildId: string): Promise<number> {
  const count = await prisma.suggestion.count({ where: { guildId, messageId: { not: null } } });
  return Math.min(count, SUGGESTION_REFRESH_MAX);
}

/**
 * Crée et publie une nouvelle suggestion dans le salon dédié
 */
export async function createSuggestion(
  guildId: string,
  userId: string,
  username: string,
  content: string,
  client: Client,
  options: { title?: string | null; category?: string | null } = {},
) {
  const title = options.title?.trim().slice(0, SUGGESTION_TITLE_MAX) || null;
  // 1. Déterminer le salon de suggestions
  const [guildConfig, settings] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { publicChannelId: true, dashboardFeatureConfigs: true }
    }),
    getSuggestionSettings(guildId),
  ]);

  const featureConfigs = Array.isArray(guildConfig?.dashboardFeatureConfigs) ? guildConfig.dashboardFeatureConfigs : [];
  const featureConfig = featureConfigs.find(isSuggestionFeatureConfig);
  if (featureConfig && featureConfig.enabled === false) {
    throw new Error('Le système de suggestions est désactivé sur ce serveur.');
  }
  let targetChannelId = featureConfig?.channelId || guildConfig?.publicChannelId;

  const discordGuild = await fetchGuild(client, guildId);
  if (!discordGuild) throw new Error("Serveur introuvable");

  // 2. Droit de proposer, avant toute écriture
  const [member, last] = await Promise.all([
    discordGuild.members.fetch(userId).catch(() => null),
    settings.cooldownMinutes > 0
      ? prisma.suggestion.findFirst({ where: { guildId, userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
      : null,
  ]);
  const refusal = suggestionSubmitBlocker(settings, member && {
    roleIds: [...member.roles.cache.keys()],
    canManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    accountCreatedAt: member.user.createdAt,
    joinedAt: member.joinedAt,
  }, last?.createdAt ?? null);
  if (refusal) {
    const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
    throw new SuggestionRefusedError(refusal.code, suggestionRefusalMessage(refusal, settings, locale));
  }

  // Fallback si aucun canal configuré: chercher un canal textuel nommé "suggestions"
  if (!targetChannelId) {
    const fallbackChannel = discordGuild.channels.cache.find(c => c.name.toLowerCase().includes('suggest') && c.isTextBased());
    if (fallbackChannel) {
      targetChannelId = fallbackChannel.id;
    } else {
      throw new Error("Aucun salon de suggestions n'a été configuré sur le dashboard.");
    }
  }

  const channel = discordGuild.channels.cache.get(targetChannelId);
  if (!channel?.isTextBased()) {
    throw new Error("Le salon de suggestions configuré est invalide ou introuvable.");
  }

  // 3. Créer l'entrée dans la base de données
  const suggestion = await prisma.suggestion.create({
    data: {
      guildId,
      userId,
      username,
      title,
      // Une catégorie retirée entre l'ouverture de la fenêtre et l'envoi est ignorée.
      category: matchSuggestionCategory(settings.categories, options.category),
      content,
      status: 'PENDING',
      channelId: targetChannelId,
    },
  });

  broadcastDashboardStateChange(guildId, SUGGESTIONS_REALTIME_REASON);

  // 4. Publier le message sur Discord
  const payload = await renderSuggestion(discordGuild, suggestion, settings.voteWhileApproved);
  const message = await channel.send({ ...payload, allowedMentions: { parse: [] } }).catch(() => null);

  if (message) {
    // Un fil refusé (permissions, salon d'annonces, message déjà dans un fil)
    // n'empêche pas la suggestion d'exister.
    const thread = settings.createThread
      ? await message.startThread({
        name: suggestionThreadName(title, content),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      }).catch((e: unknown) => {
        logger.warn('Suggestions', `Fil de la suggestion ${suggestion.id} impossible à ouvrir:`, e);
        return null;
      })
      : null;
    await prisma.suggestion.update({
      where: { id: suggestion.id },
      data: { messageId: message.id, threadId: thread?.id ?? null },
    });
  }

  kotboEventBus.publish('suggestion:created', {
    guildId,
    suggestionId: suggestion.id,
    userId,
    username,
    title: suggestion.title,
    category: suggestion.category,
    content,
    channelId: targetChannelId,
    messageId: message?.id ?? null,
    timestamp: Date.now(),
  });

  publishGuildSignal(guildId, 'module:suggestions');
  return suggestion;
}

type SuggestionVoteResult =
  | { ok: true; suggestion: Suggestion; settings: SuggestionSettings; thresholdReached: boolean }
  | { ok: false; reason: 'not_found' | 'closed' };

/**
 * Enregistre un vote : un second clic du même côté le retire, un clic de
 * l'autre côté le déplace. La ligne est verrouillée le temps de l'écriture,
 * pour que deux votes simultanés (Discord et site) ne s'écrasent pas.
 */
export async function applySuggestionVote(guildId: string, suggestionId: string, userId: string, type: 'up' | 'down'): Promise<SuggestionVoteResult> {
  const settings = await getSuggestionSettings(guildId);
  const { voteWhileApproved } = settings;
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM suggestions WHERE id = ${suggestionId} FOR UPDATE`;
    const suggestion = await tx.suggestion.findUnique({ where: { id: suggestionId } });
    if (!suggestion || suggestion.guildId !== guildId) return { ok: false as const, reason: 'not_found' as const };
    if (!isSuggestionVotingOpen(statusOf(suggestion), voteWhileApproved)) return { ok: false as const, reason: 'closed' as const };

    let upvoters = [...suggestion.upvoters];
    let downvoters = [...suggestion.downvoters];
    const hasUpvoted = upvoters.includes(userId);
    const hasDownvoted = downvoters.includes(userId);

    if (type === 'up') {
      if (hasUpvoted) {
        upvoters = upvoters.filter(id => id !== userId);
      } else {
        upvoters.push(userId);
        downvoters = downvoters.filter(id => id !== userId); // Enlever du camp adverse
      }
    } else {
      if (hasDownvoted) {
        downvoters = downvoters.filter(id => id !== userId);
      } else {
        downvoters.push(userId);
        upvoters = upvoters.filter(id => id !== userId); // Enlever du camp adverse
      }
    }

    // Le seuil ne se franchit qu'une fois : des votes qui partent ensuite ne
    // retirent pas le signalement, et revenir au-dessus ne le relance pas.
    const thresholdReached = !suggestion.thresholdReachedAt
      && crossedSuggestionThreshold(settings.voteThreshold, suggestion.upvoters.length, upvoters.length);
    const thresholdReachedAt = thresholdReached ? new Date() : suggestion.thresholdReachedAt;

    await tx.suggestion.update({ where: { id: suggestionId }, data: { upvoters, downvoters, thresholdReachedAt } });
    return { ok: true as const, suggestion: { ...suggestion, upvoters, downvoters, thresholdReachedAt }, settings, thresholdReached };
  });

  if (result.ok) {
    notifySuggestionsChanged(guildId);
    // Ici et non à la publication du message : l'événement part même quand
    // le message public est introuvable.
    if (result.thresholdReached) publishThresholdReached(result.suggestion, settings.voteThreshold);
  }
  return result;
}

/**
 * Vote venu d'ailleurs que Discord (site communautaire) : même écriture, et le
 * message public est retrouvé par le salon enregistré plutôt que par
 * l'interaction.
 */
export async function voteOnSuggestion(client: Client, guildId: string, suggestionId: string, userId: string, type: 'up' | 'down'): Promise<SuggestionVoteResult> {
  const vote = await applySuggestionVote(guildId, suggestionId, userId, type);
  if (vote.ok) await publishVote(client, vote, null);
  return vote;
}

/**
 * Suites d'un vote enregistré : le message redessiné, puis l'épingle quand ce
 * vote fait franchir le seuil et que le serveur le demande.
 */
async function publishVote(
  client: Client,
  vote: Extract<SuggestionVoteResult, { ok: true }>,
  known: Message | null,
): Promise<RefreshOutcome> {
  const message = known ?? await findStoredSuggestionMessage(client, vote.suggestion);
  if (!message) return 'missing';
  const outcome = await refreshSuggestionMessage(client, vote.suggestion, vote.settings.voteWhileApproved, message);
  // En attente seulement : la décision désépingle, une approuvée resterait épinglée sans fin.
  if (vote.thresholdReached && vote.settings.pinAtThreshold && statusOf(vote.suggestion) === 'PENDING' && !message.pinned) {
    await message.pin().catch((e: unknown) => logger.warn('Suggestions', `Épinglage de la suggestion ${vote.suggestion.id} impossible:`, e));
  }
  return outcome;
}

/**
 * Traite les votes sur une suggestion (Upvote / Downvote)
 */
export async function handleSuggestionVote(interaction: ButtonInteraction, type: 'up' | 'down') {
  const suggestionId = interaction.customId.split(':')[1];
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const locale = await getEffectiveLocale(interaction);
  const o = { locale };

  const vote = interaction.guildId
    ? await applySuggestionVote(interaction.guildId, suggestionId, interaction.user.id, type)
    : { ok: false as const, reason: 'not_found' as const };
  if (!vote.ok) {
    return interaction.editReply({
      content: vote.reason === 'closed' ? m.b5_suggestion_vote_closed({}, o) : m.b5_suggestion_vote_not_found({}, o),
    });
  }

  const message = await findSuggestionMessage(interaction, vote.suggestion);
  if (!message) {
    logger.warn('Suggestions', `Message public introuvable pour la suggestion ${suggestionId} (interaction message: ${interaction.message.id})`);
    return interaction.editReply({ content: m.b5_suggestion_vote_ok_no_message({}, o) });
  }

  const outcome = await publishVote(interaction.client, vote, message);
  return interaction.editReply({
    content: outcome === 'edited' ? m.b5_suggestion_vote_ok({}, o) : m.b5_suggestion_vote_ok_not_refreshed({}, o),
  });
}

/** Seuil de votes franchi : annoncé une fois, pour les workflows et les webhooks sortants. */
function publishThresholdReached(suggestion: Suggestion, threshold: number | null): void {
  kotboEventBus.publish('suggestion:threshold-reached', {
    guildId: suggestion.guildId,
    suggestionId: suggestion.id,
    userId: suggestion.userId,
    username: suggestion.username,
    title: suggestion.title,
    category: suggestion.category,
    content: suggestion.content,
    upvotes: suggestion.upvoters.length,
    downvotes: suggestion.downvoters.length,
    threshold: threshold ?? suggestion.upvoters.length,
    channelId: suggestion.channelId,
    messageId: suggestion.messageId,
    timestamp: Date.now(),
  });
}

/** Annonce une décision du staff sur le bus (workflows, webhooks sortants). */
function publishSuggestionResolved(suggestion: Suggestion, previousStatus: SuggestionStatus): void {
  const status = statusOf(suggestion);
  if (status === 'PENDING') return;

  kotboEventBus.publish('suggestion:resolved', {
    guildId: suggestion.guildId,
    suggestionId: suggestion.id,
    userId: suggestion.userId,
    username: suggestion.username,
    title: suggestion.title,
    category: suggestion.category,
    content: suggestion.content,
    status,
    previousStatus,
    responseText: suggestion.responseText ?? '',
    respondedById: suggestion.respondedById === 'mcp_agent' ? null : suggestion.respondedById,
    upvotes: suggestion.upvoters.length,
    downvotes: suggestion.downvoters.length,
    timestamp: Date.now(),
  });
}

/**
 * Pose ou change la décision du staff, et redessine le message public.
 *
 * Une décision n'est pas définitive : une suggestion approuvée peut passer
 * « mise en place », une refusée être reconsidérée. `PENDING` la rouvre : la
 * réponse et son auteur sont effacés, les votes rouverts. L'événement
 * `suggestion:resolved` ne part qu'à un vrai changement de statut, pour qu'une
 * réponse reformulée ne relance pas les workflows.
 *
 * `null` quand la suggestion n'existe pas sur ce serveur.
 */
export async function resolveSuggestion(
  guildId: string,
  suggestionId: string,
  status: SuggestionStatus,
  responseText: string | null,
  respondedById: string,
  client: Client
): Promise<{ suggestion: Suggestion; previousStatus: SuggestionStatus } | null> {
  // Le serveur fait partie de la recherche : un admin d'un serveur ne doit pas
  // pouvoir trancher la suggestion d'un autre en changeant l'identifiant.
  const current = await prisma.suggestion.findFirst({
    where: { id: suggestionId, guildId },
  });
  if (!current) return null;

  const decided = await prisma.suggestion.update({
    where: { id: suggestionId },
    data: status === 'PENDING'
      ? { status, responseText: null, respondedById: null, respondedAt: null }
      : { status, responseText: responseText?.trim() || null, respondedById, respondedAt: new Date() },
  });

  const settings = await getSuggestionSettings(guildId);
  const updated = await settleAuthorGains(client, current, decided, settings);

  notifySuggestionsChanged(guildId);
  if (updated.status !== current.status) publishSuggestionResolved(updated, statusOf(current));

  await refreshSuggestionMessage(client, updated, settings.voteWhileApproved);
  if (updated.status !== current.status) await announceDecision(client, updated, settings);

  return { suggestion: updated, previousStatus: statusOf(current) };
}

/**
 * Verse ou reprend la récompense de l'auteur selon le changement de statut
 * (voir `suggestionRewardMove`) et rend la suggestion avec ce qui est versé.
 *
 * Deux décisions simultanées (dashboard et assistant, double clic) lisent le
 * même statut de départ : chacune réserve d'abord la récompense par une
 * écriture conditionnelle, et seule celle qui l'obtient verse ou reprend.
 * Seule la somme réellement versée est reprise, même si le réglage a changé.
 */
async function settleAuthorGains(client: Client, before: Suggestion, after: Suggestion, settings: SuggestionSettings): Promise<Suggestion> {
  const move = suggestionRewardMove(statusOf(before), statusOf(after));

  if (move === 'grant' && (settings.rewardXp > 0 || settings.rewardCoins > 0)) {
    const claimed = await prisma.suggestion.updateMany({
      where: { id: after.id, xpGranted: 0, coinsGranted: 0 },
      data: { xpGranted: settings.rewardXp, coinsGranted: settings.rewardCoins },
    });
    if (claimed.count === 0) return refetch(after);
    const gains = await grantMemberGains(client, after.guildId, after.userId, { xp: settings.rewardXp, coins: settings.rewardCoins }, {
      ...GAINS_CONTEXT,
      channelId: after.channelId ?? undefined,
    });
    // Un module éteint ou un échec : la réservation est ramenée à ce qui a été versé.
    return prisma.suggestion.update({ where: { id: after.id }, data: { xpGranted: gains.xp, coinsGranted: gains.coins } });
  }

  if (move === 'reclaim') {
    const granted = { xp: after.xpGranted, coins: after.coinsGranted };
    if (granted.xp === 0 && granted.coins === 0) return after;
    const claimed = await prisma.suggestion.updateMany({
      where: { id: after.id, xpGranted: granted.xp, coinsGranted: granted.coins },
      data: { xpGranted: 0, coinsGranted: 0 },
    });
    if (claimed.count === 0) return refetch(after);
    await reclaimMemberGains(client, after.guildId, after.userId, granted, GAINS_CONTEXT);
    return { ...after, xpGranted: 0, coinsGranted: 0 };
  }

  return after;
}

/** Ligne relue après une écriture concurrente ; l'ancienne si elle a disparu entre-temps. */
async function refetch(suggestion: Suggestion): Promise<Suggestion> {
  return (await prisma.suggestion.findUnique({ where: { id: suggestion.id } })) ?? suggestion;
}

/**
 * Prévient l'auteur d'une décision : en message privé quand le serveur le
 * veut, et dans le fil de la suggestion quand il y en a un. Un auteur aux
 * messages privés fermés y est mentionné à la place. Rien ne part pour une
 * remise en attente.
 */
async function announceDecision(client: Client, suggestion: Suggestion, settings: SuggestionSettings): Promise<void> {
  const status = statusOf(suggestion);
  if (status === 'PENDING' || (!settings.notifyAuthor && !suggestion.threadId)) return;

  const guild = await fetchGuild(client, suggestion.guildId);
  const locale = await resolveGuildLocale(suggestion.guildId, guild?.preferredLocale);
  const notice = buildSuggestionNotice({
    guildName: guild?.name ?? '',
    status,
    title: suggestion.title,
    content: suggestion.content,
    responseText: suggestion.responseText,
    messageUrl: suggestionMessageUrl(suggestion),
  }, suggestionNoticeLabels(locale));

  let delivered = false;
  if (settings.notifyAuthor) {
    const author = await client.users.fetch(suggestion.userId).catch(() => null);
    delivered = !!(await author?.send({ embeds: [notice] }).catch(() => null));
  }

  if (suggestion.threadId) {
    const thread = await client.channels.fetch(suggestion.threadId).catch(() => null);
    if (thread?.isThread()) {
      const mention = settings.notifyAuthor && !delivered;
      await thread.send({
        content: mention ? `<@${suggestion.userId}>` : undefined,
        embeds: [notice],
        allowedMentions: { users: mention ? [suggestion.userId] : [] },
      }).catch((e: unknown) => logger.warn('Suggestions', `Décision non publiée dans le fil ${suggestion.threadId}:`, e));
    }
  }
}

/**
 * Supprime une suggestion (doublon, abus) et ce qu'elle a publié : le message
 * et son fil ; la récompense versée est reprise. Les épingles des listes de
 * suivi gardent leur copie. `null` quand elle n'existe pas sur ce serveur.
 */
export async function deleteSuggestion(client: Client, guildId: string, suggestionId: string): Promise<Suggestion | null> {
  const suggestion = await prisma.suggestion.findFirst({ where: { id: suggestionId, guildId } });
  if (!suggestion) return null;

  const message = await findStoredSuggestionMessage(client, suggestion);
  await message?.delete().catch((e: unknown) => logger.warn('Suggestions', `Message de la suggestion ${suggestion.id} non supprimé:`, e));
  if (suggestion.threadId) {
    const thread = await client.channels.fetch(suggestion.threadId).catch(() => null);
    if (thread?.isThread()) {
      await thread.delete().catch((e: unknown) => logger.warn('Suggestions', `Fil ${suggestion.threadId} non supprimé:`, e));
    }
  }

  // Une suggestion supprimée (doublon, abus) ne laisse pas sa récompense derrière elle.
  if (suggestion.xpGranted > 0 || suggestion.coinsGranted > 0) {
    await reclaimMemberGains(client, guildId, suggestion.userId, { xp: suggestion.xpGranted, coins: suggestion.coinsGranted }, GAINS_CONTEXT);
  }
  await prisma.suggestion.delete({ where: { id: suggestion.id } });
  notifySuggestionsChanged(guildId);
  return suggestion;
}
