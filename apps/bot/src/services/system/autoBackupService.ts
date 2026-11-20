import { Guild } from 'discord.js';
import cron from 'node-cron';
import prisma from '../../utils/db.js';
import { createBackup, BackupOptions } from './backupService.js';
import { isGuildActivated } from '../../utils/activation.js';

// Configuration du backup automatique
const AUTO_BACKUP_ENABLED = true; // Activé pour les serveurs Discord
const AUTO_BACKUP_TIME = '02:00'; // 2h du matin
const AUTO_BACKUP_TIMEZONE = 'Europe/Paris';
const MAX_AUTO_BACKUPS = 3; // Garder seulement les 3 derniers backups automatiques

// Stocker les tâches cron pour chaque serveur
const backupTasks = new Map<string, cron.ScheduledTask>();

/**
 * Initialise le système de backup automatique pour un serveur
 */
export async function initializeAutoBackup(guild: Guild): Promise<void> {
  if (!AUTO_BACKUP_ENABLED) return;
  if (!isGuildActivated(guild.id)) return;

  const guildId = guild.id;

  // Vérifier si le backup automatique est déjà activé pour ce serveur
  const existingTask = backupTasks.get(guildId);
  if (existingTask) {
    existingTask.stop();
  }

  // Créer la tâche cron pour le backup quotidien
  const task = cron.schedule(
    `0 ${AUTO_BACKUP_TIME.split(':')[0]} * * *`, // Tous les jours à l'heure spécifiée
    async () => {
      try {
        await performAutoBackup(guild);
      } catch (error) {
        console.error(`Erreur lors du backup automatique pour le serveur ${guild.name}:`, error);
      }
    },
    {
      timezone: AUTO_BACKUP_TIMEZONE,
    },
  );

  backupTasks.set(guildId, task);
}

/**
 * Arrête le backup automatique pour un serveur
 */
export function stopAutoBackup(guildId: string): void {
  const task = backupTasks.get(guildId);
  if (task) {
    task.stop();
    backupTasks.delete(guildId);
    console.log(`🛑 Backup automatique arrêté pour le serveur ${guildId}`);
  }
}

/**
 * Effectue un backup automatique
 */
async function performAutoBackup(guild: Guild): Promise<void> {
  console.log(`🔄 Début du backup automatique pour le serveur ${guild.name}...`);

  const guildId = guild.id;

  // Nettoyer les anciens backups automatiques (garder seulement MAX_AUTO_BACKUPS)
  await cleanupOldAutoBackups(guildId);

  // Créer les options de backup automatique
  const backupOptions: BackupOptions = {
    name: `Auto Backup - ${guild.name} - ${new Date().toLocaleDateString('fr-FR')}`,
    description: 'Backup automatique quotidien',
    includeMessages: false, // Désactivé par défaut pour économiser l'espace
    includeMembers: true,
    includeRoles: true,
    includeChannels: true,
    includeEmojis: true,
    includeStickers: true,
    createdByUserId: guild.client.user?.id || 'SYSTEM',
    createdByUsername: 'Kotbo Auto Backup',
    createdByTag: '0000',
  };

  // Créer le backup
  const backup = await createBackup(guild, backupOptions);

  console.log(`✅ Backup automatique terminé pour le serveur ${guild.name}: ${backup.name}`);
}

/**
 * Nettoie les anciens backups automatiques
 */
async function cleanupOldAutoBackups(guildId: string): Promise<void> {
  // Récupérer tous les backups automatiques du serveur
  const autoBackups = await prisma.$queryRaw`
    SELECT * FROM server_backups 
    WHERE guild_id = ${guildId} 
    AND created_by_username = 'Kotbo Auto Backup'
    ORDER BY created_at DESC
  `;

  // Si on a plus de MAX_AUTO_BACKUPS, supprimer les plus anciens
  if (Array.isArray(autoBackups) && autoBackups.length > MAX_AUTO_BACKUPS) {
    const toDelete = autoBackups.slice(MAX_AUTO_BACKUPS);
    
    for (const backup of toDelete) {
      await prisma.$executeRaw`
        DELETE FROM server_backups 
        WHERE id = ${backup.id}
      `;
      console.log(`🗑️ Ancien backup automatique supprimé: ${backup.name}`);
    }
  }
}

/**
 * Initialise le backup automatique pour tous les serveurs
 */
export async function initializeAutoBackupForAllGuilds(guilds: Iterable<Guild>): Promise<void> {
  if (!AUTO_BACKUP_ENABLED) return;

  for (const guild of guilds) {
    try {
      await initializeAutoBackup(guild);
    } catch (error) {
      console.error(`Erreur lors de l'initialisation du backup automatique pour ${guild.name}:`, error);
    }
  }
  console.log(`✅ Backup automatique planifié à ${AUTO_BACKUP_TIME} pour ${backupTasks.size} serveur(s)`);
}

/**
 * Arrête tous les backups automatiques
 */
export function stopAllAutoBackups(): void {
  for (const [guildId, task] of backupTasks.entries()) {
    task.stop();
    console.log(`🛑 Backup automatique arrêté pour le serveur ${guildId}`);
  }
  backupTasks.clear();
}
