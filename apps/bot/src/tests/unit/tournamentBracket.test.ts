import { describe, expect, test } from 'bun:test';
import {
  buildTournament,
  findMatch,
  normalizeScore,
  readTournamentSettings,
  seedOrder,
  type Entrant,
  type StoredResult,
  type TournamentView,
} from '../../services/features/tournament/bracket.js';

const players = (n: number): Entrant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, name: `Joueur ${i + 1}`, seed: i + 1, members: [] }));

/** Joue tous les matchs prêts : la meilleure tête de série gagne 2-0. */
function playAll(settings: ReturnType<typeof readTournamentSettings>, entrants: Entrant[]): { view: TournamentView; results: StoredResult[] } {
  const results: StoredResult[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const view = buildTournament(settings, entrants, results);
    const ready = view.stages.flatMap((s) => s.rounds.flat()).filter((m) => m.status === 'ready');
    if (!ready.length) return { view, results };
    for (const m of ready) {
      const oneWins = m.player1!.seed < m.player2!.seed;
      results.push({
        stage: m.stage, round: m.round, position: m.position,
        player1Id: m.player1!.id, player2Id: m.player2!.id,
        score1: oneWins ? 2 : 0, score2: oneWins ? 0 : 2, sets: null,
      });
    }
  }
  throw new Error('tournoi sans fin');
}

describe('moteur de tournoi', () => {
  test('ordre classique des têtes de série (1-16, 8-9, 4-13…)', () => {
    expect(seedOrder(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
  });

  test('élimination directe à 5 : les 3 meilleures têtes de série sont exemptées', () => {
    const view = buildTournament(readTournamentSettings({}), players(5), []);
    const first = view.stages[0].rounds[0];
    expect(first.filter((m) => m.status === 'bye')).toHaveLength(3);
    expect(first.filter((m) => m.status === 'ready').map((m) => [m.player1!.seed, m.player2!.seed])).toEqual([[4, 5]]);
  });

  test('élimination directe jouée jusqu au bout : champion et places', () => {
    const { view } = playAll(readTournamentSettings({ tournament: { thirdPlace: true } }), players(8));
    expect(view.champion?.seed).toBe(1);
    const place = Object.fromEntries(view.standings.map((r) => [r.entrant.seed, r.placement]));
    expect(place).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 5, 7: 5, 8: 5 });
  });

  test('double élimination à 8 : perdants repêchés, grande finale, 3e en tête de l arbre des perdants', () => {
    const { view } = playAll(readTournamentSettings({ tournament: { format: 'DOUBLE' } }), players(8));
    expect(view.stages.map((s) => [s.id, s.rounds.length])).toEqual([['W', 3], ['L', 4], ['GF', 1]]);
    expect(view.champion?.seed).toBe(1);
    const place = Object.fromEntries(view.standings.map((r) => [r.entrant.seed, r.placement]));
    expect(place[2]).toBe(2);
    expect(place[3]).toBe(3);
    expect(place[8]).toBe(7);
  });

  test('double élimination avec exemptions : le tournoi se termine', () => {
    const { view } = playAll(readTournamentSettings({ tournament: { format: 'DOUBLE' } }), players(6));
    expect(view.champion?.seed).toBe(1);
    expect(view.standings.every((r) => r.placement !== null)).toBe(true);
  });

  test('poules puis phase finale', () => {
    const settings = readTournamentSettings({ tournament: { format: 'GROUPS', groupCount: 2, groupQualifiers: 2 } });
    const before = buildTournament(settings, players(8), []);
    expect(before.stages.filter((s) => s.kind === 'group').map((s) => s.rounds.flat().length)).toEqual([6, 6]);
    expect(before.stages.find((s) => s.id === 'PO')!.rounds[0].every((m) => m.status === 'waiting')).toBe(true);

    const { view } = playAll(settings, players(8));
    expect(view.champion?.seed).toBe(1);
    // Serpentin : 1, 4, 5, 8 en poule A ; les deux premiers de chaque poule passent.
    expect(view.stages[0].table!.map((r) => r.entrant.seed)).toEqual([1, 4, 5, 8]);
    const place = Object.fromEntries(view.standings.map((r) => [r.entrant.seed, r.placement]));
    expect(place[5]).toBe(5);
    expect(place[8]).toBe(7);
  });

  test('un score en aval devient caduc si le résultat en amont change', () => {
    const settings = readTournamentSettings({});
    const results: StoredResult[] = [
      { stage: 'W', round: 1, position: 0, player1Id: 'u1', player2Id: 'u4', score1: 0, score2: 2, sets: null },
      { stage: 'W', round: 1, position: 1, player1Id: 'u2', player2Id: 'u3', score1: 2, score2: 0, sets: null },
      { stage: 'W', round: 2, position: 0, player1Id: 'u1', player2Id: 'u2', score1: 2, score2: 1, sets: null },
    ];
    const view = buildTournament(settings, players(4), results);
    const final = findMatch(view, 'W', 2, 0)!;
    expect(final.player1?.seed).toBe(4);
    expect(final.status).toBe('ready');
    expect(view.champion).toBeNull();
  });

  test('validation des scores et du détail des manches', () => {
    const view = buildTournament(readTournamentSettings({}), players(2), []);
    const match = findMatch(view, 'W', 1, 0)!;
    expect(normalizeScore(match, { score1: 2, score2: 1 }, false)).toEqual({ score1: 2, score2: 1, sets: null });
    expect('error' in normalizeScore(match, { score1: 2, score2: 2 }, false)).toBe(true);
    expect('error' in normalizeScore(match, { score1: 3, score2: 0 }, false)).toBe(true);
    expect(normalizeScore(match, { sets: [[11, 7], [9, 11], [11, 4]] }, true)).toEqual({ score1: 2, score2: 1, sets: [[11, 7], [9, 11], [11, 4]] });
    expect('error' in normalizeScore(match, { sets: [[5, 5]] }, true)).toBe(true);
  });
});
