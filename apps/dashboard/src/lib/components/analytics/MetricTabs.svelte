<!--
  Tuiles de chiffres clés qui pilotent la courbe du dessous, comme dans
  Google Analytics : cliquer une tuile affiche sa mesure dans le graphique.
  Chaque tuile porte sa valeur, son écart avec la période d'avant (flèche en
  plus de la couleur) et sa mini-courbe.
-->
<script lang="ts" module>
  export interface MetricTab {
    id: string;
    label: string;
    value: string;
    /** Écart en %, null = pas de base de comparaison. */
    delta?: number | null;
    /** Une hausse est une mauvaise nouvelle (départs, sanctions). */
    invert?: boolean;
    /** Valeur de la période d'avant : remplace l'écart en %, trop instable d'une semaine à l'autre. */
    previous?: string;
    spark?: number[];
    color?: string;
    hint?: string;
  }
</script>

<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import Sparkline from './Sparkline.svelte';
  import { m } from '../../i18n';
  import { fmtDelta } from './analyticsFormat';

  const {
    metrics,
    active,
    onchange,
    compare = false,
    label,
    interactive = true,
    deltaUnit = 'pct',
  }: {
    metrics: MetricTab[];
    active: string;
    onchange: (id: string) => void;
    compare?: boolean;
    /** Nom du groupe pour les lecteurs d'écran. */
    label: string;
    /** false : simples chiffres clés, sans courbe à piloter. */
    interactive?: boolean;
    /** Unité de l'écart : % (défaut) ou points, pour des notes sur 100. */
    deltaUnit?: 'pct' | 'pts';
  } = $props();

  function tone(metric: MetricTab): 'up' | 'down' | 'flat' {
    const d = metric.delta;
    if (d === undefined || d === null || Math.abs(d) < 0.05) return 'flat';
    return d > 0 ? 'up' : 'down';
  }

  function good(metric: MetricTab): boolean | null {
    const t = tone(metric);
    if (t === 'flat') return null;
    return (t === 'up') !== Boolean(metric.invert);
  }

  function onKeydown(event: KeyboardEvent, index: number) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = metrics[(index + delta + metrics.length) % metrics.length];
    if (!next) return;
    onchange(next.id);
    const buttons = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[(index + delta + metrics.length) % metrics.length]?.focus();
  }
</script>

{#snippet content(metric: MetricTab, selected: boolean, verdict: boolean | null)}
  <span class="metric-tab__label">{metric.label}</span>
  <span class="metric-tab__row">
    <span class="metric-tab__value">{metric.value}</span>
    {#if metric.spark && metric.spark.length > 1}
      <Sparkline values={metric.spark} color={selected ? 'var(--metric-color)' : 'var(--series-neutral)'} width={64} height={22} />
    {/if}
  </span>
  {#if compare && metric.previous !== undefined}
    <span class="metric-tab__delta text-on-surface-variant font-normal">
      {m.anx_previous_period({ value: metric.previous })}
    </span>
  {:else if compare && metric.delta !== undefined}
    <span
      class="metric-tab__delta {verdict === true ? 'text-success' : verdict === false ? 'text-error' : 'text-on-surface-variant'}"
    >
      {#if tone(metric) !== 'flat'}
        <Papicon icon={tone(metric) === 'up' ? 'trending-up' : 'trending-down'} size={12} />
      {/if}
      {fmtDelta(metric.delta ?? null, deltaUnit)}
      <span class="text-on-surface-variant font-normal">{m.anx_delta_vs_previous()}</span>
    </span>
  {/if}
{/snippet}

{#if interactive}
  <div class="metric-tabs" role="tablist" aria-label={label}>
    {#each metrics as metric, index (metric.id)}
      {@const selected = metric.id === active}
      <button
        type="button"
        role="tab"
        class="metric-tab"
        aria-selected={selected}
        tabindex={selected ? 0 : -1}
        title={metric.hint || undefined}
        style="--metric-color: {metric.color ?? 'var(--series-1)'};"
        onclick={() => onchange(metric.id)}
        onkeydown={(e) => onKeydown(e, index)}
      >
        {@render content(metric, selected, good(metric))}
      </button>
    {/each}
  </div>
{:else}
  <ul class="metric-tabs" aria-label={label}>
    {#each metrics as metric (metric.id)}
      <li class="metric-tab metric-tab--static" title={metric.hint || undefined} style="--metric-color: {metric.color ?? 'var(--series-1)'};">
        {@render content(metric, true, good(metric))}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .metric-tabs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr));
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    overflow: hidden;
  }

  .metric-tab {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.875rem 1rem 0.875rem;
    text-align: left;
    border-right: 1px solid var(--color-outline-variant);
    border-bottom: 1px solid var(--color-outline-variant);
    margin: 0 -1px -1px 0;
    transition: background-color 120ms ease;
  }

  .metric-tab::before {
    content: '';
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: transparent;
  }

  .metric-tab:hover {
    background: var(--color-surface-container);
  }

  .metric-tab[aria-selected='true'] {
    background: var(--color-surface-container);
  }

  .metric-tab[aria-selected='true']::before {
    background: var(--metric-color);
  }

  .metric-tab--static,
  .metric-tab--static:hover {
    background: transparent;
  }

  .metric-tab:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .metric-tab__label {
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .metric-tab__row {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
  }

  .metric-tab__value {
    font-family: var(--font-headline);
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.15;
    color: var(--color-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .metric-tab__delta {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }
</style>
