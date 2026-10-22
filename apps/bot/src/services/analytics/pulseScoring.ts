/**
 * Modèle de scoring du Pulse - fonctions pures, sans I/O.
 *
 * Principes de calibration :
 *
 * 1. **Continuité.** Toutes les courbes sont monotones et continues : on passe
 *    par une saturation `x / (x + k)`, où `k` est la valeur qui vaut 50/100.
 *
 * 2. **Dénominateur humain.** Les ratios sont rapportés à `totalHumans`, pas à
 *    `totalMembers` : les bots ne postent pas, ne partent pas et ne se font pas
 *    sanctionner.
 *
 * 3. **Relatif à soi-même, à jour de semaine égal.** L'activité est comparée à
 *    la médiane des 28 derniers jours du serveur, et de préférence à la médiane
 *    des *mêmes jours de la semaine* : un mardi se juge face aux mardis. Sans
 *    cela, un serveur qui vit le week-end perdait des points chaque lundi.
 *
 * 4. **Repères ajustés à la taille.** La part de membres actifs baisse
 *    naturellement quand un serveur grandit (loi de puissance bien connue des
 *    communautés en ligne). Les repères absolus suivent `(humains / 100)^-0,3` :
 *    12 % d'actifs « moyens » à 100 humains, ~6 % à 1 000, ~24 % à 10.
 *
 * 5. **Facteurs explicables.** Chaque sous-score est la moyenne pondérée de
 *    facteurs mesurés (messages par humain, taux de réponse, toxicité…). Un
 *    facteur sans donnée (pas de tickets, AegisAI éteint, serveur sans vocal) est
 *    retiré et les poids restants sont renormalisés : on ne note pas ce qui
 *    n'existe pas. Chaque facteur porte son `impact` sur le score global, en
 *    points par rapport à une note neutre de 50 : c'est ce que le dashboard
 *    affiche dans « ce qui fait monter / baisser le score ».
 */

export interface PulseScoreInput {
  /** Membres humains (hors bots). */
  humans: number;
  totalMembers: number;
  messages: number;
  voiceMinutes: number;
  /** Membres ayant posté au moins un message. */
  activeMembers: number;
  /** Membres ayant rejoint au moins un salon vocal. */
  activeVoiceMembers: number;
  membersJoined: number;
  membersLeft: number;
  sanctionsCount: number;
  ticketsOpen: number;
  ticketsResolved: number;
  channelsHealthy: number;
  channelsUnhealthy: number;
  /** Médianes du serveur sur la fenêtre de référence (28 j), si disponibles. */
  baseline?: PulseBaseline | null;
  /** Arrivées et départs cumulés sur les 7 jours finissant au jour évalué. */
  week?: { joined: number; left: number; days: number } | null;
  /** Membres actifs distincts (texte ou vocal) le jour J et sur 28 jours. */
  audience?: { daily: number; monthly: number } | null;
  /** Prises de parole avec ou sans réponse, et réponses en moins de 15 min. */
  responses?: { answered: number; unanswered: number; fast: number } | null;
  /** Messages analysés par AegisAI et part jugée toxique. */
  toxicity?: { analyzed: number; toxic: number } | null;
}

export interface PulseReference {
  /** Messages par humain et par jour, médiane. */
  messagesPerHuman: number;
  /** Minutes vocales par humain et par jour, médiane. */
  voicePerHuman: number;
  /** Taux de participation quotidien, médiane. */
  participationRate: number;
}

export interface PulseBaseline extends PulseReference {
  /** Nombre de jours réellement observés (sert à pondérer la confiance). */
  sampleDays: number;
  /** Médianes des seuls jours tombant le même jour de la semaine. */
  sameWeekday?: (PulseReference & { samples: number }) | null;
}

export interface PulseScores {
  score: number;
  activityScore: number;
  moderationScore: number;
  growthScore: number;
  engagementScore: number;
  healthScore: number;
}

export type PulseDimension = 'activity' | 'engagement' | 'growth' | 'moderation' | 'health';

