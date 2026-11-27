/**
 * Règles de la cellule de suivi, sans accès à la base ni à Discord.
 *
 * La composition de la cellule décide qui lit les dossiers. Le journal
 * d'audit doit donc dire qui a été ajouté ou retiré, pas seulement combien :
 * sinon un ajout discret de soi-même à l'équipe passerait inaperçu.
 */
import { DEFAULT_ALERT_EVENTS } from './wellbeingAlertPolicy.js';
import { DAY_MS } from './wellbeingPolicyShared.js';

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
  crisisProtocol?: boolean;
  followUpDays?: number;
  sanctionSignal?: boolean;
  distressWatch?: boolean;
  networkPool?: boolean;
  profileRetentionMonths?: number;
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
    (prev.crisisProtocol ?? true) !== (after.crisisProtocol ?? true)
      ? `Protocole de crise : ${after.crisisProtocol ?? true ? 'activé' : 'désactivé'}` : null,
    (prev.followUpDays ?? 30) !== (after.followUpDays ?? 30)
      ? `Prise de nouvelles après clôture : ${after.followUpDays ? `${after.followUpDays} jour(s)` : 'désactivée'}` : null,
    (prev.sanctionSignal ?? false) !== (after.sanctionSignal ?? false)
      ? `Signal aux modérateurs : ${after.sanctionSignal ? 'activé' : 'désactivé'}` : null,
    (prev.distressWatch ?? false) !== (after.distressWatch ?? false)
      ? `Repérage des mots de détresse : ${after.distressWatch ? 'activé' : 'désactivé'}` : null,
    (prev.networkPool ?? false) !== (after.networkPool ?? false)
      ? `Référents du réseau : ${after.networkPool ? 'partagés' : 'plus partagés'}` : null,
    // À la création de la cellule, la durée par défaut n'est pas un changement.
    prev.profileRetentionMonths !== undefined && after.profileRetentionMonths !== undefined
      && prev.profileRetentionMonths !== after.profileRetentionMonths
      ? `Conservation des fiches : ${after.profileRetentionMonths} mois` : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join(' · ') : 'Aucun changement';
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

/** Module inscrit au journal d'audit pour les gestes de la cellule. */
export const WELLBEING_AUDIT_MODULE = 'Suivi confidentiel';

/** Nom de base (anglais) de la commande Discord : ses usages ne sont pas comptés par membre. */
export const WELLBEING_COMMAND = 'confidential';

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
    `Revue des accès de la cellule de suivi de ${guildName}.`,
    'Ces personnes peuvent lire les dossiers confidentiels ou demander un accès d\'urgence :',
    line('Membres de la cellule', lists.teamUserIds),
    line('Rôles de la cellule', lists.teamRoleIds),
    line('Membres de la direction', lists.directorUserIds),
    line('Rôles de la direction', lists.directorRoleIds),
    'Si c\'est toujours juste, confirmez-le dans l\'onglet Réglages de la page Suivi confidentiel du dashboard ; sinon, retirez qui n\'en a plus besoin.',
  ].join('\n');
}

// ── Session récente ────────────────────────────────────────────────────────

/** Ancienneté maximale de la connexion au dashboard pour lire les dossiers. */
export const WELLBEING_SESSION_MAX_HOURS = 12;

/** Connexion trop ancienne, ou de date inconnue : il faut se reconnecter. */
export function wellbeingSessionExpired(sessionCreatedAt: number | undefined, now: number): boolean {
  if (sessionCreatedAt === undefined) return true;
  return now - sessionCreatedAt >= WELLBEING_SESSION_MAX_HOURS * 60 * 60 * 1000;
}

// ── Membres de la cellule ──────────────────────────────────────────────────

/** Membres de la cellule parmi les membres du serveur : désignés, ou par rôle. */
export function cellMemberIds(
  lists: Pick<WellbeingAccessLists, 'teamUserIds' | 'teamRoleIds'>,
  members: ReadonlyArray<{ id: string; roleIds: readonly string[] }>,
): string[] {
  const ids = new Set(lists.teamUserIds);
  for (const member of members) if (member.roleIds.some((id) => lists.teamRoleIds.includes(id))) ids.add(member.id);
  return [...ids];
}

/** Délai minimal entre deux chargements complets des membres d'un serveur. */
export const MEMBER_LOAD_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Faut-il charger tous les membres du serveur pour connaître la cellule ? Seuls
 * les rôles l'exigent (un membre absent du cache n'y serait pas compté), et
 * seulement si le cache est incomplet, sans recommencer avant 10 minutes.
 */
export function shouldLoadAllMembers(state: {
  teamRoleIds: readonly string[];
  cacheSize: number;
  memberCount: number;
  lastLoadedAt: number | undefined;
  now: number;
}): boolean {
  if (state.teamRoleIds.length === 0 || state.cacheSize >= state.memberCount) return false;
  return state.lastLoadedAt === undefined || state.now - state.lastLoadedAt >= MEMBER_LOAD_INTERVAL_MS;
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
