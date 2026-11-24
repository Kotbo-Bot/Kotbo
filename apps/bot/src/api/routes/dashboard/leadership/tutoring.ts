import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { TutoringItemState } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
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

const PERIOD_SELECT = {
  id: true, status: true, staffUserId: true, mentorId: true, startDate: true, doingListId: true, hierarchyId: true, targetGrade: true,
  staffMember: { select: { username: true, displayName: true, userId: true } },
} as const;

type TutoringViewer = { me: { id: string; isTutor: boolean } | null; isAdmin: boolean; isManager: boolean };
type PeriodRow = NonNullable<Awaited<ReturnType<typeof findPeriod>>>;
type PeriodContext = {
  period: PeriodRow;
  role: NonNullable<ReturnType<typeof tutoringRole>>;
  canCoach: boolean;
  apprenticeName: string;
};

function findPeriod(guildId: string, periodId: string) {
  return prisma.testingPeriod.findFirst({ where: { id: periodId, guildId }, select: PERIOD_SELECT });
}

const denied = (c: Context, message = 'Action réservée aux responsables du tutorat.') => send(c, { error: message }, 403);

/**
 * Tutorat : un tutoré, un tuteur, un parcours d'objectifs, des points d'étape,
 * un carnet de bord et des missions.
 *
 * Trois rôles, revérifiés ici pour chaque tutorat (la garde serveur laisse
 * passer les écritures du segment) :
 * - responsable (administrateur ou droit tutorat) : tout, sur tous les tutorats ;
 * - tuteur : ses tutorés (objectifs, points d'étape, missions, décision) ;
 * - tutoré : lit son tutorat et tient son carnet de bord.
 */
/** Clés de modules du dashboard, filtrées sur celles du serveur. */
async function readFeatureKeys(guildId: string, value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) return [];
  const { getAvailableFeatureConfigs } = await import('../../../../services/core/dashboardManagementService.js');
  const known = new Set((await getAvailableFeatureConfigs(guildId)).map((config) => config.featureKey));
  return [...new Set(value.filter((key): key is string => typeof key === 'string' && known.has(key)))];
}

/** À la validation : accorde au tutoré, en son nom propre, les modules prévus. */
async function grantTutoringAccess(guildId: string, period: { id: string; staffUserId: string; unlockFeatureKeys?: string[] }): Promise<string[]> {
  const keys = period.unlockFeatureKeys ?? [];
  if (keys.length === 0) return [];
  const member = await prisma.staffMember.findFirst({ where: { id: period.staffUserId, guildId }, select: { userId: true } });
  if (!member) return [];
  await prisma.$transaction(keys.map((featureKey) => prisma.dashboardFeatureUserAccess.upsert({
    where: { guildId_userId_featureKey: { guildId, userId: member.userId, featureKey } },
    create: { guildId, userId: member.userId, featureKey, source: 'TUTORING', sourceId: period.id },
    update: { canView: true, canModerate: true, source: 'TUTORING', sourceId: period.id },
  })));
  return keys;
}

