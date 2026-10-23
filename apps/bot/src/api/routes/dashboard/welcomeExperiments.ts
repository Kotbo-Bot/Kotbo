import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, pushAudit, getGuildName, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import {
  EXPERIMENT_METRICS,
  ExperimentValidationError,
  parseVariants,
  type ExperimentMetric,
} from '../../../services/features/welcomeExperimentMath.js';
import { getExperimentResults, invalidateRunningExperiment } from '../../../services/features/welcomeExperimentService.js';

const SEGMENT = 'welcome-experiments';
const LOG = 'WelcomeExperimentsAPI';

function readMetric(value: unknown): ExperimentMetric {
  return typeof value === 'string' && (EXPERIMENT_METRICS as readonly string[]).includes(value) ? value as ExperimentMetric : 'retained_d7';
}

function readText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Tests A/B de l'accueil.
 *
 *   GET    /welcome-experiments              liste, avec le message actuel
 *   POST   /welcome-experiments              brouillon
 *   PATCH  /welcome-experiments/:id          modifier (versions : brouillon seulement)
 *   POST   /welcome-experiments/:id/start    lancer (un seul test à la fois)
 *   POST   /welcome-experiments/:id/stop     arrêter
 *   POST   /welcome-experiments/:id/ship     appliquer une version à l'accueil
 *   DELETE /welcome-experiments/:id          supprimer (hors test en cours)
 *   GET    /welcome-experiments/:id/results  résultats
 */
