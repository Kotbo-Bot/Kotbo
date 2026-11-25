import type {
  RankCardAchievement,
  RankCardAchievementMetrics,
  RankCardAchievementTier,
  RankCardBadgeIconId,
} from './types.js';

/**
 * Tracés SVG sur une grille 24x24, remplis en `evenodd`. La même chaîne sert au
 * `Path2D` du canvas serveur et à l'attribut `d` du dashboard : pas d'asset à
 * versionner en double, et le badge reste net à toutes les tailles.
 */
export const RANK_CARD_BADGE_ICONS: Record<RankCardBadgeIconId, string> = {
  // Logo Kotbo : la tuile arrondie du favicon, le K étant creusé dedans par la
  // règle `evenodd`. Un K plein serait illisible à la taille d'un badge.
  kotbo: 'M6 0L18 0A6 6 0 0 1 24 6L24 18A6 6 0 0 1 18 24L6 24A6 6 0 0 1 0 18L0 6A6 6 0 0 1 6 0ZM7.8 6A1.05 1.05 0 0 1 8.85 7.05L8.85 16.95A1.05 1.05 0 0 1 7.8 18A1.05 1.05 0 0 1 6.75 16.95L6.75 7.05A1.05 1.05 0 0 1 7.8 6ZM8.85 9.75C11.25 9.75 15 7.5 15 7.5C15 7.5 15.75 9 13.5 11.25C12 12.75 8.85 13.5 8.85 13.5ZM8.85 14.25C11.25 14.25 15.75 16.5 15.75 16.5C15.75 16.5 15 18.75 12.75 18C11.25 17.25 8.85 15.75 8.85 15.75ZM16.2 12A1.05 1.05 0 1 0 18.3 12A1.05 1.05 0 1 0 16.2 12Z',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5L3 8zM5 19.5h14V22H5z',
  gem: 'M6 3h12l4 6-10 12L2 9l4-6z',
  gift: 'M3 8h8v4H3zM13 8h8v4h-8zM4 13h7v8H4zM13 13h7v8h-7zM12 7.5C10 3 6 4 7.5 6.5 8.3 7.8 10.5 8 12 8c1.5 0 3.7-.2 4.5-1.5C18 4 14 3 12 7.5z',
  // Silhouette et signe plus, sans chevauchement : le plus s'arrête au-dessus
  // de l'épaule, que l'arc du buste n'atteint qu'à partir de y = 17.
  referral: 'M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM1 21a8 8 0 0 1 16 0zM19 7h2v3h3v2h-3v3h-2v-3h-3v-2h3z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  shield: 'M12 2l8 3v6c0 5.5-3.4 9.7-8 11-4.6-1.3-8-5.5-8-11V5l8-3z',
  peak: 'M2 20L9 7l4 6 3-4 6 11H2z',
  trophy: 'M7 3h10v6a5 5 0 0 1-10 0V3zM17 4h4v3c0 2.4-1.8 4.3-4.2 4.5l.2-2c1.3-.3 2-1.2 2-2.5V6h-2zM7 4H3v3c0 2.4 1.8 4.3 4.2 4.5l-.2-2C5.7 9.2 5 8.3 5 7V6h2zM11 14h2v4h-2zM7 19h10v3H7z',
  heart: 'M12 21l-1.5-1.4C5.4 15 2 11.9 2 8.1 2 5 4.4 2.6 7.5 2.6c1.7 0 3.4.8 4.5 2.1 1.1-1.3 2.8-2.1 4.5-2.1C19.6 2.6 22 5 22 8.1c0 3.8-3.4 6.9-8.5 11.5L12 21z',
  star: 'M12 2.5l2.53 6.52 6.98.39-5.42 4.42 1.79 6.76L12 16.8l-5.88 3.79 1.79-6.76-5.42-4.42 6.98-.39L12 2.5z',
  target: 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 1 1 0-14zm0 3a4 4 0 1 0 0 8 4 4 0 1 0 0-8z',
  // Aucune pièce ne chevauche une autre : avec `evenodd`, un recouvrement
  // creuserait un trou. Seule la ligne du dos est volontairement dans le corps.
  bug: 'M12 8a5 6 0 1 0 0 12a5 6 0 1 0 0-12zM11.4 9.5h1.2v9h-1.2zM12 3a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM2.5 10h4.8v1.4H2.5zM16.7 10h4.8v1.4h-4.8zM2 13.3h4.5v1.4H2zM17.5 13.3H22v1.4h-4.5zM2.5 17h4.8v1.4H2.5zM16.7 17h4.8v1.4h-4.8z',
  code: 'M7 6.2L1.4 12 7 17.8 8.4 16.4 4.2 12 8.4 7.6zM17 6.2L15.6 7.6 19.8 12 15.6 16.4 17 17.8 22.6 12zM13.1 4.5l1.8.5-4 14.5-1.8-.5z',
  flask: 'M9 2h6v1.6h-1v5.2l5.6 9.6A2.4 2.4 0 0 1 17.5 22h-11a2.4 2.4 0 0 1-2.1-3.6L10 8.8V3.6H9z',
};

