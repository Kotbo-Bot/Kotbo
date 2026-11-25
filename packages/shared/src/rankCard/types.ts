/**
 * Personnalisation de la carte `/rank`.
 *
 * La préférence est globale à l'utilisateur (elle le suit d'un serveur à
 * l'autre) : seules les données de progression affichées dessus (niveau, XP,
 * rang) restent propres au serveur où la commande est lancée.
 */

export type RankCardStopColor = { offset: number; color: string };

export type RankCardGlow = {
  /** Position du centre, en fraction de la largeur / hauteur de la carte. */
  x: number;
  y: number;
  /** Rayon en pixels sur la carte de référence (934x282). */
  radius: number;
  color: string;
};

export type RankCardBackgroundPreset = {
  id: string;
  /** Libellé affiché dans le dashboard, en français puis en anglais. */
  label: { fr: string; en: string };
  /** Dégradé de fond, tracé en diagonale du coin haut-gauche au coin bas-droit. */
  gradient: RankCardStopColor[];
  /** Halos radiaux dessinés par-dessus le dégradé. */
  glows: RankCardGlow[];
  /** Dégradé horizontal des liserés haut et bas. */
  accentBar: RankCardStopColor[];
  /** Couleur de remplissage du disque derrière l'avatar. */
  avatarBackdrop: string;
  /** Succès requis pour choisir ce fond. Absent : ouvert à tous. */
  unlockedBy?: string;
};

/**
 * Élément de décor dont le dessin vit dans le rendu du bot : le catalogue ne
 * porte que l'identité et la condition d'accès, le tracé est choisi par `id`.
 */
export type RankCardDecorPreset = {
  id: string;
  label: { fr: string; en: string };
  unlockedBy?: string;
};

export type RankCardAchievementTier = 'bronze' | 'silver' | 'gold' | 'legendary' | 'kotbo';

export type RankCardAchievementMetric =
  | 'staff'
  | 'supporterMonths'
  | 'giftsOffered'
  | 'maxLevel'
  | 'firstPlaces'
  | 'reputation'
  | 'starboard'
  | 'questsClaimed'
  /** Serveurs parrainés qui ont payé au moins une facture. */
  | 'referrals'
  /** Jamais calculé : attribué et retiré à la main depuis le panel admin. */
  | 'manual';

export type RankCardAchievementMetrics = Record<RankCardAchievementMetric, number>;

export type RankCardAchievement = {
  id: string;
  label: { fr: string; en: string };
  /** Condition d'obtention, affichée sous le badge verrouillé. */
  description: { fr: string; en: string };
  /** Texte affiché sous le pseudo quand le succès est choisi comme titre. */
  title: { fr: string; en: string };
  tier: RankCardAchievementTier;
  icon: RankCardBadgeIconId;
  /**
   * Image de badge à la place du tracé, sans extension. Le PNG est versionné
   * dans les deux applications, comme les emojis de la carte. Le tracé reste le
   * repli si le fichier manque.
   */
  image?: string;
  metric: RankCardAchievementMetric;
  threshold: number;
  /**
   * Un succès révocable n'est jamais enregistré : il suit l'état courant (un
   * administrateur retiré perd son badge). Les autres restent acquis une fois
   * obtenus, même si la métrique redescend.
   */
  revocable: boolean;
};

export type RankCardBadgeIconId =
  | 'kotbo'
  | 'crown'
  | 'gem'
  | 'gift'
  | 'referral'
  | 'bolt'
  | 'shield'
  | 'peak'
  | 'trophy'
  | 'heart'
  | 'star'
  | 'target'
  | 'bug'
  | 'code'
  | 'flask';

/**
 * Les emojis ne sont pas positionnables : le rendu les aligne lui-même dans la
 * bande décorative sous le pseudo. L'utilisateur choisit seulement lesquels et
 * dans quel ordre.
 */
export type RankCardCustomization = {
  backgroundId: string;
  /** Police du pseudo. Le reste de la carte garde une police neutre. */
  fontId: string;
  emojis: string[];
  frameId: string;
  patternId: string;
  barStyleId: string;
  /** Succès dont le titre remplace le `@pseudo`. `null` : le pseudo reste. */
  titleId: string | null;
  /** Succès affichés en badges, dans l'ordre choisi. */
  badges: string[];
};
