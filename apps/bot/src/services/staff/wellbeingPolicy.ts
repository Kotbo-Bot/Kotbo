/**
 * Règles de la cellule bien-être, sans accès à la base ni à Discord.
 *
 * La composition de la cellule décide qui lit les dossiers. Le journal
 * d'audit doit donc dire qui a été ajouté ou retiré, pas seulement combien :
 * sinon un ajout discret de soi-même à l'équipe passerait inaperçu.
 */
import { createHash, randomInt } from 'node:crypto';

export interface WellbeingAccessLists {
  enabled: boolean;
  requireReason: boolean;
  teamRoleIds: string[];
  teamUserIds: string[];
  directorRoleIds: string[];
  directorUserIds: string[];
  alertChannelId?: string | null;
  alertUserIds?: string[];
  alertEvents?: string[];
  breakGlassApproval?: boolean;
  reportEnabled?: boolean;
  staleCriticalDays?: number;
}

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
 * - DISSOLUTION : désactivation de la cellule demandée, annulée ou appliquée.
 */
export const WELLBEING_ALERT_EVENTS = [
  'BREAK_GLASS', 'EMERGENCY_READ', 'TEAM_READ', 'CASE_CHANGE', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION',
] as const;
export type WellbeingAlertEvent = (typeof WELLBEING_ALERT_EVENTS)[number];
export const DEFAULT_ALERT_EVENTS: WellbeingAlertEvent[] = ['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION'];
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
  reason?: string;
  expiresAt?: Date;
  /** Geste sur un dossier : « créé », « modifié », « annoté », « supprimé ». */
  action?: string;
  /** Étape d'un accès d'urgence soumis à validation. */
  stage?: 'requested' | 'approved' | 'rejected' | 'ended' | 'dissolution_requested' | 'dissolution_cancelled' | 'dissolution_applied';
  /** Signalement anonyme : l'alerte ne nomme personne. */
  anonymous?: boolean;
  reminder?: 'review' | 'stale';
  days?: number;
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
        return `Cellule bien-être : ${actor} demande un accès d'urgence, à valider par une autre personne de la direction ou de la cellule. Motif : ${ctx.reason ?? 'non précisé'}`;
      }
      if (ctx.stage === 'rejected') return `Cellule bien-être : demande d'accès d'urgence refusée par ${actor}.`;
      if (ctx.stage === 'ended') return `Cellule bien-être : accès d'urgence terminé par ${actor}.`;
      if (ctx.stage === 'approved') return `Cellule bien-être : accès d'urgence validé par ${actor}${until}.`;
      return `Cellule bien-être : accès d'urgence activé par ${actor}${until}. Motif : ${ctx.reason ?? 'non précisé'}`;
    }
    case 'EMERGENCY_READ':
      return `Cellule bien-être : ${actor} consulte ${ctx.caseCount ?? 0} dossier(s) sous accès d'urgence.`;
    case 'TEAM_READ':
      return `Cellule bien-être : ${actor} consulte ${ctx.caseCount ?? 0} dossier(s).`;
    case 'CASE_CHANGE':
      return `Cellule bien-être : un dossier a été ${ctx.action ?? 'modifié'} par ${actor}.`;
    case 'CONFIG_CHANGE':
      return `Cellule bien-être : configuration modifiée par ${actor}.`;
    case 'REPORT':
      return ctx.anonymous
        ? 'Cellule bien-être : nouveau signalement anonyme reçu depuis Discord.'
        : `Cellule bien-être : nouveau signalement de ${actor} reçu depuis Discord.`;
    case 'MEMBERSHIP_CHANGE': {
      const target = `<@${ctx.targetId ?? ''}>`;
      // L'audit Discord ne nomme pas toujours l'auteur.
      const author = ctx.actorId ? actor : 'un auteur inconnu';
      const group = ctx.scope === 'direction' ? 'la direction' : 'la cellule';
      if (ctx.change === 'removed') return `Cellule bien-être : ${author} a retiré ${target} de ${group} (rôle Discord).`;
      return ctx.reverted
        ? `Cellule bien-être : ${author} a donné à ${target} un rôle de ${group} ; ajout annulé, seul le propriétaire du serveur peut le faire.`
        : `Cellule bien-être : ${author} a ajouté ${target} à ${group} (rôle Discord).`;
    }
    case 'DISSOLUTION': {
      if (ctx.stage === 'dissolution_cancelled') return `Cellule bien-être : la désactivation de la cellule a été annulée par ${actor}.`;
      if (ctx.stage === 'dissolution_applied') return 'Cellule bien-être : la cellule est désactivée, comme demandé il y a 24 heures.';
      const until = ctx.expiresAt ? ` <t:${Math.floor(ctx.expiresAt.getTime() / 1000)}:R>` : '';
      return `Cellule bien-être : ${actor} a demandé la désactivation de la cellule. Elle prendra effet${until} ; le propriétaire peut l'annuler d'ici là.`;
    }
    case 'UNUSUAL_ACCESS':
      return `Cellule bien-être : ${actor} a ouvert ${ctx.caseCount ?? 0} dossiers en ${UNUSUAL_ACCESS_WINDOW_MS / 60_000} minutes. Vérifiez que c'est attendu.`;
    case 'PURGE_SOON':
      return `Cellule bien-être : ${ctx.caseCount ?? 0} dossier(s) fermé(s) seront effacés dans ${PURGE_NOTICE_DAYS} jours. Prolongez-les depuis le dashboard pour les garder.`;
    case 'REMINDER':
      return ctx.reminder === 'stale'
        ? `Cellule bien-être : un dossier critique est sans activité depuis ${ctx.days ?? 0} jour(s).`
        : 'Cellule bien-être : un dossier arrive à son échéance de suivi.';
  }
}

