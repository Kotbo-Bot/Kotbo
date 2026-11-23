import { EmbedBuilder } from 'discord.js';

type MentionKind = 'users' | 'roles';

export type EmbedMessage = {
  content?: string;
  embeds: EmbedBuilder[];
  allowedMentions: { parse: MentionKind[] };
};

/**
 * Message d'un embed d'automatisation. Une mention dans un embed ne notifie
 * personne : le texte au-dessus sert à pinger. Ses mentions de membres et de
 * rôles notifient, jamais @everyone ni @here.
 */
export function buildEmbedMessage(params: { title: string; description: string; content: string; color: number }): EmbedMessage | null {
  const title = params.title.slice(0, 256);
  const description = params.description.slice(0, 4096);
  if (!title && !description) return null;

  const embed = new EmbedBuilder().setColor(params.color);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);

  const content = params.content.trim().slice(0, 2000);
  return content
    ? { content, embeds: [embed], allowedMentions: { parse: ['users', 'roles'] } }
    : { embeds: [embed], allowedMentions: { parse: [] } };
}
