<!--
  Ce que le site rapporte au serveur : visiteurs, clics sur « Rejoindre »,
  arrivées par l'invitation du site, arrivées encore là après sept jours.
  Chaque barre se lit par rapport à l'étape précédente ; la dernière par
  rapport aux seules arrivées assez anciennes pour juger.
-->
<script lang="ts">
  import { Callout, SectionCard } from '../ui';
  import BarList from '../analytics/BarList.svelte';
  import { fmtNumber, fmtPct, SERIES } from '../analytics/analyticsFormat';
  import { m } from '../../i18n';
  import type { SiteFunnel } from '../../api/site';

  let { funnel }: { funnel: SiteFunnel } = $props();

  const rate = (count: number, base: number): number | null => (base > 0 ? Math.min(100, (count / base) * 100) : null);

  const steps = $derived([
    { id: 'visitors', label: m.ste_funnel_visitors(), count: funnel.visitors, rate: null as number | null, hint: '' },
    { id: 'clickers', label: m.ste_funnel_clickers(), count: funnel.clickers, rate: rate(funnel.clickers, funnel.visitors), hint: m.ste_funnel_clicks({ count: fmtNumber(funnel.clicks) }) },
    { id: 'arrivals', label: m.ste_funnel_arrivals(), count: funnel.arrivals, rate: rate(funnel.arrivals, funnel.clickers), hint: '' },
    {
      id: 'retained',
      label: m.ste_funnel_retained(),
      count: funnel.retained,
      rate: rate(funnel.retained, funnel.eligible),
      hint: m.ste_funnel_eligible({ count: fmtNumber(funnel.eligible) }),
    },
  ]);

  const SOURCE_LABELS: Record<string, () => string> = {
    hero: () => m.ste_join_source_hero(),
    forum: () => m.ste_join_source_forum(),
    block: () => m.ste_join_source_block(),
    footer: () => m.ste_join_source_footer(),
    other: () => m.ste_join_source_other(),
  };
</script>

<SectionCard title={m.ste_funnel_title()} description={m.ste_funnel_desc()} icon="trending-up">
  <div class="px-5 pb-5 space-y-5">
    {#if !funnel.attributable}
      <Callout variant="info">{m.ste_funnel_not_attributable()}</Callout>
    {/if}
    <ol class="site-funnel">
      {#each steps as step, i (step.id)}
        <li>
          <div class="site-funnel__head">
            <span class="site-funnel__label">{step.label}</span>
            <span class="site-funnel__value">{fmtNumber(step.count)}{#if i > 0}<span class="site-funnel__rate">{step.rate === null ? '–' : fmtPct(step.rate, 0)}</span>{/if}</span>
          </div>
          <div class="site-funnel__track" aria-hidden="true">
            <span class="site-funnel__fill" style="width: {Math.max(1.5, i === 0 ? 100 : (step.rate ?? 0))}%; background: {SERIES[i % SERIES.length]};"></span>
          </div>
          {#if step.hint}<span class="site-funnel__hint">{step.hint}</span>{/if}
        </li>
      {/each}
    </ol>
    {#if funnel.sources.length > 0}
      <div>
        <p class="site-funnel__sub">{m.ste_funnel_sources()}</p>
        <BarList items={funnel.sources.map((s) => ({ id: s.source, label: SOURCE_LABELS[s.source]?.() ?? s.source, value: s.clicks }))} color={SERIES[1]} empty={m.ste_no_data()} />
      </div>
    {/if}
  </div>
</SectionCard>

<style>
  .site-funnel { display: flex; flex-direction: column; gap: 0.875rem; margin: 0; padding: 0; list-style: none; }
  .site-funnel li { display: flex; flex-direction: column; gap: 0.3125rem; }
  .site-funnel__head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .site-funnel__label { font-size: 0.875rem; color: var(--color-on-surface); }
  .site-funnel__value { font-size: 0.875rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--color-on-surface); }
  .site-funnel__rate { margin-left: 0.375rem; font-weight: 500; color: var(--color-on-surface-variant); }
  .site-funnel__track { height: 0.625rem; border-radius: 999px; background: var(--color-surface-container); overflow: hidden; }
  .site-funnel__fill { display: block; height: 100%; border-radius: 999px; }
  .site-funnel__hint { font-size: 0.75rem; color: var(--color-on-surface-variant); }
  .site-funnel__sub { margin: 0 0 0.5rem; font-size: 0.8rem; font-weight: 600; color: var(--color-on-surface-variant); }
</style>
