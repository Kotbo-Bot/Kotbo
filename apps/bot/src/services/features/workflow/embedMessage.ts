import { EmbedBuilder } from 'discord.js';

type MentionKind = 'users' | 'roles';

export type EmbedMessage = {
  content?: string;
  embeds: EmbedBuilder[];
  allowedMentions: { parse: MentionKind[] };
};

/** Discord n'affiche que des images servies en https : le reste est ignoré, jamais une erreur. */
function httpsUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > 2000) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export type EmbedParams = {
  title: string;
  description: string;
  content: string;
  color: number;
  thumbnail?: string;
  image?: string;
  footer?: string;
  footerIcon?: string;
};

/**
 * Message d'un embed d'automatisation. Une mention dans un embed ne notifie
 * personne : le texte au-dessus sert à pinger. Ses mentions de membres et de
 * rôles notifient, jamais @everyone ni @here.
 */
export function buildEmbedMessage(params: EmbedParams): EmbedMessage | null {
  const title = params.title.slice(0, 256);
  const description = params.description.slice(0, 4096);
  if (!title && !description) return null;

  const embed = new EmbedBuilder().setColor(params.color);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);

  const thumbnail = httpsUrl(params.thumbnail);
  if (thumbnail) embed.setThumbnail(thumbnail);
  const image = httpsUrl(params.image);
  if (image) embed.setImage(image);
  const footer = params.footer?.trim().slice(0, 2048);
  // Une icône sans texte de pied de page n'est pas affichable par Discord.
  if (footer) {
    const iconURL = httpsUrl(params.footerIcon);
    embed.setFooter(iconURL ? { text: footer, iconURL } : { text: footer });
  }

  const content = params.content.trim().slice(0, 2000);
  return content
    ? { content, embeds: [embed], allowedMentions: { parse: ['users', 'roles'] } }
    : { embeds: [embed], allowedMentions: { parse: [] } };
}
