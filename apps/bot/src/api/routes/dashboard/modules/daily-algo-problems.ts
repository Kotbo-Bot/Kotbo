import type { Client } from 'discord.js';
import { Hono } from 'hono';
/** Routes dashboard du module `daily-algo-problems`. */
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { broadcastDashboardStateChange, getGuildName, pushAudit, resolveAdminAccess } from '../../../shared.js';
import { Prisma } from '@prisma/client';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
export function createDailyAlgoProblemsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  router.get(`${base}/daily-algo-problems`, ...gate, async (c) => {
    try {
      const problems = await prisma.dailyAlgoProblem.findMany({
        orderBy: [
          { usedAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'desc' },
        ]
      });
      return send(c, problems);
    } catch (err) {
      logger.error('DailyAlgoAPI', 'Error fetching daily algo problems:', err);
      return fail(c, err, 'Erreur lors de la récupération des exercices', 'DailyAlgoAPI');
    }
  });

  router.post(`${base}/daily-algo-problems`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const MAIN_GUILD_ID = '1477350874740424986';
    const isBotAdmin = await resolveAdminAccess(client, c.var.dashboardUser.userId);
    if (guildId !== MAIN_GUILD_ID && !isBotAdmin) {
      return send(c, { error: 'Seul le serveur principal peut ajouter des exercices.' }, 403);
    }
    try {
      const body = await readBody<{
        title: string;
        description: string;
        solution?: string;
        difficulty?: string;
        language?: string;
        functionName?: string;
        functionArgs?: unknown;
        unitTests?: unknown;
        allowedLanguages?: string[];
      }>(c);
      if (!body || !body.title || !body.description) {
        return send(c, { error: 'Payload invalide : champs manquants' }, 400);
      }
      const problem = await prisma.dailyAlgoProblem.create({
        data: {
          title: body.title,
          description: body.description,
          solution: body.solution || '',
          difficulty: body.difficulty || 'moyen',
          language: body.language || 'fr',
          functionName: body.functionName || 'solve',
          functionArgs: body.functionArgs !== undefined ? (body.functionArgs as Prisma.InputJsonValue) : undefined,
          unitTests: body.unitTests !== undefined ? (body.unitTests as Prisma.InputJsonValue) : undefined,
          allowedLanguages: Array.isArray(body.allowedLanguages) ? body.allowedLanguages.map(String) : undefined,
        }
      });
      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Ajout Exercice',
        context: getGuildName(client, guildId),
        module: 'Daily Algo',
        eventType: 'Manuel',
        details: `Ajout d'un nouvel exercice : ${problem.title}`,
        channelId: null
      });
      broadcastDashboardStateChange(guildId, 'daily_algo_problems_updated');
      return send(c, problem, 201);
    } catch (err) {
      logger.error('DailyAlgoAPI', 'Error creating daily algo problem:', err);
      return fail(c, err, "Erreur lors de la création de l'exercice", 'DailyAlgoAPI');
    }
  });


  router.patch(`${base}/daily-algo-problems/:problemId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const MAIN_GUILD_ID = '1477350874740424986';
    const isBotAdmin = await resolveAdminAccess(client, user.userId);
    
    if (guildId !== MAIN_GUILD_ID && !isBotAdmin) {
      return send(c, { error: 'Seul le serveur principal peut modifier des exercices.' }, 403);
    }

    const problemId = c.req.param('problemId');
    try {
      const body = await readBody<{
        title?: string;
        description?: string;
        solution?: string;
        difficulty?: string;
        language?: string;
        functionName?: string;
        functionArgs?: unknown;
        unitTests?: unknown;
        allowedLanguages?: string[];
      }>(c);

      if (!body) {
        return send(c, { error: 'Payload invalide' }, 400);
      }

      const existing = await prisma.dailyAlgoProblem.findUnique({
        where: { id: problemId }
      });

      if (!existing) {
        return send(c, { error: 'Exercice introuvable' }, 404);
      }

      const updated = await prisma.dailyAlgoProblem.update({
        where: { id: problemId },
        data: {
          title: body.title !== undefined ? body.title : undefined,
          description: body.description !== undefined ? body.description : undefined,
          solution: body.solution !== undefined ? body.solution : undefined,
          difficulty: body.difficulty !== undefined ? body.difficulty : undefined,
          language: body.language !== undefined ? body.language : undefined,
          functionName: body.functionName !== undefined ? body.functionName : undefined,
          functionArgs: body.functionArgs !== undefined ? (body.functionArgs as Prisma.InputJsonValue) : undefined,
          unitTests: body.unitTests !== undefined ? (body.unitTests as Prisma.InputJsonValue) : undefined,
          allowedLanguages: Array.isArray(body.allowedLanguages) ? body.allowedLanguages.map(String) : undefined,
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modification Exercice',
        context: getGuildName(client, guildId),
        module: 'Daily Algo',
        eventType: 'Manuel',
        details: `Exercice "${updated.title}" mis à jour.`,
        channelId: null
      });

      broadcastDashboardStateChange(guildId, 'daily_algo_problems_updated');

      return send(c, updated);
    } catch (err) {
      logger.error('DailyAlgoAPI', `Error updating daily algo problem ${problemId}:`, err);
      return fail(c, err, "Erreur lors de la modification de l'exercice", 'DailyAlgoAPI');
    }
  });

  router.delete(`${base}/daily-algo-problems/:problemId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const MAIN_GUILD_ID = '1477350874740424986';
    const isBotAdmin = await resolveAdminAccess(client, user.userId);
    
    if (guildId !== MAIN_GUILD_ID && !isBotAdmin) {
      return send(c, { error: 'Seul le serveur principal peut supprimer des exercices.' }, 403);
    }

    const problemId = c.req.param('problemId');
    try {
      const existing = await prisma.dailyAlgoProblem.findUnique({
        where: { id: problemId }
      });

      if (!existing) {
        return send(c, { error: 'Exercice introuvable' }, 404);
      }

      await prisma.dailyAlgoProblem.delete({
        where: { id: problemId }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression Exercice',
        context: getGuildName(client, guildId),
        module: 'Daily Algo',
        eventType: 'Manuel',
        details: `Exercice "${existing.title}" supprimé.`,
        channelId: null
      });

      broadcastDashboardStateChange(guildId, 'daily_algo_problems_updated');

      return send(c, { success: true });
    } catch (err) {
      logger.error('DailyAlgoAPI', `Error deleting daily algo problem ${problemId}:`, err);
      return fail(c, err, "Erreur lors de la suppression de l'exercice", 'DailyAlgoAPI');
    }
  });

  return router;
}

