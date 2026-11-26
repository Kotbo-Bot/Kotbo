import type { FileView, MessageEntities, MessageMediaView, MessageView } from '@arcscord/discord-ui-svelte';
import { mergeEntities, toPreviewMarkdown } from './components/discord/previewEntities.svelte';
import { memberAvatarSrc } from './discordMedia';

export interface LoggedMessageAttachment {
  name?: string | null;
  url: string;
  contentType?: string | null;
}

export interface LoggedMessageInput {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  isBot?: boolean;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  attachments?: readonly LoggedMessageAttachment[] | null;
}

export interface GuildEntitiesInput {
  roles?: readonly { id: string; name: string; color?: string | null }[];
  channels?: readonly { id: string; name: string }[];
}

function toIsoTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : new Date().toISOString();
}

/**
 * Construit les entités de serveur (rôles et salons) pour résoudre les
 * mentions `<@&id>` et `<#id>` dans `@arcscord/discord-ui`.
 */
export function buildGuildEntities(guild?: GuildEntitiesInput): MessageEntities {
  const roles: NonNullable<MessageEntities['roles']> = {};
  for (const role of guild?.roles ?? []) {
    roles[role.id] = { name: role.name, ...(role.color ? { color: role.color } : {}) };
  }
  const channels: NonNullable<MessageEntities['channels']> = {};
  for (const channel of guild?.channels ?? []) {
    channels[channel.id] = { name: channel.name };
  }
  return {
    ...(Object.keys(roles).length ? { roles } : {}),
    ...(Object.keys(channels).length ? { channels } : {}),
  };
}

/**
 * Convertit un message journalisé en `MessageView` + `MessageEntities` pour
 * `@arcscord/discord-ui-svelte`.
 */
export function toLoggedMessageView(
  msg: LoggedMessageInput,
  guild?: GuildEntitiesInput,
): { view: MessageView; entities: MessageEntities } {
  const media: MessageMediaView[] = [];
  const attachments: FileView[] = [];

  for (const [index, att] of (msg.attachments ?? []).entries()) {
    const type = att.contentType ?? '';
    const alt = att.name || '';
    if (type.startsWith('image/')) {
      media.push({ id: `${msg.id}-img-${index}`, url: att.url, alt });
    } else if (type.startsWith('video/')) {
      media.push({ id: `${msg.id}-vid-${index}`, kind: 'video', url: att.url, alt });
    } else {
      attachments.push({ id: `${msg.id}-file-${index}`, kind: 'file', url: att.url, name: att.name || 'file' });
    }
  }

  const textEntities = msg.content
    ? toPreviewMarkdown(msg.content, { mentions: false }).entities
    : {};

  return {
    view: {
      id: msg.id,
      author: {
        id: msg.authorId,
        displayName: msg.authorName,
        avatarUrl: memberAvatarSrc(msg.authorAvatar ?? null, msg.authorName, msg.authorId),
        bot: Boolean(msg.isBot),
      },
      timestamp: toIsoTimestamp(msg.createdAt),
      ...(msg.editedAt ? { edited: true } : {}),
      body: { kind: 'markdown', content: msg.content || '' },
      ...(media.length ? { media } : {}),
      ...(attachments.length ? { attachments } : {}),
    },
    entities: mergeEntities([buildGuildEntities(guild), textEntities]),
  };
}
