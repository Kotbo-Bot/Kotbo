/**
 * Messages récupérés comme preuves d'une sanction (route des preuves Discord)
 * convertis au format de @arcscord/discord-ui.
 *
 * Ce sont tous des messages de la personne sanctionnée ; leur texte arrive
 * avec les mentions déjà remplacées par des noms (`@Pseudo`, `#salon`).
 */
import type { EmbedView, FileView, MessageMediaView, MessageView, StickerView } from '@arcscord/discord-ui-svelte';

export interface EvidenceEmbed {
  color: string | null;
  authorName: string | null;
  authorIconUrl: string | null;
  authorUrl: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  fields: { name: string; value: string; inline: boolean }[];
  thumbnailUrl: string | null;
  imageUrl: string | null;
  footerText: string | null;
  footerIconUrl: string | null;
}

export interface EvidenceMessage {
  id: string;
  content: string;
  createdAt: string;
  attachments: { url: string; name: string; contentType: string | null; size: number; kind: 'image' | 'video' | 'file' }[];
  embeds: EvidenceEmbed[];
  stickers: { id: string; name: string; url: string }[];
  /** Message supprimé, relu dans le journal des messages. */
  deleted?: boolean;
}

export function toEvidenceEmbed(embed: EvidenceEmbed, id: string): EmbedView {
  return {
    id,
    ...(embed.color ? { color: embed.color } : {}),
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.url ? { url: embed.url } : {}),
    ...(embed.description ? { description: embed.description } : {}),
    ...(embed.authorName
      ? { author: { name: embed.authorName, ...(embed.authorUrl ? { url: embed.authorUrl } : {}), ...(embed.authorIconUrl ? { iconUrl: embed.authorIconUrl } : {}) } }
      : {}),
    ...(embed.fields.length ? { fields: embed.fields.map((field, index) => ({ id: `${id}-field-${index}`, ...field })) } : {}),
    ...(embed.thumbnailUrl ? { thumbnail: { id: `${id}-thumbnail`, url: embed.thumbnailUrl, alt: '' } } : {}),
    ...(embed.imageUrl ? { image: { id: `${id}-image`, url: embed.imageUrl, alt: '' } } : {}),
    ...(embed.footerText ? { footer: { text: embed.footerText, ...(embed.footerIconUrl ? { iconUrl: embed.footerIconUrl } : {}) } } : {}),
  };
}

/** Taille lisible d'un fichier joint, comme Discord l'écrit. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stickerFormat(url: string): StickerView['format'] {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.json')) return 'lottie';
  if (path.endsWith('.gif')) return 'gif';
  return 'png';
}

/** `author` : la personne sanctionnée, seule autrice de ces messages. */
export function toEvidenceMessageView(message: EvidenceMessage, author: { id: string; displayName: string }): MessageView {
  const media: MessageMediaView[] = [];
  const files: FileView[] = [];
  for (const attachment of message.attachments) {
    if (attachment.kind === 'image') media.push({ id: `${message.id}-${media.length}`, url: attachment.url, alt: attachment.name });
    else if (attachment.kind === 'video') media.push({ id: `${message.id}-${media.length}`, kind: 'video', url: attachment.url, alt: attachment.name });
    else files.push({ id: `${message.id}-file-${files.length}`, kind: 'file', url: attachment.url, name: attachment.name, size: fileSize(attachment.size) });
  }

  return {
    id: message.id,
    author,
    timestamp: message.createdAt,
    body: { kind: 'markdown', content: message.content },
    ...(media.length ? { media } : {}),
    ...(files.length ? { attachments: files } : {}),
    ...(message.embeds.length ? { embeds: message.embeds.map((embed, index) => toEvidenceEmbed(embed, `${message.id}-embed-${index}`)) } : {}),
    ...(message.stickers.length
      ? { stickers: message.stickers.map((sticker) => ({ id: sticker.id, name: sticker.name, url: sticker.url, format: stickerFormat(sticker.url) })) }
      : {}),
  };
}
