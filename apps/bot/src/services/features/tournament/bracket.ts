/**
 * Moteur des tournois, sans base ni Discord : à partir des têtes de série et
 * des scores enregistrés, il recalcule tout le tableau (qui joue quel match,
 * qui avance, qui est éliminé) et le classement.
 *
 * Un score n'est retenu que si les deux joueurs enregistrés avec lui sont
 * toujours ceux du match : corriger un résultat en amont rend les matchs
 * suivants caducs sans rien avoir à effacer.
 */

export const TOURNAMENT_FORMATS = ['SINGLE', 'DOUBLE', 'GROUPS'] as const;
export type TournamentFormat = (typeof TOURNAMENT_FORMATS)[number];
export const BEST_OF_VALUES = [1, 3, 5, 7] as const;

export type TournamentSettings = {
  format: TournamentFormat;
  bestOf: number;
  /** BO de la finale (grande finale en double élimination). null = même BO que le reste. */
  finalBestOf: number | null;
  /** Saisie du score de chaque manche, pas seulement des manches gagnées. */
  setDetail: boolean;
  /** Petite finale entre les perdants des demi-finales. */
  thirdPlace: boolean;
  /** 1 = joueurs seuls ; au-delà, équipes de cette taille, capitaine compris. */
  teamSize: number;
  groupCount: number;
  /** Qualifiés par poule pour la phase finale ; 0 = les poules suffisent. */
  groupQualifiers: number;
  /** 0 = pas de limite d'inscrits. */
  maxEntries: number;
};

export type Entrant = { id: string; name: string; seed: number; members: string[] };

export type StoredResult = {
  stage: string;
  round: number;
  position: number;
  player1Id: string;
  player2Id: string;
  score1: number;
  score2: number;
  sets: unknown;
};

export type MatchStatus = 'waiting' | 'ready' | 'live' | 'done' | 'bye';

export type MatchView = {
  stage: string;
  round: number;
  position: number;
  number: number;
  bestOf: number;
  player1: Entrant | null;
  player2: Entrant | null;
  score1: number;
  score2: number;
  sets: [number, number][] | null;
  winner: 1 | 2 | null;
  status: MatchStatus;
};

export type GroupRow = { entrant: Entrant; rank: number; wins: number; losses: number; setsWon: number; setsLost: number };

export type StageView = {
  /** W, L, GF, P3, PO ou G0..Gn. */
  id: string;
  kind: 'bracket' | 'group';
  rounds: MatchView[][];
  table?: GroupRow[];
};

export type StandingRow = {
  entrant: Entrant;
  /** null = encore en lice. */
  placement: number | null;
  wins: number;
  losses: number;
  setsWon: number;
  setsLost: number;
};