export interface WellbeingActor {
  userId: string;
  roleIds: ReadonlySet<string>;
  isOwner: boolean;
}

export interface WellbeingAccess {
  isTeamMember: boolean;
  /** Propriétaire, ou membre ou rôle désigné : peut déclencher un accès d'urgence. */
  isDirector: boolean;
  /** La composition décide qui lit les dossiers : seul le propriétaire la modifie. */
  canConfigure: boolean;
  canReadCases: boolean;
  /** L'accès d'urgence sert à lire : créer, modifier ou noter reste à la cellule. */
  canWriteCases: boolean;
}

function listed(userIds: readonly string[], roleIds: readonly string[], actor: WellbeingActor): boolean {
  return userIds.includes(actor.userId) || roleIds.some((id) => actor.roleIds.has(id));
}

/**
 * Droits d'une personne sur la cellule. Être administrateur du dashboard n'y
 * entre pas : sinon tout admin pourrait lire les dossiers par accès d'urgence,
 * sans que le propriétaire puisse l'en empêcher.
 */
export function resolveWellbeingAccess(
  config: WellbeingAccessLists | null,
  actor: WellbeingActor,
  hasActiveBreakGlass: boolean,
): WellbeingAccess {
  const enabled = config?.enabled === true;
  const isTeamMember = !!config && config.enabled && listed(config.teamUserIds, config.teamRoleIds, actor);
  const isDirector = actor.isOwner || (!!config && listed(config.directorUserIds, config.directorRoleIds, actor));
  return {
    isTeamMember,
    isDirector,
    canConfigure: actor.isOwner,
    canReadCases: enabled && (isTeamMember || (isDirector && hasActiveBreakGlass)),
    canWriteCases: isTeamMember,
  };
}

/** Durée de conservation d'un dossier fermé, comptée depuis sa dernière modification. */
export const CLOSED_CASE_RETENTION_DAYS = 365;

export function idListChange(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return {
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
  };
}

function listLine(label: string, before: readonly string[], after: readonly string[], nameOf: (id: string) => string): string | null {
  const { added, removed } = idListChange(before, after);
  const parts = [...added.map((id) => `+${nameOf(id)}`), ...removed.map((id) => `-${nameOf(id)}`)];
  return parts.length > 0 ? `${label} : ${parts.join(', ')}` : null;
}

