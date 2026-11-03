import { NODE_CATALOG, TRIGGER_LIBRARY, isNodeAvailable } from '@kotbo/shared';
import { isModulePaused } from '@kotbo/contracts';

/**
 * Ce que les éditeurs d'automatisation proposent.
 *
 * Un nœud rattaché à un module en pause n'a aucune chance de s'exécuter : son
 * événement n'est plus émis, et le bot refuse de l'enregistrer. Une
 * automatisation déjà enregistrée avec un tel nœud reste lisible : seul le
 * choix est retiré.
 */
export function isNodeOffered(type: string): boolean {
  return isNodeAvailable(type, isModulePaused);
}

export const OFFERED_NODE_CATALOG = NODE_CATALOG.filter((def) => isNodeOffered(def.type));

export const OFFERED_TRIGGERS = TRIGGER_LIBRARY.filter((trigger) => isNodeOffered(trigger.type));
