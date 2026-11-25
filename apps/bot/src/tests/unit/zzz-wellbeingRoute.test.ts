/**
 * Routes dashboard de la cellule bien-être : les garde-fous d'accès.
 *
 * Préfixe `zzz-` : ce fichier remplace la base, les alertes, l'historique et
 * les absences pour tout le process (`mock.module` est global). Il doit
 * charger après les tests de ces modules.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';
import { caseVisibilityWhere } from '../../services/staff/wellbeingPolicy.js';

process.env.WELLBEING_ENCRYPTION_KEY = 'cle-de-test-bien-etre';

const GUILD = '900000000000000001';
const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const DIR = '100000000000000003';
const DIR2 = '100000000000000004';
const OWNER = '100000000000000005';
const SUBJECT = '100000000000000006';
const HOUR = 3_600_000;

const CONFIG = {
  guildId: GUILD,
  enabled: true,
  requireReason: true,
  teamUserIds: [ALICE, BOB],
  teamRoleIds: [] as string[],
  directorUserIds: [DIR, DIR2],
  directorRoleIds: [] as string[],
  alertChannelId: null,
  alertUserIds: [] as string[],
  alertEvents: [] as string[],
  breakGlassApproval: false,
  reportEnabled: false,
  staleCriticalDays: 7,
  resources: [],
  backupUserId: null as string | null,
  accessReviewedAt: null,
  accessReviewSentAt: null,
  digestSentAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function makeCase(over: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    guildId: GUILD,
    subjectUserId: SUBJECT as string | null,
    subjectName: 'Sujet',
    title: 'Titre',
    summary: 'Résumé',
    category: 'SOUTIEN',
    severity: 'NORMAL',
    status: 'OPEN',
    source: 'DASHBOARD',
    createdById: ALICE,
    createdByName: 'alice',
    assigneeId: null as string | null,
    reviewAt: null as Date | null,
    deletedAt: null as Date | null,
    deletedById: null,
    deletedByName: null,
    purgeRequestedById: null as string | null,
    purgeRequestedByName: null as string | null,
    purgeRequestedAt: null as Date | null,
    closedReason: null as string | null,
    notes: [],
    events: [],
    attachments: [],
    tasks: [],
    createdAt: new Date('2026-11-20T10:00:00Z'),
    updatedAt: new Date('2026-11-20T10:00:00Z'),
    lastActivityAt: new Date('2026-11-20T10:00:00Z'),
    ...over,
  };
}

let visibleCase: ReturnType<typeof makeCase> | null = makeCase();
let activeBreakGlass: Record<string, unknown> | null = null;
let breakGlassLog: Record<string, unknown> | null = null;
let note: Record<string, unknown> | null = null;
let signal: Record<string, unknown> | null = null;
let ticket: Record<string, unknown> | null = null;
let transferredCase: Record<string, unknown> | null = null;

const mockDb = {
  dashboardAuditLog: {
    create: mock(async (_args?: unknown) => ({})),
    findMany: mock(async (_args?: unknown) => [
      { dateIso: new Date('2026-11-20T10:00:00Z'), user: 'alice', action: 'Consultation', details: '=SOMME(1)' },
    ]),
  },
  guild: { findUnique: mock(async (_args?: unknown) => null) },
  wellbeingConfig: {
    findUnique: mock(async (_args?: unknown) => CONFIG),
    update: mock(async (_args?: unknown) => CONFIG),
    upsert: mock(async (_args?: unknown) => CONFIG),
  },
  wellbeingBreakGlassLog: {
    // Un appel sans `id` cherche l'accès actif de la personne ; avec `id`, un journal précis.
    findFirst: mock(async (args?: { where?: { id?: string } }) => (args?.where?.id ? breakGlassLog : activeBreakGlass)),
    findMany: mock(async (_args?: unknown) => []),
    update: mock(async (args: { data: Record<string, unknown> }) => ({ ...breakGlassLog, ...args.data })),
    create: mock(async (args: { data: Record<string, unknown> }) => ({ id: 'log-new', ...args.data })),
  },
  wellbeingCase: {
    findFirst: mock(async (_args?: unknown) => visibleCase),
    findUnique: mock(async (_args?: unknown) => transferredCase),
    findMany: mock(async (_args?: unknown) => []),
    findUniqueOrThrow: mock(async (_args?: unknown) => visibleCase ?? makeCase()),
    update: mock(async (args: { data: Record<string, unknown> }) => ({ ...visibleCase, ...args.data })),
    create: mock(async (args: { data: Record<string, unknown> }) => ({ ...makeCase(), ...args.data })),
    delete: mock(async (_args?: unknown) => visibleCase),
  },
  wellbeingCaseEvent: {
    findFirst: mock(async (_args?: unknown) => null),
    count: mock(async (_args?: unknown) => 0),
  },
  wellbeingCaseNote: {
    findFirst: mock(async (_args?: unknown) => note),
    update: mock(async (_args?: unknown) => note),
  },
  wellbeingReporterMessage: {
    create: mock(async (args: { data: Record<string, unknown> }) => ({ id: 'msg-1', ...args.data })),
  },
  wellbeingDistressSignal: {
    findFirst: mock(async (_args?: unknown) => signal),
    findMany: mock(async (_args?: unknown) => []),
    update: mock(async (_args?: unknown) => signal),
    updateMany: mock(async (_args?: unknown) => ({ count: signal ? 1 : 0 })),
  },
  wellbeingPulseWeek: {
    findMany: mock(async (_args?: unknown) => []),
  },
  ticket: {
    findFirst: mock(async (_args?: unknown) => ticket),
  },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

function mockModule(relative: string, implementation: Record<string, unknown>) {
  const source = path.resolve(__dirname, `${relative}.ts`);
  for (const suffix of ['.ts', '.js']) {
    mock.module(path.resolve(__dirname, `${relative}${suffix}`), () => completeModuleMock(source, implementation));
  }
}

const appendCaseEvents = mock(async (_caseId: string, _events: Array<{ type: string; toValue?: string | null }>) => {});
mockModule('../../services/staff/wellbeingEvents', { appendCaseEvents });
mockModule('../../services/staff/wellbeingAlerts', {
  sendWellbeingAlert: mock(async () => {}),
  sendWellbeingDirect: mock(async () => {}),
});
mockModule('../../services/staff/wellbeingAbsence', { currentAbsence: mock(async () => null) });
const applyCrisisProtocolIfDue = mock(async (..._args: unknown[]) => false);
mockModule('../../services/staff/wellbeingCrisis', { applyCrisisProtocolIfDue, CRISIS_PROTOCOL_EVENT: 'CRISIS_PROTOCOL' });
const closeTicket = mock(async (..._args: unknown[]) => null);
mockModule('../../services/features/ticketService', { closeTicket });
mockModule('../../commands/utility/wellbeing', { wellbeingPanelMessage: mock(() => ({ content: 'panel' })) });
const requestDissolution = mock(async () => new Date(Date.now() + 24 * HOUR));
mockModule('../../services/staff/wellbeingDissolution', {
  requestDissolution,
  cancelDissolution: mock(async () => true),
  applyDueDissolutions: mock(async () => {}),
});

const session = (userId: string, ageHours = 1) =>
  ({ userId, username: userId, createdAt: Date.now() - ageHours * HOUR } as unknown as AuthClaims);

mockDashboardGate(DASHBOARD_ACCESS_ADMIN, session(ALICE));
const { createWellbeingRouter } = await import('../../api/routes/dashboard/leadership/wellbeing.js');

const discordGuild = {
  id: GUILD,
  name: 'Serveur',
  ownerId: OWNER,
  members: { fetch: async () => ({ roles: { cache: { map: () => [] } } }), cache: new Map() },
  roles: { cache: new Map() },
  channels: { cache: new Map() },
};
const client = { guilds: { cache: new Map([[GUILD, discordGuild]]), fetch: async () => discordGuild } } as unknown as Client;

async function call(method: string, suffix: string, body?: unknown, user: AuthClaims = session(ALICE)) {
  setDashboardAccess(DASHBOARD_ACCESS_ADMIN, user);
  const { status, body: json } = await dashboardCall(createWellbeingRouter(client), method, `/api/dashboard/guilds/${GUILD}/wellbeing${suffix}`, body);
  return { status, json };
}

beforeEach(() => {
  visibleCase = makeCase();
  activeBreakGlass = null;
  breakGlassLog = null;
  note = null;
  signal = null;
  ticket = null;
  transferredCase = null;
  appendCaseEvents.mockClear();
  applyCrisisProtocolIfDue.mockClear();
  closeTicket.mockClear();
  requestDissolution.mockClear();
  for (const model of Object.values(mockDb)) {
    for (const fn of Object.values(model)) (fn as { mockClear: () => void }).mockClear();
  }
});

describe('lecture des dossiers', () => {
  test('une connexion de plus de 12 heures doit être renouvelée', async () => {
    const { status, json } = await call('GET', '/cases', undefined, session(ALICE, 13));
    expect(status).toBe(403);
    expect(json.code).toBe('WELLBEING_REAUTH');
    expect(mockDb.wellbeingCase.findMany).not.toHaveBeenCalled();
  });

  test('la liste écarte les dossiers qui concernent la personne et la corbeille', async () => {
    const { status } = await call('GET', '/cases');
    expect(status).toBe(200);
    const args = mockDb.wellbeingCase.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } };
    expect(args.where.AND[0]).toEqual(caseVisibilityWhere(GUILD, ALICE, { trashed: false }));
  });

  test("ouvrir un dossier trace la lecture et vérifie l'historique", async () => {
    const { status, json } = await call('GET', '/cases/case-1');
    expect(status).toBe(200);
    expect(json.integrity).toBe('ok');
    expect(appendCaseEvents.mock.calls[0]?.[1]?.[0]?.type).toBe('VIEWED');
  });

  test('un dossier masqué (conflit d intérêts) est introuvable', async () => {
    visibleCase = null;
    const { status } = await call('PATCH', '/cases/case-1', { status: 'CLOSED' });
    expect(status).toBe(404);
  });
});

describe('écriture des dossiers', () => {
  test("on n'ouvre pas de dossier sur soi-même", async () => {
    const { status } = await call('POST', '/cases', { subjectUserId: ALICE, subjectName: 'alice', title: 'T', summary: 'R' });
    expect(status).toBe(400);
    expect(mockDb.wellbeingCase.create).not.toHaveBeenCalled();
  });

  test('fermer enregistre le motif et son entrée d historique', async () => {
    const { status } = await call('PATCH', '/cases/case-1', { status: 'CLOSED', closedReason: 'RESOLVED' });
    expect(status).toBe(200);
    const args = mockDb.wellbeingCase.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data).toMatchObject({ status: 'CLOSED', closedReason: 'RESOLVED' });
    const types = appendCaseEvents.mock.calls[0]?.[1]?.map((event) => event.type);
    expect(types).toEqual(['STATUS', 'CLOSED_REASON']);
  });

  test("sous accès d'urgence, la direction lit sans écrire", async () => {
    activeBreakGlass = { id: 'log-1', status: 'APPROVED', caseId: null, subjectUserId: null, expiresAt: new Date(Date.now() + HOUR) };
    const { status } = await call('PATCH', '/cases/case-1', { status: 'CLOSED' }, session(DIR));
    expect(status).toBe(403);
    expect(mockDb.wellbeingCase.update).not.toHaveBeenCalled();
  });

  test('supprimer met à la corbeille, sans effacer', async () => {
    const { status } = await call('DELETE', '/cases/case-1');
    expect(status).toBe(200);
    const args = mockDb.wellbeingCase.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.deletedAt).toBeInstanceOf(Date);
    expect(mockDb.wellbeingCase.delete).not.toHaveBeenCalled();
  });

  test("seul l'auteur corrige sa note", async () => {
    note = { id: 'note-1', caseId: 'case-1', authorId: BOB, content: 'x', originalContent: null, createdAt: new Date() };
    const { status } = await call('PATCH', '/cases/case-1/notes/note-1', { content: 'corrigée' });
    expect(status).toBe(403);
    expect(mockDb.wellbeingCaseNote.update).not.toHaveBeenCalled();
  });
});

describe('effacement anticipé à deux clés', () => {
  const pending = () => makeCase({ deletedAt: new Date(), purgeRequestedById: ALICE, purgeRequestedByName: 'alice', purgeRequestedAt: new Date() });

  test("l'auteur de la demande ne la valide pas", async () => {
    visibleCase = pending();
    const { status } = await call('POST', '/cases/case-1/purge');
    expect(status).toBe(403);
    expect(mockDb.wellbeingCase.delete).not.toHaveBeenCalled();
  });

  test('une autre personne de la cellule valide et le dossier est effacé', async () => {
    visibleCase = pending();
    const { status } = await call('POST', '/cases/case-1/purge', undefined, session(BOB));
    expect(status).toBe(200);
    expect(mockDb.wellbeingCase.delete).toHaveBeenCalledTimes(1);
  });

  test('une demande en attente ne peut pas être remplacée', async () => {
    visibleCase = pending();
    const { status } = await call('POST', '/cases/case-1/purge-request', undefined, session(BOB));
    expect(status).toBe(409);
    expect(mockDb.wellbeingCase.update).not.toHaveBeenCalled();
  });
});

describe("arrêt d'un accès d'urgence", () => {
  test("un pair de la direction ne coupe pas l'accès d'un autre", async () => {
    breakGlassLog = { id: 'log-1', guildId: GUILD, actorId: DIR, actorName: 'dir', status: 'APPROVED', expiresAt: new Date(Date.now() + HOUR) };
    const { status } = await call('POST', '/break-glass/log-1/end', undefined, session(DIR2));
    expect(status).toBe(403);
    expect(mockDb.wellbeingBreakGlassLog.update).not.toHaveBeenCalled();
  });

  test('la cellule le révoque', async () => {
    breakGlassLog = { id: 'log-1', guildId: GUILD, actorId: DIR, actorName: 'dir', status: 'APPROVED', expiresAt: new Date(Date.now() + HOUR) };
    const { status } = await call('POST', '/break-glass/log-1/end');
    expect(status).toBe(200);
    expect(mockDb.wellbeingBreakGlassLog.update).toHaveBeenCalledTimes(1);
  });
});

describe('désactivation de la cellule', () => {
  test('différée : la cellule reste active et la demande est enregistrée', async () => {
    const { status, json } = await call('PUT', '/config', { enabled: false }, session(OWNER));
    expect(status).toBe(200);
    const args = mockDb.wellbeingConfig.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect('enabled' in args.update).toBe(false);
    expect(requestDissolution).toHaveBeenCalledTimes(1);
    expect(json.config.dissolutionAt).toBeTruthy();
  });

  test('vider la composition d une cellule active est refusé', async () => {
    const { status } = await call('PUT', '/config', { teamUserIds: [], teamRoleIds: [] }, session(OWNER));
    expect(status).toBe(400);
    expect(mockDb.wellbeingConfig.upsert).not.toHaveBeenCalled();
  });
});

describe('réponse au signaleur', () => {
  test("refusée pour un dossier qui ne vient pas d'un signalement", async () => {
    const { status } = await call('POST', '/cases/case-1/reporter-reply', { message: 'Pris en compte' });
    expect(status).toBe(400);
    expect(mockDb.wellbeingCase.update).not.toHaveBeenCalled();
  });

  test('enregistrée chiffrée pour un signalement, comme un message du fil', async () => {
    visibleCase = makeCase({ source: 'DISCORD', trackingCodeHash: 'empreinte' });
    const { status, json } = await call('POST', '/cases/case-1/reporter-reply', { message: 'Pris en compte' });
    expect(status).toBe(200);
    const args = mockDb.wellbeingReporterMessage.create.mock.calls[0]?.[0] as { data: { content: string; fromReporter: boolean } };
    expect(args.data.fromReporter).toBe(false);
    expect(args.data.content).not.toContain('Pris en compte');
    expect(json.item.trackingCodeHash).toBeUndefined();
  });

  test('un message vide est refusé', async () => {
    visibleCase = makeCase({ source: 'DISCORD', trackingCodeHash: 'empreinte' });
    const { status } = await call('POST', '/cases/case-1/reporter-reply', { message: '  ' });
    expect(status).toBe(400);
    expect(mockDb.wellbeingReporterMessage.create).not.toHaveBeenCalled();
  });
});

describe('protocole de crise et prise de nouvelles', () => {
  test('passer un dossier en critique applique le protocole', async () => {
    const { status } = await call('PATCH', '/cases/case-1', { severity: 'CRITICAL' });
    expect(status).toBe(200);
    expect(applyCrisisProtocolIfDue).toHaveBeenCalledTimes(1);
    expect(applyCrisisProtocolIfDue.mock.calls[0]?.[1]).toBe('NORMAL');
    expect(applyCrisisProtocolIfDue.mock.calls[0]?.[2]).toBe('CRITICAL');
  });

  test('fermer un dossier résolu programme la prise de nouvelles', async () => {
    const { status } = await call('PATCH', '/cases/case-1', { status: 'CLOSED', closedReason: 'RESOLVED' });
    expect(status).toBe(200);
    const args = mockDb.wellbeingCase.update.mock.calls[0]?.[0] as { data: { followUpAt: Date | null } };
    expect(args.data.followUpAt).toBeInstanceOf(Date);
  });

  test('rouvrir un dossier annule la prise de nouvelles', async () => {
    visibleCase = makeCase({ status: 'CLOSED', closedReason: 'RESOLVED' });
    await call('PATCH', '/cases/case-1', { status: 'OPEN' });
    const args = mockDb.wellbeingCase.update.mock.calls[0]?.[0] as { data: { followUpAt: Date | null } };
    expect(args.data.followUpAt).toBeNull();
  });
});

describe('signaux de détresse', () => {
  test('écarter un signal le marque traité', async () => {
    signal = { id: 'sig-1', guildId: GUILD, userId: SUBJECT };
    const { status } = await call('POST', '/signals/sig-1/dismiss');
    expect(status).toBe(200);
    const args = mockDb.wellbeingDistressSignal.updateMany.mock.calls[0]?.[0] as { where: { userId: unknown }; data: { outcome: string } };
    expect(args.data.outcome).toBe('DISMISSED');
    // Un signal sur soi-même n'est jamais modifiable par soi.
    expect(args.where.userId).toEqual({ not: ALICE });
  });

  test("un dossier ouvert depuis un signal déjà traité est refusé", async () => {
    const { status } = await call('POST', '/cases', { signalId: 'sig-1', subjectName: 'S', title: 'T', summary: 'R' });
    expect(status).toBe(404);
    expect(mockDb.wellbeingCase.create).not.toHaveBeenCalled();
  });

  test('la direction seule ne voit pas les signaux', async () => {
    const { status } = await call('GET', '/signals', undefined, session(DIR));
    expect(status).toBe(403);
  });
});

describe('transfert de ticket', () => {
  test('un ticket déjà transféré ne crée pas de second dossier', async () => {
    ticket = { id: 't-1', guildId: GUILD, userId: SUBJECT, username: 'sujet', reason: 'Aide', description: 'D', ticketTypeLabel: null, status: 'OPEN' };
    transferredCase = { id: 'case-1' };
    const { status } = await call('POST', '/cases/from-ticket', { ticketId: 't-1' });
    expect(status).toBe(409);
    expect(mockDb.wellbeingCase.create).not.toHaveBeenCalled();
  });

  test('le ticket devient un dossier et peut être fermé', async () => {
    ticket = { id: 't-1', guildId: GUILD, userId: SUBJECT, username: 'sujet', reason: 'Aide', description: 'D', ticketTypeLabel: null, status: 'OPEN' };
    const { status } = await call('POST', '/cases/from-ticket', { ticketId: 't-1', closeTicket: true });
    expect(status).toBe(201);
    const args = mockDb.wellbeingCase.create.mock.calls[0]?.[0] as { data: { source: string; ticketId: string; summary: string } };
    expect(args.data.source).toBe('TICKET');
    expect(args.data.ticketId).toBe('t-1');
    expect(args.data.summary).not.toContain('Aide');
    expect(closeTicket).toHaveBeenCalledTimes(1);
  });
});

describe('message permanent', () => {
  test('refusé tant que les signalements Discord sont fermés', async () => {
    const { status } = await call('POST', '/report-panel', { channelId: '300000000000000001' });
    expect(status).toBe(400);
  });
});

describe('journal de la cellule', () => {
  test('exporté en CSV, sans formule exécutable', async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, session(ALICE));
    const { status, res, body } = await dashboardCall(createWellbeingRouter(client), 'GET', `/api/dashboard/guilds/${GUILD}/wellbeing/journal`);
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(String(body)).toContain("\"'=SOMME(1)\"");
  });
});