export async function handleWelcomeExperimentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== SEGMENT) return false;
  const method = req.method;
  const audit = (action: string, details: string) => pushAudit(guildId, {
    user: user.username ?? `User${user.userId}`,
    action,
    context: getGuildName(client, guildId),
    module: 'Accueil',
    eventType: 'Settings',
    details,
    channelId: null,
  }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));

  try {
    // GET /welcome-experiments
    if (parts.length === 5 && method === 'GET') {
      const [experiments, counts, welcome] = await Promise.all([
        prisma.welcomeExperiment.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' }, take: 50 }),
        prisma.welcomeExperimentAssignment.groupBy({ by: ['experimentId', 'variantKey'], where: { guildId }, _count: { _all: true } }),
        prisma.welcomeConfig.findUnique({ where: { guildId }, select: { welcomeEnabled: true, welcomeChannelId: true, welcomeMessage: true, welcomeImageEnabled: true } }),
      ]);
      const assigned = new Map<string, Record<string, number>>();
      for (const row of counts) {
        const entry = assigned.get(row.experimentId) ?? {};
        entry[row.variantKey] = row._count._all;
        assigned.set(row.experimentId, entry);
      }
      json(res, 200, {
        experiments: experiments.map((experiment) => ({ ...experiment, assigned: assigned.get(experiment.id) ?? {} })),
        welcome: welcome ?? { welcomeEnabled: false, welcomeChannelId: null, welcomeMessage: '', welcomeImageEnabled: false },
        canEdit: access.canManageSettings,
      });
      return true;
    }

    // POST /welcome-experiments
    if (parts.length === 5 && method === 'POST') {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const name = readText(body?.name, 80);
      if (!name) {
        json(res, 400, { error: 'Donne un nom au test.' });
        return true;
      }
      const experiment = await prisma.welcomeExperiment.create({
        data: {
          guildId,
          name,
          hypothesis: readText(body?.hypothesis, 500),
          primaryMetric: readMetric(body?.primaryMetric),
          variants: parseVariants(body?.variants) as never,
          createdById: user.userId,
        },
      });
      await audit('Création test A/B accueil', `« ${name} ».`);
      json(res, 201, { experiment: { ...experiment, assigned: {} } });
      return true;
    }

    const experimentId = parts[5];
    if (!experimentId) return false;
    const existing = await prisma.welcomeExperiment.findFirst({ where: { id: experimentId, guildId } });
    if (!existing) {
      json(res, 404, { error: 'Test introuvable.' });
      return true;
    }

    // GET /welcome-experiments/:id/results
    if (parts.length === 7 && parts[6] === 'results' && method === 'GET') {
      json(res, 200, await getExperimentResults(guildId, experimentId));
      return true;
    }

    // PATCH /welcome-experiments/:id
    if (parts.length === 6 && method === 'PATCH') {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const data: Record<string, unknown> = {};
      if (body?.name !== undefined) {
        const name = readText(body.name, 80);
        if (!name) {
          json(res, 400, { error: 'Donne un nom au test.' });
          return true;
        }
        data.name = name;
      }
      if (body?.hypothesis !== undefined) data.hypothesis = readText(body.hypothesis, 500);
      // Changer les versions ou la mesure en cours de route fausserait la
      // comparaison : seulement sur un brouillon.
      if (body?.variants !== undefined || body?.primaryMetric !== undefined) {
        if (existing.status !== 'DRAFT') {
          json(res, 409, { error: 'Les versions ne se modifient plus une fois le test lancé.' });
          return true;
        }
        if (body.variants !== undefined) data.variants = parseVariants(body.variants);
        if (body.primaryMetric !== undefined) data.primaryMetric = readMetric(body.primaryMetric);
      }
      const experiment = await prisma.welcomeExperiment.update({ where: { id: experimentId }, data });
      json(res, 200, { experiment });
      return true;
    }

    // POST /welcome-experiments/:id/start
    if (parts.length === 7 && parts[6] === 'start' && method === 'POST') {
      if (existing.status !== 'DRAFT') {
        json(res, 409, { error: 'Seul un brouillon peut être lancé.' });
        return true;
      }
      const running = await prisma.welcomeExperiment.findFirst({ where: { guildId, status: 'RUNNING' }, select: { name: true } });
      if (running) {
        json(res, 409, { error: `Le test « ${running.name} » est déjà en cours : arrête-le d'abord.` });
        return true;
      }
      const experiment = await prisma.welcomeExperiment.update({ where: { id: experimentId }, data: { status: 'RUNNING', startedAt: new Date() } });
      await invalidateRunningExperiment(guildId);
      await audit('Lancement test A/B accueil', `« ${existing.name} ».`);
      json(res, 200, { experiment });
      return true;
    }

    // POST /welcome-experiments/:id/stop
    if (parts.length === 7 && parts[6] === 'stop' && method === 'POST') {
      if (existing.status !== 'RUNNING') {
        json(res, 409, { error: "Ce test n'est pas en cours." });
        return true;
      }
      const experiment = await prisma.welcomeExperiment.update({ where: { id: experimentId }, data: { status: 'STOPPED', stoppedAt: new Date() } });
      await invalidateRunningExperiment(guildId);
      await audit('Arrêt test A/B accueil', `« ${existing.name} ».`);
      json(res, 200, { experiment });
      return true;
    }

    // POST /welcome-experiments/:id/ship  { variantKey }
    if (parts.length === 7 && parts[6] === 'ship' && method === 'POST') {
      const body = await readJsonBody<{ variantKey?: unknown }>(req);
      const variant = parseVariants(existing.variants).find((item) => item.key === body?.variantKey);
      if (!variant) {
        json(res, 400, { error: 'Version inconnue.' });
        return true;
      }
      await prisma.$transaction(async (tx) => {
        const welcome: Record<string, unknown> = {};
        if (variant.message !== null) welcome.welcomeMessage = variant.message;
        if (variant.imageEnabled !== null) welcome.welcomeImageEnabled = variant.imageEnabled;
        if (Object.keys(welcome).length > 0) {
          await tx.welcomeConfig.updateMany({ where: { guildId }, data: welcome });
        }
        if (variant.threadEnabled === false) {
          await tx.welcomeThreadConfig.updateMany({ where: { guildId }, data: { enabled: false } });
        }
        await tx.welcomeExperiment.update({
          where: { id: experimentId },
          data: { status: 'STOPPED', winnerKey: variant.key, ...(existing.stoppedAt ? {} : { stoppedAt: new Date() }) },
        });
      });
      await invalidateRunningExperiment(guildId);
      await audit('Version d’accueil appliquée', `« ${variant.name} » du test « ${existing.name} » devient l'accueil du serveur.`);
      json(res, 200, { ok: true });
      return true;
    }

    // DELETE /welcome-experiments/:id
    if (parts.length === 6 && method === 'DELETE') {
      if (existing.status === 'RUNNING') {
        json(res, 409, { error: 'Arrête le test avant de le supprimer.' });
        return true;
      }
      await prisma.welcomeExperiment.delete({ where: { id: experimentId } });
      await audit('Suppression test A/B accueil', `« ${existing.name} ».`);
      json(res, 200, { ok: true });
      return true;
    }
  } catch (err) {
    if (err instanceof ExperimentValidationError) {
      json(res, 400, { error: err.message });
      return true;
    }
    logger.error(LOG, `Erreur sur ${method} ${parts.join('/')} :`, err);
    jsonFailure(res, err, 'Erreur sur les tests A/B', LOG);
    return true;
  }

  return false;
}
