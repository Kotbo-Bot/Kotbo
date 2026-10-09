// ─── Onboarding System (Notion-style) ───────────────────────────────────────
// Three layers:
//   1. Welcome modal   - shown once on first guild visit
//   2. Checklist        - floating panel tracking onboarding tasks
//   3. Page tips        - contextual cards on first page visit

import { m } from '../i18n';
import { DEMO_MODE } from '../demo/mode';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChecklistTask {
  id: string;
  title: string;
  description: string;
  icon: string;
  /** Route to navigate when clicking the task */
  route?: string;
  /** Auto-complete when user visits this route */
  autoCompleteRoute?: string;
}

export interface SetupTask {
  id: string;
  title: string;
  description: string;
  icon: string;
  route: string;
  autoCompleteRoute: string;
  /** true = must-do first, false = optional / à la carte */
  essential: boolean;
}

export type GuideTab = 'discover' | 'setup';

export interface OnboardingState {
  welcomeSeen: boolean;
  checklistDismissed: boolean;
  checklistMinimized: boolean;
  completedTasks: string[];
  completedSetupTasks: string[];
  activeTab: GuideTab;
  visitedPages: string[];
  startedAt: number;
  completedAt?: number;
}

// ─── Checklist Tasks ────────────────────────────────────────────────────────

export const checklistTasks: ChecklistTask[] = [
  {
    id: 'visit-overview',
    title: m.chk_visit_overview_title(),
    description: m.chk_visit_overview_desc(),
    icon: 'layout-grid',
    route: '/',
    autoCompleteRoute: '/',
  },
  {
    id: 'explore-modules',
    title: m.chk_explore_modules_title(),
    description: m.chk_explore_modules_desc(),
    icon: 'package',
    route: '/modules',
    autoCompleteRoute: '/modules',
  },
  {
    id: 'check-members',
    title: m.chk_check_members_title(),
    description: m.chk_check_members_desc(),
    icon: 'users',
    route: '/members',
    autoCompleteRoute: '/members',
  },
  {
    id: 'review-moderation',
    title: m.chk_review_moderation_title(),
    description: m.chk_review_moderation_desc(),
    icon: 'shield',
    route: '/security/sanctions',
    autoCompleteRoute: '/security/sanctions',
  },
  {
    id: 'setup-community',
    title: m.chk_setup_community_title(),
    description: m.chk_setup_community_desc(),
    icon: 'trophy',
    route: '/leveling',
    autoCompleteRoute: '/leveling',
  },
  {
    id: 'manage-staff',
    title: m.chk_manage_staff_title(),
    description: m.chk_manage_staff_desc(),
    icon: 'user-check',
    route: '/staff-management?tab=members',
    autoCompleteRoute: '/staff-management',
  },
  {
    id: 'configure-settings',
    title: m.chk_configure_settings_title(),
    description: m.chk_configure_settings_desc(),
    icon: 'settings',
    route: '/management',
    autoCompleteRoute: '/management',
  },
  {
    id: 'try-shortcuts',
    title: m.chk_try_shortcuts_title(),
    description: m.chk_try_shortcuts_desc(),
    icon: 'keyboard',
  },
];

// ─── Setup Guide Tasks (2nd tutorial) ───────────────────────────────────────
// Essential tasks first, then optional features

