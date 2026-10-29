import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, PermissionFlagsBits, SeparatorSpacingSize, type Guild, type GuildMember, type User } from 'discord.js';
import { Prisma, SanctionType, type MemberProfile } from '@prisma/client';
import prisma from '../../utils/db.js';
import { resolveMemberAvatarUrl, resolveUserAvatarUrl } from './memberIdentityService.js';
import { mediaGallery, sectionOld, separatorOld, text, thumbnailOld, truncate } from '../../utils/embeds.js';
import { E, buildProgressBar } from '../../utils/emojis.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';
import { formatDurationFr, getSanctionTypeBreakdown, listSanctionsByMember, type ListedSanction } from './sanctionService.js';
import * as altAccountService from './altAccountService.js';
import { getCrossServerSanctionSummary, type CrossServerSanctionSummary } from './crossServerSanctionService.js';
import { generateMemberStatsImage } from '../core/imageService.js';

export type MemberCaseSection = 'resume' | 'sanctions' | 'identite' | 'activite';

// 4 sanctions par page : chaque carte active consomme jusqu'à 3 composants V2
// (section + texte + bouton Révoquer) et le message est plafonné à 40 composants.
export const MEMBER_CASE_PAGE_SIZE = 4;

export type MemberCasePanel = {
  components: Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;
  section: MemberCaseSection;
  pageIndex: number;
  totalPages: number;
  files?: import('discord.js').AttachmentBuilder[];
};

type MemberCaseContext = {
  guild: Guild;
  user: User | null;
  member: GuildMember | null;
  profile: MemberProfile | null;
  banned: boolean;
  sanctions: ListedSanction[];
  sanctionsTotal: number;
  sanctionsBreakdown: Record<SanctionType, number>;
  crossServer: CrossServerSanctionSummary;
  linkedUserIds: string[];
  pageIndex: number;
  totalPages: number;
};

type MemberProfileSnapshot = {
  guildId: string;
  userId: string;
  userTag?: string | null;
  username?: string | null;
  globalName?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  accentColor?: number | null;
  locale?: string | null;
  isBot?: boolean;
  accountCreatedAt?: Date | null;
  guildJoinedAt?: Date | null;
  guildLeftAt?: Date | null;
  lastSeenAt?: Date | null;
  lastMessageAt?: Date | null;
  lastMessageChannelId?: string | null;
  messageCountDelta?: number;
  voiceSessionCountDelta?: number;
  voiceTimeSecondsDelta?: number;
  voiceLastChannelId?: string | null;
  voiceLastJoinedAt?: Date | null;
  voiceLastLeftAt?: Date | null;
  rolesSnapshot?: string[];
};

async function upsertMemberProfile(snapshot: MemberProfileSnapshot): Promise<void> {
  const now = new Date();
  const nextRolesSnapshot = snapshot.rolesSnapshot ?? [];

  const updateData: Prisma.MemberProfileUpdateInput = {
    userTag: snapshot.userTag ?? undefined,
    username: snapshot.username ?? undefined,
    globalName: snapshot.globalName ?? undefined,
    displayName: snapshot.displayName ?? undefined,
    avatarUrl: snapshot.avatarUrl ?? undefined,
    bannerUrl: snapshot.bannerUrl ?? undefined,
    accentColor: snapshot.accentColor ?? undefined,
    locale: snapshot.locale ?? undefined,
    isBot: snapshot.isBot ?? undefined,
    accountCreatedAt: snapshot.accountCreatedAt ?? undefined,
    guildJoinedAt: snapshot.guildJoinedAt ?? undefined,
    // `null` efface la date de départ, `undefined` n'y touche pas. Réduire les
    // deux à `undefined` laissait « parti » un membre revenu sur le serveur.
    guildLeftAt: snapshot.guildLeftAt,
    lastSeenAt: snapshot.lastSeenAt ?? now,
    lastMessageAt: snapshot.lastMessageAt ?? undefined,
    lastMessageChannelId: snapshot.lastMessageChannelId ?? undefined,
    voiceLastChannelId: snapshot.voiceLastChannelId ?? undefined,
    voiceLastJoinedAt: snapshot.voiceLastJoinedAt ?? undefined,
    voiceLastLeftAt: snapshot.voiceLastLeftAt ?? undefined,
    rolesSnapshot: nextRolesSnapshot,
  };

  if (snapshot.messageCountDelta && snapshot.messageCountDelta > 0) {
    updateData.messageCount = { increment: snapshot.messageCountDelta };
  }

  if (snapshot.voiceSessionCountDelta && snapshot.voiceSessionCountDelta > 0) {
    updateData.voiceSessionCount = { increment: snapshot.voiceSessionCountDelta };
  }

  if (snapshot.voiceTimeSecondsDelta && snapshot.voiceTimeSecondsDelta > 0) {
    updateData.voiceTimeSeconds = { increment: snapshot.voiceTimeSecondsDelta };
  }

  try {
    await prisma.memberProfile.upsert({
      where: {
        guildId_userId: {
          guildId: snapshot.guildId,
          userId: snapshot.userId,
        },
      },
      create: {
        guildId: snapshot.guildId,
        userId: snapshot.userId,
        userTag: snapshot.userTag ?? null,
        username: snapshot.username ?? null,
        globalName: snapshot.globalName ?? null,
        displayName: snapshot.displayName ?? null,
        avatarUrl: snapshot.avatarUrl ?? null,
        bannerUrl: snapshot.bannerUrl ?? null,
        accentColor: snapshot.accentColor ?? null,
        locale: snapshot.locale ?? null,
        isBot: snapshot.isBot ?? false,
        accountCreatedAt: snapshot.accountCreatedAt ?? null,
        guildJoinedAt: snapshot.guildJoinedAt ?? null,
        guildLeftAt: snapshot.guildLeftAt ?? null,
        lastSeenAt: snapshot.lastSeenAt ?? now,
        lastMessageAt: snapshot.lastMessageAt ?? null,
        lastMessageChannelId: snapshot.lastMessageChannelId ?? null,
        messageCount: snapshot.messageCountDelta && snapshot.messageCountDelta > 0 ? snapshot.messageCountDelta : 0,
        voiceSessionCount: snapshot.voiceSessionCountDelta && snapshot.voiceSessionCountDelta > 0 ? snapshot.voiceSessionCountDelta : 0,
        voiceTimeSeconds: snapshot.voiceTimeSecondsDelta && snapshot.voiceTimeSecondsDelta > 0 ? snapshot.voiceTimeSecondsDelta : 0,
        voiceLastChannelId: snapshot.voiceLastChannelId ?? null,
        voiceLastJoinedAt: snapshot.voiceLastJoinedAt ?? null,
        voiceLastLeftAt: snapshot.voiceLastLeftAt ?? null,
        rolesSnapshot: nextRolesSnapshot,
      },
      update: updateData,
    });
  } catch (err: unknown) {
    // Defensive: if DB schema is not in sync with Prisma (missing columns), avoid crashing the whole flow.
    // Log the error and continue. Migration should be applied to fix the root cause.
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.error('MemberProfile', `Upsert failed for ${snapshot.guildId}/${snapshot.userId}: ${String(err)}`);
    } catch { /* ignored */ }
    return;
  }
}

