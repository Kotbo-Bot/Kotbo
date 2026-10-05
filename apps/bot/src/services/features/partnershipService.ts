// ============================================================================
// PARTENARIATS / DEMANDES DE BÊTA-TEST
// Candidature via le formulaire "Retour / Suggestion" du dashboard →
// MP récap au candidat + invitation vers le serveur HQ.
// Au join du serveur (ou immédiatement s'il y est déjà), un ticket est
// automatiquement ouvert avec le staff, contenant la candidature complète.
// ============================================================================

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
  type Client,
  type ColorResolvable,
  type Guild,
  type GuildMember,
  type OverwriteResolvable,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { upsertRetryingRace } from '../../utils/upsertRetry.js';
import { logger } from '../../utils/logger.js';
import { admitJoiningMember } from '../moderation/joinAdmissionService.js';
import { buildTicketChannelName } from './ticketService.js';
import { INVITE_SOURCE, recordBotInvite } from '../analytics/inviteService.js';

export const PARTNERSHIP_GUILD_ID = process.env.PARTNERSHIP_GUILD_ID || '1477350874740424986';

export type PartnershipCategory = 'partenariat' | 'beta';

export type PartnershipApplicationInput = {
  category: PartnershipCategory;
  projectName: string;
  projectUrl?: string | null;
  memberCount?: string | null;
  description: string;
  motivation: string;
  experience?: string | null;
  availability?: string | null;
  contact?: string | null;
};

type PartnershipApplicationRecord = PartnershipApplicationInput & {
  id: string;
  userId: string;
  userTag: string | null;
  status: string;
  createdAt: Date;
};

const CATEGORY_META: Record<PartnershipCategory, { label: string; emoji: string; color: number }> = {
  partenariat: { label: 'Partenariat', emoji: '🤝', color: 0x8b5cf6 },
  beta: { label: 'Bêta-test', emoji: '🧪', color: 0x06b6d4 },
};

async function fetchPartnershipGuild(client: Client): Promise<Guild | null> {
  return (
    client.guilds.cache.get(PARTNERSHIP_GUILD_ID) ||
    (await client.guilds.fetch(PARTNERSHIP_GUILD_ID).catch(() => null))
  );
}

// ============================================================================
// RÉCAP (partagé entre le MP et le ticket)
// ============================================================================

function buildRecapEmbed(app: PartnershipApplicationRecord): EmbedBuilder {
  const meta = CATEGORY_META[app.category as PartnershipCategory] ?? CATEGORY_META.partenariat;

  const embed = new EmbedBuilder()
    .setTitle(`${meta.emoji} Candidature ${meta.label} - ${app.projectName.slice(0, 200)}`)
    .setColor(meta.color)
    .setTimestamp(app.createdAt)
    .setFooter({ text: `Kotbo · Candidature ID: ${app.id}` })
    .addFields(
      { name: '👤 Candidat', value: `<@${app.userId}> (\`${app.userId}\`)`, inline: true },
      { name: '📌 Type de demande', value: meta.label, inline: true },
      { name: '🏷️ Projet / Serveur', value: app.projectName.slice(0, 1000) }
    );

  if (app.projectUrl) embed.addFields({ name: '🔗 Lien', value: app.projectUrl.slice(0, 1000), inline: true });
  if (app.memberCount) embed.addFields({ name: '👥 Nombre de membres', value: app.memberCount.slice(0, 100), inline: true });
  embed.addFields(
    { name: '📝 Description du projet', value: app.description.slice(0, 1000) },
    { name: '💡 Motivation', value: app.motivation.slice(0, 1000) }
  );
  if (app.experience) embed.addFields({ name: '🎓 Expérience', value: app.experience.slice(0, 1000) });
  if (app.availability) embed.addFields({ name: '📅 Disponibilité', value: app.availability.slice(0, 1000) });
  if (app.contact) embed.addFields({ name: '📬 Autre moyen de contact', value: app.contact.slice(0, 500) });

  return embed;
}

// ============================================================================
// INVITATION
// ============================================================================

