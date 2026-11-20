<!--
  Courbe principale d'Analytics. Une seule mesure, un seul axe : la période
  d'avant en pointillés neutres, la moyenne mobile en trait plein (la série
  brute s'efface alors), la prévision en pointillés de la même couleur avec sa
  bande d'incertitude. En mode empilé, la mesure est découpée par salon ou
  catégorie, avec une légende.

  Les repères (notes et jours inhabituels) sont dessinés en traits verticaux
  fins, avec un symbole en tête : un rond pour une note, un triangle pour un
  pic ou un creux. L'infobulle du jour les liste en clair.
-->
<script lang="ts" module>
  /** `lines` : plusieurs séries côte à côte (segments comparés), sans empilement. */
  export type ChartMode = 'line' | 'bar' | 'stacked' | 'lines';

  export interface ChartMarker {
    index: number;
    tone: 'note' | 'up' | 'down';
    text: string;
  }
</script>

<script lang="ts">
  import Chart from '../charts/Chart.svelte';

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
    /** Clic sur un point de la courbe (position dans `labels`). */
    onselect?: (index: number) => void;
  } = $props();

  const BAND = '__band__';

  /** Transparence d'un jeton : le canvas ne lit que `rgba(var(--x), a)`, recomposé par Chart. */
  function alpha(color: string, a: number): string {
    const token = color.match(/^var\((--[\w-]+)\)$/);
    return token ? `rgba(var(${token[1]}), ${a})` : color;
  }

  function cssVar(name: string): string {
    if (typeof document === 'undefined') return '';
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const data = $derived.by(() => {
    if (stacks.length > 0) {
      if (mode === 'bar') {
        return {
          labels,
          datasets: stacks.map((s) => ({
            type: 'bar',
            label: s.label,
            data: s.values,
            backgroundColor: s.color,
            hoverBackgroundColor: s.color,
            borderRadius: 4,
            borderSkipped: 'bottom',
            maxBarThickness: 28,
          })),
        };
      }
      if (mode === 'stacked') {
        return {
          labels,
          datasets: stacks.map((s) => ({
            type: 'line',
            label: s.label,
            data: s.values,
            borderColor: 'var(--color-surface-container-low)',
            borderWidth: 1.5,
            backgroundColor: alpha(s.color, 0.75),
            fill: true,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointBackgroundColor: s.color,
            tension: 0.25,
            stack: 'total',
          })),
        };
      }
      return {
        labels,
        datasets: stacks.map((s) => ({
          type: 'line',
          label: s.label,
          data: s.values,
          borderColor: s.color,
          backgroundColor: s.color,
          borderWidth: 2,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.25,
        })),
      };
    }
    if (!main) return { labels, datasets: [] };

    const datasets: any[] = [];
    const faded = smoothed !== null;
    if (mode === 'bar') {
      datasets.push({
        type: 'bar',
        label: main.label,
        data: main.values,
        backgroundColor: main.color,
        hoverBackgroundColor: main.color,
        borderRadius: 4,
        borderSkipped: 'bottom',
        maxBarThickness: 28,
        ...(faded ? { backgroundColor: alpha(main.color, 0.4), hoverBackgroundColor: alpha(main.color, 0.55) } : {}),
        order: 3,
      });
    } else {
      datasets.push({
        type: 'line',
        label: main.label,
        data: main.values,
        borderColor: faded ? alpha(main.color, 0.4) : main.color,
        borderWidth: faded ? 1.5 : 2,
        backgroundColor: alpha(main.color, faded ? 0.04 : 0.1),
        fill: 'origin',
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: main.color,
        tension: 0.25,
        spanGaps: false,
        order: 3,
      });
    }
    if (smoothed) {
      datasets.push({
        type: 'line',
        label: smoothed.label,
        data: smoothed.values,
        borderColor: main.color,
        backgroundColor: main.color,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
        tension: 0.35,
        order: 2,
      });
    }
    if (previous) {
      datasets.push({
        type: 'line',
        label: previous.label,
        data: previous.values,
        borderColor: 'var(--series-neutral)',
        backgroundColor: 'var(--series-neutral)',
        borderDash: [5, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        tension: 0.25,
        order: 1,
      });
    }
    if (projection) {
      datasets.push(
        {
          type: 'line',
          label: BAND,
          data: projection.low,
          borderColor: 'transparent',
          backgroundColor: 'transparent',
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
          order: 5,
        },
        {
          type: 'line',
          label: BAND,
          data: projection.high,
          borderColor: 'transparent',
          backgroundColor: alpha(main.color, 0.14),
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: '-1',
          order: 5,
        },
        {
          type: 'line',
          label: projection.label,
          data: projection.values,
          borderColor: main.color,
          backgroundColor: main.color,
          borderDash: [3, 3],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false,
          tension: 0.25,
          order: 0,
        },
      );
    }
    return { labels, datasets };
  });

  const visibleDatasets = $derived(data.datasets.filter((d: any) => d.label !== BAND).length);

  const options = $derived({
    interaction: { mode: 'index', intersect: false },
    onClick: (_event: unknown, elements: Array<{ index: number }>, chart: any) => {
      if (!onselect) return;
      const index = elements[0]?.index ?? chart?.tooltip?.dataPoints?.[0]?.dataIndex;
      if (typeof index === 'number') onselect(index);
    },
    plugins: {
      legend: {
        display: visibleDatasets > 1,
        position: 'bottom',
        labels: {
          boxWidth: 10,
          boxHeight: 10,
          color: () => cssVar('--color-on-surface-variant'),
          filter: (item: { text: string }) => item.text !== BAND,
        },
      },
      tooltip: {
        filter: (item: { dataset: { label: string }; parsed: { y: number | null } }) =>
          item.dataset.label !== BAND && item.parsed.y !== null,
        callbacks: {
          label: (ctx: { dataset: { label: string }; parsed: { y: number } }) => `${ctx.dataset.label} : ${format(ctx.parsed.y)}`,
          footer: (items: Array<{ dataIndex: number }>) => {
            const index = items[0]?.dataIndex;
            return markers.filter((mk) => mk.index === index).map((mk) => mk.text);
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: () => cssVar('--color-outline-variant') },
        ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0, color: () => cssVar('--color-on-surface-variant'), font: { size: 11 } },
      },
      y: {
        beginAtZero: true,
        stacked: mode === 'stacked',
        border: { display: false },
        grid: { color: () => cssVar('--color-outline-variant'), drawTicks: false },
        ticks: { maxTicksLimit: 5, padding: 8, color: () => cssVar('--color-on-surface-variant'), font: { size: 11 }, callback: (v: number) => format(v) },
      },
    },
  });

  /** Traits verticaux des repères, avec un rond (note) ou un triangle (pic, creux) en tête. */
  const markerPlugin = $derived({
    id: 'analyticsMarkers',
    afterDatasetsDraw(chart: any) {
      if (markers.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      const ink = cssVar('--color-on-surface-variant') || '#71717a';
      const accent = cssVar('--color-primary') || '#6366f1';
      const surface = cssVar('--color-surface-container-low') || '#fff';
      const drawn = new Set<string>();
      for (const marker of markers) {
        const x = scales.x.getPixelForValue(marker.index);
        if (!Number.isFinite(x) || x < chartArea.left - 1 || x > chartArea.right + 1) continue;
        const key = `${marker.index}:${marker.tone === 'note' ? 'n' : 'a'}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const color = marker.tone === 'note' ? accent : ink;
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top + 8);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        const y = chartArea.top + (marker.tone === 'note' ? 4 : 14);
        ctx.beginPath();
        if (marker.tone === 'note') {
          ctx.arc(x, y, 4, 0, Math.PI * 2);
        } else if (marker.tone === 'up') {
          ctx.moveTo(x, y - 5);
          ctx.lineTo(x + 5, y + 4);
          ctx.lineTo(x - 5, y + 4);
          ctx.closePath();
        } else {
          ctx.moveTo(x, y + 5);
          ctx.lineTo(x + 5, y - 4);
          ctx.lineTo(x - 5, y - 4);
          ctx.closePath();
        }
        ctx.stroke();
        ctx.fill();
        ctx.restore();
      }
    },
  });

  // Le type de graphique, la mesure (son format) et les repères sont lus à la
  // création du graphique : on le recrée quand ils changent.
  const chartKey = $derived(`${mode}|${main?.label ?? ''}|${stacks.map((s) => s.label).join(',')}|${markers.map((mk) => `${mk.index}${mk.tone}`).join(',')}|${previous ? 1 : 0}${smoothed ? 1 : 0}${projection ? 1 : 0}`);
</script>

{#key chartKey}
  <Chart type={mode === 'bar' ? 'bar' : 'line'} {data} {options} {height} plugins={[markerPlugin]} />
{/key}