async function fetchGuildUserContext(guild: Guild, userId: string, pageIndex = 0): Promise<MemberCaseContext> {
  const linkedUserIds = await altAccountService.getAllLinkedUserIds(guild.id, userId);

  const [user, member, profile, bans, sanctions] = await Promise.all([
    guild.client.users.fetch(userId, { force: true }).catch(() => guild.client.users.cache.get(userId) ?? null),
    guild.members.cache.get(userId) ?? guild.members.fetch(userId).catch(() => null),
    prisma.memberProfile.findUnique({
      where: {
        guildId_userId: {
          guildId: guild.id,
          userId,
        },
      },
    }),
    guild.bans.fetch(userId).catch(() => null),
    listSanctionsByMember({
      guildId: guild.id,
      targetUserId: userId,
      targetUserIds: linkedUserIds,
      page: pageIndex,
      pageSize: MEMBER_CASE_PAGE_SIZE,
    }),
  ]);

  const [sanctionsBreakdown, crossServer] = await Promise.all([
    getSanctionTypeBreakdown(guild.id, userId, linkedUserIds),
    getCrossServerSanctionSummary(guild.client, guild.id, linkedUserIds),
  ]);
  const totalPages = Math.max(1, Math.ceil(sanctions.total / MEMBER_CASE_PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const pageSanctions = safePageIndex === pageIndex
    ? sanctions.sanctions
    : (await listSanctionsByMember({
        guildId: guild.id,
        targetUserId: userId,
        targetUserIds: linkedUserIds,
        page: safePageIndex,
        pageSize: MEMBER_CASE_PAGE_SIZE,
      })).sanctions;

  return {
    guild,
    user,
    member,
    profile,
    banned: Boolean(bans),
    sanctions: pageSanctions,
    sanctionsTotal: sanctions.total,
    sanctionsBreakdown,
    crossServer,
    linkedUserIds: linkedUserIds.filter((id) => id !== userId),
    pageIndex: safePageIndex,
    totalPages,
  };
}

const CROSS_SERVER_TYPE_LABELS: Record<SanctionType, string> = {
  WARN: 'Warn',
  KICK: 'Kick',
  TIMEOUT: 'Timeout',
  TEMP_BAN: 'Tempban',
  BAN: 'Ban',
  SOFTBAN: 'Softban',
  JAIL: 'Jail',
};

/**
 * Construit le texte du bloc "casier cross-serveur" affiché dans l'embed des sanctions.
 * Retourne null s'il n'y a rien de pertinent à montrer.
 */
function buildCrossServerFieldValue(crossServer: CrossServerSanctionSummary): string | null {
  if (!crossServer.enabled || crossServer.total === 0) return null;

  const lines = crossServer.recent.slice(0, 5).map((entry) => {
    const label = CROSS_SERVER_TYPE_LABELS[entry.type] ?? entry.type;
    const duration = entry.durationSeconds ? ` · ${formatDurationFr(entry.durationSeconds * 1000)}` : '';
    const when = `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:R>`;
    const state = entry.status === 'ACTIVE' ? '🔴' : '⚪';
    const reason = entry.reason.trim() ? `\n┗ *${truncate(entry.reason.trim(), 90)}*` : '';
    return `${state} **${label}**${duration} · ${truncate(entry.guildName, 30)} · ${when}${reason}`;
  });

  const breakdown = Object.entries(crossServer.breakdown)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${CROSS_SERVER_TYPE_LABELS[type as SanctionType]} ×${count}`)
    .join(' · ');

  const extra = crossServer.total > 5 ? `\n*… et ${crossServer.total - 5} autre(s)*` : '';
  const footer = breakdown ? `\n\`${breakdown}\`` : '';

  return `${lines.join('\n')}${extra}${footer}`;
}

function getDashboardMemberUrl(userId: string): string {
  let base = process.env.DASHBOARD_URL || 'http://localhost:5173';
  try {
    base = getCurrentInstance().dashboardUrl || base;
  } catch { /* instance non initialisée : fallback env */ }
  return `${base.replace(/\/$/, '')}/members/${userId}`;
}

const SECTION_TABS: Array<{ section: MemberCaseSection; label: string; emojiKey: string }> = [
  { section: 'resume', label: 'Résumé', emojiKey: 'info' },
  { section: 'sanctions', label: 'Sanctions', emojiKey: 'moderation' },
  { section: 'identite', label: 'Identité', emojiKey: 'profile' },
  { section: 'activite', label: 'Activité', emojiKey: 'stats' },
];

function buildTabsRow(userId: string, active: MemberCaseSection): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    SECTION_TABS.map(({ section: tabSection, label, emojiKey }) =>
      new ButtonBuilder()
        // Réutilise la route `refresh` : cliquer un onglet = re-rendre la section demandée
        // (l'onglet actif sert donc aussi de bouton "Actualiser").
        .setCustomId(`case:refresh:${userId}:${tabSection}:0`)
        .setLabel(label)
        .setEmoji(E[emojiKey])
        .setStyle(active === tabSection ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
}

function buildQuickSanctionRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`case:sanction:${userId}:warn`).setLabel('Warn').setEmoji(E.warning).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`case:sanction:${userId}:timeout`).setLabel('Timeout').setEmoji(E.mute).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`case:sanction:${userId}:kick`).setLabel('Kick').setEmoji(E.kick).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`case:sanction:${userId}:ban`).setLabel('Ban').setEmoji(E.ban).setStyle(ButtonStyle.Danger),
  );
}

