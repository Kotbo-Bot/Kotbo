/** Formatage partage par les pages de la console admin. */

const integer = new Intl.NumberFormat('fr-FR');
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

export const formatNumber = (value: number): string => integer.format(Math.round(value));

/** 1 240 reste lisible tel quel ; au-dela de 10 000 on passe a « 12,4 k ». */
export const formatCompact = (value: number): string => (Math.abs(value) < 10_000 ? formatNumber(value) : compact.format(value));

export function formatVoice(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${formatCompact(minutes / 60)} h`;
}

export function formatPercent(part: number, whole: number, digits = 0): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(digits).replace('.', ',')} %` : '–';
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDay(t: number): string {
  return new Date(t).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'jamais';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return days < 60 ? `il y a ${days} j` : `il y a ${Math.round(days / 30)} mois`;
}

/** Variation en pourcentage ; null quand la reference est vide. */
export function delta(current: number, previous: number): number | null {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

export const dayStart = (dateKey: string): number => Date.parse(`${dateKey}T00:00:00Z`);
