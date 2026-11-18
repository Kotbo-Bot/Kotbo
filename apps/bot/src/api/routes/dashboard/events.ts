import type { Prisma } from '@prisma/client';
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { broadcastDashboardStateChange } from '../../shared.js';
import {
  getEvents,
  getEvent,
  createEvent,
  publishEvent,
  nextQuestion,
  getEventStats,
  prevQuestion,
  finishEvent,
  deleteEvent,
  createCustomEvent,
} from '../../../services/features/eventService.js';
import {
  getEventRegistrations,
  removeEventRegistration,
} from '../../../services/features/customFormService.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import {
  generateTournament,
  getTournament,
  reportTournamentMatch,
  resetTournament,
  resetTournamentMatch,
  swapTournamentSeeds,
} from '../../../services/features/tournament/tournamentService.js';
import { UserFacingError } from '../../../utils/userFacingError.js';
import { isGuildChannel } from '../../../utils/panelMessage.js';

/** Un salon fourni doit appartenir au serveur de la requête (la garde d'événement ne vérifie que l'événement). */
async function hasForeignChannel(guildId: string, ...ids: unknown[]): Promise<boolean> {
  for (const id of ids) {
    if (typeof id === 'string' && id && !(await isGuildChannel(guildId, id))) return true;
  }
  return false;
}