function buildFooterRow(userId: string, section: MemberCaseSection, pageIndex: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (section === 'sanctions') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`case:prev:${userId}:${section}:${pageIndex}`)
        .setLabel('Précédent')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIndex <= 0 || totalPages <= 1),
      new ButtonBuilder()
        .setCustomId(`case:next:${userId}:${section}:${pageIndex}`)
        .setLabel('Suivant')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIndex >= totalPages - 1 || totalPages <= 1),
    );
  }

  row.addComponents(
    new ButtonBuilder().setLabel('Dashboard').setEmoji(E.link).setStyle(ButtonStyle.Link).setURL(getDashboardMemberUrl(userId)),
    new ButtonBuilder().setCustomId(`case:close:${userId}`).setLabel('Fermer').setStyle(ButtonStyle.Danger),
  );

  return row;
}

function buildCaseTargetRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`case:open:${userId}`)
      .setLabel('Voir le casier')
      .setEmoji(E.moderation)
      .setStyle(ButtonStyle.Primary),
  );
}

const MODERATOR_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
];

function getPermissionLabel(member: GuildMember | null): string {
  if (!member) return 'Inconnu';
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return 'Administrateur';
  if (MODERATOR_PERMISSIONS.some((perm) => member.permissions.has(perm))) return 'Modérateur';
  return 'Membre';
}

const USER_FLAG_EMOJIS: Record<string, string> = {
  Staff: '🛠️',
  Partner: '🎫',
  Hypesquad: '🎉',
  HypeSquadOnlineHouse1: '🦁',
  HypeSquadOnlineHouse2: '🧠',
  HypeSquadOnlineHouse3: '⚖️',
  BugHunterLevel1: '🐛',
  BugHunterLevel2: '🐞',
  PremiumEarlySupporter: '🌟',
  VerifiedDeveloper: '👨‍💻',
  CertifiedModerator: '🛡️',
  VerifiedBot: '✅',
  ActiveDeveloper: '💻',
};

function getFlagsDisplay(user: User | null, isBot: boolean): string {
  const emojis: string[] = [];
  for (const flag of user?.flags?.toArray() ?? []) {
    const emoji = USER_FLAG_EMOJIS[flag];
    if (emoji && !emojis.includes(emoji)) emojis.push(emoji);
  }
  if (isBot) emojis.push('🤖');
  return emojis.length > 0 ? emojis.join(' ') : 'Aucun';
}

function getRolesCount(member: GuildMember | null): number {
  if (!member) return 0;
  return member.roles.cache.filter((role) => role.id !== member.guild.id).size;
}

const SANCTION_TYPE_EMOJI_KEY: Record<SanctionType, string> = {
  WARN: 'warning',
  KICK: 'kick',
  TIMEOUT: 'mute',
  TEMP_BAN: 'ban',
  BAN: 'ban',
  SOFTBAN: 'ban',
  JAIL: 'mute',
};

type CaseIdentity = {
  userId: string;
  username: string;
  globalName: string;
  displayName: string;
  statusLabel: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
};

