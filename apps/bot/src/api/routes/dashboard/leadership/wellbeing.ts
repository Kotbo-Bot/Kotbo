/**
 * Cellule bien-être : espace confidentiel cloisonné avec accès break-glass
 * journalisé pour la direction en cas d'enquête interne.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { describeConfigChange } from '../../../../services/staff/wellbeingPolicy.js';

const BREAK_GLASS_HOURS = 2;
const CATEGORIES = ['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI'];
const SEVERITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const STATUSES = ['OPEN', 'MONITORING', 'CLOSED'];
const SNOWFLAKE_RE = /^\d{17,20}$/;

async function resolveWellbeingRole(client: Client, guildId: string, userId: string, isAdmin: boolean) {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId } });
  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
  const roleIds = new Set(member ? member.roles.cache.map((r) => r.id) : []);
  const isOwner = discordGuild?.ownerId === userId;

  const isTeamMember = !!config?.enabled && (
    config.teamUserIds.includes(userId)
    || config.teamRoleIds.some((r) => roleIds.has(r))
  );
  const isDirector = isOwner || isAdmin || (
    !!config && (
      config.directorUserIds.includes(userId)
      || config.directorRoleIds.some((r) => roleIds.has(r))
    )
  );

  const activeBreakGlass = isDirector && !isTeamMember
    ? await prisma.wellbeingBreakGlassLog.findFirst({
        where: { guildId, actorId: userId, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      })
    : null;

  return {
    config,
    isTeamMember,
    isDirector,
    // La composition de la cellule décide qui lit les dossiers : seul le propriétaire
    // la modifie. Un admin qui pourrait s'y ajouter contournerait l'accès d'urgence.
    canConfigure: isOwner,
    discordGuild,
    hasCaseAccess: !!config?.enabled && (isTeamMember || !!activeBreakGlass),
    activeBreakGlass,
  };
}

/** Id d'un dossier de ce serveur, ou null : un id inconnu n'entre pas au journal. */
async function caseIdOfGuild(guildId: string, caseId: string | undefined): Promise<string | null> {
  const id = caseId?.trim();
  if (!id) return null;
  const found = await prisma.wellbeingCase.findFirst({ where: { id, guildId }, select: { id: true } });
  return found?.id ?? null;
}