export type PulseFactorKey =
  | 'messages'
  | 'voice'
  | 'participation'
  | 'voiceParticipation'
  | 'depth'
  | 'stickiness'
  | 'responses'
  | 'netGrowth'
  | 'churn'
  | 'sanctions'
  | 'toxicity'
  | 'channels'
  | 'ticketResolution'
  | 'ticketBacklog';

export interface PulseFactor {
  key: PulseFactorKey;
  dimension: PulseDimension;
  /** Note du facteur, 0-100. */
  score: number;
  /** Part du facteur dans son sous-score, après retrait des facteurs absents. */
  weight: number;
  /** Points gagnés (+) ou perdus (−) sur le score global face à une note de 50. */
  impact: number;
  /** Valeur mesurée (ratio, taux ou volume selon le facteur). */
  value: number;
  /** Ce qui vaut « normal » pour ce serveur, à la même échelle que `value`. */
  reference: number | null;
  /** `server` : habitude du serveur ; `typical` : repère générique ajusté à la taille. */
  referenceKind: 'server' | 'typical';
}

export interface PulseBreakdown {
  scores: PulseScores;
  factors: PulseFactor[];
  /** Fiabilité du diagnostic, 0-100 : volume, historique, couverture des signaux. */
  confidence: number;
}

export type AlertSeverity = 'info' | 'warning' | 'danger' | 'success';

export interface PulseAlert {
  /** Catégorie historique, conservée pour compatibilité. */
  type: string;
  /** Identifiant stable, utilisé pour traduire côté client. */
  code: string;
  severity: AlertSeverity;
  /** Paramètres d'interpolation du message traduit. */
  params?: Record<string, number | string>;
  /** Rendu français pré-calculé (fallback pour le bot et le MCP). */
  message: string;
}

