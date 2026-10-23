import { m } from '../i18n';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void | Promise<void>;
  };
  /** Bulle d'annulation : une barre montre le temps qu'il reste pour annuler. */
  undoable?: boolean;
}

export interface UndoableOptions {
  /** L'action reelle, lancee quand le delai d'annulation expire. */
  commit: () => void | Promise<void>;
  /** Remet l'interface comme avant, quand l'utilisateur annule. */
  onUndo?: () => void;
  /** L'action a echoue apres coup : remettre l'element. Un message d'erreur s'affiche deja. */
  onError?: (error: unknown) => void;
  /** L'appel signale deja son echec lui-meme (dashboardRequest) : pas de second message. */
  quietError?: boolean;
  duration?: number;
}

interface PendingUndo extends UndoableOptions {
  resolve: (committed: boolean) => void;
}

/** Bulles affichables en meme temps : au-dela, la plus ancienne cede la place. */
const MAX_VISIBLE = 4;

/** Temps laisse pour annuler : assez pour reagir, assez court pour ne pas encombrer. */
const UNDO_DURATION = 6000;

class ToastStore {
  toasts = $state<Toast[]>([]);

  /** Minuteries de disparition, pour pouvoir en relancer une sans doublon. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Actions differees, en attente de la fin de leur delai d'annulation. */
  private pending = new Map<string, PendingUndo>();

  constructor() {
    // Fermer l'onglet pendant le delai vaut validation : ce que l'utilisateur
    // a vu disparaitre ne doit pas revenir au prochain chargement.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        for (const id of [...this.pending.keys()]) this.remove(id);
      });
    }
  }

  /**
   * Action legere sans confirmation prealable : l'interface l'applique tout de
   * suite, la bulle propose « Annuler » quelques secondes, et l'action reelle
   * ne part qu'a l'expiration. Pour supprimer une ligne, un element isole ;
   * une suppression aux effets en cascade garde sa fenetre de confirmation.
   *
   *   items = items.filter((i) => i.id !== item.id);
   *   toast.undoable('Tâche supprimée', {
   *     commit: () => api.delete(`/tasks/${item.id}`),
   *     onUndo: () => (items = [...items, item]),
   *     onError: () => (items = [...items, item]),
   *   });
   *
   * La promesse dit si l'action a ete menee (true) ou annulee (false).
   */
  undoable(message: string, options: UndoableOptions): Promise<boolean> {
    const id = crypto.randomUUID();
    const duration = options.duration ?? UNDO_DURATION;

    return new Promise<boolean>((resolve) => {
      this.pending.set(id, { ...options, resolve });
      this.toasts.push({
        id,
        message,
        type: 'success',
        duration,
        undoable: true,
        action: {
          label: m.toast_undo(),
          onClick: () => {
            const entry = this.pending.get(id);
            if (!entry) return;
            this.pending.delete(id);
            entry.onUndo?.();
            entry.resolve(false);
          },
        },
      });
      while (this.toasts.length > MAX_VISIBLE) {
        this.remove(this.toasts[0].id);
      }
      this.scheduleRemoval(id, duration);
    });
  }

  /** Lance l'action differee d'une bulle qui s'en va sans avoir ete annulee. */
  private async commitPending(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    try {
      await entry.commit();
      entry.resolve(true);
    } catch (error) {
      console.error('Undoable action failed:', error);
      entry.onError?.(error);
      if (!entry.quietError) this.error(m.toast_undoable_failed());
      entry.resolve(false);
    }
  }

  add(
    message: string,
    type: ToastType = 'info',
    duration = 5000,
    action?: { label: string; onClick: () => void | Promise<void> }
  ) {
    // Un meme message deja a l'ecran ne se rejoue pas : une action qui echoue
    // deux fois, ou une page qui double le message du socle, empilait des
    // bulles identiques que l'utilisateur devait fermer une par une.
    const existing = this.toasts.find((entry) => entry.message === message && entry.type === type);
    if (existing) {
      this.scheduleRemoval(existing.id, duration);
      return;
    }

    const id = crypto.randomUUID();
    this.toasts.push({ id, message, type, duration, action });

    // Une avalanche (module eteint, coupure reseau) ne doit pas recouvrir la
    // page : seules les dernieres bulles restent.
    while (this.toasts.length > MAX_VISIBLE) {
      this.remove(this.toasts[0].id);
    }

    this.scheduleRemoval(id, duration);
  }

  private scheduleRemoval(id: string, duration: number) {
    const previous = this.timers.get(id);
    if (previous) {
      clearTimeout(previous);
      this.timers.delete(id);
    }
    if (duration > 0) {
      this.timers.set(id, setTimeout(() => this.remove(id), duration));
    }
  }

  success(message: string, duration?: number, action?: { label: string; onClick: () => void | Promise<void> }) {
    this.add(message, 'success', duration, action);
  }

  error(message: string, duration?: number, action?: { label: string; onClick: () => void | Promise<void> }) {
    this.add(message, 'error', duration, action);
  }

  info(message: string, duration?: number, action?: { label: string; onClick: () => void | Promise<void> }) {
    this.add(message, 'info', duration, action);
  }

  warning(message: string, duration?: number, action?: { label: string; onClick: () => void | Promise<void> }) {
    this.add(message, 'warning', duration, action);
  }

  remove(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts = this.toasts.filter((t) => t.id !== id);
    // Fermer une bulle d'annulation, la voir expirer ou ceder sa place : dans
    // tous les cas l'utilisateur n'a pas annule, l'action part.
    void this.commitPending(id);
  }
}

export const toast = new ToastStore();
