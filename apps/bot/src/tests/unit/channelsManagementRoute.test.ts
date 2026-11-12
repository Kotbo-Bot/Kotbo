import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import { PermissionFlagsBits, type Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims, type DashboardAccess } from '../../api/shared.js';

/**
 * Réservation et renommage d'un salon temporaire depuis le dashboard.
 *
 * L'écouteur et cette route accordent les mêmes droits par deux chemins
 * différents : les correctifs appliqués à l'un ne valaient rien tant que
 * l'autre restait en place. Les cas couverts ici sont ceux où la route ouvrait
 * le salon plus largement que sa catégorie, ou annonçait une modification que
 * Discord avait refusée.
 *
 * Ne pas mocker `../../utils/logger` ici : `mock.module` est global au process,
 * et le mock fuiterait dans les autres fichiers de test.
 */

const GUILD = '100000000000000000';
const OWNER = '200000000000000000';
const ROLE = '800000000000000000';
const PREVIOUS_ROLE = '810000000000000000';
const CHANNEL = '400000000000000000';

/** Les cinq droits que « Ajouter » et la réservation accordent. */
const ALL_TRUST_BITS = PermissionFlagsBits.ViewChannel
  | PermissionFlagsBits.Connect
  | PermissionFlagsBits.Speak
  | PermissionFlagsBits.SendMessages
  | PermissionFlagsBits.ReadMessageHistory;

let tempVoiceRow: Record<string, unknown> | null = null;
const mockDb = {
  tempVoiceChannel: {
    findMany: mock(async () => [tempVoiceRow]),
    findUnique: mock(async () => tempVoiceRow),
    update: mock(async () => tempVoiceRow),
    delete: mock(async () => ({})),
  },
  dashboardAuditLog: { create: mock(async () => ({})) },
  guild: { findUnique: mock(async () => null), update: mock(async () => ({})) },
  // Tables separees, une ligne par serveur : la route les lit en `Promise.all`
  // avec la guilde, donc leur absence du mock faisait echouer tout `GET`.
  tempVoiceAccessRequestConfig: {
    findUnique: mock(async () => null),
    upsert: mock(async () => ({})),
  },
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async () => null),
    upsert: mock(async () => ({})),
  },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

// Import après les mocks
const { handleChannelsManagementRoutes } = await import('../../api/routes/dashboard/modules/channels-management.js');
const { MAX_ADDITIONAL_GENERATORS } = await import('../../services/features/tempVoiceService.js');

function createMockRequest(body: Record<string, unknown>): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = 'PATCH';
  req.url = `/api/dashboard/guilds/${GUILD}/channels-management/temp-voice/channels/${CHANNEL}`;
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

interface MockResponse extends ServerResponse {
  body: string;
}

function createMockResponse(): MockResponse {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket)) as MockResponse;

  let _statusCode = 200;
  let _body = '';

  Object.defineProperty(res, 'statusCode', {
    get: () => _statusCode,
    set: (code: number) => { _statusCode = code; },
  });

  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (statusCode: number) => { _statusCode = statusCode; return res; };
  res.end = (chunk?: unknown) => {
    if (chunk) _body += String(chunk);
    res.body = _body;
    return res;
  };

  return res;
}

/**
 * Salon vocal temporaire et le serveur qui le porte.
 *
 * `categoryDenies` est ce que la catégorie refuse aux cibles interrogées :
 * c'est la seule chose que la route doit consulter avant d'accorder.
 * `categoryEveryoneDeny` est la surcharge @everyone de la catégorie, que le
 * salon a recopiée à sa création.
 */
