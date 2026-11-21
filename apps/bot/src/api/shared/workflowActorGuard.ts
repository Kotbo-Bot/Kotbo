/**
 * Garde « l'auteur du workflow a-t-il le droit de programmer ces actions ? ».
 * Les règles de relevé vivent dans `collectActorRightChecks` ; ici, la lecture
 * des droits Discord de l'auteur et le refus rédigé pour le dashboard.
 */
import { PermissionFlagsBits, type Client } from 'discord.js';
import type { WorkflowGraph } from '@kotbo/shared';
import { ACTOR_PERMISSION_LABELS, collectActorRightChecks, type ActorPermission } from '../../services/features/workflow/actorRights.js';
import { roleGrantRefusal } from './roleGrantGuard.js';

/** Message de refus, ou `null` si l'auteur peut programmer tout ce que le graphe fait. */
export async function workflowActorRefusal(
  client: Client,
  guildId: string,
  actorUserId: string,
  graph: WorkflowGraph,
): Promise<string | null> {
  const needs = collectActorRightChecks(graph);

  const roleRefusal = await roleGrantRefusal(client, guildId, actorUserId, needs.roleIds);
  if (roleRefusal) return roleRefusal;
  if (needs.permissions.length === 0) return null;

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(actorUserId).catch(() => null) : null;
  if (!guild || !member) return "Impossible de vérifier vos droits sur ce serveur : vous n'en êtes pas membre.";
  if (member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) return null;

  const missing = needs.permissions.filter((name: ActorPermission) => !member.permissions.has(PermissionFlagsBits[name]));
  if (missing.length === 0) return null;
  return `Ce workflow sanctionne des membres : il vous faut vous-même le droit « ${missing.map((name) => ACTOR_PERMISSION_LABELS[name]).join(' », « ')} ».`;
}
