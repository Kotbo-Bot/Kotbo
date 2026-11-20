import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { validateScenario, type ScenarioStep } from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import { getGuildName, safePushAudit } from '../../shared.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import {
  ScenarioValidationError,
  createScenario,
  deleteScenario,
  getSessionDetail,
  getSimulationConfig,
  listScenarios,
  listSessions,
  sanitizeSimulationConfigPatch,
  updateScenario,
  upsertSimulationConfig,
} from '../../../services/staff/simulationService.js';

interface ScenarioBody {
  title?: unknown;
  description?: unknown;
  difficulty?: unknown;
  enabled?: unknown;
  steps?: unknown;
}

const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];

function parseSteps(raw: unknown): ScenarioStep[] | null {
  return Array.isArray(raw) ? (raw as ScenarioStep[]) : null;
}

export function createSimulationRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/simulation';

  // Ces routes n'avaient aucun controle : n'importe quel membre du staff
  // pouvait reecrire la configuration et supprimer les scenarios. La lecture
  // reste ouverte a qui a deja acces au dashboard, comme sur les autres modules.
  const writeAccess = createMiddleware(async (c, next) => {
    if (c.req.method !== 'GET' && !c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions administratives requises.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), writeAccess] as const;

  const audit = (c: Context, action: string, details: string) => {
    const guildId = c.req.param('guildId')!;
    const user = c.var.dashboardUser;
    return safePushAudit(guildId, {
      user: `${user.username ?? 'Inconnu'} (${user.userId})`,
      action,
      context: getGuildName(client, guildId),
      module: 'Staff Simulator',
      eventType: 'Manuel',
      details,
      channelId: null,
    }, action);
  };

  /** Champs communs à la création et à la mise à jour d'un scénario. */
  const scenarioInput = (body: ScenarioBody & { title: string }, steps: ScenarioStep[]) => ({
    title: body.title,
    description: typeof body.description === 'string' ? body.description : '',
    difficulty: DIFFICULTIES.includes(String(body.difficulty)) ? String(body.difficulty) : 'MEDIUM',
    enabled: body.enabled !== false,
    steps,
  });

  // Configuration + scénarios
  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [config, scenarios] = await Promise.all([
        getSimulationConfig(guildId),
        listScenarios(guildId),
      ]);
      return send(c, { config, scenarios });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur GET:', err);
      return fail(c, err, 'Erreur lors de la récupération du simulateur', 'SimulationAPI');
    }
  });

  router.patch(`${base}/config`, ...gate, async (c) => {
    try {
      const body = await readBody(c);
      if (!body) return send(c, { error: 'Corps de requête manquant' }, 400);
      const patch = sanitizeSimulationConfigPatch(body);
      if (Object.keys(patch).length === 0) return send(c, { error: 'Aucun champ valide à mettre à jour' }, 400);
      const config = await upsertSimulationConfig(c.req.param('guildId'), patch);
      await audit(c, 'Mise à jour simulateur', `Actif : ${config.enabled}, salon de test : ${config.testChannelId ?? 'aucun'}.`);
      return send(c, { config });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur PATCH config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'SimulationAPI');
    }
  });

  // ── Sessions ─────────────────────────────────────────────────────────────
  router.get(`${base}/sessions`, ...gate, async (c) => {
    try {
      const sessions = await listSessions(
        c.req.param('guildId'),
        c.req.query('traineeId') ?? undefined,
        Number(c.req.query('take')) || 25,
      );
      return send(c, { sessions });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur GET sessions:', err);
      return fail(c, err, 'Erreur lors de la récupération des sessions', 'SimulationAPI');
    }
  });

  router.get(`${base}/sessions/:sessionId`, ...gate, async (c) => {
    try {
      const session = await getSessionDetail(c.req.param('guildId'), c.req.param('sessionId'));
      if (!session) return send(c, { error: 'Session introuvable' }, 404);
      return send(c, { session });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur GET sessions:', err);
      return fail(c, err, 'Erreur lors de la récupération des sessions', 'SimulationAPI');
    }
  });

  // ── Scénarios ────────────────────────────────────────────────────────────
  router.post(`${base}/scenarios`, ...gate, async (c) => {
    try {
      const body = await readBody<ScenarioBody>(c);
      const steps = parseSteps(body?.steps);
      if (!body || typeof body.title !== 'string' || !steps) return send(c, { error: 'Titre ou étapes manquants' }, 400);

      const scenario = await createScenario(
        c.req.param('guildId'),
        scenarioInput(body as ScenarioBody & { title: string }, steps),
        c.var.dashboardUser.userId,
      );
      await audit(c, 'Création scénario', `« ${scenario.title} », ${steps.length} étape(s).`);
      return send(c, { scenario }, 201);
    } catch (err) {
      if (err instanceof ScenarioValidationError) return send(c, { error: 'Scénario invalide', issues: err.issues }, 400);
      logger.error('SimulationAPI', 'Erreur création scénario:', err);
      return fail(c, err, 'Erreur lors de la création du scénario', 'SimulationAPI');
    }
  });

  router.put(`${base}/scenarios/:scenarioId`, ...gate, async (c) => {
    try {
      const body = await readBody<ScenarioBody>(c);
      const steps = parseSteps(body?.steps);
      if (!body || typeof body.title !== 'string' || !steps) return send(c, { error: 'Titre ou étapes manquants' }, 400);

      const scenario = await updateScenario(
        c.req.param('guildId'),
        c.req.param('scenarioId'),
        scenarioInput(body as ScenarioBody & { title: string }, steps),
      );
      if (!scenario) return send(c, { error: 'Scénario introuvable' }, 404);

      await audit(c, 'Mise à jour scénario', `« ${scenario.title} », ${steps.length} étape(s).`);
      return send(c, { scenario });
    } catch (err) {
      if (err instanceof ScenarioValidationError) return send(c, { error: 'Scénario invalide', issues: err.issues }, 400);
      logger.error('SimulationAPI', 'Erreur mise à jour scénario:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du scénario', 'SimulationAPI');
    }
  });

  router.delete(`${base}/scenarios/:scenarioId`, ...gate, async (c) => {
    const scenarioId = c.req.param('scenarioId');
    try {
      const deleted = await deleteScenario(c.req.param('guildId'), scenarioId);
      if (!deleted) return send(c, { error: 'Scénario introuvable' }, 404);
      await audit(c, 'Suppression scénario', `Scénario ${scenarioId} supprimé.`);
      return send(c, { success: true });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur suppression scénario:', err);
      return fail(c, err, 'Erreur lors de la suppression', 'SimulationAPI');
    }
  });

  // Validation à la volée, utilisée par l'éditeur avant enregistrement
  router.patch(`${base}/scenarios`, ...gate, async (c) => {
    try {
      const body = await readBody<ScenarioBody>(c);
      const steps = parseSteps(body?.steps) ?? [];
      return send(c, { issues: validateScenario({ title: String(body?.title ?? ''), steps }) });
    } catch (err) {
      logger.error('SimulationAPI', 'Erreur validation scénario:', err);
      return fail(c, err, 'Erreur lors de la validation', 'SimulationAPI');
    }
  });

  return router;
}
