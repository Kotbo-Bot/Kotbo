/**
 * Tutorat : ce que la page montre d'un tutorat, calculé au même endroit pour
 * l'accueil (cartes) et la fiche (détail).
 *
 * Un tutorat, c'est un tutoré, un tuteur, un parcours d'objectifs (communs ou
 * propres à la hiérarchie et au grade visés), des points d'étape réguliers, un
 * carnet de bord, et des missions dans une liste de suivi reliée.
 */
import type { Prisma, TutoringItem, TutoringItemState } from '@prisma/client';
import prisma from '../../utils/db.js';
import { getTutoringConfig } from '../core/tutoringService.js';
import { deriveListKey, freeListKey } from './doingListBoard.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const TUTORING_MEMBER_SELECT = {
  id: true,
  userId: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  grade: true,
} satisfies Prisma.StaffMemberSelect;

const PERIOD_INCLUDE = {
  staffMember: { select: TUTORING_MEMBER_SELECT },
  mentor: { select: TUTORING_MEMBER_SELECT },
  checklistProgress: { select: { itemId: true, state: true, completedAt: true } },
  _count: { select: { reports: true } },
} satisfies Prisma.TestingPeriodInclude;

type PeriodRow = Prisma.TestingPeriodGetPayload<{ include: typeof PERIOD_INCLUDE }>;

export type TutoringRole = 'manager' | 'mentor' | 'apprentice';

/** Place de la personne sur ce tutorat ; null : il ne la concerne pas. */
export function tutoringRole(
  viewer: { isManager: boolean; staffId: string | null },
  period: { staffUserId: string; mentorId: string | null },
): TutoringRole | null {
  if (viewer.isManager) return 'manager';
  if (!viewer.staffId) return null;
  if (period.mentorId === viewer.staffId) return 'mentor';
  return period.staffUserId === viewer.staffId ? 'apprentice' : null;
}

/** Un objectif vaut pour le tutorat s'il est commun ou s'il vise sa hiérarchie et son grade. */
export function itemAppliesTo(item: Pick<TutoringItem, 'hierarchyId' | 'grade'>, hierarchyId: string | null, targetGrade: string | null) {
  return (!item.hierarchyId || item.hierarchyId === hierarchyId) && (!item.grade || item.grade === targetGrade);
}

/** Prochain point d'étape attendu : un intervalle après le dernier, ou après le début. */
export function nextReportDue(period: { startDate: Date; lastReportAt: Date | null }, intervalDays: number): Date {
  return new Date((period.lastReportAt ?? period.startDate).getTime() + intervalDays * DAY_MS);
}

export function daysSince(date: Date, now = Date.now()): number {
  return Math.max(0, Math.floor((now - date.getTime()) / DAY_MS));
}

/**
 * Conditions affichées avant de trancher. Seule la durée minimale bloque la
 * validation (un administrateur peut passer outre) ; les deux autres éclairent
 * la décision sans l'imposer.
 */
export function tutoringReadiness(input: { daysElapsed: number; minDays: number; acquired: number; total: number; reports: number }) {
  return [
    { key: 'duration', ok: input.daysElapsed >= input.minDays, blocking: true, value: input.daysElapsed, target: input.minDays },
    { key: 'objectives', ok: input.total === 0 || input.acquired === input.total, blocking: false, value: input.acquired, target: input.total },
    { key: 'reports', ok: input.reports > 0, blocking: false, value: input.reports, target: 1 },
  ];
}

function summarize(period: PeriodRow, items: TutoringItem[], intervalDays: number) {
  const applicable = items.filter((item) => itemAppliesTo(item, period.hierarchyId, period.targetGrade));
  const states = new Map(period.checklistProgress.map((progress) => [progress.itemId, progress.state]));
  const count = (state: TutoringItemState) => applicable.filter((item) => states.get(item.id) === state).length;
  const nextReportAt = period.status === 'ONGOING' && period.mentorId ? nextReportDue(period, intervalDays) : null;
  return {
    id: period.id,
    status: period.status,
    startDate: period.startDate,
    endDate: period.endDate,
    plannedDurationDays: period.plannedDurationDays,
    targetGrade: period.targetGrade,
    hierarchyId: period.hierarchyId,
    notes: period.notes,
    doingListId: period.doingListId,
    apprentice: period.staffMember,
    mentor: period.mentor,
    daysElapsed: daysSince(period.startDate, (period.endDate ?? new Date()).getTime()),
    progress: { total: applicable.length, acquired: count('ACQUIRED'), learning: count('KNOWN') },
    reports: period._count.reports,
    lastReportAt: period.lastReportAt,
    nextReportAt,
    reportOverdue: !!nextReportAt && nextReportAt.getTime() < Date.now(),
  };
}

export type TutoringSummary = ReturnType<typeof summarize>;

