import { toLocalInputValue } from '../../datetimeLocal';

// Un datetime-local porte une heure murale sans fuseau, que le bot (process en UTC)
// relirait comme de l'UTC. Une valeur qui n'est pas une date passe telle quelle.
function mapDate(value: unknown, convert: (d: Date) => string): unknown {
  const d = typeof value === 'string' ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? convert(d) : value;
}

export const toLocalDateInput = (value: unknown) => mapDate(value, toLocalInputValue);
export const toUtcIso = (value: unknown) => mapDate(value, (d) => d.toISOString());
