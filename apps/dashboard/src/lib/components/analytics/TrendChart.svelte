<script lang="ts">
  import { TrendChart as KotboTrendChart } from '@kotbo/ui/analytics';

  const {
    dates,
    values,
    previous = [],
    label,
    previousLabel,
    compare = false,
    color = 'var(--series-1)',
    height = 240,
    format = (v: number) => String(v),
  }: {
    dates: string[];
    values: number[];
    previous?: number[];
    label: string;
    previousLabel: string;
    compare?: boolean;
    color?: string;
    height?: number;
    format?: (value: number) => string;
  } = $props();
</script>

<KotboTrendChart {dates} {values} {previous} {label} {previousLabel} {compare} {color} {height} {format} />
