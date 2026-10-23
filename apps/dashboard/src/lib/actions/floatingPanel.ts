import { portal } from './portal';

export interface FloatingPanelOptions {
  /** Élément dont le panneau suit la position. */
  anchor: HTMLElement | null;
  /** Côté privilégié ; l'autre est pris quand la place manque. */
  placement?: 'top' | 'bottom';
  /** Bord de l'ancre sur lequel le panneau s'aligne horizontalement. */
  align?: 'start' | 'end';
  gap?: number;
  margin?: number;
}

/**
 * Sort un panneau flottant dans <body> et le place à la main sous (ou sur) son
 * ancre. Laissé dans le flux, il se faisait rogner par le moindre parent en
 * `overflow-hidden` et sortait de l'écran dès que l'ancre était près d'un bord ;
 * un simple `position: fixed` ne suffit pas non plus, une ancêtre animée en
 * `transform` redevenant son bloc conteneur.
 */
export function floatingPanel(node: HTMLElement, options: FloatingPanelOptions) {
  let current = options;
  const portalled = portal(node);
  // Plan des popovers : au-dessus des modales, d'où ces panneaux s'ouvrent souvent.
  node.classList.add('app-popover');

  function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function place() {
    const anchor = current.anchor;
    if (!anchor) return;
    const gap = current.gap ?? 8;
    const margin = current.margin ?? 8;
    const rect = anchor.getBoundingClientRect();

    node.style.position = 'fixed';
    node.style.maxHeight = `${window.innerHeight - margin * 2}px`;

    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const roomAbove = rect.top - gap - margin;
    const roomBelow = window.innerHeight - rect.bottom - gap - margin;
    const preferTop = (current.placement ?? 'bottom') === 'top';
    const onTop = preferTop
      ? roomAbove >= height || roomAbove >= roomBelow
      : roomBelow < height && roomAbove > roomBelow;

    const top = onTop ? rect.top - gap - height : rect.bottom + gap;
    const left = current.align === 'start' ? rect.left : rect.right - width;

    node.style.top = `${clamp(top, margin, window.innerHeight - margin - height)}px`;
    node.style.left = `${clamp(left, margin, window.innerWidth - margin - width)}px`;
  }

  place();
  // Le contenu change de hauteur avec l'onglet actif : replacer au montage seul
  // laisserait le panneau déborder après coup.
  const observer = new ResizeObserver(place);
  observer.observe(node);
  // `capture` : le défilement d'un conteneur interne ne remonte pas jusqu'à window.
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  return {
    update(next: FloatingPanelOptions) {
      current = next;
      place();
    },
    destroy() {
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      portalled.destroy();
    },
  };
}
