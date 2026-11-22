import prisma from '../../utils/db.js';
import type { TutoringConfig, TutoringItem, TutoringItemState } from '@prisma/client';

/**
 * Service de gestion du tutorat
 */

interface TutoringItemInput {
  id?: string;
  category: string;
  title: string;
  description?: string | null;
  sortOrder?: number;
  hierarchyId?: string | null;
  grade?: string | null;
  grantRoleIds?: string[];
  grantDashboardSection?: string | null;
}

/**
 * Un item de checklist s'applique à une période de test si sa hiérarchie et son
 * grade sont soit non renseignés (item commun), soit identiques à ceux ciblés par
 * la période. Permet d'avoir une checklist par hiérarchie/grade en plus d'items communs.
 */
const itemAppliesTo = (item: TutoringItem, hierarchyId: string | null, targetGrade: string | null) => {
  const hierarchyMatches = !item.hierarchyId || item.hierarchyId === hierarchyId;
  const gradeMatches = !item.grade || item.grade === targetGrade;
  return hierarchyMatches && gradeMatches;
};

export const getTutoringConfig = async (guildId: string) => {
  let config = await prisma.tutoringConfig.findUnique({
    where: { guildId }
  });

  if (!config) {
    config = await prisma.tutoringConfig.create({
      data: { guildId }
    });
  }

  return config;
};

export const updateTutoringConfig = async (guildId: string, data: Partial<TutoringConfig>) => {
  return prisma.tutoringConfig.upsert({
    where: { guildId },
    update: data,
    create: {
      guildId,
      ...data
    }
  });
};

export const getTutoringItems = async (guildId: string, filters?: { hierarchyId?: string | null }) => {
  return prisma.tutoringItem.findMany({
    where: {
      guildId,
      ...(filters?.hierarchyId !== undefined ? { hierarchyId: filters.hierarchyId } : {})
    },
    orderBy: [{ sortOrder: 'asc' }]
  });
};

/** Items de checklist applicables à une période de test (communs + spécifiques à sa hiérarchie/grade). */
export const getApplicableTutoringItems = async (
  guildId: string,
  hierarchyId: string | null,
  targetGrade: string | null
) => {
  const items = await prisma.tutoringItem.findMany({
    where: { guildId },
    orderBy: [{ sortOrder: 'asc' }]
  });

  return items.filter((item) => itemAppliesTo(item, hierarchyId, targetGrade));
};

export const upsertTutoringItem = async (guildId: string, data: TutoringItemInput) => {
  if (data.id) {
    return prisma.tutoringItem.update({
      where: { id: data.id },
      data: {
        category: data.category,
        title: data.title,
        description: data.description,
        sortOrder: data.sortOrder,
        hierarchyId: data.hierarchyId ?? null,
        grade: data.grade ?? null,
        ...(data.grantRoleIds !== undefined ? { grantRoleIds: data.grantRoleIds } : {}),
        ...(data.grantDashboardSection !== undefined ? { grantDashboardSection: data.grantDashboardSection } : {}),
      }
    });
  }

  return prisma.tutoringItem.create({
    data: {
      guildId,
      category: data.category,
      title: data.title,
      description: data.description,
      sortOrder: data.sortOrder,
      hierarchyId: data.hierarchyId ?? null,
      grade: data.grade ?? null,
      grantRoleIds: data.grantRoleIds ?? [],
      grantDashboardSection: data.grantDashboardSection ?? null,
    }
  });
};

export const deleteTutoringItem = async (id: string) => {
  return prisma.tutoringItem.delete({
    where: { id }
  });
};

export const deleteTestingPeriod = async (id: string) => {
  return prisma.testingPeriod.delete({
    where: { id }
  });
};

/**
 * Fusionne la checklist applicable à une période (communs + spécifiques à sa
 * hiérarchie/grade) avec la progression déjà enregistrée, pour que les items pas
 * encore cochés restent visibles au lieu de disparaître.
 */
const withFullChecklist = async <T extends { guildId: string; hierarchyId: string | null; targetGrade: string | null; checklistProgress: Array<{ item: TutoringItem; state: TutoringItemState; completedAt: Date | null; completedByUserId: string | null }> }>(
  period: T
) => {
  const applicableItems = await getApplicableTutoringItems(period.guildId, period.hierarchyId, period.targetGrade);
  const progressByItemId = new Map(period.checklistProgress.map((p) => [p.item.id, p]));

  const fullChecklist = applicableItems.map((item) => {
    const progress = progressByItemId.get(item.id);
    return {
      item,
      state: progress?.state ?? 'UNCHECKED',
      completedAt: progress?.completedAt ?? null,
      completedByUserId: progress?.completedByUserId ?? null
    };
  });

  return { ...period, fullChecklist };
};

