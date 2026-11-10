/**
 * Comportement clavier d'une fenetre modale (RGAA 7.1, 12.8) : le focus entre
 * dans la fenetre a l'ouverture, Tab et Maj+Tab y restent, Echap la ferme, et
 * le focus revient sur le declencheur a la fermeture.
 *
 * A poser sur le panneau, qui doit porter `tabindex="-1"` : c'est lui qui recoit
 * le focus, pas le premier champ - sur telephone, focaliser un champ ferait
 * monter le clavier avant que l'utilisateur ne le demande. Un element marque
 * `data-autofocus` le recoit a la place (un bouton, qui ne fait pas monter le
 * clavier).
 */
export type DialogFocusOptions = {
  onEscape?: () => void;
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusables(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}

/**
 * Seule la fenetre du dessus reagit : une confirmation ouverte par-dessus ne
 * prend pas toujours le focus, et Echap fermait alors la fenetre du dessous.
 * Les fenetres sont portees dans body, la plus recente en dernier.
 */
function isTopmost(node: HTMLElement): boolean {
  const modals = document.querySelectorAll('[aria-modal="true"]');
  return modals[modals.length - 1] === node;
}

export function dialogFocus(node: HTMLElement, options: DialogFocusOptions) {
  let onEscape = options.onEscape;
  const previouslyFocused = document.activeElement as HTMLElement | null;

  // Une image plus tard : un `autofocus` du contenu passe d'abord et l'emporte.
  const frame = requestAnimationFrame(() => {
    if (node.contains(document.activeElement)) return;
    const target = node.querySelector<HTMLElement>('[data-autofocus]') ?? node;
    target.focus({ preventScroll: true });
  });

  function onKeyDown(event: KeyboardEvent) {
    if (!isTopmost(node)) return;

    if (event.key === 'Escape') {
      if (!onEscape || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }

    if (event.key !== 'Tab') return;
    const list = focusables(node);
    if (list.length === 0) {
      event.preventDefault();
      return;
    }

    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  node.addEventListener('keydown', onKeyDown);

  return {
    update(next: DialogFocusOptions) {
      onEscape = next.onEscape;
    },
    destroy() {
      cancelAnimationFrame(frame);
      node.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    },
  };
}
