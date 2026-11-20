const MINUTE_MS = 60 * 1000;

/**
 * Échéance future en temps relatif (« dans 12 minutes », « dans 3 heures »). Arrondie
 * au-dessus en minutes, au plus proche en heures : un drop dû dans 30 secondes ne
 * s'annonce pas « dans 0 minute ». L'échéance passée est laissée à l'appelant, qui sait
 * ce qui retient le drop.
 */
export function dropCountdown(nextAt: Date, now: Date, locale: string): string {
  const minutes = Math.max(1, Math.ceil((nextAt.getTime() - now.getTime()) / MINUTE_MS));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  return minutes < 60 ? format.format(minutes, 'minute') : format.format(Math.round(minutes / 60), 'hour');
}
