/**
 * Succès de carte de rang attribués à la main (`/api/admin/achievements/*`).
 *
 * L'accès administrateur bot est vérifié en amont par `handleAdminRoutes`.
 */

import type { Client } from 'discord.js';
import type { Context } from 'hono';
import { HttpError, type AuthClaims } from '../../shared.js';
import { readBody, requestIp, send } from '../../hono/dashboard/kit.js';

const reply = (c: Context, status: number, data: unknown) => send(c, data, status);
import { logger } from '../../../utils/logger.js';
import { getRankCardAchievement } from '@kotbo/shared';
import {
  grantManualAchievement,
  listManualAchievementHolders,
  ManualAchievementError,
  revokeManualAchievement,
} from '../../../services/progression/achievementService.js';
import { invalidateRankCardCustomization } from '../../../services/progression/rankCardService.js';
import { recordAdminAudit } from '../../../services/system/adminAuditService.js';

const DISCORD_ID = /^\d{17,20}$/;

type DiscordProfile = { username: string | null; avatarUrl: string | null };

async function resolveProfiles(client: Client, userIds: string[]): Promise<Record<string, DiscordProfile>> {
  const unique = [...new Set(userIds)];
  const entries = await Promise.all(unique.map(async (userId) => {
    try {
      const user = await client.users.fetch(userId);
      return [userId, { username: user.username, avatarUrl: user.displayAvatarURL({ size: 64 }) }] as const;
    } catch {
      return [userId, { username: null, avatarUrl: null }] as const;
    }
  }));
  return Object.fromEntries(entries);
}

function sendError(c: Context, err: unknown, fallback: string): Response {
  if (err instanceof ManualAchievementError) {
    return reply(c, err.status, { error: err.message });
  }
  if (err instanceof HttpError) {
    return reply(c, err.statusCode, { error: err.message });
  }
  logger.error('AdminAPI', fallback, err);
  return reply(c, 500, { error: fallback });
}

export async function handleAdminAchievementRoutes(
  c: Context,
  parts: string[],
  client: Client,
  user: AuthClaims,
): Promise<Response | null> {
  const method = c.req.method;

  // GET /api/admin/achievements - détenteurs de chaque succès manuel
  if (parts.length === 3 && method === 'GET') {
    try {
      const holders = await listManualAchievementHolders();
      const profiles = await resolveProfiles(client, Object.values(holders).flatMap((list) => list.flatMap((holder) =>
        holder.grantedBy ? [holder.userId, holder.grantedBy] : [holder.userId])));
      return reply(c, 200, { holders, profiles });
    } catch (err) {
      return sendError(c, err, 'Erreur lors du chargement des succès attribués.');
    }

  }

  // POST /api/admin/achievements/grants - { userId, achievementId, note? }
  if (parts[3] === 'grants' && parts.length === 4 && method === 'POST') {
    try {
      const body = await readBody<{ userId?: unknown; achievementId?: unknown; note?: unknown }>(c);
      const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
      const achievementId = typeof body?.achievementId === 'string' ? body.achievementId : '';
      if (!DISCORD_ID.test(userId)) {
        return reply(c, 400, { error: 'Identifiant Discord invalide.' });

      }

      // Un identifiant mal copié donnerait un badge à un compte inexistant, que
      // personne ne verrait jamais dans la liste sous un nom reconnaissable.
      const profile = (await resolveProfiles(client, [userId]))[userId];
      if (!profile.username) {
        return reply(c, 404, { error: 'Aucun compte Discord ne correspond à cet identifiant.' });

      }

      const holder = await grantManualAchievement(userId, achievementId, user.userId, body?.note);
      await invalidateRankCardCustomization(userId);

      const label = getRankCardAchievement(achievementId)?.label.fr ?? achievementId;
      await recordAdminAudit({
        actorId: user.userId,
        actorName: user.username,
        action: 'achievement.grant',
        targetType: 'user',
        targetId: userId,
        summary: `Succès « ${label} » attribué à ${profile.username}`,
        metadata: { achievementId, note: holder.note },
        ip: requestIp(c),
      });

      const profiles = await resolveProfiles(client, [user.userId]);
      return reply(c, 201, { holder, profiles: { ...profiles, [userId]: profile } });
    } catch (err) {
      return sendError(c, err, "Erreur lors de l'attribution du succès.");
    }

  }

  // DELETE /api/admin/achievements/grants/:achievementId/:userId
  if (parts[3] === 'grants' && parts.length === 6 && method === 'DELETE') {
    const achievementId = parts[4];
    const userId = parts[5];
    if (!DISCORD_ID.test(userId)) {
      return reply(c, 400, { error: 'Identifiant Discord invalide.' });

    }

    try {
      await revokeManualAchievement(userId, achievementId);
      await invalidateRankCardCustomization(userId);

      const label = getRankCardAchievement(achievementId)?.label.fr ?? achievementId;
      await recordAdminAudit({
        actorId: user.userId,
        actorName: user.username,
        action: 'achievement.revoke',
        targetType: 'user',
        targetId: userId,
        summary: `Succès « ${label} » retiré à ${userId}`,
        metadata: { achievementId },
        ip: requestIp(c),
      });

      return reply(c, 200, { ok: true });
    } catch (err) {
      return sendError(c, err, 'Erreur lors du retrait du succès.');
    }

  }

  return null;
}
