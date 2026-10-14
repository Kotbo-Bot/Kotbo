import { afterAll, describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { APIEmbed, Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { readFileSync } from 'node:fs';
import { TEMP_VOICE_OWNER_MENTION_DEFAULT, TEMP_VOICE_OWNERSHIP_DEFAULTS } from '@kotbo/shared';
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

// Chemin commun des logs : on capture l'embed au lieu de le poster.
const envois: Array<{ embed: APIEmbed; type: string; tag: unknown; sources: unknown; audit: unknown }> = [];
let envoiEnEchec = false;
// Le vrai module, rendu en fin de fichier : `mock.module` est global au process.
const logDispatchReel = { ...(await import('../../utils/logDispatch.js')) };
afterAll(() => {
  for (const logPath of ['../../utils/logDispatch.ts', '../../utils/logDispatch.js']) {
    mock.module(path.resolve(__dirname, logPath), () => logDispatchReel);
  }
});
for (const logPath of ['../../utils/logDispatch.ts', '../../utils/logDispatch.js']) {
  mock.module(path.resolve(__dirname, logPath), () => completeModuleMock(path.resolve(__dirname, '../../utils/logDispatch.ts'), {
    sendLogEmbed: mock(async (_g: unknown, embed: { toJSON: () => APIEmbed }, type: string, _c: unknown, tag: unknown, sources: unknown, audit: unknown) => {
      if (envoiEnEchec) throw new Error('Discord injoignable');
      envois.push({ embed: embed.toJSON(), type, tag, sources, audit });
    }),
  }));
}

const { handleChannelsManagementRoutes, explainDroppedGenerators } =
  await import('../../api/routes/dashboard/modules/channels-management.js');
const { construireEmbedReglagesVocaux } = await import('../../utils/tempVoiceReglagesLog.js');
const { lirePlacementMention, normaliserReglagesPropriete } = await import('../../services/features/tempVoiceService.js');

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
function mockClient(extra: { channel?: Record<string, unknown>; locale?: string } = {}) {
  const channels = new Map<string, unknown>([
    [GEN_A, { id: GEN_A, name: 'Créer A', type: 2 }],
    [GEN_B, { id: GEN_B, name: 'Créer B', type: 2 }],
    ...(extra.channel ? [[CHANNEL, extra.channel] as [string, unknown]] : []),
  ]);
  const guild = {
    id: GUILD,
    name: 'Serveur test',
    preferredLocale: extra.locale ?? 'fr',
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
  envois.length = 0;
  envoiEnEchec = false;
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

describe('E — embed Discord des réglages vocaux modifiés depuis le dashboard', () => {
  const champs = (i = 0) => Object.fromEntries((envois[i].embed.fields as Array<{ name: string; value: string }>).map((f) => [f.name, f.value]));

  test('serveur francophone : un embed, titre, « Par » et lignes « champ : avant → après »', async () => {
    const res = await callConfig('PATCH', { tempVoiceModPermissions: { panelMode: 'FLAT', ownerMentionPlacement: 'none' }, tempVoiceDefaults: { userLimit: 12 } });
    expect(res.statusCode).toBe(200);
    expect(envois).toHaveLength(1);
    expect(envois[0].type).toBe('voice_panel');
    expect(envois[0].tag).toBe('Toji (dashboard)');
    expect(envois[0].embed.title).toBe('🎛️ Réglages des salons vocaux modifiés (dashboard)');
    expect(champs().Par).toBe('Toji (dashboard)');
    expect(champs().Modifications.split('\n')).toEqual([
      'Générateur principal : places : 0 → 12',
      'Panneau : mode : CLASSIC → FLAT',
      'Mention du propriétaire : panel → none',
    ]);
    expect(String((envois[0].audit as { details: string }).details)).toContain('Panneau : mode : CLASSIC → FLAT');
  });

  test('serveur anglophone : titre, champs et libellés en anglais', async () => {
    await callConfig('PATCH', { tempVoiceModPermissions: { panelMode: 'FLAT', canRename: false } }, mockClient({ locale: 'en-US' }).client);
    expect(envois[0].embed.title).toBe('🎛️ Voice channel settings changed (dashboard)');
    expect(champs().By).toBe('Toji (dashboard)');
    expect(champs().Changes.split('\n')).toEqual(['Moderators: rename : yes → no', 'Panel: mode : CLASSIC → FLAT']);
  });

  test('aucun changement : aucun embed', async () => {
    await callConfig('PATCH', { tempVoiceModPermissions: { panelMode: 'CLASSIC' } });
    expect(envois).toHaveLength(0);
  });

  test('un échec d\'envoi n\'empêche pas l\'enregistrement ni l\'audit', async () => {
    envoiEnEchec = true;
    const res = await callConfig('PATCH', { tempVoiceModPermissions: { panelMode: 'FLAT' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(mockDb.tempVoiceModPermissionsConfig.upsert).toHaveBeenCalled();
    expect(audits()).toHaveLength(1);
  });

  test('un très long journal respecte les limites d\'embed (champ 1024, total 6000, 25 champs)', () => {
    const lignes = Array.from({ length: 300 }, (_, i) => `Champ ${i} : ${'a'.repeat(300)} → ${'b'.repeat(200)}`);
    for (const locale of ['fr', 'en'] as const) {
      const e = construireEmbedReglagesVocaux(lignes, 'Toji (dashboard)', locale)!.toJSON();
      const fields = e.fields!;
      expect(fields.length).toBeLessThanOrEqual(25);
      expect(fields.every((f) => f.value.length <= 1024 && f.name.length <= 256)).toBe(true);
      const total = (e.title?.length ?? 0) + (e.footer?.text.length ?? 0) + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
      expect(total).toBeLessThanOrEqual(6000);
      expect(fields.at(-1)!.value).toMatch(/^… (et \d+ autre|and \d+ more)/);
    }
    expect(construireEmbedReglagesVocaux([], 'x', 'fr')).toBeNull();
  });
});

describe('F — copies des défauts de TempVoiceModPermissionsConfig', () => {
  test('schéma Prisma, type partagé, route (ligne absente) et démo du dashboard portent les mêmes défauts', async () => {
    const schema = readFileSync(path.resolve(__dirname, '../../../../../packages/database/prisma/temp-voice-access.prisma'), 'utf8');
    const modele = schema.match(/model TempVoiceModPermissionsConfig \{([\s\S]*?)\n\}/)![1];
    const prisma: Record<string, unknown> = {};
    for (const [, nom, defaut] of modele.matchAll(/^\s+(\w+)\s+\w+\??\s+@default\(([^()]*)\)/gm)) {
      prisma[nom] = defaut === 'true' ? true : defaut === 'false' ? false : /^-?\d+$/.test(defaut) ? Number(defaut) : defaut.replace(/^"|"$/g, '');
    }
    for (const nom of ['handoverDmEnabled', 'handoverDelaySeconds', 'claimEmbedEnabled', 'claimWho', 'moderatorClaimOverride', 'deleteWhenEmpty', 'ownerMentionPlacement']) {
      expect(prisma).toHaveProperty(nom);
    }

    mockDb.tempVoiceModPermissionsConfig.findUnique = mock(async () => null);
    const route = JSON.parse((await callConfig('GET', {})).body).tempVoiceModPermissions as Record<string, unknown>;
    const { PRISMA_DEFAULTS } = await import('../../../../dashboard/src/lib/demo/generated/prismaDefaults');
    const demo = (PRISMA_DEFAULTS as Record<string, Record<string, unknown>>).TempVoiceModPermissionsConfig;
    const partage = { ...TEMP_VOICE_OWNERSHIP_DEFAULTS, ownerMentionPlacement: TEMP_VOICE_OWNER_MENTION_DEFAULT } as Record<string, unknown>;

    for (const [nom, valeur] of Object.entries(prisma)) {
      expect({ nom, route: route[nom] }).toEqual({ nom, route: valeur });
      expect({ nom, demo: demo[nom] }).toEqual({ nom, demo: valeur });
      if (nom in partage) expect({ nom, partage: partage[nom] }).toEqual({ nom, partage: valeur });
    }
    // Côté bot : une ligne illisible retombe sur les mêmes valeurs.
    expect(normaliserReglagesPropriete(undefined)).toEqual(TEMP_VOICE_OWNERSHIP_DEFAULTS);
    expect(lirePlacementMention(undefined)).toBe(prisma.ownerMentionPlacement as typeof TEMP_VOICE_OWNER_MENTION_DEFAULT);
  });
});