async function createPartnershipInvite(guild: Guild): Promise<string | null> {
  const me = guild.members.me;
  const candidates = [
    guild.rulesChannel,
    guild.systemChannel,
    ...guild.channels.cache
      .filter(c => c.isTextBased() && !c.isThread() && !!me && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite))
      .values(),
  ];

  for (const channel of candidates) {
    if (!channel || channel.isThread() || !('createInvite' in channel)) continue;
    const invite = await channel
      .createInvite({ maxAge: 7 * 24 * 60 * 60, maxUses: 1, unique: true, reason: 'Candidature partenariat / bêta-test' })
      .catch(() => null);
    if (invite) {
      await recordBotInvite(invite, INVITE_SOURCE.partnership());
      return invite.url;
    }
  }
  return null;
}

// ============================================================================
// TICKET AUTOMATIQUE (candidat + staff)
// ============================================================================

async function createPartnershipTicket(
  client: Client,
  app: PartnershipApplicationRecord
): Promise<{ ticketId: string; channelId: string } | null> {
  const guild = await fetchPartnershipGuild(client);
  if (!guild) {
    logger.error('Partnership', `Serveur partenariat ${PARTNERSHIP_GUILD_ID} introuvable`);
    return null;
  }

  const member = await guild.members.fetch(app.userId).catch(() => null);
  if (!member) return null;

  // FK Ticket → Guild : s'assurer que la ligne existe
  await upsertRetryingRace(() => prisma.guild.upsert({ where: { id: guild.id }, update: {}, create: { id: guild.id } }));

  const guildConfig = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: { ticketCategoryId: true, ticketStaffRoleId: true, ticketEmbedColor: true },
  });

  const memberPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  const permissionOverwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: app.userId, allow: memberPermissions },
  ];
  const staffRoleId = guildConfig?.ticketStaffRoleId;
  if (staffRoleId) {
    permissionOverwrites.push({
      id: staffRoleId,
      allow: [...memberPermissions, PermissionFlagsBits.ManageMessages],
    });
  }

  const meta = CATEGORY_META[app.category as PartnershipCategory] ?? CATEGORY_META.partenariat;

  try {
    const ticketChannel = await guild.channels.create({
      name: buildTicketChannelName(`${app.category}-${member.user.username}`, app.userId),
      type: ChannelType.GuildText,
      parent: guildConfig?.ticketCategoryId || null,
      permissionOverwrites,
      reason: `Candidature ${meta.label} de ${member.user.tag}`,
    });

    const ticket = await prisma.ticket.create({
      data: {
        guildId: guild.id,
        channelId: ticketChannel.id,
        userId: app.userId,
        username: member.user.username,
        reason: `${meta.emoji} Candidature ${meta.label}`,
        description: `${app.projectName} - ${app.description}`.slice(0, 1500),
        status: 'OPEN',
      },
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
      new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
      new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );

    const configuredColor = guildConfig?.ticketEmbedColor;
    const recapColor: ColorResolvable = configuredColor && /^#?[0-9a-f]{6}$/i.test(configuredColor)
      ? (configuredColor.startsWith('#') ? configuredColor : `#${configuredColor}`) as ColorResolvable
      : meta.color;
    const recap = buildRecapEmbed(app).setColor(recapColor);

    await ticketChannel.send({
      content: `${staffRoleId ? `<@&${staffRoleId}> ` : ''}<@${app.userId}> 🔔 Bienvenue ! Ta candidature **${meta.label}** a bien été transmise au staff, qui va l'étudier ici avec toi.`,
      embeds: [recap],
      components: [row],
    });

    await prisma.partnershipApplication.update({
      where: { id: app.id },
      data: { status: 'TICKET_CREATED', ticketId: ticket.id, ticketChannelId: ticketChannel.id },
    });

    logger.success('Partnership', `Ticket ${ticket.id} créé pour la candidature ${app.id} (${member.user.tag})`);
    return { ticketId: ticket.id, channelId: ticketChannel.id };
  } catch (err) {
    logger.error('Partnership', `Échec de création du ticket pour la candidature ${app.id}:`, err);
    return null;
  }
}

// ============================================================================
// SOUMISSION (appelée par la route dashboard)
// ============================================================================

export type PartnershipSubmitResult =
  | { ok: true; alreadyMember: boolean; dmDelivered: boolean; inviteUrl: string | null }
  | { ok: false; error: string };

