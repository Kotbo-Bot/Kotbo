/** Facturation Stripe : offre du serveur, souscription, portail client. */
import { authStore } from '../stores/auth.svelte';
import { apiRequest, dashboardRequest } from './client';

export type PlanKey = 'FREE' | 'PLUS' | 'PRO' | 'ULTIMATE' | 'CUSTOM';
export type BillingInterval = 'month' | 'year';

export interface PlanCard {
  key: PlanKey;
  name: string;
  tagline: string;
  description: string;
  /** Tranche de taille servie par l'offre, `null` pour `FREE`. */
  memberRange: { min: number; max: number | null } | null;
  priceCents: { month: number; year: number } | null;
  /** Faux quand l'offre ne se vend pas en ligne, ou qu'un prix Stripe manque. */
  purchasable: boolean;
}

/** Essai gratuit, offert seulement avec un code de parrainage : possible ou non, et pourquoi. */
export interface TrialInfo {
  available: boolean;
  /** Durée de l'essai en jours, décidée côté serveur (jamais écrite en dur ici). */
  days: number;
  reason: 'already_used_by_user' | 'already_used_by_guild' | 'guild_has_subscription' | 'plan_not_eligible' | null;
}

export interface BillingStatus {
  /** Faux si l'instance n'a pas de clé Stripe : la page l'annonce au lieu de proposer des boutons morts. */
  enabled: boolean;
  plan: PlanKey;
  planName: string;
  /** Statut Stripe brut (`active`, `past_due`, `canceled`…), null sans abonnement. */
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Un abonnement Stripe est rattaché, même clos : portail et factures. */
  hasSubscription: boolean;
  /** Il vit encore chez Stripe, même impayé : il se gère au portail, pas par un second paiement. */
  hasLiveSubscription: boolean;
  /**
   * Dépend de l'administrateur connecté autant que du serveur : l'essai se
   * consomme une fois par compte Discord, deux administrateurs du même serveur
   * peuvent donc voir un bouton différent.
   */
  trial: TrialInfo;
  /** Faux pour un membre du staff en lecture seule. */
  canManage?: boolean;
  /** Code de parrainage de l'utilisateur connecté, et serveurs qui l'ont utilisé. */
  referral?: { code: string; discountPercent: number; referred: number };
  plans: PlanCard[];
  /** Membres du serveur, tels que l'API les compte pour choisir l'offre. */
  memberCount?: number;
  /** Offre faite pour la taille actuelle du serveur. */
  eligiblePlan?: PlanKey | null;
}

export async function fetchBillingStatus(guildId = authStore.selectedGuildId ?? undefined): Promise<BillingStatus | null> {
  return dashboardRequest('/billing', { method: 'GET', guildId, errorContext: 'API Error (Billing):' });
}

/** Un serveur que l'utilisateur paye, dans la vue d'ensemble de la facturation. */
export interface BillingOverviewGuild {
  guildId: string;
  name: string;
  iconUrl: string | null;
  plan: PlanKey;
  planName: string;
  status: string | null;
  interval: BillingInterval | null;
  /** Montant du catalogue pour la période, 0 sans abonnement Stripe en cours. */
  amountCents: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  accessExpiresAt: string | null;
  network: { name: string; role: string } | null;
}

export interface BillingOverview {
  guilds: BillingOverviewGuild[];
  totalMonthlyCents: number;
}

/** Tous les serveurs dont l'utilisateur est le payeur, avec le total mensuel. */
export async function fetchBillingOverview(): Promise<BillingOverview> {
  return apiRequest('/api/dashboard/billing/overview', { method: 'GET', errorContext: 'API Error (Billing overview):' });
}

/**
 * Ouvre une session de paiement et renvoie l'URL Stripe.
 *
 * L'appelant redirige lui-même : le paiement se déroule entièrement sur un
 * domaine Stripe, aucune donnée bancaire ne transite par le dashboard.
 *
 * L'essai et la remise passent par le code de parrainage : c'est le serveur
 * qui le vérifie et qui décide s'il les accorde. Un code refusé lève une erreur
 * dont le message dit pourquoi.
 */
export async function startCheckout(
  plan: Exclude<PlanKey, 'FREE' | 'CUSTOM'>,
  interval: BillingInterval,
  referralCode?: string,
  guildId = authStore.selectedGuildId ?? undefined,
): Promise<string | null> {
  const result = await dashboardRequest('/billing/checkout', {
    method: 'POST',
    payload: { plan, interval, ...(referralCode ? { referralCode } : {}) },
    guildId,
    silent: true,
    errorContext: 'API Error (Checkout):',
  });
  return result?.url ?? null;
}

/** Déplace l'abonnement du serveur courant vers un autre. Lève une erreur dont le message dit pourquoi. */
export async function transferSubscription(
  targetGuildId: string,
  guildId = authStore.selectedGuildId ?? undefined,
): Promise<void> {
  await dashboardRequest('/billing/transfer', {
    method: 'POST',
    payload: { targetGuildId },
    guildId,
    silent: true,
    errorContext: 'API Error (Transfer):',
  });
}

/** Portail Stripe : factures, moyen de paiement, changement d'offre, résiliation. */
export async function openBillingPortal(guildId = authStore.selectedGuildId ?? undefined): Promise<string | null> {
  const result = await dashboardRequest('/billing/portal', {
    method: 'POST',
    guildId,
    silent: true,
    errorContext: 'API Error (Portal):',
  });
  return result?.url ?? null;
}
