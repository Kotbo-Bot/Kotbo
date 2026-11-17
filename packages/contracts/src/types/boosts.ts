/**
 * Boosts : paliers du serveur, avantages débloqués et badge d'ancienneté du
 * booster. Partagé entre le bot (/profile, notifications) et le dashboard
 * (badge, calculateur d'avantages).
 */

/** Paliers de badge Discord, en mois de boost continu. */
export const BOOST_BADGE_MONTHS = [1, 2, 3, 6, 9, 12, 15, 18, 24] as const;

/** Boosts requis par niveau de serveur (index = niveau). */
// shortcut: seuils et avantages recopiés de Discord (2 / 7 / 14) ; à mettre à jour si Discord change ses paliers.
export const BOOST_TIER_THRESHOLDS = [0, 2, 7, 14] as const;

/** Boosts inclus dans un abonnement Nitro : sert à traduire des boosts manquants en personnes. */
export const BOOSTS_PER_NITRO = 2;

export type BoostPerkId =
  | 'emoji_100' | 'stickers_15' | 'audio_128' | 'stream_720' | 'animated_icon' | 'invite_background'
  | 'emoji_150' | 'stickers_30' | 'audio_256' | 'stream_1080' | 'banner' | 'upload_50' | 'role_icons'
  | 'emoji_250' | 'stickers_60' | 'audio_384' | 'vanity_url' | 'animated_banner' | 'upload_100';

export const BOOST_PERKS: ReadonlyArray<{ id: BoostPerkId; tier: 1 | 2 | 3 }> = [
  { id: 'emoji_100', tier: 1 },
  { id: 'stickers_15', tier: 1 },
  { id: 'audio_128', tier: 1 },
  { id: 'stream_720', tier: 1 },
  { id: 'animated_icon', tier: 1 },
  { id: 'invite_background', tier: 1 },
  { id: 'emoji_150', tier: 2 },
  { id: 'stickers_30', tier: 2 },
  { id: 'audio_256', tier: 2 },
  { id: 'stream_1080', tier: 2 },
  { id: 'banner', tier: 2 },
  { id: 'upload_50', tier: 2 },
  { id: 'role_icons', tier: 2 },
  { id: 'emoji_250', tier: 3 },
  { id: 'stickers_60', tier: 3 },
  { id: 'audio_384', tier: 3 },
  { id: 'vanity_url', tier: 3 },
  { id: 'animated_banner', tier: 3 },
  { id: 'upload_100', tier: 3 },
];

/** Niveau atteint avec `boosts` boosts. */
export function boostTierFor(boosts: number): 0 | 1 | 2 | 3 {
  if (boosts >= BOOST_TIER_THRESHOLDS[3]) return 3;
  if (boosts >= BOOST_TIER_THRESHOLDS[2]) return 2;
  if (boosts >= BOOST_TIER_THRESHOLDS[1]) return 1;
  return 0;
}

export type BoostGoal = {
  tier: number;
  /** Boosts encore nécessaires (0 = déjà atteint). */
  missingBoosts: number;
  /** Membres Nitro à convaincre si chacun pose ses boosts inclus. */
  missingNitroMembers: number;
};

/** Ce qu'il manque pour atteindre `tier` (ou le niveau qui débloque tous les avantages demandés). */
export function boostGoal(currentBoosts: number, tier: number): BoostGoal {
  const target = BOOST_TIER_THRESHOLDS[Math.max(0, Math.min(3, tier))] ?? 0;
  const missingBoosts = Math.max(0, target - Math.max(0, currentBoosts));
  return { tier, missingBoosts, missingNitroMembers: Math.ceil(missingBoosts / BOOSTS_PER_NITRO) };
}

/** Niveau requis pour débloquer tous les avantages choisis. */
export function tierForPerks(perks: Iterable<BoostPerkId>): number {
  let tier = 0;
  for (const id of perks) tier = Math.max(tier, BOOST_PERKS.find((p) => p.id === id)?.tier ?? 0);
  return tier;
}

/** Boosts qu'on peut perdre avant de redescendre d'un niveau (null au niveau 0). */
export function boostMargin(currentBoosts: number): number | null {
  const tier = boostTierFor(currentBoosts);
  if (tier === 0) return null;
  return currentBoosts - BOOST_TIER_THRESHOLDS[tier];
}

/** Mois calendaires pleins entre `since` et `now`. */
export function boostMonths(since: Date, now: Date = new Date()): number {
  const months = (now.getUTCFullYear() - since.getUTCFullYear()) * 12 + now.getUTCMonth() - since.getUTCMonth();
  return Math.max(0, now.getUTCDate() < since.getUTCDate() ? months - 1 : months);
}

export type BoostBadge = {
  /** 0 à 8 : palier du badge (0 = premier mois). */
  step: number;
  months: number;
  /** Palier suivant en mois, null au dernier. */
  nextMonths: number | null;
};

/** Badge d'ancienneté, comme sur Discord : le premier palier s'affiche dès le début du boost. */
export function boostBadge(since: Date | string, now: Date = new Date()): BoostBadge {
  const months = boostMonths(new Date(since), now);
  const step = BOOST_BADGE_MONTHS.filter((m) => m <= Math.max(1, months)).length - 1;
  return { step, months, nextMonths: BOOST_BADGE_MONTHS[step + 1] ?? null };
}
