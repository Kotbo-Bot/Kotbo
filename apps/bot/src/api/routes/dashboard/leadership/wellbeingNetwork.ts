/**
 * Référents partagés entre les cellules de suivi d'un réseau de serveurs.
 *
 * Côté cellule d'origine : la liste des référents du réseau et la
 * désignation de l'un d'eux sur un dossier. Côté référent : les dossiers des
 * autres serveurs qui lui sont confiés, qu'il lit et annote depuis la cellule
 * de son propre serveur. Le reste du dossier (statut, plan d'action,
 * signaleur) reste à la cellule d'origine.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { getGuildName } from '../../../shared.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { shouldRecordView } from '../../../../services/staff/wellbeingCasePolicy.js';
import {
  NETWORK_REFERENT_EVENT,
  NETWORK_VIEW,
  networkReferentError,
  networkReferentText,
} from '../../../../services/staff/wellbeingNetworkPolicy.js';
import { networkPool, networkReferentCaseRefs } from '../../../../services/staff/wellbeingNetwork.js';
import { sendWellbeingAlert, sendWellbeingDirect } from '../../../../services/staff/wellbeingAlerts.js';
import { openCase, openCaseHeader, openNote, sealNote } from '../../../../services/staff/wellbeingCrypto.js';
import {
  CASE_INCLUDE,
  SNOWFLAKE_RE,
  actorName,
  audit,
  findVisibleCase,
  recordEvents,
  resolveWellbeingRole,
  staleSession,
} from './wellbeingShared.js';

const NOT_FOUND = 'Dossier introuvable, ou plus partagé avec votre cellule.';

/**
 * En-tête d'un dossier vu par le référent du réseau : ni le référent local,
 * ni l'origine, ni les demandes de purge, qui restent à la cellule d'origine.
 */
const NETWORK_LIST_SELECT = {
  id: true,
  guildId: true,
  title: true,
  subjectName: true,
  category: true,
  severity: true,
  status: true,
  updatedAt: true,
} as const;

