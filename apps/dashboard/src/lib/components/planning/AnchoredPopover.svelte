<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { portal } from '../../actions/portal';

  /**
   * Bulle accrochee a un element, comme l'apercu d'un evenement dans Outlook :
   * a droite de l'ancre s'il y a la place, sinon a gauche ; en bas d'ecran sur
   * telephone. Echap ou un clic ailleurs la ferme.
   */
  const {
    anchor,
    onClose,
    label,
    width = 360,
    children,
  }: {
    /** Rectangle de l'element vise ; null ferme la bulle. */
    anchor: DOMRect | null;
    onClose: () => void;
    /** Nom accessible de la bulle. */
    label: string;
    width?: number;
    children: Snippet;
  } = $props();

  const GUTTER = 8;
  let panel = $state<HTMLDivElement | null>(null);
  let position = $state({ top: -9999, left: -9999 });

  function place() {
    if (!anchor || !panel) return;
    const w = Math.min(width, window.innerWidth - 2 * GUTTER);
    const h = panel.offsetHeight;
    if (window.innerWidth < 640) {
      position = { top: window.innerHeight - h - GUTTER, left: GUTTER };
      return;
    }
    let left = anchor.right + GUTTER;
    if (left + w > window.innerWidth - GUTTER) left = anchor.left - GUTTER - w;
    if (left < GUTTER) left = Math.min(Math.max(GUTTER, anchor.left), window.innerWidth - w - GUTTER);
    const top = Math.min(anchor.top, window.innerHeight - h - GUTTER);
    position = { top: Math.max(GUTTER, top), left };
  }

  $effect(() => {
    if (!anchor) return;
    void tick().then(() => {
      place();
      // Le premier champ de saisie d'abord : on tape le titre sans cliquer.
      (panel?.querySelector<HTMLElement>('input:not([type="checkbox"]), textarea') ?? panel?.querySelector<HTMLElement>('button'))?.focus();
    });

    const onPointerDown = (event: PointerEvent) => {
      if (panel && !panel.contains(event.target as Node)) onClose();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Le clic qui ouvre la bulle ne doit pas la refermer aussitot.
    const timer = setTimeout(() => window.addEventListener('pointerdown', onPointerDown, true));
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onClose);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', onClose);
    };
  });
</script>

{#if anchor}
  <div
    bind:this={panel}
    use:portal
    role="dialog"
    aria-label={label}
    class="anchored-popover fixed rounded-xl border border-outline-variant bg-surface-container-lowest shadow-xl"
    style="top: {position.top}px; left: {position.left}px; width: {width}px;"
  >
    {@render children()}
  </div>
{/if}

<style>
  .anchored-popover {
    z-index: var(--layer-popover);
    max-width: calc(100vw - 1rem);
    max-height: calc(100vh - 1rem);
    overflow-y: auto;
  }
</style>
