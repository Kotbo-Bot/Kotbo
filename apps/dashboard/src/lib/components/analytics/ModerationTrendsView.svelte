<!--
  Tendances de modération : sanctions par type dans le temps (empilées),
  répartition entre modérateurs, récidive (membres sanctionnés au moins deux
  fois sur la période) et délai entre l'incident rapporté et la sanction.
-->
<script lang="ts">
  import { Callout, SectionCard } from '../ui';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import TimeSeriesChart from './TimeSeriesChart.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchModerationTrends, type ModerationTrends } from '../../api';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDelta, fmtDuration, fmtNumber, fmtPct, shortDate, SERIES } from './analyticsFormat';

  const { onOpenMember }: { onOpenMember: (userId: string, name: string) => void } = $props();

  const loader = analyticsLoader(() => fetchModerationTrends(filters.periodQuery), 'moderationTrends');
  const data = $derived(loader.data as ModerationTrends | null);

  const TYPE_ORDER = ['WARN', 'TIMEOUT', 'KICK', 'SOFTBAN', 'TEMP_BAN', 'BAN'];
  const typeLabel = (t: string) =>
    ({ WARN: m.anx_mod_warn(), TIMEOUT: m.anx_mod_timeout(), KICK: m.anx_mod_kick(), SOFTBAN: m.anx_mod_softban(), TEMP_BAN: m.anx_mod_tempban(), BAN: m.anx_mod_ban() })[t] ?? t;
  // Couleur fixe par type, quel que soit le nombre de types présents.
  const typeColor = (t: string) => SERIES[Math.max(0, TYPE_ORDER.indexOf(t))]!;

  const stacks = $derived(
    (data?.byType.series ?? [])
      .slice()
      .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
      .map((s) => ({ label: typeLabel(s.type), values: s.values, color: typeColor(s.type) })),
  );

  const tiles: MetricTab[] = $derived(
    data
      ? [
          { id: 'total', label: m.anx_fact_sanctions(), value: fmtNumber(data.total), delta: relativeDelta(data.total, data.previousTotal), color: SERIES[0] },
          { id: 'sanctioned', label: m.anx_modt_sanctioned(), value: fmtNumber(data.recidivism.sanctioned), color: SERIES[0] },
          {
            id: 'recidivism',
            label: m.anx_modt_recidivism(),
            hint: m.anx_modt_recidivism_hint(),
            value: data.recidivism.rate === null ? '—' : fmtPct(data.recidivism.rate),
            delta: data.recidivism.rate !== null && data.recidivism.previousRate ? relativeDelta(data.recidivism.rate, data.recidivism.previousRate) : undefined,
            invert: true,
            color: SERIES[0],
          },
          { id: 'delay', label: m.anx_modt_delay(), hint: m.anx_modt_delay_hint({ count: fmtNumber(data.reportDelay.reports) }), value: fmtDuration(data.reportDelay.medianSec), color: SERIES[0] },
        ]
      : [],
  );
</script>

{#if loader.loading && !data}
  <AnalyticsSkeleton />
{:else if loader.error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{loader.error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loader.loading}>
    <MetricTabs metrics={tiles} active="" onchange={() => {}} compare={filters.compare} label={m.anx_modt_title()} interactive={false} />

    {#if stacks.length > 0}
      <SectionCard title={m.anx_modt_by_type()}>
        <TimeSeriesChart labels={data.byType.dates.map(shortDate)} mode="stacked" {stacks} format={fmtNumber} height={240} />
      </SectionCard>
    {/if}

    <div class="mod-grid">
      <SectionCard title={m.anx_modt_moderators()} description={m.anx_modt_moderators_desc()} flush>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{m.anx_modt_moderator()}</th>
                <th scope="col" class="num">{m.anx_fact_sanctions()}</th>
                <th scope="col" class="num">{m.anx_top_share()}</th>
                {#if filters.compare}<th scope="col" class="num">{m.anx_table_delta()}</th>{/if}
                <th scope="col">{m.anx_modt_mix()}</th>
              </tr>
            </thead>
            <tbody>
              {#each data.moderators as mod (mod.userId)}
                <tr>
                  <th scope="row"><button type="button" class="row-link" onclick={() => onOpenMember(mod.userId, mod.name ?? '')}>{mod.name ?? m.an_member_fallback()}</button></th>
                  <td class="num">{fmtNumber(mod.count)}</td>
                  <td class="num">{fmtPct(mod.share, 0)}</td>
                  {#if filters.compare}<td class="num">{fmtDelta(relativeDelta(mod.count, mod.previous), 'pct')}</td>{/if}
                  <td>
                    <span class="mix" role="img" aria-label={Object.entries(mod.types).map(([t, n]) => `${typeLabel(t)} ${n}`).join(', ')}>
                      {#each TYPE_ORDER.filter((t) => mod.types[t]) as t (t)}
                        <span class="mix__part" style="flex-grow: {mod.types[t]}; background: {typeColor(t)};" title={`${typeLabel(t)} : ${mod.types[t]}`}></span>
                      {/each}
                    </span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title={m.anx_modt_offenders()} description={m.anx_modt_offenders_desc()}>
        {#if data.recidivism.offenders.length === 0}
          <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_modt_offenders_empty()}</p>
        {:else}
          <ul class="offenders">
            {#each data.recidivism.offenders as o (o.userId)}
              <li>
                <button type="button" class="offender" onclick={() => onOpenMember(o.userId, o.name ?? '')}>
                  <span class="offender__name">{o.name ?? m.an_member_fallback()}</span>
                  <span class="offender__meta">{m.anx_modt_offender_count({ count: fmtNumber(o.count) })}{o.last ? ` · ${shortDate(o.last.slice(0, 10))}` : ''}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </SectionCard>
    </div>
  </div>
{/if}

<style>
  .mod-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    align-items: start;
  }

  .table-wrap {
    max-height: 26rem;
    overflow: auto;
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
  }

  .data-table thead th {
    position: sticky;
    top: 0;
    background: var(--color-surface-container-low);
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .row-link {
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .row-link:hover {
    color: var(--color-primary);
  }

  .mix {
    display: flex;
    gap: 2px;
    width: 6rem;
    height: 0.5rem;
    border-radius: 999px;
    overflow: hidden;
  }

  .mix__part {
    flex-basis: 0;
    min-width: 3px;
  }

  .offenders {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    max-height: 22rem;
    overflow-y: auto;
  }

  .offender {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
  }

  .offender:hover {
    background: var(--color-surface-container);
  }

  .offender__name {
    min-width: 0;
    font-size: 0.875rem;
    color: var(--color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .offender__meta {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }
</style>
