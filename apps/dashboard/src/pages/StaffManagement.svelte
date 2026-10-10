<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, Button } from '../lib/components/ui';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { fetchMemberCase, fetchGuildState, fetchDiscordChannels, fetchPolls, toggleTutorStatus, fetchStaffWarnings, fetchFeatureConfigurations, updateStaffConfig, deleteStaffRole, updateStaffRole, fetchStaffHierarchies, createStaffHierarchy, updateStaffHierarchy, deleteStaffHierarchy, fetchHierarchySchema, importHierarchyRoleMembers, addMemberHierarchyGrade, removeMemberHierarchyGrade, fetchStaffServerChannels, dashboardFetch } from '../lib/api';
  import DiscordMemberLookup from '../lib/components/DiscordMemberLookup.svelte';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import type { StaffMember, StaffRole, StaffHierarchy } from '../lib/types';
  import Papicon from '../lib/components/Papicon.svelte';
  import Chart from '../lib/components/charts/Chart.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import OrgChart from '../lib/components/OrgChart.svelte';
  import EmojiPicker from '../lib/components/EmojiPicker.svelte';
  import { m } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  let guildId = $state<string | null>(null);
  let accessLevel = $state('none');
  let error = $state('');
  
  type StaffTab = 'members' | 'roles' | 'warnings' | 'blacklist' | 'polls' | 'leadership' | 'permissions' | 'organigramme';
  const staffTabs: StaffTab[] = ['members', 'roles', 'organigramme', 'warnings', 'blacklist', 'polls', 'leadership', 'permissions'];

  function isStaffTab(value: string | null | undefined): value is StaffTab {
    return !!value && staffTabs.includes(value as StaffTab);
  }

  let activeTab = $state<StaffTab>('members');

  // États de chargement par catégorie
  const loadingStates = $state<Record<string, boolean>>({
    members: true,
    roles: true,
    organigramme: true,
    warnings: false,
    blacklist: false,
    polls: true,
    leadership: true
  });

  $effect(() => {
    const _path = $router.path;
    // L'onglet Tutorat a ete fondu dans la page du meme nom.
    if (_path.startsWith('/staff-management/tutoring')) {
      router.goto('/tutoring');
      return;
    }
    const tab = resolveTabFromUrl('/staff-management', staffTabs, 'members');
    if (isStaffTab(tab) && tab !== activeTab) {
      activeTab = tab;
      void loadTabData(tab);
    }
  });

  function switchTab(tab: StaffTab) {
    gotoTab('/staff-management', tab, 'members');
    void loadTabData(tab);
  }

  // Data
  let staffMembers = $state<StaffMember[]>([]);
  let staffRoles = $state<StaffRole[]>([]);
  let staffWarnings = $state<any[]>([]);
  let polls = $state<any[]>([]);
  let leadershipMetrics = $state<any[]>([]);

  const progressionChartData = $derived({
    labels: leadershipMetrics.map(lm => staffMembers.find(sm => sm.userId === lm.staffUserId)?.username || lm.staffUserId),
    datasets: [{
      label: m.sm_chart_label_progression_score(),
      data: leadershipMetrics.map(lm => lm.progressionScore),
      backgroundColor: 'rgba(99, 102, 241, 0.5)',
      borderColor: 'rgb(99, 102, 241)',
      borderWidth: 1,
      borderRadius: 8
    }]
  });

  const activityChartData = $derived({
    labels: leadershipMetrics.map(lm => staffMembers.find(sm => sm.userId === lm.staffUserId)?.username || lm.staffUserId),
    datasets: [
      {
        label: m.sm_chart_label_avg30(),
        data: leadershipMetrics.map(lm => lm.avg30d),
        backgroundColor: 'rgba(107, 114, 128, 0.4)',
        borderRadius: 6
      },
      {
        label: m.sm_chart_label_avg7(),
        data: leadershipMetrics.map(lm => lm.avg7d),
        backgroundColor: 'rgba(99, 102, 241, 0.8)',
        borderRadius: 6
      }
    ]
  });
  let availableDiscordRoles = $state<any[]>(dashboardStore.state.discordRoles || []);
  let availableDiscordChannels = $state<any[]>(dashboardStore.state.discordChannels || []);
  let availableDiscordVoiceChannels = $state<any[]>(dashboardStore.state.discordVoiceChannels || []);

  // Salons du serveur staff lié (pickers cross-serveur)
  let staffGuildName = $state<string | null>(null);
  let staffGuildTextChannels = $state<any[]>([]);
  let staffGuildVoiceChannels = $state<any[]>([]);

  async function loadStaffServerChannels() {
    try {
      const data = await fetchStaffServerChannels();
      if (data?.staffGuildId) {
        staffGuildName = data.staffGuildName ?? data.staffGuildId;
        staffGuildTextChannels = data.channels ?? [];
        staffGuildVoiceChannels = data.voiceChannels ?? [];
      }
    } catch {
      // pas de lien staff
    }
  }

  const meetingAnnouncementChannelOptions = $derived([
    ...availableDiscordChannels.map((dc: any) => ({ id: dc.id, name: `#${dc.name}` })),
    ...staffGuildTextChannels.map((dc: any) => ({ id: dc.id, name: `#${dc.name} - Staff (${staffGuildName})` })),
  ]);
  const meetingVoiceChannelOptions = $derived([
    ...availableDiscordVoiceChannels.map((vc: any) => ({ id: vc.id, name: vc.name })),
    ...staffGuildVoiceChannels.map((vc: any) => ({ id: vc.id, name: `${vc.name} - Staff (${staffGuildName})` })),
  ]);
  let loadingFeatureConfigs = $state(false);
  let featureConfigs = $state<any[]>([]);

  // Hiérarchies multiples
  let hierarchies = $state<StaffHierarchy[]>([]);
  let hierarchySchema = $state<any>(null);
  let showAddHierarchyForm = $state(false);
  let editingHierarchy = $state<StaffHierarchy | null>(null);

  // Modal forms states (hiérarchies)
  let newHierarchyName = $state('');
  let newHierarchyDescription = $state('');
  let newHierarchyColor = $state('#3b82f6');
  let newHierarchyIcon = $state('🔵');
  let newHierarchyDiscordRoleId = $state('');
  let newHierarchyResponsableUserId = $state('');
  let newHierarchyParentId = $state('');
  let isSavingHierarchy = $state(false);

  // Import modal
  let showImportModal = $state(false);
  let importHierarchyTarget = $state<StaffHierarchy | null>(null);
  let importDiscordRoleId = $state('');
  let importGradeName = $state('');
  let isImporting = $state(false);
  let importResult = $state<{ imported: number; skipped: number; total: number } | null>(null);

  // Member Hierarchy Grade modal
  let showMemberHierarchyGradeForm = $state(false);
  let memberHierarchyGradeTarget = $state<StaffMember | null>(null);
  let selectedMemberHierarchyId = $state('');
  let selectedMemberHierarchyGrade = $state('');
  let isSavingMemberHierarchyGrade = $state(false);

  // Checklists de tutorat (par hiérarchie / grade)

  const isAdmin = $derived(((authStore.guilds as any[]).find(g => g.id === authStore.selectedGuildId))?.accessLevel === 'admin');
  const directoryAccess = $derived((dashboardStore.state.featureAccess as any)?.staff_directory || {});
  const rolesAccess = $derived((dashboardStore.state.featureAccess as any)?.staff_roles || {});
  
  const canManageSettings = $derived(isAdmin || !!dashboardStore.state.access?.canManageSettings || !!directoryAccess.canConfigure || !!rolesAccess.canConfigure);
  const canModerate = $derived(canManageSettings || !!directoryAccess.canModerate || !!rolesAccess.canModerate);
  const staffTabVisible = $derived<Record<StaffTab, boolean>>({
    members: !!directoryAccess.canView,
    roles: !!rolesAccess.canView,
    organigramme: !!directoryAccess.canView,
    warnings: canModerate,
    blacklist: canModerate,
    polls: canModerate,
    leadership: canModerate,
    permissions: canManageSettings,
  });


  const activeStaffMembers = $derived(staffMembers.filter(sm => !sm.blacklistEntries || sm.blacklistEntries.length === 0));
  const blacklistedStaffMembers = $derived(staffMembers.filter(sm => sm.blacklistEntries && sm.blacklistEntries.length > 0));

  // Forms
  let showAddMemberForm = $state(false);
  let addMemberLookupQuery = $state('');
  let newMemberUserId = $state('');
  let newMemberGrade = $state('');
  let newMemberUsername = $state('');
  let newMemberAvatarUrl = $state('');
  let newMemberRoleIds = $state<string[]>([]);
  let newMemberCreateTutoring = $state(true);

  let showAddRoleForm = $state(false);
  let newRoleName = $state('');
  let roleSearchQuery = $state('');
  let selectedDiscordRoleId = $state('');
  let roleSuggestionsOpen = $state(false);
  let isSavingRoleOrder = $state(false);
  let draggedRoleId = $state<string | null>(null);
  let roleDropTargetId = $state<string | null>(null);
  let containerDragOverId = $state<string | null>(null);
  let newRoleHierarchyId = $state('');
  let newRoleIsResponsable = $state(false);
  let newRoleLevel = $state(100);

  // Edit Role Modal state
  let showEditRoleModal = $state(false);
  let editingRole = $state<StaffRole | null>(null);
  let editRoleName = $state('');
  let editRoleLevel = $state(100);
  let editRoleColor = $state('');
  let editRoleDiscordRoleId = $state('');
  let editRoleHierarchyId = $state('');
  let editRoleIsResponsable = $state(false);

  let showWarnForm = $state(false);
  let warnLookupQuery = $state('');
  let warnTargetUserId = $state('');
  let warnReason = $state('');
  let warnExpiresAt = $state('');

  let showBlacklistForm = $state(false);
  let blacklistLookupQuery = $state('');
  let blacklistTargetUserId = $state('');
  let blacklistReason = $state('');
  let blacklistEndDate = $state('');

  // Polls
  let showPollForm = $state(false);
  let newPollTitle = $state('');
  let newPollDescription = $state('');
  let newPollOptions = $state<string[]>(['', '']);
  let newPollClosesAt = $state('');
  let isSavingPoll = $state(false);
  
  let baseStaffRoleId = $state<string | null>(null);
  let testStaffRoleId = $state<string | null>(null);
  let meetingAnnouncementChannelId = $state<string | null>(null);
  let meetingVoiceChannelId = $state<string | null>(null);
  let staffAnnouncementChannelId = $state<string | null>(null);
  
  let warnsToDemote = $state<number>(3);
  let warnsToBlacklist = $state<number>(5);
  let blacklistPermanentByDefault = $state<boolean>(true);
  let actionMode = $state<'auto' | 'validation'>('validation');
  let demoteRemoveAllRoles = $state<boolean>(true);
  
  let isSavingConfig = $state(false);
  let showConfigMenu = $state(false);
  
  // Member Case Modal State
  let caseModalOpen = $state(false);
  let caseSelectedUserId = $state<string | null>(null);
  let caseSelectedUserName = $state('');
  let caseData = $state<any>(null);
  let caseLoading = $state(false);
  let caseError = $state('');

  /**
   * Le dossier membre appartient a la section Membres, ici comme ailleurs.
   */
  const canOpenMemberCase = $derived(canViewFeature('members'));

  async function openMemberCase(userId: string, userName: string) {
    if (!guildId || !userId || !canOpenMemberCase) return;

    caseSelectedUserId = userId;
    caseSelectedUserName = userName;
    caseModalOpen = true;
    caseLoading = true;
    caseError = '';
    caseData = null;

    // L'adresse appelee ici etait `staff/member-case/:id`, qui n'existe pas
    // cote bot : la fenetre s'ouvrait sur « Impossible de charger le dossier ».
    // Le dossier vit sur la route des membres, celle que les onze autres pages
    // utilisent deja.
    try {
      caseData = await fetchMemberCase(userId, guildId);
    } catch (err) {
      caseError = errorMessage(err) ?? 'Impossible de charger le dossier';
    } finally {
      caseLoading = false;
    }
  }

  $effect(() => {
    if (!newMemberGrade && orderedStaffRoles.length > 0) {
      newMemberGrade = orderedStaffRoles[0].name;
    }
  });
  function normalizeText(value: string): string {
    return value.trim().toLowerCase();
  }

  function resolveGradeFromDiscordRoles(roleIds: string[]): string | null {
    if (!roleIds.length) return null;

    const matchingRole = getOrderedStaffRoles()
      .find((role) => role.discordRoleId && roleIds.includes(role.discordRoleId));

    return matchingRole?.name ?? null;
  }

  function resolveMemberHierarchyDraft(member: StaffMember): { hierarchyId: string; grade: string } | null {
    const existingHierarchyGrade = member.hierarchyGrades?.find((entry) => entry.hierarchy?.enabled !== false) ?? member.hierarchyGrades?.[0];
    if (existingHierarchyGrade) {
      return {
        hierarchyId: existingHierarchyGrade.hierarchyId,
        grade: existingHierarchyGrade.grade,
      };
    }

    const matchedStaffRole = getOrderedStaffRoles().find(
      (role) => role.hierarchyId && normalizeText(role.name) === normalizeText(member.grade)
    );

    if (matchedStaffRole?.hierarchyId) {
      return {
        hierarchyId: matchedStaffRole.hierarchyId,
        grade: matchedStaffRole.name,
      };
    }

    return null;
  }

  $effect(() => {
    const autoGrade = resolveGradeFromDiscordRoles(newMemberRoleIds);
    if (autoGrade) {
      newMemberGrade = autoGrade;
    }
  });

  function getOrderedStaffRoles() {
    return [...staffRoles].sort((left, right) => {
      const levelDelta = (right.level ?? 0) - (left.level ?? 0);
      if (levelDelta !== 0) return levelDelta;

      const sortDelta = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
      if (sortDelta !== 0) return sortDelta;

      return new Date(left.createdAt ?? 0).getTime() - new Date(right.createdAt ?? 0).getTime();
    });
  }

  function getOrderedHierarchies() {
    return [...hierarchies].sort((left, right) => {
      const sortDelta = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
      if (sortDelta !== 0) return sortDelta;

      return new Date(left.createdAt ?? 0).getTime() - new Date(right.createdAt ?? 0).getTime();
    });
  }

  function getRolesInHierarchy(hierarchyId: string | null) {
    return getOrderedStaffRoles().filter((role) => (role.hierarchyId ?? null) === hierarchyId);
  }

  const orderedStaffRoles = $derived(getOrderedStaffRoles());
  const unlinkedRoles = $derived(getOrderedStaffRoles().filter((r) => !r.hierarchyId));

  const roleSuggestions = $derived(
    (() => {
      const query = normalizeText(roleSearchQuery);
      if (!query) {
        return availableDiscordRoles.slice(0, 8);
      }

      return availableDiscordRoles
        .filter((role) => normalizeText(role.name).includes(query) || role.id.includes(query))
        .slice(0, 8);
    })()
  );

  function findDiscordRoleByQuery(query: string) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) {
      return null;
    }

    return availableDiscordRoles.find((role) => role.id === query.trim() || normalizeText(role.name) === normalizedQuery) || null;
  }

  function handleRoleSearchInput(value: string): void {
    roleSearchQuery = value;
    const matchedRole = findDiscordRoleByQuery(value);
    selectedDiscordRoleId = matchedRole?.id ?? '';
    roleSuggestionsOpen = true;
  }

  function selectRoleSuggestion(role: { id: string; name: string }): void {
    roleSearchQuery = role.name;
    selectedDiscordRoleId = role.id;
    roleSuggestionsOpen = false;
  }

  function startRoleDrag(roleId: string): void {
    draggedRoleId = roleId;
    roleDropTargetId = roleId;
  }

  function clearRoleDragState(): void {
    draggedRoleId = null;
    roleDropTargetId = null;
    containerDragOverId = null;
  }

  async function updateRoleHierarchyOnServer(roleId: string, hierarchyId: string | null) {
    if (!guildId || !authStore.token) return;
    const ok = await updateStaffRole(roleId, { hierarchyId }, guildId);
    if (!ok) {
      throw new Error(m.sm_err_role_hierarchy_update());
    }
  }

  async function moveRoleToHierarchy(sourceRoleId: string, targetHierarchyId: string | null) {
    const nextRoles = getOrderedStaffRoles();
    const sourceRole = nextRoles.find((role) => role.id === sourceRoleId);
    if (!sourceRole) return;

    const currentHierarchyId = sourceRole.hierarchyId ?? null;
    if (currentHierarchyId === targetHierarchyId) return;

    const sourceIndex = nextRoles.findIndex((role) => role.id === sourceRoleId);
    if (sourceIndex >= 0) {
      const [movedRole] = nextRoles.splice(sourceIndex, 1);

      movedRole.hierarchyId = targetHierarchyId;

      let targetIndex = -1;
      if (targetHierarchyId) {
        for (let i = nextRoles.length - 1; i >= 0; i--) {
          if (nextRoles[i].hierarchyId === targetHierarchyId) {
            targetIndex = i;
            break;
          }
        }
      } else {
        for (let i = nextRoles.length - 1; i >= 0; i--) {
          if (!nextRoles[i].hierarchyId) {
            targetIndex = i;
            break;
          }
        }
      }

      if (targetIndex >= 0) {
        nextRoles.splice(targetIndex + 1, 0, movedRole);
      } else {
        nextRoles.push(movedRole);
      }
    }

    try {
      await updateRoleHierarchyOnServer(sourceRoleId, targetHierarchyId);
      await saveStaffRoleOrder(nextRoles.map((role) => role.id));

      staffRoles = nextRoles.map((role, index) => ({ ...role, sortOrder: index }));
    } catch (err) {
      console.error("Erreur lors de la mise à jour de la hiérarchie du rôle:", err);
      toast.error(m.sm_err_hierarchy_update_prefix() + (err instanceof Error ? err.message : String(err)));
      await loadStaffRoles();
    }
  }

  async function moveRoleInList(sourceRoleId: string, targetRoleId: string): Promise<void> {
    if (sourceRoleId === targetRoleId) return;

    const nextRoles = getOrderedStaffRoles();
    const sourceIndex = nextRoles.findIndex((role) => role.id === sourceRoleId);
    const targetIndex = nextRoles.findIndex((role) => role.id === targetRoleId);

    if (sourceIndex < 0 || targetIndex < 0) return;

    const sourceRole = nextRoles[sourceIndex];
    const targetRole = nextRoles[targetIndex];

    const targetHierarchyId = targetRole.hierarchyId ?? null;
    const currentHierarchyId = sourceRole.hierarchyId ?? null;

    // Si on a glissé sur un rôle d'une hiérarchie différente, on met à jour la hiérarchie
    if (currentHierarchyId !== targetHierarchyId) {
      try {
        await updateRoleHierarchyOnServer(sourceRoleId, targetHierarchyId);
      } catch (err) {
        console.error("Erreur lors de la mise à jour de la hiérarchie du rôle:", err);
        toast.error(m.sm_err_hierarchy_update_prefix() + (err instanceof Error ? err.message : String(err)));
        await loadStaffRoles();
        return;
      }
    }

    const [movedRole] = nextRoles.splice(sourceIndex, 1);
    movedRole.hierarchyId = targetHierarchyId;
    nextRoles.splice(targetIndex, 0, movedRole);
    staffRoles = nextRoles.map((role, index) => ({ ...role, sortOrder: index }));
    await saveStaffRoleOrder(nextRoles.map((role) => role.id));
  }

  async function saveStaffRoleOrder(orderedRoleIds: string[]) {
    if (!guildId || !authStore.token) return;

    isSavingRoleOrder = true;
    try {
      const res = await dashboardFetch(`/staff/roles/order`, { guildId,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({ orderedRoleIds })
      });

      if (!res.ok) throw new Error(m.sm_err_reorder());

      await loadStaffRoles();
    } catch (err) {
      console.error('Erreur réordonnancement rôles staff:', err);
      toast.error(m.sm_err_role_order_update());
      await loadStaffRoles();
    } finally {
      isSavingRoleOrder = false;
      clearRoleDragState();
    }
  }

  function openAddMemberForm(): void {
    showAddMemberForm = !showAddMemberForm;
    if (!showAddMemberForm) {
      addMemberLookupQuery = '';
      newMemberUserId = '';
      newMemberUsername = '';
      newMemberAvatarUrl = '';
      newMemberCreateTutoring = true;
    }
  }

  function openWarnForm(): void {
    showWarnForm = !showWarnForm;
    if (!showWarnForm) {
      warnLookupQuery = '';
      warnTargetUserId = '';
    }
  }

  function openBlacklistForm(): void {
    showBlacklistForm = !showBlacklistForm;
    if (!showBlacklistForm) {
      blacklistLookupQuery = '';
      blacklistTargetUserId = '';
    }
  }

  // Loadings

  onMount(() => {
    const initialTab = resolveTabFromUrl('/staff-management', staffTabs, 'members');
    if (isStaffTab(initialTab)) {
      activeTab = initialTab;
    }
  });

  let lastLoadedGuildId = '';
  let lastLoadedToken = '';

  $effect(() => {
    const currentGuildId = authStore.selectedGuildId;
    if (!currentGuildId) return;

    if (!authStore.token) {
      error = m.sm_err_unauthenticated();
      return;
    }

    guildId = currentGuildId;
    const activeGuild = (authStore.guilds as any[]).find((g: any) => g.id === currentGuildId);
    accessLevel = activeGuild?.accessLevel || 'none';

    if (accessLevel !== 'admin' && !directoryAccess.canView && !rolesAccess.canView) {
      error = m.sm_err_insufficient_access();
      return;
    } else {
      error = '';
    }

    if (currentGuildId === lastLoadedGuildId && authStore.token === lastLoadedToken) {
      return;
    }
    lastLoadedGuildId = currentGuildId;
    lastLoadedToken = authStore.token || '';

  /**
   * Charge les salons Discord depuis l'endpoint dédié.
   * À appeler si getGuildState retourne des listes vides.
   */
  async function loadDiscordChannels(targetGuildId: string) {
    try {
      const data = await fetchDiscordChannels(targetGuildId);
      if (data?.textChannels?.length > 0 || data?.voiceChannels?.length > 0) {
        availableDiscordChannels = data.textChannels || [];
        availableDiscordVoiceChannels = data.voiceChannels || [];
      }
    } catch {
      // Silencieux - les selects resteront vides si Discord est inaccessible
    }
  }

    // Le contenu du staff ne dépend pas des rôles/salons Discord (utilisés uniquement
    // par les selects des modales) : on lance les deux en parallèle plutôt qu'en cascade.
    void loadInitialData();

    void (async () => {
      try {
        const dashboardState = await fetchGuildState(currentGuildId);
        availableDiscordRoles = dashboardState?.discordRoles || [];
        availableDiscordChannels = dashboardState?.discordChannels || [];
        availableDiscordVoiceChannels = dashboardState?.discordVoiceChannels || [];

        // Si les salons sont absents (guild pas en cache Discord), on les charge via l'endpoint dédié
        if (availableDiscordChannels.length === 0 && availableDiscordVoiceChannels.length === 0) {
          await loadDiscordChannels(currentGuildId);
        }

        void loadStaffServerChannels();
      } catch (err) {
        console.error('Erreur:', err);
      }
    })();
  });

  async function loadInitialData() {
    // L'onglet actif part immédiatement, en parallèle des configs dont il ne dépend pas.
    await Promise.all([
      loadTabData(activeTab),
      loadStaffRoles(),
      loadStaffConfig(),
      loadFeatureConfigs(),
      loadHierarchies(),
    ]);
  }

  // Onglets déjà chargés : évite de refetcher à chaque aller-retour entre onglets.
  const loadedTabs = new Set<StaffTab>();

  async function loadTabData(tab: StaffTab, force = false) {
    // 'blacklist' et 'members' consomment la même ressource
    const cacheKey = tab === 'blacklist' ? 'members' : tab;
    if (!force && loadedTabs.has(cacheKey as StaffTab)) return;
    loadedTabs.add(cacheKey as StaffTab);

    try {
      switch (tab) {
        case 'members': await loadStaffMembers(); break;
        case 'roles': await Promise.all([loadStaffRoles(), loadHierarchies()]); break;
        case 'organigramme': await loadHierarchySchema(); break;
        case 'warnings': await loadStaffWarnings(); break;
        case 'blacklist': await loadStaffMembers(); break;
        case 'polls': await loadPolls(); break;
        case 'leadership': await loadLeadershipMetrics(); break;
      }
    } catch (err) {
      loadedTabs.delete(cacheKey as StaffTab);
      throw err;
    }
  }

  async function loadHierarchies() {
    if (!guildId || !authStore.token) return;
    try {
      const data = await fetchStaffHierarchies(guildId);
      hierarchies = data?.hierarchies || [];
    } catch (err) {
      console.error('Erreur loading hierarchies:', err);
    }
  }

  async function loadHierarchySchema() {
    if (!guildId || !authStore.token) return;
    loadingStates.organigramme = true;
    try {
      hierarchySchema = await fetchHierarchySchema(guildId);
    } catch (err) {
      console.error('Erreur loading hierarchy schema:', err);
    } finally {
      loadingStates.organigramme = false;
    }
  }

  async function loadStaffMembers() {
    if (!guildId || !authStore.token) return;
    loadingStates.members = true;
    try {
      const res = await dashboardFetch(`/staff/members`, { guildId,
        });
      if (!res.ok) throw new Error(`Erreur API staff members (${res.status})`);
      const data = await res.json();
      staffMembers = data.members || [];
    } catch (err) {
      console.error('Erreur loading staff members:', err);
    } finally {
      loadingStates.members = false;
    }
  }

  async function loadStaffRoles() {
    if (!guildId || !authStore.token) return;
    loadingStates.roles = true;
    try {
      const res = await dashboardFetch(`/staff/roles`, { guildId,
        });
      if (!res.ok) throw new Error(`Erreur API staff roles (${res.status})`);
      const data = await res.json();
      staffRoles = data.roles || [];
    } catch (err) {
      console.error('Erreur loading staff roles:', err);
    } finally {
      loadingStates.roles = false;
    }
  }

  async function loadStaffWarnings() {
    if (!guildId || !authStore.token) return;
    loadingStates.warnings = true;
    try {
      const data = await fetchStaffWarnings(guildId);
      staffWarnings = data.warnings || [];
    } catch (err) {
      console.error('Erreur loading staff warnings:', err);
    } finally {
      loadingStates.warnings = false;
    }
  }

  async function loadStaffConfig() {
    if (!guildId || !authStore.token) return;
    try {
      const res = await dashboardFetch(`/staff/config`, { guildId,
        });
      if (res.ok) {
        const data = await res.json();
        const cfg = data.config || {};
        baseStaffRoleId = cfg.baseStaffRoleId ?? null;
        testStaffRoleId = cfg.testStaffRoleId ?? null;
        meetingAnnouncementChannelId = cfg.meetingAnnouncementChannelId ?? null;
        meetingVoiceChannelId = cfg.meetingVoiceChannelId ?? null;
        staffAnnouncementChannelId = cfg.staffAnnouncementChannelId ?? null;

        warnsToDemote = Number.isFinite(Number(cfg.warnsToDemote)) ? Number(cfg.warnsToDemote) : warnsToDemote;
        warnsToBlacklist = Number.isFinite(Number(cfg.warnsToBlacklist)) ? Number(cfg.warnsToBlacklist) : warnsToBlacklist;
        blacklistPermanentByDefault = cfg.blacklistPermanentByDefault === undefined ? blacklistPermanentByDefault : !!cfg.blacklistPermanentByDefault;
        actionMode = cfg.actionMode === 'auto' ? 'auto' : 'validation';
        demoteRemoveAllRoles = cfg.demoteRemoveAllRoles === undefined ? demoteRemoveAllRoles : !!cfg.demoteRemoveAllRoles;
      }
    } catch (err) {
      console.error('Erreur loading staff config:', err);
    }
  }

  async function loadFeatureConfigs() {
    loadingFeatureConfigs = true;
    try {
      const data = await fetchFeatureConfigurations(guildId!);
      featureConfigs = data.features || [];
    } catch (err) {
      console.error('Erreur loading feature configs:', err);
    } finally {
      loadingFeatureConfigs = false;
    }
  }

  async function saveStaffConfig() {
    if (!guildId || !authStore.token) return;
    isSavingConfig = true;
    try {
      const ok = await updateStaffConfig({
        baseStaffRoleId,
        testStaffRoleId,
        meetingAnnouncementChannelId,
        meetingVoiceChannelId,
        staffAnnouncementChannelId,
        warnsToDemote,
        warnsToBlacklist,
        blacklistPermanentByDefault,
        actionMode,
        demoteRemoveAllRoles
      }, guildId);
      
      if (!ok) throw new Error('Erreur API');
      await dashboardStore.refresh();
    } catch (err) {
      console.error('Error saving staff config:', err);
    } finally {
      isSavingConfig = false;
    }
  }

  async function loadLeadershipMetrics() {
    if (!guildId || !authStore.token) return;
    loadingStates.leadership = true;
    try {
      const res = await dashboardFetch(`/leadership`, { guildId,
        });
      if (res.ok) {
        const data = await res.json();
        leadershipMetrics = data.metrics || [];
      }
    } catch (err) {
      console.error('Erreur loading metrics:', err);
    } finally {
      loadingStates.leadership = false;
    }
  }

  async function loadPolls() {
    if (!guildId || !authStore.token) return;
    loadingStates.polls = true;
    try {
      const data = await fetchPolls(guildId);
      polls = data.polls || [];
    } catch (err) {
      console.error('Erreur loading polls:', err);
    } finally {
      loadingStates.polls = false;
    }
  }

  function addPollOptionInput() {
    newPollOptions = [...newPollOptions, ''];
  }

  function removePollOptionInput(index: number) {
    if (newPollOptions.length <= 2) return;
    newPollOptions = newPollOptions.filter((_, i) => i !== index);
  }

  async function createPoll() {
    if (!guildId || !authStore.token || !newPollTitle.trim()) return;
    const filteredOptions = newPollOptions.filter(o => o.trim() !== '');
    if (filteredOptions.length < 2) {
      toast.warning(m.sm_toast_poll_min_options());
      return;
    }
    isSavingPoll = true;
    try {
      const res = await dashboardFetch(`/staff/polls`, { guildId,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({
          title: newPollTitle,
          description: newPollDescription,
          options: filteredOptions,
          closesAt: newPollClosesAt || undefined
        })
      });
      if (!res.ok) throw new Error('Erreur creation');
      showPollForm = false;
      newPollTitle = '';
      newPollDescription = '';
      newPollOptions = ['', ''];
      newPollClosesAt = '';
      await loadPolls();
    } catch (err) {
      toast.error(m.sm_err_poll_create());
    } finally {
      isSavingPoll = false;
    }
  }

  async function castVote(pollId: string, optionId: string) {
    if (!guildId || !authStore.token) return;
    try {
      const res = await dashboardFetch(`/staff/polls/vote`, { guildId,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({ pollId, optionId })
      });
      if (!res.ok) throw new Error(m.common_error());
      await loadPolls();
    } catch (err) {
      toast.error(m.sm_err_vote());
    }
  }

  async function closePoll(pollId: string) {
    if (!guildId || !authStore.token || !(await confirmDialog.ask({ title: m.sm_confirm_close_poll_title(), description: m.sm_confirm_close_poll_desc(), confirmLabel: m.sm_confirm_close_poll_btn(), variant: 'warning' }))) return;
    try {
      const res = await dashboardFetch(`/staff/polls/${pollId}/close`, { guildId,
        method: 'PATCH'
        });
      if (!res.ok) throw new Error(m.sm_err_poll_close());
      await loadPolls();
    } catch (err) {
      toast.error(m.sm_err_poll_close());
    }
  }

  async function addStaffMember() {
    if (!guildId || !authStore.token || !newMemberGrade) return;

    if (!newMemberUserId.trim()) {
      toast.warning(m.sm_toast_select_member());
      return;
    }

    try {
      const res = await dashboardFetch(`/staff/members`, { guildId,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({
          userId: newMemberUserId.trim(),
          grade: newMemberGrade,
          username: newMemberUsername,
          avatarUrl: newMemberAvatarUrl,
          createTestingPeriod: newMemberCreateTutoring
        })
      });

      if (!res.ok) throw new Error('Erreur lors de l\'ajout');

      showAddMemberForm = false;
      addMemberLookupQuery = '';
      newMemberUserId = '';
      newMemberGrade = 'HELPER';
      newMemberUsername = '';
      newMemberAvatarUrl = '';
      newMemberRoleIds = [];
      newMemberCreateTutoring = true;
      await loadStaffMembers();
    } catch (err) {
      console.error('Erreur:', err);
      toast.error(m.sm_err_member_add());
    }
  }

  // Hierarchy CRUD
  function openAddHierarchyForm() {
    editingHierarchy = null;
    newHierarchyName = '';
    newHierarchyDescription = '';
    newHierarchyColor = '#3b82f6';
    newHierarchyIcon = '🔵';
    newHierarchyDiscordRoleId = '';
    newHierarchyResponsableUserId = '';
    newHierarchyParentId = '';
    showAddHierarchyForm = true;
  }

  function openEditHierarchyForm(h: StaffHierarchy) {
    editingHierarchy = h;
    newHierarchyName = h.name;
    newHierarchyDescription = h.description || '';
    newHierarchyColor = h.color || '#3b82f6';
    newHierarchyIcon = h.icon || '🔵';
    newHierarchyDiscordRoleId = h.discordRoleId || '';
    newHierarchyResponsableUserId = h.responsableUserId || '';
    newHierarchyParentId = h.parentHierarchyId || '';
    showAddHierarchyForm = true;
  }

  async function saveHierarchy() {
    if (!guildId || !authStore.token || !newHierarchyName.trim()) return;
    isSavingHierarchy = true;
    try {
      const payload = {
        name: newHierarchyName.trim(),
        description: newHierarchyDescription.trim() || null,
        color: newHierarchyColor,
        icon: newHierarchyIcon.trim() || null,
        discordRoleId: newHierarchyDiscordRoleId.trim() || null,
        responsableUserId: newHierarchyResponsableUserId.trim() || null,
        parentHierarchyId: newHierarchyParentId || null
      };

      if (editingHierarchy) {
        await updateStaffHierarchy(editingHierarchy.id, payload, guildId);
      } else {
        await createStaffHierarchy(payload, guildId);
      }
      showAddHierarchyForm = false;
      void Promise.allSettled([loadHierarchies(), loadHierarchySchema()]);
    } catch (err) {
      console.error('Erreur lors de l\'enregistrement de la hiérarchie:', err);
      toast.error(m.sm_err_hierarchy_save());
    } finally {
      isSavingHierarchy = false;
    }
  }

  async function deleteHierarchy(id: string) {
    if (!(await confirmDialog.danger(m.sm_confirm_delete_hierarchy_title(), m.sm_confirm_delete_hierarchy_desc()))) return;
    try {
      await deleteStaffHierarchy(id, guildId);
      await Promise.all([loadHierarchies(), loadHierarchySchema(), loadStaffRoles()]);
    } catch (err) {
      toast.error(m.sm_err_delete_generic());
    }
  }

  // Import Modal
  function openImportModal(h: StaffHierarchy) {
    importHierarchyTarget = h;
    importDiscordRoleId = '';
    importGradeName = '';
    importResult = null;
    showImportModal = true;
  }

  async function runImport() {
    if (!guildId || !importHierarchyTarget || !importDiscordRoleId || !importGradeName) return;
    isImporting = true;
    importResult = null;
    try {
      const res = await importHierarchyRoleMembers(importHierarchyTarget.id, importDiscordRoleId, importGradeName, guildId);
      importResult = res;
      await Promise.all([loadStaffMembers(), loadHierarchies(), loadHierarchySchema()]);
    } catch (err) {
      toast.error(errorMessage(err) || m.sm_err_import());
    } finally {
      isImporting = false;
    }
  }

  // Member Hierarchy Grade Modal
  function openMemberHierarchyGradeForm(sm: StaffMember) {
    memberHierarchyGradeTarget = sm;
    const draft = resolveMemberHierarchyDraft(sm);
    selectedMemberHierarchyId = draft?.hierarchyId ?? '';
    selectedMemberHierarchyGrade = draft?.grade ?? '';
    showMemberHierarchyGradeForm = true;
  }

  async function saveMemberHierarchyGrade() {
    if (!guildId || !memberHierarchyGradeTarget || !selectedMemberHierarchyId || !selectedMemberHierarchyGrade) return;
    isSavingMemberHierarchyGrade = true;
    try {
      await addMemberHierarchyGrade(memberHierarchyGradeTarget.userId, selectedMemberHierarchyId, selectedMemberHierarchyGrade, guildId);
      showMemberHierarchyGradeForm = false;
      await loadStaffMembers();
    } catch (err) {
      toast.error(errorMessage(err) || m.sm_err_grade_add());
    } finally {
      isSavingMemberHierarchyGrade = false;
    }
  }

  async function removeMemberHierarchy(userId: string, hierarchyId: string) {
    if (!(await confirmDialog.danger(m.sm_confirm_remove_member_hierarchy_title(), '', m.sm_confirm_remove_btn()))) return;
    try {
      await removeMemberHierarchyGrade(userId, hierarchyId, guildId);
      await loadStaffMembers();
    } catch (err) {
      toast.error(errorMessage(err) || m.sm_err_remove());
    }
  }

  async function toggleTutor(userId: string) {
    if (!guildId || !authStore.token) return;
    try {
      const ok = await toggleTutorStatus(userId, guildId);
      if (!ok) throw new Error(m.common_error());
      await loadStaffMembers();
    } catch (err) {
      console.error('Erreur toggle tutor:', err);
      toast.error(m.sm_err_tutor_toggle());
    }
  }

  async function promoteStaff(userId: string) {
    if (!guildId || !authStore.token) return;

    const currentGrade = staffMembers.find(sm => sm.userId === userId)?.grade;
    const currentIdx = getOrderedStaffRoles().findIndex(r => r.name === currentGrade);
    
    if (currentIdx === -1) {
      toast.warning(m.sm_toast_grade_not_found());
      return;
    }

    if (currentIdx <= 0) {
      toast.warning(m.sm_toast_grade_max());
      return;
    }

    const newGrade = getOrderedStaffRoles()[currentIdx - 1].name;

    try {
      const res = await dashboardFetch(`/staff/members/${userId}`, { guildId,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({ grade: newGrade })
      });

      if (!res.ok) throw new Error(m.common_error());
      await loadStaffMembers();
    } catch (err) {
      toast.error(m.sm_err_promote());
    }
  }

  async function demoteStaff(userId: string) {
    if (!guildId || !authStore.token) return;

    const currentGrade = staffMembers.find(sm => sm.userId === userId)?.grade;
    const currentIdx = getOrderedStaffRoles().findIndex(r => r.name === currentGrade);
    
    if (currentIdx === -1) {
      toast.warning(m.sm_toast_grade_not_found());
      return;
    }

    if (currentIdx >= getOrderedStaffRoles().length - 1) {
      toast.warning(m.sm_toast_grade_min());
      return;
    }

    const newGrade = getOrderedStaffRoles()[currentIdx + 1].name;

    try {
      const res = await dashboardFetch(`/staff/members/${userId}`, { guildId,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({ grade: newGrade })
      });

      if (!res.ok) throw new Error(m.common_error());
      await loadStaffMembers();
    } catch (err) {
      toast.error(m.sm_err_demote());
    }
  }

  async function toggleStaffSuspension(member: StaffMember) {
    if (!guildId || !authStore.token) return;

    const suspend = !member.suspendedAt;
    const confirmed = await confirmDialog.ask(
      suspend
        ? {
          title: m.sm_confirm_suspend_title(),
          description: m.sm_confirm_suspend_desc(),
          confirmLabel: m.sm_confirm_suspend_btn(),
          variant: 'warning'
        }
        : {
          title: m.sm_confirm_unsuspend_title(),
          description: m.sm_confirm_unsuspend_desc(),
          confirmLabel: m.sm_confirm_unsuspend_btn()
        }
    );
    if (!confirmed) return;

    try {
      const res = await dashboardFetch(`/staff/members/${member.userId}`, { guildId,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({ action: suspend ? 'suspend' : 'unsuspend' })
      });

      if (!res.ok) throw new Error(m.common_error());
      await loadStaffMembers();
    } catch (err) {
      toast.error(suspend ? m.sm_err_suspend() : m.sm_err_unsuspend());
    }
  }

  async function removeStaff(userId: string) {
    if (!guildId || !authStore.token || !(await confirmDialog.danger(m.sm_confirm_remove_staff_title(), '', m.sm_confirm_remove_staff_btn()))) return;

    try {
      const res = await dashboardFetch(`/staff/members/${userId}`, { guildId,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({ action: 'remove' })
      });

      if (!res.ok) throw new Error(m.common_error());
      await loadStaffMembers();
    } catch (err) {
      toast.error(m.sm_err_remove());
    }
  }

  async function createStaffRole() {
    if (!guildId || !authStore.token) return;

    const nextRoleName = roleSearchQuery.trim();
    if (!nextRoleName) return;

    const existingRole = getOrderedStaffRoles().find((role) => normalizeText(role.name) === normalizeText(nextRoleName));
    if (existingRole) {
      roleSearchQuery = existingRole.name;
      selectedDiscordRoleId = existingRole.discordRoleId || '';
      showAddRoleForm = false;
      return;
    }

    const matchedDiscordRole = selectedDiscordRoleId
      ? availableDiscordRoles.find((role) => role.id === selectedDiscordRoleId)
      : findDiscordRoleByQuery(nextRoleName);

    try {
      const res = await dashboardFetch(`/staff/roles`, { guildId,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: matchedDiscordRole?.name || nextRoleName,
          level: Number(newRoleLevel),
          discordRoleId: matchedDiscordRole?.id,
          hierarchyId: newRoleHierarchyId || undefined,
          isResponsable: newRoleIsResponsable
        })
      });

      if (!res.ok) throw new Error(m.common_error());

      showAddRoleForm = false;
      newRoleName = '';
      roleSearchQuery = '';
      selectedDiscordRoleId = '';
      roleSuggestionsOpen = false;
      newRoleHierarchyId = '';
      newRoleIsResponsable = false;
      newRoleLevel = 100;
      await loadStaffRoles();
    } catch (err) {
      toast.error(m.sm_err_role_create());
    }
  }

  function openEditRoleModal(role: StaffRole) {
    editingRole = role;
    editRoleName = role.name;
    editRoleLevel = role.level;
    editRoleColor = role.color || '';
    editRoleDiscordRoleId = role.discordRoleId || '';
    editRoleHierarchyId = role.hierarchyId || '';
    editRoleIsResponsable = role.isResponsable;
    showEditRoleModal = true;
  }

  async function saveRoleEdit() {
    if (!editingRole || !guildId) return;

    try {
      const data = {
        name: editRoleName,
        level: Number(editRoleLevel),
        color: editRoleColor || null,
        discordRoleId: editRoleDiscordRoleId || null,
        hierarchyId: editRoleHierarchyId || null,
        isResponsable: editRoleIsResponsable
      };

      const ok = await updateStaffRole(editingRole.id, data, guildId);
      if (ok) {
        toast.success(m.sm_toast_role_updated());
        showEditRoleModal = false;
        editingRole = null;
        await loadStaffRoles();
      }
    } catch (err) {
      toast.error(m.sm_err_role_update());
    }
  }

  async function removeStaffRole(roleId: string, roleName: string) {
    if (!guildId || !authStore.token) return;
    if (!(await confirmDialog.danger(m.sm_confirm_delete_role_title({ name: roleName }), m.sm_confirm_delete_role_desc()))) return;

    try {
      const success = await deleteStaffRole(roleId, guildId);
      if (success) {
        await loadStaffRoles();
      }
    } catch (err) {
      console.error('Erreur lors de la suppression du rôle:', err);
    }
  }

  async function issueWarning() {
    if (!guildId || !authStore.token || !warnTargetUserId || !warnReason) return;

    try {
      const res = await dashboardFetch(`/staff/warnings`, { guildId,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({
          staffUserId: warnTargetUserId,
          reason: warnReason,
          expiresAt: warnExpiresAt ? new Date(warnExpiresAt).toISOString() : null
        })
      });

      if (!res.ok) throw new Error(m.common_error());

      showWarnForm = false;
      warnTargetUserId = '';
      warnReason = '';
      warnExpiresAt = '';
      await Promise.all([loadStaffMembers(), loadStaffWarnings()]);
    } catch (err) {
      toast.error(m.sm_err_warn());
    }
  }

  async function deleteWarning(warningId: string) {
    if (!guildId || !authStore.token) return;
    if (!(await confirmDialog.danger(m.sm_confirm_delete_warning()))) return;

    try {
      const res = await dashboardFetch(`/staff/warnings/${warningId}`, { guildId,
        method: 'DELETE'
        });

      if (!res.ok) throw new Error(m.common_error());

      await Promise.all([loadStaffMembers(), loadStaffWarnings()]);
    } catch (err) {
      toast.error(m.sm_err_warn_delete());
    }
  }

  async function blacklistStaff() {
    if (!guildId || !authStore.token || !blacklistTargetUserId || !blacklistReason) return;

    try {
      const res = await dashboardFetch(`/staff/blacklist`, { guildId,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({
          staffUserId: blacklistTargetUserId,
          reason: blacklistReason,
          endDate: blacklistEndDate ? new Date(blacklistEndDate).toISOString() : null
        })
      });

      if (!res.ok) throw new Error(m.common_error());

      showBlacklistForm = false;
      blacklistTargetUserId = '';
      blacklistReason = '';
      blacklistEndDate = '';
      await loadStaffMembers();
    } catch (err) {
      toast.error(m.sm_err_blacklist());
    }
  }

  async function removeStaffBlacklist(userId: string) {
    if (!guildId || !authStore.token || !(await confirmDialog.ask({ title: m.sm_confirm_remove_blacklist_title(), confirmLabel: m.sm_confirm_remove_btn(), variant: 'warning' }))) return;

    try {
      const res = await dashboardFetch(`/staff/blacklist/${userId}`, { guildId,
        method: 'DELETE'
        });

      if (!res.ok) throw new Error(m.common_error());

      await loadStaffMembers();
    } catch (err) {
      toast.error(m.sm_err_blacklist_remove());
    }
  }

  const stats = $derived([
    {
      label: m.sm_stat_members(),
      value: staffMembers.length.toString(),
      note: m.sm_stat_members_note(),
      icon: "users",
      color: "bg-primary/10 text-primary",
      loading: loadingStates.members
    },
    {
      label: m.sm_stat_roles(),
      value: staffRoles.length.toString(),
      note: m.sm_stat_roles_note(),
      icon: "shield",
      color: "bg-success/10 text-success",
      loading: loadingStates.roles
    },
    {
      label: m.sm_stat_warnings(),
      value: staffMembers.reduce((acc, member) => acc + (member.warnings?.length || 0), 0).toString(),
      note: m.sm_stat_warnings_note(),
      icon: "alert-triangle",
      color: "bg-warning/10 text-warning",
      loading: loadingStates.members // Depends on staffMembers
    },
    {
      label: m.sm_stat_polls(),
      value: polls.filter(p => p.status !== 'CLOSED' && (!p.closesAt || new Date(p.closesAt) > new Date())).length.toString(),
      note: m.sm_stat_polls_note(),
      icon: "bar-chart-2",
      color: "bg-slate-500/10 text-on-surface-variant",
      loading: loadingStates.polls
    },
  ]);
