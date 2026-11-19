/**
 * subscriptionSync.ts
 *
 * Traduit l'état d'un abonnement Stripe en état Kotbo.
 *
 * C'est le seul endroit qui décide « ce statut Stripe donne-t-il droit au
 * service ? ». Le webhook ne fait que lui passer un abonnement ; les commandes
 * de rattrapage aussi. Un seul chemin, donc un seul comportement à vérifier.
 *
 * Principe directeur : **Stripe fait foi**. On ne calcule jamais une date de fin
 * nous-mêmes, on recopie celle de l'abonnement. Un remboursement, un changement
 * d'offre au prorata, une prolongation manuelle depuis l'interface Stripe : tout
 * arrive ici sous forme d'un abonnement mis à jour, et l'état Kotbo suit sans
 * qu'on ait à modéliser la règle de gestion une seconde fois.
 */

import { normalizePlanKey, type PlanKey } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { invalidatePlan } from '../system/planService.js';
import { announceAccessEnded, grantAccess, markAccessExpired, minutesUntil, type AccessType } from '../system/accessService.js';
import { ENTITLING_STATUSES, LIVE_STATUSES } from './entitlingStatuses.js';
import { planForPriceId, type Stripe } from './stripeService.js';
import { confirmTrialStarted } from './trialService.js';


/**
 * Fin de la période payée.
 *
 * Depuis les versions d'API récentes, `current_period_end` ne vit plus sur
 * l'abonnement mais sur chacune de ses lignes. Un abonnement Kotbo n'ayant
 * qu'une ligne, on prend la plus lointaine : c'est correct aujourd'hui et le
 * resterait si une option facturée à part était ajoutée un jour.
 */
function periodEnd(subscription: Stripe.Subscription): Date | null {
  const timestamps = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number');

  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps) * 1000);
}

/**
 * Offre correspondant à un abonnement, déduite du prix réellement souscrit.
 *
 * Les métadonnées ne servent que de filet : elles portent l'offre demandée au
 * moment du clic, mais un changement d'offre depuis le portail client Stripe ne
 * repasse pas par notre code et les laisse périmées. Le prix, lui, est toujours
 * à jour.
 */
function planForSubscription(subscription: Stripe.Subscription): PlanKey | null {
  for (const item of subscription.items.data) {
    const priceId = typeof item.price === 'string' ? item.price : item.price?.id;
    const match = priceId ? planForPriceId(priceId) : null;
    if (match) return match.plan;
  }

  const fromMetadata = subscription.metadata?.plan;
  if (fromMetadata) {
    logger.warn(
      'Billing',
      `Prix inconnu sur l'abonnement ${subscription.id} : repli sur l'offre ${fromMetadata} des métadonnées. ` +
        'Vérifier que les variables STRIPE_PRICE_* correspondent aux prix du compte Stripe.',
    );
    return normalizePlanKey(fromMetadata);
  }

  return null;
}

/** Serveur rattaché à un abonnement : métadonnées d'abord, puis la base. */
export async function guildIdForSubscription(subscription: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = subscription.metadata?.guildId;
  if (fromMetadata) return fromMetadata;

  const row = await prisma.guild.findFirst({
    where: { stripeSubscriptionId: subscription.id },
    select: { id: true },
  });
  if (row) return row.id;

  // Dernier recours : le client Stripe porte lui aussi le serveur. Ce chemin
  // sert quand un abonnement a été créé à la main depuis l'interface Stripe.
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customerId) return null;

  const byCustomer = await prisma.guild.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  return byCustomer?.id ?? null;
}

/**
 * Aligne l'état d'un serveur sur son abonnement Stripe.
 *
 * Idempotent : rejouer le même abonnement deux fois produit exactement le même
 * état. C'est ce qui rend sûrs les rejeux de webhook et la commande de
 * resynchronisation.
 */