function mockClient(options: {
  categoryDenies?: bigint;
  categoryEveryoneDeny?: bigint;
  renameFails?: boolean;
  renameHangs?: boolean;
  deleteFails?: boolean;
  ownerCached?: boolean;
} = {}) {
  const edits: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const deletes: string[] = [];
  const denied = options.categoryDenies ?? 0n;

  const parent = {
    permissionsFor: () => ({ bitfield: ~denied }),
    permissionOverwrites: {
      cache: new Map<string, { allow: bigint; deny: bigint }>(options.categoryEveryoneDeny === undefined
        ? []
        : [[GUILD, { allow: 0n, deny: options.categoryEveryoneDeny }]]),
    },
  };

  const channel = {
    id: CHANNEL,
    name: 'Salon de Tojii',
    type: 2, // ChannelType.GuildVoice
    parentId: '600000000000000000',
    parent,
    members: new Map(),
    setName: mock(async () => {
      if (options.renameFails) throw new Error('Invalid Form Body');
      // `@discordjs/rest` attend la fin de la fenêtre de limitation au lieu de
      // rejeter : la requête finit par aboutir, bien après la borne.
      if (options.renameHangs) await new Promise((resolve) => setTimeout(resolve, 4_000));
      Object.assign(channel, { name: 'nouveau-nom' });
      return channel;
    }),
    delete: mock(async () => {
      if (options.deleteFails) throw new Error('Missing Permissions');
      return channel;
    }),
    permissionOverwrites: {
      // discord.js accepte indifféremment un identifiant, un rôle ou un membre.
      edit: mock(async (target: string | { id: string }, patch: Record<string, unknown>) => {
        edits.push({ id: typeof target === 'string' ? target : target.id, patch });
      }),
      delete: mock(async (id: string) => { deletes.push(id); }),
    },
  };

  const guild = {
    id: GUILD,
    name: 'Serveur test',
    channels: { cache: new Map<string, unknown>([[CHANNEL, channel]]) },
    roles: { cache: new Map<string, unknown>([[ROLE, { id: ROLE }], [PREVIOUS_ROLE, { id: PREVIOUS_ROLE }]]) },
    members: {
      cache: new Map<string, unknown>(options.ownerCached === false ? [] : [[OWNER, { id: OWNER }]]),
      fetch: mock(async (id: string) => (id === OWNER ? { id: OWNER } : null)),
    },
  };

  Object.assign(channel, { guild });

  return {
    edits,
    deletes,
    client: { guilds: { cache: new Map<string, unknown>([[GUILD, guild]]) } } as unknown as Client,
  };
}

async function patchTempVoiceChannel(client: Client, body: Record<string, unknown>) {
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
    auditUser: 'Admin',
    moduleKey: 'channels-management',
  });
  return res;
}

