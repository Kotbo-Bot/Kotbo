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
 *
 * « Gérer » dans la liste des serveurs payants ne bascule le dashboard que vers
 * un serveur de la session : un serveur sans Kotbo, ou quitté par le payeur,
 * laissait toutes les pages en 404. Celui-là ouvre directement le portail.
 * QUAND IL TOMBE : passer par `openGuildBilling`, qui teste `authStore.guilds`.
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

  test('« Gérer » ne bascule que vers un serveur ouvrable, sinon il ouvre le portail du payeur', () => {
    const handler = source.slice(source.indexOf('function openGuildBilling'));
    const body = handler.slice(0, handler.indexOf('\n  }\n'));
    expect(body).toContain('authStore.guilds.some((guild) => guild.id === guildId)');
    expect(body.indexOf('openOwnedGuildPortal(guildId)')).toBeGreaterThan(-1);
    expect(body.indexOf('openOwnedGuildPortal(guildId)')).toBeLessThan(body.indexOf('authStore.setGuild(guildId)'));
  });
});
