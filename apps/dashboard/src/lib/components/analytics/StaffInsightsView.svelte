<!--
  Réactivité du staff sur les tickets : délai de première réponse et de
  résolution, part des tickets répondus en moins d'une heure, charge par
  membre du staff, et grille jour × heure des tickets ouverts : la teinte
  marque les heures où ils attendent le plus (staff absent).
-->
<script lang="ts">
  import { Callout, SectionCard } from '../ui';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchStaffInsights, type StaffInsights } from '../../api';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDuration, fmtNumber, fmtPct, SERIES } from './analyticsFormat';

  const { onOpenMember }: { onOpenMember: (userId: string, name: string) => void } = $props();

  const loader = analyticsLoader(() => fetchStaffInsights(filters.periodQuery), 'staffInsights');
  const data = $derived(loader.data as StaffInsights | null);

  const tiles: MetricTab[] = $derived.by(() => {
    if (!data) return [];
    const t = data.tickets;
    const delta = (now: number | null, prev: number | null) => (now !== null && prev ? relativeDelta(now, prev) : undefined);
    return [
      { id: 'opened', label: m.anx_staff_opened(), value: fmtNumber(t.opened), delta: relativeDelta(t.opened, t.previousOpened), color: SERIES[0] },
      { id: 'first', label: m.anx_staff_first(), hint: m.anx_staff_first_hint(), value: fmtDuration(t.firstResponseMedianSec), delta: delta(t.firstResponseMedianSec, t.previousFirstResponseMedianSec), invert: true, color: SERIES[0] },
      { id: 'within1h', label: m.anx_staff_within1h(), value: t.within1h === null ? '–' : fmtPct(t.within1h), color: SERIES[0] },
      { id: 'resolution', label: m.anx_staff_resolution(), value: fmtDuration(t.resolutionMedianSec), delta: delta(t.resolutionMedianSec, t.previousResolutionMedianSec), invert: true, color: SERIES[0] },
      { id: 'unresolved', label: m.anx_staff_unresolved(), value: fmtNumber(t.unresolved), color: SERIES[0] },
    ];
  });

  const DAYS = $derived([m.anx_day_mon(), m.anx_day_tue(), m.anx_day_wed(), m.anx_day_thu(), m.anx_day_fri(), m.anx_day_sat(), m.anx_day_sun()]);
  const maxOpened = $derived(Math.max(1, ...(data?.coverage.flat().map((c) => c.opened) ?? [1])));

  /** Teinte d'une case : plus l'attente médiane est longue, plus c'est foncé ; sans ticket, vide. */
  function cellStyle(cell: { opened: number; medianSec: number | null }): string {
    if (cell.opened === 0) return '';
    if (cell.medianSec === null) return 'background: var(--color-surface-container-high);';
    const strength = Math.round(12 + Math.min(1, cell.medianSec / 7200) * 78);
    return `background: color-mix(in srgb, var(--series-2) ${strength}%, var(--color-surface-container-lowest, var(--color-surface)));`;
  }

  const slowHours = $derived(
    (data?.coverage ?? [])
      .flatMap((row, d) => row.map((cell, h) => ({ d, h, ...cell })))
      .filter((c) => c.opened >= 2 && (c.medianSec ?? 0) > 3600)
      .sort((a, b) => (b.medianSec ?? 0) - (a.medianSec ?? 0))
      .slice(0, 3),
  );
</script>

{#if loader.loading && !data}
  <AnalyticsSkeleton />
{:else if loader.error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{loader.error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loader.loading}>
    {#if !data.measuredSince}
      <Callout variant="info">{m.anx_staff_not_measured()}</Callout>
    {/if}
    <MetricTabs metrics={tiles} active="" onchange={() => {}} compare={filters.compare} label={m.anx_staff_title()} interactive={false} />

    <div class="staff-grid">
      <SectionCard title={m.anx_staff_load()} description={m.anx_staff_load_desc()} flush>
        {#if data.staff.length === 0}
          <p class="px-5 py-6 text-body-sm text-on-surface-variant">{m.anx_staff_load_empty()}</p>
        {:else}
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">{m.anx_staff_member()}</th>
                  <th scope="col" class="num">{m.anx_staff_claimed()}</th>
                  <th scope="col" class="num">{m.anx_staff_closed()}</th>
                  <th scope="col" class="num">{m.anx_staff_first_short()}</th>
                  <th scope="col" class="num">{m.anx_top_share()}</th>
                </tr>
              </thead>
              <tbody>
                {#each data.staff as s (s.userId)}
                  <tr>
                    <th scope="row"><button type="button" class="row-link" onclick={() => onOpenMember(s.userId, s.name ?? '')}>{s.name ?? m.an_member_fallback()}</button></th>
                    <td class="num">{fmtNumber(s.claimed)}</td>
                    <td class="num">{fmtNumber(s.closed)}</td>
                    <td class="num">{fmtDuration(s.firstResponseMedianSec)}</td>
                    <td class="num">{fmtPct(s.share, 0)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </SectionCard>

      <SectionCard title={m.anx_staff_coverage()} description={m.anx_staff_coverage_desc({ tz: data.timezone })}>
        <div class="cov-wrap">
          <table class="cov">
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">{m.anx_staff_day()}</span></th>
                {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
                  <th scope="col" class="cov__hour">{h % 3 === 0 ? h : ''}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each data.coverage as row, d (d)}
                <tr>
                  <th scope="row" class="cov__day">{DAYS[d]}</th>
                  {#each row as cell, h (h)}
                    <td
                      class="cov__cell"
                      style={cellStyle(cell)}
                      title={cell.opened > 0 ? m.anx_staff_cell({ day: DAYS[d] ?? '', hour: String(h), opened: fmtNumber(cell.opened), delay: fmtDuration(cell.medianSec) }) : undefined}
                    >
                      {#if cell.opened > 0}<span class="cov__dot" style="opacity: {0.35 + (cell.opened / maxOpened) * 0.65};"></span>{/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if slowHours.length > 0}
          <p class="mt-3 text-body-sm text-on-surface-variant">
            {m.anx_staff_slow_hours({ hours: slowHours.map((c) => `${DAYS[c.d]} ${c.h} h (${fmtDuration(c.medianSec)})`).join(', ') })}
          </p>
        {/if}
      </SectionCard>
    </div>
  </div>
{/if}

<style>
  .staff-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
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

  .cov-wrap {
    overflow-x: auto;
    margin-top: 0.5rem;
  }

  .cov {
    border-collapse: separate;
    border-spacing: 2px;
    font-size: 0.6875rem;
  }

  .cov__hour {
    min-width: 1rem;
    font-weight: 400;
    color: var(--color-on-surface-variant);
    text-align: left;
  }

  .cov__day {
    padding-right: 0.375rem;
    font-weight: 500;
    text-align: left;
    color: var(--color-on-surface-variant);
    white-space: nowrap;
  }

  .cov__cell {
    width: 1rem;
    height: 1.125rem;
    border-radius: 0.1875rem;
    background: var(--color-surface-container);
    text-align: center;
    vertical-align: middle;
  }

  .cov__dot {
    display: inline-block;
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 999px;
    background: var(--color-on-surface);
  }
</style>
