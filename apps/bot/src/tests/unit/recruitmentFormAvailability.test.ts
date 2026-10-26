import { describe, expect, test } from 'bun:test';
import { decideFormAvailability } from '../../services/staff/recruitmentFormAvailability.js';

const base = { isActive: true, autoClosedReason: null, pending: 0, accepted: 0, maxPending: 3, maxAccepted: 2 };

describe('decideFormAvailability', () => {
  test('sous les plafonds, le poste reste ouvert', () => {
    expect(decideFormAvailability({ ...base, pending: 2, accepted: 1 })).toEqual({ isActive: true, autoClosedReason: null });
  });

  test('ferme à X candidatures en attente, puis rouvre quand l’une est tranchée', () => {
    const closed = decideFormAvailability({ ...base, pending: 3 });
    expect(closed).toEqual({ isActive: false, autoClosedReason: 'PENDING' });
    expect(decideFormAvailability({ ...base, ...closed, pending: 2 })).toEqual({ isActive: true, autoClosedReason: null });
  });

  test('le plafond d’acceptés ferme et ne se lève pas en tranchant', () => {
    const closed = decideFormAvailability({ ...base, accepted: 2 });
    expect(closed).toEqual({ isActive: false, autoClosedReason: 'ACCEPTED' });
    expect(decideFormAvailability({ ...base, ...closed, accepted: 2, pending: 0 })).toEqual(closed);
  });

  test('un poste fermé à la main n’est jamais rouvert par le bot', () => {
    expect(decideFormAvailability({ ...base, isActive: false, autoClosedReason: null })).toEqual({ isActive: false, autoClosedReason: null });
  });

  test('sans plafond, rien ne ferme', () => {
    expect(decideFormAvailability({ ...base, maxPending: null, maxAccepted: null, pending: 99, accepted: 99 }).isActive).toBe(true);
  });
});
