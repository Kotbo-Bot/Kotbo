/**
 * Utilitaires d'export JSON et CSV côté dashboard.
 */

export interface ExportColumn<T> {
  label: string;
  value: (row: T) => unknown;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw = Array.isArray(value)
    ? value.join(', ')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  triggerDownload(blob, filename.endsWith('.json') ? filename : `${filename}.json`);
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const headerLine = headers.map(formatCsvCell).join(',');
  const lines = rows.map((row) => row.map(formatCsvCell).join(','));
  const blob = new Blob(['\uFEFF' + [headerLine, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

export function exportRows<T>(
  format: 'csv' | 'json',
  filenameBase: string,
  items: T[],
  columns: ExportColumn<T>[],
  rawOverride?: unknown,
) {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `${filenameBase}_${stamp}`;
  if (format === 'json') {
    downloadJson(name, rawOverride ?? items);
    return;
  }
  const headers = columns.map((col) => col.label);
  const rows = items.map((item) => columns.map((col) => col.value(item)));
  downloadCsv(name, headers, rows);
}
