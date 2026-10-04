import {
  DEFAULT_LEVEL_CURVE,
  getRankCardAchievement,
  isManualRankCardAchievement,
  levelFromXp,
  normalizeLevelCurve,
  RANK_CARD_ACHIEVEMENTS,
  rankCardAchievementsFromMetrics,
  type RankCardAchievementMetric,
  type RankCardAchievementMetrics,
} from '@kotbo/shared';
import prisma, { prismaRead } from '../../utils/db.js';
import { upsertRetryingRace } from '../../utils/upsertRetry.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

// Pendant les relances d'un paiement refusé, l'abonnement passe en `past_due`
// et n'est plus compté. Stripe peut relancer plusieurs semaines : sans marge,
// une carte expirée puis remplacée remettait l'ancienneté du payeur à zéro.
const SUPPORTER_GRACE_MS = 30 * DAY_MS;

// `past_due` exclu : Stripe avance la période dès l'émission de la facture,
// la compter prolongerait l'ancienneté d'un mois qui n'a pas été payé.
const PAYING_STATUSES = ['active'];
const FIRST_PLACE_MIN_MEMBERS = 10;
const FIRST_PLACE_MAX_GUILDS = 25;
const LEVEL_SCAN_MAX_GUILDS = 200;

// Les administrateurs Kotbo ont tout le catalogue ouvert. Ces ouvertures ne
// sont jamais enregistrées : un administrateur retiré ne garde que ce qu'il a
// réellement atteint.
const STAFF_ACHIEVEMENT_ID = 'kotbo_staff';

const EVALUATION_TTL_SECONDS = 60;
const RENDER_TTL_SECONDS = 60;
const BACKGROUND_REFRESH_TTL_SECONDS = 10 * 60;
// Le gain d'XP vocale fait monter de niveau beaucoup de membres sur le même
// tick : sans plafond, chacun lancerait sa dizaine de requêtes en même temps.
const BACKGROUND_REFRESH_MAX_CONCURRENT = 2;
let backgroundRefreshesRunning = 0;

export type AchievementState = {
  /**
   * `grantedByStaff` : ouvert par le statut d'administrateur Kotbo sans avoir
   * été atteint. Le dashboard continue d'y afficher la progression réelle.
   */
  unlocked: Array<{ id: string; unlockedAt: string | null; grantedByStaff: boolean }>;
  metrics: RankCardAchievementMetrics;
};

function evaluationKey(userId: string): string {
  return `user:${userId}:achievements`;
}

function renderKey(userId: string): string {
  return `user:${userId}:achievements_render`;
}

function backgroundRefreshKey(userId: string): string {
  return `user:${userId}:achievements_refresh`;
}

async function isKotboStaff(userId: string): Promise<boolean> {
  if (process.env.DISCORD_CLIENT_OWNER_ID && userId === process.env.DISCORD_CLIENT_OWNER_ID) return true;
  const admin = await prisma.globalAdmin.findUnique({ where: { userId }, select: { userId: true } });
  return Boolean(admin);
}

/**
 * Crée l'ancienneté d'un payeur dont l'abonnement précède ce suivi. Le point de
 * départ est le consentement de paiement, seule trace durable de la
 * souscription ; à défaut, l'ancienneté démarre maintenant.
 *
 * Chaque souscription laisse son propre consentement : par serveur, seul le
 * plus récent date l'abonnement en cours, celui d'un abonnement résilié il y a
 * deux ans donnerait tout de suite « Grand mécène » à qui vient de se réabonner.
 * Entre serveurs, le plus ancien de ces départs l'emporte, pour qu'un nouveau
 * serveur payé ne remette pas à zéro un payeur de longue date.
 */
async function backfillSupporter(userId: string) {
  const guilds = await prismaRead.guild.findMany({
    where: {
      billingOwnerId: userId,
      stripeSubscriptionStatus: { in: PAYING_STATUSES },
      stripeCurrentPeriodEnd: { not: null },
    },
    select: { id: true, stripeCurrentPeriodEnd: true },
  });
  if (guilds.length === 0) return null;

  const consents = await prismaRead.billingConsent.findMany({
    where: { discordUserId: userId, kind: 'SUBSCRIPTION', guildId: { in: guilds.map((guild) => guild.id) } },
    orderBy: { createdAt: 'desc' },
    select: { guildId: true, createdAt: true },
  });
  const latestByGuild = new Map<string, Date>();
  for (const consent of consents) {
    if (consent.guildId && !latestByGuild.has(consent.guildId)) latestByGuild.set(consent.guildId, consent.createdAt);
  }
  const startedAt = latestByGuild.size > 0
    ? new Date(Math.min(...[...latestByGuild.values()].map((date) => date.getTime())))
    : new Date();
  const coveredUntil = new Date(Math.max(...guilds.map((guild) => guild.stripeCurrentPeriodEnd!.getTime())));

  return upsertRetryingRace(() => prisma.rankCardSupporter.upsert({
    where: { userId },
    update: {},
    create: { userId, streakStartedAt: startedAt, coveredUntil },
  }));
}

