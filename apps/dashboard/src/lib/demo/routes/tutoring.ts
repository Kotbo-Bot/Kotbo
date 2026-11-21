/**
 * Tutorat du staff : un Helper en période d'essai, suivi par un modérateur.
 * Mêmes personnes que l'équipe de la démo (`home.ts`).
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { G } from '../crud';
import { DAY, ME, ago } from '../fixtures';
import { staffMembers } from './home';

const CONFIG_KEY = 'tutoring/config';
const ITEMS_KEY = 'tutoring/items';
const PERIODS_KEY = 'tutoring/periods';

const configSeed = () => ({ reportIntervalDays: 7, reminderDaysBefore: 1, minTestDays: 21, showVocalActivity: true, showAbsences: true });

const itemsSeed = () => [
  { id: 'ti-1', category: 'Modération', title: 'Appliquer le barème des sanctions', description: 'Choisir la bonne sanction selon le règlement.', sortOrder: 0, hierarchyId: null, grade: null },
  { id: 'ti-2', category: 'Modération', title: 'Rédiger un rapport de sanction', description: null, sortOrder: 1, hierarchyId: null, grade: null },
  { id: 'ti-3', category: 'Support', title: 'Prendre en charge un ticket', description: 'Répondre sous 15 minutes et fermer proprement.', sortOrder: 2, hierarchyId: null, grade: null },
  { id: 'ti-4', category: 'Support', title: 'Utiliser les réponses enregistrées', description: null, sortOrder: 3, hierarchyId: null, grade: null },
  { id: 'ti-5', category: 'Outils', title: 'Lire les logs et l’historique d’un membre', description: null, sortOrder: 4, hierarchyId: null, grade: null },
  { id: 'ti-6', category: 'Outils', title: 'Organiser une réunion vocale', description: null, sortOrder: 5, hierarchyId: null, grade: null },
];

type Member = ReturnType<typeof staffMembers>[number];
const asTutoringMember = (m: Member) => ({ id: m.id, userId: m.userId, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl, grade: m.grade });

type Period = {
  id: string;
  status: 'ONGOING' | 'PASSED' | 'FAILED';
  startDate: string;
  endDate: string | null;
  plannedDurationDays: number;
  targetGrade: string | null;
  hierarchyId: string | null;
  notes: string | null;
  doingListId: string | null;
  apprenticeId: string;
  mentorId: string | null;
  objectives: Record<string, { state: 'UNCHECKED' | 'KNOWN' | 'ACQUIRED'; completedAt: string | null }>;
  reports: Array<{ id: string; type: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'; content: string; createdAt: string; authorId: string }>;
  logs: Array<{ id: string; content: string; date: string }>;
};

function periodsSeed(): Period[] {
  const team = staffMembers();
  const apprentice = team.find((m) => m.username === 'kylian') ?? team[team.length - 1];
  const mentor = team.find((m) => m.username === 'zenox') ?? team[0];
  const second = team.find((m) => m.username === 'aiden') ?? team[1];
  return [
    {
      id: 'tp-1',
      status: 'ONGOING',
      startDate: ago(16 * DAY),
      endDate: null,
      plannedDurationDays: 30,
      targetGrade: 'Modérateur',
      hierarchyId: 'hier-moderation',
      notes: 'Très présent sur les tickets, à accompagner sur les sanctions.',
      doingListId: null,
      apprenticeId: apprentice.id,
      mentorId: mentor.id,
      objectives: {
        'ti-1': { state: 'KNOWN', completedAt: null },
        'ti-3': { state: 'ACQUIRED', completedAt: ago(9 * DAY) },
        'ti-4': { state: 'ACQUIRED', completedAt: ago(6 * DAY) },
        'ti-5': { state: 'KNOWN', completedAt: null },
      },
      reports: [
        { id: 'tr-1', type: 'POSITIVE', content: 'Bonne prise en main des tickets, ton toujours poli.', createdAt: ago(9 * DAY), authorId: mentor.id },
        { id: 'tr-2', type: 'NEUTRAL', content: 'A fermé un ticket sans réponse au membre : on en a parlé, il a compris.', createdAt: ago(2 * DAY), authorId: mentor.id },
      ],
      logs: [
        { id: 'tl-1', content: 'Première session de modération en binôme.', date: ago(14 * DAY) },
        { id: 'tl-2', content: 'Formation sur le barème des sanctions.', date: ago(7 * DAY) },
      ],
    },
    {
      id: 'tp-2',
      status: 'PASSED',
      startDate: ago(120 * DAY),
      endDate: ago(90 * DAY),
      plannedDurationDays: 30,
      targetGrade: 'Modérateur',
      hierarchyId: 'hier-moderation',
      notes: 'Validé à l’unanimité.',
      doingListId: null,
      apprenticeId: second.id,
      mentorId: mentor.id,
      objectives: Object.fromEntries(itemsSeed().map((i) => [i.id, { state: 'ACQUIRED' as const, completedAt: ago(95 * DAY) }])),
      reports: [{ id: 'tr-3', type: 'POSITIVE', content: 'Autonome sur tout le périmètre.', createdAt: ago(92 * DAY), authorId: mentor.id }],
      logs: [],
    },
  ];
}

const periods = () => demoDb.get(PERIODS_KEY, periodsSeed);
const items = () => demoDb.get(ITEMS_KEY, itemsSeed);
const config = () => demoDb.get(CONFIG_KEY, configSeed);

function memberById(id: string | null) {
  const found = staffMembers().find((m) => m.id === id);
  return found ? asTutoringMember(found) : null;
}

function summary(p: Period) {
  const cfg = config();
  const states = Object.values(p.objectives);
  const lastReport = p.reports.map((r) => r.createdAt).sort().pop() ?? null;
  const next = lastReport ? new Date(new Date(lastReport).getTime() + cfg.reportIntervalDays * 86_400_000).toISOString() : null;
  return {
    id: p.id,
    status: p.status,
    startDate: p.startDate,
    endDate: p.endDate,
    plannedDurationDays: p.plannedDurationDays,
    targetGrade: p.targetGrade,
    hierarchyId: p.hierarchyId,
    notes: p.notes,
    doingListId: p.doingListId,
    apprentice: memberById(p.apprenticeId)!,
    mentor: memberById(p.mentorId),
    daysElapsed: Math.floor((Date.now() - new Date(p.startDate).getTime()) / 86_400_000),
    progress: { total: items().length, acquired: states.filter((s) => s.state === 'ACQUIRED').length, learning: states.filter((s) => s.state === 'KNOWN').length },
    reports: p.reports.length,
    lastReportAt: lastReport,
    nextReportAt: p.status === 'ONGOING' ? next : null,
    reportOverdue: p.status === 'ONGOING' && !!next && new Date(next).getTime() < Date.now(),
  };
}

function detail(p: Period) {
  const base = summary(p);
  const cfg = config();
  const acquired = base.progress.acquired;
  return {
    ...base,
    objectives: items().map((i) => ({ id: i.id, category: i.category, title: i.title, description: i.description, state: p.objectives[i.id]?.state ?? 'UNCHECKED', completedAt: p.objectives[i.id]?.completedAt ?? null })),
    reports: p.reports.map((r) => ({ id: r.id, type: r.type, content: r.content, createdAt: r.createdAt, author: memberById(r.authorId)! })),
    logs: p.logs,
    absences: [],
    vocalStats: { voiceTimeSeconds: 14 * 3600 + 1800, voiceSessionCount: 23 },
    missions: null,
    readiness: [
      { key: 'duration' as const, ok: base.daysElapsed >= cfg.minTestDays, blocking: true, value: base.daysElapsed, target: cfg.minTestDays },
      { key: 'objectives' as const, ok: acquired >= base.progress.total, blocking: false, value: acquired, target: base.progress.total },
      { key: 'reports' as const, ok: p.reports.length >= 2, blocking: false, value: p.reports.length, target: 2 },
    ],
    config: { minTestDays: cfg.minTestDays, reportIntervalDays: cfg.reportIntervalDays },
  };
}

function save(next: Period) {
  demoDb.set(PERIODS_KEY, periods().map((p) => (p.id === next.id ? next : p)));
  return { period: detail(next), role: 'manager' as const };
}

function change(id: string, fn: (p: Period) => Period) {
  const current = periods().find((p) => p.id === id);
  return current ? save(fn(current)) : new Response(JSON.stringify({ error: 'Tutorat introuvable dans la démo.' }), { status: 404 });
}

export function registerTutoringRoutes(): void {
  const base = `${G}/tutoring`;
  route('GET', `${base}/overview`, () => {
    const list = periods().map(summary);
    return {
      canManage: true,
      isTutor: true,
      mine: null,
      mentoring: list.filter((p) => p.status === 'ONGOING'),
      all: list,
      config: { minTestDays: config().minTestDays, reportIntervalDays: config().reportIntervalDays },
    };
  });
  route('GET', `${base}/candidates`, () => {
    const ongoing = new Set(periods().filter((p) => p.status === 'ONGOING').map((p) => p.apprenticeId));
    return {
      members: staffMembers().map((m) => ({ ...asTutoringMember(m), isTutor: m.isTutor, inTutoring: ongoing.has(m.id) })),
      hierarchies: [
        { id: 'hier-direction', name: 'Direction' },
        { id: 'hier-moderation', name: 'Modération' },
        { id: 'hier-support', name: 'Support' },
      ],
      grades: [
        { name: 'Admin', hierarchyId: 'hier-direction' },
        { name: 'Modérateur', hierarchyId: 'hier-moderation' },
        { name: 'Helper', hierarchyId: 'hier-support' },
      ],
    };
  });
  route('GET', `${base}/periods/:id`, ({ params }) => {
    const p = periods().find((x) => x.id === params.id);
    return p ? { period: detail(p), role: 'manager' } : new Response(JSON.stringify({ error: 'Introuvable' }), { status: 404 });
  });
  route('POST', `${base}/periods`, ({ body }) => {
    const p: Period = {
      id: demoId(),
      status: 'ONGOING',
      startDate: new Date().toISOString(),
      endDate: null,
      plannedDurationDays: body?.plannedDurationDays ?? 30,
      targetGrade: body?.targetGrade ?? null,
      hierarchyId: body?.hierarchyId ?? null,
      notes: null,
      doingListId: null,
      apprenticeId: body?.staffMemberId,
      mentorId: body?.mentorId ?? null,
      objectives: {},
      reports: [],
      logs: [],
    };
    demoDb.set(PERIODS_KEY, [p, ...periods()]);
    return { period: detail(p) };
  });
  route('PATCH', `${base}/periods/:id`, ({ params, body }) =>
    change(params.id, (p) => ({ ...p, ...(body?.mentorId !== undefined ? { mentorId: body.mentorId } : {}), ...(body?.plannedDurationDays ? { plannedDurationDays: body.plannedDurationDays } : {}), ...(body?.targetGrade !== undefined ? { targetGrade: body.targetGrade } : {}), ...(body?.hierarchyId !== undefined ? { hierarchyId: body.hierarchyId } : {}) })),
  );
  route('DELETE', `${base}/periods/:id`, ({ params }) => {
    demoDb.set(PERIODS_KEY, periods().filter((p) => p.id !== params.id));
    return { success: true };
  });
  route('POST', `${base}/periods/:id/missions-board`, ({ params }) => change(params.id, (p) => ({ ...p, doingListId: 'dl-tutorat' })));
  route('PUT', `${base}/periods/:id/objectives/:itemId`, ({ params, body }) =>
    change(params.id, (p) => ({ ...p, objectives: { ...p.objectives, [params.itemId]: { state: body?.state ?? 'UNCHECKED', completedAt: body?.state === 'ACQUIRED' ? new Date().toISOString() : null } } })),
  );
  route('POST', `${base}/periods/:id/reports`, ({ params, body }) => {
    const author = staffMembers().find((m) => m.userId === ME.id) ?? staffMembers()[0];
    return change(params.id, (p) => ({ ...p, reports: [...p.reports, { id: demoId(), type: body?.type ?? 'NEUTRAL', content: body?.content ?? '', createdAt: new Date().toISOString(), authorId: author.id }] }));
  });
  route('POST', `${base}/periods/:id/logs`, ({ params, body }) => {
    const log = { id: demoId(), content: body?.content ?? '', date: new Date().toISOString() };
    change(params.id, (p) => ({ ...p, logs: [...p.logs, log] }));
    return { log };
  });
  route('POST', `${base}/periods/:id/decision`, ({ params, body }) =>
    change(params.id, (p) => ({ ...p, status: body?.status === 'FAILED' ? 'FAILED' : 'PASSED', endDate: new Date().toISOString(), notes: body?.notes ?? p.notes })),
  );
  route('GET', `${base}/config`, () => ({ config: config() }));
  route('PATCH', `${base}/config`, ({ body }) => ({ config: demoDb.update(CONFIG_KEY, configSeed, (c) => ({ ...c, ...(body ?? {}) })) }));
  route('GET', `${base}/items`, () => ({ items: items() }));
  route('POST', `${base}/items`, ({ body }) => {
    const item = { id: demoId(), category: body?.category ?? 'Général', title: body?.title ?? 'Nouvel objectif', description: body?.description ?? null, sortOrder: items().length, hierarchyId: body?.hierarchyId ?? null, grade: body?.grade ?? null };
    demoDb.set(ITEMS_KEY, [...items(), item]);
    return { item };
  });
  route('DELETE', `${base}/items/:itemId`, ({ params }) => {
    demoDb.set(ITEMS_KEY, items().filter((i) => i.id !== params.itemId));
    return { success: true };
  });
  // « Toi » n'est tutoré de personne : le menu n'a rien à afficher en plus.
  route('GET', `${base}/apprentice-progress`, () => ({ progress: null }));
}
