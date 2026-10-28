<!--
  Classement « Top N » façon Cloudflare : une ligne par membre ou salon, avec
  une barre en fond proportionnelle au premier, la valeur, l'écart avec la
  période d'avant et une mini-courbe. Bascule en graphique à barres. « Tout
  voir » ouvre la liste complète (500 au plus) avec recherche et export.

  La carte s'adapte à sa propre largeur (requêtes de conteneur) : la
  mini-courbe puis l'écart s'effacent quand la place manque, le nom ne se
  coupe jamais au milieu d'un mot.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Callout, Modal } from '../ui';
  import Papicon from '../Papicon.svelte';
  import BarList from './BarList.svelte';
  import Sparkline from './Sparkline.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { memberAvatarSrc } from '../../discordMedia';
  import { downloadSingleSheetXlsx } from '../../xlsxExport';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import type { ActivityRankingItem, ActivityRankings } from '../../api';
  import { fmtNumber } from './analyticsFormat';

  const {
    title,
    description = '',
    icon = '',
    kind,
    load,
    reloadKey,
    format = fmtNumber,
    compare = false,
    color = 'var(--series-1)',
    onselect,
    exportName = 'classement',
    limit = 8,
    bare = false,
  }: {
    title: string;
    description?: string;
    icon?: string;
    kind: 'members' | 'channels';
    load: (limit: number) => Promise<ActivityRankings | null>;
    reloadKey: string;
    format?: (value: number) => string;
    compare?: boolean;
    color?: string;
    onselect?: (item: ActivityRankingItem) => void;
    exportName?: string;
    /** Lignes montrées avant « Tout voir ». */
    limit?: number;
    /** Sans cadre ni fond : la carte est posée dans un bloc qui en a déjà un. */
    bare?: boolean;
  } = $props();

  const FULL = 500;
  const PAGE = 50;

  let data = $state<ActivityRankings | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestKey = '';

  $effect(() => {
    const key = reloadKey;
    untrack(() => {
      requestKey = key;
      loading = true;
      error = '';
      load(limit)
        .then((res) => {
          if (requestKey === key) data = res;
        })
        .catch((e) => {
          if (requestKey === key) error = errorMessage(e) || m.an_error_generic();
        })
        .finally(() => {
          if (requestKey === key) loading = false;
        });
    });
  });

  let mode = $state<'table' | 'chart'>('table');

  // ── Liste complète ─────────────────────────────────────────────────────────
  let fullOpen = $state(false);
  let full = $state<ActivityRankings | null>(null);
  let fullKey = '';
  let fullLoading = $state(false);
  let search = $state('');
  let page = $state(1);

  function openFull() {
    fullOpen = true;
    search = '';
    page = 1;
    if (fullKey === reloadKey && full) return;
    const key = reloadKey;
    fullKey = key;
    fullLoading = true;
    load(FULL)
      .then((res) => {
        if (fullKey === key) full = res;
      })
      .catch((e) => toast.error(errorMessage(e) || m.an_error_generic()))
      .finally(() => {
        if (fullKey === key) fullLoading = false;
      });
  }

  const ranked = $derived((full?.items ?? []).map((item, i) => ({ item, rank: i + 1 })));
  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return q ? ranked.filter(({ item }) => displayName(item).toLowerCase().includes(q)) : ranked;
  });
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / PAGE)));
  const visible = $derived(filtered.slice((page - 1) * PAGE, page * PAGE));

  $effect(() => {
    search;
    page = 1;
  });

  function displayName(item: ActivityRankingItem): string {
    if (kind === 'channels') return item.name ? `#${item.name}` : m.anx_channel_deleted();
    return item.name ?? m.an_member_fallback();
  }

  async function exportFull() {
    const rows = (full?.items ?? []).map((item, i) => ({
      [m.anx_top_rank()]: i + 1,
      [m.anx_top_name()]: displayName(item),
      id: item.id,
      [m.anx_top_value()]: item.value,
      [m.anx_table_previous()]: item.previous,
      [m.anx_top_share()]: item.share,
    }));
    const ok = await downloadSingleSheetXlsx(`${exportName}_${new Date().toISOString().slice(0, 10)}.xlsx`, exportName.slice(0, 31), rows);
    if (ok) toast.success(m.an_export_xlsx_done());
    else toast.error(m.an_export_no_data());
  }

  const max = $derived(Math.max(1, ...(data?.items ?? []).map((i) => i.value)));
  const barItems = $derived(
    (data?.items ?? []).map((item) => ({ id: item.id, label: displayName(item), value: item.value, display: format(item.value), raw: item })),
  );
