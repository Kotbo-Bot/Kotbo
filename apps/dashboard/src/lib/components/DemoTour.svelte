<!--
  Visites guidées de la démo, pilotées par `demoTour` (demo/tour.svelte.ts).

  Même principe que `GuideSpotlight` : attendre que la page rende l'élément
  visé, le faire défiler, l'entourer et poser une bulle à côté. Le voile capte
  les clics hors de l'élément pour que la visite ne se perde pas en route ;
  l'élément, lui, reste cliquable : le visiteur peut essayer ce qu'on lui montre.

  Élément introuvable : dans la visite principale, la bulle s'affiche au centre
  et la visite continue ; dans une visite de page, l'étape est sautée (une page
  sans données n'a pas à montrer un tableau vide).
-->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { router } from 'tinro';
  import { demoTour } from '../demo/tour.svelte';
  import { DEMO_MODE, appPathname } from '../demo/mode';
  import { m } from '../i18n';
  import Button from './ui/Button.svelte';

  /** Visite principale : délai avant d'afficher la bulle au centre. La recherche continue ensuite. */
  const MAIN_TIMEOUT_MS = 2_500;
  /** Visite de page : délai avant de sauter l'étape. */
  const PAGE_TIMEOUT_MS = 1_500;
  /** Barre du haut fixe : un élément calé en haut d'écran ne doit pas passer dessous. */
  const TOP_OFFSET = 88;
  const PADDING = 6;
  const GAP = 12;
  const MARGIN = 16;

  type Rect = { top: number; left: number; width: number; height: number };

  let element = $state<HTMLElement | null>(null);
  let rect = $state<Rect | null>(null);
  let gaveUp = $state(false);
  let bubble = $state<HTMLDivElement | null>(null);
  let bubbleHeight = $state(0);
  let viewport = $state({ width: 0, height: 0 });

  let frame = 0;
  let searchingSince = 0;
  /** Le visiteur est arrivé sur la page de l'étape : la quitter ensuite arrête une visite de page. */
  let arrived = false;

  /** Visible à l'écran, pas seulement présent : une barre latérale repliée hors champ ne compte pas. */
  function isShown(candidate: HTMLElement): boolean {
    const box = candidate.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.right > 0 && box.left < window.innerWidth;
  }

  function locate(selector: string): HTMLElement | null {
    for (const candidate of document.querySelectorAll<HTMLElement>(selector)) {
      if (isShown(candidate)) return candidate;
    }
    return null;
  }

  function reveal(target: HTMLElement) {
    const box = target.getBoundingClientRect();
    const room = window.innerHeight - TOP_OFFSET;
    // Un élément plus haut que l'écran se cale en haut, sinon on le centre.
    const offset = box.height > room * 0.7 ? TOP_OFFSET : TOP_OFFSET + (room - box.height) / 2;
    window.scrollTo({
      top: Math.max(0, window.scrollY + box.top - offset),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    element = null;
    rect = null;
    gaveUp = false;
    arrived = false;
    searchingSince = Date.now();
  }

  function loop() {
    const step = demoTour.step;
    if (!step) return reset();

    viewport = { width: window.innerWidth, height: window.innerHeight };
    const onStepPage = demoTour.isOnStepPage(appPathname());
    if (onStepPage) {
      arrived = true;
    } else if (arrived && demoTour.kind === 'page') {
      // Parti ailleurs en pleine visite de page : elle n'a plus rien à montrer.
      demoTour.stop();
      return reset();
    }

    if (!element || !element.isConnected || !isShown(element)) {
      const found = onStepPage ? locate(step.target) : null;
      if (found) {
        element = found;
        gaveUp = false;
        reveal(found);
      } else {
        element = null;
        rect = null;
        const waited = Date.now() - searchingSince;
        if (demoTour.kind === 'page' && waited > PAGE_TIMEOUT_MS) {
          demoTour.skipMissing();
          return;
        }
        if (waited > MAIN_TIMEOUT_MS) gaveUp = true;
      }
    }

    if (element) {
      const box = element.getBoundingClientRect();
      rect = {
        top: box.top - PADDING,
        left: box.left - PADDING,
        width: box.width + PADDING * 2,
        height: box.height + PADDING * 2,
      };
    }

    frame = requestAnimationFrame(loop);
  }

  const stepKey = $derived(demoTour.active ? `${demoTour.kind}:${demoTour.path}:${demoTour.index}` : null);

  $effect(() => {
    // Une nouvelle étape repart de zéro : nouvel élément, nouveau délai.
    const key = stepKey;
    reset();
    if (key) {
      frame = requestAnimationFrame(loop);
      void tick().then(() => bubble?.focus({ preventScroll: true }));
    }
    return () => cancelAnimationFrame(frame);
  });

  // Première ouverture : la visite principale. Ensuite, chaque arrivée sur une
  // page qui a sa visite la lance, une fois.
  // `untrack` : seule la navigation relance cet effet. Suivre l'état de la
  // visite relancerait la visite de page à la seconde où une autre se termine.
  let started = false;
  $effect(() => {
    void $router.path;
    untrack(() => {
      if (!started) {
        started = true;
        demoTour.startIfNew();
      }
      demoTour.onPageVisit(appPathname());
    });
  });

  onDestroy(() => cancelAnimationFrame(frame));

  function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  }

  function onKeydown(event: KeyboardEvent) {
    if (!demoTour.active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      demoTour.stop();
    } else if (!isEditable(event.target) && event.key === 'ArrowRight') {
      event.preventDefault();
      demoTour.next();
    } else if (!isEditable(event.target) && event.key === 'ArrowLeft') {
      event.preventDefault();
      demoTour.previous();
    }
  }

  const progress = $derived(
    demoTour.kind === 'page'
      ? m.demo_page_progress({ current: demoTour.index + 1, total: demoTour.total })
      : m.demo_tour_progress({ current: demoTour.index + 1, total: demoTour.total }),
  );

  const nextLabel = $derived.by(() => {
    if (!demoTour.isLast) return m.demo_tour_next();
    if (demoTour.kind === 'main') return m.demo_tour_finish();
    return demoTour.resumesMain ? m.demo_page_resume() : m.demo_page_done();
  });

  const bubbleWidth = $derived(Math.min(340, viewport.width - MARGIN * 2));

  const bubblePosition = $derived.by(() => {
    const centered = {
      top: Math.max(MARGIN, (viewport.height - bubbleHeight) / 2),
      left: (viewport.width - bubbleWidth) / 2,
    };
    if (!rect) return centered;

    const clampLeft = (left: number) => Math.min(Math.max(MARGIN, left), viewport.width - bubbleWidth - MARGIN);
    const clampTop = (top: number) => Math.min(Math.max(MARGIN, top), viewport.height - bubbleHeight - MARGIN);

    const below = rect.top + rect.height + GAP;
    if (below + bubbleHeight <= viewport.height - MARGIN) return { top: below, left: clampLeft(rect.left) };

    const above = rect.top - GAP - bubbleHeight;
    if (above >= MARGIN) return { top: above, left: clampLeft(rect.left) };

    // Élément haut et étroit : la bulle se met à côté.
    const right = rect.left + rect.width + GAP;
    if (right + bubbleWidth <= viewport.width - MARGIN) return { top: clampTop(Math.max(rect.top, MARGIN)), left: right };

    const left = rect.left - GAP - bubbleWidth;
    if (left >= MARGIN) return { top: clampTop(Math.max(rect.top, MARGIN)), left };

    // Élément plus grand que l'écran : la bulle se pose en bas, par-dessus.
    return { top: viewport.height - bubbleHeight - MARGIN, left: clampLeft(rect.left) };
  });

  /** Quatre bandes autour de l'élément : le voile bloque les clics partout sauf sur lui. */
  const veil = $derived.by(() => {
    if (!rect) return null;
    const top = Math.max(0, rect.top);
    const bottom = Math.max(top, Math.min(viewport.height, rect.top + rect.height));
    const left = Math.max(0, rect.left);
    const right = Math.max(left, Math.min(viewport.width, rect.left + rect.width));
    return { top, bottom, left, right };
  });

  const showBubble = $derived(demoTour.active && (rect !== null || gaveUp));
</script>

<svelte:window onkeydown={onKeydown} />

{#if DEMO_MODE && demoTour.active && demoTour.step}
  {#if veil}
    <div class="tour-veil" style="top: 0; left: 0; right: 0; height: {veil.top}px;" aria-hidden="true"></div>
    <div class="tour-veil" style="top: {veil.bottom}px; left: 0; right: 0; bottom: 0;" aria-hidden="true"></div>
    <div class="tour-veil" style="top: {veil.top}px; left: 0; width: {veil.left}px; height: {veil.bottom - veil.top}px;" aria-hidden="true"></div>
    <div class="tour-veil" style="top: {veil.top}px; left: {veil.right}px; right: 0; height: {veil.bottom - veil.top}px;" aria-hidden="true"></div>
  {:else}
    <div class="tour-veil" style="inset: 0;" aria-hidden="true" transition:fade={{ duration: 150 }}></div>
  {/if}

  {#if rect}
    <div
      class="tour-ring"
      style="top: {rect.top}px; left: {rect.left}px; width: {rect.width}px; height: {rect.height}px;"
      aria-hidden="true"
    ></div>
  {/if}

  {#if showBubble}
    <div
      bind:this={bubble}
      bind:offsetHeight={bubbleHeight}
      class="tour-bubble"
      style="top: {bubblePosition.top}px; left: {bubblePosition.left}px; width: {bubbleWidth}px;"
      role="dialog"
      aria-modal="false"
      aria-labelledby="demo-tour-title"
      aria-describedby="demo-tour-body"
      tabindex="-1"
    >
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs font-medium text-primary">{progress}</p>
        <button
          type="button"
          class="text-xs text-on-surface-variant hover:text-on-surface underline-offset-2 hover:underline cursor-pointer"
          onclick={() => demoTour.skip()}
        >
          {demoTour.resumesMain ? m.demo_page_skip_detail() : m.demo_tour_skip()}
        </button>
      </div>

      <div class="mt-2 flex gap-1" aria-hidden="true">
        {#each { length: demoTour.total } as _, i}
          <span class="h-1 flex-1 rounded-full {i <= demoTour.index ? 'bg-primary' : 'bg-outline-variant'}"></span>
        {/each}
      </div>

      <p id="demo-tour-title" class="mt-3 text-sm font-semibold text-on-surface">{demoTour.step.title()}</p>
      <p id="demo-tour-body" class="mt-1 text-sm text-on-surface-variant leading-relaxed">{demoTour.step.body()}</p>

      <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
        {#if demoTour.canDetail}
          <Button size="sm" variant="secondary" onclick={() => demoTour.detail()}>{m.demo_tour_detail()}</Button>
        {/if}
        <div class="ml-auto flex items-center gap-2">
          {#if demoTour.index > 0}
            <Button size="sm" variant="ghost" onclick={() => demoTour.previous()}>{m.demo_tour_previous()}</Button>
          {/if}
          <Button size="sm" variant="primary" onclick={() => demoTour.next()}>{nextLabel}</Button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .tour-veil {
    position: fixed;
    z-index: 9995;
    background: rgb(0 0 0 / 0.55);
  }

  .tour-ring {
    position: fixed;
    z-index: 9996;
    border-radius: 1rem;
    corner-shape: superellipse(1.3);
    border: 2px solid var(--color-primary);
    pointer-events: none;
    transition: top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease;
  }

  .tour-bubble {
    position: fixed;
    z-index: 9997;
    padding: 1rem 1.125rem;
    border-radius: var(--radius-card);
    corner-shape: superellipse(1.3);
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
    box-shadow: var(--shadow-float);
    outline: none;
    transition: top 0.2s ease, left 0.2s ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .tour-ring,
    .tour-bubble {
      transition: none;
    }
  }
</style>
