import { toast } from './stores/toast.svelte';

/**
 * Suppression d'un element isole, sans fenetre de confirmation : la ligne
 * disparait tout de suite, la bulle propose « Annuler » quelques secondes, et
 * l'appel ne part qu'a l'expiration. Annuler ou un echec remettent l'element a
 * sa place d'origine.
 *
 * Reserve aux suppressions a impact local (une regle, un flux, une note). Une
 * suppression aux effets en cascade garde sa confirmation, avec la liste de
 * ses consequences.
 *
 *   removeWithUndo({
 *     get: () => rules,
 *     set: (next) => (rules = next),
 *     match: (r) => r.id === rule.id,
 *     message: 'Alerte supprimée',
 *     commit: () => deleteAlertRule(rule.id),
 *   });
 */
export function removeWithUndo<T>(options: {
  get: () => T[];
  set: (items: T[]) => void;
  match: (item: T) => boolean;
  message: string;
  /** L'appel reel. Il doit lever en cas d'echec pour que l'element revienne. */
  commit: () => unknown | Promise<unknown>;
  /** L'appel annonce deja son echec lui-meme. */
  quietError?: boolean;
}): Promise<boolean> {
  const items = options.get();
  const index = items.findIndex(options.match);
  if (index < 0) return Promise.resolve(false);
  const removed = items[index];
  options.set(items.filter((_, i) => i !== index));

  const restore = () => {
    const current = options.get();
    if (current.some(options.match)) return;
    const at = Math.min(index, current.length);
    options.set([...current.slice(0, at), removed, ...current.slice(at)]);
  };

  return toast.undoable(options.message, {
    commit: async () => {
      await options.commit();
    },
    onUndo: restore,
    onError: restore,
    quietError: options.quietError,
  });
}

/** Pour une ecriture qui rend un booleen au lieu de lever : `false` devient une erreur. */
export async function orThrow(result: Promise<unknown>): Promise<void> {
  if (!(await result)) throw new Error('Write failed');
}