function getCaseIdentity(context: MemberCaseContext): CaseIdentity {
  const { profile, user, member } = context;
  const userId = user?.id ?? profile?.userId ?? member?.id ?? 'inconnu';
  const username = user?.username ?? profile?.username ?? member?.user.username ?? 'inconnu';
  const globalName = user?.globalName ?? profile?.globalName ?? member?.user.globalName ?? username;

  return {
    userId,
    username,
    globalName,
    displayName: member?.displayName ?? profile?.displayName ?? globalName,
    statusLabel: member
      ? `${E.success} Membre du serveur`
      : context.banned
        ? `${E.ban} Banni du serveur`
        : `${E.error} Ancien membre`,
    avatarUrl: resolveMemberAvatarUrl(member, 256) ?? resolveUserAvatarUrl(user, 256) ?? profile?.avatarUrl ?? null,
    bannerUrl: user?.bannerURL({ size: 1024 }) ?? profile?.bannerUrl ?? null,
  };
}

/**
 * Tronc commun de toutes les sections du casier : en-tête identité (avatar,
 * statut), bannière optionnelle, puis rangée d'onglets de navigation.
 */
function addCaseHeader(
  container: ContainerBuilder,
  context: MemberCaseContext,
  active: MemberCaseSection,
  opts?: { withBanner?: boolean },
): CaseIdentity {
  const identity = getCaseIdentity(context);
  const headerText = `### ${E.moderation} ${identity.displayName}\n<@${identity.userId}> (\`${identity.username}\`)\n${identity.statusLabel}`;

  if (identity.avatarUrl) {
    container.addSectionComponents(sectionOld(headerText, thumbnailOld(identity.avatarUrl)));
  } else {
    container.addTextDisplayComponents(text(headerText));
  }

  if (opts?.withBanner && identity.bannerUrl) {
    container.addMediaGalleryComponents(mediaGallery(identity.bannerUrl));
  }

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
  container.addActionRowComponents(buildTabsRow(identity.userId, active));
  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Large));

  return identity;
}

function addCaseFooter(container: ContainerBuilder, context: MemberCaseContext, sectionName: MemberCaseSection, identity: CaseIdentity): void {
  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Large));
  if (sectionName === 'resume') {
    container.addActionRowComponents(buildQuickSanctionRow(identity.userId));
  }
  container.addActionRowComponents(buildFooterRow(identity.userId, sectionName, context.pageIndex, context.totalPages));
}

function buildSummaryContainer(context: MemberCaseContext): ContainerBuilder {
  const profile = context.profile;
  const user = context.user;
  const member = context.member;

  const container = new ContainerBuilder()
    .setAccentColor(context.banned ? 0xd62828 : member ? 0x2a9d8f : 0x5865f2);
  const identity = addCaseHeader(container, context, 'resume', { withBanner: true });

  const accountCreatedAt = user?.createdTimestamp
    ? `<t:${Math.floor(user.createdTimestamp / 1000)}:d> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)`
    : profile?.accountCreatedAt
      ? `<t:${Math.floor(profile.accountCreatedAt.getTime() / 1000)}:d> (<t:${Math.floor(profile.accountCreatedAt.getTime() / 1000)}:R>)`
      : 'Inconnue';

  const joinedAt = member?.joinedTimestamp
    ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:d> (<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`
    : profile?.guildJoinedAt
      ? `<t:${Math.floor(profile.guildJoinedAt.getTime() / 1000)}:d> (<t:${Math.floor(profile.guildJoinedAt.getTime() / 1000)}:R>)`
      : 'Inconnue';

  const rolesCount = getRolesCount(member);
  const dateLines = [
    `${E.calendar} **Création du compte** ${accountCreatedAt}`,
    `${E.clock} **Membre depuis** ${joinedAt}`,
  ];
  if (!member && !context.banned) {
    const leftAt = profile?.guildLeftAt
      ? `<t:${Math.floor(profile.guildLeftAt.getTime() / 1000)}:d> (<t:${Math.floor(profile.guildLeftAt.getTime() / 1000)}:R>)`
      : 'Inconnue';
    dateLines.push(`${E.arrow} **Dernier départ** ${leftAt}`);
  }
  if (member?.premiumSinceTimestamp) {
    const boostTs = Math.floor(member.premiumSinceTimestamp / 1000);
    dateLines.push(`${E.star} **Boost depuis** <t:${boostTs}:d> (<t:${boostTs}:R>)`);
  }
  dateLines.push(`${E.shield} **Permissions :** \`${getPermissionLabel(member)}\` (**${rolesCount}** rôle${rolesCount > 1 ? 's' : ''})`);
  dateLines.push(`${E.dot} **Flags :** ${getFlagsDisplay(user, profile?.isBot ?? user?.bot ?? false)}`);
  container.addTextDisplayComponents(text(dateLines.join('\n')));

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));

  const msgCount = profile?.messageCount ?? 0;
  const lastMsg = profile?.lastMessageAt ? `<t:${Math.floor(profile.lastMessageAt.getTime() / 1000)}:R>` : 'Aucun';
  const voiceTime = formatDurationFr((profile?.voiceTimeSeconds ?? 0) * 1000);
  const lastVoice = profile?.voiceLastChannelId ? `<#${profile.voiceLastChannelId}>` : 'Aucun';
  container.addTextDisplayComponents(
    text(`${E.messages} **Messages :** ${msgCount} *(Dernier : ${lastMsg})*\n${E.voice} **Vocal :** ${voiceTime} *(Dernier : ${lastVoice})*`),
  );

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));

  const noteButton = new ButtonBuilder()
    .setCustomId(`case:note:${identity.userId}`)
    .setLabel('Modifier')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary);
  container.addSectionComponents(
    sectionOld(`**📝 Note de modération**\n${profile?.moderatorNote ? `> ${profile.moderatorNote.replace(/\n/g, '\n> ')}` : '*Aucune note.*'}`, noteButton),
  );

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));

  const recentSanctions = context.sanctions.length > 0
    ? context.sanctions.slice(0, 3).map((s) => {
        const emoji = E[SANCTION_TYPE_EMOJI_KEY[s.type]] ?? E.moderation;
        return `${emoji} **${s.type}** · ${truncate(s.reason, 60)} · <t:${Math.floor(s.createdAt.getTime() / 1000)}:R>`;
      }).join('\n')
    : '*Aucune sanction enregistrée pour ce membre.*';
  const crossServerLine = context.crossServer.enabled && context.crossServer.total > 0
    ? `\n🌐 **Autres serveurs :** ${context.crossServer.total} sanction${context.crossServer.total > 1 ? 's' : ''} sur ${context.crossServer.serverCount} serveur${context.crossServer.serverCount > 1 ? 's' : ''}`
    : '';
  container.addTextDisplayComponents(
    text(`**${E.moderation} Dernières sanctions (${context.sanctions.length}/${context.sanctionsTotal})**\n${recentSanctions}${crossServerLine}`),
  );

  if (context.linkedUserIds.length > 0) {
    container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
    const linked = context.linkedUserIds.slice(0, 3);
    container.addTextDisplayComponents(
      text(`**${E.link} Comptes liés (${context.linkedUserIds.length})**\n${linked.map((id) => `<@${id}>`).join(' · ')}${context.linkedUserIds.length > 3 ? ` *+${context.linkedUserIds.length - 3} autre(s)*` : ''}`),
    );
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        linked.map((id, index) =>
          new ButtonBuilder()
            .setCustomId(`case:open:${id}`)
            .setLabel(`Casier lié ${index + 1}`)
            .setEmoji(E.link)
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    );
  }

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(text(`-# \`ID\` \`${identity.userId}\``));

  addCaseFooter(container, context, 'resume', identity);
  return container;
}

