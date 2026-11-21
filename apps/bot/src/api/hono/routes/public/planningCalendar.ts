import { OpenAPIHono } from '@hono/zod-openapi';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getJwtSecret } from '../../../shared/core.js';
import { buildIcs, verifyIcalToken, type IcsEvent } from '../../../../services/staff/planningIcal.js';

const PAST_DAYS = 30;
const FUTURE_DAYS = 120;

// Les agendas relisent toutes les quelques heures : 30 lectures par 5 minutes suffisent largement.
const hits = new Map<string, number[]>();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_HITS = 30;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > MAX_HITS;
}

/** GET /api/public/planning/:token.ics - le planning d'un membre du staff au format iCal. */
export function createPublicPlanningCalendarRouter(client: Client) {
  const app = new OpenAPIHono();

  app.get('/api/public/planning/:file', async (c) => {
    const file = c.req.param('file');
    const identity = file.endsWith('.ics') ? verifyIcalToken(file.slice(0, -4), getJwtSecret()) : null;
    if (!identity) return c.text('Lien invalide', 404);
    if (rateLimited(file)) return c.text('Trop de requêtes', 429);

    const { guildId, userId } = identity;
    try {
      // Retire du staff, ou plus au staff de ce serveur : le lien ne montre plus rien.
      const staff = await prisma.staffMember.findFirst({ where: { guildId, userId }, select: { id: true } });
      if (!staff) return c.text('Lien invalide', 404);

      const from = new Date(Date.now() - PAST_DAYS * 86400000);
      const to = new Date(Date.now() + FUTURE_DAYS * 86400000);
      const [meetings, calls, tasks, absences] = await Promise.all([
        prisma.staffMeeting.findMany({
          where: { guildId, scheduledAt: { gte: from, lte: to }, status: { not: 'CANCELED' } },
          select: { id: true, title: true, description: true, scheduledAt: true, endedAt: true },
        }),
        prisma.staffCall.findMany({
          where: {
            guildId,
            scheduledAt: { gte: from, lte: to },
            OR: [{ creatorId: staff.id }, { invitees: { some: { staffUserId: staff.id } } }],
          },
          select: { id: true, title: true, description: true, scheduledAt: true, endedAt: true },
        }),
        prisma.staffTask.findMany({
          where: { guildId, assigneeId: staff.id, status: { not: 'COMPLETED' }, dueDate: { gte: from, lte: to } },
          select: { id: true, title: true, description: true, dueDate: true },
        }),
        prisma.staffAbsence.findMany({
          where: {
            guildId,
            staffUserId: staff.id,
            status: { in: ['APPROVED', 'ACKNOWLEDGED', 'PENDING'] },
            startDate: { lte: to },
            OR: [{ endDate: { gte: from } }, { isIndefinite: true }],
          },
          select: { id: true, reason: true, type: true, startDate: true, endDate: true },
        }),
      ]);

      const events: IcsEvent[] = [
        ...meetings.map((x) => ({ uid: `meeting-${x.id}`, start: x.scheduledAt, end: x.endedAt ?? new Date(x.scheduledAt.getTime() + 3600000), summary: x.title, description: x.description })),
        ...calls.map((x) => ({ uid: `call-${x.id}`, start: x.scheduledAt, end: x.endedAt, summary: x.title, description: x.description })),
        ...tasks.map((x) => ({ uid: `task-${x.id}`, start: x.dueDate!, summary: `Tâche : ${x.title}`, description: x.description })),
        ...absences.map((x) => ({
          uid: `absence-${x.id}`,
          start: x.startDate,
          end: x.endDate ? new Date(x.endDate.getTime() + 86400000) : null,
          allDay: true,
          summary: `Absence${x.type ? ` (${x.type})` : ''}`,
          description: x.reason,
        })),
      ];

      const guildName = client.guilds.cache.get(guildId)?.name ?? 'Kotbo';
      c.header('Content-Type', 'text/calendar; charset=utf-8');
      c.header('Cache-Control', 'private, max-age=300');
      return c.body(buildIcs(`Planning · ${guildName}`, events));
    } catch (err) {
      logger.error('PlanningCalendar', 'Erreur lors de la génération du flux iCal :', err);
      return c.text('Erreur', 500);
    }
  });

  return app;
}
