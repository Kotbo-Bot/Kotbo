/**
 * Registre des offres commerciales Kotbo - source de vérité unique.
 *
 * Kotbo est **freemium** : l'offre gratuite ouvre ce que les autres bots
 * donnent gratuitement (modération, sécurité, accueil, niveaux, tickets…), et
 * une seule offre payante, **Plus**, ouvre l'intégralité du catalogue pour
 * tous les serveurs, quelle que soit leur taille.
 *
 * `PRO`, `ULTIMATE` et `CUSTOM` ne se vendent plus (`listed: false`) : ils
 * restent connus pour les serveurs qui les ont déjà, sans quoi
 * `normalizePlanKey` les ferait retomber sur `FREE` et leurs renouvellements
 * Stripe ne retrouveraient plus leur offre.
 *
 * La seule frontière fonctionnelle est celle de `FREE` (`FREE_MODULES`). Elle
 * ne ferme jamais la sécurité d'un serveur : un raid subi faute d'abonnement
 * ferait plus de tort à Kotbo que l'abonnement ne rapporte. Ce qui reste payant
 * est ce qu'aucun bot gratuit ne fait : la gestion du staff, l'IA, le
 * cross-serveur, le site, l'engagement poussé (saisons, clans, RPG).
 *
 * Le lien avec `MODULE_REGISTRY` se fait par `planIncludesModule`, consulté par
 * `moduleGate` côté bot (garde d'exécution) et par le dashboard (affichage du
 * cadenas).
 *
 * Ce paquet ne dépend de rien (ni Prisma, ni Stripe, ni discord.js) : le bot,
 * le dashboard et les scripts l'importent tel quel. Les identifiants Stripe ne
 * sont donc **pas** ici - ils vivent dans les variables d'environnement, dont ce
 * fichier ne connaît que les noms.
 */

import { MODULE_REGISTRY } from './modules.js';

/**
 * Offres, de la plus faible à la plus forte. L'ordre du tableau fait foi pour
 * `comparePlans` : un plan situé plus loin inclut tout ce que porte le précédent.
 *
 * - `FREE`     : état d'un serveur sans abonnement. Ouvre `FREE_MODULES`.
 * - `PLUS`     : la seule offre vendue, tout le catalogue, pour tous les serveurs.
 * - `PRO`      : ancienne offre des serveurs de 1 001 à 10 000 membres, plus vendue.
 * - `ULTIMATE` : ancienne offre des serveurs de 10 001 à 100 000 membres, plus vendue.
 * - `CUSTOM`   : accord négocié (white-label, partenariat), posé à la main
 *                depuis l'administration, jamais vendu par Stripe.
 */
export const PLAN_KEYS = ['FREE', 'PLUS', 'PRO', 'ULTIMATE', 'CUSTOM'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Offres payantes, celles qu'un palier de taille peut désigner. */
export type PaidPlanKey = Exclude<PlanKey, 'FREE'>;

/** Périodicité de facturation. Une offre peut n'en proposer aucune (FREE, CUSTOM). */
export type BillingInterval = 'month' | 'year';

/**
 * Tranche de taille servie par une offre. `max: null` = pas de plafond.
 * Bornes exprimées en nombre de membres Discord du serveur.
 */
export interface PlanMemberRange {
  min: number;
  max: number | null;
}

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  /** Accroche courte, affichée sur la carte de l'offre. */
  tagline: string;
  description: string;
  /**
   * Modules débloqués, en plus des modules `core` (toujours inclus, quel que
   * soit le plan : sans eux le serveur n'est plus administrable, et il faut
   * bien pouvoir atteindre la page de facturation pour s'abonner).
   *
   * `'all'` débloque tout le catalogue, y compris les modules ajoutés plus tard.
   * Toutes les offres payantes sont dans ce cas - c'est la promesse tout-en-un.
   */
  modules: 'all' | string[];
  /**
   * Taille de serveur à laquelle l'offre s'adresse, ou `null` pour une offre
   * qui n'est pas un palier (`FREE`, anciennes offres, accord négocié).
   */
  memberRange: PlanMemberRange | null;
  /**
   * Affichée dans la grille des offres. Une offre retirée de la vente ne
   * l'est plus, sauf pour le serveur qui l'a encore.
   */
  listed: boolean;
  /**
   * Noms des variables d'environnement portant les identifiants de prix Stripe
   * (`price_...`). On stocke le *nom* et pas la valeur pour que ce fichier reste
   * publiable et identique entre test et production - seul le `.env` change.
   *
   * `null` pour les offres qui ne passent pas par Stripe.
   */
  priceEnv: { month: string; year: string } | null;
  /**
   * Tarif affiché, en centimes d'euro. Purement indicatif pour l'abonnement :
   * le montant réellement débité est celui du prix Stripe. Sert à peindre la
   * page tarifs sans un appel à l'API Stripe à chaque chargement, et à calculer
   * le montant d'un cadeau (`giftPriceCents`).
   */
  displayPriceCents: { month: number; year: number } | null;
  /** Vendue en libre-service depuis le dashboard (bouton « S'abonner »). */
  selfServe: boolean;
}

