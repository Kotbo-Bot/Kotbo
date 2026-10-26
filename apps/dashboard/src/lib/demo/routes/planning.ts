/**
 * Planning du staff : calendrier, appels, tâches, réunions et absences.
 *
 * Le calendrier reprend `getStaffCalendarData` (`services/staff/
 * staffLeadershipService.ts`) : des lignes Prisma avec leur `staffMember`.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { ME, VOICE_CHANNELS, personByName, role } from '../fixtures';
import { staffMembers } from './home';

const DAY_MS = 86_400_000;
const at = (days: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() + days * DAY_MS);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const TASKS = 'planning/tasks';
const CALLS = 'planning/calls';
const CALL_CONFIG = 'planning/call-config';

const staffOf = (name: string) => staffMembers().find((s) => s.username === personByName(name).username)!;
const meStaff = () => staffMembers().find((s) => s.userId === ME.id)!;

function tasksSeed(): Record<string, any>[] {
  const task = (n: number, title: string, description: string | null, assignee: string, creator: string, status: string, priority: string, dueDays: number | null) =>
    row('StaffTask', {
      id: `task-${n}`,
      title,
      description,
      status,
      priority,
      dueDate: dueDays === null ? null : at(dueDays, 20),
      assigneeId: assignee === 'Toi' ? meStaff().id : staffOf(assignee).id,
      creatorId: creator === 'Toi' ? meStaff().id : staffOf(creator).id,
      createdAt: at(-3, 14),
    });
  return [
    task(1, 'Préparer les questions du quiz de mercredi', '20 questions jeux vidéo, 10 culture générale', 'Toi', 'Arka', 'IN_PROGRESS', 'HIGH', 1),
    task(2, 'Relire le nouveau règlement', 'Article sur les liens externes à clarifier', 'Toi', 'Lena', 'PENDING', 'MEDIUM', 4),
    task(3, 'Former Kylian aux tickets boutique', null, 'Lena', 'Arka', 'PENDING', 'MEDIUM', 2),
    task(4, 'Nettoyer les rôles inutilisés', 'Supprimer les rôles des anciens événements', 'Zenox', 'Toi', 'DONE', 'LOW', -1),
    task(5, 'Mettre à jour la FAQ du support', null, 'Aiden', 'Lena', 'PENDING', 'LOW', null),
  ];
}

function callsSeed(): Record<string, any>[] {
  const call = (n: number, title: string, description: string | null, days: number, hour: number, creator: string, invitees: string[], ended = false) => ({
    ...row('StaffCall', {
      id: `call-${n}`,
      title,
      description,
      scheduledAt: at(days, hour),
      endedAt: ended ? at(days, hour + 1) : null,
      status: ended ? 'ENDED' : 'SCHEDULED',
      creatorId: staffOf(creator).id,
      channelMode: 'EXISTING',
      discordChannelId: VOICE_CHANNELS[1].id,
      isTempChannel: false,
    }),
    creator: staffOf(creator),
    reminders: [],
    invitees: invitees.map((name, i) => ({ id: `call-${n}-inv-${i}`, staffMember: name === 'Toi' ? meStaff() : staffOf(name), status: 'PENDING' })),
  });
  return [
    call(1, 'Point modération', 'Retour sur les avertissements de la semaine', 1, 21, 'Zenox', ['Toi', 'Aiden', 'Kylian']),
    call(2, 'Organisation du tournoi', 'Arbitres, horaires, lots', 3, 19, 'Arka', ['Toi', 'Lena', 'Zenox']),
    call(3, 'Accueil de Kylian', null, -5, 18, 'Lena', ['Kylian'], true),
  ];
}

function meetingsFor(start: number, end: number): Record<string, any>[] {
  const members = staffMembers().filter((s) => s.blacklistEntries.length === 0);
  const meeting = (n: number, title: string, description: string, days: number, done: boolean): Record<string, any> => ({
    ...row('StaffMeeting', {
      id: `meet-${n}`,
      title,
      description,
      scheduledAt: at(days, 20),
      endedAt: done ? at(days, 21) : null,
      status: done ? 'ENDED' : 'SCHEDULED',
      createdByUserId: personByName('Arka').id,
      voiceChannelId: VOICE_CHANNELS[1].id,
      timezone: 'Europe/Paris',
    }),
    reminders: [],
    presences: done
      ? members.map((s, i) => ({ id: `pres-${n}-${i}`, staffMember: s, status: i === 4 ? 'EXCUSED' : i === 5 ? 'ABSENT' : 'PRESENT', present: i < 4, excused: i === 4, absent: i === 5 }))
      : [],
  });
  return [
    meeting(1, 'Réunion staff du dimanche', 'Bilan de la semaine, tickets en retard, préparation de la soirée quiz.', 2, false),
    meeting(2, 'Réunion staff du dimanche', 'Bilan du tournoi, recrutement de helpers.', -5, true),
    meeting(3, 'Réunion staff du dimanche', 'Nouveau règlement, retour sur le raid bloqué.', -12, true),
  ].filter((m) => {
    const t = new Date(m.scheduledAt).getTime();
    return t >= start && t <= end;
  });
}

function absencesFor(): Record<string, any>[] {
  const absence = (n: number, name: string, reason: string, type: string, from: number, to: number, status: string) => {
    const staff = staffOf(name);
    return { ...row('StaffAbsence', { id: `abs${n}`, staffUserId: staff.id, startDate: at(from, 0), endDate: at(to, 23, 59), reason, type, status }), staffMember: staff };
  };
  return [absence(1, 'Kylian', 'Partiels à la fac', 'Études', 3, 5, 'PENDING'), absence(2, 'Zenox', 'Vacances', 'Vacances', -1, 4, 'ACKNOWLEDGED')];
}

function voiceSessionsFor(start: number, end: number): Record<string, any>[] {
  const list: Record<string, any>[] = [];
  const members = staffMembers().filter((s) => s.blacklistEntries.length === 0);
  for (let d = -21; d <= 0; d++) {
    members.forEach((s, i) => {
      if ((d + i * 3) % 3 !== 0) return;
      const joined = at(d, 20 + (i % 3), 10 * i);
      const duration = (40 + ((i * 17 + d * 7) % 90)) * 60;
      list.push({
        ...row('StaffVoiceSession', {
          id: `vs-${s.id}-${d}`,
          staffUserId: s.id,
          channelId: VOICE_CHANNELS[i % 2].id,
          channelName: VOICE_CHANNELS[i % 2].name,
          joinedAt: joined,
          leftAt: new Date(new Date(joined).getTime() + duration * 1000).toISOString(),
          durationSeconds: duration,
        }),
        staffMember: s,
      });
    });
  }
  return list.filter((v) => {
    const t = new Date(v.joinedAt).getTime();
    return t >= start && t <= end;
  });
}

export function registerPlanningRoutes(): void {
  const base = '/api/dashboard/guilds/:id';

  route('GET', `${base}/absences/calendar-data`, ({ query }) => {
    const start = new Date(query.get('start') ?? Date.now() - 30 * DAY_MS).getTime();
    const end = new Date(query.get('end') ?? Date.now() + 30 * DAY_MS).getTime();
    const ids = query.get('staffIds')?.split(',').filter(Boolean);
    const keep = (staffId: string) => !ids || ids.length === 0 || ids.includes(staffId);
    const tasks: Record<string, any>[] = demoDb.get(TASKS, tasksSeed).map((t) => ({ ...t, assignee: staffMembers().find((s) => s.id === t.assigneeId) ?? null }));
    return {
      absences: absencesFor().filter((a) => keep(a.staffUserId)),
      voiceSessions: voiceSessionsFor(start, end).filter((v) => keep(v.staffUserId)),
      meetings: meetingsFor(start, end),
      calls: demoDb.get(CALLS, callsSeed).filter((c) => {
        const t = new Date(c.scheduledAt).getTime();
        return t >= start && t <= end;
      }),
      tasks: tasks.filter((t) => keep(t.assigneeId)),
    };
  });

  route('GET', `${base}/absences/superiors`, () => ({
    superiors: staffMembers()
      .filter((s) => s.userId !== ME.id)
      .slice(0, 4)
      .map((s, i) => ({
        userId: s.userId,
        displayName: s.displayName ?? s.username,
        avatarUrl: s.avatarUrl ?? null,
        grade: s.grade ?? null,
        reason: i === 0 ? 'tutor' : i === 1 ? 'owner' : 'rank',
      })),
  }));

  route('GET', `${base}/absences/config`, () => ({
    config: { enabled: true, requireApproval: true, maxDurationDays: 30, notifyChannelId: '900000000000000318', roleAccess: [], roleAccessByRole: [], notificationTargets: [] },
  }));

  const callConfigSeed = () => ({ mode: 'ROLES', allowedRoleIds: [role('Admin').id, role('Modérateur').id], allowedUserIds: [personByName('Lena').id] });
  route('GET', `${base}/calls/config`, () => ({ config: demoDb.get(CALL_CONFIG, callConfigSeed), canCreate: true }));
  route('POST', `${base}/calls/config`, ({ body }) => ({ config: demoDb.update(CALL_CONFIG, callConfigSeed, (c) => ({ ...c, ...(body ?? {}) })), canCreate: true }));

  route('GET', `${base}/calls`, () => ({ calls: demoDb.get(CALLS, callsSeed) }));
  route('POST', `${base}/calls`, ({ body }) => {
    const created = {
      ...row('StaffCall', { id: `call-${demoId()}`, title: body?.title ?? 'Appel', description: body?.description ?? null, scheduledAt: body?.scheduledAt ?? new Date().toISOString(), creatorId: meStaff().id, channelMode: body?.channelMode ?? 'TEMP' }),
      creator: meStaff(),
      reminders: [],
      invitees: [],
    };
    demoDb.update(CALLS, callsSeed, (list) => [...list, created]);
    return { success: true, call: created };
  });
  route('PATCH', `${base}/calls/:callId`, ({ params, body }) => {
    demoDb.update(CALLS, callsSeed, (list) => list.map((c) => (c.id === params.callId ? { ...c, ...(body ?? {}) } : c)));
    return { success: true };
  });
  route('DELETE', `${base}/calls/:callId`, ({ params }) => {
    demoDb.update(CALLS, callsSeed, (list) => list.filter((c) => c.id !== params.callId));
    return { success: true };
  });

  route('GET', `${base}/tasks`, ({ query }) => {
    const assigneeId = query.get('assigneeId');
    const list = demoDb.get(TASKS, tasksSeed).filter((t) => !assigneeId || t.assigneeId === assigneeId);
    return { tasks: list.map((t) => ({ ...t, assignee: staffMembers().find((s) => s.id === t.assigneeId) ?? null, creator: staffMembers().find((s) => s.id === t.creatorId) ?? null })) };
  });
  route('POST', `${base}/tasks`, ({ body }) => {
    const created = row('StaffTask', {
      id: `task-${demoId()}`,
      title: body?.title ?? 'Tâche',
      description: body?.description ?? null,
      priority: body?.priority ?? 'MEDIUM',
      dueDate: body?.dueDate ?? null,
      assigneeId: body?.assigneeId ?? meStaff().id,
      creatorId: meStaff().id,
    });
    demoDb.update(TASKS, tasksSeed, (list) => [...list, created]);
    return { success: true, task: created };
  });
  route('PATCH', `${base}/tasks/:taskId`, ({ params, body }) => {
    const list = demoDb.update(TASKS, tasksSeed, (all) => all.map((t) => (t.id === params.taskId ? { ...t, ...(body ?? {}), updatedAt: new Date().toISOString() } : t)));
    return { success: true, task: list.find((t) => t.id === params.taskId) };
  });
  route('DELETE', `${base}/tasks/:taskId`, ({ params }) => {
    demoDb.update(TASKS, tasksSeed, (list) => list.filter((t) => t.id !== params.taskId));
    return { success: true };
  });

  route('POST', `${base}/reminders`, () => ({ success: true }));
}
