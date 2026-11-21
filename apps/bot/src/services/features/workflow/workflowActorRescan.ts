/**
 * Rattrapage des workflows enregistrés avant le contrôle des droits de l'auteur.
 *
 * À l'enregistrement, `workflowActorRefusal` refuse un rôle ou une sanction que
 * l'auteur n'aurait pas le droit de donner. Les workflows déjà actifs n'ont jamais
 * été jugés : on les rejuge avec leur créateur et on désactive ceux qui dépassent
 * ses droits. Un créateur parti du serveur n'est pas jugé (rien à comparer).
 *
 * shortcut: seul `createdById` est connu, pas le dernier éditeur ; à relancer au
 * besoin avec RESCAN_WORKFLOW_RIGHTS=1, jamais en continu (il re-désactiverait
 * un workflow qu'un administrateur a volontairement réactivé).
 */
import type { Client } from 'discord.js';
import type { WorkflowGraph } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { workflowActorRefusal } from '../../../api/shared/workflowActorGuard.js';
import { setWorkflowEnabled } from './workflowService.js';

export interface RescanDeps {
  refusalFor: (guildId: string, userId: string, graph: WorkflowGraph) => Promise<string | null>;
  isMember: (guildId: string, userId: string) => Promise<boolean>;
  disable: (guildId: string, workflowId: string, reason: string) => Promise<void>;
}

export async function rescanWorkflowActorRights(client: Client, deps: RescanDeps = defaultDeps(client)): Promise<number> {
  const guildIds = [...client.guilds.cache.keys()];
  const workflows = await prisma.workflow.findMany({
    where: { enabled: true, createdById: { not: null }, guildId: { in: guildIds } },
    select: { id: true, guildId: true, name: true, graph: true, createdById: true },
  });

  let disabled = 0;
  for (const wf of workflows) {
    const graph = wf.graph as unknown as WorkflowGraph;
    if (!Array.isArray(graph?.nodes) || !wf.createdById) continue;
    if (!(await deps.isMember(wf.guildId, wf.createdById))) continue;

    const refusal = await deps.refusalFor(wf.guildId, wf.createdById, graph);
    if (!refusal) continue;

    await deps.disable(wf.guildId, wf.id, refusal);
    disabled++;
    logger.warn('WorkflowRescan', `Workflow « ${wf.name} » (${wf.id}, serveur ${wf.guildId}) désactivé : ${refusal}`);
  }
  logger.info('WorkflowRescan', `${workflows.length} workflow(s) actif(s) contrôlé(s), ${disabled} désactivé(s).`);
  return disabled;
}

function defaultDeps(client: Client): RescanDeps {
  return {
    refusalFor: (guildId, userId, graph) => workflowActorRefusal(client, guildId, userId, graph),
    isMember: async (guildId, userId) => {
      const guild = client.guilds.cache.get(guildId);
      return Boolean(guild && await guild.members.fetch(userId).catch(() => null));
    },
    disable: async (guildId, workflowId, reason) => {
      await setWorkflowEnabled(guildId, workflowId, false);
      // Le motif reste visible sur la fiche du workflow dans le dashboard.
      await prisma.workflow.updateMany({
        where: { id: workflowId, guildId },
        data: { lastError: `Désactivé : ${reason}`.slice(0, 500) },
      });
    },
  };
}