function buildIdentityContainer(context: MemberCaseContext): ContainerBuilder {
  const profile = context.profile;
  const user = context.user;

  const container = new ContainerBuilder().setAccentColor(0x8ecae6);
  const identity = addCaseHeader(container, context, 'identite');

  const userTag = user?.tag ?? profile?.userTag ?? context.member?.user.tag ?? `Utilisateur ${identity.userId}`;
  const locale = profile?.locale ?? (user as { locale?: string | null } | null)?.locale ?? 'Inconnue';
  const accentColor = profile?.accentColor != null
    ? `#${profile.accentColor.toString(16).padStart(6, '0')}`
    : 'Inconnue';

  container.addTextDisplayComponents(
    text([
      `${E.profile} **Tag complet** ${userTag}`,
      `${E.dot} **Nom d'utilisateur** \`${identity.username}\``,
      `${E.dot} **Nom global** ${identity.globalName}`,
      `${E.dot} **Pseudo serveur** \`${identity.displayName}\``,
      `${E.dot} **Locale** ${locale}`,
      `${E.dot} **Compte bot** ${profile?.isBot || user?.bot ? 'Oui 🤖' : 'Non'}`,
      `${E.dot} **Couleur d'accent** ${accentColor}`,
      `${E.dot} **Flags** ${getFlagsDisplay(user, profile?.isBot ?? user?.bot ?? false)}`,
    ].join('\n')),
  );

  if (identity.bannerUrl) {
    container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
    container.addMediaGalleryComponents(mediaGallery(identity.bannerUrl));
  }

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(text(`-# \`ID\` \`${identity.userId}\``));

  addCaseFooter(container, context, 'identite', identity);
  return container;
}

export type ActivityExtras = {
  activeDays: number;
  totalMessages14d: number;
  totalVoiceMinutes14d: number;
  serverAvgMessages: number;
  serverAvgVoiceSeconds: number;
};

function buildActivityBar(value: number, average: number): string {
  // 50 % de barre = pile dans la moyenne du serveur, 100 % = double ou plus.
  const ratio = value / Math.max(average, 1);
  const percent = Math.max(0, Math.min(100, ratio * 50));
  const label = ratio >= 0.95 && ratio <= 1.05 ? 'dans la moyenne' : `×${ratio.toFixed(1)} de la moyenne`;
  return `${buildProgressBar(percent, 8)} *${label}*`;
}

