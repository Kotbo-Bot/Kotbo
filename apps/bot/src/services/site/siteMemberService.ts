/**
 * Membres du site communautaire : réglages (profil public, notifications) et
 * données du profil public.
 *
 * Le profil public est visible par défaut ; le membre peut le masquer depuis
 * son espace. La bio n'y figure que si le membre l'a rendue publique dans son
 * profil Kotbo : elle a pu être écrite en la croyant privée.
 */

import type { Client } from 'discord.js';
import { normalizeSiteNotifications, type SiteNotificationPrefs } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { getMemberIdentities } from '../moderation/memberIdentityService.js';

export interface SiteMemberSettingsView {
  profileHidden: boolean;
  notifications: SiteNotificationPrefs;
  dailyStreak: number;
}

export async function getSiteMemberSettings(guildId: string, userId: string): Promise<SiteMemberSettingsView> {
  const row = await prisma.siteMemberSettings.findUnique({ where: { guildId_userId: { guildId, userId } } });
  return {
    profileHidden: row?.profileHidden ?? false,
    notifications: normalizeSiteNotifications(row?.notifications),
    dailyStreak: row?.dailyStreak ?? 0,
  };
}

export async function updateSiteMemberSettings(
  guildId: string,
  userId: string,
  input: { profileHidden?: unknown; notifications?: unknown },
): Promise<SiteMemberSettingsView> {
  const data: { profileHidden?: boolean; notifications?: SiteNotificationPrefs } = {};
  if (typeof input.profileHidden === 'boolean') data.profileHidden = input.profileHidden;
  if (input.notifications !== undefined) data.notifications = normalizeSiteNotifications(input.notifications);
  await prisma.siteMemberSettings.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, ...data },
    update: data,
  });
  return getSiteMemberSettings(guildId, userId);
}

export interface PublicMemberProfile {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  bio: string | null;
  joinedAt: Date | null;
  isStaff: boolean;
  level: { level: number; xp: number; rank: number } | null;
  reputation: number;
  messageCount: number;
  voiceHours: number;
}

/**
 * Profil public d'un membre, ou `null` : inconnu du serveur, parti, ou profil
 * masqué. Les bots n'ont pas de profil.
 */
export async function getPublicMemberProfile(client: Client, guildId: string, userId: string): Promise<PublicMemberProfile | null> {
  if (!/^\d{17,20}$/.test(userId)) return null;
  const [member, settings] = await Promise.all([
    prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { isBot: true, guildLeftAt: true, guildJoinedAt: true, bio: true, isProfilePrivate: true, username: true, messageCount: true, voiceTimeSeconds: true },
    }),
    prisma.siteMemberSettings.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { profileHidden: true } }),
  ]);
  if (!member || member.isBot || member.guildLeftAt || settings?.profileHidden) return null;

  const [identities, level, rep, staff] = await Promise.all([
    getMemberIdentities(client, guildId, [userId]),
    prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { xp: true, level: true } }),
    prisma.reputationVote.aggregate({ where: { guildId, receiverId: userId }, _sum: { value: true } }),
    prisma.staffMember.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { id: true } }),
  ]);
  const identity = identities.get(userId);
  const rank = level ? (await prisma.memberLevel.count({ where: { guildId, xp: { gt: level.xp } } })) + 1 : null;
  return {
    userId,
    displayName: identity?.displayName ?? member.username ?? userId,
    username: member.username,
    avatarUrl: identity?.avatarUrl ?? null,
    bio: member.isProfilePrivate === false && member.bio ? member.bio : null,
    joinedAt: member.guildJoinedAt,
    isStaff: Boolean(staff),
    level: level && rank ? { level: level.level, xp: level.xp, rank } : null,
    reputation: rep._sum.value ?? 0,
    messageCount: member.messageCount,
    voiceHours: Math.round(member.voiceTimeSeconds / 3600),
  };
}
