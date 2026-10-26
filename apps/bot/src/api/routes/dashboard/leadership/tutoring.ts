import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import { TutoringItemState } from '@prisma/client';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { json, readJsonBody, getGuildName, resolveDashboardAccess, pushAudit } from '../../../shared.js';
import { jsonFailure } from '../../../shared/failure.js';
import {
  addMentorReport,
  createTestingPeriod,
  endTestingPeriod,
} from '../../../../services/staff/staffManagementService.js';
import * as tutoringService from '../../../../services/core/tutoringService.js';
import {
  TUTORING_MEMBER_SELECT,
  createTutoringBoard,
  daysSince,
  getTutoringDetail,
  itemAppliesTo,
  listTutoringSummaries,
  tutoringRole,
} from '../../../../services/staff/tutoringOverview.js';

const LOG = 'TutoringAPI';
const TEXT_MAX = 4000;
const REPORT_TYPES = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;
const ITEM_STATES = Object.values(TutoringItemState);

function readText(raw: unknown, max = TEXT_MAX): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().slice(0, max);
  return text || null;
}

function readDays(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : null;
}

/**
 * Tutorat : un tutoré, un tuteur, un parcours d'objectifs, des points d'étape,
 * un carnet de bord et des missions.
 *
 * Trois rôles, revérifiés ici pour chaque tutorat (le répartiteur laisse
 * passer les écritures du segment) :
 * - responsable (administrateur ou droit tutorat) : tout, sur tous les tutorats ;
 * - tuteur : ses tutorés (objectifs, points d'étape, missions, décision) ;
 * - tutoré : lit son tutorat et tient son carnet de bord.
 */
