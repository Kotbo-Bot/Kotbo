import { Hono } from 'hono';
import type { Client } from 'discord.js';
/** Routes dashboard du module `banned-words`. */
import { invalidateBannedWordsCache } from '../../../../services/moderation/bannedWordsService.js';
import { isReservedByNicknameModeration } from '../../../../services/moderation/nicknameModerationService.js';
import prisma from '../../../../utils/db.js';
import { errorCode } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { broadcastDashboardStateChange, getGuildName, pushAudit } from '../../../shared.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
export function createBannedWordsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/banned-words`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [globalWords, guildWords] = await Promise.all([
        prisma.bannedWord.findMany({
          where: { guildId: null },
          select: { id: true, word: true, category: true, enabled: true, guildId: true },
          orderBy: [{ category: 'asc' }, { word: 'asc' }],
        }),
        prisma.bannedWord.findMany({
          where: { guildId },
          select: { id: true, word: true, category: true, enabled: true, guildId: true },
          orderBy: [{ category: 'asc' }, { word: 'asc' }],
        }),
      ]);
      return send(c, { global: globalWords, custom: guildWords });
    } catch (err) {
      logger.error('BannedWordsAPI', 'GET banned-words error:', err);
      return fail(c, err, 'Erreur lors de la récupération des mots bannis', 'BannedWordsAPI');
    }
  });

  router.post(`${base}/banned-words`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{ word: string; category?: string }>(c);
      if (!body?.word || typeof body.word !== 'string' || !body.word.trim()) {
        return send(c, { error: 'Champ `word` requis' }, 400);
      }

      const cleanWord = body.word.trim().toLowerCase().slice(0, 100);

      if (isReservedByNicknameModeration(cleanWord)) {
        return send(c, { error: 'Ce mot ne peut pas être banni (réservé par le système de modération)' }, 400);
      }

      const category = ['custom', 'racism', 'threat', 'sexual', 'lgbtphobia', 'hate', 'insult'].includes(body.category ?? '')
        ? body.category!
        : 'custom';

      const guildData = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { nicknameModerationWhitelist: true },
      });
      const whitelist = guildData?.nicknameModerationWhitelist ?? [];
      if (whitelist.includes(cleanWord)) {
        return send(c, {
          error: `Impossible de bannir ce mot car il est déjà présent dans la liste des pseudos autorisés (whitelist) : ${cleanWord}`,
        }, 400);
      }

      const created = await prisma.bannedWord.create({
        data: { guildId, word: cleanWord, category },
      });

      invalidateBannedWordsCache(guildId);

      const guildDb = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { nickModDiscordAutoModSync: true }
      });
      if (guildDb?.nickModDiscordAutoModSync) {
        void import('../../../../services/moderation/autoModService.js')
          .then(({ syncDiscordAutoModProfileRule }) => syncDiscordAutoModProfileRule(client, guildId))
          .catch((syncErr) => {
            logger.error('BannedWordsAPI', `Erreur lors de la synchronisation AutoMod Pseudos pour ${guildId}:`, syncErr);
          });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Ajout mot banni',
        context: getGuildName(client, guildId),
        module: 'Mots bannis',
        eventType: 'Manuel',
        details: `Mot "${cleanWord}" ajouté (catégorie: ${category})`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'banned_words_updated');

      return send(c, { ok: true, id: created.id }, 201);
    } catch (err: unknown) {
      if (errorCode(err) === 'P2002') {
        return send(c, { error: 'Ce mot existe déjà sur ce serveur' }, 409);
      } else {
        logger.error('BannedWordsAPI', 'POST banned-words error:', err);
        return send(c, { error: "Erreur lors de l'ajout du mot" }, 500);
      }
    }
  });

  router.patch(`${base}/banned-words/:wordId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const wordId = c.req.param('wordId');
    try {
      const body = await readBody<{ enabled: boolean }>(c);
      if (!body || typeof body.enabled !== 'boolean') {
        return send(c, { error: 'Champ `enabled` requis (boolean)' }, 400);
      }

      const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId } });
      if (!existing) {
        return send(c, { error: 'Mot introuvable' }, 404);
      }

      if (body.enabled) {
        const guildData = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { nicknameModerationWhitelist: true },
        });
        const whitelist = guildData?.nicknameModerationWhitelist ?? [];
        if (whitelist.includes(existing.word.toLowerCase())) {
          return send(c, {
            error: `Impossible d'activer ce mot car il est déjà présent dans la liste des pseudos autorisés (whitelist) : ${existing.word}`,
          }, 400);
        }
      }

      await prisma.bannedWord.update({ where: { id: wordId }, data: { enabled: body.enabled } });

      invalidateBannedWordsCache(guildId);

      const guildDb = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { nickModDiscordAutoModSync: true }
      });
      if (guildDb?.nickModDiscordAutoModSync) {
        void import('../../../../services/moderation/autoModService.js')
          .then(({ syncDiscordAutoModProfileRule }) => syncDiscordAutoModProfileRule(client, guildId))
          .catch((syncErr) => {
            logger.error('BannedWordsAPI', `Erreur lors de la synchronisation AutoMod Pseudos pour ${guildId}:`, syncErr);
          });
      }

      broadcastDashboardStateChange(guildId, 'banned_words_updated');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('BannedWordsAPI', 'PATCH banned-words error:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'BannedWordsAPI');
    }
  });

  router.delete(`${base}/banned-words/:wordId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    const wordId = c.req.param('wordId');
    try {
      const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId } });
      if (!existing) {
        return send(c, { error: 'Mot introuvable ou non modifiable' }, 404);
      }

      await prisma.bannedWord.delete({ where: { id: wordId } });

      invalidateBannedWordsCache(guildId);

      const guildDb = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { nickModDiscordAutoModSync: true }
      });
      if (guildDb?.nickModDiscordAutoModSync) {
        void import('../../../../services/moderation/autoModService.js')
          .then(({ syncDiscordAutoModProfileRule }) => syncDiscordAutoModProfileRule(client, guildId))
          .catch((syncErr) => {
            logger.error('BannedWordsAPI', `Erreur lors de la synchronisation AutoMod Pseudos pour ${guildId}:`, syncErr);
          });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression mot banni',
        context: getGuildName(client, guildId),
        module: 'Mots bannis',
        eventType: 'Manuel',
        details: `Mot "${existing.word}" supprimé`,
        channelId: null,
      });

      broadcastDashboardStateChange(guildId, 'banned_words_updated');

      return send(c, { ok: true });
    } catch (err) {
      logger.error('BannedWordsAPI', 'DELETE banned-words error:', err);
      return fail(c, err, 'Erreur lors de la suppression', 'BannedWordsAPI');
    }
  });

  return router;
}