/** Ligne d'audit d'une modification de configuration. `nameOf` traduit un id de rôle ou de membre en nom lisible. */
export function describeConfigChange(
  before: WellbeingAccessLists | null,
  after: WellbeingAccessLists,
  nameOf: (id: string) => string,
): string {
  const prev: WellbeingAccessLists = before ?? {
    enabled: false,
    requireReason: true,
    teamRoleIds: [],
    teamUserIds: [],
    directorRoleIds: [],
    directorUserIds: [],
  };
  const alertsOf = (lists: WellbeingAccessLists) => JSON.stringify([
    lists.alertChannelId ?? null,
    lists.alertUserIds ?? [],
    lists.alertEvents ?? DEFAULT_ALERT_EVENTS,
  ]);
  const lines = [
    prev.enabled !== after.enabled ? `Cellule ${after.enabled ? 'activée' : 'désactivée'}` : null,
    listLine('Équipe', [...prev.teamRoleIds, ...prev.teamUserIds], [...after.teamRoleIds, ...after.teamUserIds], nameOf),
    listLine('Direction', [...prev.directorRoleIds, ...prev.directorUserIds], [...after.directorRoleIds, ...after.directorUserIds], nameOf),
    prev.requireReason !== after.requireReason ? `Motif d'accès d'urgence : ${after.requireReason ? 'obligatoire' : 'facultatif'}` : null,
    alertsOf(prev) !== alertsOf(after) ? 'Alertes modifiées' : null,
    (prev.breakGlassApproval ?? false) !== (after.breakGlassApproval ?? false)
      ? `Seconde validation de l'accès d'urgence : ${after.breakGlassApproval ? 'exigée' : 'retirée'}` : null,
    (prev.reportEnabled ?? false) !== (after.reportEnabled ?? false)
      ? `Signalements Discord : ${after.reportEnabled ? 'ouverts' : 'fermés'}` : null,
    (prev.staleCriticalDays ?? 7) !== (after.staleCriticalDays ?? 7)
      ? `Relance des dossiers critiques : ${after.staleCriticalDays ? `${after.staleCriticalDays} jour(s)` : 'désactivée'}` : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join(' · ') : 'Aucun changement';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Un dossier fermé et inchangé avant cette date est supprimé. */
export function closedCaseCutoff(now: Date): Date {
  return new Date(now.getTime() - CLOSED_CASE_RETENTION_DAYS * DAY_MS);
}

/** Date d'effacement d'un dossier fermé, comptée depuis sa dernière modification. */
export function casePurgeDate(updatedAt: Date): Date {
  return new Date(updatedAt.getTime() + CLOSED_CASE_RETENTION_DAYS * DAY_MS);
}

/** La cellule est prévenue ce nombre de jours avant l'effacement d'un dossier fermé. */
export const PURGE_NOTICE_DAYS = 7;

/** Un dossier fermé modifié avant cette date sera effacé dans `PURGE_NOTICE_DAYS` jours ou moins. */
export function purgeNoticeCutoff(now: Date): Date {
  return closedCaseCutoff(new Date(now.getTime() + PURGE_NOTICE_DAYS * DAY_MS));
}

/** Seul un dossier annoncé avant cette date peut être effacé : le préavis est toujours tenu. */
export function purgeWarnedCutoff(now: Date): Date {
  return new Date(now.getTime() - PURGE_NOTICE_DAYS * DAY_MS);
}

// ── Corbeille et conflit d'intérêts ───────────────────────────────────────

/** Un dossier supprimé reste restaurable ce nombre de jours, puis il est purgé. */
export const CASE_TRASH_DAYS = 30;

/** Un dossier mis à la corbeille avant cette date est purgé. */
export function trashCutoff(now: Date): Date {
  return new Date(now.getTime() - CASE_TRASH_DAYS * DAY_MS);
}

/**
 * Dossiers qu'une personne peut voir sur ce serveur : jamais ceux qui la
 * concernent (conflit d'intérêts), et la corbeille à part. Le `OR` garde les
 * dossiers sans membre lié, qu'un simple `not` écarterait (NULL en SQL).
 */
export function caseVisibilityWhere(guildId: string, viewerId: string, options: { trashed?: boolean } = {}) {
  return {
    guildId,
    deletedAt: options.trashed ? { not: null } : null,
    OR: [{ subjectUserId: null }, { subjectUserId: { not: viewerId } }],
  };
}

/** Une demande d'effacement anticipé attend sa seconde clé ce nombre d'heures. */
export const PURGE_REQUEST_HOURS = 72;

interface PurgeRequestState {
  deletedAt: Date | null;
  purgeRequestedById: string | null;
  purgeRequestedAt: Date | null;
}

const purgeRequestExpired = (requestedAt: Date, now: Date) =>
  now.getTime() - requestedAt.getTime() >= PURGE_REQUEST_HOURS * 60 * 60 * 1000;

/** Une demande d'effacement attend sa validation : elle ne peut pas être remplacée. */
export function purgeRequestPending(item: PurgeRequestState, now: Date): boolean {
  return !!item.purgeRequestedById && !!item.purgeRequestedAt && !purgeRequestExpired(item.purgeRequestedAt, now);
}

/**
 * Raison de refuser l'effacement définitif d'un dossier de la corbeille avant
 * son délai, ou `null`. Une seconde personne de la cellule doit valider.
 */
export function purgeApprovalError(
  item: PurgeRequestState,
  approverId: string,
  now: Date,
): 'not_trashed' | 'not_requested' | 'self' | 'expired' | null {
  if (!item.deletedAt) return 'not_trashed';
  if (!item.purgeRequestedById || !item.purgeRequestedAt) return 'not_requested';
  if (item.purgeRequestedById === approverId) return 'self';
  if (purgeRequestExpired(item.purgeRequestedAt, now)) return 'expired';
  return null;
}

/** La personne est-elle celle que le dossier concerne ? Elle ne le voit alors pas. */
export function isCaseSubject(subjectUserId: string | null, userId: string | null): boolean {
  return !!subjectUserId && !!userId && subjectUserId === userId;
}

/** La personne concernée ne suit pas son propre dossier. */
export function assigneeConflict(subjectUserId: string | null, assigneeId: string | null): boolean {
  return isCaseSubject(subjectUserId, assigneeId);
}

/** Une ouverture de dossier est tracée au plus une fois par période et par personne. */
export function shouldRecordView(lastViewedAt: Date | null, now: Date): boolean {
  return shouldSendReadAlert(lastViewedAt?.getTime(), now.getTime());
}

// ── Historique ─────────────────────────────────────────────────────────────

export interface CaseTracked {
  status: string;
  severity: string;
  assigneeId: string | null;
  reviewAt: Date | null;
}

export interface CaseEventDraft {
  type: 'STATUS' | 'SEVERITY' | 'ASSIGNEE' | 'REVIEW';
  fromValue: string | null;
  toValue: string | null;
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

/** Entrées d'historique d'une modification : un champ changé, une entrée. */
export function caseChangeEvents(before: CaseTracked, patch: Partial<CaseTracked>): CaseEventDraft[] {
  const events: CaseEventDraft[] = [];
  const push = (type: CaseEventDraft['type'], from: string | null, to: string | null) => {
    if (from !== to) events.push({ type, fromValue: from, toValue: to });
  };
  if (patch.status !== undefined) push('STATUS', before.status, patch.status);
  if (patch.severity !== undefined) push('SEVERITY', before.severity, patch.severity);
  if (patch.assigneeId !== undefined) push('ASSIGNEE', before.assigneeId, patch.assigneeId);
  if (patch.reviewAt !== undefined) push('REVIEW', iso(before.reviewAt), iso(patch.reviewAt));
  return events;
}

// ── Accès d'urgence ────────────────────────────────────────────────────────

/** Durée d'un accès d'urgence validé. */
export const BREAK_GLASS_HOURS = 2;
/** Délai laissé à une seconde personne pour valider une demande. */
export const BREAK_GLASS_REQUEST_HOURS = 24;

export function isBreakGlassActive(log: { status: string; expiresAt: Date }, now: Date): boolean {
  return log.status === 'APPROVED' && log.expiresAt.getTime() > now.getTime();
}

/**
 * Raison de refuser la décision sur une demande, ou `null`. `canDecide` : la
 * personne est de la direction ou de la cellule.
 */
export function decideBreakGlassError(
  log: { status: string; actorId: string; expiresAt: Date },
  decider: { userId: string; canDecide: boolean },
  now: Date,
): 'forbidden' | 'self' | 'closed' | null {
  if (!decider.canDecide) return 'forbidden';
  if (decider.userId === log.actorId) return 'self';
  if (log.status !== 'PENDING' || log.expiresAt.getTime() <= now.getTime()) return 'closed';
  return null;
}

/**
 * Raison de refuser la fin anticipée d'un accès (ou l'annulation d'une
 * demande), ou `null`. L'auteur arrête le sien ; la cellule et le
 * propriétaire révoquent celui des autres, pas un pair de la direction.
 */
export function endBreakGlassError(
  log: { status: string; actorId: string; expiresAt: Date },
  ender: { userId: string; isTeamMember: boolean; isOwner: boolean },
  now: Date,
): 'forbidden' | 'closed' | null {
  if (ender.userId !== log.actorId && !ender.isTeamMember && !ender.isOwner) return 'forbidden';
  if (!['APPROVED', 'PENDING'].includes(log.status) || log.expiresAt.getTime() <= now.getTime()) return 'closed';
  return null;
}

/** Filtre des dossiers lisibles sous un accès d'urgence ciblé. */
export function breakGlassScope(log: { caseId: string | null; subjectUserId: string | null }): { id?: string; subjectUserId?: string } {
  if (log.caseId) return { id: log.caseId };
  if (log.subjectUserId) return { subjectUserId: log.subjectUserId };
  return {};
}

// ── Ressources d'aide ──────────────────────────────────────────────────────

export interface WellbeingResource {
  label: string;
  url: string | null;
  phone: string | null;
  description: string | null;
}

export const MAX_RESOURCES = 10;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** Un lien n'est gardé que s'il mène à une page web : pas de `javascript:` dans un message privé. */
function safeUrl(value: unknown): string | null {
  const raw = text(value, 300);
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
      label: text(item.label, 80) ?? '',
      phone: text(item.phone, 30),
      url: safeUrl(item.url),
      description: text(item.description, 200),
    }))
    .filter((item) => item.label !== '')
    .slice(0, MAX_RESOURCES);
}

