import { Hono, type Context } from 'hono';
import { PermissionFlagsBits, type Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { safePushAudit, getGuildName } from '../../shared.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import {
  addImagesToCatalog,
  decideVisionReview,
  invalidateVisionCache,
  MAX_LISTS_PER_GUILD,
} from '../../../services/moderation/visionService.js';
import { normalizeAutoSanction } from '../../../services/moderation/autoSanction.js';
import { provisionJail } from '../../../services/moderation/jailService.js';

/** Image envoyée en base64 : le navigateur la réduit avant l'envoi. */
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

function cleanName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim().slice(0, 60) : '';
  return name.length > 0 ? name : null;
}

function cleanDuration(value: unknown): number | null {
  if (value === null || value === '' || value === undefined) return null;
  const minutes = Math.floor(Number(value));
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 365 * 24 * 60) : null;
}

function cleanChannelId(value: unknown): string | null {
  return typeof value === 'string' && /^\d{17,20}$/.test(value) ? value : null;
}

/**
 * Routes Kotbo Vision et Jail, sous /raid-protection :
 *   GET    vision                     listes, revues en attente, compteurs
 *   POST   vision/lists               créer une liste
 *   PATCH  vision/lists/:id           modifier une liste
 *   DELETE vision/lists/:id           supprimer une liste et ses images
 *   GET    vision/images?list=:id     images d'une liste (ou du serveur)
 *   POST   vision/images              ajouter une image (base64)
 *   PATCH  vision/images/:id          interdire / autoriser une image
 *   DELETE vision/images/:id          retirer une image
 *   POST   vision/reviews/:id         trancher une revue
 *   POST   jail/provision               créer ou réparer le rôle Jail
 *   GET    jail/members                 membres en Jail
 */