</script>

{#snippet identity(item: ActivityRankingItem)}
  {#if kind === 'members'}
    <img class="top-avatar" src={memberAvatarSrc(item.avatarUrl, item.name, item.id)} alt="" loading="lazy" width="24" height="24" />
  {:else}
    <span class="top-hash" aria-hidden="true">#</span>
  {/if}
{/snippet}

{#snippet row(item: ActivityRankingItem, rank: number, scale: number)}
  <button
    type="button"
    class="top-row"
    style="--fill: {Math.max(1.5, (item.value / scale) * 100)}%; --row-color: {color};"
    onclick={() => onselect?.(item)}
    disabled={!onselect}
  >
    <span class="top-row__rank">{rank}</span>
    <span class="top-row__ident">
      {@render identity(item)}
      <span class="top-row__name">{displayName(item)}</span>
    </span>
    {#if item.spark.length > 1}
      <span class="top-row__spark"><Sparkline values={item.spark} {color} width={56} height={18} fill={false} /></span>
    {/if}
    <span class="top-row__value">{format(item.value)}</span>
    {#if compare}
      <span class="top-row__delta text-on-surface-variant" title={m.anx_delta_title()}>{format(item.previous)}</span>
    {/if}
  </button>
{/snippet}

<section class="top-list" class:top-list--bare={bare}>
  <header class="top-list__header">
    <div class="flex min-w-0 items-start gap-2.5">
      {#if icon}
        <span class="top-list__icon"><Papicon {icon} size={16} /></span>
      {/if}
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-on-surface">{title}</h3>
        {#if description}<p class="text-body-sm text-on-surface-variant">{description}</p>{/if}
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <div class="icon-group" role="group" aria-label={m.anx_view_label()}>
        <button type="button" class="icon-group__btn" aria-pressed={mode === 'table'} aria-label={m.anx_view_table()} title={m.anx_view_table()} onclick={() => (mode = 'table')}>
          <Papicon icon="table" size={15} />
        </button>
        <button type="button" class="icon-group__btn" aria-pressed={mode === 'chart'} aria-label={m.anx_view_bar()} title={m.anx_view_bar()} onclick={() => (mode = 'chart')}>
          <Papicon icon="bar-chart-2" size={15} />
        </button>
      </div>
    </div>
  </header>

  {#if loading && !data}
    <AnalyticsSkeleton />
  {:else if error}
    <Callout variant="danger">{error}</Callout>
  {:else if data && !data.available}
    <Callout variant="info">{m.anx_top_unavailable()}</Callout>
  {:else if data && data.items.length === 0}
    <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_top_empty()}</p>
  {:else if data}
    <div class="top-list__body" class:top-list__body--busy={loading}>
      {#if mode === 'table'}
        <div class="top-head" aria-hidden="true">
          <span class="min-w-0 flex-1">{kind === 'members' ? m.anx_top_member() : m.anx_top_channel()}</span>
          <span class="top-head__value">{m.anx_top_value()}</span>
          {#if compare}<span class="top-head__delta">{m.anx_table_previous()}</span>{/if}
        </div>
        <ol class="top-rows">
          {#each data.items as item, i (item.id)}
            <li>{@render row(item, i + 1, max)}</li>
          {/each}
        </ol>
      {:else}
        <BarList items={barItems} {color} onselect={onselect ? (b) => onselect(b.raw) : undefined}>
          {#snippet leading(b)}{@render identity(b.raw)}{/snippet}
        </BarList>
      {/if}
      <footer class="top-list__footer">
        <span class="text-body-sm text-on-surface-variant">
          {m.anx_top_total({ value: format(data.total) })}
          {#if compare && data.prevTotal > 0}
            · {m.anx_previous_period({ value: format(data.prevTotal) })}
          {/if}
        </span>
        <Button size="sm" variant="ghost" iconRight="chevron-right" onclick={openFull}>{m.anx_top_see_all()}</Button>
      </footer>
    </div>
  {/if}
</section>

<Modal bind:open={fullOpen} title={title} subtitle={description} size="lg" onClose={() => (fullOpen = false)}>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <label class="relative min-w-0 flex-1">
        <span class="sr-only">{m.anx_top_search()}</span>
        <input type="search" class="input w-full" placeholder={m.anx_top_search()} bind:value={search} />
      </label>
      <Button size="sm" icon="download" onclick={exportFull} disabled={!full || full.items.length === 0}>{m.anx_top_export()}</Button>
    </div>
    {#if fullLoading && !full}
      <AnalyticsSkeleton />
    {:else if visible.length === 0}
      <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_top_empty()}</p>
    {:else}
      <div class="top-list top-list--modal">
        <ol class="top-rows">
          {#each visible as entry (entry.item.id)}
            <li>{@render row(entry.item, entry.rank, Math.max(1, full?.items[0]?.value ?? 1))}</li>
          {/each}
        </ol>
      </div>
      {#if pages > 1}
        <div class="flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" icon="chevron-left" disabled={page <= 1} onclick={() => (page -= 1)}>{m.anx_top_prev_page()}</Button>
          <span class="text-body-sm text-on-surface-variant tabular-nums">{page} / {pages}</span>
          <Button size="sm" variant="ghost" iconRight="chevron-right" disabled={page >= pages} onclick={() => (page += 1)}>{m.anx_top_next_page()}</Button>
        </div>
      {/if}
    {/if}
  </div>
</Modal>

<style>
  .top-list {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
    padding: 1rem;
    border-radius: 0.875rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-lowest, var(--color-surface));
  }

  .top-list--modal,
  .top-list--bare {
    padding: 0;
    border: none;
    background: transparent;
  }

  .top-list__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .top-list__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--color-surface-container);
    color: var(--color-on-surface-variant);
  }

  .top-list__body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: opacity 150ms ease;
  }

  .top-list__body--busy {
    opacity: 0.55;
  }

  .top-list__footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-outline-variant);
  }

  .top-head {
    display: flex;
    gap: 0.75rem;
    padding: 0 0.5rem 0 2.25rem;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .top-head__value {
    min-width: 3.5rem;
    text-align: right;
  }

  .top-head__delta {
    min-width: 4.5rem;
    text-align: right;
  }

  .top-rows {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .top-row {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-height: 2.5rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
    overflow: hidden;
  }

  .top-row::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--fill);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--row-color) 14%, transparent);
    z-index: -1;
  }

  .top-row:not(:disabled):hover {
    background: var(--color-surface-container);
  }

  .top-row:disabled {
    cursor: default;
  }

  .top-row:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .top-row__rank {
    width: 1.25rem;
    flex-shrink: 0;
    text-align: right;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface-variant);
  }

  .top-row__ident {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    flex: 1;
  }

  .top-row__name {
    min-width: 0;
    font-size: 0.875rem;
    color: var(--color-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .top-row__spark {
    flex-shrink: 0;
  }

  .top-row__value {
    flex-shrink: 0;
    min-width: 3.5rem;
    text-align: right;
    font-size: 0.875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }

  .top-row__delta {
    flex-shrink: 0;
    min-width: 4.5rem;
    text-align: right;
    font-size: 0.75rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  :global(.top-avatar) {
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    border-radius: 999px;
    object-fit: cover;
    background: var(--color-surface-container);
  }

  .top-hash {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    border-radius: 0.375rem;
    background: var(--color-surface-container);
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-on-surface-variant);
  }

  .icon-group {
    display: inline-flex;
    padding: 0.125rem;
    gap: 0.125rem;
    border-radius: 0.5rem;
    border: 1px solid var(--color-outline-variant);
  }

  .icon-group__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.875rem;
    height: 1.625rem;
    border-radius: 0.375rem;
    color: var(--color-on-surface-variant);
  }

  .icon-group__btn:hover {
    background: var(--color-surface-container);
    color: var(--color-on-surface);
  }

  .icon-group__btn[aria-pressed='true'] {
    background: var(--color-surface-container-high);
    color: var(--color-on-surface);
  }

  .icon-group__btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  @container (max-width: 26rem) {
    .top-row__spark {
      display: none;
    }
  }

  @container (max-width: 19rem) {
    .top-row__delta,
    .top-head__delta {
      display: none;
    }
  }
</style>