export async function syncSubscription(subscription: Stripe.Subscription): Promise<void> {
  const guildId = await guildIdForSubscription(subscription);
  if (!guildId) {
    logger.error(
      'Billing',
      `Abonnement ${subscription.id} sans serveur rattaché : aucun accès accordé. ` +
        'Ajouter `guildId` dans les métadonnées de l\'abonnement pour le rattraper.',
    );
    return;
  }

  const entitled = ENTITLING_STATUSES.has(subscription.status);
  const plan = entitled ? (planForSubscription(subscription) ?? 'FREE') : 'FREE';
  const expiresAt = periodEnd(subscription);

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const priceId = subscription.items.data[0]?.price
    ? typeof subscription.items.data[0].price === 'string'
      ? subscription.items.data[0].price
      : subscription.items.data[0].price.id
    : null;

  // Lu avant l'upsert qui l'écrase : la fin d'abonnement ne s'annonce qu'au
  // passage « couvert -> non couvert » de l'abonnement courant.
  const previous = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { stripeSubscriptionId: true, stripeSubscriptionStatus: true },
  });
  const wasEntitled = !!previous
    && previous.stripeSubscriptionId === subscription.id
    && !!previous.stripeSubscriptionStatus
    && ENTITLING_STATUSES.has(previous.stripeSubscriptionStatus as Stripe.Subscription.Status);

  await prisma.guild.upsert({
    where: { id: guildId },
    update: {
      // Seul un abonnement qui couvre ou couvrait le serveur écrit l'offre : après un abonnement clos, un cadeau a pu la poser.
      plan: entitled || wasEntitled ? plan : undefined,
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: subscription.status,
      stripePriceId: priceId,
      stripeCancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      stripeCurrentPeriodEnd: expiresAt,
    },
    // Un paiement peut précéder toute configuration du serveur : la ligne
    // `Guild` est créée à la volée plutôt que de perdre l'abonnement.
    create: {
      id: guildId,
      plan,
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: subscription.status,
      stripePriceId: priceId,
      stripeCancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      stripeCurrentPeriodEnd: expiresAt,
    },
  });

  // L'essai a réellement démarré : la réservation posée avant la redirection
  // devient un essai consommé, que l'expiration de la session de paiement ne
  // pourra plus libérer. Fait avant l'octroi d'accès, pour qu'un échec plus loin
  // ne rejoue pas un essai déjà servi.
  if (subscription.status === 'trialing') {
    const startedAt = subscription.trial_start ? new Date(subscription.trial_start * 1000) : new Date();
    await confirmTrialStarted(guildId, subscription.id, startedAt);
  }

  if (entitled && expiresAt) {
    // L'activation binaire historique est portée par `activateGuild` (codes) ;
    // un paiement doit produire le même résultat sans consommer de code.
    await prisma.guild.update({
      where: { id: guildId },
      data: { activated: true, activatedAt: new Date(), activatedViaStaffLink: false },
    });

    // `grantAccess` pose la date de fin et remet les rappels à zéro : le cron
    // `access-lifecycle` reprend la main pour prévenir et couper le moment venu.
    // On lui donne la durée jusqu'à la fin de période Stripe, pas 30 jours en
    // dur : un mois n'a pas toujours 30 jours, et un changement d'offre au
    // prorata décale l'échéance.
    await grantAccess(guildId, {
      // `TRIAL` pendant l'essai : les embeds de rappel et le message de fin ne
      // disent pas la même chose selon qu'on interrompt un essai ou un
      // abonnement payé.
      type: subscription.status === 'trialing' ? 'TRIAL' : 'SUBSCRIPTION',
      durationMinutes: Math.max(1, minutesUntil(expiresAt)),
    });

    const { activatedGuilds } = await import('../../utils/activation.js');
    activatedGuilds.add(guildId);

    // Le parcours de configuration s'arrete ici : sa derniere etape est la mise
    // en service, et elle vient d'avoir lieu. C'est la seule sortie qui ne
    // demande rien a personne - le dashboard s'ouvre au retour de Stripe, sans
    // qu'un drapeau de navigateur ait a s'en meler.
    //
    // Un echec n'interrompt pas la synchronisation : l'abonnement, lui, est
    // deja ecrit, `markOnboardingComplete` a journalise, et le rejeu du webhook
    // repassera par ici.
    const { markOnboardingComplete } = await import('../core/onboardingGate.js');
    await markOnboardingComplete(guildId, `abonnement ${subscription.id}`).catch(() => {});
  }

  await invalidatePlan(guildId);

  // Ce chemin écrit `plan` sans passer par `setGuildPlan` : la coupure du bot
  // perso est donc déclenchée ici aussi. Un échec ne doit pas faire rejouer le webhook.
  const { retireCustomBotIfIneligible } = await import('../system/customBotRetire.js');
  await retireCustomBotIfIneligible(guildId).catch((err) => logger.error('CustomBot', `Coupure du bot perso de ${guildId} impossible :`, err));

  if (expiresAt && subscription.status === 'active') {
    await recordPayerCoverage(guildId, expiresAt);
  }

  logger.info(
    'Billing',
    `Serveur ${guildId} synchronisé : offre ${plan}, statut ${subscription.status}` +
      (expiresAt ? `, période jusqu'au ${expiresAt.toISOString()}.` : '.'),
  );

  // Une seule annonce : l'accès marqué expiré sort aussi le serveur du cron
  // `access-lifecycle`, qui enverrait sinon un second avis et des rappels.
  if (!entitled && wasEntitled && (await markAccessExpired(guildId))) {
    const type = previous.stripeSubscriptionStatus === 'trialing' ? 'TRIAL' : 'SUBSCRIPTION';
    await announceSubscriptionLost(guildId, type, subscription.status);
  }
}

