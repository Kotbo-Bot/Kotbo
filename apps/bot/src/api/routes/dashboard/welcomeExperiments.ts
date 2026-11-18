import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { pushAudit, getGuildName } from '../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
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
export function createWelcomeExperimentsRouter(client: Client) {
  const router = new Hono();
  const base = `/api/dashboard/guilds/:guildId/${SEGMENT}`;
  const gate = guildRoute(client);

  const audit = (c: Context, action: string, details: string) => {
    const guildId = c.req.param('guildId')!;
    return pushAudit(guildId, {
      user: auditUserOf(c),
      action,
      context: getGuildName(client, guildId),
      module: 'Accueil',
      eventType: 'Settings',
      details,
      channelId: null,
    }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));
  };

  /** Une erreur de validation devient un 400, le reste passe par `fail`. */
  const guarded = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof ExperimentValidationError) return send(c, { error: err.message }, 400);
      logger.error(LOG, `Erreur sur ${c.req.method} ${c.req.path} :`, err);
      return fail(c, err, 'Erreur sur les tests A/B', LOG);
    }
  };

  /** Le test visé, limité au serveur, ou le 404. */
  async function loadExperiment(c: Context) {
    const existing = await prisma.welcomeExperiment.findFirst({
      where: { id: c.req.param('experimentId'), guildId: c.req.param('guildId') },
    });
    return existing ?? send(c, { error: 'Test introuvable.' }, 404);
  }

  router.get(base, ...gate, guarded(async (c) => {
    const guildId = c.req.param('guildId')!;
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
    return send(c, {
      experiments: experiments.map((experiment) => ({ ...experiment, assigned: assigned.get(experiment.id) ?? {} })),
      welcome: welcome ?? { welcomeEnabled: false, welcomeChannelId: null, welcomeMessage: '', welcomeImageEnabled: false },
      canEdit: c.var.effectiveAccess.canManageSettings,
    });
  }));

  router.post(base, ...gate, guarded(async (c) => {
    const body = await readBody(c);
    const name = readText(body?.name, 80);
    if (!name) return send(c, { error: 'Donne un nom au test.' }, 400);
    const experiment = await prisma.welcomeExperiment.create({
      data: {
        guildId: c.req.param('guildId')!,
        name,
        hypothesis: readText(body?.hypothesis, 500),
        primaryMetric: readMetric(body?.primaryMetric),
        variants: parseVariants(body?.variants) as never,
        createdById: c.var.dashboardUser.userId,
      },
    });
    await audit(c, 'Création test A/B accueil', `« ${name} ».`);
    return send(c, { experiment: { ...experiment, assigned: {} } }, 201);
  }));

  router.get(`${base}/:experimentId/results`, ...gate, guarded(async (c) => {
    const existing = await loadExperiment(c);
    if (existing instanceof Response) return existing;
    return send(c, await getExperimentResults(c.req.param('guildId')!, existing.id));
  }));

  router.patch(`${base}/:experimentId`, ...gate, guarded(async (c) => {
    const existing = await loadExperiment(c);
    if (existing instanceof Response) return existing;
    const body = await readBody(c);
    const data: Record<string, unknown> = {};
    if (body?.name !== undefined) {
      const name = readText(body.name, 80);
      if (!name) return send(c, { error: 'Donne un nom au test.' }, 400);
      data.name = name;
    }
    if (body?.hypothesis !== undefined) data.hypothesis = readText(body.hypothesis, 500);
    // Changer les versions ou la mesure en cours de route fausserait la
    // comparaison : seulement sur un brouillon.
    if (body?.variants !== undefined || body?.primaryMetric !== undefined) {
      if (existing.status !== 'DRAFT') {
        return send(c, { error: 'Les versions ne se modifient plus une fois le test lancé.' }, 409);
      }
      if (body.variants !== undefined) data.variants = parseVariants(body.variants);
      if (body.primaryMetric !== undefined) data.primaryMetric = readMetric(body.primaryMetric);
    }
    const experiment = await prisma.welcomeExperiment.update({ where: { id: existing.id }, data });
    return send(c, { experiment });
  }));

  router.post(`${base}/:experimentId/start`, ...gate, guarded(async (c) => {
    const existing = await loadExperiment(c);
    if (existing instanceof Response) return existing;
    const guildId = c.req.param('guildId')!;
    if (existing.status !== 'DRAFT') return send(c, { error: 'Seul un brouillon peut être lancé.' }, 409);
    const running = await prisma.welcomeExperiment.findFirst({ where: { guildId, status: 'RUNNING' }, select: { name: true } });
    if (running) return send(c, { error: `Le test « ${running.name} » est déjà en cours : arrête-le d'abord.` }, 409);
    const experiment = await prisma.welcomeExperiment.update({ where: { id: existing.id }, data: { status: 'RUNNING', startedAt: new Date() } });
    await invalidateRunningExperiment(guildId);
    await audit(c, 'Lancement test A/B accueil', `« ${existing.name} ».`);
    return send(c, { experiment });
  }));

  router.post(`${base}/:experimentId/stop`, ...gate, guarded(async (c) => {
    const existing = await loadExperiment(c);
    if (existing instanceof Response) return existing;
    if (existing.status !== 'RUNNING') return send(c, { error: "Ce test n'est pas en cours." }, 409);
    const experiment = await prisma.welcomeExperiment.update({ where: { id: existing.id }, data: { status: 'STOPPED', stoppedAt: new Date() } });
    await invalidateRunningExperiment(c.req.param('guildId')!);
    await audit(c, 'Arrêt test A/B accueil', `« ${existing.name} ».`);
    return send(c, { experiment });
  }));

  // { variantKey }
  router.post(`${base}/:experimentId/ship`, ...gate, guarded(async (c) => {
    const existing = await loadExperiment(c);
    if (existing instanceof Response) return existing;
    const guildId = c.req.param('guildId')!;
    const body = await readBody<{ variantKey?: unknown }>(c);
    const variant = parseVariants(existing.variants).find((item) => item.key === body?.variantKey);
    if (!variant) return send(c, { error: 'Version inconnue.' }, 400);
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
        where: { id: existing.id },
        data: { status: 'STOPPED', winnerKey: variant.key, ...(existing.stoppedAt ? {} : { stoppedAt: new Date() }) },
      });
    });
    await invalidateRunningExperiment(guildId);
    await audit(c, 'Version d’accueil appliquée', `« ${variant.name} » du test « ${existing.name} » devient l'accueil du serveur.`);
    return send(c, { ok: true });
  }));

  router.delete(`${base}/:experimentId`, ...gate, guarded(async (c) => {
    const existing = await loadExperiment(c);
    if (existing instanceof Response) return existing;
    if (existing.status === 'RUNNING') return send(c, { error: 'Arrête le test avant de le supprimer.' }, 409);
    await prisma.welcomeExperiment.delete({ where: { id: existing.id } });
    await audit(c, 'Suppression test A/B accueil', `« ${existing.name} ».`);
    return send(c, { ok: true });
  }));

  return router;
}
