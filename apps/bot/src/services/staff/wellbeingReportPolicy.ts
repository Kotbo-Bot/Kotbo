/** Ce que voit un membre : signalements, code de suivi, fil anonyme et ressources d'aide. */
import { createHash, randomInt } from 'node:crypto';
import { trimmedText } from './wellbeingPolicyShared.js';

// ── Signalements ───────────────────────────────────────────────────────────

/**
 * Modèles du message permanent publié dans un salon : le texte change, les
 * trois boutons restent. Le premier est celui par défaut.
 */
export const REPORT_PANEL_TEMPLATES = ['listening', 'short', 'staff', 'anonymous'] as const;
export type ReportPanelTemplate = (typeof REPORT_PANEL_TEMPLATES)[number];

export function cleanPanelTemplate(input: unknown): ReportPanelTemplate {
  return REPORT_PANEL_TEMPLATES.find((template) => template === input) ?? REPORT_PANEL_TEMPLATES[0];
}

/** Un même membre n'envoie qu'un signalement par période : la cellule n'est pas noyée. */
export const REPORT_COOLDOWN_MS = 10 * 60 * 1000;

export function shouldAcceptReport(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= REPORT_COOLDOWN_MS;
}

// ── Code de suivi d'un signalement ─────────────────────────────────────────

/** Sans I, O, 0 ni 1 : un code recopié à la main ne se confond pas. */
const TRACKING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateTrackingCode(): string {
  const pick = () => Array.from({ length: 5 }, () => TRACKING_ALPHABET[randomInt(TRACKING_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

export function normalizeTrackingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Seule l'empreinte du code est gardée, liée au serveur : la base ne permet pas de le retrouver. */
export function trackingCodeHash(guildId: string, code: string): string {
  return createHash('sha256').update(`${guildId}:${normalizeTrackingCode(code)}`).digest('hex');
}

/** Ce que voit la personne qui a signalé : un état, jamais le contenu ni qui traite. */
export function trackingStatus(
  item: { status: string; assigneeId: string | null; deletedAt: Date | null } | null,
): 'unknown' | 'received' | 'in_progress' | 'closed' {
  if (!item) return 'unknown';
  if (item.deletedAt || item.status === 'CLOSED') return 'closed';
  if (item.assigneeId || item.status === 'MONITORING') return 'in_progress';
  return 'received';
}

/** Une même personne ne vérifie un code qu'à ce rythme : deviner un code reste hors de portée. */
export const TRACKING_LOOKUP_COOLDOWN_MS = 10 * 1000;

// ── Réponse au signaleur ───────────────────────────────────────────────────

/** Message de la cellule lu par l'auteur d'un signalement avec son code de suivi. */
export const REPORTER_REPLY_MAX = 500;

// ── Fil anonyme avec le signaleur ──────────────────────────────────────────

/** Messages qu'un signaleur peut envoyer sur un même dossier. */
export const MAX_REPORTER_MESSAGES = 20;
/** Échanges montrés par `/confidentiel suivi`. */
export const TRACKING_THREAD_SIZE = 5;

export function reporterCanWrite(item: { status: string; deletedAt: Date | null }, sentByReporter: number): boolean {
  return item.status !== 'CLOSED' && !item.deletedAt && sentByReporter < MAX_REPORTER_MESSAGES;
}

/** Derniers échanges d'un signalement, du plus ancien au plus récent. */
export function trackingThread<T extends { createdAt: Date }>(messages: readonly T[], size = TRACKING_THREAD_SIZE): T[] {
  return [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(-size);
}

// ── Ressources d'aide ──────────────────────────────────────────────────────

export interface WellbeingResource {
  label: string;
  url: string | null;
  phone: string | null;
  description: string | null;
  /** Langue du public visé (code à deux lettres), ou `null` pour tous. */
  locale: string | null;
}

export const MAX_RESOURCES = 10;

/** Un lien n'est gardé que s'il mène à une page web : pas de `javascript:` dans un message privé. */
function safeUrl(value: unknown): string | null {
  const raw = trimmedText(value, 300);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

export function cleanResources(input: unknown): WellbeingResource[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      label: trimmedText(item.label, 80) ?? '',
      phone: trimmedText(item.phone, 30),
      url: safeUrl(item.url),
      description: trimmedText(item.description, 200),
      locale: typeof item.locale === 'string' && /^[a-z]{2}$/.test(item.locale) ? item.locale : null,
    }))
    .filter((item) => item.label !== '')
    .slice(0, MAX_RESOURCES);
}

/**
 * Ressources montrées à un membre selon sa langue (`fr`, `en-US`...) : celles
 * de sa langue et celles pour tous. S'il n'en reste aucune, toutes : mieux
 * vaut un numéro dans une autre langue que rien.
 */
export function resourcesForLocale(resources: readonly WellbeingResource[], locale: string | null | undefined): WellbeingResource[] {
  const lang = (locale ?? '').slice(0, 2).toLowerCase();
  const matching = resources.filter((r) => !r.locale || r.locale === lang);
  return matching.length > 0 ? matching : [...resources];
}

/** Message privé envoyé au membre : les ressources, rien du dossier. */
export function resourcesMessage(guildName: string, resources: readonly WellbeingResource[]): string {
  const lines = resources.map((r) => {
    const details = [r.phone, r.url].filter(Boolean).join(' · ');
    return `- **${r.label}**${details ? ` : ${details}` : ''}${r.description ? `\n  ${r.description}` : ''}`;
  });
  return [`La cellule de suivi de **${guildName}** te partage ces ressources d'aide :`, ...lines].join('\n');
}