/** Erreur dont le message peut être montré tel quel à l'administrateur. */
export class TransferError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) {
    super(message);
  }
}

const STRIPE_FIELDS = {
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripeSubscriptionStatus: null,
  stripePriceId: null,
  stripeCancelAtPeriodEnd: false,
  stripeCurrentPeriodEnd: null,
} as const;

/**
 * Déplace l'abonnement d'un serveur vers un autre, sans rien changer côté
 * paiement : même client Stripe, même abonnement, même échéance.
 *
 * Ordre voulu : la base d'abord (les colonnes Stripe sont `@unique`, le serveur
 * cible doit être libre), puis les métadonnées Stripe qui servent au webhook à
 * retrouver le serveur. Si Stripe refuse, la base est remise comme avant.
 */
export async function transferSubscription(sourceId: string, targetId: string, userId: string | null): Promise<void> {
  if (sourceId === targetId) throw new TransferError('Choisis un autre serveur que celui-ci.');

  const [source, target] = await Promise.all([
    prisma.guild.findUnique({ where: { id: sourceId } }),
    prisma.guild.findUnique({ where: { id: targetId }, select: { stripeCustomerId: true, stripeSubscriptionId: true } }),
  ]);
  // Un abonnement clos ne se transfère pas : la source a pu recevoir un cadeau, que son passage en FREE effacerait.
  if (!source?.stripeSubscriptionId || !source.stripeCustomerId || !LIVE_STATUSES.has(source.stripeSubscriptionStatus ?? '')) {
    throw new TransferError("Ce serveur n'a pas d'abonnement à transférer.", 404);
  }
  if (target?.stripeSubscriptionId || target?.stripeCustomerId) {
    throw new TransferError('Le serveur choisi a déjà un abonnement.', 409);
  }

  const { getStripe } = await import('./stripeService.js');
  const stripe = getStripe();
  if (!stripe) throw new TransferError('Facturation Stripe non configurée.', 502);

  const moved = {
    stripeCustomerId: source.stripeCustomerId,
    stripeSubscriptionId: source.stripeSubscriptionId,
    stripeSubscriptionStatus: source.stripeSubscriptionStatus,
    stripePriceId: source.stripePriceId,
    stripeCancelAtPeriodEnd: source.stripeCancelAtPeriodEnd,
    stripeCurrentPeriodEnd: source.stripeCurrentPeriodEnd,
  };

  await prisma.$transaction([
    prisma.guild.update({ where: { id: sourceId }, data: { ...STRIPE_FIELDS, billingOwnerId: null } }),
    prisma.guild.upsert({
      where: { id: targetId },
      update: { ...moved, billingOwnerId: source.billingOwnerId ?? userId },
      create: { id: targetId, ...moved, billingOwnerId: source.billingOwnerId ?? userId },
    }),
  ]);

  try {
    await stripe.customers.update(moved.stripeCustomerId, { metadata: { guildId: targetId } });
    await stripe.subscriptions.update(moved.stripeSubscriptionId, { metadata: { guildId: targetId } });
  } catch (err) {
    logger.error('Billing', `Métadonnées Stripe non mises à jour pour le transfert ${sourceId} -> ${targetId} :`, err);
    await prisma.$transaction([
      prisma.guild.update({ where: { id: targetId }, data: STRIPE_FIELDS }),
      prisma.guild.update({ where: { id: sourceId }, data: { ...moved, billingOwnerId: source.billingOwnerId } }),
    ]);
    // Une mise à jour partielle (client changé, abonnement non) est remise telle quelle.
    await stripe.customers.update(moved.stripeCustomerId, { metadata: { guildId: sourceId } }).catch(() => {});
    throw new TransferError("Stripe n'a pas pu enregistrer le transfert, rien n'a changé.", 502);
  }

  // Le serveur cible reçoit l'accès via le chemin habituel (offre, échéance,
  // activation) ; la source repasse en gratuit sans message de fin d'accès,
  // puisqu'elle n'a rien perdu par accident.
  const subscription = await stripe.subscriptions.retrieve(moved.stripeSubscriptionId);
  await syncSubscription(subscription);

  const { setGuildPlan } = await import('../system/planService.js');
  await setGuildPlan(sourceId, 'FREE', `abonnement transféré vers ${targetId}`);
  await prisma.guild.update({ where: { id: sourceId }, data: { accessExpiredAt: new Date() } });

  logger.info('Billing', `Abonnement ${moved.stripeSubscriptionId} transféré de ${sourceId} vers ${targetId}.`);
}

