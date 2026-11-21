import { afterAll, describe, expect, test } from 'bun:test';
import { toLocalInputValue } from './datetimeLocal';

// `bun test` tourne en UTC, où le décalage est nul et le défaut invisible.
const fuseauAvant = process.env.TZ;
afterAll(() => {
  if (fuseauAvant === undefined) delete process.env.TZ;
  else process.env.TZ = fuseauAvant;
});

describe('départ d\'une campagne', () => {
  test('le champ affiche l\'heure locale de l\'organisateur', () => {
    process.env.TZ = 'Europe/Paris';
    expect(toLocalInputValue(new Date('2026-01-15T17:00:00.000Z'))).toBe('2026-01-15T18:00');
    expect(toLocalInputValue(new Date('2026-07-15T17:00:00.000Z'))).toBe('2026-07-15T19:00');

    process.env.TZ = 'America/New_York';
    expect(toLocalInputValue(new Date('2026-01-15T17:00:00.000Z'))).toBe('2026-01-15T12:00');
  });

  test.each(['Europe/Paris', 'America/New_York', 'Asia/Tokyo'])(
    '%s : ouvrir puis enregistrer sans rien changer garde le même départ',
    (fuseau) => {
      process.env.TZ = fuseau;
      for (const startAt of ['2026-01-15T17:00:00.000Z', '2026-07-15T06:30:00.000Z']) {
        expect(new Date(toLocalInputValue(new Date(startAt))).toISOString()).toBe(startAt);
      }
    },
  );
});
