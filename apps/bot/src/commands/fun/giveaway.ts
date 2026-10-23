import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type SharedNameAndDescription } from 'discord.js';
import { createGiveaway, endGiveaway, listGiveawayRpgItems, rerollGiveaway } from '../../services/features/giveawayService.js';
import { canManageGiveaways } from '../../services/features/giveawayConfigService.js';
import { findGiveawayTemplateByName, listGiveawayTemplates } from '../../services/features/giveawayTemplateService.js';
import prisma from '../../utils/db.js';
import { extractTrackingInfo, resolveModuleFromCommand, wrapModuleTracking } from '../../utils/moduleTracking.js';
import { getCommandMetadata, getEffectiveLocale, getLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

// Noms et descriptions localises par Discord selon le client de chaque membre.
// Le code lit les options par leur nom par defaut, celui de `meta.name`.
const meta = getCommandMetadata('gvw_cmd');
const startMeta = getCommandMetadata('gvw_sub_start');
const endMeta = getCommandMetadata('gvw_sub_end');
const rerollMeta = getCommandMetadata('gvw_sub_reroll');
const prizeMeta = getCommandMetadata('gvw_opt_prize');
const winnersMeta = getCommandMetadata('gvw_opt_winners');
const durationMeta = getCommandMetadata('gvw_opt_duration');
const templateMeta = getCommandMetadata('gvw_opt_template');
const descriptionMeta = getCommandMetadata('gvw_opt_description');
const channelMeta = getCommandMetadata('gvw_opt_channel');
const xpMeta = getCommandMetadata('gvw_opt_xp');
const coinsMeta = getCommandMetadata('gvw_opt_coins');
const itemMeta = getCommandMetadata('gvw_opt_item');
const validationMeta = getCommandMetadata('gvw_opt_validation');
const idMeta = getCommandMetadata('gvw_opt_id');

/**
 * Pose nom et description d'une sous-commande ou d'une option, dans les deux
 * langues. On renvoie l'objet recu plutot que le retour des setters : leur type
 * `this` ne se laisse pas generaliser proprement.
 */
function describe<T extends SharedNameAndDescription>(
  option: T,
  info: ReturnType<typeof getCommandMetadata>,
): T {
  option
    .setName(info.name)
    .setNameLocalizations(info.nameLocalizations)
    .setDescription(info.description)
    .setDescriptionLocalizations(info.descriptionLocalizations);
  return option;
}

// Pas de `setDefaultMemberPermissions` : Discord masquerait la commande aux
// rôles gestionnaires configurés dans l'onglet Configuration du dashboard, qui
// n'ont pas forcément « Gérer les messages ». Le droit est donc vérifié à
// l'exécution par `canManageGiveaways`.
const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    describe(sub, startMeta)
      .addStringOption((o) => describe(o, prizeMeta).setRequired(false))
      .addIntegerOption((o) => describe(o, winnersMeta).setRequired(false))
      .addIntegerOption((o) => describe(o, durationMeta).setRequired(false))
      .addStringOption((o) => describe(o, templateMeta).setRequired(false).setAutocomplete(true))
      .addStringOption((o) => describe(o, descriptionMeta).setRequired(false))
      .addChannelOption((o) => describe(o, channelMeta).setRequired(false))
      .addIntegerOption((o) => describe(o, xpMeta).setRequired(false))
      .addIntegerOption((o) => describe(o, coinsMeta).setRequired(false))
      .addStringOption((o) => describe(o, itemMeta).setRequired(false).setAutocomplete(true))
      .addBooleanOption((o) => describe(o, validationMeta).setRequired(false))
  )
  .addSubcommand((sub) =>
    describe(sub, endMeta)
      .addStringOption((o) => describe(o, idMeta).setRequired(true))
  )
  .addSubcommand((sub) =>
    describe(sub, rerollMeta)
      .addStringOption((o) => describe(o, idMeta).setRequired(true))
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId, userId } = extractTrackingInfo(interaction);
  const moduleName = resolveModuleFromCommand('giveaway');
  const subcommand = interaction.options.getSubcommand();

  // Wrapper pour tracker les performances et l'utilisation
  await wrapModuleTracking(
    moduleName,
    executeInternal,
    [interaction],
    {
      actionType: 'command',
      actionName: subcommand,
      guildId,
      userId,
    }
  );
}

