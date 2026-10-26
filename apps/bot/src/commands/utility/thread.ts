/**
 * /fil : gère le fil où l'on se trouve.
 *
 * `renommer` couvre les fils de l'auto-thread et ceux des panneaux de
 * discussion. Les autres sous-commandes reprennent les actions du menu
 * « Gérer » des panneaux, pour qui préfère taper que cliquer.
 *
 * Le bot est le créateur de ces fils : Discord ne laisse donc que les
 * modérateurs (Gérer les fils) les administrer. Ces commandes ouvrent les
 * actions à l'auteur, selon la configuration qui a ouvert le fil.
 */
import type { SlashCommandDefinition } from '../../commands.js';
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';
import { THREAD_PANEL_SLOWMODE_SECONDS } from '@kotbo/shared';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getCommandMetadata, getEffectiveLocale } from '../../utils/i18n.js';
import { canRenameAutoThread } from '../../services/features/autoThreadService.js';
import { getPanelThread, runThreadAction, type ThreadAction } from '../../services/features/threadPanelService.js';
import { buildManageMenu } from '../../events/threadPanel.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b4_thread');
const renameMeta = getCommandMetadata('b4_thread_rename');

type OptionKind = 'none' | 'member' | 'message' | 'seconds';

/** Sous-commandes des panneaux : nom anglais, nom français, descriptions, option attendue. */
const PANEL_SUBCOMMANDS: Array<{ action: ThreadAction | 'manage'; en: string; fr: string; descEn: string; descFr: string; option: OptionKind }> = [
  { action: 'manage', en: 'manage', fr: 'gerer', descEn: 'Open the thread controls', descFr: 'Ouvre les commandes du fil', option: 'none' },
  { action: 'close', en: 'close', fr: 'fermer', descEn: 'Close (archive) the thread', descFr: 'Ferme (archive) le fil', option: 'none' },
  { action: 'reopen', en: 'reopen', fr: 'rouvrir', descEn: 'Reopen the thread', descFr: 'Rouvre le fil', option: 'none' },
  { action: 'lock', en: 'lock', fr: 'verrouiller', descEn: 'Only moderators can post anymore', descFr: 'Seuls les modérateurs peuvent encore écrire', option: 'none' },
  { action: 'unlock', en: 'unlock', fr: 'deverrouiller', descEn: 'Unlock the thread', descFr: 'Déverrouille le fil', option: 'none' },
  { action: 'slowmode', en: 'slowmode', fr: 'lent', descEn: 'Set a delay between two messages', descFr: 'Impose un délai entre deux messages', option: 'seconds' },
  { action: 'pin', en: 'pin', fr: 'epingler', descEn: 'Pin a message of the thread', descFr: 'Épingle un message du fil', option: 'message' },
  { action: 'add', en: 'add', fr: 'ajouter', descEn: 'Add a member to the thread', descFr: 'Ajoute un membre au fil', option: 'member' },
  { action: 'remove', en: 'remove', fr: 'retirer', descEn: 'Remove a member from the thread', descFr: 'Retire un membre du fil', option: 'member' },
  { action: 'ban', en: 'ban', fr: 'bannir', descEn: 'Remove a member and keep them out', descFr: 'Retire un membre et l’empêche de revenir', option: 'member' },
  { action: 'unban', en: 'unban', fr: 'debannir', descEn: 'Let a banned member back', descFr: 'Laisse revenir un membre banni', option: 'member' },
  { action: 'trust', en: 'trust', fr: 'confiance', descEn: 'Give a member the thread controls', descFr: 'Donne les commandes du fil à un membre', option: 'member' },
  { action: 'untrust', en: 'untrust', fr: 'retirer-confiance', descEn: 'Take the thread controls back', descFr: 'Reprend les commandes du fil à un membre', option: 'member' },
  { action: 'transfer', en: 'transfer', fr: 'transferer', descEn: 'Give the thread to another member', descFr: 'Confie le fil à un autre membre', option: 'member' },
  { action: 'claim', en: 'claim', fr: 'reclamer', descEn: 'Take over a thread whose owner is gone', descFr: 'Reprend un fil dont le propriétaire est parti', option: 'none' },
  { action: 'resolve', en: 'resolve', fr: 'resolu', descEn: 'Mark the forum post resolved', descFr: 'Marque le post de forum résolu', option: 'none' },
];