describe('réservation d\'un salon temporaire depuis le dashboard', () => {
  beforeEach(() => {
    tempVoiceRow = { id: CHANNEL, guildId: GUILD, creatorId: OWNER, roleId: null, createdAt: new Date() };
    mockDb.tempVoiceChannel.findMany = mock(async () => [tempVoiceRow]);
    mockDb.tempVoiceChannel.delete = mock(async () => ({}));
  });

  test('lever la réservation rend le droit à la catégorie au lieu de l\'accorder', async () => {
    // `Connect: true` faisait du salon temporaire le seul endroit où entrer sur
    // un serveur fermé : le correctif avait été appliqué à l'écouteur, et cette
    // route continuait d'écraser le refus posé plus haut.
    tempVoiceRow = { ...tempVoiceRow, roleId: ROLE };
    const { client, edits } = mockClient();

    const res = await patchTempVoiceChannel(client, { roleId: null });

    expect(res.statusCode).toBe(200);
    const everyone = edits.find((entry) => entry.id === GUILD);
    expect(everyone?.patch.Connect).toBeNull();
    expect(Object.values(everyone?.patch ?? {})).not.toContain(true);
  });

  test('lever la réservation garde le refus de connexion de la catégorie', async () => {
    // `null` effacerait le refus que le salon a recopié de sa catégorie.
    tempVoiceRow = { ...tempVoiceRow, roleId: ROLE };
    const { client, edits } = mockClient({ categoryEveryoneDeny: PermissionFlagsBits.Connect });

    const res = await patchTempVoiceChannel(client, { roleId: null });

    expect(res.statusCode).toBe(200);
    const everyone = edits.find((entry) => entry.id === GUILD);
    expect(everyone?.patch.Connect).toBe(false);
  });

  test('n\'efface pas le registre quand le serveur est injoignable', async () => {
    // Un GET effaçait toutes les lignes du serveur quand il n'était pas en
    // cache : ses salons n'y sont pas non plus, et chacun passait pour disparu.
    const res = createMockResponse();
    await handleChannelsManagementRoutes({
      req: createMockRequest({}),
      res,
      parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management', 'temp-voice', 'channels'],
      url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management/temp-voice/channels`),
      client: { guilds: { cache: new Map() } } as unknown as Client,
      user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
      guildId: GUILD,
      access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
      method: 'GET',
      auditUser: 'Admin',
      moduleKey: 'channels-management',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.tempVoiceChannel.delete).not.toHaveBeenCalled();
  });

  test('refuse un rôle de réservation qui n\'en est pas un', async () => {
    // L'identifiant du serveur est celui de @everyone : il passe la validation
    // de format, et la réservation ouvrait alors le salon à tout le monde.
    const { client, edits } = mockClient();

    const res = await patchTempVoiceChannel(client, { roleId: GUILD });

    expect(res.statusCode).toBe(400);
    expect(edits).toHaveLength(0);
  });

  test('n\'accorde pas au propriétaire ce que la catégorie lui refuse', async () => {
    // Le repli valait `{ Connect: true, ViewChannel: true, Speak: true }` des
    // que la cible n'était pas un rôle - et le propriétaire est un membre, donc
    // toujours. Une catégorie qui lui refuse « Se connecter » se faisait ainsi
    // contredire par la réservation elle-même.
    const { client, edits } = mockClient({ categoryDenies: PermissionFlagsBits.Connect });

    const res = await patchTempVoiceChannel(client, { roleId: ROLE });

    expect(res.statusCode).toBe(200);
    const owner = edits.find((entry) => entry.id === OWNER);
    expect(owner?.patch.Connect).toBeUndefined();
    expect(owner?.patch.ViewChannel).toBe(true);
  });

  test('retrouve le propriétaire absent du cache avant de verrouiller', async () => {
    // Le verrou ferme le salon à @everyone : si le propriétaire n'est pas en
    // cache - il a quitté le salon, ou le bot vient de redémarrer - le sauter
    // le mettrait dehors de son propre salon réservé.
    const { client, edits } = mockClient({ ownerCached: false });

    const res = await patchTempVoiceChannel(client, { roleId: ROLE });

    expect(res.statusCode).toBe(200);
    expect(edits.some((entry) => entry.id === OWNER)).toBe(true);
  });

  test('lève la surcharge de la réservation précédente', async () => {
    // Sans ce retrait, le salon portait au bout de quelques changements la
    // liste de tous les rôles réservés depuis sa création.
    tempVoiceRow = { ...tempVoiceRow, roleId: PREVIOUS_ROLE };
    const { client, deletes, edits } = mockClient();

    const res = await patchTempVoiceChannel(client, { roleId: ROLE });

    expect(res.statusCode).toBe(200);
    expect(deletes).toContain(PREVIOUS_ROLE);
    // @everyone en dernier : le verrou ne tombe qu'une fois les accès poses.
    expect(edits.at(-1)?.id).toBe(GUILD);
  });

  test('ne verrouille pas le salon quand la catégorie refuse le rôle', async () => {
    // Le verrou était posé avant la confrontation : un refus laissait le salon
    // fermé à tout le monde sans qu'aucune réservation soit enregistrée.
    const { client, edits } = mockClient({ categoryDenies: ALL_TRUST_BITS });

    await patchTempVoiceChannel(client, { roleId: ROLE });

    expect(edits).toHaveLength(0);
  });
});

describe('fermeture forcée depuis le dashboard', () => {
  beforeEach(() => {
    tempVoiceRow = { id: CHANNEL, guildId: GUILD, creatorId: OWNER, roleId: null, createdAt: new Date() };
    mockDb.tempVoiceChannel.delete = mock(async () => ({}));
  });

  test('ne perd pas la trace d\'un salon que Discord refuse de supprimer', async () => {
    // L'état était purgé avant la suppression : le salon survivait sur Discord
    // sans que rien ne le référence, et la page annonçait « fermé avec succès ».
    const { client } = mockClient({ deleteFails: true });

    const res = await patchTempVoiceChannel(client, { action: 'DELETE' });

    expect(res.statusCode).toBe(409);
    expect(mockDb.tempVoiceChannel.delete).not.toHaveBeenCalled();
  });

  test('purge la base quand Discord accepte', async () => {
    const { client } = mockClient();

    const res = await patchTempVoiceChannel(client, { action: 'DELETE' });

    expect(res.statusCode).toBe(200);
    expect(mockDb.tempVoiceChannel.delete).toHaveBeenCalled();
  });
});

describe('renommage d\'un salon temporaire depuis le dashboard', () => {
  beforeEach(() => {
    tempVoiceRow = { id: CHANNEL, guildId: GUILD, creatorId: OWNER, roleId: null, createdAt: new Date() };
    mockDb.dashboardAuditLog.create.mockClear();
  });

  test('n\'annonce pas un renommage que Discord a refusé', async () => {
    // Le refus était avalé : la page affichait « Salon mis à jour » et l'audit
    // consignait un renommage qui n'avait pas eu lieu.
    const { client } = mockClient({ renameFails: true });

    const res = await patchTempVoiceChannel(client, { name: 'nouveau-nom' });

    expect(res.statusCode).toBe(409);
    expect(mockDb.dashboardAuditLog.create).not.toHaveBeenCalled();
  });

  test('confirme un renommage accepté et garde l\'ancien nom dans l\'audit', async () => {
    // discord.js met l'instance en cache à jour dès le retour de `setName` :
    // relire `channel.name` ensuite ecrivait « Nouveau -> Nouveau » dans l'audit.
    const { client } = mockClient();

    const res = await patchTempVoiceChannel(client, { name: 'nouveau-nom' });

    expect(res.statusCode).toBe(200);
    const audit = (mockDb.dashboardAuditLog.create.mock.calls as unknown[][]).at(-1);
    expect(JSON.stringify(audit ?? [])).toContain('Salon de Tojii');
  });

  test('ne bloque pas la requête quand Discord temporise', async () => {
    // Sans borne d'attente, la requête HTTP restait ouverte plusieurs minutes
    // et le navigateur abandonnait avant d'avoir le moindre verdict.
    const { client } = mockClient({ renameHangs: true });

    const res = await patchTempVoiceChannel(client, { name: 'nouveau-nom' });

    expect(res.statusCode).toBe(202);
  });
});

describe('création des générateurs additionnels depuis le dashboard', () => {
  /**
   * Serveur vide : tout salon demandé par la page doit être créé.
   *
   * Le cache accueille ce que `create` vient de poser, comme le fait
   * `ChannelManager`, sans quoi la route recréerait la catégorie partagée à
   * chaque tour de boucle et ce test mesurerait autre chose que le plafond.
   */
  function mockEmptyGuild() {
    const created: Array<{ id: string; name: string; type: number; parentId: string | null }> = [];
    const cache = new Map<string, { id: string; name: string; type: number; parentId: string | null }>();

    const guild = {
      id: GUILD,
      name: 'Serveur test',
      preferredLocale: 'fr',
      channels: {
        cache: Object.assign(cache, {
          find: (predicate: (channel: { id: string; name: string; type: number; parentId: string | null }) => boolean) =>
            [...cache.values()].find(predicate),
        }),
        create: mock(async (payload: { name: string; type: number; parent?: string }) => {
          const channel = {
            id: `9${String(created.length + 1).padStart(17, '0')}`,
            name: payload.name,
            type: payload.type,
            parentId: payload.parent ?? null,
          };
          created.push(channel);
          cache.set(channel.id, channel);
          return channel;
        }),
      },
      roles: { cache: new Map<string, unknown>() },
      members: { cache: new Map<string, unknown>(), fetch: mock(async () => null) },
    };
    return { created, client: { guilds: { cache: new Map<string, unknown>([[GUILD, guild]]) } } as unknown as Client };
  }

  async function saveSettings(client: Client, body: Record<string, unknown>) {
    const res = createMockResponse();
    await handleChannelsManagementRoutes({
      req: createMockRequest(body),
      res,
      parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management'],
      url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management`),
      client,
      user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
      guildId: GUILD,
      access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
      method: 'PATCH',
      auditUser: 'Admin',
      moduleKey: 'channels-management',
    });
    return res;
  }

  test('borne la création au plafond des générateurs additionnels', async () => {
    // Le plafond ne jouait qu'à l'enregistrement : la boucle de création, elle,
    // parcourait le tableau entier. Un corps de requête à deux cents entrées
    // vides faisait donc créer deux cents salons pour n'en garder que vingt-cinq.
    const { created, client } = mockEmptyGuild();

    const res = await saveSettings(client, {
      tempVoiceEnabled: true,
      tempVoiceChannelId: '500000000000000000',
      tempVoiceCategoryId: '600000000000000000',
      tempVoiceGenerators: Array.from({ length: MAX_ADDITIONAL_GENERATORS + 175 }, () => ({})),
    });

    expect(res.statusCode).toBe(200);
    const generators = created.filter((channel) => channel.name === '➕ Créer un salon');
    expect(generators).toHaveLength(MAX_ADDITIONAL_GENERATORS);
  });
});

