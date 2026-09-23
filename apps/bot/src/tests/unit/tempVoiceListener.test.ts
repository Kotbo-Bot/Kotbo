import { afterAll, describe, expect, mock, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { Events, MessageFlags, PermissionFlagsBits, type Client } from 'discord.js';
import { MAX_USER_LIMIT } from '../../services/features/tempVoiceService.js';

/**
 * Cycle de vie des interactions du panneau des salons temporaires.
 *
 * `tempVoiceService.test.ts` couvre le calcul des permissions, qui est pur.
 * Les defauts releves en revue étaient tous ailleurs : dans ce que l'écouteur
 * fait *autour* de ce calcul - acquitter une interaction avant un appel long,
 * refuser une cible, laisser tranquille un serveur injoignable. Chacun des cas
 * ci-dessous échoue sur le code d'avant le correctif.
 *
 * Ne pas mocker `../../utils/logger` ici : `mock.module` est global au process,
 * et le mock fuiterait dans les autres fichiers de test.
 */

/** Reglages moderateur servis par le faux Prisma ; `null` = aucune ligne en base. */
let permissionsModerateur: Record<string, boolean> | null = null;

/** Ligne `TempVoiceAccessRequestConfig` ; `null` = aucune ligne, donc demandes
 *  desactivees et aucun bouton nulle part. */
let configDemandes: Record<string, unknown> | null = null;

const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async () => permissionsModerateur),
  },
  tempVoiceAccessRequestConfig: {
    findUnique: mock(async () => configDemandes),
  },
  tempVoiceChannel: {
    findMany: mock(async () => [] as Array<Record<string, unknown>>),
    findUnique: mock(async () => null as Record<string, unknown> | null),
    create: mock(async () => ({})),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
  },
};

let guildConfig: Record<string, unknown> | null = null;

const cachePath = path.resolve(import.meta.dir, '../../utils/cache.ts');
const mockCache = () => completeModuleMock(cachePath, {
  getCachedGuild: mock(async () => guildConfig),
});

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', mockCache],
];

for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');

const GUILD = '100000000000000000';
const OWNER = '200000000000000000';
const OTHER = '300000000000000000';
const CHANNEL = '400000000000000000';
const GENERATOR = '500000000000000000';

/**
 * Les actions que `handleTempVoiceAction` sait traiter.
 *
 * Le panneau ne doit poser que des boutons de cette liste : un identifiant qui
 * n'y figure pas tombe dans le `default` du `switch` et laisse l'interaction
 * sans réponse, sans qu'aucune erreur ne soit levée.
 */
const ACTIONS_DU_PANNEAU = [
  // Les trois portes du panneau refondu, plus la quatrième qui n'existe que
  // lorsque le salon est fermé.
  'salon', 'membres', 'propriete', 'demander',
  // Sous-panneaux éphémères.
  'bascule_verrou', 'mode_select', 'membre_select', 'membre_ici',
  'm_kick', 'm_ban', 'm_trust', 'm_untrust', 'm_transfer',
  'demande_ok', 'demande_non', 'demande_ban',
  // Identifiants des panneaux postés avant la refonte : toujours acceptés.
  'lock', 'unlock', 'limit', 'rename', 'chat', 'kick', 'ban', 'trust', 'transfer', 'claim', 'reserve',
];
const CATEGORY = '600000000000000000';

/**
 * Renommage plus lent que le délai accordé par l'écouteur (2,5 s).
 *
 * Le test doit se terminer dans les deux cas : avec le correctif, l'attente est
 * bornée et la réponse arrive avant ; sans lui, `await` patiente jusqu'ici puis
 * annonce un succès - c'est l'assertion qui tranche, pas un blocage du runner.
 */
const LATE_RENAME_MS = 4_000;

/**
 * Client minimal qui retient les ecouteurs poses par le module.
 *
 * `registerTempVoiceListener` s'abonne à `voiceStateUpdate` et
 * `interactionCreate` : les tests rejouent l'écouteur voulu à la main plutôt
 * que de simuler une passerelle Discord.
 */
function fakeClient(guilds: Map<string, unknown> = new Map()) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(event, listener);
      return client;
    },
    once: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(`once:${event}`, listener);
      return client;
    },
    isReady: () => false,
    guilds: { cache: guilds },
  } as unknown as Client;

  return { client, listeners };
}

/** Surcharge de permission réduite à ce que l'écouteur lit dessus. */
function fakeOverwrite(allow = 0n, deny = 0n) {
  return {
    allow: { bitfield: allow, has: (bit: bigint) => (allow & bit) === bit },
    deny: { bitfield: deny, has: (bit: bigint) => (deny & bit) === bit },
  };
}

/** Applique un patch de permissions à une surcharge, comme le fait Discord. */
function applyPatch(current: ReturnType<typeof fakeOverwrite>, patch: Record<string, unknown>) {
  let allow = current.allow.bitfield;
  let deny = current.deny.bitfield;
  for (const [name, value] of Object.entries(patch)) {
    const bit = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
    if (bit === undefined) continue;
    allow = value === true ? allow | bit : allow & ~bit;
    deny = value === false ? deny | bit : deny & ~bit;
  }
  return fakeOverwrite(allow, deny);
}

/**
 * Salon vocal dont on observe les surcharges posées et les réponses.
 *
 * `latencyMs` espace les écritures : sans délai, deux actions lancées ensemble
 * s'exécutent bout à bout et aucune course ne se produit.
 */
function fakeChannel(everyoneDeny = 0n, latencyMs = 0) {
  // Cibles qu'aucun des deux caches consultes par `upsert` - `roles.cache` puis
  // `users.cache` - ne saurait résoudre. Vide par defaut : tout ce que le module
  // manipule vient d'un `members.fetch`, qui met l'utilisateur en cache.
  const unresolvableIds = new Set<string>();
  const edits: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const setName = mock(async () => undefined);
  // `overwrites` est ce que le cache de discord.js porte ; `written` ce que
  // Discord a réellement reçu. Les deux ne se rejoignent qu'à la relecture.
  const overwrites = new Map([[GUILD, fakeOverwrite(0n, everyoneDeny)]]);
  const written = new Map(overwrites);
  const syncFromGateway = () => {
    overwrites.clear();
    for (const [id, overwrite] of written) overwrites.set(id, overwrite);
  };
  /** Surcharge déjà établie : Discord la porte, et le cache la connaît. */
  const seedOverwrite = (id: string, overwrite: ReturnType<typeof fakeOverwrite>) => {
    overwrites.set(id, overwrite);
    written.set(id, overwrite);
  };

  return {
    edits,
    setName,
    overwrites,
    written,
    syncFromGateway,
    seedOverwrite,
    unresolvableIds,
    channel: {
      id: CHANNEL,
      type: 2, // ChannelType.GuildVoice
      guild: { id: GUILD, roles: { everyone: { id: GUILD } } },
      members: new Map<string, unknown>(),
      setName,
      setUserLimit: mock(async () => undefined),
      delete: mock(async () => undefined),
      send: mock(async () => ({ id: '888888888888888888' })),
      parentId: null as string | null,
      parent: null as unknown,
      permissionOverwrites: {
        cache: overwrites,
        // discord.js accepte indifféremment un identifiant, un rôle ou un membre.
        //
        // Et il ne touche pas au cache : `PermissionOverwriteManager.upsert`
        // fait l'appel REST et rend le salon tel quel. Ce qu'on vient d'écrire
        // n'est donc lisible qu'après un `CHANNEL_UPDATE` ou une relecture -
        // d'où l'écart entre `written` et `overwrites`, que `syncFromGateway`
        // rattrape. Un mock qui tiendrait le cache à jour rendrait verts des
        // tests qui ne le seraient pas en production.
        edit: mock(async (target: string | { id: string }, patch: Record<string, unknown>, options?: { type?: number }) => {
          if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

          // `upsert` résout une cible donnée par identifiant dans `roles.cache`
          // puis `users.cache`, et lève avant tout appel réseau si aucun des
          // deux ne la connaît - sauf si le type est donné explicitement.
          if (typeof target === 'string' && options?.type === undefined && unresolvableIds.has(target)) {
            throw new TypeError('Supplied parameter is not a User nor a Role.');
          }

          const id = typeof target === 'string' ? target : target.id;
          edits.push({ id, patch });
          written.set(id, applyPatch(written.get(id) ?? fakeOverwrite(), patch));
        }),
        delete: mock(async (id: string) => { written.delete(id); }),
      },
    },
  };
}

/** Interaction de menu qui enregistre l'ordre réel des appels Discord. */
function fakeSelectInteraction(options: {
  customId: string;
  values: string[];
  channel: unknown;
  member: unknown;
  guild: unknown;
}) {
  const calls: string[] = [];
  const interaction = {
    guildId: GUILD,
    customId: options.customId,
    values: options.values,
    channel: options.channel,
    guild: options.guild,
    member: options.member,
    user: { id: OWNER, bot: false },
    deferred: false,
    replied: false,
    isButton: () => false,
    isModalSubmit: () => false,
    // Trois familles de menus, et le module les distingue par leur type avant
    // meme de lire l'identifiant : un banc qui rend `false` partout laisse
    // l'interaction tomber dans le vide, sans erreur et sans effet.
    isRoleSelectMenu: () => options.customId.includes('reserve'),
    isStringSelectMenu: () => options.customId.includes('mode_select')
      || options.customId.includes('membre_ici'),
    isUserSelectMenu: () => !options.customId.includes('reserve')
      && !options.customId.includes('mode_select')
      && !options.customId.includes('membre_ici'),
    isMessageComponent: () => true,
    isRepliable: () => true,
    message: { edit: mock(async () => undefined) },
    deferUpdate: mock(async () => { calls.push('deferUpdate'); interaction.deferred = true; }),
    deferReply: mock(async () => { calls.push('defer'); interaction.deferred = true; }),
    reply: mock(async () => { calls.push('reply'); interaction.replied = true; }),
    editReply: mock(async () => { calls.push('editReply'); }),
    followUp: mock(async () => { calls.push('followUp'); }),
    showModal: mock(async () => undefined),
  };
  return { interaction, calls };
}

/** Interaction de bouton, le seul type qui n'était exerce par aucun test. */
function fakeButtonInteraction(action: string, options: { channel: unknown; member: unknown; guild: unknown }) {
  const calls: string[] = [];
  const interaction = {
    guildId: GUILD,
    customId: `tempvoice:${action}`,
    channel: options.channel,
    guild: options.guild,
    member: options.member,
    user: { id: OWNER, bot: false },
    deferred: false,
    replied: false,
    isButton: () => true,
    isModalSubmit: () => false,
    isRoleSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isMessageComponent: () => true,
    isRepliable: () => true,
    message: { edit: mock(async () => undefined) },
    deferUpdate: mock(async () => { calls.push('deferUpdate'); interaction.deferred = true; }),
    deferReply: mock(async () => { calls.push('defer'); interaction.deferred = true; }),
    reply: mock(async () => { calls.push('reply'); interaction.replied = true; }),
    editReply: mock(async () => { calls.push('editReply'); }),
    followUp: mock(async () => { calls.push('followUp'); }),
    showModal: mock(async () => { calls.push('showModal'); }),
  };
  return { interaction, calls };
}

/**
 * Serveur vu depuis le panneau.
 *
 * `channels.fetch` rejoue ce que fait discord.js : un aller REST qui remet
 * l'instance en cache a jour. `onFetch` sert aux tests qui ont besoin que le
 * cache soit en retard sur l'état réel du salon.
 */
function fakeGuild(members: Map<string, unknown>, roles: Map<string, unknown> = new Map(), onFetch?: () => void) {
  return {
    id: GUILD,
    available: true,
    ownerId: '999999999999999999',
    roles: { everyone: { id: GUILD }, cache: roles },
    members: {
      me: { permissions: { has: () => true } },
      cache: members,
      fetch: mock(async (id: string) => members.get(id) ?? null),
    },
    channels: {
      cache: new Map(),
      // Une relecture rattrape ce que la passerelle n'a pas encore livré.
      fetch: mock(async () => { onFetch?.(); return null; }),
    },
  };
}

function fakeTarget(id: string, isBot: boolean) {
  // Ce que le membre a reçu en MP. Un refus de demande d'accès ne se dit que
  // là : l'écrire dans le salon transformerait un réglage en humiliation.
  const mp: Array<Record<string, unknown>> = [];
  return {
    id,
    displayName: `membre-${id}`,
    user: { id, bot: isBot },
    permissions: { has: () => false },
    roles: { cache: { has: (_id: string): boolean => false } },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: null as string | null, disconnect: mock(async () => undefined) },
    mp,
    send: mock(async (payload: Record<string, unknown>) => { mp.push(payload); }),
  };
}

/**
 * Catégorie parente d'un générateur.
 *
 * `permissionsFor` rend les droits du bot *dans la catégorie* : c'est ce que
 * Discord évalue, et non l'agregat au niveau du serveur.
 */
function fakeCategory(options: { inherited?: Map<string, unknown>; botCanAll?: boolean } = {}) {
  return {
    id: CATEGORY,
    type: 4, // ChannelType.GuildCategory
    permissionOverwrites: { cache: options.inherited ?? new Map<string, unknown>() },
    permissionsFor: () => ({ has: () => options.botCanAll !== false }),
  };
}

/** Serveur vu depuis le chemin de création : cache des salons et fabrique. */
function fakeCreationGuild(
  category: ReturnType<typeof fakeCategory> | null,
  options: { everyoneDeny?: bigint } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  // Ce que le bot poste dans le salon fraîchement créé : le panneau de gestion.
  const posted: Array<Record<string, unknown>> = [];
  const channels = new Map<string, unknown>();
  if (category) channels.set(CATEGORY, category);

  return {
    created,
    posted,
    guild: {
      id: GUILD,
      name: 'Serveur test',
      available: true,
      ownerId: '999999999999999999',
      roles: { everyone: { id: GUILD } },
      // Droits complets au niveau du serveur : seule la catégorie peut retirer
      // quelque chose, et c'est précisément ce que les tests exercent.
      members: { me: { permissions: { has: () => true } }, fetch: mock(async () => null) },
      channels: {
        cache: channels,
        create: mock(async (payload: Record<string, unknown>) => {
          created.push(payload);
          return {
            id: CHANNEL,
            name: payload.name,
            // La carte d'état lit le salon : un salon créé verrouillé doit
            // porter son refus, sinon le quatrième bouton ne peut pas apparaître.
            guild: { id: GUILD, members: { me: { id: '111111111111111111' } } },
            members: new Map<string, unknown>(),
            userLimit: (payload.userLimit as number | undefined) ?? 0,
            permissionOverwrites: {
              cache: new Map<string, unknown>([
                [GUILD, fakeOverwrite(0n, options.everyoneDeny ?? 0n)],
              ]),
            },
            delete: mock(async () => undefined),
            send: mock(async (message: Record<string, unknown>) => {
              posted.push(message);
              return { id: '777777777777777777' };
            }),
          };
        }),
      },
    },
  };
}

