/**
 * Fiches confidentielles de la cellule de suivi : ce que la cellule sait
 * d'une personne, en notes datées, sans rien à traiter. Les règles de
 * conservation sont dans wellbeingProfilePolicy.ts.
 *
 * Mêmes garde-fous que les dossiers : réservé à la cellule, connexion récente
 * pour lire, jamais sa propre fiche, lectures tracées au journal.
 */
import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { READ_ALERT_COOLDOWN_MS, forgetStale, isCaseSubject, shouldRecordView } from '../../../../services/staff/wellbeingPolicy.js';
import {
  PROFILE_EXTEND_REASON_MAX,
  PROFILE_NOTE_MAX,
  PROFILE_RETENTION_DEFAULT_MONTHS,
  PROFILE_SELF_REFUSAL,
  profileExtendError,
  profileNoteDeleteError,
  profileNoteExpiry,
} from '../../../../services/staff/wellbeingProfilePolicy.js';
import { openProfileHeader, openProfileNote, sealProfileNote, sealWellbeing } from '../../../../services/staff/wellbeingCrypto.js';
import {
  SNOWFLAKE_RE,
  actorName,
  audit,
  checkUnusualAccess,
  recordProfileOpening,
  resolveWellbeingRole,
  staleSession,
} from './wellbeingShared.js';

const NOT_FOUND = 'Fiche introuvable.';

/** Dernière consultation tracée, par serveur, par personne et par fiche. */
const lastViewAt = new Map<string, number>();

/** Personne visée par l'URL : un id invalide est introuvable, sa propre fiche est refusée en le disant. */
type Subject = { ok: true; id: string } | { ok: false; status: 403 | 404; error: string };

function subjectOf(c: Context): Subject {
  const subjectUserId = c.req.param('subjectUserId') ?? '';
  if (!SNOWFLAKE_RE.test(subjectUserId)) return { ok: false, status: 404, error: NOT_FOUND };
  if (isCaseSubject(subjectUserId, c.var.dashboardUser.userId)) return { ok: false, status: 403, error: PROFILE_SELF_REFUSAL };
  return { ok: true, id: subjectUserId };
}