</script>

<div class="space-y-8 animate-in fade-in slide-in-from-bottom-6 duration-1000">
  {#if !guildId && !error}
    <div class="space-y-8 p-8 md:p-10 w-full animate-in fade-in duration-700">
      <Skeleton width="w-1/3" height="h-14" rounded="rounded-lg" />
      <div class="flex flex-col md:flex-row gap-6">
        <Skeleton height="h-32" class="flex-1" rounded="rounded-xl" />
        <Skeleton height="h-32" class="flex-1" rounded="rounded-xl" />
        <Skeleton height="h-32" class="flex-1" rounded="rounded-xl" />
        <Skeleton height="h-32" class="flex-1" rounded="rounded-xl" />
      </div>
      <Skeleton height="h-[60vh]" rounded="rounded-xl" />
    </div>
  {:else if error}
    <div class="mt-6 rounded-lg border border-error/20 bg-error/10 px-4 py-3 text-sm font-bold text-error text-center max-w-2xl mx-auto">
      {error}
    </div>
  {:else if guildId}
    <header class="flex flex-col md:flex-row md:items-end justify-between gap-x-6 gap-y-3">
      <div class="min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight text-on-surface font-headline leading-tight">
          {m.sm_header_title()}
        </h1>
        <p class="mt-1 max-w-prose text-sm text-on-surface-variant">
          {m.sm_header_desc()}
        </p>
      </div>
      {#if canManageSettings}
        <div class="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            icon="settings"
            onclick={() => showConfigMenu = true}
            title={m.sm_header_config_title()}
          >{m.sm_header_settings()}</Button>
        </div>
      {/if}
    </header>

    <!-- STATS -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" data-tour="staff-stats">
      {#each stats as stat}
        <MetricCard
          label={stat.label}
          value={stat.value}
          note={stat.note}
          icon={stat.icon}
          toneClass={stat.color}
          loading={stat.loading}
        />
      {/each}
    </div>

    <Tabs
      label={m.nav_group_staff()}
      tabs={pageTabItems('/staff-management', (id) => staffTabVisible[id as StaffTab])}
      active={activeTab}
      onchange={(id) => switchTab(id as StaffTab)}
    />

    <!-- SECTIONS -->
    <div class="premium-card rounded-xl overflow-hidden" data-tour="staff-panel">
      {#if activeTab === 'members'}
        <div class="p-6 md:p-8 flex items-center justify-between border-b border-outline-variant/10 bg-surface-container-low/30">
          <div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_members_title()}</h3>
            <p class="text-sm font-medium text-on-surface-variant/60 mt-1">{m.sm_members_desc()}</p>
          </div>
          {#if directoryAccess.canConfigure}
            <button
              onclick={openAddMemberForm}
              class="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-primary/20 bg-primary/8 px-6 py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-white"
            >
              <Papicon icon={showAddMemberForm ? 'x' : 'plus'} size={14} />
              {showAddMemberForm ? m.common_cancel() : m.sm_btn_add_member()}
            </button>
          {/if}
        </div>

        {#if showAddMemberForm}
          <div class="p-6 md:p-8 border-b border-primary/10 bg-primary/5 animate-in slide-in-from-top-4 fade-in duration-300">
            <div class="flex flex-col gap-4 md:flex-row md:items-end">
              <div class="flex-1">
                <label>
                  <span class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_discord_user()}</span>
                  <div class="min-w-0">
                    <DiscordMemberLookup
                      {guildId}
                      bind:query={addMemberLookupQuery}
                      bind:selectedId={newMemberUserId}
                      bind:selectedUsername={newMemberUsername}
                      bind:selectedAvatarUrl={newMemberAvatarUrl}
                      bind:selectedRoleIds={newMemberRoleIds}
                      placeholder={m.sm_placeholder_mention_or_id()}
                      selectedIdPlaceholder={m.sm_placeholder_discord_id_autofill()}
                    />
                  </div>
                </label>
              </div>
              <div class="md:w-64 shrink-0">
                <label>
                  <span class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_global_grade()}</span>
                  <select bind:value={newMemberGrade} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10">
                    {#each orderedStaffRoles as role}
                      <option value={role.name}>{role.name}</option>
                    {/each}
                  </select>
                </label>
              </div>
              <div class="flex items-center gap-3 shrink-0 mb-3 md:mb-0">
                <ToggleSwitch
                  checked={newMemberCreateTutoring}
                  onToggle={(v: boolean) => newMemberCreateTutoring = v}
                />
                <span class="text-body-sm font-medium text-on-surface-variant/70">{m.sm_toggle_create_tutoring()}</span>
              </div>
              <button onclick={addStaffMember} class="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-8 py-3 text-xs font-semibold text-white transition-all active:scale-[0.98]">
                {m.common_add()}
              </button>
            </div>
          </div>
        {/if}

        {#if loadingStates.members}
          <div class="divide-y divide-outline-variant/10">
            {#each Array(5) as _}
              <div class="px-8 py-6 flex flex-col gap-6 lg:flex-row lg:items-center">
                <div class="flex items-center gap-4 flex-1">
                  <Skeleton width="w-12" height="h-12" circle={true} />
                  <div class="space-y-2 flex-1">
                    <Skeleton width="w-1/4" height="h-5" />
                    <div class="flex gap-2">
                       <Skeleton width="w-16" height="h-4" rounded="rounded-full" />
                       <Skeleton width="w-24" height="h-4" rounded="rounded-full" />
                    </div>
                  </div>
                </div>
                <div class="flex gap-2">
                  <Skeleton width="w-10" height="h-10" rounded="rounded-xl" />
                  <Skeleton width="w-10" height="h-10" rounded="rounded-xl" />
                  <Skeleton width="w-10" height="h-10" rounded="rounded-xl" />
                </div>
              </div>
            {/each}
          </div>
        {:else if activeStaffMembers.length > 0}
          <div class="divide-y divide-outline-variant/10">
            {#each activeStaffMembers as member (member.id)}
              <article class="group bg-transparent px-6 py-6 md:px-8 transition-all hover:bg-primary/4">
                <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                  <div class="flex items-center gap-4 flex-1">
                    <div class="h-12 w-12 shrink-0 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant/70 border border-outline-variant/20 shadow-sm overflow-hidden">
                      {#if member.avatarUrl}
                        <img src={member.avatarUrl} alt="" class="h-full w-full object-cover" />
                      {:else}
                        <Papicon icon="user" size={24} />
                      {/if}
                    </div>
                    <div>
                      <h4 class="text-lg font-semibold text-on-surface leading-tight hover:text-primary transition-colors cursor-pointer">
                        <a href="/profile/{member.userId}">{member.displayName || member.username || m.sm_unknown_user()}</a>
                      </h4>
                      <div class="flex items-center gap-3 mt-1.5 flex-wrap">
                        <span class="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                          {member.grade}
                        </span>
                        {#if member.hierarchyGrades && member.hierarchyGrades.length > 0}
                          {#each member.hierarchyGrades as hGrade}
                            <span 
                              class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                              style="border-color: {hGrade.hierarchy?.color ? hGrade.hierarchy.color + '30' : 'rgba(99, 102, 241, 0.2)'}; background-color: {hGrade.hierarchy?.color ? hGrade.hierarchy.color + '15' : 'rgba(99, 102, 241, 0.1)'}; color: {hGrade.hierarchy?.color || 'var(--color-primary)'}"
                            >
                              <span>{hGrade.hierarchy?.icon || '🔵'}</span>
                              <span>{hGrade.hierarchy?.name} : {hGrade.grade}</span>
                            </span>
                          {/each}
                        {/if}
                        {#if member.isTutor}
                          <span class="inline-flex items-center gap-1 item rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-semibold text-indigo-600 shadow-sm shadow-indigo-500/5 transition-all animate-in zoom-in-95 duration-300">
                            <Papicon icon="shield" size={12} />
                            {m.sm_tutor_badge()}
                          </span>
                        {/if}
                        {#if member.suspendedAt}
                          <span
                            class="inline-flex items-center gap-1 rounded-full border border-orange-500/25 bg-orange-500/10 px-2.5 py-0.5 text-xs font-semibold text-orange-600"
                            title={member.suspendedReason || m.sm_suspended_since({ date: new Date(member.suspendedAt).toLocaleDateString() })}
                          >
                            <Papicon icon="pause" size={12} />
                            {m.sm_suspended_badge()}
                          </span>
                        {/if}
                        <span class="text-2xs font-medium text-on-surface-variant/70">
                          {m.sm_member_since({ date: new Date(member.joinedStaffAt).toLocaleDateString() })}
                        </span>
                        {#if (member.warnings?.length || 0) > 0}
                          <span class="inline-flex items-center gap-1 rounded-full border border-warning/20 bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning">
                            <Papicon icon="alert-triangle" size={12} />
                            {member.warnings?.length || 0} {m.sm_warn_count_label()}{(member.warnings?.length || 0) > 1 ? 's' : ''}
                          </span>
                        {/if}
                      </div>

                      {#if member.stats}
                        <div class="flex items-center gap-3 mt-2 text-xs text-on-surface-variant/60">
                           <div class="flex items-center gap-1">
                             <Papicon icon="message-square" size={14} />
                             <span>{member.stats.totalMessages} {m.sm_word_msg()}</span>
                           </div>
                           <div class="flex items-center gap-1">
                             <Papicon icon="mic" size={14} />
                             <span>{member.stats.totalVoiceMinutes} {m.sm_word_min()}</span>
                           </div>
                           <div class="flex items-center gap-1">
                             <Papicon icon="gavel" size={14} />
                             <span>{member.stats.sanctionsIssued} {m.sm_word_sanctions()}</span>
                           </div>
                        </div>
                      {/if}
                    </div>
                  </div>

                  <div class="flex items-center gap-2 shrink-0 flex-wrap" data-tour="staff-actions">
                    {#if canModerate}
                      <button
                        onclick={() => toggleTutor(member.userId)}
                        class="group/tutor relative inline-flex items-center justify-center rounded-xl p-2.5 transition-all {member.isTutor ? 'text-indigo-600 bg-indigo-500/15 border border-indigo-500/30 shadow-sm ring-2 ring-indigo-500/20' : 'text-on-surface-variant/40 hover:text-indigo-600 hover:bg-indigo-500/10 border border-outline-variant/20 bg-surface-container-low/50 hover:border-indigo-500/30'}"
                        title={member.isTutor ? m.sm_title_toggle_tutor_remove() : m.sm_title_toggle_tutor_add()}
                      >
                        <Papicon 
                          icon={member.isTutor ? 'user-check' : 'user-plus'} 
                          size={20} 
                          class="transition-transform group-hover/tutor:scale-110 group-active/tutor:scale-90" 
                        />
                        {#if member.isTutor}
                           <span class="absolute -top-1 -right-1 flex h-3 w-3">
                             <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                             <span class="relative inline-flex rounded-full h-3 w-3 bg-indigo-500"></span>
                           </span>
                        {/if}
                      </button>
                    {/if}

                    {#if canManageSettings}
                      <div class="w-px h-6 bg-outline-variant/10 mx-1"></div>
                      <button
                        onclick={() => openMemberHierarchyGradeForm(member)}
                        class="inline-flex items-center justify-center rounded-xl p-2.5 text-primary hover:bg-primary/15 border border-primary/20 bg-primary/5 transition-colors"
                        title={m.sm_title_manage_hierarchies()}
                      >
                        <Papicon icon="git-branch" size={20} />
                      </button>
                      <button
                        onclick={() => promoteStaff(member.userId)}
                        disabled={(() => {
                          const idx = orderedStaffRoles.findIndex((r) => r.name === member.grade);
                          return idx <= 0;
                        })()}
                        class="inline-flex items-center justify-center rounded-xl p-2.5 transition-colors disabled:opacity-40 {(orderedStaffRoles.findIndex((r) => r.name === member.grade) <= 0) ? 'text-on-surface-variant/30' : 'text-success hover:bg-success/15 border border-success/20 bg-success/5'}"
                        title={m.sm_title_promote()}
                      >
                        <Papicon icon="chevrons-up" size={20} />
                      </button>
                      <button
                        onclick={() => demoteStaff(member.userId)}
                        disabled={(() => {
                          const idx = orderedStaffRoles.findIndex((r) => r.name === member.grade);
                          return idx === -1 || idx >= orderedStaffRoles.length - 1;
                        })()}
                        class="inline-flex items-center justify-center rounded-xl p-2.5 transition-colors disabled:opacity-40 {(orderedStaffRoles.findIndex((r) => r.name === member.grade) === -1 || orderedStaffRoles.findIndex((r) => r.name === member.grade) >= orderedStaffRoles.length - 1) ? 'text-on-surface-variant/30' : 'text-warning hover:bg-warning/15 border border-warning/20 bg-warning/5'}"
                        title={m.sm_title_demote()}
                      >
                        <Papicon icon="chevrons-down" size={20} />
                      </button>
                      <div class="w-px h-6 bg-outline-variant/20 mx-1"></div>
                      <button
                        onclick={() => toggleStaffSuspension(member)}
                        class="inline-flex items-center justify-center rounded-xl p-2.5 transition-colors {member.suspendedAt ? 'text-sky-600 hover:bg-sky-500/15 border border-sky-500/30 bg-sky-500/10' : 'text-orange-600 hover:bg-orange-500/15 border border-orange-500/20 bg-orange-500/5'}"
                        title={member.suspendedAt ? m.sm_title_unsuspend() : m.sm_title_suspend()}
                      >
                        <Papicon icon={member.suspendedAt ? 'play' : 'pause'} size={20} />
                      </button>
                      <button
                        onclick={() => removeStaff(member.userId)}
                        class="inline-flex items-center justify-center rounded-xl p-2.5 text-error transition-colors hover:bg-error/15 border border-error/20 bg-error/5"
                        title={m.sm_title_remove_staff()}
                      >
                        <Papicon icon="user-minus" size={20} />
                      </button>
                    {/if}
                  </div>
                </div>
              </article>
            {/each}
          </div>
        {:else}
          <div class="flex flex-col items-center justify-center p-16 text-center">
            <div class="w-20 h-20 rounded-xl bg-primary/8 text-primary flex items-center justify-center shadow-inner">
              <Papicon icon="users" size={40} />
            </div>
            <h3 class="mt-6 text-2xl font-semibold tracking-tighter text-on-surface">
              {m.sm_empty_members_title()}
            </h3>
            <p class="mt-3 max-w-xl text-sm leading-relaxed text-on-surface-variant/65">
              {m.sm_empty_members_desc()}
            </p>
          </div>
        {/if}

      {:else if activeTab === 'roles'}
        <div class="p-6 md:p-8 flex items-center justify-between border-b border-outline-variant/10 bg-surface-container-low/30">
          <div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_roles_title()}</h3>
            <p class="text-sm font-medium text-on-surface-variant/75 mt-1">{m.sm_roles_desc()}</p>
          </div>
          <div class="flex items-center gap-2">
            {#if rolesAccess.canConfigure}
              <button
                onclick={openAddHierarchyForm}
                class="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-primary/20 bg-primary/8 px-6 py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-white"
              >
                <Papicon icon="plus" size={14} />
                {m.sm_btn_new_hierarchy()}
              </button>
              <button
                onclick={() => showAddRoleForm = !showAddRoleForm}
                class="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-primary/20 bg-primary/8 px-6 py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-white"
              >
                <Papicon icon={showAddRoleForm ? 'x' : 'plus'} size={14} />
                {showAddRoleForm ? m.sm_aria_close() : m.sm_btn_new_role()}
              </button>
            {/if}
          </div>
        </div>

        <div class="p-6 md:p-8 border-b border-outline-variant/20 bg-surface-container-lowest/50">
          <div class="flex items-center justify-between mb-4">
            <h4 class="text-body-sm font-medium text-on-surface-variant/50">{m.sm_global_config_title()}</h4>
            {#if isSavingConfig}
              <span class="text-2xs font-bold uppercase text-primary animate-pulse">{m.sm_saving()}</span>
            {/if}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label>
                <span class="block text-xs font-semibold text-on-surface mb-2">{m.sm_field_base_role()} <span class="text-on-surface-variant/50 normal-case tracking-normal">{m.sm_optional_tag()}</span></span>
                <select bind:value={baseStaffRoleId} onchange={saveStaffConfig} disabled={!rolesAccess.canConfigure} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:opacity-50 disabled:cursor-not-allowed">
                  <option value={null}>{m.sm_none_option()}</option>
                  {#each availableDiscordRoles as dr}
                    <option value={dr.id}>{dr.name}</option>
                  {/each}
                </select>
              </label>
            </div>
            <div>
              <label>
                <span class="block text-xs font-semibold text-on-surface mb-2">{m.sm_field_test_role()} <span class="text-on-surface-variant/50 normal-case tracking-normal">{m.sm_optional_tag()}</span></span>
                <select bind:value={testStaffRoleId} onchange={saveStaffConfig} disabled={!rolesAccess.canConfigure} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:opacity-50 disabled:cursor-not-allowed">
                  <option value={null}>{m.sm_none_option()}</option>
                  {#each availableDiscordRoles as dr}
                    <option value={dr.id}>{dr.name}</option>
                  {/each}
                </select>
              </label>
            </div>
            <div>
              <label>
                <span class="block text-xs font-semibold text-on-surface mb-2">{m.sm_field_meeting_announce_channel()} <span class="text-on-surface-variant/50 normal-case tracking-normal">{m.sm_text_tag()}</span></span>
                <SearchableSelect bind:value={meetingAnnouncementChannelId} options={meetingAnnouncementChannelOptions} placeholder={m.sm_none_option()} className="w-full" />
              </label>
            </div>
            <div>
              <label>
                <span class="block text-xs font-semibold text-on-surface mb-2">{m.sm_field_meeting_voice_channel()}</span>
                <SearchableSelect bind:value={meetingVoiceChannelId} options={meetingVoiceChannelOptions} placeholder={m.sm_none_option()} className="w-full" />
              </label>
            </div>
            <div>
              <label>
                <span class="block text-xs font-semibold text-on-surface mb-2">{m.sm_field_staff_announce_channel()} <span class="text-on-surface-variant/50 normal-case tracking-normal">{m.sm_optional_tag()}</span></span>
                <SearchableSelect bind:value={staffAnnouncementChannelId} options={availableDiscordChannels.map(dc => ({ id: dc.id, name: `#${dc.name}` }))} placeholder={m.sm_none_option()} className="w-full" />
              </label>
            </div>
          </div>
        </div>

        {#if showAddRoleForm}
          <div class="p-6 md:p-8 border-b border-primary/10 bg-primary/5 animate-in slide-in-from-top-4 fade-in duration-300">
            <div class="flex flex-col gap-6">
              <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div class="relative">
                  <label for="staff-role-search" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_search_discord_role()}</label>
                  <div class="relative">
                    <Papicon icon="search" size={20} class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40" />
                    <input
                      id="staff-role-search"
                      type="text"
                      placeholder={m.sm_placeholder_role_name()}
                      value={roleSearchQuery}
                      oninput={(event) => {
                        const value = (event.currentTarget as HTMLInputElement).value;
                        newRoleName = value;
                        handleRoleSearchInput(value);
                      }}
                      onfocus={() => roleSuggestionsOpen = true}
                      onblur={() => setTimeout(() => { roleSuggestionsOpen = false; }, 120)}
                      class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low pl-12 pr-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                    />
                  </div>
                  {#if roleSuggestionsOpen && roleSuggestions.length > 0}
                    <div class="absolute left-0 right-0 top-full mt-2 z-10 rounded-lg border border-outline-variant/20 bg-surface-container-high p-2 shadow-sm">
                      {#each roleSuggestions as role (role.id)}
                        <button
                          type="button"
                          class="w-full flex items-center justify-between rounded-xl px-4 py-2 hover:bg-surface-container-low transition-colors text-left"
                          onclick={() => selectRoleSuggestion(role)}
                        >
                          <span class="font-bold text-sm text-on-surface">{role.name}</span>
                          <span class="text-xs text-on-surface-variant/70">@{role.id}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>

                <div>
                  <label for="role-hierarchy-select" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_hierarchy_assoc()}</label>
                  <select
                    id="role-hierarchy-select"
                    bind:value={newRoleHierarchyId}
                    class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                  >
                    <option value="">{m.sm_none_alt_option()}</option>
                    {#each hierarchies as h}
                      <option value={h.id}>{h.name}</option>
                    {/each}
                  </select>
                </div>

                <div>
                  <label for="role-level-input" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_role_weight()}</label>
                  <input
                    id="role-level-input"
                    type="number"
                    min="1"
                    max="10000"
                    bind:value={newRoleLevel}
                    class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                  />
                </div>

                <div class="flex items-center gap-3 pt-6">
                  <ToggleSwitch
                    checked={newRoleIsResponsable}
                    onToggle={(v: boolean) => newRoleIsResponsable = v}
                  />
                  <span class="text-body-sm font-medium text-on-surface-variant/70">{m.sm_toggle_hierarchy_chief()}</span>
                </div>
              </div>

              <div class="flex justify-end">
                <button onclick={createStaffRole} class="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-8 py-3 text-xs font-semibold text-white transition-all active:scale-[0.98]">
                  {m.sm_btn_create_association()}
                </button>
              </div>
            </div>
          </div>
        {/if}

        {#if isSavingRoleOrder}
          <div class="bg-blue-500/10 border-b border-blue-500/20 px-6 py-2.5 flex items-center justify-center gap-2 text-body-sm font-medium text-blue-700">
             <Papicon icon="refresh-cw" size={14} class="animate-spin" />
             {m.sm_saving_order()}
          </div>
        {/if}

        {#if loadingStates.roles}
          <div class="p-6 md:p-8 space-y-3">
            {#each Array(4) as _}
              <div class="flex items-center justify-between gap-4 rounded-xl border border-outline-variant/10 bg-surface-container px-6 py-4">
                <div class="flex items-center gap-3">
                  <Skeleton width="w-8" height="h-8" rounded="rounded-lg" />
                  <Skeleton width="w-32" height="h-5" />
                </div>
                <Skeleton width="w-24" height="h-4" rounded="rounded-full" />
              </div>
            {/each}
          </div>
        {:else}
          <div class="p-6 md:p-8 space-y-8">
            <!-- Hiérarchies Grid -->
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-8">
              {#each hierarchies as h (h.id)}
                {@const hRoles = getOrderedStaffRoles().filter(r => r.hierarchyId === h.id)}
                <div class="premium-card rounded-xl p-6 border-t-4 bg-surface-container-low" style="border-top-color: {h.color || '#3b82f6'}">
                  <div class="flex items-start justify-between mb-4">
                    <div class="flex items-center gap-3">
                      <span class="text-2xl">{h.icon || '🔵'}</span>
                      <div>
                        <h4 class="text-lg font-semibold text-on-surface">{h.name}</h4>
                        {#if h.description}
                          <p class="text-xs text-on-surface-variant/75 mt-0.5">{h.description}</p>
                        {/if}
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      {#if rolesAccess.canConfigure}
                        <button onclick={() => openImportModal(h)} class="px-3 py-1.5 rounded-xl bg-primary/8 text-primary hover:bg-primary hover:text-white transition-all text-body-sm font-medium" title={m.sm_title_import_members()}>
                          {m.sm_btn_import()}
                        </button>
                        <button onclick={() => openEditHierarchyForm(h)} class="p-2 text-on-surface-variant hover:text-primary transition-colors" title={m.sm_title_edit_hierarchy()}>
                          <Papicon icon="edit" size={18} />
                        </button>
                        <button onclick={() => deleteHierarchy(h.id)} class="p-2 text-on-surface-variant hover:text-error transition-colors" title={m.sm_title_delete_hierarchy()}>
                          <Papicon icon="trash-2" size={18} />
                        </button>
                      {/if}
                    </div>
                  </div>

                  <!-- Roles Stack inside this Hierarchy -->
                  <div
                    class="space-y-3 min-h-20 p-2 rounded-lg transition-all {containerDragOverId === h.id ? 'bg-primary/5 border-2 border-dashed border-primary/40' : ''}"
                    role="list"
                    aria-label={m.sm_aria_roles_for({ name: h.name })}
                    ondragover={(event) => {
                      event.preventDefault();
                      containerDragOverId = h.id;
                    }}
                    ondragleave={() => {
                      containerDragOverId = null;
                    }}
                    ondrop={async (event) => {
                      event.preventDefault();
                      containerDragOverId = null;
                      if (draggedRoleId) {
                        await moveRoleToHierarchy(draggedRoleId, h.id);
                      }
                    }}
                  >
                    {#if hRoles.length > 0}
                      {#each hRoles as role (role.id)}
                        <div
                          class="group flex items-center justify-between gap-4 rounded-xl border border-outline-variant/20 bg-surface-container px-6 py-4 transition-all {roleDropTargetId === role.id ? 'border-primary bg-primary/5' : 'hover:border-primary/40 hover:bg-surface-container-high'}"
                          role="listitem"
                          ondragover={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            roleDropTargetId = role.id;
                          }}
                          ondrop={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (draggedRoleId) {
                              moveRoleInList(draggedRoleId, role.id);
                            }
                          }}
                        >
                          <div class="flex items-center gap-4 min-w-0">
                            <button
                              type="button"
                              class="flex shrink-0 cursor-grab items-center justify-center rounded-xl p-2.5 text-on-surface-variant/70 hover:bg-primary/10 hover:text-primary active:cursor-grabbing"
                              draggable="true"
                              ondragstart={() => startRoleDrag(role.id)}
                              ondragend={clearRoleDragState}
                              aria-label={m.sm_aria_move_role({ name: role.name })}
                            >
                              <Papicon icon="menu" size={20} />
                            </button>
                            <div class="min-w-0 flex-1">
                              <h5 class="text-sm font-semibold text-on-surface flex items-center gap-2">
                                {role.name}
                                {#if role.isResponsable}
                                  <span class="px-2 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20 text-xs font-semibold">{m.sm_role_chief_badge()}</span>
                                {/if}
                                <span class="inline-flex items-center rounded-full bg-outline-variant/20 px-2 py-0.5 text-2xs font-bold text-on-surface-variant">
                                  {m.sm_role_weight_label({ level: role.level })}
                                </span>
                              </h5>
                              <p class="mt-0.5 truncate text-xs font-medium text-on-surface-variant/75">
                                {#if role.discordRoleId}
                                  {m.sm_role_discord_prefix()} <span class="font-bold">@{availableDiscordRoles.find((entry) => entry.id === role.discordRoleId)?.name || role.discordRoleId}</span>
                                {:else}
                                  {m.sm_role_custom()}
                                {/if}
                              </p>
                            </div>
                          </div>
                          <div class="flex items-center gap-2 shrink-0">
                            {#if rolesAccess.canConfigure}
                              <button
                                onclick={() => openEditRoleModal(role)}
                                class="inline-flex items-center justify-center rounded-xl p-2 text-primary transition-colors hover:bg-primary/15 border border-primary/20 bg-primary/5"
                                title={m.sm_title_edit_role()}
                              >
                                <Papicon icon="edit" size={16} />
                              </button>
                              <button
                                onclick={() => removeStaffRole(role.id, role.name)}
                                class="inline-flex items-center justify-center rounded-xl p-2 text-error transition-colors hover:bg-error/15 border border-error/20 bg-error/5"
                                title={m.sm_title_delete_role()}
                              >
                                <Papicon icon="trash-2" size={16} />
                              </button>
                            {/if}
                          </div>
                        </div>
                      {/each}
                    {:else}
                      <p class="text-xs text-on-surface-variant/50 italic text-center py-4">{m.sm_no_roles_in_hierarchy()}</p>
                    {/if}
                  </div>
                </div>
              {/each}

              <!-- Roles without hierarchy -->
              <div class="premium-card rounded-xl p-6 border-t-4 border-slate-400 bg-surface-container-low">
                <div class="flex items-center justify-between mb-4">
                  <div>
                    <h4 class="text-lg font-semibold text-on-surface">{m.sm_roles_unlinked_title()}</h4>
                    <p class="text-xs text-on-surface-variant/75 mt-0.5">{m.sm_roles_unlinked_desc()}</p>
                  </div>
                </div>

                <div
                  class="space-y-3 min-h-20 p-2 rounded-lg transition-all {containerDragOverId === 'unlinked' ? 'bg-primary/5 border-2 border-dashed border-primary/40' : ''}"
                  role="list"
                  aria-label={m.sm_aria_roles_unlinked()}
                  ondragover={(event) => {
                    event.preventDefault();
                    containerDragOverId = 'unlinked';
                  }}
                  ondragleave={() => {
                    containerDragOverId = null;
                  }}
                  ondrop={async (event) => {
                    event.preventDefault();
                    containerDragOverId = null;
                    if (draggedRoleId) {
                      await moveRoleToHierarchy(draggedRoleId, null);
                    }
                  }}
                >
                  {#if unlinkedRoles.length > 0}
                    {#each unlinkedRoles as role (role.id)}
                      <div
                        class="group flex items-center justify-between gap-4 rounded-xl border border-outline-variant/20 bg-surface-container px-6 py-4 transition-all {roleDropTargetId === role.id ? 'border-primary bg-primary/5' : 'hover:border-primary/40 hover:bg-surface-container-high'}"
                        role="listitem"
                        ondragover={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          roleDropTargetId = role.id;
                        }}
                        ondrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (draggedRoleId) {
                            moveRoleInList(draggedRoleId, role.id);
                          }
                        }}
                      >
                        <div class="flex items-center gap-4 min-w-0">
                          <button
                            type="button"
                            class="flex shrink-0 cursor-grab items-center justify-center rounded-xl p-2.5 text-on-surface-variant/70 hover:bg-primary/10 hover:text-primary active:cursor-grabbing"
                            draggable="true"
                            ondragstart={() => startRoleDrag(role.id)}
                            ondragend={clearRoleDragState}
                            aria-label={m.sm_aria_move_role({ name: role.name })}
                          >
                            <Papicon icon="menu" size={20} />
                          </button>
                          <div class="min-w-0 flex-1">
                            <h5 class="text-sm font-semibold text-on-surface flex items-center gap-2">
                              {role.name}
                              <span class="inline-flex items-center rounded-full bg-outline-variant/20 px-2 py-0.5 text-2xs font-bold text-on-surface-variant">
                                {m.sm_role_weight_label({ level: role.level })}
                              </span>
                            </h5>
                            <p class="mt-0.5 truncate text-xs font-medium text-on-surface-variant/75">
                              {#if role.discordRoleId}
                                {m.sm_role_discord_prefix()} <span class="font-bold">@{availableDiscordRoles.find((entry) => entry.id === role.discordRoleId)?.name || role.discordRoleId}</span>
                              {:else}
                                {m.sm_role_custom()}
                              {/if}
                            </p>
                          </div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          {#if rolesAccess.canConfigure}
                            <button
                              onclick={() => openEditRoleModal(role)}
                              class="inline-flex items-center justify-center rounded-xl p-2 text-primary transition-colors hover:bg-primary/15 border border-primary/20 bg-primary/5"
                              title={m.sm_title_edit_role()}
                            >
                              <Papicon icon="edit" size={16} />
                            </button>
                            <button
                              onclick={() => removeStaffRole(role.id, role.name)}
                              class="inline-flex items-center justify-center rounded-xl p-2 text-error transition-colors hover:bg-error/15 border border-error/20 bg-error/5"
                              title={m.sm_title_delete_role()}
                            >
                              <Papicon icon="trash-2" size={16} />
                            </button>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  {:else}
                    <p class="text-xs text-on-surface-variant/50 italic text-center py-4">{m.sm_no_roles_unlinked()}</p>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        {/if}

      {:else if activeTab === 'organigramme'}
        {#if loadingStates.organigramme}
          <div class="p-8 flex items-center justify-center">
            <Skeleton width="w-full" height="h-[60vh]" rounded="rounded-xl" />
          </div>
        {:else}
          <OrgChart schema={hierarchySchema} />
        {/if}

      {:else if activeTab === 'warnings'}
        <div class="p-6 md:p-8 flex items-center justify-between border-b border-outline-variant/10 bg-surface-container-low/30">
          <div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_warn_title()}</h3>
            <p class="text-sm font-medium text-on-surface-variant/60 mt-1">{m.sm_warn_desc()}</p>
          </div>
          <button
            onclick={openWarnForm}
            class="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-primary/20 bg-primary/8 px-6 py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-white"
          >
            <Papicon icon={showWarnForm ? 'x' : 'plus'} size={14} />
            {showWarnForm ? m.common_cancel() : m.sm_btn_new_warning()}
          </button>
        </div>

        {#if showWarnForm}
          <div class="p-6 md:p-8 border-b border-primary/10 bg-primary/5 animate-in slide-in-from-top-4 fade-in duration-300">
            <div class="grid gap-6 md:grid-cols-2">
              <div class="space-y-4 md:col-span-2">
                <label class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">
                  {m.sm_field_target_member()}
                  <DiscordMemberLookup
                    {guildId}
                    bind:query={warnLookupQuery}
                    bind:selectedId={warnTargetUserId}
                    staffOnly={true}
                    placeholder={m.sm_placeholder_search_staff()}
                    selectedIdPlaceholder={m.sm_placeholder_staff_id_autofill()}
                  />
                </label>
              </div>

              <div class="space-y-4">
                <label>
                  <span class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_warn_reason()}</span>
                  <textarea
                    bind:value={warnReason}
                    placeholder={m.sm_placeholder_warn_reason()}
                    rows="3"
                    class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10 resize-none"
                  ></textarea>
                </label>
              </div>

              <div class="space-y-4 flex flex-col justify-between">
                <div>
                   <label for="warn-expires-at" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_expires_at()} {m.sm_optional_tag()}</label>
                   <input
                     id="warn-expires-at"
                     type="datetime-local"
                     bind:value={warnExpiresAt}
                     class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                   />
                </div>
                <div class="flex justify-end mt-4">
                  <button onclick={issueWarning} class="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-8 py-3 text-xs font-semibold text-white shadow-sm transition-all hover:bg-amber-600 active:scale-[0.98]">
                    <Papicon icon="gavel" size={14} />
                    {m.sm_btn_sanction()}
                  </button>
                </div>
              </div>
            </div>
          </div>
        {/if}

        {#if loadingStates.warnings}
          <div class="p-6 md:p-8 space-y-4">
            {#each Array(3) as _}
              <div class="h-16 w-full rounded-xl border border-outline-variant/10 bg-surface-container animate-pulse"></div>
            {/each}
          </div>
        {:else if staffWarnings.length > 0}
          <div class="p-6 md:p-8">
            <div class="overflow-hidden rounded-xl border border-outline-variant/10 bg-surface-container-low/50">
              <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                  <thead>
                    <tr class="bg-surface-container-high/30 text-xs font-semibold text-on-surface-variant/40">
                      <th class="px-6 py-4">{m.sm_col_member()}</th>
                      <th class="px-6 py-4">{m.sm_col_reason()}</th>
                      <th class="px-6 py-4">{m.sm_col_issued_by()}</th>
                      <th class="px-6 py-4 text-center">{m.sm_col_date()}</th>
                      <th class="px-6 py-4 text-center">{m.sm_col_status()}</th>
                      <th class="px-6 py-4 text-right">{m.sm_col_actions()}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-outline-variant/5">
                    {#each staffWarnings as warn (warn.id)}
                      <tr class="group hover:bg-primary/5 transition-colors">
                        <td class="px-6 py-4 whitespace-nowrap">
                          <div class="flex items-center gap-3">
                            <div class="h-9 w-9 rounded-full overflow-hidden bg-white/5 border border-white/10 shrink-0">
                              {#if warn.staffAvatarUrl}
                                <img src={warn.staffAvatarUrl} alt="" class="h-full w-full object-cover" />
                              {:else}
                                <div class="h-full w-full flex items-center justify-center text-on-surface-variant/30">
                                  <Papicon icon="user" size={16} />
                                </div>
                              {/if}
                            </div>
                            <div>
                              <div class="text-sm font-bold text-on-surface leading-none">{warn.staffDisplayName}</div>
                              <div class="text-2xs text-on-surface-variant/40 mt-1 font-mono">{warn.staffUserId}</div>
                            </div>
                          </div>
                        </td>
                        <td class="px-6 py-4">
                          <div class="text-sm text-on-surface-variant/80 max-w-md line-clamp-2" title={warn.reason}>
                            {warn.reason}
                          </div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap">
                          <div class="text-xs font-bold text-on-surface-variant/70">
                            {warn.issuedByTag}
                          </div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-center">
                          <div class="text-xs font-medium text-on-surface-variant/50">
                            {new Date(warn.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-center">
                          {#if warn.isActive}
                            <span class="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2.5 py-1 text-xs font-semibold text-warning border border-warning/20">
                              <span class="w-1 h-1 rounded-full bg-amber-600 animate-pulse"></span>
                              {m.sm_status_active()}
                            </span>
                          {:else}
                            <span class="inline-flex items-center rounded-full bg-outline-variant/10 px-2.5 py-1 text-xs font-semibold text-on-surface-variant/40">{m.sm_status_expired()}</span>
                          {/if}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-right">
                          <button
                            onclick={() => deleteWarning(warn.id)}
                            class="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-error/10 text-error transition-all hover:bg-rose-500 hover:text-white"
                            title={m.sm_title_delete_warning()}
                          >
                            <Papicon icon="trash-2" size={14} />
                          </button>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        {:else}
          <div class="p-16 flex flex-col items-center justify-center text-center">
            <div class="w-20 h-20 rounded-xl bg-warning/10 text-warning flex items-center justify-center shadow-inner">
              <Papicon icon="alert-triangle" size={40} />
            </div>
            <h3 class="mt-6 text-2xl font-semibold tracking-tighter text-on-surface">
              {m.sm_empty_warnings_title()}
            </h3>
            <p class="mt-3 max-w-xl text-sm leading-relaxed text-on-surface-variant/65">
              {m.sm_empty_warnings_desc()}
            </p>
          </div>
        {/if}

      {:else if activeTab === 'blacklist'}
         <div class="p-6 md:p-8 flex items-center justify-between border-b border-outline-variant/10 bg-surface-container-low/30">
          <div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_blacklist_title()}</h3>
            <p class="text-sm font-medium text-on-surface-variant/60 mt-1">{m.sm_blacklist_desc()}</p>
          </div>
          <button
            onclick={openBlacklistForm}
            class="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-error/20 bg-error/10 px-6 py-3 text-xs font-semibold text-error transition-colors hover:bg-rose-500 hover:text-white"
          >
            <Papicon icon={showBlacklistForm ? 'x' : 'slash'} size={14} />
            {showBlacklistForm ? m.common_cancel() : m.sm_btn_blacklist()}
          </button>
        </div>

        {#if showBlacklistForm}
          <div class="p-6 md:p-8 border-b border-error/10 bg-error/5 animate-in slide-in-from-top-4 fade-in duration-300">
            <div class="grid gap-6 md:grid-cols-2">
              <div class="space-y-4 md:col-span-2">
                <label>
                  <span class="block text-body-sm font-medium text-error/80 mb-2">{m.sm_field_blacklist_target()}</span>
                  <DiscordMemberLookup
                    {guildId}
                    bind:query={blacklistLookupQuery}
                    bind:selectedId={blacklistTargetUserId}
                    staffOnly={false}
                    placeholder={m.sm_placeholder_mention_or_id()}
                    selectedIdPlaceholder={m.sm_placeholder_discord_id_autofill()}
                  />
                </label>
              </div>

              <div class="space-y-4">
                <label>
                  <span class="block text-body-sm font-medium text-error/80 mb-2">{m.sm_field_blacklist_reason()}</span>
                  <textarea
                    bind:value={blacklistReason}
                    placeholder={m.sm_placeholder_blacklist_reason()}
                    rows="3"
                    class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-error/40 focus:ring-4 focus:ring-error/10 resize-none"
                  ></textarea>
                </label>
              </div>

              <div class="space-y-4 flex flex-col justify-between">
                <div>
                   <label for="blacklist-end-date" class="block text-body-sm font-medium text-error/80 mb-2">{m.sm_field_blacklist_end()}</label>
                   <input
                     id="blacklist-end-date"
                     type="date"
                     bind:value={blacklistEndDate}
                     class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-error/40 focus:ring-4 focus:ring-error/10"
                   />
                </div>
                <div class="flex justify-end mt-4">
                  <button onclick={blacklistStaff} class="inline-flex items-center justify-center gap-2 rounded-lg bg-rose-600 px-8 py-3 text-xs font-semibold text-white shadow-sm transition-all hover:bg-rose-700 active:scale-[0.98]">
                    <Papicon icon="slash" size={14} />
                    {m.sm_btn_apply_blacklist()}
                  </button>
                </div>
              </div>
            </div>
          </div>
        {/if}

        {#if blacklistedStaffMembers.length === 0}
          <div class="p-16 flex flex-col items-center justify-center text-center opacity-40">
            <div class="w-20 h-20 rounded-xl bg-error/10 text-error flex items-center justify-center shadow-inner mb-6">
              <Papicon icon="user-x" size={40} />
            </div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_blacklist_empty_title()}</h3>
            <p class="mt-3 max-w-xl text-sm leading-relaxed text-on-surface-variant/65">
               {m.sm_blacklist_empty_desc()}
            </p>
          </div>
        {:else}
          <div class="divide-y divide-outline-variant/10">
            {#each blacklistedStaffMembers as member (member.id)}
              <article class="group bg-transparent px-6 py-6 md:px-8 transition-all hover:bg-error/4">
                <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                  <div class="flex items-center gap-4 flex-1">
                    <div class="h-12 w-12 shrink-0 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant/70 border border-outline-variant/20 shadow-sm overflow-hidden">
                      {#if member.avatarUrl}
                        <img src={member.avatarUrl} alt="" class="h-full w-full object-cover" />
                      {:else}
                        <Papicon icon="user" size={24} />
                      {/if}
                    </div>
                    <div>
                      <h4 class="text-lg font-semibold text-on-surface leading-tight">
                        {member.displayName || member.username || m.sm_unknown_user()}
                      </h4>
                      <div class="flex items-center gap-3 mt-1.5 flex-wrap">
                        <span class="inline-flex items-center rounded-full border border-error/20 bg-error/10 px-2.5 py-0.5 text-xs font-semibold text-error">
                          {m.sm_blacklisted_badge()}
                        </span>
                        {#if member.blacklistEntries?.[0]?.reason}
                          <span class="text-xs font-medium text-error/80">
                            {m.sm_blacklist_reason_prefix({ reason: member.blacklistEntries[0].reason })}
                          </span>
                        {/if}
                        {#if member.blacklistEntries?.[0]?.endDate}
                          <span class="text-2xs font-medium text-on-surface-variant/70">
                            {m.sm_blacklist_until({ date: new Date(member.blacklistEntries[0].endDate).toLocaleDateString() })}
                          </span>
                        {:else}
                          <span class="text-2xs font-medium text-on-surface-variant/70">
                            {m.sm_permanent()}
                          </span>
                        {/if}
                      </div>
                    </div>
                  </div>

                  <div class="flex items-center gap-2 shrink-0">
                    {#if canModerate}
                      <button
                        onclick={() => removeStaffBlacklist(member.userId)}
                        class="inline-flex items-center gap-2 rounded-xl border border-error/30 bg-error/10 px-4 py-2 text-body-sm font-medium text-error transition-colors hover:bg-rose-600 hover:text-white"
                        title={m.sm_title_remove_blacklist()}
                      >
                        <Papicon icon="trash-2" size={16} />
                        {m.sm_btn_remove_blacklist()}
                      </button>
                    {/if}
                  </div>
                </div>
              </article>
            {/each}
          </div>
        {/if}

      {:else if activeTab === 'polls'}
        <div class="p-6 md:p-8 flex items-center justify-between border-b border-outline-variant/10 bg-surface-container-low/30">
          <div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_polls_title()}</h3>
            <p class="text-sm font-medium text-on-surface-variant/60 mt-1">{m.sm_polls_desc()}</p>
          </div>
          <button
            onclick={() => showPollForm = !showPollForm}
            class="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-primary/20 bg-primary/10 px-6 py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-white"
          >
            <Papicon icon={showPollForm ? 'x' : 'plus'} size={14} />
            {showPollForm ? m.common_cancel() : m.sm_btn_new_poll()}
          </button>
        </div>

        {#if showPollForm}
          <div class="p-6 md:p-8 border-b border-primary/10 bg-primary/5 animate-in slide-in-from-top-4 fade-in duration-300">
            <div class="grid gap-6 lg:grid-cols-2">
              <div class="space-y-4">
                <div>
                  <label for="poll-title" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_poll_title()}</label>
                  <FormInput id="poll-title" bind:value={newPollTitle} placeholder={m.sm_placeholder_poll_title()} className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10" />
                </div>
                <div>
                  <label for="poll-description" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_description()}</label>
                  <textarea id="poll-description" bind:value={newPollDescription} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10 h-32 resize-none" placeholder={m.sm_placeholder_poll_desc()}></textarea>
                </div>
                <div>
                  <label for="poll-closes-at" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_poll_closes()}</label>
                  <input id="poll-closes-at" type="datetime-local" bind:value={newPollClosesAt} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10" />
                </div>
              </div>
              <div class="space-y-4">
                <div class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_poll_options()}</div>
                <div class="space-y-3">
                  {#each newPollOptions as _option, i}
                    <div class="flex items-center gap-2">
                      <input bind:value={newPollOptions[i]} class="flex-1 rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10" placeholder={m.sm_placeholder_option_n({ n: i + 1 })} />
                      {#if newPollOptions.length > 2}
                        <button onclick={() => removePollOptionInput(i)} class="p-2 text-error hover:bg-error/10 rounded-xl transition-colors">
                          <Papicon icon="trash-2" size={20} />
                        </button>
                      {/if}
                    </div>
                  {/each}
                </div>
                <button onclick={addPollOptionInput} class="inline-flex items-center gap-2 text-body-sm font-medium text-primary/70 hover:text-primary transition-colors mt-2">
                  <Papicon icon="plus-circle" size={18} />
                  {m.sm_btn_add_option()}
                </button>
                <div class="pt-6 border-t border-outline-variant/10">
                   <button onclick={createPoll} disabled={isSavingPoll} class="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-8 py-4 text-xs font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-50">
                    <Papicon icon={isSavingPoll ? 'refresh-cw' : 'check-square'} size={14} class={isSavingPoll ? 'animate-spin' : ''} />
                    {m.sm_btn_publish_poll()}
                  </button>
                </div>
              </div>
            </div>
          </div>
        {/if}

        <div class="p-6 md:p-8 space-y-6">
          {#if loadingStates.polls}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {#each Array(4) as _}
                <div class="bg-surface-container px-6 py-6 rounded-xl border border-outline-variant/10">
                   <div class="flex justify-between items-start mb-6">
                      <div class="space-y-2">
                        <Skeleton width="w-24" height="h-4" rounded="rounded-full" />
                        <Skeleton width="w-48" height="h-6" />
                      </div>
                      <Skeleton width="w-8" height="h-8" rounded="rounded-lg" />
                   </div>
                   <div class="space-y-3 mb-6">
                      <Skeleton height="h-10" rounded="rounded-xl" />
                      <Skeleton height="h-10" rounded="rounded-xl" />
                   </div>
                   <div class="pt-4 border-t border-outline-variant/10 flex justify-between">
                      <Skeleton width="w-32" height="h-3" />
                      <Skeleton width="w-24" height="h-3" />
                   </div>
                </div>
              {/each}
            </div>
          {:else if polls.length === 0}
            <div class="p-16 flex flex-col items-center justify-center text-center opacity-40">
              <Papicon icon="list" size={60} />
              <p class="mt-4 text-sm font-semibold">{m.sm_empty_polls()}</p>
            </div>
          {:else}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {#each polls as poll (poll.id)}
                {@const isClosed = poll.status === 'CLOSED' || (poll.closesAt && new Date(poll.closesAt) < new Date())}
                {@const totalWeight = (poll.options as any[]).reduce((sum: number, opt: any) => {
                  const optVotes = (poll.votes as any[] | undefined)?.filter((v: any) => v.optionId === opt.id) || [];
                  return sum + optVotes.reduce((s: number, v: any) => s + (v.weight || 1), 0);
                }, 0)}
                {@const userVote = (poll.votes as any[] | undefined)?.find((v: any) => v.staffMember?.userId === authStore.user?.id)}
                <div class="bg-surface-container px-6 py-6 rounded-xl border border-outline-variant/10 group transition-all hover:border-primary/20">
                  <div class="flex items-start justify-between gap-4">
                    <div class="space-y-1">
                      <div class="flex items-center gap-2">
                        {#if isClosed}
                          <span class="inline-flex items-center rounded-full bg-surface-container-high px-2 py-0.5 text-2xs font-semibold uppercase text-on-surface-variant/60">{m.sm_poll_closed_badge()}</span>
                        {:else}
                          <span class="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-2xs font-semibold uppercase text-success animate-pulse">{m.sm_poll_ongoing_badge()}</span>
                        {/if}
                        <span class="text-2xs font-medium text-on-surface-variant/40">{m.sm_poll_by({ author: poll.author?.displayName || poll.author?.username })}</span>
                      </div>
                      <h4 class="text-lg font-semibold text-on-surface tracking-tight leading-tight">{poll.title}</h4>
                    </div>
                    {#if !isClosed && (accessLevel === 'admin' || canManageSettings)}
                       <button onclick={() => closePoll(poll.id)} class="p-2 text-on-surface-variant/40 hover:text-error transition-colors" title={m.sm_title_close_now()}>
                         <Papicon icon="x" size={20} />
                       </button>
                    {/if}
                  </div>
                  
                  {#if poll.description}
                    <p class="mt-3 text-xs text-on-surface-variant/70 leading-relaxed line-clamp-2">{poll.description}</p>
                  {/if}

                  <div class="mt-6 space-y-3">
                    {#each poll.options as option}
                      {@const optVotes = poll.votes?.filter((v: any) => v.optionId === option.id) || []}
                      {@const optWeight = optVotes.reduce((s: number, v: any) => s + (v.weight || 1), 0)}
                      {@const percent = totalWeight > 0 ? (optWeight / totalWeight) * 100 : 0}
                      {@const isSelected = userVote?.optionId === option.id}
                      
                      <div class="space-y-1.5">
                        <button 
                          onclick={() => castVote(poll.id, option.id)}
                          disabled={isClosed || !!userVote}
                          class="w-full relative overflow-hidden rounded-xl border p-3 flex items-center justify-between transition-all {isSelected ? 'border-primary bg-primary/5' : 'border-outline-variant/10 bg-surface-container-low hover:border-primary/30'} group/opt"
                        >
                          <span class="relative z-10 text-xs font-semibold {isSelected ? 'text-primary' : 'text-on-surface-variant group-hover/opt:text-on-surface'}">{option.text}</span>
                          {#if isSelected}
                             <Papicon icon="check-circle" size={14} class="relative z-10 text-primary" />
                          {/if}
                          {#if isClosed || userVote}
                            <div class="absolute inset-y-0 left-0 bg-primary/10 transition-all duration-1000" style="width: {percent}%"></div>
                          {/if}
                        </button>
                        {#if isClosed || userVote}
                           <div class="flex items-center justify-between px-1">
                             <div class="flex gap-1">
                                {#each optVotes as vote}
                                  <div class="h-1 w-3 rounded-full bg-primary/30" title={m.sm_poll_weight_title({ weight: vote.weight })}></div>
                                {/each}
                             </div>
                             <span class="text-2xs font-semibold text-on-surface-variant/50">{Math.round(percent)}% ({optWeight.toFixed(1)})</span>
                           </div>
                        {/if}
                      </div>
                    {/each}
                  </div>

                  <div class="mt-6 pt-4 border-t border-outline-variant/10 flex items-center justify-between">
                    <span class="text-xs font-semibold text-on-surface-variant/40">{m.sm_poll_total_votes({ total: totalWeight.toFixed(1) })}</span>
                    {#if poll.closesAt && !isClosed}
                      <span class="text-2xs font-medium text-warning/70 italic flex items-center gap-1">
                        <Papicon icon="clock" size={12} />
                        {m.sm_poll_ends_on({ date: new Date(poll.closesAt).toLocaleDateString() })}
                      </span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if activeTab === 'leadership'}
        <div class="p-6 md:p-8 space-y-8">
          <div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_leadership_title()}</h3>
            <p class="text-sm font-medium text-on-surface-variant/60 mt-1">{m.sm_leadership_desc()}</p>
          </div>

          <!-- Performance analysis (Charts) -->
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="premium-card p-6 rounded-xl space-y-4">
              <div class="flex items-center gap-3 mb-2">
                <div class="p-2 rounded-xl bg-primary/10 text-primary">
                  <Papicon icon="BarChart" size={18} />
                </div>
                <h4 class="text-sm font-semibold text-on-surface">{m.sm_chart_score_distribution()}</h4>
              </div>
              <div class="h-50">
                <Chart data={progressionChartData} type="bar" height={200} options={{ indexAxis: 'y', scales: { x: { beginAtZero: true, max: 100 } } }} />
              </div>
            </div>

            <div class="premium-card p-6 rounded-xl space-y-4">
              <div class="flex items-center gap-3 mb-2">
                <div class="p-2 rounded-xl bg-success/10 text-success">
                  <Papicon icon="Activity" size={18} />
                </div>
                <h4 class="text-sm font-semibold text-on-surface">{m.sm_chart_activity_comparison()}</h4>
              </div>
              <div class="h-50">
                <Chart data={activityChartData} type="bar" height={200} options={{ indexAxis: 'y', scales: { x: { beginAtZero: true } } }} />
              </div>
            </div>
          </div>

          <div class="overflow-x-auto rounded-xl border border-outline-variant/10 bg-surface-container-low/50">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="border-b border-outline-variant/10 text-xs font-medium text-on-surface-variant/40">
                  <th class="px-8 py-5">{m.sm_col_member()}</th>
                  <th class="px-8 py-5">{m.sm_col_progression_score()}</th>
                  <th class="px-8 py-5">{m.sm_col_activity()}</th>
                  <th class="px-8 py-5 text-right">{m.sm_col_status_alerts()}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/5">
                {#if loadingStates.leadership}
                  {#each Array(5) as _}
                    <tr>
                      <td class="px-8 py-5">
                        <div class="flex items-center gap-3">
                          <Skeleton width="w-9" height="h-9" circle={true} />
                          <div class="space-y-1">
                            <Skeleton width="w-24" height="h-4" />
                            <Skeleton width="w-16" height="h-3" />
                          </div>
                        </div>
                      </td>
                      <td class="px-8 py-5"><Skeleton width="w-32" height="h-4" /></td>
                      <td class="px-8 py-5"><Skeleton width="w-24" height="h-10" /></td>
                      <td class="px-8 py-5 text-right"><Skeleton width="w-20" height="h-5" rounded="rounded-full" class="ml-auto" /></td>
                    </tr>
                  {/each}
                {:else}
                  {#each leadershipMetrics as metric}
                  {@const member = staffMembers.find(sm => sm.userId === metric.staffUserId)}
                  <tr class="group hover:bg-primary/4 transition-colors">
                    <td class="px-8 py-5">
                      <div class="flex items-center gap-3">
                        <div class="h-9 w-9 rounded-full bg-surface-container-high border border-outline-variant/20 flex items-center justify-center text-xs font-semibold">
                          {member?.username?.substring(0, 1).toUpperCase() || '?'}
                        </div>
                        <div>
                          <div class="text-sm font-semibold text-on-surface tracking-tight">{member?.displayName || member?.username}</div>
                          <div class="text-2xs font-bold text-on-surface-variant/50 uppercase">{member?.grade}</div>
                        </div>
                      </div>
                    </td>
                    <td class="px-8 py-5">
                      <div class="flex items-center gap-4">
                        <div class="flex-1 h-2 bg-surface-container-high rounded-full overflow-hidden max-w-25">
                          <div class="h-full bg-primary" style="width: {metric.progressionScore}%"></div>
                        </div>
                        <span class="text-xs font-semibold text-primary">{metric.progressionScore}/100</span>
                      </div>
                    </td>
                    <td class="px-8 py-5">
                      <div class="flex flex-col gap-1">
                        <div class="text-2xs font-bold">
                          {m.sm_avg_prefix()} <span class="text-on-surface">{metric.avg30d}</span> {m.sm_msg_per_day()}
                        </div>
                        <div class="text-2xs font-medium text-on-surface-variant/60">
                          {m.sm_week_prefix()} <span class={metric.avg7d < metric.avg30d * 0.5 ? 'text-warning font-bold' : ''}>{metric.avg7d}</span> {m.sm_msg_per_day()}
                        </div>
                      </div>
                    </td>
                    <td class="px-8 py-5 text-right">
                       {#if metric.hasInactivityAlert}
                         <span class="inline-flex items-center gap-1.5 rounded-full bg-warning/10 border border-warning/20 px-3 py-1 text-2xs font-semibold text-warning animate-pulse">
                           <Papicon icon="alert-triangle" size={14} />
                           {m.sm_inactivity_detected()}
                         </span>
                       {:else}
                         <span class="inline-flex items-center gap-1.5 rounded-full bg-success/10 border border-success/20 px-3 py-1 text-2xs font-semibold text-success">
                           <Papicon icon="check-circle" size={14} />
                           {m.sm_active_badge()}
                         </span>
                       {/if}
                    </td>
                  </tr>
                {/each}
                {/if}
              </tbody>
            </table>
          </div>
        </div>

      {:else if activeTab === 'permissions'}
        <div class="p-6 md:p-8 space-y-12">
          <div>
            <h3 class="text-2xl font-semibold tracking-tighter text-on-surface flex items-center gap-3">
              <Papicon icon="lock" size={28} class="text-primary" />
              {m.sm_perms_title()}
            </h3>
            <p class="text-sm font-medium text-on-surface-variant/60 mt-1">{m.sm_perms_desc()}</p>
          </div>

          <div class="grid grid-cols-1 gap-8">
            <RolePermissionSettings
              title={m.sm_perms_directory_title()}
              description={m.sm_perms_directory_desc()}
              featureKey="staff_directory"
            />

            <RolePermissionSettings
              title={m.sm_perms_roles_title()}
              description={m.sm_perms_roles_desc()}
              featureKey="staff_roles"
            />
          </div>
        </div>
      {/if}

    </div>
  {/if}
</div>

<MemberCaseModal
  open={caseModalOpen}
  userId={caseSelectedUserId}
  userName={caseSelectedUserName}
  caseData={caseData}
  loading={caseLoading}
  error={caseError}
  onClose={() => caseModalOpen = false}
  onSelectUser={(newUserId) => {
    const foundNode = caseData?.interactionGraph?.nodes?.find((n: any) => n.id === newUserId);
    const label = foundNode?.label || 'Membre';
    openMemberCase(newUserId, label);
  }}
/>

<!-- Modal Configuration -->
{#if showConfigMenu}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <div
      class="absolute inset-0 bg-surface-container-lowest/80 transition-opacity"
      role="button"
      tabindex="0"
      aria-label={m.sm_aria_close_config()}
      onclick={() => showConfigMenu = false}
      onkeydown={(e) => {
        if (e.key === 'Escape') showConfigMenu = false;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          showConfigMenu = false;
        }
      }}
    ></div>
    
    <div class="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-outline-variant/30 bg-surface shadow-sm">
      <div class="sticky top-0 z-10 flex items-center justify-between border-b border-outline-variant/20 bg-surface/80 p-6 md:px-8">
        <div>
          <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">{m.sm_config_modal_title()}</h3>
          <p class="text-sm font-medium text-on-surface-variant/75 mt-1">{m.sm_config_modal_desc()}</p>
        </div>
        <div class="flex items-center gap-4">
          {#if isSavingConfig}
            <span class="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <span class="relative flex h-2 w-2">
                <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75"></span>
                <span class="relative inline-flex h-2 w-2 rounded-full bg-primary"></span>
              </span>
              {m.sm_saving()}
            </span>
          {/if}
          <button onclick={() => showConfigMenu = false} class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors">
            <Papicon icon="x" size={20} />
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-6 p-6 md:p-8 lg:grid-cols-2">
        <!-- Bloc Sanctions / Seuils -->
        <div class="premium-card relative overflow-hidden rounded-xl border border-error/15 bg-surface-container-low p-6">
          <div class="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-error/5 blur-none hidden"></div>
          
          <div class="relative mb-6 flex items-center gap-4">
            <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-error/10 text-error shadow-inner">
              <Papicon icon="alert-triangle" size={24} />
            </div>
            <div>
              <h4 class="text-lg font-semibold tracking-tight text-on-surface">{m.sm_sanctions_thresholds_title()}</h4>
              <p class="text-xs text-on-surface-variant/80">{m.sm_sanctions_thresholds_desc()}</p>
            </div>
          </div>

          <div class="space-y-6">
            <div>
              <span class="mb-3 block text-xs font-semibold text-on-surface-variant/60">{m.sm_execution_mode()}</span>
              <div class="flex gap-2 rounded-lg border border-outline-variant/20 bg-surface p-1">
                <label class="flex-1 cursor-pointer">
                  <input type="radio" name="actionMode" value="validation" checked={actionMode === 'validation'} onchange={() => { actionMode = 'validation'; saveStaffConfig(); }} class="peer sr-only" />
                  <div class="rounded-xl px-3 py-2 text-center text-xs font-bold transition-all peer-checked:bg-primary/10 peer-checked:text-primary peer-checked:shadow-sm">
                    <Papicon icon="user-check" size={14} class="mb-1 mx-auto" />
                    {m.sm_mode_approval()}
                  </div>
                </label>
                <label class="flex-1 cursor-pointer">
                  <input type="radio" name="actionMode" value="auto" checked={actionMode === 'auto'} onchange={() => { actionMode = 'auto'; saveStaffConfig(); }} class="peer sr-only" />
                  <div class="rounded-xl px-3 py-2 text-center text-xs font-bold transition-all bg-error/10 peer-checked:text-error peer-checked:shadow-sm">
                    <Papicon icon="zap" size={14} class="mb-1 mx-auto" />
                    {m.sm_mode_auto()}
                  </div>
                </label>
              </div>
            </div>

            <div>
              <span class="mb-3 block text-xs font-semibold text-on-surface-variant/60">{m.sm_warn_thresholds()}</span>
              <div class="flex gap-4">
                <div class="flex-1 rounded-lg border border-orange-500/20 bg-orange-500/5 p-4">
                  <div class="flex items-center justify-between mb-2">
                     <span class="text-xs font-bold text-orange-700">{m.sm_threshold_demotion()}</span>
                     <Papicon icon="chevrons-down" size={16} class="text-orange-600/50" />
                  </div>
                  <div class="flex items-center gap-2">
                    <input type="number" min="0" bind:value={warnsToDemote} onchange={saveStaffConfig} class="w-full rounded-xl border border-outline-variant/30 bg-surface px-3 py-2 text-center text-lg font-semibold text-on-surface outline-none transition focus:border-orange-500/50 focus:ring-2 focus:ring-orange-500/20" />
                    <span class="text-2xs font-bold uppercase text-on-surface-variant/60">{m.sm_warn_unit()}</span>
                  </div>
                </div>
                <div class="flex-1 rounded-lg border border-error/20 bg-error/5 p-4">
                  <div class="flex items-center justify-between mb-2">
                     <span class="text-xs font-bold text-error">{m.sm_threshold_blacklist()}</span>
                     <Papicon icon="shield-off" size={16} class="text-error/50" />
                  </div>
                   <div class="flex items-center gap-2">
                    <input type="number" min="0" bind:value={warnsToBlacklist} onchange={saveStaffConfig} class="w-full rounded-xl border border-outline-variant/30 bg-surface px-3 py-2 text-center text-lg font-semibold text-on-surface outline-none transition focus:border-error/50 focus:ring-2 focus:ring-error/20" />
                    <span class="text-2xs font-bold uppercase text-on-surface-variant/60">{m.sm_warn_unit()}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="space-y-1">
              <label class="flex cursor-pointer items-center justify-between rounded-lg border border-outline-variant/15 bg-surface px-4 py-3 hover:bg-surface-container-high transition-colors">
                <div class="flex items-center gap-3">
                  <Papicon icon="user-minus" size={18} class="text-on-surface-variant/60" />
                  <div>
                    <span class="block text-sm font-bold text-on-surface">{m.sm_toggle_remove_roles_label()}</span>
                    <span class="block text-xs text-on-surface-variant">{m.sm_toggle_remove_roles_desc()}</span>
                  </div>
                </div>
                <ToggleSwitch checked={demoteRemoveAllRoles} onToggle={(v: boolean) => { demoteRemoveAllRoles = v; saveStaffConfig(); }} size="sm" activeClass="bg-amber-500" />
              </label>

              <label class="flex cursor-pointer items-center justify-between rounded-lg border border-outline-variant/15 bg-surface px-4 py-3 hover:bg-surface-container-high transition-colors">
                <div class="flex items-center gap-3">
                  <Papicon icon="lock" size={18} class="text-on-surface-variant/60" />
                  <div>
                    <span class="block text-sm font-bold text-on-surface">{m.sm_toggle_perma_blacklist_label()}</span>
                    <span class="block text-xs text-on-surface-variant">{m.sm_toggle_perma_blacklist_desc()}</span>
                  </div>
                </div>
                <ToggleSwitch checked={blacklistPermanentByDefault} onToggle={(v: boolean) => { blacklistPermanentByDefault = v; saveStaffConfig(); }} size="sm" activeClass="bg-rose-500" />
              </label>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
{/if}

<!-- Modal Nouvelle / Modifier Hiérarchie -->
{#if showAddHierarchyForm}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <div
      class="absolute inset-0 bg-surface-container-lowest/80 transition-opacity"
      role="button"
      tabindex="0"
      aria-label={m.sm_aria_close()}
      onclick={() => showAddHierarchyForm = false}
      onkeydown={(e) => { if (e.key === 'Escape') showAddHierarchyForm = false; }}
    ></div>

    <div class="relative w-full max-w-lg rounded-xl border border-outline-variant/30 bg-surface p-8 shadow-sm animate-in zoom-in-95 duration-200">
      <div class="flex items-center justify-between mb-6">
        <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">
          {editingHierarchy ? m.sm_modal_edit_hierarchy_title() : m.sm_btn_new_hierarchy()}
        </h3>
        <button onclick={() => showAddHierarchyForm = false} class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors">
          <Papicon icon="x" size={20} />
        </button>
      </div>

      <div class="space-y-4">
        <div>
          <label for="hierarchy-name" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_hierarchy_name()}</label>
          <input id="hierarchy-name" type="text" bind:value={newHierarchyName} placeholder={m.sm_placeholder_hierarchy_name()} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10" />
        </div>

        <div>
          <label for="hierarchy-desc" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_description()}</label>
          <textarea id="hierarchy-desc" bind:value={newHierarchyDescription} placeholder={m.sm_placeholder_hierarchy_desc()} rows="3" class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10 resize-none"></textarea>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="hierarchy-color" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_color()}</label>
            <div class="flex gap-2">
              <input id="hierarchy-color" type="color" bind:value={newHierarchyColor} class="h-11 w-12 rounded-xl border border-outline-variant/20 bg-surface-container-low p-1 cursor-pointer" />
              <input type="text" bind:value={newHierarchyColor} class="flex-1 rounded-lg border border-outline-variant/20 bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none transition focus:border-primary/40" />
            </div>
          </div>
          <div>
            <label for="hierarchy-icon" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_emoji()}</label>
            <div class="flex gap-2">
              <input id="hierarchy-icon" type="text" bind:value={newHierarchyIcon} placeholder="🔵, 🛡️, 🎭..." class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10" />
              <EmojiPicker bind:value={newHierarchyIcon} />
            </div>
          </div>
        </div>

        <div>
          <label for="hierarchy-role" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_hierarchy_role()} {m.sm_optional_tag()}</label>
          <select id="hierarchy-role" bind:value={newHierarchyDiscordRoleId} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10">
            <option value="">{m.sm_none_option()}</option>
            {#each availableDiscordRoles as dr}
              <option value={dr.id}>{dr.name}</option>
            {/each}
          </select>
        </div>

        <div>
          <label for="hierarchy-resp" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_hierarchy_responsible_member()} {m.sm_optional_tag()}</label>
          <select id="hierarchy-resp" bind:value={newHierarchyResponsableUserId} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10">
            <option value="">{m.sm_none_option()}</option>
            {#each staffMembers as sm}
              <option value={sm.userId}>{sm.displayName || sm.username || sm.userId}</option>
            {/each}
          </select>
        </div>

        <div>
          <label for="hierarchy-parent" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_hierarchy_parent()} {m.sm_optional_tag()}</label>
          <select id="hierarchy-parent" bind:value={newHierarchyParentId} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10">
            <option value="">{m.sm_none_alt_option()}</option>
            {#each hierarchies.filter((h) => !editingHierarchy || h.id !== editingHierarchy.id) as h}
              <option value={h.id}>{h.name}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="mt-8 flex justify-end gap-3">
        <button onclick={() => showAddHierarchyForm = false} class="px-6 py-3 rounded-lg border border-outline-variant/20 bg-surface-container-low hover:bg-surface-container text-body-sm font-medium text-on-surface transition-all">
          {m.common_cancel()}
        </button>
        <button onclick={saveHierarchy} disabled={isSavingHierarchy || !newHierarchyName.trim()} class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-body-sm font-medium text-white transition-all active:scale-[0.98] disabled:opacity-50">
          {isSavingHierarchy ? m.sm_saving_ellipsis() : m.common_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Modal Importer depuis Discord -->
{#if showImportModal && importHierarchyTarget}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <div
      class="absolute inset-0 bg-surface-container-lowest/80 transition-opacity"
      role="button"
      tabindex="0"
      aria-label={m.sm_aria_close()}
      onclick={() => showImportModal = false}
      onkeydown={(e) => { if (e.key === 'Escape') showImportModal = false; }}
    ></div>

    <div class="relative w-full max-w-lg rounded-xl border border-outline-variant/30 bg-surface p-8 shadow-sm animate-in zoom-in-95 duration-200">
      <div class="flex items-center justify-between mb-6">
        <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">
          {m.sm_modal_import_title({ name: importHierarchyTarget.name })}
        </h3>
        <button onclick={() => showImportModal = false} class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors">
          <Papicon icon="x" size={20} />
        </button>
      </div>

      {#if importResult}
        <div class="bg-success/10 border border-success/20 rounded-lg p-4 text-success space-y-2 mb-6">
          <p class="font-bold">{m.sm_import_success()}</p>
          <ul class="text-xs list-disc list-inside">
            <li>{m.sm_import_total({ n: importResult.total })}</li>
            <li>{m.sm_import_imported({ n: importResult.imported })}</li>
            <li>{m.sm_import_skipped({ n: importResult.skipped })}</li>
          </ul>
        </div>
      {/if}

      <div class="space-y-4">
        <div>
          <label for="import-role-select" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_import_role()}</label>
          <select id="import-role-select" bind:value={importDiscordRoleId} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10">
            <option value="">{m.sm_option_choose_role()}</option>
            {#each availableDiscordRoles as dr}
              <option value={dr.id}>{dr.name}</option>
            {/each}
          </select>
        </div>

        <div>
          <label for="import-grade-select" class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_field_import_grade()}</label>
          <select id="import-grade-select" bind:value={importGradeName} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10">
            <option value="">{m.sm_option_choose_grade()}</option>
            {#each getOrderedStaffRoles().filter(r => r.hierarchyId === importHierarchyTarget?.id) as r}
              <option value={r.name}>{r.name}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="mt-8 flex justify-end gap-3">
        <button onclick={() => showImportModal = false} class="px-6 py-3 rounded-lg border border-outline-variant/20 bg-surface-container-low hover:bg-surface-container text-body-sm font-medium text-on-surface transition-all">
          {importResult ? m.common_close() : m.common_cancel()}
        </button>
        {#if !importResult}
          <button onclick={runImport} disabled={isImporting || !importDiscordRoleId || !importGradeName} class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-body-sm font-medium text-white transition-all active:scale-[0.98] disabled:opacity-50">
            {isImporting ? m.sm_importing() : m.sm_btn_launch_import()}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Modal Gérer les hiérarchies d'un membre -->
{#if showMemberHierarchyGradeForm && memberHierarchyGradeTarget}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <div
      class="absolute inset-0 bg-surface-container-lowest/80 transition-opacity"
      role="button"
      tabindex="0"
      aria-label={m.sm_aria_close()}
      onclick={() => showMemberHierarchyGradeForm = false}
      onkeydown={(e) => { if (e.key === 'Escape') showMemberHierarchyGradeForm = false; }}
    ></div>

    <div class="relative w-full max-w-lg rounded-xl border border-outline-variant/30 bg-surface p-8 shadow-sm animate-in zoom-in-95 duration-200">
      <div class="flex items-center justify-between mb-6">
        <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">
          {m.sm_modal_member_hierarchies_title({ name: memberHierarchyGradeTarget.displayName || memberHierarchyGradeTarget.username })}
        </h3>
        <button onclick={() => showMemberHierarchyGradeForm = false} class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors">
          <Papicon icon="x" size={20} />
        </button>
      </div>

      <!-- Existing Hierarchies list -->
      <div class="mb-6 space-y-2">
        <span class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_current_grades()}</span>
        {#if memberHierarchyGradeTarget?.hierarchyGrades && memberHierarchyGradeTarget.hierarchyGrades.length > 0}
          <div class="divide-y divide-outline-variant/10 border border-outline-variant/15 rounded-lg bg-surface-container-low overflow-hidden">
            {#each memberHierarchyGradeTarget.hierarchyGrades as hGrade}
              <div class="flex items-center justify-between px-4 py-3 text-sm">
                <div class="flex items-center gap-2">
                  <span>{hGrade.hierarchy?.icon || '🔵'}</span>
                  <span class="font-bold">{hGrade.hierarchy?.name}</span>
                  <span class="text-on-surface-variant/75">- {hGrade.grade}</span>
                </div>
                <button onclick={() => removeMemberHierarchy(memberHierarchyGradeTarget?.userId || '', hGrade.hierarchyId)} class="text-error hover:text-error text-body-sm font-medium">
                  {m.sm_confirm_remove_btn()}
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-xs text-on-surface-variant/50 italic py-2">{m.sm_no_secondary_hierarchy()}</p>
        {/if}
      </div>

      <!-- Form to add new hierarchy grade -->
      <div class="space-y-4 pt-4 border-t border-outline-variant/10">
        <span class="block text-body-sm font-medium text-on-surface-variant/70 mb-2">{m.sm_associate_new_hierarchy()}</span>

        <div>
          <label for="member-h-select" class="block text-xs font-bold text-on-surface-variant/60 mb-2">{m.sm_field_hierarchy()}</label>
          <select
            id="member-h-select"
            bind:value={selectedMemberHierarchyId}
            onchange={(event) => {
              const hierarchyId = (event.currentTarget as HTMLSelectElement).value;
              selectedMemberHierarchyId = hierarchyId;

              if (!hierarchyId || !memberHierarchyGradeTarget) {
                selectedMemberHierarchyGrade = '';
                return;
              }

              const existingGrade = memberHierarchyGradeTarget.hierarchyGrades?.find((entry) => entry.hierarchyId === hierarchyId)?.grade;
              selectedMemberHierarchyGrade = existingGrade || getOrderedStaffRoles().find((role) => role.hierarchyId === hierarchyId)?.name || '';
            }}
            class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
          >
            <option value="">{m.sm_option_choose_hierarchy()}</option>
            {#each hierarchies as h}
              <option value={h.id}>
                {h.name}{memberHierarchyGradeTarget?.hierarchyGrades?.some((hg) => hg.hierarchyId === h.id) ? m.sm_already_linked_suffix() : ''}
              </option>
            {/each}
          </select>
        </div>

        {#if selectedMemberHierarchyId}
          <div>
            <label for="member-g-select" class="block text-xs font-bold text-on-surface-variant/60 mb-2">{m.sm_field_grade()}</label>
            <select id="member-g-select" bind:value={selectedMemberHierarchyGrade} class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10">
              <option value="">{m.sm_option_choose_grade()}</option>
              {#each getOrderedStaffRoles().filter(r => r.hierarchyId === selectedMemberHierarchyId) as r}
                <option value={r.name}>{r.name}</option>
              {/each}
            </select>
          </div>
        {/if}
      </div>

      <div class="mt-8 flex justify-end gap-3">
        <button onclick={() => showMemberHierarchyGradeForm = false} class="px-6 py-3 rounded-lg border border-outline-variant/20 bg-surface-container-low hover:bg-surface-container text-body-sm font-medium text-on-surface transition-all">
          {m.common_close()}
        </button>
        <button onclick={saveMemberHierarchyGrade} disabled={isSavingMemberHierarchyGrade || !selectedMemberHierarchyId || !selectedMemberHierarchyGrade} class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-body-sm font-medium text-white transition-all active:scale-[0.98] disabled:opacity-50">
          {isSavingMemberHierarchyGrade ? m.sm_adding() : m.common_add()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Modal Éditer un Rôle -->
{#if showEditRoleModal && editingRole}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
    <div
      class="absolute inset-0 bg-surface-container-lowest/80 transition-opacity"
      role="button"
      tabindex="0"
      aria-label={m.sm_aria_close()}
      onclick={() => { showEditRoleModal = false; editingRole = null; }}
      onkeydown={(e) => { if (e.key === 'Escape') { showEditRoleModal = false; editingRole = null; } }}
    ></div>

    <div class="relative w-full max-w-lg rounded-xl border border-outline-variant/30 bg-surface p-8 shadow-sm animate-in zoom-in-95 duration-200">
      <div class="flex items-center justify-between mb-6">
        <h3 class="text-2xl font-semibold tracking-tighter text-on-surface">
          {m.sm_title_edit_role()}
        </h3>
        <button onclick={() => { showEditRoleModal = false; editingRole = null; }} class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors">
          <Papicon icon="x" size={20} />
        </button>
      </div>

      <div class="space-y-4">
        <div>
          <label for="edit-role-name" class="block text-xs font-bold text-on-surface-variant/60 mb-2">{m.sm_modal_edit_role_field_name()}</label>
          <input
            id="edit-role-name"
            type="text"
            bind:value={editRoleName}
            class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
          />
        </div>

        <div>
          <label for="edit-role-level" class="block text-xs font-bold text-on-surface-variant/60 mb-2">{m.sm_field_role_weight()}</label>
          <input
            id="edit-role-level"
            type="number"
            min="1"
            max="10000"
            bind:value={editRoleLevel}
            class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
          />
        </div>

        <div>
          <label for="edit-role-color" class="block text-xs font-bold text-on-surface-variant/60 mb-2">{m.sm_field_color_hex_optional()}</label>
          <input
            id="edit-role-color"
            type="text"
            placeholder="#3b82f6"
            bind:value={editRoleColor}
            class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
          />
        </div>

        <div>
          <label for="edit-role-discord" class="block text-xs font-bold text-on-surface-variant/60 mb-2">{m.sm_field_linked_discord_role()}</label>
          <select
            id="edit-role-discord"
            bind:value={editRoleDiscordRoleId}
            class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
          >
            <option value="">{m.sm_none_option()}</option>
            {#each availableDiscordRoles as dr}
              <option value={dr.id}>{dr.name}</option>
            {/each}
          </select>
        </div>

        <div>
          <label for="edit-role-hierarchy" class="block text-xs font-bold text-on-surface-variant/60 mb-2">{m.sm_field_hierarchy_assoc()}</label>
          <select
            id="edit-role-hierarchy"
            bind:value={editRoleHierarchyId}
            class="w-full rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
          >
            <option value="">{m.sm_none_out_of_hierarchy()}</option>
            {#each hierarchies as h}
              <option value={h.id}>{h.name}</option>
            {/each}
          </select>
        </div>

        <div class="flex items-center gap-3 pt-2">
          <ToggleSwitch
            checked={editRoleIsResponsable}
            onToggle={(v: boolean) => editRoleIsResponsable = v}
          />
          <span class="text-body-sm font-medium text-on-surface-variant/70">{m.sm_toggle_hierarchy_chief()}</span>
        </div>
      </div>

      <div class="mt-8 flex justify-end gap-3">
        <button onclick={() => { showEditRoleModal = false; editingRole = null; }} class="px-6 py-3 rounded-lg border border-outline-variant/20 bg-surface-container-low hover:bg-surface-container text-body-sm font-medium text-on-surface transition-all">
          {m.common_cancel()}
        </button>
        <button onclick={saveRoleEdit} class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-body-sm font-medium text-white transition-all hover:active:scale-[0.98]">
          {m.common_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