/** Message privé envoyé au membre : les ressources, rien du dossier. */
export function resourcesMessage(guildName: string, resources: readonly WellbeingResource[]): string {
  const lines = resources.map((r) => {
    const details = [r.phone, r.url].filter(Boolean).join(' · ');
    return `- **${r.label}**${details ? ` : ${details}` : ''}${r.description ? `\n  ${r.description}` : ''}`;
  });
  return [`La cellule bien-être de **${guildName}** te partage ces ressources d'aide :`, ...lines].join('\n');
}

// ── Documents Google Drive ─────────────────────────────────────────────────

/** Hôtes acceptés : Drive et les éditeurs Docs, Sheets, Slides, Forms. */
const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
export const MAX_CASE_ATTACHMENTS = 20;
/** Plan d'action : tâches par dossier et longueur d'un libellé. */
export const MAX_CASE_TASKS = 30;
export const TASK_LABEL_MAX = 200;
export const ATTACHMENT_LABEL_MAX = 120;

/**
 * Lien vers un document Google Drive, ou `null`. Seul le lien est gardé : le
 * fichier reste chez Google, et ses droits de partage décident qui l'ouvre.
 */
export function cleanDriveLink(value: unknown): string | null {
  const raw = text(value, 500);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !DRIVE_HOSTS.has(url.hostname)) return null;
    return raw;
  } catch {
    return null;
  }
}

