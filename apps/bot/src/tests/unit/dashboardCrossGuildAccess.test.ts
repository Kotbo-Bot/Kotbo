/**
 * Un élément d'un autre serveur ne se manipule pas depuis le dashboard du sien.
 *
 * Tickets, événements, liens de serveur staff et invitations étaient pris par leur seul
 * identifiant : le staff d'un serveur pouvait fermer un ticket, publier un événement,
 * décider des rôles synchronisés ou marquer une invitation d'un autre serveur. Chaque
 * route vérifie désormais l'appartenance et répond « introuvable » sinon.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';

/**
 * Source d'une route du dashboard, fins de ligne ramenées à LF : les motifs
 * cherchés ci-dessous portent des `\n`, qu'un checkout Windows (CRLF) cassait.
 */
const readRouteSource = (file: string) =>
  readFileSync(path.resolve(import.meta.dir, '../../api/routes/dashboard', file), 'utf8').replace(/\r\n/g, '\n');

const HERE = 'guild-here';
const ELSEWHERE = 'guild-elsewhere';

/** Les écritures reçues, par « modèle.méthode ». */
let writes: string[] = [];
/** Le filtre `where` de chaque écriture, pour vérifier qu'il porte le serveur. */
let writeWheres: Array<{ key: string; where: any }> = [];

const rows: Record<string, (args: any) => unknown> = {
  // Chaque élément appartient à l'autre serveur : un filtre sur `guildId: HERE` ne le trouve pas.
  'ticket.findFirst': ({ where }) => (where.guildId === ELSEWHERE ? { id: where.id, guildId: ELSEWHERE, channelId: 'c1' } : null),
  'ticket.findUnique': ({ where }) => ({ id: where.id, guildId: ELSEWHERE, channelId: 'c1' }),
  'event.findFirst': ({ where }) => (where.guildId === ELSEWHERE ? { id: where.id } : null),
  'event.findUnique': ({ where }) => ({ id: where.id, guildId: ELSEWHERE }),
  'staffServerLink.findUnique': () => ({ id: 'link-1', mainGuildId: ELSEWHERE, staffGuildId: 'guild-staff-elsewhere' }),
  'staffPoll.findFirst': ({ where }) => (where.guildId === ELSEWHERE
    ? { status: 'OPEN', closesAt: null, options: [{ id: 'opt-1' }] }
    : null),
  'guildInvite.findFirst': ({ where }) => (where.guildId === ELSEWHERE ? { code: where.code } : null),
};

