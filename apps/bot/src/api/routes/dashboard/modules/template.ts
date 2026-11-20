/** Routes dashboard du module `template`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, getOrCreateRuntime, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

export function createTemplateRouter(client: Client) {
  const router = new Hono();

  router.put('/api/dashboard/guilds/:guildId/template', ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ messageTemplate: string }>(c);
      const runtime = await getOrCreateRuntime(guildId);
      await prisma.dashboardSettings.update({
        where: { guildId },
        data: { messageTemplate: body?.messageTemplate || runtime.messageTemplate }
      });
      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Mise à jour template',
        context: getGuildName(client, guildId),
        module: 'Contenu',
        eventType: 'Manuel',
        details: 'Template de message éditorial mis à jour.',
        channelId: null
      });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('TemplateAPI', 'Error updating template:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du template', 'TemplateAPI');
    }
  });

  return router;
}
