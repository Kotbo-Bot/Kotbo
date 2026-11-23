/**
 * Conversation Discord renvoyée par l'API (vue d'un ticket, transcription
 * JSON) : messages au format de l'API Discord, noms des mentions, auteurs
 * figés. Convertie pour @arcscord/discord-ui par `fromDiscordMessage`, qui
 * rend aussi les Components V2.
 */
import { fromDiscordMessage } from '@arcscord/discord-ui-core/discord-api';
import type { MessageAuthor, MessageEntities, MessageView, ReplyView } from '@arcscord/discord-ui-svelte';

export type DiscordApiMessage = Parameters<typeof fromDiscordMessage>[0];

/** Identité affichée d'un auteur au moment de la capture. */
export type ConversationAuthor = {
  displayName: string;
  avatarUrl: string;
  color?: string;
  bot: boolean;
  verified: boolean;
};

export type DiscordConversation = {
  messages: DiscordApiMessage[];
  entities: MessageEntities;
  authors: Record<string, ConversationAuthor>;
};

export const EMPTY_CONVERSATION: DiscordConversation = { messages: [], entities: {}, authors: {} };

/** Conversation d'une réponse d'API, vide si elle n'en porte pas. */
export function conversationOf(data: Partial<DiscordConversation> | null | undefined): DiscordConversation {
  return {
    messages: Array.isArray(data?.messages) ? data.messages : [],
    entities: data?.entities ?? {},
    authors: data?.authors ?? {},
  };
}

/** L'identité figée l'emporte sur celle que l'API Discord donnait alors. */
function withAuthor(author: MessageAuthor, authors: Record<string, ConversationAuthor>): MessageAuthor {
  const known = authors[author.id];
  if (!known) return author;
  return {
    ...author,
    displayName: known.displayName || author.displayName,
    avatarUrl: known.avatarUrl || author.avatarUrl,
    bot: known.bot,
    verified: known.verified,
    ...(known.color ? { color: known.color } : {}),
  };
}

function withReplyAuthor(reply: ReplyView | undefined, authors: Record<string, ConversationAuthor>): ReplyView | undefined {
  if (!reply || !('author' in reply) || !reply.author) return reply;
  return { ...reply, author: withAuthor(reply.author, authors) } as ReplyView;
}

/** Message que la lib n'a pas su lire : on garde au moins l'auteur et le texte. */
function fallbackView(message: DiscordApiMessage): MessageView {
  return {
    id: message.id,
    author: { id: message.author.id, displayName: message.author.global_name || message.author.username },
    timestamp: message.timestamp,
    body: { kind: 'markdown', content: message.content ?? '' },
  };
}

export function conversationViews(conversation: DiscordConversation): MessageView[] {
  return conversation.messages.map((message) => {
    let view: MessageView;
    try {
      view = fromDiscordMessage(message);
    } catch {
      view = fallbackView(message);
    }
    return { ...view, author: withAuthor(view.author, conversation.authors), reply: withReplyAuthor(view.reply, conversation.authors) } as MessageView;
  });
}
