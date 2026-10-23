import { toast } from '../stores/toast.svelte';

/**
 * Un bouton grise dit pourquoi. Pour les boutons ecrits a la main, ce que
 * `disabledReason` fait pour le composant Button : quand une raison est
 * donnee, le bouton garde son air grise mais reste cliquable, et le clic
 * affiche la raison au lieu de ne rien faire. Un bouton grise muet, on clique
 * quand meme et on croit l'outil casse.
 *
 *   <button disabled={saving} use:explainDisabled={!salon ? 'Choisis d\'abord un salon' : ''}>
 *
 * Garder dans `disabled` ce qui n'a pas besoin d'explication (une action en
 * cours) ; la raison, elle, ne doit etre non vide que lorsque le bouton est
 * vraiment indisponible.
 */
export function explainDisabled(node: HTMLButtonElement, reason: string) {
  let current = reason;
  const originalTitle = node.getAttribute('title');

  function apply() {
    if (current) {
      node.setAttribute('aria-disabled', 'true');
      node.setAttribute('title', current);
    } else {
      node.removeAttribute('aria-disabled');
      if (originalTitle === null) node.removeAttribute('title');
      else node.setAttribute('title', originalTitle);
    }
  }

  // Phase de capture : le clic est arrete avant le gestionnaire du bouton.
  function onClick(event: MouseEvent) {
    if (!current) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast.info(current);
  }

  node.addEventListener('click', onClick, true);
  apply();

  return {
    update(next: string) {
      current = next;
      apply();
    },
    destroy() {
      node.removeEventListener('click', onClick, true);
    },
  };
}
