/**
 * Tests A/B de l'accueil : attribution d'une version à chaque arrivant, puis
 * mesure de ce que chaque version produit.
 *
 * Un seul test tourne à la fois sur un serveur : deux tests simultanés sur le
 * même message se contamineraient. Les mesures se calculent à la demande, à
 * partir des tables déjà tenues par le bot (profils et statistiques
 * quotidiennes des membres) : le test n'ajoute aucune collecte.
 */
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import {
  DECISION_THRESHOLD,
  EXPERIMENT_METRICS,
  METRIC_DAYS,
  MIN_SAMPLE_PER_VARIANT,
  compareRates,
  parseVariants,
  pickVariant,
  requiredSampleSize,
  type ExperimentMetric,
  type ExperimentVariant,
  type RateComparison,
} from './welcomeExperimentMath.js';

const DAY = 86_400_000;
const MAX_ASSIGNMENTS = 50_000;

interface RunningExperiment {
  id: string;
  variants: ExperimentVariant[];
}

const runningKey = (guildId: string) => `guild:${guildId}:welcome-experiment`;

/** Le test en cours, mis en cache une minute : lu à chaque arrivée. */
async function getRunningExperiment(guildId: string): Promise<RunningExperiment | null> {
  const cached = await cache.wrap(runningKey(guildId), 60, async () => {
    const row = await prisma.welcomeExperiment.findFirst({
      where: { guildId, status: 'RUNNING' },
      select: { id: true, variants: true },
    });
    // `cache.wrap` ne garde pas `null` : un objet vide dit « aucun test ».
    if (!row) return { id: '' as string, variants: [] as ExperimentVariant[] };
    try {
      return { id: row.id, variants: parseVariants(row.variants) };
    } catch {
      return { id: '', variants: [] };
    }
  });
  return cached.id ? cached : null;
}

/**
 * Version de l'accueil pour un arrivant, ou `null` hors test. L'attribution
 * est enregistrée une fois ; un membre qui revient garde la première.
 */
export async function assignWelcomeVariant(guildId: string, userId: string): Promise<ExperimentVariant | null> {
  try {
    const experiment = await getRunningExperiment(guildId);
    if (!experiment) return null;
    const variant = pickVariant(experiment.id, userId, experiment.variants);
    await prisma.welcomeExperimentAssignment.createMany({
      data: [{ experimentId: experiment.id, guildId, userId, variantKey: variant.key }],
      skipDuplicates: true,
    });
    return variant;
  } catch (err) {
    // Un test en panne ne doit jamais empêcher l'accueil du membre.
    logger.warn('WelcomeExperiment', `Attribution impossible pour ${userId} sur ${guildId} :`, err);
    return null;
  }
}

export async function invalidateRunningExperiment(guildId: string): Promise<void> {
  await cache.invalidateGuild(guildId);
}

// ── Résultats ───────────────────────────────────────────

export interface MetricResult {
  /** Arrivants assez anciens pour être mesurés. */
  eligible: number;
  success: number;
  rate: number | null;
  vsControl: RateComparison | null;
}

export interface VariantResult {
  key: string;
  name: string;
  weight: number;
  assigned: number;
  metrics: Record<ExperimentMetric, MetricResult>;
  /** Messages envoyés en moyenne pendant les 7 premiers jours. */
  messagesFirstWeek: number | null;
}

export interface ExperimentResults {
  variants: VariantResult[];
  primaryMetric: ExperimentMetric;
  recommendation: {
    status: 'collecting' | 'winner' | 'control_wins' | 'no_difference';
    winnerKey: string | null;
    /** Arrivants mesurés qu'il faudrait par version pour conclure. */
    neededPerVariant: number | null;
  };
}

interface MemberOutcome {
  userId: string;
  variantKey: string;
  assignedAt: Date;
  leftAt: Date | null;
  messagesByDay: Map<number, number>;
}

/** Arrivant encore là N jours après son arrivée ? `null` tant qu'il est trop tôt pour le dire. */
export function retainedAfter(outcome: Pick<MemberOutcome, 'assignedAt' | 'leftAt'>, days: number, now: number): boolean | null {
  const deadline = outcome.assignedAt.getTime() + days * DAY;
  if (deadline > now) return null;
  return !outcome.leftAt || outcome.leftAt.getTime() > deadline;
}

/** A écrit au moins un message dans ses N premiers jours ? */
export function activatedWithin(outcome: Pick<MemberOutcome, 'assignedAt' | 'messagesByDay'>, days: number, now: number): boolean | null {
  if (outcome.assignedAt.getTime() + days * DAY > now) return null;
  for (let day = 0; day < days; day += 1) if ((outcome.messagesByDay.get(day) ?? 0) > 0) return true;
  return false;
}

