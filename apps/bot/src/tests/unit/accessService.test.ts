import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';

// `accessService` importe le client Prisma au chargement du module ; seules les
// fonctions pures sont testées ici, la base n'est jamais touchée.
const mockDb = {
  guild: {
    findUnique: mock(() => Promise.resolve(null as unknown)),
    findMany: mock(() => Promise.resolve([] as unknown[])),
    update: mock(() => Promise.resolve({} as unknown)),
  },
  activationCode: {
    findFirst: mock(() => Promise.resolve(null as unknown)),
  },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

import {
  buildAccessFields,
  computeExpiry,
  dueReminder,
  expireAccess,
  formatDuration,
  minutesUntil,
  normalizeAccessGrant,
  reminderMilestones,
  MAX_ACCESS_DURATION_MINUTES,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
} from '../../services/system/accessService';

const MS_PER_MINUTE = 60_000;
const DAY = MINUTES_PER_DAY;
const HOUR = MINUTES_PER_HOUR;

describe('computeExpiry / minutesUntil', () => {
  test('une période de 15 jours se termine 15 jours après son démarrage', () => {
    const from = new Date('2026-07-28T10:00:00.000Z');
    expect(computeExpiry(15 * DAY, from).toISOString()).toBe('2026-08-12T10:00:00.000Z');
  });

  test('une période de 30 minutes se termine 30 minutes plus tard', () => {
    const from = new Date('2026-07-28T10:00:00.000Z');
    expect(computeExpiry(30, from).toISOString()).toBe('2026-07-28T10:30:00.000Z');
  });

  test('les minutes restantes sont arrondies au supérieur', () => {
    const now = new Date('2026-07-28T10:00:00.000Z');
    expect(minutesUntil(new Date(now.getTime() + 90 * MS_PER_MINUTE + 30_000), now)).toBe(91);
    expect(minutesUntil(new Date(now.getTime() + 90 * MS_PER_MINUTE), now)).toBe(90);
  });

  test('une échéance dépassée ne renvoie jamais de valeur négative', () => {
    const now = new Date('2026-07-28T10:00:00.000Z');
    expect(minutesUntil(new Date(now.getTime() - 5 * MS_PER_MINUTE), now)).toBe(0);
  });
});

describe('reminderMilestones', () => {
  test('une période de 15 jours notifie à mi-parcours, J-3 et J-1', () => {
    expect(reminderMilestones(15 * DAY)).toEqual([7 * DAY, 3 * DAY, DAY]);
  });

  test('les paliers s\'adaptent aux périodes courtes', () => {
    expect(reminderMilestones(30 * DAY)).toEqual([15 * DAY, 3 * DAY, DAY]);
    expect(reminderMilestones(7 * DAY)).toEqual([3 * DAY, DAY]);
    expect(reminderMilestones(2 * DAY)).toEqual([DAY]);
  });

  test('une période en minutes garde un rappel à mi-parcours', () => {
    // 30 min de test : les paliers en jours ne tiennent pas, seul le mi-parcours reste.
    expect(reminderMilestones(30)).toEqual([15]);
    expect(reminderMilestones(4 * HOUR)).toEqual([2 * HOUR]);
  });

  test('le palier de mi-parcours est arrondi à une unité lisible', () => {
    // 15 jours → 7 jours pile, pas « 7 jours 12 heures ».
    expect(reminderMilestones(15 * DAY)[0]).toBe(7 * DAY);
    // 5 heures → 2 heures pile, pas 2 h 30.
    expect(reminderMilestones(5 * HOUR)[0]).toBe(2 * HOUR);
  });

  test('une période d\'une minute n\'envoie aucun rappel, seulement le message de fin', () => {
    expect(reminderMilestones(1)).toEqual([]);
  });

  test('aucun palier en double', () => {
    expect(reminderMilestones(6 * DAY)).toEqual([3 * DAY, DAY]);
  });
});

describe('dueReminder', () => {
  const milestones = [7 * DAY, 3 * DAY, DAY];

  test('aucun rappel tant que le premier palier n\'est pas atteint', () => {
    expect(dueReminder(10 * DAY, milestones, []).milestone).toBeNull();
  });

  test('déclenche le palier atteint et le mémorise', () => {
    const result = dueReminder(7 * DAY, milestones, []);
    expect(result.milestone).toBe(7 * DAY);
    expect(result.sent).toEqual([7 * DAY]);
  });

  test('ne renvoie jamais deux fois le même palier', () => {
    expect(dueReminder(7 * DAY, milestones, [7 * DAY]).milestone).toBeNull();
    expect(dueReminder(6 * DAY, milestones, [7 * DAY]).milestone).toBeNull();
  });

  test('après un arrêt prolongé, envoie le bon message et solde les paliers dépassés', () => {
    const result = dueReminder(2 * DAY, milestones, []);
    expect(result.milestone).toBe(3 * DAY);
    expect(result.sent).toEqual([7 * DAY, 3 * DAY]);
  });

  test('fonctionne à l\'échelle de la minute', () => {
    const result = dueReminder(15, [15], []);
    expect(result.milestone).toBe(15);
  });
});

describe('formatDuration', () => {
  test('rend une durée lisible dans chaque unité', () => {
    expect(formatDuration(1)).toBe('1 minute');
    expect(formatDuration(30)).toBe('30 minutes');
    expect(formatDuration(HOUR)).toBe('1 heure');
    expect(formatDuration(2 * HOUR)).toBe('2 heures');
    expect(formatDuration(DAY)).toBe('1 jour');
    expect(formatDuration(15 * DAY)).toBe('15 jours');
  });

  test('compose deux unités quand le reste est significatif', () => {
    expect(formatDuration(90)).toBe('1 heure 30 minutes');
    expect(formatDuration(DAY + 12 * HOUR)).toBe('1 jour 12 heures');
  });

  test('traduit en anglais', () => {
    expect(formatDuration(30, 'en')).toBe('30 minutes');
    expect(formatDuration(15 * DAY, 'en')).toBe('15 days');
    expect(formatDuration(DAY, 'en')).toBe('1 day');
  });
});

describe('buildAccessFields', () => {
  const from = new Date('2026-07-28T10:00:00.000Z');

  test('un accès permanent n\'a pas de date de fin', () => {
    expect(buildAccessFields('PERMANENT', null, from)).toEqual({
      accessType: 'PERMANENT',
      accessExpiresAt: null,
      accessExpiredAt: null,
      accessDurationMinutes: null,
      accessRemindersSent: [],
    });
  });

  test('un essai pose la date de fin et retient sa durée', () => {
    const fields = buildAccessFields('TRIAL', 15 * DAY, from);
    expect(fields.accessType).toBe('TRIAL');
    expect(fields.accessExpiresAt?.toISOString()).toBe('2026-08-12T10:00:00.000Z');
    expect(fields.accessDurationMinutes).toBe(15 * DAY);
    expect(fields.accessRemindersSent).toEqual([]);
  });

  test('une période de 30 minutes est traitée comme n\'importe quelle autre', () => {
    const fields = buildAccessFields('TRIAL', 30, from);
    expect(fields.accessExpiresAt?.toISOString()).toBe('2026-07-28T10:30:00.000Z');
    expect(fields.accessDurationMinutes).toBe(30);
  });

  test('une durée nulle ou négative retombe sur un accès permanent', () => {
    expect(buildAccessFields('TRIAL', 0, from).accessType).toBe('PERMANENT');
    expect(buildAccessFields('TRIAL', -5, from).accessExpiresAt).toBeNull();
  });
});

describe('normalizeAccessGrant', () => {
  test('sans type explicite, l\'accès est permanent', () => {
    expect(normalizeAccessGrant(undefined, undefined)).toEqual({ accessType: 'PERMANENT', durationMinutes: null });
  });

  test('accepte un essai avec une durée entière en minutes', () => {
    expect(normalizeAccessGrant('trial', 30)).toEqual({ accessType: 'TRIAL', durationMinutes: 30 });
    expect(normalizeAccessGrant('SUBSCRIPTION', String(30 * DAY))).toEqual({
      accessType: 'SUBSCRIPTION',
      durationMinutes: 30 * DAY,
    });
  });

  test('refuse une durée absente, non entière ou hors bornes', () => {
    expect(normalizeAccessGrant('TRIAL', undefined)).toHaveProperty('error');
    expect(normalizeAccessGrant('TRIAL', 0)).toHaveProperty('error');
    expect(normalizeAccessGrant('TRIAL', 1.5)).toHaveProperty('error');
    expect(normalizeAccessGrant('TRIAL', MAX_ACCESS_DURATION_MINUTES + 1)).toHaveProperty('error');
  });

  test('refuse un type inconnu', () => {
    expect(normalizeAccessGrant('LIFETIME', 30)).toHaveProperty('error');
  });
});

describe('expireAccess', () => {
  test('un essai termine repasse le serveur en gratuit sans le desactiver', async () => {
    // Depuis le freemium, la fin d'un essai ferme les modules payants, pas la
    // moderation : le serveur ne doit pas perdre son activation.
    mockDb.guild.findUnique.mockImplementation(() => Promise.resolve({
      activated: true,
      accessType: 'TRIAL',
      accessExpiresAt: new Date(Date.now() - 60_000),
      accessExpiredAt: null,
      accessDurationMinutes: 15 * DAY,
      accessRemindersSent: [],
    }));
    mockDb.guild.update.mockClear();

    const client = { guilds: { fetch: () => Promise.resolve(null) } };
    await expireAccess(client as never, '123');

    const writes = mockDb.guild.update.mock.calls.map((call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data);
    expect(writes).toContainEqual({ plan: 'FREE' });
    expect(writes.some((data) => data.activated === false)).toBe(false);
  });
});