/** Dégradé du liseré et de l'icône, du haut vers le bas du badge. */
export const RANK_CARD_TIER_COLORS: Record<RankCardAchievementTier, string[]> = {
  bronze: ['#f0b27a', '#a0522d'],
  silver: ['#f1f5f9', '#94a3b8'],
  gold: ['#fde68a', '#d97706'],
  legendary: ['#c4b5fd', '#f472b6', '#22d3ee'],
  // Palette de la marque, reprise du favicon : cyan sur bleu profond.
  kotbo: ['#67e8f9', '#22d3ee', '#0369a1'],
};

export const RANK_CARD_MAX_BADGES = 3;

export const RANK_CARD_ACHIEVEMENTS: RankCardAchievement[] = [
  {
    id: 'kotbo_staff',
    label: { fr: 'Staff Kotbo', en: 'Kotbo Staff' },
    description: { fr: "Faire partie de l'équipe d'administration de Kotbo.", en: 'Be part of the Kotbo administration team.' },
    title: { fr: 'Staff Kotbo', en: 'Kotbo Staff' },
    tier: 'kotbo',
    icon: 'kotbo',
    image: 'kotbo',
    metric: 'staff',
    threshold: 1,
    revocable: true,
  },
  {
    id: 'supporter_1',
    label: { fr: 'Soutien', en: 'Supporter' },
    description: { fr: 'Payer un abonnement Kotbo depuis 1 mois.', en: 'Pay for a Kotbo subscription for 1 month.' },
    title: { fr: 'Soutien', en: 'Supporter' },
    tier: 'bronze',
    icon: 'gem',
    metric: 'supporterMonths',
    threshold: 1,
    revocable: false,
  },
  {
    id: 'supporter_6',
    label: { fr: 'Mécène', en: 'Patron' },
    description: { fr: 'Payer un abonnement Kotbo depuis 6 mois.', en: 'Pay for a Kotbo subscription for 6 months.' },
    title: { fr: 'Mécène', en: 'Patron' },
    tier: 'silver',
    icon: 'gem',
    metric: 'supporterMonths',
    threshold: 6,
    revocable: false,
  },
  {
    id: 'supporter_12',
    label: { fr: 'Grand mécène', en: 'Grand patron' },
    description: { fr: 'Payer un abonnement Kotbo depuis 12 mois.', en: 'Pay for a Kotbo subscription for 12 months.' },
    title: { fr: 'Grand mécène', en: 'Grand patron' },
    tier: 'gold',
    icon: 'gem',
    metric: 'supporterMonths',
    threshold: 12,
    revocable: false,
  },
  {
    id: 'gift_giver',
    label: { fr: 'Bienfaiteur', en: 'Benefactor' },
    description: { fr: 'Offrir Kotbo à un serveur.', en: 'Gift Kotbo to a server.' },
    title: { fr: 'Bienfaiteur', en: 'Benefactor' },
    tier: 'gold',
    icon: 'gift',
    metric: 'giftsOffered',
    threshold: 1,
    revocable: false,
  },
  {
    id: 'referrer',
    label: { fr: 'Parrain', en: 'Referrer' },
    description: { fr: 'Parrainer un serveur qui a payé son abonnement Kotbo.', en: 'Refer a server that paid for its Kotbo subscription.' },
    title: { fr: 'Parrain', en: 'Referrer' },
    tier: 'silver',
    icon: 'referral',
    metric: 'referrals',
    threshold: 1,
    revocable: false,
  },
  {
    id: 'level_25',
    label: { fr: 'Habitué', en: 'Regular' },
    description: { fr: 'Atteindre le niveau 25 sur un serveur.', en: 'Reach level 25 on a server.' },
    title: { fr: 'Habitué', en: 'Regular' },
    tier: 'bronze',
    icon: 'bolt',
    metric: 'maxLevel',
    threshold: 25,
    revocable: false,
  },
  {
    id: 'level_50',
    label: { fr: 'Vétéran', en: 'Veteran' },
    description: { fr: 'Atteindre le niveau 50 sur un serveur.', en: 'Reach level 50 on a server.' },
    title: { fr: 'Vétéran', en: 'Veteran' },
    tier: 'silver',
    icon: 'shield',
    metric: 'maxLevel',
    threshold: 50,
    revocable: false,
  },
  {
    id: 'level_100',
    label: { fr: 'Légende', en: 'Legend' },
    description: { fr: 'Atteindre le niveau 100 sur un serveur.', en: 'Reach level 100 on a server.' },
    title: { fr: 'Légende', en: 'Legend' },
    tier: 'gold',
    icon: 'peak',
    metric: 'maxLevel',
    threshold: 100,
    revocable: false,
  },
  {
    id: 'first_place',
    label: { fr: 'Numéro un', en: 'Number one' },
    description: { fr: "Être premier du classement d'XP d'un serveur d'au moins 10 membres.", en: 'Top the XP leaderboard of a server with at least 10 members.' },
    title: { fr: 'Numéro un', en: 'Number one' },
    tier: 'gold',
    icon: 'trophy',
    metric: 'firstPlaces',
    threshold: 1,
    revocable: false,
  },
  {
    id: 'reputation_50',
    label: { fr: 'Apprécié', en: 'Appreciated' },
    description: { fr: 'Recevoir 50 points de réputation.', en: 'Receive 50 reputation points.' },
    title: { fr: 'Apprécié', en: 'Appreciated' },
    tier: 'silver',
    icon: 'heart',
    metric: 'reputation',
    threshold: 50,
    revocable: false,
  },
  {
    id: 'starboard_10',
    label: { fr: 'Étoile', en: 'Star' },
    description: { fr: 'Voir 10 de ses messages mis en avant sur un starboard.', en: 'Get 10 of your messages featured on a starboard.' },
    title: { fr: 'Étoile', en: 'Star' },
    tier: 'silver',
    icon: 'star',
    metric: 'starboard',
    threshold: 10,
    revocable: false,
  },
  {
    id: 'quests_50',
    label: { fr: 'Aventurier', en: 'Adventurer' },
    description: { fr: 'Terminer 50 quêtes.', en: 'Complete 50 quests.' },
    title: { fr: 'Aventurier', en: 'Adventurer' },
    tier: 'bronze',
    icon: 'target',
    metric: 'questsClaimed',
    threshold: 50,
    revocable: false,
  },
  {
    id: 'bug_hunter',
    label: { fr: 'Chercheur de bug', en: 'Bug hunter' },
    description: { fr: "Signaler un bug confirmé par l'équipe Kotbo.", en: 'Report a bug confirmed by the Kotbo team.' },
    title: { fr: 'Chercheur de bug', en: 'Bug hunter' },
    tier: 'silver',
    icon: 'bug',
    metric: 'manual',
    threshold: 1,
    revocable: false,
  },
  {
    id: 'tester',
    label: { fr: 'Testeur', en: 'Tester' },
    description: { fr: "Aider l'équipe Kotbo à tester les nouveautés.", en: 'Help the Kotbo team test new features.' },
    title: { fr: 'Testeur', en: 'Tester' },
    tier: 'silver',
    icon: 'flask',
    metric: 'manual',
    threshold: 1,
    revocable: false,
  },
  {
    id: 'contributor',
    label: { fr: 'Contributeur', en: 'Contributor' },
    description: { fr: 'Contribuer au code de Kotbo.', en: "Contribute to Kotbo's code." },
    title: { fr: 'Contributeur', en: 'Contributor' },
    tier: 'gold',
    icon: 'code',
    metric: 'manual',
    threshold: 1,
    revocable: false,
  },
];

