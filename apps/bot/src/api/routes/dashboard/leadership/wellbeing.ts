/**
 * Cellule bien-être : espace confidentiel cloisonné avec accès d'urgence
 * journalisé pour la direction en cas d'enquête interne.
 *
 * Les textes des dossiers sont chiffrés en base (wellbeingCrypto), chaque
 * modification laisse une entrée d'historique, et l'accès d'urgence peut
 * exiger la validation d'une seconde personne et se limiter à un membre.
 */
import { Hono, type Context } from 'hono';
import type { Client, Guild } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import {
  BREAK_GLASS_HOURS,
  BREAK_GLASS_REQUEST_HOURS,
  DEFAULT_ALERT_EVENTS,
  MAX_ALERT_USERS,
  breakGlassScope,
  caseChangeEvents,
  cleanAlertEvents,
  cleanResources,
  decideBreakGlassError,
  describeConfigChange,
  resolveWellbeingAccess,
  resourcesMessage,
  type CaseEventDraft,
  type CaseTracked,
} from '../../../../services/staff/wellbeingPolicy.js';
import { sendWellbeingAlert } from '../../../../services/staff/wellbeingAlerts.js';
import { openCase, openNote, sealCaseFields, sealNote } from '../../../../services/staff/wellbeingCrypto.js';
import { bodyText } from '../../../../utils/bodyText.js';

const CATEGORIES = ['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI'];
const SEVERITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const STATUSES = ['OPEN', 'MONITORING', 'CLOSED'];
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HOUR_MS = 60 * 60 * 1000;
const MAX_STALE_DAYS = 90;
const MODULE_LABEL = 'Cellule bien-être';

const CASE_INCLUDE = {
  notes: { orderBy: { createdAt: 'asc' as const } },
  events: { orderBy: { createdAt: 'asc' as const } },
};

async function actorOf(discordGuild: Guild | null, userId: string) {
  const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
  return {
    userId,
    roleIds: new Set(member ? member.roles.cache.map((r) => r.id) : []),
    isOwner: discordGuild?.ownerId === userId,
  };
}

async function resolveWellbeingRole(client: Client, guildId: string, userId: string) {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId } });
  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const actor = await actorOf(discordGuild, userId);

  const base = resolveWellbeingAccess(config, actor, false);
  // Seul un accès validé et non échu compte : une demande en attente n'ouvre rien.
  const activeBreakGlass = base.isDirector && !base.isTeamMember
    ? await prisma.wellbeingBreakGlassLog.findFirst({
        where: { guildId, actorId: userId, status: 'APPROVED', expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      })
    : null;

  return {
    ...resolveWellbeingAccess(config, actor, !!activeBreakGlass),
    config,
    discordGuild,
    activeBreakGlass,
  };
}

type WellbeingState = Awaited<ReturnType<typeof resolveWellbeingRole>>;

/** Un référent doit appartenir à la cellule : il lit le dossier qu'on lui confie. */
async function isTeamMemberId(state: WellbeingState, userId: string): Promise<boolean> {
  if (!SNOWFLAKE_RE.test(userId)) return false;
  return resolveWellbeingAccess(state.config, await actorOf(state.discordGuild, userId), false).isTeamMember;
}

/** Id d'un dossier de ce serveur, ou null : un id inconnu n'entre pas au journal. */
async function caseIdOfGuild(guildId: string, caseId: unknown): Promise<string | null> {
  const id = bodyText(caseId, 64);
  if (!id) return null;
  const found = await prisma.wellbeingCase.findFirst({ where: { id, guildId }, select: { id: true } });
  return found?.id ?? null;
}

function actorName(c: Context): string {
  const user = c.var.dashboardUser;
  return user.username ?? user.userId;
}

