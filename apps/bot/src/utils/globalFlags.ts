/**
 * Maintenance et blacklist globales, tenues en mémoire par chaque processus
 * (`KOTBO_MAINTENANCE_MODE`, `KOTBO_BLACKLIST`) pour filtrer les interactions
 * sans requête. L'API ne les écrit qu'en base et dans son propre processus :
 * les autres shards et les instances white-label les relisent en base.
 */
import prisma from './db.js';
import { logger } from './logger.js';

const REFRESH_MS = 60_000;

async function refreshGlobalFlags(): Promise<void> {
  const config = await prisma.botGlobalConfig.findUnique({ where: { key: 'MAINTENANCE_MODE' } });
  global.KOTBO_MAINTENANCE_MODE = config?.value === 'true';

  const blacklist = await prisma.globalBlacklist.findMany({ select: { userId: true } });
  global.KOTBO_BLACKLIST = new Set(blacklist.map(b => b.userId));
}

/** Charge la maintenance et la blacklist en mémoire, puis les relit toutes les 60 s. */
export async function startGlobalFlagsSync(): Promise<void> {
  try {
    await refreshGlobalFlags();
  } catch (err) {
    logger.error('System', 'Erreur lors du chargement de la config globale', err);
    global.KOTBO_MAINTENANCE_MODE = false;
    global.KOTBO_BLACKLIST = new Set();
  }

  setInterval(() => {
    void refreshGlobalFlags().catch((err) =>
      logger.warn('System', 'Rafraîchissement de la config globale impossible :', err),
    );
  }, REFRESH_MS).unref?.();
}
