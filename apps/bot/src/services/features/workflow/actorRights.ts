/**
 * Droits que l'auteur d'un workflow doit lui-même posséder.
 *
 * Un workflow agit avec l'autorité du bot, bien plus haute que celle du membre du
 * staff qui le configure. Sans contrôle, « quand je réagis, ajouter le rôle Admin »
 * ou « bannir sur tel mot » faisait du bot un intermédiaire pour monter en
 * privilège. On relève ici, dans le graphe, ce que l'auteur n'aurait pas le droit
 * de faire lui-même : les rôles choisis en dur dans une action de rôle, et les
 * permissions Discord des sanctions.
 *
 * Seuls les rôles fixes sont connus à l'enregistrement : un rôle qui vient du
 * déclencheur ne se vérifie qu'à l'exécution.
 */
import type { WorkflowGraph } from '@kotbo/shared';
import { fixedEntityInputs } from './staticChecks.js';

/** Noms de `PermissionFlagsBits`, sans dépendance à discord.js. */
export type ActorPermission = 'KickMembers' | 'BanMembers' | 'ModerateMembers';

const ROLE_ACTIONS = new Set(['AddRole', 'RemoveRole', 'AddTemporaryRole']);

const SANCTION_PERMISSIONS: Record<string, ActorPermission> = {
  KickMember: 'KickMembers',
  BanMember: 'BanMembers',
  TimeoutMember: 'ModerateMembers',
};

export const ACTOR_PERMISSION_LABELS: Record<ActorPermission, string> = {
  KickMembers: 'Expulser des membres',
  BanMembers: 'Bannir des membres',
  ModerateMembers: 'Exclure temporairement des membres',
};

export interface ActorRightChecks {
  /** Rôles choisis en dur dans une action qui les donne ou les retire. */
  roleIds: string[];
  /** Permissions Discord que l'auteur doit posséder. */
  permissions: ActorPermission[];
}

export function collectActorRightChecks(graph: WorkflowGraph): ActorRightChecks {
  const roleIds = new Set<string>();
  const permissions = new Set<ActorPermission>();

  for (const node of graph.nodes) {
    if (ROLE_ACTIONS.has(node.type)) {
      for (const entity of Object.values(fixedEntityInputs(graph, node.id))) {
        if (entity.kind === 'role') roleIds.add(entity.id);
      }
    }
    const permission = SANCTION_PERMISSIONS[node.type];
    if (permission) permissions.add(permission);
  }

  return { roleIds: [...roleIds], permissions: [...permissions] };
}
