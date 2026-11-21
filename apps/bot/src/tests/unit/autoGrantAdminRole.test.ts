import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

const GUILD = 'guild-1';

let joinRoleId: string | null = null;
let rewardRoleId = '';

const mockDb = {
  welcomeConfig: { findUnique: mock(async () => ({ guildId: GUILD, joinRoleId })) },
  levelConfig: { findUnique: mock(async () => ({ guildId: GUILD, stackRewards: true })) },
  levelRoleReward: { findMany: mock(async () => [{ guildId: GUILD, level: 1, roleId: rewardRoleId }]) },
  workflowTemporaryRole: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { applyJoinAutoRole } = await import('../../services/features/welcomeGoodbyeService.js');
const { syncMemberAutoRoles } = await import('../../services/features/serverTagRoleService.js');
const { updateMemberLevelRoles } = await import('../../services/progression/levelingService.js');
const { createWorkflowEffects } = await import('../../services/features/workflow/effects.js');

/** Rôles placés sous le bot et non gérés : seul `role-admin` porte Administrateur. */
const ROLES = [
  { id: 'role-membre', name: 'Membre', permissions: new PermissionsBitField(0n) },
  { id: 'role-admin', name: 'Admin', permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) },
].map((role) => ({ ...role, position: 1, managed: false, editable: true }));

/** Membre qui arbore le tag du serveur, sans aucun rôle ; `added` relève chaque rôle reçu. */
function monde() {
  const added: string[] = [];
  const idOf = (role: unknown) => (typeof role === 'string' ? role : (role as { id: string }).id);
  const bot = { permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles), roles: { highest: { position: 10 } } };
  const guild = {
    id: GUILD,
    roles: { cache: new Map(ROLES.map((role) => [role.id, role])) },
    members: { me: bot, cache: new Map(), fetch: async () => member },
  };
  const member = {
    id: 'member-1',
    user: { id: 'member-1', tag: 'membre#0001', bot: false, primaryGuild: { identityEnabled: true, identityGuildId: GUILD, tag: 'KTBO' } },
    guild,
    roles: {
      cache: new Map<string, unknown>(),
      add: mock(async (roles: unknown) => {
        for (const role of [roles].flat()) added.push(idOf(role));
      }),
    },
  };
  const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
  return { guild, member, client, added };
}

/** Action de workflow sur le membre : un refus lève une erreur, seul compte ce qui a été ajouté. */
const workflowAction = (type: string, inputs = {}) => async (roleId: string) => {
  const { guild, added } = monde();
  const member = { kind: 'Member', id: 'member-1', tag: 'membre#0001' };
  await createWorkflowEffects(guild as never)
    .runAction(type as never, { member, role: { kind: 'Role', id: roleId, name: roleId }, ...inputs } as never, {})
    .catch(() => null);
  return added;
};

/** Chaque point d'octroi, réduit à « tenter de donner ce rôle » ; rend les rôles réellement ajoutés. */
const OCTROIS: Array<[string, (roleId: string) => Promise<string[]>]> = [
  ["l'auto-rôle d'arrivée", async (roleId) => {
    const { member, added } = monde();
    joinRoleId = roleId;
    await applyJoinAutoRole(member as never);
    return added;
  }],
  ['le rôle du tag de serveur', async (roleId) => {
    const { member, added } = monde();
    await syncMemberAutoRoles(member as never, {
      tagAutoRoleEnabled: true,
      tagAutoRoleId: roleId,
      statusScanEnabled: false,
      statusScanKeyword: '',
      statusScanRoleId: null,
      statusScanScope: 'STATUS',
    });
    return added;
  }],
  ['la récompense de niveau', async (roleId) => {
    const { client, added } = monde();
    rewardRoleId = roleId;
    await updateMemberLevelRoles(GUILD, 'member-1', 5, client as never);
    return added;
  }],
  ["l'action « Ajouter un rôle » d'un workflow", workflowAction('AddRole')],
  ["l'action « Donner un rôle temporaire » d'un workflow", workflowAction('AddTemporaryRole', { minutes: 60 })],
];

describe('aucun octroi automatique ne distribue un rôle Administrateur', () => {
  test.each(OCTROIS)('%s donne un rôle ordinaire, jamais un rôle Administrateur', async (_octroi, octroyer) => {
    expect(await octroyer('role-membre')).toEqual(['role-membre']);
    expect(await octroyer('role-admin')).toEqual([]);
  });
});
