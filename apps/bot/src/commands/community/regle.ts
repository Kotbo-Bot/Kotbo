import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { foldSearchText } from '@kotbo/shared';
import type { SlashCommandDefinition } from '../../commands.js';
import { getCommandMetadata, getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import prisma from '../../utils/db.js';
import { loadRegulationArticles, type RegulationArticle } from '../../services/staff/regulationService.js';

/**
 * /regle : citer un article du règlement dans le salon, par son numéro ou son
 * titre, plutôt que d'en poster une capture. La numérotation est celle du
 * règlement publié : articles actifs, dans l'ordre.
 */

const meta = getCommandMetadata('regulation_cmd');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption((o) =>
    o
      .setName('article')
      .setDescription(m.regulation_cmd_opt_article({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.regulation_cmd_opt_article({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMaxLength(100)
      .setAutocomplete(true),
  );

async function activeArticles(guildId: string): Promise<RegulationArticle[]> {
  return (await loadRegulationArticles(guildId)).filter((a) => a.enabled);
}

/** Retrouve l'article : id choisi dans l'autocomplétion, numéro, puis titre. Exporté pour le test. */
export function findArticle(articles: RegulationArticle[], raw: string): { article: RegulationArticle; index: number } | null {
  const input = raw.trim();
  let index = input.startsWith('id:') ? articles.findIndex((a) => a.id === input.slice(3)) : -1;
  if (index < 0 && /^\d+$/.test(input)) {
    const n = Number(input);
    if (n >= 1 && n <= articles.length) index = n - 1;
  }
  if (index < 0) {
    const query = foldSearchText(input);
    if (query) {
      index = articles.findIndex((a) => foldSearchText(a.title) === query);
      if (index < 0) index = articles.findIndex((a) => foldSearchText(a.title).includes(query));
      if (index < 0) index = articles.findIndex((a) => foldSearchText(a.description).includes(query));
    }
  }
  return index >= 0 ? { article: articles[index]!, index } : null;
}

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }
  const query = foldSearchText(interaction.options.getFocused());
  const choices = (await activeArticles(guildId))
    .map((a, i) => ({ name: `${i + 1} · ${a.title}`.slice(0, 100), value: `id:${a.id}` }))
    .filter((c) => !query || foldSearchText(c.name).includes(query))
    .slice(0, 25);
  await interaction.respond(choices);
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const o = { locale };
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: m.site_cmd_wiki_guild_only({}, o), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const raw = interaction.options.getString('article', true);
  const found = findArticle(await activeArticles(guildId), raw);
  if (!found) {
    await interaction.reply({
      content: m.regulation_cmd_not_found({ query: raw.trim().slice(0, 80) }, o),
      flags: [MessageFlags.Ephemeral],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const { article, index } = found;
  const emoji = article.emoji?.trim() || '📌';
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(m.panel_regulation_article_heading({ emoji, index: index + 1, title: article.title }, o).slice(0, 256))
    .setDescription((article.description.trim() || m.panel_regulation_article_no_desc({}, o)).slice(0, 4096));

  // Lien vers le règlement complet, s'il est publié.
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { regulationChannelId: true, configChannelId: true, regulationMessageIds: true, regulationMessageId: true },
  });
  const channelId = guild?.regulationChannelId ?? guild?.configChannelId;
  const messageId = guild?.regulationMessageIds?.[0] ?? guild?.regulationMessageId;
  if (channelId && messageId) embed.setURL(`https://discord.com/channels/${guildId}/${channelId}/${messageId}`);

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

export const regleCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
