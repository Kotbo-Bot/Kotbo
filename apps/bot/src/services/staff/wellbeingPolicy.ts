/**
 * Règles de la cellule bien-être, sans accès à la base ni à Discord.
 *
 * La composition de la cellule décide qui lit les dossiers. Le journal
 * d'audit doit donc dire qui a été ajouté ou retiré, pas seulement combien :
 * sinon un ajout discret de soi-même à l'équipe passerait inaperçu.
 */

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
 * - REMINDER : dossier arrivé à échéance de suivi, ou critique et inactif.
 */
export const WELLBEING_ALERT_EVENTS = [
  'BREAK_GLASS', 'EMERGENCY_READ', 'TEAM_READ', 'CASE_CHANGE', 'CONFIG_CHANGE', 'REPORT', 'REMINDER',
] as const;
export type WellbeingAlertEvent = (typeof WELLBEING_ALERT_EVENTS)[number];
export const DEFAULT_ALERT_EVENTS: WellbeingAlertEvent[] = ['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER'];
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
  stage?: 'requested' | 'approved' | 'rejected';
  /** Signalement anonyme : l'alerte ne nomme personne. */
  anonymous?: boolean;
  reminder?: 'review' | 'stale';
  days?: number;
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

/** Un dossier fermé et inchangé avant cette date est supprimé. */
export function closedCaseCutoff(now: Date): Date {
  return new Date(now.getTime() - CLOSED_CASE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
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

// ── Relances et signalements ───────────────────────────────────────────────

export function staleCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Un même membre n'envoie qu'un signalement par période : la cellule n'est pas noyée. */
export const REPORT_COOLDOWN_MS = 10 * 60 * 1000;

export function shouldAcceptReport(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= REPORT_COOLDOWN_MS;
}

/** Nom de base (anglais) de la commande Discord : ses usages ne sont pas comptés par membre. */
export const WELLBEING_COMMAND = 'wellbeing';
