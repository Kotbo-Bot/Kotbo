import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims, type DashboardAccess } from '../../api/shared.js';

/**
 * Route `channels-management`, volet vocal : journal des changements, mention du
 * propriétaire, validation des entrées, codes d'erreur stables, notices et
 * valeurs relues après enregistrement. Vrai handler, base simulée.
 *
 * Ne pas mocker `../../utils/logger` (mock.module est global au process).
 */

const GUILD = '100000000000000000';
const OWNER = '200000000000000000';
const ROLE = '800000000000000000';
const PREVIOUS_ROLE = '810000000000000000';
const CHANNEL = '400000000000000000';
const GEN_A = '500000000000000001';
const GEN_B = '500000000000000002';

let tempVoiceRow: Record<string, unknown> | null = null;
const mockDb = {
  tempVoiceChannel: {
    findMany: mock(async () => [tempVoiceRow]),
    findUnique: mock(async () => tempVoiceRow),
    update: mock(async () => tempVoiceRow),
    delete: mock(async () => ({})),
  },
  dashboardAuditLog: { create: mock(async (_arg: unknown) => ({})) },
  guild: { findUnique: mock(async () => null as unknown), update: mock(async (_a: unknown) => ({})) },
  tempVoiceAccessRequestConfig: {
    findUnique: mock(async () => null as unknown),
    upsert: mock(async (_a: unknown) => ({})),
  },
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async () => null as unknown),
    upsert: mock(async (_a: unknown) => ({})),
  },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { handleChannelsManagementRoutes, explainDroppedGenerators } =
  await import('../../api/routes/dashboard/modules/channels-management.js');

function createMockRequest(body: Record<string, unknown>, method = 'PATCH'): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

interface MockResponse extends ServerResponse {
  body: string;
}

function createMockResponse(): MockResponse {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as MockResponse;
  let code = 200;
  let out = '';
  Object.defineProperty(res, 'statusCode', { get: () => code, set: (v: number) => { code = v; } });
  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (status: number) => { code = status; return res; };
  res.end = (chunk?: unknown) => {
    if (chunk) out += String(chunk);
    res.body = out;
    return res;
  };
  return res;
}

/** Serveur avec quelques salons et rôles en cache, de quoi nommer les ids. */
function mockClient(extra: { channel?: Record<string, unknown> } = {}) {
  const channels = new Map<string, unknown>([
    [GEN_A, { id: GEN_A, name: 'Créer A', type: 2 }],
    [GEN_B, { id: GEN_B, name: 'Créer B', type: 2 }],
    ...(extra.channel ? [[CHANNEL, extra.channel] as [string, unknown]] : []),
  ]);
  const guild = {
    id: GUILD,
    name: 'Serveur test',
    preferredLocale: 'fr',
    channels: { cache: channels, fetch: mock(async (id: string) => channels.get(id) ?? null) },
    roles: { cache: new Map<string, unknown>([[ROLE, { id: ROLE, name: 'Membres' }], [PREVIOUS_ROLE, { id: PREVIOUS_ROLE, name: 'Anciens' }]]) },
    members: { cache: new Map<string, unknown>([[OWNER, { id: OWNER }]]), fetch: mock(async () => ({ id: OWNER })) },
  };
  Object.assign(extra.channel ?? {}, { guild });
  return { client: { guilds: { cache: new Map<string, unknown>([[GUILD, guild]]) } } as unknown as Client };
}

const GUILD_ROW = {
  autoThreadEnabled: false,
  autoThreadChannels: [],
  autoThreadBotsEnabled: false,
  statsEnabled: false,
  statsConfig: null,
  tempVoiceEnabled: true,
  tempVoiceChannelId: null,
  tempVoiceCategoryId: null,
  tempVoiceNameTemplate: 'Salon de {user}',
  tempVoiceRequiredRoleId: null,
  tempVoiceDefaults: null,
  tempVoiceGenerators: null,
  honeypotEnabled: false,
  honeypotChannelId: null,
  honeypotSanction: 'WARN',
  honeypotReinvite: false,
  wordStatsEnabled: false,
};

function modRow(overrides: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    canRename: true, canChangeLimit: true, canLock: true, canChangeWriteMode: true,
    canKickOrBan: true, canReserve: true, canTransfer: true,
    panelCompactMode: false, reservableRoleIds: [], reservationOverflow: 'ASK', reservationFallbackChannelId: null,
    panelMode: 'CLASSIC', stateLayout: 'GRID3', stateColors: 'NEUTRAL', panelComponents: 'V2',
    reservationFallbackMode: 'ANY_ROLE', perGeneratorPresentation: false, ownerMentionPlacement: 'panel',
    handoverDmEnabled: true, handoverDelaySeconds: 30, claimEmbedEnabled: true, claimWho: 'present',
    moderatorClaimOverride: true, deleteWhenEmpty: true,
    ...overrides,
  };
}

