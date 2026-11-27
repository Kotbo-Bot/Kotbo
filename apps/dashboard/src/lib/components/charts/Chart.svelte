<script lang="ts">
  import { Chart as KotboChart } from '@kotbo/ui/analytics';
  import type { ChartTypeRegistry } from 'chart.js';
  import gradient from 'chartjs-plugin-gradient';

  // Le plugin lit `legend.legendItems[i].datasetIndex` sans verifier l'existence :
  // on saute le degrade cosmetique si la legende a moins d'items que de datasets.
  const safeGradient = {
    ...gradient,
    afterUpdate(chartInstance: any, args: any, opts: any) {
      const items = chartInstance.legend?.legendItems;
      const count = chartInstance.data?.datasets?.length ?? 0;
      if (!items || items.length < count || items.some((item: any) => !item)) return;
      try {
        (gradient as any).afterUpdate?.(chartInstance, args, opts);
      } catch {
        // legende sans degrade, sans consequence sur le rendu des datasets
      }
    },
  };

  const {
    data,
    type = 'line',
    options = {},
    height = 300,
    width = null as number | null,
    plugins = [] as any[],
    label = '',
  }: {
    data: any;
    type?: keyof ChartTypeRegistry;
    options?: any;
    height?: number;
    width?: number | null;
    plugins?: any[];
    label?: string;
  } = $props();
</script>

<KotboChart {data} {type} {options} {height} {width} plugins={[safeGradient, ...plugins]} {label} />