/**
 * Modules ouverts sans abonnement, en plus du cœur. Une dépendance hors de
 * cette liste éteindrait le module en cascade : `youtube` et `twitch` tirent
 * `social_networks` avec eux (garde-fou dans `planRegistry.test.ts`).
 */
export const FREE_MODULES = [
  // Modération et sécurité : jamais derrière un paiement.
  'sanctions',
  'automod',
  'logs',
  'raid_protection',
  'security_verification',
  'nickname_moderation',
  // Accueil et contenu de base.
  'welcome_goodbye',
  'reaction_roles',
  'regulation',
  'embed_builder',
  'auto_responses',
  'auto_thread',
  'news',
  // Communauté.
  'leveling',
  'tickets',
  'giveaways',
  'events',
  'suggestions',
  'starboard',
  'fun',
  // Intégrations.
  'analytics',
  'workflows',
  'social_networks',
  'youtube',
  'twitch',
  'bump_reminder',
  // Vitrine de la gestion du staff : le reste de la catégorie est payant.
  'staff_directory',
];

export const PLAN_REGISTRY: PlanDefinition[] = [
  {
    key: 'FREE',
    name: 'Gratuit',
    tagline: 'Tout ce qu\'un bot gratuit fait, en mieux.',
    description:
      "Modération, anti-raid, logs, accueil, niveaux, tickets, giveaways, analytics, notifications YouTube et Twitch : l'essentiel d'un serveur, sans carte bancaire et sans limite de durée.",
    modules: FREE_MODULES,
    memberRange: null,
    listed: true,
    priceEnv: null,
    displayPriceCents: null,
    selfServe: false,
  },
  {
    key: 'PLUS',
    name: 'Plus',
    tagline: 'Tout Kotbo, pour tous les serveurs.',
    description:
      "Le catalogue complet, au même prix quelle que soit la taille du serveur : gestion du staff, IA de modération, site, saisons, clans, économie, serveur MCP, cross-serveur, et les modules ajoutés plus tard.",
    modules: 'all',
    memberRange: { min: 0, max: null },
    listed: true,
    priceEnv: { month: 'STRIPE_PRICE_PLUS_MONTHLY', year: 'STRIPE_PRICE_PLUS_YEARLY' },
    displayPriceCents: { month: 500, year: 3_000 },
    selfServe: true,
  },
  // Anciennes offres : plus vendues, gardées pour les serveurs qui les ont.
  // `priceEnv` reste renseigné pour que le webhook relie encore leurs prix.
  {
    key: 'PRO',
    name: 'Pro',
    tagline: 'Ancienne offre, remplacée par Plus.',
    description: "Tout le catalogue. Cette offre n'est plus vendue : Plus ouvre exactement la même chose, pour tous les serveurs.",
    modules: 'all',
    memberRange: null,
    listed: false,
    priceEnv: { month: 'STRIPE_PRICE_PRO_MONTHLY', year: 'STRIPE_PRICE_PRO_YEARLY' },
    displayPriceCents: { month: 999, year: 4_999 },
    selfServe: false,
  },
  {
    key: 'ULTIMATE',
    name: 'Ultimate',
    tagline: 'Ancienne offre, remplacée par Plus.',
    description: "Tout le catalogue. Cette offre n'est plus vendue : Plus ouvre exactement la même chose, pour tous les serveurs.",
    modules: 'all',
    memberRange: null,
    listed: false,
    priceEnv: { month: 'STRIPE_PRICE_ULTIMATE_MONTHLY', year: 'STRIPE_PRICE_ULTIMATE_YEARLY' },
    displayPriceCents: { month: 2_500, year: 14_999 },
    selfServe: false,
  },
  {
    key: 'CUSTOM',
    name: 'Sur mesure',
    tagline: 'Un accord convenu avec l\'équipe Kotbo.',
    description:
      "Tout le catalogue, sur des conditions convenues au cas par cas : white-label, partenariat, infrastructure dédiée. Posé par l'équipe Kotbo, jamais souscrit en ligne.",
    modules: 'all',
    memberRange: null,
    listed: false,
    priceEnv: null,
    displayPriceCents: null,
    selfServe: false,
  },
];

