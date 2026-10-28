/**
 * Colonnes d'un jour : les evenements qui se chevauchent se partagent la
 * largeur, chacun dans la premiere colonne libre, comme dans Outlook.
 */
export function layoutDay(events: Array<{ key: string; start: number; end: number }>) {
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end);
  const result = new Map<string, { col: number; cols: number }>();
  let cluster: typeof sorted = [];
  let columns: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    for (const e of cluster) result.set(e.key, { col: result.get(e.key)!.col, cols: columns.length });
    cluster = [];
    columns = [];
  };

  for (const e of sorted) {
    if (e.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    let col = columns.findIndex((end) => end <= e.start);
    if (col === -1) {
      col = columns.length;
      columns.push(e.end);
    } else {
      columns[col] = e.end;
    }
    result.set(e.key, { col, cols: 0 });
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  flush();
  return result;
}
