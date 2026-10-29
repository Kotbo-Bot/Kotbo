import { m } from '../i18n';

export function typeLabel(value: string): string {
  if (value === 'WARN') return m.fmt_type_warn();
  if (value === 'KICK') return m.fmt_type_kick();
  if (value === 'TIMEOUT') return m.fmt_type_timeout();
  if (value === 'TEMP_BAN') return m.fmt_type_temp_ban();
  if (value === 'BAN') return m.fmt_type_ban();
  if (value === 'JAIL') return m.fmt_type_jail();
  return value;
}

export function statusLabel(value: string): string {
  if (value === 'ACTIVE') return 'Active';
  if (value === 'RESOLVED') return m.fmt_status_resolved();
  return m.fmt_status_failed();
}

export function durationLabel(seconds: number | null): string {
  if (!seconds) return 'N/A';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}j`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(' ') : `${seconds}s`;
}

export function toDateTimeLocal(value: string | null | undefined): string {
  if (!value) return new Date().toISOString().slice(0, 16);
  return new Date(value).toISOString().slice(0, 16);
}