export async function handleTutoringRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== 'tutoring') return false;
  const method = req.method ?? 'GET';
  const auditUser = user.username ?? `User${user.userId}`;
  const audit = (action: string, details: string) => pushAudit(guildId, {
    user: auditUser,
    action,
    context: getGuildName(client, guildId),
    module: 'Tutoring',
    eventType: 'Manuel',
    details,
    channelId: null,
  }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));

  const [accessLevel, me] = await Promise.all([
    resolveDashboardAccess(client, guildId, user.userId),
    prisma.staffMember.findUnique({ where: { guildId_userId: { guildId, userId: user.userId } }, select: { id: true, isTutor: true } }),
  ]);
  const isAdmin = accessLevel.level === 'admin';
  const isManager = isAdmin || accessLevel.canManageTutoring;
  const denied = (message = 'Action réservée aux responsables du tutorat.') => {
    json(res, 403, { error: message });
    return true;
  };

  try {
    // GET /tutoring/overview : ce que la personne doit voir en ouvrant la page.
    if (parts.length === 6 && parts[5] === 'overview' && method === 'GET') {
      const [mine, mentoring, all, config] = await Promise.all([
        me ? listTutoringSummaries(guildId, { staffUserId: me.id, status: 'ONGOING' }) : [],
        me ? listTutoringSummaries(guildId, { mentorId: me.id, status: 'ONGOING' }) : [],
        isManager ? listTutoringSummaries(guildId) : [],
        tutoringService.getTutoringConfig(guildId),
      ]);
      json(res, 200, {
        canManage: isManager,
        isTutor: !!me?.isTutor,
        mine: mine[0] ?? null,
        mentoring,
        all,
        config: { minTestDays: config.minTestDays, reportIntervalDays: config.reportIntervalDays },
      });
      return true;
    }

    // GET /tutoring/candidates : de quoi remplir « Nouveau tutorat ».
    if (parts.length === 6 && parts[5] === 'candidates' && method === 'GET') {
      if (!isManager) return denied();
      const [members, ongoing, hierarchies, roles] = await Promise.all([
        prisma.staffMember.findMany({ where: { guildId }, select: { ...TUTORING_MEMBER_SELECT, isTutor: true }, orderBy: { username: 'asc' } }),
        prisma.testingPeriod.findMany({ where: { guildId, status: 'ONGOING' }, select: { staffUserId: true } }),
        prisma.staffHierarchy.findMany({ where: { guildId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        prisma.staffRole.findMany({ where: { guildId, enabled: true }, select: { name: true, hierarchyId: true }, orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }] }),
      ]);
      const busy = new Set(ongoing.map((period) => period.staffUserId));
      json(res, 200, {
        members: members.map((member) => ({ ...member, inTutoring: busy.has(member.id) })),
        hierarchies,
        grades: roles,
      });
      return true;
    }

    // ── Parcours : réglages et objectifs ───────────────────────
    if (parts[5] === 'config') {
      if (method === 'GET') {
        json(res, 200, { config: await tutoringService.getTutoringConfig(guildId) });
        return true;
      }
      if (method === 'PATCH') {
        if (!isManager) return denied();
        const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
        const data: { reportIntervalDays?: number; reminderDaysBefore?: number; minTestDays?: number; showVocalActivity?: boolean; showAbsences?: boolean } = {};
        for (const key of ['reportIntervalDays', 'reminderDaysBefore', 'minTestDays'] as const) {
          if (body[key] !== undefined) {
            const days = key === 'reminderDaysBefore' && body[key] === 0 ? 0 : readDays(body[key]);
            if (days === null) {
              json(res, 400, { error: 'Les durées sont des nombres entiers de jours (1 à 365).' });
              return true;
            }
            data[key] = days;
          }
        }
        if (typeof body.showVocalActivity === 'boolean') data.showVocalActivity = body.showVocalActivity;
        if (typeof body.showAbsences === 'boolean') data.showAbsences = body.showAbsences;
        const config = await tutoringService.updateTutoringConfig(guildId, data);
        await audit('Réglages du tutorat', Object.entries(data).map(([key, value]) => `${key}: ${value}`).join(', '));
        json(res, 200, { config });
        return true;
      }
      return false;
    }

    if (parts[5] === 'items') {
      // GET /tutoring/items : tous les objectifs du serveur.
      if (parts.length === 6 && method === 'GET') {
        json(res, 200, { items: await tutoringService.getTutoringItems(guildId) });
        return true;
      }
      if (!isManager) return denied();
      // POST /tutoring/items : création ou modification ({ id }).
      if (parts.length === 6 && method === 'POST') {
        const body = (await readJsonBody<{ id?: unknown; category?: unknown; title?: unknown; description?: unknown; sortOrder?: unknown; hierarchyId?: unknown; grade?: unknown }>(req)) ?? {};
        const title = readText(body.title, 200);
        const category = readText(body.category, 80) ?? 'Général';
        if (!title) {
          json(res, 400, { error: "Donne un intitulé à l'objectif." });
          return true;
        }
        if (typeof body.id === 'string' && !(await prisma.tutoringItem.findFirst({ where: { id: body.id, guildId }, select: { id: true } }))) {
          json(res, 404, { error: 'Objectif introuvable.' });
          return true;
        }
        const hierarchyId = typeof body.hierarchyId === 'string' && body.hierarchyId
          ? (await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId }, select: { id: true } }))?.id ?? null
          : null;
        const item = await tutoringService.upsertTutoringItem(guildId, {
          id: typeof body.id === 'string' ? body.id : undefined,
          category,
          title,
          description: readText(body.description, 1000),
          sortOrder: typeof body.sortOrder === 'number' ? Math.floor(body.sortOrder) : undefined,
          hierarchyId,
          grade: readText(body.grade, 80),
        });
        await audit(body.id ? 'Objectif de tutorat modifié' : 'Objectif de tutorat ajouté', `« ${title} » (${category}).`);
        json(res, 201, { item });
        return true;
      }
      // DELETE /tutoring/items/:itemId
      if (parts.length === 7 && method === 'DELETE') {
        const item = await prisma.tutoringItem.findFirst({ where: { id: parts[6], guildId }, select: { id: true, title: true } });
        if (!item) {
          json(res, 404, { error: 'Objectif introuvable.' });
          return true;
        }
        await tutoringService.deleteTutoringItem(item.id);
        await audit('Objectif de tutorat supprimé', `« ${item.title} ».`);
        json(res, 200, { ok: true });
        return true;
      }
      return false;
    }

    // Lectures historiques reprises par le reste du dashboard (menu, profil).
    if (parts.length === 6 && parts[5] === 'apprentice-progress' && method === 'GET') {
      json(res, 200, { progress: await tutoringService.getApprenticeProgress(guildId, user.userId) });
      return true;
    }
    if (parts.length === 6 && parts[5] === 'tutor-dashboard' && method === 'GET') {
      json(res, 200, { apprentices: await tutoringService.getTutorDashboard(guildId, user.userId, isAdmin) });
      return true;
    }

    if (parts[5] !== 'periods') return false;

    // POST /tutoring/periods : nouveau tutorat.
    if (parts.length === 6 && method === 'POST') {
      if (!isManager) return denied();
      const body = (await readJsonBody<{
        staffMemberId?: unknown;
        mentorId?: unknown;
        plannedDurationDays?: unknown;
        targetGrade?: unknown;
        hierarchyId?: unknown;
        withMissions?: unknown;
      }>(req)) ?? {};
      const apprentice = typeof body.staffMemberId === 'string'
        ? await prisma.staffMember.findFirst({ where: { id: body.staffMemberId, guildId }, select: { id: true, username: true, displayName: true, userId: true } })
        : null;
      if (!apprentice) {
        json(res, 400, { error: 'Choisis la personne à tutorer parmi le staff.' });
        return true;
      }
      const mentor = typeof body.mentorId === 'string' && body.mentorId
        ? await prisma.staffMember.findFirst({ where: { id: body.mentorId, guildId }, select: { id: true } })
        : null;
      if (typeof body.mentorId === 'string' && body.mentorId && !mentor) {
        json(res, 400, { error: 'Le tuteur doit faire partie du staff.' });
        return true;
      }
      if (mentor?.id === apprentice.id) {
        json(res, 400, { error: 'Une personne ne peut pas être sa propre tutrice.' });
        return true;
      }
      if (await prisma.testingPeriod.findFirst({ where: { guildId, staffUserId: apprentice.id, status: 'ONGOING' }, select: { id: true } })) {
        json(res, 409, { error: 'Cette personne a déjà un tutorat en cours.' });
        return true;
      }
      const hierarchyId = typeof body.hierarchyId === 'string' && body.hierarchyId
        ? (await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId }, select: { id: true } }))?.id
        : undefined;
      const period = await createTestingPeriod(
        guildId,
        apprentice.id,
        mentor?.id,
        readDays(body.plannedDurationDays) ?? 14,
        readText(body.targetGrade, 80) ?? undefined,
        hierarchyId,
      );
      const name = apprentice.displayName || apprentice.username || apprentice.userId;
      if (body.withMissions === true) await createTutoringBoard(guildId, period.id, name, user.userId);
      await audit('Création tutorat', `Tutorat de ${name}.`);
      json(res, 201, { period: await getTutoringDetail(guildId, period.id) });
      return true;
    }

    const periodId = parts[6];
    if (!periodId) return false;
    const period = await prisma.testingPeriod.findFirst({
      where: { id: periodId, guildId },
      select: { id: true, status: true, staffUserId: true, mentorId: true, startDate: true, doingListId: true, hierarchyId: true, targetGrade: true, staffMember: { select: { username: true, displayName: true, userId: true } } },
    });
    if (!period) {
      json(res, 404, { error: 'Tutorat introuvable.' });
      return true;
    }
    const role = tutoringRole({ isManager, staffId: me?.id ?? null }, period);
    if (!role) return denied("Ce tutorat ne te concerne pas.");
    const canCoach = role === 'manager' || role === 'mentor';
    const apprenticeName = period.staffMember.displayName || period.staffMember.username || period.staffMember.userId;

    // GET /tutoring/periods/:id : la fiche.
    if (parts.length === 7 && method === 'GET') {
      json(res, 200, { period: await getTutoringDetail(guildId, periodId), role });
      return true;
    }

    // PATCH /tutoring/periods/:id : tuteur, durée prévue, grade et hiérarchie visés.
    if (parts.length === 7 && method === 'PATCH') {
      if (role !== 'manager') return denied();
      const body = (await readJsonBody<{ mentorId?: unknown; plannedDurationDays?: unknown; targetGrade?: unknown; hierarchyId?: unknown }>(req)) ?? {};
      const data: { mentorId?: string | null; plannedDurationDays?: number; targetGrade?: string | null; hierarchyId?: string | null } = {};
      if (body.mentorId !== undefined) {
        if (body.mentorId === null || body.mentorId === '') data.mentorId = null;
        else {
          const mentor = typeof body.mentorId === 'string'
            ? await prisma.staffMember.findFirst({ where: { id: body.mentorId, guildId }, select: { id: true } })
            : null;
          if (!mentor || mentor.id === period.staffUserId) {
            json(res, 400, { error: 'Le tuteur doit faire partie du staff et ne pas être le tutoré.' });
            return true;
          }
          data.mentorId = mentor.id;
        }
      }
      if (body.plannedDurationDays !== undefined) {
        const days = readDays(body.plannedDurationDays);
        if (days === null) {
          json(res, 400, { error: 'La durée prévue est un nombre de jours entre 1 et 365.' });
          return true;
        }
        data.plannedDurationDays = days;
      }
      if (body.targetGrade !== undefined) data.targetGrade = readText(body.targetGrade, 80);
      if (body.hierarchyId !== undefined) {
        data.hierarchyId = typeof body.hierarchyId === 'string' && body.hierarchyId
          ? (await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId }, select: { id: true } }))?.id ?? null
          : null;
      }
      await prisma.testingPeriod.update({ where: { id: periodId }, data });
      await audit('Tutorat modifié', `Tutorat de ${apprenticeName} : ${Object.keys(data).join(', ') || 'aucun changement'}.`);
      json(res, 200, { period: await getTutoringDetail(guildId, periodId), role });
      return true;
    }

    // DELETE /tutoring/periods/:id : efface le tutorat et son suivi, pas sa liste de missions.
    if (parts.length === 7 && method === 'DELETE') {
      if (role !== 'manager') return denied();
      await prisma.testingPeriod.delete({ where: { id: periodId } });
      await audit('Suppression tutorat', `Tutorat de ${apprenticeName}.`);
      json(res, 200, { ok: true });
      return true;
    }

    const action = parts[7];

    // POST /tutoring/periods/:id/missions-board : crée la liste des missions.
    if (parts.length === 8 && action === 'missions-board' && method === 'POST') {
      if (!canCoach) return denied();
      if (period.doingListId) {
        json(res, 409, { error: 'Ce tutorat a déjà sa liste de missions.' });
        return true;
      }
      await createTutoringBoard(guildId, periodId, apprenticeName, user.userId);
      json(res, 201, { period: await getTutoringDetail(guildId, periodId), role });
      return true;
    }

    // PUT /tutoring/periods/:id/objectives/:itemId { state }
    if (parts.length === 9 && action === 'objectives' && method === 'PUT') {
      if (!canCoach) return denied('Seuls le tuteur et les responsables valident les objectifs.');
      if (period.status !== 'ONGOING') {
        json(res, 400, { error: 'Ce tutorat est terminé.' });
        return true;
      }
      const body = (await readJsonBody<{ state?: unknown }>(req)) ?? {};
      if (!ITEM_STATES.includes(body.state as TutoringItemState)) {
        json(res, 400, { error: 'État inconnu.' });
        return true;
      }
      const item = await prisma.tutoringItem.findFirst({ where: { id: parts[8], guildId } });
      if (!item || !itemAppliesTo(item, period.hierarchyId, period.targetGrade)) {
        json(res, 404, { error: 'Objectif introuvable pour ce tutorat.' });
        return true;
      }
      const progress = await tutoringService.updateChecklistProgress(periodId, item.id, body.state as TutoringItemState, user.userId);
      json(res, 200, { progress });
      return true;
    }

    // POST /tutoring/periods/:id/reports { type, content } : point d'étape.
    if (parts.length === 8 && action === 'reports' && method === 'POST') {
      if (!canCoach) return denied("Seuls le tuteur et les responsables font les points d'étape.");
      const body = (await readJsonBody<{ type?: unknown; content?: unknown }>(req)) ?? {};
      const content = readText(body.content);
      if (!REPORT_TYPES.includes(body.type as (typeof REPORT_TYPES)[number]) || !content) {
        json(res, 400, { error: "Choisis un ressenti et écris le point d'étape." });
        return true;
      }
      await addMentorReport(periodId, user.userId, body.type as (typeof REPORT_TYPES)[number], content);
      await audit("Point d'étape", `Tutorat de ${apprenticeName} (${body.type}).`);
      json(res, 201, { period: await getTutoringDetail(guildId, periodId), role });
      return true;
    }

    // POST /tutoring/periods/:id/logs { content } : carnet de bord du tutoré.
    if (parts.length === 8 && action === 'logs' && method === 'POST') {
      if (role !== 'apprentice' && role !== 'manager') return denied('Le carnet de bord est tenu par la personne tutorée.');
      const body = (await readJsonBody<{ content?: unknown }>(req)) ?? {};
      const content = readText(body.content);
      if (!content) {
        json(res, 400, { error: "L'entrée du carnet est vide." });
        return true;
      }
      const log = await tutoringService.addApprenticeLog(periodId, content);
      json(res, 201, { log });
      return true;
    }

    // POST /tutoring/periods/:id/decision { status, notes, force } : fin du tutorat.
    if (parts.length === 8 && action === 'decision' && method === 'POST') {
      if (!canCoach) return denied('Seuls le tuteur et les responsables concluent un tutorat.');
      if (period.status !== 'ONGOING') {
        json(res, 400, { error: 'Ce tutorat est déjà terminé.' });
        return true;
      }
      const body = (await readJsonBody<{ status?: unknown; notes?: unknown; force?: unknown }>(req)) ?? {};
      if (body.status !== 'PASSED' && body.status !== 'FAILED') {
        json(res, 400, { error: 'Décision inconnue.' });
        return true;
      }
      const force = body.force === true;
      if (body.status === 'PASSED') {
        const { minTestDays } = await tutoringService.getTutoringConfig(guildId);
        const days = daysSince(period.startDate);
        if (days < minTestDays && !force) {
          json(res, 409, { error: `Le tutorat dure depuis ${days} j, il en faut ${minTestDays} pour le valider.`, canForce: isAdmin });
          return true;
        }
        if (force && !isAdmin) return denied('Seul un administrateur valide un tutorat avant la durée minimale.');
      }
      await endTestingPeriod(periodId, body.status, readText(body.notes) ?? undefined);
      await audit(`Fin de tutorat (${body.status})${force ? ' [FORCÉ]' : ''}`, `Tutorat de ${apprenticeName}.`);
      json(res, 200, { period: await getTutoringDetail(guildId, periodId), role });
      return true;
    }

    return false;
  } catch (err) {
    logger.error(LOG, 'Erreur tutorat :', err);
    jsonFailure(res, err, 'Erreur sur le tutorat', LOG);
    return true;
  }
}
