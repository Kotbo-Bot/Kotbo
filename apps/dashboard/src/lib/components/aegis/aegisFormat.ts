/** Libellés, couleurs et préréglages partagés par les écrans Kotbo × AegisAI. */
import { m } from '../../i18n';
import type { AegisDetection, AegisEmotion } from '../../api';

export const EMOTION_ORDER: AegisEmotion[] = ['joy', 'surprise', 'neutral', 'sad', 'fear', 'anger'];

export function emotionLabel(emotion: AegisEmotion | string | null | undefined): string {
  switch (emotion) {
    case 'joy': return m.aegis_emotion_joy();
    case 'sad': return m.aegis_emotion_sad();
    case 'anger': return m.aegis_emotion_anger();
    case 'fear': return m.aegis_emotion_fear();
    case 'surprise': return m.aegis_emotion_surprise();
    case 'neutral': return m.aegis_emotion_neutral();
    default: return '—';
  }
}

/** Colère en rouge, joie en vert : l'émotion se lit d'un coup d'œil. */
export const EMOTION_COLORS: Record<AegisEmotion, string> = {
  joy: 'var(--color-success)',
  surprise: 'var(--color-warning)',
  neutral: 'var(--series-neutral)',
  sad: 'var(--series-1)',
  fear: 'var(--series-4)',
  anger: 'var(--color-error)',
};

export function kindLabel(kind: AegisDetection['kind']): string {
  switch (kind) {
    case 'TOXIC': return m.aegis_kind_TOXIC();
    case 'HARASSMENT': return m.aegis_kind_HARASSMENT();
    case 'CONFLICT': return m.aegis_kind_CONFLICT();
    case 'DISTRESS': return m.aegis_kind_DISTRESS();
  }
}

export function statusLabel(status: AegisDetection['status']): string {
  switch (status) {
    case 'PENDING': return m.aegis_status_PENDING();
    case 'AUTO': return m.aegis_status_AUTO();
    case 'CONFIRMED': return m.aegis_status_CONFIRMED();
    case 'DISMISSED': return m.aegis_status_DISMISSED();
  }
}

export function actionLabel(action: string): string {
  switch (action) {
    case 'DELETE': return m.aegis_did_DELETE();
    case 'WARN': return m.aegis_did_WARN();
    case 'TIMEOUT': return m.aegis_did_TIMEOUT();
    case 'NICKNAME_RESET': return m.aegis_did_NICKNAME_RESET();
    case 'SLOWMODE': return m.aegis_did_SLOWMODE();
    case 'ALERT': return m.aegis_did_ALERT();
    case 'REVIEW': return m.aegis_did_REVIEW();
    default: return m.aegis_did_NONE();
  }
}

export type Zone = 'none' | 'review' | 'auto';

export function zoneOf(points: number, review: number, auto: number): Zone {
  if (points >= auto) return 'auto';
  if (points >= review) return 'review';
  return 'none';
}

export const ZONE_TONE: Record<Zone, string> = {
  none: 'text-success',
  review: 'text-warning',
  auto: 'text-error',
};

/**
 * Préréglages de sensibilité, calés sur les mesures du 2026-10-05 :
 * « t'es nul à ce jeu mdr » sort à 90, « ta mère la pute » à 96, une menace
 * de mort à 80, « ce film est de la merde » à 68.
 */
export const PRESETS = {
  tolerant: { reviewThreshold: 88, autoThreshold: 97 },
  balanced: { reviewThreshold: 80, autoThreshold: 95 },
  strict: { reviewThreshold: 70, autoThreshold: 90 },
} as const;

export type PresetId = keyof typeof PRESETS | 'custom';

export function presetOf(review: number, auto: number): PresetId {
  for (const [id, preset] of Object.entries(PRESETS) as Array<[keyof typeof PRESETS, { reviewThreshold: number; autoThreshold: number }]>) {
    if (preset.reviewThreshold === review && preset.autoThreshold === auto) return id;
  }
  return 'custom';
}

export const points = (score: number) => Math.round(score * 100);

export function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}