export const setupTasks: SetupTask[] = [
  // ── Essentiels (à faire en premier) ──
  {
    id: 'setup-regulation',
    title: m.stp_setup_regulation_title(),
    description: m.stp_setup_regulation_desc(),
    icon: 'book',
    route: '/regulation',
    autoCompleteRoute: '/regulation',
    essential: true,
  },
  {
    id: 'setup-hierarchy',
    title: m.stp_setup_hierarchy_title(),
    description: m.stp_setup_hierarchy_desc(),
    icon: 'shield',
    route: '/staff-management?tab=roles',
    autoCompleteRoute: '/staff-management',
    essential: true,
  },
  {
    id: 'setup-channels',
    title: m.stp_setup_channels_title(),
    description: m.stp_setup_channels_desc(),
    icon: 'hash',
    route: '/channels-management',
    autoCompleteRoute: '/channels-management',
    essential: true,
  },
  {
    id: 'setup-staff-members',
    title: m.stp_setup_staff_members_title(),
    description: m.stp_setup_staff_members_desc(),
    icon: 'user-check',
    route: '/staff-management?tab=members',
    autoCompleteRoute: '/staff-management',
    essential: true,
  },

  // ── Optionnels (personnalisation) ──
  {
    id: 'setup-automod',
    title: m.stp_setup_automod_title(),
    description: m.stp_setup_automod_desc(),
    icon: 'shield-alert',
    route: '/security/filters',
    autoCompleteRoute: '/security/filters',
    essential: false,
  },
  {
    id: 'setup-welcome',
    title: m.stp_setup_welcome_title(),
    description: m.stp_setup_welcome_desc(),
    icon: 'megaphone',
    route: '/announcement',
    autoCompleteRoute: '/announcement',
    essential: false,
  },
  {
    id: 'setup-leveling',
    title: m.stp_setup_leveling_title(),
    description: m.stp_setup_leveling_desc(),
    icon: 'trophy',
    route: '/leveling',
    autoCompleteRoute: '/leveling',
    essential: false,
  },
  {
    id: 'setup-economy',
    title: m.stp_setup_economy_title(),
    description: m.stp_setup_economy_desc(),
    icon: 'coins',
    route: '/economy',
    autoCompleteRoute: '/economy',
    essential: false,
  },
  {
    id: 'setup-tickets',
    title: m.stp_setup_tickets_title(),
    description: m.stp_setup_tickets_desc(),
    icon: 'message-square',
    route: '/tickets',
    autoCompleteRoute: '/tickets',
    essential: false,
  },
  {
    id: 'setup-reaction-roles',
    title: m.stp_setup_reaction_roles_title(),
    description: m.stp_setup_reaction_roles_desc(),
    icon: 'mouse-pointer',
    route: '/reaction-roles',
    autoCompleteRoute: '/reaction-roles',
    essential: false,
  },
  {
    id: 'setup-suggestions',
    title: m.stp_setup_suggestions_title(),
    description: m.stp_setup_suggestions_desc(),
    icon: 'thumbs-up',
    route: '/suggestions',
    autoCompleteRoute: '/suggestions',
    essential: false,
  },
  {
    id: 'setup-giveaways',
    title: m.stp_setup_giveaways_title(),
    description: m.stp_setup_giveaways_desc(),
    icon: 'sparkles',
    route: '/giveaways',
    autoCompleteRoute: '/giveaways',
    essential: false,
  },
  {
    id: 'setup-triggers',
    title: m.stp_setup_triggers_title(),
    description: m.stp_setup_triggers_desc(),
    icon: 'message-square',
    route: '/triggers',
    autoCompleteRoute: '/triggers',
    essential: false,
  },
  {
    id: 'setup-embeds',
    title: m.stp_setup_embeds_title(),
    description: m.stp_setup_embeds_desc(),
    icon: 'file-plus',
    route: '/embed-builder',
    autoCompleteRoute: '/embed-builder',
    essential: false,
  },
  {
    id: 'setup-logs',
    title: m.stp_setup_logs_title(),
    description: m.stp_setup_logs_desc(),
    icon: 'file-text',
    route: '/logs',
    autoCompleteRoute: '/logs',
    essential: false,
  },
  {
    id: 'setup-recruitment',
    title: m.stp_setup_recruitment_title(),
    description: m.stp_setup_recruitment_desc(),
    icon: 'user-plus',
    route: '/recruitment',
    autoCompleteRoute: '/recruitment',
    essential: false,
  },
  {
    id: 'setup-news',
    title: m.stp_setup_news_title(),
    description: m.stp_setup_news_desc(),
    icon: 'rss',
    route: '/news',
    autoCompleteRoute: '/news',
    essential: false,
  },
  {
    id: 'setup-fun',
    title: m.stp_setup_fun_title(),
    description: m.stp_setup_fun_desc(),
    icon: 'smile',
    route: '/fun',
    autoCompleteRoute: '/fun',
    essential: false,
  },
  {
    id: 'setup-social',
    title: m.stp_setup_social_title(),
    description: m.stp_setup_social_desc(),
    icon: 'share-2',
    route: '/social-networks',
    autoCompleteRoute: '/social-networks',
    essential: false,
  },
  {
    id: 'setup-schedules',
    title: m.stp_setup_schedules_title(),
    description: m.stp_setup_schedules_desc(),
    icon: 'calendar',
    route: '/schedules',
    autoCompleteRoute: '/schedules',
    essential: false,
  },
  {
    id: 'setup-backups',
    title: m.stp_setup_backups_title(),
    description: m.stp_setup_backups_desc(),
    icon: 'archive',
    route: '/backups',
    autoCompleteRoute: '/backups',
    essential: false,
  },
];

