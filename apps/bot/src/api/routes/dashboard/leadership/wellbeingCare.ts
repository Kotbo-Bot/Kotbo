/**
 * Liens de la cellule de suivi avec les membres : réponse au signaleur,
 * ressources d'aide, signaux de détresse et message permanent de signalement.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName } from '../../../shared.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import {
  REPORTER_REPLY_MAX,
  REPORT_PANEL_TEMPLATES,
  cleanPanelTemplate,
  cleanResources,
  resourcesMessage,
} from '../../../../services/staff/wellbeingReportPolicy.js';
import { sealWellbeing } from '../../../../services/staff/wellbeingCrypto.js';
import { wellbeingPanelMessage, wellbeingPanelText } from '../../../../commands/utility/wellbeing.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { actorName, audit, findVisibleCase, fullCase, recordEvents, resolveWellbeingRole, SNOWFLAKE_RE } from './wellbeingShared.js';

export function createWellbeingCareRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  // Message à l'auteur d'un signalement : il le lit avec son code de suivi
  // et peut y répondre, sans que la cellule sache qui il est.
  router.post(`${base}/cases/:caseId/reporter-reply`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
      if (!existing) return send(c, { error: 'Dossier introuvable.' }, 404);
      if (!existing.trackingCodeHash) return send(c, { error: "Ce dossier n'a pas de code de suivi : il ne vient pas d'un signalement Discord." }, 400);
      const body = await readBody<{ message?: string }>(c);
      const message = bodyText(body?.message, REPORTER_REPLY_MAX);
      if (!message) return send(c, { error: 'Message requis.' }, 400);
      await prisma.wellbeingReporterMessage.create({
        data: { caseId, fromReporter: false, content: sealWellbeing(guildId, message), authorId: user.userId },
      });
      await prisma.wellbeingCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });
      await recordEvents(caseId, c, [{ type: 'REPORTER_REPLY', toValue: 'SET' }]);
      return send(c, { item: await fullCase(caseId) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error replying to reporter:', err);
      return fail(c, err, 'Erreur lors de la réponse au signaleur.', 'WellbeingAPI');
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
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const body = await readBody<{ resources?: unknown }>(c);
      const resources = cleanResources(body?.resources);
      await prisma.wellbeingConfig.update({ where: { guildId }, data: { resources: resources as unknown as Prisma.InputJsonValue } });
      await audit(client, c, guildId, 'Ressources Cellule de suivi', `${resources.length} ressource(s) d'aide enregistrée(s).`);
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
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const caseId = c.req.param('caseId');
      const existing = await findVisibleCase(guildId, caseId, user.userId);
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

  // Signaux de détresse à examiner : un lien vers le message, jamais son texte.
  router.get(`${base}/signals`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      // Un signal sur soi-même reste masqué, comme un dossier (conflit d'intérêts).
      const signals = await prisma.wellbeingDistressSignal.findMany({
        where: { guildId, handledAt: null, userId: { not: user.userId } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const names = new Map<string, string>();
      for (const signal of signals) {
        if (names.has(signal.userId)) continue;
        const member = state.discordGuild?.members.cache.get(signal.userId);
        names.set(signal.userId, member?.displayName ?? member?.user.username ?? signal.userId);
      }
      return send(c, {
        signals: signals.map((signal) => ({
          id: signal.id,
          userId: signal.userId,
          userName: names.get(signal.userId) ?? signal.userId,
          url: `https://discord.com/channels/${guildId}/${signal.channelId}/${signal.messageId}`,
          createdAt: signal.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing signals:', err);
      return fail(c, err, 'Erreur lors du chargement des signaux.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/signals/:signalId/dismiss`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const { count } = await prisma.wellbeingDistressSignal.updateMany({
        where: { id: c.req.param('signalId'), guildId, handledAt: null, userId: { not: user.userId } },
        data: { handledAt: new Date(), handledById: user.userId, handledByName: actorName(c), outcome: 'DISMISSED' },
      });
      if (count === 0) return send(c, { error: 'Signal introuvable ou déjà traité.' }, 404);
      await audit(client, c, guildId, 'Signal Cellule de suivi', 'Signal de détresse écarté.');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error dismissing signal:', err);
      return fail(c, err, "Erreur lors du traitement du signal.", 'WellbeingAPI');
    }
  });

  // Modèles du message permanent, avec leur texte dans la langue du serveur.
  router.get(`${base}/report-panel/templates`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const locale = await resolveGuildLocale(guildId, state.discordGuild?.preferredLocale);
      return send(c, { templates: REPORT_PANEL_TEMPLATES.map((id) => ({ id, text: wellbeingPanelText(id, locale) })) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error loading panel templates:', err);
      return fail(c, err, 'Erreur lors du chargement des modèles.', 'WellbeingAPI');
    }
  });

  // Message permanent dans un salon : écrire à la cellule d'un clic.
  router.post(`${base}/report-panel`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      if (!state.config?.reportEnabled) {
        return send(c, { error: "Ouvrez d'abord les signalements Discord dans les réglages de la cellule." }, 400);
      }
      const body = await readBody<{ channelId?: string; template?: string }>(c);
      const channelId = bodyText(body?.channelId, 20);
      const channel = SNOWFLAKE_RE.test(channelId) ? state.discordGuild?.channels.cache.get(channelId) : undefined;
      if (!channel || !channel.isSendable()) return send(c, { error: 'Salon introuvable ou fermé au bot.' }, 400);
      const locale = await resolveGuildLocale(guildId, state.discordGuild?.preferredLocale);
      await channel.send(wellbeingPanelMessage(locale, cleanPanelTemplate(body?.template)));
      await audit(client, c, guildId, 'Message Cellule de suivi', `Message permanent publié dans #${channel.name}.`);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error posting panel:', err);
      return fail(c, err, 'Erreur lors de la publication du message.', 'WellbeingAPI');
    }
  });

  return router;
}
