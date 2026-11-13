/**
 * Remercier en réagissant sous un message, avec l'emoji choisi par le serveur.
 *
 * Un refus (limite du jour, déjà remercié aujourd'hui) reste silencieux : une
 * réponse publique à chaque réaction de trop inonderait le salon. Retirer la
 * réaction ne retire pas le remerciement, comme une commande déjà envoyée.
 */
import type { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { getReputationConfig } from './reputationService.js';
import { recordRep } from './reputationActions.js';
import { isThanksReaction } from './reputationReactionFilter.js';

export async function handleReputationReaction(
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  const guildId = reaction.message.guildId;
  if (!guildId || user.bot) return;

  const settings = await getReputationConfig(guildId);
  const emojiKey = reaction.emoji.id ?? reaction.emoji.name ?? '';
  // Tri bon marché d'abord : la plupart des réactions ne sont pas des remerciements,
  // inutile de récupérer le message pour elles.
  if (!settings.reactionEnabled || emojiKey !== settings.reactionEmoji) return;

  const message = reaction.message.partial
    ? await reaction.message.fetch().catch(() => null)
    : reaction.message;
  if (!message || !message.inGuild()) return;

  const thanks = isThanksReaction({
    enabled: settings.reactionEnabled,
    configuredEmoji: settings.reactionEmoji,
    emojiKey,
    reactorId: user.id,
    reactorIsBot: user.bot ?? false,
    authorId: message.webhookId ? null : message.author?.id ?? null,
    authorIsBot: message.author?.bot ?? false,
  });
  if (!thanks) return;

  const locale = await resolveGuildLocale(guildId, message.guild.preferredLocale);
  const channelName = 'name' in message.channel ? message.channel.name : message.channelId;
  await recordRep(client, {
    guildId,
    giverId: user.id,
    receiverId: message.author.id,
    reason: m.b2_rep_ctx_reason_message({ channel: channelName }, { locale }),
    channelId: message.channelId,
    messageId: message.id,
  });
}