// ── Relances et signalements ───────────────────────────────────────────────

export function staleCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Un même membre n'envoie qu'un signalement par période : la cellule n'est pas noyée. */
export const REPORT_COOLDOWN_MS = 10 * 60 * 1000;

export function shouldAcceptReport(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= REPORT_COOLDOWN_MS;
}

/** Module inscrit au journal d'audit pour les gestes de la cellule. */
export const WELLBEING_AUDIT_MODULE = 'Cellule bien-être';

/** Nom de base (anglais) de la commande Discord : ses usages ne sont pas comptés par membre. */
export const WELLBEING_COMMAND = 'wellbeing';

// ── Appartenance par rôle Discord ──────────────────────────────────────────

export interface RoleDelta {
  added: string[];
  removed: string[];
}

function roleIdsOf(changes: ReadonlyArray<{ key: string; new?: unknown }>, key: '$add' | '$remove'): string[] {
  const value = changes.find((change) => change.key === key)?.new;
  return Array.isArray(value)
    ? value.map((role) => (role as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string')
    : [];
}

/** Rôles ajoutés et retirés d'une entrée d'audit `MemberRoleUpdate`. */
export function roleDeltaFromChanges(changes: ReadonlyArray<{ key: string; new?: unknown }> | null | undefined): RoleDelta {
  return { added: roleIdsOf(changes ?? [], '$add'), removed: roleIdsOf(changes ?? [], '$remove') };
}

export interface CellMembershipChange {
  roleId: string;
  scope: 'team' | 'direction';
  change: 'added' | 'removed';
}

/** Changements d'un membre qui touchent un rôle de la cellule ou de la direction. */
export function cellMembershipChanges(config: WellbeingAccessLists | null, delta: RoleDelta): CellMembershipChange[] {
  if (!config) return [];
  const scopeOf = (roleId: string): 'team' | 'direction' | null =>
    config.teamRoleIds.includes(roleId) ? 'team' : config.directorRoleIds.includes(roleId) ? 'direction' : null;
  const of = (roleIds: string[], change: 'added' | 'removed') => roleIds.flatMap((roleId) => {
    const scope = scopeOf(roleId);
    return scope ? [{ roleId, scope, change }] : [];
  });
  return [...of(delta.added, 'added'), ...of(delta.removed, 'removed')];
}

/**
 * Seul le propriétaire fait entrer quelqu'un dans la cellule ou la direction :
 * un ajout par un autre membre, par Kotbo lui-même (niveaux, boutique, menus
 * de rôles, workflows...) ou par un auteur inconnu est annulé.
 */
export function shouldRevertCellRoleGrant(executorId: string | null, ownerId: string): boolean {
  return executorId !== ownerId;
}


// ── Revue périodique des accès ─────────────────────────────────────────────

/** Le propriétaire reconfirme la composition de la cellule à ce rythme. */
export const ACCESS_REVIEW_DAYS = 30;

interface AccessReviewState {
  createdAt: Date;
  accessReviewedAt: Date | null;
  accessReviewSentAt: Date | null;
}

/** Composition non confirmée depuis `ACCESS_REVIEW_DAYS` jours (ou depuis la création). */
export function accessReviewDue(config: AccessReviewState, now: Date): boolean {
  const since = config.accessReviewedAt ?? config.createdAt;
  return now.getTime() - since.getTime() >= ACCESS_REVIEW_DAYS * DAY_MS;
}

/** Rappel au propriétaire : quand la revue est due, au plus une fois par période. */
export function shouldSendAccessReview(config: AccessReviewState, now: Date): boolean {
  if (!accessReviewDue(config, now)) return false;
  return !config.accessReviewSentAt || now.getTime() - config.accessReviewSentAt.getTime() >= ACCESS_REVIEW_DAYS * DAY_MS;
}

/** Message privé au propriétaire : qui lit les dossiers aujourd'hui. */
export function accessReviewMessage(
  guildName: string,
  lists: Pick<WellbeingAccessLists, 'teamUserIds' | 'teamRoleIds' | 'directorUserIds' | 'directorRoleIds'>,
  nameOf: (id: string) => string,
): string {
  const line = (label: string, ids: readonly string[]) => `- ${label} : ${ids.length > 0 ? ids.map(nameOf).join(', ') : 'aucun'}`;
  return [
    `Revue des accès de la cellule bien-être de ${guildName}.`,
    'Ces personnes peuvent lire les dossiers confidentiels ou demander un accès d\'urgence :',
    line('Membres de la cellule', lists.teamUserIds),
    line('Rôles de la cellule', lists.teamRoleIds),
    line('Membres de la direction', lists.directorUserIds),
    line('Rôles de la direction', lists.directorRoleIds),
    'Si c\'est toujours juste, confirmez-le dans l\'onglet Réglages de la page Bien-être du dashboard ; sinon, retirez qui n\'en a plus besoin.',
  ].join('\n');
}

// ── Bilan de la cellule ────────────────────────────────────────────────────

export interface CellStatsCase {
  status: string;
  severity: string;
  category: string;
  source: string;
  assigneeId: string | null;
  createdAt: Date;
  closedReason?: string | null;
  events: ReadonlyArray<{ type: string; toValue: string | null; createdAt: Date }>;
}

const MONTHS_IN_STATS = 6;
const monthKey = (date: Date) => date.toISOString().slice(0, 7);

/**
 * Chiffres du bilan, sans contenu : dossiers ouverts et fermés, charge active,
 * délai médian de prise en charge des signalements Discord, six derniers mois.
 */
export function wellbeingCellStats(cases: readonly CellStatsCase[], now: Date) {
  const since = now.getTime() - 30 * DAY_MS;
  const closedAt = (item: CellStatsCase) =>
    [...item.events].reverse().find((event) => event.type === 'STATUS' && event.toValue === 'CLOSED')?.createdAt ?? null;
  const active = cases.filter((item) => item.status !== 'CLOSED');

  const activeByCategory: Record<string, number> = {};
  for (const item of active) activeByCategory[item.category] = (activeByCategory[item.category] ?? 0) + 1;
  // Fermés sans motif (avant les motifs, ou fermés depuis Discord) : comptés à part.
  const closedByReason: Record<string, number> = {};
  for (const item of cases.filter((c) => c.status === 'CLOSED')) {
    const reason = item.closedReason ?? 'UNSPECIFIED';
    closedByReason[reason] = (closedByReason[reason] ?? 0) + 1;
  }

  const triageHours = cases
    .filter((item) => item.source === 'DISCORD')
    .map((item) => {
      const first = item.events.find((event) => event.type === 'ASSIGNEE' && event.toValue);
      return first ? (first.createdAt.getTime() - item.createdAt.getTime()) / 3_600_000 : null;
    })
    .filter((hours): hours is number => hours !== null)
    .sort((a, b) => a - b);
  const middle = Math.floor(triageHours.length / 2);
  const medianTriageHours = triageHours.length === 0
    ? null
    : Math.round(triageHours.length % 2 ? triageHours[middle]! : (triageHours[middle - 1]! + triageHours[middle]!) / 2);

  const months = Array.from({ length: MONTHS_IN_STATS }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_IN_STATS - 1 - index), 1));
    return { month: monthKey(date), opened: 0, closed: 0 };
  });
  const byMonth = new Map(months.map((entry) => [entry.month, entry]));
  for (const item of cases) {
    const opened = byMonth.get(monthKey(item.createdAt));
    if (opened) opened.opened += 1;
    const closed = closedAt(item);
    const closedEntry = closed && item.status === 'CLOSED' ? byMonth.get(monthKey(closed)) : undefined;
    if (closedEntry) closedEntry.closed += 1;
  }

  return {
    openedLast30: cases.filter((item) => item.createdAt.getTime() >= since).length,
    closedLast30: cases.filter((item) => {
      const closed = closedAt(item);
      return item.status === 'CLOSED' && !!closed && closed.getTime() >= since;
    }).length,
    active: active.length,
    criticalUnassigned: active.filter((item) => item.severity === 'CRITICAL' && !item.assigneeId).length,
    activeByCategory,
    closedByReason,
    medianTriageHours,
    months,
  };
}

