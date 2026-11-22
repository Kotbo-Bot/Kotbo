/**
 * Messages d'un ticket (route `GET /tickets/:id`) convertis au format de
 * @arcscord/discord-ui pour la vue conversation.
 *
 * La route renvoie le Markdown brut, les embeds (et cartes Components V2) à
 * plat, les boutons et réactions déjà résolus, plus les noms des mentions
 * (`entities`). Une transcription relue d'un ticket fermé arrive au même
 * format, sans entités ni boutons.
 */
import type {
  ActionRowView,
  AudioView,
  EmbedView,
  FileView,
  MessageButtonView,
  MessageEntities,
  MessageMediaView,
  MessageView,
  ReactionView,
  StickerView,
} from '@arcscord/discord-ui-svelte';

export type TicketChatButton = { label: string; emoji: string | null; url: string | null; style: number; disabled: boolean };

export type TicketChatEmbed = {
  title?: string | null;
  description?: string | null;
  color?: string | null;
  fields?: { name: string; value: string }[];
  image?: { url: string } | null;
  thumbnail?: { url: string } | null;
  video?: { url: string } | null;
  images?: string[];
  buttons?: TicketChatButton[];
};

export type TicketChatMessage = {
  id: string;
  authorId?: string;
  authorName?: string | null;
  authorAvatar?: string | null;
  isStaff?: boolean;
  content?: string | null;
  mediaUrls?: { type: 'image' | 'video' | 'audio'; url: string }[];
  stickers?: { id: string; name: string; url: string }[];
  attachments?: { url: string; contentType: string | null }[];
  embeds?: TicketChatEmbed[];
  buttons?: TicketChatButton[];
  reactions?: { emoji: string | null; imageUrl: string | null; name: string; count: number }[];
  entities?: MessageEntities;
  createdAt: string;
};

/** Discord limite une rangée à cinq boutons. */
const BUTTONS_PER_ROW = 5;

const BUTTON_STYLES: Record<number, 'primary' | 'secondary' | 'success' | 'danger'> = {
  1: 'primary',
  2: 'secondary',
  3: 'success',
  4: 'danger',
};

function fileName(url: string | null | undefined): string {
  if (!url) return '';
  return url.split('?')[0].split('/').pop() ?? '';
}

function emojiOf(emoji: string | null): { name: string; image?: string } | undefined {
  if (!emoji) return undefined;
  return emoji.startsWith('https://') ? { name: 'emoji', image: emoji } : { name: emoji };
}

function toButton(button: TicketChatButton, id: string): MessageButtonView {
  const label = button.label;
  const emoji = emojiOf(button.emoji);
  if (button.url) return { id, kind: 'link-button', label, url: button.url, disabled: button.disabled, emoji };
  return { id, kind: 'button', label, style: BUTTON_STYLES[button.style] ?? 'secondary', disabled: button.disabled, emoji };
}

function toRows(buttons: TicketChatButton[], messageId: string): ActionRowView[] {
  const rows: ActionRowView[] = [];
  for (let start = 0; start < buttons.length; start += BUTTONS_PER_ROW) {
    const row = buttons.slice(start, start + BUTTONS_PER_ROW);
    rows.push({
      id: `${messageId}-row-${rows.length}`,
      kind: 'action-row',
      buttons: row.map((button, index) => toButton(button, `${messageId}-button-${start + index}`)),
    });
  }
  return rows;
}

/**
 * Un lien d'image déjà montré par un embed (aperçu Tenor, Giphy, image
 * jointe) ne se répète pas en média du message : Discord ne l'affiche qu'une
 * fois.
 */
function shownByEmbed(url: string, embeds: TicketChatEmbed[]): boolean {
  const name = fileName(url);
  return embeds.some((embed) => {
    const urls = [embed.image?.url, embed.thumbnail?.url, embed.video?.url].filter((value): value is string => !!value);
    if (urls.includes(url)) return true;
    if (name && urls.some((value) => fileName(value).includes(name))) return true;
    return ['giphy.com', 'tenor.com'].some((host) => url.includes(host) && urls.some((value) => value.includes(host)));
  });
}

function toEmbed(embed: TicketChatEmbed, id: string): EmbedView {
  return {
    id,
    title: embed.title || undefined,
    description: embed.description || undefined,
    color: embed.color || undefined,
    fields: embed.fields?.map((field, index) => ({ id: `${id}-field-${index}`, name: field.name, value: field.value })),
    image: embed.image?.url ? { id: `${id}-image`, url: embed.image.url, alt: '' } : undefined,
    thumbnail: embed.thumbnail?.url && !embed.image?.url ? { id: `${id}-thumbnail`, url: embed.thumbnail.url, alt: '' } : undefined,
  };
}

