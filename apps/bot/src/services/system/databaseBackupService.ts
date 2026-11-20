import cron from 'node-cron';
import { createWriteStream } from 'fs';
import { mkdir, readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { logger } from '../../utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration du backup de la base de données
const DATABASE_BACKUP_ENABLED = true;
const DATABASE_BACKUP_TIME = '02:00'; // 2h du matin
const DATABASE_BACKUP_TIMEZONE = 'Europe/Paris';
const RETENTION_DAYS = 7; // Garder les backups pendant 7 jours

const BACKUP_DIR = path.join(__dirname, '../../../../../backups/database');

let backupTask: cron.ScheduledTask | null = null;

function findPgDump(): string {
  // pg_dump installé via `apk add postgresql-client` dans DockerfileBot
  return process.env.PG_DUMP_PATH || 'pg_dump';
}

/**
 * Purge les backups plus vieux que RETENTION_DAYS jours
 */
async function pruneOldBackups(): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = await readdir(BACKUP_DIR).catch(() => [] as string[]);
  let removed = 0;

  for (const entry of entries) {
    if (!entry.startsWith('kotbo_backup_')) continue;
    const filePath = path.join(BACKUP_DIR, entry);
    const info = await stat(filePath).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await unlink(filePath).catch(() => {});
      removed++;
    }
  }

  return removed;
}

/**
 * Effectue un backup de la base de données PostgreSQL via pg_dump,
 * compressé directement en gzip (pas de dépendance à un binaire gzip externe).
 */
export async function performDatabaseBackup(): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL non défini, impossible de faire le backup.');
  }

  logger.info('DatabaseBackup', 'Début du backup de la base de données PostgreSQL...');

  await mkdir(BACKUP_DIR, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(BACKUP_DIR, `kotbo_backup_${timestamp}.sql.gz`);

  const pgDump = findPgDump();

  const child = Bun.spawn([pgDump, connectionString, '--format=plain', '--no-owner', '--no-acl'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderrOutput = new Response(child.stderr).text();

  // Le flux peut se terminer avant que pg_dump rende son code : on attend les deux,
  // sinon un dump interrompu passait pour un backup réussi.
  const [, code] = await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(outputFile)),
    child.exited,
  ]);
  if (code !== 0) {
    await unlink(outputFile).catch(() => {});
    throw new Error(`pg_dump a échoué (code ${code}): ${(await stderrOutput).slice(0, 2000)}`);
  }

  const size = (await stat(outputFile)).size;
  logger.info(
    'DatabaseBackup',
    `Backup terminé: ${path.basename(outputFile)} (${(size / 1024 / 1024).toFixed(2)} MB)`,
  );

  const removed = await pruneOldBackups();
  if (removed > 0) {
    logger.debug('DatabaseBackup', `${removed} ancien(s) backup(s) supprimé(s) (> ${RETENTION_DAYS}j)`);
  }

  return outputFile;
}

/**
 * Initialise le système de backup automatique de la base de données
 */
export function initializeDatabaseBackup(): void {
  if (!DATABASE_BACKUP_ENABLED) {
    logger.warn('DatabaseBackup', 'Backup de la base de données désactivé');
    return;
  }

  if (backupTask) {
    backupTask.stop();
  }

  backupTask = cron.schedule(
    `0 ${DATABASE_BACKUP_TIME.split(':')[0]} * * *`, // Tous les jours à l'heure spécifiée
    async () => {
      try {
        await performDatabaseBackup();
      } catch (error) {
        logger.error('DatabaseBackup', 'Erreur lors du backup automatique de la base de données:', error);
      }
    },
    {
      timezone: DATABASE_BACKUP_TIMEZONE,
    },
  );

  logger.info(
    'DatabaseBackup',
    `Backup automatique de la base de données initialisé à ${DATABASE_BACKUP_TIME} (${DATABASE_BACKUP_TIMEZONE})`,
  );
}

/**
 * Arrête le backup automatique de la base de données
 */
export function stopDatabaseBackup(): void {
  if (backupTask) {
    backupTask.stop();
    backupTask = null;
    logger.info('DatabaseBackup', 'Backup automatique de la base de données arrêté');
  }
}

/**
 * Effectue un backup manuel de la base de données
 */
export async function manualDatabaseBackup(): Promise<string> {
  logger.info('DatabaseBackup', 'Backup manuel de la base de données...');
  const filePath = await performDatabaseBackup();
  return `Backup de la base de données terminé avec succès: ${path.basename(filePath)}`;
}
