/**
 * `/partenariat` - le module Partenariats depuis Discord.
 *
 * Parité avec le dashboard : tout ce qui se décide - proposer, consulter,
 * valider, refuser, publier - se fait ici aussi. Ce qui reste au dashboard,
 * ce sont les écrans de saisie longue (accords, échéanciers, réglages), qu'un
 * formulaire Discord de cinq champs ne peut pas porter.
 *
 * Les actions de staff passent par des boutons plutôt que par des options de
 * commande : décider sur une demande demande de l'avoir sous les yeux, et une
 * liste d'identifiants à recopier est le meilleur moyen de valider la mauvaise.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { PARTNERSHIP_STAGE_META, getPartnershipStage, getPartnershipType } from '@kotbo/contracts';
import type { SlashCommandDefinition } from '../../commands.js';
import prisma from '../../utils/db.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { isPartnershipsActive, getPartnershipSettings } from '../../services/partnerships/partnershipSettings.js';
import { listPartnerships, getPartnershipDetail } from '../../services/partnerships/partnershipService.js';
import { getPartnershipReport } from '../../services/partnerships/partnershipAttributionService.js';
import { publishPromotion, refreshShowcase } from '../../services/partnerships/partnershipPromotionService.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('c_partenariat');

/**
 * Description vide acceptable par Discord.
 *
 * Un embed refuse une description vide. L'espace de largeur nulle est nomme
 * plutot qu'ecrit en clair : un caractere invisible en dur est invisible en
 * revue de code.
 */
const EMPTY_DESCRIPTION = String.fromCharCode(0x200b);

/** Préfixe des composants du module, déclaré dans MODULE_REGISTRY. */
export const PARTNERSHIP_COMPONENT_PREFIX = 'partnership:';

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub
      .setName('liste')
      .setDescription(m.c_partenariat_list_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c_partenariat_list_desc({}, { locale: 'fr' }) })
      .addStringOption((opt) =>
        opt
          .setName('etape')
          .setDescription(m.c_partenariat_list_opt_etape_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c_partenariat_list_opt_etape_desc({}, { locale: 'fr' }) })
          .addChoices(
            ...PARTNERSHIP_STAGE_META.slice(0, 12).map((stage) => ({ name: stage.label, value: stage.key })),
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription(m.c_partenariat_info_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c_partenariat_info_desc({}, { locale: 'fr' }) })
      .addStringOption((opt) =>
        opt
          .setName('nom')
          .setDescription(m.c_partenariat_info_opt_nom_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c_partenariat_info_opt_nom_desc({}, { locale: 'fr' }) })
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('bilan')
      .setDescription(m.c_partenariat_bilan_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c_partenariat_bilan_desc({}, { locale: 'fr' }) })
      .addStringOption((opt) =>
        opt.setName('nom').setDescription('Partenaire').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('proposer')
      .setDescription(m.c_partenariat_propose_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c_partenariat_propose_desc({}, { locale: 'fr' }) }),
  )
  .addSubcommand((sub) =>
    sub
      .setName('demandes')
      .setDescription(m.c_partenariat_demandes_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c_partenariat_demandes_desc({}, { locale: 'fr' }) }),
  )
  .addSubcommand((sub) =>
    sub
      .setName('pub')
      .setDescription(m.c_partenariat_pub_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c_partenariat_pub_desc({}, { locale: 'fr' }) })
      .addStringOption((opt) =>
        opt.setName('nom').setDescription('Partenaire').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('vitrine')
      .setDescription(m.c_partenariat_vitrine_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c_partenariat_vitrine_desc({}, { locale: 'fr' }) }),
  );

/**
 * Droits de staff sur le module.
 *
 * `ManageGuild` et non `Administrator` : c'est la permission que portent les
 * responsables partenariats sur la plupart des serveurs, et le centre de
 * gestion peut de toute façon ouvrir le module côté dashboard.
 */
