/**
 * Dossiers de la cellule de suivi : liste, ouverture tracée, création (page,
 * signal, ticket), modification, corbeille, prolongation, export et
 * effacement anticipé à deux clés.
 */
import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { breakGlassScope } from '../../../../services/staff/wellbeingAccessPolicy.js';
import { CASE_TRASH_DAYS, purgeApprovalError, purgeRequestPending } from '../../../../services/staff/wellbeingRetentionPolicy.js';
import {
  assigneeConflict,
  cleanCloseReason,
  isCaseSubject,
  caseVisibilityWhere,
  shouldRecordView,
  verifyCaseEventChain,
  caseChangeEvents,
  followUpDate,
  ticketCaseSummary,
  type CaseEventDraft,
  type CaseTracked,
} from '../../../../services/staff/wellbeingCasePolicy.js';
import { reminderRecipient } from '../../../../services/staff/wellbeingWorkloadPolicy.js';
import { sendWellbeingAlert } from '../../../../services/staff/wellbeingAlerts.js';
import { currentAbsence } from '../../../../services/staff/wellbeingAbsence.js';
import { openCase, openCaseHeader, sealCaseFields } from '../../../../services/staff/wellbeingCrypto.js';
import { applyCrisisProtocolIfDue } from '../../../../services/staff/wellbeingCrisis.js';
import { closeTicket } from '../../../../services/features/ticketService.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { STAGE_EVENT, cleanBoardColumns, stageChange, stageLabel } from '../../../../services/staff/wellbeingBoardPolicy.js';
import { TAGS_EVENT, caseCategoryIds, cleanTagIds, tagNames } from '../../../../services/staff/wellbeingCustomPolicy.js';
import {
  actorName,
  audit,
  CASE_INCLUDE,
  CASE_LIST_SELECT,
  checkUnusualAccess,
  customizationOf,
  findVisibleCase,
  fullCase,
  isTeamMemberId,
  newColumnId,
  parseReviewAt,
  recordEvents,
  resolveWellbeingRole,
  SNOWFLAKE_RE,
  staleSession,
  type WellbeingState,
} from './wellbeingShared.js';

const SEVERITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const STATUSES = ['OPEN', 'MONITORING', 'CLOSED'];

