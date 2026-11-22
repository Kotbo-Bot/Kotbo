import { afterAll, describe, expect, test } from 'bun:test';
import { toLocalDateInput, toUtcIso } from './eventDates';

// `bun test` tourne en UTC, où le décalage est nul et le défaut invisible.
const fuseauAvant = process.env.TZ;
afterAll(() => {
  if (fuseauAvant === undefined) delete process.env.TZ;
  else process.env.TZ = fuseauAvant;
});

describe('heures d’un événement', () => {
  test('le champ affiche l’heure locale de l’organisateur et l’envoi repart en UTC', () => {
    process.env.TZ = 'Europe/Paris';
    expect(toLocalDateInput('2026-07-14T19:00:00.000Z')).toBe('2026-07-14T21:00');
    expect(toUtcIso('2026-07-14T21:00')).toBe('2026-07-14T19:00:00.000Z');
  });
});
