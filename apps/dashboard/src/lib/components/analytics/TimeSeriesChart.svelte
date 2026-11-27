<script lang="ts" module>
  export type ChartMode = import('@kotbo/ui/analytics').ChartMode;
  export type ChartMarker = import('@kotbo/ui/analytics').ChartMarker;
</script>

<script lang="ts">
  import { TimeSeriesChart as KotboTimeSeriesChart } from '@kotbo/ui/analytics';

  const {
    labels,
    mode,
    main = null,
    previous = null,
    smoothed = null,
    projection = null,
    stacks = [],
    markers = [],
    format = (v: number) => String(v),
    height = 280,
    onselect,
  }: {
    labels: string[];
    mode: ChartMode;
    main?: { label: string; values: (number | null)[]; color: string } | null;
    previous?: { label: string; values: (number | null)[] } | null;
    smoothed?: { label: string; values: (number | null)[] } | null;
    projection?: { label: string; values: (number | null)[]; low: (number | null)[]; high: (number | null)[] } | null;
    stacks?: Array<{ label: string; values: (number | null)[]; color: string }>;
    markers?: ChartMarker[];
    format?: (value: number) => string;
    height?: number;
    onselect?: (index: number) => void;
  } = $props();
</script>

<KotboTimeSeriesChart
  {labels}
  {mode}
  {main}
  {previous}
  {smoothed}
  {projection}
  {stacks}
  {markers}
  {format}
  {height}
  {onselect}
/>
