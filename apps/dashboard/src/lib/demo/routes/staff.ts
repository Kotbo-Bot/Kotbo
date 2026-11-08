/**
 * Gestion du staff : rôles, hiérarchies, organigramme, avertissements,
 * sondages et suivi d'activité.
 *
 * Formes reprises de `routes/dashboard/leadership/staff.ts` côté bot et des
 * types `StaffRole`, `StaffHierarchy` du dashboard.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { memberDay } from '../activity';
import { ME, ROLES, ago, DAY, personById, personByName, role } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';
import { HIERARCHY_OF_GRADE, staffMembers } from './home';

const ROLES_KEY = 'staff/roles';
const CONFIG_KEY = 'staff/config';
const HIERARCHIES_KEY = 'staff/hierarchies';
const WARNINGS_KEY = 'staff/warnings';
const POLLS_KEY = 'staff/polls';

type StaffRoleRow = {
  id: string;
  guildId: string;
  name: string;
  level: number;
  discordRoleId: string | null;
  color: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  hierarchyId: string | null;
  isResponsable: boolean;
};

const staffRole = (n: number, name: string, level: number, hierarchyId: string, isResponsable = false): StaffRoleRow => ({
  id: `staff-role-${n}`,
  guildId: DEMO_GUILD_ID,
  name,
  level,
  discordRoleId: role(name).id,
  color: role(name).color,
  sortOrder: n,
  enabled: true,
  createdAt: ago(400 * DAY),
  updatedAt: ago(20 * DAY),
  hierarchyId,
  isResponsable,
});

function rolesSeed(): StaffRoleRow[] {
  return [
    staffRole(1, 'Fondateur', 100, 'hier-direction', true),
    staffRole(2, 'Admin', 80, 'hier-direction'),
    staffRole(3, 'Modérateur', 50, 'hier-moderation', true),
    staffRole(4, 'Helper', 20, 'hier-support'),
  ];
}

function configSeed() {
  return {
    baseStaffRoleId: role('Helper').id,
    testStaffRoleId: null,
    formerStaffRoleId: null,
    chiefStaffRoleId: role('Admin').id,
    chiefStaffUserId: personByName('Arka').id,
    meetingAnnouncementChannelId: '900000000000000318',
    meetingVoiceChannelId: '900000000000000331',
    staffAnnouncementChannelId: '900000000000000318',
    warnsToDemote: 3,
    warnsToBlacklist: 5,
    blacklistPermanentByDefault: false,
    actionMode: 'validation',
    demoteRemoveAllRoles: true,
  };
}

type HierarchyRow = {
  id: string;
  guildId: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  parentHierarchyId: string | null;
  responsableUserId: string | null;
  discordRoleId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

function hierarchiesSeed(): HierarchyRow[] {
  const h = (id: string, name: string, description: string, color: string, icon: string, sortOrder: number, parent: string | null, responsable: string): HierarchyRow => ({
    id, guildId: DEMO_GUILD_ID, name, description, color, icon, sortOrder, parentHierarchyId: parent,
    responsableUserId: personByName(responsable).id, discordRoleId: null, enabled: true, createdAt: ago(300 * DAY), updatedAt: ago(10 * DAY),
  });
  return [
    h('hier-direction', 'Direction', 'Décisions, partenariats, budget du serveur', '#f0b232', 'Crown', 0, null, 'Arka'),
    h('hier-moderation', 'Modération', 'Sanctions, signalements, anti-raid', '#5865f2', 'Shield', 1, 'hier-direction', 'Zenox'),
    h('hier-support', 'Support', 'Tickets, accueil des nouveaux, FAQ', '#23a55a', 'Lifebuoy', 2, 'hier-moderation', 'Aiden'),
  ];
}

function warningsSeed() {
  const kylian = personByName('Kylian');
  const aiden = personByName('Aiden');
  return [
    { id: 'swarn-1', staffUserId: kylian.id, staffDisplayName: kylian.displayName, staffAvatarUrl: null, reason: 'Ticket fermé sans réponse au membre', issuedByTag: 'zenox', isActive: true, createdAt: ago(4 * DAY) },
    { id: 'swarn-2', staffUserId: aiden.id, staffDisplayName: aiden.displayName, staffAvatarUrl: null, reason: 'Sanction appliquée sans rapport', issuedByTag: 'lena', isActive: false, createdAt: ago(45 * DAY) },
  ];
}

function pollsSeed() {
  const author = (name: string) => ({ username: personByName(name).username, displayName: personByName(name).displayName });
  const vote = (name: string, optionId: string, weight = 1) => ({ id: `${optionId}-${name}`, userId: personByName(name).id, optionId, weight });
  return [
    {
      id: 'poll-1',
      title: 'Recruter deux helpers ce mois-ci ?',
      description: 'Les tickets s’accumulent le soir. On ouvre les candidatures maintenant ou après le tournoi ?',
      status: 'OPEN',
      closesAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      createdAt: ago(1 * DAY),
      author: author('Lena'),
      options: [
        { id: 'p1-o1', text: 'Oui, dès cette semaine' },
        { id: 'p1-o2', text: 'Après le tournoi' },
        { id: 'p1-o3', text: 'Non, on attend' },
      ],
      votes: [vote('Arka', 'p1-o1', 2), vote('Lena', 'p1-o1', 2), vote('Zenox', 'p1-o2'), vote('Aiden', 'p1-o1')],
    },
    {
      id: 'poll-2',
      title: 'Heure de la réunion staff',
      description: null,
      status: 'CLOSED',
      closesAt: ago(6 * DAY),
      createdAt: ago(9 * DAY),
      author: author('Arka'),
      options: [
        { id: 'p2-o1', text: 'Dimanche 20h' },
        { id: 'p2-o2', text: 'Samedi 18h' },
      ],
      votes: [vote('Arka', 'p2-o1', 2), vote('Lena', 'p2-o1', 2), vote('Zenox', 'p2-o1'), vote('Aiden', 'p2-o2'), vote('Kylian', 'p2-o1')],
    },
  ];
}

function hierarchiesWithRoles() {
  const roles = demoDb.get(ROLES_KEY, rolesSeed);
  const members = staffMembers();
  return demoDb.get(HIERARCHIES_KEY, hierarchiesSeed).map((h) => ({
    ...h,
    roles: roles.filter((r) => r.hierarchyId === h.id),
    memberGrades: members.flatMap((m) => m.hierarchyGrades.filter((g) => g.hierarchyId === h.id)),
  }));
}

function schema() {
  const config = demoDb.get(CONFIG_KEY, configSeed);
  const chief = personById(config.chiefStaffUserId ?? '') ?? personByName('Arka');
  const members = staffMembers().filter((m) => m.blacklistEntries.length === 0);
  return {
    chiefStaff: { userId: chief.id, roleId: config.chiefStaffRoleId, name: chief.displayName },
    hierarchies: hierarchiesWithRoles().map((h) => {
      const inside = members.filter((m) => HIERARCHY_OF_GRADE[m.grade] === h.id);
      const responsable = h.responsableUserId ? personById(h.responsableUserId) : null;
      return {
        id: h.id,
        name: h.name,
        description: h.description,
        color: h.color,
        icon: h.icon,
        sortOrder: h.sortOrder,
        parentHierarchyId: h.parentHierarchyId,
        responsable: responsable ? { userId: responsable.id, name: responsable.displayName } : null,
        roles: h.roles.map((r) => ({ id: r.id, name: r.name, level: r.level, isResponsable: r.isResponsable, color: r.color })),
        memberCount: inside.length,
        members: inside.map((m) => ({ userId: m.userId, username: m.username, displayName: m.displayName, avatarUrl: null, grade: m.grade })),
      };
    }),
  };
}

function leadership() {
  return staffMembers()
    .filter((m) => m.blacklistEntries.length === 0)
    .map((m) => {
      const person = personById(m.userId);
      let week = 0;
      let month = 0;
      for (let d = 0; d < 30; d++) {
        const day = person ? memberDay(person, d).messages : 0;
        month += day;
        if (d < 7) week += day;
      }
      const avg30d = Math.round(month / 30);
      // Kylian a levé le pied cette semaine : c'est lui que l'alerte d'inactivité signale.
      const avg7d = m.username === 'kylian' ? Math.round(avg30d * 0.3) : Math.round(week / 7);
      return {
        staffUserId: m.userId,
        avg: avg30d,
        avg30d,
        avg7d,
        progressionScore: Math.min(100, 40 + Math.round(Math.sqrt(month) * 1.6)),
        hasInactivityAlert: avg7d < avg30d * 0.5,
      };
    });
}

export function registerStaffRoutes(): void {
  const base = '/api/dashboard/guilds/:id/staff';

  route('GET', `${base}/roles`, () => ({ roles: demoDb.get(ROLES_KEY, rolesSeed) }));
  route('POST', `${base}/roles`, ({ body }) => {
    const discord = ROLES.find((r) => r.id === body?.discordRoleId);
    const created: StaffRoleRow = {
      id: `staff-role-${demoId()}`,
      guildId: DEMO_GUILD_ID,
      name: body?.name || discord?.name || 'Nouveau grade',
      level: Number(body?.level) || 10,
      discordRoleId: body?.discordRoleId ?? null,
      color: body?.color ?? discord?.color ?? null,
      sortOrder: 99,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hierarchyId: body?.hierarchyId ?? null,
      isResponsable: !!body?.isResponsable,
    };
    demoDb.update(ROLES_KEY, rolesSeed, (list) => [...list, created]);
    return { success: true, role: created };
  });
  route('PATCH', `${base}/roles/order`, ({ body }) => {
    const order: string[] = body?.order ?? body?.roleIds ?? [];
    demoDb.update(ROLES_KEY, rolesSeed, (list) => list.map((r) => ({ ...r, sortOrder: order.indexOf(r.id) >= 0 ? order.indexOf(r.id) : r.sortOrder })));
    return { success: true };
  });
  route('PATCH', `${base}/roles/:roleId`, ({ params, body }) => {
    const roles = demoDb.update(ROLES_KEY, rolesSeed, (list) => list.map((r) => (r.id === params.roleId ? { ...r, ...body, updatedAt: new Date().toISOString() } : r)));
    return { success: true, role: roles.find((r) => r.id === params.roleId) };
  });
  route('DELETE', `${base}/roles/:roleId`, ({ params }) => {
    demoDb.update(ROLES_KEY, rolesSeed, (list) => list.filter((r) => r.id !== params.roleId));
    return { success: true };
  });

  route('GET', `${base}/config`, () => ({ config: demoDb.get(CONFIG_KEY, configSeed) }));
  route('PATCH', `${base}/config`, ({ body }) => ({ success: true, config: demoDb.update(CONFIG_KEY, configSeed, (c) => ({ ...c, ...(body ?? {}) })) }));

  route('GET', `${base}/hierarchies`, () => ({ hierarchies: hierarchiesWithRoles() }));
  route('GET', `${base}/hierarchies/schema`, () => schema());
  route('POST', `${base}/hierarchies`, ({ body }) => {
    const created: HierarchyRow = {
      id: `hier-${demoId()}`,
      guildId: DEMO_GUILD_ID,
      name: body?.name || 'Nouvelle hiérarchie',
      description: body?.description ?? null,
      color: body?.color ?? '#949ba4',
      icon: body?.icon ?? null,
      sortOrder: 99,
      parentHierarchyId: body?.parentHierarchyId ?? null,
      responsableUserId: body?.responsableUserId ?? null,
      discordRoleId: body?.discordRoleId ?? null,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    demoDb.update(HIERARCHIES_KEY, hierarchiesSeed, (list) => [...list, created]);
    return { success: true, hierarchy: { ...created, roles: [], memberGrades: [] } };
  });
  route('PATCH', `${base}/hierarchies/:hierarchyId`, ({ params, body }) => {
    demoDb.update(HIERARCHIES_KEY, hierarchiesSeed, (list) => list.map((h) => (h.id === params.hierarchyId ? { ...h, ...body, updatedAt: new Date().toISOString() } : h)));
    return { success: true, hierarchy: hierarchiesWithRoles().find((h) => h.id === params.hierarchyId) };
  });
  route('DELETE', `${base}/hierarchies/:hierarchyId`, ({ params }) => {
    demoDb.update(HIERARCHIES_KEY, hierarchiesSeed, (list) => list.filter((h) => h.id !== params.hierarchyId));
    return { success: true };
  });
  route('POST', `${base}/hierarchies/:hierarchyId/import-roles`, () => ({ imported: 2, skipped: 1, total: 3 }));
  route('POST', `${base}/hierarchies/sync`, () => ({ success: true, synced: 6 }));

  route('POST', `${base}/members/:userId/tutor`, () => ({ success: true }));
  route('POST', `${base}/members/:userId/hierarchy-grade`, ({ body }) => ({ success: true, grade: { id: `hg-${demoId()}`, ...body, joinedAt: new Date().toISOString() } }));
  route('DELETE', `${base}/members/:userId/hierarchy-grade/:hierarchyId`, () => ({ success: true }));

  route('GET', `${base}/warnings`, () => ({ warnings: demoDb.get(WARNINGS_KEY, warningsSeed) }));
  route('POST', `${base}/warnings`, ({ body }) => {
    const target = personById(body?.userId ?? body?.staffUserId ?? '');
    const created = {
      id: `swarn-${demoId()}`,
      staffUserId: target?.id ?? '',
      staffDisplayName: target?.displayName ?? 'Membre du staff',
      staffAvatarUrl: null,
      reason: body?.reason ?? '',
      issuedByTag: ME.username,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    demoDb.update(WARNINGS_KEY, warningsSeed, (list) => [created, ...list]);
    return { success: true, warning: created };
  });
  route('DELETE', `${base}/warnings/:warningId`, ({ params }) => {
    demoDb.update(WARNINGS_KEY, warningsSeed, (list) => list.map((w) => (w.id === params.warningId ? { ...w, isActive: false } : w)));
    return { success: true };
  });

  route('GET', `${base}/polls`, () => ({ polls: demoDb.get(POLLS_KEY, pollsSeed) }));
  route('POST', `${base}/polls`, ({ body }) => {
    const id = `poll-${demoId()}`;
    const options: Array<string | { text: string }> = Array.isArray(body?.options) ? body.options : [];
    const created = {
      id,
      title: body?.title ?? 'Sondage',
      description: body?.description ?? null,
      status: 'OPEN',
      closesAt: body?.closesAt ?? new Date(Date.now() + 2 * 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
      author: { username: ME.username, displayName: ME.displayName },
      options: options.map((option, i) => ({ id: `${id}-o${i}`, text: typeof option === 'string' ? option : option.text })),
      votes: [] as Array<{ id: string; userId: string; optionId: string; weight: number }>,
    };
    demoDb.update(POLLS_KEY, pollsSeed, (list) => [created, ...list]);
    return { success: true, poll: created };
  });
  route('POST', `${base}/polls/vote`, ({ body }) => {
    demoDb.update(POLLS_KEY, pollsSeed, (list) =>
      list.map((p) =>
        p.id === body?.pollId
          ? { ...p, votes: [...p.votes.filter((v) => v.userId !== ME.id), { id: `${body.optionId}-me`, userId: ME.id, optionId: body.optionId, weight: 2 }] }
          : p,
      ),
    );
    return { success: true };
  });
  route('POST', `${base}/polls/:pollId/close`, ({ params }) => {
    demoDb.update(POLLS_KEY, pollsSeed, (list) => list.map((p) => (p.id === params.pollId ? { ...p, status: 'CLOSED', closesAt: new Date().toISOString() } : p)));
    return { success: true };
  });

  route('GET', '/api/dashboard/guilds/:id/leadership', () => ({ metrics: leadership() }));
}