function isStaff(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    return interaction.reply({ content: m.c_partenariat_guild_only(), flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;
  if (!(await isPartnershipsActive(guildId))) {
    return interaction.reply({ content: m.c_partenariat_module_off(), flags: MessageFlags.Ephemeral });
  }

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'liste':
        return await handleList(interaction, guildId);
      case 'info':
        return await handleInfo(interaction, guildId);
      case 'bilan':
        return await handleReport(interaction, guildId);
      case 'proposer':
        return await handlePropose(interaction, guildId);
      case 'demandes':
        return await handleApplications(interaction, guildId);
      case 'pub':
        return await handlePublish(interaction, guildId);
      case 'vitrine':
        return await handleShowcase(interaction, guildId);
      default:
        return interaction.reply({ content: 'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    return interaction.reply({ content: publicErrorMessage(error), flags: MessageFlags.Ephemeral }).catch(() => null);
  }
}

// ─── Lecture ─────────────────────────────────────────────────────────────────

async function handleList(interaction: ChatInputCommandInteraction, guildId: string) {
  const stage = interaction.options.getString('etape');
  const partnerships = await listPartnerships({
    guildId,
    stages: stage ? [stage] : undefined,
    liveOnly: !stage,
    take: 25,
  });

  if (partnerships.length === 0) {
    return interaction.reply({ content: m.c_partenariat_none(), flags: MessageFlags.Ephemeral });
  }

  const lines = partnerships.map((partnership) => {
    const stageMeta = getPartnershipStage(partnership.stage);
    const typeMeta = getPartnershipType(partnership.type);
    return `• **${partnership.partner.displayName}** - ${typeMeta?.label ?? partnership.type} · ${
      stageMeta?.label ?? partnership.stage
    } · ${partnership.referredJoins} arrivée(s)`;
  });

  const embed = new EmbedBuilder()
    .setTitle(stage ? `Partenariats - ${getPartnershipStage(stage)?.label ?? stage}` : 'Partenariats actifs')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setColor(0x5865f2)
    .setFooter({ text: `${partnerships.length} dossier(s)` });

  // Public : la liste des partenaires n'a rien de confidentiel, et elle sert
  // aussi aux membres qui cherchent les serveurs amis.
  return interaction.reply({ embeds: [embed] });
}

async function findByName(guildId: string, needle: string) {
  return prisma.partnership.findFirst({
    where: {
      guildId,
      OR: [
        { id: needle },
        { partner: { displayName: { contains: needle, mode: 'insensitive' } } },
        { title: { contains: needle, mode: 'insensitive' } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
}

async function handleInfo(interaction: ChatInputCommandInteraction, guildId: string) {
  const needle = interaction.options.getString('nom', true);
  const found = await findByName(guildId, needle);
  if (!found) {
    return interaction.reply({ content: m.c_partenariat_not_found(), flags: MessageFlags.Ephemeral });
  }

  const detail = await getPartnershipDetail(found.id);
  if (!detail) {
    return interaction.reply({ content: m.c_partenariat_not_found(), flags: MessageFlags.Ephemeral });
  }

  const stageMeta = getPartnershipStage(detail.stage);
  const typeMeta = getPartnershipType(detail.type);

  const embed = new EmbedBuilder()
    .setTitle(detail.partner.displayName)
    .setColor(0x5865f2)
    .setDescription(detail.summary?.slice(0, 2000) ?? detail.partner.description?.slice(0, 2000) ?? EMPTY_DESCRIPTION)
    .addFields(
      { name: 'Type', value: typeMeta?.label ?? detail.type, inline: true },
      { name: 'Étape', value: stageMeta?.label ?? detail.stage, inline: true },
      { name: 'Santé', value: `${detail.healthScore}/100`, inline: true },
    );

  if (detail.partner.iconUrl?.startsWith('https://')) embed.setThumbnail(detail.partner.iconUrl);
  if (detail.startAt) {
    embed.addFields({
      name: 'Période',
      value: `${detail.startAt.toLocaleDateString('fr-FR')}${
        detail.endAt ? ` → ${detail.endAt.toLocaleDateString('fr-FR')}` : ''
      }`,
      inline: true,
    });
  }
  if (detail.commitments.length > 0) {
    embed.addFields({
      name: 'Engagements',
      value: detail.commitments
        .slice(0, 6)
        .map((commitment) => `${commitment.state === 'BREACHED' ? '✗' : '✓'} ${commitment.label ?? commitment.kind}`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  if (detail.partner.inviteUrl) {
    embed.addFields({ name: 'Rejoindre', value: detail.partner.inviteUrl });
  }

  // Les notes internes ne sortent jamais dans Discord : elles sont visibles du
  // staff sur le dashboard, pas d'un salon où n'importe qui peut lire.
  return interaction.reply({ embeds: [embed], flags: isStaff(interaction) ? undefined : MessageFlags.Ephemeral });
}

async function handleReport(interaction: ChatInputCommandInteraction, guildId: string) {
  if (!isStaff(interaction)) {
    return interaction.reply({ content: m.c_partenariat_staff_only(), flags: MessageFlags.Ephemeral });
  }

  const found = await findByName(guildId, interaction.options.getString('nom', true));
  if (!found) {
    return interaction.reply({ content: m.c_partenariat_not_found(), flags: MessageFlags.Ephemeral });
  }

  const report = await getPartnershipReport(found.id);
  if (!report) {
    return interaction.reply({ content: m.c_partenariat_not_found(), flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Bilan - ${report.partnership.partner.displayName}`)
    .setColor(report.partnership.healthScore >= 60 ? 0x57f287 : report.partnership.healthScore >= 40 ? 0xfee75c : 0xed4245)
    .addFields(
      { name: 'Arrivées attribuées', value: String(report.joins), inline: true },
      { name: 'Encore présents', value: String(report.stillHere), inline: true },
      { name: 'Rétention', value: report.retentionRate === null ? '-' : `${report.retentionRate}%`, inline: true },
      { name: 'Actifs', value: report.activeRate === null ? '-' : `${report.activeRate}%`, inline: true },
      { name: 'Sanctions reçues', value: String(report.sanctions), inline: true },
      { name: 'Publicités publiées', value: String(report.adsPublished), inline: true },
    )
    .setFooter({ text: `Santé ${report.partnership.healthScore}/100 · confiance ${report.partnership.partner.trustScore}/100` });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── Candidature ─────────────────────────────────────────────────────────────

/**
 * Ouvre le formulaire de candidature. Un modal plutôt que des options de
 * commande : les quatre champs sont longs, et un membre qui se trompe peut
 * corriger avant d'envoyer.
 */
async function handlePropose(interaction: ChatInputCommandInteraction, guildId: string) {
  const settings = await getPartnershipSettings(guildId);
  if (!settings.applicationsOpen) {
    return interaction.reply({ content: m.c_partenariat_applications_closed(), flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`${PARTNERSHIP_COMPONENT_PREFIX}apply`)
    .setTitle(m.c_partenariat_modal_title());

  const fields = [
    new TextInputBuilder()
      .setCustomId('name')
      .setLabel(m.c_partenariat_modal_name().slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(true),
    new TextInputBuilder()
      .setCustomId('invite')
      .setLabel(m.c_partenariat_modal_invite().slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setMaxLength(200)
      .setRequired(false),
    new TextInputBuilder()
      .setCustomId('members')
      .setLabel(m.c_partenariat_modal_members().slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setMaxLength(10)
      .setRequired(false),
    new TextInputBuilder()
      .setCustomId('pitch')
      .setLabel(m.c_partenariat_modal_pitch().slice(0, 45))
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1000)
      .setRequired(true),
  ];

  modal.addComponents(
    ...fields.map((field) => new ActionRowBuilder<TextInputBuilder>().addComponents(field)),
  );

  return interaction.showModal(modal);
}

/** Demandes en attente, avec les boutons de décision sur chacune. */
async function handleApplications(interaction: ChatInputCommandInteraction, guildId: string) {
  if (!isStaff(interaction)) {
    return interaction.reply({ content: m.c_partenariat_staff_only(), flags: MessageFlags.Ephemeral });
  }

  const applications = await prisma.partnerApplication.findMany({
    where: { guildId, status: { in: ['PENDING', 'REVIEWING'] } },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });

  if (applications.length === 0) {
    return interaction.reply({ content: m.c_partenariat_no_pending(), flags: MessageFlags.Ephemeral });
  }

  const embeds = applications.map((application) => {
    const screening = (application.screening as { flags?: string[] } | null)?.flags ?? [];
    const embed = new EmbedBuilder()
      .setTitle(application.projectName.slice(0, 256))
      .setColor(screening.length > 0 ? 0xfee75c : 0x5865f2)
      .setDescription(application.description?.slice(0, 1000) ?? EMPTY_DESCRIPTION)
      .setFooter({ text: `Reçue le ${application.createdAt.toLocaleDateString('fr-FR')}` });

    if (application.memberCount) {
      embed.addFields({ name: 'Membres', value: String(application.memberCount), inline: true });
    }
    if (application.applicantTag) {
      embed.addFields({ name: 'Demandeur', value: application.applicantTag, inline: true });
    }
    if (screening.length > 0) {
      embed.addFields({ name: 'Points de vigilance', value: screening.join('\n').slice(0, 1024) });
    }
    return embed;
  });

  const rows = applications.slice(0, 5).map((application) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PARTNERSHIP_COMPONENT_PREFIX}accept:${application.id}`)
        .setLabel(`Accepter - ${application.projectName.slice(0, 40)}`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${PARTNERSHIP_COMPONENT_PREFIX}reject:${application.id}`)
        .setLabel('Refuser')
        .setStyle(ButtonStyle.Danger),
    ),
  );

  return interaction.reply({ embeds, components: rows, flags: MessageFlags.Ephemeral });
}

// ─── Publication ─────────────────────────────────────────────────────────────

async function handlePublish(interaction: ChatInputCommandInteraction, guildId: string) {
  if (!isStaff(interaction)) {
    return interaction.reply({ content: m.c_partenariat_staff_only(), flags: MessageFlags.Ephemeral });
  }

  const found = await findByName(guildId, interaction.options.getString('nom', true));
  if (!found) {
    return interaction.reply({ content: m.c_partenariat_not_found(), flags: MessageFlags.Ephemeral });
  }

  const promotion = await prisma.partnershipPromotion.findFirst({
    where: { partnershipId: found.id, direction: 'GRANTED', active: true },
    select: { id: true },
  });
  if (!promotion) {
    return interaction.reply({ content: m.c_partenariat_publish_failed(), flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const published = await publishPromotion(promotion.id, interaction.client);
  return interaction.editReply({
    content: published ? m.c_partenariat_published() : m.c_partenariat_publish_failed(),
  });
}

async function handleShowcase(interaction: ChatInputCommandInteraction, guildId: string) {
  if (!isStaff(interaction)) {
    return interaction.reply({ content: m.c_partenariat_staff_only(), flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const live = await prisma.partnership.findMany({
    where: { guildId, stage: { in: ['ACTIVE', 'RENEWAL'] } },
    select: { id: true },
    take: 50,
  });
  for (const partnership of live) await refreshShowcase(partnership.id, interaction.client);

  return interaction.editReply({ content: m.c_partenariat_showcase_done({ count: live.length }) });
}

// ─── Autocomplétion ──────────────────────────────────────────────────────────

/**
 * Propose les partenaires du serveur. Sans cela, `nom` obligerait à connaître
 * l'orthographe exacte, et le premier réflexe serait de coller un identifiant.
 */
async function autocomplete(interaction: Parameters<NonNullable<SlashCommandDefinition['autocomplete']>>[0]) {
  if (!interaction.guildId) return interaction.respond([]);

  const focused = interaction.options.getFocused().toString().slice(0, 100);
  const partnerships = await prisma.partnership.findMany({
    where: {
      guildId: interaction.guildId,
      stage: { notIn: ['ARCHIVED', 'REJECTED'] },
      ...(focused ? { partner: { displayName: { contains: focused, mode: 'insensitive' as const } } } : {}),
    },
    include: { partner: { select: { displayName: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 25,
  });

  return interaction.respond(
    partnerships.map((partnership) => ({
      name: `${partnership.partner.displayName} (${getPartnershipStage(partnership.stage)?.label ?? partnership.stage})`.slice(0, 100),
      value: partnership.id,
    })),
  );
}

export const partnershipCommand: SlashCommandDefinition = { data, execute, autocomplete };
