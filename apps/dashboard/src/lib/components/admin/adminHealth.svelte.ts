/**
 * Sante du bot, partagee par toute la console admin.
 *
 * Chaque page monte sa propre coquille : sans ce module, changer d'onglet
 * relancait la requete et l'indicateur repassait par « chargement » a chaque
 * clic. L'etat vit ici, hors des composants, et survit a la navigation.
 */
import { fetchAdminStats } from '../../api';

export interface AdminHealth {
  guildCount: number;
  userCount: number;
  uptime: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  averageShardPing: number;
  onlineShardCount: number;
  shardCount: number;
}

const REFRESH_MS = 30_000;

export const adminHealth = $state<{ data: AdminHealth | null; error: boolean }>({ data: null, error: false });

let lastFetch = 0;
let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshAdminHealth(): Promise<void> {
  lastFetch = Date.now();
  try {
    const stats = (await fetchAdminStats()) as Record<string, any>;
    adminHealth.data = {
      guildCount: stats.guildCount ?? 0,
      userCount: stats.userCount ?? 0,
      uptime: stats.uptime ?? 0,
      heapUsed: stats.memoryUsage?.heapUsed ?? 0,
      heapTotal: stats.memoryUsage?.heapTotal ?? 1,
      rss: stats.memoryUsage?.rss ?? 0,
      averageShardPing: stats.averageShardPing ?? 0,
      onlineShardCount: stats.onlineShardCount ?? 0,
      shardCount: stats.shardCount ?? 0,
    };
    adminHealth.error = false;
  } catch {
    adminHealth.error = true;
  }
}

/** A appeler au montage ; renvoie la fonction d'arret. */
export function watchAdminHealth(): () => void {
  watchers += 1;
  if (Date.now() - lastFetch > REFRESH_MS) void refreshAdminHealth();
  timer ??= setInterval(refreshAdminHealth, REFRESH_MS);
  return () => {
    watchers -= 1;
    // Une image de delai : la coquille de la page suivante se monte juste
    // apres le demontage de celle-ci, inutile d'arreter puis de relancer.
    setTimeout(() => {
      if (watchers === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 0);
  };
}