export async function submitPartnershipApplication(
  client: Client,
  user: { id: string; username?: string },
  input: PartnershipApplicationInput
): Promise<PartnershipSubmitResult> {
  const existing = await prisma.partnershipApplication.findFirst({
    where: { userId: user.id, status: { in: ['AWAITING_JOIN', 'TICKET_CREATED'] } },
  });
  if (existing) {
    return { ok: false, error: 'Tu as déjà une candidature en cours de traitement.' };
  }

  const guild = await fetchPartnershipGuild(client);
  if (!guild) {
    return { ok: false, error: 'Le serveur de partenariat est indisponible pour le moment. Réessaie plus tard.' };
  }

  // @ts-expect-error - Prisma client needs to be regenerated by user to recognize partnershipApplication
  const app: PartnershipApplicationRecord = await prisma.partnershipApplication.create({
    data: {
      userId: user.id,
      userTag: user.username ?? null,
      category: input.category,
      projectName: input.projectName,
      projectUrl: input.projectUrl || null,
      memberCount: input.memberCount || null,
      description: input.description,
      motivation: input.motivation,
      experience: input.experience || null,
      availability: input.availability || null,
      contact: input.contact || null,
      status: 'AWAITING_JOIN',
    },
  });

  const isMember = !!(await guild.members.fetch(user.id).catch(() => null));
  const meta = CATEGORY_META[input.category];
  const recap = buildRecapEmbed(app);

  let inviteUrl: string | null = null;
  let dmDelivered = false;
  let ticketChannelId: string | null = null;

  if (isMember) {
    const ticket = await createPartnershipTicket(client, app);
    ticketChannelId = ticket?.channelId ?? null;
  } else {
    inviteUrl = await createPartnershipInvite(guild);
  }

  const dmLines = isMember
    ? [
        `${meta.emoji} **Ta candidature ${meta.label} a bien été envoyée !** En voici le récapitulatif.`,
        ticketChannelId
          ? `\n🎫 Comme tu es déjà sur **${guild.name}**, un ticket vient d'être ouvert avec le staff pour étudier ta candidature : <#${ticketChannelId}>`
          : `\n🎫 Comme tu es déjà sur **${guild.name}**, le staff va ouvrir un ticket avec toi très rapidement.`,
      ]
    : [
        `${meta.emoji} **Ta candidature ${meta.label} a bien été envoyée !** En voici le récapitulatif.`,
        `\n⚠️ **Important : pour que ta demande soit prise en compte, tu dois rejoindre le serveur ${guild.name}.**`,
        inviteUrl
          ? `👉 ${inviteUrl}`
          : "👉 (invitation indisponible - contacte un administrateur pour être invité)",
        `\nDès que tu auras rejoint, un ticket sera **automatiquement ouvert** entre toi et le staff avec ta candidature.`,
      ];

  try {
    const discordUser = await client.users.fetch(user.id);
    await discordUser.send({ content: dmLines.join('\n'), embeds: [recap] });
    dmDelivered = true;
  } catch {
    logger.warn('Partnership', `MP impossible vers ${user.id} (MP fermés ?)`);
  }

  await prisma.partnershipApplication.update({
    where: { id: app.id },
    data: { inviteUrl, dmDelivered },
  });

  return { ok: true, alreadyMember: isMember, dmDelivered, inviteUrl };
}

// ============================================================================
// LISTENER : ticket automatique quand le candidat rejoint le serveur
// ============================================================================

export async function handlePartnershipGuildJoin(client: Client, member: GuildMember): Promise<void> {
  if (member.guild.id !== PARTNERSHIP_GUILD_ID || member.user.bot) return;

  // @ts-expect-error - Prisma client needs to be regenerated by user to recognize partnershipApplication
  const app: PartnershipApplicationRecord | null = await prisma.partnershipApplication.findFirst({
    where: { userId: member.id, status: 'AWAITING_JOIN' },
    orderBy: { createdAt: 'desc' },
  });
  if (!app) return;

  await createPartnershipTicket(client, app);
}

export function registerPartnershipListener(client: Client): void {
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    try {
      if (!(await admitJoiningMember(member))) return;
      await handlePartnershipGuildJoin(client, member);
    } catch (err) {
      logger.error('Partnership', `Erreur au join de ${member.user.tag}:`, err);
    }
  });
  logger.success('Partnership', 'Écouteur partenariat/bêta-test enregistré (guildMemberAdd)');
}
