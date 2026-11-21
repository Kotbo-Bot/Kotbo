/**
 * Garde « qui configure peut-il donner ce rôle ? ».
 *
 * Un menu de rôles ou une auto-réponse fait attribuer un rôle par le bot, dont le
 * rang est bien plus haut que celui du membre du staff qui les configure. Sans
 * cette garde, un modérateur à qui la section est ouverte pouvait y mettre un
 * rôle plus puissant que le sien (ou doté de droits qu'il n'a pas) et se
 * l'attribuer : le bot servait d'intermédiaire. La règle est celle de Discord pour
 * un membre : on ne donne que ce qui est strictement sous son propre rôle le plus
 * haut, et rien qui porte une permission critique qu'on ne possède pas.
 */
import { PermissionFlagsBits, type Client } from 'discord.js';

/** Permissions dont l'octroi équivaut à une montée en privilège. */
export const CRITICAL_ROLE_PERMISSIONS: ReadonlyArray<{ flag: bigint; label: string }> = [
  { flag: PermissionFlagsBits.Administrator, label: 'Administrateur' },
  { flag: PermissionFlagsBits.ManageGuild, label: 'Gérer le serveur' },
  { flag: PermissionFlagsBits.ManageRoles, label: 'Gérer les rôles' },
  { flag: PermissionFlagsBits.ManageChannels, label: 'Gérer les salons' },
  { flag: PermissionFlagsBits.ManageWebhooks, label: 'Gérer les webhooks' },
  { flag: PermissionFlagsBits.BanMembers, label: 'Bannir des membres' },
  { flag: PermissionFlagsBits.KickMembers, label: 'Expulser des membres' },
  { flag: PermissionFlagsBits.ModerateMembers, label: 'Exclure temporairement des membres' },
  { flag: PermissionFlagsBits.MentionEveryone, label: 'Mentionner @everyone' },
];

export type RoleGrantActor = {
  isOwner: boolean;
  isAdministrator: boolean;
  highestPosition: number;
  hasPermission: (flag: bigint) => boolean;
};

export type RoleGrantTarget = { id: string; name: string; position: number; permissions: { has: (flag: bigint) => boolean } };

/** Message de refus pour le premier rôle que l'acteur n'a pas le droit de donner, sinon `null`. */
export function evaluateRoleGrant(actor: RoleGrantActor | null, roles: RoleGrantTarget[]): string | null {
  if (!actor) return "Impossible de vérifier vos droits sur ce serveur : vous n'en êtes pas membre.";
  if (actor.isOwner || actor.isAdministrator) return null;

  for (const role of roles) {
    if (role.position >= actor.highestPosition) {
      return `Vous ne pouvez pas faire attribuer le rôle « ${role.name} » : il est au même niveau que votre rôle le plus haut, ou au-dessus.`;
    }
    const escalated = CRITICAL_ROLE_PERMISSIONS.filter((p) => role.permissions.has(p.flag) && !actor.hasPermission(p.flag));
    if (escalated.length > 0) {
      return `Vous ne pouvez pas faire attribuer le rôle « ${role.name} » : il donne des droits que vous n'avez pas (${escalated.map((p) => p.label).join(', ')}).`;
    }
  }
  return null;
}

/**
 * Vérifie, pour l'acteur du dashboard, les rôles qu'une configuration ferait donner.
 * Les rôles introuvables sont laissés aux contrôles existants (« missing »).
 */
export async function roleGrantRefusal(
  client: Client,
  guildId: string,
  actorUserId: string,
  roleIds: Array<string | null | undefined>,
): Promise<string | null> {
  const wanted = [...new Set(roleIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0) return null;

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  const member = await guild.members.fetch(actorUserId).catch(() => null);
  const roles: RoleGrantTarget[] = [];
  for (const id of wanted) {
    const role = guild.roles.cache.get(id) ?? await guild.roles.fetch(id).catch(() => null);
    if (role) roles.push({ id: role.id, name: role.name, position: role.position, permissions: role.permissions });
  }

  const actor: RoleGrantActor | null = member
    ? {
        isOwner: member.id === guild.ownerId,
        isAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
        highestPosition: member.roles.highest.position,
        hasPermission: (flag) => member.permissions.has(flag),
      }
    : null;
  return evaluateRoleGrant(actor, roles);
}
