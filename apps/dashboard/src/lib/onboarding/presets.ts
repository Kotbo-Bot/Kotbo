import { m } from '../i18n';
import { bot } from '../stores/botLocale.svelte';
/**
 * Les reponses toutes faites du parcours, decrites une fois.
 *
 * Ce fichier ne connait ni l'ordre des ecrans ni leur nombre : il ne porte que
 * la matiere qu'ils presentent - vocations, niveaux de moderation, articles de
 * reglement, motifs de ticket, couleurs, rythmes de progression. L'ordre vit
 * dans `steps.ts`, ce qu'on choisit de configurer dans `tracks.ts`.
 *
 * Rien ici n'est une page blanche. Personne ne redige huit articles de
 * reglement ni ne calibre une courbe d'XP le jour ou il decouvre un bot : on
 * part de quelque chose de deja juste, et c'est de l'avoir ajuste qui fait
 * qu'on le considere comme sien.
 */
import type { ServerTemplateSection, StaffRolePower } from '../api/serverTemplateTypes';

export type ServerKind = 'new' | 'existing';
export type ThemeKey = 'gaming' | 'communaute' | 'entraide' | 'creation';
export type ModerationLevel = 'light' | 'standard' | 'strict';
export type LevelRhythm = 'calm' | 'standard' | 'intense';

export type Theme = {
  key: ThemeKey;
  label: string;
  pitch: string;
  icon: string;
  /**
   * Sections de la maquette retenues. `access` et `staff` n'en sont jamais
   * absentes : la premiere porte le role Membre a qui tous les salons fermes
   * sont rouverts, la seconde le role sans lequel les salons du staff ne
   * seraient visibles que du bot.
   */
  sections: ServerTemplateSection[];
};

export const THEMES: Theme[] = [
  {
    key: 'communaute',
    get label() { return m.obp_th_community(); },
    get pitch() { return m.obp_th_community_pitch(); },
    icon: 'users',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'stats', 'text', 'fun', 'voice'],
  },
  {
    key: 'gaming',
    get label() { return m.obp_th_gaming(); },
    get pitch() { return m.obp_th_gaming_pitch(); },
    icon: 'trophy',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'stats', 'text', 'fun', 'bots', 'voice'],
  },
  {
    key: 'entraide',
    get label() { return m.obp_th_help(); },
    get pitch() { return m.obp_th_help_pitch(); },
    icon: 'help-circle',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'text'],
  },
  {
    key: 'creation',
    get label() { return m.obp_th_creative(); },
    get pitch() { return m.obp_th_creative_pitch(); },
    icon: 'sparkles',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'stats', 'text', 'fun', 'voice'],
  },
];

export const MODERATION_LEVELS: {
  key: ModerationLevel;
  label: string;
  pitch: string;
  detail: string;
  icon: string;
}[] = [
  {
    key: 'light',
    get label() { return m.obp_md_loose(); },
    get pitch() { return m.obp_md_loose_pitch(); },
    get detail() { return m.obp_md_loose_detail(); },
    icon: 'smile',
  },
  {
    key: 'standard',
    get label() { return m.obp_balanced(); },
    get pitch() { return m.obp_md_standard_pitch(); },
    get detail() { return m.obp_md_standard_detail(); },
    icon: 'shield',
  },
  {
    key: 'strict',
    get label() { return m.obp_md_strict(); },
    get pitch() { return m.obp_md_strict_pitch(); },
    get detail() { return m.obp_md_strict_detail(); },
    icon: 'lock',
  },
];

// ── Écran « langue » ─────────────────────────────────────────────────────────

/**
 * Une poignee de fuseaux, pas la liste complete.
 *
 * Le runtime du bot en connait plusieurs centaines et la page de reglages les
 * propose tous. Ici, un menu de six cents entrees serait une question a laquelle
 * personne ne repond : on montre les fuseaux qui couvrent la francophonie et
 * l'Europe, et le reglage complet reste dans le tableau de bord.
 */
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: 'Europe/Paris', get label() { return m.obp_tz_paris(); } },
  { value: 'Europe/London', get label() { return m.obp_tz_london(); } },
  { value: 'Africa/Casablanca', label: 'Casablanca, Rabat' },
  { value: 'Indian/Reunion', get label() { return m.obp_tz_reunion(); } },
  // Montréal, Québec, Toronto et New York partagent le même fuseau : une seule entrée.
  { value: 'America/Montreal', get label() { return m.obp_tz_montreal(); } },
  { value: 'UTC', get label() { return m.obp_tz_utc(); } },
];