function stickerFormat(url: string): StickerView['format'] {
  const name = fileName(url).toLowerCase();
  if (name.endsWith('.json')) return 'lottie';
  if (name.endsWith('.gif')) return 'gif';
  return 'png';
}

export function toTicketMessageView(msg: TicketChatMessage): MessageView {
  const embeds = msg.embeds ?? [];
  const attachments = msg.attachments ?? [];
  const media: MessageMediaView[] = [];
  const files: (FileView | AudioView)[] = [];

  for (const [index, link] of (msg.mediaUrls ?? []).entries()) {
    if (attachments.some((attachment) => attachment.url === link.url) || shownByEmbed(link.url, embeds)) continue;
    const id = `${msg.id}-link-${index}`;
    if (link.type === 'image') media.push({ id, url: link.url, alt: '' });
    else if (link.type === 'video') media.push({ id, kind: 'video', url: link.url, alt: '' });
    else files.push({ id, kind: 'audio', url: link.url, name: fileName(link.url) });
  }

  for (const [index, attachment] of attachments.entries()) {
    const id = `${msg.id}-attachment-${index}`;
    const type = attachment.contentType ?? '';
    const name = fileName(attachment.url) || 'fichier';
    if (type.startsWith('image/')) media.push({ id, url: attachment.url, alt: name });
    else if (type.startsWith('video/')) media.push({ id, kind: 'video', url: attachment.url, alt: name });
    else if (type.startsWith('audio/')) files.push({ id, kind: 'audio', url: attachment.url, name });
    else files.push({ id, kind: 'file', url: attachment.url, name });
  }

  // Ce qu'un embed porte en plus de son image (vidéo, galerie) passe en
  // média du message : le modèle d'embed n'en a qu'une.
  for (const [index, embed] of embeds.entries()) {
    if (!embed.image?.url && embed.video?.url) media.push({ id: `${msg.id}-embed-${index}-video`, kind: 'video', url: embed.video.url, alt: '' });
    for (const [imageIndex, url] of (embed.images ?? []).entries()) media.push({ id: `${msg.id}-embed-${index}-image-${imageIndex}`, url, alt: '' });
  }

  const buttons = [...embeds.flatMap((embed) => embed.buttons ?? []), ...(msg.buttons ?? [])];

  const reactions: ReactionView[] = (msg.reactions ?? []).map((reaction, index) => ({
    id: `${msg.id}-reaction-${index}`,
    emoji: { name: reaction.emoji ?? reaction.name, image: reaction.imageUrl ?? undefined },
    count: reaction.count,
  }));

  return {
    id: msg.id,
    author: {
      id: msg.authorId || msg.authorName || 'unknown',
      displayName: msg.authorName || '',
      avatarUrl: msg.authorAvatar || undefined,
      bot: msg.isStaff === true && !msg.id.startsWith('temp-'),
    },
    timestamp: msg.createdAt,
    body: { kind: 'markdown', content: msg.content ?? '' },
    media: media.length ? media : undefined,
    attachments: files.length ? files : undefined,
    stickers: msg.stickers?.length
      ? msg.stickers.map((sticker) => ({ id: sticker.id, name: sticker.name, url: sticker.url, format: stickerFormat(sticker.url) }))
      : undefined,
    embeds: embeds.length ? embeds.map((embed, index) => toEmbed(embed, `${msg.id}-embed-${index}`)) : undefined,
    components: buttons.length ? toRows(buttons, msg.id) : undefined,
    reactions: reactions.length ? reactions : undefined,
  };
}

/** Noms des mentions de toute la conversation, pour le cadre `DiscordUI`. */
export function mergeTicketEntities(messages: TicketChatMessage[]): MessageEntities {
  const merged: { [K in keyof MessageEntities]-?: NonNullable<MessageEntities[K]> } = { users: {}, roles: {}, channels: {}, emojis: {}, commands: {} };
  for (const message of messages) {
    const entities = message.entities;
    if (!entities) continue;
    Object.assign(merged.users, entities.users);
    Object.assign(merged.roles, entities.roles);
    Object.assign(merged.channels, entities.channels);
    Object.assign(merged.emojis, entities.emojis);
  }
  return merged;
}
