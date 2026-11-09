/**
 * Changement de page dans l'application monopage : rien ne previent un lecteur
 * d'ecran qu'une autre page s'affiche, et le focus reste sur le lien du menu.
 * Le titre de l'onglet nomme la page (RGAA 8.6) et le focus passe au contenu
 * (RGAA 12.8), sauf quand l'utilisateur agit deja dans la page (un onglet, un
 * filtre) ou dans une fenetre encore ouverte.
 */
export function pageTitle(page: string, brand: string): string {
  return page ? `${page} - ${brand}` : brand;
}

export function focusMainAfterNavigation(main: HTMLElement): void {
  const active = document.activeElement;
  if (active && active !== document.body) {
    if (main.contains(active) || active.closest('[role="dialog"]')) return;
  }
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
}
