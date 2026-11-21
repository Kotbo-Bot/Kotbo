import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { EmbedBuilder } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const LINK = { id: 'link-1', mainGuildId: 'main-guild', staffGuildId: 'staff-guild' };
const MAPPING_ID = 'mapping-1';

const prismaMock = {
  staffServerLink: {
    findUnique: mock(async ({ where }: { where: { id: string } }) =>
      where.id === LINK.id ? { mainGuildId: LINK.mainGuildId, staffGuildId: LINK.staffGuildId } : null),
  },
  staffServerRoleMapping: {
    findUnique: mock(async ({ where }: { where: { id: string } }) =>
      where.id === MAPPING_ID ? { staffServerLinkId: LINK.id } : null),
  },
};

// Les effets réels de chaque sous-commande sur le lien.
const effets = {
  removeStaffServerLink: mock(async () => ({ id: LINK.id })),
  fullSyncStaffRoles: mock(async () => ({ synced: 0, errors: 0 })),
  addRoleMapping: mock(async () => ({ id: 'mapping-2' })),
  removeRoleMapping: mock(async () => undefined),
};

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
mockModule('../../utils/db', { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock });
mockModule('../../utils/cache', { getCachedGuild: async () => ({ language: 'fr' }) });
mockModule('../../services/staff/staffServerService', effets);

const { staffserverCommand } = await import('../../commands/admin/staffserver.js');

function commande(sub: string, guildId: string, strings: Record<string, string>) {
  const editReply = mock(async (_payload: { embeds: EmbedBuilder[] }) => undefined);
  const interaction = {
    guildId,
    guildLocale: 'fr',
    locale: 'fr',
    client: {},
    user: { id: 'admin-1' },
    options: {
      getSubcommand: () => sub,
      getString: (name: string) => strings[name] ?? null,
      getRole: (name: string) => (name === 'main-role' ? { id: 'role-main' } : null),
    },
    deferReply: mock(async () => undefined),
    editReply,
  };
  return { interaction: interaction as never, editReply };
}

function derniereDescription(editReply: ReturnType<typeof commande>['editReply']): string | undefined {
  return editReply.mock.calls.at(-1)?.[0].embeds[0]?.data.description;
}

beforeEach(() => {
  for (const effet of Object.values(effets)) effet.mockClear();
});

describe('/staffserver sur un lien d’autres serveurs', () => {
  test.each([
    ['remove', { 'link-id': LINK.id }, effets.removeStaffServerLink],
    ['sync', { 'link-id': LINK.id }, effets.fullSyncStaffRoles],
    ['mapping', { 'link-id': LINK.id }, effets.addRoleMapping],
    ['unmap', { 'mapping-id': MAPPING_ID }, effets.removeRoleMapping],
  ] as const)('%s : refusé hors des deux serveurs du lien, accepté depuis l’un d’eux', async (sub, strings, effet) => {
    const dehors = commande(sub, 'autre-serveur', strings);
    await staffserverCommand.execute(dehors.interaction);
    expect(effet).not.toHaveBeenCalled();
    expect(derniereDescription(dehors.editReply)).toBe('Lien introuvable.');

    const dedans = commande(sub, LINK.staffGuildId, strings);
    await staffserverCommand.execute(dedans.interaction);
    expect(effet).toHaveBeenCalledTimes(1);
  });
});
