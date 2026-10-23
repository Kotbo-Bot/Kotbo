import { describe, expect, test } from 'bun:test';
import {
  ConflictTracker,
  CooldownGate,
  HarassmentTracker,
  decideToxicity,
  isDistress,
  isHeated,
} from '../../services/moderation/aegis/aegisSignals';

const thresholds = { reviewThreshold: 80, autoThreshold: 95 };

describe('decideToxicity', () => {
  test('trois zones', () => {
    expect(decideToxicity(0.6825, thresholds, false)).toBe('none');
    expect(decideToxicity(0.8966, thresholds, false)).toBe('review');
    expect(decideToxicity(0.959, thresholds, false)).toBe('auto');
  });

  test('une note en retard ne supprime plus, elle part en revue', () => {
    expect(decideToxicity(0.99, thresholds, true)).toBe('review');
  });

  test("un membre exempté est noté, mais jamais sanctionné d'office", () => {
    expect(decideToxicity(0.99, thresholds, false, true)).toBe('review');
    expect(decideToxicity(0.85, thresholds, false, true)).toBe('review');
    expect(decideToxicity(0.1, thresholds, false, true)).toBe('none');
  });
});

describe('isHeated', () => {
  test('toxique ou en colère nette', () => {
    expect(isHeated(0.85, undefined, 80)).toBe(true);
    expect(isHeated(0.1, { label: 'anger', score: 0.81 }, 80)).toBe(true);
    expect(isHeated(0.1, { label: 'anger', score: 0.6 }, 80)).toBe(false);
    expect(isHeated(undefined, { label: 'joy', score: 0.99 }, 80)).toBe(false);
  });
});

describe('isDistress', () => {
  const t = { distressThreshold: 95, reviewThreshold: 80 };
  test('tristesse ou peur très marquée', () => {
    expect(isDistress({ label: 'sad', score: 0.9773 }, 0.0374, t)).toBe(true);
    expect(isDistress({ label: 'fear', score: 0.96 }, undefined, t)).toBe(true);
    expect(isDistress({ label: 'sad', score: 0.9 }, 0.03, t)).toBe(false);
    expect(isDistress({ label: 'anger', score: 0.99 }, 0.03, t)).toBe(false);
  });

  test("une insulte notée « sad » n'est pas de la détresse", () => {
    // « sale noir » : sad 0,93 et toxicité 0,96.
    expect(isDistress({ label: 'sad', score: 0.99 }, 0.9617, t)).toBe(false);
  });
});

describe('ConflictTracker', () => {
  const opts = { windowMs: 120_000, threshold: 4, cooldownMs: 600_000 };

  test('il faut au moins deux membres', () => {
    const tracker = new ConflictTracker();
    for (let i = 0; i < 6; i += 1) expect(tracker.record('c', 'a', i * 1000, opts).triggered).toBe(false);
  });

  test('se déclenche, puis se tait pendant le mode lent', () => {
    const tracker = new ConflictTracker();
    tracker.record('c', 'a', 0, opts);
    tracker.record('c', 'b', 1000, opts);
    tracker.record('c', 'a', 2000, opts);
    const fired = tracker.record('c', 'b', 3000, opts);
    expect(fired).toEqual({ triggered: true, authors: ['a', 'b'], count: 4 });
    for (let i = 0; i < 5; i += 1) expect(tracker.record('c', i % 2 ? 'a' : 'b', 4000 + i, opts).triggered).toBe(false);
  });

  test('les messages sortis de la fenêtre ne comptent plus', () => {
    const tracker = new ConflictTracker();
    tracker.record('c', 'a', 0, opts);
    tracker.record('c', 'b', 1000, opts);
    tracker.record('c', 'a', 2000, opts);
    expect(tracker.record('c', 'b', 200_000, opts).triggered).toBe(false);
  });
});

describe('HarassmentTracker', () => {
  test('alerte au seuil puis repart de zéro', () => {
    const tracker = new HarassmentTracker();
    const opts = { windowMs: 1_800_000, threshold: 3 };
    expect(tracker.record('a>b', 0, opts).triggered).toBe(false);
    expect(tracker.record('a>b', 1, opts).triggered).toBe(false);
    expect(tracker.record('a>b', 2, opts)).toEqual({ triggered: true, count: 3 });
    expect(tracker.record('a>b', 3, opts).triggered).toBe(false);
  });
});

describe('CooldownGate', () => {
  test('une alerte par période', () => {
    const gate = new CooldownGate();
    expect(gate.tryPass('u', 0, 1000)).toBe(true);
    expect(gate.tryPass('u', 500, 1000)).toBe(false);
    expect(gate.tryPass('u', 1000, 1000)).toBe(true);
  });
});