const ACHIEVEMENTS_BY_ID = new Map(RANK_CARD_ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]));

export function getRankCardAchievement(id: string): RankCardAchievement | null {
  return ACHIEVEMENTS_BY_ID.get(id) ?? null;
}

/**
 * Attribué par l'équipe, jamais atteint par une métrique. Le pass des
 * administrateurs Kotbo ne l'ouvre pas : un badge « Chercheur de bug » sur la
 * carte de quelqu'un qui n'en a trouvé aucun lui ôterait son sens.
 */
export function isManualRankCardAchievement(achievement: RankCardAchievement): boolean {
  return achievement.metric === 'manual';
}

/** Succès atteints par les métriques courantes, dans l'ordre du catalogue. */
export function rankCardAchievementsFromMetrics(metrics: Partial<RankCardAchievementMetrics>): RankCardAchievement[] {
  return RANK_CARD_ACHIEVEMENTS.filter((achievement) => !isManualRankCardAchievement(achievement)
    && (metrics[achievement.metric] ?? 0) >= achievement.threshold);
}

/**
 * Chemin de l'image d'un badge, servie par le dashboard. Le canvas du bot lit
 * le même nom de fichier dans `apps/bot/assets/rank-badges`.
 */
export function rankCardBadgeImageUrl(image: string): string {
  return `/rank-badges/${image}.png`;
}

/** Vrai quand l'élément est ouvert à tous ou que son succès est acquis. */
export function isRankCardItemUnlocked(unlockedBy: string | undefined, unlocked: ReadonlySet<string>): boolean {
  return !unlockedBy || unlocked.has(unlockedBy);
}