export function createTutoringRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/tutoring';

  /** Qui regarde : sa fiche staff et ses droits sur le tutorat. */
  const loadViewer = createMiddleware<{ Variables: { viewer: TutoringViewer } }>(async (c, next) => {
    const me = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId: c.req.param('guildId')!, userId: c.var.dashboardUser.userId } },
      select: { id: true, isTutor: true },
    });
    const isAdmin = c.var.access.level === 'admin';
    c.set('viewer', { me, isAdmin, isManager: isAdmin || c.var.access.canManageTutoring });
    await next();
  });
  const gate = [...guildRoute(client), loadViewer] as const;

  /** Le tutorat visé et le rôle de la personne sur lui. */
  const loadPeriod = createMiddleware<{ Variables: { viewer: TutoringViewer; tutoring: PeriodContext } }>(async (c, next) => {
    const period = await findPeriod(c.req.param('guildId')!, c.req.param('periodId')!);
    if (!period) return send(c, { error: 'Tutorat introuvable.' }, 404);
    const { isManager, me } = c.var.viewer;
    const role = tutoringRole({ isManager, staffId: me?.id ?? null }, period);
    if (!role) return denied(c, 'Ce tutorat ne te concerne pas.');
    c.set('tutoring', {
      period,
      role,
      canCoach: role === 'manager' || role === 'mentor',
      apprenticeName: period.staffMember.displayName || period.staffMember.username || period.staffMember.userId,
    });
    await next();
  });
  const periodGate = [...gate, loadPeriod] as const;

  const audit = (c: Context, action: string, details: string) => {
    const guildId = c.req.param('guildId')!;
    return pushAudit(guildId, {
      user: auditUserOf(c),
      action,
      context: getGuildName(client, guildId),
      module: 'Tutoring',
      eventType: 'Manuel',
      details,
      channelId: null,
    }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));
  };

  router.onError((err, c) => {
    logger.error(LOG, 'Erreur tutorat :', err);
    return fail(c, err, 'Erreur sur le tutorat', LOG);
  });

  // Ce que la personne doit voir en ouvrant la page.
  router.get(`${base}/overview`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { me, isManager } = c.var.viewer;
    const [mine, mentoring, all, config] = await Promise.all([
      me ? listTutoringSummaries(guildId, { staffUserId: me.id, status: 'ONGOING' }) : [],
      me ? listTutoringSummaries(guildId, { mentorId: me.id, status: 'ONGOING' }) : [],
      isManager ? listTutoringSummaries(guildId) : [],
      tutoringService.getTutoringConfig(guildId),
    ]);
    return send(c, {
      canManage: isManager,
      isTutor: !!me?.isTutor,
      mine: mine[0] ?? null,
      mentoring,
      all,
      config: { minTestDays: config.minTestDays, reportIntervalDays: config.reportIntervalDays },
    });
  });

  // De quoi remplir « Nouveau tutorat ».
  router.get(`${base}/candidates`, ...gate, async (c) => {
    if (!c.var.viewer.isManager) return denied(c);
    const guildId = c.req.param('guildId');
    const [members, ongoing, hierarchies, roles] = await Promise.all([
      prisma.staffMember.findMany({ where: { guildId }, select: { ...TUTORING_MEMBER_SELECT, isTutor: true }, orderBy: { username: 'asc' } }),
      prisma.testingPeriod.findMany({ where: { guildId, status: 'ONGOING' }, select: { staffUserId: true } }),
      prisma.staffHierarchy.findMany({ where: { guildId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.staffRole.findMany({ where: { guildId, enabled: true }, select: { name: true, hierarchyId: true }, orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }] }),
    ]);
    const busy = new Set(ongoing.map((period) => period.staffUserId));
    const { getAvailableFeatureConfigs } = await import('../../../../services/core/dashboardManagementService.js');
    const features = (await getAvailableFeatureConfigs(guildId)).map((config) => ({ key: config.featureKey, label: config.featureName }));
    return send(c, {
      members: members.map((member) => ({ ...member, inTutoring: busy.has(member.id) })),
      hierarchies,
      grades: roles,
      features,
    });
  });

  // ── Parcours : réglages et objectifs ───────────────────────
  router.get(`${base}/config`, ...gate, async (c) => send(c, { config: await tutoringService.getTutoringConfig(c.req.param('guildId')) }));

  router.patch(`${base}/config`, ...gate, async (c) => {
    if (!c.var.viewer.isManager) return denied(c);
    const body = (await readBody(c)) ?? {};
    const data: { reportIntervalDays?: number; reminderDaysBefore?: number; minTestDays?: number; showVocalActivity?: boolean; showAbsences?: boolean } = {};
    for (const key of ['reportIntervalDays', 'reminderDaysBefore', 'minTestDays'] as const) {
      if (body[key] !== undefined) {
        const days = key === 'reminderDaysBefore' && body[key] === 0 ? 0 : readDays(body[key]);
        if (days === null) return send(c, { error: 'Les durées sont des nombres entiers de jours (1 à 365).' }, 400);
        data[key] = days;
      }
    }
    if (typeof body.showVocalActivity === 'boolean') data.showVocalActivity = body.showVocalActivity;
    if (typeof body.showAbsences === 'boolean') data.showAbsences = body.showAbsences;
    const config = await tutoringService.updateTutoringConfig(c.req.param('guildId'), data);
    await audit(c, 'Réglages du tutorat', Object.entries(data).map(([key, value]) => `${key}: ${value}`).join(', '));
    return send(c, { config });
  });

  // Tous les objectifs du serveur.
  router.get(`${base}/items`, ...gate, async (c) => send(c, { items: await tutoringService.getTutoringItems(c.req.param('guildId')) }));

  // Création ou modification ({ id }).
  router.post(`${base}/items`, ...gate, async (c) => {
    if (!c.var.viewer.isManager) return denied(c);
    const guildId = c.req.param('guildId');
    const body = (await readBody<{ id?: unknown; category?: unknown; title?: unknown; description?: unknown; sortOrder?: unknown; hierarchyId?: unknown; grade?: unknown; grantRoleIds?: unknown; grantDashboardSection?: unknown }>(c)) ?? {};
    const title = readText(body.title, 200);
    const category = readText(body.category, 80) ?? 'Général';
    if (!title) return send(c, { error: "Donne un intitulé à l'objectif." }, 400);
    if (typeof body.id === 'string' && !(await prisma.tutoringItem.findFirst({ where: { id: body.id, guildId }, select: { id: true } }))) {
      return send(c, { error: 'Objectif introuvable.' }, 404);
    }
    const hierarchyId = typeof body.hierarchyId === 'string' && body.hierarchyId
      ? (await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId }, select: { id: true } }))?.id ?? null
      : null;
    const grantRoleIds = Array.isArray(body.grantRoleIds)
      ? body.grantRoleIds.filter((r): r is string => typeof r === 'string' && /^\d{17,20}$/.test(r))
      : undefined;
    const grantDashboardSection = readText(body.grantDashboardSection, 60);
    // Un rôle que le bot ne peut pas gérer (ou @everyone, ou rôle d'intégration) échouerait en silence à la validation.
    if (grantRoleIds && grantRoleIds.length > 0) {
      const discordGuild = client.guilds.cache.get(guildId);
      if (discordGuild) {
        const bad = grantRoleIds.filter((id) => {
          const role = discordGuild.roles.cache.get(id);
          return !role || !role.editable || role.managed || role.id === guildId;
        });
        if (bad.length > 0) return send(c, { error: 'Un des rôles choisis est introuvable ou ne peut pas être attribué par le bot (rôle plus haut que le sien, géré par une intégration ou @everyone).' }, 400);
      }
    }
    const item = await tutoringService.upsertTutoringItem(guildId, {
      id: typeof body.id === 'string' ? body.id : undefined,
      category,
      title,
      description: readText(body.description, 1000),
      sortOrder: typeof body.sortOrder === 'number' ? Math.floor(body.sortOrder) : undefined,
      hierarchyId,
      grade: readText(body.grade, 80),
      ...(grantRoleIds !== undefined ? { grantRoleIds } : {}),
      ...(body.grantDashboardSection !== undefined ? { grantDashboardSection } : {}),
    });
    await audit(c, body.id ? 'Objectif de tutorat modifié' : 'Objectif de tutorat ajouté', `« ${title} » (${category}).`);
    return send(c, { item }, 201);
  });

  router.delete(`${base}/items/:itemId`, ...gate, async (c) => {
    if (!c.var.viewer.isManager) return denied(c);
    const item = await prisma.tutoringItem.findFirst({ where: { id: c.req.param('itemId'), guildId: c.req.param('guildId') }, select: { id: true, title: true } });
    if (!item) return send(c, { error: 'Objectif introuvable.' }, 404);
    await tutoringService.deleteTutoringItem(item.id);
    await audit(c, 'Objectif de tutorat supprimé', `« ${item.title} ».`);
    return send(c, { ok: true });
  });

  // Lectures historiques reprises par le reste du dashboard (menu, profil).
  router.get(`${base}/apprentice-progress`, ...gate, async (c) =>
    send(c, { progress: await tutoringService.getApprenticeProgress(c.req.param('guildId'), c.var.dashboardUser.userId) }));
  router.get(`${base}/tutor-dashboard`, ...gate, async (c) =>
    send(c, { apprentices: await tutoringService.getTutorDashboard(c.req.param('guildId'), c.var.dashboardUser.userId, c.var.viewer.isAdmin) }));

  // Nouveau tutorat.
  router.post(`${base}/periods`, ...gate, async (c) => {
    if (!c.var.viewer.isManager) return denied(c);
    const guildId = c.req.param('guildId');
    const body = (await readBody<{
      staffMemberId?: unknown;
      mentorId?: unknown;
      plannedDurationDays?: unknown;
      targetGrade?: unknown;
      hierarchyId?: unknown;
      withMissions?: unknown;
      unlockFeatureKeys?: unknown;
    }>(c)) ?? {};
    const apprentice = typeof body.staffMemberId === 'string'
      ? await prisma.staffMember.findFirst({ where: { id: body.staffMemberId, guildId }, select: { id: true, username: true, displayName: true, userId: true } })
      : null;
    if (!apprentice) return send(c, { error: 'Choisis la personne à tutorer parmi le staff.' }, 400);
    const mentor = typeof body.mentorId === 'string' && body.mentorId
      ? await prisma.staffMember.findFirst({ where: { id: body.mentorId, guildId }, select: { id: true } })
      : null;
    if (typeof body.mentorId === 'string' && body.mentorId && !mentor) return send(c, { error: 'Le tuteur doit faire partie du staff.' }, 400);
    if (mentor?.id === apprentice.id) return send(c, { error: 'Une personne ne peut pas être sa propre tutrice.' }, 400);
    if (await prisma.testingPeriod.findFirst({ where: { guildId, staffUserId: apprentice.id, status: 'ONGOING' }, select: { id: true } })) {
      return send(c, { error: 'Cette personne a déjà un tutorat en cours.' }, 409);
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
    if (body.unlockFeatureKeys !== undefined) {
      await prisma.testingPeriod.update({ where: { id: period.id }, data: { unlockFeatureKeys: await readFeatureKeys(guildId, body.unlockFeatureKeys) } });
    }
    if (body.withMissions === true) await createTutoringBoard(guildId, period.id, name, c.var.dashboardUser.userId);
    await audit(c, 'Création tutorat', `Tutorat de ${name}.`);
    return send(c, { period: await getTutoringDetail(guildId, period.id) }, 201);
  });

  // La fiche.
  router.get(`${base}/periods/:periodId`, ...periodGate, async (c) =>
    send(c, { period: await getTutoringDetail(c.req.param('guildId'), c.req.param('periodId')), role: c.var.tutoring.role }));

  // Tuteur, durée prévue, grade et hiérarchie visés.
  router.patch(`${base}/periods/:periodId`, ...periodGate, async (c) => {
    const { period, role, apprenticeName } = c.var.tutoring;
    if (role !== 'manager') return denied(c);
    const guildId = c.req.param('guildId');
    const periodId = c.req.param('periodId');
    const body = (await readBody<{ mentorId?: unknown; plannedDurationDays?: unknown; targetGrade?: unknown; hierarchyId?: unknown; unlockFeatureKeys?: unknown }>(c)) ?? {};
    const data: { mentorId?: string | null; plannedDurationDays?: number; targetGrade?: string | null; hierarchyId?: string | null; unlockFeatureKeys?: string[] } = {};
    if (body.unlockFeatureKeys !== undefined) data.unlockFeatureKeys = await readFeatureKeys(guildId, body.unlockFeatureKeys);
    if (body.mentorId !== undefined) {
      if (body.mentorId === null || body.mentorId === '') data.mentorId = null;
      else {
        const mentor = typeof body.mentorId === 'string'
          ? await prisma.staffMember.findFirst({ where: { id: body.mentorId, guildId }, select: { id: true } })
          : null;
        if (!mentor || mentor.id === period.staffUserId) {
          return send(c, { error: 'Le tuteur doit faire partie du staff et ne pas être le tutoré.' }, 400);
        }
        data.mentorId = mentor.id;
      }
    }
    if (body.plannedDurationDays !== undefined) {
      const days = readDays(body.plannedDurationDays);
      if (days === null) return send(c, { error: 'La durée prévue est un nombre de jours entre 1 et 365.' }, 400);
      data.plannedDurationDays = days;
    }
    if (body.targetGrade !== undefined) data.targetGrade = readText(body.targetGrade, 80);
    if (body.hierarchyId !== undefined) {
      data.hierarchyId = typeof body.hierarchyId === 'string' && body.hierarchyId
        ? (await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId }, select: { id: true } }))?.id ?? null
        : null;
    }
    await prisma.testingPeriod.update({ where: { id: periodId }, data });
    await audit(c, 'Tutorat modifié', `Tutorat de ${apprenticeName} : ${Object.keys(data).join(', ') || 'aucun changement'}.`);
    return send(c, { period: await getTutoringDetail(guildId, periodId), role });
  });

  // Efface le tutorat et son suivi, pas sa liste de missions.
  router.delete(`${base}/periods/:periodId`, ...periodGate, async (c) => {
    const { role, apprenticeName } = c.var.tutoring;
    if (role !== 'manager') return denied(c);
    await prisma.testingPeriod.delete({ where: { id: c.req.param('periodId') } });
    await audit(c, 'Suppression tutorat', `Tutorat de ${apprenticeName}.`);
    return send(c, { ok: true });
  });

  // Crée la liste des missions.
  router.post(`${base}/periods/:periodId/missions-board`, ...periodGate, async (c) => {
    const { period, role, canCoach, apprenticeName } = c.var.tutoring;
    if (!canCoach) return denied(c);
    if (period.doingListId) return send(c, { error: 'Ce tutorat a déjà sa liste de missions.' }, 409);
    const guildId = c.req.param('guildId');
    const periodId = c.req.param('periodId');
    await createTutoringBoard(guildId, periodId, apprenticeName, c.var.dashboardUser.userId);
    return send(c, { period: await getTutoringDetail(guildId, periodId), role }, 201);
  });

  // { state }
  router.put(`${base}/periods/:periodId/objectives/:itemId`, ...periodGate, async (c) => {
    const { period, canCoach } = c.var.tutoring;
    if (!canCoach) return denied(c, 'Seuls le tuteur et les responsables valident les objectifs.');
    if (period.status !== 'ONGOING') return send(c, { error: 'Ce tutorat est terminé.' }, 400);
    const body = (await readBody<{ state?: unknown }>(c)) ?? {};
    if (!ITEM_STATES.includes(body.state as TutoringItemState)) return send(c, { error: 'État inconnu.' }, 400);
    const item = await prisma.tutoringItem.findFirst({ where: { id: c.req.param('itemId'), guildId: c.req.param('guildId') } });
    if (!item || !itemAppliesTo(item, period.hierarchyId, period.targetGrade)) {
      return send(c, { error: 'Objectif introuvable pour ce tutorat.' }, 404);
    }
    const progress = await tutoringService.updateChecklistProgress(c.req.param('periodId'), item.id, body.state as TutoringItemState, c.var.dashboardUser.userId);

    // Déblocage automatique à la validation (`ACQUIRED`) : rôles Discord et accès dashboard
    const unlocked: { roles: string[]; dashboardSection: string | null } = { roles: [], dashboardSection: null };
    if (body.state === 'ACQUIRED') {
      const guildId = c.req.param('guildId');
      if (item.grantRoleIds.length > 0) {
        const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        const member = discordGuild ? await discordGuild.members.fetch(period.staffMember.userId).catch(() => null) : null;
        if (member) {
          for (const roleId of item.grantRoleIds) {
            if (!member.roles.cache.has(roleId)) {
              const ok = await member.roles.add(roleId, `Tutorat validé : ${item.title}`).then(() => true).catch(() => false);
              if (ok) unlocked.roles.push(roleId);
            }
          }
        }
      }
      if (item.grantDashboardSection) {
        unlocked.dashboardSection = item.grantDashboardSection;
      }
      if (unlocked.roles.length > 0 || unlocked.dashboardSection) {
        await audit(
          c,
          'Déblocage automatique tutorat',
          `${period.staffMember.username ?? period.staffMember.userId} · « ${item.title} » → rôles: ${unlocked.roles.length}, section: ${unlocked.dashboardSection ?? 'aucune'}`,
        );
      }
    }

    return send(c, { progress, unlocked });
  });

  // { type, content } : point d'étape.
  router.post(`${base}/periods/:periodId/reports`, ...periodGate, async (c) => {
    const { role, canCoach, apprenticeName } = c.var.tutoring;
    if (!canCoach) return denied(c, "Seuls le tuteur et les responsables font les points d'étape.");
    const body = (await readBody<{ type?: unknown; content?: unknown }>(c)) ?? {};
    const content = readText(body.content);
    if (!REPORT_TYPES.includes(body.type as (typeof REPORT_TYPES)[number]) || !content) {
      return send(c, { error: "Choisis un ressenti et écris le point d'étape." }, 400);
    }
    const periodId = c.req.param('periodId');
    await addMentorReport(periodId, c.var.dashboardUser.userId, body.type as (typeof REPORT_TYPES)[number], content);
    await audit(c, "Point d'étape", `Tutorat de ${apprenticeName} (${body.type}).`);
    return send(c, { period: await getTutoringDetail(c.req.param('guildId'), periodId), role }, 201);
  });

  // { content } : carnet de bord du tutoré.
  router.post(`${base}/periods/:periodId/logs`, ...periodGate, async (c) => {
    const { role } = c.var.tutoring;
    if (role !== 'apprentice' && role !== 'manager') return denied(c, 'Le carnet de bord est tenu par la personne tutorée.');
    const body = (await readBody<{ content?: unknown }>(c)) ?? {};
    const content = readText(body.content);
    if (!content) return send(c, { error: "L'entrée du carnet est vide." }, 400);
    return send(c, { log: await tutoringService.addApprenticeLog(c.req.param('periodId'), content) }, 201);
  });

  // Retire les modules débloqués par ce tutorat.
  router.delete(`${base}/periods/:periodId/grants`, ...periodGate, async (c) => {
    const { role, apprenticeName } = c.var.tutoring;
    if (role !== 'manager') return denied(c);
    const { count } = await prisma.dashboardFeatureUserAccess.deleteMany({
      where: { guildId: c.req.param('guildId'), source: 'TUTORING', sourceId: c.req.param('periodId') },
    });
    await audit(c, 'Droits du tutorat retirés', `Tutorat de ${apprenticeName} : ${count} module(s).`);
    return send(c, { ok: true, count });
  });

  // { status, notes, force } : fin du tutorat.
  router.post(`${base}/periods/:periodId/decision`, ...periodGate, async (c) => {
    const { period, role, canCoach, apprenticeName } = c.var.tutoring;
    const { isAdmin } = c.var.viewer;
    if (!canCoach) return denied(c, 'Seuls le tuteur et les responsables concluent un tutorat.');
    if (period.status !== 'ONGOING') return send(c, { error: 'Ce tutorat est déjà terminé.' }, 400);
    const body = (await readBody<{ status?: unknown; notes?: unknown; force?: unknown }>(c)) ?? {};
    if (body.status !== 'PASSED' && body.status !== 'FAILED') return send(c, { error: 'Décision inconnue.' }, 400);
    const guildId = c.req.param('guildId');
    const periodId = c.req.param('periodId');
    const force = body.force === true;
    if (body.status === 'PASSED') {
      const { minTestDays } = await tutoringService.getTutoringConfig(guildId);
      const days = daysSince(period.startDate);
      if (days < minTestDays && !force) {
        return send(c, { error: `Le tutorat dure depuis ${days} j, il en faut ${minTestDays} pour le valider.`, canForce: isAdmin }, 409);
      }
      if (force && !isAdmin) return denied(c, 'Seul un administrateur valide un tutorat avant la durée minimale.');
    }
    await endTestingPeriod(periodId, body.status, readText(body.notes) ?? undefined);
    const unlocked = body.status === 'PASSED' ? await grantTutoringAccess(guildId, period) : [];
    await audit(c, `Fin de tutorat (${body.status})${force ? ' [FORCÉ]' : ''}`, `Tutorat de ${apprenticeName}.${unlocked.length ? ` Modules débloqués : ${unlocked.join(', ')}.` : ''}`);
    return send(c, { period: await getTutoringDetail(guildId, periodId), role });
  });

  return router;
}