async function callConfig(method: 'GET' | 'PATCH', body: Record<string, unknown>, client = mockClient().client) {
  const res = createMockResponse();
  await handleChannelsManagementRoutes({
    req: createMockRequest(body, method),
    res,
    parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management'],
    url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management`),
    client,
    user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
    guildId: GUILD,
    access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
    method,
    auditUser: 'Toji (dashboard)',
    moduleKey: 'channels-management',
  });
  return res;
}

const audits = () => mockDb.dashboardAuditLog.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

beforeEach(() => {
  mockDb.dashboardAuditLog.create = mock(async (_arg: unknown) => ({}));
  mockDb.guild.findUnique = mock(async () => GUILD_ROW);
  mockDb.guild.update = mock(async (_a: unknown) => ({}));
  mockDb.tempVoiceAccessRequestConfig.findUnique = mock(async () => null);
  mockDb.tempVoiceAccessRequestConfig.upsert = mock(async (_a: unknown) => ({}));
  mockDb.tempVoiceModPermissionsConfig.findUnique = mock(async () => modRow());
  mockDb.tempVoiceModPermissionsConfig.upsert = mock(async (_a: unknown) => ({}));
});

describe('B — journal des changements de réglages vocaux', () => {
  test('un seul audit, une ligne « champ : avant → après » par champ modifié, avec l\'utilisateur', async () => {
    const res = await callConfig('PATCH', {
      tempVoiceModPermissions: { panelMode: 'FLAT', ownerMentionPlacement: 'none' },
      tempVoiceAccessRequest: { denyCooldownMinutes: 30 },
      tempVoiceDefaults: { userLimit: 12 },
    });

    expect(res.statusCode).toBe(200);
    const [entry, ...reste] = audits();
    expect(reste).toHaveLength(0);
    expect(entry.user).toBe('Toji (dashboard)');
    const lignes = String(entry.details).split('\n');
    expect(lignes).toContain('Panneau : mode : CLASSIC → FLAT');
    expect(lignes).toContain('Mention du propriétaire : panel → none');
    expect(lignes).toContain('Demandes d\'accès : silence après un refus (min) : 10 → 30');
    expect(lignes).toContain('Générateur principal : places : 0 → 12');
    expect(lignes).toHaveLength(4);
  });

  test('aucun champ vocal modifié : aucune ligne d\'audit', async () => {
    const res = await callConfig('PATCH', {
      tempVoiceModPermissions: { panelMode: 'CLASSIC', ownerMentionPlacement: 'panel' },
      tempVoiceDefaults: { userLimit: 0 },
    });

    expect(res.statusCode).toBe(200);
    expect(audits()).toHaveLength(0);
  });

  test('les salons et rôles sont nommés quand le cache les connaît, sinon l\'id', async () => {
    await callConfig('PATCH', {
      tempVoiceGenerators: [{ channelId: GEN_A, requiredRoleId: ROLE, autoAllowRoleIds: [PREVIOUS_ROLE] }],
      tempVoiceModPermissions: { reservationFallbackChannelId: '999999999999999999', reservableRoleIds: [ROLE] },
    });

    const lignes = String(audits()[0].details).split('\n');
    expect(lignes).toContain('Générateur #Créer A : (aucun) → ajouté');
    expect(lignes.some((l) => l.startsWith('Réservation : salon de repli : (aucun) → 999999999999999999'))).toBe(true);
    expect(lignes).toContain('Réservation : rôles proposés : (aucun) → @Membres');
  });

  test('les autres clés du corps gardent la ligne générique, séparée', async () => {
    await callConfig('PATCH', { honeypotReinvite: true, tempVoiceModPermissions: { panelMode: 'FLAT' } });

    const entries = audits();
    expect(entries.map((e) => e.action)).toEqual([
      expect.stringContaining('Réglages vocaux modifiés'),
      'Sauvegarde configuration Gestion des salons',
    ]);
  });
});

describe('B — actions sur un salon actif', () => {
  function activeChannel() {
    const edits: Array<{ target: unknown; reason?: string }> = [];
    const channel: Record<string, unknown> = {
      id: CHANNEL,
      name: 'Salon de Tojii',
      type: 2,
      parentId: null,
      parent: null,
      members: new Map(),
      manageable: true,
      setName: mock(async (_name: string, _reason?: string) => channel),
      delete: mock(async (_reason?: string) => channel),
      permissionOverwrites: {
        edit: mock(async (target: unknown, _patch: unknown, opts?: { reason?: string }) => { edits.push({ target, reason: opts?.reason }); }),
        delete: mock(async (_id: string, _reason?: string) => {}),
      },
    };
    return { channel, edits };
  }

  async function patchActive(client: Client, body: Record<string, unknown>) {
    const res = createMockResponse();
    await handleChannelsManagementRoutes({
      req: createMockRequest(body),
      res,
      parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management', 'temp-voice', 'channels', CHANNEL],
      url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management/temp-voice/channels/${CHANNEL}`),
      client,
      user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
      guildId: GUILD,
      access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
      method: 'PATCH',
      auditUser: 'Toji (dashboard)',
      moduleKey: 'channels-management',
    });
    return res;
  }

  beforeEach(() => {
    tempVoiceRow = { id: CHANNEL, guildId: GUILD, creatorId: OWNER, roleId: PREVIOUS_ROLE, createdAt: new Date() };
    mockDb.tempVoiceChannel.findUnique = mock(async () => tempVoiceRow);
    mockDb.tempVoiceChannel.update = mock(async () => tempVoiceRow);
    mockDb.tempVoiceChannel.delete = mock(async () => ({}));
  });

  test('renommer : channelId réel et raison Discord avec l\'utilisateur', async () => {
    const { channel } = activeChannel();
    const { client } = mockClient({ channel });

    await patchActive(client, { name: 'Nouveau' });

    expect((channel.setName as ReturnType<typeof mock>).mock.calls[0][1]).toContain('Toji (dashboard)');
    expect(audits()[0].channelId).toBe(CHANNEL);
  });

  test('réserver : ancien rôle → nouveau rôle lisible, raison sur chaque écriture de permissions', async () => {
    const { channel, edits } = activeChannel();
    const { client } = mockClient({ channel });

    const res = await patchActive(client, { roleId: ROLE });

    expect(res.statusCode).toBe(200);
    const entry = audits()[0];
    expect(entry.channelId).toBe(CHANNEL);
    expect(String(entry.details)).toContain('@Anciens → @Membres');
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) expect(e.reason).toContain('Toji (dashboard)');
    const deleteCall = (channel.permissionOverwrites as { delete: ReturnType<typeof mock> }).delete.mock.calls[0];
    expect(deleteCall[1]).toContain('Toji (dashboard)');
  });

  test('libérer : audit lisible et raison sur la restauration', async () => {
    const { channel, edits } = activeChannel();
    const { client } = mockClient({ channel });

    await patchActive(client, { roleId: null });

    expect(String(audits()[0].details)).toContain('@Anciens → aucun');
    expect(edits[0].reason).toContain('Toji (dashboard)');
  });

  test('fermer : channelId réel et raison avec l\'utilisateur', async () => {
    const { channel } = activeChannel();
    const { client } = mockClient({ channel });

    await patchActive(client, { action: 'DELETE' });

    expect((channel.delete as ReturnType<typeof mock>).mock.calls[0][0]).toContain('Toji (dashboard)');
    expect(audits()[0].channelId).toBe(CHANNEL);
  });
});

