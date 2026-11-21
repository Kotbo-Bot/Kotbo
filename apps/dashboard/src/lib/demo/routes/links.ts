/**
 * Liens de salons (ponts entre serveurs) et serveur du staff. Le serveur de
 * démo est relié à deux serveurs amis et à son serveur staff.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, ME, ROLES, ago, channelByName, personByName, role } from '../fixtures';
import { DEMO_GUILD_ID, DEMO_GUILD_NAME } from '../mode';

const KODA = { id: '930000000000000012', name: 'Koda' };
const PIXEL = { id: '930000000000000013', name: 'Pixel Forge' };
const STAFF = { id: '930000000000000020', name: 'Atelier Nova · Staff' };

const member = (id: string, groupId: string, guildId: string, guildName: string, channelId: string, channelName: string, extra: Record<string, unknown> = {}) => ({
  ...row('ChannelLinkGroupMember', { id, groupId, guildId, channelId, addedByUserId: ME.id, createdAt: ago(20 * DAY) }),
  guildId,
  guildName,
  guildIcon: null,
  channelName,
  isLocal: guildId === DEMO_GUILD_ID,
  isLinkOnly: false,
  missingBotPermissions: [],
  missingEveryonePermissions: [],
  channelMissing: false,
  ...extra,
});

function stats(seed: number) {
  const daily = Array.from({ length: 30 }, (_, i) => 20 + ((i * seed * 7) % 45));
  const sent = daily.reduce((a, b) => a + b, 0);
  return { sent, received: Math.round(sent * 1.4), failed: seed === 1 ? 2 : 0, daily, channels: {} };
}

function groupsSeed() {
  const group = (id: string, name: string, members: ReturnType<typeof member>[], seed: number, extra: Record<string, unknown> = {}) => ({
    ...row('ChannelLinkGroup', { id, name, ownerGuildId: DEMO_GUILD_ID, createdByUserId: ME.id, createdAt: ago(25 * DAY), ...extra }),
    members,
    localMembers: members.filter((m) => m.isLocal),
    remoteGuildCount: new Set(members.filter((m) => !m.isLocal).map((m) => m.guildId)).size,
    storesMessageMap: true,
    stats: stats(seed),
  });
  const lfg = channelByName('recherche-de-groupe');
  return [
    group('link-1', 'Recherche de groupe inter-serveurs', [
      member('lm-1', 'link-1', DEMO_GUILD_ID, DEMO_GUILD_NAME, lfg.id, lfg.name),
      member('lm-2', 'link-1', KODA.id, KODA.name, '930000000000000112', 'lfg'),
      member('lm-3', 'link-1', PIXEL.id, PIXEL.name, '930000000000000113', 'cherche-équipe', { missingEveryonePermissions: ['UseExternalEmojis'] }),
    ], 1),
    group('link-2', 'Annonces partagées avec Koda', [
      member('lm-4', 'link-2', DEMO_GUILD_ID, DEMO_GUILD_NAME, channelByName('annonces').id, 'annonces', { mode: 'SEND' }),
      member('lm-5', 'link-2', KODA.id, KODA.name, '930000000000000114', 'partenaires', { mode: 'RECEIVE' }),
    ], 2, { relayEmbeds: true }),
  ];
}

const groups = () => demoDb.get('channel-links', groupsSeed);
const saveGroups = (list: ReturnType<typeof groupsSeed>) => demoDb.set('channel-links', list);

function staffLinkSeed() {
  const mapping = (id: string, mainRole: (typeof ROLES)[number], staffName: string) => ({
    ...row('StaffServerRoleMapping', { id, staffServerLinkId: 'staff-link-1', mainDiscordRoleId: mainRole.id, staffDiscordRoleId: `9300000000000002${id.slice(-2)}`, createdAt: ago(30 * DAY) }),
    staffRole: null,
    mainRoleName: mainRole.name,
    mainRoleColor: mainRole.color,
    staffRoleName: staffName,
    staffRoleColor: mainRole.color,
  });
  return [
    {
      ...row('StaffServerLink', {
        id: 'staff-link-1',
        mainGuildId: DEMO_GUILD_ID,
        staffGuildId: STAFF.id,
        syncMode: 'MAIN_TO_STAFF',
        hierarchyId: 'hier-moderation',
        mainLogChannelId: channelByName('logs').id,
        staffLogChannelId: '930000000000000201',
        modlogMirrorChannelId: '930000000000000202',
        sanctionReportChannelId: '930000000000000203',
        onboardingInviteEnabled: true,
        onboardingInviteChannelId: '930000000000000204',
        offboardingAlertChannelId: '930000000000000201',
        createdByUserId: ME.id,
        createdAt: ago(30 * DAY),
      }),
      hierarchy: { id: 'hier-moderation', name: 'Modération' },
      isMain: true,
      otherGuildId: STAFF.id,
      otherGuildName: STAFF.name,
      otherGuildIcon: null,
      mainGuildName: DEMO_GUILD_NAME,
      staffGuildName: STAFF.name,
      roleMappings: [mapping('map-01', role('Admin'), 'Admin'), mapping('map-02', role('Modérateur'), 'Modérateur'), mapping('map-03', role('Helper'), 'Helper')],
    },
  ];
}

const staffChannels = () => ({
  staffGuildId: STAFF.id,
  staffGuildName: STAFF.name,
  channels: [
    { id: '930000000000000201', name: 'logs-staff' },
    { id: '930000000000000202', name: 'modlog' },
    { id: '930000000000000203', name: 'rapports-sanctions' },
    { id: '930000000000000204', name: 'accueil-staff' },
    { id: '930000000000000205', name: 'recrutement' },
  ],
  voiceChannels: [{ id: '930000000000000206', name: 'Réunion' }],
  categories: [{ id: '930000000000000207', name: 'STAFF' }, { id: '930000000000000208', name: 'RECRUTEMENT' }],
});

// ── Invitations ──────────────────────────────────────────────────────────

const INVITES: Array<[code: string, inviter: string, label: string | null, uses: number, left: number, daysAgo: number]> = [
  ['atelier-nova', 'Arka', 'Lien officiel', 412, 61, 300],
  ['topgg', 'Arka', 'Top.gg', 188, 34, 120],
  ['disboard', 'Lena', 'Disboard', 96, 22, 90],
  ['tiktok-oct', 'Lina', 'TikTok d’octobre', 54, 9, 40],
  ['k8Rq2Lp', 'Noé', null, 23, 3, 25],
  ['tournoi', 'Zenox', 'Tournoi d’automne', 31, 2, 6],
];

function invitationsSeed() {
  const people = (name: string) => personByName(name);
  const invitations = INVITES.map(([code, inviter, sourceLabel, uses, , daysAgo], i) =>
    row('GuildInvite', { id: `gi-${i}`, guildId: DEMO_GUILD_ID, code, inviterId: people(inviter).id, inviterTag: people(inviter).username, sourceLabel, uses, maxUses: code === 'tournoi' ? 50 : null, createdAt: ago(daysAgo * DAY) }),
  );
  const inviteUsage = INVITES.map(([code, , , uses, left, daysAgo]) => ({ inviteCode: code, _count: { _all: uses, leftAt: left }, _max: { joinedAt: ago(Math.min(daysAgo, 2) * DAY) } }));
  const byInviter = new Map<string, { uses: number; left: number }>();
  for (const [, inviter, , uses, left] of INVITES) {
    const current = byInviter.get(inviter) ?? { uses: 0, left: 0 };
    byInviter.set(inviter, { uses: current.uses + uses, left: current.left + left });
  }
  const inviterUsage = [...byInviter].map(([name, { uses, left }]) => ({ inviterId: people(name).id, inviterTag: people(name).username, _count: { _all: uses, leftAt: left }, _max: { joinedAt: ago(DAY) }, avatarUrl: null }));
  const totalJoined = INVITES.reduce((s, i) => s + i[3], 0);
  const totalLeft = INVITES.reduce((s, i) => s + i[4], 0);
  return { invitations, suspendedInviters: [] as unknown[], inviteUsage, inviterUsage, summary: { totalJoined, totalLeft } };
}

export function registerLinksRoutes(): void {
  const invitations = () => demoDb.get('invitations', invitationsSeed);
  route('GET', `${G}/invitations`, () => invitations());
  route('PUT', `${G}/invitations/:code/suspend`, ({ params, body }) => {
    demoDb.update('invitations', invitationsSeed, (s) => ({ ...s, invitations: s.invitations.map((i) => (i.code === params.code ? { ...i, isSuspended: body?.suspended ?? !i.isSuspended } : i)) }));
    return { success: true };
  });
  route('PUT', `${G}/invitations/:code/source`, ({ params, body }) => {
    demoDb.update('invitations', invitationsSeed, (s) => ({ ...s, invitations: s.invitations.map((i) => (i.code === params.code ? { ...i, sourceLabel: body?.sourceLabel ?? body?.source ?? null } : i)) }));
    return { success: true };
  });
  route('DELETE', `${G}/invitations/:code`, ({ params }) => {
    demoDb.update('invitations', invitationsSeed, (s) => ({ ...s, invitations: s.invitations.map((i) => (i.code === params.code ? { ...i, isDeleted: true } : i)) }));
    return { success: true };
  });

  const base = `${G}/channel-links`;
  route('GET', base, () => groups());
  route('GET', `${base}/other-guilds`, () => [
    { id: KODA.id, name: KODA.name, icon: null, channels: [{ id: '930000000000000112', name: 'lfg' }, { id: '930000000000000114', name: 'partenaires' }] },
    { id: PIXEL.id, name: PIXEL.name, icon: null, channels: [{ id: '930000000000000113', name: 'cherche-équipe' }, { id: '930000000000000115', name: 'général' }] },
  ]);
  route('GET', `${base}/invites`, () => demoDb.get('channel-links/invites', () => [
    row('ChannelLinkInvite', { id: 'cli-1', code: 'NOVA-7Q2K', guildId: DEMO_GUILD_ID, channelId: channelByName('général').id, expiresAt: ago(-2 * DAY), createdByUserId: ME.id, createdAt: ago(DAY) }),
  ]));
  route('POST', `${base}/invites`, ({ body }) => {
    const invite = row('ChannelLinkInvite', { ...(body ?? {}), id: demoId(), code: `NOVA-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, guildId: DEMO_GUILD_ID, expiresAt: ago(-7 * DAY), createdByUserId: ME.id });
    demoDb.update('channel-links/invites', () => [] as unknown[], (list) => [invite, ...list]);
    return { ...invite, serverInviteUrl: 'https://discord.gg/atelier-nova' };
  });
  route('POST', `${base}/direct`, ({ body }) => {
    const id = demoId();
    const local = channelByName('général');
    const created = { ...groupsSeed()[0], id, name: body?.name ?? 'Nouveau lien', members: [member(demoId(), id, DEMO_GUILD_ID, DEMO_GUILD_NAME, body?.channelId ?? local.id, local.name)], stats: stats(3) };
    saveGroups([created, ...groups()]);
    return { ...created, serverInviteUrl: null };
  });
  route('PATCH', `${base}/:groupId`, ({ params, body }) => {
    let updated: unknown;
    saveGroups(groups().map((g) => (g.id === params.groupId ? (updated = { ...g, ...(body ?? {}) }) as typeof g : g)));
    return updated;
  });
  route('DELETE', `${base}/:groupId`, ({ params }) => {
    saveGroups(groups().filter((g) => g.id !== params.groupId));
    return { ok: true };
  });
  route('POST', `${base}/:groupId/members`, ({ params }) => groups().find((g) => g.id === params.groupId));
  route('PATCH', `${base}/:groupId/members/:memberId`, ({ params, body }) => {
    let updated: unknown;
    saveGroups(groups().map((g) => (g.id === params.groupId ? (updated = { ...g, members: g.members.map((m) => (m.id === params.memberId ? { ...m, ...(body ?? {}) } : m)) }) as typeof g : g)));
    return updated;
  });
  route('DELETE', `${base}/:groupId/members/:memberId`, ({ params }) => {
    let remaining: (ReturnType<typeof groupsSeed>[number]) | null = null;
    saveGroups(groups().map((g) => (g.id === params.groupId ? (remaining = { ...g, members: g.members.filter((m) => m.id !== params.memberId) }) : g)));
    return { ok: true, group: remaining };
  });
  route('POST', `${base}/:groupId/invite`, () => ({ inviteUrl: 'https://discord.gg/atelier-nova', topicUpdated: true }));

  const links = () => demoDb.get('staff-server', staffLinkSeed);
  route('GET', `${G}/staff-server`, () => links());
  route('GET', `${G}/staff-server/channels`, () => staffChannels());
  route('POST', `${G}/staff-server`, () => links()[0]);
  route('PATCH', `${G}/staff-server/:linkId`, ({ params, body }) => {
    let updated: unknown;
    demoDb.set('staff-server', links().map((l) => (l.id === params.linkId ? (updated = { ...l, ...(body ?? {}) }) as typeof l : l)));
    return updated;
  });
  route('DELETE', `${G}/staff-server/:linkId`, ({ params }) => {
    demoDb.set('staff-server', links().filter((l) => l.id !== params.linkId));
    return { ok: true };
  });
  route('POST', `${G}/staff-server/:linkId/mappings`, ({ params, body }) => {
    const mapping = { ...row('StaffServerRoleMapping', { ...(body ?? {}), id: demoId(), staffServerLinkId: params.linkId }), staffRole: null, mainRoleName: ROLES.find((r) => r.id === body?.mainDiscordRoleId)?.name ?? 'Rôle', mainRoleColor: null, staffRoleName: 'Rôle staff', staffRoleColor: null };
    demoDb.set('staff-server', links().map((l) => (l.id === params.linkId ? { ...l, roleMappings: [...l.roleMappings, mapping] } : l)));
    return mapping;
  });
  route('DELETE', `${G}/staff-server/:linkId/mappings/:mappingId`, ({ params }) => {
    demoDb.set('staff-server', links().map((l) => (l.id === params.linkId ? { ...l, roleMappings: l.roleMappings.filter((m) => m.id !== params.mappingId) } : l)));
    return { ok: true };
  });
  route('POST', `${G}/staff-server/:linkId/sync`, () => ({ added: 2, removed: 0, unchanged: 5, errors: [] }));
}
