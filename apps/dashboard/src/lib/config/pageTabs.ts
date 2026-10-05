import { m } from '../i18n';
import { allPages } from './pages';

/**
 * Onglets de chaque page, adressables par URL.
 *
 * Les pages découpent leur contenu en onglets via `tabRouting` : `/economy`
 * porte dix sections, `/analytics` près de trente. Ces sections sont invisibles
 * pour qui cherche « bestiaire » ou « rétention » depuis la palette, qui ne
 * connaissait que les pages. Ce registre les lui donne.
 *
 * Il est tenu à la main plutôt que dérivé des pages : chaque page définit ses
 * onglets à sa façon (tableau de slugs, boutons en dur, composant partagé), et
 * les importer toutes ferait entrer l'application entière dans le bundle de la
 * palette. Le prix est de le mettre à jour quand un onglet naît ; le contrat est
 * simple, un onglet absent d'ici reste seulement absent de la recherche.
 */
export interface PageTabConfig {
  /** Segment d'URL de l'onglet, tel que `resolveTabFromUrl` l'attend. */
  id: string;
  /** Libellé lu par un humain, dans la langue du dashboard. */
  label: () => string;
  icon?: string;
}

/**
 * Clé : `href` de la page dans `pages.ts`. Valeur : ses onglets, dans l'ordre où
 * la page les affiche.
 */