// Une étape de quiz par événement à la fois : l'édition du message Discord peut traîner,
// et un second clic pendant ce temps faisait sauter une question de plus.
// shortcut: verrou en mémoire, valable tant que seul le shard 0 sert l'API.
const stepsInProgress = new Set<string>();

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
export function createEventsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // L'événement doit appartenir au serveur ouvert : toutes les routes avec
  // :eventId le prenaient par son seul identifiant, et le staff d'un autre
  // serveur pouvait le lire, le modifier, le publier ou le supprimer.
  const ownedEvent = createMiddleware(async (c, next) => {
    const eventId = c.req.param('eventId');
    if (eventId) {
      const owned = await prisma.event.findFirst({ where: { id: eventId, guildId: c.req.param('guildId') }, select: { id: true } });
      if (!owned) return send(c, { error: 'Événement introuvable.' }, 404);
    }
    await next();
  });
  const gate = [...guildRoute(client), ownedEvent] as const;

  // /events/:eventId/tournament[/generate|/reset|/swap|/matches/:stage/:round/:position]
  const tournament = `${base}/events/:eventId/tournament`;
  router.get(tournament, ...gate, async (c) => {
    try {
      return send(c, { tournament: await getTournament(c.req.param('eventId'), client) });
    } catch (err) {
      if (err instanceof UserFacingError) return send(c, { error: err.message }, 400);
      return fail(c, err, 'Impossible de mettre à jour le tournoi.', 'EventsAPI');
    }
  });

  /** Applique un changement au tournoi puis renvoie l'arbre à jour. */
  const updateTournament = (change: (c: Context, eventId: string) => Promise<unknown>) => async (c: Context) => {
    const eventId = c.req.param('eventId')!;
    try {
      await change(c, eventId);
      broadcastDashboardStateChange(c.req.param('guildId')!, 'events_updated');
      return send(c, { tournament: await getTournament(eventId, client) });
    } catch (err) {
      // Score refusé, arbre impossible à générer… : un refus normal, pas une panne.
      if (err instanceof UserFacingError) return send(c, { error: err.message }, 400);
      return fail(c, err, 'Impossible de mettre à jour le tournoi.', 'EventsAPI');
    }
  };
  const matchKey = (c: Context) =>
    [c.req.param('stage') ?? '', Number(c.req.param('round')), Number(c.req.param('position'))] as const;

  router.post(`${tournament}/generate`, ...gate, updateTournament(async (c, eventId) => {
    const body = await readBody(c);
    await generateTournament(eventId, body?.shuffle === true);
  }));
  router.post(`${tournament}/reset`, ...gate, updateTournament(async (c, eventId) => {
    await readBody(c);
    await resetTournament(eventId);
  }));
  router.post(`${tournament}/swap`, ...gate, updateTournament(async (c, eventId) => {
    const body = await readBody(c);
    await swapTournamentSeeds(eventId, Number(body?.seedA), Number(body?.seedB));
  }));
  router.put(`${tournament}/matches/:stage/:round/:position`, ...gate, updateTournament(async (c, eventId) => {
    const body = await readBody(c);
    await reportTournamentMatch(eventId, ...matchKey(c), body ?? {});
  }));
  router.delete(`${tournament}/matches/:stage/:round/:position`, ...gate, updateTournament(async (c, eventId) => {
    await resetTournamentMatch(eventId, ...matchKey(c));
  }));



  router.get(`${base}/events`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const events = await getEvents(guildId);
      return send(c, { events });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, 'Erreur récupération événements', 'EventsAPI');
    }
  });

  router.post(`${base}/events`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<Record<string, unknown>>(c);
      if (!body || typeof body.title !== 'string' || !body.title.trim()) {
        return send(c, { error: 'Le titre de l\'événement est requis.' }, 400);
      }
      if (await hasForeignChannel(guildId, body.channelId, body.announcementChannelId)) {
        return send(c, { error: 'Salon introuvable sur ce serveur.' }, 400);
      }

      let event;
      if (body.type === 'CUSTOM' || body.type === 'TOURNAMENT') {
        event = await createCustomEvent(client, guildId, body as Parameters<typeof createCustomEvent>[2]);
      } else {
        if (body.type !== 'QUIZ' && body.type !== 'CTF') {
          return send(c, { error: "Type d'événement invalide : attendu CUSTOM, TOURNAMENT, QUIZ ou CTF." }, 400);
        }
        event = await createEvent(guildId, body as Parameters<typeof createEvent>[1]);
      }
      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, { event }, 201);
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, 'Erreur création événement', 'EventsAPI');
    }
  });

  router.get(`${base}/events/:eventId`, ...gate, async (c) => {
    const eventId = c.req.param('eventId');
    try {
      const event = await getEvent(eventId);
      return send(c, { event });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, 'Erreur récupération événement', 'EventsAPI');
    }
  });

  router.delete(`${base}/events/:eventId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    try {
      await deleteEvent(client, eventId);
      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, { success: true });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, 'Erreur suppression événement', 'EventsAPI');
    }
  });

  router.post(`${base}/events/:eventId/publish`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    try {
      const event = await publishEvent(client, eventId);
      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, { event });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, "Impossible de publier l'événement.", 'EventsAPI');
    }
  });

  router.post(`${base}/events/:eventId/next`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    if (stepsInProgress.has(eventId)) {
      return send(c, { error: 'Une question est déjà en train de changer, patiente quelques secondes.' }, 409);
    }
    stepsInProgress.add(eventId);
    const startedAt = Date.now();
    try {
      const result = await nextQuestion(client, eventId);
      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, result);
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, "Impossible de passer à l'étape suivante.", 'EventsAPI');
    } finally {
      stepsInProgress.delete(eventId);
      const ms = Date.now() - startedAt;
      if (ms > 5000) logger.warn('EventsAPI', `Étape next de l'événement ${eventId} lente : ${ms} ms`);
    }
  });

  router.post(`${base}/events/:eventId/prev`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    if (stepsInProgress.has(eventId)) {
      return send(c, { error: 'Une question est déjà en train de changer, patiente quelques secondes.' }, 409);
    }
    stepsInProgress.add(eventId);
    const startedAt = Date.now();
    try {
      const result = await prevQuestion(client, eventId);
      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, result);
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, "Impossible de revenir à l'étape précédente.", 'EventsAPI');
    } finally {
      stepsInProgress.delete(eventId);
      const ms = Date.now() - startedAt;
      if (ms > 5000) logger.warn('EventsAPI', `Étape prev de l'événement ${eventId} lente : ${ms} ms`);
    }
  });

  router.post(`${base}/events/:eventId/finish`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    try {
      const result = await finishEvent(client, eventId);
      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, result);
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, "Impossible de terminer l'événement.", 'EventsAPI');
    }
  });

  router.patch(`${base}/events/:eventId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    try {
      const body = await readBody<Record<string, unknown>>(c);
      if (!body) {
        return send(c, { error: 'Corps de requête invalide.' }, 400);
      }
      if (await hasForeignChannel(guildId, body.channelId, body.announcementChannelId)) {
        return send(c, { error: 'Salon introuvable sur ce serveur.' }, 400);
      }
      const currentEvent = await prisma.event.findUnique({ where: { id: eventId } });
      const isLive = currentEvent?.status === 'ONGOING';
      // Le champ « nombre de membres » du dashboard envoie un nombre ; la colonne est un String.
      if (typeof body.triggerValue === 'number') body.triggerValue = String(body.triggerValue);

      // Le corps vient du dashboard : on ne recopie que les champs presents,
      // et les listes imbriquees ne sont acceptees que dans leur forme attendue.
      const quizQuestions = Array.isArray(body.questions) ? body.questions as Record<string, unknown>[] : null;
      const ctfChallenges = Array.isArray(body.ctfChallenges) ? body.ctfChallenges as Record<string, unknown>[] : null;

      const event = await prisma.event.update({
        where: { id: eventId },
        data: {
          title: body.title,
          description: body.description,
          channelId: body.channelId,
          announcementChannelId: body.announcementChannelId,
          formId: body.formId,
          triggerType: body.triggerType,
          triggerValue: body.triggerValue,
          config: body.config,
          triggerStatus: (body.triggerType !== currentEvent?.triggerType || body.triggerValue !== currentEvent?.triggerValue) ? 'PENDING' : undefined,
          questions: (quizQuestions && !isLive && currentEvent?.type === 'QUIZ') ? {
            deleteMany: {},
            create: quizQuestions.map((q, i) => ({
              text: q.text,
              options: q.options,
              correctOptionIndex: q.correctOptionIndex,
              sortOrder: i,
              imageUrl: q.imageUrl
            }))
          } : undefined,
          ctfChallenges: (ctfChallenges && !isLive && currentEvent?.type === 'CTF') ? {
            deleteMany: {},
            create: ctfChallenges.map((c, i) => ({
              title: c.title,
              description: c.description || '',
              flag: c.flag,
              points: Number(c.points) || 100,
              roleIdReward: c.roleIdReward || null,
              xpReward: Number(c.xpReward) || 0,
              imageUrl: c.imageUrl || null,
              sortOrder: i
            }))
          } : undefined
        } as Prisma.EventUpdateInput,
        include: { questions: true, ctfChallenges: true },
      });

      if (isLive && quizQuestions && currentEvent?.type === 'QUIZ') {
        const existingQuestions = await prisma.eventQuizQuestion.findMany({
          where: { eventId },
          orderBy: { sortOrder: 'asc' }
        });

        for (let i = 0; i < Math.min(existingQuestions.length, quizQuestions.length); i++) {
          const q = quizQuestions[i];
          if (i < existingQuestions.length) {
            await prisma.eventQuizQuestion.update({
              where: { id: existingQuestions[i].id },
              data: {
                text: String(q.text ?? ''),
                options: (q.options ?? []) as Prisma.InputJsonValue,
                correctOptionIndex: Number(q.correctOptionIndex ?? 0),
                imageUrl: typeof q.imageUrl === 'string' ? q.imageUrl : null,
              }
            });
          }
        }
      }

      if (isLive && ctfChallenges && currentEvent?.type === 'CTF') {
        const existingChallenges = await prisma.eventCtfChallenge.findMany({
          where: { eventId },
          orderBy: { sortOrder: 'asc' }
        });

        for (let i = 0; i < Math.min(existingChallenges.length, ctfChallenges.length); i++) {
          const c = ctfChallenges[i];
          await prisma.eventCtfChallenge.update({
            where: { id: existingChallenges[i].id },
            data: {
              title: String(c.title ?? ''),
              description: typeof c.description === 'string' ? c.description : '',
              flag: String(c.flag ?? ''),
              points: Number(c.points) || 100,
              roleIdReward: typeof c.roleIdReward === 'string' ? c.roleIdReward : null,
              xpReward: Number(c.xpReward) || 0,
              imageUrl: typeof c.imageUrl === 'string' ? c.imageUrl : null,
            }
          });
        }
      }

      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, { event });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, "Impossible d'enregistrer l'événement.", 'EventsAPI');
    }
  });

  router.get(`${base}/events/:eventId/stats`, ...gate, async (c) => {
    const eventId = c.req.param('eventId');
    try {
      const stats = await getEventStats(eventId);
      return send(c, { stats });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, 'Erreur récupération stats', 'EventsAPI');
    }
  });

  router.get(`${base}/events/:eventId/registrations`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    try {
      const registrations = await getEventRegistrations(eventId);
      // L'inscription ne garde que l'identifiant et le pseudo fige au moment
      // de l'inscription : la photo doit etre resolue ici.
      const identities = await getMemberIdentities(
        client,
        guildId,
        registrations.flatMap((registration) => [registration.userId, ...registration.teamMemberIds]),
      );
      return send(c, {
        registrations: registrations.map((registration) => {
          const identity = identities.get(registration.userId);
          return {
            ...registration,
            username: identity?.displayName || registration.username,
            avatarUrl: identity?.avatarUrl || null,
            teamMembers: registration.teamMemberIds.map((id) => ({ id, name: identities.get(id)?.displayName || id })),
          };
        }),
      });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, 'Erreur récupération inscriptions', 'EventsAPI');
    }
  });

  router.delete(`${base}/events/:eventId/registrations/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    const userId = c.req.param('userId');
    try {
      await removeEventRegistration(eventId, c.req.param('userId'));
      broadcastDashboardStateChange(guildId, 'events_updated');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('EventsAPI', err);
      return fail(c, err, 'Erreur suppression inscription', 'EventsAPI');
    }
  });

  return router;
}

