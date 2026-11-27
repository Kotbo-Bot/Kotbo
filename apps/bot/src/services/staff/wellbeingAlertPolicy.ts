/** Alertes de la cellule de suivi : événements, textes et consultation inhabituelle, sans accès à la base ni à Discord. */
import { PURGE_NOTICE_DAYS } from './wellbeingRetentionPolicy.js';

/**
 * Événements qui préviennent les destinataires des alertes :
 * - BREAK_GLASS : activation d'un accès d'urgence ;
 * - EMERGENCY_READ : consultation des dossiers sous accès d'urgence ;
 * - TEAM_READ : consultation des dossiers par la cellule ;
 * - CASE_CHANGE : dossier créé, modifié, annoté ou supprimé ;
 * - CONFIG_CHANGE : composition ou réglages de la cellule modifiés ;
 * - REPORT : signalement reçu depuis Discord ;
 * - REMINDER : dossier arrivé à échéance de suivi, ou critique et inactif ;
 * - MEMBERSHIP_CHANGE : rôle de la cellule ou de la direction donné ou retiré ;
 * - PURGE_SOON : des dossiers fermés seront effacés dans une semaine ;
 * - UNUSUAL_ACCESS : une personne ouvre beaucoup de dossiers en peu de temps ;
 * - DISSOLUTION : désactivation de la cellule demandée, annulée ou appliquée ;
 * - DISTRESS : un message aux mots de détresse attend d'être examiné ;
 * - SANCTION_SIGNAL : une personne suivie par la cellule vient d'être sanctionnée.
 */
export const WELLBEING_ALERT_EVENTS = [
  'BREAK_GLASS', 'EMERGENCY_READ', 'TEAM_READ', 'CASE_CHANGE', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION', 'DISTRESS', 'SANCTION_SIGNAL',
] as const;
export type WellbeingAlertEvent = (typeof WELLBEING_ALERT_EVENTS)[number];
export const DEFAULT_ALERT_EVENTS: WellbeingAlertEvent[] = ['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION', 'DISTRESS'];
/** Destinataires prévenus en message privé, au plus. */
export const MAX_ALERT_USERS = 10;
/** Une même personne qui recharge la page ne déclenche qu'une alerte de consultation par période. */
export const READ_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

export function cleanAlertEvents(input: unknown): WellbeingAlertEvent[] {
  if (!Array.isArray(input)) return [];
  return WELLBEING_ALERT_EVENTS.filter((event) => input.includes(event));
}

export function shouldSendReadAlert(lastSentAt: number | undefined, now: number): boolean {
  return lastSentAt === undefined || now - lastSentAt >= READ_ALERT_COOLDOWN_MS;
}

export interface AlertContext {
  /** Auteur du geste ; vide pour une tâche planifiée. */
  actorId: string;
  caseCount?: number;
  /** Notes de fiche bientôt effacées (PURGE_SOON). */
  noteCount?: number;
  reason?: string;
  expiresAt?: Date;
  /** Geste sur un dossier : « créé », « modifié », « annoté », « supprimé ». */
  action?: string;
  /** Étape d'un accès d'urgence soumis à validation. */
  stage?: 'requested' | 'approved' | 'rejected' | 'ended' | 'dissolution_requested' | 'dissolution_cancelled' | 'dissolution_applied';
  /** Signalement anonyme : l'alerte ne nomme personne. */
  anonymous?: boolean;
  reminder?: 'review' | 'stale' | 'follow_up';
  days?: number;
  /** Nouveau message d'un signaleur, reçu avec son code de suivi. */
  followUp?: boolean;
  /** Changement d'appartenance : membre visé, sens, portée, et ajout annulé. */
  targetId?: string;
  change?: 'added' | 'removed';
  scope?: 'team' | 'direction';
  reverted?: boolean;
}

/**
 * Texte d'une alerte. Il nomme l'auteur et le geste, jamais le contenu d'un
 * dossier ni la personne concernée : l'alerte peut partir dans un salon.
 */
