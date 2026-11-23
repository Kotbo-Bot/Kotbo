/**
 * Disposition des onglets de la fiche membre selon le rôle du staff qui la
 * consulte. Les ids doivent rester alignés avec `MemberCaseTab` côté dashboard.
 */
export const MEMBER_CASE_TABS = [
  'extra', 'resume', 'identite', 'activite', 'analytics', 'contenu', 'messages', 'logs',
  'sanctions', 'candidatures', 'invites', 'connexions', 'linked_accounts', 'notes', 'wellbeing',
] as const;

/** Onglet jamais masquable : la fiche garde toujours son point d'entrée. */
export const ALWAYS_VISIBLE_TAB = 'resume';

export interface MemberCaseLayoutRule {
  roleIds: string[];
  tabOrder: string[];
  hiddenTabs: string[];
}

/** Première règle (déjà triée par position) dont un rôle est porté par le lecteur. */
export function pickLayoutRule<T extends { roleIds: string[] }>(rules: readonly T[], viewerRoleIds: ReadonlySet<string>): T | null {
  return rules.find((rule) => rule.roleIds.some((id) => viewerRoleIds.has(id))) ?? null;
}

/** Ne garde que des onglets connus, sans doublon, et jamais l'onglet d'entrée masqué. */
export function sanitizeLayoutRule(input: { tabOrder?: unknown; hiddenTabs?: unknown; roleIds?: unknown }): MemberCaseLayoutRule {
  const known = new Set<string>(MEMBER_CASE_TABS);
  const clean = (value: unknown, accept: (v: string) => boolean) =>
    Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && accept(v)))] : [];
  return {
    roleIds: clean(input.roleIds, (v) => /^\d{17,20}$/.test(v)),
    tabOrder: clean(input.tabOrder, (v) => known.has(v)),
    hiddenTabs: clean(input.hiddenTabs, (v) => known.has(v) && v !== ALWAYS_VISIBLE_TAB),
  };
}
