/**
 * Ce que le serveur a deja de date, montre dans le Planning a cote des
 * reunions et absences : evenements Discord, fins de giveaways, publications
 * et taches planifiees. Lecture seule ; chaque element renvoie vers sa page.
 */
import { GuildScheduledEventStatus } from 'discord.js';
import { cronOccurrences } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { getClient } from '../../utils/client.js';

export type PlanningExtraKind = 'server_event' | 'giveaway' | 'schedule' | 'testing_end' | 'sanction_end';

/** Absence de l'equipe entiere, pour l'alerte de couverture : le calendrier n'a que les personnes cochees. */
export interface TeamAbsence {
  staffName: string;
  start: string;
  end: string | null;
}

export interface PlanningExtra {
  kind: PlanningExtraKind;
  id: string;
  title: string;
  start: string;
  end: string | null;
  description: string | null;
  /** Page du dashboard qui gere l'element. */
  href: string;
  /** Lien Discord direct, quand il existe. */
  externalUrl: string | null;
  meta: Record<string, string | number | boolean | null>;
}

interface DiscordEventRow {
  id: string;
  name: string;
  description: string | null;
  start: string | null;
  end: string | null;
  status: number;
  location: string | null;
  channelId: string | null;
  userCount: number | null;
  url: string;
}

/** Une tache qui tombe plus de deux fois par jour encombre le calendrier sans rien apprendre. */
const MAX_SCHEDULE_RUNS_PER_DAY = 2;

// Les taches tournent avec node-cron, donc dans le fuseau du process.
const PROCESS_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Evenements Discord du serveur, gardes une minute : la page relit a chaque changement de periode. */
async function fetchDiscordEvents(guildId: string): Promise<DiscordEventRow[]> {
  return cache.wrap(`guild:${guildId}:planning-discord-events`, 60, async () => {
    const guild = getClient()?.guilds.cache.get(guildId);
    if (!guild) return [];
    const events = await guild.scheduledEvents.fetch({ withUserCount: true }).catch(() => null);
    if (!events) return [];
    return [...events.values()].map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      start: e.scheduledStartAt?.toISOString() ?? null,
      end: e.scheduledEndAt?.toISOString() ?? null,
      status: e.status,
      location: e.entityMetadata?.location ?? null,
      channelId: e.channelId,
      userCount: e.userCount ?? null,
      url: e.url,
    }));
  });
}