// ── Écran « règlement » ──────────────────────────────────────────────────────

export type RulePreset = {
  key: string;
  emoji: string;
  title: string;
  description: string;
  /** Retenu d'office a l'ouverture de l'ecran. */
  byDefault: boolean;
};

/**
 * Un reglement pret a publier, qu'on ajuste plutot qu'on ne redige.
 *
 * Personne n'ecrit huit articles depuis une page blanche le jour ou il decouvre
 * un bot. Ceux-ci couvrent ce qu'on retrouve sur presque tous les serveurs ; ils
 * s'editent sur place, et c'est cette edition qui fait qu'on les considere comme
 * les siens.
 */
export const RULE_PRESETS: RulePreset[] = [
  {
    key: 'respect',
    emoji: '🤝',
    get title() { return m.bot_rule_respect_title({}, bot()); },
    get description() { return m.bot_rule_respect_desc({}, bot()); },
    byDefault: true,
  },
  {
    key: 'spam',
    emoji: '🔇',
    get title() { return m.bot_rule_spam_title({}, bot()); },
    get description() { return m.bot_rule_spam_desc({}, bot()); },
    byDefault: true,
  },
  {
    key: 'pub',
    emoji: '📢',
    get title() { return m.bot_rule_pub_title({}, bot()); },
    get description() { return m.bot_rule_pub_desc({}, bot()); },
    byDefault: true,
  },
  {
    key: 'nsfw',
    emoji: '🚫',
    get title() { return m.bot_rule_nsfw_title({}, bot()); },
    get description() { return m.bot_rule_nsfw_desc({}, bot()); },
    byDefault: true,
  },
  {
    key: 'channels',
    emoji: '🗂️',
    get title() { return m.bot_rule_channels_title({}, bot()); },
    get description() { return m.bot_rule_channels_desc({}, bot()); },
    byDefault: true,
  },
  {
    key: 'privacy',
    emoji: '🔒',
    get title() { return m.bot_rule_privacy_title({}, bot()); },
    get description() { return m.bot_rule_privacy_desc({}, bot()); },
    byDefault: false,
  },
  {
    key: 'staff',
    emoji: '🛡️',
    get title() { return m.bot_rule_staff_title({}, bot()); },
    get description() { return m.bot_rule_staff_desc({}, bot()); },
    byDefault: false,
  },
  {
    key: 'discord-tos',
    emoji: '📜',
    get title() { return m.bot_rule_tos_title({}, bot()); },
    get description() { return m.bot_rule_tos_desc({}, bot()); },
    byDefault: false,
  },
];

// ── Écran « support » ────────────────────────────────────────────────────────

export type TicketPreset = {
  key: string;
  emoji: string;
  label: string;
  description: string;
  /** Vocations pour lesquelles ce motif est coche d'office. */
  themes: ThemeKey[];
};

/**
 * Les motifs d'ouverture proposes sur le panneau de tickets.
 *
 * Coches d'apres la vocation deja choisie : un serveur d'entraide n'a pas les
 * memes demandes qu'un serveur de creation, et re-poser la question serait
 * demander deux fois la meme chose.
 */