/**
 * Alimente l'ancienneté du payeur pour les succès de la carte de rang. Un échec
 * ici ne doit jamais faire échouer la synchronisation : l'accès au service
 * passe avant un badge.
 */
async function recordPayerCoverage(guildId: string, coveredUntil: Date): Promise<void> {
  try {
    const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { billingOwnerId: true } });
    if (!guild?.billingOwnerId) return;
    const { recordSupporterCoverage } = await import('../progression/achievementService.js');
    await recordSupporterCoverage(guild.billingOwnerId, coveredUntil);
  } catch (err) {
    logger.warn('Billing', `Ancienneté du payeur de ${guildId} non enregistrée:`, err);
  }
}

/**
 * Prévient le serveur que son abonnement ne le couvre plus.
 *
 * Distinct de l'expiration gérée par `accessService` : ici la période payée peut
 * encore courir sur le papier, mais Stripe a clos l'abonnement (résiliation
 * immédiate, impayé définitif). Sans ce message, le serveur constaterait la
 * fermeture de ses modules sans la moindre explication.
 */
async function announceSubscriptionLost(guildId: string, type: AccessType, status: string): Promise<void> {
  try {
    await announceAccessEnded(getClient(), guildId, type);
    logger.info('Billing', `Perte d'abonnement annoncée à ${guildId} (statut ${status}).`);
  } catch (err) {
    // Le client Discord n'est pas toujours disponible (worker, démarrage) ;
    // l'état en base est déjà juste, seule la notification est perdue.
    logger.warn('Billing', `Impossible d'annoncer la perte d'abonnement à ${guildId}:`, err);
  }
}

/**
 * Purge les événements Stripe archivés.
 *
 * La table `billing_events` sert d'abord de verrou d'idempotence : sa valeur
 * s'arrête quand Stripe cesse de rejouer un événement, soit trois jours. La
 * rétention est fixée bien au-delà pour laisser le temps d'enquêter sur un
 * litige de paiement, mais pas au point de conserver indéfiniment des payloads
 * qui contiennent des données de facturation.
 *
 * Les lignes en erreur sont épargnées : ce sont précisément celles qu'on veut
 * pouvoir relire, et elles ne grossissent pas.
 */
const BILLING_EVENT_RETENTION_DAYS = 90;

export async function pruneOldBillingEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - BILLING_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const { count } = await prisma.billingEvent.deleteMany({
    where: { receivedAt: { lt: cutoff }, error: null },
  });

  if (count > 0) logger.info('Billing', `${count} événement(s) Stripe purgé(s) (plus de ${BILLING_EVENT_RETENTION_DAYS} jours).`);
}
