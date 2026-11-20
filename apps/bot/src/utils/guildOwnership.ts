/**
 * Quelle instance sert quel serveur.
 *
 * Un serveur rattaché à une instance (Guild.instanceId : marque blanche ou bot
 * perso d'un serveur) n'est servi que par elle ; les autres, par Kotbo. Sans
 * cette règle, pendant la bascule vers le bot d'un serveur, Kotbo et ce bot
 * traitaient chacun les mêmes événements (XP, logs, réponses en double).
 */
import prisma from './db.js';
import { logger } from './logger.js';

const REFRESH_MS = 30_000;
let owners = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshGuildOwnership(): Promise<void> {
  try {
    const rows = await prisma.guild.findMany({
      where: { instanceId: { not: null } },
      select: { id: true, instanceId: true },
    });
    owners = new Map(rows.map((row) => [row.id, row.instanceId!]));
  } catch (err) {
    logger.warn('Instances', 'Rattachement des serveurs non rafraîchi :', err);
  }
}

/**
 * shortcut: un rattachement fait dans un autre processus met jusqu'à 30 s à
 * être vu ici ; passer par Redis si la bascule doit être instantanée.
 */
export async function startGuildOwnershipSync(): Promise<void> {
  if (timer) return;
  await refreshGuildOwnership();
  timer = setInterval(() => void refreshGuildOwnership(), REFRESH_MS);
  timer.unref?.();
}

/**
 * Le bot perso d'un serveur (instance `cb-<serveur>`) n'a le droit d'être que
 * là : renvoie ce serveur, ou null pour toute autre instance.
 */
export function customBotOnlyGuild(instance: { slug: string }): string | null {
  return /^cb-(\d{17,20})$/.exec(instance.slug)?.[1] ?? null;
}

export function servesGuild(guildId: string, instance: { id: string; isDefault: boolean }): boolean {
  const owner = owners.get(guildId);
  return instance.isDefault ? !owner : owner === instance.id;
}