// ── Consultation inhabituelle ──────────────────────────────────────────────

/** Dossiers ouverts par une même personne dans la fenêtre au-delà desquels la cellule est prévenue. */
export const UNUSUAL_ACCESS_THRESHOLD = 10;
export const UNUSUAL_ACCESS_WINDOW_MS = 10 * 60 * 1000;
/** Une même personne ne déclenche pas plus d'une alerte par heure. */
export const UNUSUAL_ACCESS_COOLDOWN_MS = 60 * 60 * 1000;

export function isUnusualAccess(openedInWindow: number): boolean {
  return openedInWindow >= UNUSUAL_ACCESS_THRESHOLD;
}

// ── Session récente ────────────────────────────────────────────────────────

/** Ancienneté maximale de la connexion au dashboard pour lire les dossiers. */
export const WELLBEING_SESSION_MAX_HOURS = 12;

/** Connexion trop ancienne, ou de date inconnue : il faut se reconnecter. */
export function wellbeingSessionExpired(sessionCreatedAt: number | undefined, now: number): boolean {
  if (sessionCreatedAt === undefined) return true;
  return now - sessionCreatedAt >= WELLBEING_SESSION_MAX_HOURS * 60 * 60 * 1000;
}

// ── Historique chaîné ──────────────────────────────────────────────────────

export interface ChainedCaseEvent {
  caseId: string;
  type: string;
  actorId: string | null;
  actorName: string;
  fromValue: string | null;
  toValue: string | null;
  createdAt: Date;
}

/**
 * Empreinte d'une entrée d'historique, liée à la précédente : une entrée
 * modifiée ou retirée directement en base casse la suite des empreintes.
 */
