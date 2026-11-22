import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { validateGraph, type WorkflowGraph } from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import { getGuildName, resolveMemberFeatureAccess, safePushAudit } from '../../shared.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { workflowActorRefusal } from '../../shared/workflowActorGuard.js';
import {
  WorkflowValidationError,
  createWorkflow,
  deleteWorkflow,
  getExecutionDetail,
  getWorkflow,
  listExecutions,
  EXECUTION_STATUSES,
  listWorkflows,
  setWorkflowEnabled,
  testWorkflow,
  collectSaveWarnings,
  type WorkflowWarning,
  updateWorkflow,
} from '../../../services/features/workflow/workflowService.js';

interface WorkflowBody {
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  graph?: unknown;
}

/** Un graphe reçu par l'API n'a aucune garantie de forme : on le normalise. */
function parseGraph(raw: unknown): WorkflowGraph | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;
  return { nodes: candidate.nodes, edges: candidate.edges } as WorkflowGraph;
}

export function createWorkflowsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/workflows';

  const workflowAccess = createMiddleware(async (c, next) => {
    const method = c.req.method;
    const access = c.var.effectiveAccess;
    // Masquer la section dans la navigation ne suffit pas : sans ce controle,
    // l'URL et l'API continuent de servir les workflows a un staff a qui le role
    // interdit la page.
    const featureAccess = await resolveMemberFeatureAccess(client, c.req.param('guildId')!, access, c.var.dashboardUser.userId);
    if (!featureAccess.workflows?.canView) {
      return send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès aux automatisations.' }, 403);
    }

    // Creer, modifier, activer et supprimer un workflow n'avait aucun controle :
    // tout staff pouvait effacer les automatisations du serveur.
    //
    // La suppression se demande a part, comme sur les reunions : la matrice des
    // acces distingue « Configurer » de « Supprimer », et un role autorise a
    // regler les automatisations n'a pas pour autant celui de les effacer.
    const requiredWorkflowRight = method === 'DELETE'
      ? featureAccess.workflows?.canDelete
      : featureAccess.workflows?.canConfigure;

    if (method !== 'GET' && !access.canManageSettings && !requiredWorkflowRight) {
      return send(c, {
        error: method === 'DELETE'
          ? 'Accès refusé. Votre rôle ne permet pas de supprimer les automatisations.'
          : 'Accès refusé. Votre rôle ne permet pas de modifier les automatisations.',
      }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), workflowAccess] as const;

  /**
   * Un workflow agit avec les droits du bot : qui n'est pas admin ne peut pas y mettre
   * un rôle plus haut que le sien, ni une sanction qu'il n'aurait pas le droit d'appliquer.
   */
  const actorRefusal = async (c: Context, guildId: string, graph: WorkflowGraph): Promise<string | null> =>
    c.var.effectiveAccess.canManageSettings
      ? null
      : workflowActorRefusal(client, guildId, c.var.dashboardUser.userId, graph);

  const audit = (c: Context, action: string, details: string) => {
    const guildId = c.req.param('guildId')!;
    const user = c.var.dashboardUser;
    return safePushAudit(guildId, {
      user: `${user.username ?? 'Inconnu'} (${user.userId})`,
      action,
      context: getGuildName(client, guildId),
      module: 'Workflows',
      eventType: 'Manuel',
      details,
      channelId: null,
    }, action);
  };

  /**
   * Avertissements rendus avec l'enregistrement. Un serveur absent du cache ou
   * une vérification en panne n'empêchent pas d'enregistrer : il n'y a alors
   * simplement rien à signaler.
   */
  async function saveWarnings(guildId: string, graph: WorkflowGraph): Promise<WorkflowWarning[]> {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return [];
    return collectSaveWarnings(guild, graph).catch((err) => {
      logger.warn('WorkflowAPI', 'Vérification à l\'enregistrement impossible :', err);
      return [];
    });
  }

  // ── Exécutions ───────────────────────────────────────────────────────────
  // Déclarées avant la route /:id pour ne pas être captées par elle.
  router.get(`${base}/executions`, ...gate, async (c) => {
    try {
      const status = c.req.query('status');
      const before = new Date(c.req.query('before') ?? '');
      const executions = await listExecutions(
        c.req.param('guildId'),
        c.req.query('workflowId') ?? undefined,
        Number(c.req.query('take')) || 25,
        {
          // Un statut inconnu ou une date illisible sont ignorés plutôt que de
          // renvoyer une liste vide qui ferait croire à l'absence d'exécution.
          status: EXECUTION_STATUSES.find((value) => value === status),
          before: Number.isNaN(before.getTime()) ? undefined : before,
        },
      );
      return send(c, { executions });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET exécutions:', err);
      return fail(c, err, 'Erreur lors de la récupération des exécutions', 'WorkflowAPI');
    }
  });

  router.get(`${base}/executions/:executionId`, ...gate, async (c) => {
    try {
      const execution = await getExecutionDetail(c.req.param('guildId'), c.req.param('executionId'));
      if (!execution) return send(c, { error: 'Exécution introuvable' }, 404);
      return send(c, { execution });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET exécutions:', err);
      return fail(c, err, 'Erreur lors de la récupération des exécutions', 'WorkflowAPI');
    }
  });

  // ── Validation à la volée (utilisée par l'éditeur avant enregistrement) ──
  router.post(`${base}/validate`, ...gate, async (c) => {
    try {
      const body = await readBody<WorkflowBody>(c);
      const graph = parseGraph(body?.graph);
      if (!graph) return send(c, { error: 'Graphe invalide' }, 400);
      return send(c, { issues: validateGraph(graph) });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur validation:', err);
      return fail(c, err, 'Erreur lors de la validation', 'WorkflowAPI');
    }
  });

  // ── Essai à blanc (bouton « Tester » de l'éditeur) ──────────────────────
  // Réservé à qui peut configurer, comme toute requête non GET : l'essai lit
  // les membres et les salons du serveur, même s'il n'y écrit rien.
  router.post(`${base}/test`, ...gate, async (c) => {
    try {
      const body = await readBody<{ graph?: unknown; workflowId?: unknown; memberId?: unknown; source?: unknown }>(c);
      const graph = parseGraph(body?.graph);
      if (!graph) return send(c, { error: 'Graphe invalide' }, 400);
      const guild = client.guilds.cache.get(c.req.param('guildId'));
      if (!guild) return send(c, { error: 'Serveur Discord introuvable' }, 404);
      const result = await testWorkflow(guild, {
        graph,
        workflowId: typeof body?.workflowId === 'string' ? body.workflowId : null,
        userId: c.var.dashboardUser.userId,
        memberId: typeof body?.memberId === 'string' && /^\d{17,20}$/.test(body.memberId) ? body.memberId : null,
        source: body?.source === 'last' ? 'last' : 'sample',
      });
      return send(c, { test: result });
    } catch (err) {
      if (err instanceof WorkflowValidationError) return send(c, { error: 'Graphe invalide', issues: err.issues }, 400);
      logger.error('WorkflowAPI', 'Erreur essai:', err);
      return fail(c, err, "Erreur lors de l'essai de l'automatisation", 'WorkflowAPI');
    }
  });

  // ── Liste ────────────────────────────────────────────────────────────────
  router.get(base, ...gate, async (c) => {
    try {
      return send(c, { workflows: await listWorkflows(c.req.param('guildId')) });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET liste:', err);
      return fail(c, err, 'Erreur lors de la récupération des workflows', 'WorkflowAPI');
    }
  });

  // ── Création ─────────────────────────────────────────────────────────────
  router.post(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<WorkflowBody>(c);
      const graph = parseGraph(body?.graph);
      if (!graph || typeof body?.name !== 'string') return send(c, { error: 'Nom ou graphe manquant' }, 400);

      const refusal = await actorRefusal(c, guildId, graph);
      if (refusal) return send(c, { error: refusal }, 403);

      const workflow = await createWorkflow(guildId, {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : null,
        enabled: body.enabled === true,
        graph,
      }, c.var.dashboardUser.userId);

      await audit(c, 'Création workflow', `« ${workflow.name} » sur ${workflow.triggerType}.`);
      return send(c, { workflow, warnings: await saveWarnings(guildId, graph) }, 201);
    } catch (err) {
      if (err instanceof WorkflowValidationError) return send(c, { error: 'Graphe invalide', issues: err.issues }, 400);
      logger.error('WorkflowAPI', 'Erreur création:', err);
      return fail(c, err, 'Erreur lors de la création du workflow', 'WorkflowAPI');
    }
  });

  // ── Détail ───────────────────────────────────────────────────────────────
  router.get(`${base}/:workflowId`, ...gate, async (c) => {
    try {
      const workflow = await getWorkflow(c.req.param('guildId'), c.req.param('workflowId'));
      if (!workflow) return send(c, { error: 'Workflow introuvable' }, 404);
      return send(c, { workflow });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET détail:', err);
      return fail(c, err, 'Erreur lors de la récupération du workflow', 'WorkflowAPI');
    }
  });

  // ── Mise à jour ──────────────────────────────────────────────────────────
  router.put(`${base}/:workflowId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<WorkflowBody>(c);
      const graph = parseGraph(body?.graph);
      if (!graph || typeof body?.name !== 'string') return send(c, { error: 'Nom ou graphe manquant' }, 400);

      const refusal = await actorRefusal(c, guildId, graph);
      if (refusal) return send(c, { error: refusal }, 403);

      const workflow = await updateWorkflow(guildId, c.req.param('workflowId'), {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : null,
        enabled: body.enabled === true,
        graph,
      });
      if (!workflow) return send(c, { error: 'Workflow introuvable' }, 404);

      await audit(c, 'Mise à jour workflow', `« ${workflow.name} », actif : ${workflow.enabled}.`);
      return send(c, { workflow, warnings: await saveWarnings(guildId, graph) });
    } catch (err) {
      if (err instanceof WorkflowValidationError) return send(c, { error: 'Graphe invalide', issues: err.issues }, 400);
      logger.error('WorkflowAPI', 'Erreur mise à jour:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du workflow', 'WorkflowAPI');
    }
  });

  // ── Activation / désactivation ───────────────────────────────────────────
  router.post(`${base}/:workflowId/toggle`, ...gate, async (c) => {
    try {
      const body = await readBody<{ enabled?: unknown }>(c);
      const toggled = await setWorkflowEnabled(c.req.param('guildId'), c.req.param('workflowId'), body?.enabled === true);
      if (!toggled) return send(c, { error: 'Workflow introuvable' }, 404);
      await audit(c, 'Bascule workflow', `Workflow ${body?.enabled === true ? 'activé' : 'désactivé'}.`);
      return send(c, { success: true });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur bascule:', err);
      return fail(c, err, 'Erreur lors du changement d\'état', 'WorkflowAPI');
    }
  });

  // ── Suppression ──────────────────────────────────────────────────────────
  router.delete(`${base}/:workflowId`, ...gate, async (c) => {
    const workflowId = c.req.param('workflowId');
    try {
      const deleted = await deleteWorkflow(c.req.param('guildId'), workflowId);
      if (!deleted) return send(c, { error: 'Workflow introuvable' }, 404);
      await audit(c, 'Suppression workflow', `Workflow ${workflowId} supprimé.`);
      return send(c, { success: true });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur suppression:', err);
      return fail(c, err, 'Erreur lors de la suppression', 'WorkflowAPI');
    }
  });

  return router;
}
