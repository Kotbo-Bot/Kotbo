import { API_BASE_URL, dashboardRequest } from './client';

/** Miroir de apps/bot/src/services/features/tournament/bracket.ts. */
export type TournamentFormat = 'SINGLE' | 'DOUBLE' | 'GROUPS';

export type TournamentSettings = {
  format: TournamentFormat;
  bestOf: number;
  finalBestOf: number | null;
  setDetail: boolean;
  thirdPlace: boolean;
  teamSize: number;
  groupCount: number;
  groupQualifiers: number;
  maxEntries: number;
};

export type Entrant = { id: string; name: string; seed: number; members: string[] };

export type MatchStatus = 'waiting' | 'ready' | 'live' | 'done' | 'bye';

export type TournamentMatch = {
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

export type TournamentStage = {
  id: string;
  kind: 'bracket' | 'group';
  rounds: TournamentMatch[][];
  table?: GroupRow[];
};

export type StandingRow = {
  entrant: Entrant;
  placement: number | null;
  wins: number;
  losses: number;
  setsWon: number;
  setsLost: number;
};

export type Tournament = {
  event: { id: string; guildId: string; title: string; description: string | null; status: string };
  registrations: number;
  seeded: boolean;
  settings: TournamentSettings;
  entrants: Entrant[];
  stages: TournamentStage[];
  standings: StandingRow[];
  champion: Entrant | null;
};

export type PublicTournament = Tournament & { guildName: string; guildIcon: string | null };

export const DEFAULT_TOURNAMENT_SETTINGS: TournamentSettings = {
  format: 'SINGLE',
  bestOf: 3,
  finalBestOf: null,
  setDetail: false,
  thirdPlace: false,
  teamSize: 1,
  groupCount: 2,
  groupQualifiers: 2,
  maxEntries: 0,
};

export async function fetchTournament(eventId: string) {
  const data = await dashboardRequest<{ tournament: Tournament }>(`/events/${eventId}/tournament`);
  return data?.tournament ?? null;
}

async function tournamentWrite(eventId: string, path: string, method: string, payload?: unknown) {
  const data = await dashboardRequest<{ tournament: Tournament }>(`/events/${eventId}/tournament${path}`, {
    method,
    payload,
    errorContext: 'Tournoi',
  });
  return data?.tournament ?? null;
}

export const generateTournament = (eventId: string, shuffle: boolean) => tournamentWrite(eventId, '/generate', 'POST', { shuffle });
export const resetTournament = (eventId: string) => tournamentWrite(eventId, '/reset', 'POST');
export const swapTournamentSeeds = (eventId: string, seedA: number, seedB: number) => tournamentWrite(eventId, '/swap', 'POST', { seedA, seedB });

const matchPath = (m: Pick<TournamentMatch, 'stage' | 'round' | 'position'>) => `/matches/${m.stage}/${m.round}/${m.position}`;
export const saveTournamentMatch = (
  eventId: string,
  match: TournamentMatch,
  score: { score1: number; score2: number } | { sets: [number, number][] },
) => tournamentWrite(eventId, matchPath(match), 'PUT', score);
export const clearTournamentMatch = (eventId: string, match: TournamentMatch) => tournamentWrite(eventId, matchPath(match), 'DELETE');

/** null : tournoi absent, privé (brouillon) ou module éteint. */
export async function fetchPublicTournament(guildId: string, eventId: string): Promise<PublicTournament | null> {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/tournaments/${encodeURIComponent(eventId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Impossible de charger le tournoi. Réessaie.');
  }
  return response.json();
}

export function tournamentPublicPath(guildId: string, eventId: string) {
  return `/${guildId}/tournaments/${eventId}`;
}