/** Tutorats du serveur résumés pour l'accueil, les plus récents d'abord. */
export async function listTutoringSummaries(guildId: string, where: Prisma.TestingPeriodWhereInput = {}): Promise<TutoringSummary[]> {
  const [config, items, periods] = await Promise.all([
    getTutoringConfig(guildId),
    prisma.tutoringItem.findMany({ where: { guildId } }),
    prisma.testingPeriod.findMany({ where: { guildId, ...where }, include: PERIOD_INCLUDE, orderBy: { startDate: 'desc' }, take: 200 }),
  ]);
  return periods.map((period) => summarize(period, items, config.reportIntervalDays));
}

/** La fiche complète d'un tutorat, ou null s'il n'est pas sur ce serveur. */
export async function getTutoringDetail(guildId: string, periodId: string) {
  const period = await prisma.testingPeriod.findFirst({ where: { id: periodId, guildId }, include: PERIOD_INCLUDE });
  if (!period) return null;

  const [config, items, reports, logs, absences, vocalStats, missions] = await Promise.all([
    getTutoringConfig(guildId),
    prisma.tutoringItem.findMany({ where: { guildId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.mentorReport.findMany({
      where: { testingPeriodId: periodId },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: TUTORING_MEMBER_SELECT } },
    }),
    prisma.tutoringLog.findMany({ where: { testingPeriodId: periodId }, orderBy: { date: 'desc' }, take: 100 }),
    prisma.staffAbsence.findMany({
      where: { guildId, staffUserId: period.staffUserId, OR: [{ endDate: { gte: new Date() } }, { isIndefinite: true }] },
      orderBy: { startDate: 'asc' },
      take: 5,
      select: { id: true, startDate: true, endDate: true, isIndefinite: true, reason: true, status: true },
    }),
    prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId: period.staffMember.userId } },
      select: { voiceTimeSeconds: true, voiceSessionCount: true },
    }),
    period.doingListId
      ? prisma.doingList.findUnique({
        where: { id: period.doingListId },
        select: {
          id: true,
          name: true,
          key: true,
          items: {
            orderBy: [{ number: 'asc' }],
            take: 100,
            select: {
              id: true,
              number: true,
              title: true,
              dueDate: true,
              column: { select: { name: true, isDone: true } },
              staffTask: { select: { assignee: { select: { userId: true } } } },
            },
          },
        },
      })
      : null,
  ]);

  const summary = summarize(period, items, config.reportIntervalDays);
  const progressByItem = new Map(period.checklistProgress.map((progress) => [progress.itemId, progress]));
  const objectives = items
    .filter((item) => itemAppliesTo(item, period.hierarchyId, period.targetGrade))
    .map((item) => ({
      id: item.id,
      category: item.category,
      title: item.title,
      description: item.description,
      state: progressByItem.get(item.id)?.state ?? 'UNCHECKED',
      completedAt: progressByItem.get(item.id)?.completedAt ?? null,
    }));

  return {
    ...summary,
    objectives,
    reports,
    logs,
    absences,
    vocalStats,
    missions: missions
      ? {
        list: { id: missions.id, name: missions.name, key: missions.key },
        items: missions.items.map((item) => ({
          id: item.id,
          key: `${missions.key}-${item.number}`,
          title: item.title,
          dueDate: item.dueDate,
          column: item.column.name,
          done: item.column.isDone,
          assignedToApprentice: item.staffTask?.assignee?.userId === period.staffMember.userId,
        })),
      }
      : null,
    readiness: tutoringReadiness({
      daysElapsed: summary.daysElapsed,
      minDays: config.minTestDays,
      acquired: summary.progress.acquired,
      total: summary.progress.total,
      reports: summary.reports,
    }),
    config: { minTestDays: config.minTestDays, reportIntervalDays: config.reportIntervalDays },
  };
}

/** Liste de suivi des missions d'un tutorat, avec ses trois étapes de départ. */
export async function createTutoringBoard(guildId: string, periodId: string, apprenticeName: string, createdById: string) {
  const key = (await freeListKey(guildId, deriveListKey(`T${apprenticeName}`))) ?? (await freeListKey(guildId, 'TUTO'));
  if (!key) throw new Error('Aucune clé de liste libre pour ce tutorat.');
  return prisma.$transaction(async (tx) => {
    const list = await tx.doingList.create({
      data: {
        guildId,
        name: `Tutorat · ${apprenticeName}`.slice(0, 80),
        key,
        description: 'Missions confiées pendant le tutorat.',
        modules: [],
        createdById,
        columns: {
          create: ['À faire', 'En cours', 'Terminé'].map((name, position) => ({ guildId, name, position, isDone: position === 2 })),
        },
      },
    });
    await tx.testingPeriod.update({ where: { id: periodId }, data: { doingListId: list.id } });
    return list;
  });
}
