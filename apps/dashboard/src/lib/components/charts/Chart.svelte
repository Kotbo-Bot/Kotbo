<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { m, dateLocale } from '../../i18n';
  import { chartTable, nearestHeadingText } from '../../chartTable';
  // `chart.js/auto` enregistre l'integralite des controleurs (radar, bubble,
  // scatter, polarArea, echelles temporelles...) et empeche toute elimination
  // de code mort. Ce composant est le seul point d'entree de chart.js du
  // dashboard, et seuls trois types y sont utilises : bar, line et doughnut.
  // On n'enregistre donc que ce qui sert reellement.
  //
  // Si un nouveau type de graphe est introduit, il faut ajouter son controleur
  // (et ses elements/echelles) ci-dessous, sinon Chart.js leve une erreur
  // explicite du type "bubble is not a registered controller".
  import {
    Chart,
    ArcElement,
    BarController,
    BarElement,
    CategoryScale,
    DoughnutController,
    Filler,
    Legend,
    LineController,
    LineElement,
    LinearScale,
    PointElement,
    Title,
    Tooltip,
    type ChartConfiguration,
    type ChartTypeRegistry,
  } from 'chart.js';
  import gradient from 'chartjs-plugin-gradient';

  // Le plugin lit `legend.legendItems[i].datasetIndex` pour chaque dataset sans
  // verifier que l'item existe. Quand la legende a moins d'items que de
  // datasets (items filtres, doughnut, legende vide), il leve
  // "s is undefined" et fait tomber toute la page. Le degrade de legende est
  // cosmetique : on le saute plutot que de perdre le graphe.
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

  Chart.register(
    BarController,
    BarElement,
    LineController,
    LineElement,
    PointElement,
    DoughnutController,
    ArcElement,
    CategoryScale,
    LinearScale,
    Filler, // requis par les datasets `fill: true`
    Legend,
    Title,
    Tooltip,
  );

  const { 
    data, 
    type = 'line', 
    options = {}, 
    height = 300,
    width = null as number | null,
    plugins = [] as any[],
    label = ''
  } = $props<{
    data: any;
    type?: keyof ChartTypeRegistry;
    options?: any;
    height?: number;
    width?: number | null;
    /** Plugins Chart.js propres à ce graphique (repères, annotations). */
    plugins?: any[];
    /** Ce que montre le graphique : legende du tableau qui le remplace pour les lecteurs d'ecran. */
    label?: string;
  }>();

  const number = new Intl.NumberFormat(dateLocale());
  const table = $derived(chartTable(data, (n) => number.format(n)));

  // Sans `label`, le titre de la carte qui contient le graphique sert de legende.
  let container = $state<HTMLDivElement | null>(null);
  let headingLabel = $state('');
  $effect(() => {
    if (container) headingLabel = nearestHeadingText(container);
  });

  let canvas = $state<HTMLCanvasElement | null>(null);
  let chart = $state<Chart | null>(null);

  // Series sans couleur : Chart.js n'enregistre pas ici son plugin `Colors`, et
  // retombe alors sur rgba(0, 0, 0, 0.1) - les graphiques sortaient en noir.
  const PALETTE = [
    'var(--color-primary)',
    'var(--color-tertiary)',
    '#0891b2',
    'var(--color-success)',
    'var(--color-warning)',
    '#db2777',
    'var(--color-error)',
  ];
  const PALETTE_FALLBACK = '#6366f1';

  const COLOR_KEYS = [
    'borderColor',
    'backgroundColor',
    'pointBackgroundColor',
    'pointBorderColor',
    'hoverBackgroundColor',
    'hoverBorderColor',
  ] as const;

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  let probe: CanvasRenderingContext2D | null = null;

  /** Composantes RGB de n'importe quelle couleur CSS, lues sur un pixel de canvas. */
  function toRgb(color: string): [number, number, number] {
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!probe) return [99, 102, 241];
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#6366f1';
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  }

  function withAlpha(color: string, alpha: number): string {
    const [r, g, b] = toRgb(color);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Le canvas ne lit pas les variables CSS : `var(--x)` y vaut du noir. Les
   * jetons valant des hex, `rgb(var(--x))` et `rgba(var(--x), a)` - la forme
   * des anciennes variables en triplets - ne sont pas valides non plus, meme en
   * CSS : on les recompose avec l'alpha demande.
   */
  function resolveColor(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(resolveColor);
    if (typeof value !== 'string' || !value.includes('var(')) return value;

    const wrapped = value.match(/^rgba?\(\s*var\((--[\w-]+)\)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (wrapped) {
      const base = cssVar(wrapped[1]);
      return withAlpha(base || PALETTE_FALLBACK, wrapped[2] ? Number(wrapped[2]) : 1);
    }
    return value.replace(/var\((--[\w-]+)\)/g, (_, name) => cssVar(name) || PALETTE_FALLBACK);
  }

  function paletteColor(index: number): string {
    return resolveColor(PALETTE[index % PALETTE.length]) as string;
  }

  function hasColor(dataset: any): boolean {
    return dataset.borderColor != null || dataset.backgroundColor != null || !!dataset.gradient;
  }

  function prepareData(raw: any) {
    const snapped = $state.snapshot(raw) as any;
    const circular = type === 'doughnut' || type === 'pie';

    return {
      ...snapped,
      datasets: (snapped?.datasets || []).map((dataset: any, index: number) => {
        const d = { ...dataset };

        if (!hasColor(d)) {
          if (circular) {
            d.backgroundColor = (d.data || []).map((_: unknown, i: number) => paletteColor(i));
            d.borderWidth ??= 0;
          } else {
            const color = paletteColor(index);
            d.borderColor = color;
            d.backgroundColor = type === 'bar' ? withAlpha(color, 0.8) : withAlpha(color, 0.12);
            d.pointBackgroundColor ??= color;
            if (type === 'bar') d.borderRadius ??= 4;
          }
        }

        for (const key of COLOR_KEYS) {
          if (d[key] != null) d[key] = resolveColor(d[key]);
        }

        const gradientColors = d.gradient?.backgroundColor?.colors;
        if (gradientColors) {
          const colors: Record<string, unknown> = {};
          for (const key in gradientColors) colors[key] = resolveColor(gradientColors[key]);
          d.gradient = {
            ...d.gradient,
            backgroundColor: { ...d.gradient.backgroundColor, colors },
          };
        }

        return d;
      }),
    };
  }

  function initChart() {
    if (!canvas) return;

    if (chart) {
      chart.destroy();
    }

    const isDark = document.documentElement.classList.contains('dark');
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';

    // Resolu a chaque (re)creation : le theme change les valeurs des jetons.
    const processedData = prepareData(data);

    const verticalLinePlugin = {
      id: 'verticalLine',
      afterDatasetsDraw: (chartInstance: any) => {
        if (type !== 'line' && type !== 'bar') return;
        
        const activeElements = chartInstance.tooltip?.getActiveElements();
        if (activeElements && activeElements.length > 0) {
          const activePoint = activeElements[0];
          const ctx = chartInstance.ctx;
          const x = activePoint.element.x;
          const topY = chartInstance.scales.y.top;
          const bottomY = chartInstance.scales.y.bottom;

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x, topY);
          ctx.lineTo(x, bottomY);
          ctx.lineWidth = 1.5;
          const isDark = document.documentElement.classList.contains('dark');
          ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.15)';
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.restore();
        }
      }
    };

    const config: ChartConfiguration = {
      type: type as any,
      data: processedData,
      plugins: [safeGradient, verticalLinePlugin, ...plugins],
      options: {

        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: 'index',
        },
        animation: {
          duration: 800,
          easing: 'easeOutQuart'
        },
        scales: (type === 'doughnut' || type === 'pie') ? undefined : {
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: textColor,
              font: {
                family: 'Inter, sans-serif',
                size: 10,
                weight: 'bold'
              },
              autoSkip: true,
              maxRotation: 0
            }
          },
          y: {
            grid: {
              color: gridColor,
              drawTicks: false,
            },
            border: {
               dash: [4, 4],
               display: false
            },
            ticks: {
              color: textColor,
              font: {
                family: 'Inter, sans-serif',
                size: 10,
                weight: 'bold'
              },
              callback: (value: any) => {
                if (value >= 1000) return (value / 1000) + 'k';
                return value;
              }
            }
          }
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            enabled: true,
            backgroundColor: isDark ? 'rgba(15, 23, 42, 0.9)' : 'rgba(255, 255, 255, 0.9)',
            titleColor: isDark ? '#f8fafc' : '#0f172a',
            bodyColor: isDark ? '#f8fafc' : '#0f172a',
            borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
            borderWidth: 1,
            padding: 12,
            cornerRadius: 12,
            displayColors: true,
            usePointStyle: true,
            boxWidth: 6,
            boxHeight: 6,
            boxPadding: 6,
            titleFont: {
              family: 'Manrope, sans-serif',
              size: 12,
              weight: '800'
            },
            bodyFont: {
              family: 'Inter, sans-serif',
              size: 13,
              weight: '600'
            },
            callbacks: {
              label: (context) => {
                let label = context.dataset.label || '';
                if (label) label += ': ';
                if (context.parsed.y !== null) {
                  label += context.parsed.y.toLocaleString('fr-FR');
                }
                return label;
              }
            }
          }
        },
        ...options
      }
    };

    chart = new Chart(canvas, config);
  }

  $effect(() => {
    if (data && chart) {
      chart.data = prepareData(data);
      chart.update();
    }
  });

  onMount(() => {
    initChart();
    
    // Watch for dark mode changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          initChart();
        }
      });
    });
    
    observer.observe(document.documentElement, { attributes: true });
    
    return () => observer.disconnect();
  });

  onDestroy(() => {
    if (chart) chart.destroy();
  });
</script>

<div bind:this={container} class="chart-container" style="height: {height}px; width: {width ? width + 'px' : '100%'}">
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>
{#if table.rows.length > 0}
  <!-- Le div porte le masquage : un <caption> echappe au clip d'une <table> sr-only et s'affichait en double sous le graphique. -->
  <div class="sr-only">
  <table>
    <caption>{label || headingLabel || m.chart_data_caption()}</caption>
    <thead>
      <tr>
        <th scope="col">{m.chart_data_label()}</th>
        {#each table.series as serie, i (i)}<th scope="col">{serie}</th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each table.rows as row, r (r)}
        <tr>
          <th scope="row">{row.label}</th>
          {#each row.values as value, i (i)}<td>{value}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
  </div>
{/if}

<style>
  .chart-container {
    position: relative;
    width: 100%;
  }
</style>

