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

/** `Node.DOCUMENT_POSITION_PRECEDING`, sans dependre du global `Node`. */
const PRECEDING = 2;

/**
 * Legende par defaut : le titre le plus proche qui precede le graphique, en
 * remontant quelques niveaux (le titre de sa carte, en pratique). Les appelants
 * n'ont alors rien a passer pour que le tableau soit identifiable.
 */
export function nearestHeadingText(element: Element, maxDepth = 6): string {
  let scope: Element | null = element.parentElement;
  for (let depth = 0; scope && depth < maxDepth; depth++, scope = scope.parentElement) {
    const before = [...scope.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(
      (heading) => element.compareDocumentPosition(heading) & PRECEDING,
    );
    const last = before.at(-1);
    if (last) return last.textContent?.trim() ?? '';
  }
  return '';
}
