/** Routes dashboard du module `import`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, getOrCreateRuntime, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

export function createImportRouter(client: Client) {
  const router = new Hono();

  router.post('/api/dashboard/guilds/:guildId/import', ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody(c);
      if (!body) return send(c, { error: 'Payload import invalide' }, 400);

      // Bloc `notifications` du fichier d'import : structure connue, mais le
      // fichier vient de l'utilisateur donc tous les champs sont optionnels.
      const notifications = (body?.notifications ?? {}) as Partial<{
        email: string;
        emailEnabled: boolean;
        cloudBackup: boolean;
        debugLog: boolean;
        killSwitchEnabled: boolean;
        severityByModule: unknown;
      }>;

      const runtime = await getOrCreateRuntime(guildId);
      await prisma.dashboardSettings.update({
        where: { guildId },
        data: {
          email: notifications.email ?? runtime.email,
          emailEnabled: !!notifications.emailEnabled,
          cloudBackup: !!notifications.cloudBackup,
          debugLog: !!notifications.debugLog,
          killSwitchEnabled: !!notifications.killSwitchEnabled,
          severityByModule: notifications.severityByModule ?? runtime.severityByModule,
          messageTemplate: body.messageTemplate ?? runtime.messageTemplate
        }
      });

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Import dashboard',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: 'Configuration importée depuis un fichier JSON.',
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('ImportAPI', 'Error importing state:', err);
      return fail(c, err, "Erreur lors de l'importation de la configuration", 'ImportAPI');
    }
  });

  return router;
}
