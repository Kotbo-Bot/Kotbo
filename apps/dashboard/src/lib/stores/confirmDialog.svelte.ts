export interface ConfirmDialogOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  requireInput?: string;
  /**
   * Ce que l'action va entrainer, une ligne par consequence : « 4 projets
   * actifs perdent leur responsable ». On valide en connaissant les effets en
   * cascade, au lieu de les decouvrir apres coup.
   */
  impacts?: string[];
}

/**
 * Service global de confirmation.
 * Remplace window.confirm() par un modal cohérent avec le design system :
 *
 *   if (!(await confirmDialog.ask({ title: 'Supprimer ?', variant: 'danger' }))) return;
 */
class ConfirmDialogStore {
  open = $state(false);
  options = $state<ConfirmDialogOptions>({});

  private resolver: ((value: boolean) => void) | null = null;

  ask(options: ConfirmDialogOptions | string): Promise<boolean> {
    // Un appel pendant qu'un dialogue est déjà ouvert annule le précédent
    this.resolver?.(false);

    this.options = typeof options === 'string' ? { title: options } : options;
    this.open = true;

    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Raccourci pour les suppressions et actions destructives. */
  danger(title: string, description = '', confirmLabel = 'Supprimer', impacts: string[] = []): Promise<boolean> {
    return this.ask({ title, description, confirmLabel, variant: 'danger', impacts });
  }

  resolve(value: boolean): void {
    this.open = false;
    this.resolver?.(value);
    this.resolver = null;
  }
}

export const confirmDialog = new ConfirmDialogStore();