/** Membre qui rejoint le générateur, et l'état vocal qui l'accompagne. */
function fakeJoiningMember(guild: unknown) {
  const member = {
    id: OWNER,
    displayName: 'Tojii',
    user: { id: OWNER, bot: false, tag: 'tojii#0001', username: 'tojii' },
    guild,
    roles: { cache: { has: () => true } },
    send: mock(async () => undefined),
  };

  const setChannel = mock(async () => undefined);
  const newState = { member, guild, channelId: GENERATOR, channel: null, setChannel, disconnect: mock(async () => undefined) };
  const oldState = { channelId: null as string | null, channel: null as unknown };

  return { member, newState, oldState, setChannel };
}

/** Configuration serveur où le générateur principal est rangé dans la catégorie. */
function generatorConfig(policy: Record<string, unknown> = {}) {
  return {
    tempVoiceEnabled: true,
    tempVoiceChannelId: GENERATOR,
    tempVoiceCategoryId: CATEGORY,
    tempVoiceNameTemplate: '🔊 Salon de {user}',
    tempVoiceDefaults: policy,
  };
}

/**
 * La ligne que le dashboard écrit, demandes activées.
 *
 * Les champs sont ceux des colonnes, pas ceux de `ConfigDemandesAcces` : c'est
 * `normaliserConfigDemandes` qui traduit, et un test qui lui donnerait déjà la
 * forme traduite ne prouverait pas qu'elle est appelée.
 */
function ligneDemandes(champs: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    enabled: true,
    responders: 'OWNER_AND_STAFF',
    notifyVia: 'VOICE',
    notifyChannelId: null,
    requestExpiresMinutes: 10,
    denyCooldownMinutes: 10,
    ...champs,
  };
}

describe('création d\'un salon temporaire', () => {
  test('applique les réglages du générateur et l\'héritage de la catégorie', async () => {
    // Le câblage complet : gabarit de nom, nombre de places, et surcharges
    // calculées à partir de la catégorie. Sans lui, le panneau du dashboard
    // n'a aucun effet sur les salons créés.
    guildConfig = generatorConfig({ userLimit: 7, ownerPowers: ['mute'] });

    const inherited = new Map<string, unknown>([
      // La catégorie refuse nommément l'accès à un membre : le salon temporaire
      // ne doit pas le lui rendre.
      [OTHER, { id: OTHER, type: 1, allow: 0n, deny: PermissionFlagsBits.ViewChannel }],
    ]);
    const { guild, created } = fakeCreationGuild(fakeCategory({ inherited }));
    const { newState, oldState } = fakeJoiningMember(guild);

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe('🔊 Salon de Tojii');
    expect(created[0]?.userLimit).toBe(7);
    expect(created[0]?.parent).toBe(CATEGORY);

    const overwrites = created[0]?.permissionOverwrites as Array<{ id: string; allow: bigint; deny: bigint }>;
    const owner = overwrites.find((entry) => entry.id === OWNER);
    expect((owner!.allow & PermissionFlagsBits.MuteMembers) === PermissionFlagsBits.MuteMembers).toBe(true);

    const refused = overwrites.find((entry) => entry.id === OTHER);
    expect((refused!.deny & PermissionFlagsBits.ViewChannel) === PermissionFlagsBits.ViewChannel).toBe(true);
    expect((refused!.allow & PermissionFlagsBits.ViewChannel) === 0n).toBe(true);

    expect(tempChannels.get(CHANNEL)?.creatorId).toBe(OWNER);
    tempChannels.delete(CHANNEL);
  });

  test('ne crée qu\'un salon quand le générateur est rejoint deux fois de suite', async () => {
    // Rejoindre et quitter le générateur plus vite que la réponse de Discord
    // déclenchait autant de créations que d'aller-retours : le membre repartait
    // avec une grappe de salons vides, et le serveur avec autant d'appels API.
    guildConfig = generatorConfig();

    const { guild, created } = fakeCreationGuild(fakeCategory());
    const first = fakeJoiningMember(guild);
    const second = fakeJoiningMember(guild);

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);

    await Promise.all([
      listeners.get(Events.VoiceStateUpdate)?.(first.oldState, first.newState),
      listeners.get(Events.VoiceStateUpdate)?.(second.oldState, second.newState),
    ]);

    expect(created).toHaveLength(1);
    tempChannels.delete(CHANNEL);
  });

  test('poste un panneau dont chaque bouton a une action correspondante', async () => {
    // Un identifiant de bouton mal orthographié ne lève rien : le clic tombe
    // dans le `default` du `switch` et l'interaction reste sans réponse.
    guildConfig = generatorConfig();

    const { guild, posted } = fakeCreationGuild(fakeCategory());
    const { newState, oldState } = fakeJoiningMember(guild);

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(posted).toHaveLength(1);
    const rows = (posted[0]?.components ?? []) as Array<{ components: Array<{ data: { custom_id?: string } }> }>;
    const ids = rows.flatMap((row) => row.components.map((c) => c.data.custom_id ?? ''));

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith('tempvoice:')).toBe(true);
      expect(ACTIONS_DU_PANNEAU).toContain(id.slice('tempvoice:'.length));
    }
    tempChannels.delete(CHANNEL);
  });

  test('refuse le générateur à qui n\'a pas le rôle requis', async () => {
    // Le rôle requis garde l'accès au générateur, pas au salon créé : sans cette
    // garde, n'importe qui obtient un salon sur un générateur réservé.
    guildConfig = { ...generatorConfig(), tempVoiceRequiredRoleId: '910000000000000000' };

    const { guild, created } = fakeCreationGuild(fakeCategory());
    const { member, newState, oldState } = fakeJoiningMember(guild);
    member.roles = { cache: { has: (): boolean => false } };

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(created).toHaveLength(0);
    expect(newState.disconnect).toHaveBeenCalled();
    expect(member.send).toHaveBeenCalled();
  });

  test('renonce quand le membre bot n\'est pas résolu', async () => {
    // Sans membre bot, on ne peut rien affirmer de ses droits : annoncer « rien
    // ne manque » ferait passer une vérification censée fermer la porte.
    guildConfig = generatorConfig();

    const { guild, created } = fakeCreationGuild(fakeCategory());
    guild.members = { ...guild.members, me: null } as never;
    const { member, newState, oldState } = fakeJoiningMember(guild);

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(created).toHaveLength(0);
    expect(member.send).toHaveBeenCalled();
  });

  test('renonce quand la catégorie retire un droit au bot', async () => {
    // Discord évalue les droits dans la catégorie : un bot administrateur du
    // serveur mais bride ici voyait la vérification passer, puis la création
    // échouer sans qu'aucun message ne soit envoye au membre.
    guildConfig = generatorConfig();

    const { guild, created } = fakeCreationGuild(fakeCategory({ botCanAll: false }));
    const { member, newState, oldState } = fakeJoiningMember(guild);

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(created).toHaveLength(0);
    expect(member.send).toHaveBeenCalled();
  });

  test('ne laisse pas de salon vide quand le déplacement échoue', async () => {
    // Le salon n'est supprimé qu'au départ de son dernier occupant : un salon
    // que personne n'a jamais rejoint n'aurait jamais été nettoyé.
    guildConfig = generatorConfig();
    prismaMock.tempVoiceChannel.create = mock(async () => ({}));

    const { guild, created } = fakeCreationGuild(fakeCategory());
    const { newState, oldState, setChannel } = fakeJoiningMember(guild);
    setChannel.mockImplementation(async () => { throw new Error('Unknown Member'); });

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(created).toHaveLength(1);
    expect(tempChannels.has(CHANNEL)).toBe(false);
    expect(prismaMock.tempVoiceChannel.create).not.toHaveBeenCalled();
  });
});

describe('fin de vie d\'un salon', () => {
  /** Rejoue un depart de salon vocal et rend le faux salon quitte. */
  async function quitte(options: { enregistre: boolean; occupants: number; memeSalon?: boolean }) {
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.delete = mock(async () => ({}));

    const { channel } = fakeChannel();
    channel.members = new Map<string, unknown>(
      Array.from({ length: options.occupants }, (_, i) => [String(i), fakeTarget(String(i), false)]),
    );

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    if (options.enregistre) tempChannels.set(CHANNEL, { creatorId: OWNER });

    const oldState = { channelId: CHANNEL, channel };
    const newState = {
      channelId: options.memeSalon ? CHANNEL : null,
      channel: options.memeSalon ? channel : null,
      guild: { id: GUILD },
      member: fakeTarget(OWNER, false),
    };
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    tempChannels.delete(CHANNEL);
    return channel;
  }

  test('ne supprime que les salons que le module a créés', async () => {
    // Le garde-fou le plus lourd de conséquences du module : sans lui, **tout**
    // salon vocal du serveur qui se vide serait supprimé par le bot.
    const channel = await quitte({ enregistre: false, occupants: 0 });

    expect(channel.delete).not.toHaveBeenCalled();
  });

  test('ne supprime pas un salon qu\'il reste quelqu\'un', async () => {
    const channel = await quitte({ enregistre: true, occupants: 1 });

    expect(channel.delete).not.toHaveBeenCalled();
  });

  test('supprime le salon enregistré que le dernier occupant vient de quitter', async () => {
    // Le versant positif : sans lui, une garde qui ne supprimerait jamais rien
    // passerait aussi les deux tests précédents.
    const channel = await quitte({ enregistre: true, occupants: 0 });

    expect(channel.delete).toHaveBeenCalled();
  });

  test('un membre qui se coupe le micro ne déclenche rien', async () => {
    // `voiceStateUpdate` se déclenche aussi sur le micro, le casque et la vidéo :
    // sans comparer les deux salons, chacun de ces gestes évaluerait la
    // suppression du salon où le membre se trouve toujours.
    const channel = await quitte({ enregistre: true, occupants: 0, memeSalon: true });

    expect(channel.delete).not.toHaveBeenCalled();
  });
});

