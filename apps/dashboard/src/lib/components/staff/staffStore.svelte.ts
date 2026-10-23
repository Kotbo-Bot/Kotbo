/**
 * Etat partage de la gestion du staff.
 *
 * La page tenait tout dans un seul fichier de plus de 3 000 lignes : donnees,
 * appels et gabarit des huit onglets. Chaque onglet est maintenant un
 * composant, et ils lisent tous ce meme etat. Un avertissement donne depuis la
 * fiche d'un membre se voit donc aussitot dans l'annuaire et dans l'onglet
 * Avertissements, sans rechargement croise.
 */
import { authStore } from '../../stores/auth.svelte';
import { dashboardStore } from '../../stores/dashboard.svelte';
import { toast } from '../../stores/toast.svelte';
import { confirmDialog } from '../../stores/confirmDialog.svelte';
import { removeWithUndo } from '../../undoRemoval';
import {
  fetchGuildState,
  fetchDiscordChannels,
  fetchPolls,
  toggleTutorStatus,
  fetchStaffWarnings,
  updateStaffConfig,
  deleteStaffRole,
  updateStaffRole,
  fetchStaffHierarchies,
  createStaffHierarchy,
  updateStaffHierarchy,
  deleteStaffHierarchy,
  fetchHierarchySchema,
  importHierarchyRoleMembers,
  addMemberHierarchyGrade,
  removeMemberHierarchyGrade,
  fetchStaffServerChannels,
  dashboardFetch,
} from '../../api';
import type { StaffMember, StaffRole, StaffHierarchy } from '../../types';
import { m } from '../../i18n';
import { errorMessage } from '@kotbo/shared';

export type StaffTab = 'members' | 'roles' | 'organigramme' | 'warnings' | 'blacklist' | 'polls' | 'leadership' | 'permissions';
export const STAFF_TABS: StaffTab[] = ['members', 'roles', 'organigramme', 'warnings', 'blacklist', 'polls', 'leadership', 'permissions'];

export type StaffWarning = {
  id: string;
  staffUserId: string;
  staffDisplayName?: string | null;
  staffAvatarUrl?: string | null;
  reason: string;
  issuedByTag?: string | null;
  isActive: boolean;
  createdAt: string;
  expiresAt?: string | null;
};

export type LeadershipMetric = {
  staffUserId: string;
  avg30d: number;
  avg7d: number;
  progressionScore: number;
  hasInactivityAlert: boolean;
};

export type PollOption = { id: string; text: string };
export type PollVote = { id: string; optionId: string; weight?: number; userId?: string; staffMember?: { userId?: string } | null };
export type StaffPoll = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  closesAt?: string | null;
  createdAt?: string;
  author?: { username?: string | null; displayName?: string | null } | null;
  options: PollOption[];
  votes?: PollVote[];
};

export type DiscordOption = { id: string; name: string; color?: number | string | null };

export type StaffConfig = {
  baseStaffRoleId: string | null;
  testStaffRoleId: string | null;
  meetingAnnouncementChannelId: string | null;
  meetingVoiceChannelId: string | null;
  staffAnnouncementChannelId: string | null;
  warnsToDemote: number;
  warnsToBlacklist: number;
  blacklistPermanentByDefault: boolean;
  actionMode: 'auto' | 'validation';
  demoteRemoveAllRoles: boolean;
};