export function createWellbeingProfilesRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing/profiles';
  const gate = guildRoute(client);

  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const stale = staleSession(c);
      if (stale) return stale;
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const profiles = await prisma.wellbeingProfile.findMany({
        where: { guildId, subjectUserId: { not: user.userId } },
        include: { notes: { select: { expiresAt: true } } },
        orderBy: { updatedAt: 'desc' },
      });
      return send(c, {
        profiles: profiles.map(({ notes, ...profile }) => ({
          ...openProfileHeader(profile),
          noteCount: notes.length,
          nextExpiry: notes.reduce<Date | null>((soonest, note) => (!soonest || note.expiresAt < soonest ? note.expiresAt : soonest), null),
        })),
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing profiles:', err);
      return fail(c, err, 'Erreur lors du chargement des fiches.', 'WellbeingAPI');
    }
  });

  router.get(`${base}/:subjectUserId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const stale = staleSession(c);
      if (stale) return stale;
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const subject = subjectOf(c);
      if (!subject.ok) return send(c, { error: subject.error }, subject.status);
      const subjectUserId = subject.id;
      const profile = await prisma.wellbeingProfile.findUnique({
        where: { guildId_subjectUserId: { guildId, subjectUserId } },
        include: { notes: { orderBy: { createdAt: 'asc' } } },
      });
      if (!profile) return send(c, { profile: null });

      const key = `${guildId}:${user.userId}:${profile.id}`;
      const now = new Date();
      const last = lastViewAt.get(key);
      if (shouldRecordView(last === undefined ? null : new Date(last), now)) {
        lastViewAt.set(key, now.getTime());
        forgetStale(lastViewAt, now.getTime(), READ_ALERT_COOLDOWN_MS);
        await audit(client, c, guildId, 'Consultation fiche Cellule de suivi', `Fiche ${profile.id} ouverte.`, 'Sécurité');
        recordProfileOpening(guildId, user.userId, now);
        await checkUnusualAccess(client, c, guildId, state.config, now);
      }
      return send(c, { profile: { ...openProfileHeader(profile), notes: profile.notes.map((note) => openProfileNote(note)) } });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error reading profile:', err);
      return fail(c, err, 'Erreur lors du chargement de la fiche.', 'WellbeingAPI');
    }
  });

  router.post(`${base}/:subjectUserId/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const subject = subjectOf(c);
      if (!subject.ok) return send(c, { error: subject.error }, subject.status);
      const subjectUserId = subject.id;
      const body = await readBody<{ content?: string; subjectName?: string; sensitive?: boolean }>(c);
      const sensitive = body?.sensitive === true;
      const content = bodyText(body?.content, PROFILE_NOTE_MAX);
      if (!content) return send(c, { error: 'Contenu requis.' }, 400);

      // La fiche naît avec sa première note ; son nom n'est fixé qu'à ce moment-là.
      const profile = await prisma.wellbeingProfile.upsert({
        where: { guildId_subjectUserId: { guildId, subjectUserId } },
        create: { guildId, subjectUserId, subjectName: sealWellbeing(guildId, bodyText(body?.subjectName, 100) || subjectUserId) },
        update: {},
      });
      const now = new Date();
      const note = await prisma.wellbeingProfileNote.create({
        data: {
          profileId: profile.id,
          authorId: user.userId,
          authorName: actorName(c),
          content: sealProfileNote(profile.id, content),
          sensitive,
          expiresAt: profileNoteExpiry(now, state.config?.profileRetentionMonths ?? PROFILE_RETENTION_DEFAULT_MONTHS, { subjectLeftAt: profile.subjectLeftAt, sensitive }),
        },
      });
      await audit(client, c, guildId, 'Note de fiche Cellule de suivi', `Note${sensitive ? ' sensible' : ''} ajoutée à la fiche ${profile.id}.`);
      return send(c, { note: openProfileNote(note) }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error adding profile note:', err);
      return fail(c, err, "Erreur lors de l'ajout de la note.", 'WellbeingAPI');
    }
  });

  router.post(`${base}/:subjectUserId/notes/:noteId/extend`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const subject = subjectOf(c);
      if (!subject.ok) return send(c, { error: subject.error }, subject.status);
      const subjectUserId = subject.id;
      const profile = await prisma.wellbeingProfile.findUnique({ where: { guildId_subjectUserId: { guildId, subjectUserId } } });
      if (!profile) return send(c, { error: NOT_FOUND }, 404);
      const existing = await prisma.wellbeingProfileNote.findFirst({ where: { id: c.req.param('noteId'), profileId: profile.id } });
      if (!existing) return send(c, { error: 'Note introuvable.' }, 404);
      const body = await readBody<{ reason?: string }>(c);
      const reason = bodyText(body?.reason, PROFILE_EXTEND_REASON_MAX);
      const error = profileExtendError(reason);
      if (error) return send(c, { error }, 400);

      const now = new Date();
      const note = await prisma.wellbeingProfileNote.update({
        where: { id: existing.id },
        data: {
          expiresAt: profileNoteExpiry(now, state.config?.profileRetentionMonths ?? PROFILE_RETENTION_DEFAULT_MONTHS, { subjectLeftAt: profile.subjectLeftAt, sensitive: existing.sensitive }),
          purgeWarnedAt: null,
          extendedAt: now,
          extendedById: user.userId,
          extendedByName: actorName(c),
          extendedReason: sealProfileNote(profile.id, reason),
        },
      });
      // Le motif reste dans la fiche, chiffré : le journal dit seulement qu'il existe.
      await audit(client, c, guildId, 'Prolongation note de fiche Cellule de suivi',
        `Note ${existing.id} de la fiche ${profile.id} gardée jusqu'au ${note.expiresAt.toISOString().slice(0, 10)}, motif consigné.`, 'Sécurité');
      return send(c, { note: openProfileNote(note) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error extending profile note:', err);
      return fail(c, err, 'Erreur lors de la prolongation de la note.', 'WellbeingAPI');
    }
  });

  router.delete(`${base}/:subjectUserId/notes/:noteId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const subject = subjectOf(c);
      if (!subject.ok) return send(c, { error: subject.error }, subject.status);
      const subjectUserId = subject.id;
      const profile = await prisma.wellbeingProfile.findUnique({ where: { guildId_subjectUserId: { guildId, subjectUserId } } });
      if (!profile) return send(c, { error: NOT_FOUND }, 404);
      const existing = await prisma.wellbeingProfileNote.findFirst({ where: { id: c.req.param('noteId'), profileId: profile.id } });
      if (!existing) return send(c, { error: 'Note introuvable.' }, 404);
      const error = profileNoteDeleteError(existing.authorId, user.userId);
      if (error) return send(c, { error }, 403);

      // Effacée pour de bon, sans corbeille : le journal garde seulement qu'elle a existé.
      await prisma.wellbeingProfileNote.delete({ where: { id: existing.id } });
      await audit(client, c, guildId, 'Effacement note de fiche Cellule de suivi',
        `Note ${existing.id} de la fiche ${profile.id} effacée par son auteur.`, 'Sécurité');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deleting profile note:', err);
      return fail(c, err, "Erreur lors de l'effacement de la note.", 'WellbeingAPI');
    }
  });

  return router;
}