export const TICKET_PRESETS: TicketPreset[] = [
  {
    key: 'question',
    emoji: '❓',
    get label() { return m.bot_ticket_question({}, bot()); },
    get description() { return m.bot_ticket_question_desc({}, bot()); },
    themes: ['communaute', 'gaming', 'entraide', 'creation'],
  },
  {
    key: 'help',
    emoji: '🆘',
    get label() { return m.bot_ticket_help({}, bot()); },
    get description() { return m.bot_ticket_help_desc({}, bot()); },
    themes: ['entraide'],
  },
  {
    key: 'report',
    emoji: '⚠️',
    get label() { return m.bot_ticket_report({}, bot()); },
    get description() { return m.bot_ticket_report_desc({}, bot()); },
    themes: ['communaute', 'gaming', 'entraide', 'creation'],
  },
  {
    key: 'bug',
    emoji: '🐛',
    get label() { return m.bot_ticket_bug({}, bot()); },
    get description() { return m.bot_ticket_bug_desc({}, bot()); },
    themes: ['entraide', 'gaming'],
  },
  {
    key: 'apply',
    emoji: '📝',
    get label() { return m.bot_ticket_apply({}, bot()); },
    get description() { return m.bot_ticket_apply_desc({}, bot()); },
    themes: ['communaute', 'gaming'],
  },
  {
    key: 'partner',
    emoji: '🤝',
    get label() { return m.bot_ticket_partner({}, bot()); },
    get description() { return m.bot_ticket_partner_desc({}, bot()); },
    themes: ['communaute', 'creation'],
  },
  {
    key: 'feedback',
    emoji: '💡',
    get label() { return m.bot_ticket_feedback({}, bot()); },
    get description() { return m.bot_ticket_feedback_desc({}, bot()); },
    themes: ['creation'],
  },
];

export function defaultTicketKeys(theme: ThemeKey): string[] {
  return TICKET_PRESETS.filter((entry) => entry.themes.includes(theme)).map((entry) => entry.key);
}

/**
 * La couleur des panneaux que le bot publie.
 *
 * Discord ne connait pas de couleur d'accent de serveur : cette teinte est
 * celle des embeds que Kotbo poste - panneau de tickets d'abord. C'est le seul
 * reglage du parcours qui ne change rien au fonctionnement, et c'est aussi
 * celui qu'on ouvre en premier : choisir une couleur, c'est commencer a
 * s'approprier ce qu'on installe.
 */
export const PANEL_COLORS: { value: string; label: string }[] = [
  { value: '#5865F2', label: 'Discord' },
  { value: '#00E5FF', label: 'Kotbo' },
  { value: '#10B981', get label() { return m.obp_col_emerald(); } },
  { value: '#F59E0B', get label() { return m.obp_col_amber(); } },
  { value: '#EF4444', get label() { return m.obp_col_red(); } },
  { value: '#EC4899', get label() { return m.obp_col_pink(); } },
  { value: '#8B5CF6', get label() { return m.obp_col_violet(); } },
  { value: '#64748B', get label() { return m.obp_col_slate(); } },
];

// ── Écran « progression » ────────────────────────────────────────────────────

/**
 * Le rythme des niveaux, en trois reglages plutot qu'en six curseurs.
 *
 * La page Niveaux du tableau de bord expose l'XP par message, le palier vocal,
 * le delai anti-farm et la courbe. Ici, on choisit une allure : le detail se
 * regle apres, quand on a vu tourner le systeme et qu'on sait ce qu'on veut
 * corriger.
 */
export const LEVEL_RHYTHMS: {
  key: LevelRhythm;
  label: string;
  pitch: string;
  detail: string;
  icon: string;
  config: { xpMin: number; xpMax: number; cooldownSeconds: number; vocalXpPerMin: number };
}[] = [
  {
    key: 'calm',
    get label() { return m.obp_rh_slow(); },
    get pitch() { return m.obp_rh_slow_pitch(); },
    get detail() { return m.obp_rh_slow_detail(); },
    icon: 'smile',
    config: { xpMin: 5, xpMax: 10, cooldownSeconds: 90, vocalXpPerMin: 2 },
  },
  {
    key: 'standard',
    get label() { return m.obp_balanced(); },
    get pitch() { return m.obp_rh_standard_pitch(); },
    get detail() { return m.obp_rh_standard_detail(); },
    icon: 'sliders-horizontal',
    config: { xpMin: 15, xpMax: 25, cooldownSeconds: 60, vocalXpPerMin: 5 },
  },
  {
    key: 'intense',
    get label() { return m.obp_rh_fast(); },
    get pitch() { return m.obp_rh_fast_pitch(); },
    get detail() { return m.obp_rh_fast_detail(); },
    icon: 'zap',
    config: { xpMin: 25, xpMax: 40, cooldownSeconds: 30, vocalXpPerMin: 10 },
  },
];

/** Les paliers proposes quand on rattache des roles existants. */
export const REWARD_TIERS = [5, 15, 30] as const;

