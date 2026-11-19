import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou de Billing.svelte, lu dans la source (pas de harnais de rendu).
 * La carte d'offre envoie au portail un abonnement encore vivant chez Stripe,
 * même impayé, que le paiement refuserait en 409 ; un abonnement clos, toujours
 * `hasSubscription` pour ses factures, doit pouvoir payer un nouvel abonnement.
 * La bannière d'offre dépassée (portail) et le transfert, que l'API refuse à un
 * abonnement clos, suivent eux aussi l'abonnement vivant.
 * QUAND IL TOMBE : tester `status.hasLiveSubscription`, avant l'achat sur la carte d'offre.
 */
const source = readFileSync(join(import.meta.dir, '../pages/Billing.svelte'), 'utf8');

describe('page Facturation', () => {
  test("la carte d'offre teste l'abonnement vivant, et non le seul rattachement, avant l'achat", () => {
    const card = source.slice(source.indexOf('{#each orderedPlans'));
    const portal = card.indexOf('{:else if status.hasLiveSubscription}');
    expect(portal).toBeGreaterThan(-1);
    expect(portal).toBeLessThan(card.indexOf('{:else if plan.purchasable && isUpgrade}'));
    expect(card).not.toContain('{:else if status.hasSubscription}');
  });

  test("la bannière d'offre dépassée et le transfert ne visent qu'un abonnement vivant", () => {
    expect(source).toContain('if (!status?.hasLiveSubscription || !status.eligiblePlan) return null;');
    expect(source).toContain('{#if status.hasLiveSubscription && status.canManage !== false && transferTargets.length > 0}');
  });
});