export const PAGE_TABS: Record<string, PageTabConfig[]> = {
  '/pulse': [
    { id: 'apercu', label: () => m.pulse_tab_overview(), icon: 'layout' },
    { id: 'sante', label: () => m.pulse_tab_health(), icon: 'heart' },
    { id: 'predictions', label: () => m.pulse_tab_predictions(), icon: 'trending-up' },
  ],

  '/inbox': [
    { id: 'tous', label: () => m.inbox_tab_all(), icon: 'layers' },
    { id: 'modération', label: () => m.inbox_tab_moderation(), icon: 'shield' },
    { id: 'recrutement', label: () => m.inbox_tab_recruitment(), icon: 'users' },
    { id: 'staff', label: () => m.inbox_tab_staff(), icon: 'user-check' },
    { id: 'système', label: () => m.inbox_tab_system(), icon: 'cpu' },
  ],

  '/analytics': [
    { id: 'overview', label: () => m.an_tab_overview(), icon: 'Grid' },
    { id: 'messages', label: () => m.an_tab_messages(), icon: 'ChatCircleDots' },
    { id: 'voice', label: () => m.an_tab_voice(), icon: 'Microphone' },
    { id: 'live', label: () => m.anx_tab_live(), icon: 'Radio' },
    { id: 'compare', label: () => m.anx_tab_compare(), icon: 'GitCompare' },
    { id: 'heatmap', label: () => m.an_tab_heatmap(), icon: 'Fire' },
    { id: 'pulse', label: () => m.an_tab_pulse(), icon: 'Activity' },
    { id: 'weekly', label: () => m.an_tab_weekly(), icon: 'Calendar' },
    { id: 'commands', label: () => m.an_tab_commands(), icon: 'Code' },
    { id: 'algo', label: () => m.an_tab_algo(), icon: 'Code' },
    { id: 'content', label: () => m.anx_section_content(), icon: 'ChatCircleDots' },
    { id: 'emojis', label: () => m.anx_tab_emojis(), icon: 'Smile' },
    { id: 'stickers', label: () => m.anx_tab_stickers(), icon: 'image' },
    { id: 'gifs', label: () => m.anx_tab_gifs(), icon: 'Lightning' },
    { id: 'sites', label: () => m.anx_tab_sites(), icon: 'link' },
    { id: 'formatting', label: () => m.anx_tab_formatting(), icon: 'Type' },
    { id: 'words', label: () => m.an_tab_words(), icon: 'ChatCircleDots' },
    { id: 'channels', label: () => m.anx_section_channels(), icon: 'ChatBubbles' },
    { id: 'responses', label: () => m.anx_tab_responses(), icon: 'Clock' },
    { id: 'channel-health', label: () => m.anx_channels_health_title(), icon: 'heart' },
    { id: 'members', label: () => m.an_tab_members(), icon: 'UsersFour' },
    { id: 'engagement', label: () => m.anx_tab_engagement(), icon: 'Activity' },
    { id: 'lifecycle', label: () => m.anx_tab_lifecycle(), icon: 'Users' },
    { id: 'concentration', label: () => m.anx_tab_concentration(), icon: 'PieChart' },
    { id: 'interactions', label: () => m.an_tab_network(), icon: 'Compass' },
    { id: 'social', label: () => m.an_tab_social(), icon: 'Users' },
    { id: 'ghosts', label: () => m.ghost_tab(), icon: 'Ghost' },
    { id: 'growth', label: () => m.anx_section_growth(), icon: 'TrendingUp' },
    { id: 'funnel', label: () => m.anx_tab_funnel(), icon: 'Filter' },
    { id: 'cohorts', label: () => m.an_tab_cohorts(), icon: 'UsersFour' },
    { id: 'churn', label: () => m.an_tab_churn(), icon: 'Warning' },
    { id: 'moderation', label: () => m.an_tab_moderation(), icon: 'Gavel' },
    { id: 'mod-advanced', label: () => m.an_tab_mod_advanced(), icon: 'ChartLineUp' },
    { id: 'staff', label: () => m.an_tab_staff_directory(), icon: 'Users' },
    { id: 'performance', label: () => m.an_tab_staff_performance(), icon: 'TrendUp' },
    { id: 'tickets', label: () => m.anx_tab_tickets(), icon: 'Ticket' },
    { id: 'alerts', label: () => m.anx_tab_alerts(), icon: 'Bell' },
    { id: 'reports', label: () => m.anx_tab_reports(), icon: 'Mail' },
  ],

  '/invitations': [
    { id: 'invites', label: () => m.iv_tab_invites(), icon: 'MailOpen' },
    { id: 'sources', label: () => m.iv_tab_sources(), icon: 'Tags' },
    { id: 'top', label: () => m.iv_tab_top(), icon: 'Crown' },
    { id: 'suspensions', label: () => m.iv_tab_suspensions(), icon: 'UserX' },
  ],

  '/logs': [
    { id: 'logs', label: () => m.lg_tab_journal(), icon: 'file-text' },
    { id: 'audit', label: () => m.audit_tab(), icon: 'history' },
    { id: 'config', label: () => m.lg_tab_config(), icon: 'settings' },
  ],

  // ── Sécurité ──────────────────────────────────────────────────────────────
  '/security/anti-raid': [
    { id: 'detection', label: () => m.sec_tab_antiraid_detection(), icon: 'ShieldAlert' },
    { id: 'captcha', label: () => m.sec_tab_antiraid_captcha(), icon: 'UserCheck' },
    { id: 'scams', label: () => m.sec_tab_antiraid_scams(), icon: 'Fishing' },
    { id: 'invites', label: () => m.sec_tab_antiraid_invites(), icon: 'Link' },
    { id: 'queues', label: () => m.sec_tab_antiraid_queues(), icon: 'Inbox' },
  ],

  '/security/filters': [
    { id: 'bot', label: () => m.am_tab_bot_filters(), icon: 'shield-alert' },
    { id: 'discord', label: () => m.am_tab_discord_filters(), icon: 'shield' },
    { id: 'ai', label: () => m.aegis_tab(), icon: 'sparkles' },
    { id: 'security', label: () => m.am_tab_security(), icon: 'lock' },
    { id: 'behavioral', label: () => m.am_tab_behavioral(), icon: 'activity' },
    { id: 'exceptions', label: () => m.am_tab_exceptions(), icon: 'filter' },
    { id: 'simulator', label: () => m.sim_tab_label(), icon: 'history' },
  ],

  '/security/filters/nicknames': [
    { id: 'custom', label: () => m.nm_tab_custom_label(), icon: 'user' },
    { id: 'global', label: () => m.nm_tab_global_label(), icon: 'globe' },
  ],

  '/security/accounts': [
    { id: 'links', label: () => m.da_tab_links(), icon: 'Link2' },
    { id: 'detections', label: () => m.da_tab_detections(), icon: 'ShieldAlert' },
    { id: 'network', label: () => m.da_tab_network(), icon: 'GitMerge' },
    { id: 'verification', label: () => m.da_tab_verification(), icon: 'ShieldCheck' },
    { id: 'config', label: () => m.da_tab_config(), icon: 'Settings' },
  ],

  '/security/sanctions': [
    { id: 'sanctions', label: () => m.sc_tab_history(), icon: 'alert-triangle' },
    { id: 'settings', label: () => m.sc_tab_configuration(), icon: 'settings' },
  ],

  // ── Progression ───────────────────────────────────────────────────────────
  '/leveling': [
    { id: 'accueil', label: () => m.lv_tab_home(), icon: 'home' },
    { id: 'gains', label: () => m.lv_tab_gains(), icon: 'Settings' },
    { id: 'progression', label: () => m.lv_tab_progression(), icon: 'Grades' },
    { id: 'annonces', label: () => m.lv_tab_announcements(), icon: 'Bell' },
    { id: 'leaderboard', label: () => m.lv_tab_leaderboard(), icon: 'Grades' },
    { id: 'import', label: () => m.lv_tab_import(), icon: 'Upload' },
  ],

  '/prestige': [
    { id: 'accueil', label: () => m.prg_tab_home(), icon: 'home' },
    { id: 'gains', label: () => m.prg_tab_gains(), icon: 'chart' },
    { id: 'echelle', label: () => m.prg_tab_ladder(), icon: 'shield' },
    { id: 'annonces', label: () => m.prg_tab_announcements(), icon: 'bell' },
    { id: 'evenements', label: () => m.prg_tab_events(), icon: 'zap' },
    { id: 'classement', label: () => m.prg_tab_leaderboard(), icon: 'crown' },
  ],

  // ── Économie ──────────────────────────────────────────────────────────────
  '/economy': [
    { id: 'config', label: () => m.eco_tab_config(), icon: 'settings' },
    { id: 'items', label: () => m.eco_tab_items(), icon: 'package' },
    { id: 'blackmarket', label: () => m.eco_tab_blackmarket(), icon: 'moon' },
    { id: 'players', label: () => m.eco_tab_players(), icon: 'users' },
  ],

  '/rpg': [
    { id: 'recettes', label: () => m.eco_tab_recipes(), icon: 'Hammer' },
    { id: 'bestiaire', label: () => m.eco_tab_bestiary(), icon: 'ghost' },
    { id: 'donjons', label: () => m.eco_tab_dungeons(), icon: 'DoorOpen' },
    { id: 'tour', label: () => m.eco_tab_tower(), icon: 'Building' },
    { id: 'peche', label: () => m.eco_tab_fish(), icon: 'Fish' },
    { id: 'raid', label: () => m.eco_tab_raid(), icon: 'crown' },
    { id: 'quetes', label: () => m.eco_tab_quests(), icon: 'Tasks' },
    { id: 'titres', label: () => m.eco_tab_titles(), icon: 'award' },
    { id: 'aventures', label: () => m.eco_tab_events(), icon: 'Compass' },
    { id: 'guildes', label: () => m.eco_tab_guilds(), icon: 'Shield' },
  ],

  '/marketplace': [
    { id: 'listings', label: () => m.mar_tab_listings_label(), icon: 'grid' },
    { id: 'history', label: () => m.mar_tab_history_label(), icon: 'clock' },
  ],

  // ── Communauté ────────────────────────────────────────────────────────────
  '/giveaways': [
    { id: 'concours', label: () => m.giv_tab_giveaways(), icon: 'Sparkles' },
    { id: 'modeles', label: () => m.giv_tab_templates(), icon: 'Copy' },
    { id: 'configuration', label: () => m.giv_tab_config(), icon: 'Settings' },
  ],

  '/announcement': [
    { id: 'welcome', label: () => m.announcements_tab_welcome(), icon: 'DoorOpen' },
    { id: 'leave', label: () => m.announcements_tab_leave(), icon: 'Logout' },
    { id: 'boost', label: () => m.announcements_tab_boost(), icon: 'Zap' },
    { id: 'autoroles', label: () => m.announcements_tab_autoroles(), icon: 'Shield' },
    { id: 'thread', label: () => m.announcements_tab_thread(), icon: 'chat' },
    { id: 'experiments', label: () => m.wx_tab(), icon: 'git-branch' },
  ],

  '/news': [
    { id: 'articles', label: () => m.news_tab_articles(), icon: 'rss' },
    { id: 'configs', label: () => m.news_tab_configs(), icon: 'settings' },
  ],

  '/social-networks': [
    { id: 'youtube', label: () => m.sn_tab_youtube(), icon: 'video' },
    { id: 'twitch', label: () => m.sn_tab_twitch(), icon: 'video' },
    { id: 'github', label: () => m.sn_tab_github(), icon: 'code' },
    { id: 'huggingface', label: () => m.sn_tab_huggingface(), icon: 'cpu' },
  ],

  // ── Staff ─────────────────────────────────────────────────────────────────
  '/staff-management': [
    { id: 'members', label: () => m.sm_tab_members(), icon: 'users' },
    { id: 'roles', label: () => m.sm_tab_roles(), icon: 'shield' },
    { id: 'organigramme', label: () => m.sm_tab_org(), icon: 'git-branch' },
    { id: 'warnings', label: () => m.sm_tab_warnings(), icon: 'alert-circle' },
    { id: 'blacklist', label: () => m.sm_tab_blacklist(), icon: 'user-x' },
    { id: 'polls', label: () => m.sm_tab_polls(), icon: 'bar-chart' },
    { id: 'leadership', label: () => m.sm_tab_leadership(), icon: 'crown' },
    { id: 'permissions', label: () => m.sm_tab_permissions(), icon: 'lock' },
  ],

  '/tickets': [
    { id: 'tickets', label: () => m.e1_tickets_tab_tickets(), icon: 'message-square' },
    { id: 'performance', label: () => m.th_tab_performance(), icon: 'trending-up' },
    { id: 'transcripts', label: () => m.e1_tickets_tab_transcripts(), icon: 'file-text' },
    { id: 'satisfaction', label: () => m.e1_tickets_tab_satisfaction(), icon: 'star' },
    { id: 'macros', label: () => m.e1_tickets_tab_macros(), icon: 'message-circle' },
    { id: 'blacklist', label: () => m.e1_tickets_tab_blacklist(), icon: 'user-x' },
    { id: 'config', label: () => m.e1_tickets_tab_config(), icon: 'settings' },
  ],

  '/planning': [
    { id: 'meeting', label: () => m.pl_tab_meetings(), icon: 'users' },
    { id: 'absence', label: () => m.pl_tab_absences(), icon: 'calendar' },
    { id: 'call', label: () => m.pl_tab_calls(), icon: 'phone' },
    { id: 'task', label: () => m.pl_tab_tasks(), icon: 'check-square' },
  ],

  // ── Configuration ─────────────────────────────────────────────────────────
  '/management': [
    { id: 'apercu', label: () => m.mgmt_nav_overview(), icon: 'grid' },
    { id: 'salons', label: () => m.mgmt_tab_channels_roles(), icon: 'hash' },
    { id: 'acces', label: () => m.mgmt_nav_access(), icon: 'shield' },
  ],

  '/channel-health': [
    { id: 'accueil', label: () => m.channel_health_tab_presets(), icon: 'sliders-horizontal' },
    { id: 'overview', label: () => m.channel_health_tab_overview(), icon: 'pie-chart' },
    { id: 'alerts', label: () => m.channel_health_tab_alerts(), icon: 'bell' },
    { id: 'config', label: () => m.channel_health_tab_config(), icon: 'settings' },
  ],

  '/channels-management': [
    { id: 'by-channel', label: () => m.cm_tab_by_channel(), icon: 'hash' },
    { id: 'auto-thread', label: () => m.cm_tab_auto_thread(), icon: 'git-branch' },
    { id: 'sticky', label: () => m.cm_tab_sticky(), icon: 'pin' },
    { id: 'stats', label: () => m.cm_tab_stats(), icon: 'bar-chart' },
    { id: 'temp-voice', label: () => m.cm_tab_temp_voice(), icon: 'mic' },
    { id: 'access-requests', label: () => m.cm_tab_access_requests(), icon: 'key' },
    { id: 'honeypot', label: () => m.cm_tab_honeypot(), icon: 'shield-alert' },
  ],

  '/command-access': [
    { id: 'doc', label: () => m.commands_tab_structure(), icon: 'Paper' },
    { id: 'permissions', label: () => m.commands_tab_permissions(), icon: 'Lock' },
  ],

  // ── Compte ────────────────────────────────────────────────────────────────
  '/profile': [
    { id: 'staff_overview', label: () => m.pf_tab_staff_overview(), icon: 'user' },
    { id: 'staff_activity', label: () => m.pf_tab_staff_activity(), icon: 'activity' },
    { id: 'community_overview', label: () => m.pf_tab_community(), icon: 'users' },
    { id: 'rank_card', label: () => m.pf_tab_rank_card(), icon: 'image' },
    { id: 'api_keys', label: () => m.pf_tab_api_keys(), icon: 'Key' },
  ],

  '/userSettings': [
    { id: 'preferences', label: () => m.us_tab_preferences(), icon: 'Gears' },
    { id: 'widget', label: () => m.us_tab_widget(), icon: 'Layout' },
  ],
};