async function supporterMonths(userId: string): Promise<number> {
  const row = await prisma.rankCardSupporter.findUnique({ where: { userId } }) ?? await backfillSupporter(userId);
  if (!row) return 0;
  const end = Math.min(Date.now(), row.coveredUntil.getTime());
  return Math.max(0, Math.floor((end - row.streakStartedAt.getTime()) / MONTH_MS));
}

async function firstPlaces(userId: string): Promise<number> {
  const rows = await prismaRead.memberLevel.findMany({
    where: { userId, xp: { gt: 0 } },
    select: { guildId: true, xp: true },
    orderBy: { xp: 'desc' },
    take: FIRST_PLACE_MAX_GUILDS,
  });

  for (const row of rows) {
    // Une égalité ne fait pas un numéro un : sans cela, deux comptes à la même
    // XP obtenaient le succès ensemble.
    const rivals = await prismaRead.memberLevel.count({
      where: { guildId: row.guildId, userId: { not: userId }, xp: { gte: row.xp } },
    });
    if (rivals > 0) continue;
    // Les lignes à 0 XP (arrivée sans message, XP remise à zéro) ne comptent pas
    // comme membres : elles suffisaient à atteindre le seuil sur un serveur vide.
    const members = await prismaRead.memberLevel.count({ where: { guildId: row.guildId, xp: { gt: 0 } } });
    if (members >= FIRST_PLACE_MIN_MEMBERS) return 1;
  }
  return 0;
}

/**
 * Niveau recalculé depuis l'XP avec la courbe de chaque serveur : la colonne
 * `level` n'est pas fiable (import d'un autre bot, courbe modifiée depuis).
 *
 * Les configs sont lues sans `getOrCreateLevelConfig`, qui créerait une ligne
 * pour chaque serveur où le module n'a jamais été configuré.
 */
async function maxLevel(userId: string): Promise<number> {
  const rows = await prismaRead.memberLevel.findMany({
    where: { userId, xp: { gt: 0 } },
    select: { guildId: true, xp: true },
    orderBy: { xp: 'desc' },
    take: LEVEL_SCAN_MAX_GUILDS,
  });
  if (rows.length === 0) return 0;

  const configs = await prismaRead.levelConfig.findMany({
    where: { guildId: { in: rows.map((row) => row.guildId) } },
    select: { guildId: true, curveBaseXp: true, curveLinearXp: true, curveExponent: true, maxLevel: true },
  });
  const curves = new Map(configs.map((config) => [config.guildId, normalizeLevelCurve({
    baseXp: config.curveBaseXp,
    linearXp: config.curveLinearXp,
    exponent: config.curveExponent,
    maxLevel: config.maxLevel,
  })]));

  return Math.max(...rows.map((row) => levelFromXp(row.xp, curves.get(row.guildId) ?? DEFAULT_LEVEL_CURVE)));
}

type ComputedMetric = Exclude<RankCardAchievementMetric, 'manual'>;

const METRIC_READERS: Record<ComputedMetric, (userId: string) => Promise<number>> = {
  staff: async (userId) => (await isKotboStaff(userId) ? 1 : 0),
  supporterMonths,
  giftsOffered: (userId) => prismaRead.billingGift.count({
    where: { purchasedById: userId, paidAt: { not: null }, source: { not: 'ADMIN' } },
  }),
  maxLevel,
  firstPlaces,
  reputation: async (userId) => {
    const result = await prismaRead.reputationVote.aggregate({ where: { receiverId: userId }, _sum: { value: true } });
    return Math.max(0, result._sum.value ?? 0);
  },
  starboard: (userId) => prismaRead.starboardEntry.count({ where: { authorId: userId, postedAt: { not: null } } }),
  questsClaimed: (userId) => prismaRead.questProgress.count({ where: { userId, status: 'CLAIMED' } }),
};

/**
 * Évaluation complète : lit toutes les métriques, enregistre les succès
 * nouvellement atteints et renvoie l'état pour le dashboard.
 *
 * Le rendu de `/rank` passe par `getRenderableAchievements`, qui ne relit que
 * les succès déjà enregistrés. L'évaluation complète tourne depuis le dashboard
 * et, en arrière-plan, via `refreshAchievementsInBackground`.
 */
