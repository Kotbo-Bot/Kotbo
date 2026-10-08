import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { extractSiteDocumentText, foldSearchText, normalizeSiteDocument } from '@kotbo/shared';
import type { SlashCommandDefinition } from '../../commands.js';
import { getCommandMetadata, getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import prisma from '../../utils/db.js';
import { getDashboardUrl } from '../../api/shared.js';
import { getSiteByGuild, listPublishedPages } from '../../services/site/siteService.js';
import { searchSite } from '../../services/site/siteSearch.js';

/**
 * /wiki : chercher une page du wiki du site et l'afficher dans le salon.
 *
 * La réponse est visible de tous : seules les pages publiques du wiki sont
 * proposées, jamais une page réservée à des rôles ou au staff.
 */

const meta = getCommandMetadata('site_cmd_wiki');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption((o) =>
    o
      .setName('page')
      .setDescription(m.site_cmd_wiki_opt_query({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.site_cmd_wiki_opt_query({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMaxLength(100)
      .setAutocomplete(true),
  );

/** Site publié du serveur, ou nul. */
async function liveSite(guildId: string) {
  const site = await getSiteByGuild(guildId);
  return site && site.published && !site.suspendedAt ? site : null;
}

function siteBase(slug: string): string {
  return `${getDashboardUrl().replace(/\/$/, '')}/s/${slug}`;
}

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const site = guildId ? await liveSite(guildId) : null;
  if (!site) {
    await interaction.respond([]);
    return;
  }
  const query = foldSearchText(interaction.options.getFocused());
  const pages = (await listPublishedPages(site, 'WIKI')).filter((p) => p.visibility === 'PUBLIC');
  const matches = pages
    .filter((p) => !query || foldSearchText(p.publishedTitle ?? p.slug).includes(query))
    .slice(0, 25)
    .map((p) => ({ name: (p.publishedTitle ?? p.slug).slice(0, 100), value: `id:${p.id}` }));
  await interaction.respond(matches);
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const o = { locale };
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: m.site_cmd_wiki_guild_only({}, o), flags: [MessageFlags.Ephemeral] });
    return;
  }
  const site = await liveSite(guildId);
  if (!site) {
    await interaction.reply({ content: m.site_cmd_wiki_no_site({}, o), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const raw = interaction.options.getString('page', true).trim();
  const base = siteBase(site.slug);

  // Valeur choisie dans l'autocomplétion : la page elle-même.
  if (raw.startsWith('id:')) {
    const page = await prisma.sitePage.findFirst({
      where: { id: raw.slice(3), siteId: site.id, kind: 'WIKI', visibility: 'PUBLIC', publishedAt: { not: null }, archivedAt: null },
      select: { slug: true, publishedTitle: true, excerpt: true, publishedContent: true, publishedAt: true },
    });
    if (page) {
      const url = `${base}/wiki/${page.slug}`;
      const text = page.excerpt || extractSiteDocumentText(normalizeSiteDocument(page.publishedContent), 1200);
      const embed = new EmbedBuilder()
        .setAuthor({ name: `📚 ${site.name ?? interaction.guild?.name ?? 'Wiki'}` })
        .setTitle((page.publishedTitle ?? page.slug).slice(0, 256))
        .setURL(url)
        .setDescription(text.length > 600 ? `${text.slice(0, 597).trimEnd()}…` : text || null)
        .setColor(0x5865f2);
      if (page.publishedAt) embed.setTimestamp(page.publishedAt);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(m.site_cmd_wiki_open({}, o)),
      );
      await interaction.reply({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
      return;
    }
  }

  // Saisie libre : recherche plein texte, pages publiques du wiki seulement.
  const hits = (await searchSite(site.id, raw, 20)).filter((h) => h.kind === 'WIKI' && h.visibility === 'PUBLIC').slice(0, 5);
  if (hits.length === 0) {
    await interaction.reply({ content: m.site_cmd_wiki_not_found({ query: raw.slice(0, 80) }, o), flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
    return;
  }
  const strip = (html: string) => html.replace(/<\/?mark>/g, '**').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const embed = new EmbedBuilder()
    .setTitle(m.site_cmd_wiki_results({ query: raw.slice(0, 80) }, o).slice(0, 256))
    .setColor(0x5865f2)
    .setDescription(
      hits
        .map((h) => `**[${h.title.replace(/[[\]]/g, '')}](${base}/wiki/${h.slug})**\n${strip(h.snippetHtml).slice(0, 220)}`)
        .join('\n\n')
        .slice(0, 4000),
    );
  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

export const wikiCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
