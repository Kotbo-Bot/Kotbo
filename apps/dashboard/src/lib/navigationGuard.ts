/**
 * Garde de navigation du bureau : tout lien interne (barre latérale, fil
 * d'Ariane) et toute navigation de la palette passent par ici plutôt que par
 * router.goto, pour qu'une page « sale » demande confirmation avant de partir.
 * Le mobile a sa propre garde (MobileTabBar, MobileNavSheet).
 */
import { router } from 'tinro';
import { m } from './i18n';
import { confirmDialog } from './stores/confirmDialog.svelte';
import { unsavedChanges } from './stores/unsavedChanges.svelte';

/** router.goto, précédé d'une confirmation s'il reste des modifications non enregistrées. */
export async function guardedNavigate(href: string): Promise<void> {
  if (unsavedChanges.canNavigate()) {
    router.goto(href);
    return;
  }
  const confirmed = await confirmDialog.ask({
    title: m.banner_unsaved_title(),
    description: m.banner_unsaved_desc({ page: unsavedChanges.pageLabel }),
    confirmLabel: m.banner_unsaved_leave(),
    variant: 'warning',
  });
  if (!confirmed) return;
  unsavedChanges.clear();
  router.goto(href);
}

/**
 * Clic sur un lien interne du bureau. Clic milieu et Ctrl/Cmd+clic restent au
 * navigateur (nouvel onglet) ; sans modification en attente, tinro navigue. Sinon
 * le clic passe par guardedNavigate et s'arrête avant tinro, qui écoute window
 * sans regarder defaultPrevented : d'où stopPropagation en plus.
 */
export function guardedLinkClick(event: MouseEvent, href: string): void {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
  ) {
    return;
  }
  if (unsavedChanges.canNavigate()) return;
  event.preventDefault();
  event.stopPropagation();
  void guardedNavigate(href);
}
