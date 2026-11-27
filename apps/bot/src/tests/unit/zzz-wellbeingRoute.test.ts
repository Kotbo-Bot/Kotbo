/**
 * Routes dashboard de la cellule de suivi : les garde-fous d'accès.
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
import { caseVisibilityWhere } from '../../services/staff/wellbeingCasePolicy.js';
import { REPORT_PANEL_TEMPLATES } from '../../services/staff/wellbeingReportPolicy.js';

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
  caseCategories: [] as unknown[],
  crisisTasks: [] as unknown[],
  noteTemplates: [] as unknown[],
  taskPlans: [{ id: 'plan-1', label: 'Médiation', tasks: [{ label: 'Entendre les parties', dueDays: 2 }, { label: 'Bilan', dueDays: null }] }] as unknown[],
  caseTags: [{ id: 'tag-1', label: 'Mineur' }] as unknown[],
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
let profile: Record<string, unknown> | null = null;
let profileNote: Record<string, unknown> | null = null;

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
    findMany: mock(async (_args?: unknown): Promise<Array<Record<string, unknown>>> => []),
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
    updateMany: mock(async (_args?: unknown) => ({ count: 0 })),
  },
  wellbeingCaseEvent: {
    findFirst: mock(async (_args?: unknown) => null),
    count: mock(async (_args?: unknown) => 0),
  },
  wellbeingCaseNote: {
    findFirst: mock(async (_args?: unknown) => note),
    update: mock(async (_args?: unknown) => note),
    create: mock(async (args: { data: Record<string, unknown> }) => ({ id: 'note-new', createdAt: new Date(), ...args.data })),
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
  wellbeingProfile: {
    findMany: mock(async (_args?: unknown) => []),
    findUnique: mock(async (_args?: unknown) => profile),
    upsert: mock(async (args: { create: Record<string, unknown> }) => ({ id: 'profile-1', subjectLeftAt: null, ...args.create })),
    update: mock(async (args: { data: Record<string, unknown> }) => ({ ...profile, ...args.data })),
  },
  wellbeingCaseTask: {
    count: mock(async (_args?: unknown) => 0),
    createMany: mock(async (_args?: unknown) => ({ count: 0 })),
  },
  wellbeingProfileNote: {
    findMany: mock(async (_args?: unknown) => []),
    findFirst: mock(async (_args?: unknown) => profileNote),
    create: mock(async (args: { data: Record<string, unknown> }) => ({ id: 'pnote-new', createdAt: new Date(), ...args.data })),
    update: mock(async (args: { data: Record<string, unknown> }) => ({ ...profileNote, ...args.data })),
    delete: mock(async (_args?: unknown) => profileNote),
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
const wellbeingPanelMessage = mock((_locale: string, template?: string, _text?: string | null) => ({ content: `panel ${template}` }));
const wellbeingPanelText = mock((template: string, _locale: string) => `texte ${template}`);
mockModule('../../commands/utility/wellbeing', { wellbeingPanelMessage, wellbeingPanelText });
type PoolEntry = { userId: string; guildId: string; name: string; guildName: string; active: number };
let pool: { available: boolean; candidates: PoolEntry[] } = { available: false, candidates: [] };
let networkRefs: Array<{ id: string; guildId: string }> = [];
const networkGuildIds = mock(async (_guildId: string): Promise<string[]> => []);
mockModule('../../services/staff/wellbeingNetwork', {
  networkPool: mock(async () => pool),
  networkReferentCaseRefs: mock(async () => networkRefs),
  networkGuildIds,
});
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
const { createWellbeingNetworkRouter } = await import('../../api/routes/dashboard/leadership/wellbeingNetwork.js');
const { createWellbeingProfilesRouter } = await import('../../api/routes/dashboard/leadership/wellbeingProfiles.js');

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
  profile = null;
  profileNote = null;
  pool = { available: false, candidates: [] };
  networkRefs = [];
  appendCaseEvents.mockClear();
  applyCrisisProtocolIfDue.mockClear();
  closeTicket.mockClear();
  requestDissolution.mockClear();
  wellbeingPanelMessage.mockClear();
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
  const CHANNEL = '300000000000000001';
  const send = mock(async (_message: unknown) => ({}));

  /** Signalements Discord ouverts et un salon où le bot peut écrire. */
  function withReportsOpen() {
    mockDb.wellbeingConfig.findUnique.mockImplementation(async () => ({ ...CONFIG, reportEnabled: true }));
    discordGuild.channels.cache.set(CHANNEL, { id: CHANNEL, name: 'aide', isSendable: () => true, send } as never);
  }

  function restore() {
    mockDb.wellbeingConfig.findUnique.mockImplementation(async () => CONFIG);
    discordGuild.channels.cache.delete(CHANNEL);
    send.mockClear();
  }

  test('refusé tant que les signalements Discord sont fermés', async () => {
    const { status } = await call('POST', '/report-panel', { channelId: CHANNEL });
    expect(status).toBe(400);
  });

  test('les modèles proposés montrent leur texte', async () => {
    const { status, json } = await call('GET', '/report-panel/templates');
    expect(status).toBe(200);
    expect(json.templates.map((item: { id: string }) => item.id)).toEqual([...REPORT_PANEL_TEMPLATES]);
    expect(json.templates[0].text).toBe(`texte ${REPORT_PANEL_TEMPLATES[0]}`);
  });

  test('le modèle choisi est publié', async () => {
    withReportsOpen();
    try {
      const { status } = await call('POST', '/report-panel', { channelId: CHANNEL, template: 'short' });
      expect(status).toBe(200);
      expect(wellbeingPanelMessage.mock.calls[0]?.[1]).toBe('short');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('un texte libre remplace le modèle', async () => {
    withReportsOpen();
    try {
      const { status } = await call('POST', '/report-panel', { channelId: CHANNEL, template: 'short', text: '  Notre texte  ' });
      expect(status).toBe(200);
      expect(wellbeingPanelMessage.mock.calls[0]?.[2]).toBe('Notre texte');
    } finally {
      restore();
    }
  });

  test('un modèle inconnu publie le message par défaut', async () => {
    withReportsOpen();
    try {
      await call('POST', '/report-panel', { channelId: CHANNEL, template: 'inconnu' });
      expect(wellbeingPanelMessage.mock.calls[0]?.[1]).toBe(REPORT_PANEL_TEMPLATES[0]);
    } finally {
      restore();
    }
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

describe('référents du réseau', () => {
  const OTHER = '900000000000000002';
  const EXT = '100000000000000009';

  async function networkCall(method: string, suffix: string, body?: unknown, user: AuthClaims = session(ALICE)) {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, user);
    const { status, body: json } = await dashboardCall(createWellbeingNetworkRouter(client), method, `/api/dashboard/guilds/${GUILD}/wellbeing${suffix}`, body);
    return { status, json };
  }

  test('refusé tant que la cellule ne partage pas ses référents', async () => {
    const { status } = await networkCall('PUT', '/cases/case-1/network-referent', { userId: EXT, guildId: OTHER });
    expect(status).toBe(400);
    expect(mockDb.wellbeingCase.update).not.toHaveBeenCalled();
  });

  test('un membre absent des cellules du réseau est refusé', async () => {
    pool = { available: true, candidates: [{ userId: EXT, guildId: OTHER, name: 'ext', guildName: 'Autre', active: 0 }] };
    const { status } = await networkCall('PUT', '/cases/case-1/network-referent', { userId: BOB, guildId: OTHER });
    expect(status).toBe(400);
    expect(mockDb.wellbeingCase.update).not.toHaveBeenCalled();
  });

  test('un candidat du réseau devient référent, et cela entre à l historique', async () => {
    pool = { available: true, candidates: [{ userId: EXT, guildId: OTHER, name: 'ext', guildName: 'Autre', active: 0 }] };
    const { status } = await networkCall('PUT', '/cases/case-1/network-referent', { userId: EXT, guildId: OTHER });
    expect(status).toBe(200);
    const args = mockDb.wellbeingCase.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data).toMatchObject({ networkReferentId: EXT, networkReferentGuildId: OTHER });
    expect(appendCaseEvents.mock.calls[0]?.[1]?.[0]?.type).toBe('NETWORK_REFERENT');
  });

  test("la direction sans la cellule ne désigne personne", async () => {
    const { status } = await networkCall('PUT', '/cases/case-1/network-referent', { userId: EXT, guildId: OTHER }, session(DIR));
    expect(status).toBe(403);
  });

  test("un dossier qui n'est plus partagé reste fermé au référent", async () => {
    const { status } = await networkCall('GET', '/network/cases/case-1', undefined, session(EXT));
    expect(status).toBe(404);
    expect(mockDb.wellbeingCase.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  test('le référent du réseau ouvre le dossier, et sa lecture est tracée', async () => {
    networkRefs = [{ id: 'case-1', guildId: OTHER }];
    const { status } = await networkCall('GET', '/network/cases/case-1', undefined, session(EXT));
    expect(status).toBe(200);
    expect(appendCaseEvents.mock.calls[0]?.[1]?.[0]).toMatchObject({ type: 'VIEWED', toValue: 'NETWORK' });
  });

  test('sa note est chiffrée comme les autres', async () => {
    networkRefs = [{ id: 'case-1', guildId: OTHER }];
    const { status } = await networkCall('POST', '/network/cases/case-1/notes', { content: 'Premier échange' }, session(EXT));
    expect(status).toBe(201);
    const args = mockDb.wellbeingCaseNote.create.mock.calls[0]?.[0] as { data: { content: string } };
    expect(args.data.content).not.toContain('Premier échange');
  });

  test("la liste ne livre au référent que ce qu'il affiche, rien de la cellule d'origine", async () => {
    networkRefs = [{ id: 'case-1', guildId: OTHER }];
    const { status } = await networkCall('GET', '/network/cases', undefined, session(EXT));
    expect(status).toBe(200);
    const args = mockDb.wellbeingCase.findMany.mock.calls.at(-1)?.[0] as { select: Record<string, boolean> };
    expect(Object.keys(args.select).sort()).toEqual(
      ['category', 'guildId', 'id', 'severity', 'status', 'subjectName', 'title', 'updatedAt'],
    );
  });

  test('une connexion ancienne doit être renouvelée', async () => {
    networkRefs = [{ id: 'case-1', guildId: OTHER }];
    const { status } = await networkCall('GET', '/network/cases', undefined, session(EXT, 13));
    expect(status).toBe(403);
  });
});

describe('colonnes ajoutées par la cellule', () => {
  test('la cellule enregistre ses colonnes, nettoyées', async () => {
    const { status } = await call('PUT', '/board-columns', { columns: [{ label: ' À contacter ' }, { label: '' }] });
    expect(status).toBe(200);
    const args = mockDb.wellbeingConfig.update.mock.calls[0]?.[0] as { data: { boardColumns: Array<{ label: string }> } };
    expect(args.data.boardColumns.map((column) => column.label)).toEqual(['À contacter']);
    // Les dossiers d'une colonne supprimée retournent à leur statut.
    expect(mockDb.wellbeingCase.updateMany).toHaveBeenCalled();
  });

  test('la direction sans la cellule ne touche pas aux colonnes', async () => {
    expect((await call('PUT', '/board-columns', { columns: [] }, session(DIR))).status).toBe(403);
  });

  test('une étape inconnue est refusée', async () => {
    const { status } = await call('PATCH', '/cases/case-1', { stage: 'inconnue' });
    expect(status).toBe(400);
    expect(mockDb.wellbeingCase.update).not.toHaveBeenCalled();
  });
});

describe('bilan de la cellule', () => {
  test('les fiches comptent sans la sienne, et les étapes apparaissent', async () => {
    const { status, json } = await call('GET', '/stats');
    expect(status).toBe(200);
    const args = mockDb.wellbeingProfileNote.findMany.mock.calls[0]?.[0] as { where: { profile: Record<string, unknown> } };
    expect(args.where.profile).toEqual({ guildId: GUILD, subjectUserId: { not: ALICE } });
    expect(json.profiles).toEqual({ people: 0, notes: 0, sensitive: 0, expiringSoon: 0 });
    expect(json.stages).toEqual([]);
  });
});

describe('membres de la cellule proposés dans les listes', () => {
  test('la cellule reçoit ses membres, sans personne d autre', async () => {
    const { status, json } = await call('GET', '/team');
    expect(status).toBe(200);
    expect(json.members.map((member: { id: string }) => member.id).sort()).toEqual([ALICE, BOB].sort());
  });

  test('la direction sans la cellule ne reçoit rien', async () => {
    expect((await call('GET', '/team', undefined, session(DIR))).status).toBe(403);
  });
});

describe('fiches confidentielles', () => {
  async function profileCall(method: string, suffix: string, body?: unknown, user: AuthClaims = session(ALICE)) {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, user);
    const { status, body: json } = await dashboardCall(createWellbeingProfilesRouter(client), method, `/api/dashboard/guilds/${GUILD}/wellbeing${suffix}`, body);
    return { status, json };
  }

  test('réservées à la cellule : la direction sans la cellule ne lit rien', async () => {
    const { status } = await profileCall('GET', '/profiles', undefined, session(DIR));
    expect(status).toBe(403);
    expect(mockDb.wellbeingProfile.findMany).not.toHaveBeenCalled();
  });

  test('une connexion ancienne doit être renouvelée', async () => {
    const { status, json } = await profileCall('GET', `/profiles/${SUBJECT}`, undefined, session(ALICE, 13));
    expect(status).toBe(403);
    expect(json.code).toBe('WELLBEING_REAUTH');
  });

  test('la liste écarte la fiche de la personne qui la consulte', async () => {
    await profileCall('GET', '/profiles');
    const args = mockDb.wellbeingProfile.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({ guildId: GUILD, subjectUserId: { not: ALICE } });
  });

  test('personne ne lit ni n annote sa propre fiche, et le refus le dit', async () => {
    const read = await profileCall('GET', `/profiles/${ALICE}`);
    expect(read.status).toBe(403);
    expect(read.json.error).toContain('vous concerne');
    expect((await profileCall('POST', `/profiles/${ALICE}/notes`, { content: 'x', subjectName: 'alice' })).status).toBe(403);
    expect(mockDb.wellbeingProfile.findUnique).not.toHaveBeenCalled();
    expect(mockDb.wellbeingProfileNote.create).not.toHaveBeenCalled();
  });

  test('un identifiant invalide reste introuvable', async () => {
    expect((await profileCall('GET', '/profiles/pas-un-id')).status).toBe(404);
  });

  test('une note est chiffrée et reçoit sa date d effacement', async () => {
    const { status } = await profileCall('POST', `/profiles/${SUBJECT}/notes`, { content: 'Se sent isolé', subjectName: 'Sujet' });
    expect(status).toBe(201);
    const args = mockDb.wellbeingProfileNote.create.mock.calls[0]?.[0] as { data: { content: string; expiresAt: Date } };
    expect(args.data.content).not.toContain('isolé');
    const months = (args.data.expiresAt.getTime() - Date.now()) / (30 * 24 * HOUR);
    expect(months).toBeGreaterThan(11);
    expect(months).toBeLessThan(13);
  });

  test('une note sensible ne vit que 3 mois', async () => {
    const { status } = await profileCall('POST', `/profiles/${SUBJECT}/notes`, { content: 'Suivi médical', subjectName: 'Sujet', sensitive: true });
    expect(status).toBe(201);
    const args = mockDb.wellbeingProfileNote.create.mock.calls[0]?.[0] as { data: { expiresAt: Date; sensitive: boolean } };
    expect(args.data.sensitive).toBe(true);
    const days = (args.data.expiresAt.getTime() - Date.now()) / (24 * HOUR);
    expect(days).toBeGreaterThan(85);
    expect(days).toBeLessThan(95);
  });

  test('prolonger sans motif est refusé', async () => {
    profile = { id: 'profile-1', guildId: GUILD, subjectUserId: SUBJECT, subjectName: 'Sujet', subjectLeftAt: null };
    profileNote = { id: 'pnote-1', profileId: 'profile-1', content: 'x', expiresAt: new Date(Date.now() + 3 * 24 * HOUR), purgeWarnedAt: new Date() };
    const { status } = await profileCall('POST', `/profiles/${SUBJECT}/notes/pnote-1/extend`, { reason: ' ' });
    expect(status).toBe(400);
    expect(mockDb.wellbeingProfileNote.update).not.toHaveBeenCalled();
  });

  test('ouvrir beaucoup de fiches en peu de temps prévient la cellule', async () => {
    for (let i = 0; i < 10; i += 1) {
      const subject = `20000000000000000${i}`;
      profile = { id: `profile-burst-${i}`, guildId: GUILD, subjectUserId: subject, subjectName: 'Sujet', subjectLeftAt: null, notes: [] };
      expect((await profileCall('GET', `/profiles/${subject}`, undefined, session(BOB))).status).toBe(200);
    }
    const details = mockDb.dashboardAuditLog.create.mock.calls.map((call) => String((call[0] as { data: { details: string } }).data.details));
    expect(details.some((text) => text.includes('Consultation inhabituelle'))).toBe(true);
  });

  test("seul l'auteur efface sa note, et l'effacement entre au journal", async () => {
    profile = { id: 'profile-1', guildId: GUILD, subjectUserId: SUBJECT, subjectName: 'Sujet', subjectLeftAt: null };
    profileNote = { id: 'pnote-1', profileId: 'profile-1', authorId: BOB, content: 'x', expiresAt: new Date() };
    expect((await profileCall('DELETE', `/profiles/${SUBJECT}/notes/pnote-1`)).status).toBe(403);
    expect(mockDb.wellbeingProfileNote.delete).not.toHaveBeenCalled();
    expect((await profileCall('DELETE', `/profiles/${SUBJECT}/notes/pnote-1`, undefined, session(BOB))).status).toBe(200);
    expect(mockDb.wellbeingProfileNote.delete).toHaveBeenCalledTimes(1);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalled();
  });

  test('une prolongation motivée repart pour la durée réglée et annule l annonce', async () => {
    profile = { id: 'profile-1', guildId: GUILD, subjectUserId: SUBJECT, subjectName: 'Sujet', subjectLeftAt: null };
    profileNote = { id: 'pnote-1', profileId: 'profile-1', content: 'x', expiresAt: new Date(Date.now() + 3 * 24 * HOUR), purgeWarnedAt: new Date() };
    const { status } = await profileCall('POST', `/profiles/${SUBJECT}/notes/pnote-1/extend`, { reason: 'Suivi encore utile' });
    expect(status).toBe(200);
    const args = mockDb.wellbeingProfileNote.update.mock.calls[0]?.[0] as { data: { expiresAt: Date; purgeWarnedAt: null; extendedReason: string } };
    expect(args.data.purgeWarnedAt).toBeNull();
    expect(args.data.extendedReason).not.toContain('Suivi');
    expect(args.data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 300 * 24 * HOUR);
  });
});

describe('personnalisation de la cellule', () => {
  test('réservée à la cellule : la direction ne règle rien', async () => {
    const { status } = await call('PUT', '/customization', { tags: [{ label: 'X' }] }, session(DIR));
    expect(status).toBe(403);
    expect(mockDb.wellbeingConfig.update).not.toHaveBeenCalled();
  });

  test('seuls les réglages envoyés sont enregistrés, nettoyés', async () => {
    const { status, json } = await call('PUT', '/customization', { tags: [{ label: 'Mineur' }, { label: 'mineur' }, { label: 'Hors serveur' }] });
    expect(status).toBe(200);
    const args = mockDb.wellbeingConfig.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(Object.keys(args.data)).toEqual(['caseTags']);
    expect((args.data.caseTags as Array<{ label: string }>).map((tag) => tag.label)).toEqual(['Mineur', 'Hors serveur']);
    expect(json.customization.tags).toHaveLength(2);
  });

  test('l’état de la cellule porte ses réglages', async () => {
    const { json } = await call('GET', '/status');
    expect(json.customization.taskPlans[0].label).toBe('Médiation');
    expect(json.customization.crisisTasks.length).toBeGreaterThan(0);
    expect(json.customization.crisisDefault).toBe(true);
  });

  test('une catégorie inconnue de la cellule devient la première proposée', async () => {
    await call('POST', '/cases', { subjectName: 'S', title: 'T', summary: 'R', category: 'inconnue' });
    const args = mockDb.wellbeingCase.create.mock.calls[0]?.[0] as { data: { category: string } };
    expect(args.data.category).toBe('SOUTIEN');
  });

  test('un dossier ne garde que les étiquettes de la cellule, et l’historique le dit', async () => {
    const { status } = await call('PATCH', '/cases/case-1', { tagIds: ['tag-1', 'inconnue'] });
    expect(status).toBe(200);
    const args = mockDb.wellbeingCase.update.mock.calls[0]?.[0] as { data: { tagIds: string[] } };
    expect(args.data.tagIds).toEqual(['tag-1']);
    const events = appendCaseEvents.mock.calls.flatMap((call) => call[1]);
    expect(events.some((event) => event.type === 'TAGS' && event.toValue === 'Mineur')).toBe(true);
  });

  test('un plan type ajoute ses tâches au dossier', async () => {
    const { status } = await call('POST', '/cases/case-1/plan', { planId: 'plan-1' });
    expect(status).toBe(201);
    const args = mockDb.wellbeingCaseTask.createMany.mock.calls[0]?.[0] as { data: Array<{ dueAt: Date | null }> };
    expect(args.data).toHaveLength(2);
    expect(args.data[1]?.dueAt).toBeNull();
  });

  test('un plan inconnu est refusé', async () => {
    const { status } = await call('POST', '/cases/case-1/plan', { planId: 'aucun' });
    expect(status).toBe(404);
    expect(mockDb.wellbeingCaseTask.createMany).not.toHaveBeenCalled();
  });
});

describe('étiquettes d’une fiche', () => {
  async function profileCall(method: string, suffix: string, body?: unknown) {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, session(ALICE));
    const { status, body: json } = await dashboardCall(createWellbeingProfilesRouter(client), method, `/api/dashboard/guilds/${GUILD}/wellbeing${suffix}`, body);
    return { status, json };
  }

  test('seules les étiquettes de la cellule sont posées', async () => {
    profile = { id: 'profile-1', guildId: GUILD, subjectUserId: SUBJECT, subjectName: 'Sujet', tagIds: [] };
    try {
      const { status } = await profileCall('PUT', `/profiles/${SUBJECT}/tags`, { tagIds: ['tag-1', 'autre'] });
      expect(status).toBe(200);
      const args = mockDb.wellbeingProfile.update.mock.calls[0]?.[0] as { data: { tagIds: string[] } };
      expect(args.data.tagIds).toEqual(['tag-1']);
    } finally {
      profile = null;
    }
  });

  test('pas de fiche, pas d’étiquette', async () => {
    const { status } = await profileCall('PUT', `/profiles/${SUBJECT}/tags`, { tagIds: ['tag-1'] });
    expect(status).toBe(404);
  });
});

describe('personnalisation : création, bilan et réseau', () => {
  const PLAN_CATEGORY = [{ id: 'SOUTIEN', label: 'Soutien', template: '', planId: 'plan-1' }];

  test('un dossier créé dans une catégorie reliée à un plan reçoit ses tâches', async () => {
    mockDb.wellbeingConfig.findUnique.mockImplementation(async () => ({ ...CONFIG, caseCategories: PLAN_CATEGORY }));
    try {
      await call('POST', '/cases', { subjectName: 'S', title: 'T', summary: 'R', category: 'SOUTIEN' });
      const args = mockDb.wellbeingCaseTask.createMany.mock.calls[0]?.[0] as { data: unknown[] };
      expect(args.data).toHaveLength(2);
    } finally {
      mockDb.wellbeingConfig.findUnique.mockImplementation(async () => CONFIG);
    }
  });

  test('sans plan relié, aucune tâche n’est ajoutée à la création', async () => {
    await call('POST', '/cases', { subjectName: 'S', title: 'T', summary: 'R', category: 'SOUTIEN' });
    expect(mockDb.wellbeingCaseTask.createMany).not.toHaveBeenCalled();
  });

  test('les étiquettes choisies à la création sont gardées si elles existent', async () => {
    await call('POST', '/cases', { subjectName: 'S', title: 'T', summary: 'R', tagIds: ['tag-1', 'inconnue'] });
    const args = mockDb.wellbeingCase.create.mock.calls[0]?.[0] as { data: { tagIds: string[] } };
    expect(args.data.tagIds).toEqual(['tag-1']);
  });

  test('le bilan compte les dossiers actifs par étiquette', async () => {
    mockDb.wellbeingCase.findMany.mockImplementationOnce(async () => [
      { ...makeCase(), tagIds: ['tag-1'] },
      { ...makeCase({ status: 'CLOSED' }), tagIds: ['tag-1'] },
    ] as never);
    const { status, json } = await call('GET', '/stats');
    expect(status).toBe(200);
    expect(json.tags).toEqual([{ label: 'Mineur', count: 1 }]);
  });

  test('les trames de notes s’enregistrent comme les autres réglages', async () => {
    const { status } = await call('PUT', '/customization', { noteTemplates: [{ label: 'Échange', text: 'Échange du …' }] });
    expect(status).toBe(200);
    const args = mockDb.wellbeingConfig.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(Object.keys(args.data)).toEqual(['noteTemplates']);
  });

  test('hors réseau, aucune cellule à reprendre', async () => {
    const { status, json } = await call('GET', '/customization/sources');
    expect(status).toBe(200);
    expect(json.sources).toEqual([]);
  });

  test('reprendre les réglages d’une cellule du réseau qui les partage', async () => {
    const OTHER = '900000000000000002';
    networkGuildIds.mockImplementation(async () => [GUILD, OTHER]);
    mockDb.wellbeingConfig.findUnique.mockImplementation(async (args?: unknown) =>
      ((args as { where: { guildId: string } }).where.guildId === OTHER
        ? { ...CONFIG, guildId: OTHER, networkPool: true, caseTags: [{ id: 'x', label: 'Partagée' }] }
        : CONFIG));
    try {
      const { status, json } = await call('POST', '/customization/import', { guildId: OTHER, kinds: ['tags'] });
      expect(status).toBe(200);
      const args = mockDb.wellbeingConfig.update.mock.calls[0]?.[0] as { where: { guildId: string }; data: { caseTags: Array<{ label: string }> } };
      expect(args.where.guildId).toBe(GUILD);
      expect(args.data.caseTags.map((tag) => tag.label)).toEqual(['Partagée']);
      expect(json.customization.tags[0].label).toBe('Partagée');
    } finally {
      networkGuildIds.mockImplementation(async () => []);
      mockDb.wellbeingConfig.findUnique.mockImplementation(async () => CONFIG);
    }
  });

  test('une cellule qui ne partage pas, ou hors du réseau, ne se reprend pas', async () => {
    const OTHER = '900000000000000002';
    expect((await call('POST', '/customization/import', { guildId: OTHER, kinds: ['tags'] })).status).toBe(404);
    networkGuildIds.mockImplementation(async () => [GUILD, OTHER]);
    try {
      expect((await call('POST', '/customization/import', { guildId: OTHER, kinds: ['tags'] })).status).toBe(403);
      expect(mockDb.wellbeingConfig.update).not.toHaveBeenCalled();
    } finally {
      networkGuildIds.mockImplementation(async () => []);
    }
  });
});

