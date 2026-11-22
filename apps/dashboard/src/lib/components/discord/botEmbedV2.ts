/**
 * Embed du bot tel que Discord l'affiche vraiment : en Components V2.
 *
 * Le bot ne publie pas ses embeds tels quels. `utils/patchV2.ts` (embedToV2)
 * les convertit en conteneur V2 à l'envoi : titre en `### titre`, auteur en
 * gras au-dessus, vignette en accessoire, description, champs sous un
 * séparateur, image en galerie, pied en `-# pied` sous un séparateur sans
 * trait. Un aperçu fidèle reprend la même conversion.
 *
 * Seule différence : le bot préfixe certains titres d'un émoji d'application
 * deviné d'après leurs mots (« ticket », « erreur »…). Ces émojis dépendent de
 * l'instance du bot : l'aperçu ne les ajoute pas.
 */
import type { ContainerChild, ContainerView, MessageMediaView } from '@arcscord/discord-ui-svelte';

export type BotEmbed = {
  title?: string;
  url?: string;
  description?: string;
  /** Couleur hexadécimale, `COLORS.primary` du bot par défaut. */
  color?: string;
  authorName?: string;
  authorUrl?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  fields?: { name: string; value: string }[];
  footer?: string;
};

const DEFAULT_COLOR = '#5865f2';
const SAFE_LINK_URL = /^https?:\/\/[^\s<>]+$/i;

/** Lien Markdown masqué, construit comme le bot (`markdownLink`). */
function markdownLink(label: string, url: string | undefined): string {
  const href = url?.trim() ?? '';
  if (!SAFE_LINK_URL.test(href)) return label;
  const safeHref = href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${label.replace(/[[\]]/g, '\\$&')}](${safeHref})`;
}

export function botEmbedToV2(embed: BotEmbed, id = 'embed'): ContainerView {
  const components: ContainerChild[] = [];
  const text = (key: string, content: string): ContainerChild => ({ id: `${id}-${key}`, kind: 'text-display', content });

  // Un titre cliquable ne peut pas rester dans un heading : le bot repasse au gras.
  let title = embed.title?.trim() ?? '';
  let titleIsLinked = false;
  if (title) {
    const linked = markdownLink(title, embed.url);
    titleIsLinked = linked !== title;
    if (titleIsLinked) title = `**${linked}**`;
  }
  const authorHeader = embed.authorName?.trim() ? `**${markdownLink(embed.authorName.trim(), embed.authorUrl)}**\n` : '';
  const fullTitle = authorHeader || title ? (titleIsLinked ? `${authorHeader}${title}` : `${authorHeader}### ${title || 'Info'}`) : '';

  const thumbnail: MessageMediaView | null = embed.thumbnailUrl ? { id: `${id}-thumbnail-media`, url: embed.thumbnailUrl, alt: '' } : null;
  if (thumbnail) {
    components.push({
      id: `${id}-header`,
      kind: 'section',
      components: fullTitle ? [{ id: `${id}-title`, kind: 'text-display', content: fullTitle }] : [],
      accessory: { id: `${id}-thumbnail`, kind: 'thumbnail', media: thumbnail },
    });
  } else if (fullTitle) {
    components.push(text('title', fullTitle));
  }

  if (embed.description) components.push(text('description', embed.description));

  const fields = (embed.fields ?? []).filter((field) => field.name && field.value);
  if (embed.fields?.length) {
    components.push({ id: `${id}-fields-separator`, kind: 'separator', divider: true, spacing: 'small' });
    fields.forEach((field, index) => components.push(text(`field-${index}`, `**${field.name}**\n${field.value}`)));
  }

  if (embed.imageUrl) {
    components.push({ id: `${id}-image`, kind: 'media-gallery', items: [{ id: `${id}-image-media`, url: embed.imageUrl, alt: '' }] });
  }

  if (embed.footer) {
    components.push({ id: `${id}-footer-separator`, kind: 'separator', divider: false, spacing: 'small' });
    components.push(text('footer', `-# ${embed.footer}`));
  }

  return { id, kind: 'container', accentColor: embed.color || DEFAULT_COLOR, components };
}
