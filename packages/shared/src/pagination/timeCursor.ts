/**
 * Curseur d'un historique trié du plus récent au plus ancien : date (ms) et id
 * de la dernière ligne affichée. La reprise se fait « sous » ce couple plutôt
 * que sur la ligne elle-même, qui a pu disparaître entre deux pages.
 */
const CURSOR_RE = /^(\d{1,15})_([A-Za-z0-9]{1,40})$/;

export function encodeTimeCursor(createdAt: Date, id: string): string {
  return `${createdAt.getTime()}_${id}`;
}

export function decodeTimeCursor(raw: string): { createdAt: Date; id: string } | null {
  const match = CURSOR_RE.exec(raw);
  if (!match) return null;
  const createdAt = new Date(Number(match[1]));
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: match[2] };
}