/**
 * Prise de rendez-vous commercial. Unique adresse de contact affichée par le
 * dashboard et le bot : la mettre ici évite qu'un lien mort survive dans un
 * coin de l'interface parce qu'on a oublié un `href`.
 */
export const SALES_CONTACT_URL = 'https://pros.kotbo.fr/rdv';

const PLAN_BY_KEY = new Map(PLAN_REGISTRY.map((plan) => [plan.key, plan]));

/** Rang d'une offre dans l'échelle. Sert aux comparaisons « au moins ». */
const PLAN_RANK: Record<PlanKey, number> = {
  FREE: 0,
  PLUS: 1,
  PRO: 2,
  ULTIMATE: 3,
  // Un accord sur mesure débloque tout : il se compare comme le sommet de
  // l'échelle, même s'il ne s'achète pas.
  CUSTOM: 4,
};

/**
 * Ramène une valeur venue de la base ou d'une requête à une offre connue. Toute
 * valeur inattendue retombe sur `FREE` : en cas de donnée corrompue, on ferme,
 * on n'ouvre pas.
 */
export function normalizePlanKey(value: unknown): PlanKey {
  const candidate = typeof value === 'string' ? value.toUpperCase() : '';
  return (PLAN_KEYS as readonly string[]).includes(candidate) ? (candidate as PlanKey) : 'FREE';
}

export function getPlanDefinition(plan: PlanKey): PlanDefinition {
  return PLAN_BY_KEY.get(plan) ?? PLAN_BY_KEY.get('FREE')!;
}

/** Négatif si `a` est en dessous de `b`, 0 si égal, positif si au-dessus. */
export function comparePlans(a: PlanKey, b: PlanKey): number {
  return PLAN_RANK[a] - PLAN_RANK[b];
}

// ─────────────────────────────────────────────────────────────
// Offre proposée à un serveur
// ─────────────────────────────────────────────────────────────

/**
 * Offre payante proposée à un serveur. Depuis l'offre unique, c'est `PLUS`
 * quelle que soit sa taille ; la signature garde l'effectif pour ne pas
 * retoucher les appelants si un palier revenait.
 */
export function planForMemberCount(_memberCount?: number | null): PaidPlanKey {
  return 'PLUS';
}

/**
 * Ce serveur peut-il souscrire cette offre en ligne ? Seule `PLUS` répond vrai.
 */
export function canPurchasePlan(plan: PlanKey, memberCount: number | null | undefined): boolean {
  return getPlanDefinition(plan).selfServe && planForMemberCount(memberCount) === plan;
}

// ─────────────────────────────────────────────────────────────
// Modules ouverts par une offre
// ─────────────────────────────────────────────────────────────

/**
 * Clés des modules ouverts par une offre, modules `core` compris. Toujours une
 * liste concrète, y compris pour `'all'`, pour être affichable telle quelle.
 */
export function modulesForPlan(plan: PlanKey): string[] {
  const definition = getPlanDefinition(plan);
  if (definition.modules === 'all') return MODULE_REGISTRY.map((m) => m.key);

  const included = new Set(definition.modules);
  for (const mod of MODULE_REGISTRY) {
    if (mod.core) included.add(mod.key);
  }
  return MODULE_REGISTRY.filter((m) => included.has(m.key)).map((m) => m.key);
}