async function recordEvents(caseId: string, c: Context, drafts: Array<CaseEventDraft | { type: string; fromValue?: string | null; toValue?: string | null }>) {
  if (drafts.length === 0) return;
  await prisma.wellbeingCaseEvent.createMany({
    data: drafts.map((draft) => ({
      caseId,
      actorId: c.var.dashboardUser.userId,
      actorName: actorName(c),
      type: draft.type,
      fromValue: draft.fromValue ?? null,
      toValue: draft.toValue ?? null,
    })),
  });
}

function parseReviewAt(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(bodyText(value, 40));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function audit(client: Client, c: Context, guildId: string, action: string, details: string, eventType = 'Manuel') {
  await pushAudit(guildId, {
    user: auditUserOf(c),
    action,
    context: getGuildName(client, guildId),
    module: MODULE_LABEL,
    eventType,
    details,
    channelId: null,
  });
}

export function createWellbeingRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  router.get(`${base}/status`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      return send(c, {
        enabled: state.config?.enabled ?? false,
        requireReason: state.config?.requireReason ?? true,
        breakGlassApproval: state.config?.breakGlassApproval ?? false,
        reportEnabled: state.config?.reportEnabled ?? false,
        isTeamMember: state.isTeamMember,
        isDirector: state.isDirector,
        canConfigure: state.canConfigure,
        hasCaseAccess: state.canReadCases,
        canWriteCases: state.canWriteCases,
        breakGlassExpiresAt: state.activeBreakGlass?.expiresAt.toISOString() ?? null,
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching status:', err);
      return fail(c, err, 'Erreur lors du chargement de la cellule bien-être.', 'WellbeingAPI');
    }
  });

  router.get(`${base}/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.isDirector) return send(c, { error: 'Réservé à la direction.' }, 403);
      const { resources: _resources, ...config } = state.config ?? {
        guildId,
        enabled: false,
        teamRoleIds: [],
        teamUserIds: [],
        directorRoleIds: [],
        directorUserIds: [],
        requireReason: true,
        alertChannelId: null,
        alertUserIds: [],
        alertEvents: DEFAULT_ALERT_EVENTS,
        breakGlassApproval: false,
        reportEnabled: false,
        staleCriticalDays: 7,
        resources: [],
      };
      return send(c, { config });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching config:', err);
      return fail(c, err, 'Erreur lors du chargement de la configuration.', 'WellbeingAPI');
    }
  });

  router.put(`${base}/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canConfigure) {
        return send(c, { error: 'Seul le propriétaire du serveur peut modifier la cellule bien-être.' }, 403);
      }
      const body = await readBody<{
        enabled?: boolean;
        teamRoleIds?: string[];
        teamUserIds?: string[];
        directorRoleIds?: string[];
        directorUserIds?: string[];
        requireReason?: boolean;
        alertChannelId?: string | null;
        alertUserIds?: string[];
        alertEvents?: string[];
        breakGlassApproval?: boolean;
        reportEnabled?: boolean;
        staleCriticalDays?: number;
      }>(c);
      const cleanIds = (arr: unknown) =>
        Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && SNOWFLAKE_RE.test(x)) : [];
      // Un salon d'alerte doit appartenir au serveur : sinon les alertes partiraient ailleurs.
      const alertChannelId = (() => {
        const id = bodyText(body?.alertChannelId, 20);
        return SNOWFLAKE_RE.test(id) && state.discordGuild?.channels.cache.has(id) ? id : null;
      })();
      const alertUserIds = [...new Set(cleanIds(body?.alertUserIds))].slice(0, MAX_ALERT_USERS);
      const alertEvents = cleanAlertEvents(body?.alertEvents);
      const staleCriticalDays = typeof body?.staleCriticalDays === 'number' && Number.isInteger(body.staleCriticalDays)
        ? Math.min(Math.max(body.staleCriticalDays, 0), MAX_STALE_DAYS)
        : undefined;

      const config = await prisma.wellbeingConfig.upsert({
        where: { guildId },
        create: {
          guildId,
          enabled: body?.enabled === true,
          teamRoleIds: cleanIds(body?.teamRoleIds),
          teamUserIds: cleanIds(body?.teamUserIds),
          directorRoleIds: cleanIds(body?.directorRoleIds),
          directorUserIds: cleanIds(body?.directorUserIds),
          requireReason: body?.requireReason !== false,
          alertChannelId,
          alertUserIds,
          ...(body?.alertEvents !== undefined ? { alertEvents } : {}),
          breakGlassApproval: body?.breakGlassApproval === true,
          reportEnabled: body?.reportEnabled === true,
          ...(staleCriticalDays !== undefined ? { staleCriticalDays } : {}),
        },
        update: {
          ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(typeof body?.requireReason === 'boolean' ? { requireReason: body.requireReason } : {}),
          ...(typeof body?.breakGlassApproval === 'boolean' ? { breakGlassApproval: body.breakGlassApproval } : {}),
          ...(typeof body?.reportEnabled === 'boolean' ? { reportEnabled: body.reportEnabled } : {}),
          ...(body?.teamRoleIds !== undefined ? { teamRoleIds: cleanIds(body.teamRoleIds) } : {}),
          ...(body?.teamUserIds !== undefined ? { teamUserIds: cleanIds(body.teamUserIds) } : {}),
          ...(body?.directorRoleIds !== undefined ? { directorRoleIds: cleanIds(body.directorRoleIds) } : {}),
          ...(body?.directorUserIds !== undefined ? { directorUserIds: cleanIds(body.directorUserIds) } : {}),
          ...(body?.alertChannelId !== undefined ? { alertChannelId } : {}),
          ...(body?.alertUserIds !== undefined ? { alertUserIds } : {}),
          ...(body?.alertEvents !== undefined ? { alertEvents } : {}),
          ...(staleCriticalDays !== undefined ? { staleCriticalDays } : {}),
        },
      });

      await audit(client, c, guildId, 'Configuration Cellule bien-être', describeConfigChange(state.config, config, (id) => {
        const role = state.discordGuild?.roles.cache.get(id);
        if (role) return `@${role.name}`;
        return state.discordGuild?.members.cache.get(id)?.user.username ?? id;
      }));

      // Les destinataires d'avant comme ceux d'après apprennent le changement :
      // retirer quelqu'un des alertes ne doit pas passer sous silence.
      void sendWellbeingAlert(client, guildId, {
        ...config,
        alertChannelId: config.alertChannelId ?? state.config?.alertChannelId ?? null,
        alertUserIds: [...new Set([...(state.config?.alertUserIds ?? []), ...config.alertUserIds])],
        alertEvents: [...new Set([...(state.config?.alertEvents ?? []), ...config.alertEvents])],
      }, 'CONFIG_CHANGE', { actorId: user.userId });

      const { resources: _resources, ...saved } = config;
      return send(c, { config: saved });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving config:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde de la configuration.', 'WellbeingAPI');
    }
  });

  // Accès exceptionnel et journalisé (« break-glass ») pour la direction.
  router.post(`${base}/break-glass`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.isDirector) {
        return send(c, { error: "Seule la direction peut déclencher un accès d'urgence." }, 403);
      }
      const body = await readBody<{ reason?: string; caseId?: string; subjectUserId?: string }>(c);
      const reason = bodyText(body?.reason, 500);
      if ((state.config?.requireReason ?? true) && reason.length < 8) {
        return send(c, { error: 'Un motif détaillé (8 caractères min.) est obligatoire pour cet accès journalisé.' }, 400);
      }
      const subjectUserId = bodyText(body?.subjectUserId, 20);
      const needsApproval = state.config?.breakGlassApproval === true;
      const expiresAt = new Date(Date.now() + (needsApproval ? BREAK_GLASS_REQUEST_HOURS : BREAK_GLASS_HOURS) * HOUR_MS);

      const log = await prisma.wellbeingBreakGlassLog.create({
        data: {
          guildId,
          actorId: user.userId,
          actorName: actorName(c),
          caseId: await caseIdOfGuild(guildId, body?.caseId),
          subjectUserId: SNOWFLAKE_RE.test(subjectUserId) ? subjectUserId : null,
          reason: reason || 'Enquête interne (sans motif requis)',
          status: needsApproval ? 'PENDING' : 'APPROVED',
          expiresAt,
        },
      });

      const scope = log.subjectUserId ? ` — limité au membre ${log.subjectUserId}` : '';
      await audit(client, c, guildId, 'Break-glass Cellule bien-être', needsApproval
        ? `Accès exceptionnel demandé, en attente de validation${scope} — Motif : ${log.reason}`
        : `Accès exceptionnel activé jusqu'à ${expiresAt.toISOString()}${scope} — Motif : ${log.reason}`, 'Sécurité');

      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', {
        actorId: user.userId,
        reason: log.reason,
        ...(needsApproval ? { stage: 'requested' as const } : { expiresAt }),
      });

      return send(c, { ok: true, pending: needsApproval, expiresAt: expiresAt.toISOString(), log }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error activating break-glass:', err);
      return fail(c, err, "Erreur lors de l'activation de l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  // Seconde clé : une autre personne de la direction ou de la cellule valide ou refuse.
  router.post(`${base}/break-glass/:logId/decide`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      const log = await prisma.wellbeingBreakGlassLog.findFirst({ where: { id: c.req.param('logId'), guildId } });
      if (!log) return send(c, { error: 'Demande introuvable.' }, 404);
      const now = new Date();
      const error = decideBreakGlassError(log, { userId: user.userId, canDecide: state.isDirector || state.isTeamMember }, now);
      if (error === 'forbidden') return send(c, { error: 'Réservé à la direction et à la cellule.' }, 403);
      if (error === 'self') return send(c, { error: 'Une autre personne doit valider votre demande.' }, 403);
      if (error === 'closed') return send(c, { error: 'Cette demande est déjà traitée ou a expiré.' }, 409);

      const body = await readBody<{ approve?: boolean }>(c);
      const approve = body?.approve === true;
      const expiresAt = approve ? new Date(now.getTime() + BREAK_GLASS_HOURS * HOUR_MS) : now;
      const updated = await prisma.wellbeingBreakGlassLog.update({
        where: { id: log.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          approvedById: user.userId,
          approvedByName: actorName(c),
          decidedAt: now,
          expiresAt,
        },
      });

      await audit(client, c, guildId, 'Break-glass Cellule bien-être', approve
        ? `Accès exceptionnel de ${log.actorName} validé jusqu'à ${expiresAt.toISOString()}`
        : `Accès exceptionnel de ${log.actorName} refusé`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', {
        actorId: user.userId,
        stage: approve ? 'approved' : 'rejected',
        expiresAt,
      }, [log.actorId]);

      return send(c, { log: updated });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deciding break-glass:', err);
      return fail(c, err, "Erreur lors de la décision sur l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  router.get(`${base}/break-glass-logs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.isDirector && !state.isTeamMember) return send(c, { error: 'Accès refusé.' }, 403);
      const logs = await prisma.wellbeingBreakGlassLog.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return send(c, { logs });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching break-glass logs:', err);
      return fail(c, err, 'Erreur lors du chargement du journal.', 'WellbeingAPI');
    }
  });

  // Dossiers confidentiels (strictement cloisonnés)
  router.get(`${base}/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canReadCases) {
        return send(c, { error: 'Espace cloisonné : accès réservé à la cellule bien-être (ou break-glass direction).' }, 403);
      }
      // Filtre optionnel : la fiche membre ne charge que les dossiers de la personne.
      const requested = c.req.query('subjectUserId');
      const subjectUserId = requested && SNOWFLAKE_RE.test(requested) ? requested : null;
      // Un accès d'urgence ciblé ne montre que le dossier ou le membre visé.
      const scope = !state.isTeamMember && state.activeBreakGlass ? breakGlassScope(state.activeBreakGlass) : {};
      if (scope.subjectUserId && subjectUserId && scope.subjectUserId !== subjectUserId) return send(c, { cases: [] });
      const cases = await prisma.wellbeingCase.findMany({
        where: { guildId, ...(subjectUserId ? { subjectUserId } : {}), ...scope },
        include: CASE_INCLUDE,
        orderBy: { updatedAt: 'desc' },
      });
      // Sous accès d'urgence, chaque consultation laisse une trace, sans le contenu des dossiers.
      if (!state.isTeamMember) {
        await audit(client, c, guildId, 'Consultation Cellule bien-être',
          `Accès d'urgence : ${cases.length} dossier(s) consulté(s)${subjectUserId ? ` pour le membre ${subjectUserId}` : ''}.`, 'Sécurité');
      }
      void sendWellbeingAlert(client, guildId, state.config, state.isTeamMember ? 'TEAM_READ' : 'EMERGENCY_READ', {
        actorId: user.userId,
        caseCount: cases.length,
      });
      return send(c, { cases: cases.map(openCase) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing cases:', err);
      return fail(c, err, 'Erreur lors du chargement des dossiers.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const body = await readBody<{
        subjectUserId?: string;
        subjectName?: string;
        title?: string;
        category?: string;
        severity?: string;
        summary?: string;
        assigneeId?: string | null;
        reviewAt?: string | null;
      }>(c);
      const subjectName = bodyText(body?.subjectName, 80);
      const title = bodyText(body?.title, 160);
      const summary = bodyText(body?.summary, 4000);
      const subjectUserId = bodyText(body?.subjectUserId, 20);
      if (!subjectName || !title || !summary) {
        return send(c, { error: 'Personne concernée, titre et résumé sont obligatoires.' }, 400);
      }
      const assigneeId = bodyText(body?.assigneeId, 20);
      if (assigneeId && !(await isTeamMemberId(state, assigneeId))) {
        return send(c, { error: 'Le référent doit faire partie de la cellule.' }, 400);
      }
      const reviewAt = parseReviewAt(body?.reviewAt) ?? null;

      const created = await prisma.wellbeingCase.create({
        data: {
          guildId,
          subjectUserId: SNOWFLAKE_RE.test(subjectUserId) ? subjectUserId : null,
          ...sealCaseFields(guildId, { title, subjectName, summary }),
          category: CATEGORIES.includes(body?.category ?? '') ? body!.category! : 'SOUTIEN',
          severity: SEVERITIES.includes(body?.severity ?? '') ? body!.severity! : 'NORMAL',
          createdById: user.userId,
          createdByName: actorName(c),
          assigneeId: assigneeId || null,
          reviewAt,
        },
      });
      await recordEvents(created.id, c, [
        { type: 'CREATED' },
        ...(assigneeId ? [{ type: 'ASSIGNEE', toValue: assigneeId }] : []),
        ...(reviewAt ? [{ type: 'REVIEW', toValue: reviewAt.toISOString() }] : []),
      ]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'créé' },
        assigneeId ? [assigneeId] : []);

      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: created.id }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error creating case:', err);
      return fail(c, err, 'Erreur lors de la création du dossier.', 'WellbeingAPI');
    }
  });

  router.patch(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await prisma.wellbeingCase.findFirst({ where: { id: caseId, guildId } });
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ status?: string; severity?: string; assigneeId?: string | null; reviewAt?: string | null }>(c);

      const patch: Partial<CaseTracked> = {
        ...(body?.status && STATUSES.includes(body.status) ? { status: body.status } : {}),
        ...(body?.severity && SEVERITIES.includes(body.severity) ? { severity: body.severity } : {}),
      };
      if (body?.assigneeId !== undefined) {
        const assigneeId = bodyText(body.assigneeId, 20);
        if (assigneeId && !(await isTeamMemberId(state, assigneeId))) {
          return send(c, { error: 'Le référent doit faire partie de la cellule.' }, 400);
        }
        patch.assigneeId = assigneeId || null;
      }
      const reviewAt = parseReviewAt(body?.reviewAt);
      if (reviewAt !== undefined) patch.reviewAt = reviewAt;

      const events = caseChangeEvents(existing, patch);
      if (events.length === 0) {
        const unchanged = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
        return send(c, { item: openCase(unchanged) });
      }
      const updated = await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: {
          ...patch,
          // Une nouvelle échéance réarme sa relance.
          ...(events.some((e) => e.type === 'REVIEW') ? { reviewRemindedAt: null } : {}),
          lastActivityAt: new Date(),
        },
      });
      await recordEvents(caseId, c, events);
      const newAssignee = events.find((e) => e.type === 'ASSIGNEE')?.toValue;
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'modifié' },
        newAssignee ? [newAssignee] : []);

      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: updated.id }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error updating case:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du dossier.', 'WellbeingAPI');
    }
  });

  // Créer, modifier, noter ou supprimer : réservé à la cellule, l'accès d'urgence ne sert qu'à lire.
  router.delete(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const { count } = await prisma.wellbeingCase.deleteMany({ where: { id: caseId, guildId } });
      if (count === 0) return send(c, { error: 'Dossier introuvable.' }, 404);
      await audit(client, c, guildId, 'Suppression Cellule bien-être', `Dossier ${caseId} supprimé avec ses notes.`);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'supprimé' });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deleting case:', err);
      return fail(c, err, 'Erreur lors de la suppression du dossier.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await prisma.wellbeingCase.findFirst({ where: { id: caseId, guildId }, select: { id: true } });
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ content?: string }>(c);
      const content = bodyText(body?.content, 4000);
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);
      const note = await prisma.wellbeingCaseNote.create({
        data: { caseId, authorId: user.userId, authorName: actorName(c), content: sealNote(caseId, content) },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'NOTE' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'annoté' });
      return send(c, { note: openNote(note) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding case note:', err);
      return fail(c, err, "Erreur lors de l'ajout de la note.", 'WellbeingAPI');
    }
  });

  // Ressources d'aide : tenues par la cellule, envoyées au membre en un clic.
  router.get(`${base}/resources`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.isTeamMember && !state.isDirector) return send(c, { error: 'Accès refusé.' }, 403);
      return send(c, { resources: cleanResources(state.config?.resources) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching resources:', err);
      return fail(c, err, 'Erreur lors du chargement des ressources.', 'WellbeingAPI');
    }
  });

  router.put(`${base}/resources`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const body = await readBody<{ resources?: unknown }>(c);
      const resources = cleanResources(body?.resources);
      await prisma.wellbeingConfig.update({ where: { guildId }, data: { resources: resources as unknown as Prisma.InputJsonValue } });
      await audit(client, c, guildId, 'Ressources Cellule bien-être', `${resources.length} ressource(s) d'aide enregistrée(s).`);
      return send(c, { resources });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving resources:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde des ressources.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/send-resources`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await prisma.wellbeingCase.findFirst({ where: { id: caseId, guildId }, select: { subjectUserId: true } });
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (!existing.subjectUserId) return send(c, { error: "Ce dossier n'est lié à aucun membre du serveur." }, 400);
      const resources = cleanResources(state.config?.resources);
      if (resources.length === 0) return send(c, { error: "Aucune ressource d'aide n'est enregistrée." }, 400);

      const target = await client.users.fetch(existing.subjectUserId).catch(() => null);
      const delivered = target
        ? await target.send({ content: resourcesMessage(getGuildName(client, guildId), resources), allowedMentions: { parse: [] } })
          .then(() => true, () => false)
        : false;
      if (!delivered) return send(c, { error: 'Message privé impossible : le membre les a peut-être fermés.' }, 409);

      await recordEvents(caseId, c, [{ type: 'RESOURCES_SENT', toValue: String(resources.length) }]);
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error sending resources:', err);
      return fail(c, err, "Erreur lors de l'envoi des ressources.", 'WellbeingAPI');
    }
  });

  return router;
}