/**
 * Onglets d'une page, prêts pour le composant `Tabs`.
 *
 * Les pages lisent leurs onglets ici plutôt que de les réécrire : la barre
 * affichée et la palette de commandes ne peuvent plus diverger. `visible`
 * retire les onglets qu'un rôle ne doit pas voir.
 */
export function pageTabItems(
  pageHref: string,
  visible: (id: string) => boolean = () => true,
): { id: string; label: string; icon?: string }[] {
  return (PAGE_TABS[pageHref] ?? [])
    .filter((tab) => visible(tab.id))
    .map((tab) => ({ id: tab.id, label: tab.label(), icon: tab.icon }));
}

/**
 * Certaines entrées de navigation pointent déjà sur un onglet précis
 * (`/staff-management/members`). Les proposer une seconde fois comme onglet
 * ferait doublon dans la palette.
 */
const PAGE_HREFS = new Set(allPages.map((page) => page.href.split('?')[0]));

export interface ResolvedPageTab extends PageTabConfig {
  /** URL complète de l'onglet. */
  href: string;
}

/**
 * Onglets d'une page, prêts à être proposés : ceux qui font doublon avec une
 * entrée de navigation existante sont écartés.
 */
export function tabsForPage(pageHref: string): ResolvedPageTab[] {
  const base = pageHref.split('?')[0];
  const tabs = PAGE_TABS[base];
  if (!tabs) return [];

  return tabs
    .map((tab) => ({ ...tab, href: `${base}/${tab.id}` }))
    .filter((tab) => !PAGE_HREFS.has(tab.href));
}