export type HierarchyPayload = {
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  discordRoleId: string | null;
  responsableUserId: string | null;
  parentHierarchyId: string | null;
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export function isPollClosed(poll: StaffPoll): boolean {
  return poll.status === 'CLOSED' || (!!poll.closesAt && new Date(poll.closesAt) < new Date());
}

export function staffName(member: Pick<StaffMember, 'displayName' | 'username' | 'userId'> | null | undefined): string {
  return member?.displayName || member?.username || m.sm_unknown_user();
}

/** Fenetres et fiche ouvertes : n'importe quel onglet peut les demander. */
export type StaffDialogs = {
  addMember: boolean;
  /** Avertir : `userId` vide laisse choisir le membre. */
  warn: { userId: string } | null;
  blacklist: { userId: string } | null;
  grades: string | null;
  settings: boolean;
};

class StaffStore {
  guildId = $state<string | null>(null);

  dialogs = $state<StaffDialogs>({ addMember: false, warn: null, blacklist: null, grades: null, settings: false });

  members = $state<StaffMember[]>([]);
  roles = $state<StaffRole[]>([]);
  hierarchies = $state<StaffHierarchy[]>([]);
  hierarchySchema = $state<any>(null);
  warnings = $state<StaffWarning[]>([]);
  polls = $state<StaffPoll[]>([]);
  leadership = $state<LeadershipMetric[]>([]);

  config = $state<StaffConfig>({
    baseStaffRoleId: null,
    testStaffRoleId: null,
    meetingAnnouncementChannelId: null,
    meetingVoiceChannelId: null,
    staffAnnouncementChannelId: null,
    warnsToDemote: 3,
    warnsToBlacklist: 5,
    blacklistPermanentByDefault: true,
    actionMode: 'validation',
    demoteRemoveAllRoles: true,
  });
  savingConfig = $state(false);
  savingRoleOrder = $state(false);

  discordRoles = $state<DiscordOption[]>([]);
  textChannels = $state<DiscordOption[]>([]);
  voiceChannels = $state<DiscordOption[]>([]);
  staffGuildName = $state<string | null>(null);
  staffGuildTextChannels = $state<DiscordOption[]>([]);
  staffGuildVoiceChannels = $state<DiscordOption[]>([]);

  loading = $state<Record<'members' | 'roles' | 'organigramme' | 'warnings' | 'polls' | 'leadership', boolean>>({
    members: true,
    roles: true,
    organigramme: true,
    warnings: true,
    polls: true,
    leadership: true,
  });

  /** Ressources deja chargees : un aller-retour entre onglets ne refait pas l'appel. */
  private loaded = new Set<string>();

  // ── Droits ──────────────────────────────────────────────

  get isAdmin(): boolean {
    return (authStore.guilds as any[]).find((g) => g.id === authStore.selectedGuildId)?.accessLevel === 'admin';
  }
  get directoryAccess(): Record<string, boolean> {
    return (dashboardStore.state.featureAccess as any)?.staff_directory || {};
  }
  get rolesAccess(): Record<string, boolean> {
    return (dashboardStore.state.featureAccess as any)?.staff_roles || {};
  }
  get canManageSettings(): boolean {
    return this.isAdmin || !!dashboardStore.state.access?.canManageSettings || !!this.directoryAccess.canConfigure || !!this.rolesAccess.canConfigure;
  }
  get canModerate(): boolean {
    return this.canManageSettings || !!this.directoryAccess.canModerate || !!this.rolesAccess.canModerate;
  }
  get canConfigureDirectory(): boolean {
    return this.isAdmin || !!this.directoryAccess.canConfigure;
  }
  get canConfigureRoles(): boolean {
    return this.isAdmin || !!this.rolesAccess.canConfigure;
  }

  // ── Vues derivees ───────────────────────────────────────

  /** Grades du plus haut au plus bas : l'ordre qui sert a promouvoir et retrograder. */
  orderedRoles = $derived.by(() =>
    [...this.roles].sort((left, right) => {
      const levelDelta = (right.level ?? 0) - (left.level ?? 0);
      if (levelDelta !== 0) return levelDelta;
      const sortDelta = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
      if (sortDelta !== 0) return sortDelta;
      return new Date(left.createdAt ?? 0).getTime() - new Date(right.createdAt ?? 0).getTime();
    }),
  );

  orderedHierarchies = $derived.by(() =>
    [...this.hierarchies].sort((left, right) => {
      const sortDelta = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
      if (sortDelta !== 0) return sortDelta;
      return new Date(left.createdAt ?? 0).getTime() - new Date(right.createdAt ?? 0).getTime();
    }),
  );

  activeMembers = $derived(this.members.filter((member) => !member.blacklistEntries?.length));
  blacklistedMembers = $derived(this.members.filter((member) => !!member.blacklistEntries?.length));
  openPolls = $derived(this.polls.filter((poll) => !isPollClosed(poll)));
  activeWarningCount = $derived(this.activeMembers.reduce((sum, member) => sum + (member.warnings?.length ?? 0), 0));
  inactiveCount = $derived(this.leadership.filter((metric) => metric.hasInactivityAlert).length);

  meetingTextOptions = $derived([
    ...this.textChannels.map((c) => ({ id: c.id, name: `#${c.name}` })),
    ...this.staffGuildTextChannels.map((c) => ({ id: c.id, name: `#${c.name} - Staff (${this.staffGuildName})` })),
  ]);
  meetingVoiceOptions = $derived([
    ...this.voiceChannels.map((c) => ({ id: c.id, name: c.name })),
    ...this.staffGuildVoiceChannels.map((c) => ({ id: c.id, name: `${c.name} - Staff (${this.staffGuildName})` })),
  ]);

  rolesInHierarchy(hierarchyId: string | null): StaffRole[] {
    return this.orderedRoles.filter((role) => (role.hierarchyId ?? null) === hierarchyId);
  }

  hierarchyById(id: string | null | undefined): StaffHierarchy | undefined {
    return id ? this.hierarchies.find((h) => h.id === id) : undefined;
  }

  roleByName(name: string | null | undefined): StaffRole | undefined {
    return name ? this.orderedRoles.find((role) => role.name === name) : undefined;
  }

  discordRoleName(id: string | null | undefined): string | null {
    if (!id) return null;
    return this.discordRoles.find((role) => role.id === id)?.name ?? id;
  }

  /** Couleur d'un grade : celle de son role Discord, a defaut celle de sa hierarchie. */
  gradeColor(grade: string | null | undefined): string | null {
    const role = this.roleByName(grade);
    if (!role) return null;
    return role.color || this.hierarchyById(role.hierarchyId)?.color || null;
  }

  gradeIndex(grade: string | null | undefined): number {
    return this.orderedRoles.findIndex((role) => role.name === grade);
  }

  canPromote(member: StaffMember): boolean {
    return this.gradeIndex(member.grade) > 0;
  }

  canDemote(member: StaffMember): boolean {
    const index = this.gradeIndex(member.grade);
    return index !== -1 && index < this.orderedRoles.length - 1;
  }

  metricFor(userId: string): LeadershipMetric | undefined {
    return this.leadership.find((metric) => metric.staffUserId === userId);
  }

  memberByUserId(userId: string): StaffMember | undefined {
    return this.members.find((member) => member.userId === userId);
  }

  membersWithGrade(grade: string): StaffMember[] {
    return this.activeMembers.filter((member) => member.grade === grade);
  }

  findDiscordRoleByQuery(query: string): DiscordOption | null {
    const normalized = normalizeText(query);
    if (!normalized) return null;
    return this.discordRoles.find((role) => role.id === query.trim() || normalizeText(role.name) === normalized) || null;
  }

  resolveGradeFromDiscordRoles(roleIds: string[]): string | null {
    if (!roleIds.length) return null;
    return this.orderedRoles.find((role) => role.discordRoleId && roleIds.includes(role.discordRoleId))?.name ?? null;
  }

  resolveMemberHierarchyDraft(member: StaffMember): { hierarchyId: string; grade: string } | null {
    const existing = member.hierarchyGrades?.find((entry) => entry.hierarchy?.enabled !== false) ?? member.hierarchyGrades?.[0];
    if (existing) return { hierarchyId: existing.hierarchyId, grade: existing.grade };
    const matched = this.orderedRoles.find((role) => role.hierarchyId && normalizeText(role.name) === normalizeText(member.grade));
    return matched?.hierarchyId ? { hierarchyId: matched.hierarchyId, grade: matched.name } : null;
  }

  // ── Consequences d'une suppression ──────────────────────
  // Ce qu'une suppression emporte, en chiffres connus de la page : on decide
  // en sachant combien de membres et de grades sont touches.

  hierarchyImpacts(hierarchy: StaffHierarchy): string[] {
    const impacts: string[] = [];
    const roles = this.rolesInHierarchy(hierarchy.id).length;
    if (roles > 0) impacts.push(m.sm_impact_hierarchy_roles({ n: roles }));
    const members = hierarchy.memberGrades?.length ?? 0;
    if (members > 0) impacts.push(m.sm_impact_hierarchy_members({ n: members }));
    const children = this.hierarchies.filter((h) => h.parentHierarchyId === hierarchy.id).length;
    if (children > 0) impacts.push(m.sm_impact_hierarchy_children({ n: children }));
    return impacts;
  }

  roleImpacts(role: StaffRole): string[] {
    const impacts: string[] = [];
    const holders = this.members.filter((member) => normalizeText(member.grade ?? '') === normalizeText(role.name)).length;
    if (holders > 0) impacts.push(m.sm_impact_role_members({ n: holders }));
    const hierarchy = this.hierarchyById(role.hierarchyId);
    if (hierarchy) impacts.push(m.sm_impact_role_hierarchy({ name: hierarchy.name }));
    return impacts;
  }

  memberImpacts(member: StaffMember): string[] {
    const impacts: string[] = [];
    if (member.grade) impacts.push(m.sm_impact_staff_grade({ grade: member.grade }));
    const ranked = this.hierarchies.filter((h) => h.memberGrades?.some((g) => g.staffMemberId === member.id)).length;
    if (ranked > 0) impacts.push(m.sm_impact_staff_hierarchies({ n: ranked }));
    return impacts;
  }

  // ── Chargement ──────────────────────────────────────────

  /** Remet l'etat a zero quand on change de serveur. */
  reset(guildId: string): void {
    this.guildId = guildId;
    this.loaded.clear();
    this.members = [];
    this.roles = [];
    this.hierarchies = [];
    this.hierarchySchema = null;
    this.warnings = [];
    this.polls = [];
    this.leadership = [];
    this.discordRoles = dashboardStore.state.discordRoles || [];
    this.textChannels = dashboardStore.state.discordChannels || [];
    this.voiceChannels = dashboardStore.state.discordVoiceChannels || [];
  }

  private async once(key: string, load: () => Promise<void>, force = false): Promise<void> {
    if (!force && this.loaded.has(key)) return;
    this.loaded.add(key);
    try {
      await load();
    } catch (err) {
      this.loaded.delete(key);
      console.error(`Chargement staff (${key}) :`, err);
    }
  }

  /**
   * Ce dont l'en-tete et l'annuaire ont besoin d'entree : les compteurs de
   * l'en-tete lisent les sondages et l'activite, qui restaient en squelette
   * tant qu'on n'avait pas ouvert leur onglet.
   */
  async loadInitial(tab: StaffTab): Promise<void> {
    await Promise.all([
      this.loadTab(tab),
      this.loadMembers(),
      this.loadRoles(),
      this.loadConfig(),
      this.loadHierarchies(),
      this.loadPolls(),
      this.loadLeadership(),
      this.loadDiscordLists(),
    ]);
  }

  async loadTab(tab: StaffTab, force = false): Promise<void> {
    switch (tab) {
      case 'members':
      case 'blacklist':
        await this.loadMembers(force);
        break;
      case 'roles':
        await Promise.all([this.loadRoles(force), this.loadHierarchies(force), this.loadMembers()]);
        break;
      case 'organigramme':
        await this.loadSchema(force);
        break;
      case 'warnings':
        await Promise.all([this.loadWarnings(force), this.loadMembers()]);
        break;
      case 'polls':
        await this.loadPolls(force);
        break;
      case 'leadership':
        await Promise.all([this.loadLeadership(force), this.loadMembers()]);
        break;
    }
  }

  loadMembers(force = false) {
    return this.once('members', async () => {
      if (!this.guildId) return;
      this.loading.members = true;
      try {
        const res = await dashboardFetch(`/staff/members`, { guildId: this.guildId });
        if (!res.ok) throw new Error(`Erreur API staff members (${res.status})`);
        const data = await res.json();
        this.members = data.members || [];
      } finally {
        this.loading.members = false;
      }
    }, force);
  }

  loadRoles(force = false) {
    return this.once('roles', async () => {
      if (!this.guildId) return;
      this.loading.roles = true;
      try {
        const res = await dashboardFetch(`/staff/roles`, { guildId: this.guildId });
        if (!res.ok) throw new Error(`Erreur API staff roles (${res.status})`);
        const data = await res.json();
        this.roles = data.roles || [];
      } finally {
        this.loading.roles = false;
      }
    }, force);
  }

  loadHierarchies(force = false) {
    return this.once('hierarchies', async () => {
      if (!this.guildId) return;
      const data = await fetchStaffHierarchies(this.guildId);
      this.hierarchies = data?.hierarchies || [];
    }, force);
  }

  loadSchema(force = false) {
    return this.once('schema', async () => {
      if (!this.guildId) return;
      this.loading.organigramme = true;
      try {
        this.hierarchySchema = await fetchHierarchySchema(this.guildId);
      } finally {
        this.loading.organigramme = false;
      }
    }, force);
  }

  loadWarnings(force = false) {
    return this.once('warnings', async () => {
      if (!this.guildId) return;
      this.loading.warnings = true;
      try {
        const data = await fetchStaffWarnings(this.guildId);
        this.warnings = data.warnings || [];
      } finally {
        this.loading.warnings = false;
      }
    }, force);
  }

  loadPolls(force = false) {
    return this.once('polls', async () => {
      if (!this.guildId) return;
      this.loading.polls = true;
      try {
        const data = await fetchPolls(this.guildId);
        this.polls = data.polls || [];
      } finally {
        this.loading.polls = false;
      }
    }, force);
  }

  loadLeadership(force = false) {
    return this.once('leadership', async () => {
      if (!this.guildId) return;
      this.loading.leadership = true;
      try {
        const res = await dashboardFetch(`/leadership`, { guildId: this.guildId });
        if (res.ok) {
          const data = await res.json();
          this.leadership = data.metrics || [];
        }
      } finally {
        this.loading.leadership = false;
      }
    }, force);
  }

  loadConfig(force = false) {
    return this.once('config', async () => {
      if (!this.guildId) return;
      const res = await dashboardFetch(`/staff/config`, { guildId: this.guildId });
      if (!res.ok) return;
      const data = await res.json();
      const cfg = data.config || {};
      const current = this.config;
      this.config = {
        baseStaffRoleId: cfg.baseStaffRoleId ?? null,
        testStaffRoleId: cfg.testStaffRoleId ?? null,
        meetingAnnouncementChannelId: cfg.meetingAnnouncementChannelId ?? null,
        meetingVoiceChannelId: cfg.meetingVoiceChannelId ?? null,
        staffAnnouncementChannelId: cfg.staffAnnouncementChannelId ?? null,
        warnsToDemote: Number.isFinite(Number(cfg.warnsToDemote)) ? Number(cfg.warnsToDemote) : current.warnsToDemote,
        warnsToBlacklist: Number.isFinite(Number(cfg.warnsToBlacklist)) ? Number(cfg.warnsToBlacklist) : current.warnsToBlacklist,
        blacklistPermanentByDefault: cfg.blacklistPermanentByDefault === undefined ? current.blacklistPermanentByDefault : !!cfg.blacklistPermanentByDefault,
        actionMode: cfg.actionMode === 'auto' ? 'auto' : 'validation',
        demoteRemoveAllRoles: cfg.demoteRemoveAllRoles === undefined ? current.demoteRemoveAllRoles : !!cfg.demoteRemoveAllRoles,
      };
    }, force);
  }

  /** Roles et salons Discord : ils ne servent qu'aux selecteurs, on ne les attend pas. */
  loadDiscordLists() {
    return this.once('discord', async () => {
      const guildId = this.guildId;
      if (!guildId) return;
      const state = await fetchGuildState(guildId);
      this.discordRoles = state?.discordRoles || [];
      this.textChannels = state?.discordChannels || [];
      this.voiceChannels = state?.discordVoiceChannels || [];
      // Serveur absent du cache Discord : les salons passent par l'adresse dediee.
      if (this.textChannels.length === 0 && this.voiceChannels.length === 0) {
        try {
          const data = await fetchDiscordChannels(guildId);
          if (data?.textChannels?.length > 0 || data?.voiceChannels?.length > 0) {
            this.textChannels = data.textChannels || [];
            this.voiceChannels = data.voiceChannels || [];
          }
        } catch {
          // Discord injoignable : les selecteurs restent vides.
        }
      }
      try {
        const linked = await fetchStaffServerChannels();
        if (linked?.staffGuildId) {
          this.staffGuildName = linked.staffGuildName ?? linked.staffGuildId;
          this.staffGuildTextChannels = linked.channels ?? [];
          this.staffGuildVoiceChannels = linked.voiceChannels ?? [];
        }
      } catch {
        // Pas de serveur staff lie.
      }
    });
  }

  refreshMembers() {
    return this.loadMembers(true);
  }

  // ── Configuration ───────────────────────────────────────

  async saveConfig(patch: Partial<StaffConfig> = {}): Promise<void> {
    if (!this.guildId) return;
    this.config = { ...this.config, ...patch };
    this.savingConfig = true;
    try {
      const ok = await updateStaffConfig({ ...this.config }, this.guildId);
      if (!ok) throw new Error('Erreur API');
      await dashboardStore.refresh();
    } catch (err) {
      console.error('Error saving staff config:', err);
      toast.error(m.common_error());
    } finally {
      this.savingConfig = false;
    }
  }

  // ── Membres ─────────────────────────────────────────────

  async addMember(input: { userId: string; grade: string; username: string; avatarUrl: string; createTestingPeriod: boolean }): Promise<boolean> {
    if (!this.guildId) return false;
    if (!input.userId.trim()) {
      toast.warning(m.sm_toast_select_member());
      return false;
    }
    try {
      const res = await dashboardFetch(`/staff/members`, {
        guildId: this.guildId,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...input, userId: input.userId.trim() }),
      });
      if (!res.ok) throw new Error('add');
      await this.refreshMembers();
      toast.success(m.sx_toast_member_added({ name: input.username || input.userId }));
      return true;
    } catch {
      toast.error(m.sm_err_member_add());
      return false;
    }
  }

  private async patchMember(userId: string, body: Record<string, unknown>): Promise<void> {
    const res = await dashboardFetch(`/staff/members/${userId}`, {
      guildId: this.guildId!,
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(m.common_error());
  }

  async shiftGrade(member: StaffMember, direction: 'up' | 'down'): Promise<void> {
    if (!this.guildId) return;
    const index = this.gradeIndex(member.grade);
    if (index === -1) {
      toast.warning(m.sm_toast_grade_not_found());
      return;
    }
    if (direction === 'up' && index <= 0) {
      toast.warning(m.sm_toast_grade_max());
      return;
    }
    if (direction === 'down' && index >= this.orderedRoles.length - 1) {
      toast.warning(m.sm_toast_grade_min());
      return;
    }
    const nextGrade = this.orderedRoles[direction === 'up' ? index - 1 : index + 1].name;
    try {
      await this.patchMember(member.userId, { grade: nextGrade });
      await this.refreshMembers();
      toast.success(
        direction === 'up'
          ? m.sx_toast_promoted({ name: staffName(member), grade: nextGrade })
          : m.sx_toast_demoted({ name: staffName(member), grade: nextGrade }),
      );
    } catch {
      toast.error(direction === 'up' ? m.sm_err_promote() : m.sm_err_demote());
    }
  }

  async toggleSuspension(member: StaffMember): Promise<void> {
    if (!this.guildId) return;
    const suspend = !member.suspendedAt;
    const confirmed = await confirmDialog.ask(
      suspend
        ? { title: m.sm_confirm_suspend_title(), description: m.sm_confirm_suspend_desc(), confirmLabel: m.sm_confirm_suspend_btn(), variant: 'warning' }
        : { title: m.sm_confirm_unsuspend_title(), description: m.sm_confirm_unsuspend_desc(), confirmLabel: m.sm_confirm_unsuspend_btn() },
    );
    if (!confirmed) return;
    try {
      await this.patchMember(member.userId, { action: suspend ? 'suspend' : 'unsuspend' });
      await this.refreshMembers();
    } catch {
      toast.error(suspend ? m.sm_err_suspend() : m.sm_err_unsuspend());
    }
  }

  async removeMember(member: StaffMember): Promise<boolean> {
    if (!this.guildId) return false;
    const confirmed = await confirmDialog.danger(
      m.sm_confirm_remove_staff_title(),
      '',
      m.sm_confirm_remove_staff_btn(),
      this.memberImpacts(member),
    );
    if (!confirmed) return false;
    try {
      await this.patchMember(member.userId, { action: 'remove' });
      await this.refreshMembers();
      return true;
    } catch {
      toast.error(m.sm_err_remove());
      return false;
    }
  }

  async toggleTutor(member: StaffMember): Promise<void> {
    if (!this.guildId) return;
    try {
      const ok = await toggleTutorStatus(member.userId, this.guildId);
      if (!ok) throw new Error(m.common_error());
      await this.refreshMembers();
    } catch {
      toast.error(m.sm_err_tutor_toggle());
    }
  }

  async addHierarchyGrade(userId: string, hierarchyId: string, grade: string): Promise<boolean> {
    if (!this.guildId) return false;
    try {
      await addMemberHierarchyGrade(userId, hierarchyId, grade, this.guildId);
      await this.refreshMembers();
      return true;
    } catch (err) {
      toast.error(errorMessage(err) || m.sm_err_grade_add());
      return false;
    }
  }

  async removeHierarchyGrade(userId: string, hierarchyId: string): Promise<void> {
    if (!this.guildId) return;
    if (!(await confirmDialog.danger(m.sm_confirm_remove_member_hierarchy_title(), '', m.sm_confirm_remove_btn()))) return;
    try {
      await removeMemberHierarchyGrade(userId, hierarchyId, this.guildId);
      await this.refreshMembers();
    } catch (err) {
      toast.error(errorMessage(err) || m.sm_err_remove());
    }
  }

  // ── Avertissements et liste noire ───────────────────────

  async issueWarning(input: { staffUserId: string; reason: string; expiresAt: string }): Promise<boolean> {
    if (!this.guildId || !input.staffUserId || !input.reason.trim()) return false;
    try {
      const res = await dashboardFetch(`/staff/warnings`, {
        guildId: this.guildId,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          staffUserId: input.staffUserId,
          reason: input.reason.trim(),
          expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
        }),
      });
      if (!res.ok) throw new Error(m.common_error());
      await Promise.all([this.refreshMembers(), this.loadWarnings(true)]);
      toast.success(m.sx_toast_warning_issued());
      return true;
    } catch {
      toast.error(m.sm_err_warn());
      return false;
    }
  }

  /** Une ligne a impact local : elle part tout de suite, avec « Annuler ». */
  deleteWarning(warning: StaffWarning): void {
    if (!this.guildId) return;
    const guildId = this.guildId;
    void removeWithUndo({
      get: () => this.warnings,
      set: (next) => (this.warnings = next),
      match: (w) => w.id === warning.id,
      message: m.sx_toast_warning_deleted(),
      commit: async () => {
        const res = await dashboardFetch(`/staff/warnings/${warning.id}`, { guildId, method: 'DELETE' });
        if (!res.ok) throw new Error(m.sm_err_warn_delete());
        await Promise.all([this.refreshMembers(), this.loadWarnings(true)]);
      },
    });
  }

  async blacklist(input: { staffUserId: string; reason: string; endDate: string }): Promise<boolean> {
    if (!this.guildId || !input.staffUserId || !input.reason.trim()) return false;
    try {
      const res = await dashboardFetch(`/staff/blacklist`, {
        guildId: this.guildId,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          staffUserId: input.staffUserId,
          reason: input.reason.trim(),
          endDate: input.endDate ? new Date(input.endDate).toISOString() : null,
        }),
      });
      if (!res.ok) throw new Error(m.common_error());
      await this.refreshMembers();
      return true;
    } catch {
      toast.error(m.sm_err_blacklist());
      return false;
    }
  }

  async liftBlacklist(member: StaffMember): Promise<void> {
    if (!this.guildId) return;
    if (!(await confirmDialog.ask({ title: m.sm_confirm_remove_blacklist_title(), confirmLabel: m.sm_confirm_remove_btn(), variant: 'warning' }))) return;
    try {
      const res = await dashboardFetch(`/staff/blacklist/${member.userId}`, { guildId: this.guildId, method: 'DELETE' });
      if (!res.ok) throw new Error(m.common_error());
      await this.refreshMembers();
    } catch {
      toast.error(m.sm_err_blacklist_remove());
    }
  }

  // ── Sondages ────────────────────────────────────────────

  async createPoll(input: { title: string; description: string; options: string[]; closesAt: string }): Promise<boolean> {
    if (!this.guildId || !input.title.trim()) return false;
    const options = input.options.map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) {
      toast.warning(m.sm_toast_poll_min_options());
      return false;
    }
    try {
      const res = await dashboardFetch(`/staff/polls`, {
        guildId: this.guildId,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: input.title.trim(), description: input.description, options, closesAt: input.closesAt || undefined }),
      });
      if (!res.ok) throw new Error('create');
      await this.loadPolls(true);
      return true;
    } catch {
      toast.error(m.sm_err_poll_create());
      return false;
    }
  }

  async vote(pollId: string, optionId: string): Promise<void> {
    if (!this.guildId) return;
    try {
      const res = await dashboardFetch(`/staff/polls/vote`, {
        guildId: this.guildId,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ pollId, optionId }),
      });
      if (!res.ok) throw new Error(m.common_error());
      await this.loadPolls(true);
    } catch {
      toast.error(m.sm_err_vote());
    }
  }

  async closePoll(pollId: string): Promise<void> {
    if (!this.guildId) return;
    const confirmed = await confirmDialog.ask({ title: m.sm_confirm_close_poll_title(), description: m.sm_confirm_close_poll_desc(), confirmLabel: m.sm_confirm_close_poll_btn(), variant: 'warning' });
    if (!confirmed) return;
    try {
      const res = await dashboardFetch(`/staff/polls/${pollId}/close`, { guildId: this.guildId, method: 'PATCH' });
      if (!res.ok) throw new Error(m.sm_err_poll_close());
      await this.loadPolls(true);
    } catch {
      toast.error(m.sm_err_poll_close());
    }
  }

  // ── Grades et poles ─────────────────────────────────────

  async createRole(input: { query: string; discordRoleId: string; hierarchyId: string; isResponsable: boolean; level: number }): Promise<boolean> {
    if (!this.guildId) return false;
    const name = input.query.trim();
    if (!name) return false;
    const existing = this.orderedRoles.find((role) => normalizeText(role.name) === normalizeText(name));
    if (existing) {
      toast.info(m.sx_toast_role_exists({ name: existing.name }));
      return false;
    }
    const discord = input.discordRoleId ? this.discordRoles.find((r) => r.id === input.discordRoleId) : this.findDiscordRoleByQuery(name);
    try {
      const res = await dashboardFetch(`/staff/roles`, {
        guildId: this.guildId,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: discord?.name || name,
          level: Number(input.level),
          discordRoleId: discord?.id,
          hierarchyId: input.hierarchyId || undefined,
          isResponsable: input.isResponsable,
        }),
      });
      if (!res.ok) throw new Error(m.common_error());
      await this.loadRoles(true);
      return true;
    } catch {
      toast.error(m.sm_err_role_create());
      return false;
    }
  }

  async updateRole(roleId: string, data: Partial<StaffRole> & Record<string, unknown>): Promise<boolean> {
    if (!this.guildId) return false;
    try {
      const ok = await updateStaffRole(roleId, data, this.guildId);
      if (!ok) throw new Error('update');
      toast.success(m.sm_toast_role_updated());
      await this.loadRoles(true);
      return true;
    } catch {
      toast.error(m.sm_err_role_update());
      return false;
    }
  }

  async deleteRole(role: StaffRole): Promise<void> {
    if (!this.guildId) return;
    if (!(await confirmDialog.danger(m.sm_confirm_delete_role_title({ name: role.name }), m.sm_confirm_delete_role_desc(), undefined, this.roleImpacts(role)))) return;
    try {
      const ok = await deleteStaffRole(role.id, this.guildId);
      if (ok) await this.loadRoles(true);
    } catch (err) {
      console.error('Erreur lors de la suppression du rôle:', err);
      toast.error(m.sm_err_delete_generic());
    }
  }



  /**
   * Deplace un grade : avant `beforeRoleId`, ou en bas de la hierarchie visee.
   *
   * L'ordre affiche, celui de la promotion, suit le poids (`level`) avant
   * `sortOrder`. Glisser un grade ne changeait que `sortOrder` : entre deux
   * grades de poids differents, il revenait aussitot a sa place. Le grade
   * deplace prend donc un poids entre ses nouveaux voisins ; s'il n'y a pas de
   * place entre eux, les poids sont reespaces de 10 en 10 dans le nouvel ordre.
   */
  async moveRole(roleId: string, target: { beforeRoleId?: string; hierarchyId: string | null }): Promise<void> {
    if (!this.guildId || roleId === target.beforeRoleId) return;
    const current = this.orderedRoles;
    const moved = current.find((role) => role.id === roleId);
    if (!moved) return;

    const rest = current.filter((role) => role.id !== roleId);
    let insertAt: number;
    if (target.beforeRoleId) {
      insertAt = rest.findIndex((role) => role.id === target.beforeRoleId);
      if (insertAt < 0) return;
    } else {
      // Bas de la hierarchie visee ; hierarchie vide : le grade garde son rang.
      let last = -1;
      rest.forEach((role, index) => {
        if ((role.hierarchyId ?? null) === target.hierarchyId) last = index;
      });
      insertAt = last >= 0 ? last + 1 : -1;
    }

    const hierarchyChanged = (moved.hierarchyId ?? null) !== target.hierarchyId;
    const levels = new Map<string, number>();

    if (insertAt >= 0) {
      const above = rest[insertAt - 1];
      const below = rest[insertAt];
      const hi = above ? above.level : (below ? below.level + 20 : moved.level);
      const lo = below ? below.level : Math.max(0, hi - 20);
      const order = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
      if (hi - lo >= 2) {
        levels.set(moved.id, Math.floor((hi + lo) / 2));
      } else {
        order.forEach((role, index) => {
          const level = (order.length - index) * 10;
          if (level !== role.level) levels.set(role.id, level);
        });
      }
      if (order.indexOf(moved) === current.indexOf(moved) && !hierarchyChanged) return;
    } else if (!hierarchyChanged) {
      return;
    }

    // Affichage immediat, puis enregistrement.
    this.roles = this.roles.map((role) => ({
      ...role,
      level: levels.get(role.id) ?? role.level,
      hierarchyId: role.id === roleId ? target.hierarchyId : role.hierarchyId,
    }));

    this.savingRoleOrder = true;
    try {
      const writes: Promise<boolean>[] = [];
      for (const [id, level] of levels) {
        const data: Record<string, unknown> = { level };
        if (id === roleId && hierarchyChanged) data.hierarchyId = target.hierarchyId;
        writes.push(updateStaffRole(id, data, this.guildId));
      }
      if (hierarchyChanged && !levels.has(roleId)) {
        writes.push(updateStaffRole(roleId, { hierarchyId: target.hierarchyId }, this.guildId));
      }
      const results = await Promise.all(writes);
      if (results.some((ok) => !ok)) throw new Error(m.sm_err_reorder());
      // `sortOrder` ne departage que les poids egaux, mais il suit l'ordre affiche.
      const res = await dashboardFetch(`/staff/roles/order`, {
        guildId: this.guildId,
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ orderedRoleIds: this.orderedRoles.map((role) => role.id) }),
      });
      if (!res.ok) throw new Error(m.sm_err_reorder());
    } catch (err) {
      console.error('Erreur réordonnancement rôles staff:', err);
      toast.error(m.sm_err_role_order_update());
    } finally {
      await this.loadRoles(true);
      this.savingRoleOrder = false;
    }
  }

  async saveHierarchy(payload: HierarchyPayload, editingId: string | null): Promise<boolean> {
    if (!this.guildId || !payload.name.trim()) return false;
    try {
      if (editingId) await updateStaffHierarchy(editingId, payload, this.guildId);
      else await createStaffHierarchy(payload, this.guildId);
      void Promise.allSettled([this.loadHierarchies(true), this.loadSchema(true)]);
      return true;
    } catch (err) {
      console.error("Erreur lors de l'enregistrement de la hiérarchie:", err);
      toast.error(m.sm_err_hierarchy_save());
      return false;
    }
  }

  async deleteHierarchy(hierarchy: StaffHierarchy): Promise<void> {
    if (!this.guildId) return;
    if (!(await confirmDialog.danger(m.sm_confirm_delete_hierarchy_title(), m.sm_confirm_delete_hierarchy_desc(), undefined, this.hierarchyImpacts(hierarchy)))) return;
    try {
      await deleteStaffHierarchy(hierarchy.id, this.guildId);
      await Promise.all([this.loadHierarchies(true), this.loadSchema(true), this.loadRoles(true)]);
    } catch {
      toast.error(m.sm_err_delete_generic());
    }
  }

  async importFromRole(hierarchyId: string, discordRoleId: string, grade: string): Promise<{ imported: number; skipped: number; total: number } | null> {
    if (!this.guildId) return null;
    try {
      const result = await importHierarchyRoleMembers(hierarchyId, discordRoleId, grade, this.guildId);
      await Promise.all([this.refreshMembers(), this.loadHierarchies(true), this.loadSchema(true)]);
      return result;
    } catch (err) {
      toast.error(errorMessage(err) || m.sm_err_import());
      return null;
    }
  }
}

export const staff = new StaffStore();