const MODULES_BY_PLAN = new Map<PlanKey, Set<string>>(
  PLAN_KEYS.map((key) => [key, new Set(modulesForPlan(key))]),
);

/**
 * L'offre `plan` donne-t-elle accès au module `moduleKey` ?
 *
 * Un module inconnu du registre est considéré inclus : la grille tarifaire ne
 * doit pas fermer une fonctionnalité qu'elle ne sait pas décrire - même règle
 * que `moduleGate`, pour que les deux gardes se comportent pareil.
 */
export function planIncludesModule(plan: PlanKey, moduleKey: string): boolean {
  if (!MODULE_REGISTRY.some((m) => m.key === moduleKey)) return true;
  return MODULES_BY_PLAN.get(plan)?.has(moduleKey) ?? false;
}

/**
 * Offre la plus basse qui ouvre ce module. `null` si le module est déjà ouvert
 * sans abonnement (cœur et `FREE_MODULES`).
 *
 * Les offres payantes étant identiques, la réponse est toujours `PLUS` pour
 * un module verrouillé. Le dashboard n'affiche pas cette valeur telle quelle : il
 * propose l'offre correspondant à la taille du serveur (`planForMemberCount`),
 * seule réellement achetable.
 */
export function lowestPlanWithModule(moduleKey: string): PlanKey | null {
  if (planIncludesModule('FREE', moduleKey)) return null;
  for (const key of PLAN_KEYS) {
    if (key === 'CUSTOM' || key === 'FREE') continue;
    if (planIncludesModule(key, moduleKey)) return key;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Essai gratuit
// ─────────────────────────────────────────────────────────────

/**
 * Durée de l'essai gratuit offert à la première souscription, en jours.
 *
 * Ici et pas dans une variable d'environnement : la durée est un engagement
 * commercial affiché sur la page tarifs et dans les CGU, elle doit être la même
 * sur toutes les instances et lisible depuis le dashboard comme depuis le bot.
 * Stripe n'en garde aucune trace côté prix - c'est le paramètre
 * `trial_period_days` de la session de paiement qui la porte, à chaque fois.
 */
export const TRIAL_DAYS = 15;

/**
 * Cette offre ouvre-t-elle droit à l'essai gratuit ?
 *
 * Seules les offres vendues en libre-service : `FREE` n'a rien à essayer, et un
 * accord `CUSTOM` se négocie, période de découverte comprise.
 */
export function planAllowsTrial(plan: PlanKey): boolean {
  return getPlanDefinition(plan).selfServe;
}

// ─────────────────────────────────────────────────────────────
// Offrir Kotbo
// ─────────────────────────────────────────────────────────────

/**
 * Durées proposées quand on offre Kotbo à un serveur, en mois.
 *
 * Un cadeau n'est pas un abonnement : c'est un paiement unique qui ouvre une
 * offre pour une durée fixe, sans reconduction ni carte enregistrée chez le
 * bénéficiaire. Le bénéficiaire n'a donc rien à résilier quand la période
 * s'achève - le serveur retombe simplement sur `FREE`.
 */
export const GIFT_DURATIONS_MONTHS = [1, 3, 6, 12] as const;
export type GiftDurationMonths = (typeof GIFT_DURATIONS_MONTHS)[number];

export function isGiftDuration(months: number): months is GiftDurationMonths {
  return (GIFT_DURATIONS_MONTHS as readonly number[]).includes(months);
}

/**
 * Montant d'un cadeau, en centimes d'euro, ou `null` si l'offre n'a pas de
 * tarif public (`FREE`, `CUSTOM` : on n'offre pas un accord négocié).
 *
 * Contrairement à l'abonnement, ce montant est bien celui qui sera débité : un
 * cadeau n'a pas de prix Stripe préenregistré, il est facturé à la volée à
 * partir de cette valeur.
 */
export function giftPriceCents(plan: PlanKey, months: number): number | null {
  const prices = getPlanDefinition(plan).displayPriceCents;
  if (!prices || !isGiftDuration(months)) return null;
  // Douze mois = le tarif annuel, remise comprise : offrir un an ne doit pas
  // coûter plus cher que s'abonner un an soi-même.
  return months === 12 ? prices.year : prices.month * months;
}
