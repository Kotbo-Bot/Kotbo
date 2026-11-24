import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { sanitizePublicTheme } from '../../../utils/publicTheme.js';
import { pushAudit, getGuildName } from '../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

const LOG = 'PublicThemeAPI';

/** Habillage des pages publiques : lecture pour le staff, écriture réservée aux administrateurs. */
export function createPublicThemeRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/public-theme';
  const adminOnly = createMiddleware(async (c, next) => {
    if (c.req.method !== 'GET' && !c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Réservé aux administrateurs du dashboard.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), adminOnly] as const;

  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { publicTheme: true } });
      return send(c, { theme: sanitizePublicTheme(guild?.publicTheme) });
    } catch (err) {
      return fail(c, err, "Erreur lors de la lecture de l'habillage", LOG);
    }
  });

  router.put(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ theme?: unknown }>(c);
      const theme = sanitizePublicTheme(body?.theme);
      const value = (theme ?? Prisma.JsonNull) as Prisma.InputJsonValue;
      await prisma.guild.upsert({
        where: { id: guildId },
        create: { id: guildId, publicTheme: value },
        update: { publicTheme: value },
      });
      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: theme ? 'Habillage des pages publiques modifié' : 'Habillage des pages publiques réinitialisé',
        context: getGuildName(client, guildId),
        module: 'Pages publiques',
        eventType: 'Settings',
        details: theme ? `Clés : ${Object.keys(theme).join(', ')}` : 'Retour à l’apparence par défaut.',
        channelId: null,
      }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));
      return send(c, { theme });
    } catch (err) {
      return fail(c, err, "Erreur lors de l'enregistrement de l'habillage", LOG);
    }
  });

  return router;
}
