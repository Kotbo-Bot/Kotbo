/**
 * Transcriptions JSON (format v1).
 *
 * Les messages sont figés au format de l'API Discord (`APIMessage`) : le
 * dashboard les convertit avec `fromDiscordMessage` de @arcscord/discord-ui,
 * et le format ne dépend pas des évolutions de la lib. Ce qui peut disparaître
 * ensuite côté Discord est figé à la capture : noms des mentions (`entities`)
 * et identité affichée de chaque auteur (`authors` : pseudo de serveur, avatar,
 * couleur du rôle, badge d'application vérifiée).
 */
import type {
  APIAttachment,
  APIEmbed,
  APIMessage,
  APIMessageInteraction,
  APIMessageInteractionMetadata,
  APIMessageReference,
  APIMessageTopLevelComponent,
  APIReaction,
  APIStickerItem,
  APIUser,
} from 'discord-api-types/v10';
import type { Guild, Message, MessageInteractionMetadata, User } from 'discord.js';
import { msgMentionEntities, type MessageEntities } from '../../utils/messageEntities.js';

export const TRANSCRIPT_DATA_VERSION = 1;

/** Identité d'un auteur telle qu'affichée au moment de la transcription. */
export type TranscriptAuthor = {
  displayName: string;
  avatarUrl: string;
  /** Couleur du rôle le plus haut qui en a une, absente sinon. */
  color?: string;
  bot: boolean;
  /** Application vérifiée par Discord (coche du badge APP). */
  verified: boolean;
};

export type TranscriptDataV1 = {
  version: 1;
  guildId: string;
  channel: { id: string; name: string; topic: string | null };
  generatedAt: string;
  messages: APIMessage[];
  entities: MessageEntities;
  authors: Record<string, TranscriptAuthor>;
};

/** Bit `VerifiedBot` des drapeaux publics d'un utilisateur Discord. */
const VERIFIED_BOT_FLAG = 1 << 16;

function serializeUser(user: User): APIUser {
  const primaryGuild = user.primaryGuild;
  return {
    id: user.id,
    username: user.username,
    global_name: user.globalName,
    discriminator: user.discriminator,
    avatar: user.avatar,
    ...(user.bot ? { bot: true } : {}),
    ...(user.system ? { system: true } : {}),
    public_flags: user.flags?.bitfield ?? 0,
    ...(primaryGuild
      ? {
        primary_guild: {
          identity_guild_id: primaryGuild.identityGuildId,
          identity_enabled: primaryGuild.identityEnabled,
          tag: primaryGuild.tag,
          badge: primaryGuild.badge,
        },
      }
      : {}),
  };
}

function serializeAttachment(attachment: Message['attachments'] extends Map<string, infer A> ? A : never): APIAttachment {
  return {
    id: attachment.id,
    filename: attachment.name,
    url: attachment.url,
    proxy_url: attachment.proxyURL,
    size: attachment.size,
    ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
    ...(attachment.description ? { description: attachment.description } : {}),
    ...(attachment.width !== null ? { width: attachment.width } : {}),
    ...(attachment.height !== null ? { height: attachment.height } : {}),
    ...(attachment.duration !== null ? { duration_secs: attachment.duration } : {}),
    ...(attachment.waveform !== null ? { waveform: attachment.waveform } : {}),
    ...(attachment.flags.bitfield ? { flags: attachment.flags.bitfield } : {}),
  };
}

function serializeReactions(msg: Message): APIReaction[] {
  return [...msg.reactions.cache.values()].map((reaction) => ({
    emoji: {
      id: reaction.emoji.id,
      name: reaction.emoji.name,
      ...(reaction.emoji.animated ? { animated: true } : {}),
    },
    count: reaction.count ?? 0,
    count_details: { burst: reaction.countDetails.burst, normal: reaction.countDetails.normal },
    me: reaction.me,
    me_burst: reaction.meBurst,
    burst_colors: reaction.burstColors ?? [],
  }));
}

function serializeInteractionMetadata(metadata: MessageInteractionMetadata): APIMessageInteractionMetadata {
  return {
    id: metadata.id,
    type: metadata.type,
    user: serializeUser(metadata.user),
    authorizing_integration_owners: metadata.authorizingIntegrationOwners,
    ...(metadata.originalResponseMessageId ? { original_response_message_id: metadata.originalResponseMessageId } : {}),
    ...(metadata.interactedMessageId ? { interacted_message_id: metadata.interactedMessageId } : {}),
    ...(metadata.triggeringInteractionMetadata
      ? { triggering_interaction_metadata: serializeInteractionMetadata(metadata.triggeringInteractionMetadata) }
      : {}),
  } as APIMessageInteractionMetadata;
}

/**
 * Message discord.js au format de l'API. `referenced` est le message auquel
 * il répond : objet résolu, `null` s'il a été supprimé, `undefined` si ce
 * n'est pas une réponse. Comme l'API, un message référencé ne porte pas sa
 * propre référence (pas de récursion).
 */
