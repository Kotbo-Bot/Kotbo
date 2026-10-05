/**
 * Calculs des tests A/B d'accueil, sans base ni Discord.
 *
 * Ce que montrent les outils d'expérimentation (GrowthBook, Statsig,
 * Optimizely), ramené à ce qu'un serveur Discord peut mesurer :
 * - une répartition déterministe : un membre qui revient retrouve sa version ;
 * - pour chaque version, le taux observé et l'écart relatif au contrôle ;
 * - la « chance de battre le contrôle », lisible par quelqu'un qui n'a jamais
 *   fait de statistiques, et la valeur p pour qui veut la vérifier ;
 * - le nombre d'arrivants qu'il faudrait pour conclure.
 */
import crypto from 'node:crypto';

export const EXPERIMENT_METRICS = ['retained_d1', 'retained_d7', 'retained_d30', 'activated_d7'] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

/** Jours d'observation nécessaires avant qu'un arrivant compte pour la mesure. */
export const METRIC_DAYS: Record<ExperimentMetric, number> = {
  retained_d1: 1,
  retained_d7: 7,
  retained_d30: 30,
  activated_d7: 7,
};

export interface ExperimentVariant {
  key: string;
  name: string;
  weight: number;
  /** Message de bienvenue de cette version ; `null` garde celui de la configuration. */
  message: string | null;
  /** Carte d'accueil : `null` suit la configuration. */
  imageEnabled: boolean | null;
  /** `false` désactive le fil d'accueil pour cette version ; `null` suit la configuration. */
  threadEnabled: boolean | null;
}

export class ExperimentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentValidationError';
  }
}

const KEYS = ['A', 'B', 'C', 'D'];

export function parseVariants(raw: unknown): ExperimentVariant[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > KEYS.length) {
    throw new ExperimentValidationError('Un test compte de 2 à 4 versions.');
  }
  return raw.map((item, index) => {
    const value = (item ?? {}) as Record<string, unknown>;
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 40) : `Version ${KEYS[index]}`;
    const weight = Math.trunc(Number(value.weight));
    const message = typeof value.message === 'string' && value.message.trim() ? value.message.trim().slice(0, 2000) : null;
    return {
      key: KEYS[index],
      name,
      weight: Number.isFinite(weight) && weight > 0 ? Math.min(100, weight) : 50,
      message,
      imageEnabled: typeof value.imageEnabled === 'boolean' ? value.imageEnabled : null,
      threadEnabled: value.threadEnabled === false ? false : null,
    };
  });
}

/**
 * Version attribuée à un membre : un hachage stable de (test, membre) placé
 * sur l'échelle des poids. Le même membre retombe toujours sur la même
 * version, même s'il quitte le serveur et revient.
 */
export function pickVariant(experimentId: string, userId: string, variants: ExperimentVariant[]): ExperimentVariant {
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const hash = crypto.createHash('sha1').update(`${experimentId}:${userId}`).digest();
  const bucket = (hash.readUInt32BE(0) / 0x1_0000_0000) * total;
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.weight;
    if (bucket < cursor) return variant;
  }
  return variants[variants.length - 1];
}

/** Fonction de répartition de la loi normale centrée réduite. */
export function normalCdf(x: number): number {
  // Approximation d'Abramowitz et Stegun (7.1.26), erreur < 1,5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface RateComparison {
  /** Écart relatif au contrôle : 0,12 = +12 %. */
  uplift: number | null;
  /** Probabilité que cette version fasse mieux que le contrôle. */
  chanceToBeat: number | null;
  /** Valeur p bilatérale du test de deux proportions. */
  pValue: number | null;
}

/**
 * Compare deux proportions. La chance de battre le contrôle suit
 * l'approximation normale des lois bêta a posteriori (a priori uniforme),
 * ce qu'affichent les outils bayésiens.
 */
export function compareRates(control: { n: number; k: number }, variant: { n: number; k: number }): RateComparison {
  if (control.n === 0 || variant.n === 0) return { uplift: null, chanceToBeat: null, pValue: null };
  const pa = control.k / control.n;
  const pb = variant.k / variant.n;

  // A posteriori Beta(k+1, n-k+1) : moyenne et variance.
  const post = (n: number, k: number) => {
    const a = k + 1;
    const b = n - k + 1;
    return { mean: a / (a + b), variance: (a * b) / ((a + b) ** 2 * (a + b + 1)) };
  };
  const A = post(control.n, control.k);
  const B = post(variant.n, variant.k);
  const chanceToBeat = normalCdf((B.mean - A.mean) / Math.sqrt(A.variance + B.variance));

  const pooled = (control.k + variant.k) / (control.n + variant.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.n + 1 / variant.n));
  const pValue = se === 0 ? null : 2 * (1 - normalCdf(Math.abs(pb - pa) / se));

  return { uplift: pa === 0 ? null : (pb - pa) / pa, chanceToBeat, pValue };
}

/**
 * Arrivants nécessaires par version pour détecter un écart relatif `mde`
 * (20 % par défaut) avec un risque de 5 % et une puissance de 80 %.
 */
export function requiredSampleSize(baselineRate: number, mde = 0.2): number | null {
  if (baselineRate <= 0 || baselineRate >= 1) return null;
  const p1 = baselineRate;
  const p2 = Math.min(0.999, p1 * (1 + mde));
  const zAlpha = 1.959964;
  const zBeta = 0.841621;
  return Math.ceil(((zAlpha + zBeta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (p2 - p1) ** 2);
}

/** Seuils de décision : comme GrowthBook, 95 % de chance et un minimum par version. */
export const DECISION_THRESHOLD = 0.95;
export const MIN_SAMPLE_PER_VARIANT = 30;
