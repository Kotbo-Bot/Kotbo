/**
 * Lecture d'une transcription, quel que soit son format.
 *
 * Les transcriptions JSON (`format` = "json") se lisent sans perte depuis
 * `data` ; les historiques (`format` = "html") repassent par
 * `parseTranscriptHtml`. Les services qui relisent une conversation
 * (restauration d'un ticket, rattrapage anti-arnaque) passent par ici.
 */
import type { APIEmbed, APIMessage } from 'discord-api-types/v10';
import type { DiscordConversation, TranscriptAuthor, TranscriptDataV1 } from './transcriptData.js';
import { parseTranscriptHtml, type ParsedTranscriptEmbed, type ParsedTranscriptMessage } from './transcriptService.js';

/** Ce qu'il faut charger d'une ligne `transcripts` pour la relire. */
export type StoredTranscript = { format: string; html: string | null; data: unknown };

/** Sélection Prisma correspondante. */
export const STORED_TRANSCRIPT_SELECT = { format: true, html: true, data: true } as const;

/** Données JSON d'une transcription, `null` si elle est historique ou illisible. */
export function transcriptDataOf(transcript: StoredTranscript): TranscriptDataV1 | null {
  if (transcript.format !== 'json') return null;
  const data = transcript.data as Partial<TranscriptDataV1> | null;
  if (!data || data.version !== 1 || !Array.isArray(data.messages)) return null;
  return data as TranscriptDataV1;
}

function hexColor(color: number | null | undefined): string | null {
  return typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : null;
}

function embedOf(embed: APIEmbed): ParsedTranscriptEmbed {
  return {
    color: hexColor(embed.color),
    authorName: embed.author?.name ?? null,
    authorIconUrl: embed.author?.icon_url ?? null,
    authorUrl: embed.author?.url ?? null,
    title: embed.title ?? null,
    url: embed.url ?? null,
    description: embed.description ?? null,
    fields: (embed.fields ?? []).map((field) => ({ name: field.name, value: field.value, inline: field.inline ?? false })),
    thumbnailUrl: embed.thumbnail?.url ?? null,
    imageUrl: embed.image?.url ?? null,
    footerText: embed.footer?.text ?? null,
    footerIconUrl: embed.footer?.icon_url ?? null,
  };
}

/** Composant brut, réduit à ce que la lecture parcourt. */
type RawNode = {
  type: number;
  content?: string;
  accent_color?: number | null;
  components?: RawNode[];
  accessory?: RawNode;
  media?: { url?: string };
  items?: Array<{ media?: { url?: string } }>;
};

/**
 * Components V2 lus comme un message classique : un conteneur devient un
 * embed (texte, couleur, vignette, première image), le texte hors conteneur
 * rejoint le contenu, les images hors conteneur les pièces jointes.
 */
function readComponents(components: RawNode[]): { text: string[]; embeds: ParsedTranscriptEmbed[]; images: string[] } {
  const text: string[] = [];
  const embeds: ParsedTranscriptEmbed[] = [];
  const images: string[] = [];

  for (const component of components) {
    if (component.type === 17) {
      const texts: string[] = [];
      const gallery: string[] = [];
      let thumbnail: string | null = null;
      const walk = (node: RawNode) => {
        if (node.type === 10 && node.content) texts.push(node.content);
        if (node.type === 9) {
          node.components?.forEach(walk);
          if (node.accessory?.type === 11 && node.accessory.media?.url) thumbnail = node.accessory.media.url;
        }
        if (node.type === 12) node.items?.forEach((item) => { if (item.media?.url) gallery.push(item.media.url); });
      };
      component.components?.forEach(walk);
      embeds.push({
        color: hexColor(component.accent_color),
        authorName: null,
        authorIconUrl: null,
        authorUrl: null,
        title: null,
        url: null,
        description: texts.join('\n\n') || null,
        fields: [],
        thumbnailUrl: thumbnail,
        imageUrl: gallery[0] ?? null,
        footerText: null,
        footerIconUrl: null,
      });
      images.push(...gallery.slice(1));
    } else if (component.type === 10 && component.content) {
      text.push(component.content);
    } else if (component.type === 12) {
      component.items?.forEach((item) => { if (item.media?.url) images.push(item.media.url); });
    }
  }
  return { text, embeds, images };
}

