/**
 * Instance bloquée par l'administration Kotbo (sans bail valide, ou bannie).
 *
 * L'API ferme alors toutes ses routes avec un 403 `instance_blocked`. Le
 * dashboard le reconnaît pour afficher le motif une fois, plutôt qu'une
 * suite d'erreurs sur chaque page.
 */
export interface InstanceBlock {
  reason: string | null;
}

export function instanceBlockFromBody(body: unknown): InstanceBlock | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (record.code !== 'instance_blocked') return null;
  return { reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason : null };
}
