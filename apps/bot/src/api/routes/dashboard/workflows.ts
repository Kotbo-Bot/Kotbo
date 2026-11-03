import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { validateGraph, type WorkflowGraph } from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, getGuildName, resolveMemberFeatureAccess, safePushAudit, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
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

export async function handleWorkflowRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== 'workflows') return false;

  const method = req.method;
  const sub = parts[5];

  // Masquer la section dans la navigation ne suffit pas : sans ce controle,
  // l'URL et l'API continuent de servir les workflows a un staff a qui le role
  // interdit la page.
  const featureAccess = await resolveMemberFeatureAccess(client, guildId, access, user.userId);
  if (!featureAccess.workflows?.canView) {
    json(res, 403, { error: 'Accès refusé. Votre rôle ne donne pas accès aux automatisations.' });
    return true;
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
    json(res, 403, {
      error: method === 'DELETE'
        ? 'Accès refusé. Votre rôle ne permet pas de supprimer les automatisations.'
        : 'Accès refusé. Votre rôle ne permet pas de modifier les automatisations.',
    });
    return true;
  }

  const audit = (action: string, details: string) => safePushAudit(guildId, {
    user: `${user.username ?? 'Inconnu'} (${user.userId})`,
    action,
    context: getGuildName(client, guildId),
    module: 'Workflows',
    eventType: 'Manuel',
    details,
    channelId: null,
  }, action);

  // ── Exécutions ───────────────────────────────────────────────────────────
  // Placé avant la route /:id pour ne pas être capté par elle.
  if (sub === 'executions' && method === 'GET') {
    try {
      if (parts[6]) {
        const execution = await getExecutionDetail(guildId, parts[6]);
        if (!execution) {
          json(res, 404, { error: 'Exécution introuvable' });
          return true;
        }
        json(res, 200, { execution });
        return true;
      }

      const status = url.searchParams.get('status');
      const before = new Date(url.searchParams.get('before') ?? '');
      const executions = await listExecutions(
        guildId,
        url.searchParams.get('workflowId') ?? undefined,
        Number(url.searchParams.get('take')) || 25,
        {
          // Un statut inconnu ou une date illisible sont ignorés plutôt que de
          // renvoyer une liste vide qui ferait croire à l'absence d'exécution.
          status: EXECUTION_STATUSES.find((value) => value === status),
          before: Number.isNaN(before.getTime()) ? undefined : before,
        },
      );
      json(res, 200, { executions });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET exécutions:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des exécutions', 'WorkflowAPI');
    }
    return true;
  }

  // ── Validation à la volée (utilisée par l'éditeur avant enregistrement) ──
  if (sub === 'validate' && method === 'POST') {
    try {
      const body = await readJsonBody<WorkflowBody>(req);
      const graph = parseGraph(body?.graph);
      if (!graph) {
        json(res, 400, { error: 'Graphe invalide' });
        return true;
      }
      json(res, 200, { issues: validateGraph(graph) });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur validation:', err);
      jsonFailure(res, err, 'Erreur lors de la validation', 'WorkflowAPI');
    }
    return true;
  }

  // ── Essai à blanc (bouton « Tester » de l'éditeur) ──────────────────────
  // Réservé à qui peut configurer, comme toute requête non GET : l'essai lit
  // les membres et les salons du serveur, même s'il n'y écrit rien.
  if (sub === 'test' && method === 'POST') {
    try {
      const body = await readJsonBody<{ graph?: unknown; workflowId?: unknown; memberId?: unknown; source?: unknown }>(req);
      const graph = parseGraph(body?.graph);
      if (!graph) {
        json(res, 400, { error: 'Graphe invalide' });
        return true;
      }
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        json(res, 404, { error: 'Serveur Discord introuvable' });
        return true;
      }
      const result = await testWorkflow(guild, {
        graph,
        workflowId: typeof body?.workflowId === 'string' ? body.workflowId : null,
        userId: user.userId,
        memberId: typeof body?.memberId === 'string' && /^\d{17,20}$/.test(body.memberId) ? body.memberId : null,
        source: body?.source === 'last' ? 'last' : 'sample',
      });
      json(res, 200, { test: result });
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        json(res, 400, { error: 'Graphe invalide', issues: err.issues });
        return true;
      }
      logger.error('WorkflowAPI', 'Erreur essai:', err);
      jsonFailure(res, err, "Erreur lors de l'essai de l'automatisation", 'WorkflowAPI');
    }
    return true;
  }

  // ── Liste ────────────────────────────────────────────────────────────────
  if (!sub && method === 'GET') {
    try {
      json(res, 200, { workflows: await listWorkflows(guildId) });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET liste:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des workflows', 'WorkflowAPI');
    }
    return true;
  }

  // ── Création ─────────────────────────────────────────────────────────────
  if (!sub && method === 'POST') {
    try {
      const body = await readJsonBody<WorkflowBody>(req);
      const graph = parseGraph(body?.graph);
      if (!graph || typeof body?.name !== 'string') {
        json(res, 400, { error: 'Nom ou graphe manquant' });
        return true;
      }

      const workflow = await createWorkflow(guildId, {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : null,
        enabled: body.enabled === true,
        graph,
      }, user.userId);

      await audit('Création workflow', `« ${workflow.name} » sur ${workflow.triggerType}.`);
      json(res, 201, { workflow });
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        json(res, 400, { error: 'Graphe invalide', issues: err.issues });
        return true;
      }
      logger.error('WorkflowAPI', 'Erreur création:', err);
      jsonFailure(res, err, 'Erreur lors de la création du workflow', 'WorkflowAPI');
    }
    return true;
  }

  // ── Détail ───────────────────────────────────────────────────────────────
  if (sub && !parts[6] && method === 'GET') {
    try {
      const workflow = await getWorkflow(guildId, sub);
      if (!workflow) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }
      json(res, 200, { workflow });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur GET détail:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération du workflow', 'WorkflowAPI');
    }
    return true;
  }

  // ── Mise à jour ──────────────────────────────────────────────────────────
  if (sub && !parts[6] && method === 'PUT') {
    try {
      const body = await readJsonBody<WorkflowBody>(req);
      const graph = parseGraph(body?.graph);
      if (!graph || typeof body?.name !== 'string') {
        json(res, 400, { error: 'Nom ou graphe manquant' });
        return true;
      }

      const workflow = await updateWorkflow(guildId, sub, {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : null,
        enabled: body.enabled === true,
        graph,
      });

      if (!workflow) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }

      await audit('Mise à jour workflow', `« ${workflow.name} », actif : ${workflow.enabled}.`);
      json(res, 200, { workflow });
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        json(res, 400, { error: 'Graphe invalide', issues: err.issues });
        return true;
      }
      logger.error('WorkflowAPI', 'Erreur mise à jour:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour du workflow', 'WorkflowAPI');
    }
    return true;
  }

  // ── Activation / désactivation ───────────────────────────────────────────
  if (sub && parts[6] === 'toggle' && method === 'POST') {
    try {
      const body = await readJsonBody<{ enabled?: unknown }>(req);
      const toggled = await setWorkflowEnabled(guildId, sub, body?.enabled === true);

      if (!toggled) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }

      await audit('Bascule workflow', `Workflow ${body?.enabled === true ? 'activé' : 'désactivé'}.`);
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur bascule:', err);
      jsonFailure(res, err, 'Erreur lors du changement d\'état', 'WorkflowAPI');
    }
    return true;
  }

  // ── Suppression ──────────────────────────────────────────────────────────
  if (sub && !parts[6] && method === 'DELETE') {
    try {
      const deleted = await deleteWorkflow(guildId, sub);
      if (!deleted) {
        json(res, 404, { error: 'Workflow introuvable' });
        return true;
      }
      await audit('Suppression workflow', `Workflow ${sub} supprimé.`);
      json(res, 200, { success: true });
    } catch (err) {
      logger.error('WorkflowAPI', 'Erreur suppression:', err);
      jsonFailure(res, err, 'Erreur lors de la suppression', 'WorkflowAPI');
    }
    return true;
  }

  return false;
}
