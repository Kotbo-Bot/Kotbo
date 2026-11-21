/**
 * Événements : un quiz prêt à être lancé (questions suivante / précédente /
 * fin, avec des réponses fictives qui arrivent), un CTF en cours et un tournoi
 * en inscriptions. Formes de `routes/dashboard/events.ts` et `eventService.ts`.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, PEOPLE, ago, channelByName } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';

type Question = Record<string, any> & { id: string; status: 'DRAFT' | 'ONGOING' | 'COMPLETED'; options: string[]; correctOptionIndex: number; sortOrder: number; text: string };
type EventRow = Record<string, any> & { id: string; type: string; status: string; questions: Question[]; ctfChallenges: any[]; participants: any[]; registrations: any[] };

const players = () => PEOPLE.filter((p) => !p.bot).slice(1, 12);

const question = (eventId: string, n: number, text: string, options: string[], correct: number): Question =>
  row('EventQuizQuestion', { id: `${eventId}-q${n}`, eventId, text, options, correctOptionIndex: correct, sortOrder: n }) as Question;

function participant(eventId: string, p: (typeof PEOPLE)[number], score: number, minutes: number | null) {
  return { ...row('EventParticipant', { id: `${eventId}-p-${p.id}`, eventId, userId: p.id, guildId: DEMO_GUILD_ID, userTag: p.username, username: p.displayName, score, lastSolveAt: minutes === null ? null : ago(minutes) }), profile: null };
}

function seed(): EventRow[] {
  const quiz: EventRow = {
    ...row('Event', { id: 'event-quiz', title: 'Quiz culture jeu vidéo', description: '10 questions, 20 secondes chacune. Le top 3 gagne des pièces.', type: 'QUIZ', status: 'DRAFT', channelId: channelByName('général').id, config: { secondsPerQuestion: 20, rewards: [500, 250, 100] }, createdAt: ago(2 * DAY) }),
    questions: [
      question('event-quiz', 0, 'Quel studio a créé The Legend of Zelda ?', ['Sega', 'Nintendo', 'Capcom', 'Square Enix'], 1),
      question('event-quiz', 1, 'En quelle année est sorti Minecraft (version complète) ?', ['2009', '2011', '2013', '2015'], 1),
      question('event-quiz', 2, 'Combien de joueurs par équipe en match classé de Valorant ?', ['4', '5', '6', '3'], 1),
      question('event-quiz', 3, 'Quel Pokémon porte le numéro 25 ?', ['Évoli', 'Salamèche', 'Pikachu', 'Rondoudou'], 2),
      question('event-quiz', 4, 'Dans Among Us, comment s’appellent les traîtres ?', ['Les espions', 'Les imposteurs', 'Les saboteurs', 'Les loups'], 1),
    ],
    ctfChallenges: [],
    participants: [],
    registrations: [],
  };
  const ctf: EventRow = {
    ...row('Event', { id: 'event-ctf', title: 'CTF de novembre', description: 'Cinq défis web et crypto, du facile au très dur.', type: 'CTF', status: 'ONGOING', channelId: channelByName('général').id, createdAt: ago(5 * DAY) }),
    questions: [],
    ctfChallenges: [
      row('EventCtfChallenge', { id: 'ctf-1', eventId: 'event-ctf', title: 'Bienvenue', description: 'Le flag est caché dans le règlement.', flag: 'NOVA{bienvenue}', points: 50, sortOrder: 0 }),
      row('EventCtfChallenge', { id: 'ctf-2', eventId: 'event-ctf', title: 'Base64 en folie', description: 'Tm9wZSwgcGFzIGljaQ==', flag: 'NOVA{b64}', points: 150, sortOrder: 1 }),
      row('EventCtfChallenge', { id: 'ctf-3', eventId: 'event-ctf', title: 'Injection polie', description: 'Le formulaire de connexion a l’air fragile.', flag: 'NOVA{sqli}', points: 300, xpReward: 200, sortOrder: 2 }),
    ],
    participants: players().slice(0, 7).map((p, i) => participant('event-ctf', p, 500 - i * 60, 60 * (i + 1))),
    registrations: [],
  };
  const tournament: EventRow = {
    ...row('Event', { id: 'event-tournoi', title: 'Tournoi d’automne (3v3)', description: 'Élimination directe, finale en direct vendredi.', type: 'TOURNAMENT', status: 'SCHEDULED', channelId: channelByName('annonces').id, config: { teamSize: 3, maxTeams: 8 }, createdAt: ago(8 * DAY) }),
    questions: [],
    ctfChallenges: [],
    participants: [],
    registrations: [
      { id: 'reg-1', eventId: 'event-tournoi', userId: players()[5].id, username: players()[5].displayName, teamName: 'Les Licornes', teamMemberIds: [players()[6].id, players()[7].id], answers: {}, status: 'CONFIRMED', createdAt: ago(3 * DAY) },
      { id: 'reg-2', eventId: 'event-tournoi', userId: players()[2].id, username: players()[2].displayName, teamName: 'Team Zen', teamMemberIds: [players()[3].id, players()[8].id], answers: {}, status: 'CONFIRMED', createdAt: ago(2 * DAY) },
      { id: 'reg-3', eventId: 'event-tournoi', userId: players()[9].id, username: players()[9].displayName, teamName: 'Les Nouveaux', teamMemberIds: [players()[10].id], answers: {}, status: 'PENDING', createdAt: ago(DAY) },
    ],
  };
  const past: EventRow = {
    ...row('Event', { id: 'event-old', title: 'Blind test d’octobre', description: null, type: 'QUIZ', status: 'COMPLETED', createdAt: ago(30 * DAY) }),
    questions: [question('event-old', 0, 'Quel jeu utilise ce thème ?', ['Tetris', 'Mario', 'Sonic', 'Pac-Man'], 0)].map((q) => ({ ...q, status: 'COMPLETED' as const })),
    ctfChallenges: [],
    participants: players().slice(0, 9).map((p, i) => participant('event-old', p, 900 - i * 90, 30 * DAY)),
    registrations: [],
  };
  return [quiz, ctf, tournament, past];
}

const KEY = 'events';
const events = () => demoDb.get(KEY, seed);
const save = (list: EventRow[]) => demoDb.set(KEY, list);
const summary = ({ questions, ctfChallenges, participants, registrations, ...e }: EventRow) => ({
  ...e,
  _count: { questions: questions.length, ctfChallenges: ctfChallenges.length, participants: participants.length, registrations: registrations.length },
});
const find = (id: string) => events().find((e) => e.id === id);
const change = (id: string, fn: (e: EventRow) => EventRow) => {
  let next: EventRow | undefined;
  save(events().map((e) => (e.id === id ? (next = fn(e)) : e)));
  return next;
};

/** Les joueurs répondent à la question en cours : de quoi voir le graphique bouger. */
function answer(e: EventRow): EventRow {
  const current = e.questions.find((q) => q.status === 'ONGOING');
  if (!current) return e;
  const scores = new Map(e.participants.map((p) => [p.userId, p.score]));
  players().forEach((p, i) => {
    const right = (i + current.sortOrder) % 3 !== 0;
    if (right) scores.set(p.id, (scores.get(p.id) ?? 0) + 100 - i * 5);
    else if (!scores.has(p.id)) scores.set(p.id, 0);
  });
  return { ...e, participants: players().map((p) => participant(e.id, p, scores.get(p.id) ?? 0, 1)).sort((a, b) => b.score - a.score) };
}