export function serializeMessage(msg: Message, referenced?: Message | null): APIMessage {
  const reference: APIMessageReference | undefined = msg.reference
    ? {
      type: msg.reference.type,
      message_id: msg.reference.messageId,
      channel_id: msg.reference.channelId,
      guild_id: msg.reference.guildId,
    }
    : undefined;

  const interaction: APIMessageInteraction | undefined = msg.interaction
    ? {
      id: msg.interaction.id,
      type: msg.interaction.type,
      name: msg.interaction.commandName,
      user: serializeUser(msg.interaction.user),
    }
    : undefined;

  const member = msg.member;
  const stickers: APIStickerItem[] = [...msg.stickers.values()].map((sticker) => ({
    id: sticker.id,
    name: sticker.name,
    format_type: sticker.format,
  }));

  return {
    id: msg.id,
    channel_id: msg.channelId,
    type: msg.type,
    author: serializeUser(msg.author),
    content: msg.content,
    timestamp: msg.createdAt.toISOString(),
    edited_timestamp: msg.editedAt?.toISOString() ?? null,
    tts: msg.tts,
    mention_everyone: msg.mentions.everyone,
    mentions: [...msg.mentions.users.values()].map(serializeUser),
    mention_roles: [...msg.mentions.roles.keys()],
    attachments: [...msg.attachments.values()].map(serializeAttachment),
    embeds: msg.embeds.map((embed) => embed.toJSON() as APIEmbed),
    components: msg.components.map((component) => component.toJSON() as APIMessageTopLevelComponent),
    pinned: msg.pinned,
    flags: msg.flags.bitfield,
    ...(msg.webhookId ? { webhook_id: msg.webhookId } : {}),
    ...(stickers.length ? { sticker_items: stickers } : {}),
    ...(msg.reactions.cache.size ? { reactions: serializeReactions(msg) } : {}),
    ...(reference ? { message_reference: reference } : {}),
    ...(referenced !== undefined ? { referenced_message: referenced ? serializeMessage(referenced) : null } : {}),
    ...(interaction ? { interaction } : {}),
    ...(msg.interactionMetadata ? { interaction_metadata: serializeInteractionMetadata(msg.interactionMetadata) } : {}),
    ...(member ? { member: { nick: member.nickname, avatar: member.avatar } } : {}),
  } as APIMessage;
}

/** Pseudo de serveur, avatar affiché, couleur du rôle, badge vérifié. */
function authorOf(user: User, guild: Guild | null, msg?: Message): TranscriptAuthor {
  const member = (msg?.author.id === user.id ? msg.member : null) ?? guild?.members.cache.get(user.id) ?? null;
  return {
    displayName: member?.displayName ?? user.displayName,
    avatarUrl: member?.displayAvatarURL({ size: 128 }) ?? user.displayAvatarURL({ size: 128 }),
    ...(member?.displayColor ? { color: member.displayHexColor } : {}),
    bot: user.bot,
    verified: ((user.flags?.bitfield ?? 0) & VERIFIED_BOT_FLAG) !== 0,
  };
}

/** Textes où le Markdown peut citer des mentions ou des émojis. */
function textsOf(msg: Message): string[] {
  const texts: string[] = [msg.content];
  for (const embed of msg.embeds) {
    texts.push(embed.title ?? '', embed.description ?? '', embed.footer?.text ?? '', embed.author?.name ?? '');
    for (const field of embed.fields) texts.push(field.name, field.value);
  }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.content === 'string') texts.push(record.content);
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  msg.components.forEach((component) => walk(component.toJSON()));
  return texts;
}

function mergeEntities(target: Required<MessageEntities>, source: MessageEntities): void {
  Object.assign(target.users, source.users);
  Object.assign(target.roles, source.roles);
  Object.assign(target.channels, source.channels);
  Object.assign(target.emojis, source.emojis);
}

/**
 * Message auquel `msg` répond : d'abord parmi les messages transcrits, puis
 * dans le cache du salon, enfin chez Discord. `null` s'il a été supprimé.
 */
async function resolveReference(msg: Message, byId: Map<string, Message>): Promise<Message | null | undefined> {
  const messageId = msg.reference?.messageId;
  if (!messageId || msg.reference?.channelId !== msg.channelId) return undefined;
  const known = byId.get(messageId) ?? msg.channel.messages.cache.get(messageId);
  if (known) return known;
  return msg.fetchReference().catch(() => null);
}

/** Construit la transcription JSON d'une suite de messages, dans l'ordre donné. */
export async function buildTranscriptData(
  channel: { id: string; name: string; topic?: string | null; guild: Guild },
  messages: Message[],
): Promise<TranscriptDataV1> {
  const guild = channel.guild;
  const byId = new Map(messages.map((msg) => [msg.id, msg]));
  const entities: Required<MessageEntities> = { users: {}, roles: {}, channels: {}, emojis: {} };
  const authors: Record<string, TranscriptAuthor> = {};
  const addAuthor = (user: User, msg?: Message) => {
    if (!authors[user.id]) authors[user.id] = authorOf(user, guild, msg);
  };

  const serialized: APIMessage[] = [];
  for (const msg of messages) {
    const referenced = await resolveReference(msg, byId);
    serialized.push(serializeMessage(msg, referenced));

    addAuthor(msg.author, msg);
    if (referenced) addAuthor(referenced.author, referenced);
    if (msg.interaction) addAuthor(msg.interaction.user);
    if (msg.interactionMetadata) addAuthor(msg.interactionMetadata.user);

    const texts = textsOf(msg);
    if (referenced) texts.push(referenced.content);
    mergeEntities(entities, msgMentionEntities(texts, guild));
    // Mentions résolues par Discord : présentes même hors du cache de la guilde.
    for (const user of msg.mentions.users.values()) {
      entities.users[user.id] ??= { name: guild.members.cache.get(user.id)?.displayName ?? user.displayName };
    }
    for (const role of msg.mentions.roles.values()) {
      entities.roles[role.id] ??= { name: role.name, color: role.color ? role.hexColor : undefined };
    }
  }

  return {
    version: TRANSCRIPT_DATA_VERSION,
    guildId: guild.id,
    channel: { id: channel.id, name: channel.name, topic: channel.topic ?? null },
    generatedAt: new Date().toISOString(),
    messages: serialized,
    entities: Object.fromEntries(Object.entries(entities).filter(([, value]) => Object.keys(value).length > 0)),
    authors,
  };
}
