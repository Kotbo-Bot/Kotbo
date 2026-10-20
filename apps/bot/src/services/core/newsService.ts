import { type Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type TextChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { notifyMany } from '../notifications/notifyService.js';
import { COLORS } from '../../utils/embeds.js';

function buildEmbedDescription(article: { summary: string | null; content: string }, mode: 'summary' | 'full_embed') {
  if (mode === 'full_embed') {
    const normalized = article.content.trim();
    if (!normalized) {
      return article.summary || 'Aucun contenu.';
    }
    return normalized.length > 3900 ? `${normalized.slice(0, 3897)}...` : normalized;
  }

  if (article.summary) {
    return article.summary;
  }

  const truncatedContent = article.content.length > 200
    ? `${article.content.substring(0, 197)}...`
    : article.content;
  return truncatedContent;
}

export async function publishNewsArticle(client: Client, guildId: string, articleId: string, mode: 'summary' | 'full_embed' = 'summary') {
  const article = await prisma.newsArticle.findUnique({
    where: { id: articleId },
  });

  if (!article) {
    throw new Error(`Article ${articleId} introuvable.`);
  }

  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      newsChannelId: true,
      publicChannelId: true,
    },
  });

  const categoryConfigs = await prisma.newsCategoryConfig.findMany({
    where: { guildId }
  });

  const articleCategory = article.category || '';
  const articleSubcategory = article.subcategory || '';

  let bestMatch = categoryConfigs.find((c) =>
    c.category.toLowerCase() === articleCategory.toLowerCase() &&
    c.subcategory.toLowerCase() === articleSubcategory.toLowerCase()
  );

  if (!bestMatch && articleSubcategory !== '') {
    bestMatch = categoryConfigs.find((c) =>
      c.category.toLowerCase() === articleCategory.toLowerCase() &&
      c.subcategory === ''
    );
  }

  const targetChannelId = bestMatch?.channelId || guildConfig?.newsChannelId || guildConfig?.publicChannelId;
  if (!targetChannelId) {
    logger.warn('News', `Aucun salon de publication configuré pour la guilde ${guildId}. L'article est publié sur le flux RSS mais aucune notification Discord n'a été envoyée.`);
    return;
  }

  const channel = await client.channels.fetch(targetChannelId).catch(() => null) as TextChannel | null;
  if (!channel || !('send' in channel)) {
    logger.error('News', `Le salon de publication ${targetChannelId} est introuvable ou inaccessible.`);
    return;
  }

  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const articleUrl = `${dashboardUrl}/${guildId}/news`;

  // Construction de l'embed
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📢 ${article.category} : ${article.title}`)
    .setTimestamp(article.publishedAt)
    .setFooter({ text: 'Kotbo Actualités' });

  embed.setDescription(buildEmbedDescription(article, mode));

  if (article.imageUrl) {
    embed.setImage(article.imageUrl);
  }

  // Auteur
  embed.setAuthor({
    name: article.authorName,
    iconURL: article.authorAvatar || undefined,
  });

  // Bouton pour voir l'article / flux
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Lire l'article")
      .setStyle(ButtonStyle.Link)
      .setURL(articleUrl)
  );

  await channel.send({ embeds: [embed], components: [row] });
  logger.info('News', `Notification Discord envoyée pour l'article ${article.title} (${articleId}) dans ${targetChannelId}.`);

  // Notifier le staff via le système d'inbox du dashboard
  const staff = await prisma.staffMember.findMany({
    where: { guildId }
  });

  await notifyMany(staff.map(m => m.userId), {
    guildId,
    kind: 'staff.news_published',
    title: `Nouvel article : ${article.title}`,
    message: `Un nouvel article de catégorie "${article.category}" rédigé par ${article.authorName} a été publié.`,
    link: '/news',
  });
}

export function generateRssXml(
  guildName: string,
  guildId: string,
  dashboardUrl: string,
  apiUrl: string,
  articles: Array<{
    id?: string;
    title: string;
    content?: string | null;
    summary?: string | null;
    publishedAt: Date | string;
    sourceUrl?: string | null;
    authorName?: string | null;
    category?: string | null;
    subcategory?: string | null;
    imageUrl?: string | null;
  }>,
  category?: string | null,
  subcategory?: string | null
): string {
  const xmlItems = articles.map(art => {
    const pubDate = new Date(art.publishedAt).toUTCString();
    const link = `${dashboardUrl}/${guildId}/news`;
    const contentEncoded = art.content ? `<![CDATA[${art.content}]]>` : '';
    const summary = art.summary ? `<![CDATA[${art.summary}]]>` : '';
    return `    <item>
      <title><![CDATA[${art.title}]]></title>
      <link>${link}</link>
      <guid isPermaLink="false">${art.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <author><![CDATA[${art.authorName}]]></author>
      <category><![CDATA[${art.category}]]></category>
      <description>${summary || contentEncoded}</description>
      ${art.imageUrl ? `<media:content url="${art.imageUrl}" medium="image" />` : ''}
    </item>`;
  }).join('\n');

  let selfLink = `${apiUrl}/api/public/rss/${guildId}`;
  if (category) {
    selfLink += `/${encodeURIComponent(category)}`;
    if (subcategory) {
      selfLink += `/${encodeURIComponent(subcategory)}`;
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title><![CDATA[Actualités - ${guildName}]]></title>
    <link>${dashboardUrl}/${guildId}/news</link>
    <description><![CDATA[Flux RSS des actualités et patch notes rédigés par le staff de ${guildName}]]></description>
    <language>fr</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${selfLink}" rel="self" type="application/rss+xml" />
${xmlItems}
  </channel>
</rss>`;
}
