/**
 * Logique de l'onglet Réglages de la cellule bien-être : formulaire, score de
 * sécurité, tableau « qui peut quoi » et parcours de première configuration.
 * Sans dépendance à Svelte, pour être testée seule.
 */

export interface WbConfigForm {
  enabled: boolean;
  requireReason: boolean;
  teamUserIds: string[];
  teamRoleIds: string[];
  directorUserIds: string[];
  directorRoleIds: string[];
  backupUserId: string | null;
  alertChannelId: string;
  alertUserIds: string[];
  alertEvents: string[];
  breakGlassApproval: boolean;
  reportEnabled: boolean;
  staleCriticalDays: number;
}

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);

/** Configuration renvoyée par le bot, ou vide : les défauts sont les plus prudents. */
export function wbConfigFromApi(config: Record<string, unknown>): WbConfigForm {
  return {
    enabled: config.enabled === true,
    requireReason: config.requireReason !== false,
    teamUserIds: ids(config.teamUserIds),
    teamRoleIds: ids(config.teamRoleIds),
    directorUserIds: ids(config.directorUserIds),
    directorRoleIds: ids(config.directorRoleIds),
    backupUserId: typeof config.backupUserId === 'string' ? config.backupUserId : null,
    alertChannelId: typeof config.alertChannelId === 'string' ? config.alertChannelId : '',
    alertUserIds: ids(config.alertUserIds),
    alertEvents: ids(config.alertEvents),
    breakGlassApproval: config.breakGlassApproval === true,
    reportEnabled: config.reportEnabled === true,
    staleCriticalDays: typeof config.staleCriticalDays === 'number' ? config.staleCriticalDays : 7,
  };
}

/** Corps de `PUT /wellbeing/config`. Même plafond que le bot pour la relance (MAX_STALE_DAYS). */
export function wbConfigToApi(form: WbConfigForm) {
  return {
    ...form,
    alertChannelId: form.alertChannelId || null,
    staleCriticalDays: Math.max(0, Math.min(90, Math.round(Number(form.staleCriticalDays) || 0))),
  };
}

// ── Sections et parcours ───────────────────────────────────────────────────

export type WbSettingsSection = 'review' | 'team' | 'direction' | 'alerts' | 'reports';

export const WB_SETUP_STEPS = ['team', 'direction', 'alerts', 'reports', 'summary'] as const;
export type WbSetupStep = (typeof WB_SETUP_STEPS)[number];

/** Cellule jamais activée ni composée : le parcours guidé est proposé. */
export function wbFirstSetup(form: WbConfigForm): boolean {
  return !form.enabled && form.teamUserIds.length === 0 && form.teamRoleIds.length === 0;
}

const hasTeam = (form: WbConfigForm) => form.teamUserIds.length > 0 || form.teamRoleIds.length > 0;
const hasAlertRecipients = (form: WbConfigForm) => !!form.alertChannelId || form.alertUserIds.length > 0;

/** L'essentiel d'une étape est rempli ; direction et signalements sont facultatifs. */
export function wbStepComplete(form: WbConfigForm, step: WbSetupStep): boolean {
  if (step === 'team') return hasTeam(form);
  if (step === 'alerts') return hasAlertRecipients(form);
  return true;
}

// ── Score de sécurité ──────────────────────────────────────────────────────

export type WbSecurityCheckId = 'named_members' | 'two_keys' | 'require_reason' | 'alerts' | 'backup' | 'review' | 'reports_noticed';

export interface WbSecurityCheck {
  id: WbSecurityCheckId;
  ok: boolean;
  /** Section où se corrige le point. */
  section: WbSettingsSection;
}

/**
 * Points de prudence d'une configuration. Les signalements ne comptent que
 * s'ils sont ouverts : sans destinataire, ils arriveraient sans que personne
 * ne le sache.
 */
export function wbSecurityChecks(form: WbConfigForm, context: { accessReviewDue: boolean }): WbSecurityCheck[] {
  const checks: WbSecurityCheck[] = [
    // Un rôle Discord peut être donné par d'autres que le propriétaire : les noms sont plus sûrs.
    { id: 'named_members', ok: form.teamUserIds.length > 0 && form.teamRoleIds.length === 0, section: 'team' },
    { id: 'two_keys', ok: form.breakGlassApproval, section: 'direction' },
    { id: 'require_reason', ok: form.requireReason, section: 'direction' },
    { id: 'alerts', ok: hasAlertRecipients(form), section: 'alerts' },
    { id: 'backup', ok: !!form.backupUserId, section: 'team' },
    { id: 'review', ok: !context.accessReviewDue, section: 'review' },
  ];
  if (form.reportEnabled) {
    checks.push({ id: 'reports_noticed', ok: form.alertEvents.includes('REPORT') && hasAlertRecipients(form), section: 'reports' });
  }
  return checks;
}

export function wbSecurityScore(checks: readonly WbSecurityCheck[]): number {
  if (checks.length === 0) return 100;
  return Math.round((checks.filter((check) => check.ok).length / checks.length) * 100);
}

// ── Qui peut quoi ──────────────────────────────────────────────────────────

export type WbAccessLevel = 'yes' | 'no' | 'emergency' | 'emergency_two_keys';

export interface WbAccessRow {
  id: 'team' | 'direction' | 'owner' | 'backup';
  members: number;
  roles: number;
  read: WbAccessLevel;
  write: WbAccessLevel;
  configure: WbAccessLevel;
  reminders: WbAccessLevel;
}

/**
 * Ce que chacun peut faire, d'après la configuration en cours d'édition. La
 * direction et le propriétaire ne lisent que sous accès d'urgence, validé par
 * une seconde personne si l'option est cochée.
 */
export function wbAccessMatrix(form: WbConfigForm): WbAccessRow[] {
  const emergency: WbAccessLevel = form.breakGlassApproval ? 'emergency_two_keys' : 'emergency';
  return [
    { id: 'team', members: form.teamUserIds.length, roles: form.teamRoleIds.length, read: 'yes', write: 'yes', configure: 'no', reminders: 'yes' },
    { id: 'direction', members: form.directorUserIds.length, roles: form.directorRoleIds.length, read: emergency, write: 'no', configure: 'no', reminders: 'no' },
    { id: 'owner', members: 1, roles: 0, read: emergency, write: 'no', configure: 'yes', reminders: 'no' },
    ...(form.backupUserId
      ? [{ id: 'backup' as const, members: 1, roles: 0, read: 'yes' as const, write: 'yes' as const, configure: 'no' as const, reminders: 'yes' as const }]
      : []),
  ];
}
