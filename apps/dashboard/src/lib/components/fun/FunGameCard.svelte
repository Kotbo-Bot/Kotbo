<!--
  Carte d'un salon fun : en-tête (icône, nom, statut), choix du salon, puis
  l'état de la partie ou la règle appliquée.

  Sans salon, la carte s'efface (bordure pointillée, icône atténuée) et dit
  quoi faire : l'œil va d'abord aux jeux qui tournent.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { m } from '../../i18n';
  import type { FunGame } from '../../funGames';
  import Papicon from '../Papicon.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import Field from '../ui/Field.svelte';

  let {
    game,
    title,
    subtitle,
    rule = '',
    channelId = $bindable(null),
    channels,
    canManage,
    children,
    actions,
  }: {
    game: FunGame;
    title: string;
    subtitle: string;
    /** Règle appliquée au salon, affichée en pied de carte. */
    rule?: string;
    channelId: string | null;
    channels: { id: string; name: string }[];
    canManage: boolean;
    /** État de la partie, montré seulement quand le salon est choisi et que le jeu en garde un. */
    children?: Snippet;
    /** Actions sur la partie (relancer), pour les jeux à score. */
    actions?: Snippet;
  } = $props();

  const active = $derived(!!channelId);
</script>

<section
  class="flex flex-col gap-5 rounded-xl p-6 transition-colors duration-200 {active
    ? 'bg-surface-container-low/40 border border-outline-variant/30'
    : 'bg-surface-container-low/20 border border-dashed border-outline-variant/40'}"
>
  <header class="flex items-start gap-3">
    <div class="h-10 w-10 shrink-0 rounded-xl flex items-center justify-center transition-opacity {game.tone} {active ? '' : 'opacity-50'}">
      <Papicon icon={game.icon} size={20} />
    </div>
    <div class="min-w-0 flex-1">
      <h3 class="text-base font-semibold tracking-tight text-on-surface">{title}</h3>
      <p class="text-xs text-on-surface-variant">{subtitle}</p>
    </div>
    <span
      class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-semibold {active
        ? 'bg-success/10 text-success'
        : 'bg-surface-container-high text-on-surface-variant'}"
    >
      <span class="h-1.5 w-1.5 rounded-full {active ? 'bg-success' : 'bg-on-surface-variant/40'}" aria-hidden="true"></span>
      {active ? m.fun_status_active() : m.fun_status_inactive()}
    </span>
  </header>

  <Field label={m.fun_channel_label()}>
    {#snippet children(id)}
      <SearchableSelect
        {id}
        bind:value={channelId}
        options={channels}
        placeholder={m.fun_no_channel()}
        disabled={!canManage}
      />
    {/snippet}
  </Field>

  {#if active && game.tracked && children}
    <div class="rounded-lg bg-surface-container-high/30 p-4">
      {@render children()}
    </div>
  {/if}

  {#if rule}
    <p class="flex items-start gap-2 text-xs text-on-surface-variant">
      <Papicon icon="info" size={14} class="mt-0.5 shrink-0" />
      <span>{rule}</span>
    </p>
  {:else if !active}
    <p class="text-xs text-on-surface-variant">{m.fun_inactive_hint()}</p>
  {/if}

  {#if active && game.group === 'score' && actions}
    <div class="mt-auto flex flex-wrap gap-2">
      {@render actions()}
    </div>
  {/if}
</section>