const WRITE_METHODS = new Set(['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

const mockDb: any = new Proxy({}, {
  get(_target, model: string) {
    if (model === '$transaction') return async (arg: any) => (typeof arg === 'function' ? arg(mockDb) : Promise.all(arg));
    return new Proxy({}, {
      get(_t, method: string) {
        return async (args: any) => {
          const key = `${model}.${method}`;
          const row = rows[key];
          if (WRITE_METHODS.has(method)) {
            writes.push(key);
            writeWheres.push({ key, where: args?.where });
            if (row) return row(args);
            return method.endsWith('Many') ? { count: 1 } : {};
          }
          if (row) return row(args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          return null;
        };
      },
    });
  },
});

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { handleEventsRoutes } = await import('../../api/routes/dashboard/events.js');
const { handleStaffServerRoutes } = await import('../../api/routes/dashboard/staffServer.js');
const { handleInvitationsRoutes } = await import('../../api/routes/dashboard/modules/invitations.js');

function request(method: string, body: unknown = {}): any {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function response(): any {
  const res: any = { statusCode: 200, headersSent: false, body: '' };
  res.setHeader = () => undefined;
  res.writeHead = (status: number) => { res.statusCode = status; return res; };
  res.end = (chunk?: string) => { if (chunk) res.body += chunk; res.headersSent = true; };
  return res;
}

const user = { userId: 'staff-1', username: 'staff' } as any;
const access = { level: 'admin', canManageSettings: true, canModerateContent: true } as any;
const client: any = { guilds: { cache: new Map(), fetch: async () => null }, channels: { cache: new Map() } };

function moduleCtx(method: string, parts: string[], body?: unknown): any {
  return {
    req: request(method, body), res: response(), parts, url: new URL('http://localhost/'), client, user,
    guildId: HERE, access, method, auditUser: 'staff', moduleKey: parts[4],
  };
}

beforeEach(() => { writes = []; writeWheres = []; });

describe('accès entre serveurs', () => {
  test('un événement d\'un autre serveur ne se modifie ni ne se supprime', async () => {
    for (const [method, parts] of [
      ['PATCH', ['api', 'dashboard', 'guilds', HERE, 'events', 'event-1']],
      ['DELETE', ['api', 'dashboard', 'guilds', HERE, 'events', 'event-1']],
      ['GET', ['api', 'dashboard', 'guilds', HERE, 'events', 'event-1']],
    ] as const) {
      const res = response();
      await handleEventsRoutes(request(method, { title: 'x' }), res, [...parts], new URL('http://localhost/'), client, user, HERE, access);
      expect(res.statusCode).toBe(404);
    }
    expect(writes).toEqual([]);
  });

  test('les rôles d\'un lien staff d\'un autre serveur ne se touchent pas', async () => {
    for (const [method, parts] of [
      ['POST', ['api', 'dashboard', 'guilds', HERE, 'staff-server', 'link-1', 'mappings']],
      ['DELETE', ['api', 'dashboard', 'guilds', HERE, 'staff-server', 'link-1', 'mappings', 'map-1']],
      ['POST', ['api', 'dashboard', 'guilds', HERE, 'staff-server', 'link-1', 'sync']],
    ] as const) {
      const res = response();
      await handleStaffServerRoutes(request(method, { staffRoleId: 'r1' }), res, [...parts], new URL('http://localhost/'), client, user, HERE);
      expect(res.statusCode).toBe(404);
    }
    expect(writes).toEqual([]);
  });

  test('une invitation d\'un autre serveur ne se suspend ni ne se supprime', async () => {
    const suspend = moduleCtx('PUT', ['api', 'dashboard', 'guilds', HERE, 'invitations', 'abc123', 'suspend'], { suspended: true });
    await handleInvitationsRoutes(suspend);
    expect(suspend.res.statusCode).toBe(404);

    const remove = moduleCtx('DELETE', ['api', 'dashboard', 'guilds', HERE, 'invitations', 'abc123']);
    await handleInvitationsRoutes(remove);
    expect(remove.res.statusCode).toBe(404);
    expect(writes).toEqual([]);
  });

  // Les routes des tickets passent d'abord par la carte des droits du membre, qui interroge
  // Discord : le harnais serait plus gros que ce qu'il garde. La garde est lue sur la source,
  // comme `ticketOrphelinCablage`.
  test('chaque action sur un ticket le cherche aussi par son serveur', () => {
    const source = readRouteSource('modules/tickets.ts');
    expect(source).not.toContain('prisma.ticket.findUnique({ where: { id: ticketId } })');
    expect(source.split('prisma.ticket.findFirst({ where: { id: ticketId, guildId } })').length - 1).toBe(9);
  });

  // Même garde, lue sur la source : ces routes passent d'abord par des contrôles de rôle qui
  // interrogent Discord, et la vérification tient en une clause sur le serveur.
  test('déclencheurs, clés API, comptes liés et soumissions sont filtrés par serveur', () => {
    const read = readRouteSource;

    const triggers = read('generalistModules.ts');
    expect(triggers).toContain('prisma.autoResponse.findFirst({\n          where: { id, guildId },');
    expect(triggers).toContain('prisma.autoResponse.deleteMany({\n          where: { id, guildId },');

    expect(read('leadership/apiKeys.ts')).toContain('prisma.aPIKey.findFirst({ where: { id: keyId, guildId } })');

    const members = read('members.ts');
    expect(members).not.toContain('prisma.linkedAccount.findUnique({\n          where: { id }');
    expect(members.split('prisma.linkedAccount.findFirst({\n          where: { id, guildId }').length - 1).toBe(2);

    expect(read('modules/daily-algo-submissions.ts')).toContain('where: { id: submissionId, run: { guildId } }');
  });

  test('un sous-élément de partenariat doit appartenir au dossier du serveur', () => {
    const source = readRouteSource('partnerships.ts');
    for (const model of ['partnershipAgreement', 'partnershipCommitment', 'partnershipPromotion', 'partnershipGuestAccess', 'partnershipPayment']) {
      expect(source).toContain(`prisma.${model}.count({ where: scoped })`);
    }
    // Un pont ne se confirme que depuis le dossier distant.
    expect(source).toContain("subAction === 'confirm'\n        ? { remotePartnershipId: partnershipId }");
    expect(source).toContain('prisma.partnerContact.count({ where: { id: parts[7], partnerId } })');
  });

  test('une alerte de santé d\'un autre serveur ne se résout pas', async () => {
    const { resolveHealthAlert } = await import('../../services/analytics/channelHealthService.js');
    // Le mock ne trouve rien pour ce serveur : l'écriture filtrée ne touche aucune ligne.
    rows['channelHealthAlert.updateMany'] = ({ where }) => ({ count: where.guildId === ELSEWHERE ? 1 : 0 });
    expect(await resolveHealthAlert(HERE, 'alert-1', 'DISMISSED', 'staff-1')).toBe(false);
    expect(await resolveHealthAlert(ELSEWHERE, 'alert-1', 'DISMISSED', 'staff-1')).toBe(true);
  });

  test('tâches, notes manager et clés API ne s\'écrivent que filtrées par serveur', async () => {
    const leadership = await import('../../services/staff/staffLeadershipService.js');
    const management = await import('../../services/staff/staffManagementService.js');

    await leadership.updateTask(HERE, 'task-1', { title: 'x' });
    await leadership.deleteTask(HERE, 'task-1');
    await leadership.deleteManagerNote(HERE, 'note-1');
    await management.deleteAPIKey(HERE, 'key-1');

    expect(writeWheres).toEqual([
      { key: 'staffTask.update', where: { id: 'task-1', guildId: HERE } },
      { key: 'staffTask.delete', where: { id: 'task-1', guildId: HERE } },
      { key: 'staffManagerNote.delete', where: { id: 'note-1', guildId: HERE } },
      { key: 'aPIKey.update', where: { id: 'key-1', guildId: HERE } },
    ]);
  });

  test('on ne vote pas au sondage d\'un autre serveur, ni pour une option hors sondage', async () => {
    const { castPollVote } = await import('../../services/staff/staffLeadershipService.js');

    await expect(castPollVote(HERE, 'poll-1', 'staff-1', 'opt-1')).rejects.toThrow('Sondage introuvable.');
    await expect(castPollVote(ELSEWHERE, 'poll-1', 'staff-1', 'opt-autre')).rejects.toThrow('Option introuvable.');
    expect(writes).toEqual([]);

    await castPollVote(ELSEWHERE, 'poll-1', 'staff-1', 'opt-1');
    expect(writes).toEqual(['staffPollVote.upsert']);
  });
});
