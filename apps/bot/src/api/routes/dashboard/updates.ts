import { Hono } from 'hono';
import prisma from '../../../utils/db.js';
import { getPollResults } from '../../../services/system/broadcastService.js';
import { dashboardAuth, fail, readBody, send } from '../../hono/dashboard/kit.js';

/**
 * Page publique (pour toute personne connectée au dashboard) des annonces et
 * mises à jour Kotbo : lecture, vote aux sondages et retours d'avis.
 *
 *   GET  /api/dashboard/updates
 *   POST /api/dashboard/updates/:id/vote     { optionIndex, guildId? }
 *   POST /api/dashboard/updates/:id/feedback { content, guildId? }
 */
const SCOPE = 'DashboardUpdates';
const FAILURE = 'Erreur sur les mises à jour';
const SNOWFLAKE = /^\d{17,20}$/;

export function createUpdatesRouter() {
  const router = new Hono();
  const base = '/api/dashboard/updates';

  router.get(base, dashboardAuth, async (c) => {
    const userId = c.var.dashboardUser.userId;
    try {
      const logs = await prisma.broadcastLog.findMany({
        where: { status: 'SENT' },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: {
          id: true,
          title: true,
          message: true,
          color: true,
          thumbnailUrl: true,
          imageUrl: true,
          footerText: true,
          pollOptions: true,
          pollClosesAt: true,
          feedbackLabel: true,
          createdAt: true,
          finishedAt: true,
        },
      });

      const ids = logs.map((l) => l.id);
      if (ids.length === 0) return send(c, { updates: [] });

      const [groupedVotes, myVotes, myFeedbacks] = await Promise.all([
        prisma.broadcastPollVote.groupBy({
          by: ['broadcastId', 'optionIndex'],
          where: { broadcastId: { in: ids } },
          _count: { _all: true },
        }),
        prisma.broadcastPollVote.findMany({
          where: { broadcastId: { in: ids }, userId },
          select: { broadcastId: true, optionIndex: true },
        }),
        prisma.broadcastFeedback.groupBy({
          by: ['broadcastId'],
          where: { broadcastId: { in: ids }, userId },
          _count: { _all: true },
        }),
      ]);

      const voteMap = new Map<string, Map<number, number>>();
      for (const row of groupedVotes) {
        let byOpt = voteMap.get(row.broadcastId);
        if (!byOpt) {
          byOpt = new Map();
          voteMap.set(row.broadcastId, byOpt);
        }
        byOpt.set(row.optionIndex, row._count._all);
      }
      const myVoteMap = new Map(myVotes.map((v) => [v.broadcastId, v.optionIndex]));
      const myFeedbackMap = new Map(myFeedbacks.map((f) => [f.broadcastId, f._count._all]));

      const updates = logs.map((log) => {
        const counts = voteMap.get(log.id);
        const pollResults = log.pollOptions.length > 0
          ? (() => {
              const options = log.pollOptions.map((label, idx) => ({
                label,
                votes: counts?.get(idx) ?? 0,
              }));
              return {
                options,
                total: options.reduce((sum, o) => sum + o.votes, 0),
                closesAt: log.pollClosesAt?.toISOString() ?? null,
              };
            })()
          : null;

        return {
          id: log.id,
          title: log.title,
          message: log.message,
          color: log.color,
          thumbnailUrl: log.thumbnailUrl,
          imageUrl: log.imageUrl,
          footerText: log.footerText,
          pollOptions: log.pollOptions,
          pollClosesAt: log.pollClosesAt?.toISOString() ?? null,
          feedbackLabel: log.feedbackLabel,
          pollResults,
          myVote: myVoteMap.get(log.id) ?? null,
          myFeedbackCount: myFeedbackMap.get(log.id) ?? 0,
          createdAt: log.createdAt.toISOString(),
          finishedAt: log.finishedAt?.toISOString() ?? null,
        };
      });

      return send(c, { updates });
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  router.post(`${base}/:id/vote`, dashboardAuth, async (c) => {
    const userId = c.var.dashboardUser.userId;
    const broadcastId = c.req.param('id');
    try {
      const body = await readBody<{ optionIndex?: unknown; guildId?: unknown }>(c);
      const optionIndex = typeof body?.optionIndex === 'number' ? body.optionIndex : -1;
      const guildId = typeof body?.guildId === 'string' && SNOWFLAKE.test(body.guildId) ? body.guildId : 'dashboard';

      const broadcast = await prisma.broadcastLog.findUnique({
        where: { id: broadcastId },
        select: { status: true, pollOptions: true, pollClosesAt: true },
      });
      if (!broadcast || broadcast.status !== 'SENT' || broadcast.pollOptions.length === 0) {
        return send(c, { error: 'Sondage introuvable.' }, 404);
      }
      if (broadcast.pollClosesAt && broadcast.pollClosesAt.getTime() <= Date.now()) {
        return send(c, { error: 'Ce sondage est clos.' }, 400);
      }
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= broadcast.pollOptions.length) {
        return send(c, { error: 'Option de vote invalide.' }, 400);
      }

      await prisma.broadcastPollVote.upsert({
        where: { broadcastId_userId: { broadcastId, userId } },
        update: { optionIndex, guildId },
        create: { broadcastId, userId, guildId, optionIndex },
      });

      const pollResults = await getPollResults(broadcastId);
      return send(c, {
        ok: true,
        myVote: optionIndex,
        pollResults: pollResults
          ? {
              options: pollResults.options,
              total: pollResults.total,
              closesAt: pollResults.closesAt?.toISOString() ?? null,
            }
          : null,
      });
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  router.post(`${base}/:id/feedback`, dashboardAuth, async (c) => {
    const userId = c.var.dashboardUser.userId;
    const broadcastId = c.req.param('id');
    try {
      const body = await readBody<{ content?: unknown; guildId?: unknown }>(c);
      const content = typeof body?.content === 'string' ? body.content.trim() : '';
      const guildId = typeof body?.guildId === 'string' && SNOWFLAKE.test(body.guildId) ? body.guildId : 'dashboard';

      const broadcast = await prisma.broadcastLog.findUnique({
        where: { id: broadcastId },
        select: { status: true, feedbackLabel: true, pollClosesAt: true },
      });
      if (!broadcast || broadcast.status !== 'SENT' || !broadcast.feedbackLabel) {
        return send(c, { error: "Demande d'avis introuvable." }, 404);
      }
      if (broadcast.pollClosesAt && broadcast.pollClosesAt.getTime() <= Date.now()) {
        return send(c, { error: "Cette demande d'avis est close." }, 400);
      }
      if (content.length < 5 || content.length > 1500) {
        return send(c, { error: 'Le retour doit contenir entre 5 et 1500 caractères.' }, 400);
      }

      await prisma.broadcastFeedback.create({
        data: { broadcastId, userId, guildId, content },
      });
      return send(c, { ok: true });
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  return router;
}
