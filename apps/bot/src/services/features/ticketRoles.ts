/**
 * Rôles de la config des tickets : équipe d'assistance, équipe responsable,
 * rôles mentionnés à l'ouverture, rôles exclus.
 *
 * `ticketStaffRoleId` reste le premier rôle d'assistance (le dashboard le
 * recopie à l'enregistrement) : tout ce qui ne lit que ce champ continue de
 * marcher, et un serveur configuré avant les listes garde son équipe.
 */

type RoleConfig = Record<string, unknown> | null | undefined;

/** Garde les identifiants texte non vides, sans doublon, dans l'ordre. */
export function cleanRoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return [...new Set(ids)];
}

function single(value: unknown): string[] {
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

/**
 * Équipe d'assistance d'un ticket. Un type de ticket qui désigne son propre
 * rôle remplace l'équipe du serveur, comme avant les listes.
 */
export function ticketSupportRoleIds(config: RoleConfig, typeRoleId?: string | null): string[] {
  if (typeRoleId) return [typeRoleId];
  return [...new Set([...single(config?.ticketStaffRoleId), ...cleanRoleIds(config?.ticketSupportRoleIds)])];
}

/** Équipe responsable : voit et gère tous les tickets, quel que soit leur type. */
export function ticketManagerRoleIds(config: RoleConfig): string[] {
  return cleanRoleIds(config?.ticketManagerRoleIds);
}

/** Tous les rôles qui ont la main sur un ticket : assistance et responsables. */
export function ticketAccessRoleIds(config: RoleConfig, typeRoleId?: string | null): string[] {
  return [...new Set([...ticketSupportRoleIds(config, typeRoleId), ...ticketManagerRoleIds(config)])];
}

/**
 * Rôles prévenus à l'ouverture. Liste vide : on retombe sur l'équipe
 * d'assistance, qui était déjà mentionnée avant ce réglage.
 */
export function ticketMentionRoleIds(config: RoleConfig, typeRoleId?: string | null): string[] {
  const own = cleanRoleIds(config?.ticketMentionRoleIds);
  return own.length > 0 ? own : ticketSupportRoleIds(config, typeRoleId);
}

/** Vrai si un des rôles du membre figure dans la liste d'exclusion. */
export function hasTicketExcludedRole(config: RoleConfig, memberRoleIds: Iterable<string>): boolean {
  const excluded = new Set(cleanRoleIds(config?.ticketExcludedRoleIds));
  if (excluded.size === 0) return false;
  for (const id of memberRoleIds) if (excluded.has(id)) return true;
  return false;
}

/** Texte de mention `<@&id>` pour une liste de rôles, `null` si elle est vide. */
export function roleMentionText(roleIds: string[]): string | null {
  return roleIds.length > 0 ? roleIds.map((id) => `<@&${id}>`).join(' ') : null;
}