export async function getPlanningExtras(
  guildId: string,
  start: Date,
  end: Date,
  scope: { events: boolean; giveaways: boolean; schedules: boolean; tutoring: boolean; sanctions: boolean },
): Promise<{ items: PlanningExtra[]; teamAbsences: TeamAbsence[] }> {
  const inRange = (from: Date, to: Date | null) => from.getTime() <= end.getTime() && (to ?? from).getTime() >= start.getTime();
  const items: PlanningExtra[] = [];

  if (scope.events) {
    const [discordEvents, kotboEvents, meetings] = await Promise.all([
      fetchDiscordEvents(guildId),
      prisma.event.findMany({
        where: { guildId, type: 'CUSTOM', status: { not: 'CANCELLED' } },
        select: { id: true, title: true, description: true, discordEventId: true, triggerType: true, triggerValue: true, status: true },
      }),
      prisma.staffMeeting.findMany({ where: { guildId, discordEventId: { not: null } }, select: { discordEventId: true } }),
    ]);
    // Les reunions du staff ont deja leur calque : leur evenement Discord n'est pas repete.
    const meetingEventIds = new Set(meetings.map((mtg) => mtg.discordEventId));
    const kotboByDiscordId = new Map(kotboEvents.filter((e) => e.discordEventId).map((e) => [e.discordEventId!, e]));
    const seenDiscordIds = new Set<string>();

    for (const e of discordEvents) {
      if (!e.start || meetingEventIds.has(e.id) || e.status === GuildScheduledEventStatus.Canceled) continue;
      seenDiscordIds.add(e.id);
      const from = new Date(e.start);
      const to = e.end ? new Date(e.end) : null;
      if (!inRange(from, to)) continue;
      const kotbo = kotboByDiscordId.get(e.id);
      items.push({
        kind: 'server_event',
        id: e.id,
        title: e.name,
        start: e.start,
        end: e.end,
        description: e.description,
        href: kotbo ? `/events/edit/${kotbo.id}` : '/events',
        externalUrl: e.url,
        meta: {
          status: e.status === GuildScheduledEventStatus.Active ? 'ACTIVE' : e.status === GuildScheduledEventStatus.Completed ? 'COMPLETED' : 'SCHEDULED',
          location: e.location,
          channelId: e.channelId,
          interested: e.userCount,
          managedByKotbo: !!kotbo,
        },
      });
    }

    // Evenement Kotbo date mais sans evenement Discord (ou supprime cote Discord).
    for (const e of kotboEvents) {
      if (e.triggerType !== 'SCHEDULED' || !e.triggerValue) continue;
      if (e.discordEventId && seenDiscordIds.has(e.discordEventId)) continue;
      const from = new Date(e.triggerValue);
      if (Number.isNaN(from.getTime()) || !inRange(from, null)) continue;
      items.push({
        kind: 'server_event',
        id: `kotbo:${e.id}`,
        title: e.title,
        start: from.toISOString(),
        end: null,
        description: e.description,
        href: `/events/edit/${e.id}`,
        externalUrl: null,
        meta: { status: e.status, location: null, channelId: null, interested: null, managedByKotbo: true },
      });
    }
  }

  if (scope.giveaways) {
    const giveaways = await prisma.giveaway.findMany({
      where: { guildId, endsAt: { gte: start, lte: end } },
      select: { id: true, prize: true, description: true, endsAt: true, ended: true, participants: true, winnerCount: true, channelId: true },
    });
    for (const g of giveaways) {
      items.push({
        kind: 'giveaway',
        id: g.id,
        title: g.prize,
        start: g.endsAt.toISOString(),
        end: null,
        description: g.description,
        href: '/giveaways',
        externalUrl: null,
        meta: { ended: g.ended, participants: g.participants.length, winnerCount: g.winnerCount, channelId: g.channelId },
      });
    }
  }

  if (scope.schedules) {
    const tasks = await prisma.scheduledTask.findMany({
      where: { guildId, enabled: true },
      select: { id: true, name: true, type: true, cron: true, targetId: true, message: true, runOnce: true },
    });
    const days = Math.max(1, (end.getTime() - start.getTime()) / 86400000);
    const cap = Math.ceil(days * MAX_SCHEDULE_RUNS_PER_DAY);
    for (const task of tasks) {
      const runs = cronOccurrences(task.cron, start, end, PROCESS_TIMEZONE, cap + 1);
      if (runs.length === 0 || runs.length > cap) continue;
      for (const run of task.runOnce ? runs.slice(0, 1) : runs) {
        items.push({
          kind: 'schedule',
          id: `${task.id}:${run.toISOString()}`,
          title: task.name,
          start: run.toISOString(),
          end: null,
          description: task.message ?? null,
          href: '/schedules',
          externalUrl: null,
          meta: { taskType: task.type, channelId: task.targetId, runOnce: task.runOnce },
        });
      }
    }
  }

  if (scope.tutoring) {
    const periods = await prisma.testingPeriod.findMany({
      where: { guildId, status: 'ONGOING' },
      select: {
        id: true, startDate: true, endDate: true, plannedDurationDays: true, targetGrade: true,
        staffMember: { select: { displayName: true, username: true, userId: true } },
        mentor: { select: { displayName: true, username: true } },
      },
    });
    for (const p of periods) {
      // Fin fixee si elle existe, sinon la duree prevue depuis le debut.
      const due = p.endDate ?? new Date(p.startDate.getTime() + p.plannedDurationDays * 86400000);
      if (!inRange(due, null)) continue;
      items.push({
        kind: 'testing_end',
        id: p.id,
        title: p.staffMember.displayName || p.staffMember.username || p.staffMember.userId,
        start: due.toISOString(),
        end: null,
        description: null,
        href: '/tutoring',
        externalUrl: null,
        meta: { mentor: p.mentor ? (p.mentor.displayName || p.mentor.username) : null, targetGrade: p.targetGrade },
      });
    }
  }

  if (scope.sanctions) {
    const sanctions = await prisma.sanction.findMany({
      where: { guildId, status: 'ACTIVE', type: { in: ['TIMEOUT', 'TEMP_BAN'] }, expiresAt: { gte: start, lte: end } },
      select: { id: true, type: true, targetUserId: true, targetTag: true, reason: true, expiresAt: true },
      take: 200,
    });
    for (const s of sanctions) {
      items.push({
        kind: 'sanction_end',
        id: s.id,
        title: s.targetTag || s.targetUserId,
        start: s.expiresAt!.toISOString(),
        end: null,
        description: s.reason,
        href: '/security/sanctions',
        externalUrl: null,
        meta: { sanctionType: s.type },
      });
    }
  }

  const absences = await prisma.staffAbsence.findMany({
    where: {
      guildId,
      status: { in: ['APPROVED', 'ACKNOWLEDGED', 'PENDING'] },
      startDate: { lte: end },
      OR: [{ endDate: { gte: start } }, { isIndefinite: true }],
    },
    select: { startDate: true, endDate: true, staffMember: { select: { displayName: true, username: true, userId: true } } },
  });
  const teamAbsences = absences.map((a) => ({
    staffName: a.staffMember.displayName || a.staffMember.username || a.staffMember.userId,
    start: a.startDate.toISOString(),
    end: a.endDate?.toISOString() ?? null,
  }));

  return { items, teamAbsences };
}
