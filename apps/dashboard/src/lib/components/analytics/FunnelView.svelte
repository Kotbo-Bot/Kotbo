<!--
  Entonnoir d'arrivée des membres arrivés sur la période : restés plus d'une
  semaine, premier message, actifs à 7 jours, actifs à 30 jours. Les deux
  dernières étapes ne comptent que les membres arrivés depuis assez
  longtemps. Dessous, le même entonnoir par source d'invitation, pour voir
  quelle provenance amène des membres qui restent et participent.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, SectionCard } from '../ui';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchOnboardingFunnel, type FunnelSteps, type OnboardingFunnel } from '../../api';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters, pct } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct } from './analyticsFormat';

  let data = $state<OnboardingFunnel | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const query = filters.query;
    const id = ++requestId;
    untrack(() => {
      loading = true;
      error = '';
    });
    fetchOnboardingFunnel(query)
      .then((res) => {
        if (id !== requestId) return;
        data = res;
        analyticsExport.funnel = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  function steps(f: FunnelSteps) {
    return [
      { id: 'joined', label: m.anx_funnel_joined(), count: f.joined, base: f.joined, hint: '' },
      { id: 'stayed', label: m.anx_funnel_stayed(), count: f.stayed, base: f.joined, hint: m.anx_funnel_stayed_hint() },
      { id: 'first', label: m.anx_funnel_first(), count: f.firstMessage, base: f.joined, hint: m.anx_funnel_first_hint() },
      { id: 'a7', label: m.anx_funnel_active7(), count: f.active7, base: f.eligible7, hint: m.anx_funnel_eligible({ count: fmtNumber(f.eligible7) }) },
      { id: 'a30', label: m.anx_funnel_active30(), count: f.active30, base: f.eligible30, hint: m.anx_funnel_eligible({ count: fmtNumber(f.eligible30) }) },
    ];
  }

  const rate = (count: number, base: number) => (base > 0 ? pct(count, base) : null);
  const show = (v: number | null) => (v === null ? '–' : fmtPct(v, 0));

  function sourceLabel(row: OnboardingFunnel['bySource'][number]): string {
    if (row.kind === 'unknown') return m.anx_funnel_source_unknown();
    if (row.kind === 'vanity') return m.anx_funnel_source_vanity({ code: row.label ?? '' });
    return row.label ?? row.key;
  }

  function delayText(days: number | null): string {
    if (days === null) return '–';
    if (days < 1) return m.anx_funnel_same_day();
    return m.anx_fact_days({ count: fmtNumber(Math.round(days * 10) / 10) });
  }
</script>

{#if loading && !data}
  <AnalyticsSkeleton />
{:else if error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loading}>
    {#if data.channelIgnored}
      <Callout variant="info">{m.anx_channel_filter_ignored()}</Callout>
    {/if}
    {#if data.overall.joined === 0}
      <SectionCard>
        <p class="py-8 text-center text-body-sm text-on-surface-variant">{m.anx_funnel_empty()}</p>
      </SectionCard>
    {:else}
      <SectionCard title={m.anx_funnel_title()} description={m.anx_funnel_desc()}>
        <ol class="funnel">
          {#each steps(data.overall) as step (step.id)}
            {@const r = rate(step.count, step.base)}
            <li class="funnel__step">
              <div class="funnel__head">
                <span class="funnel__label">{step.label}</span>
                <span class="funnel__value">{fmtNumber(step.count)} <span class="funnel__rate">{step.id === 'joined' ? '' : show(r)}</span></span>
              </div>
              <div class="funnel__track" aria-hidden="true">
                <span class="funnel__fill" style="width: {Math.max(1.5, step.id === 'joined' ? 100 : (r ?? 0))}%;"></span>
              </div>
              {#if step.hint}<span class="funnel__hint">{step.hint}</span>{/if}
            </li>
          {/each}
        </ol>
        <dl class="funnel-facts">
          <div>
            <dt>{m.anx_funnel_median_first()}</dt>
            <dd>{delayText(data.overall.medianDaysToFirstMessage)}</dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title={m.anx_funnel_sources_title()} description={m.anx_funnel_sources_desc()} flush>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{m.anx_funnel_source()}</th>
                <th scope="col" class="num">{m.anx_funnel_joined()}</th>
                <th scope="col" class="num">{m.anx_funnel_stayed()}</th>
                <th scope="col" class="num">{m.anx_funnel_first()}</th>
                <th scope="col" class="num">{m.anx_funnel_active7()}</th>
                <th scope="col" class="num">{m.anx_funnel_active30()}</th>
                <th scope="col" class="num">{m.anx_funnel_median_short()}</th>
              </tr>
            </thead>
            <tbody>
              {#each data.bySource as row (row.key)}
                <tr>
                  <th scope="row" class="source">{sourceLabel(row)}</th>
                  <td class="num">{fmtNumber(row.joined)}</td>
                  <td class="num">{show(rate(row.stayed, row.joined))}</td>
                  <td class="num">{show(rate(row.firstMessage, row.joined))}</td>
                  <td class="num">{show(rate(row.active7, row.eligible7))}</td>
                  <td class="num">{show(rate(row.active30, row.eligible30))}</td>
                  <td class="num">{delayText(row.medianDaysToFirstMessage)}</td>
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
  .funnel {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin-top: 0.5rem;
  }

  .funnel__step {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }

  .funnel__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  .funnel__label {
    font-size: 0.875rem;
    color: var(--color-on-surface);
  }

  .funnel__value {
    font-size: 0.875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }

  .funnel__rate {
    margin-left: 0.375rem;
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .funnel__track {
    height: 0.625rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .funnel__fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--series-1);
  }

  .funnel__hint {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .funnel-facts {
    display: flex;
    gap: 2rem;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-outline-variant);
  }

  .funnel-facts dt {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .funnel-facts dd {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .table-wrap {
    overflow-x: auto;
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
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .data-table .source {
    font-weight: 500;
    color: var(--color-on-surface);
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
