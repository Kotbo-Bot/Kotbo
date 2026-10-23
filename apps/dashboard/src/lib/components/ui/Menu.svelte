<!--
  Menu d'actions secondaires derriere un bouton « ... ».

  Pour ce qui ne merite pas un bouton a soi sur chaque ligne : masquer,
  ignorer, retirer. La liste est teleportee dans le body et positionnee en
  fixe, pour ne pas etre coupee par une carte ou une liste qui deborde ; elle
  s'ouvre vers le haut quand la place manque en bas.
-->
<script lang="ts" module>
  export type MenuItem = {
    label: string;
    /** Precision sous le libelle : ce qui se passera, en une ligne. */
    description?: string;
    icon?: string;
    onselect: () => void;
  };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { portal } from '../../actions/portal';
  import Papicon from '../Papicon.svelte';

  const {
    items,
    /** Nom accessible du bouton : « Options pour <sujet> ». */
    label,
    icon = 'more-horizontal',
  }: { items: MenuItem[]; label: string; icon?: string } = $props();

  const MENU_WIDTH = 256;
  const GUTTER = 8;

  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLDivElement | null>(null);
  let position = $state({ top: 0, left: 0, above: false });

  function place() {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const height = menu?.offsetHeight ?? 0;
    const above = rect.bottom + GUTTER + height > window.innerHeight && rect.top - GUTTER - height > 0;
    const left = Math.min(Math.max(GUTTER, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - GUTTER);
    position = { top: above ? rect.top - GUTTER - height : rect.bottom + GUTTER, left: Math.max(GUTTER, left), above };
  }

  function menuItems(): HTMLElement[] {
    return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
  }

  async function show(focus: 'first' | 'last' | null = 'first') {
    open = true;
    place();
    await tick();
    // Deuxieme passe : la hauteur n'est connue qu'une fois la liste rendue.
    place();
    const list = menuItems();
    if (focus === 'first') list[0]?.focus();
    if (focus === 'last') list.at(-1)?.focus();
  }

  function close(restoreFocus = true) {
    if (!open) return;
    open = false;
    if (restoreFocus) trigger?.focus();
  }

  function select(item: MenuItem) {
    close();
    item.onselect();
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      void show('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      void show('last');
    }
  }

  function onMenuKeydown(event: KeyboardEvent) {
    const list = menuItems();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list.at(-1)?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close(false);
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (!open) return;
    const target = event.target as Node;
    if (menu?.contains(target) || trigger?.contains(target)) return;
    close(false);
  }
</script>

<svelte:window
  onpointerdown={onWindowPointerDown}
  onresize={() => close(false)}
  onscrollcapture={() => open && place()}
/>

<button
  bind:this={trigger}
  type="button"
  class="btn btn-ghost btn-sm btn-icon"
  aria-label={label}
  aria-haspopup="menu"
  aria-expanded={open}
  onclick={() => (open ? close() : show(null))}
  onkeydown={onTriggerKeydown}
>
  <Papicon {icon} size={15} />
</button>

{#if open}
  <div
    use:portal
    bind:this={menu}
    role="menu"
    tabindex="-1"
    aria-label={label}
    class="fixed z-[var(--layer-popover)] rounded-lg border border-outline-variant bg-surface-container-lowest shadow-lg py-1"
    style="top: {position.top}px; left: {position.left}px; width: {MENU_WIDTH}px;"
    onkeydown={onMenuKeydown}
  >
    {#each items as item (item.label)}
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        class="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-container-high focus:bg-surface-container-high focus:outline-none transition-colors"
        onclick={() => select(item)}
      >
        {#if item.icon}
          <Papicon icon={item.icon} size={15} class="mt-0.5 shrink-0 text-on-surface-variant" />
        {/if}
        <span class="min-w-0">
          <span class="block text-sm text-on-surface">{item.label}</span>
          {#if item.description}
            <span class="block text-xs text-on-surface-variant">{item.description}</span>
          {/if}
        </span>
      </button>
    {/each}
  </div>
{/if}
