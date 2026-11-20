/** Routes dashboard du module `command-access`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { normalizeCommandRestrictions } from '../../../../utils/commandAccess.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit, resolveFeatureAccessMap } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

export function createCommandAccessRouter(client: Client) {
  const router = new Hono();

  router.put('/api/dashboard/guilds/:guildId/command-access', ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.var.dashboardUser.userId;
    const access = c.var.effectiveAccess;
    try {
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
      const roleIds = member?.roles.cache.map((role) => role.id) ?? [];
      const featureAccess = await resolveFeatureAccessMap(client, guildId, access, userId, roleIds);

      if (!featureAccess.commands?.canConfigure && !access.canManageSettings) {
        return send(c, { error: 'Accès refusé. Permissions insuffisantes.' }, 403);
      }

      const body = await readBody<{ commandRestrictions?: unknown }>(c);
      if (!body) return send(c, { error: 'Payload de restrictions invalide' }, 400);

      const commandRestrictions = normalizeCommandRestrictions(body.commandRestrictions);
      await prisma.dashboardSettings.update({
        where: { guildId },
        data: { commandRestrictions }
      });

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Sauvegarde restrictions commandes',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: `${commandRestrictions.length} règle(s) de commande enregistrée(s).`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('CommandAccessAPI', 'Error updating command restrictions:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des restrictions', 'CommandAccessAPI');
    }
  });

  return router;
}
