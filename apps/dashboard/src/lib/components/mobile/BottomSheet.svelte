<script lang="ts">
  import type { Snippet } from 'svelte';
  import { portal } from '../../actions/portal';
  import { scrollLock } from '../../scrollLock';
  import { prefersReducedMotion } from '../../stores/media.svelte';
  import Papicon from '../Papicon.svelte';

  type Props = {
    open: boolean;
    title: string;
    /** Rendered under the title in smaller, quieter type. */
    subtitle?: string;
    /** Fraction of the viewport the sheet may occupy. */
    maxHeight?: string;
    onclose: () => void;
    header?: Snippet;
    children: Snippet;
    footer?: Snippet;
  };

  const {
    open,
    title,
    subtitle,
    maxHeight = '88dvh',
    onclose,
    header,
    children,
    footer,
  }: Props = $props();

  /** Past this many pixels of downward drag, releasing dismisses the sheet. */
  const DISMISS_DISTANCE = 110;
  /** A fast flick dismisses even when the drag was short. */
  const DISMISS_VELOCITY = 0.6;

  let panel = $state<HTMLElement | null>(null);
  let body = $state<HTMLElement | null>(null);
  let dragOffset = $state(0);
  let dragging = $state(false);

  let pointerId: number | null = null;
  let startY = 0;
  let startTime = 0;
  let previouslyFocused: HTMLElement | null = null;

  $effect(() => {
    if (!open) return;

    previouslyFocused = document.activeElement as HTMLElement | null;
    dragOffset = 0;

    // Focus the panel itself rather than the first control: on a phone, focusing
    // an input here would raise the keyboard over the sheet before the user asks.
    const frame = requestAnimationFrame(() => panel?.focus({ preventScroll: true }));

    return () => {
      cancelAnimationFrame(frame);
      previouslyFocused?.focus?.({ preventScroll: true });
      previouslyFocused = null;
    };
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }

    if (event.key !== 'Tab' || !panel) return;

    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse') return;
    // Dragging from inside the scrollable area is only a dismissal when the
    // content is already at the top; otherwise the gesture belongs to the list.
    const fromBody = body?.contains(event.target as Node) ?? false;
    if (fromBody && (body?.scrollTop ?? 0) > 0) return;

    pointerId = event.pointerId;
    startY = event.clientY;
    startTime = event.timeStamp;
    dragging = true;
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging || event.pointerId !== pointerId) return;

    const delta = event.clientY - startY;
    if (delta <= 0) {
      dragOffset = 0;
      return;
    }

    // Claim the gesture only once it is clearly a downward drag.
    if (delta > 6 && event.cancelable) event.preventDefault();
    dragOffset = delta;
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging || event.pointerId !== pointerId) return;

    const elapsed = Math.max(event.timeStamp - startTime, 1);
    const velocity = dragOffset / elapsed;

    dragging = false;
    pointerId = null;

    if (dragOffset > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY) {
      onclose();
    } else {
      dragOffset = 0;
    }
  }
</script>

{#if open}
  <div
    use:portal
    use:scrollLock
    class="sheet"
    class:sheet--static={$prefersReducedMotion}
    onkeydown={onKeyDown}
    role="presentation"
  >
    <button
      type="button"
      class="sheet__scrim"
      style:opacity={dragging ? Math.max(0.15, 1 - dragOffset / 320) : undefined}
      aria-label="Fermer"
      onclick={onclose}
    ></button>

    <div
      bind:this={panel}
      class="sheet__panel"
      class:sheet__panel--dragging={dragging}
      style:transform={dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined}
      style:--sheet-max-height={maxHeight}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    >
      <div class="sheet__grabber" aria-hidden="true"></div>

      <header class="sheet__header">
        <div class="sheet__heading">
          <h2 class="sheet__title">{title}</h2>
          {#if subtitle}
            <p class="sheet__subtitle">{subtitle}</p>
          {/if}
        </div>

        {#if header}
          {@render header()}
        {/if}

        <button type="button" class="sheet__close" onclick={onclose} aria-label="Fermer">
          <Papicon icon="x" size={18} />
        </button>
      </header>

      <div bind:this={body} class="sheet__body">
        {@render children()}
      </div>

      {#if footer}
        <footer class="sheet__footer">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sheet {
    position: fixed;
    z-index: 90;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    inset: 0;
  }

  .sheet__scrim {
    position: absolute;
    border: 0;
    background: rgb(0 0 0 / 0.45);
    inset: 0;
    animation: sheet-scrim-in 180ms ease-out;
  }

  .sheet__panel {
    position: relative;
    display: flex;
    width: 100%;
    max-width: 34rem;
    max-height: var(--sheet-max-height, 88dvh);
    flex-direction: column;
    border: 1px solid var(--outline-variant);
    border-bottom: 0;
    border-radius: 1.5rem 1.5rem 0 0;
    background: var(--surface-container-lowest);
    box-shadow: 0 -18px 60px rgb(0 0 0 / 0.32);
    touch-action: none;
    animation: sheet-panel-in 260ms cubic-bezier(0.22, 1, 0.36, 1);
    padding-bottom: env(safe-area-inset-bottom);
  }

  .sheet__panel:focus-visible {
    outline: none;
  }

  /* No transition while the finger is down, so the panel tracks it exactly. */
  .sheet__panel:not(.sheet__panel--dragging) {
    transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .sheet__grabber {
    width: 2.25rem;
    height: 0.25rem;
    margin: 0.625rem auto 0;
    flex: none;
    border-radius: 999px;
    background: var(--outline-variant);
  }

  .sheet__header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem 0.75rem 1.125rem;
  }

  .sheet__heading {
    min-width: 0;
    flex: 1 1 auto;
  }

  .sheet__title {
    overflow: hidden;
    color: var(--on-surface);
    font-family: var(--font-headline);
    font-size: 1.0625rem;
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sheet__subtitle {
    margin-top: 0.125rem;
    overflow: hidden;
    color: var(--on-surface-variant);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sheet__close {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    flex: none;
    place-items: center;
    border-radius: 999px;
    color: var(--on-surface-variant);
    transition: background-color 150ms ease;
  }

  .sheet__close:hover {
    background: var(--surface-container);
    color: var(--on-surface);
  }

  .sheet__body {
    min-height: 0;
    flex: 1 1 auto;
    padding: 0 1rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* Vertical panning belongs to this list, not to the dismissal gesture. */
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
  }

  .sheet__footer {
    flex: none;
    padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
    border-top: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
  }

  @keyframes sheet-scrim-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes sheet-panel-in {
    from { transform: translate3d(0, 100%, 0); }
    to { transform: translate3d(0, 0, 0); }
  }

  .sheet--static .sheet__scrim,
  .sheet--static .sheet__panel {
    animation: none;
  }

  .sheet--static .sheet__panel {
    transition: none;
  }
</style>
