<!--
  Rôles par réaction : rôles pris et retirés depuis les menus jour par jour, puis le
  détail par rôle de menu (prises, retraits, solde, porteurs actuels, courbe).
  Seuls les clics sur les menus comptent : un rôle donné à la main ne dit rien
  de ce que les membres choisissent.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, SectionCard } from '../ui';
  import ActivityChartCard, { type ChartMetric } from './ActivityChartCard.svelte';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import Sparkline from './Sparkline.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchReactionRoleAnalytics, type ReactionRoleAnalytics } from '../../api';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsAnnotations } from './annotations.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDelta, fmtNumber, SERIES } from './analyticsFormat';

  const loader = analyticsLoader(() => fetchReactionRoleAnalytics(filters.periodQuery), 'reaction-roles');
  const data = $derived(loader.data as ReactionRoleAnalytics | null);

  $effect(() => {
    const period = filters.periodQuery;
    untrack(() => analyticsAnnotations.load(period));
  });

  let activeMetric = $state('added');

  const metrics: ChartMetric[] = $derived(
    data
      ? [
          {
            id: 'added',
            label: m.anx_rr_added(),
            color: SERIES[0]!,
            format: fmtNumber,
            value: fmtNumber(data.totals.added),
            delta: relativeDelta(data.totals.added, data.totals.previousAdded),
            aggregate: 'sum',
            daily: data.daily.map((d) => d.added),
            prevDaily: data.daily.map((d) => d.previousAdded),
            forecast: true,
          },
          {
            id: 'removed',
            label: m.anx_rr_removed(),
            color: SERIES[1]!,
            format: fmtNumber,
            value: fmtNumber(data.totals.removed),
            delta: relativeDelta(data.totals.removed, data.totals.previousRemoved),
            aggregate: 'sum',
            daily: data.daily.map((d) => d.removed),
            prevDaily: data.daily.map((d) => d.previousRemoved),
            forecast: true,
          },
        ]
      : [],
  );

  const tiles: MetricTab[] = $derived(
    data
      ? [
          { id: 'net', label: m.anx_rr_net(), hint: m.anx_rr_net_hint(), value: fmtNumber(data.totals.net), color: SERIES[0] },
          { id: 'roles', label: m.anx_rr_roles(), value: fmtNumber(data.roles.length), color: SERIES[0] },
        ]
      : [],
  );

  let search = $state('');
  type SortKey = 'added' | 'removed' | 'net' | 'holders';
  let sort = $state<SortKey>('added');
  const rows = $derived(
    (data?.roles ?? [])
      .filter((r) => `${r.roleName ?? ''} ${r.menuTitle ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
      .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1)),
  );
  const maxAdded = $derived(Math.max(1, ...(data?.roles.map((r) => r.added) ?? [1])));
</script>

{#if loader.loading && !data}
  <AnalyticsSkeleton />
{:else if loader.error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{loader.error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loader.loading}>
    {#if data.totals.added + data.totals.removed === 0 && data.totals.previousAdded + data.totals.previousRemoved === 0}
      <Callout variant="info" title={m.anx_rr_empty_title()}>{m.anx_rr_empty_desc()}</Callout>
    {:else}
      <ActivityChartCard
        {metrics}
        active={activeMetric}
        onchange={(id) => (activeMetric = id)}
        dates={data.daily.map((d) => d.dateKey)}
        days={filters.days}
        compare={filters.compare}
        onToggleCompare={() => filters.toggleCompare()}
        loadHourly={async () => null}
        loadBreakdown={async () => null}
        reloadKey={filters.periodKey}
        annotations={analyticsAnnotations.items}
        onAnnotate={(dateKey, label) => analyticsAnnotations.add(dateKey, label, filters.periodQuery)}
        onDeleteAnnotation={(id) => analyticsAnnotations.remove(id)}
        canDeleteAnnotation={(a) => analyticsAnnotations.canDelete(a)}
        busy={loader.loading}
        forecastAllowed={!filters.isCustom}
      />
      <MetricTabs metrics={tiles} active="" onchange={() => {}} compare={filters.compare} label={m.anx_tab_reaction_roles()} interactive={false} />

      <SectionCard title={m.anx_rr_table()} description={m.anx_rr_table_desc()} flush>
        <div class="px-5 pt-4">
          <label class="sr-only" for="rr-search">{m.anx_top_search()}</label>
          <input id="rr-search" type="search" class="input w-full sm:w-72" placeholder={m.anx_rr_search()} bind:value={search} />
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{m.anx_rr_role()}</th>
                <th scope="col" class="num" aria-sort={sort === 'added' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'added')}>{m.anx_rr_added()}</button></th>
                {#if filters.compare}<th scope="col" class="num">{m.anx_table_delta()}</th>{/if}
                <th scope="col" class="num" aria-sort={sort === 'removed' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'removed')}>{m.anx_rr_removed()}</button></th>
                <th scope="col" class="num" aria-sort={sort === 'net' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'net')}>{m.anx_rr_net()}</button></th>
                <th scope="col" class="num" aria-sort={sort === 'holders' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'holders')}>{m.anx_rr_holders()}</button></th>
                <th scope="col"><span class="sr-only">{m.anx_rr_trend()}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each rows as r (`${r.menuId}:${r.roleId}`)}
                <tr>
                  <th scope="row">
                    <span class="rr-role">
                      <span class="rr-dot" style="background: {r.roleColor ?? 'var(--color-outline)'};" aria-hidden="true"></span>
                      {r.roleName ? `@${r.roleName}` : m.anx_rr_role_deleted()}
                    </span>
                    <span class="rr-menu">{r.menuTitle ?? m.anx_rr_menu_deleted()}</span>
                    <span class="rr-bar" aria-hidden="true"><span style="width: {Math.max(2, (r.added / maxAdded) * 100)}%;"></span></span>
                  </th>
                  <td class="num">{fmtNumber(r.added)}</td>
                  {#if filters.compare}<td class="num">{fmtDelta(relativeDelta(r.added, r.previousAdded), 'pct')}</td>{/if}
                  <td class="num">{fmtNumber(r.removed)}</td>
                  <td class="num {r.net < 0 ? 'text-error' : ''}">{r.net > 0 ? '+' : ''}{fmtNumber(r.net)}</td>
                  <td class="num">{r.holders === null ? '–' : fmtNumber(r.holders)}</td>
                  <td><Sparkline values={r.spark} width={64} height={18} fill={false} /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SectionCard>
    {/if}
  </div>
{/if}

<style>
  .table-wrap {
    max-height: 30rem;
    overflow: auto;
    margin-top: 0.75rem;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .data-table th,
  .data-table td {
    padding: 0.5rem 1rem;
    text-align: left;
    border-bottom: 1px solid var(--color-outline-variant);
    white-space: nowrap;
    vertical-align: middle;
  }

  .data-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-surface-container-low);
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .th-sort {
    color: inherit;
    font-weight: inherit;
  }

  [aria-sort] .th-sort {
    color: var(--color-on-surface);
  }

  .rr-role {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .rr-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .rr-menu {
    display: block;
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--color-on-surface-variant);
  }

  .rr-bar {
    display: block;
    width: 8rem;
    height: 0.25rem;
    margin-top: 0.25rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .rr-bar > span {
    display: block;
    height: 100%;
    background: var(--series-1);
  }
</style>
