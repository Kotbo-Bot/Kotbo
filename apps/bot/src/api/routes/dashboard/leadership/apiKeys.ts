import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import {
  getStaffMember,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  createAPIKey,
  getAPIKeys,
  deleteAPIKey,
  hashAPIKey,
  generateAPIKey,
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';

export function createApiKeysRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.post(`${base}/api-keys`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        name?: string;
        permissions?: string[];
      }>(c);

      const { fullKey, displayKey } = generateAPIKey();
      const keyHash = hashAPIKey(fullKey);

      const apiKey = await createAPIKey(
        guildId,
        user.userId,
        keyHash,
        displayKey,
        body?.name || 'Mon clé API',
        body?.permissions || []
      );

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Création clé API',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Clé API créée: ${displayKey}`,
        channelId: null
      });

      return send(c, {
        id: apiKey.id,
        fullKey,
        displayKey: apiKey.displayKey,
        name: apiKey.name,
        permissions: apiKey.permissions,
      }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error creating API key:', err);
      return fail(c, err, 'Erreur lors de la création de la clé API', 'StaffAPI');
    }
  });

  router.get(`${base}/api-keys`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const keys = await getAPIKeys(guildId, user.userId);
      return send(c, { keys });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting API keys:', err);
      return fail(c, err, 'Erreur lors de la récupération des clés API', 'StaffAPI');
    }
  });

  router.delete(`${base}/api-keys/:keyId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const keyId = c.req.param('keyId');
    try {
      // Filtrée par serveur : un admin d'ici supprimait sinon la clé d'un autre serveur.
      const key = await prisma.aPIKey.findFirst({ where: { id: keyId, guildId } });
      if (!key) {
        return send(c, { error: 'Clé API introuvable' }, 404);
      }
      const requesterStaff = await getStaffMember(guildId, user.userId);
      if (!requesterStaff || (key.createdByUserId !== requesterStaff.id && access.level !== 'admin')) {
        return send(c, { error: 'Non autorisé à supprimer cette clé API' }, 403);
      }

      await deleteAPIKey(guildId, keyId);

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Suppression clé API',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Clé API supprimée: ${keyId}`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting API key:', err);
      return fail(c, err, 'Erreur lors de la suppression de la clé API', 'StaffAPI');
    }
  });

  return router;
}