describe('acquittement des interactions', () => {
  /**
   * Discord ferme une interaction non acquittée au bout de trois secondes.
   * Le code d'avant repondait après plusieurs appels réseau : l'action
   * aboutissait, mais le membre voyait « Unknown interaction ».
   */
  test('une action ciblant un membre est acquittée avant le premier appel Discord', async () => {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map([[OTHER, target]]));
    const { client, listeners } = fakeClient();

    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction, calls } = fakeSelectInteraction({
      customId: 'tempvoice:trust_select',
      values: [OTHER],
      channel,
      member: fakeTarget(OWNER, false),
      guild,
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    // Le point vérifié : l'acquittement arrive AVANT toute réponse, donc avant
    // les appels qui la retardaient.
    expect(calls[0]).toBe('defer');
    expect(calls).toContain('editReply');
    expect(calls).not.toContain('reply');
  });

  test('la réservation par rôle est acquittée elle aussi', async () => {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();

    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction, calls } = fakeSelectInteraction({
      customId: 'tempvoice:reserve_select',
      values: [],
      channel,
      member: fakeTarget(OWNER, false),
      guild,
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    // Une lecture en base, plusieurs surcharges et une écriture précèdent la
    // réponse : sans acquittement, elle arrivait trop tard.
    expect(calls[0]).toBe('defer');
  });
});

describe('autorisation d\'un membre', () => {
  /**
   * Le câblage compte autant que le calcul : sans ce test, remplacer la lecture
   * des droits de la catégorie par `null` laisserait toute la suite au vert.
   */
  /** Les cinq droits que « Ajouter » accorde quand la catégorie les laisse tous. */
  const FULL_ACCESS = PermissionFlagsBits.ViewChannel
    | PermissionFlagsBits.Connect
    | PermissionFlagsBits.Speak
    | PermissionFlagsBits.SendMessages
    | PermissionFlagsBits.ReadMessageHistory;

  function trustCategory(granted: bigint) {
    return {
      id: '900000000000000000',
      type: 4, // ChannelType.GuildCategory
      permissionsFor: mock(() => ({ bitfield: granted })),
    };
  }

  function closedCategory(visible: boolean) {
    return trustCategory(visible
      ? FULL_ACCESS
      : FULL_ACCESS & ~PermissionFlagsBits.ViewChannel);
  }

  /** Rejoue « Ajouter » sur une catégorie donnée et rend le message affiché. */
  let dernieresEcritures: Array<{ id: string; patch: Record<string, unknown> }> = [];

  async function trust(parent: unknown) {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, edits } = fakeChannel();
    dernieresEcritures = edits;
    channel.parentId = '900000000000000000';
    channel.parent = parent as never;

    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map([[OTHER, target]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const messages: string[] = [];
    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:trust_select', values: [OTHER],
      channel, member: fakeTarget(OWNER, false), guild,
    });
    interaction.editReply = mock(async (p: { content: string }) => { messages.push(p.content); }) as never;
    interaction.reply = mock(async (p: { content: string }) => { messages.push(p.content); }) as never;

    await listeners.get(Events.InteractionCreate)?.(interaction);
    tempChannels.delete(CHANNEL);
    return messages;
  }

  test('distingue un accès complet d\'un accès partiel', async () => {
    // Le nombre de droits d'un accès complet était écrit en dur ici alors qu'il
    // vit dans le service : le jour où la liste s'est allongée, toute réussite
    // s'est annoncée comme partielle, et le message de succès est devenu mort.
    expect((await trust(trustCategory(FULL_ACCESS)))[0]).toContain('autorisé à rejoindre');
    // Et la surcharge est réellement posée : annoncer sans écrire passerait
    // sinon pour une réussite.
    expect(dernieresEcritures.some((entry) => entry.id === OTHER)).toBe(true);

    const partial = FULL_ACCESS & ~PermissionFlagsBits.SendMessages;
    expect((await trust(trustCategory(partial)))[0]).toContain('accès partiel');
  });

  test('ne fait pas entrer dans une catégorie qui refuse la vue à la cible', async () => {
    // Cas courant : refus à @everyone, autorisation à un rôle que la cible
    // ne porte pas.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    channel.parentId = '900000000000000000';
    channel.parent = closedCategory(false) as never;

    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map([[OTHER, target]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:trust_select',
      values: [OTHER],
      channel,
      member: fakeTarget(OWNER, false),
      guild,
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    const edits = channel.permissionOverwrites.edit as unknown as { mock: { calls: unknown[][] } };
    const targetOverwrite = edits.mock.calls.find((call) => call[0] === OTHER);
    expect((targetOverwrite?.[1] as Record<string, unknown> | undefined)?.ViewChannel).toBeUndefined();
  });

  test('refuse quand la catégorie configurée est introuvable', async () => {
    // Accorder sur une absence d'information reviendrait à ouvrir par défaut.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    channel.parentId = '900000000000000000';
    channel.parent = null as never;

    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map([[OTHER, target]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:trust_select',
      values: [OTHER],
      channel,
      member: fakeTarget(OWNER, false),
      guild,
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    const edits = channel.permissionOverwrites.edit as unknown as { mock: { calls: unknown[][] } };
    expect(edits.mock.calls.some((call) => call[0] === OTHER)).toBeFalse();
  });
});

describe('qui a le droit d\'agir', () => {
  test('un membre qui n\'est ni propriétaire ni staff ne touche à rien', async () => {
    // La porte d'entrée de tout le panneau : sans elle, n'importe quel membre
    // verrouillé, renomme, expulse ou réserve le salon de n'importe qui. Elle
    // est évaluée avant le `switch`, donc un seul bouton suffit à la garder.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, edits } = fakeChannel();

    const intrus = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map<string, unknown>([[OTHER, intrus]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction, calls } = fakeButtonInteraction('lock', { channel, guild, member: intrus });
    interaction.user = { id: OTHER, bot: false };
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits).toHaveLength(0);
    expect(calls).toContain('reply');
    tempChannels.delete(CHANNEL);
  });

  test('le propriétaire, lui, passe', async () => {
    // Le versant positif : sans lui, une garde qui refuserait tout le monde
    // passerait aussi le test précédent.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, edits } = fakeChannel();

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('lock', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    // Verrouiller rend d'abord la parole au propriétaire, puis ferme à
    // @everyone : sans la première écriture, il serait muet chez lui.
    expect(edits.map((entry) => entry.id)).toEqual([OWNER, GUILD]);
    tempChannels.delete(CHANNEL);
  });
});

describe('cibles interdites', () => {
  test('un membre du staff ne peut pas être expulsé du salon', async () => {
    // Le propriétaire d'un salon temporaire ne doit pas pouvoir sortir la
    // modération de son propre salon.
    const STAFF_ROLE = '500000000000000000';
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: STAFF_ROLE, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();

    const staff = fakeTarget(OTHER, false);
    staff.roles = { cache: { has: (id: string): boolean => id === STAFF_ROLE } };
    staff.voice = { channelId: CHANNEL, disconnect: mock(async () => undefined) };

    const guild = fakeGuild(new Map<string, unknown>([[OTHER, staff]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:kick_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(staff.voice.disconnect).not.toHaveBeenCalled();
    tempChannels.delete(CHANNEL);
  });

  test('on n\'expulse pas quelqu\'un qui n\'est pas dans le salon', async () => {
    // `disconnect` sur un membre resté ailleurs le sortirait du salon où il se
    // trouve vraiment : le panneau d'un salon n'agit que sur ses occupants.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();

    const ailleurs = fakeTarget(OTHER, false);
    ailleurs.voice = { channelId: '990000000000000000', disconnect: mock(async () => undefined) };

    const guild = fakeGuild(new Map<string, unknown>([[OTHER, ailleurs]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:kick_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(ailleurs.voice.disconnect).not.toHaveBeenCalled();
    tempChannels.delete(CHANNEL);
  });

  test('une action qui échoue répond quand même au membre', async () => {
    // Sans cette réponse, l'interaction reste sur « réfléchit… » jusqu'à
    // expiration : le membre ne sait ni que ça a échoué, ni qu'il peut réessayer.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    channel.permissionOverwrites.edit = mock(async () => { throw new Error('Missing Permissions'); }) as never;

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction, calls } = fakeButtonInteraction('lock', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(calls).toContain('followUp');
    tempChannels.delete(CHANNEL);
  });

  test('un bot ne peut pas être banni de son propre salon', async () => {
    // Le risque : banni, le bot perd l'accès au salon et ne peut plus le
    // supprimer quand il se vide - le salon reste ouvert indéfiniment.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    const botTarget = fakeTarget(OTHER, true);
    const guild = fakeGuild(new Map([[OTHER, botTarget]]));
    const { client, listeners } = fakeClient();

    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:ban_select',
      values: [OTHER],
      channel,
      member: fakeTarget(OWNER, false),
      guild,
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    // Aucune surcharge posée sur le bot.
    const overwriteEdits = channel.permissionOverwrites.edit as unknown as { mock: { calls: unknown[][] } };
    const targetedTheBot = overwriteEdits.mock.calls.some((call) => call[0] === OTHER);
    expect(targetedTheBot).toBeFalse();
  });

  test('le staff peut agir sur le propriétaire, un membre ordinaire non', async () => {
    // Le cas d'usage cite dans le code : un salon renommé en insulte par son
    // propriétaire. La garde d'avant bloquait aussi la modération.
    const STAFF_ROLE = '500000000000000000';
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: STAFF_ROLE, moderatorRoleId: null, testStaffRoleId: null };

    const { channel } = fakeChannel();
    const owner = fakeTarget(OWNER, false);
    owner.voice = { channelId: CHANNEL, disconnect: mock(async () => undefined) };
    const staff = fakeTarget(OTHER, false);
    staff.roles = { cache: { has: (id: string) => id === STAFF_ROLE } } as never;

    // Le staff doit être joignable : l'écouteur résout l'auteur via
    // `guild.members.fetch` quand l'interaction ne porte pas un vrai GuildMember.
    const guild = fakeGuild(new Map<string, unknown>([[OWNER, owner], [OTHER, staff]]));

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:kick_select',
      values: [OWNER],
      channel,
      member: staff,
      guild,
    });
    interaction.user = { id: OTHER, bot: false };

    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(owner.voice.disconnect).toHaveBeenCalled();
  });
});

describe('transfert de propriété', () => {
  test('répond à une interaction déjà acquittée sans la laisser en suspens', async () => {
    // `transfer_select` acquitte, puis `transferOwnership` appelait `reply` :
    // discord.js leve `InteractionAlreadyReplied`, le `.catch` l'avalait, et le
    // transfert reussit pendant que le membre reste sur « reflechit... ».
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map([[OTHER, target]]));
    const { client, listeners } = fakeClient();

    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction, calls } = fakeSelectInteraction({
      customId: 'tempvoice:transfer_select',
      values: [OTHER],
      channel,
      member: fakeTarget(OWNER, false),
      guild,
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(calls[0]).toBe('defer');
    expect(calls).toContain('editReply');
    expect(calls).not.toContain('reply');
  });
});

describe('transfert et catégorie', () => {
  test('ne rend pas à la cible ce que la catégorie lui refuse', async () => {
    // Recevoir un salon ne doit pas rendre la parole à quelqu'un à qui le staff
    // vient de la retirer au niveau de la catégorie. Le calcul est couvert par
    // le service ; ici c'est son branchement qui l'est.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    prismaMock.tempVoiceChannel.update = mock(async () => ({}));

    const { channel, edits } = fakeChannel();
    channel.parentId = CATEGORY;
    // La parole est retirée nommément à la cible comme à l'ancien propriétaire.
    channel.parent = fakeCategory({
      inherited: new Map<string, unknown>([
        [OTHER, fakeOverwrite(0n, PermissionFlagsBits.Speak)],
        [OWNER, fakeOverwrite(0n, PermissionFlagsBits.Speak)],
      ]),
    });

    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map<string, unknown>([[OTHER, target]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:transfer_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    const pose = edits.find((entry) => entry.id === OTHER);
    expect(pose?.patch.Speak).toBe(false);
    expect(pose?.patch.Connect).toBe(true);
    // Les pouvoirs ne dépendent pas des droits de la cible dans la catégorie :
    // un membre ordinaire n'y a jamais « Rendre muet ».
    expect(pose?.patch.MuteMembers).toBe(true);

    const revoked = edits.find((entry) => entry.id === OWNER);
    expect(revoked?.patch.Speak).toBe(false);
    expect(revoked?.patch.MuteMembers).toBeNull();
    tempChannels.delete(CHANNEL);
  });

  test('enregistre le nouveau propriétaire en base', async () => {
    // Sans cette écriture, un redémarrage rend le salon à son créateur
    // d'origine, parti depuis longtemps.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    prismaMock.tempVoiceChannel.update = mock(async () => ({}));

    const { channel } = fakeChannel();
    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map<string, unknown>([[OTHER, target]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:transfer_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(prismaMock.tempVoiceChannel.update).toHaveBeenCalled();
    tempChannels.delete(CHANNEL);
  });
});

describe('transferts simultanés', () => {
  test('ne laissent pas deux propriétaires avec les mêmes pouvoirs', async () => {
    // Deux transferts lances ensemble lisaient le même propriétaire sortant :
    // chacun posait sa surcharge, une seule était révoquée, et le perdant
    // gardait « Gérer le salon » sans que rien ne le lui retire.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const THIRD = '700000000000000000';
    const { channel, written, syncFromGateway, seedOverwrite } = fakeChannel(0n, 5);

    // Le propriétaire sortant porte de vrais pouvoirs : sans eux, la surcharge
    // posée sur le nouveau propriétaire vaudrait `MuteMembers: null`, donc
    // exactement ce qu'écrit une revocation - le test ne distinguerait plus
    // celui qui reçoit le salon de celui qui le rend.
    // « Gérer le salon » n'est pas dans la politique par défaut : si un maillon
    // de la chaîne retombe dessus au lieu de lire ce que le salon porte, le
    // pouvoir disparaît, et le test le voit.
    seedOverwrite(OWNER, fakeOverwrite(
      PermissionFlagsBits.ViewChannel
      | PermissionFlagsBits.Connect
      | PermissionFlagsBits.Speak
      | PermissionFlagsBits.ManageChannels,
    ));

    const first = fakeTarget(OTHER, false);
    const second = fakeTarget(THIRD, false);
    const guild = fakeGuild(new Map<string, unknown>([[OTHER, first], [THIRD, second]]), new Map(), syncFromGateway);

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const a = fakeSelectInteraction({
      customId: 'tempvoice:transfer_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    const b = fakeSelectInteraction({
      customId: 'tempvoice:transfer_select', values: [THIRD],
      channel, guild, member: fakeTarget(OWNER, false),
    });

    await Promise.all([
      listeners.get(Events.InteractionCreate)?.(a.interaction),
      listeners.get(Events.InteractionCreate)?.(b.interaction),
    ]);

    // Sans mise en file, les deux transferts lisent OWNER comme sortant : ils ne
    // revoquent que lui, et le premier beneficiaire garde « Rendre muet » sur un
    // salon dont il n'est plus propriétaire.
    // On lit ce que Discord porte, pas le cache : celui-ci ne reflete nos
    // propres ecritures qu'une fois la passerelle passee.
    expect(tempChannels.get(CHANNEL)?.creatorId).toBe(THIRD);
    expect(written.get(OTHER)?.allow.has(PermissionFlagsBits.ManageChannels)).toBe(false);
    expect(written.get(THIRD)?.allow.has(PermissionFlagsBits.ManageChannels)).toBe(true);
  });
});

describe('reprise d\'un salon abandonné', () => {
  test('annonce la reprise dans le salon', async () => {
    // « Récupérer » est ouvert à tous les occupants : la réponse à l'auteur
    // reste privée, mais le salon entier doit apprendre qui commande.
    guildConfig = { tempVoiceEnabled: true };
    const { channel } = fakeChannel();
    const claimer = fakeTarget(OWNER, false);
    channel.members = new Map<string, unknown>([[OWNER, claimer]]);

    const guild = fakeGuild(new Map<string, unknown>([[OWNER, claimer]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    // Le propriétaire est parti, celui qui reclame est dans le salon.
    tempChannels.set(CHANNEL, { creatorId: OTHER });

    const { interaction } = fakeButtonInteraction('claim', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(tempChannels.get(CHANNEL)?.creatorId).toBe(OWNER);
    expect(channel.send).toHaveBeenCalled();
    tempChannels.delete(CHANNEL);
  });

  test('refuse la reprise à qui n\'a pas rejoint le salon', async () => {
    // Le panneau reste lisible depuis l'extérieur : sans ce garde-fou, on
    // prenait la main sur un salon où l'on n'avait jamais mis les pieds.
    guildConfig = { tempVoiceEnabled: true };
    const { channel } = fakeChannel();

    const guild = fakeGuild(new Map<string, unknown>([[OWNER, fakeTarget(OWNER, false)]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OTHER });

    const { interaction } = fakeButtonInteraction('claim', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(tempChannels.get(CHANNEL)?.creatorId).toBe(OTHER);
    expect(channel.send).not.toHaveBeenCalled();
    tempChannels.delete(CHANNEL);
  });
});

describe('transfert sur un salon dont la surcharge a disparu', () => {
  test('ne pioche pas les pouvoirs d\'un générateur additionnel', async () => {
    // La surcharge du propriétaire peut avoir été effacée à la main. Le salon
    // ne retient pas quel générateur l'a créé : sans générateur principal, un
    // additionnel donnerait au salon des pouvoirs qui ne regissent que les
    // siens - ici « Gérer le salon », que la politique par défaut n'accorde pas.
    guildConfig = {
      tempVoiceEnabled: true,
      tempVoiceChannelId: null,
      tempVoiceGenerators: [{ channelId: '510000000000000000', ownerPowers: ['manageChannel'] }],
      tempVoiceCategoryId: null,
      tempVoiceNameTemplate: '🔊 Salon de {user}',
    };

    const { channel, edits } = fakeChannel();
    const target = fakeTarget(OTHER, false);
    const guild = fakeGuild(new Map<string, unknown>([[OTHER, target]]));

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:transfer_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    const applied = edits.find((entry) => entry.id === OTHER);
    expect(applied?.patch.ManageChannels).toBeNull();
    // La politique par défaut, elle, reconduit les trois pouvoirs historiques.
    expect(applied?.patch.MuteMembers).toBe(true);
    tempChannels.delete(CHANNEL);
  });
});

describe('deux reprises lancées ensemble', () => {
  test('la seconde ne vole pas le salon à la première', async () => {
    // La garde « le propriétaire est-il parti ? » est évaluée avant la mise en
    // file : deux réclamations simultanees la passent toutes les deux, et la
    // seconde révoquait la première après lui avoir annoncé le salon.
    guildConfig = { tempVoiceEnabled: true };
    const THIRD = '700000000000000000';
    const { channel, written, syncFromGateway } = fakeChannel(0n, 5);

    const first = fakeTarget(OWNER, false);
    const second = fakeTarget(THIRD, false);
    // Le propriétaire d'origine est parti, les deux reclamants sont présents.
    channel.members = new Map<string, unknown>([[OWNER, first], [THIRD, second]]);

    const guild = fakeGuild(new Map<string, unknown>([[OWNER, first], [THIRD, second]]), new Map(), syncFromGateway);
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OTHER });

    const a = fakeButtonInteraction('claim', { channel, guild, member: first });
    const b = fakeButtonInteraction('claim', { channel, guild, member: second });
    b.interaction.user = { id: THIRD, bot: false };

    await Promise.all([
      listeners.get(Events.InteractionCreate)?.(a.interaction),
      listeners.get(Events.InteractionCreate)?.(b.interaction),
    ]);

    // Une seule reprise annoncée : sans la revérification, le salon changeait
    // deux fois de main et le premier reclamant se voyait révoquer juste après
    // avoir lu « vous avez récupère la propriété ».
    const winner = tempChannels.get(CHANNEL)?.creatorId ?? '';
    expect([OWNER, THIRD]).toContain(winner);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(written.get(winner)?.allow.has(PermissionFlagsBits.Connect)).toBe(true);
    tempChannels.delete(CHANNEL);
  });
});

describe('révocation de l\'ancien propriétaire', () => {
  test('rend ses pouvoirs même quand il n\'est plus dans le cache', async () => {
    // `permissionOverwrites.edit` résout une cible donnée par identifiant dans
    // `roles.cache` puis `users.cache`, et lève **avant** tout appel réseau si
    // aucun des deux ne la connaît. Un ancien propriétaire parti du serveur, ou
    // simplement absent du cache après un redémarrage, gardait donc tous ses
    // pouvoirs pendant que le bot annonçait un transfert propre.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, edits, unresolvableIds } = fakeChannel();

    const target = fakeTarget(OTHER, false);
    // La cible vient d'être résolue par `members.fetch`, donc mise en cache ;
    // le propriétaire sortant, lui, n'y est plus.
    unresolvableIds.add(OWNER);

    const guild = fakeGuild(new Map([[OTHER, target]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:transfer_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits.some((entry) => entry.id === OWNER)).toBe(true);
    expect(tempChannels.get(CHANNEL)?.creatorId).toBe(OTHER);
    tempChannels.delete(CHANNEL);
  });
});

describe('réservation par rôle', () => {
  test('retrouve le propriétaire absent du cache avant de verrouiller', async () => {
    // Réserver ferme le salon à @everyone : sauter un propriétaire absent du
    // cache - il a quitté le salon, ou le bot vient de redémarrer - le mettrait
    // dehors de son propre salon. Même correctif que côté dashboard.
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.findUnique = mock(async () => null);

    const ROLE = '800000000000000000';
    const { channel, edits } = fakeChannel();
    channel.parent = { permissionsFor: () => ({ bitfield: ~0n }) };

    // Le cache des membres est vide : seul `fetch` peut résoudre le propriétaire.
    const guild = fakeGuild(new Map(), new Map<string, unknown>([[ROLE, { id: ROLE }]]));
    guild.members.fetch = mock(async (id: string) => (id === OWNER ? fakeTarget(OWNER, false) : null));

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:reserve_select', values: [ROLE],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits.some((entry) => entry.id === OWNER)).toBe(true);
    tempChannels.delete(CHANNEL);
  });

  test('autorise avant de verrouiller, jamais l\'inverse', async () => {
    // Le verrou était posé en premier : un appel refusé entre les deux laissait
    // le salon fermé à tout le monde, sans réservation, et rien ne le rouvrait.
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.findUnique = mock(async () => null);

    const ROLE = '800000000000000000';
    const { channel, edits } = fakeChannel();
    channel.parent = { permissionsFor: () => ({ bitfield: ~0n }) };

    const owner = fakeTarget(OWNER, false);
    const guild = fakeGuild(
      new Map<string, unknown>([[OWNER, owner]]),
      new Map<string, unknown>([[ROLE, { id: ROLE }]]),
    );
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:reserve_select', values: [ROLE],
      channel, guild, member: owner,
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    // @everyone en dernier : tant qu'il n'est pas fermé, le salon reste utilisable.
    expect(edits.at(-1)?.id).toBe(GUILD);
    expect(edits.at(-1)?.patch.Connect).toBe(false);
    tempChannels.delete(CHANNEL);
  });

  test('ne verrouille pas le salon quand la catégorie refuse le rôle', async () => {
    // Le verrou était posé avant la confrontation à la catégorie : quand
    // celle-ci refusait le rôle, le salon restait fermé à tout le monde alors
    // qu'aucune réservation n'avait été enregistrée.
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.findUnique = mock(async () => null);

    const ROLE = '800000000000000000';
    const { channel, edits } = fakeChannel();
    channel.parent = { permissionsFor: () => ({ bitfield: 0n }) };

    const guild = fakeGuild(new Map(), new Map<string, unknown>([[ROLE, { id: ROLE }]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:reserve_select', values: [ROLE],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits).toHaveLength(0);
    tempChannels.delete(CHANNEL);
  });
});

describe('verrouillage du salon', () => {
  test('déverrouiller rend le droit à la catégorie au lieu de l\'autoriser', async () => {
    // Le correctif central de la branche, côté panneau : `Connect: true` faisait
    // du salon temporaire le seul endroit où entrer sur un serveur fermé.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits } = fakeChannel(PermissionFlagsBits.Connect);

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('unlock', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    // @everyone d'abord, puis le propriétaire : déverrouiller lui reprend la
    // parole accordée au verrouillage, sinon il resterait seul à pouvoir
    // écrire dans un salon pourtant rendu à sa catégorie.
    expect(edits.map((entry) => entry.id)).toEqual([GUILD, OWNER]);
    expect(edits[0]?.patch).toEqual({ Connect: null, SendMessages: null });
    tempChannels.delete(CHANNEL);
  });

  test('déverrouiller garde le refus de connexion de la catégorie', async () => {
    // `null` effacerait le refus que le salon a recopié de sa catégorie : il
    // s'ouvrirait à tout le serveur au lieu de revenir à l'état hérité.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits } = fakeChannel(PermissionFlagsBits.Connect);
    channel.parentId = CATEGORY;
    channel.parent = fakeCategory({
      inherited: new Map<string, unknown>([[GUILD, fakeOverwrite(0n, PermissionFlagsBits.Connect)]]),
    });

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('unlock', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits[0]?.patch).toEqual({ Connect: false, SendMessages: null });
    tempChannels.delete(CHANNEL);
  });
});

describe('limite de places', () => {
  /** Rejoue la fenêtre de saisie de la limite et rend le message affiché. */
  async function submitLimit(value: string) {
    guildConfig = { tempVoiceEnabled: true };
    const { channel } = fakeChannel();
    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const messages: string[] = [];
    const interaction = {
      guildId: GUILD,
      customId: 'tempvoice:limit_modal',
      channel,
      guild,
      member: fakeTarget(OWNER, false),
      user: { id: OWNER, bot: false },
      deferred: false,
      replied: false,
      isButton: () => false,
      isModalSubmit: () => true,
      isRoleSelectMenu: () => false,
      isUserSelectMenu: () => false,
      // Une vraie interaction Discord porte les trois gardes de type, quelle que
      // soit sa nature. En omettre une ici fait lever le module sur un appel
      // parfaitement legitime, et l'echec accuse le code au lieu du banc.
      isStringSelectMenu: () => false,
      isRepliable: () => true,
      fields: { getTextInputValue: () => value },
      deferReply: mock(async () => { interaction.deferred = true; }),
      reply: mock(async (p: { content: string }) => { messages.push(p.content); }),
      editReply: mock(async (p: { content: string }) => { messages.push(p.content); }),
      followUp: mock(async () => undefined),
    };

    await listeners.get(Events.InteractionCreate)?.(interaction);
    tempChannels.delete(CHANNEL);
    return { messages, setUserLimit: channel.setUserLimit };
  }

  test('applique une valeur que Discord accepte', async () => {
    const { messages, setUserLimit } = await submitLimit('5');

    expect(setUserLimit).toHaveBeenCalledWith(5);
    expect(messages[0]).toContain('5');
  });

  test('refuse ce qui n\'est pas un nombre, et les valeurs négatives', async () => {
    // `Number.parseInt('abc')` rend `NaN` : sans la garde, `setUserLimit(NaN)`
    // part vers Discord. Et une limite négative n'a pas de sens.
    const texte = await submitLimit('abc');
    expect(texte.setUserLimit).not.toHaveBeenCalled();
    expect(texte.messages[0]).toContain('invalide');

    const negatif = await submitLimit('-3');
    expect(negatif.setUserLimit).not.toHaveBeenCalled();
    expect(negatif.messages[0]).toContain('invalide');
  });

  test('zéro s\'annonce comme une absence de limite', async () => {
    const { messages, setUserLimit } = await submitLimit('0');

    expect(setUserLimit).toHaveBeenCalledWith(0);
    expect(messages[0]).toContain('Limite de places retirée');
  });

  test('refuse une valeur au-delà de ce que Discord accepte', async () => {
    // La borne vient de la politique : l'écrire en dur ici la figerait, comme
    // le nombre de droits d'un accès complet l'avait été.
    const { messages, setUserLimit } = await submitLimit(String(MAX_USER_LIMIT + 1));

    expect(setUserLimit).not.toHaveBeenCalled();
    expect(messages[0]).toContain('invalide');
  });
});

describe('levée de la réservation depuis le panneau', () => {
  test('rend le droit à la catégorie au lieu de l\'autoriser', async () => {
    // Le correctif central de la branche, côté panneau. Il n'était vérifié que
    // par la route : ici, `values: []` est le geste « aucun rôle ».
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.findUnique = mock(async () => null);
    prismaMock.tempVoiceChannel.update = mock(async () => ({}));

    const { channel, edits } = fakeChannel();
    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:reserve_select', values: [],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits.map((entry) => entry.id)).toEqual([GUILD]);
    expect(edits[0]?.patch).toEqual({ Connect: null, SendMessages: null });
    tempChannels.delete(CHANNEL);
  });

  test('garde le refus de connexion de la catégorie', async () => {
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.findUnique = mock(async () => null);
    prismaMock.tempVoiceChannel.update = mock(async () => ({}));

    const { channel, edits } = fakeChannel();
    channel.parentId = CATEGORY;
    channel.parent = fakeCategory({
      inherited: new Map<string, unknown>([[GUILD, fakeOverwrite(0n, PermissionFlagsBits.Connect)]]),
    });
    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:reserve_select', values: [],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits[0]?.patch).toEqual({ Connect: false, SendMessages: null });
    tempChannels.delete(CHANNEL);
  });

  test('retire la surcharge du rôle réservé précédemment', async () => {
    // Sans ce retrait, le salon porte au bout de quelques changements la liste
    // de tous les rôles réservés depuis sa création. Côté panneau, rien ne
    // l'exigeait : `findUnique` rendait toujours `null` dans les tests.
    const PREVIOUS_ROLE = '820000000000000000';
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.findUnique = mock(async () => ({ roleId: PREVIOUS_ROLE }));
    prismaMock.tempVoiceChannel.update = mock(async () => ({}));

    const { channel } = fakeChannel();
    const removed: string[] = [];
    channel.permissionOverwrites.delete = mock(async (id: string) => { removed.push(id); }) as never;

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:reserve_select', values: [],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(removed).toContain(PREVIOUS_ROLE);
    prismaMock.tempVoiceChannel.findUnique = mock(async () => null);
    tempChannels.delete(CHANNEL);
  });
});

describe('bannissement d\'un membre', () => {
  test('coupe la connexion, la vue et le chat textuel', async () => {
    // Bannir ne coupait que la connexion : le banni continuait de lire et
    // d'écrire dans le chat du salon dont on venait de le sortir. La constante
    // était gardée, son site d'appel non.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, edits } = fakeChannel();

    const target = fakeTarget(OTHER, false);
    target.voice = { channelId: CHANNEL, disconnect: mock(async () => undefined) };

    const guild = fakeGuild(new Map<string, unknown>([[OTHER, target]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:ban_select', values: [OTHER],
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    const pose = edits.find((entry) => entry.id === OTHER);
    expect(pose?.patch).toEqual({ Connect: false, ViewChannel: false, SendMessages: false });
    expect(target.voice.disconnect).toHaveBeenCalled();
    tempChannels.delete(CHANNEL);
  });
});

describe('chat textuel du salon', () => {
  test('ferme le chat à @everyone en gardant la parole au propriétaire', async () => {
    // La création n'accorde plus « Envoyer des messages » au propriétaire :
    // fermer le chat sans la lui reposer le rendrait muet chez lui. Personne
    // d'autre ne doit recevoir de surcharge au passage.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits } = fakeChannel();

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('chat', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits.map((entry) => entry.id)).toEqual([OWNER, GUILD]);
    expect(edits[0]?.patch.SendMessages).toBe(true);
    expect(edits[1]?.patch.SendMessages).toBe(false);
    tempChannels.delete(CHANNEL);
  });

  test('relit le salon avant de décider du sens de la bascule', async () => {
    // Une écriture de surcharge ne met pas le cache à jour : le sens de la
    // bascule se décidait donc sur un état que la passerelle n'avait pas encore
    // rattrapé. Ici le cache dit « chat ouvert » et le salon est déjà fermé :
    // sans la relecture, le bouton le refermerait et annoncerait l'inverse.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits, overwrites } = fakeChannel();

    const guild = fakeGuild(new Map(), new Map(), () => {
      overwrites.set(GUILD, fakeOverwrite(0n, PermissionFlagsBits.SendMessages));
    });
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('chat', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(guild.channels.fetch).toHaveBeenCalled();
    expect(edits[0]?.patch.SendMessages).toBeNull();
    tempChannels.delete(CHANNEL);
  });

  test('rouvre le chat en rendant le droit à la catégorie', async () => {
    // Rouvrir en `true` ferait d'un salon temporaire le seul endroit où écrire
    // sur un serveur dont la catégorie réserve la parole : on rend le droit à
    // l'héritage, jamais on ne l'accorde.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits } = fakeChannel(PermissionFlagsBits.SendMessages);

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('chat', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    // @everyone retrouve sa catégorie, et le propriétaire aussi : lui laisser
    // la surcharge posée à la fermeture ferait du salon rouvert un endroit où
    // lui seul garde un droit explicite.
    expect(edits.map((entry) => entry.id)).toEqual([GUILD, OWNER]);
    expect(edits[0]?.patch.SendMessages).toBeNull();
    expect(edits[1]?.patch.SendMessages).toBeNull();
    tempChannels.delete(CHANNEL);
  });

  test('ne rouvre pas un chat que la catégorie ferme à @everyone', async () => {
    // Le salon a recopié ce refus à sa création : le bouton le lit comme un
    // chat fermé, et `null` l'aurait effacé en un clic.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits } = fakeChannel(PermissionFlagsBits.SendMessages);
    channel.parentId = CATEGORY;
    channel.parent = fakeCategory({
      inherited: new Map<string, unknown>([[GUILD, fakeOverwrite(0n, PermissionFlagsBits.SendMessages)]]),
    });

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('chat', { channel, guild, member: fakeTarget(OWNER, false) });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(edits[0]?.patch.SendMessages).toBe(false);
    tempChannels.delete(CHANNEL);
  });
});

describe('fermeture d\'un salon', () => {
  test('ne perd pas la trace d\'un salon que Discord refuse de supprimer', async () => {
    // L'état était purgé avant la suppression : quand `channel.delete` échoue,
    // le salon survit sur Discord mais plus rien ne le référence, et le
    // balayage - qui lit la base - ne le retrouvera jamais.
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.delete = mock(async () => ({}));

    const { channel } = fakeChannel();
    channel.delete = mock(async () => { throw new Error('Missing Permissions'); }) as never;

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const oldState = { channelId: CHANNEL, channel };
    const newState = { channelId: null, channel: null, guild: { id: GUILD }, member: fakeTarget(OWNER, false) };
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(channel.delete).toHaveBeenCalled();
    expect(prismaMock.tempVoiceChannel.delete).not.toHaveBeenCalled();
    expect(tempChannels.has(CHANNEL)).toBeTrue();
  });

  test('purge la mémoire et la base quand Discord accepte', async () => {
    // Le chemin nominal : sans lui, une `closeTempChannel` réduite à `return`
    // passerait le test précédent.
    guildConfig = { tempVoiceEnabled: true };
    prismaMock.tempVoiceChannel.delete = mock(async () => ({}));

    const { channel } = fakeChannel();
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const oldState = { channelId: CHANNEL, channel };
    const newState = { channelId: null, channel: null, guild: { id: GUILD }, member: fakeTarget(OWNER, false) };
    await listeners.get(Events.VoiceStateUpdate)?.(oldState, newState);

    expect(prismaMock.tempVoiceChannel.delete).toHaveBeenCalled();
    expect(tempChannels.has(CHANNEL)).toBeFalse();
  });
});

describe('boutons du panneau', () => {
  const context = () => {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });
    return { channel, listeners, guild: fakeGuild(new Map()) };
  };

  test('verrouiller acquitte avant de toucher aux permissions', async () => {
    const { channel, listeners, guild } = context();
    const { interaction, calls } = fakeButtonInteraction('lock', {
      channel, guild, member: fakeTarget(OWNER, false),
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(calls[0]).toBe('defer');
    expect(calls).toContain('editReply');
  });

  test('renommer ouvre la fenêtre de saisie sans acquitter', async () => {
    // Discord refuse `showModal` sur une interaction acquittée : ce test garde
    // la liste des actions qui diffèrent d'un élargissement distrait.
    const { channel, listeners, guild } = context();
    const { interaction, calls } = fakeButtonInteraction('rename', {
      channel, guild, member: fakeTarget(OWNER, false),
    });

    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(calls).toContain('showModal');
    expect(calls).not.toContain('defer');
  });

  test('un refus de récupération reste privé', async () => {
    // « Récupérer » est ouvert à tout le monde : ses refus ne doivent pas
    // s'afficher devant tout le salon.
    const { channel, listeners, guild } = context();
    channel.members.set(OWNER, {});
    const { interaction } = fakeButtonInteraction('claim', {
      channel, guild, member: fakeTarget(OTHER, false),
    });
    interaction.user = { id: OTHER, bot: false };

    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('renommage refusé', () => {
  test('distingue un refus de Discord d\'une simple attente', async () => {
    // `withTimeout` transformait tout échec en « pas de réponse dans le délai » :
    // un nom refusé par Discord annonçait « s'appliquera peut-être d'ici
    // quelques minutes », alors qu'il ne s'appliquerait jamais.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    channel.setName = mock(async () => { throw new Error('Invalid Form Body'); }) as never;

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const messages: string[] = [];
    const interaction = {
      guildId: GUILD,
      customId: 'tempvoice:rename_modal',
      channel, guild,
      member: fakeTarget(OWNER, false),
      user: { id: OWNER, bot: false },
      deferred: false,
      replied: false,
      isButton: () => false,
      isModalSubmit: () => true,
      isRoleSelectMenu: () => false,
      isUserSelectMenu: () => false,
      // Une vraie interaction Discord porte les trois gardes de type, quelle que
      // soit sa nature. En omettre une ici fait lever le module sur un appel
      // parfaitement legitime, et l'echec accuse le code au lieu du banc.
      isStringSelectMenu: () => false,
      isRepliable: () => true,
      fields: { getTextInputValue: () => 'Nouveau nom' },
      deferReply: mock(async () => { interaction.deferred = true; }),
      reply: mock(async (p: { content: string }) => { messages.push(p.content); }),
      editReply: mock(async (p: { content: string }) => { messages.push(p.content); }),
      followUp: mock(async () => undefined),
    };

    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('refusé');
    expect(messages[0]).not.toContain("n'a pas confirmé");
  });
});

/** Rejoue le balayage de démarrage et attend qu'il se termine. */
async function runSweep(listeners: Map<string, (...args: unknown[]) => unknown>) {
  const onReady = listeners.get(`once:${Events.ClientReady}`);
  expect(onReady).toBeDefined();
  await onReady?.();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('sweepOrphanChannels', () => {
  test('libère la ligne d\'un salon disparu de Discord', async () => {
    // Un salon supprimé à la main pendant l'arrêt du bot laissait sa ligne en
    // base : le panneau du dashboard continuait de le lister.
    prismaMock.tempVoiceChannel.findMany = mock(async () => [
      { id: CHANNEL, guildId: GUILD, creatorId: OWNER },
    ]);
    prismaMock.tempVoiceChannel.delete = mock(async () => ({}));

    const guild = { id: GUILD, available: true, channels: { cache: new Map() } };
    const { client, listeners } = fakeClient(new Map([[GUILD, guild]]));

    registerTempVoiceListener(client);
    await runSweep(listeners);

    expect(prismaMock.tempVoiceChannel.delete).toHaveBeenCalled();
    expect(tempChannels.has(CHANNEL)).toBe(false);
  });

  test('ferme un salon déjà vide et reprend un salon occupé', async () => {
    // Un salon ne disparaît qu'au départ de son dernier occupant : sans ce
    // balayage, ceux vides au démarrage resteraient ouverts indéfiniment. Et
    // sans la reprise, ceux qui vivent encore ne seraient plus pilotables.
    const BUSY_CHANNEL = '410000000000000000';
    prismaMock.tempVoiceChannel.findMany = mock(async () => [
      { id: CHANNEL, guildId: GUILD, creatorId: OWNER },
      { id: BUSY_CHANNEL, guildId: GUILD, creatorId: OTHER },
    ]);
    prismaMock.tempVoiceChannel.delete = mock(async () => ({}));

    const { channel: vide } = fakeChannel();
    const { channel: occupe } = fakeChannel();
    occupe.id = BUSY_CHANNEL;
    occupe.members = new Map<string, unknown>([[OTHER, fakeTarget(OTHER, false)]]);

    const guild = {
      id: GUILD,
      available: true,
      channels: { cache: new Map<string, unknown>([[CHANNEL, vide], [BUSY_CHANNEL, occupe]]) },
    };
    const { client, listeners } = fakeClient(new Map([[GUILD, guild]]));

    registerTempVoiceListener(client);
    await runSweep(listeners);

    expect(vide.delete).toHaveBeenCalled();
    expect(occupe.delete).not.toHaveBeenCalled();
    expect(tempChannels.get(BUSY_CHANNEL)?.creatorId).toBe(OTHER);
    tempChannels.delete(BUSY_CHANNEL);
  });

  test('un serveur injoignable est laissé de côté, pas nettoyé', async () => {
    // Le risque : un serveur indisponible reste en cache sans ses salons.
    // Conclure « le salon n'existe plus » effaçait la ligne en base alors que
    // le salon existait toujours - plus rien ne le référençait, et il ne
    // pouvait plus jamais être nettoyé.
    prismaMock.tempVoiceChannel.findMany = mock(async () => [
      { id: CHANNEL, guildId: GUILD, creatorId: OWNER },
    ]);
    prismaMock.tempVoiceChannel.delete = mock(async () => ({}));

    const unavailableGuild = { id: GUILD, available: false, channels: { cache: new Map() } };
    const { client, listeners } = fakeClient(new Map([[GUILD, unavailableGuild]]));

    registerTempVoiceListener(client);
    const onReady = listeners.get(`once:${Events.ClientReady}`);
    expect(onReady).toBeDefined();
    await onReady?.();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(prismaMock.tempVoiceChannel.delete).not.toHaveBeenCalled();
  });
});

describe('renommage', () => {
  test('n\'annonce pas un succès que Discord n\'a pas confirmé', async () => {
    // Le risque : `@discordjs/rest` ne rejette pas sur une limite de debit, il
    // attend la fin de la fenêtre puis rejoue la requête. Un `.catch` ne voit
    // donc jamais ce cas, et l'ancien code annonçait « renommé » ou attendait
    // jusqu'à l'expiration de l'interaction.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };

    const { channel } = fakeChannel();
    // Renommage qui aboutit, mais plus tard que le délai accordé : c'est ce que
    // fait le client REST quand Discord temporise - il attend la fin de la
    // fenêtre, puis rejoue la requête avec succès.
    channel.setName = mock(
      () => new Promise((resolve) => setTimeout(resolve, LATE_RENAME_MS)),
    ) as never;

    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const messages: string[] = [];
    const interaction = {
      guildId: GUILD,
      customId: 'tempvoice:rename_modal',
      channel,
      guild,
      member: fakeTarget(OWNER, false),
      user: { id: OWNER, bot: false },
      deferred: false,
      replied: false,
      isButton: () => false,
      isModalSubmit: () => true,
      isRoleSelectMenu: () => false,
      isUserSelectMenu: () => false,
      // Une vraie interaction Discord porte les trois gardes de type, quelle que
      // soit sa nature. En omettre une ici fait lever le module sur un appel
      // parfaitement legitime, et l'echec accuse le code au lieu du banc.
      isStringSelectMenu: () => false,
      isRepliable: () => true,
      fields: { getTextInputValue: () => 'Nouveau nom' },
      deferReply: mock(async () => { interaction.deferred = true; }),
      reply: mock(async (payload: { content: string }) => { messages.push(payload.content); }),
      editReply: mock(async (payload: { content: string }) => { messages.push(payload.content); }),
      followUp: mock(async () => undefined),
    };

    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    // Ni « renommé » (faux), ni « échoue » (faux aussi : la requête suit son
    // cours) - le message doit dire que Discord n'a pas confirmé.
    expect(messages[0]).toContain("n'a pas confirmé");
  });
});

/**
 * Le câblage, et non le calcul.
 *
 * `tempVoiceService.test.ts` prouve que les fonctions pures sont justes ; rien
 * n'y prouve que l'écouteur les appelle. Un test de la fonction laisse passer
 * l'appelant qui l'oublie — c'est une leçon déjà payée deux fois ici. Un test
 * par site d'appel, donc, et chacun échoue si on retire l'appel correspondant
 * de `tempVoice.ts` sans rien casser d'autre.
 */
describe('câblage du panneau refondu', () => {
  const TROISIEME = '700000000000000000';

  /** Écouteur prêt à recevoir, sur un salon déjà enregistré. */
  function scene(entree: { creatorId: string; modeEcriture?: 'everyone' | 'inVoice' | 'ownerOnly' | 'nobody' }) {
    const { channel, edits } = fakeChannel();
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, entree);
    return { channel, edits, listeners };
  }

  function entreeVocale(channel: unknown, membre: unknown) {
    return [
      { channelId: null, channel: null },
      { channelId: CHANNEL, channel, guild: { id: GUILD }, member: membre },
    ] as const;
  }

  function sortieVocale(channel: unknown, membre: unknown) {
    return [
      { channelId: CHANNEL, channel },
      { channelId: null, channel: null, guild: { id: GUILD }, member: membre },
    ] as const;
  }

  test('une entrée en vocal pose la parole quand le mode la suit', async () => {
    // `decisionEntreeVocal` est testée ailleurs ; ici on prouve qu'elle est
    // appelée sur `VoiceStateUpdate`. Sans cet appel, le mode « ceux qui sont en
    // vocal » ne donne la parole à personne, en silence.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits, listeners } = scene({ creatorId: OWNER, modeEcriture: 'inVoice' });

    await listeners.get(Events.VoiceStateUpdate)?.(...entreeVocale(channel, fakeTarget(OTHER, false)));

    expect(edits).toEqual([{ id: OTHER, patch: { SendMessages: true } }]);
    tempChannels.delete(CHANNEL);
  });

  test('un autre mode ne pose aucune surcharge à l\'entrée', async () => {
    // Le versant négatif : une pose inconditionnelle passerait le test ci-dessus.
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits, listeners } = scene({ creatorId: OWNER, modeEcriture: 'everyone' });

    await listeners.get(Events.VoiceStateUpdate)?.(...entreeVocale(channel, fakeTarget(OTHER, false)));

    expect(edits).toEqual([]);
    tempChannels.delete(CHANNEL);
  });

  test('quitter le vocal retire la surcharge que la présence avait posée', async () => {
    // Membre propre au test : les marques d'origine ne s'effacent qu'à la mort
    // du salon, et deux tests sur le même couple salon+membre se marcheraient
    // dessus.
    const PARTANT = '710000000000000000';
    guildConfig = { tempVoiceEnabled: true };
    const { channel, edits, listeners } = scene({ creatorId: OWNER, modeEcriture: 'inVoice' });
    const partant = fakeTarget(PARTANT, false);

    await listeners.get(Events.VoiceStateUpdate)?.(...entreeVocale(channel, partant));
    // Le salon n'est pas vide : sans occupant, il serait supprimé au départ.
    channel.members.set(OWNER, {});
    await listeners.get(Events.VoiceStateUpdate)?.(...sortieVocale(channel, partant));

    expect(edits).toEqual([
      { id: PARTANT, patch: { SendMessages: true } },
      { id: PARTANT, patch: { SendMessages: null } },
    ]);
    tempChannels.delete(CHANNEL);
  });

  test('quitter le vocal n\'efface pas une autorisation donnée à la main', async () => {
    // Le point le plus exposé de la refonte : « Autoriser » et la présence
    // écrivent la même surcharge. Sans le marquage d'origine posé par
    // `trust_select`, ce départ effacerait un droit donné à la main — et rien,
    // ni côté service ni côté Discord, ne le signalerait.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, edits, listeners } = scene({ creatorId: OWNER, modeEcriture: 'inVoice' });

    const INVITE = '720000000000000000';
    const invite = fakeTarget(INVITE, false);
    const guild = fakeGuild(new Map<string, unknown>([[INVITE, invite]]));

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:trust_select', values: [INVITE],
      channel, member: fakeTarget(OWNER, false), guild,
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    const ecrituresApresAutorisation = edits.length;
    expect(ecrituresApresAutorisation).toBeGreaterThan(0);

    channel.members.set(OWNER, {});
    await listeners.get(Events.VoiceStateUpdate)?.(...sortieVocale(channel, invite));

    // Rien de plus n'a été écrit : la surcharge d'« Autoriser » est intacte.
    expect(edits).toHaveLength(ecrituresApresAutorisation);
    tempChannels.delete(CHANNEL);
  });

  /** Rejoue un clic de bouton d'un modérateur, et rend ce que Discord a reçu. */
  async function verrouParModerateur(reglages: Record<string, string> | undefined) {
    const STAFF_ROLE = '500000000000000000';
    guildConfig = {
      tempVoiceEnabled: true,
      baseStaffRoleId: STAFF_ROLE,
      moderatorRoleId: null,
      testStaffRoleId: null,
    };
    // Les reglages viennent d'une TABLE, pas d'une colonne de `Guild` : sans
    // cette ligne, `lireReglagesAdmin` retombe sur « tout autorise » et le test
    // passerait au vert en prouvant le contraire de ce qu'il annonce.
    permissionsModerateur = reglages
      ? { canLock: reglages.verrouiller !== 'adminsSeulement' }
      : null;
    const { channel, edits, listeners } = scene({ creatorId: OWNER });

    const moderateur = fakeTarget(OTHER, false);
    moderateur.roles = { cache: { has: (id: string): boolean => id === STAFF_ROLE } };
    const guild = fakeGuild(new Map<string, unknown>([[OTHER, moderateur]]));

    const { interaction } = fakeButtonInteraction('lock', { channel, guild, member: moderateur });
    interaction.user = { id: OTHER, bot: false };
    await listeners.get(Events.InteractionCreate)?.(interaction);

    tempChannels.delete(CHANNEL);
    return edits;
  }

  test('un modérateur ne verrouille pas ce qu\'un admin lui a fermé', async () => {
    // `peutAgir` n'a pas de valeur par défaut à dessein : un appelant qui
    // l'oublierait obtiendrait un panneau tout permis, et ce test serait le seul
    // à s'en apercevoir.
    expect(await verrouParModerateur({ verrouiller: 'adminsSeulement' })).toHaveLength(0);
  });

  test('le même modérateur verrouille quand le réglage l\'autorise', async () => {
    // Le versant positif : une garde qui refuserait toujours passerait aussi le
    // test précédent, et le panneau serait mort sans que rien ne le dise.
    expect(await verrouParModerateur({ verrouiller: 'autorise' })).not.toHaveLength(0);
  });

  /** Rejoue la fenêtre de saisie du renommage. */
  async function renomme(channel: unknown, guild: unknown, listeners: Map<string, (...args: unknown[]) => unknown>, valeur: string) {
    const interaction = {
      guildId: GUILD,
      customId: 'tempvoice:rename_modal',
      channel,
      guild,
      member: fakeTarget(OWNER, false),
      user: { id: OWNER, bot: false },
      deferred: false,
      replied: false,
      isButton: () => false,
      isModalSubmit: () => true,
      isRoleSelectMenu: () => false,
      isUserSelectMenu: () => false,
      // Une vraie interaction Discord porte les trois gardes de type, quelle que
      // soit sa nature. En omettre une ici fait lever le module sur un appel
      // parfaitement legitime, et l'echec accuse le code au lieu du banc.
      isStringSelectMenu: () => false,
      isMessageComponent: () => false,
      isRepliable: () => true,
      fields: { getTextInputValue: () => valeur },
      deferReply: mock(async () => { interaction.deferred = true; }),
      reply: mock(async () => { interaction.replied = true; }),
      editReply: mock(async () => undefined),
      followUp: mock(async () => undefined),
    };
    await listeners.get(Events.InteractionCreate)?.(interaction);
  }

  test('le troisième renommage en dix minutes n\'ouvre pas la fenêtre de saisie', async () => {
    // Discord ne refuse pas le troisième : il l'attend, parfois plusieurs
    // minutes, sans rien dire. Le quota doit donc être consommé au site d'appel,
    // sinon le bouton annonce un compte qui ne bouge jamais.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, listeners } = scene({ creatorId: OWNER });
    const guild = fakeGuild(new Map());

    await renomme(channel, guild, listeners, 'Un');
    await renomme(channel, guild, listeners, 'Deux');

    const { interaction, calls } = fakeButtonInteraction('rename', {
      channel, guild, member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    expect(calls).not.toContain('showModal');
    tempChannels.delete(CHANNEL);
  });

  test('le bouton « Demander l\'accès » suit le réglage du serveur', async () => {
    // `boutonDemanderAccesVisible` décide ; encore faut-il que la rangée
    // l'appelle, et avec la config. Un salon ouvert n'a que trois portes, et un
    // serveur qui n'a pas activé les demandes n'en a jamais quatre.
    guildConfig = generatorConfig();

    const identifiantsDuPanneau = async (ligne: Record<string, unknown> | null, verrouille: boolean) => {
      configDemandes = ligne;
      const scene = fakeCreationGuild(
        fakeCategory(),
        verrouille ? { everyoneDeny: PermissionFlagsBits.Connect } : {},
      );
      const arrivee = fakeJoiningMember(scene.guild);
      const { client, listeners } = fakeClient();
      registerTempVoiceListener(client);
      await listeners.get(Events.VoiceStateUpdate)?.(arrivee.oldState, arrivee.newState);
      tempChannels.delete(CHANNEL);

      const rows = (scene.posted[0]?.components ?? []) as Array<{ components: Array<{ data: { custom_id?: string } }> }>;
      return rows.flatMap((row) => row.components.map((c) => c.data.custom_id ?? ''));
    };

    expect(await identifiantsDuPanneau(ligneDemandes(), true)).toContain('tempvoice:demander');
    // Le versant négatif, celui que la revue a relevé : la colonne `enabled`
    // était écrite par le dashboard et jamais lue.
    expect(await identifiantsDuPanneau(ligneDemandes({ enabled: false }), true)).not.toContain('tempvoice:demander');
    expect(await identifiantsDuPanneau(null, true)).not.toContain('tempvoice:demander');
    expect(await identifiantsDuPanneau(ligneDemandes(), false)).not.toContain('tempvoice:demander');
    configDemandes = null;
  });

  test('une deuxième demande d\'accès ne repingue pas le propriétaire', async () => {
    // Sans le registre, un membre contrarié envoie trente pings en dix secondes.
    // Le garde-fou vit dans le service ; ce test prouve qu'on le consulte.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    configDemandes = ligneDemandes();
    const { channel: salon } = fakeChannel(PermissionFlagsBits.Connect);
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const demandeur = fakeTarget(TROISIEME, false);
    const guild = fakeGuild(new Map<string, unknown>([[TROISIEME, demandeur]]));

    const cliquer = async () => {
      const { interaction } = fakeButtonInteraction('demander', { channel: salon, guild, member: demandeur });
      interaction.user = { id: TROISIEME, bot: false };
      await listeners.get(Events.InteractionCreate)?.(interaction);
    };

    await cliquer();
    await cliquer();

    expect(salon.send).toHaveBeenCalledTimes(1);
    tempChannels.delete(CHANNEL);
    configDemandes = null;
  });
});

/**
 * Ce que la configuration des demandes d'accès change *au clic*.
 *
 * `tempVoiceService.test.ts` prouve que `peutRepondreDemande`,
 * `boutonDemanderAccesVisible` et `nettoyagePresenceAuDemarrage` sont justes.
 * Aucun de ces tests ne prouve que l'écouteur les appelle : la colonne
 * `enabled` était écrite par le dashboard et lue par personne. Un test par site
 * d'appel, donc, chacun rouge si l'appel disparaît de `tempVoice.ts`.
 */
describe('configuration des demandes d\'accès', () => {
  const ROLE_STAFF = '510000000000000000';

  afterAll(() => setSystemTime());

  /**
   * Un salon verrouillé sur lequel une demande a déjà été déposée *par le
   * bouton*, et la carte de décision postée. Rien n'est injecté dans le
   * registre : la demande suit le chemin de production.
   */
  async function demandeDeposee(options: {
    ligne: Record<string, unknown>;
    demandeur: ReturnType<typeof fakeTarget>;
    repondeur: ReturnType<typeof fakeTarget>;
    proprietaire?: ReturnType<typeof fakeTarget>;
    reglagesModerateur?: Record<string, boolean>;
    /** Salon de notification dédié, avec ou sans droit d'écriture pour le bot. */
    salonDedie?: { id: string; peutEcrire: boolean };
  }) {
    guildConfig = {
      tempVoiceEnabled: true,
      baseStaffRoleId: ROLE_STAFF,
      moderatorRoleId: null,
      testStaffRoleId: null,
    };
    configDemandes = options.ligne;
    permissionsModerateur = options.reglagesModerateur ?? null;

    const { channel, edits } = fakeChannel(PermissionFlagsBits.Connect);
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const membres = new Map<string, unknown>([
      [options.demandeur.id, options.demandeur],
      [options.repondeur.id, options.repondeur],
    ]);
    if (options.proprietaire) membres.set(OWNER, options.proprietaire);
    const guild = fakeGuild(membres);

    // Le salon dédié n'existe que si le test en demande un : `fakeGuild` rend
    // `null` par défaut, ce qui est exactement le cas « salon disparu ».
    const messagesDedies: Array<Record<string, unknown>> = [];
    if (options.salonDedie) {
      const dedie = {
        id: options.salonDedie.id,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => options.salonDedie?.peutEcrire ?? false }),
        send: mock(async (message: Record<string, unknown>) => {
          messagesDedies.push(message);
          return { id: '900000000000000000' };
        }),
      };
      guild.channels.fetch = mock(async (id: string) => (id === dedie.id ? dedie : null)) as never;
    }

    const depot = fakeButtonInteraction('demander', { channel, guild, member: options.demandeur });
    depot.interaction.user = { id: options.demandeur.id, bot: false };
    await listeners.get(Events.InteractionCreate)?.(depot.interaction);

    /** Le clic du répondeur sur la carte, avec l'identifiant qu'elle porte. */
    const trancher = async (verdict: 'ok' | 'non' | 'ban') => {
      const { interaction } = fakeButtonInteraction(
        `demande_${verdict}:${options.demandeur.id}:${CHANNEL}`,
        { channel, guild, member: options.repondeur },
      );
      interaction.user = { id: options.repondeur.id, bot: false };
      await listeners.get(Events.InteractionCreate)?.(interaction);
    };

    /** Rend la mémoire du module : sinon la demande suivante hérite de celle-ci. */
    const ranger = () => {
      tempChannels.delete(CHANNEL);
      configDemandes = null;
      permissionsModerateur = null;
    };

    return { channel, edits, guild, listeners, trancher, ranger, messagesDedies };
  }

  /** Un modérateur : reconnu staff, mais ni propriétaire ni administrateur. */
  function moderateur(id: string) {
    const membre = fakeTarget(id, false);
    membre.roles = { cache: { has: (role: string): boolean => role === ROLE_STAFF } };
    return membre;
  }

  test('`responders: OWNER` refuse au modérateur d\'accepter une demande', async () => {
    // Le clic passe la garde d'entrée (un modérateur est staff) : seule la
    // colonne `responders` l'arrête. Elle ne gouverne aucune action de
    // `peutAgir`, et l'écouteur appelait justement `peutAgir`.
    const demandeur = fakeTarget('730000000000000000', false);
    const scene = await demandeDeposee({
      ligne: ligneDemandes({ responders: 'OWNER' }),
      demandeur,
      repondeur: moderateur(OTHER),
    });

    await scene.trancher('ok');

    expect(scene.edits.filter((e) => e.id === demandeur.id)).toHaveLength(0);
    scene.ranger();
  });

  test('`responders: OWNER_AND_STAFF` le laisse trancher', async () => {
    // Le versant positif : une garde qui refuserait toujours passerait aussi le
    // test précédent, et la carte serait morte sans que rien ne le dise.
    const demandeur = fakeTarget('731000000000000000', false);
    const scene = await demandeDeposee({
      ligne: ligneDemandes({ responders: 'OWNER_AND_STAFF' }),
      demandeur,
      repondeur: moderateur(OTHER),
    });

    await scene.trancher('ok');

    expect(scene.edits.filter((e) => e.id === demandeur.id)).not.toHaveLength(0);
    scene.ranger();
  });

  test('« Refuser et bannir » respecte le réglage des modérateurs', async () => {
    // Le plus grave des points de revue : cette branche passait par
    // `repondreDemande`, qu'aucun réglage ne gouverne. Un modérateur bannissait
    // avec `canKickOrBan` désactivé.
    const demandeur = fakeTarget('732000000000000000', false);
    const scene = await demandeDeposee({
      ligne: ligneDemandes(),
      demandeur,
      repondeur: moderateur(OTHER),
      reglagesModerateur: { canKickOrBan: false },
    });

    await scene.trancher('ban');

    expect(scene.edits.filter((e) => e.id === demandeur.id)).toHaveLength(0);
    scene.ranger();
  });

  test('« Refuser et bannir » ne touche pas un membre du staff', async () => {
    // L'autre moitié du même trou : aucun `isProtectedTarget` ne protégeait le
    // staff sur cette branche, alors que le même geste sur la fiche du membre
    // l'exige. Le propriétaire tranche ici, pour qu'aucun réglage de modérateur
    // ne puisse expliquer le refus à sa place.
    const demandeur = fakeTarget('733000000000000000', false);
    demandeur.roles = { cache: { has: (role: string): boolean => role === ROLE_STAFF } };
    const scene = await demandeDeposee({
      ligne: ligneDemandes(),
      demandeur,
      repondeur: fakeTarget(OWNER, false),
    });

    await scene.trancher('ban');

    expect(scene.edits.filter((e) => e.id === demandeur.id)).toHaveLength(0);
    scene.ranger();
  });

  test('une demande expirée n\'ouvre plus rien', async () => {
    // Une carte reste cliquable indéfiniment : sans vérification, « Autoriser »
    // accordait encore l'accès sur une demande que le registre avait oubliée.
    const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);
    setSystemTime(new Date(T0));

    const demandeur = fakeTarget('734000000000000000', false);
    const scene = await demandeDeposee({
      // Une minute, le minimum que le schéma accepte.
      ligne: ligneDemandes({ requestExpiresMinutes: 1 }),
      demandeur,
      repondeur: fakeTarget(OWNER, false),
    });

    setSystemTime(new Date(T0 + 5 * 60_000));
    await scene.trancher('ok');
    setSystemTime();

    expect(scene.edits.filter((e) => e.id === demandeur.id)).toHaveLength(0);
    scene.ranger();
  });

  test('le refus annonce le délai du serveur, pas celui du registre', async () => {
    // `prevenirDemandeur` affichait `registreDemandes.silenceMs` - le défaut du
    // registre, partagé par tous les serveurs. Un administrateur qui règle
    // trente minutes lisait dix.
    const demandeur = fakeTarget('735000000000000000', false);
    const scene = await demandeDeposee({
      ligne: ligneDemandes({ denyCooldownMinutes: 30 }),
      demandeur,
      repondeur: fakeTarget(OWNER, false),
    });

    await scene.trancher('non');

    const descriptions = demandeur.mp.flatMap((message) => {
      const embeds = (message.embeds ?? []) as Array<{ data?: { description?: string } }>;
      return embeds.map((embed) => embed.data?.description ?? '');
    });
    expect(descriptions.join(' ')).toContain('30 min');
    scene.ranger();
  });

  test('un MP fermé fait retomber la carte dans le salon vocal', async () => {
    // Discord n'offre aucun moyen de savoir à l'avance qu'un membre a fermé ses
    // MP : l'envoi échoue en silence. Sans repli, la demande n'atteint
    // personne et le demandeur attend une réponse qui ne viendra jamais.
    const demandeur = fakeTarget('736000000000000000', false);
    const proprietaire = fakeTarget(OWNER, false);
    proprietaire.send = mock(async () => { throw new Error('Cannot send messages to this user'); });

    const scene = await demandeDeposee({
      ligne: ligneDemandes({ notifyVia: 'DM' }),
      demandeur,
      repondeur: proprietaire,
      proprietaire,
    });

    expect(proprietaire.send).toHaveBeenCalled();
    expect(scene.channel.send).toHaveBeenCalledTimes(1);
    scene.ranger();
  });

  test('le salon dédié reçoit la carte, et elle garde ses boutons', async () => {
    // La seule branche de la cascade qu'aucun test ne couvrait. Elle enchaîne
    // trois choses qu'une relecture ne prouve pas : la relecture du salon par
    // son identifiant, le contrôle du droit d'écriture, et l'identifiant de
    // salon embarqué dans les boutons - sans lui, une carte hors du salon
    // vocal n'a plus rien à piloter.
    const demandeur = fakeTarget('738000000000000000', false);
    const proprietaire = fakeTarget(OWNER, false);
    const DEDIE = '850000000000000000';

    const scene = await demandeDeposee({
      ligne: ligneDemandes({ notifyVia: 'CHANNEL', notifyChannelId: DEDIE }),
      demandeur,
      repondeur: proprietaire,
      proprietaire,
      salonDedie: { id: DEDIE, peutEcrire: true },
    });

    expect(scene.messagesDedies).toHaveLength(1);
    // Le salon dédié a servi : ni le salon vocal ni le MP n'ont été sollicités.
    expect(scene.channel.send).not.toHaveBeenCalled();
    expect(proprietaire.mp).toHaveLength(0);

    const carte = scene.messagesDedies[0] as {
      content?: string;
      components?: Array<{ components: Array<{ data: { custom_id?: string } }> }>;
    };
    // C'est la mention qui notifie : un embed n'en produit aucune.
    expect(carte.content).toBe(`<@${OWNER}>`);

    const autoriser = (carte.components ?? [])
      .flatMap((rangee) => rangee.components.map((composant) => composant.data.custom_id ?? ''))
      .find((id) => id.startsWith('tempvoice:demande_ok:')) ?? '';
    expect(autoriser).toBe(`tempvoice:demande_ok:${demandeur.id}:${CHANNEL}`);
    expect(autoriser.length).toBeLessThanOrEqual(100);

    scene.ranger();
  });

  test('un salon dédié où le bot est muet fait retomber la carte dans le vocal', async () => {
    // Un salon où le bot ne peut pas écrire n'est pas un canal. Sans ce
    // contrôle, la demande partait dans le vide : la carte semblait envoyée et
    // le propriétaire n'en voyait jamais la couleur.
    const demandeur = fakeTarget('739000000000000000', false);
    const proprietaire = fakeTarget(OWNER, false);
    const DEDIE = '851000000000000000';

    const scene = await demandeDeposee({
      ligne: ligneDemandes({ notifyVia: 'CHANNEL', notifyChannelId: DEDIE }),
      demandeur,
      repondeur: proprietaire,
      proprietaire,
      salonDedie: { id: DEDIE, peutEcrire: false },
    });

    expect(scene.messagesDedies).toHaveLength(0);
    expect(scene.channel.send).toHaveBeenCalledTimes(1);
    scene.ranger();
  });

  test('un salon dédié disparu fait retomber la carte dans le vocal', async () => {
    // `notifyChannelId` désigne un salon que l'administrateur a pu supprimer
    // depuis. La relecture rend `null`, et la cascade doit continuer.
    const demandeur = fakeTarget('740000000000000000', false);
    const proprietaire = fakeTarget(OWNER, false);

    const scene = await demandeDeposee({
      ligne: ligneDemandes({ notifyVia: 'CHANNEL', notifyChannelId: '852000000000000000' }),
      demandeur,
      repondeur: proprietaire,
      proprietaire,
    });

    expect(scene.channel.send).toHaveBeenCalledTimes(1);
    scene.ranger();
  });

  test('une carte reçue en MP garde la main sur son salon', async () => {
    // Le piège de la cascade : le gestionnaire résolvait le salon depuis
    // `interaction.channel`. Une carte reçue en MP n'a plus le salon vocal sous
    // la main, et ses boutons n'auraient plus rien à piloter.
    const demandeur = fakeTarget('737000000000000000', false);
    const proprietaire = fakeTarget(OWNER, false);

    const scene = await demandeDeposee({
      ligne: ligneDemandes({ notifyVia: 'DM' }),
      demandeur,
      repondeur: proprietaire,
      proprietaire,
    });

    // Le MP a abouti : la carte n'est pas partie dans le salon vocal.
    expect(scene.channel.send).not.toHaveBeenCalled();

    const carte = proprietaire.mp[0] as {
      components?: Array<{ components: Array<{ data: { custom_id?: string } }> }>;
    };
    const autoriser = (carte.components ?? [])
      .flatMap((rangee) => rangee.components.map((composant) => composant.data.custom_id ?? ''))
      .find((id) => id.startsWith('tempvoice:demande_ok:')) ?? '';

    expect(autoriser).toBe(`tempvoice:demande_ok:${demandeur.id}:${CHANNEL}`);
    // Discord refuse un `custom_id` au-delà de cent caractères.
    expect(autoriser.length).toBeLessThanOrEqual(100);

    // Le MP ne porte ni salon vocal ni serveur : seul l'identifiant les désigne.
    scene.channel.guild = scene.guild;
    const interaction = {
      guildId: null as string | null,
      customId: autoriser,
      channel: { id: '800000000000000000', type: 1 },
      guild: null as unknown,
      member: null as unknown,
      client: { channels: { fetch: mock(async () => scene.channel) } },
      user: { id: OWNER, bot: false },
      deferred: false,
      replied: false,
      isButton: () => true,
      isModalSubmit: () => false,
      isRoleSelectMenu: () => false,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isMessageComponent: () => true,
      isRepliable: () => true,
      message: { edit: mock(async () => undefined) },
      deferUpdate: mock(async () => { interaction.deferred = true; }),
      deferReply: mock(async () => { interaction.deferred = true; }),
      reply: mock(async () => { interaction.replied = true; }),
      editReply: mock(async () => undefined),
      followUp: mock(async () => undefined),
    };
    await scene.listeners.get(Events.InteractionCreate)?.(interaction);

    expect(scene.edits.filter((e) => e.id === demandeur.id)).not.toHaveLength(0);
    scene.ranger();
  });
});

describe('reprise des surcharges au démarrage', () => {
  test('ne retire que les présences devenues orphelines', async () => {
    // Le registre d'origines est en mémoire : après un redémarrage, les
    // surcharges de présence n'ont plus personne pour les retirer. Et la forme
    // ne sert que dans un sens - `SendMessages` sans `Connect` ne peut venir
    // que de la présence ; une autorisation donne toujours `Connect`.
    const ABSENT = '740000000000000000';
    const PRESENT = '741000000000000000';
    const AUTORISE = '742000000000000000';

    prismaMock.tempVoiceChannel.findMany = mock(async () => [
      // `writeMode` relu : sans lui le mode retombe sur « ouvert », et toutes
      // les présences seraient retirées, y compris celle d'un membre encore là.
      { id: CHANNEL, guildId: GUILD, creatorId: OWNER, writeMode: 'inVoice' },
    ]);
    prismaMock.tempVoiceChannel.delete = mock(async () => ({}));

    const { channel, edits, seedOverwrite } = fakeChannel();
    channel.members = new Map<string, unknown>([[PRESENT, fakeTarget(PRESENT, false)]]);
    seedOverwrite(ABSENT, fakeOverwrite(PermissionFlagsBits.SendMessages));
    seedOverwrite(PRESENT, fakeOverwrite(PermissionFlagsBits.SendMessages));
    seedOverwrite(AUTORISE, fakeOverwrite(PermissionFlagsBits.SendMessages | PermissionFlagsBits.Connect));

    const guild = { id: GUILD, available: true, channels: { cache: new Map([[CHANNEL, channel]]) } };
    const { client, listeners } = fakeClient(new Map([[GUILD, guild]]));

    registerTempVoiceListener(client);
    await runSweep(listeners);

    expect(edits).toEqual([{ id: ABSENT, patch: { SendMessages: null } }]);
    tempChannels.delete(CHANNEL);
  });
});

describe('Réécriture du panneau : anciens messages et composants V2', () => {
  /**
   * Un panneau tel que Discord le rend : `flags.has()` dit s'il est déjà en
   * composants V2. Un message posté avant ce passage porte encore un `content`,
   * que Discord refuse de voir coexister avec des composants V2.
   */
  function fauxPanneau(estV2: boolean, supprimable = true) {
    return {
      id: '777000000000000001',
      flags: { has: (drapeau: number) => estV2 && drapeau === MessageFlags.IsComponentsV2 },
      edit: mock(async () => undefined),
      delete: mock(async () => {
        if (!supprimable) throw new Error('Missing Permissions');
      }),
    };
  }

  /** Un salon temporaire vivant dont le panneau est déjà connu. */
  function salonAvecPanneau(id: string, panneau: ReturnType<typeof fauxPanneau>) {
    const { channel } = fakeChannel();
    channel.id = id;
    (channel as { guild: Record<string, unknown> }).guild = {
      id: GUILD,
      roles: { everyone: { id: GUILD } },
      channels: { fetch: mock(async () => null) },
    };
    (channel as { messages?: unknown }).messages = { fetch: mock(async () => panneau) };
    tempChannels.set(id, { creatorId: OWNER, panneauId: panneau.id });
    return channel;
  }

  test('le panneau est mis a jour, jamais supprime ni repose', async () => {
    // Le panneau de base est poste une fois, a la creation du salon. Le
    // supprimer pour en reposter un laissait le salon SANS AUCUN panneau des que
    // l'envoi echouait - et il echoue precisement quand le mode d'ecriture ferme
    // le chat, puisque le bot n'a pas de surcharge a lui.
    const ancien = fauxPanneau(false);
    const dejaV2 = fauxPanneau(true);

    const salonAncien = salonAvecPanneau('910000000000000001', ancien);
    const salonV2 = salonAvecPanneau('910000000000000002', dejaV2);

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    const guild = fakeGuild(new Map());

    for (const salon of [salonAncien, salonV2]) {
      const { interaction } = fakeButtonInteraction('salon', { channel: salon, guild, member: null });
      await listeners.get(Events.InteractionCreate)?.(interaction);
    }

    await new Promise((resolve) => setTimeout(resolve, 400));

    // Les deux sont edites, quelle que soit leur forme.
    expect(ancien.edit).toHaveBeenCalled();
    expect(dejaV2.edit).toHaveBeenCalled();

    // Et aucun n'est supprime, ni remplace par un envoi.
    expect(ancien.delete).not.toHaveBeenCalled();
    expect(dejaV2.delete).not.toHaveBeenCalled();
    expect(salonAncien.send).not.toHaveBeenCalled();
    expect(salonV2.send).not.toHaveBeenCalled();

    for (const id of ['910000000000000001', '910000000000000002']) {
      tempChannels.delete(id);
    }
  }, 10_000);
});

describe('Fraîcheur des sous-panneaux', () => {
  test('la fiche d\'un membre est redessinée sur les vraies données après une action', async () => {
    // `PermissionOverwriteManager.upsert` fait l'appel REST et rend le salon tel
    // quel : ce qu'on vient d'écrire n'est PAS dans le cache. La fiche annonçait
    // donc « Non autorisé » juste après avoir autorisé quelqu'un - elle lisait
    // l'état d'avant son propre clic.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, syncFromGateway } = fakeChannel();
    const cible = fakeTarget(OTHER, false);

    // La relecture passe par `channel.guild.channels` - en production, le salon
    // porte son serveur. Le `fetch` joue ce que fait une relecture forcée : la
    // passerelle livre enfin ce que Discord a reçu.
    const guild = fakeGuild(new Map([[OTHER, cible]]));
    (channel as { guild: Record<string, unknown> }).guild = {
      id: GUILD,
      roles: { everyone: { id: GUILD } },
      channels: {
        fetch: mock(async () => {
          syncFromGateway();
          return null;
        }),
      },
    };
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction(`m_trust:${OTHER}`, {
      channel,
      guild,
      member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    // L'autorisation a bien été écrite chez Discord...
    const ecrites = channel.permissionOverwrites.edit as unknown as { mock: { calls: unknown[][] } };
    expect(ecrites.mock.calls.some((appel) => appel[0] === OTHER)).toBe(true);

    // ...et le cache que lit la fiche la connaît maintenant. C'est la relecture
    // qui l'y met : sans elle, la fiche redessinée montrerait l'état d'avant.
    expect(channel.permissionOverwrites.cache.has(OTHER)).toBe(true);

    // La fiche a bien été réécrite en place, pas seulement acquittée.
    expect(interaction.editReply).toHaveBeenCalled();

    tempChannels.delete(CHANNEL);
    guildConfig = null;
  }, 10_000);
});

describe('Mode compact des sous-panneaux', () => {
  /** Un clic sur un bouton qui vit dans un sous-panneau éphémère. */
  function clicDansSousPanneau(channel: unknown, guild: unknown) {
    const scene = fakeButtonInteraction('lock', { channel, guild, member: fakeTarget(OWNER, false) });
    (scene.interaction as { message: Record<string, unknown> }).message = {
      flags: { has: (drapeau: number) => drapeau === MessageFlags.Ephemeral },
      edit: mock(async () => undefined),
    };
    return scene;
  }

  async function jouer(compact: boolean) {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    // Les sept permissions restent ouvertes : seul le mode d'affichage varie.
    permissionsModerateur = {
      canRename: true,
      canChangeLimit: true,
      canLock: true,
      canChangeWriteMode: true,
      canKickOrBan: true,
      canReserve: true,
      canTransfer: true,
      panelCompactMode: compact,
    };

    const { channel } = fakeChannel();
    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const scene = clicDansSousPanneau(channel, guild);
    await listeners.get(Events.InteractionCreate)?.(scene.interaction);

    tempChannels.delete(CHANNEL);
    permissionsModerateur = null;
    guildConfig = null;
    return scene;
  }

  test('le mode compact reprend le sous-panneau au lieu d\'empiler un message', async () => {
    // `deferReply` crée un message de plus - trois éphémères pour une seule
    // réservation. `deferUpdate` reprend celui qui porte le bouton.
    const scene = await jouer(true);
    expect(scene.calls).toContain('deferUpdate');
    expect(scene.calls).not.toContain('defer');
  }, 10_000);

  test('sans le mode compact, rien ne change : un message de plus, comme avant', async () => {
    // Le défaut ne doit rien changer pour les serveurs qui n'ont rien demandé.
    const scene = await jouer(false);
    expect(scene.calls).toContain('defer');
    expect(scene.calls).not.toContain('deferUpdate');
  }, 10_000);

  test('en mode compact, la réponse porte un bouton de retour', async () => {
    // Le verdict remplace le menu qui l'a provoqué : sans chemin de retour, la
    // personne reste devant une phrase et plus aucun bouton.
    const scene = await jouer(true);
    const charges = (scene.interaction.editReply as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const composants = charges.flatMap((appel) => {
      const charge = appel[0] as { components?: unknown[] } | undefined;
      return charge?.components ?? [];
    });
    expect(composants.length).toBeGreaterThan(0);
  }, 10_000);

  test('sans le mode compact, la réponse ne pose aucun bouton de retour', async () => {
    // Le sous-panneau est toujours là derrière : un « Retour » y renverrait
    // depuis un message qui ne l'a jamais remplacé.
    const scene = await jouer(false);
    const charges = (scene.interaction.editReply as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const composants = charges.flatMap((appel) => {
      const charge = appel[0] as { components?: unknown[] } | undefined;
      return charge?.components ?? [];
    });
    expect(composants).toHaveLength(0);
  }, 10_000);
});

describe('Vitesse de réécriture du panneau', () => {
  function panneauDeSalon(id: string) {
    const message = {
      id: '778000000000000001',
      flags: { has: (drapeau: number) => drapeau === MessageFlags.IsComponentsV2 },
      edit: mock(async () => undefined),
      delete: mock(async () => undefined),
    };
    const { channel } = fakeChannel();
    channel.id = id;
    (channel as { guild: Record<string, unknown> }).guild = {
      id: GUILD,
      roles: { everyone: { id: GUILD } },
      channels: { fetch: mock(async () => null) },
    };
    (channel as { messages?: unknown }).messages = { fetch: mock(async () => message) };
    tempChannels.set(id, { creatorId: OWNER, panneauId: message.id });
    return { channel, message };
  }

  test('le panneau se réécrit sans attendre la fin de la fenêtre', async () => {
    // L'anti-rebond n'avait pas de front montant : un clic sur « Verrouiller »
    // laissait le panneau annoncer « Ouvert » pendant deux secondes pleines.
    const { channel, message } = panneauDeSalon('930000000000000001');
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);

    const { interaction } = fakeButtonInteraction('salon', {
      channel,
      guild: fakeGuild(new Map()),
      member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    // Bien en deçà de la fenêtre de coalescence : si la réécriture l'attendait,
    // rien ne serait encore parti.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(message.edit).toHaveBeenCalled();

    tempChannels.delete('930000000000000001');
  }, 10_000);

  test('la mention du propriétaire survit à la réécriture', async () => {
    // Une édition remplace tous les composants : sans repasser la mention, la
    // ligne « @propriétaire » disparaissait au premier changement d'état.
    const { channel, message } = panneauDeSalon('930000000000000002');
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);

    const { interaction } = fakeButtonInteraction('salon', {
      channel,
      guild: fakeGuild(new Map()),
      member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const appels = message.edit.mock.calls as unknown as unknown[][];
    const charge = appels[0]?.[0] as { content?: string } | undefined;
    expect(charge?.content).toBe(`<@${OWNER}>`);

    tempChannels.delete('930000000000000002');
  }, 10_000);

  test('une rafale de clics ne produit qu\'un seul rattrapage', async () => {
    // Le front montant ne doit pas se payer en écritures : Discord plafonne les
    // éditions à cinq par tranche de cinq secondes et par salon.
    const { channel, message } = panneauDeSalon('930000000000000003');
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    const guild = fakeGuild(new Map());

    for (let i = 0; i < 6; i += 1) {
      const { interaction } = fakeButtonInteraction('salon', {
        channel,
        guild,
        member: fakeTarget(OWNER, false),
      });
      await listeners.get(Events.InteractionCreate)?.(interaction);
    }

    // Une fois la fenêtre refermée : un passage immédiat, un seul rattrapage.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(message.edit).toHaveBeenCalledTimes(2);

    tempChannels.delete('930000000000000003');
  }, 10_000);
});

describe('Modes d\'écriture : ce que le libellé promet', () => {
  /**
   * Un salon où quelqu'un a été « Autorisé ».
   *
   * `categoryTrustPatch` accorde cinq bits d'un coup, `SendMessages` compris :
   * la personne peut donc écrire par une surcharge nominative, et non par
   * @everyone. C'est ce qui rend le défaut invisible tant qu'on ne regarde que
   * le patch pose sur @everyone.
   */
  async function basculerVers(mode: string) {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel, edits, seedOverwrite, syncFromGateway } = fakeChannel();
    seedOverwrite(OTHER, fakeOverwrite(
      PermissionFlagsBits.SendMessages | PermissionFlagsBits.Connect | PermissionFlagsBits.ViewChannel,
      0n,
    ));
    (channel as { guild: Record<string, unknown> }).guild = {
      id: GUILD,
      roles: { everyone: { id: GUILD } },
      channels: { fetch: mock(async () => { syncFromGateway(); return null; }) },
    };

    const guild = fakeGuild(new Map([[OTHER, fakeTarget(OTHER, false)]]));
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeSelectInteraction({
      customId: 'tempvoice:mode_select',
      values: [mode],
      channel,
      member: fakeTarget(OWNER, false),
      guild,
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    tempChannels.delete(CHANNEL);
    guildConfig = null;
    return edits;
  }

  /** Le dernier patch écrit pour cette cible, ou `undefined`. */
  function dernierPatch(edits: Array<{ id: string; patch: Record<string, unknown> }>, id: string) {
    return [...edits].reverse().find((e) => e.id === id)?.patch;
  }

  test('« Personne » fait taire aussi ceux qui ont été autorisés', async () => {
    // « Personne — y compris moi. Le salon devient un mur d'affichage. » Couper
    // @everyone ne suffit pas : une autorisation accorde `SendMessages`
    // nominativement, et une surcharge nominative prime sur @everyone.
    const edits = await basculerVers('nobody');
    // Exiger une ECRITURE : sans elle, le test passerait aussi bien quand le
    // mode ne touche a rien - c'est-a-dire precisement quand le defaut est la.
    const patch = dernierPatch(edits, OTHER);
    expect(patch).toBeDefined();
    expect(patch?.SendMessages).not.toBe(true);
  });

  test('« Moi seul » fait taire aussi ceux qui ont été autorisés', async () => {
    // « Moi seul — personne d'autre ne peut écrire. »
    const edits = await basculerVers('ownerOnly');
    // Exiger une ECRITURE : sans elle, le test passerait aussi bien quand le
    // mode ne touche a rien - c'est-a-dire precisement quand le defaut est la.
    const patch = dernierPatch(edits, OTHER);
    expect(patch).toBeDefined();
    expect(patch?.SendMessages).not.toBe(true);
  });

  test('« Ceux qui sont en vocal » fait taire un autorisé qui n\'est pas connecté', async () => {
    // Le mode suit la présence : une autorisation ne doit pas valoir laissez-
    // passer permanent pour le chat, sans quoi le libellé ment aussi.
    const edits = await basculerVers('inVoice');
    // Exiger une ECRITURE : sans elle, le test passerait aussi bien quand le
    // mode ne touche a rien - c'est-a-dire precisement quand le defaut est la.
    const patch = dernierPatch(edits, OTHER);
    expect(patch).toBeDefined();
    expect(patch?.SendMessages).not.toBe(true);
  });
});

describe('Sous-panneau « Membres » : deux portes', () => {
  /** Les options d'un menu, ou qu'elles se trouvent selon la version du builder. */
  function optionsDuMenu(menu: unknown): Array<{ value?: string }> {
    const brut = menu as { options?: unknown[]; data?: { options?: unknown[] } } | undefined;
    const liste = brut?.options ?? brut?.data?.options ?? [];
    return liste.map((option) => {
      const o = option as { value?: string; data?: { value?: string } };
      return { value: o.value ?? o.data?.value };
    });
  }

  function salonAvecPresents(nombre: number) {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    const membres = new Map<string, unknown>();
    for (let i = 0; i < nombre; i += 1) {
      // Jamais d'arithmetique sur un identifiant Discord : 7e17 depasse
      // `Number.MAX_SAFE_INTEGER`, et l'increment s'evapore - les trente
      // membres se seraient ecrases sur un seul, sans la moindre erreur.
      const id = `70000000000000${String(1000 + i)}`;
      membres.set(id, { ...fakeTarget(id, false), displayName: `Membre ${i}` });
    }
    // Un bot present ne doit pas occuper une place dans la liste : aucune action
    // du panneau n'a de sens sur lui.
    membres.set('799999999999999999', { ...fakeTarget('799999999999999999', true), displayName: 'Robot' });
    (channel as { members: Map<string, unknown> }).members = membres;
    return channel;
  }

  async function ouvrirMembres(channel: unknown) {
    const guild = fakeGuild(new Map());
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('membres', {
      channel,
      guild,
      member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    tempChannels.delete(CHANNEL);
    guildConfig = null;

    const appels = (interaction.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (appels[0]?.[0] ?? {}) as { components?: Array<{ components: Array<{ data: Record<string, unknown> }> }> };
  }

  test('les personnes présentes ont leur propre menu, en plus de la recherche', async () => {
    // Chercher dans tout le serveur quelqu'un qu'on a sous les yeux était le cas
    // le plus fréquent, et le plus laborieux.
    const charge = await ouvrirMembres(salonAvecPresents(3));
    const identifiants = (charge.components ?? [])
      .flatMap((rangee) => rangee.components.map((composant) => composant.data.custom_id as string));

    expect(identifiants).toContain('tempvoice:membre_ici');
    expect(identifiants).toContain('tempvoice:membre_select');
  });

  test('un salon vide ne pose pas de menu vide', async () => {
    // Discord rejette le message entier quand un menu n'a aucune option : la
    // rangée doit disparaître, pas se vider.
    const charge = await ouvrirMembres(salonAvecPresents(0));
    const identifiants = (charge.components ?? [])
      .flatMap((rangee) => rangee.components.map((composant) => composant.data.custom_id as string));

    expect(identifiants).not.toContain('tempvoice:membre_ici');
    expect(identifiants).toContain('tempvoice:membre_select');
  });

  test('le menu des présents ne dépasse jamais vingt-cinq options', async () => {
    // Le plafond de Discord. Au-delà, la liste est tronquée plutôt qu'omise.
    const charge = await ouvrirMembres(salonAvecPresents(30));
    const menu = (charge.components ?? [])
      .flatMap((rangee) => rangee.components)
      .find((composant) => composant.data.custom_id === 'tempvoice:membre_ici');

    // `StringSelectMenuBuilder` range ses options hors de `data` : les lire la
    // rendrait un tableau vide, et le test passerait pour rien.
    const options = optionsDuMenu(menu);
    expect(options).toHaveLength(25);
  });

  test('un bot présent n\'occupe pas une place dans la liste', async () => {
    // Aucune action du panneau n'a de sens sur un bot.
    const charge = await ouvrirMembres(salonAvecPresents(2));
    const menu = (charge.components ?? [])
      .flatMap((rangee) => rangee.components)
      .find((composant) => composant.data.custom_id === 'tempvoice:membre_ici');

    const options = optionsDuMenu(menu);
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.value)).not.toContain('799999999999999999');
  });
});

describe('Verite des presents : le cache de discord.js ment par omission', () => {
  test('un membre en vocal mais absent du cache est recupere avant affichage', async () => {
    // `channel.members` n'est pas la liste des connectes : c'est celle des etats
    // vocaux DONT le membre est deja en cache. Un absent du cache disparait du
    // decompte, de la liste et des autorisations - sans erreur, sans trace.
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();

    const ABSENT = '760000000000000001';
    const membresEnCache = new Map<string, unknown>();
    const recuperes: string[][] = [];

    (channel as { members: Map<string, unknown> }).members = membresEnCache;
    (channel as { guild: Record<string, unknown> }).guild = {
      id: GUILD,
      roles: { everyone: { id: GUILD } },
      channels: { fetch: mock(async () => null) },
      // L'etat vocal fait foi : il dit que quelqu'un est la.
      voiceStates: { cache: new Map([[ABSENT, { id: ABSENT, channelId: CHANNEL }]]) },
      members: {
        cache: membresEnCache,
        fetch: mock(async (options: { user: string[] }) => {
          recuperes.push(options.user);
          for (const id of options.user) {
            membresEnCache.set(id, { ...fakeTarget(id, false), displayName: 'Arrive tard' });
          }
          return membresEnCache;
        }),
      },
    };

    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const { interaction } = fakeButtonInteraction('membres', {
      channel,
      guild: fakeGuild(new Map()),
      member: fakeTarget(OWNER, false),
    });
    await listeners.get(Events.InteractionCreate)?.(interaction);

    // Le membre manquant a bien ete reclame a Discord...
    expect(recuperes.flat()).toContain(ABSENT);

    // ...et il figure dans le menu des presents.
    const appels = (interaction.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const charge = (appels[0]?.[0] ?? {}) as {
      components?: Array<{ components: Array<{ data: Record<string, unknown>; options?: unknown[] }> }>;
    };
    const menu = (charge.components ?? [])
      .flatMap((rangee) => rangee.components)
      .find((composant) => composant.data.custom_id === 'tempvoice:membre_ici');
    const valeurs = ((menu?.options ?? []) as Array<{ data?: { value?: string }; value?: string }>)
      .map((option) => option.value ?? option.data?.value);

    expect(valeurs).toContain(ABSENT);

    tempChannels.delete(CHANNEL);
    guildConfig = null;
  }, 10_000);
});

describe('Les trois portes : ouvrir a cote, ou reprendre le sous-panneau', () => {
  async function cliquerPorte(depuisEphemere: boolean) {
    guildConfig = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { channel } = fakeChannel();
    const { client, listeners } = fakeClient();
    registerTempVoiceListener(client);
    tempChannels.set(CHANNEL, { creatorId: OWNER });

    const scene = fakeButtonInteraction('salon', {
      channel,
      guild: fakeGuild(new Map()),
      member: fakeTarget(OWNER, false),
    });
    (scene.interaction as { update?: unknown }).update = mock(async () => undefined);
    if (depuisEphemere) {
      (scene.interaction as { message: Record<string, unknown> }).message = {
        flags: { has: (drapeau: number) => drapeau === MessageFlags.Ephemeral },
        edit: mock(async () => undefined),
      };
    }

    await listeners.get(Events.InteractionCreate)?.(scene.interaction);

    tempChannels.delete(CHANNEL);
    guildConfig = null;
    return scene.interaction as unknown as {
      reply: { mock: { calls: unknown[][] } };
      update: { mock: { calls: unknown[][] } };
    };
  }

  test('depuis le panneau public, un ephemere s ouvre a cote', async () => {
    // L'editer effacerait le panneau pour tout le serveur.
    const interaction = await cliquerPorte(false);
    expect(interaction.reply.mock.calls.length).toBeGreaterThan(0);
    expect(interaction.update.mock.calls).toHaveLength(0);
  }, 10_000);

  test('depuis un sous-panneau, le message existant est repris', async () => {
    // C'est le cas du bouton « Retour » du mode compact : sans cela, il empilait
    // un ephemere de plus a chaque retour - exactement ce que ce mode evite.
    const interaction = await cliquerPorte(true);
    expect(interaction.update.mock.calls.length).toBeGreaterThan(0);
    expect(interaction.reply.mock.calls).toHaveLength(0);
  }, 10_000);
});
