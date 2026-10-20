<!--
  Coque des fiches détaillées (salon, catégorie, invitation) : la même que la
  fiche membre. En-tête avec icône, titre et actions, onglets collés en haut au
  défilement, corps sur toute la hauteur de l'écran.

  Les classes `sheet-kpis` (bandeau de chiffres) et `sheet-facts` (liste
  libellé / valeur) sont posées ici pour que les fiches les partagent.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Modal from './Modal.svelte';
  import Papicon from './Papicon.svelte';
  import { Tabs, type TabItem } from './ui';

  const {
    open,
    onClose,
    icon,
    title,
    subtitle = '',
    badges,
    actions,
    tabs = [],
    active = '',
    onchange = () => {},
    tabsLabel = '',
    children,
  }: {
    open: boolean;
    onClose: () => void;
    icon: string;
    title: string;
    subtitle?: string;
    badges?: Snippet;
    actions?: Snippet;
    tabs?: TabItem[];
    active?: string;
    onchange?: (id: string) => void;
    tabsLabel?: string;
    children: Snippet;
  } = $props();
</script>

<Modal {open} {onClose} size="screen" showCloseButton={false}>
  <div class="sheet" role="presentation" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <header class="sheet-header">
      <span class="sheet-icon"><Papicon {icon} size={24} /></span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="modal-title" class="truncate text-xl font-semibold tracking-tight text-on-surface">{title}</h2>
          {@render badges?.()}
        </div>
        {#if subtitle}<p class="mt-0.5 truncate text-sm text-on-surface-variant">{subtitle}</p>{/if}
      </div>
      <div class="sheet-actions">{@render actions?.()}</div>
    </header>

    {#if tabs.length > 0}
      <div class="sheet-tabs">
        <Tabs label={tabsLabel || title} class="max-w-full" {tabs} {active} {onchange} />
      </div>
    {/if}

    <div class="sheet-body">{@render children()}</div>
  </div>
</Modal>

<style>
  .sheet {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    background: var(--surface);
  }
  .sheet-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    padding: 1.25rem 1.5rem;
    background: var(--surface-container-lowest);
    border-bottom: 1px solid var(--outline-variant);
  }
  .sheet-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.5rem;
    height: 3.5rem;
    flex-shrink: 0;
    border-radius: 0.75rem;
    color: var(--primary-color);
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
  }
  .sheet-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }
  .sheet-tabs {
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 0.75rem 1.5rem;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--outline-variant);
  }
  .sheet-body {
    padding: 1.25rem 1.5rem 1.5rem;
  }
  @media (max-width: 640px) {
    .sheet-header, .sheet-tabs, .sheet-body {
      padding-left: 1rem;
      padding-right: 1rem;
    }
    .sheet-actions {
      margin-left: 0;
      width: 100%;
    }
  }

  /* Bandeau de chiffres séparés par un filet, comme la fiche membre. */
  .sheet :global(.sheet-kpis) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem 1.5rem;
  }
  @media (min-width: 900px) {
    .sheet :global(.sheet-kpis) { grid-template-columns: repeat(var(--kpis, 4), minmax(0, 1fr)); }
    .sheet :global(.sheet-kpis > div + div) {
      border-left: 1px solid var(--outline-variant);
      padding-left: 1.25rem;
    }
  }
  .sheet :global(.sheet-kpis dt) {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--on-surface-variant);
  }
  .sheet :global(.sheet-kpis dd) {
    margin-top: 0.125rem;
    font-size: 1.375rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--on-surface);
    font-variant-numeric: tabular-nums;
  }
  .sheet :global(.sheet-kpis span) {
    display: block;
    font-size: 0.75rem;
    color: var(--on-surface-variant);
  }

  .sheet :global(.sheet-facts) {
    display: flex;
    flex-direction: column;
  }
  .sheet :global(.sheet-facts > div) {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-top: 1px solid color-mix(in srgb, var(--outline-variant) 60%, transparent);
  }
  .sheet :global(.sheet-facts > div:first-child) {
    border-top: none;
    padding-top: 0;
  }
  .sheet :global(.sheet-facts dt) {
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
  }
  .sheet :global(.sheet-facts dd) {
    min-width: 0;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--on-surface);
    text-align: right;
    overflow-wrap: anywhere;
  }

  /* Ligne de classement cliquable : nom, valeur, barre de part. */
  .sheet :global(.sheet-row) {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1.25rem;
    text-align: left;
  }
  .sheet :global(button.sheet-row:hover) { background: var(--surface-container-low); }
  .sheet :global(.sheet-bar) {
    display: block;
    height: 0.375rem;
    margin-top: 0.375rem;
    border-radius: 9999px;
    background: var(--surface-container-high);
    overflow: hidden;
  }
  .sheet :global(.sheet-bar > span) {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--primary-color);
  }
</style>
