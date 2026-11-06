import { describe, expect, test } from 'bun:test';
import { pickRecentAuditEntry } from '../../events/auditEntryMatch';

const NOW = 1_000_000;
const LOOKBACK = 12_000;

describe('pickRecentAuditEntry', () => {
  test('rend l’entrée récente qui vise la cible, avec sa raison', () => {
    const entry = pickRecentAuditEntry(
      [
        { createdTimestamp: NOW - 1_000, targetId: 'autre', reason: null },
        { createdTimestamp: NOW - 2_000, targetId: 'membre', reason: 'Menu de rôles « Couleurs »' },
      ],
      'membre',
      NOW,
      LOOKBACK,
    );

    expect(entry?.reason).toBe('Menu de rôles « Couleurs »');
  });

  test('ignore une entrée trop ancienne : ce serait une autre action', () => {
    expect(pickRecentAuditEntry([{ createdTimestamp: NOW - LOOKBACK - 1, targetId: 'membre' }], 'membre', NOW, LOOKBACK))
      .toBeUndefined();
  });

  test('sans cible demandée, la plus récente des entrées de la fenêtre suffit', () => {
    const entry = pickRecentAuditEntry([{ createdTimestamp: NOW, targetId: 'x', reason: 'r' }], null, NOW, LOOKBACK);

    expect(entry?.reason).toBe('r');
  });
});
