/**
 * Contenu d'un dossier de suivi : notes (et leur correction), documents
 * Google Drive et plan d'action. Réservé à la cellule.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { cleanMentionIds, mentionText } from '../../../../services/staff/wellbeingAlertPolicy.js';
import {
  ATTACHMENT_LABEL_MAX,
  MAX_CASE_ATTACHMENTS,
  cleanDriveLink,
  MAX_CASE_TASKS,
  TASK_LABEL_MAX,
  assigneeConflict,
  canEditNote,
  caseVisibilityWhere,
} from '../../../../services/staff/wellbeingCasePolicy.js';
import { sendWellbeingAlert, sendWellbeingDirect } from '../../../../services/staff/wellbeingAlerts.js';
import { openCase, openNote, sealNote } from '../../../../services/staff/wellbeingCrypto.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { addPlanTasks } from '../../../../services/staff/wellbeingTaskPlans.js';
import {
  actorName,
  CASE_INCLUDE,
  customizationOf,
  findVisibleCase,
  fullCase,
  isTeamMemberId,
  parseReviewAt,
  recordEvents,
  resolveWellbeingRole,
} from './wellbeingShared.js';

export function createWellbeingCaseItemsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  router.post(`${base}/cases/:caseId/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ content?: string; notifyUserIds?: unknown }>(c);
      const content = bodyText(body?.content, 4000);
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);
      const note = await prisma.wellbeingCaseNote.create({
        data: { caseId, authorId: user.userId, authorName: actorName(c), content: sealNote(caseId, content) },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'NOTE' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'annoté' });
      // Collègues prévenus : de la cellule seulement, ni l'auteur ni la personne concernée.
      const mentioned: string[] = [];
      for (const id of cleanMentionIds(body?.notifyUserIds)) {
        if (id !== user.userId && id !== existing.subjectUserId && await isTeamMemberId(state, id)) mentioned.push(id);
      }
      if (mentioned.length > 0) void sendWellbeingDirect(client, mentioned, mentionText(user.userId));
      return send(c, { note: openNote(note) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding case note:', err);
      return fail(c, err, "Erreur lors de l'ajout de la note.", 'WellbeingAPI');
    }
  });

  // Correction d'une note par son auteur : la première version reste lisible.
  router.patch(`${base}/cases/:caseId/notes/:noteId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const note = await prisma.wellbeingCaseNote.findFirst({
        where: { id: c.req.param('noteId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (!note) return send(c, { error: 'Note introuvable.' }, 404);
      if (!canEditNote(note, user.userId, new Date())) {
        return send(c, { error: 'Seul son auteur corrige une note, dans les 48 heures.' }, 403);
      }
      const body = await readBody<{ content?: string }>(c);
      const content = bodyText(body?.content, 4000);
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);
      await prisma.wellbeingCaseNote.update({
        where: { id: note.id },
        data: {
          content: sealNote(caseId, content),
          // La première version est gardée une fois pour toutes, même après plusieurs corrections.
          ...(note.originalContent ? {} : { originalContent: note.content }),
          editedAt: new Date(),
        },
      });
      await recordEvents(caseId, c, [{ type: 'NOTE_EDITED' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'annoté (note corrigée)' });
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error editing note:', err);
      return fail(c, err, 'Erreur lors de la correction de la note.', 'WellbeingAPI');
    }
  });

  // Documents Google Drive : seul le lien est gardé, chiffré. L'accès au
  // fichier reste réglé par son partage dans Drive.
  router.post(`${base}/cases/:caseId/attachments`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await prisma.wellbeingCase.findFirst({
        where: { AND: [{ id: caseId }, caseVisibilityWhere(guildId, user.userId)] },
        select: { id: true, _count: { select: { attachments: true } } },
      });
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (existing._count.attachments >= MAX_CASE_ATTACHMENTS) {
        return send(c, { error: `Un dossier compte au plus ${MAX_CASE_ATTACHMENTS} documents.` }, 400);
      }
      const body = await readBody<{ label?: string; url?: string }>(c);
      const url = cleanDriveLink(body?.url);
      if (!url) return send(c, { error: 'Seuls les liens https vers Google Drive ou Google Docs sont acceptés.' }, 400);
      const label = bodyText(body?.label, ATTACHMENT_LABEL_MAX) || 'Document Drive';

      await prisma.wellbeingCaseAttachment.create({
        data: {
          caseId,
          label: sealNote(caseId, label),
          url: sealNote(caseId, url),
          addedById: user.userId,
          addedByName: actorName(c),
        },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'ATTACHMENT_ADDED' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'complété d\'un document' });

      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding attachment:', err);
      return fail(c, err, "Erreur lors de l'ajout du document.", 'WellbeingAPI');
    }
  });

  router.delete(`${base}/cases/:caseId/attachments/:attachmentId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      // Le dossier doit être de ce serveur : un id de document seul ne suffit pas.
      const { count } = await prisma.wellbeingCaseAttachment.deleteMany({
        where: { id: c.req.param('attachmentId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (count === 0) return send(c, { error: 'Document introuvable.' }, 404);
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'ATTACHMENT_REMOVED' }]);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'modifié' });

      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error removing attachment:', err);
      return fail(c, err, 'Erreur lors du retrait du document.', 'WellbeingAPI');
    }
  });

  // Plan d'action : tâches du dossier.
  router.post(`${base}/cases/:caseId/tasks`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const count = await prisma.wellbeingCaseTask.count({ where: { caseId } });
      if (count >= MAX_CASE_TASKS) return send(c, { error: `Un plan d'action compte au plus ${MAX_CASE_TASKS} tâches.` }, 400);
      const body = await readBody<{ label?: string; assigneeId?: string | null; dueAt?: string | null }>(c);
      const label = bodyText(body?.label, TASK_LABEL_MAX);
      if (!label) return send(c, { error: 'Libellé requis.' }, 400);
      const assigneeId = bodyText(body?.assigneeId, 20);
      if (assigneeId && !(await isTeamMemberId(state, assigneeId))) {
        return send(c, { error: 'Le responsable doit faire partie de la cellule.' }, 400);
      }
      if (assigneeConflict(existing.subjectUserId, assigneeId || null)) {
        return send(c, { error: 'La personne concernée ne peut pas suivre son propre dossier.' }, 400);
      }
      await prisma.wellbeingCaseTask.create({
        data: {
          caseId,
          label: sealNote(caseId, label),
          assigneeId: assigneeId || null,
          dueAt: parseReviewAt(body?.dueAt) ?? null,
          createdById: user.userId,
          createdByName: actorName(c),
        },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'TASK_ADDED' }]);
      return send(c, { item: await fullCase(caseId) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding task:', err);
      return fail(c, err, "Erreur lors de l'ajout de la tâche.", 'WellbeingAPI');
    }
  });

  // Plan d'action type de la cellule : ses tâches s'ajoutent au dossier, dans la limite du plan d'action.
  router.post(`${base}/cases/:caseId/plan`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ planId?: string }>(c);
      const plan = customizationOf(state.config).taskPlans.find((item) => item.id === bodyText(body?.planId, 32));
      if (!plan) return send(c, { error: 'Plan introuvable.' }, 404);
      const added = await addPlanTasks(caseId, plan, { id: user.userId, name: actorName(c) });
      if (added === 0) return send(c, { error: `Un plan d'action compte au plus ${MAX_CASE_TASKS} tâches.` }, 400);
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      return send(c, { item: await fullCase(caseId), added }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error applying task plan:', err);
      return fail(c, err, "Erreur lors de l'application du plan.", 'WellbeingAPI');
    }
  });

  router.patch(`${base}/cases/:caseId/tasks/:taskId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const task = await prisma.wellbeingCaseTask.findFirst({
        where: { id: c.req.param('taskId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (!task) return send(c, { error: 'Tâche introuvable.' }, 404);
      const body = await readBody<{ done?: boolean }>(c);
      if (typeof body?.done !== 'boolean') return send(c, { error: 'État attendu.' }, 400);
      if (body.done !== !!task.doneAt) {
        await prisma.wellbeingCaseTask.update({
          where: { id: task.id },
          data: body.done ? { doneAt: new Date(), doneById: user.userId } : { doneAt: null, doneById: null },
        });
        await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
        await recordEvents(caseId, c, [{ type: body.done ? 'TASK_DONE' : 'TASK_REOPENED' }]);
      }
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error updating task:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la tâche.', 'WellbeingAPI');
    }
  });

  router.delete(`${base}/cases/:caseId/tasks/:taskId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const { count } = await prisma.wellbeingCaseTask.deleteMany({
        where: { id: c.req.param('taskId'), caseId, wellbeingCase: caseVisibilityWhere(guildId, user.userId) },
      });
      if (count === 0) return send(c, { error: 'Tâche introuvable.' }, 404);
      await recordEvents(caseId, c, [{ type: 'TASK_REMOVED' }]);
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error removing task:', err);
      return fail(c, err, 'Erreur lors du retrait de la tâche.', 'WellbeingAPI');
    }
  });

  return router;
}
