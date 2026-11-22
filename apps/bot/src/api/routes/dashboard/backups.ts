import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { createBackup, type BackupData } from '../../../services/system/backupService.js';
import { isRestoringBackup, restoreBackup } from '../../../services/system/restoreService.js';
import { parseBackupImport } from '../../../services/system/backupImportValidation.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { assertFreeQuota } from '../../../services/system/freeQuota.js';
import { pushAudit } from '../../shared.js';
import { publicErrorMessage } from '../../../utils/publicError.js';

export function createBackupsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Administrateur seulement, sur un serveur présent dans le cache du bot.
  const adminAccess = createMiddleware(async (c, next) => {
    if (!c.var.access.canManageSettings) return send(c, { error: 'Accès refusé' }, 403);
    if (!client.guilds.cache.get(c.req.param('guildId')!)) return send(c, { error: 'Serveur non trouvé' }, 404);
    await next();
  });
  const gate = [...guildRoute(client), adminAccess] as const;


  router.get(`${base}/backups`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const backups = await prisma.serverBackup.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });
      return send(c, backups);
    } catch (error) {
      logger.error('BackupAPI', 'Error fetching backups:', error);
      return fail(c, error, 'Erreur lors de la récupération des sauvegardes', 'BackupAPI');
    }
  });

  router.post(`${base}/backups`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        name?: string;
        description?: string;
        includeMessages?: boolean;
        includeMembers?: boolean;
        includeRoles?: boolean;
        includeChannels?: boolean;
        includeEmojis?: boolean;
        includeStickers?: boolean;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de la requête invalide' }, 400);
      }

      // Présence garantie par la garde du routeur.
      const guild = client.guilds.cache.get(guildId)!;
      const backup = await createBackup(guild, {
        name: body.name || '',
        description: body.description || '',
        includeMessages: body.includeMessages ?? false,
        includeMembers: body.includeMembers ?? true,
        includeRoles: body.includeRoles ?? true,
        includeChannels: body.includeChannels ?? true,
        includeEmojis: body.includeEmojis ?? true,
        includeStickers: body.includeStickers ?? true,
        createdByUserId: user.userId,
        createdByUsername: user.username || 'Unknown',
        createdByTag: '0000',
      });

      await pushAudit(guildId, {
        channelId: null,
        user: user.username || `User${user.userId}`,
        action: 'Création sauvegarde',
        context: body.name || 'Sans nom',
        module: 'Sauvegardes',
        eventType: 'Settings',
        details: `Nom: ${body.name || 'Sans nom'} | Description: ${body.description || 'Aucune'} | Messages: ${body.includeMessages ?? false} | Membres: ${body.includeMembers ?? true} | Rôles: ${body.includeRoles ?? true} | Salons: ${body.includeChannels ?? true} | Émojis: ${body.includeEmojis ?? true} | Stickers: ${body.includeStickers ?? true}`,
      });

      return send(c, backup);
    } catch (error) {
      logger.error('BackupAPI', 'Error creating backup:', error);
      return fail(c, error, 'Erreur lors de la création de la sauvegarde', 'BackupAPI');
    }
  });

  router.delete(`${base}/backups/:backupId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const backupId = c.req.param('backupId');
      const backup = await prisma.serverBackup.findUnique({
        where: { id: backupId },
      });

      if (!backup) {
        return send(c, { error: 'Sauvegarde non trouvée' }, 404);
      }

      if (backup.guildId !== guildId) {
        return send(c, { error: "Cette sauvegarde n'appartient pas à ce serveur" }, 403);
      }

      await prisma.serverBackup.delete({
        where: { id: backupId },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: user.username || `User${user.userId}`,
        action: 'Suppression sauvegarde',
        context: backup.name,
        module: 'Sauvegardes',
        eventType: 'Settings',
        details: `Nom: ${backup.name} | Créé par: ${backup.createdByUsername} | Date création: ${backup.createdAt.toISOString()}`,
      });

      return send(c, { success: true });
    } catch (error) {
      logger.error('BackupAPI', 'Error deleting backup:', error);
      return fail(c, error, 'Erreur lors de la suppression de la sauvegarde', 'BackupAPI');
    }
  });

  router.post(`${base}/backups/:backupId/restore`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      // Présence garantie par la garde du routeur.
      const guild = client.guilds.cache.get(guildId)!;
      // Le bot recrée rôles, permissions et attributions hors Admin Lock, et Gérer le
      // serveur suffit à importer un fichier forgé : Administrateur exigé, comme /backup.
      const member = await guild.members.fetch(user.userId).catch(() => null);
      if (!member?.permissions.has('Administrator')) {
        return send(c, { error: 'La restauration demande la permission Administrateur' }, 403);
      }

      const backupId = c.req.param('backupId');
      const backup = await prisma.serverBackup.findUnique({
        where: { id: backupId },
      });

      if (!backup) {
        return send(c, { error: 'Sauvegarde non trouvée' }, 404);
      }

      if (backup.guildId !== guildId) {
        return send(c, { error: "Cette sauvegarde n'appartient pas à ce serveur" }, 403);
      }

      if (isRestoringBackup(guildId)) {
        return send(c, { error: 'Une restauration est déjà en cours sur ce serveur' }, 409);
      }

      // Écrasement confirmé dans le dashboard, sans interaction Discord pour trancher
      // au cas par cas : 'replace'. includeKotbo est sûr, la sauvegarde appartient à
      // ce serveur et un import n'en porte jamais. La restauration dure plusieurs
      // minutes : elle tourne en arrière-plan, la requête n'attend que son lancement.
      void restoreBackup(guild, backup.data as unknown as BackupData, {
        fullRestore: true,
        includeRoles: backup.includeRoles,
        includeChannels: backup.includeChannels,
        includeMembers: backup.includeMembers,
        includeEmojis: backup.includeEmojis,
        includeStickers: backup.includeStickers,
        includeMessages: backup.includeMessages,
        includeKotbo: true,
        conflictResolution: 'replace',
      })
        .then(() => pushAudit(guildId, {
          channelId: null,
          user: user.username || `User${user.userId}`,
          action: 'Restauration sauvegarde',
          context: backup.name,
          module: 'Sauvegardes',
          eventType: 'Settings',
          details: `Nom: ${backup.name} | Créé par: ${backup.createdByUsername} | Date création: ${backup.createdAt.toISOString()}`,
        }))
        .catch((error) => logger.error('BackupAPI', `Restauration de ${backup.id} échouée :`, error));

      return send(c, { started: true }, 202);
    } catch (error) {
      logger.error('BackupAPI', 'Error restoring backup:', error);
      return fail(c, error, 'Erreur lors de la restauration de la sauvegarde', 'BackupAPI');
    }
  });

  router.get(`${base}/backups/:backupId/export`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const backupId = c.req.param('backupId');
      const backup = await prisma.serverBackup.findUnique({
        where: { id: backupId },
      });

      if (!backup) {
        return send(c, { error: 'Sauvegarde non trouvée' }, 404);
      }

      if (backup.guildId !== guildId) {
        return send(c, { error: "Cette sauvegarde n'appartient pas à ce serveur" }, 403);
      }

      // Créer l'objet JSON à exporter
      const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        backup: {
          name: backup.name,
          description: backup.description,
          serverName: backup.serverName,
          serverIcon: backup.serverIcon,
          createdByUserId: backup.createdByUserId,
          createdByUsername: backup.createdByUsername,
          createdByTag: backup.createdByTag,
          createdAt: backup.createdAt,
          data: backup.data,
          options: {
            includeMessages: backup.includeMessages,
            includeMembers: backup.includeMembers,
            includeRoles: backup.includeRoles,
            includeChannels: backup.includeChannels,
            includeEmojis: backup.includeEmojis,
            includeStickers: backup.includeStickers,
          },
          stats: {
            rolesCount: backup.rolesCount,
            channelsCount: backup.channelsCount,
            membersCount: backup.membersCount,
            messagesCount: backup.messagesCount,
            emojisCount: backup.emojisCount,
            stickersCount: backup.stickersCount,
            sizeBytes: backup.sizeBytes,
          },
        },
      };

      const jsonString = JSON.stringify(exportData, null, 2);
      const buffer = Buffer.from(jsonString, 'utf-8');

      await pushAudit(guildId, {
        channelId: null,
        user: user.username || `User${user.userId}`,
        action: 'Export sauvegarde',
        context: backup.name,
        module: 'Sauvegardes',
        eventType: 'Settings',
        details: `Nom: ${backup.name} | Taille: ${backup.sizeBytes || 0} bytes | Rôles: ${backup.rolesCount} | Salons: ${backup.channelsCount} | Membres: ${backup.membersCount}`,
      });

      return c.body(buffer, 200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${backup.name.replace(/[^a-zA-Z0-9]/g, '_')}_backup.json"`,
        'Content-Length': String(buffer.length),
      });
    } catch (error) {
      logger.error('BackupAPI', 'Error exporting backup:', error);
      return fail(c, error, "Erreur lors de l'export de la sauvegarde", 'BackupAPI');
    }
  });

  router.post(`${base}/backups/import`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{ file?: string; name?: string }>(c);

      if (!body?.file) {
        return send(c, { error: 'Fichier requis' }, 400);
      }
      if (typeof body.file !== 'string') {
        return send(c, { error: 'Le fichier doit être envoyé sous forme de texte JSON' }, 400);
      }
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100)) {
        return send(c, { error: 'Le nom doit contenir entre 1 et 100 caractères' }, 400);
      }

      let backupData;
      try {
        backupData = parseBackupImport(body.file);
      } catch (error) {
        return send(c, {
          error: publicErrorMessage(error, 'Le fichier de sauvegarde est invalide'),
        }, 400);
      }

      // Vérifier le nombre de backups existants
      const existingBackups = await prisma.serverBackup.count({
        where: { guildId, isPreset: false },
      });

      await assertFreeQuota(guildId, 'backups', async () => existingBackups);
      const MAX_BACKUPS_PER_GUILD = 3;
      if (existingBackups >= MAX_BACKUPS_PER_GUILD) {
        return send(c, { error: 'Limite de sauvegardes atteinte' }, 400);
      }

      // Générer le nom du backup
      const backupName = body.name?.trim() || backupData.name || `Import - ${backupData.serverName || 'Serveur'} - ${new Date().toLocaleDateString('fr-FR')}`;

      // Créer le backup dans la base de données
      const newBackup = await prisma.serverBackup.create({
        data: {
          guildId,
          name: backupName,
          description: backupData.description,
          data: backupData.data as unknown as Prisma.InputJsonValue,
          includeMessages: backupData.options.includeMessages,
          includeMembers: backupData.options.includeMembers,
          includeRoles: backupData.options.includeRoles,
          includeChannels: backupData.options.includeChannels,
          includeEmojis: backupData.options.includeEmojis,
          includeStickers: backupData.options.includeStickers,
          createdByUserId: user.userId,
          createdByUsername: user.username || 'Unknown',
          createdByTag: '0000',
          serverName: backupData.serverName || 'Importé',
          serverIcon: backupData.serverIcon,
          sizeBytes: backupData.stats.sizeBytes,
          rolesCount: backupData.stats.rolesCount,
          channelsCount: backupData.stats.channelsCount,
          membersCount: backupData.stats.membersCount,
          messagesCount: backupData.stats.messagesCount,
          emojisCount: backupData.stats.emojisCount,
          stickersCount: backupData.stats.stickersCount,
          isPreset: false,
        },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: user.username || `User${user.userId}`,
        action: 'Import sauvegarde',
        context: backupName,
        module: 'Sauvegardes',
        eventType: 'Settings',
        details: `Nom: ${backupName} | Taille: ${backupData.stats.sizeBytes} bytes | Rôles: ${backupData.stats.rolesCount} | Salons: ${backupData.stats.channelsCount} | Membres: ${backupData.stats.membersCount}`,
      });

      return send(c, newBackup);
    } catch (error) {
      logger.error('BackupAPI', 'Error importing backup:', error);
      return fail(c, error, "Erreur lors de l'import de la sauvegarde", 'BackupAPI');
    }
  });

  return router;
}