export function createVisionRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/raid-protection';
  const gate = guildRoute(client);

  const audit = (c: Context, action: string, details = '') => {
    const guildId = c.req.param('guildId')!;
    const user = c.var.dashboardUser;
    return safePushAudit(guildId, {
      user: `${user.username ?? 'Utilisateur'} (${user.userId})`,
      action,
      context: getGuildName(client, guildId),
      module: 'Kotbo Vision',
      eventType: 'Manuel',
      details,
      channelId: null,
    }, 'VisionAPI');
  };

  router.onError((err, c) => {
    logger.error('VisionAPI', `Erreur ${c.req.method} ${c.req.path}`, err);
    return fail(c, err, 'Erreur Kotbo Vision', 'VisionAPI');
  });

  // ── Jail ──────────────────────────────────────────────────────────────
  router.post(`${base}/jail/provision`, ...gate, async (c) => {
    const guild = client.guilds.cache.get(c.req.param('guildId'));
    if (!guild) return send(c, { error: 'Serveur introuvable' }, 404);
    if (!guild.members.me?.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels])) {
      return send(c, { error: 'Kotbo a besoin des permissions « Gérer les rôles » et « Gérer les salons ».' }, 400);
    }
    const body = await readBody<{ createChannel?: boolean }>(c);
    const result = await provisionJail(guild, { createChannel: body?.createChannel === true });
    await audit(c, 'Rôle Jail provisionné', `Rôle ${result.roleId}, ${result.channelsUpdated} salon(s) masqué(s)`);
    return send(c, result);
  });

  router.get(`${base}/jail/members`, ...gate, async (c) => {
    const jails = await prisma.memberJail.findMany({ where: { guildId: c.req.param('guildId') }, orderBy: { createdAt: 'desc' }, take: 200 });
    return send(c, { jails });
  });

  // ── Vue d'ensemble ────────────────────────────────────────────────────
  router.get(`${base}/vision`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const [lists, counts, reviews, guildCount, globalCount, blocked] = await Promise.all([
      prisma.visionList.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
      prisma.scamImageHash.groupBy({ by: ['listId'], where: { guildId, status: 'BLOCKED' }, _count: { _all: true } }),
      prisma.visionReview.findMany({ where: { guildId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.scamImageHash.count({ where: { guildId, listId: null, status: 'BLOCKED' } }),
      prisma.scamImageHash.count({ where: { guildId: null, status: 'BLOCKED' } }),
      prisma.scamImageHash.aggregate({ where: { OR: [{ guildId }, { guildId: null }] }, _sum: { hits: true } }),
    ]);
    const countByList = new Map(counts.map((row) => [row.listId, row._count._all]));
    return send(c, {
      lists: lists.map((l) => ({ ...l, imageCount: countByList.get(l.id) ?? 0 })),
      reviews,
      guildCatalogCount: guildCount,
      globalCatalogCount: globalCount,
      blockedTotal: blocked._sum.hits ?? 0,
      maxLists: MAX_LISTS_PER_GUILD,
    });
  });

  // ── Listes ────────────────────────────────────────────────────────────
  router.post(`${base}/vision/lists`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readBody(c);
    const name = cleanName(body?.name);
    if (!name) return send(c, { error: 'Nom de liste requis' }, 400);
    if ((await prisma.visionList.count({ where: { guildId } })) >= MAX_LISTS_PER_GUILD) {
      return send(c, { error: `${MAX_LISTS_PER_GUILD} listes au maximum par serveur.` }, 409);
    }
    const list = await prisma.visionList.create({
      data: {
        guildId,
        name,
        reviewChannelId: cleanChannelId(body?.reviewChannelId),
        sanction: body?.sanction ? normalizeAutoSanction(body.sanction, 'TIMEOUT') : null,
        durationMin: cleanDuration(body?.durationMin),
        createdBy: c.var.dashboardUser.userId,
      },
    }).catch((err) => {
      if ((err as { code?: string }).code === 'P2002') return null;
      throw err;
    });
    if (!list) return send(c, { error: 'Une liste porte déjà ce nom.' }, 409);
    invalidateVisionCache(guildId);
    await audit(c, 'Liste Kotbo Vision créée', name);
    return send(c, { list: { ...list, imageCount: 0 } }, 201);
  });

  router.patch(`${base}/vision/lists/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const body = await readBody(c);
    const data: Record<string, unknown> = {};
    if (body && 'name' in body) {
      const name = cleanName(body.name);
      if (!name) return send(c, { error: 'Nom de liste requis' }, 400);
      data.name = name;
    }
    if (body && 'enabled' in body) data.enabled = body.enabled === true;
    if (body && 'reviewChannelId' in body) data.reviewChannelId = cleanChannelId(body.reviewChannelId);
    if (body && 'sanction' in body) data.sanction = body.sanction ? normalizeAutoSanction(body.sanction, 'TIMEOUT') : null;
    if (body && 'durationMin' in body) data.durationMin = cleanDuration(body.durationMin);
    const updated = await prisma.visionList.updateMany({ where: { id, guildId }, data });
    if (updated.count === 0) return send(c, { error: 'Liste introuvable' }, 404);
    invalidateVisionCache(guildId);
    return send(c, { list: await prisma.visionList.findUnique({ where: { id } }) });
  });

  router.delete(`${base}/vision/lists/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const deleted = await prisma.visionList.deleteMany({ where: { id, guildId } });
    if (deleted.count === 0) return send(c, { error: 'Liste introuvable' }, 404);
    invalidateVisionCache(guildId);
    await audit(c, 'Liste Kotbo Vision supprimée', id);
    return send(c, { success: true });
  });

  // ── Images ────────────────────────────────────────────────────────────
  router.get(`${base}/vision/images`, ...gate, async (c) => {
    const listParam = c.req.query('list');
    const listId = listParam && listParam !== 'server' ? listParam : null;
    const images = await prisma.scamImageHash.findMany({
      where: { guildId: c.req.param('guildId'), listId },
      select: { id: true, filename: true, thumb: true, source: true, status: true, hits: true, lastSeenAt: true, parentId: true, createdAt: true, addedBy: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return send(c, { images });
  });

  router.post(`${base}/vision/images`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readBody(c);
    const listId = typeof body?.listId === 'string' ? body.listId : null;
    if (listId && !(await prisma.visionList.findFirst({ where: { id: listId, guildId }, select: { id: true } }))) {
      return send(c, { error: 'Liste introuvable' }, 404);
    }
    const raw = typeof body?.data === 'string' ? body.data.replace(/^data:[^;]+;base64,/, '') : '';
    const buffer = Buffer.from(raw, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
      return send(c, { error: 'Image absente ou trop lourde (6 Mo au plus).' }, 400);
    }
    const name = typeof body?.name === 'string' ? body.name.slice(0, 200) : 'image';
    const result = await addImagesToCatalog({ guildId, listId, images: [{ buffer, name }], addedBy: c.var.dashboardUser.userId });
    if (result.added + result.variants > 0) await audit(c, 'Image ajoutée à Kotbo Vision', `${name}${listId ? ` (liste ${listId})` : ''}`);
    return send(c, result);
  });

  router.patch(`${base}/vision/images/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readBody(c);
    const status = body?.status === 'ALLOWED' ? 'ALLOWED' : 'BLOCKED';
    const updated = await prisma.scamImageHash.updateMany({ where: { id: c.req.param('id'), guildId }, data: { status } });
    if (updated.count === 0) return send(c, { error: 'Image introuvable' }, 404);
    invalidateVisionCache(guildId);
    return send(c, { success: true });
  });

  router.delete(`${base}/vision/images/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    // Les images globales ne se suppriment pas d'ici : seul le serveur
    // propriétaire d'une entrée peut la retirer.
    const deleted = await prisma.scamImageHash.deleteMany({ where: { id, guildId } });
    if (deleted.count === 0) return send(c, { error: 'Image introuvable' }, 404);
    await prisma.scamImageHash.updateMany({ where: { parentId: id, guildId }, data: { parentId: null } });
    invalidateVisionCache(guildId);
    await audit(c, 'Image retirée de Kotbo Vision', id);
    return send(c, { success: true });
  });

  // ── Revues ────────────────────────────────────────────────────────────
  router.post(`${base}/vision/reviews/:id`, ...gate, async (c) => {
    const id = c.req.param('id');
    const review = await prisma.visionReview.findFirst({ where: { id, guildId: c.req.param('guildId') }, select: { id: true } });
    if (!review) return send(c, { error: 'Revue introuvable' }, 404);
    const body = await readBody(c);
    const confirm = body?.decision === 'confirm';
    const decision = await decideVisionReview(client, id, c.var.dashboardUser.userId, confirm);
    if (!decision.ok) return send(c, { error: decision.reason }, 409);
    await audit(c, confirm ? 'Image Kotbo Vision confirmée' : 'Image Kotbo Vision écartée', id);
    return send(c, decision);
  });

  return router;
}