export const essentialSetupTasks = setupTasks.filter(t => t.essential);
export const optionalSetupTasks = setupTasks.filter(t => !t.essential);

// ─── Defaults & Storage ─────────────────────────────────────────────────────

const DEFAULT_STATE: OnboardingState = {
  welcomeSeen: false,
  checklistDismissed: false,
  checklistMinimized: true,
  completedTasks: [],
  completedSetupTasks: [],
  activeTab: 'discover',
  visitedPages: [],
  startedAt: 0,
};

const STORAGE_PREFIX = 'onboarding-';
const LEGACY_KEY = 'tutorial-progress';

const getStorageKey = (guildId: string) => `${STORAGE_PREFIX}${guildId}`;

function readState(guildId: string): OnboardingState {
  try {
    const raw = localStorage.getItem(getStorageKey(guildId));
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE, ...parsed };
    }

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed?.completed || parsed?.dismissed || parsed?.seen) {
        return {
          ...DEFAULT_STATE,
          welcomeSeen: true,
          checklistDismissed: true,
          completedTasks: checklistTasks.map(t => t.id),
          completedSetupTasks: setupTasks.map(t => t.id),
          visitedPages: [],
          startedAt: parsed.startedAt ?? Date.now(),
          completedAt: parsed.completedAt ?? Date.now(),
        };
      }
    }

    const legacyGuild = localStorage.getItem(`tutorial-${guildId}`);
    if (legacyGuild) {
      const parsed = JSON.parse(legacyGuild);
      if (parsed?.completed || parsed?.dismissed || parsed?.seen) {
        return {
          ...DEFAULT_STATE,
          welcomeSeen: true,
          checklistDismissed: true,
          completedTasks: checklistTasks.map(t => t.id),
          completedSetupTasks: setupTasks.map(t => t.id),
          visitedPages: [],
          startedAt: parsed.startedAt ?? Date.now(),
          completedAt: parsed.completedAt ?? Date.now(),
        };
      }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_STATE };
}

function writeState(guildId: string | null, state: OnboardingState) {
  if (!guildId) return;
  try {
    localStorage.setItem(getStorageKey(guildId), JSON.stringify(state));
  } catch {
    // ignore
  }
}

// ─── Reactive State ─────────────────────────────────────────────────────────

let guildId = $state<string | null>(null);
let state = $state<OnboardingState>({ ...DEFAULT_STATE });

// Welcome modal visibility
let showWelcome = $state(false);

// ─── Store ──────────────────────────────────────────────────────────────────

