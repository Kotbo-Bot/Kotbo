/** Libellés et icônes de l'automod des tags, partagés par la page, l'assistant et la fiche serveur. */
import { m } from '../../i18n';
import type { TagAction, TagTrigger, TagAutomodEvent } from '../../api';

export type ActionMeta = { label: string; hint: string; icon: string; tone: 'soft' | 'medium' | 'strong'; needsDuration: boolean };

export function tagActionMeta(action: TagAction): ActionMeta {
  switch (action) {
    case 'ALERT': return { label: m.tam_action_alert(), hint: m.tam_action_alert_hint(), icon: 'Bell', tone: 'soft', needsDuration: false };
    case 'DM': return { label: m.tam_action_dm(), hint: m.tam_action_dm_hint(), icon: 'MessageCircle', tone: 'soft', needsDuration: false };
    case 'TICKET': return { label: m.tam_action_ticket(), hint: m.tam_action_ticket_hint(), icon: 'Ticket', tone: 'soft', needsDuration: false };
    case 'ROLE': return { label: m.tam_action_role(), hint: m.tam_action_role_hint(), icon: 'Tag', tone: 'medium', needsDuration: false };
    case 'WARN': return { label: m.tam_action_warn(), hint: m.tam_action_warn_hint(), icon: 'AlertTriangle', tone: 'medium', needsDuration: false };
    case 'TIMEOUT': return { label: m.tam_action_timeout(), hint: m.tam_action_timeout_hint(), icon: 'Clock', tone: 'medium', needsDuration: true };
    case 'JAIL': return { label: m.tam_action_jail(), hint: m.tam_action_jail_hint(), icon: 'Lock', tone: 'medium', needsDuration: true };
    case 'KICK': return { label: m.tam_action_kick(), hint: m.tam_action_kick_hint(), icon: 'LogOut', tone: 'strong', needsDuration: false };
    case 'SOFTBAN': return { label: m.tam_action_softban(), hint: m.tam_action_softban_hint(), icon: 'UserX', tone: 'strong', needsDuration: false };
    case 'BAN': return { label: m.tam_action_ban(), hint: m.tam_action_ban_hint(), icon: 'Ban', tone: 'strong', needsDuration: true };
  }
}

/** Actions proposées, de la plus douce à la plus forte. */
export const TAG_ACTIONS: TagAction[] = ['ALERT', 'DM', 'TICKET', 'ROLE', 'WARN', 'TIMEOUT', 'JAIL', 'KICK', 'SOFTBAN', 'BAN'];

/** Actions d'escalade : pas d'escalade vers plus doux que la première réponse. */
export const ESCALATION_ACTIONS: TagAction[] = ['TIMEOUT', 'JAIL', 'KICK', 'BAN'];

export function tagTriggerLabel(trigger: TagTrigger): string {
  return {
    JOIN: m.tam_trigger_join(),
    TAG_CHANGE: m.tam_trigger_tag_change(),
    RESCAN: m.tam_trigger_rescan(),
    WAVE: m.tam_trigger_wave(),
    NEW_ACCOUNT: m.tam_trigger_new_account(),
    MASS_ADOPT: m.tam_trigger_mass_adopt(),
    IMPERSONATION: m.tam_trigger_impersonation(),
    SHARED_LIST: m.tam_trigger_shared_list(),
    PRESET_LIST: m.tam_trigger_preset_list(),
    ALLOWLIST: m.tam_trigger_allowlist(),
    ESCALATION: m.tam_trigger_escalation(),
  }[trigger];
}

export function tagStatusMeta(status: TagAutomodEvent['status']): { label: string; className: string } {
  return {
    APPLIED: { label: m.tam_status_applied(), className: 'bg-success/10 text-on-success-container border-success/30' },
    DRY_RUN: { label: m.tam_status_dry_run(), className: 'bg-surface-container-high text-on-surface-variant border-outline-variant/40' },
    PENDING: { label: m.tam_status_pending(), className: 'bg-warning/10 text-on-warning-container border-warning/30' },
    RESOLVED: { label: m.tam_status_resolved(), className: 'bg-primary/10 text-primary border-primary/30' },
    FAILED: { label: m.tam_status_failed(), className: 'bg-error/10 text-on-error-container border-error/30' },
    SKIPPED: { label: m.tam_status_skipped(), className: 'bg-surface-container-high text-on-surface-variant border-outline-variant/40' },
  }[status];
}

/** Crans de durée proposés (minutes). */
export const DURATION_PRESETS = [10, 60, 360, 1440, 10080];
export const ESCALATION_DELAY_PRESETS = [60, 360, 1440, 4320];