export function caseEventHash(previousHash: string | null, event: ChainedCaseEvent): string {
  const fields = [previousHash ?? '', event.caseId, event.type, event.actorId ?? '', event.actorName,
    event.fromValue ?? '', event.toValue ?? '', event.createdAt.toISOString()];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Vérifie l'historique d'un dossier, dans l'ordre chronologique. Les entrées
 * écrites avant le chaînage (sans empreinte) ne sont admises qu'en tête :
 * `partial` dit alors que seule la suite est garantie.
 */
export function verifyCaseEventChain(events: ReadonlyArray<ChainedCaseEvent & { hash: string | null }>): 'ok' | 'partial' | 'broken' {
  let previous: string | null = null;
  let chained = false;
  let legacy = false;
  for (const event of events) {
    if (!event.hash) {
      if (chained) return 'broken';
      legacy = true;
      continue;
    }
    if (caseEventHash(previous, event) !== event.hash) return 'broken';
    previous = event.hash;
    chained = true;
  }
  return legacy ? 'partial' : 'ok';
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

// ── Mentions dans une note ─────────────────────────────────────────────────

export const MAX_NOTE_MENTIONS = 5;

export function cleanMentionIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((id): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id)))].slice(0, MAX_NOTE_MENTIONS);
}

/** Message privé à un collègue mentionné : qui l'appelle, rien du dossier. */
export function mentionText(actorId: string): string {
  return `Cellule bien-être : <@${actorId}> vous signale une note dans un dossier. Ouvrez la page Bien-être du dashboard pour la lire.`;
}

// ── Mes échéances ──────────────────────────────────────────────────────────

const AGENDA_DAYS = 7;

export interface AgendaItem {
  caseId: string;
  kind: 'review' | 'task';
  dueAt: Date;
  overdue: boolean;
}

/**
 * Échéances d'une personne de la cellule sur les 7 prochains jours, retards
 * compris : suivi des dossiers dont elle est référente, et ses tâches (une
 * tâche sans responsable revient au référent du dossier). Sans contenu.
 */
