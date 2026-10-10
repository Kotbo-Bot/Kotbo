/**
 * L'accueil : statistiques, tâches à traiter, préférences, langue et fuseau.
 *
 * Formes reprises de `homeTasks.ts` et
 * `general.ts` côté bot, réduites aux champs que les pages lisent.
 */
import type { HomeTasksData } from '@kotbo/contracts';
import { route } from '../backend';
import { demoDb } from '../db';
import { HOUR, PEOPLE, ago, personByName, role } from '../fixtures';

const DAY_MS = 86_400_000;
const DAY = 24 * HOUR;

/** Mêmes étapes que `setupJourney.ts` côté bot : un serveur à moitié réglé. */
function setupJourney() {
  const steps = [
    { key: 'logs', group: 'essentiel', label: 'Salon de logs', why: "Sans lui, aucune trace de ce que fait le bot ni de ce qui se passe sur le serveur.", done: true, href: '/logs/config' },
    { key: 'moderator-role', group: 'essentiel', label: 'Rôle modérateur', why: "Il décide qui peut sanctionner et prendre en charge un ticket. Sans lui, seuls les administrateurs le peuvent.", done: true, href: '/security/sanctions/settings' },
    { key: 'timezone', group: 'essentiel', label: 'Fuseau horaire', why: "Le bot tourne en UTC : sans fuseau, toute date affichée ou saisie est décalée.", done: true, href: '/management', detail: 'Europe/Paris' },
    { key: 'regulation', group: 'moderation', label: 'Règlement publié', why: "Une sanction sans règle écrite se conteste. Le règlement sert aussi de référence aux rapports.", done: false, href: '/regulation' },
    { key: 'security', group: 'moderation', label: 'Protection activée', why: "Filtres AutoMod et anti-raid. Un niveau de protection les règle tous d'un coup.", done: true, href: '/security/quick-setup' },
    { key: 'sanction-alerts', group: 'moderation', label: 'Salon des alertes de sanction', why: "Le staff voit passer les sanctions au lieu de les découvrir dans le casier.", done: false, href: '/security/sanctions/settings' },
    { key: 'tickets', group: 'engagement', label: 'Tickets opérationnels', why: "Catégorie, rôle du staff et salon du panneau : sans les trois, un membre ne peut pas ouvrir de ticket.", done: true, href: '/tickets/config' },
    { key: 'ticket-quotas', group: 'engagement', label: 'Quotas de tickets', why: "Sans quota, rien n'empêche un membre d'ouvrir dix tickets d'affilée.", done: false, href: '/tickets/config' },
    { key: 'welcome', group: 'engagement', label: 'Accueil des arrivants', why: "Un serveur qui n'accueille pas perd la moitié de ses arrivants dans la première heure.", done: true, href: '/announcement/welcome' },
  ];
  return { steps, progress: { done: steps.filter((s) => s.done).length, total: steps.length } };
}

function homeTasks(): HomeTasksData {
  return {
    tasks: [
      {
        key: 'tickets_unclaimed',
        severity: 'warning',
        count: 2,
        oldestAt: ago(3 * HOUR),
        href: '/tickets',
        preview: [
          { id: 't148', label: '#0148 · Bug sur la boutique', at: ago(3 * HOUR) },
          { id: 't149', label: '#0149 · Question sur les rôles', at: ago(40) },
        ],
      },
      {
        key: 'sanction_reports_missing',
        severity: 'info',
        count: 1,
        mine: 0,
        href: '/security/sanctions',
        preview: [{ id: 's501', label: 'Vantar · Avertissement sans rapport', at: ago(2 * HOUR) }],
      },
      {
        key: 'absences_pending',
        severity: 'info',
        count: 1,
        href: '/absences',
        preview: [{ id: 'abs1', label: 'Kylian · du lundi au mercredi', at: ago(5 * HOUR) }],
      },
      {
        key: 'meetings_upcoming',
        severity: 'info',
        count: 1,
        href: '/meetings',
        preview: [{ id: 'meet1', label: 'Réunion staff du dimanche', at: new Date(Date.now() + 2 * DAY_MS).toISOString() }],
      },
    ],
    setup: null,
    generatedAt: new Date().toISOString(),
  };
}

const USER_SETTINGS = 'user-settings';
const LANGUAGE = 'language';
const TIMEZONE = 'timezone';

const staffPeople = () => PEOPLE.filter((p) => p.roles.some((id) => [role('Fondateur').id, role('Admin').id, role('Modérateur').id, role('Helper').id].includes(id)));

const gradeOf = (roles: string[]) =>
  roles.includes(role('Fondateur').id) ? 'Fondateur' : roles.includes(role('Admin').id) ? 'Admin' : roles.includes(role('Modérateur').id) ? 'Modérateur' : 'Helper';

/** Hiérarchie de chaque grade, reprise par `routes/staff.ts`. */
export const HIERARCHY_OF_GRADE: Record<string, string> = { Fondateur: 'hier-direction', Admin: 'hier-direction', Modérateur: 'hier-moderation', Helper: 'hier-support' };