function quizStats(e: EventRow) {
  const current = e.questions.find((q) => q.status === 'ONGOING') ?? [...e.questions].reverse().find((q) => q.status === 'COMPLETED');
  if (!current) return null;
  const responses = players().map((p, i) => {
    const right = (i + current.sortOrder) % 3 !== 0;
    const optionIndex = right ? current.correctOptionIndex : (current.correctOptionIndex + 1 + (i % 3)) % current.options.length;
    return { userId: p.id, userTag: p.username, optionIndex, responseTimeMs: 2_000 + i * 900, isCorrect: right };
  });
  const distribution: Record<number, number> = {};
  current.options.forEach((_, i) => (distribution[i] = responses.filter((r) => r.optionIndex === i).length));
  return {
    questionId: current.id,
    questionText: current.text,
    distribution,
    options: current.options,
    latestResponses: responses.slice(0, 5).map((r) => ({ userId: r.userId, userTag: r.userTag, optionIndex: r.optionIndex, optionLabel: current.options[r.optionIndex], isCorrect: r.isCorrect, questionId: current.id, questionText: current.text })),
    responses,
  };
}

export function registerEventRoutes(): void {
  const base = `${G}/events`;
  route('GET', base, () => ({ events: events().map(summary) }));
  route('POST', base, ({ body }) => {
    const event: EventRow = { ...row('Event', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, status: 'DRAFT' }), questions: [], ctfChallenges: [], participants: [], registrations: [] };
    save([event, ...events()]);
    return { event };
  });
  route('GET', `${base}/:eventId`, ({ params }) => ({ event: find(params.eventId) ?? null }));
  route('PATCH', `${base}/:eventId`, ({ params, body }) => {
    const event = change(params.eventId, (e) => {
      const next = { ...e, ...(body ?? {}) };
      if (Array.isArray(body?.questions)) next.questions = body.questions.map((q: Record<string, unknown>, i: number) => ({ ...question(e.id, i, String(q.text ?? ''), (q.options as string[]) ?? [], Number(q.correctOptionIndex ?? 0)), ...q, id: (q.id as string) ?? `${e.id}-q${demoId()}`, sortOrder: i }));
      if (Array.isArray(body?.ctfChallenges)) next.ctfChallenges = body.ctfChallenges.map((c: Record<string, unknown>, i: number) => ({ ...row('EventCtfChallenge', { ...c, eventId: e.id, sortOrder: i }), id: (c.id as string) ?? demoId() }));
      return next;
    });
    return { event };
  });
  route('DELETE', `${base}/:eventId`, ({ params }) => {
    save(events().filter((e) => e.id !== params.eventId));
    return { success: true };
  });
  route('POST', `${base}/:eventId/publish`, ({ params }) => ({ event: change(params.eventId, (e) => ({ ...e, status: e.type === 'TOURNAMENT' ? 'SCHEDULED' : 'ONGOING', messageId: demoId() })) }));

  route('POST', `${base}/:eventId/next`, ({ params }) => {
    const e = find(params.eventId);
    if (!e) return new Response(JSON.stringify({ error: 'Événement introuvable.' }), { status: 404 });
    const current = e.questions.find((q) => q.status === 'ONGOING');
    const upcoming = e.questions.find((q) => q.status === 'DRAFT');
    if (!upcoming) {
      change(e.id, (x) => answer({ ...x, status: 'COMPLETED', questions: x.questions.map((q) => (q.status === 'ONGOING' ? { ...q, status: 'COMPLETED', endTime: new Date().toISOString() } : q)) }));
      return { status: 'completed' };
    }
    const now = new Date().toISOString();
    change(e.id, (x) => answer({
      ...x,
      status: 'ONGOING',
      questions: x.questions.map((q) => (q.id === current?.id ? { ...q, status: 'COMPLETED', endTime: now } : q.id === upcoming.id ? { ...q, status: 'ONGOING', startTime: now } : q)),
    }));
    return { status: 'next_question_launched', questionId: upcoming.id };
  });
  route('POST', `${base}/:eventId/prev`, ({ params }) => {
    const e = find(params.eventId);
    const completed = e?.questions.filter((q) => q.status === 'COMPLETED') ?? [];
    const previous = completed[completed.length - 1];
    if (!e || !previous) return new Response(JSON.stringify({ error: 'Pas de question précédente.' }), { status: 400 });
    change(e.id, (x) => ({ ...x, questions: x.questions.map((q) => (q.id === previous.id ? { ...q, status: 'ONGOING' } : q.status === 'ONGOING' ? { ...q, status: 'DRAFT', startTime: null } : q)) }));
    return { status: 'previous_question_launched', questionId: previous.id };
  });
  route('POST', `${base}/:eventId/finish`, ({ params }) => {
    change(params.eventId, (x) => answer({ ...x, status: 'COMPLETED', questions: x.questions.map((q) => (q.status === 'ONGOING' ? { ...q, status: 'COMPLETED' } : q)) }));
    return { status: 'completed' };
  });
  route('GET', `${base}/:eventId/stats`, ({ params }) => {
    const e = find(params.eventId);
    if (!e) return { stats: null };
    if (e.type === 'CTF') {
      return {
        stats: {
          type: 'CTF',
          challenges: e.ctfChallenges.map((c, i) => {
            const solvers = e.participants.slice(0, Math.max(1, 6 - i * 2));
            return { id: c.id, title: c.title, points: c.points, xpReward: c.xpReward, roleIdReward: c.roleIdReward, solveCount: solvers.length, solves: solvers.map((p, j) => ({ userId: p.userId, username: p.username, solvedAt: ago(30 * (j + 1)) })) };
          }),
        },
      };
    }
    return { stats: quizStats(e) };
  });
  route('GET', `${base}/:eventId/registrations`, ({ params }) => ({
    registrations: (find(params.eventId)?.registrations ?? []).map((r) => ({ ...r, avatarUrl: null, teamMembers: r.teamMemberIds.map((id: string) => ({ id, name: PEOPLE.find((p) => p.id === id)?.displayName ?? id })) })),
  }));
  route('DELETE', `${base}/:eventId/registrations/:userId`, ({ params }) => {
    change(params.eventId, (e) => ({ ...e, registrations: e.registrations.filter((r) => r.userId !== params.userId) }));
    return { ok: true };
  });
}