export async function evaluateAchievements(userId: string): Promise<AchievementState> {
  const cached = await cache.get<AchievementState>(evaluationKey(userId));
  if (cached) return cached;

  const persisted = await prisma.userAchievement.findMany({
    where: { userId },
    select: { achievementId: true, unlockedAt: true },
  });
  const persistedAt = new Map(persisted.map((row) => [row.achievementId, row.unlockedAt]));

  const metrics = { manual: 0 } as RankCardAchievementMetrics;
  const metricNames = Object.keys(METRIC_READERS) as ComputedMetric[];

  await Promise.all(metricNames.map(async (metric) => {
    const tiers = RANK_CARD_ACHIEVEMENTS.filter((achievement) => achievement.metric === metric);
    // Tous les paliers déjà acquis : relire la métrique ne changerait rien.
    if (tiers.every((achievement) => !achievement.revocable && persistedAt.has(achievement.id))) {
      metrics[metric] = Math.max(...tiers.map((achievement) => achievement.threshold));
      return;
    }
    try {
      metrics[metric] = await METRIC_READERS[metric](userId);
    } catch (error) {
      // Une métrique révocable à 0 retirerait des éléments déjà choisis, et
      // l'enregistrement suivant les effacerait : mieux vaut faire échouer la
      // requête. Les autres métriques ne font que retarder un déblocage.
      if (tiers.some((achievement) => achievement.revocable)) throw error;
      logger.warn('Achievements', `Métrique ${metric} illisible pour ${userId}:`, error);
      metrics[metric] = 0;
    }
  }));

  const reached = rankCardAchievementsFromMetrics(metrics);
  const toPersist = reached.filter((achievement) => !achievement.revocable && !persistedAt.has(achievement.id));

  if (toPersist.length > 0) {
    const now = new Date();
    await prisma.userAchievement.createMany({
      data: toPersist.map((achievement) => ({ userId, achievementId: achievement.id, unlockedAt: now })),
      skipDuplicates: true,
    });
    for (const achievement of toPersist) persistedAt.set(achievement.id, now);
    await cache.delete(renderKey(userId));
  }

  const reachedIds = new Set(reached.map((achievement) => achievement.id));
  const staff = reachedIds.has(STAFF_ACHIEVEMENT_ID);
  const unlocked = RANK_CARD_ACHIEVEMENTS
    .map((achievement) => ({
      achievement,
      earned: achievement.revocable ? reachedIds.has(achievement.id) : persistedAt.has(achievement.id),
    }))
    .filter(({ achievement, earned }) => earned || (staff && !isManualRankCardAchievement(achievement)))
    .map(({ achievement, earned }) => ({
      id: achievement.id,
      unlockedAt: persistedAt.get(achievement.id)?.toISOString() ?? null,
      grantedByStaff: !earned,
    }));

  const state = { unlocked, metrics };
  await cache.set(evaluationKey(userId), state, EVALUATION_TTL_SECONDS);
  return state;
}

/**
 * Succès utilisables pour dessiner la carte : ceux enregistrés, ou tout le
 * catalogue pour un administrateur Kotbo.
 *
 * Lève en cas d'échec plutôt que de renvoyer une liste vide : l'appelant
 * retirerait alors les éléments réservés et mettrait ce résultat en cache.
 */
export async function getRenderableAchievements(userId: string): Promise<Set<string>> {
  const cached = await cache.get<string[]>(renderKey(userId));
  if (cached) return new Set(cached);

  const [persisted, staff] = await Promise.all([
    prisma.userAchievement.findMany({ where: { userId }, select: { achievementId: true } }),
    isKotboStaff(userId),
  ]);
  const persistedIds = persisted.map((row) => row.achievementId);
  const ids = staff
    ? [...new Set([
      ...RANK_CARD_ACHIEVEMENTS.filter((achievement) => !isManualRankCardAchievement(achievement)).map((achievement) => achievement.id),
      ...persistedIds,
    ])]
    : persistedIds;
  await cache.set(renderKey(userId), ids, RENDER_TTL_SECONDS);
  return new Set(ids);
}

/**
 * Prolonge l'ancienneté d'un payeur jusqu'à `coveredUntil`. Appelée à chaque
 * synchronisation d'un abonnement payé : idempotente, un rejeu ne fait que
 * réécrire la même échéance.
 */
export async function recordSupporterCoverage(userId: string, coveredUntil: Date): Promise<void> {
  const now = new Date();
  const existing = await prisma.rankCardSupporter.findUnique({ where: { userId } }) ?? await backfillSupporter(userId);
  const lapsed = !existing || existing.coveredUntil.getTime() + SUPPORTER_GRACE_MS < now.getTime();
  // Un payeur de plusieurs serveurs reste couvert par l'échéance la plus lointaine.
  const nextCoveredUntil = existing && existing.coveredUntil > coveredUntil ? existing.coveredUntil : coveredUntil;

  await prisma.rankCardSupporter.upsert({
    where: { userId },
    update: { coveredUntil: nextCoveredUntil, ...(lapsed ? { streakStartedAt: now } : {}) },
    create: { userId, streakStartedAt: now, coveredUntil },
  });
  await cache.delete(evaluationKey(userId));
}