export function alertText(event: WellbeingAlertEvent, ctx: AlertContext): string {
  const actor = `<@${ctx.actorId}>`;
  switch (event) {
    case 'BREAK_GLASS': {
      const until = ctx.expiresAt ? ` jusqu'à <t:${Math.floor(ctx.expiresAt.getTime() / 1000)}:R>` : '';
      if (ctx.stage === 'requested') {
        return `Cellule de suivi : ${actor} demande un accès d'urgence, à valider par une autre personne de la direction ou de la cellule. Motif : ${ctx.reason ?? 'non précisé'}`;
      }
      if (ctx.stage === 'rejected') return `Cellule de suivi : demande d'accès d'urgence refusée par ${actor}.`;
      if (ctx.stage === 'ended') return `Cellule de suivi : accès d'urgence terminé par ${actor}.`;
      if (ctx.stage === 'approved') return `Cellule de suivi : accès d'urgence validé par ${actor}${until}.`;
      return `Cellule de suivi : accès d'urgence activé par ${actor}${until}. Motif : ${ctx.reason ?? 'non précisé'}`;
    }
    case 'EMERGENCY_READ':
      return `Cellule de suivi : ${actor} consulte ${ctx.caseCount ?? 0} dossier(s) sous accès d'urgence.`;
    case 'TEAM_READ':
      return `Cellule de suivi : ${actor} consulte ${ctx.caseCount ?? 0} dossier(s).`;
    case 'CASE_CHANGE':
      return `Cellule de suivi : un dossier a été ${ctx.action ?? 'modifié'} par ${actor}.`;
    case 'CONFIG_CHANGE':
      return `Cellule de suivi : configuration modifiée par ${actor}.`;
    case 'REPORT':
      if (ctx.followUp) return 'Cellule de suivi : nouveau message reçu sur un signalement, avec son code de suivi.';
      return ctx.anonymous
        ? 'Cellule de suivi : nouveau signalement anonyme reçu depuis Discord.'
        : `Cellule de suivi : nouveau signalement de ${actor} reçu depuis Discord.`;
    case 'MEMBERSHIP_CHANGE': {
      const target = `<@${ctx.targetId ?? ''}>`;
      // L'audit Discord ne nomme pas toujours l'auteur.
      const author = ctx.actorId ? actor : 'un auteur inconnu';
      const group = ctx.scope === 'direction' ? 'la direction' : 'la cellule';
      if (ctx.change === 'removed') return `Cellule de suivi : ${author} a retiré ${target} de ${group} (rôle Discord).`;
      return ctx.reverted
        ? `Cellule de suivi : ${author} a donné à ${target} un rôle de ${group} ; ajout annulé, seul le propriétaire du serveur peut le faire.`
        : `Cellule de suivi : ${author} a ajouté ${target} à ${group} (rôle Discord).`;
    }
    case 'DISSOLUTION': {
      if (ctx.stage === 'dissolution_cancelled') return `Cellule de suivi : la désactivation de la cellule a été annulée par ${actor}.`;
      if (ctx.stage === 'dissolution_applied') return 'Cellule de suivi : la cellule est désactivée, comme demandé il y a 24 heures.';
      const until = ctx.expiresAt ? ` <t:${Math.floor(ctx.expiresAt.getTime() / 1000)}:R>` : '';
      return `Cellule de suivi : ${actor} a demandé la désactivation de la cellule. Elle prendra effet${until} ; le propriétaire peut l'annuler d'ici là.`;
    }
    case 'UNUSUAL_ACCESS':
      return `Cellule de suivi : ${actor} a ouvert ${ctx.caseCount ?? 0} dossiers ou fiches en ${UNUSUAL_ACCESS_WINDOW_MS / 60_000} minutes. Vérifiez que c'est attendu.`;
    case 'PURGE_SOON':
      if (ctx.noteCount !== undefined) {
        return `Cellule de suivi : ${ctx.noteCount} note(s) de fiche seront effacées dans ${PURGE_NOTICE_DAYS} jours. Prolongez-les depuis le dashboard, avec un motif, pour les garder.`;
      }
      return `Cellule de suivi : ${ctx.caseCount ?? 0} dossier(s) fermé(s) seront effacés dans ${PURGE_NOTICE_DAYS} jours. Prolongez-les depuis le dashboard pour les garder.`;
    case 'REMINDER':
      if (ctx.reminder === 'follow_up') {
        return `Cellule de suivi : un dossier résolu il y a ${ctx.days ?? 0} jour(s) attend une prise de nouvelles.`;
      }
      return ctx.reminder === 'stale'
        ? `Cellule de suivi : un dossier critique est sans activité depuis ${ctx.days ?? 0} jour(s).`
        : 'Cellule de suivi : un dossier arrive à son échéance de suivi.';
    case 'DISTRESS':
      return 'Cellule de suivi : un message aux mots de détresse a été repéré. Il attend dans les signaux de la page Suivi confidentiel.';
    case 'SANCTION_SIGNAL':
      return `Cellule de suivi : ${actor} vient de sanctionner une personne suivie par la cellule. Le référent est prévenu.`;
  }
}

