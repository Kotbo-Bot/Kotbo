import { Client, MessageFlags, PermissionFlagsBits, type ButtonInteraction, type Guild, type Message } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import type { Suggestion } from '@prisma/client';
import {
  canSubmitSuggestion,
  isSuggestionStatus,
  isSuggestionVotingOpen,
  type SuggestionStatus,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { publishGuildSignal } from '../site/siteLive.js';
import { logger } from '../../utils/logger.js';
import { UserFacingError } from '../../utils/userFacingError.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { getEffectiveLocale, resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { buildSuggestionMessage, isSuggestionMessageFor } from './suggestionMessage.js';
import { suggestionMessageLabels } from './suggestionMessageLabels.js';
import { getSuggestionSettings, SUGGESTIONS_REALTIME_REASON } from './suggestionSettings.js';

/** Membre que les réglages du serveur n'autorisent pas à proposer. */
export class SuggestionNotAllowedError extends UserFacingError {}

type SuggestionFeatureConfig = {
  featureKey?: string;
  enabled?: boolean;
  channelId?: string | null;
};

type FetchedChannel = NonNullable<Awaited<ReturnType<Client['channels']['fetch']>>>;

type RenderableSuggestion = Pick<
  Suggestion,
  'id' | 'guildId' | 'userId' | 'username' | 'content' | 'status' | 'responseText' | 'upvoters' | 'downvoters' | 'channelId' | 'messageId'
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

/** Suggestions approuvées redessinées d'un coup : de quoi couvrir les récentes sans saturer l'API Discord. */
const APPROVED_REFRESH_MAX = 50;

/**
 * Rouvre ou referme les boutons des suggestions approuvées quand le réglage
 * « votes ouverts après approbation » change : sans cela, les messages déjà
 * publiés gardaient l'ancien état. Une à une, pour rester sous la limite
 * d'édition de Discord.
 */
export async function refreshApprovedSuggestionMessages(client: Client, guildId: string, voteWhileApproved: boolean): Promise<void> {
  const approved = await prisma.suggestion.findMany({
    where: { guildId, status: 'APPROVED', messageId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: APPROVED_REFRESH_MAX,
  });
  for (const suggestion of approved) {
    await refreshSuggestionMessage(client, suggestion, voteWhileApproved);
  }
}

/**
 * Crée et publie une nouvelle suggestion dans le salon dédié
 */
export async function createSuggestion(guildId: string, userId: string, username: string, content: string, client: Client) {
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
  const member = await discordGuild.members.fetch(userId).catch(() => null);
  const allowed = canSubmitSuggestion(settings.allowedRoleIds, member && {
    roleIds: [...member.roles.cache.keys()],
    canManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
  });
  if (!allowed) {
    const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
    throw new SuggestionNotAllowedError(m.b5_suggestion_err_role({}, { locale }));
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
    await prisma.suggestion.update({
      where: { id: suggestion.id },
      data: { messageId: message.id },
    });
  }

  kotboEventBus.publish('suggestion:created', {
    guildId,
    suggestionId: suggestion.id,
    userId,
    username,
    content,
    channelId: targetChannelId,
    messageId: message?.id ?? null,
    timestamp: Date.now(),
  });

  publishGuildSignal(guildId, 'module:suggestions');
  return suggestion;
}

type SuggestionVoteResult =
  | { ok: true; suggestion: Suggestion; voteWhileApproved: boolean }
  | { ok: false; reason: 'not_found' | 'closed' };

/**
 * Enregistre un vote : un second clic du même côté le retire, un clic de
 * l'autre côté le déplace. La ligne est verrouillée le temps de l'écriture,
 * pour que deux votes simultanés (Discord et site) ne s'écrasent pas.
 */
export async function applySuggestionVote(guildId: string, suggestionId: string, userId: string, type: 'up' | 'down'): Promise<SuggestionVoteResult> {
  const { voteWhileApproved } = await getSuggestionSettings(guildId);
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

    await tx.suggestion.update({ where: { id: suggestionId }, data: { upvoters, downvoters } });
    return { ok: true as const, suggestion: { ...suggestion, upvoters, downvoters }, voteWhileApproved };
  });

  if (result.ok) notifySuggestionsChanged(guildId);
  return result;
}

/**
 * Vote venu d'ailleurs que Discord (site communautaire) : même écriture, et le
 * message public est retrouvé par le salon enregistré plutôt que par
 * l'interaction.
 */
export async function voteOnSuggestion(client: Client, guildId: string, suggestionId: string, userId: string, type: 'up' | 'down'): Promise<SuggestionVoteResult> {
  const vote = await applySuggestionVote(guildId, suggestionId, userId, type);
  if (vote.ok) await refreshSuggestionMessage(client, vote.suggestion, vote.voteWhileApproved);
  return vote;
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

  const outcome = await refreshSuggestionMessage(interaction.client, vote.suggestion, vote.voteWhileApproved, message);
  return interaction.editReply({
    content: outcome === 'edited' ? m.b5_suggestion_vote_ok({}, o) : m.b5_suggestion_vote_ok_not_refreshed({}, o),
  });
}

/** Annonce une décision du staff sur le bus (workflows, webhooks sortants). */
function publishSuggestionResolved(suggestion: Suggestion): void {
  const status = statusOf(suggestion);
  if (status === 'PENDING') return;

  kotboEventBus.publish('suggestion:resolved', {
    guildId: suggestion.guildId,
    suggestionId: suggestion.id,
    userId: suggestion.userId,
    username: suggestion.username,
    content: suggestion.content,
    status,
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

  const updated = await prisma.suggestion.update({
    where: { id: suggestionId },
    data: status === 'PENDING'
      ? { status, responseText: null, respondedById: null, respondedAt: null }
      : { status, responseText: responseText?.trim() || null, respondedById, respondedAt: new Date() },
  });

  notifySuggestionsChanged(guildId);
  if (updated.status !== current.status) publishSuggestionResolved(updated);

  const { voteWhileApproved } = await getSuggestionSettings(guildId);
  await refreshSuggestionMessage(client, updated, voteWhileApproved);

  return { suggestion: updated, previousStatus: statusOf(current) };
}
