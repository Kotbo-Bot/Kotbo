/**
 * Délais entre deux combats, réglés par serveur.
 *
 * Les monstres ordinaires et les boss ont chacun leur verrou (`lastBattle` et
 * `lastBossBattle`) : un serveur qui laisse enchaîner les boss ne doit pas pour autant
 * supprimer l'attente entre deux monstres, et inversement.
 */

export const FIGHT_COOLDOWN_SEC_RANGE = { min: 0, max: 3600 } as const;
export const BOSS_COOLDOWN_MIN_RANGE = { min: 0, max: 1440 } as const;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

function bounded(value: number | null | undefined, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(value)));
}

export function fightCooldownMs(config: { fightCooldownSec?: number | null }): number {
  return bounded(config.fightCooldownSec, FIGHT_COOLDOWN_SEC_RANGE, 120) * MS_PER_SECOND;
}

/**
 * Traque : combat contre une créature choisie, plus cher qu'une rencontre au hasard.
 *
 * Les surcoûts sont des pourcentages entiers du combat ordinaire, réglés par serveur. À
 * 100 %, traquer ne coûte pas plus que combattre : c'était le cas avant, et choisir sa
 * cible valait alors toujours mieux que de s'en remettre au hasard.
 */
export const HUNT_ENERGY_PERCENT_RANGE = { min: 100, max: 500 } as const;
export const HUNT_COOLDOWN_PERCENT_RANGE = { min: 100, max: 1000 } as const;

export function huntEnergyCost(baseCost: number, config: { huntEnergyPercent?: number | null }): number {
  const percent = bounded(config.huntEnergyPercent, HUNT_ENERGY_PERCENT_RANGE, 150);
  return Math.ceil((baseCost * percent) / 100);
}

/**
 * Temps que la traque ajoute au verrou des combats ordinaires.
 *
 * Le verrou est commun : sans ce report, il suffirait d'alterner une traque et un combat
 * au hasard pour ne jamais payer le délai allongé.
 */
export function huntCooldownExtraMs(config: { fightCooldownSec?: number | null; huntCooldownPercent?: number | null }): number {
  const percent = bounded(config.huntCooldownPercent, HUNT_COOLDOWN_PERCENT_RANGE, 200);
  return Math.round((fightCooldownMs(config) * (percent - 100)) / 100);
}

export function bossCooldownMs(config: { bossCooldownMin?: number | null }): number {
  return bounded(config.bossCooldownMin, BOSS_COOLDOWN_MIN_RANGE, 2) * MS_PER_MINUTE;
}

/** Temps d'attente restant, 0 si le joueur peut combattre. */
export function remainingCooldownMs(last: Date | null | undefined, cooldownMs: number, now: number = Date.now()): number {
  if (!last || cooldownMs <= 0) return 0;
  return Math.max(0, cooldownMs - (now - last.getTime()));
}

/** Attente lisible dans les deux langues du bot : « 1h 05min », « 12min 30s », « 45s ». */
export function formatCooldown(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / MS_PER_SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}min`;
  if (minutes > 0) return seconds > 0 ? `${minutes}min ${String(seconds).padStart(2, '0')}s` : `${minutes}min`;
  return `${seconds}s`;
}