export function staffMembers() {
  const current = staffPeople().map((p, i) => {
    const grade = gradeOf(p.roles);
    const id = `staff-${p.username}`;
    return {
      id,
      guildId: '',
      userId: p.id,
      grade,
      joinedStaffAt: ago(p.joinedMinutesAgo - 10 * DAY),
      currentRoleStartedAt: ago(Math.max(1, p.joinedMinutesAgo - 30 * DAY)),
      userTag: p.username,
      username: p.username,
      displayName: p.displayName,
      avatarUrl: null,
      isTutor: i === 2,
      suspendedAt: null as string | null,
      suspendedReason: null as string | null,
      createdAt: ago(p.joinedMinutesAgo),
      updatedAt: ago(DAY),
      warnings: p.username === 'kylian' ? [{ id: 'swarn-1', reason: 'Ticket fermé sans réponse au membre', expiresAt: new Date(Date.now() + 20 * DAY_MS).toISOString() }] : [],
      blacklistEntries: [] as { id: string; reason: string; endDate?: string | null }[],
      stats: { totalMessages: p.messages, totalVoiceMinutes: p.voiceMinutes, sanctionsIssued: 3 + i * 4 },
      hierarchyGrades: [{ id: `hg-${p.username}`, staffMemberId: id, hierarchyId: HIERARCHY_OF_GRADE[grade], grade, joinedAt: ago(p.joinedMinutesAgo - 10 * DAY) }],
    };
  });
  const former = {
    ...current[current.length - 1],
    id: 'staff-gael',
    userId: '900000000000001006',
    grade: 'Helper',
    userTag: 'gael07',
    username: 'gael07',
    displayName: 'Gaël07',
    isTutor: false,
    warnings: [],
    blacklistEntries: [{ id: 'sbl-1', reason: 'A partagé des captures du salon staff sur un autre serveur', endDate: null }],
    stats: { totalMessages: 410, totalVoiceMinutes: 120, sanctionsIssued: 2 },
    hierarchyGrades: [],
  };
  return [...current, former];
}

export const ABSENCES = 'absences';
export function absencesSeed() {
  const kylian = personByName('Kylian');
  const zenox = personByName('Zenox');
  return [
    {
      id: 'abs1',
      userId: kylian.id,
      userTag: kylian.username,
      displayName: kylian.displayName,
      reason: 'Partiels à la fac',
      startDate: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      endDate: new Date(Date.now() + 5 * DAY_MS).toISOString(),
      status: 'PENDING',
      createdAt: ago(5 * HOUR),
    },
    {
      id: 'abs2',
      userId: zenox.id,
      userTag: zenox.username,
      displayName: zenox.displayName,
      reason: 'Vacances',
      startDate: ago(DAY),
      endDate: new Date(Date.now() + 4 * DAY_MS).toISOString(),
      status: 'ACKNOWLEDGED',
      createdAt: ago(6 * DAY),
    },
  ];
}

export const MEETINGS = 'meetings';
export function meetingsSeed() {
  return [
    {
      id: 'meet1',
      title: 'Réunion staff du dimanche',
      description: 'Bilan de la semaine, tickets en retard, préparation de la soirée quiz.',
      scheduledAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
      endedAt: null,
      timezone: 'Europe/Paris',
      createdAt: ago(3 * DAY),
    },
  ];
}

export function registerHomeRoutes(): void {
  route('GET', '/api/config', () => ({ discordClientId: '0' }));

  route('GET', '/api/dashboard/guilds/:guildId/home-tasks', () => homeTasks());
  // Le parcours « Bien demarrer » : sans cette route, la page de demo
  // n'affichait qu'un « Parcours indisponible », alors que c'est par elle que
  // l'ecran de bienvenue fait commencer.
  route('GET', '/api/dashboard/guilds/:guildId/setup', () => setupJourney());
  route('GET', '/api/dashboard/guilds/:guildId/notifications', () => ({ notifications: [] }));
  route('GET', '/api/dashboard/guilds/:guildId/tutoring/apprentice-progress', () => ({ progress: null }));

  route('GET', '/api/dashboard/guilds/:guildId/user-settings', () => demoDb.get(USER_SETTINGS, () => ({})));
  route('PUT', '/api/dashboard/guilds/:guildId/user-settings', ({ body }) =>
    demoDb.update(USER_SETTINGS, () => ({}), (current) => ({ ...current, ...(body ?? {}) })),
  );

  const languageState = () => demoDb.get(LANGUAGE, () => ({ mode: 'auto', locale: 'fr' }));
  route('GET', '/api/dashboard/guilds/:guildId/language', () => ({ ...languageState(), detected: 'fr', available: ['fr', 'en'], rerender: null }));
  route('PATCH', '/api/dashboard/guilds/:guildId/language', ({ body }) => {
    const auto = body?.mode === 'auto' || body?.language === null;
    const next = demoDb.set(LANGUAGE, { mode: auto ? 'auto' : 'manual', locale: auto ? 'fr' : body?.language === 'en' ? 'en' : 'fr' });
    return { ...next, detected: 'fr', available: ['fr', 'en'], rerender: null };
  });

  const timezoneList = ['Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'America/Montreal', 'UTC'];
  route('GET', '/api/dashboard/guilds/:guildId/timezone', () => ({ timezone: demoDb.get(TIMEZONE, () => 'Europe/Paris'), default: 'Europe/Paris', available: timezoneList }));
  route('PATCH', '/api/dashboard/guilds/:guildId/timezone', ({ body }) => {
    const timezone = typeof body?.timezone === 'string' ? body.timezone : 'Europe/Paris';
    demoDb.set(TIMEZONE, timezone);
    return { timezone, default: 'Europe/Paris', available: timezoneList };
  });

  route('GET', '/api/dashboard/guilds/:guildId/staff/members', () => ({ members: staffMembers() }));
  route('GET', '/api/dashboard/guilds/:guildId/absences', () => ({ absences: demoDb.get(ABSENCES, absencesSeed) }));
  route('GET', '/api/dashboard/guilds/:guildId/meetings', () => ({ meetings: demoDb.get(MEETINGS, meetingsSeed) }));
}