export function agendaItems(
  cases: ReadonlyArray<{ id: string; status: string; assigneeId: string | null; reviewAt: Date | null }>,
  tasks: ReadonlyArray<{ caseId: string; assigneeId: string | null; dueAt: Date | null; doneAt: Date | null }>,
  viewerId: string,
  now: Date,
): AgendaItem[] {
  const horizon = now.getTime() + AGENDA_DAYS * DAY_MS;
  const active = new Map(cases.filter((item) => item.status !== 'CLOSED').map((item) => [item.id, item]));
  const item = (caseId: string, kind: AgendaItem['kind'], dueAt: Date): AgendaItem =>
    ({ caseId, kind, dueAt, overdue: dueAt.getTime() < now.getTime() });
  const reviews = [...active.values()]
    .filter((c) => c.assigneeId === viewerId && c.reviewAt && c.reviewAt.getTime() <= horizon)
    .map((c) => item(c.id, 'review', c.reviewAt!));
  const mine = tasks
    .filter((task) => !task.doneAt && task.dueAt && task.dueAt.getTime() <= horizon && active.has(task.caseId))
    .filter((task) => (task.assigneeId ?? active.get(task.caseId)?.assigneeId) === viewerId)
    .map((task) => item(task.caseId, 'task', task.dueAt!));
  return [...reviews, ...mine].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

// ── Motif de clôture ───────────────────────────────────────────────────────

/** Comment un dossier se termine : le bilan les compte. */
export const CLOSE_REASONS = ['RESOLVED', 'REFERRED', 'NO_FOLLOWUP', 'DUPLICATE'] as const;

export function cleanCloseReason(input: unknown): (typeof CLOSE_REASONS)[number] | null {
  return CLOSE_REASONS.find((reason) => reason === input) ?? null;
}

// ── Référent absent ────────────────────────────────────────────────────────

/** Absence en cours, prise en compte ou validée (une simple demande ne suffit pas). */
export function absenceActive(
  absence: { status: string; isVoid: boolean; endedAt: Date | null; startDate: Date; endDate: Date | null; isIndefinite: boolean },
  now: Date,
): boolean {
  if (!['APPROVED', 'ACKNOWLEDGED'].includes(absence.status) || absence.isVoid || absence.endedAt) return false;
  if (absence.startDate.getTime() > now.getTime()) return false;
  return absence.isIndefinite || !absence.endDate || absence.endDate.getTime() > now.getTime();
}

/** Qui reçoit la relance d'un dossier : le référent, ou son suppléant s'il est absent. */
export function reminderRecipient(assigneeId: string | null, absentIds: ReadonlySet<string>, backupUserId: string | null): string | null {
  if (!assigneeId) return null;
  if (absentIds.has(assigneeId) && backupUserId && backupUserId !== assigneeId) return backupUserId;
  return assigneeId;
}

// ── Correction d'une note ──────────────────────────────────────────────────

/** Une note se corrige par son auteur, dans ce délai ; la version d'origine reste lisible. */
export const NOTE_EDIT_HOURS = 48;

export function canEditNote(note: { authorId: string; createdAt: Date }, editorId: string, now: Date): boolean {
  return note.authorId === editorId && now.getTime() - note.createdAt.getTime() < NOTE_EDIT_HOURS * 60 * 60 * 1000;
}

// ── Résumé hebdomadaire ────────────────────────────────────────────────────

/** Membres de la cellule parmi les membres du serveur : désignés, ou par rôle. */
export function cellMemberIds(
  lists: Pick<WellbeingAccessLists, 'teamUserIds' | 'teamRoleIds'>,
  members: ReadonlyArray<{ id: string; roleIds: readonly string[] }>,
): string[] {
  const ids = new Set(lists.teamUserIds);
  for (const member of members) if (member.roleIds.some((id) => lists.teamRoleIds.includes(id))) ids.add(member.id);
  return [...ids];
}

/** Un résumé ne part qu'une fois par semaine et par serveur. */
export const DIGEST_INTERVAL_DAYS = 6;

/** Message privé du lundi : des chiffres, jamais de titre ni de personne. `null` s'il n'y a rien. */
export function weeklyDigestText(
  guildName: string,
  counts: { assigned: number; reviewsThisWeek: number; triage: number; criticalUnassigned: number },
): string | null {
  if (Object.values(counts).every((value) => value === 0)) return null;
  return [
    `Cellule bien-être de ${guildName}, votre semaine :`,
    `- dossiers dont vous êtes référent : ${counts.assigned}`,
    `- échéances de suivi cette semaine : ${counts.reviewsThisWeek}`,
    `- signalements à trier : ${counts.triage}`,
    `- dossiers critiques sans référent : ${counts.criticalUnassigned}`,
    'Le détail est sur la page Bien-être du dashboard.',
  ].join('\n');
}

/**
 * Chiffres du résumé d'une personne de la cellule. Les dossiers qui la
 * concernent sont écartés, comme partout ailleurs (conflit d'intérêts).
 */
export function digestCounts(
  cases: ReadonlyArray<{ status: string; severity: string; source: string; assigneeId: string | null; subjectUserId: string | null; reviewAt: Date | null }>,
  memberId: string,
  now: Date,
) {
  const visible = cases.filter((item) => item.status !== 'CLOSED' && !isCaseSubject(item.subjectUserId, memberId));
  const mine = visible.filter((item) => item.assigneeId === memberId);
  const weekEnd = now.getTime() + 7 * DAY_MS;
  return {
    assigned: mine.length,
    reviewsThisWeek: mine.filter((item) => item.reviewAt && item.reviewAt.getTime() <= weekEnd).length,
    triage: visible.filter((item) => item.source === 'DISCORD' && !item.assigneeId).length,
    criticalUnassigned: visible.filter((item) => item.severity === 'CRITICAL' && !item.assigneeId).length,
  };
}

/** Le résumé part le lundi, à partir de 8 h (UTC), une fois par semaine. */
export function digestDue(lastSentAt: Date | null, now: Date): boolean {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 8) return false;
  return !lastSentAt || now.getTime() - lastSentAt.getTime() >= DIGEST_INTERVAL_DAYS * DAY_MS;
}

// ── Dissolution différée ───────────────────────────────────────────────────

/** Une désactivation de la cellule n'a d'effet qu'après ce délai, annoncé à la cellule. */
export const DISSOLUTION_DELAY_HOURS = 24;

export function dissolutionDate(now: Date): Date {
  return new Date(now.getTime() + DISSOLUTION_DELAY_HOURS * 60 * 60 * 1000);
}

export function dissolutionDue(at: Date | null, now: Date): boolean {
  return !!at && at.getTime() <= now.getTime();
}

/** Plus personne dans la cellule : c'est une dissolution, soumise au même délai. */
export function emptiesComposition(lists: Pick<WellbeingAccessLists, 'teamUserIds' | 'teamRoleIds'>): boolean {
  return lists.teamUserIds.length === 0 && lists.teamRoleIds.length === 0;
}

// ── Réponse au signaleur ───────────────────────────────────────────────────

/** Message de la cellule lu par l'auteur d'un signalement avec son code de suivi. */
export const REPORTER_REPLY_MAX = 500;

// ── Journal exportable ─────────────────────────────────────────────────────

export interface JournalRow {
  date: Date;
  source: string;
  actor: string;
  action: string;
  details: string;
}

/**
 * Journal de la cellule en CSV, pour un audit : accès, décisions et réglages,
 * jamais le contenu d'un dossier. Une cellule qui commence par = + - @ est
 * préfixée d'une apostrophe pour qu'un tableur ne l'exécute pas.
 */
export function journalCsv(rows: readonly JournalRow[]): string {
  const cell = (value: string) => {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = rows.map((row) => [row.date.toISOString(), row.source, row.actor, row.action, row.details].map(cell).join(','));
  return ['date,source,auteur,action,details', ...lines].join('\r\n') + '\r\n';
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