export function createWellbeingNetworkRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  // ── Cellule d'origine ──────────────────────────────────────────────────

  router.get(`${base}/network/pool`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const subject = c.req.query('subjectUserId');
      return send(c, await networkPool(client, guildId, subject && SNOWFLAKE_RE.test(subject) ? [subject] : []));
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing network referents:', err);
      return fail(c, err, 'Erreur lors du chargement des référents du réseau.', 'WellbeingAPI');
    }
  });

  router.put(`${base}/cases/:caseId/network-referent`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      const body = await readBody<{ userId?: string | null; guildId?: string }>(c);
      const userId = bodyText(body?.userId, 20) || null;
      const referentGuildId = userId ? bodyText(body?.guildId, 20) : null;

      if (userId && referentGuildId) {
        const pool = await networkPool(client, guildId, []);
        if (!pool.available) return send(c, { error: "Cette cellule ne partage pas ses référents avec le réseau." }, 400);
        const error = networkReferentError({ userId, guildId: referentGuildId }, pool.candidates, existing.subjectUserId);
        if (error) return send(c, { error }, 400);
      } else if (userId) {
        return send(c, { error: 'Serveur du référent manquant.' }, 400);
      }

      if (userId !== existing.networkReferentId || referentGuildId !== existing.networkReferentGuildId) {
        await prisma.wellbeingCase.update({
          where: { id: caseId },
          data: { networkReferentId: userId, networkReferentGuildId: referentGuildId, lastActivityAt: new Date() },
        });
        await recordEvents(caseId, c, [{ type: NETWORK_REFERENT_EVENT, fromValue: existing.networkReferentId, toValue: userId }]);
        await audit(client, c, guildId, 'Référent du réseau Cellule de suivi', userId && referentGuildId
          ? `Dossier ${caseId} confié à ${userId}, membre de la cellule de ${getGuildName(client, referentGuildId)}.`
          : `Dossier ${caseId} : référent du réseau retiré.`, 'Sécurité');
        if (userId) void sendWellbeingDirect(client, [userId], networkReferentText(getGuildName(client, guildId)));
        void sendWellbeingAlert(client, guildId, state.config, 'CASE_CHANGE', { actorId: user.userId, action: userId ? 'confié à un référent du réseau' : 'retiré à son référent du réseau' });
      }
      const item = await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      return send(c, { item: openCase(item) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error setting network referent:', err);
      return fail(c, err, 'Erreur lors de la désignation du référent du réseau.', 'WellbeingAPI');
    }
  });

  // ── Référent du réseau ─────────────────────────────────────────────────

  router.get(`${base}/network/cases`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const stale = staleSession(c);
      if (stale) return stale;
      const refs = await networkReferentCaseRefs(client, guildId, c.var.dashboardUser.userId);
      if (refs.length === 0) return send(c, { cases: [] });
      const cases = await prisma.wellbeingCase.findMany({
        where: { id: { in: refs.map((ref) => ref.id) } },
        select: NETWORK_LIST_SELECT,
        orderBy: { updatedAt: 'desc' },
      });
      return send(c, { cases: cases.map((item) => ({ ...openCaseHeader(item), guildName: getGuildName(client, item.guildId) })) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing network cases:', err);
      return fail(c, err, 'Erreur lors du chargement des dossiers du réseau.', 'WellbeingAPI');
    }
  });

  router.get(`${base}/network/cases/:caseId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const stale = staleSession(c);
      if (stale) return stale;
      const caseId = c.req.param('caseId');
      const [ref] = await networkReferentCaseRefs(client, guildId, user.userId, caseId);
      if (!ref) return send(c, { error: NOT_FOUND }, 404);

      const lastView = await prisma.wellbeingCaseEvent.findFirst({
        where: { caseId, type: 'VIEWED', actorId: user.userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (shouldRecordView(lastView?.createdAt ?? null, new Date())) {
        await recordEvents(caseId, c, [{ type: 'VIEWED', toValue: NETWORK_VIEW }]);
        // Le journal du serveur du dossier dit qui l'a lu, et depuis quelle cellule.
        await audit(client, c, ref.guildId, 'Consultation Cellule de suivi',
          `Référent du réseau : dossier ${caseId} ouvert depuis la cellule de ${getGuildName(client, guildId)}.`, 'Sécurité');
      }
      // Seul ce que le référent du réseau lit et annote sort : ni plan d'action,
      // ni documents, ni échanges avec le signaleur, qui restent à la cellule d'origine.
      const item = openCase(await prisma.wellbeingCase.findUniqueOrThrow({ where: { id: caseId }, include: { notes: CASE_INCLUDE.notes } }));
      return send(c, {
        item: {
          id: item.id,
          guildName: getGuildName(client, item.guildId),
          title: item.title,
          subjectName: item.subjectName,
          summary: item.summary,
          category: item.category,
          severity: item.severity,
          status: item.status,
          updatedAt: item.updatedAt,
          notes: item.notes,
        },
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error reading network case:', err);
      return fail(c, err, 'Erreur lors du chargement du dossier.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/network/cases/:caseId/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const stale = staleSession(c);
      if (stale) return stale;
      const caseId = c.req.param('caseId');
      const [ref] = await networkReferentCaseRefs(client, guildId, user.userId, caseId);
      if (!ref) return send(c, { error: NOT_FOUND }, 404);
      const body = await readBody<{ content?: string }>(c);
      const content = bodyText(body?.content, 4000);
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);
      const note = await prisma.wellbeingCaseNote.create({
        data: { caseId, authorId: user.userId, authorName: actorName(c), content: sealNote(caseId, content) },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'NOTE', toValue: NETWORK_VIEW }]);
      // La cellule d'origine et son référent apprennent qu'une note est arrivée.
      const owner = await prisma.wellbeingConfig.findUnique({ where: { guildId: ref.guildId } });
      const local = await prisma.wellbeingCase.findUnique({ where: { id: caseId }, select: { assigneeId: true } });
      void sendWellbeingAlert(client, ref.guildId, owner, 'CASE_CHANGE', { actorId: user.userId, action: 'annoté par son référent du réseau' },
        local?.assigneeId ? [local.assigneeId] : []);
      return send(c, { note: openNote(note) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding network case note:', err);
      return fail(c, err, "Erreur lors de l'ajout de la note.", 'WellbeingAPI');
    }
  });

  return router;
}
