<script lang="ts" module>
  export type MetricTab = import('@kotbo/ui/analytics').MetricTab;
</script>

<script lang="ts">
  import { MetricTabs as KotboMetricTabs } from '@kotbo/ui/analytics';
  import ServerTagPill from '../ServerTagPill.svelte';

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
    label: string;
    interactive?: boolean;
    deltaUnit?: 'pct' | 'pts';
  } = $props();
</script>

<KotboMetricTabs {metrics} {active} {onchange} {compare} {label} {interactive} {deltaUnit}>
  {#snippet badge(metric)}
    {#if metric.tag}
      <ServerTagPill tag={metric.tag.text} badgeUrl={metric.tag.badgeUrl} />
    {/if}
  {/snippet}
</KotboMetricTabs>