/** Version du modèle : à incrémenter dès qu'un calcul change, le cron recalcule l'historique. */
export const PULSE_MODEL_VERSION = 2;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function clampScore(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Saturation douce sur [0, 100) : `0 → 0`, `x = k → 50`, `x → ∞ → 100`.
 * Monotone croissante, dérivée décroissante, jamais discontinue.
 */
export function saturate(x: number, k: number): number {
  if (!(x > 0) || !(k > 0)) return 0;
  return (100 * x) / (x + k);
}

/** Saturation inversée : `0 → 100`, `x = k → 50`. Pour les métriques « moins c'est mieux ». */
export function saturateInverse(x: number, k: number): number {
  if (!(x > 0)) return 100;
  if (!(k > 0)) return 0;
  return (100 * k) / (x + k);
}

/** Médiane robuste (renvoie 0 sur un échantillon vide). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Score d'un ratio « valeur du jour / référence du serveur ».
 * `r = 1` (dans la norme) → ~59, `r = 2` → ~74, `r = 0.5` → ~42, `r = 0` → 0.
 */
function relativeScore(value: number, reference: number): number | null {
  if (!(reference > 0)) return null;
  return saturate(value / reference, 0.7);
}

/**
 * Poids accordé à la part relative, en fonction du nombre de jours observés.
 * Sous 7 jours d'historique la référence n'est pas fiable : on reste sur l'absolu.
 */
function baselineWeight(sampleDays: number): number {
  if (sampleDays < 7) return 0;
  return Math.min(0.5, 0.5 * ((sampleDays - 6) / 14));
}

/** Référence du jour : mêmes jours de semaine s'il y en a assez, sinon tous les jours. */
function referenceOf(base: PulseBaseline, pick: (r: PulseReference) => number): number {
  const same = base.sameWeekday;
  if (same && same.samples >= 3) return pick(same);
  return pick(base);
}

/**
 * Facteur d'échelle des repères absolus : `(humains / 100)^-0,3`, borné.
 * À 100 humains il vaut 1 (calibration d'origine).
 */
export function sizeFactor(humans: number): number {
  if (!(humans > 0)) return 1;
  return Math.max(0.35, Math.min(2.5, (humans / 100) ** -0.3));
}

// ---------------------------------------------------------------------------
// Constantes de calibration (valeur qui vaut 50/100 pour un serveur de 100 humains)
// ---------------------------------------------------------------------------

/** 0,8 message par humain et par jour = activité textuelle « moyenne ». */
const K_MESSAGES_PER_HUMAN = 0.8;
/** 4 minutes de vocal par humain et par jour. */
const K_VOICE_PER_HUMAN = 4;
/** 12 % d'humains actifs par jour = participation « moyenne » sur Discord. */
const K_PARTICIPATION = 0.12;
/** 4 % d'humains en vocal par jour. */
const K_VOICE_PARTICIPATION = 0.04;
/** 8 messages par membre actif = conversation de profondeur « moyenne ». */
const K_DEPTH = 8;
/** Adhérence DAU/MAU de 20 % : un actif du mois revient un jour sur cinq. */
const K_STICKINESS = 0.2;
/** 8 sanctions pour 100 membres actifs = modération « moyenne ». */
const K_SANCTION_RATE = 0.08;
/**
 * Lissage additif du dénominateur des sanctions.
 * Sans lui, sur un serveur à 5 actifs, une seule sanction ferait un taux de 20 %
 * et effondrerait le score : il faut un minimum de volume pour qu'un taux parle.
 */
const SANCTION_SMOOTHING = 20;
/** 4 % de messages jugés toxiques par AegisAI = climat « moyen ». */
const K_TOXICITY = 0.04;
/** 1 % de départs quotidiens = churn significatif. */
const K_CHURN = 0.01;
/** 3 tickets ouverts pour 100 humains = backlog « moyen ». */
const K_TICKET_BACKLOG = 0.03;

/** Volumes minimaux pour qu'un taux soit retenu comme facteur. */
const MIN_RESPONSE_TURNS = 10;
const MIN_TOXICITY_SAMPLE = 20;
const MIN_MONTHLY_AUDIENCE = 10;

/** Note d'un sous-score sans aucun facteur mesurable : rien à juger, ni blâme ni félicitations. */
const NEUTRAL_NOTHING_TO_JUDGE = 75;

/** Pondération du score global. La somme vaut 1. */
export const PULSE_WEIGHTS: Record<PulseDimension, number> = {
  activity: 0.25,
  engagement: 0.25,
  growth: 0.2,
  moderation: 0.15,
  health: 0.15,
};

// ---------------------------------------------------------------------------
// Facteurs
// ---------------------------------------------------------------------------

type RawFactor = Omit<PulseFactor, 'weight' | 'impact' | 'dimension'> & { baseWeight: number };

/** Mélange absolu / relatif d'une mesure, avec la référence affichée. */
function blended(
  value: number,
  typical: number,
  base: PulseBaseline | null | undefined,
  pick: (r: PulseReference) => number,
): { score: number; reference: number; referenceKind: 'server' | 'typical' } {
  const absolute = saturate(value, typical);
  const weight = base ? baselineWeight(base.sampleDays) : 0;
  if (!base || weight <= 0) return { score: absolute, reference: typical, referenceKind: 'typical' };
  const reference = referenceOf(base, pick);
  const relative = relativeScore(value, reference);
  if (relative === null) return { score: absolute, reference: typical, referenceKind: 'typical' };
  return { score: absolute * (1 - weight) + relative * weight, reference, referenceKind: 'server' };
}

/**
 * Un serveur qui ne fait pas de vocal n'a pas à être pénalisé pour ça : le
 * facteur vocal est retiré tant que rien ne se passe ni aujourd'hui ni d'habitude.
 */
function voiceIsUsed(input: PulseScoreInput): boolean {
  if (input.voiceMinutes > 0) return true;
  const base = input.baseline;
  return Boolean(base && base.sampleDays >= 7 && base.voicePerHuman > 0);
}

function activityFactors(input: PulseScoreInput): RawFactor[] {
  const humans = input.humans;
  const sf = sizeFactor(humans);
  const messagesPerHuman = input.messages / humans;
  const factors: RawFactor[] = [
    { key: 'messages', baseWeight: 0.65, value: messagesPerHuman, ...blended(messagesPerHuman, K_MESSAGES_PER_HUMAN * sf, input.baseline, (r) => r.messagesPerHuman) },
  ];
  if (voiceIsUsed(input)) {
    const voicePerHuman = input.voiceMinutes / humans;
    factors.push({ key: 'voice', baseWeight: 0.35, value: voicePerHuman, ...blended(voicePerHuman, K_VOICE_PER_HUMAN * sf, input.baseline, (r) => r.voicePerHuman) });
  }
  return factors;
}

function engagementFactors(input: PulseScoreInput): RawFactor[] {
  const humans = input.humans;
  const sf = sizeFactor(humans);
  const participation = input.activeMembers / humans;
  const factors: RawFactor[] = [
    { key: 'participation', baseWeight: 0.35, value: participation, ...blended(participation, K_PARTICIPATION * sf, input.baseline, (r) => r.participationRate) },
  ];

  if (voiceIsUsed(input)) {
    const typical = K_VOICE_PARTICIPATION * sf;
    const voiceParticipation = input.activeVoiceMembers / humans;
    factors.push({ key: 'voiceParticipation', baseWeight: 0.1, value: voiceParticipation, score: saturate(voiceParticipation, typical), reference: typical, referenceKind: 'typical' });
  }

  if (input.activeMembers > 0) {
    const depth = input.messages / input.activeMembers;
    factors.push({ key: 'depth', baseWeight: 0.15, value: depth, score: saturate(depth, K_DEPTH), reference: K_DEPTH, referenceKind: 'typical' });
  }

  const audience = input.audience;
  if (audience && audience.monthly >= MIN_MONTHLY_AUDIENCE) {
    const stickiness = audience.daily / audience.monthly;
    factors.push({ key: 'stickiness', baseWeight: 0.2, value: stickiness, score: saturate(stickiness, K_STICKINESS), reference: K_STICKINESS, referenceKind: 'typical' });
  }

  const responses = input.responses;
  const turns = responses ? responses.answered + responses.unanswered : 0;
  if (responses && turns >= MIN_RESPONSE_TURNS) {
    const rate = responses.answered / turns;
    const fastShare = responses.answered > 0 ? responses.fast / responses.answered : 0;
    // Être répondu compte plus qu'être répondu vite.
    factors.push({ key: 'responses', baseWeight: 0.2, value: rate, score: 100 * (0.75 * rate + 0.25 * fastShare), reference: null, referenceKind: 'typical' });
  }

  return factors;
}

function growthFactors(input: PulseScoreInput): RawFactor[] {
  const humans = input.humans;
  // Un jour isolé est très bruité : on le mélange à la moyenne de la semaine.
  const week = input.week && input.week.days >= 3 ? input.week : null;
  const blend = (day: number, weekTotal: number | undefined) =>
    week && weekTotal !== undefined ? 0.4 * day + 0.6 * (weekTotal / week.days) : day;

  const joined = blend(input.membersJoined, week?.joined);
  const left = blend(input.membersLeft, week?.left);
  const netRate = (joined - left) / humans;
  const churnRate = left / humans;

  return [
    // tanh : symétrique autour de 0, sature en douceur. +1 %/j → ~92, −1 %/j → ~8.
    { key: 'netGrowth', baseWeight: 0.7, value: netRate, score: 50 + 50 * Math.tanh(netRate * 125), reference: 0, referenceKind: 'typical' },
    // Porte tournante : une croissance nette positive peut cacher beaucoup de
    // départs. Sans départ le facteur est neutre (50), il ne fait que retirer.
    { key: 'churn', baseWeight: 0.3, value: churnRate, score: 50 - 50 * (churnRate / (churnRate + K_CHURN)), reference: K_CHURN, referenceKind: 'typical' },
  ];
}

function moderationFactors(input: PulseScoreInput): RawFactor[] {
  const factors: RawFactor[] = [];
  // Le taux se rapporte aux membres *actifs* : un inactif ne peut pas enfreindre les règles.
  if (input.activeMembers > 0 || input.sanctionsCount > 0) {
    const rate = input.sanctionsCount / (input.activeMembers + SANCTION_SMOOTHING);
    factors.push({ key: 'sanctions', baseWeight: 0.6, value: rate, score: saturateInverse(rate, K_SANCTION_RATE), reference: K_SANCTION_RATE, referenceKind: 'typical' });
  }
  const tox = input.toxicity;
  if (tox && tox.analyzed >= MIN_TOXICITY_SAMPLE) {
    const rate = tox.toxic / tox.analyzed;
    factors.push({ key: 'toxicity', baseWeight: 0.4, value: rate, score: saturateInverse(rate, K_TOXICITY), reference: K_TOXICITY, referenceKind: 'typical' });
  }
  return factors;
}

function healthFactors(input: PulseScoreInput): RawFactor[] {
  const factors: RawFactor[] = [];
  const totalChannels = input.channelsHealthy + input.channelsUnhealthy;
  if (totalChannels > 0) {
    const share = input.channelsHealthy / totalChannels;
    factors.push({ key: 'channels', baseWeight: 0.5, value: share, score: share * 100, reference: null, referenceKind: 'typical' });
  }
  const handled = input.ticketsResolved + input.ticketsOpen;
  if (handled > 0) {
    const rate = input.ticketsResolved / handled;
    factors.push({ key: 'ticketResolution', baseWeight: 0.25, value: rate, score: rate * 100, reference: null, referenceKind: 'typical' });
    // Le backlog absolu compte autant que le taux : 3 tickets ouverts sur 100
    // humains, ce n'est pas la même chose que sur 10 000.
    const backlog = input.ticketsOpen / input.humans;
    factors.push({ key: 'ticketBacklog', baseWeight: 0.25, value: input.ticketsOpen, score: saturateInverse(backlog, K_TICKET_BACKLOG), reference: Math.round(K_TICKET_BACKLOG * input.humans), referenceKind: 'typical' });
  }
  return factors;
}

/** Moyenne pondérée des facteurs, poids renormalisés sur ceux qui existent. */
function combine(dimension: PulseDimension, raw: RawFactor[], fallback: number): { score: number; factors: PulseFactor[] } {
  const total = raw.reduce((sum, f) => sum + f.baseWeight, 0);
  if (total <= 0) return { score: fallback, factors: [] };
  const factors = raw.map(({ baseWeight, ...f }) => {
    const weight = baseWeight / total;
    const score = Math.max(0, Math.min(100, Number.isFinite(f.score) ? f.score : 0));
    return {
      ...f,
      dimension,
      score: Math.round(score),
      weight: Math.round(weight * 1000) / 1000,
      impact: Math.round((score - 50) * weight * PULSE_WEIGHTS[dimension] * 10) / 10,
    };
  });
  const score = raw.reduce((sum, f, i) => sum + factors[i].score * (f.baseWeight / total), 0);
  return { score, factors };
}

function dimensionResult(input: PulseScoreInput, dimension: PulseDimension) {
  if (input.humans <= 0) {
    // Aucun humain : activité et engagement à 0, le reste neutre.
    const empty: Record<PulseDimension, number> = { activity: 0, engagement: 0, growth: 50, moderation: NEUTRAL_NOTHING_TO_JUDGE, health: NEUTRAL_NOTHING_TO_JUDGE };
    return { score: empty[dimension], factors: [] as PulseFactor[] };
  }
  switch (dimension) {
    case 'activity': return combine('activity', activityFactors(input), 0);
    case 'engagement': return combine('engagement', engagementFactors(input), 0);
    case 'growth': return combine('growth', growthFactors(input), 50);
    case 'moderation': return combine('moderation', moderationFactors(input), NEUTRAL_NOTHING_TO_JUDGE);
    case 'health': return combine('health', healthFactors(input), NEUTRAL_NOTHING_TO_JUDGE);
  }
}

// ---------------------------------------------------------------------------
// Sous-scores
// ---------------------------------------------------------------------------

export const computeActivityScore = (input: PulseScoreInput) => clampScore(dimensionResult(input, 'activity').score);
export const computeEngagementScore = (input: PulseScoreInput) => clampScore(dimensionResult(input, 'engagement').score);
export const computeGrowthScore = (input: PulseScoreInput) => clampScore(dimensionResult(input, 'growth').score);
export const computeModerationScore = (input: PulseScoreInput) => clampScore(dimensionResult(input, 'moderation').score);
export const computeHealthScore = (input: PulseScoreInput) => clampScore(dimensionResult(input, 'health').score);

const DIMENSIONS: PulseDimension[] = ['activity', 'engagement', 'growth', 'moderation', 'health'];
const ALL_FACTOR_COUNT = 14;

/**
 * Fiabilité du diagnostic. Un score calculé sur 4 membres actifs, sans
 * historique et avec la moitié des signaux absents ne vaut pas un score
 * calculé sur 300 actifs et un mois de recul : le dashboard l'affiche.
 */
export function computeConfidence(input: PulseScoreInput, factorCount: number): number {
  if (input.humans <= 0) return 0;
  const volume = Math.min(1, input.activeMembers / 25);
  const history = Math.min(1, (input.baseline?.sampleDays ?? 0) / 21);
  const size = Math.min(1, input.humans / 50);
  const coverage = Math.min(1, factorCount / (ALL_FACTOR_COUNT * 0.6));
  return clampScore(100 * (0.4 * volume + 0.3 * history + 0.15 * size + 0.15 * coverage));
}

export function computePulseBreakdown(input: PulseScoreInput): PulseBreakdown {
  const results = Object.fromEntries(DIMENSIONS.map((d) => [d, dimensionResult(input, d)])) as Record<
    PulseDimension,
    { score: number; factors: PulseFactor[] }
  >;
  const sub = (d: PulseDimension) => clampScore(results[d].score);

  const scores: PulseScores = {
    score: clampScore(DIMENSIONS.reduce((sum, d) => sum + results[d].score * PULSE_WEIGHTS[d], 0)),
    activityScore: sub('activity'),
    engagementScore: sub('engagement'),
    growthScore: sub('growth'),
    moderationScore: sub('moderation'),
    healthScore: sub('health'),
  };
  const factors = DIMENSIONS.flatMap((d) => results[d].factors);
  return { scores, factors, confidence: computeConfidence(input, factors.length) };
}

export function computePulseScores(input: PulseScoreInput): PulseScores {
  return computePulseBreakdown(input).scores;
}

// ---------------------------------------------------------------------------
// Alertes
// ---------------------------------------------------------------------------

/**
 * Le serveur a-t-il assez de matière pour qu'un diagnostic ait du sens ?
 * Sans ce garde-fou, une guilde fraîchement ajoutée déclenchait « activité très
 * faible » et « croissance stagnante » dès le premier snapshot.
 */
export function hasEnoughSignal(input: PulseScoreInput): boolean {
  return input.humans >= 5 && (input.messages > 0 || input.voiceMinutes > 0 || input.membersJoined > 0);
}

export function generateAlerts(scores: PulseScores, input: PulseScoreInput): PulseAlert[] {
  const alerts: PulseAlert[] = [];

  if (!hasEnoughSignal(input)) {
    alerts.push({
      type: 'data',
      code: 'insufficient_data',
      severity: 'info',
      message: "Pas encore assez de données pour un diagnostic fiable.",
    });
    return alerts;
  }

  const push = (type: string, code: string, severity: AlertSeverity, message: string, params?: Record<string, number | string>) => {
    alerts.push({ type, code, severity, message, params });
  };

  if (scores.activityScore < 30) {
    push('activity', 'activity_critical', 'danger', 'Activité très faible - le serveur est en sommeil.');
  } else if (scores.activityScore < 50) {
    push('activity', 'activity_low', 'warning', 'Activité en dessous de la normale du serveur.');
  }

  if (scores.moderationScore < 35) {
    push('moderation', 'moderation_critical', 'danger', 'Taux de sanctions élevé - vérifiez les conflits en cours.', {
      count: input.sanctionsCount,
    });
  }

  const tox = input.toxicity;
  if (tox && tox.analyzed >= MIN_TOXICITY_SAMPLE && tox.toxic / tox.analyzed > K_TOXICITY * 1.5) {
    push('moderation', 'toxicity_high', 'warning', `Climat tendu : ${Math.round((100 * tox.toxic) / tox.analyzed)} % de messages jugés toxiques.`, {
      pct: Math.round((100 * tox.toxic) / tox.analyzed),
    });
  }

  if (scores.growthScore < 30) {
    push('growth', 'growth_critical', 'danger', 'Le serveur perd des membres - analysez les départs.', {
      left: input.membersLeft,
    });
  } else if (scores.growthScore < 45) {
    push('growth', 'growth_stagnant', 'warning', 'Croissance stagnante.');
  }

  // Porte tournante : autant d'arrivées que de départs, l'acquisition ne convertit pas.
  const churnRate = input.membersLeft / Math.max(input.humans, 1);
  if (churnRate > 0.01 && input.membersLeft >= 3 && input.membersJoined >= input.membersLeft) {
    push('growth', 'growth_churn', 'warning', `${input.membersLeft} départs compensés par les arrivées - la rétention est faible.`, {
      left: input.membersLeft,
      joined: input.membersJoined,
    });
  }

  if (scores.engagementScore < 30) {
    push('engagement', 'engagement_low', 'warning', 'Faible engagement - peu de membres participent activement.');
  }

  const responses = input.responses;
  const turns = responses ? responses.answered + responses.unanswered : 0;
  if (responses && turns >= MIN_RESPONSE_TURNS * 2 && responses.unanswered / turns > 0.5) {
    const pct = Math.round((100 * responses.unanswered) / turns);
    push('engagement', 'responses_low', 'warning', `${pct} % des prises de parole restent sans réponse.`, { pct });
  }

  if (input.ticketsOpen > 10) {
    push('tickets', 'tickets_backlog', 'warning', `${input.ticketsOpen} tickets ouverts en attente.`, {
      count: input.ticketsOpen,
    });
  }

  if (input.channelsUnhealthy > 0 && scores.healthScore < 45) {
    push('health', 'channels_unhealthy', 'warning', `${input.channelsUnhealthy} salons en mauvaise santé détectés.`, {
      count: input.channelsUnhealthy,
    });
  }

  if (scores.activityScore > 75 && scores.engagementScore > 75 && scores.growthScore > 60) {
    push('positive', 'excellent', 'success', 'Excellente dynamique - le serveur est en pleine forme !');
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Tendance et comparaison
// ---------------------------------------------------------------------------

/** Seuil de variation à partir duquel une tendance est jugée significative. */
export const TREND_THRESHOLD = 3;

export function resolveTrend(delta: number): 'UP' | 'DOWN' | 'STABLE' {
  if (delta > TREND_THRESHOLD) return 'UP';
  if (delta < -TREND_THRESHOLD) return 'DOWN';
  return 'STABLE';
}

/**
 * Écart du jour face à la médiane des jours précédents (7 au plus).
 * Comparer à la seule veille faisait varier la tendance au gré d'un dimanche
 * creux ; la médiane d'une semaine donne le niveau habituel.
 */
export function trendAgainst(score: number, previousScores: number[]): { trend: 'UP' | 'DOWN' | 'STABLE'; delta: number } {
  if (previousScores.length === 0) return { trend: 'STABLE', delta: 0 };
  const delta = Math.round(score - median(previousScores.slice(0, 7)));
  return { trend: resolveTrend(delta), delta };
}

/**
 * Rang centile d'un score parmi des pairs : part des pairs moins bien notés,
 * les ex æquo comptant pour moitié. `null` sous `minPeers`, pour qu'un
 * classement sur trois serveurs ne passe pas pour une statistique.
 */
export function percentileRank(score: number, peers: number[], minPeers = 8): number | null {
  if (peers.length < minPeers) return null;
  let below = 0;
  let equal = 0;
  for (const p of peers) {
    if (p < score) below++;
    else if (p === score) equal++;
  }
  return Math.round((100 * (below + equal / 2)) / peers.length);
}
