/**
 * spam/types.ts - Types du moteur anti-spam comportemental.
 *
 * Le moteur produit des signaux répartis en familles. Le scoring applique des
 * rendements décroissants à l'intérieur d'une famille (deux signaux de
 * répétition disent la même chose) et un bonus de corroboration entre familles
 * différentes (répétition + automatisation + contenu concordent rarement par
 * hasard).
 */

export type SpamSignalType =
  // Automatisation : comment le message a été produit
  | 'no_typing'
  | 'paste_burst'
  | 'inhuman_rate'
  | 'regular_intervals'
  // Diffusion : où le message est parti
  | 'cross_channel_burst'
  | 'attachment_flood'
  // Répétition : combien de fois
  | 'near_duplicate'
  | 'repeat_identical'
  // Contenu : ce qui est dit
  | 'mention_burst'
  | 'everyone_attempt'
  | 'unicode_obfuscation'
  | 'invite_link'
  // Contexte : qui parle, et depuis quand
  | 'first_message_link'
  | 'link_from_newcomer';

export type SpamSignalFamily = 'AUTOMATION' | 'DIFFUSION' | 'REPETITION' | 'CONTENT' | 'CONTEXT';

export const SPAM_SIGNAL_FAMILY: Record<SpamSignalType, SpamSignalFamily> = {
  no_typing: 'AUTOMATION',
  paste_burst: 'AUTOMATION',
  inhuman_rate: 'AUTOMATION',
  regular_intervals: 'AUTOMATION',

  cross_channel_burst: 'DIFFUSION',
  attachment_flood: 'DIFFUSION',

  near_duplicate: 'REPETITION',
  repeat_identical: 'REPETITION',

  mention_burst: 'CONTENT',
  everyone_attempt: 'CONTENT',
  unicode_obfuscation: 'CONTENT',
  invite_link: 'CONTENT',

  first_message_link: 'CONTEXT',
  link_from_newcomer: 'CONTEXT',
};

/**
 * Familles atténuées par la confiance du membre.
 *
 * La confiance dit « ce membre a l'habitude de parler ici », donc elle
 * relativise *ce qui est dit* (CONTENT) et *qui le dit* (CONTEXT). Elle ne
 * relativise pas *comment le message a été produit* : un compte de confiance
 * qui se met soudain à poster sans frappe et en rafale est précisément le
 * scénario du compte compromis, celui qu'il ne faut surtout pas atténuer.
 */
export const TRUST_ATTENUATED_FAMILIES: ReadonlySet<SpamSignalFamily> = new Set<SpamSignalFamily>([
  'CONTENT',
  'CONTEXT',
]);

export type SpamSignal = {
  type: SpamSignalType;
  /** Confiance intrinsèque du signal, 0-100. */
  score: number;
  label: string;
  detail?: string;
};

export type SpamAction = 'NONE' | 'LOG' | 'DELETE' | 'TIMEOUT' | 'BAN';

/** Un message déjà observé pour ce membre (tampon circulaire en mémoire). */
export type RecentMessage = {
  at: number;
  channelId: string;
  /** Contenu normalisé (voir normalize.ts). */
  normalized: string;
  length: number;
  hasAttachment: boolean;
};

/** Éléments de confiance, tous optionnels : le moteur dégrade proprement. */
export type TrustContext = {
  accountAgeMs: number | null;
  membershipMs: number | null;
  messageCount: number;
  /** Le membre porte au moins un rôle autre que @everyone. */
  hasRole: boolean;
  /** Le membre porte un rôle de confiance explicite (staff, vérifié…). */
  isTrustedRole: boolean;
};

/** Réglages du moteur (sous-ensemble de SpamDetectionConfig, sans Prisma). */
export type SpamTuning = {
  windowSeconds: number;
  crossChannelThreshold: number;
  duplicateSimilarity: number;
  typingSignalEnabled: boolean;
  pasteSignalEnabled: boolean;
  crossChannelEnabled: boolean;
  duplicateEnabled: boolean;
  cadenceEnabled: boolean;
  contentEnabled: boolean;
  trustEnabled: boolean;
};

export const DEFAULT_TUNING: SpamTuning = {
  windowSeconds: 30,
  crossChannelThreshold: 3,
  duplicateSimilarity: 0.85,
  typingSignalEnabled: true,
  pasteSignalEnabled: true,
  crossChannelEnabled: true,
  duplicateEnabled: true,
  cadenceEnabled: true,
  contentEnabled: true,
  trustEnabled: true,
};

/** Entrée complète d'une évaluation. Aucune dépendance à discord.js : testable. */
export type SpamEvaluationContext = {
  now: number;
  content: string;
  channelId: string;
  attachmentCount: number;
  mentionCount: number;
  /** Le message a réellement mentionné @everyone (permission accordée). */
  mentionedEveryone: boolean;
  /** Historique récent du membre, du plus ancien au plus récent, message courant exclu. */
  history: RecentMessage[];
  /** Dernier `typingStart` observé pour ce membre, ou null. */
  lastTypingAt: number | null;
  /**
   * Premier `typingStart` de la saisie en cours (remis à zéro à chaque message
   * envoyé), ou null. Sert à estimer le temps passé à écrire ce message.
   */
  typingSessionStartAt: number | null;
  /**
   * false quand le bot n'a jamais observé le moindre événement de frappe sur la
   * guilde : l'intent est probablement absent, le signal serait faussé.
   */
  typingObservable: boolean;
  trust: TrustContext;
  tuning: SpamTuning;
};

export type SpamVerdict = {
  score: number;
  signals: SpamSignal[];
  distinctFamilies: number;
  familyBreakdown: Partial<Record<SpamSignalFamily, number>>;
  corroborationMultiplier: number;
  /** Multiplicateur appliqué aux familles atténuables (1 = aucune atténuation). */
  trustMultiplier: number;
};

/** Seuils d'action, alignés sur SpamDetectionConfig. */
export type SpamThresholds = {
  logThreshold: number;
  deleteThreshold: number;
  timeoutThreshold: number;
  banThreshold: number;
};

export function resolveAction(score: number, thresholds: SpamThresholds): SpamAction {
  if (score >= thresholds.banThreshold) return 'BAN';
  if (score >= thresholds.timeoutThreshold) return 'TIMEOUT';
  if (score >= thresholds.deleteThreshold) return 'DELETE';
  if (score >= thresholds.logThreshold) return 'LOG';
  return 'NONE';
}

/** Nombre de messages conservés par membre dans le tampon en mémoire. */
export const HISTORY_SIZE = 25;
