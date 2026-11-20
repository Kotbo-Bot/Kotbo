import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import type { GuildMember } from 'discord.js';

let configRow: Record<string, unknown> | null = null;
const mockDb = {
  reputationConfig: { findUnique: mock(async () => configRow) },
  guild: { findUnique: mock(async () => null) },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { applyReputationGain, grantReachedTiers, revokeLostTiers, tierAnnouncementLabels } = await import('../../services/community/reputationTierService.js');

const TIERS = [
  { threshold: 10, roleId: 'r10' },
  { threshold: 50, roleId: 'r50' },
];

/** Membre factice : un rôle « editable » est un rôle que le bot peut donner. */
function fakeMember(held: string[], roles: Record<string, { editable: boolean; managed?: boolean }>) {
  const current = new Set(held);
  const add = mock(async (role: { id: string }) => { current.add(role.id); });
  const remove = mock(async (role: { id: string }) => { current.delete(role.id); });
  const guildRoles = new Map(Object.entries(roles).map(([id, flags]) => [id, { id, managed: false, ...flags }]));
  const member = {
    guild: { roles: { cache: guildRoles } },
    roles: { cache: { has: (id: string) => current.has(id) }, add, remove },
  } as unknown as GuildMember;
  return { member, add, remove, current };
}

describe('grantReachedTiers', () => {
  test('donne le rôle du palier atteint', async () => {
    const { member, add } = fakeMember([], { r10: { editable: true }, r50: { editable: true } });
    const granted = await grantReachedTiers(member, TIERS, 10, 'raison');
    expect(granted.map((tier) => tier.roleId)).toEqual(['r10']);
    expect(add).toHaveBeenCalledTimes(1);
  });

  test('saute un rôle que le bot ne peut pas donner, sans planter', async () => {
    const { member, add } = fakeMember([], { r10: { editable: false } });
    expect(await grantReachedTiers(member, TIERS, 10, 'raison')).toEqual([]);
    expect(add).not.toHaveBeenCalled();
  });

  test('rattrape un palier plus bas que le membre n\'a pas encore', async () => {
    const { member } = fakeMember(['r50'], { r10: { editable: true }, r50: { editable: true } });
    const granted = await grantReachedTiers(member, TIERS, 51, 'raison');
    expect(granted.map((tier) => tier.roleId)).toEqual(['r10']);
  });

  test('saute un rôle supprimé du serveur', async () => {
    const { member } = fakeMember([], {});
    expect(await grantReachedTiers(member, TIERS, 10, 'raison')).toEqual([]);
  });

  test('ne redonne pas un rôle déjà porté et ne l\'annonce pas', async () => {
    const { member, add } = fakeMember(['r10'], { r10: { editable: true } });
    expect(await grantReachedTiers(member, TIERS, 10, 'raison')).toEqual([]);
    expect(add).not.toHaveBeenCalled();
  });

  test('un échec Discord sur un rôle n\'empêche pas les suivants', async () => {
    const { member, add } = fakeMember([], { r10: { editable: true }, r50: { editable: true } });
    add.mockImplementationOnce(async () => { throw new Error('Missing Permissions'); });
    const granted = await grantReachedTiers(member, TIERS, 60, 'raison');
    expect(granted.map((tier) => tier.roleId)).toEqual(['r50']);
  });
});

describe('revokeLostTiers', () => {
  test('retire les rôles des paliers que le total n\'atteint plus', async () => {
    const { member, remove, current } = fakeMember(['r10', 'r50'], { r10: { editable: true }, r50: { editable: true } });
    await revokeLostTiers(member, TIERS, 49, 'raison');
    expect(remove).toHaveBeenCalledTimes(1);
    expect([...current]).toEqual(['r10']);
  });

  test('ne touche pas un rôle que le membre n\'a pas', async () => {
    const { member, remove } = fakeMember(['r10'], { r10: { editable: true }, r50: { editable: true } });
    await revokeLostTiers(member, TIERS, 20, 'raison');
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('tierAnnouncementLabels', () => {
  test('garde les trous à remplir par l\'aperçu', () => {
    const labels = tierAnnouncementLabels('fr');
    expect(labels.locale).toBe('fr');
    expect(labels.body).toContain('{user}');
    expect(labels.body).toContain('{role}');
    expect(labels.body).toContain('{threshold}');
    expect(labels.title.length).toBeGreaterThan(0);
  });
});

describe('applyReputationGain', () => {
  /** Client dont le serveur connaît le membre et un salon d'annonce. */
  function fakeClient(guildId: string) {
    const { member, add } = fakeMember([], { r10: { editable: true } });
    const send = mock(async (_payload: unknown) => ({}));
    const channel = { isTextBased: () => true, isSendable: () => true, send };
    const guild = {
      id: guildId,
      preferredLocale: 'fr',
      roles: (member.guild as unknown as { roles: unknown }).roles,
      channels: { cache: new Map([['annonces', channel]]) },
      members: { fetch: async () => member },
    };
    Object.assign(member, { id: 'u', guild });
    const client = { guilds: { cache: new Map([[guildId, guild]]) } } as never;
    return { client, add, send };
  }

  test('un palier franchi par un vote est donné et annoncé', async () => {
    configRow = { dailyLimit: 3, announceChannelId: 'annonces', tiers: [{ threshold: 10, roleId: 'r10' }] };
    const { client, add, send } = fakeClient('g-annonce');
    await applyReputationGain(client, 'g-annonce', 'u', 9, 10);
    expect(add).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('sans annonce, le palier est donné en silence', async () => {
    configRow = { dailyLimit: 3, announceChannelId: 'annonces', tiers: [{ threshold: 10, roleId: 'r10' }] };
    const { client, add, send } = fakeClient('g-silence');
    await applyReputationGain(client, 'g-silence', 'u', 9, 10, { announce: false });
    expect(add).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