function messageOf(message: APIMessage, data: TranscriptDataV1): ParsedTranscriptMessage {
  const author = data.authors[message.author.id];
  const v2 = readComponents((message.components ?? []) as RawNode[]);
  const attachmentImages = message.attachments
    .filter((attachment) => attachment.content_type?.startsWith('image/'))
    .map((attachment) => attachment.url);

  return {
    avatarUrl: author?.avatarUrl ?? '',
    username: author?.displayName ?? message.author.global_name ?? message.author.username,
    isBot: message.author.bot === true,
    timestamp: message.timestamp,
    createdAt: message.timestamp,
    content: [message.content, ...v2.text].filter(Boolean).join('\n'),
    embeds: [...message.embeds.map(embedOf), ...v2.embeds],
    imageUrls: [...attachmentImages, ...v2.images],
  };
}

/** Messages d'une transcription, dans l'ordre, quel que soit son format. */
export function loadTranscriptMessages(transcript: StoredTranscript): ParsedTranscriptMessage[] {
  const data = transcriptDataOf(transcript);
  if (data) return data.messages.map((message) => messageOf(message, data));
  return transcript.html ? parseTranscriptHtml(transcript.html) : [];
}

function colorNumber(hex: string | null): number | undefined {
  if (!hex) return undefined;
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return Number.isNaN(value) ? undefined : value;
}

function legacyEmbed(embed: ParsedTranscriptEmbed): APIEmbed {
  return {
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.url ? { url: embed.url } : {}),
    ...(embed.description ? { description: embed.description } : {}),
    ...(colorNumber(embed.color) !== undefined ? { color: colorNumber(embed.color) } : {}),
    ...(embed.authorName
      ? { author: { name: embed.authorName, ...(embed.authorUrl ? { url: embed.authorUrl } : {}), ...(embed.authorIconUrl ? { icon_url: embed.authorIconUrl } : {}) } }
      : {}),
    ...(embed.fields.length ? { fields: embed.fields } : {}),
    ...(embed.thumbnailUrl ? { thumbnail: { url: embed.thumbnailUrl } } : {}),
    ...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {}),
    ...(embed.footerText ? { footer: { text: embed.footerText, ...(embed.footerIconUrl ? { icon_url: embed.footerIconUrl } : {}) } } : {}),
  };
}

/**
 * Transcription historique au format conversation. Le HTML ne garde ni
 * identifiants ni pièces jointes non-image : chaque pseudo devient un auteur
 * synthétique (identifiants 1, 2…), les images des pièces jointes PNG.
 */
function legacyConversation(messages: ParsedTranscriptMessage[], fallbackDate: string): DiscordConversation {
  const authorIds = new Map<string, string>();
  const authors: Record<string, TranscriptAuthor> = {};
  const apiMessages = messages.map((message, index): APIMessage => {
    let authorId = authorIds.get(message.username);
    if (!authorId) {
      // Identifiant numérique : la lib en dérive l'avatar par défaut (BigInt de l'identifiant).
      authorId = String(authorIds.size + 1);
      authorIds.set(message.username, authorId);
      authors[authorId] = { displayName: message.username, avatarUrl: message.avatarUrl, bot: message.isBot, verified: false };
    }
    return {
      id: `transcript-${index}`,
      channel_id: 'transcript',
      type: 0,
      author: { id: authorId, username: message.username, global_name: message.username, discriminator: '0', avatar: null, ...(message.isBot ? { bot: true } : {}) },
      content: message.content,
      timestamp: message.createdAt ?? fallbackDate,
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: message.imageUrls.map((url, imageIndex) => ({
        id: `transcript-${index}-${imageIndex}`,
        filename: url.split('?')[0].split('/').pop() || 'image.png',
        url,
        proxy_url: url,
        size: 0,
        content_type: 'image/png',
      })),
      embeds: message.embeds.map(legacyEmbed),
      pinned: false,
    } as APIMessage;
  });
  return { messages: apiMessages, entities: {}, authors };
}

/**
 * Conversation d'une transcription pour l'affichage, quel que soit son
 * format. `fallbackDate` date les messages historiques illisibles.
 */
export function transcriptConversation(transcript: StoredTranscript, fallbackDate: string): DiscordConversation {
  const data = transcriptDataOf(transcript);
  if (data) return { messages: data.messages, entities: data.entities, authors: data.authors };
  return legacyConversation(transcript.html ? parseTranscriptHtml(transcript.html) : [], fallbackDate);
}