/**
 * Évaluation hors dashboard, sans jamais bloquer ni faire échouer l'appelant.
 *
 * Sans elle, un succès passager n'était enregistré que si le membre ouvrait le
 * dashboard au bon moment : premier du classement pendant un mois sans y aller,
 * il ne l'obtenait jamais. Espacée par membre, car l'évaluation parcourt les
 * classements de plusieurs serveurs.
 */
export function refreshAchievementsInBackground(userId: string): void {
  // Au-delà du plafond, l'appel est abandonné sans poser la clé d'espacement :
  // le prochain `/rank` ou la prochaine montée de niveau retentera.
  if (backgroundRefreshesRunning >= BACKGROUND_REFRESH_MAX_CONCURRENT) return;
  backgroundRefreshesRunning++;

  void (async () => {
    const key = backgroundRefreshKey(userId);
    if (await cache.get<boolean>(key)) return;
    await cache.set(key, true, BACKGROUND_REFRESH_TTL_SECONDS);
    // L'état en cache peut dater d'avant la montée de niveau qui déclenche cet appel.
    await cache.delete(evaluationKey(userId));
    await evaluateAchievements(userId);
  })()
    .catch((error) => {
      logger.warn('Achievements', `Évaluation en arrière-plan impossible pour ${userId}:`, error);
    })
    .finally(() => {
      backgroundRefreshesRunning--;
    });
}

export class ManualAchievementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ManualAchievementHolder = {
  userId: string;
  unlockedAt: string;
  grantedBy: string | null;
  note: string | null;
};

const MANUAL_NOTE_MAX_LENGTH = 300;

function requireManualAchievement(achievementId: string) {
  const achievement = getRankCardAchievement(achievementId);
  if (!achievement || !isManualRankCardAchievement(achievement)) {
    throw new ManualAchievementError("Ce succès n'existe pas ou ne s'attribue pas à la main.", 400);
  }
  return achievement;
}

async function invalidateAchievementCaches(userId: string): Promise<void> {
  await Promise.all([cache.delete(evaluationKey(userId)), cache.delete(renderKey(userId))]);
}

/** Détenteurs de chaque succès manuel, du plus récent au plus ancien. */
export async function listManualAchievementHolders(): Promise<Record<string, ManualAchievementHolder[]>> {
  const manualIds = RANK_CARD_ACHIEVEMENTS.filter(isManualRankCardAchievement).map((achievement) => achievement.id);
  const rows = await prisma.userAchievement.findMany({
    where: { achievementId: { in: manualIds } },
    orderBy: { unlockedAt: 'desc' },
  });

  const holders: Record<string, ManualAchievementHolder[]> = Object.fromEntries(manualIds.map((id) => [id, []]));
  for (const row of rows) {
    holders[row.achievementId].push({
      userId: row.userId,
      unlockedAt: row.unlockedAt.toISOString(),
      grantedBy: row.grantedBy,
      note: row.note,
    });
  }
  return holders;
}

/**
 * L'appelant vide aussi le cache de personnalisation (`rankCardService`), qui
 * importe ce module et ne peut donc pas être importé ici.
 */
export async function grantManualAchievement(
  userId: string,
  achievementId: string,
  grantedBy: string,
  rawNote: unknown,
): Promise<ManualAchievementHolder> {
  requireManualAchievement(achievementId);
  const note = typeof rawNote === 'string' && rawNote.trim()
    ? rawNote.trim().slice(0, MANUAL_NOTE_MAX_LENGTH)
    : null;

  // Pas de lecture préalable : deux clics simultanés passeraient tous deux la
  // vérification, et le second échouerait en erreur 500 sur la clé primaire.
  let row;
  try {
    row = await prisma.userAchievement.create({
      data: { userId, achievementId, grantedBy, note },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new ManualAchievementError('Ce membre a déjà ce succès.', 409);
    }
    throw error;
  }
  await invalidateAchievementCaches(userId);

  return { userId, unlockedAt: row.unlockedAt.toISOString(), grantedBy, note };
}

/**
 * Ne touche pas à la personnalisation enregistrée : un badge ou un décor lié au
 * succès retiré est écarté à la lecture, et revient si le succès est rendu.
 */
export async function revokeManualAchievement(userId: string, achievementId: string): Promise<void> {
  requireManualAchievement(achievementId);
  const { count } = await prisma.userAchievement.deleteMany({ where: { userId, achievementId } });
  if (count === 0) throw new ManualAchievementError("Ce membre n'a pas ce succès.", 404);
  await invalidateAchievementCaches(userId);
}