describe('A — mention du propriétaire', () => {
  test('GET : défaut « panel » sans ligne, valeur stockée sinon, valeur inconnue relue au défaut', async () => {
    mockDb.tempVoiceModPermissionsConfig.findUnique = mock(async () => null);
    let served = JSON.parse((await callConfig('GET', {})).body).tempVoiceModPermissions;
    expect(served.ownerMentionPlacement).toBe('panel');

    mockDb.tempVoiceModPermissionsConfig.findUnique = mock(async () => modRow({ ownerMentionPlacement: 'message' }));
    served = JSON.parse((await callConfig('GET', {})).body).tempVoiceModPermissions;
    expect(served.ownerMentionPlacement).toBe('message');

    mockDb.tempVoiceModPermissionsConfig.findUnique = mock(async () => modRow({ ownerMentionPlacement: 'partout' }));
    served = JSON.parse((await callConfig('GET', {})).body).tempVoiceModPermissions;
    expect(served.ownerMentionPlacement).toBe('panel');
  });

  test('PATCH : les trois valeurs sont écrites', async () => {
    for (const value of ['panel', 'message', 'none']) {
      mockDb.tempVoiceModPermissionsConfig.upsert = mock(async (_a: unknown) => ({}));
      const res = await callConfig('PATCH', { tempVoiceModPermissions: { ownerMentionPlacement: value } });
      expect(res.statusCode).toBe(200);
      const call = mockDb.tempVoiceModPermissionsConfig.upsert.mock.calls[0][0] as { update: Record<string, unknown>; create: Record<string, unknown> };
      expect(call.update.ownerMentionPlacement).toBe(value);
      expect(call.create.ownerMentionPlacement).toBe(value);
    }
  });

  test('PATCH : une valeur hors liste est un 400 avec code, rien n\'est écrit', async () => {
    const res = await callConfig('PATCH', { tempVoiceModPermissions: { ownerMentionPlacement: 'partout' } });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('tv_setting_invalid_choice');
    expect(body.params).toMatchObject({ field: 'ownerMentionPlacement', expected: 'panel | message | none' });
    expect(mockDb.tempVoiceModPermissionsConfig.upsert).not.toHaveBeenCalled();
    expect(mockDb.guild.update).not.toHaveBeenCalled();
  });
});

