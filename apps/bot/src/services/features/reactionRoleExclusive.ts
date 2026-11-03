/**
 * Menu « un seul rôle » (couleurs, pronoms, région) : prendre un rôle du menu
 * retire ceux du même menu que le membre avait déjà.
 */
export function rolesToSwapOut(menuRoleIds: string[], ownedRoleIds: Iterable<string>, clickedRoleId: string): string[] {
  const owned = new Set(ownedRoleIds);
  return [...new Set(menuRoleIds)].filter((id) => id !== clickedRoleId && owned.has(id));
}
