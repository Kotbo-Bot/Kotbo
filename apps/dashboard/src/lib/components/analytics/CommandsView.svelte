<!--
  Commandes slash : utilisations jour par jour, membres qui s'en servent,
  taux d'échec et durée moyenne, puis le détail par commande (avec sa
  sous-commande), les plus gros utilisateurs et les commandes qui ne servent
  plus. Avant la collecte par jour n'existait qu'un cumul sans date : il est
  montré à part quand la période n'a encore rien.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, SectionCard } from '../ui';
  import ActivityChartCard, { type ChartMetric } from './ActivityChartCard.svelte';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import Sparkline from './Sparkline.svelte';
  import BarList from './BarList.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchCommandAnalytics, type CommandAnalytics } from '../../api';
  import { memberAvatarSrc } from '../../discordMedia';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsAnnotations } from './annotations.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDelta, fmtNumber, fmtPct, SERIES } from './analyticsFormat';

  const { onOpenMember }: { onOpenMember: (userId: string, name: string) => void } = $props();

  const loader = analyticsLoader(() => fetchCommandAnalytics(filters.periodQuery), 'commands');
  const data = $derived(loader.data as CommandAnalytics | null);

  $effect(() => {
    const period = filters.periodQuery;
    untrack(() => analyticsAnnotations.load(period));
  });

  const metrics: ChartMetric[] = $derived(
    data
      ? [{
          id: 'uses',
          label: m.anx_cmd_uses(),
          color: SERIES[0]!,
          format: fmtNumber,
          value: fmtNumber(data.totals.uses),
          delta: relativeDelta(data.totals.uses, data.totals.previousUses),
          aggregate: 'sum',
          daily: data.daily.map((d) => d.uses),
          prevDaily: data.daily.map((d) => d.previous),
          forecast: true,
        }]
      : [],
  );

  const fmtMs = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${fmtNumber(ms)} ms` : `${fmtNumber(Math.round(ms / 100) / 10)} s`);

  const tiles: MetricTab[] = $derived(
    data
      ? [
          { id: 'users', label: m.anx_cmd_users(), value: fmtNumber(data.totals.users), delta: relativeDelta(data.totals.users, data.totals.previousUsers), color: SERIES[0] },
          { id: 'commands', label: m.anx_cmd_distinct(), value: fmtNumber(data.totals.commands), color: SERIES[0] },
          { id: 'errors', label: m.anx_cmd_error_rate(), hint: m.anx_cmd_error_rate_hint(), value: data.totals.errorRate === null ? '—' : fmtPct(data.totals.errorRate), color: SERIES[0] },
          { id: 'duration', label: m.anx_cmd_avg_duration(), value: fmtMs(data.totals.avgMs), color: SERIES[0] },
        ]
      : [],
  );

  let search = $state('');
  type SortKey = 'uses' | 'users' | 'errorRate' | 'avgMs';
  let sort = $state<SortKey>('uses');
  const rows = $derived(
    (data?.commands ?? [])
      .filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
      .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1)),
  );
  const maxUses = $derived(Math.max(1, ...(data?.commands.map((c) => c.uses) ?? [1])));
  const allTimeItems = $derived((data?.allTime ?? []).map((c) => ({ id: c.name, label: `/${c.name}`, value: c.count })));
</script>

{#if loader.loading && !data}
  <AnalyticsSkeleton />
{:else if loader.error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{loader.error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loader.loading}>
    {#if data.totals.uses === 0 && data.totals.previousUses === 0}
      <Callout variant="info" title={m.anx_cmd_empty_title()}>{m.anx_cmd_empty_desc()}</Callout>
      {#if allTimeItems.length > 0}
        <SectionCard title={m.anx_cmd_all_time()} description={m.anx_cmd_all_time_desc()}>
          <BarList items={allTimeItems} />
        </SectionCard>
      {/if}
    {:else}
      <ActivityChartCard
        {metrics}
        active="uses"
        onchange={() => {}}
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
      <MetricTabs metrics={tiles} active="" onchange={() => {}} compare={filters.compare} label={m.an_tab_commands()} interactive={false} />

      <SectionCard title={m.anx_cmd_table()} description={m.anx_cmd_table_desc()} flush>
        <div class="px-5 pt-4">
          <label class="sr-only" for="cmd-search">{m.anx_top_search()}</label>
          <input id="cmd-search" type="search" class="input w-full sm:w-72" placeholder={m.anx_cmd_search()} bind:value={search} />
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{m.anx_cmd_command()}</th>
                <th scope="col" class="num" aria-sort={sort === 'uses' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'uses')}>{m.anx_cmd_uses()}</button></th>
                {#if filters.compare}<th scope="col" class="num">{m.anx_table_delta()}</th>{/if}
                <th scope="col" class="num" aria-sort={sort === 'users' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'users')}>{m.anx_cmd_users()}</button></th>
                <th scope="col" class="num" aria-sort={sort === 'errorRate' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'errorRate')}>{m.anx_cmd_errors()}</button></th>
                <th scope="col" class="num" aria-sort={sort === 'avgMs' ? 'descending' : undefined}><button type="button" class="th-sort" onclick={() => (sort = 'avgMs')}>{m.anx_cmd_duration()}</button></th>
                <th scope="col"><span class="sr-only">{m.anx_cmd_trend()}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each rows as c (c.name)}
                <tr>
                  <th scope="row">
                    <span class="cmd-name">/{c.name}</span>
                    <span class="cmd-bar" aria-hidden="true"><span style="width: {Math.max(2, (c.uses / maxUses) * 100)}%;"></span></span>
                  </th>
                  <td class="num">{fmtNumber(c.uses)} <span class="text-on-surface-variant">· {fmtPct(c.share, 0)}</span></td>
                  {#if filters.compare}<td class="num">{fmtDelta(relativeDelta(c.uses, c.previous), 'pct')}</td>{/if}
                  <td class="num">{fmtNumber(c.users)}</td>
                  <td class="num {c.errorRate !== null && c.errorRate >= 5 ? 'text-error' : ''}">{c.errorRate === null ? '—' : fmtPct(c.errorRate)}</td>
                  <td class="num">{fmtMs(c.avgMs)}</td>
                  <td><Sparkline values={c.spark} width={64} height={18} fill={false} /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div class="cmd-grid">
        <SectionCard title={m.anx_cmd_top_users()} description={m.anx_cmd_top_users_desc()}>
          <ul class="users">
            {#each data.topUsers as u, i (u.userId)}
              <li>
                <button type="button" class="user" onclick={() => onOpenMember(u.userId, u.name ?? '')}>
                  <span class="user__rank">{i + 1}</span>
                  <img class="user__avatar" src={memberAvatarSrc(u.avatarUrl, u.name, u.userId)} alt="" width="24" height="24" loading="lazy" />
                  <span class="user__name">{u.name ?? m.an_member_fallback()}</span>
                  <span class="user__meta">{m.anx_cmd_user_commands({ count: fmtNumber(u.commands) })}</span>
                  <span class="user__value">{fmtNumber(u.uses)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </SectionCard>
        <SectionCard title={m.anx_cmd_unused()} description={m.anx_cmd_unused_desc()}>
          {#if data.unused.length === 0}
            <p class="py-4 text-body-sm text-on-surface-variant">{m.anx_cmd_unused_empty()}</p>
          {:else}
            <ul class="unused">
              {#each data.unused as name (name)}<li class="unused__item">/{name}</li>{/each}
            </ul>
          {/if}
        </SectionCard>
      </div>
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

  .cmd-name {
    display: block;
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .cmd-bar {
    display: block;
    width: 8rem;
    height: 0.25rem;
    margin-top: 0.25rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .cmd-bar > span {
    display: block;
    height: 100%;
    background: var(--series-1);
  }

  .cmd-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    align-items: start;
  }

  .users {
    display: flex;
    flex-direction: column;
    max-height: 24rem;
    overflow-y: auto;
  }

  .user {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
  }

  .user:hover {
    background: var(--color-surface-container);
  }

  .user__rank {
    width: 1.25rem;
    text-align: right;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .user__avatar {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    object-fit: cover;
  }

  .user__name {
    flex: 1;
    min-width: 0;
    font-size: 0.875rem;
    color: var(--color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user__meta {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .user__value {
    min-width: 2.5rem;
    text-align: right;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }

  .unused {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .unused__item {
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }
</style>