export function summarize(
  variants: ExperimentVariant[],
  outcomes: MemberOutcome[],
  primaryMetric: ExperimentMetric,
  now = Date.now(),
): ExperimentResults {
  const byVariant = new Map(variants.map((variant) => [variant.key, [] as MemberOutcome[]]));
  for (const outcome of outcomes) byVariant.get(outcome.variantKey)?.push(outcome);

  const measure = (list: MemberOutcome[], metric: ExperimentMetric) => {
    let eligible = 0;
    let success = 0;
    for (const outcome of list) {
      const result = metric === 'activated_d7'
        ? activatedWithin(outcome, 7, now)
        : retainedAfter(outcome, METRIC_DAYS[metric], now);
      if (result === null) continue;
      eligible += 1;
      if (result) success += 1;
    }
    return { eligible, success };
  };

  const raw = variants.map((variant) => {
    const list = byVariant.get(variant.key) ?? [];
    const metrics = Object.fromEntries(EXPERIMENT_METRICS.map((metric) => [metric, measure(list, metric)])) as Record<ExperimentMetric, { eligible: number; success: number }>;
    const mature = list.filter((outcome) => outcome.assignedAt.getTime() + 7 * DAY <= now);
    const messages = mature.map((outcome) => [...outcome.messagesByDay.entries()].filter(([day]) => day < 7).reduce((sum, [, count]) => sum + count, 0));
    return {
      variant,
      assigned: list.length,
      metrics,
      messagesFirstWeek: messages.length ? Math.round((messages.reduce((a, b) => a + b, 0) / messages.length) * 10) / 10 : null,
    };
  });

  const control = raw[0];
  const results: VariantResult[] = raw.map((entry, index) => ({
    key: entry.variant.key,
    name: entry.variant.name,
    weight: entry.variant.weight,
    assigned: entry.assigned,
    messagesFirstWeek: entry.messagesFirstWeek,
    metrics: Object.fromEntries(EXPERIMENT_METRICS.map((metric) => {
      const own = entry.metrics[metric];
      const base = control.metrics[metric];
      return [metric, {
        eligible: own.eligible,
        success: own.success,
        rate: own.eligible ? own.success / own.eligible : null,
        vsControl: index === 0 ? null : compareRates({ n: base.eligible, k: base.success }, { n: own.eligible, k: own.success }),
      }];
    })) as Record<ExperimentMetric, MetricResult>,
  }));

  // ── Recommandation sur la mesure principale ──
  const primary = results.map((result) => result.metrics[primaryMetric]);
  const enough = primary.every((metric) => metric.eligible >= MIN_SAMPLE_PER_VARIANT);
  const baseRate = primary[0].rate;
  const neededPerVariant = baseRate !== null ? requiredSampleSize(baseRate) : null;

  let status: ExperimentResults['recommendation']['status'] = 'collecting';
  let winnerKey: string | null = null;
  if (enough) {
    const challengers = results.slice(1).map((result) => ({ key: result.key, chance: result.metrics[primaryMetric].vsControl?.chanceToBeat ?? null }));
    const best = challengers.filter((c) => c.chance !== null).sort((a, b) => (b.chance ?? 0) - (a.chance ?? 0))[0];
    if (best && (best.chance ?? 0) >= DECISION_THRESHOLD) {
      status = 'winner';
      winnerKey = best.key;
    } else if (challengers.every((c) => c.chance !== null && c.chance <= 1 - DECISION_THRESHOLD)) {
      status = 'control_wins';
      winnerKey = results[0].key;
    } else if (neededPerVariant !== null && primary.every((metric) => metric.eligible >= neededPerVariant)) {
      status = 'no_difference';
    }
  }

  return { variants: results, primaryMetric, recommendation: { status, winnerKey, neededPerVariant } };
}

const dayIndex = (dateKey: string, assignedAt: Date) =>
  Math.floor((Date.parse(`${dateKey}T00:00:00Z`) - Date.UTC(assignedAt.getUTCFullYear(), assignedAt.getUTCMonth(), assignedAt.getUTCDate())) / DAY);

export async function getExperimentResults(guildId: string, experimentId: string): Promise<ExperimentResults | null> {
  const experiment = await prisma.welcomeExperiment.findFirst({
    where: { id: experimentId, guildId },
    select: { variants: true, primaryMetric: true },
  });
  if (!experiment) return null;
  const variants = parseVariants(experiment.variants);
  const primaryMetric = (EXPERIMENT_METRICS as readonly string[]).includes(experiment.primaryMetric)
    ? experiment.primaryMetric as ExperimentMetric
    : 'retained_d7';

  const assignments = await prisma.welcomeExperimentAssignment.findMany({
    where: { experimentId },
    select: { userId: true, variantKey: true, assignedAt: true },
    take: MAX_ASSIGNMENTS,
  });

  const outcomes = new Map<string, MemberOutcome>(assignments.map((row) => [row.userId, {
    userId: row.userId,
    variantKey: row.variantKey,
    assignedAt: row.assignedAt,
    leftAt: null,
    messagesByDay: new Map<number, number>(),
  }]));

  const userIds = [...outcomes.keys()];
  const firstKey = assignments.length
    ? new Date(Math.min(...assignments.map((row) => row.assignedAt.getTime()))).toISOString().slice(0, 10)
    : null;

  for (let index = 0; index < userIds.length; index += 5_000) {
    const chunk = userIds.slice(index, index + 5_000);
    const [profiles, stats] = await Promise.all([
      prisma.memberProfile.findMany({ where: { guildId, userId: { in: chunk } }, select: { userId: true, guildLeftAt: true } }),
      firstKey
        ? prisma.memberDailyStat.findMany({
          where: { guildId, userId: { in: chunk }, dateKey: { gte: firstKey }, messagesCount: { gt: 0 } },
          select: { userId: true, dateKey: true, messagesCount: true },
        })
        : Promise.resolve([]),
    ]);
    for (const profile of profiles) {
      const outcome = outcomes.get(profile.userId);
      // Un départ antérieur à l'arrivée mesurée appartient à un séjour précédent.
      if (outcome && profile.guildLeftAt && profile.guildLeftAt >= outcome.assignedAt) outcome.leftAt = profile.guildLeftAt;
    }
    for (const stat of stats) {
      const outcome = outcomes.get(stat.userId);
      if (!outcome) continue;
      const day = dayIndex(stat.dateKey, outcome.assignedAt);
      if (day >= 0 && day < 31) outcome.messagesByDay.set(day, (outcome.messagesByDay.get(day) ?? 0) + stat.messagesCount);
    }
  }

  return summarize(variants, [...outcomes.values()], primaryMetric);
}
