<script lang="ts">
  import { Sparkline as KotboSparkline } from '@kotbo/ui/analytics';

  const {
    values,
    color = 'var(--series-1)',
    width = 72,
    height = 22,
    fill = true,
  }: {
    values: number[];
    color?: string;
    width?: number;
    height?: number;
    fill?: boolean;
  } = $props();
</script>

<KotboSparkline {values} {color} {width} {height} {fill} />
