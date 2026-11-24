/**
 * Libellés des types de journaux et de leurs catégories.
 *
 * Le catalogue (`@kotbo/shared`) donne les types ; ce fichier leur donne un
 * nom lisible. Le `Record` complet est voulu : un type ajouté au catalogue
 * sans libellé fait échouer la compilation, au lieu d'apparaître dans la page
 * sous son identifiant technique.
 */
import type { LogEventCategory, LogEventType } from '@kotbo/shared';
import { m } from './i18n';

interface Label {
  label: () => string;
  desc: () => string;
}

export const LOG_EVENT_LABELS: Record<LogEventType, Label> = {
  message_delete: { label: m.lg_ev_message_delete, desc: m.lg_ev_message_delete_d },
  message_edit: { label: m.lg_ev_message_edit, desc: m.lg_ev_message_edit_d },
  message_bulk_delete: { label: m.lg_ev_bulk_delete, desc: m.lg_ev_bulk_delete_d },

  member_join: { label: m.lg_ev_member_join, desc: m.lg_ev_member_join_d },
  member_leave: { label: m.lg_ev_member_leave, desc: m.lg_ev_member_leave_d },
  member_roles_update: { label: m.lg_ev_roles_update, desc: m.lg_ev_roles_update_d },
  member_tag_update: { label: m.lg_ev_tag_update, desc: m.lg_ev_tag_update_d },
  member_timeout: { label: m.lg_ev_member_timeout, desc: m.lg_ev_member_timeout_d },

  moderation_kick: { label: m.lg_ev_kick, desc: m.lg_ev_kick_d },
  moderation_ban: { label: m.lg_ev_ban, desc: m.lg_ev_ban_d },
  moderation_unban: { label: m.lg_ev_unban, desc: m.lg_ev_unban_d },
  moderation_timeout: { label: m.lg_ev_timeout_audit, desc: m.lg_ev_timeout_audit_d },

  voice_join: { label: m.lg_ev_voice_join, desc: m.lg_ev_voice_join_d },
  voice_leave: { label: m.lg_ev_voice_leave, desc: m.lg_ev_voice_leave_d },
  voice_move: { label: m.lg_ev_voice_move, desc: m.lg_ev_voice_move_d },
  voice_moderation: { label: m.lg_ev_voice_moderation, desc: m.lg_ev_voice_moderation_d },
  voice_panel: { label: m.lg_ev_voice_panel, desc: m.lg_ev_voice_panel_d },

  channel_lifecycle: { label: m.lg_ev_channel_lifecycle, desc: m.lg_ev_channel_lifecycle_d },
  role_lifecycle: { label: m.lg_ev_role_lifecycle, desc: m.lg_ev_role_lifecycle_d },

  automod_sanction: { label: m.lg_ev_automod_sanction, desc: m.lg_ev_automod_sanction_d },
  automod_native_alert: { label: m.lg_ev_automod_native_alert, desc: m.lg_ev_automod_native_alert_d },
  automod_ghost_ping: { label: m.lg_ev_automod_ghost_ping, desc: m.lg_ev_automod_ghost_ping_d },
  automod_spam: { label: m.lg_ev_automod_spam, desc: m.lg_ev_automod_spam_d },
  automod_slowmode: { label: m.lg_ev_automod_slowmode, desc: m.lg_ev_automod_slowmode_d },
  automod_files: { label: m.lg_ev_automod_files, desc: m.lg_ev_automod_files_d },
  automod_other_servers: { label: m.lg_ev_automod_other_servers, desc: m.lg_ev_automod_other_servers_d },
  automod_emoji: { label: m.lg_ev_automod_emoji, desc: m.lg_ev_automod_emoji_d },
  automod_nickname: { label: m.lg_ev_automod_nickname, desc: m.lg_ev_automod_nickname_d },
  automod_tag: { label: m.lg_ev_automod_tag, desc: m.lg_ev_automod_tag_d },
  automod_clans: { label: m.lg_ev_automod_clans, desc: m.lg_ev_automod_clans_d },
  vision_blocked: { label: m.lg_ev_vision_blocked, desc: m.lg_ev_vision_blocked_d },
  aegis_alert: { label: m.lg_ev_aegis_alert, desc: m.lg_ev_aegis_alert_d },

  security_honeypot: { label: m.lg_ev_security_honeypot, desc: m.lg_ev_security_honeypot_d },
  security_anti_bot: { label: m.lg_ev_security_anti_bot, desc: m.lg_ev_security_anti_bot_d },
  security_shield: { label: m.lg_ev_security_shield, desc: m.lg_ev_security_shield_d },
  security_admin_lock: { label: m.lg_ev_security_admin_lock, desc: m.lg_ev_security_admin_lock_d },
  security_captcha: { label: m.lg_ev_security_captcha, desc: m.lg_ev_security_captcha_d },
  security_ban_hygiene: { label: m.lg_ev_security_ban_hygiene, desc: m.lg_ev_security_ban_hygiene_d },

  alt_detection: { label: m.lg_ev_alt_detection, desc: m.lg_ev_alt_detection_d },
  alt_validation: { label: m.lg_ev_alt_validation, desc: m.lg_ev_alt_validation_d },
  verification_warn_threshold: { label: m.lg_ev_verification_warn_threshold, desc: m.lg_ev_verification_warn_threshold_d },
};

export const LOG_CATEGORY_META: Record<LogEventCategory, { label: () => string; icon: string }> = {
  messages: { label: m.lg_cat_messages, icon: 'Chat' },
  members: { label: m.lg_cat_members, icon: 'Users' },
  moderation: { label: m.lg_cat_moderation, icon: 'Shield' },
  voice: { label: m.lg_cat_voice, icon: 'Microphone' },
  server: { label: m.lg_cat_lifecycle, icon: 'Folder' },
  automod: { label: m.lg_cat_automod, icon: 'Filter' },
  security: { label: m.lg_cat_security, icon: 'ShieldAlert' },
  accounts: { label: m.lg_cat_accounts, icon: 'UserCheck' },
};