describe('reglages de presentation du panneau des salons temporaires', () => {
  /**
   * Cinq reglages d'affichage stockes en base sous forme de chaines libres
   * (`String @default(...)`), lus et ecrits par la route. Rien dans le schema
   * n'empeche une chaine hors union d'y arriver : un renommage cote dashboard,
   * une migration a moitie jouee, un appel direct a l'API. Les deux sens sont
   * donc bornes, et ces deux tests mesurent ce bornage — sans eux, une valeur
   * invalide serait rendue telle quelle au panneau et le reglage deviendrait
   * fantome sans que rien ne le signale.
   */
  const PANEL_DEFAULTS = {
    panelMode: 'CLASSIC',
    stateLayout: 'GRID3',
    stateColors: 'NEUTRAL',
    panelComponents: 'V2',
    reservationFallbackMode: 'ANY_ROLE',
  } as const;

  const GUILD_CONFIG_ROW = {
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

  /** Ligne complete de `TempVoiceModPermissionsConfig`, surchargeable champ par champ. */
  function modPermissionsRow(overrides: Record<string, unknown>) {
    return {
      guildId: GUILD,
      canRename: true,
      canChangeLimit: true,
      canLock: true,
      canChangeWriteMode: true,
      canKickOrBan: true,
      canReserve: true,
      canTransfer: true,
      panelCompactMode: false,
      reservableRoleIds: [],
      reservationOverflow: 'ASK',
      reservationFallbackChannelId: null,
      ...PANEL_DEFAULTS,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockDb.guild.findUnique = mock(async () => GUILD_CONFIG_ROW as never);
    mockDb.guild.update = mock(async () => ({}));
    mockDb.tempVoiceAccessRequestConfig.findUnique = mock(async () => null);
    mockDb.tempVoiceModPermissionsConfig.findUnique = mock(async () => null);
    mockDb.tempVoiceModPermissionsConfig.upsert = mock(async () => ({}));
  });

  const emptyClient = () => ({
    guilds: {
      cache: new Map<string, unknown>([[GUILD, {
        id: GUILD,
        name: 'Serveur test',
        preferredLocale: 'fr',
        channels: { cache: new Map<string, unknown>() },
        roles: { cache: new Map<string, unknown>() },
        members: { cache: new Map<string, unknown>(), fetch: mock(async () => null) },
      }]]),
    },
  } as unknown as Client);

  async function callRoute(method: 'GET' | 'PATCH', body: Record<string, unknown>) {
    const res = createMockResponse();
    await handleChannelsManagementRoutes({
      req: createMockRequest(body),
      res,
      parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management'],
      url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management`),
      client: emptyClient(),
      user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
      guildId: GUILD,
      access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
      method,
      auditUser: 'Admin',
      moduleKey: 'channels-management',
    });
    return res;
  }

  /**
   * Une valeur hors union est REJETÉE, elle ne retombe pas sur le défaut.
   *
   * Les cinq réglages de présentation ne décident d'aucune action : ils
   * décident de l'apparence du panneau. Les rabattre en silence donnerait un
   * réglage qui ne s'enregistre pas — la page annonce « enregistré », et le
   * panneau ne change pas. Un 400 est plus honnête. C'est une divergence
   * assumée avec `reservationOverflow`, qui retombe sur `ASK` parce qu'une
   * valeur inconnue y déclencherait sinon un déplacement ou une déconnexion
   * que personne n'a choisis.
   */
  test('une valeur hors union est rejetee, et rien n est ecrit', async () => {
    const avant = (mockDb.tempVoiceModPermissionsConfig.upsert.mock.calls as unknown[][]).length;

    const res = await callRoute('PATCH', {
      tempVoiceModPermissions: modPermissionsRow({
        panelMode: 'PLEIN_ECRAN',
        stateLayout: 'GRID9',
        stateColors: 'RAINBOW',
        panelComponents: 'V3',
        reservationFallbackMode: 'WHATEVER',
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    // Le rejet doit être total : pas d'écriture partielle des champs valides.
    expect((mockDb.tempVoiceModPermissionsConfig.upsert.mock.calls as unknown[][]).length).toBe(avant);
  });

  test("une ligne en base porteuse d'une valeur invalide est relue au defaut", async () => {
    mockDb.tempVoiceModPermissionsConfig.findUnique = mock(async () => modPermissionsRow({
      panelMode: '',
      stateLayout: 'grid3',
      stateColors: 'DARK_MODE',
      panelComponents: 'v2',
      reservationFallbackMode: 'MEMBER',
    }) as never);

    const res = await callRoute('GET', {});

    expect(res.statusCode).toBe(200);
    const served = JSON.parse(res.body).tempVoiceModPermissions as Record<string, unknown>;
    expect({
      panelMode: served.panelMode,
      stateLayout: served.stateLayout,
      stateColors: served.stateColors,
      panelComponents: served.panelComponents,
      reservationFallbackMode: served.reservationFallbackMode,
    }).toEqual({ ...PANEL_DEFAULTS });
  });

  test('PATCH tempVoiceDefaults : visibilite et reglagesPerso valides conserves, visibilite inconnue => tous', async () => {
    const ecrit = async (tempVoiceDefaults: Record<string, unknown>) => {
      mockDb.guild.update = mock(async () => ({}));
      const res = await callRoute('PATCH', { tempVoiceDefaults });
      expect(res.statusCode).toBe(200);
      const calls = mockDb.guild.update.mock.calls as unknown as Array<[{ data: { tempVoiceDefaults: Record<string, unknown> } }]>;
      return calls[0]![0].data.tempVoiceDefaults;
    };

    const garde = await ecrit({ visibilite: 'prive', reglagesPerso: false });
    expect(garde.visibilite).toBe('prive');
    expect(garde.reglagesPerso).toBe(false);

    const rabattu = await ecrit({ visibilite: 'nimporte' });
    expect(rabattu.visibilite).toBe('tous');
  });
});
