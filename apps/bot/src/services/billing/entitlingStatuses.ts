import type { Stripe } from './stripeService.js';

// `past_due` ouvre le service tant que Stripe relance le paiement ; il passe en
// `canceled` ou `unpaid`, qui ferment, quand les relances échouent toutes.
export const ENTITLING_STATUSES: ReadonlySet<string> = new Set<Stripe.Subscription.Status>(['active', 'trialing', 'past_due']);

// Abonnement encore vivant chez Stripe, qui peut reprendre et facturer : seuls
// `canceled` et `incomplete_expired` sont définitifs.
export const LIVE_STATUSES: ReadonlySet<string> = new Set<Stripe.Subscription.Status>(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);
