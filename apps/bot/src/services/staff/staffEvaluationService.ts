import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export async function generateStaffEvaluation(guildId: string, staffUserId: string, periodDays = 30) {
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - periodDays);

  const [activity, sanctions, tickets, meetings, absences, previousEval] = await Promise.all([
    prismaRead.staffActivity.findMany({
      where: { guildId, staffUserId, activityDate: { gte: periodStart, lte: periodEnd } },
    }),
    prismaRead.sanction.count({
      where: { guildId, moderatorUserId: staffUserId, createdAt: { gte: periodStart, lte: periodEnd } },
    }),
    prismaRead.ticket.count({
      where: { guildId, claimedById: staffUserId, status: 'CLOSED', updatedAt: { gte: periodStart, lte: periodEnd } },
    }),
    prismaRead.staffMeetingPresence.findMany({
      where: {
        staffUserId,
        meeting: { guildId, scheduledAt: { gte: periodStart, lte: periodEnd } },
      },
      include: { meeting: { select: { id: true } } },
    }),
    prismaRead.staffAbsence.findMany({
      where: {
        guildId,
        staffUserId,
        status: 'APPROVED',
        startDate: { lte: periodEnd },
        OR: [{ endDate: { gte: periodStart } }, { endDate: null }],
      },
    }),
    prismaRead.staffEvaluation.findFirst({
      where: { guildId, staffUserId },
      orderBy: { periodEnd: 'desc' },
    }),
  ]);

  const totalMessages = activity.reduce((sum, a) => sum + a.messageCount, 0);
  const totalVoiceMinutes = activity.reduce((sum, a) => sum + a.voiceMinutes, 0);
  const sanctionsHandled = sanctions;
  const ticketsResolved = tickets;

  const meetingsTotal = await prismaRead.staffMeeting.count({
    where: { guildId, scheduledAt: { gte: periodStart, lte: periodEnd } },
  });
  const meetingsAttended = meetings.filter((m) => m.status === 'PRESENT').length;

  let absenceDays = 0;
  for (const absence of absences) {
    const start = absence.startDate > periodStart ? absence.startDate : periodStart;
    const end = absence.endDate && absence.endDate < periodEnd ? absence.endDate : periodEnd;
    absenceDays += Math.ceil((end.getTime() - start.getTime()) / 86400000);
  }

  const activeDays = Math.max(1, periodDays - absenceDays);

  // Activity score: messages + voice relative to active days
  const msgPerDay = totalMessages / activeDays;
  const voicePerDay = totalVoiceMinutes / activeDays;
  const activityScore = Math.min(100, Math.round(
    Math.min(msgPerDay * 5, 50) + Math.min(voicePerDay * 1, 50)
  ));

  // Moderation score: sanctions + tickets handled
  const modActions = sanctionsHandled + ticketsResolved;
  const moderationScore = Math.min(100, Math.round(modActions * 5));

  // Presence score: meetings attended + absence ratio
  const meetingRatio = meetingsTotal > 0 ? meetingsAttended / meetingsTotal : 1;
  const absenceRatio = absenceDays / periodDays;
  const presenceScore = Math.min(100, Math.round(meetingRatio * 60 + (1 - absenceRatio) * 40));

  const overallScore = Math.round(activityScore * 0.4 + moderationScore * 0.3 + presenceScore * 0.3);

  const previousScore = previousEval?.overallScore ?? overallScore;
  const trendDelta = overallScore - previousScore;
  const trend = trendDelta > 5 ? 'UP' : trendDelta < -5 ? 'DOWN' : 'STABLE';

  const evaluation = await prisma.staffEvaluation.create({
    data: {
      guildId,
      staffUserId,
      periodStart,
      periodEnd,
      totalMessages,
      totalVoiceMinutes,
      sanctionsHandled,
      ticketsResolved,
      meetingsAttended,
      meetingsTotal,
      absenceDays,
      activityScore,
      moderationScore,
      presenceScore,
      overallScore,
      trend,
      trendDelta,
    },
  });

  logger.info('StaffEval', `Évaluation générée pour ${staffUserId} (guild: ${guildId}): score=${overallScore}`);
  return evaluation;
}

export async function getStaffEvaluations(guildId: string, staffUserId?: string) {
  const where: any = { guildId };
  if (staffUserId) where.staffUserId = staffUserId;

  return prismaRead.staffEvaluation.findMany({
    where,
    orderBy: { periodEnd: 'desc' },
    take: 50,
  });
}

export async function updateEvaluationNote(guildId: string, evaluationId: string, managerNote: string) {
  return prisma.staffEvaluation.update({
    where: { id: evaluationId, guildId },
    data: { managerNote, status: 'PUBLISHED' },
  });
}

export async function getEvaluationsDashboardData(guildId: string) {
  const [evaluations, staffMembers] = await Promise.all([
    prismaRead.staffEvaluation.findMany({
      where: { guildId },
      orderBy: { periodEnd: 'desc' },
      take: 100,
    }),
    prismaRead.staffMember.findMany({
      where: { guildId },
      select: { userId: true, displayName: true },
    }),
  ]);

  const latestByStaff = new Map<string, typeof evaluations[0]>();
  for (const ev of evaluations) {
    if (!latestByStaff.has(ev.staffUserId)) {
      latestByStaff.set(ev.staffUserId, ev);
    }
  }

  const averageScore = evaluations.length > 0
    ? Math.round(evaluations.reduce((sum, e) => sum + e.overallScore, 0) / evaluations.length)
    : 0;

  return {
    evaluations,
    latestByStaff: Array.from(latestByStaff.values()),
    staffMembers,
    averageScore,
  };
}

export async function generateAllStaffEvaluations(guildId: string, periodDays = 30) {
  const staffMembers = await prismaRead.staffMember.findMany({
    where: { guildId },
    select: { userId: true },
  });

  const results = [];
  for (const staff of staffMembers) {
    try {
      const evaluation = await generateStaffEvaluation(guildId, staff.userId, periodDays);
      results.push(evaluation);
    } catch (error) {
      logger.error('StaffEval', `Erreur évaluation pour ${staff.userId}:`, error);
    }
  }

  return results;
}
