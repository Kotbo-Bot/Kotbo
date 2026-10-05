/**
 * spam/activityStore.ts - Fenêtre glissante d'activité par membre, en mémoire.
 *
 * Le moteur a besoin des derniers messages d'un membre et de sa dernière trace
 * de frappe. Passer par la base à chaque message serait absurde : ces données
 * ne servent que quelques secondes. Tout est donc en mémoire, borné, avec
 * éviction par ancienneté.
 *
 * Conséquence assumée : un redémarrage vide le contexte. Les signaux de rafale
 * repartent de zéro, ce qui est le bon comportement - mieux vaut rater les
 * premières secondes après un redémarrage que sanctionner sur un historique
 * reconstitué à moitié.
 */

import { HISTORY_SIZE, type RecentMessage } from './types.js';

type MemberActivity = {
  messages: RecentMessage[];
  lastTypingAt: number | null;
  /** Premier `typingStart` de la saisie en cours, remis à zéro à chaque message. */
  typingSessionStartAt: number | null;
  updatedAt: number;
};

const activity = new Map<string, MemberActivity>();

/**
 * Guildes où le bot a déjà observé au moins un événement de frappe.
 *
 * Sans l'intent GuildMessageTyping, `typingStart` n'arrive jamais et le signal
 * « posté sans frappe » marquerait l'intégralité du serveur. Tant qu'aucune
 * frappe n'a été vue sur une guilde, le signal est neutralisé.
 */
const typingObserved = new Set<string>();

/**
 * Au-delà de ce silence entre deux `typingStart`, la frappe suivante ouvre une
 * nouvelle saisie : un brouillon abandonné il y a une heure ne doit pas faire
 * passer un collage d'aujourd'hui pour une longue rédaction.
 */
const TYPING_SESSION_GAP_MS = 3 * 60 * 1000;

/** Entrées inactives évincées au-delà de ce délai. */
const ENTRY_TTL_MS = 15 * 60 * 1000;
/** Plafond dur, pour qu'un raid massif ne fasse pas gonfler la mémoire. */
const MAX_ENTRIES = 20_000;

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/** Balayage TTL périodique plutôt qu'à chaque message : la Map est grande. */
const SWEEP_EVERY = 500;
let sinceLastSweep = 0;

function prune(now: number): void {
  if (++sinceLastSweep >= SWEEP_EVERY) {
    sinceLastSweep = 0;
    for (const [k, entry] of activity) {
      if (now - entry.updatedAt > ENTRY_TTL_MS) activity.delete(k);
    }
  }

  // Filet de sécurité : sous un raid massif, le balayage périodique peut ne pas
  // suffire. On évince alors les plus anciennes (ordre d'insertion de Map).
  while (activity.size > MAX_ENTRIES) {
    const oldest = activity.keys().next().value;
    if (oldest === undefined) break;
    activity.delete(oldest);
  }
}

/** Historique récent d'un membre, du plus ancien au plus récent. */
export function getHistory(guildId: string, userId: string): RecentMessage[] {
  const entry = activity.get(key(guildId, userId));
  if (!entry) return [];
  const cutoff = Date.now() - ENTRY_TTL_MS;
  return entry.messages.filter((m) => m.at >= cutoff);
}

export function getLastTypingAt(guildId: string, userId: string): number | null {
  return activity.get(key(guildId, userId))?.lastTypingAt ?? null;
}

export function getTypingSessionStartAt(guildId: string, userId: string): number | null {
  return activity.get(key(guildId, userId))?.typingSessionStartAt ?? null;
}

/** true si le bot reçoit effectivement les événements de frappe sur cette guilde. */
export function isTypingObservable(guildId: string): boolean {
  return typingObserved.has(guildId);
}

export function recordTyping(guildId: string, userId: string, at = Date.now()): void {
  typingObserved.add(guildId);

  const k = key(guildId, userId);
  const entry = activity.get(k);
  if (entry) {
    const resumed =
      entry.typingSessionStartAt !== null &&
      entry.lastTypingAt !== null &&
      at - entry.lastTypingAt <= TYPING_SESSION_GAP_MS;
    if (!resumed) entry.typingSessionStartAt = at;
    entry.lastTypingAt = at;
    entry.updatedAt = at;
    return;
  }
  activity.set(k, { messages: [], lastTypingAt: at, typingSessionStartAt: at, updatedAt: at });
}

/** Enregistre un message dans le tampon du membre, après évaluation. */
export function recordMessage(guildId: string, userId: string, message: RecentMessage): void {
  const k = key(guildId, userId);
  const entry = activity.get(k) ?? {
    messages: [],
    lastTypingAt: null,
    typingSessionStartAt: null,
    updatedAt: message.at,
  };

  entry.messages.push(message);
  if (entry.messages.length > HISTORY_SIZE) {
    entry.messages.splice(0, entry.messages.length - HISTORY_SIZE);
  }
  entry.updatedAt = message.at;
  // Le message est parti : la prochaine frappe commence une nouvelle saisie.
  entry.typingSessionStartAt = null;

  activity.set(k, entry);
  prune(message.at);
}

/** Oublie un membre (après sanction : son historique n'a plus d'intérêt). */
export function forgetMember(guildId: string, userId: string): void {
  activity.delete(key(guildId, userId));
}

/** Réservé aux tests : remet le store à zéro. */
export function resetActivityStore(): void {
  activity.clear();
  typingObserved.clear();
  sinceLastSweep = 0;
}

/** Métriques pour le dashboard (taille du contexte en mémoire). */
export function activityStoreStats(): { entries: number; guildsWithTyping: number } {
  return { entries: activity.size, guildsWithTyping: typingObserved.size };
}
