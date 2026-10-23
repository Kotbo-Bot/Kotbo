<script lang="ts">
  /** Aide d'un champ : s'ouvre au survol, au clavier et au toucher (mobile). */
  import Papicon from '../Papicon.svelte';

  const { text }: { text: string } = $props();

  let button = $state<HTMLButtonElement>();
  let pinned = $state(false);
  let hovered = $state(false);
  let position = $state({ top: 0, left: 0 });
  const open = $derived(pinned || hovered);
  const id = $props.id();

  const WIDTH = 256;
  const MARGIN = 8;

  function place() {
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const left = Math.min(Math.max(MARGIN, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - MARGIN);
    position = { top: rect.bottom + 6, left };
  }

  function show() {
    place();
    hovered = true;
  }

  function toggle(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    place();
    pinned = !pinned;
  }

  function onWindowPointer(event: PointerEvent) {
    if (pinned && button && !button.contains(event.target as Node)) pinned = false;
  }
</script>

<svelte:window
  onpointerdown={onWindowPointer}
  onkeydown={(event) => { if (event.key === 'Escape') { pinned = false; hovered = false; } }}
  onscroll={() => { if (open) place(); }}
  onresize={() => { if (open) place(); }}
/>

<button
  bind:this={button}
  type="button"
  class="inline-flex items-center justify-center rounded-full text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
  aria-label={text}
  aria-expanded={open}
  aria-describedby={open ? id : undefined}
  onclick={toggle}
  onmouseenter={show}
  onmouseleave={() => { hovered = false; }}
  onfocus={show}
  onblur={() => { hovered = false; }}
>
  <Papicon icon="info" size={12} />
</button>

{#if open}
  <span
    {id}
    role="tooltip"
    class="fixed z-50 rounded-lg border border-outline-variant bg-surface-container-highest px-3 py-2 text-2xs font-normal leading-relaxed text-on-surface shadow-lg"
    style="top: {position.top}px; left: {position.left}px; width: min({WIDTH}px, calc(100vw - {MARGIN * 2}px));"
  >{text}</span>
{/if}
