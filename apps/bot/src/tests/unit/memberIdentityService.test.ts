import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { Collection } from 'discord.js';
import path from 'node:path';

type UpdateManyArgs = {
  where?: { guildId?: string; userId?: string; username?: null };
  data?: { username?: string; displayName?: string; avatarUrl?: string };
};

const mockDb = {
  memberProfile: {
    updateMany: mock(async (_args: UpdateManyArgs) => ({ count: 1 })),
  },
};

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
};

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

for (const suffix of ['../../utils/logger.ts', '../../utils/logger.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    logger: silentLogger,
  }));
}

const { resolveMemberAvatarUrl, resolveMissingMemberIdentities } = await import('../../services/moderation/memberIdentityService');

/**
 * Membre calqué sur discord.js : `avatarURL()` rend `null` quand aucune photo
 * n'est posée, là où `displayAvatarURL()` renvoie l'avatar générique partagé.
 */
function cachedMember(id: string, username: string, options: { avatar?: string | null; guildAvatar?: string | null } = {}) {
  const { avatar = `https://cdn.example/${id}.png`, guildAvatar = null } = options;
  return {
    id,
    displayName: `Surnom ${username}`,
    avatarURL: () => guildAvatar,
    user: {
      id,
      username,
      globalName: null,
      avatarURL: () => avatar,
      displayAvatarURL: () => avatar ?? 'https://cdn.discordapp.com/embed/avatars/0.png',
    },
  };
}

function createClient(cached: Array<ReturnType<typeof cachedMember>>) {
  const memberCache = new Collection<string, ReturnType<typeof cachedMember>>();
  for (const member of cached) memberCache.set(member.id, member);

  const guildMembersFetch = mock(async () => memberCache);
  const usersFetch = mock(async (userId: string) => ({
    id: userId,
    username: `parti-${userId}`,
    globalName: null,
    avatarURL: () => `https://cdn.example/${userId}.png`,
    displayAvatarURL: () => `https://cdn.example/${userId}.png`,
  }));

  const guild = {
    id: 'guild-1',
    members: { cache: memberCache, fetch: guildMembersFetch },
  };

  const client = {
    guilds: { cache: new Collection([[guild.id, guild]]) },
    users: { fetch: usersFetch },
  };

  return { client, guildMembersFetch, usersFetch };
}

describe('resolveMissingMemberIdentities', () => {
  beforeEach(() => {
    mockDb.memberProfile.updateMany.mockClear();
  });

  test("ne contacte pas Discord quand aucune identité ne manque", async () => {
    const { client, guildMembersFetch, usersFetch } = createClient([]);

    const identities = await resolveMissingMemberIdentities(client as never, 'guild-1', []);

    expect(identities.size).toBe(0);
    expect(guildMembersFetch).not.toHaveBeenCalled();
    expect(usersFetch).not.toHaveBeenCalled();
    expect(mockDb.memberProfile.updateMany).not.toHaveBeenCalled();
  });

  test('nomme un membre présent depuis le cache du serveur', async () => {
    const { client, usersFetch } = createClient([cachedMember('user-1', 'kotbo')]);

    const identities = await resolveMissingMemberIdentities(client as never, 'guild-1', ['user-1']);

    expect(identities.get('user-1')).toEqual({
      username: 'kotbo',
      displayName: 'Surnom kotbo',
      avatarUrl: 'https://cdn.example/user-1.png',
      serverTag: null,
      boostingSince: null,
    });
    expect(usersFetch).not.toHaveBeenCalled();
  });

  test('joint le tag de serveur affiché par le membre', async () => {
    const member = cachedMember('user-2', 'nerd');
    (member.user as Record<string, unknown>).primaryGuild = {
      identityEnabled: true,
      identityGuildId: 'guild-9',
      tag: 'NERD',
      badge: 'abc',
    };
    const { client } = createClient([member]);

    const identities = await resolveMissingMemberIdentities(client as never, 'guild-1', ['user-2']);

    expect(identities.get('user-2')?.serverTag).toEqual({
      guildId: 'guild-9',
      tag: 'NERD',
      badgeUrl: 'https://cdn.discordapp.com/clan-badges/guild-9/abc.png',
    });
  });

  test("nomme un membre parti via l'API utilisateur", async () => {
    const { client, usersFetch } = createClient([]);

    const identities = await resolveMissingMemberIdentities(client as never, 'guild-1', ['user-9']);

    expect(usersFetch).toHaveBeenCalledWith('user-9');
    expect(identities.get('user-9')?.username).toBe('parti-user-9');
  });

  test("n'écrase que les profils dépourvus de pseudo", async () => {
    const { client } = createClient([cachedMember('user-1', 'kotbo')]);

    await resolveMissingMemberIdentities(client as never, 'guild-1', ['user-1']);
    // La persistance est lancée en arrière-plan.
    await Promise.resolve();
    await Promise.resolve();

    const call = mockDb.memberProfile.updateMany.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ guildId: 'guild-1', userId: 'user-1', username: null });
    expect(call?.data?.username).toBe('kotbo');
  });

  test("laisse l'avatar vide quand le membre n'a aucune photo", async () => {
    const { client } = createClient([cachedMember('user-2', 'sansphoto', { avatar: null })]);

    const identities = await resolveMissingMemberIdentities(client as never, 'guild-1', ['user-2']);

    // Stocker l'avatar Discord générique donnerait la même vignette à tous les
    // profils sans photo, ce qui rendait les classements illisibles (issue #211).
    expect(identities.get('user-2')?.avatarUrl).toBeNull();
  });
});

describe('resolveMemberAvatarUrl', () => {
  test("préfère l'avatar posé sur le serveur à l'avatar global", () => {
    const member = cachedMember('user-3', 'kotbo', { guildAvatar: 'https://cdn.example/guild-user-3.png' });

    expect(resolveMemberAvatarUrl(member as never, 256)).toBe('https://cdn.example/guild-user-3.png');
  });

  test("retombe sur l'avatar global quand le serveur n'en a pas", () => {
    const member = cachedMember('user-4', 'kotbo');

    expect(resolveMemberAvatarUrl(member as never, 256)).toBe('https://cdn.example/user-4.png');
  });

  test('rend null plutôt que l\'avatar Discord par défaut', () => {
    const member = cachedMember('user-5', 'kotbo', { avatar: null });

    expect(resolveMemberAvatarUrl(member as never, 256)).toBeNull();
  });

  test('tolère un membre absent', () => {
    expect(resolveMemberAvatarUrl(null, 256)).toBeNull();
  });
});