export function createWellbeingCasesRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  // Dossiers confidentiels (strictement cloisonnés)
  router.get(`${base}/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canReadCases) {
        return send(c, { error: 'Espace cloisonné : accès réservé à la cellule de suivi (ou break-glass direction).' }, 403);
      }
      const stale = staleSession(c);
      if (stale) return stale;
      // Filtre optionnel : la fiche membre ne charge que les dossiers de la personne.
      const requested = c.req.query('subjectUserId');
      const subjectUserId = requested && SNOWFLAKE_RE.test(requested) ? requested : null;
      // Un accès d'urgence ciblé ne montre que le dossier ou le membre visé.
      const scope = !state.isTeamMember && state.activeBreakGlass ? breakGlassScope(state.activeBreakGlass) : {};
      if (scope.subjectUserId && subjectUserId && scope.subjectUserId !== subjectUserId) return send(c, { cases: [] });
      // La corbeille n'est montrée qu'à la cellule, qui seule peut restaurer.
      const trashed = c.req.query('trash') === '1' && state.canWriteCases;
      const cases = await prisma.wellbeingCase.findMany({
        where: { AND: [caseVisibilityWhere(guildId, user.userId, { trashed }), subjectUserId ? { subjectUserId } : {}, scope] },
        select: CASE_LIST_SELECT,
        orderBy: { updatedAt: 'desc' },
      });
      // Dossier sur un membre de la cellule : il lui est masqué, les autres le savent.
      const subjects = [...new Set(cases.map((item) => item.subjectUserId).filter((id): id is string => !!id))];
      const cellSubjects = new Set<string>();
      for (const id of subjects) if (await isTeamMemberId(state, id)) cellSubjects.add(id);
      // Sous accès d'urgence, chaque consultation laisse une trace, sans le contenu des dossiers.
      if (!state.isTeamMember) {
        await audit(client, c, guildId, 'Consultation Cellule de suivi',
          `Accès d'urgence : ${cases.length} dossier(s) consulté(s)${subjectUserId ? ` pour le membre ${subjectUserId}` : ''}.`, 'Sécurité');
      }
      void sendWellbeingAlert(client, guildId, state.config, state.isTeamMember ? 'TEAM_READ' : 'EMERGENCY_READ', {
        actorId: user.userId,
        caseCount: cases.length,
      });
      return send(c, {
        cases: cases.map((item) => ({ ...openCaseHeader(item), subjectIsTeamMember: !!item.subjectUserId && cellSubjects.has(item.subjectUserId) })),
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing cases:', err);
      return fail(c, err, 'Erreur lors du chargement des dossiers.', 'WellbeingAPI');
    }
  });

  /** Référent absent en ce moment : jusqu'à quand, et qui reçoit ses relances. */
  async function assigneeAbsence(guildId: string, assigneeId: string | null, state: WellbeingState) {
    if (!assigneeId) return null;
    const current = await currentAbsence(guildId, assigneeId);
    if (!current) return null;
    const recipient = reminderRecipient(assigneeId, new Set([assigneeId]), state.config?.backupUserId ?? null);
    return {
      until: current.isIndefinite || !current.endDate ? null : current.endDate.toISOString(),
      backupUserId: recipient === assigneeId ? null : recipient,
    };
  }

  // Contenu d'un dossier : chaque ouverture est tracée dans son historique.
  router.get(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canReadCases) {
        return send(c, { error: 'Espace cloisonné : accès réservé à la cellule de suivi (ou break-glass direction).' }, 403);
      }
      const stale = staleSession(c);
      if (stale) return stale;
      const caseId = c.req.param('caseId');
      const scope = !state.isTeamMember && state.activeBreakGlass ? breakGlassScope(state.activeBreakGlass) : {};
      const found = await prisma.wellbeingCase.findFirst({
        where: { AND: [{ id: caseId }, caseVisibilityWhere(guildId, user.userId, { trashed: c.req.query('trash') === '1' && state.canWriteCases }), scope] },
        select: { id: true },
      });
      if (!found) return send(c, { error: 'Dossier introuvable.' }, 404);

      const now = new Date();
      const lastView = await prisma.wellbeingCaseEvent.findFirst({
        where: { caseId, type: 'VIEWED', actorId: user.userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (shouldRecordView(lastView?.createdAt ?? null, now)) {
        await recordEvents(caseId, c, [{ type: 'VIEWED', toValue: state.isTeamMember ? null : 'EMERGENCY' }]);
        if (!state.isTeamMember) {
          await audit(client, c, guildId, 'Consultation Cellule de suivi', `Accès d'urgence : dossier ${caseId} ouvert.`, 'Sécurité');
        }
        await checkUnusualAccess(client, c, guildId, state.config, now);
      }
      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item), integrity: verifyCaseEventChain(item.events), assigneeAbsence: await assigneeAbsence(guildId, item.assigneeId, state) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error reading case:', err);
      return fail(c, err, 'Erreur lors du chargement du dossier.', 'WellbeingAPI');
    }
  });

  interface NewCaseInput {
    subjectUserId: string | null;
    subjectName: string;
    title: string;
    summary: string;
    category: string;
    severity: string;
    assigneeId: string | null;
    reviewAt: Date | null;
    source?: string;
    ticketId?: string;
  }

  /**
   * Création d'un dossier, quelle que soit son origine (page, signal de
   * détresse, ticket) : contrôles communs, historique, protocole de crise et
   * alerte. Rend une erreur à renvoyer telle quelle, ou l'id du dossier.
   */
  async function createCase(c: Context, guildId: string, state: WellbeingState, input: NewCaseInput): Promise<{ error: string } | { id: string }> {
    const user = c.var.dashboardUser;
    if (!input.subjectName || !input.title || !input.summary) {
      return { error: 'Personne concernée, titre et résumé sont obligatoires.' };
    }
    // Un dossier sur soi-même serait aussitôt masqué à son auteur (conflit
    // d'intérêts) : il le créerait sans pouvoir le suivre ni le fermer.
    if (isCaseSubject(input.subjectUserId, user.userId)) {
      return { error: "Vous ne pouvez pas ouvrir un dossier qui vous concerne : demandez à un autre membre de la cellule." };
    }
    if (input.assigneeId && !(await isTeamMemberId(state, input.assigneeId))) {
      return { error: 'Le référent doit faire partie de la cellule.' };
    }
    if (assigneeConflict(input.subjectUserId, input.assigneeId)) {
      return { error: 'La personne concernée ne peut pas suivre son propre dossier.' };
    }
    const categories = caseCategoryIds(customizationOf(state.config).categories);
    const created = await prisma.wellbeingCase.create({
      data: {
        guildId,
        subjectUserId: input.subjectUserId,
        ...sealCaseFields(guildId, { title: input.title, subjectName: input.subjectName, summary: input.summary }),
        category: categories.includes(input.category) ? input.category : categories[0]!,
        severity: SEVERITIES.includes(input.severity) ? input.severity : 'NORMAL',
        createdById: user.userId,
        createdByName: actorName(c),
        assigneeId: input.assigneeId,
        reviewAt: input.reviewAt,
        ...(input.source ? { source: input.source } : {}),
        ...(input.ticketId ? { ticketId: input.ticketId } : {}),
      },
    });
    await recordEvents(created.id, c, [
      { type: 'CREATED', toValue: input.source ?? null },
      ...(input.assigneeId ? [{ type: 'ASSIGNEE', toValue: input.assigneeId }] : []),
      ...(input.reviewAt ? [{ type: 'REVIEW', toValue: input.reviewAt.toISOString() }] : []),
    ]);
    await applyCrisisProtocolIfDue(created, null, created.severity, state.config?.crisisProtocol ?? true, { id: user.userId, name: actorName(c) },
      customizationOf(state.config).crisisTasks);
    void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'créé' },
      input.assigneeId ? [input.assigneeId] : []);
    return { id: created.id };
  }

  router.post(`${base}/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const body = await readBody<{
        subjectUserId?: string;
        subjectName?: string;
        title?: string;
        category?: string;
        severity?: string;
        summary?: string;
        assigneeId?: string | null;
        reviewAt?: string | null;
        signalId?: string;
      }>(c);
      // Dossier ouvert depuis un signal de détresse : le signal est marqué traité.
      const signalId = bodyText(body?.signalId, 64);
      const signal = signalId
        ? await prisma.wellbeingDistressSignal.findFirst({ where: { id: signalId, guildId, handledAt: null } })
        : null;
      if (signalId && !signal) return send(c, { error: 'Signal introuvable ou déjà traité.' }, 404);
      const subjectUserId = bodyText(body?.subjectUserId, 20);
      const result = await createCase(c, guildId, state, {
        subjectUserId: SNOWFLAKE_RE.test(subjectUserId) ? subjectUserId : null,
        subjectName: bodyText(body?.subjectName, 80),
        title: bodyText(body?.title, 160),
        summary: bodyText(body?.summary, 4000),
        category: body?.category ?? '',
        severity: body?.severity ?? '',
        assigneeId: bodyText(body?.assigneeId, 20) || null,
        reviewAt: parseReviewAt(body?.reviewAt) ?? null,
        ...(signal ? { source: 'DISTRESS' } : {}),
      });
      if ('error' in result) return send(c, { error: result.error }, 400);
      if (signal) {
        await prisma.wellbeingDistressSignal.update({
          where: { id: signal.id },
          data: { handledAt: new Date(), handledById: user.userId, handledByName: actorName(c), outcome: 'CASE', caseId: result.id },
        });
      }
      return send(c, { item: await fullCase(result.id) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error creating case:', err);
      return fail(c, err, 'Erreur lors de la création du dossier.', 'WellbeingAPI');
    }
  });

  // Ticket transféré à la cellule : il devient un dossier, et peut être fermé.
  router.post(`${base}/cases/from-ticket`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const body = await readBody<{ ticketId?: string; closeTicket?: boolean }>(c);
      const ticket = await prisma.ticket.findFirst({ where: { id: bodyText(body?.ticketId, 64), guildId } });
      if (!ticket) return send(c, { error: 'Ticket introuvable.' }, 404);
      const already = await prisma.wellbeingCase.findUnique({ where: { ticketId: ticket.id }, select: { id: true } });
      if (already) return send(c, { error: 'Ce ticket a déjà été transféré à la cellule.' }, 409);
      const result = await createCase(c, guildId, state, {
        subjectUserId: ticket.userId,
        subjectName: ticket.username,
        title: `Ticket : ${ticket.reason}`.slice(0, 160),
        summary: ticketCaseSummary(ticket),
        category: 'SOUTIEN',
        severity: 'NORMAL',
        assigneeId: null,
        reviewAt: null,
        source: 'TICKET',
        ticketId: ticket.id,
      });
      if ('error' in result) return send(c, { error: result.error }, 400);
      await audit(client, c, guildId, 'Transfert Cellule de suivi', `Ticket ${ticket.id} transféré à la cellule (dossier ${result.id}).`);
      if (body?.closeTicket === true && ticket.status !== 'CLOSED') {
        await closeTicket(client, ticket.id, user.userId, actorName(c));
      }
      return send(c, { caseId: result.id }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error transferring ticket:', err);
      return fail(c, err, 'Erreur lors du transfert du ticket.', 'WellbeingAPI');
    }
  });

  router.patch(`${base}/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ status?: string; severity?: string; assigneeId?: string | null; reviewAt?: string | null; closedReason?: string; stage?: string | null; tagIds?: unknown }>(c);

      const patch: Partial<CaseTracked> = {
        ...(body?.status && STATUSES.includes(body.status) ? { status: body.status } : {}),
        ...(body?.severity && SEVERITIES.includes(body.severity) ? { severity: body.severity } : {}),
      };
      if (body?.assigneeId !== undefined) {
        const assigneeId = bodyText(body.assigneeId, 20);
        if (assigneeId && !(await isTeamMemberId(state, assigneeId))) {
          return send(c, { error: 'Le référent doit faire partie de la cellule.' }, 400);
        }
        if (assigneeConflict(existing.subjectUserId, assigneeId || null)) {
          return send(c, { error: 'La personne concernée ne peut pas suivre son propre dossier.' }, 400);
        }
        patch.assigneeId = assigneeId || null;
      }
      const reviewAt = parseReviewAt(body?.reviewAt);
      if (reviewAt !== undefined) patch.reviewAt = reviewAt;

      const events: Array<CaseEventDraft | { type: string; fromValue?: string | null; toValue: string | null }> = caseChangeEvents(existing, patch);
      // Étape de travail : une colonne ajoutée par la cellule, sans effet sur le statut.
      const columns = cleanBoardColumns(state.config?.boardColumns, newColumnId);
      const requestedStage = body?.stage === undefined ? undefined : (body.stage === null ? null : bodyText(body.stage, 32) || null);
      const stage = stageChange(existing, { stage: requestedStage, status: patch.status }, columns);
      if (stage && 'error' in stage) return send(c, { error: stage.error }, 400);
      if (stage) events.push({ type: STAGE_EVENT, fromValue: stageLabel(columns, existing.stage), toValue: stageLabel(columns, stage.stage) });
      // Fermer enregistre son motif ; rouvrir l'efface.
      const closing = patch.status === 'CLOSED' && existing.status !== 'CLOSED';
      const closedReason = closing ? cleanCloseReason(body?.closedReason) : undefined;
      if (closedReason) events.push({ type: 'CLOSED_REASON', toValue: closedReason });
      // Étiquettes de la cellule : l'historique garde leurs noms.
      const { tags } = customizationOf(state.config);
      const tagIds = body?.tagIds === undefined ? undefined : cleanTagIds(body.tagIds, tags);
      const tagsChanged = tagIds !== undefined && tagIds.join() !== (existing.tagIds ?? []).join();
      if (tagsChanged) events.push({ type: TAGS_EVENT, fromValue: tagNames(tags, existing.tagIds ?? []), toValue: tagNames(tags, tagIds) });
      if (events.length === 0) {
        const unchanged = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
        return send(c, { item: openCase(unchanged) });
      }
      const now = new Date();
      const updated = await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: {
          ...patch,
          ...(stage ? { stage: stage.stage } : {}),
          ...(tagsChanged ? { tagIds } : {}),
          // Une nouvelle échéance réarme sa relance.
          ...(events.some((e) => e.type === 'REVIEW') ? { reviewRemindedAt: null } : {}),
          // Un dossier résolu programme sa prise de nouvelles ; rouvrir l'annule.
          ...(closing
            ? { closedReason: closedReason ?? null, followUpAt: followUpDate(now, state.config?.followUpDays ?? 30, closedReason ?? null), followUpSentAt: null }
            : {}),
          ...(patch.status && patch.status !== 'CLOSED' ? { closedReason: null, followUpAt: null, followUpSentAt: null } : {}),
          lastActivityAt: now,
        },
      });
      await recordEvents(caseId, c, events);
      if (patch.severity) {
        await applyCrisisProtocolIfDue(updated, existing.severity, patch.severity, state.config?.crisisProtocol ?? true, { id: user.userId, name: actorName(c) },
          customizationOf(state.config).crisisTasks);
      }
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
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      // Corbeille plutôt qu'effacement : un dossier ne disparaît pas d'un clic, la purge vient 30 jours après.
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: { deletedAt: new Date(), deletedById: user.userId, deletedByName: actorName(c) },
      });
      await recordEvents(caseId, c, [{ type: 'TRASHED' }]);
      await audit(client, c, guildId, 'Suppression Cellule de suivi', `Dossier ${caseId} mis à la corbeille (purge dans ${CASE_TRASH_DAYS} jours).`);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'mis à la corbeille' });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deleting case:', err);
      return fail(c, err, 'Erreur lors de la suppression du dossier.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/restore`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId, { trashed: true });
      if (!existing) return send(c, { error: 'Dossier introuvable dans la corbeille.' }, 404);
      await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: { deletedAt: null, deletedById: null, deletedByName: null, lastActivityAt: new Date() },
      });
      await recordEvents(caseId, c, [{ type: 'RESTORED' }]);
      await audit(client, c, guildId, 'Restauration Cellule de suivi', `Dossier ${caseId} restauré depuis la corbeille.`);
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'restauré' });
      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error restoring case:', err);
      return fail(c, err, 'Erreur lors de la restauration du dossier.', 'WellbeingAPI');
    }
  });

  // Prolonger un dossier fermé : son effacement repart pour un an.
  router.post(`${base}/cases/:caseId/extend`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (existing.status !== 'CLOSED') return send(c, { error: 'Seul un dossier fermé a une date d\'effacement.' }, 400);
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { purgeWarnedAt: null } });
      await recordEvents(caseId, c, [{ type: 'EXTENDED' }]);
      await audit(client, c, guildId, 'Conservation Cellule de suivi', `Dossier ${caseId} prolongé d'un an.`);
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error extending case:', err);
      return fail(c, err, 'Erreur lors de la prolongation du dossier.', 'WellbeingAPI');
    }
  });

  // Export imprimable : tracé, et filigrané côté page au nom de qui l'exporte.
  router.post(`${base}/cases/:caseId/export`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const stale = staleSession(c);
      if (stale) return stale;
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const exportedAt = new Date();
      await recordEvents(caseId, c, [{ type: 'EXPORTED' }]);
      await audit(client, c, guildId, 'Export Cellule de suivi', `Dossier ${caseId} exporté.`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'exporté' });
      return send(c, { item: await fullCase(caseId), exportedBy: actorName(c), exportedById: user.userId, exportedAt: exportedAt.toISOString() });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error exporting case:', err);
      return fail(c, err, "Erreur lors de l'export du dossier.", 'WellbeingAPI');
    }
  });

  // Effacement anticipé de la corbeille : une personne demande, une autre valide.
  router.post(`${base}/cases/:caseId/purge-request`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId, { trashed: true });
      if (!existing) return send(c, { error: 'Dossier introuvable dans la corbeille.' }, 404);
      const now = new Date();
      // Une demande en cours n'est pas remplacée : elle se valide ou expire.
      if (purgeRequestPending(existing, now)) {
        return send(c, { error: "Une demande d'effacement est déjà en attente de validation pour ce dossier." }, 409);
      }
      await prisma.wellbeingCase.update({
        where: { id: caseId },
        data: { purgeRequestedById: user.userId, purgeRequestedByName: actorName(c), purgeRequestedAt: now },
      });
      await recordEvents(caseId, c, [{ type: 'PURGE_REQUESTED' }]);
      await audit(client, c, guildId, 'Suppression Cellule de suivi', `Effacement définitif du dossier ${caseId} demandé, à valider par une autre personne.`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'proposé à l\'effacement définitif' });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error requesting purge:', err);
      return fail(c, err, "Erreur lors de la demande d'effacement.", 'WellbeingAPI');
    }
  });

  router.post(`${base}/cases/:caseId/purge`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId, { trashed: true });
      if (!existing) return send(c, { error: 'Dossier introuvable dans la corbeille.' }, 404);
      const error = purgeApprovalError(existing, user.userId, new Date());
      if (error === 'self') return send(c, { error: 'Une autre personne de la cellule doit valider votre demande.' }, 403);
      if (error === 'expired') return send(c, { error: 'La demande a expiré : il faut la refaire.' }, 409);
      if (error) return send(c, { error: "Aucune demande d'effacement en cours pour ce dossier." }, 409);
      await prisma.wellbeingCase.delete({ where: { id: caseId } });
      await audit(client, c, guildId, 'Suppression Cellule de suivi',
        `Dossier ${caseId} effacé définitivement (demande de ${existing.purgeRequestedByName ?? existing.purgeRequestedById}).`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: 'effacé définitivement' });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error purging case:', err);
      return fail(c, err, "Erreur lors de l'effacement du dossier.", 'WellbeingAPI');
    }
  });

  return router;
}