function buildActivityContainer(context: MemberCaseContext, extras?: ActivityExtras, withChart = false): ContainerBuilder {
  const profile = context.profile;

  const container = new ContainerBuilder().setAccentColor(0xffb703);
  const identity = addCaseHeader(container, context, 'activite');

  const kpiParts = [
    `${E.messages} **${profile?.messageCount ?? 0}** messages`,
    `${E.voice} **${formatDurationFr((profile?.voiceTimeSeconds ?? 0) * 1000)}** en vocal`,
    `${E.calendar} **${profile?.voiceSessionCount ?? 0}** sessions vocales`,
  ];
  if (extras) {
    kpiParts.push(`${E.fire} **${extras.activeDays}**/14 jours actifs`);
  }
  container.addTextDisplayComponents(text(kpiParts.join(' · ')));

  if (extras) {
    container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(
      text([
        `**${E.stats} Comparé au serveur**`,
        `${E.messages} Messages ${buildActivityBar(profile?.messageCount ?? 0, extras.serverAvgMessages)}`,
        `${E.voice} Vocal ${buildActivityBar(profile?.voiceTimeSeconds ?? 0, extras.serverAvgVoiceSeconds)}`,
      ].join('\n')),
    );
  }

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));

  const lastVoice = profile?.voiceLastChannelId ? `<#${profile.voiceLastChannelId}>` : 'Aucun';
  const lastVoiceJoin = profile?.voiceLastJoinedAt
    ? `<t:${Math.floor(profile.voiceLastJoinedAt.getTime() / 1000)}:R>`
    : 'Inconnu';
  container.addTextDisplayComponents(
    text([
      `${E.messages} **Dernier message** ${profile?.lastMessageAt ? `<t:${Math.floor(profile.lastMessageAt.getTime() / 1000)}:R>` : 'Aucun'} ${profile?.lastMessageChannelId ? `dans <#${profile.lastMessageChannelId}>` : ''}`,
      `${E.voice} **Dernier vocal** ${lastVoiceJoin} dans ${lastVoice}`,
    ].join('\n')),
  );

  const roles = context.member
    ? [...context.member.roles.cache.values()]
        .filter((role) => role.id !== context.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((role) => `<@&${role.id}>`)
    : (profile?.rolesSnapshot ?? []).map((roleId) => `<@&${roleId}>`);
  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(
    text(`**${E.crown} Rôles (${roles.length})**\n${roles.length > 0 ? truncate(roles.slice(0, 20).join(' '), 900) : 'Aucun'}`),
  );

  if (withChart) {
    container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
    container.addMediaGalleryComponents(mediaGallery('attachment://activity_stats.png'));
  }

  addCaseFooter(container, context, 'activite', identity);
  return container;
}

// Fonction (et non constante) : E est un proxy rafraîchi après le chargement
// des emojis d'application, il faut donc résoudre au moment du rendu.
function sanctionStatusLabel(status: string): string {
  if (status === 'ACTIVE') return `${E.dnd} Active`;
  if (status === 'RESOLVED') return `${E.offline} Résolue`;
  if (status === 'FAILED') return `${E.error} Échouée`;
  return status;
}

