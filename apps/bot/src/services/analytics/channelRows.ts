/**
 * Messages par salon, regroupés par id.
 *
 * L'historique garde le nom qu'avait le salon au moment du message : un salon
 * renommé ressort en plusieurs lignes pour un même id. Sans fusion, il compte
 * deux fois dans un classement et sa clé est en double à l'affichage.
 */
export interface ChannelCountRow {
  channelId: string;
  channelName: string;
  count: number;
}

export function mergeChannelRows(rows: readonly ChannelCountRow[], limit: number): ChannelCountRow[] {
  const byId = new Map<string, { row: ChannelCountRow; bestNameCount: number }>();
  for (const row of rows) {
    const entry = byId.get(row.channelId);
    if (!entry) {
      byId.set(row.channelId, { row: { ...row }, bestNameCount: row.count });
      continue;
    }
    entry.row.count += row.count;
    if (row.count > entry.bestNameCount) {
      entry.row.channelName = row.channelName;
      entry.bestNameCount = row.count;
    }
  }
  return [...byId.values()]
    .map((entry) => entry.row)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
