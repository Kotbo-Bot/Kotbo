import { logger } from '../utils/logger.js';

/**
 * Sonde de blocage de la boucle d'événements.
 *
 * Une requête Prisma est chronométrée de l'appel jusqu'à la reprise de
 * l'appelant. Si la boucle reste bloquée trois secondes, toutes les requêtes en
 * vol « prennent » trois secondes, jusqu'à une lecture par clé primaire, et le
 * journal se remplit de requêtes lentes qui ne le sont pas. Cette ligne dit
 * quand c'est le process, et non la base, qui a traîné.
 */

const INTERVAL_MS = 500;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WARN_MS = parsePositiveInt(process.env.EVENT_LOOP_LAG_WARN_MS, 500);

let timer: ReturnType<typeof setInterval> | null = null;

const activeTasks = new Map<string, number>();

/** Déclare un traitement de fond en cours ; l'appel renvoyé le retire. */
export function trackActiveTask(name: string): () => void {
  activeTasks.set(name, (activeTasks.get(name) ?? 0) + 1);
  return () => {
    const left = (activeTasks.get(name) ?? 1) - 1;
    if (left > 0) activeTasks.set(name, left);
    else activeTasks.delete(name);
  };
}

export function startEventLoopLagMonitor(): void {
  if (timer) return;
  let expectedAt = performance.now() + INTERVAL_MS;

  timer = setInterval(() => {
    const now = performance.now();
    const lagMs = now - expectedAt;
    expectedAt = now + INTERVAL_MS;
    if (lagMs < WARN_MS) return;

    // Le tas aide à reconnaître une pause du ramasse-miettes d'un calcul bloquant.
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    // shortcut: liste les jobs en cours à la fin du blocage, pas forcément le fautif ; recouper sur plusieurs lignes.
    const active = activeTasks.size ? ` Jobs en cours : ${[...activeTasks.keys()].join(', ')}.` : '';
    logger.warn(
      'EventLoop',
      `Boucle d'événements bloquée ${Math.round(lagMs)}ms (tas ${heapMb} Mo) : les requêtes lentes de cet instant attendaient le process, pas la base.${active}`,
    );
  }, INTERVAL_MS);

  // La sonde ne doit pas retenir le process à l'arrêt.
  timer.unref?.();
}