function buildSanctionsContainer(context: MemberCaseContext): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(0xef476f);
  const identity = addCaseHeader(container, context, 'sanctions');

  if (context.sanctions.length === 0) {
    container.addTextDisplayComponents(text(`${E.success} *Aucune sanction sur cette page.*`));
  }

  context.sanctions.forEach((sanction, index) => {
    if (index > 0) container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));

    const emoji = E[SANCTION_TYPE_EMOJI_KEY[sanction.type]] ?? E.moderation;
    const statusLabel = sanctionStatusLabel(sanction.status);
    const duration = sanction.durationSeconds ? ` · ${formatDurationFr(sanction.durationSeconds * 1000)}` : '';
    const moderator = sanction.moderatorTag ?? `<@${sanction.moderatorUserId}>`;
    const cardText = [
      `${emoji} **${sanction.type}**${duration} · ${statusLabel} · <t:${Math.floor(sanction.createdAt.getTime() / 1000)}:R>`,
      `> ${truncate(sanction.reason, 140)}`,
      `-# Par ${moderator}`,
    ].join('\n');

    if (sanction.status === 'ACTIVE' && sanction.type !== 'KICK') {
      container.addSectionComponents(
        sectionOld(
          cardText,
          new ButtonBuilder()
            .setCustomId(`case:revoke:${identity.userId}:${sanction.id}:${context.pageIndex}`)
            .setLabel('Révoquer')
            .setEmoji(E.unlock)
            .setStyle(ButtonStyle.Danger),
        ),
      );
    } else {
      container.addTextDisplayComponents(text(cardText));
    }
  });

  container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));

  const b = context.sanctionsBreakdown;
  container.addTextDisplayComponents(
    text(`**Total ${context.sanctionsTotal}** · ${E.warning} ${b.WARN ?? 0} · ${E.mute} ${b.TIMEOUT ?? 0} · ${E.kick} ${b.KICK ?? 0} · ${E.ban} ${(b.BAN ?? 0) + (b.TEMP_BAN ?? 0) + (b.SOFTBAN ?? 0)}`),
  );

  const crossServerValue = buildCrossServerFieldValue(context.crossServer);
  if (crossServerValue) {
    container.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(
      text(`**🌐 Autres serveurs (${context.crossServer.total} · ${context.crossServer.serverCount} serveur${context.crossServer.serverCount > 1 ? 's' : ''})**\n${truncate(crossServerValue, 1000)}`),
    );
  }

  container.addSeparatorComponents(separatorOld(false, SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(text(`-# Page ${context.pageIndex + 1} / ${context.totalPages}`));

  addCaseFooter(container, context, 'sanctions', identity);
  return container;
}

export async function touchMemberProfileFromMember(member: GuildMember): Promise<void> {
  await upsertMemberProfile({
    guildId: member.guild.id,
    userId: member.id,
    userTag: member.user.tag,
    username: member.user.username,
    globalName: member.user.globalName,
    displayName: member.displayName,
    avatarUrl: resolveMemberAvatarUrl(member, 256),
    bannerUrl: null,
    accentColor: member.user.accentColor,
    locale: null,
    isBot: member.user.bot,
    accountCreatedAt: member.user.createdAt,
    guildJoinedAt: member.joinedAt ?? null,
    guildLeftAt: null,
    lastSeenAt: new Date(),
    rolesSnapshot: [...member.roles.cache.keys()].filter((roleId) => roleId !== member.guild.id),
  });
}

export async function touchMemberProfileFromUser(guildId: string, user: User, extra?: Partial<MemberProfileSnapshot>): Promise<void> {
  await upsertMemberProfile({
    guildId,
    userId: user.id,
    userTag: user.tag,
    username: user.username,
    globalName: user.globalName,
    displayName: extra?.displayName ?? user.globalName ?? user.username,
    avatarUrl: resolveUserAvatarUrl(user, 256),
    bannerUrl: null,
    accentColor: user.accentColor,
    locale: extra?.locale ?? null,
    isBot: user.bot,
    accountCreatedAt: user.createdAt,
    guildJoinedAt: extra?.guildJoinedAt ?? null,
    guildLeftAt: extra?.guildLeftAt ?? null,
    lastSeenAt: extra?.lastSeenAt ?? new Date(),
    lastMessageAt: extra?.lastMessageAt ?? null,
    lastMessageChannelId: extra?.lastMessageChannelId ?? null,
    rolesSnapshot: extra?.rolesSnapshot ?? [],
  });
}

const lastProfileTouch = new Map<string, number>();
const profileMessageCountBuffer = new Map<string, number>();

async function flushProfileMessageCounts(): Promise<void> {
  const entries = [...profileMessageCountBuffer.entries()];
  if (entries.length === 0) return;

  for (const [key, delta] of entries) {
    const [guildId, userId] = key.split(':');
    if (!guildId || !userId) continue;

    profileMessageCountBuffer.delete(key);
    lastProfileTouch.set(key, Date.now());

    await prisma.memberProfile.update({
      where: { guildId_userId: { guildId, userId } },
      data: {
        messageCount: { increment: delta },
        guildLeftAt: null,
        lastSeenAt: new Date(),
      }
    }).catch(() => {
      // Ignorer si le profil n'existe pas en base encore
    });
  }
}

setInterval(() => { void flushProfileMessageCounts(); }, 60_000);

process.on('beforeExit', () => {
  void flushProfileMessageCounts();
});

export async function touchMemberMessageActivity(params: {
  guildId: string;
  user: User;
  channelId: string;
  displayName?: string | null;
}): Promise<void> {
  const key = `${params.guildId}:${params.user.id}`;
  const now = Date.now();
  const lastTouch = lastProfileTouch.get(key) ?? 0;

  profileMessageCountBuffer.set(key, (profileMessageCountBuffer.get(key) ?? 0) + 1);

  if (now - lastTouch < 30_000) {
    return;
  }

  lastProfileTouch.set(key, now);
  const delta = profileMessageCountBuffer.get(key) ?? 1;
  profileMessageCountBuffer.delete(key);

  await upsertMemberProfile({
    guildId: params.guildId,
    userId: params.user.id,
    userTag: params.user.tag,
    username: params.user.username,
    globalName: params.user.globalName,
    displayName: params.displayName ?? params.user.globalName ?? params.user.username,
    avatarUrl: params.user.displayAvatarURL({ size: 256 }),
    accentColor: params.user.accentColor,
    isBot: params.user.bot,
    accountCreatedAt: params.user.createdAt,
    // Écrire sur le serveur, c'est y être : rattrape un retour dont l'arrivée
    // n'a pas été vue (bot coupé, module de journaux éteint).
    guildLeftAt: null,
    lastSeenAt: new Date(),
    lastMessageAt: new Date(),
    lastMessageChannelId: params.channelId,
    messageCountDelta: delta,
  });
}

export async function touchMemberVoiceJoin(params: {
  guildId: string;
  user: User;
  channelId: string;
  displayName?: string | null;
  joinedAt?: Date | null;
}): Promise<void> {
  await upsertMemberProfile({
    guildId: params.guildId,
    userId: params.user.id,
    userTag: params.user.tag,
    username: params.user.username,
    globalName: params.user.globalName,
    displayName: params.displayName ?? params.user.globalName ?? params.user.username,
    avatarUrl: params.user.displayAvatarURL({ size: 256 }),
    accentColor: params.user.accentColor,
    isBot: params.user.bot,
    accountCreatedAt: params.user.createdAt,
    lastSeenAt: new Date(),
    voiceSessionCountDelta: 1,
    voiceLastChannelId: params.channelId,
    voiceLastJoinedAt: params.joinedAt ?? new Date(),
    voiceLastLeftAt: null,
  });
}

export async function touchMemberVoiceLeave(params: {
  guildId: string;
  user: User;
  channelId: string;
  displayName?: string | null;
  joinedAt?: Date | null;
  durationSeconds?: number | null;
}): Promise<void> {
  await upsertMemberProfile({
    guildId: params.guildId,
    userId: params.user.id,
    userTag: params.user.tag,
    username: params.user.username,
    globalName: params.user.globalName,
    displayName: params.displayName ?? params.user.globalName ?? params.user.username,
    avatarUrl: params.user.displayAvatarURL({ size: 256 }),
    accentColor: params.user.accentColor,
    isBot: params.user.bot,
    accountCreatedAt: params.user.createdAt,
    lastSeenAt: new Date(),
    voiceLastChannelId: params.channelId,
    voiceLastJoinedAt: params.joinedAt ?? undefined,
    voiceLastLeftAt: new Date(),
    voiceTimeSecondsDelta: params.durationSeconds && params.durationSeconds > 0 ? params.durationSeconds : 0,
  });
}

export async function touchMemberJoin(member: GuildMember): Promise<void> {
  await touchMemberProfileFromMember(member);
}

export async function touchMemberLeave(params: {
  guildId: string;
  user: User;
  displayName?: string | null;
  guildJoinedAt?: Date | null;
}): Promise<void> {
  await upsertMemberProfile({
    guildId: params.guildId,
    userId: params.user.id,
    userTag: params.user.tag,
    username: params.user.username,
    globalName: params.user.globalName,
    displayName: params.displayName ?? params.user.globalName ?? params.user.username,
    avatarUrl: params.user.displayAvatarURL({ size: 256 }),
    accentColor: params.user.accentColor,
    isBot: params.user.bot,
    accountCreatedAt: params.user.createdAt,
    guildJoinedAt: params.guildJoinedAt ?? undefined,
    guildLeftAt: new Date(),
    lastSeenAt: new Date(),
  });
}

export async function touchSanctionTargetIdentity(params: {
  guildId: string;
  userId: string;
  userTag?: string | null;
}): Promise<void> {
  await upsertMemberProfile({
    guildId: params.guildId,
    userId: params.userId,
    userTag: params.userTag ?? null,
    lastSeenAt: new Date(),
  });
}

export async function buildMemberCasePanel(
  guild: Guild,
  userId: string,
  section: MemberCaseSection = 'resume',
  pageIndex = 0,
): Promise<MemberCasePanel> {
  const contextPageIndex = section === 'sanctions' ? pageIndex : 0;
  const context = await fetchGuildUserContext(guild, userId, contextPageIndex);

  let panelContainer: ContainerBuilder;
  let files: import('discord.js').AttachmentBuilder[] | undefined;

  if (section === 'sanctions') {
    panelContainer = buildSanctionsContainer(context);
  } else if (section === 'identite') {
    panelContainer = buildIdentityContainer(context);
  } else if (section === 'activite') {
    let extras: ActivityExtras | undefined;
    let chartAttachment: AttachmentBuilder | undefined;

    try {
      const periodDays = 14;
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - periodDays);
      const startDateKey = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, '0')}-${String(sinceDate.getDate()).padStart(2, '0')}`;

      const [dailyStats, serverAvg] = await Promise.all([
        prisma.memberDailyStat.findMany({
          where: { guildId: guild.id, userId, dateKey: { gte: startDateKey } },
          orderBy: { dateKey: 'asc' },
        }),
        prisma.memberProfile.aggregate({
          where: { guildId: guild.id, isBot: false },
          _avg: { messageCount: true, voiceTimeSeconds: true },
        }),
      ]);

      const activeDays = dailyStats.length;
      let totalMessages = 0;
      let totalVoice = 0;
      let peakDayMessages = 0;

      const dailyData = dailyStats.map(stat => {
        totalMessages += stat.messagesCount;
        totalVoice += stat.voiceMinutes;
        if (stat.messagesCount > peakDayMessages) peakDayMessages = stat.messagesCount;
        return {
          date: stat.dateKey,
          messages: stat.messagesCount,
          voice: stat.voiceMinutes,
        };
      });

      extras = {
        activeDays,
        totalMessages14d: totalMessages,
        totalVoiceMinutes14d: totalVoice,
        serverAvgMessages: serverAvg._avg.messageCount ?? 0,
        serverAvgVoiceSeconds: serverAvg._avg.voiceTimeSeconds ?? 0,
      };

      const username = context.user?.username ?? context.profile?.username ?? context.member?.user.username ?? 'inconnu';

      const imageBuffer = await generateMemberStatsImage(
        username,
        periodDays,
        { totalMessages, totalVoice, activeDays, peakDayMessages },
        dailyData
      );

      chartAttachment = new AttachmentBuilder(imageBuffer, { name: 'activity_stats.png' });
    } catch (error) {
      import('../../utils/logger.js').then(({ logger }) => {
        logger.error('Casier', `Erreur de génération du graphique d'activité: ${String(error)}`);
      });
    }

    panelContainer = buildActivityContainer(context, extras, Boolean(chartAttachment));
    if (chartAttachment) files = [chartAttachment];
  } else {
    panelContainer = buildSummaryContainer(context);
  }

  return {
    components: [panelContainer],
    section,
    pageIndex: context.pageIndex,
    totalPages: context.totalPages,
    files,
  };
}

export function buildMemberCaseActionRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return buildCaseTargetRow(userId);
}

export async function getMemberCaseFooterLabel(guild: Guild, userId: string): Promise<string> {
  const profile = await prisma.memberProfile.findUnique({
    where: {
      guildId_userId: {
        guildId: guild.id,
        userId,
      },
    },
  });

  return profile?.userTag ?? `Utilisateur ${userId}`;
}