async function executeInternal(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      // Hors serveur, la seule langue connue est celle du client Discord.
      content: m.gvw_cmd_guild_only({}, { locale: getLocale(interaction) }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const locale = await getEffectiveLocale(interaction);

  // Administrateurs, « Gérer les messages », ou rôles gestionnaires déclarés
  // dans l'onglet Configuration des giveaways.
  const member = interaction.guild
    ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
    : null;
  if (!(await canManageGiveaways(member, guildId))) {
    await interaction.reply({
      content: m.gvw_cmd_forbidden({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === startMeta.name) {
    const templateName = interaction.options.getString(templateMeta.name);
    const template = templateName ? await findGiveawayTemplateByName(guildId, templateName) : null;
    if (templateName && !template) {
      await interaction.reply({
        content: m.gvw_cmd_template_unknown({ name: templateName }, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    // Les options saisies priment sur le modèle : il sert de point de départ,
    // pas de carcan. Prix, gagnants et durée ne sont plus obligatoires pour
    // Discord, puisqu'un modèle peut les porter : c'est donc ici qu'on exige
    // qu'ils viennent de l'une des deux sources.
    const prize = interaction.options.getString(prizeMeta.name) ?? template?.prize;
    const winners = interaction.options.getInteger(winnersMeta.name) ?? template?.winnerCount;
    const duration = interaction.options.getInteger(durationMeta.name) ?? template?.durationMinutes;
    if (!prize || !winners || !duration) {
      await interaction.reply({
        content: m.gvw_cmd_missing_fields({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const description = interaction.options.getString(descriptionMeta.name) ?? template?.description ?? undefined;
    const rpgXp = interaction.options.getInteger(xpMeta.name) ?? template?.rpgXp ?? 0;
    const rpgCoins = interaction.options.getInteger(coinsMeta.name) ?? template?.rpgCoins ?? 0;
    const rpgItemId = interaction.options.getString(itemMeta.name) ?? template?.rpgItemId ?? null;
    const needValidation = interaction.options.getBoolean(validationMeta.name) ?? template?.needValidation ?? false;

    // On ne résout que l'identifiant : `createGiveaway` vérifie déjà que le
    // salon existe et que le bot peut y écrire, et le dit mieux que nous.
    const channelId = interaction.options.getChannel(channelMeta.name)?.id
      ?? template?.channelId
      ?? interaction.channelId;
    if (!channelId) {
      await interaction.reply({ content: m.gvw_cmd_bad_channel({}, { locale }), flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.reply({ content: m.gvw_cmd_creating({}, { locale }), flags: [MessageFlags.Ephemeral] });
    try {
      const giveaway = await createGiveaway(
        interaction.client,
        guildId,
        channelId,
        prize,
        winners,
        duration,
        description,
        rpgXp,
        rpgCoins,
        rpgItemId,
        needValidation,
        interaction.user.id,
        template?.styleOverrides ?? {},
        template?.ignoreBonuses ?? false
      );
      await interaction.editReply(m.gvw_cmd_created({ id: `\`${giveaway.id}\`` }, { locale }));
    } catch (err) {
      await interaction.editReply(
        publicErrorMessage(err, m.gvw_cmd_create_failed({}, { locale })),
      );
    }
  }
  
  else if (subcommand === endMeta.name) {
    const id = interaction.options.getString(idMeta.name, true).trim();
    const giveaway = await prisma.giveaway.findUnique({ where: { id } });

    if (!giveaway || giveaway.guildId !== guildId) {
      await interaction.reply({ content: m.gvw_cmd_not_found({}, { locale }), flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (giveaway.ended) {
      await interaction.reply({ content: m.gvw_cmd_already_ended({}, { locale }), flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.reply({ content: m.gvw_cmd_ending({}, { locale }), flags: [MessageFlags.Ephemeral] });
    await endGiveaway(interaction.client, id, guildId);
    await interaction.editReply(m.gvw_cmd_ended({ id: `\`${id}\`` }, { locale }));
  } 
  
  else if (subcommand === rerollMeta.name) {
    const id = interaction.options.getString(idMeta.name, true).trim();
    const giveaway = await prisma.giveaway.findUnique({ where: { id } });

    if (!giveaway || giveaway.guildId !== guildId) {
      await interaction.reply({ content: m.gvw_cmd_not_found({}, { locale }), flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (!giveaway.ended) {
      await interaction.reply({ content: m.gvw_cmd_not_ended({}, { locale }), flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.reply({ content: m.gvw_cmd_rerolling({}, { locale }), flags: [MessageFlags.Ephemeral] });
    await rerollGiveaway(interaction.client, id, guildId);
    await interaction.editReply(m.gvw_cmd_rerolled({ id: `\`${id}\`` }, { locale }));
  }
}

/**
 * Complète les deux options qui se saisissent autrement à l'aveugle.
 *
 * Le modèle se désigne par son nom, et une faute de frappe renverrait « modèle
 * introuvable ». L'objet, lui, se désigne par un identifiant que personne ne
 * retient : il fallait aller le chercher dans la section Économie et le
 * recopier, comme le dashboard l'imposait avant son sélecteur.
 */
async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();

  if (focused.name === itemMeta.name) {
    const items = await listGiveawayRpgItems(guildId).catch(() => []);
    const matches = items
      .filter((item) => item.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((item) => ({
        name: `${item.emoji ? `${item.emoji} ` : ''}${item.name}`.slice(0, 100),
        value: item.id,
      }));

    await interaction.respond(matches).catch(() => undefined);
    return;
  }

  const templates = await listGiveawayTemplates(guildId).catch(() => []);
  const matches = templates
    .filter((template) => template.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map((template) => ({ name: `${template.name} — ${template.prize}`.slice(0, 100), value: template.name }));

  await interaction.respond(matches).catch(() => undefined);
}

export const giveawayCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