// ── Consultation inhabituelle ──────────────────────────────────────────────

/** Dossiers et fiches ouverts par une même personne dans la fenêtre au-delà desquels la cellule est prévenue. */
export const UNUSUAL_ACCESS_THRESHOLD = 10;
export const UNUSUAL_ACCESS_WINDOW_MS = 10 * 60 * 1000;
/** Une même personne ne déclenche pas plus d'une alerte par heure. */
export const UNUSUAL_ACCESS_COOLDOWN_MS = 60 * 60 * 1000;

export function isUnusualAccess(openedInWindow: number): boolean {
  return openedInWindow >= UNUSUAL_ACCESS_THRESHOLD;
}

/**
 * Compteur gardé en mémoire (horodatage en ms par clé) : passé `max` entrées,
 * celles plus anciennes que `maxAgeMs` sont oubliées, pour qu'il ne grossisse
 * pas sans fin.
 */
export function forgetStale(map: Map<string, number>, now: number, maxAgeMs: number, max = 500): void {
  if (map.size <= max) return;
  for (const [key, at] of map) if (now - at > maxAgeMs) map.delete(key);
}

/** Ouvertures (horodatages en ms) encore dans la fenêtre de consultation inhabituelle. */
export function openingsInWindow(times: readonly number[], now: number): number[] {
  return times.filter((at) => now - at <= UNUSUAL_ACCESS_WINDOW_MS);
}

// ── Mentions dans une note ─────────────────────────────────────────────────

export const MAX_NOTE_MENTIONS = 5;

export function cleanMentionIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((id): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id)))].slice(0, MAX_NOTE_MENTIONS);
}

/** Message privé à un collègue mentionné : qui l'appelle, rien du dossier. */
export function mentionText(actorId: string): string {
  return `Cellule de suivi : <@${actorId}> vous signale une note dans un dossier. Ouvrez la page Suivi confidentiel du dashboard pour la lire.`;
}

// ── Aperçu des alertes ─────────────────────────────────────────────────────

/**
 * Texte de chaque alerte tel qu'il partira, sur un exemple : les mentions
 * Discord deviennent des noms lisibles et les dates relatives une durée,
 * pour l'afficher dans le dashboard.
 */
export function alertPreviews(actorLabel: string, now: Date): Record<WellbeingAlertEvent, string> {
  const ctx: AlertContext = {
    actorId: 'ACTOR',
    caseCount: 3,
    reason: 'Enquête sur un signalement',
    expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    action: 'modifié',
    reminder: 'review',
    days: 7,
    targetId: 'TARGET',
    change: 'added',
    scope: 'team',
  };
  const readable = (text: string) => text
    .replace(/<@ACTOR>/g, `@${actorLabel}`)
    .replace(/<@TARGET>/g, '@membre')
    .replace(/<t:\d+:R>/g, 'dans 2 heures');
  return Object.fromEntries(WELLBEING_ALERT_EVENTS.map((event) => [event, readable(alertText(event, ctx))])) as Record<WellbeingAlertEvent, string>;
}