export function createWellbeingRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  router.get(`${base}/status`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      return send(c, {
        enabled: state.config?.enabled ?? false,
        requireReason: state.config?.requireReason ?? true,
        isTeamMember: state.isTeamMember,
        isDirector: state.isDirector,
        canConfigure: state.canConfigure,
        hasCaseAccess: state.hasCaseAccess,
        breakGlassExpiresAt: state.activeBreakGlass?.expiresAt.toISOString() ?? null,
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching status:', err);
      return fail(c, err, 'Erreur lors du chargement de la cellule bien-être.', 'WellbeingAPI');
    }
  });

  router.get(`${base}/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.isDirector) {
        return send(c, { error: 'Réservé à la direction.' }, 403);
      }
      return send(c, {
        config: state.config ?? {
          guildId,
          enabled: false,
          teamRoleIds: [],
          teamUserIds: [],
          directorRoleIds: [],
          directorUserIds: [],
          requireReason: true,
        },
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching config:', err);
      return fail(c, err, 'Erreur lors du chargement de la configuration.', 'WellbeingAPI');
    }
  });

  router.put(`${base}/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
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
      }>(c);
      const cleanIds = (arr: unknown) =>
        Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && SNOWFLAKE_RE.test(x)) : [];

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
        },
        update: {
          ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(body?.teamRoleIds !== undefined ? { teamRoleIds: cleanIds(body.teamRoleIds) } : {}),
          ...(body?.teamUserIds !== undefined ? { teamUserIds: cleanIds(body.teamUserIds) } : {}),
          ...(body?.directorRoleIds !== undefined ? { directorRoleIds: cleanIds(body.directorRoleIds) } : {}),
          ...(body?.directorUserIds !== undefined ? { directorUserIds: cleanIds(body.directorUserIds) } : {}),
          ...(typeof body?.requireReason === 'boolean' ? { requireReason: body.requireReason } : {}),
        },
      });

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Configuration Cellule bien-être',
        context: getGuildName(client, guildId),
        module: 'Cellule bien-être',
        eventType: 'Manuel',
        details: describeConfigChange(state.config, config, (id) => {
          const role = state.discordGuild?.roles.cache.get(id);
          if (role) return `@${role.name}`;
          return state.discordGuild?.members.cache.get(id)?.user.username ?? id;
        }),
        channelId: null,
      });

      return send(c, { config });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error saving config:', err);
      return fail(c, err, 'Erreur lors de la sauvegarde de la configuration.', 'WellbeingAPI');
    }
  });

  // Accès exceptionnel et journalisé (« break-glass ») pour la direction
  router.post(`${base}/break-glass`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.isDirector) {
        return send(c, { error: "Seule la direction peut déclencher un accès d'urgence." }, 403);
      }
      const body = await readBody<{ reason?: string; caseId?: string }>(c);
      const reason = body?.reason?.trim().slice(0, 500) ?? '';
      if ((state.config?.requireReason ?? true) && reason.length < 8) {
        return send(c, { error: 'Un motif détaillé (8 caractères min.) est obligatoire pour cet accès journalisé.' }, 400);
      }

      const expiresAt = new Date(Date.now() + BREAK_GLASS_HOURS * 60 * 60 * 1000);
      const log = await prisma.wellbeingBreakGlassLog.create({
        data: {
          guildId,
          actorId: user.userId,
          actorName: user.username ?? user.userId,
          caseId: await caseIdOfGuild(guildId, body?.caseId),
          reason: reason || 'Enquête interne (sans motif requis)',
          expiresAt,
        },
      });

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Break-glass Cellule bien-être',
        context: getGuildName(client, guildId),
        module: 'Cellule bien-être',
        eventType: 'Sécurité',
        details: `Accès exceptionnel activé jusqu'à ${expiresAt.toISOString()} — Motif : ${log.reason}`,
        channelId: null,
      });

      return send(c, { ok: true, expiresAt: expiresAt.toISOString(), log }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error activating break-glass:', err);
      return fail(c, err, "Erreur lors de l'activation de l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  router.get(`${base}/break-glass-logs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.isDirector && !state.isTeamMember) {
        return send(c, { error: 'Accès refusé.' }, 403);
      }
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
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.hasCaseAccess) {
        return send(c, { error: 'Espace cloisonné : accès réservé à la cellule bien-être (ou break-glass direction).' }, 403);
      }
      // Filtre optionnel : la fiche membre ne charge que les dossiers de la personne.
      const requested = c.req.query('subjectUserId');
      const subjectUserId = requested && SNOWFLAKE_RE.test(requested) ? requested : null;
      const cases = await prisma.wellbeingCase.findMany({
        where: { guildId, ...(subjectUserId ? { subjectUserId } : {}) },
        include: { notes: { orderBy: { createdAt: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
      });
      // Sous accès d'urgence, chaque consultation laisse une trace, sans le contenu des dossiers.
      if (!state.isTeamMember) {
        await pushAudit(guildId, {
          user: auditUserOf(c),
          action: 'Consultation Cellule bien-être',
          context: getGuildName(client, guildId),
          module: 'Cellule bien-être',
          eventType: 'Sécurité',
          details: `Accès d'urgence : ${cases.length} dossier(s) consulté(s)${subjectUserId ? ` pour le membre ${subjectUserId}` : ''}.`,
          channelId: null,
        });
      }
      return send(c, { cases });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing cases:', err);
      return fail(c, err, 'Erreur lors du chargement des dossiers.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.hasCaseAccess) {
        return send(c, { error: 'Accès refusé à la cellule bien-être.' }, 403);
      }
      const body = await readBody<{
        subjectUserId?: string;
        subjectName?: string;
        title?: string;
        category?: string;
        severity?: string;
        summary?: string;
      }>(c);
      const subjectName = body?.subjectName?.trim().slice(0, 80) ?? '';
      const title = body?.title?.trim().slice(0, 160) ?? '';
      const summary = body?.summary?.trim().slice(0, 4000) ?? '';
      if (!subjectName || !title || !summary) {
        return send(c, { error: 'Personne concernée, titre et résumé sont obligatoires.' }, 400);
      }
      const created = await prisma.wellbeingCase.create({
        data: {
          guildId,
          subjectUserId: SNOWFLAKE_RE.test(body?.subjectUserId?.trim() ?? '') ? body!.subjectUserId!.trim() : null,
          subjectName,
          title,
          category: CATEGORIES.includes(body?.category ?? '') ? body!.category! : 'SOUTIEN',
          severity: SEVERITIES.includes(body?.severity ?? '') ? body!.severity! : 'NORMAL',
          summary,
          createdById: user.userId,
          createdByName: user.username ?? user.userId,
        },
        include: { notes: true },
      });
      return send(c, { item: created }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error creating case:', err);
      return fail(c, err, 'Erreur lors de la création du dossier.', 'WellbeingAPI');
    }
  });

  router.patch(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.hasCaseAccess) return send(c, { error: 'Accès refusé.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await prisma.wellbeingCase.findFirst({ where: { id: caseId, guildId } });
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ status?: string; severity?: string }>(c);
      const updated = await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: {
          ...(body?.status && STATUSES.includes(body.status) ? { status: body.status } : {}),
          ...(body?.severity && SEVERITIES.includes(body.severity) ? { severity: body.severity } : {}),
        },
        include: { notes: { orderBy: { createdAt: 'asc' } } },
      });
      return send(c, { item: updated });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error updating case:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du dossier.', 'WellbeingAPI');
    }
  });

  // Suppression d'un dossier : réservée à la cellule, l'accès d'urgence ne sert qu'à lire.
  router.delete(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.config?.enabled || !state.isTeamMember) return send(c, { error: 'Réservé à la cellule bien-être.' }, 403);
      const caseId = c.req.param('caseId');
      const { count } = await prisma.wellbeingCase.deleteMany({ where: { id: caseId, guildId } });
      if (count === 0) return send(c, { error: 'Dossier introuvable.' }, 404);
      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Suppression Cellule bien-être',
        context: getGuildName(client, guildId),
        module: 'Cellule bien-être',
        eventType: 'Manuel',
        details: `Dossier ${caseId} supprimé avec ses notes.`,
        channelId: null,
      });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deleting case:', err);
      return fail(c, err, 'Erreur lors de la suppression du dossier.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const isAdmin = c.var.effectiveAccess.level === 'admin';
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId, isAdmin);
      if (!state.hasCaseAccess) return send(c, { error: 'Accès refusé.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await prisma.wellbeingCase.findFirst({ where: { id: caseId, guildId } });
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ content?: string }>(c);
      const content = body?.content?.trim().slice(0, 4000) ?? '';
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);
      const note = await prisma.wellbeingCaseNote.create({
        data: {
          caseId,
          authorId: user.userId,
          authorName: user.username ?? user.userId,
          content,
        },
      });
      return send(c, { note }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding case note:', err);
      return fail(c, err, "Erreur lors de l'ajout de la note.", 'WellbeingAPI');
    }
  });

  return router;
}