function addPanelSubcommand(sub: SlashCommandSubcommandBuilder, def: (typeof PANEL_SUBCOMMANDS)[number]) {
  sub.setName(def.en).setNameLocalizations({ fr: def.fr }).setDescription(def.descEn).setDescriptionLocalizations({ fr: def.descFr });
  if (def.option === 'member') {
    sub.addUserOption((o) => o.setName('member').setNameLocalizations({ fr: 'membre' }).setDescription('Member').setDescriptionLocalizations({ fr: 'Membre' }).setRequired(true));
  } else if (def.option === 'message') {
    sub.addStringOption((o) => o.setName('message').setDescription('Message link or ID').setDescriptionLocalizations({ fr: 'Lien ou identifiant du message' }).setRequired(true).setMaxLength(200));
  } else if (def.option === 'seconds') {
    sub.addIntegerOption((o) => o
      .setName('seconds')
      .setNameLocalizations({ fr: 'secondes' })
      .setDescription('Delay, 0 to turn off')
      .setDescriptionLocalizations({ fr: 'Délai, 0 pour couper' })
      .setRequired(true)
      .addChoices(...THREAD_PANEL_SLOWMODE_SECONDS.map((s) => ({ name: String(s), value: s }))));
  }
  return sub;
}

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName(renameMeta.name)
      .setNameLocalizations(renameMeta.nameLocalizations)
      .setDescription(renameMeta.description)
      .setDescriptionLocalizations(renameMeta.descriptionLocalizations)
      .addStringOption((option) =>
        option
          .setName('name')
          .setNameLocalizations({ fr: 'nom' })
          .setDescription(m.b4_thread_rename_opt_name({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b4_thread_rename_opt_name({}, { locale: 'fr' }) })
          .setMinLength(1)
          .setMaxLength(100)
          .setRequired(true),
      ),
  );
for (const def of PANEL_SUBCOMMANDS) data.addSubcommand((sub) => addPanelSubcommand(sub, def));

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const title = m.thread_rename_title({}, { locale });
  const fail = (text: string) => interaction.reply({ embeds: [errorEmbed(title, text)], flags: [MessageFlags.Ephemeral] });

  const thread = interaction.channel;
  if (!interaction.inCachedGuild() || !thread?.isThread()) {
    await fail(m.thread_rename_not_thread({}, { locale }));
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const record = await getPanelThread(thread.id);
  const ctx = record ? { thread, member: interaction.member, record, locale } : null;

  if (subcommand !== renameMeta.name) {
    const def = PANEL_SUBCOMMANDS.find((d) => d.en === subcommand);
    if (!def) return;
    if (!ctx) {
      await fail(locale === 'fr' ? 'Ce fil n’a pas été ouvert par un panneau de discussion.' : 'This thread wasn’t opened by a discussion panel.');
      return;
    }
    if (def.action === 'manage') {
      await interaction.reply({ ...(await buildManageMenu(ctx)), flags: [MessageFlags.Ephemeral] });
      return;
    }
    const values = def.option === 'member'
      ? [interaction.options.getUser('member', true).id]
      : def.option === 'message'
        ? [interaction.options.getString('message', true)]
        : def.option === 'seconds' ? [String(interaction.options.getInteger('seconds', true))] : [];
    // Fermer un fil peut prendre un instant : on accuse réception d'abord.
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const result = await runThreadAction(ctx, def.action, values);
    await interaction.editReply({ embeds: [(result.ok ? successEmbed : errorEmbed)(`/${meta.name} ${subcommand}`, result.message)] });
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  if (!name || name.length > 100) {
    await fail(m.thread_rename_invalid({}, { locale }));
    return;
  }

  if (ctx) {
    const result = await runThreadAction(ctx, 'rename', [name]);
    await interaction.reply({ embeds: [(result.ok ? successEmbed : errorEmbed)(title, result.message)], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const isModerator = interaction.member.permissionsIn(thread).has(PermissionFlagsBits.ManageThreads);
  const refusal = await canRenameAutoThread(thread.id, interaction.user.id, isModerator);
  if (refusal === 'not_auto_thread') {
    await fail(m.thread_rename_not_auto({}, { locale }));
    return;
  }
  if (refusal === 'not_allowed') {
    await fail(m.thread_rename_not_allowed({}, { locale }));
    return;
  }

  const renamed = await thread.setName(name, `Renommé par ${interaction.user.tag} (/fil renommer)`).catch(() => null);
  if (!renamed) {
    await fail(m.thread_rename_failed({}, { locale }));
    return;
  }

  await interaction.reply({
    embeds: [successEmbed(title, m.thread_rename_done({ name }, { locale }))],
    flags: [MessageFlags.Ephemeral],
  });
}

export const threadCommand = { data, execute } satisfies SlashCommandDefinition;
