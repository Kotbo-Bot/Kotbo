import prisma from '../../utils/db.js';
import { getStaffMember } from '../staff/staffManagementService.js';

type PublicEventParticipation = {
  id: string;
  eventId: string;
  eventTitle: string;
  eventType: string;
  createdAt: Date;
  score: number;
};

type PublicInvite = {
  inviteCode: string | null;
  inviterId: string | null;
  inviterTag: string | null;
  joinedAt: Date;
};

export type PublicProfileSnapshot = {
  memberProfile: {
    id: string;
    guildId: string;
    userId: string;
    userTag: string | null;
    username: string | null;
    globalName: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    bannerUrl: string | null;
    accentColor: number | null;
    locale: string | null;
    isBot: boolean;
    bio: string | null;
    isProfilePrivate: boolean;
    accountCreatedAt: Date | null;
    guildJoinedAt: Date | null;
    guildLeftAt: Date | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
    lastMessageAt: Date | null;
    lastMessageChannelId: string | null;
    messageCount: number;
    voiceSessionCount: number;
    voiceTimeSeconds: number;
    voiceLastChannelId: string | null;
    voiceLastJoinedAt: Date | null;
    voiceLastLeftAt: Date | null;
    rolesSnapshot: string[];
    isSuspectedDC: boolean;
    moderatorNote: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  invite: PublicInvite | null;
  eventParticipations: PublicEventParticipation[];
};

type StaffGradeHistoryEntry = {
  id: string;
  action: string;
  details: string;
  module: string;
  eventType: string;
  user: string;
  dateIso: Date;
};

export type StaffProfileSnapshot = {
  staffMember: NonNullable<Awaited<ReturnType<typeof getStaffMember>>>;
  publicProfile: PublicProfileSnapshot['memberProfile'] | null;
  activeBlacklist: Awaited<ReturnType<typeof prisma.staffBlacklist.findFirst>>;
  blacklistHistory: Awaited<ReturnType<typeof prisma.staffBlacklist.findMany>>;
  warnings: Awaited<ReturnType<typeof prisma.staffWarning.findMany>>;
  testingPeriods: Awaited<ReturnType<typeof prisma.testingPeriod.findMany>>;
  activities: Awaited<ReturnType<typeof prisma.staffActivity.findMany>>;
  apiKeys: Awaited<ReturnType<typeof prisma.aPIKey.findMany>>;
  absences: Awaited<ReturnType<typeof prisma.staffAbsence.findMany>>;
  notesWritten: Awaited<ReturnType<typeof prisma.staffManagerNote.findMany>>;
  notesAbout: Awaited<ReturnType<typeof prisma.staffManagerNote.findMany>>;
  gradeHistory: StaffGradeHistoryEntry[];
  stats: {
    totalMessages: number;
    totalVoiceMinutes: number;
    activeWarnings: number;
    sanctionsIssued: number;
    testsCompleted: number;
  };
};

export async function getPublicProfileSnapshot(userId: string, guildId?: string): Promise<PublicProfileSnapshot | null> {
  const memberProfile = await prisma.memberProfile.findFirst({
    where: guildId ? { userId, guildId } : { userId },
    orderBy: guildId ? undefined : { updatedAt: 'desc' },
  });

  if (!memberProfile) {
    return null;
  }

  const [invite, eventParticipations] = await Promise.all([
    prisma.memberInvite.findFirst({
      where: {
        guildId: memberProfile.guildId,
        userId,
      },
      orderBy: { joinedAt: 'desc' },
    }),
    prisma.eventParticipant.findMany({
      where: {
        guildId: memberProfile.guildId,
        userId,
      },
      include: {
        event: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
  ]);

  return {
    memberProfile: {
      id: memberProfile.id,
      guildId: memberProfile.guildId,
      userId: memberProfile.userId,
      userTag: memberProfile.userTag,
      username: memberProfile.username,
      globalName: memberProfile.globalName,
      displayName: memberProfile.displayName,
      avatarUrl: memberProfile.avatarUrl,
      bannerUrl: memberProfile.bannerUrl,
      accentColor: memberProfile.accentColor,
      locale: memberProfile.locale,
      isBot: memberProfile.isBot,
      bio: memberProfile.bio ?? null,
      isProfilePrivate: memberProfile.isProfilePrivate,
      accountCreatedAt: memberProfile.accountCreatedAt,
      guildJoinedAt: memberProfile.guildJoinedAt,
      guildLeftAt: memberProfile.guildLeftAt,
      firstSeenAt: memberProfile.firstSeenAt,
      lastSeenAt: memberProfile.lastSeenAt,
      lastMessageAt: memberProfile.lastMessageAt,
      lastMessageChannelId: memberProfile.lastMessageChannelId,
      messageCount: memberProfile.messageCount,
      voiceSessionCount: memberProfile.voiceSessionCount,
      voiceTimeSeconds: memberProfile.voiceTimeSeconds,
      voiceLastChannelId: memberProfile.voiceLastChannelId,
      voiceLastJoinedAt: memberProfile.voiceLastJoinedAt,
      voiceLastLeftAt: memberProfile.voiceLastLeftAt,
      rolesSnapshot: memberProfile.rolesSnapshot,
      isSuspectedDC: memberProfile.isSuspectedDC,
      moderatorNote: memberProfile.moderatorNote,
      createdAt: memberProfile.createdAt,
      updatedAt: memberProfile.updatedAt,
    },
    invite: invite
      ? {
          inviteCode: invite.inviteCode,
          inviterId: invite.inviterId,
          inviterTag: invite.inviterTag,
          joinedAt: invite.joinedAt,
        }
      : null,
    eventParticipations: eventParticipations.map((entry) => ({
      id: entry.id,
      eventId: entry.eventId,
      eventTitle: entry.event.title,
      eventType: entry.event.type,
      createdAt: entry.createdAt,
      score: entry.score,
    })),
  };
}

export async function getStaffProfileSnapshot(guildId: string, userId: string): Promise<StaffProfileSnapshot | null> {
  const staffMember = await getStaffMember(guildId, userId);

  if (!staffMember) {
    return null;
  }

  const [
    publicProfile,
    warnings,
    blacklistHistory,
    activeBlacklist,
    testingPeriods,
    activities,
    apiKeys,
    absences,
    notesWritten,
    notesAbout,
    gradeHistory,
  ] = await Promise.all([
    prisma.memberProfile.findFirst({
      where: { guildId, userId: staffMember.userId },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.staffWarning.findMany({
      where: { guildId, staffUserId: staffMember.id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.staffBlacklist.findMany({
      where: { guildId, staffUserId: staffMember.id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.staffBlacklist.findFirst({
      where: {
        guildId,
        staffUserId: staffMember.id,
        isActive: true,
        OR: [{ endDate: { gt: new Date() } }, { endDate: null }],
      },
    }),
    prisma.testingPeriod.findMany({
      where: { guildId, staffUserId: staffMember.id },
      include: {
        mentor: true,
        staffMember: true,
        reports: {
          include: { author: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.staffActivity.findMany({
      where: { guildId, staffUserId: staffMember.id },
      orderBy: { activityDate: 'desc' },
      take: 60,
    }),
    prisma.aPIKey.findMany({
      where: { guildId, createdByUserId: staffMember.id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.staffAbsence.findMany({
      where: { guildId, staffUserId: staffMember.id },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    prisma.staffManagerNote.findMany({
      where: { guildId, authorUserId: staffMember.id },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    prisma.staffManagerNote.findMany({
      where: { guildId, staffUserId: staffMember.id },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    prisma.dashboardAuditLog.findMany({
      where: {
        guildId,
        module: 'Staff Management',
        OR: [
          { details: { contains: staffMember.userId } },
          { action: { contains: 'grade', mode: 'insensitive' } },
        ],
      },
      orderBy: { dateIso: 'desc' },
      take: 20,
    }),
  ]);

  const totalMessages = activities.reduce((sum, activity) => sum + activity.messageCount, 0);
  const totalVoiceMinutes = activities.reduce((sum, activity) => sum + activity.voiceMinutes, 0);

  return {
    staffMember,
    publicProfile: publicProfile
      ? {
          id: publicProfile.id,
          guildId: publicProfile.guildId,
          userId: publicProfile.userId,
          userTag: publicProfile.userTag,
          username: publicProfile.username,
          globalName: publicProfile.globalName,
          displayName: publicProfile.displayName,
          avatarUrl: publicProfile.avatarUrl,
          bannerUrl: publicProfile.bannerUrl,
          accentColor: publicProfile.accentColor,
          locale: publicProfile.locale,
          isBot: publicProfile.isBot,
          bio: publicProfile.bio ?? null,
          isProfilePrivate: publicProfile.isProfilePrivate,
          accountCreatedAt: publicProfile.accountCreatedAt,
          guildJoinedAt: publicProfile.guildJoinedAt,
          guildLeftAt: publicProfile.guildLeftAt,
          firstSeenAt: publicProfile.firstSeenAt,
          lastSeenAt: publicProfile.lastSeenAt,
          lastMessageAt: publicProfile.lastMessageAt,
          lastMessageChannelId: publicProfile.lastMessageChannelId,
          messageCount: publicProfile.messageCount,
          voiceSessionCount: publicProfile.voiceSessionCount,
          voiceTimeSeconds: publicProfile.voiceTimeSeconds,
          voiceLastChannelId: publicProfile.voiceLastChannelId,
          voiceLastJoinedAt: publicProfile.voiceLastJoinedAt,
          voiceLastLeftAt: publicProfile.voiceLastLeftAt,
          rolesSnapshot: publicProfile.rolesSnapshot,
          isSuspectedDC: publicProfile.isSuspectedDC,
          moderatorNote: publicProfile.moderatorNote,
          createdAt: publicProfile.createdAt,
          updatedAt: publicProfile.updatedAt,
        }
      : null,
    activeBlacklist,
    blacklistHistory,
    warnings,
    testingPeriods,
    activities,
    apiKeys,
    absences,
    notesWritten,
    notesAbout,
    gradeHistory: gradeHistory.map((entry) => ({
      id: entry.id,
      action: entry.action,
      details: entry.details,
      module: entry.module,
      eventType: entry.eventType,
      user: entry.user,
      dateIso: entry.dateIso,
    })),
    stats: {
      totalMessages,
      totalVoiceMinutes,
      activeWarnings: warnings.filter((warning) => warning.isActive).length,
      sanctionsIssued: warnings.length + blacklistHistory.length,
      testsCompleted: testingPeriods.filter((period) => period.status !== 'ONGOING').length,
    },
  };
}