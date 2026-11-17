/**
 * Alternative textuelle d'un graphique (RGAA 1.1, 1.10) : un canvas Chart.js
 * n'expose rien aux lecteurs d'ecran. Les memes donnees, en tableau, leur
 * donnent l'information que la courbe donne a l'oeil.
 */
type Point = { x?: unknown; y?: unknown } | number | null | undefined;
type ChartDataLike = {
  labels?: unknown[];
  datasets?: { label?: string; data?: Point[] }[];
};

export type ChartTable = {
  series: string[];
  rows: { label: string; values: string[] }[];
};

function valueOf(point: Point): unknown {
  return point !== null && typeof point === 'object' ? point.y : point;
}

export function chartTable(data: ChartDataLike | undefined, format: (n: number) => string): ChartTable {
  const datasets = data?.datasets ?? [];
  if (datasets.length === 0) return { series: [], rows: [] };

  const first = datasets[0].data ?? [];
  const labels = data?.labels?.length
    ? data.labels
    : first.map((point) => (point !== null && typeof point === 'object' ? point.x : ''));

  const cell = (value: unknown) =>
    value === null || value === undefined ? '' : typeof value === 'number' ? format(value) : String(value);

  return {
    series: datasets.map((dataset, i) => dataset.label || String(i + 1)),
    rows: labels.map((label, row) => ({
      label: String(label ?? ''),
      values: datasets.map((dataset) => cell(valueOf(dataset.data?.[row]))),
    })),
  };
}