export const onboardingStore = {
  // ── Getters - Discover tab ──
  get initialized() { return guildId !== null; },
  get welcomeSeen() { return state.welcomeSeen; },
  get showWelcome() { return showWelcome; },
  get checklistDismissed() { return state.checklistDismissed; },
  get checklistMinimized() { return state.checklistMinimized; },
  get completedTasks() { return state.completedTasks; },
  get visitedPages() { return state.visitedPages; },
  get activeTab() { return state.activeTab; },

  get completedCount() {
    return state.completedTasks.length;
  },

  get totalTasks() {
    return checklistTasks.length;
  },

  get progress() {
    return checklistTasks.length === 0 ? 100 : Math.round((state.completedTasks.length / checklistTasks.length) * 100);
  },

  get allCompleted() {
    return state.completedTasks.length >= checklistTasks.length;
  },

  // ── Getters - Setup tab ──
  get completedSetupTasks() { return state.completedSetupTasks; },

  get completedSetupCount() {
    return state.completedSetupTasks.length;
  },

  get totalSetupTasks() {
    return setupTasks.length;
  },

  get essentialSetupCount() {
    return essentialSetupTasks.length;
  },

  get completedEssentialCount() {
    return essentialSetupTasks.filter(t => state.completedSetupTasks.includes(t.id)).length;
  },

  get setupProgress() {
    return setupTasks.length === 0 ? 100 : Math.round((state.completedSetupTasks.length / setupTasks.length) * 100);
  },

  get essentialsDone() {
    return essentialSetupTasks.every(t => state.completedSetupTasks.includes(t.id));
  },

  get allSetupCompleted() {
    return state.completedSetupTasks.length >= setupTasks.length;
  },

  // ── Getters - Combined ──
  get overallProgress() {
    const total = checklistTasks.length + setupTasks.length;
    const done = state.completedTasks.length + state.completedSetupTasks.length;
    return total === 0 ? 100 : Math.round((done / total) * 100);
  },

  get bothCompleted() {
    return this.allCompleted && this.allSetupCompleted;
  },

  isTaskCompleted(taskId: string): boolean {
    return state.completedTasks.includes(taskId);
  },

  isSetupTaskCompleted(taskId: string): boolean {
    return state.completedSetupTasks.includes(taskId);
  },

  isPageVisited(pageId: string): boolean {
    return state.visitedPages.includes(pageId);
  },

  // ── Actions ──

  initialize(newGuildId: string) {
    if (guildId === newGuildId) return;
    guildId = newGuildId;
    state = readState(newGuildId);

    if (!state.welcomeSeen && !state.startedAt) {
      // En démo, la visite guidée (DemoTour) tient ce rôle : deux accueils
      // empilés se masqueraient l'un l'autre.
      showWelcome = !DEMO_MODE;
      state.startedAt = Date.now();
      writeState(guildId, state);
    }
  },

  // Welcome
  dismissWelcome() {
    showWelcome = false;
    state.welcomeSeen = true;
    state.checklistMinimized = false;
    writeState(guildId, state);
  },

  // Checklist
  toggleChecklist() {
    state.checklistMinimized = !state.checklistMinimized;
    writeState(guildId, state);
  },

  expandChecklist() {
    state.checklistMinimized = false;
    writeState(guildId, state);
  },

  minimizeChecklist() {
    state.checklistMinimized = true;
    writeState(guildId, state);
  },

  dismissChecklist() {
    state.checklistDismissed = true;
    writeState(guildId, state);
  },

  setActiveTab(tab: GuideTab) {
    state.activeTab = tab;
    writeState(guildId, state);
  },

  completeTask(taskId: string) {
    if (state.completedTasks.includes(taskId)) return;
    state.completedTasks = [...state.completedTasks, taskId];

    if (state.completedTasks.length >= checklistTasks.length) {
      state.completedAt = Date.now();
    }

    writeState(guildId, state);
  },

  completeSetupTask(taskId: string) {
    if (state.completedSetupTasks.includes(taskId)) return;
    state.completedSetupTasks = [...state.completedSetupTasks, taskId];
    writeState(guildId, state);
  },

  // Page tips
  onPageVisit(path: string, _queryString: string = '') {
    // Auto-complete discover checklist tasks
    for (const task of checklistTasks) {
      if (!task.autoCompleteRoute) continue;
      if (path === task.autoCompleteRoute || path.startsWith(task.autoCompleteRoute + '/')) {
        this.completeTask(task.id);
      }
    }

    // Auto-complete setup tasks
    for (const task of setupTasks) {
      if (path === task.autoCompleteRoute || path.startsWith(task.autoCompleteRoute + '/')) {
        this.completeSetupTask(task.id);
      }
    }
  },

  // Complete reset
  reset() {
    state = {
      ...DEFAULT_STATE,
      startedAt: Date.now(),
    };
    showWelcome = true;
    writeState(guildId, state);
  },

  // Restart tutorial (from menu)
  restart() {
    state = {
      ...DEFAULT_STATE,
      welcomeSeen: false,
      startedAt: Date.now(),
    };
    showWelcome = true;
    writeState(guildId, state);
  },

  // Mark shortcut task as done (called from keyboard handler)
  markShortcutUsed() {
    this.completeTask('try-shortcuts');
  },
};

// Legacy exports for backward compat with MainLayout/Navbar references
export const tutorialStore = onboardingStore;
export const tutorialSteps = checklistTasks;
export function shouldShowTutorialForNewUser(guildId: string): boolean {
  const s = readState(guildId);
  return !s.welcomeSeen && !s.startedAt;
}