export const getTutorDashboard = async (guildId: string, tutorUserId: string, fetchAll: boolean = false) => {
  const where: Record<string, unknown> = {
    guildId,
    status: 'ONGOING'
  };

  if (!fetchAll) {
    // Trouver le StaffMember ID du tuteur
    const tutor = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId: tutorUserId } }
    });

    if (!tutor) return [];
    where.mentorId = tutor.id;
  }

  const apprentices = await prisma.testingPeriod.findMany({
    where,
    include: {
      staffMember: true,
      mentor: true,
      checklistProgress: {
        include: { item: true }
      },
      reports: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  // Enrich with stats and absences
  return Promise.all(apprentices.map(async (apprentice) => {
    const [vocalStats, absences] = await Promise.all([
      apprentice.staffMember?.userId ? prisma.memberProfile.findUnique({
        where: { guildId_userId: { guildId, userId: apprentice.staffMember.userId } },
        select: { voiceTimeSeconds: true, voiceSessionCount: true }
      }) : Promise.resolve(null),
      prisma.staffAbsence.findMany({
        where: { 
          guildId, 
          staffUserId: apprentice.staffUserId,
          OR: [
            { endDate: { gte: new Date() } },
            { isIndefinite: true }
          ]
        },
        orderBy: { startDate: 'asc' },
        take: 3
      })
    ]);

    return {
      ...(await withFullChecklist(apprentice)),
      vocalStats,
      absences
    };
  }));
};

export const getApprenticeProgress = async (guildId: string, userId: string) => {
  const apprentice = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } }
  });

  if (!apprentice) return null;

  const period = await prisma.testingPeriod.findFirst({
    where: {
      guildId,
      staffUserId: apprentice.id,
      status: 'ONGOING'
    },
    include: {
      mentor: true,
      checklistProgress: {
        include: { item: true }
      },
      reports: {
        orderBy: { createdAt: 'desc' }
      },
      logs: {
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  if (!period) return null;

  const [vocalStats, absences] = await Promise.all([
    prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { voiceTimeSeconds: true, voiceSessionCount: true }
    }),
    prisma.staffAbsence.findMany({
      where: { 
        guildId, 
        staffUserId: apprentice.id,
        endDate: { gte: new Date() }
      },
      orderBy: { startDate: 'asc' },
      take: 5
    })
  ]);

  return {
    ...(await withFullChecklist(period)),
    vocalStats,
    absences
  };
};

export const updateChecklistProgress = async (
  testingPeriodId: string,
  itemId: string,
  state: TutoringItemState,
  userId: string
) => {
  return prisma.tutoringChecklistProgress.upsert({
    where: {
      testingPeriodId_itemId: {
        testingPeriodId,
        itemId
      }
    },
    update: {
      state,
      completedAt: state === 'ACQUIRED' ? new Date() : null,
      completedByUserId: userId
    },
    create: {
      testingPeriodId,
      itemId,
      state,
      completedAt: state === 'ACQUIRED' ? new Date() : null,
      completedByUserId: userId
    }
  });
};

export const addApprenticeLog = async (testingPeriodId: string, content: string) => {
  return prisma.tutoringLog.create({
    data: {
      testingPeriodId,
      content
    }
  });
};

export const checkReportReminders = async (guildId: string) => {
  const config = await getTutoringConfig(guildId);
  const now = new Date();
  
  const periods = await prisma.testingPeriod.findMany({
    where: {
      guildId,
      status: 'ONGOING',
      mentorId: { not: null }
    },
    include: {
      mentor: true,
      staffMember: true
    }
  });

  const reminders = [];

  for (const period of periods) {
    const lastDate = period.lastReportAt || period.startDate;
    const nextDue = new Date(lastDate);
    nextDue.setDate(nextDue.getDate() + config.reportIntervalDays);

    const reminderDate = new Date(nextDue);
    reminderDate.setDate(reminderDate.getDate() - config.reminderDaysBefore);

    if (now >= reminderDate && now < nextDue) {
      // Envoyer un rappel au mentor
      reminders.push({
        userId: period.mentor!.userId,
        apprenticeName: period.staffMember.username || period.staffMember.userId,
        dueDate: nextDue
      });
    }
  }

  return reminders;
};
