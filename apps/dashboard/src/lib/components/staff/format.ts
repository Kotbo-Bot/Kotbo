import { dateLocale, m } from '../../i18n';

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

/** « il y a 3 j », puis la date au-dela d'un mois. */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '';
  const future = diff < 0;
  const minutes = Math.max(1, Math.round(Math.abs(diff) / 60000));
  if (minutes >= 60 * 24 * 30) return formatDate(value);
  const unit =
    minutes < 60 ? m.sx_unit_min({ n: minutes })
    : minutes < 60 * 24 ? m.sx_unit_hour({ n: Math.round(minutes / 60) })
    : m.sx_unit_day({ n: Math.round(minutes / 1440) });
  return future ? m.sx_in({ d: unit }) : m.sx_ago({ d: unit });
}

/** Anciennete lisible : « 8 mois », « 1 an ». */
export function formatTenure(value: string | Date | null | undefined): string {
  if (!value) return '';
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days < 31) return m.sx_tenure_days({ n: days });
  if (days < 365) return m.sx_tenure_months({ n: Math.floor(days / 30.4) });
  return m.sx_tenure_years({ n: Math.floor(days / 365) });
}

export function formatNumber(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString(dateLocale());
}

/** Minutes de vocal en heures arrondies. */
export function formatVoice(minutes: number | null | undefined): string {
  const total = minutes ?? 0;
  if (total < 60) return m.sx_unit_min({ n: total });
  return m.sx_unit_hour({ n: Math.round(total / 60) });
}

/** Ecart de la semaine a la moyenne du mois, en pourcentage. */
export function weekTrend(avg7d: number, avg30d: number): number | null {
  if (!avg30d) return null;
  return Math.round(((avg7d - avg30d) / avg30d) * 100);
}