export type TournamentView = {
  settings: TournamentSettings;
  entrants: Entrant[];
  stages: StageView[];
  standings: StandingRow[];
  champion: Entrant | null;
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const isBestOf = (value: unknown): value is number => BEST_OF_VALUES.includes(Number(value) as 1);

/** Lit `Event.config.tournament`, rempli par l'éditeur : toute valeur absente ou fausse prend son défaut. */
export function readTournamentSettings(config: unknown): TournamentSettings {
  const root = config && typeof config === 'object' ? (config as Record<string, unknown>).tournament : null;
  const raw = (root && typeof root === 'object' ? root : {}) as Record<string, unknown>;
  return {
    format: TOURNAMENT_FORMATS.includes(raw.format as TournamentFormat) ? (raw.format as TournamentFormat) : 'SINGLE',
    bestOf: isBestOf(raw.bestOf) ? Number(raw.bestOf) : 3,
    finalBestOf: isBestOf(raw.finalBestOf) ? Number(raw.finalBestOf) : null,
    setDetail: raw.setDetail === true,
    thirdPlace: raw.thirdPlace === true,
    teamSize: clampInt(raw.teamSize, 1, 10, 1),
    groupCount: clampInt(raw.groupCount, 1, 16, 2),
    groupQualifiers: clampInt(raw.groupQualifiers, 0, 8, 2),
    maxEntries: clampInt(raw.maxEntries, 0, 256, 0),
  };
}

export const winsNeeded = (bestOf: number) => Math.floor(bestOf / 2) + 1;

/** Ordre classique des têtes de série : 1-16, 8-9, 4-13… pour que les meilleures se croisent le plus tard. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((seed) => [seed, next + 1 - seed]);
  }
  return order;
}

const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/** Une place du tableau : un joueur connu, une place vide (exemption) ou un vainqueur encore inconnu. */
type Slot = { entrant: Entrant | null; known: boolean };
const EMPTY: Slot = { entrant: null, known: true };
const PENDING: Slot = { entrant: null, known: false };
const filled = (entrant: Entrant): Slot => ({ entrant, known: true });

function parseSets(raw: unknown): [number, number][] | null {
  if (!Array.isArray(raw)) return null;
  const sets = raw.filter((s): s is [number, number] => Array.isArray(s) && s.length === 2 && s.every((n) => Number.isInteger(n) && n >= 0));
  return sets.length ? sets : null;
}

class Context {
  number = 0;
  readonly results: Map<string, StoredResult>;
  /** Plus la clé est haute, plus le joueur est allé loin ; absente = encore en lice. */
  readonly elimination = new Map<string, number>();

  constructor(results: StoredResult[]) {
    this.results = new Map(results.map((r) => [`${r.stage}:${r.round}:${r.position}`, r]));
  }

  play(stage: string, round: number, position: number, a: Slot, b: Slot, bestOf: number) {
    const match: MatchView = {
      stage, round, position, number: ++this.number, bestOf,
      player1: a.entrant, player2: b.entrant,
      score1: 0, score2: 0, sets: null, winner: null, status: 'waiting',
    };
    if (!a.known || !b.known) return { match, winner: PENDING, loser: PENDING };
    if (!a.entrant || !b.entrant) {
      match.status = 'bye';
      return { match, winner: a.entrant ? a : b, loser: EMPTY };
    }

    const stored = this.results.get(`${stage}:${round}:${position}`);
    if (!stored || stored.player1Id !== a.entrant.id || stored.player2Id !== b.entrant.id) {
      match.status = 'ready';
      return { match, winner: PENDING, loser: PENDING };
    }
    match.score1 = stored.score1;
    match.score2 = stored.score2;
    match.sets = parseSets(stored.sets);
    const need = winsNeeded(bestOf);
    if (stored.score1 >= need && stored.score1 > stored.score2) match.winner = 1;
    else if (stored.score2 >= need && stored.score2 > stored.score1) match.winner = 2;
    if (!match.winner) {
      match.status = 'live';
      return { match, winner: PENDING, loser: PENDING };
    }
    match.status = 'done';
    return match.winner === 1 ? { match, winner: a, loser: b } : { match, winner: b, loser: a };
  }

  eliminate(slot: Slot, key: number) {
    if (slot.entrant) this.elimination.set(slot.entrant.id, key);
  }
}

/** Arbre à élimination directe sur des places déjà rangées (longueur en puissance de 2). */
function eliminationStage(ctx: Context, stage: string, slots: Slot[], bestOf: number, finalBestOf: number | null) {
  const rounds: MatchView[][] = [];
  const losers: Slot[][] = [];
  const total = Math.log2(slots.length);
  let current = slots;
  for (let round = 1; round <= total; round++) {
    const matches: MatchView[] = [];
    const next: Slot[] = [];
    const roundLosers: Slot[] = [];
    const roundBestOf = round === total && finalBestOf ? finalBestOf : bestOf;
    for (let p = 0; p < current.length / 2; p++) {
      const result = ctx.play(stage, round, p, current[2 * p], current[2 * p + 1], roundBestOf);
      matches.push(result.match);
      next.push(result.winner);
      roundLosers.push(result.loser);
    }
    rounds.push(matches);
    losers.push(roundLosers);
    current = next;
  }
  return { rounds, champion: current[0], losers };
}

/** Élimination directe classique (arbre principal ou phase finale après les poules). */
function knockout(ctx: Context, stage: string, slots: Slot[], settings: TournamentSettings, keyOffset: number): StageView[] {
  const main = eliminationStage(ctx, stage, slots, settings.bestOf, settings.finalBestOf);
  const total = main.rounds.length;
  main.losers.forEach((roundLosers, i) => roundLosers.forEach((slot) => ctx.eliminate(slot, keyOffset + i + 1)));
  ctx.eliminate(main.champion, keyOffset + total + 1);
  const stages: StageView[] = [{ id: stage, kind: 'bracket', rounds: main.rounds }];

  if (settings.thirdPlace && total >= 2) {
    const semiLosers = main.losers[total - 2];
    const third = ctx.play('P3', 1, 0, semiLosers[0], semiLosers[1], settings.bestOf);
    // Le vainqueur passe juste au-dessus du perdant, qui garde sa clé de demi-finaliste.
    ctx.eliminate(third.winner, keyOffset + total - 0.5);
    stages.push({ id: 'P3', kind: 'bracket', rounds: [[third.match]] });
  }
  return stages;
}

function bracketSlots(entrants: Entrant[]): Slot[] {
  const bySeed = new Map(entrants.map((e) => [e.seed, e]));
  const size = nextPowerOfTwo(Math.max(...entrants.map((e) => e.seed)));
  return seedOrder(size).map((seed) => {
    const entrant = bySeed.get(seed);
    return entrant ? filled(entrant) : EMPTY;
  });
}

function doubleElimination(ctx: Context, entrants: Entrant[], settings: TournamentSettings): StageView[] {
  const winners = eliminationStage(ctx, 'W', bracketSlots(entrants), settings.bestOf, null);
  const k = winners.losers.length;
  const rounds: MatchView[][] = [];
  let current = winners.losers[0];

  // Arbre des perdants : un tour entre rescapés, puis un tour où arrivent les
  // perdants du tour suivant de l'arbre principal, croisés pour éviter les revanches.
  const playRound = (pairs: [Slot, Slot][]) => {
    const round = rounds.length + 1;
    const matches: MatchView[] = [];
    current = pairs.map(([a, b], p) => {
      const result = ctx.play('L', round, p, a, b, settings.bestOf);
      matches.push(result.match);
      ctx.eliminate(result.loser, round);
      return result.winner;
    });
    rounds.push(matches);
  };
  const pairUp = () => playRound(Array.from({ length: current.length / 2 }, (_, p) => [current[2 * p], current[2 * p + 1]]));

  if (k >= 2) {
    pairUp();
    for (let j = 2; j <= k; j++) {
      const drops = [...winners.losers[j - 1]].reverse();
      playRound(current.map((slot, p) => [slot, drops[p]]));
      if (j < k) pairUp();
    }
  }

  const final = ctx.play('GF', 1, 0, winners.champion, current[0], settings.finalBestOf ?? settings.bestOf);
  ctx.eliminate(final.loser, rounds.length + 1);
  ctx.eliminate(final.winner, rounds.length + 2);
  return [
    { id: 'W', kind: 'bracket', rounds: winners.rounds },
    { id: 'L', kind: 'bracket', rounds },
    { id: 'GF', kind: 'bracket', rounds: [[final.match]] },
  ];
}

/** Toutes les rencontres d'une poule, journée par journée (méthode du cercle). */
function roundRobin(members: Entrant[]): [Entrant, Entrant][][] {
  const list: (Entrant | null)[] = members.length % 2 ? [...members, null] : [...members];
  const days: [Entrant, Entrant][][] = [];
  for (let day = 0; day < list.length - 1; day++) {
    const pairs: [Entrant, Entrant][] = [];
    for (let i = 0; i < list.length / 2; i++) {
      const a = list[i];
      const b = list[list.length - 1 - i];
      if (a && b) pairs.push([a, b]);
    }
    days.push(pairs);
    list.splice(1, 0, list.pop()!);
  }
  return days;
}

type Tally = { wins: number; losses: number; setsWon: number; setsLost: number };

function tally(matches: MatchView[]): Map<string, Tally> {
  const totals = new Map<string, Tally>();
  const get = (id: string) => totals.get(id) ?? totals.set(id, { wins: 0, losses: 0, setsWon: 0, setsLost: 0 }).get(id)!;
  for (const m of matches) {
    if (m.status !== 'done' || !m.player1 || !m.player2) continue;
    const one = get(m.player1.id);
    const two = get(m.player2.id);
    one.setsWon += m.score1; one.setsLost += m.score2;
    two.setsWon += m.score2; two.setsLost += m.score1;
    if (m.winner === 1) { one.wins++; two.losses++; } else { two.wins++; one.losses++; }
  }
  return totals;
}

const byRecord = (totals: Map<string, Tally>) => (a: Entrant, b: Entrant) => {
  const ta = totals.get(a.id) ?? { wins: 0, losses: 0, setsWon: 0, setsLost: 0 };
  const tb = totals.get(b.id) ?? { wins: 0, losses: 0, setsWon: 0, setsLost: 0 };
  return tb.wins - ta.wins
    || (tb.setsWon - tb.setsLost) - (ta.setsWon - ta.setsLost)
    || tb.setsWon - ta.setsWon
    || a.seed - b.seed;
};

function groupStage(ctx: Context, entrants: Entrant[], settings: TournamentSettings): StageView[] {
  const sorted = [...entrants].sort((a, b) => a.seed - b.seed);
  const groupCount = Math.min(settings.groupCount, Math.max(1, Math.floor(sorted.length / 2)));
  // Répartition en serpentin : A B C C B A… pour équilibrer le niveau des poules.
  const groups: Entrant[][] = Array.from({ length: groupCount }, () => []);
  sorted.forEach((entrant, i) => {
    const lap = Math.floor(i / groupCount);
    const index = i % groupCount;
    groups[lap % 2 ? groupCount - 1 - index : index].push(entrant);
  });

  const stages: StageView[] = [];
  const ranked: Entrant[][] = [];
  let allComplete = true;
  groups.forEach((members, g) => {
    const stage = `G${g}`;
    const rounds = roundRobin(members).map((pairs, day) =>
      pairs.map(([a, b], p) => ctx.play(stage, day + 1, p, filled(a), filled(b), settings.bestOf).match),
    );
    const matches = rounds.flat();
    const totals = tally(matches);
    const order = [...members].sort(byRecord(totals));
    const complete = matches.every((m) => m.status === 'done');
    allComplete &&= complete;
    ranked.push(order);
    stages.push({
      id: stage,
      kind: 'group',
      rounds,
      table: order.map((entrant, i) => ({ entrant, rank: i + 1, ...(totals.get(entrant.id) ?? { wins: 0, losses: 0, setsWon: 0, setsLost: 0 }) })),
    });
  });

  const qualifiers = Math.min(settings.groupQualifiers, Math.min(...groups.map((g) => g.length)));
  const playoffSize = qualifiers * groupCount;
  // Tant que les poules tournent, personne n'a de place et la phase finale reste en attente.
  if (allComplete) {
    // Hors phase finale, la place dépend du rang dans la poule, à égalité entre poules.
    ranked.forEach((order) => order.forEach((entrant, rank) => {
      if (rank >= qualifiers || playoffSize < 2) ctx.elimination.set(entrant.id, -(rank * groupCount) - 1);
    }));
  }

  if (playoffSize >= 2) {
    // A1, B1, C1… puis A2, B2… : les premiers de poule prennent les meilleures têtes de série.
    const seeded = Array.from({ length: qualifiers }, (_, rank) => ranked.map((order) => order[rank])).flat();
    const size = nextPowerOfTwo(playoffSize);
    const slots = seedOrder(size).map((seed) => {
      if (seed > playoffSize) return EMPTY;
      return allComplete ? filled(seeded[seed - 1]) : PENDING;
    });
    stages.push(...knockout(ctx, 'PO', slots, settings, 0));
  }
  return stages;
}

/** Recalcule tout le tournoi. `entrants` ne contient que les inscrits qui ont une tête de série. */
export function buildTournament(settings: TournamentSettings, entrants: Entrant[], results: StoredResult[]): TournamentView {
  const ctx = new Context(results);
  let stages: StageView[] = [];
  if (entrants.length >= 2) {
    if (settings.format === 'DOUBLE') stages = doubleElimination(ctx, entrants, settings);
    else if (settings.format === 'GROUPS') stages = groupStage(ctx, entrants, settings);
    else stages = knockout(ctx, 'W', bracketSlots(entrants), settings, 0);
  }

  const totals = tally(stages.flatMap((s) => s.rounds.flat()));
  const keys = ctx.elimination;

  // Place = 1 + joueurs allés plus loin, en comptant ceux encore en lice : ils finiront devant.
  const placement = (entrant: Entrant): number | null => {
    const key = keys.get(entrant.id);
    if (key === undefined) return null;
    return 1 + entrants.filter((other) => {
      const otherKey = keys.get(other.id);
      return otherKey === undefined || otherKey > key;
    }).length;
  };

  const standings = entrants
    .map((entrant) => ({ entrant, placement: placement(entrant), ...(totals.get(entrant.id) ?? { wins: 0, losses: 0, setsWon: 0, setsLost: 0 }) }))
    .sort((a, b) => (a.placement ?? 0) - (b.placement ?? 0) || byRecord(totals)(a.entrant, b.entrant));

  const leaders = standings.filter((row) => row.placement === 1);
  return { settings, entrants, stages, standings, champion: leaders.length === 1 ? leaders[0].entrant : null };
}

/**
 * Vérifie un score saisi pour un match. Avec le détail des manches, les manches
 * gagnées s'en déduisent. Renvoie l'erreur à afficher, ou le score à enregistrer.
 */
export function normalizeScore(
  match: MatchView,
  input: { score1?: unknown; score2?: unknown; sets?: unknown },
  setDetail: boolean,
): { error: string } | { score1: number; score2: number; sets: [number, number][] | null } {
  if (!match.player1 || !match.player2 || match.status === 'waiting' || match.status === 'bye') {
    return { error: 'Ce match ne peut pas encore être joué.' };
  }
  const need = winsNeeded(match.bestOf);
  let score1: number;
  let score2: number;
  let sets: [number, number][] | null = null;

  if (setDetail && Array.isArray(input.sets)) {
    sets = [];
    for (const set of input.sets) {
      const [a, b] = Array.isArray(set) ? set.map(Number) : [];
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 999 || b > 999) return { error: 'Chaque manche doit avoir deux scores entiers.' };
      if (a === b) return { error: 'Une manche ne peut pas finir à égalité.' };
      sets.push([a, b]);
    }
    if (sets.length > match.bestOf) return { error: `Un BO${match.bestOf} se joue en ${match.bestOf} manche(s) au plus.` };
    score1 = sets.filter(([a, b]) => a > b).length;
    score2 = sets.length - score1;
  } else {
    score1 = Number(input.score1);
    score2 = Number(input.score2);
  }

  if (!Number.isInteger(score1) || !Number.isInteger(score2) || score1 < 0 || score2 < 0 || score1 > need || score2 > need || (score1 === need && score2 === need)) {
    return { error: `Score invalide : en BO${match.bestOf}, le vainqueur gagne ${need} manche(s).` };
  }
  return { score1, score2, sets };
}

export function findMatch(view: TournamentView, stage: string, round: number, position: number): MatchView | null {
  return view.stages.find((s) => s.id === stage)?.rounds[round - 1]?.find((m) => m.position === position) ?? null;
}