describe('3 — silence après un refus : bornes 1..1440', () => {
  test('0 est refusé (le bot le lit comme 1 minute), 1 et 1440 passent, 1441 est refusé', async () => {
    for (const [value, status] of [[0, 400], [1, 200], [1440, 200], [1441, 400]] as const) {
      const res = await callConfig('PATCH', { tempVoiceAccessRequest: { denyCooldownMinutes: value } });
      expect(res.statusCode).toBe(status);
      if (status === 400) {
        const body = JSON.parse(res.body);
        expect(body.code).toBe('tv_setting_invalid_range');
        expect(body.params).toMatchObject({ field: 'denyCooldownMinutes', min: 1, max: 1440 });
      }
    }
  });

  test('GET : une ligne qui stocke 0 est relue 1', async () => {
    mockDb.tempVoiceAccessRequestConfig.findUnique = mock(async () => ({
      guildId: GUILD, enabled: true, responders: 'OWNER', notifyVia: 'DM', notifyChannelId: null,
      requestExpiresMinutes: 10, denyCooldownMinutes: 0,
    }));
    const served = JSON.parse((await callConfig('GET', {})).body).tempVoiceAccessRequest;
    expect(served.denyCooldownMinutes).toBe(1);
  });
});

describe('9 — entrées validées avant toute écriture', () => {
  test('un gabarit de nom null ou numérique est un 400 en français avec code, pas un 500', async () => {
    for (const value of [null, 42, { a: 1 }]) {
      const res = await callConfig('PATCH', { tempVoiceNameTemplate: value });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('tv_name_template_invalid');
      expect(body.error).toContain('Modèle de nom');
    }
    expect(mockDb.guild.update).not.toHaveBeenCalled();
  });

  test('un gabarit texte est écrit, rogné à 100 caractères', async () => {
    const res = await callConfig('PATCH', { tempVoiceNameTemplate: `  ${'x'.repeat(150)}  ` });
    expect(res.statusCode).toBe(200);
    const data = (mockDb.guild.update.mock.calls[0][0] as unknown as { data: Record<string, unknown> }).data;
    expect(data.tempVoiceNameTemplate).toBe('x'.repeat(100));
  });

  test('des identifiants qui n\'en sont pas sont refusés, null et vide valent « aucun »', async () => {
    for (const key of ['tempVoiceChannelId', 'tempVoiceCategoryId', 'tempVoiceRequiredRoleId']) {
      for (const bad of ['salon-general', 123, ['4000'], '12345']) {
        const res = await callConfig('PATCH', { [key]: bad });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({ code: 'tv_snowflake_invalid', params: { field: key } });
      }
      mockDb.guild.update = mock(async (_a: unknown) => ({}));
      for (const empty of [null, '']) {
        expect((await callConfig('PATCH', { [key]: empty })).statusCode).toBe(200);
        expect((mockDb.guild.update.mock.calls.at(-1)![0] as unknown as { data: Record<string, unknown> }).data[key]).toBeNull();
      }
      expect((await callConfig('PATCH', { [key]: CHANNEL })).statusCode).toBe(200);
    }
  });

  test('les salons des demandes d\'accès et du repli de réservation sont aussi contrôlés', async () => {
    let res = await callConfig('PATCH', { tempVoiceAccessRequest: { notifyChannelId: 'general' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).params.field).toBe('notifyChannelId');

    res = await callConfig('PATCH', { tempVoiceModPermissions: { reservationFallbackChannelId: 7 } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('tv_snowflake_invalid');
  });
});

describe('C — codes d\'erreur stables', () => {
  test('chaque refus porte un `code`, en plus du texte français', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ tempVoiceModPermissions: 'x' }, 'tv_object_expected'],
      [{ tempVoiceAccessRequest: [] }, 'tv_object_expected'],
      [{ tempVoiceModPermissions: { claimWho: 'tous' } }, 'tv_setting_invalid_choice'],
      [{ tempVoiceModPermissions: { handoverDelaySeconds: 1 } }, 'tv_setting_invalid_range'],
      [{ tempVoiceAccessRequest: { requestExpiresMinutes: 0 } }, 'tv_setting_invalid_range'],
      [{ tempVoiceGenerators: [{ channelId: GEN_A, panelMode: 'ZZZ' }] }, 'tv_setting_invalid_choice'],
      [{ honeypotSanction: 'KILL' }, 'tv_honeypot_sanction_invalid'],
    ];
    for (const [body, code] of cases) {
      const res = await callConfig('PATCH', body);
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe(code);
      expect(parsed.error.length).toBeGreaterThan(10);
    }
  });

  test('salon introuvable (renommage / suppression) : code stable', async () => {
    const res = createMockResponse();
    await handleChannelsManagementRoutes({
      req: createMockRequest({ name: 'x' }),
      res,
      parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management', 'channel', CHANNEL],
      url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management/channel/${CHANNEL}`),
      client: mockClient().client,
      user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
      guildId: GUILD,
      access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
      method: 'PATCH',
      auditUser: 'Admin',
      moduleKey: 'channels-management',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('tv_channel_not_found');
  });
});

describe('1 — générateurs écartés par le serveur : notice', () => {
  test('un salon déjà pris par le principal ou par un autre générateur est signalé', async () => {
    const res = await callConfig('PATCH', {
      tempVoiceChannelId: GEN_A,
      tempVoiceGenerators: [
        { channelId: GEN_A },
        { channelId: GEN_B },
        { channelId: GEN_B },
        { categoryId: CHANNEL },
      ],
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resolved.tempVoiceGenerators.map((g: { channelId: string }) => g.channelId)).toEqual([GEN_B]);
    expect(body.notices).toHaveLength(3);
    expect(body.notices[0]).toContain('n°2');
    expect(body.notices[0]).toContain('déjà le générateur principal');
    expect(body.notices[1]).toContain('n°4');
    expect(body.notices[1]).toContain('déjà utilisé par le générateur n°3');
    expect(body.notices[2]).toContain('n°5');
    expect(body.notices[2]).toContain('aucun salon vocal valide');
  });

  test('sans écart, pas de champ `notices`', async () => {
    const res = await callConfig('PATCH', { tempVoiceGenerators: [{ channelId: GEN_A }, { channelId: GEN_B }] });
    expect(JSON.parse(res.body).notices).toBeUndefined();
  });

  test('explainDroppedGenerators : plafond et noms de salons', () => {
    const input = Array.from({ length: 27 }, (_, i) => ({ channelId: `5000000000000${String(i).padStart(5, '0')}` }));
    const kept = input.slice(0, 25);
    const notices = explainDroppedGenerators(input, kept, null, (id) => (id === input[25].channelId ? 'Trop' : undefined));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('plafond de 25');
  });
});

describe('12 — la page réapplique ce que le serveur a gardé', () => {
  test('`resolved` porte la politique normalisée et les deux configs complètes', async () => {
    const res = await callConfig('PATCH', {
      tempVoiceDefaults: { userLimit: 150, lockOnCreate: true, textChat: 'inconnu' },
      tempVoiceAccessRequest: { requestExpiresMinutes: 12.7 },
      tempVoiceModPermissions: { panelMode: 'FLAT' },
    });

    expect(res.statusCode).toBe(200);
    const { resolved } = JSON.parse(res.body);
    expect(resolved.tempVoiceDefaults).toMatchObject({ userLimit: 99, lockOnCreate: true, textChat: 'inherit' });
    expect(resolved.tempVoiceAccessRequest.requestExpiresMinutes).toBe(12);
    expect(resolved.tempVoiceModPermissions).toMatchObject({ panelMode: 'FLAT', ownerMentionPlacement: 'panel', canRename: true });
  });
});
