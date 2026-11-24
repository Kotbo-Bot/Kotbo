/**
 * Type de ticket désigné dans une automatisation, par son identifiant ou par
 * le nom affiché sur le panneau (« Convocation »), plus simple à écrire.
 */
export function findTicketType<T extends { id: string; label: string }>(types: readonly T[], ref: string): T | null {
  const wanted = ref.trim();
  if (!wanted) return null;
  const byId = types.find((type) => type.id === wanted);
  if (byId) return byId;
  const key = wanted.toLocaleLowerCase('fr');
  return types.find((type) => type.label.trim().toLocaleLowerCase('fr') === key) ?? null;
}
