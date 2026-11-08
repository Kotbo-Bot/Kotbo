import { IncomingMessage, ServerResponse } from 'node:http';
import { Client, PermissionFlagsBits } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, safePushAudit, getGuildName, type AuthClaims } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
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
 */
export async function handleVisionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string
): Promise<boolean> {
  const sub = parts[5];
  if (sub !== 'vision' && sub !== 'jail') return false;
  const method = req.method;
  const resource = parts[6];
  const id = parts[7];
  const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
  const audit = (action: string, details = '') =>
    safePushAudit(guildId, { user: auditUser, action, context: getGuildName(client, guildId), module: 'Kotbo Vision', eventType: 'Manuel', details, channelId: null }, 'VisionAPI');

  try {
    // ── Jail ──────────────────────────────────────────────────────────────
    if (sub === 'jail') {
      if (resource === 'provision' && method === 'POST') {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return json(res, 404, { error: 'Serveur introuvable' }), true;
        if (!guild.members.me?.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels])) {
          json(res, 400, { error: 'Kotbo a besoin des permissions « Gérer les rôles » et « Gérer les salons ».' });
          return true;
        }
        const body = await readJsonBody<{ createChannel?: boolean }>(req);
        const result = await provisionJail(guild, { createChannel: body?.createChannel === true });
        await audit('Rôle Jail provisionné', `Rôle ${result.roleId}, ${result.channelsUpdated} salon(s) masqué(s)`);
        json(res, 200, result);
        return true;
      }
      if (resource === 'members' && method === 'GET') {
        const jails = await prisma.memberJail.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' }, take: 200 });
        json(res, 200, { jails });
        return true;
      }
      return false;
    }

    // ── Vue d'ensemble ────────────────────────────────────────────────────
    if (!resource && method === 'GET') {
      const [lists, counts, reviews, guildCount, globalCount, blocked] = await Promise.all([
        prisma.visionList.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
        prisma.scamImageHash.groupBy({ by: ['listId'], where: { guildId, status: 'BLOCKED' }, _count: { _all: true } }),
        prisma.visionReview.findMany({ where: { guildId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 50 }),
        prisma.scamImageHash.count({ where: { guildId, listId: null, status: 'BLOCKED' } }),
        prisma.scamImageHash.count({ where: { guildId: null, status: 'BLOCKED' } }),
        prisma.scamImageHash.aggregate({ where: { OR: [{ guildId }, { guildId: null }] }, _sum: { hits: true } }),
      ]);
      const countByList = new Map(counts.map((c) => [c.listId, c._count._all]));
      json(res, 200, {
        lists: lists.map((l) => ({ ...l, imageCount: countByList.get(l.id) ?? 0 })),
        reviews,
        guildCatalogCount: guildCount,
        globalCatalogCount: globalCount,
        blockedTotal: blocked._sum.hits ?? 0,
        maxLists: MAX_LISTS_PER_GUILD,
      });
      return true;
    }

    // ── Listes ────────────────────────────────────────────────────────────
    if (resource === 'lists') {
      if (!id && method === 'POST') {
        const body = await readJsonBody(req);
        const name = cleanName(body?.name);
        if (!name) return json(res, 400, { error: 'Nom de liste requis' }), true;
        if ((await prisma.visionList.count({ where: { guildId } })) >= MAX_LISTS_PER_GUILD) {
          json(res, 409, { error: `${MAX_LISTS_PER_GUILD} listes au maximum par serveur.` });
          return true;
        }
        const list = await prisma.visionList.create({
          data: {
            guildId,
            name,
            reviewChannelId: cleanChannelId(body?.reviewChannelId),
            sanction: body?.sanction ? normalizeAutoSanction(body.sanction, 'TIMEOUT') : null,
            durationMin: cleanDuration(body?.durationMin),
            createdBy: user.userId,
          },
        }).catch((err) => {
          if ((err as { code?: string }).code === 'P2002') return null;
          throw err;
        });
        if (!list) return json(res, 409, { error: 'Une liste porte déjà ce nom.' }), true;
        invalidateVisionCache(guildId);
        await audit('Liste Kotbo Vision créée', name);
        json(res, 201, { list: { ...list, imageCount: 0 } });
        return true;
      }
      if (id && method === 'PATCH') {
        const body = await readJsonBody(req);
        const data: Record<string, unknown> = {};
        if (body && 'name' in body) {
          const name = cleanName(body.name);
          if (!name) return json(res, 400, { error: 'Nom de liste requis' }), true;
          data.name = name;
        }
        if (body && 'enabled' in body) data.enabled = body.enabled === true;
        if (body && 'reviewChannelId' in body) data.reviewChannelId = cleanChannelId(body.reviewChannelId);
        if (body && 'sanction' in body) data.sanction = body.sanction ? normalizeAutoSanction(body.sanction, 'TIMEOUT') : null;
        if (body && 'durationMin' in body) data.durationMin = cleanDuration(body.durationMin);
        const updated = await prisma.visionList.updateMany({ where: { id, guildId }, data });
        if (updated.count === 0) return json(res, 404, { error: 'Liste introuvable' }), true;
        invalidateVisionCache(guildId);
        json(res, 200, { list: await prisma.visionList.findUnique({ where: { id } }) });
        return true;
      }
      if (id && method === 'DELETE') {
        const deleted = await prisma.visionList.deleteMany({ where: { id, guildId } });
        if (deleted.count === 0) return json(res, 404, { error: 'Liste introuvable' }), true;
        invalidateVisionCache(guildId);
        await audit('Liste Kotbo Vision supprimée', id);
        json(res, 200, { success: true });
        return true;
      }
    }

    // ── Images ────────────────────────────────────────────────────────────
    if (resource === 'images') {
      if (!id && method === 'GET') {
        const listParam = url.searchParams.get('list');
        const listId = listParam && listParam !== 'server' ? listParam : null;
        const images = await prisma.scamImageHash.findMany({
          where: { guildId, listId },
          select: { id: true, filename: true, thumb: true, source: true, status: true, hits: true, lastSeenAt: true, parentId: true, createdAt: true, addedBy: true },
          orderBy: { createdAt: 'desc' },
          take: 300,
        });
        json(res, 200, { images });
        return true;
      }
      if (!id && method === 'POST') {
        const body = await readJsonBody(req);
        const listId = typeof body?.listId === 'string' ? body.listId : null;
        if (listId && !(await prisma.visionList.findFirst({ where: { id: listId, guildId }, select: { id: true } }))) {
          json(res, 404, { error: 'Liste introuvable' });
          return true;
        }
        const raw = typeof body?.data === 'string' ? body.data.replace(/^data:[^;]+;base64,/, '') : '';
        const buffer = Buffer.from(raw, 'base64');
        if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
          json(res, 400, { error: 'Image absente ou trop lourde (6 Mo au plus).' });
          return true;
        }
        const name = typeof body?.name === 'string' ? body.name.slice(0, 200) : 'image';
        const result = await addImagesToCatalog({ guildId, listId, images: [{ buffer, name }], addedBy: user.userId });
        if (result.added + result.variants > 0) await audit('Image ajoutée à Kotbo Vision', `${name}${listId ? ` (liste ${listId})` : ''}`);
        json(res, 200, result);
        return true;
      }
      if (id && method === 'PATCH') {
        const body = await readJsonBody(req);
        const status = body?.status === 'ALLOWED' ? 'ALLOWED' : 'BLOCKED';
        const updated = await prisma.scamImageHash.updateMany({ where: { id, guildId }, data: { status } });
        if (updated.count === 0) return json(res, 404, { error: 'Image introuvable' }), true;
        invalidateVisionCache(guildId);
        json(res, 200, { success: true });
        return true;
      }
      if (id && method === 'DELETE') {
        // Les images globales ne se suppriment pas d'ici : seul le serveur
        // propriétaire d'une entrée peut la retirer.
        const deleted = await prisma.scamImageHash.deleteMany({ where: { id, guildId } });
        if (deleted.count === 0) return json(res, 404, { error: 'Image introuvable' }), true;
        await prisma.scamImageHash.updateMany({ where: { parentId: id, guildId }, data: { parentId: null } });
        invalidateVisionCache(guildId);
        await audit('Image retirée de Kotbo Vision', id);
        json(res, 200, { success: true });
        return true;
      }
    }

    // ── Revues ────────────────────────────────────────────────────────────
    if (resource === 'reviews' && id && method === 'POST') {
      const review = await prisma.visionReview.findFirst({ where: { id, guildId }, select: { id: true } });
      if (!review) return json(res, 404, { error: 'Revue introuvable' }), true;
      const body = await readJsonBody(req);
      const confirm = body?.decision === 'confirm';
      const decision = await decideVisionReview(client, id, user.userId, confirm);
      if (!decision.ok) return json(res, 409, { error: decision.reason }), true;
      await audit(confirm ? 'Image Kotbo Vision confirmée' : 'Image Kotbo Vision écartée', id);
      json(res, 200, decision);
      return true;
    }
  } catch (err) {
    logger.error('VisionAPI', `Erreur ${method} ${parts.slice(5).join('/')}`, err);
    jsonFailure(res, err, 'Erreur Kotbo Vision', 'VisionAPI');
    return true;
  }
  return false;
}
