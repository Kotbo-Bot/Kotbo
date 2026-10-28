<script lang="ts">
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, Button, Callout } from '../lib/components/ui';
  import { authStore } from '../lib/stores/auth.svelte';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { fetchMemberCase } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import OrgChart from '../lib/components/OrgChart.svelte';
  import { staff, STAFF_TABS, type StaffTab } from '../lib/components/staff/staffStore.svelte';
  import StaffDirectory from '../lib/components/staff/StaffDirectory.svelte';
  import StaffRoles from '../lib/components/staff/StaffRoles.svelte';
  import StaffListPanels from '../lib/components/staff/StaffListPanels.svelte';
  import StaffWarnings from '../lib/components/staff/StaffWarnings.svelte';
  import StaffBlacklist from '../lib/components/staff/StaffBlacklist.svelte';
  import StaffPolls from '../lib/components/staff/StaffPolls.svelte';
  import StaffLeadership from '../lib/components/staff/StaffLeadership.svelte';
  import StaffDialogs from '../lib/components/staff/StaffDialogs.svelte';
  import StaffCaseTab from '../lib/components/staff/StaffCaseTab.svelte';
  import { m } from '../lib/i18n';
  import { errorMessage } from '@kotbo/shared';

  function isStaffTab(value: string | null | undefined): value is StaffTab {
    return !!value && STAFF_TABS.includes(value as StaffTab);
  }

  let activeTab = $state<StaffTab>('members');

  const tabVisible = $derived<Record<StaffTab, boolean>>({
    members: !!staff.directoryAccess.canView || staff.isAdmin,
    roles: !!staff.rolesAccess.canView || staff.isAdmin,
    organigramme: !!staff.directoryAccess.canView || staff.isAdmin,
    warnings: staff.canModerate,
    blacklist: staff.canModerate,
    polls: staff.canModerate,
    leadership: staff.canModerate,
    permissions: staff.canManageSettings,
  });

  const hasAccess = $derived(staff.isAdmin || !!staff.directoryAccess.canView || !!staff.rolesAccess.canView);

  $effect(() => {
    const path = $router.path;
    // L'onglet Tutorat a ete fondu dans la page du meme nom.
    if (path.startsWith('/staff-management/tutoring')) {
      router.goto('/tutoring');
      return;
    }
    const tab = resolveTabFromUrl('/staff-management', STAFF_TABS, 'members');
    if (isStaffTab(tab) && tab !== activeTab) {
      activeTab = tab;
      if (staff.guildId) void staff.loadTab(tab);
    }
  });

  function switchTab(tab: StaffTab) {
    gotoTab('/staff-management', tab, 'members');
    void staff.loadTab(tab);
  }

  // Chargement : une fois par serveur et par session.
  let loadedFor = '';
  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (!guildId || !authStore.token || !hasAccess) return;
    const key = `${guildId}:${authStore.token}`;
    if (key === loadedFor) return;
    loadedFor = key;
    staff.reset(guildId);
    void staff.loadInitial(activeTab);
  });

  // ── Compteurs ──
  const myOpenVotes = $derived(
    staff.openPolls.filter((poll) => !(poll.votes ?? []).some((v) => (v.staffMember?.userId ?? v.userId) === authStore.user?.id)).length,
  );
  const suspendedCount = $derived(staff.activeMembers.filter((s) => !!s.suspendedAt).length);
  const tutorCount = $derived(staff.activeMembers.filter((s) => s.isTutor).length);
  const nearThreshold = $derived(
    staff.activeMembers.filter((s) => (s.warnings?.length ?? 0) > 0 && (s.warnings?.length ?? 0) >= (staff.config.warnsToDemote || 3) - 1).length,
  );

  type Stat = { id: StaffTab; label: string; icon: string; value: string; note: string; tone: string; loading: boolean };
  const stats = $derived<Stat[]>([
    {
      id: 'members',
      label: m.sx_kpi_team(),
      icon: 'users',
      value: String(staff.activeMembers.length),
      note: [tutorCount ? m.sx_kpi_tutors({ n: tutorCount }) : '', suspendedCount ? m.sx_kpi_suspended({ n: suspendedCount }) : '']
        .filter(Boolean).join(' · ') || m.sx_kpi_all_active(),
      tone: '',
      loading: staff.loading.members && staff.members.length === 0,
    },
    {
      id: 'warnings',
      label: m.sx_kpi_warnings(),
      icon: 'alert-triangle',
      value: String(staff.activeWarningCount),
      note: nearThreshold ? m.sx_kpi_near({ n: nearThreshold }) : m.sx_kpi_no_risk(),
      tone: nearThreshold ? 'text-warning' : '',
      loading: staff.loading.members && staff.members.length === 0,
    },
    {
      id: 'leadership',
      label: m.sx_kpi_activity(),
      icon: 'activity',
      value: staff.inactiveCount ? String(staff.inactiveCount) : '0',
      note: staff.inactiveCount ? m.sx_kpi_in_decline() : m.sx_kpi_all_steady(),
      tone: staff.inactiveCount ? 'text-warning' : '',
      loading: staff.loading.leadership && staff.leadership.length === 0,
    },
    {
      id: 'polls',
      label: m.sx_kpi_polls(),
      icon: 'bar-chart',
      value: String(staff.openPolls.length),
      note: myOpenVotes ? m.sx_kpi_to_vote({ n: myOpenVotes }) : m.sx_kpi_up_to_date(),
      tone: '',
      loading: staff.loading.polls && staff.polls.length === 0,
    },
  ]);

  const visibleStats = $derived(stats.filter((stat) => tabVisible[stat.id]));

  const tabBadges = $derived<Partial<Record<StaffTab, number>>>({
    members: staff.activeMembers.length,
    warnings: staff.activeWarningCount,
    blacklist: staff.blacklistedMembers.length,
    polls: myOpenVotes,
  });

  const tabs = $derived(
    pageTabItems('/staff-management', (id) => tabVisible[id as StaffTab]).map((tab) => {
      const badge = tabBadges[tab.id as StaffTab];
      return badge ? { ...tab, badge } : tab;
    }),
  );

  // ── Dossier membre ──
  // Le dossier appartient a la section Membres, ici comme ailleurs.
  const canOpenMemberCase = $derived(canViewFeature('members'));
  let caseOpen = $state(false);
  let caseUserId = $state<string | null>(null);
  let caseUserName = $state('');
  let caseData = $state<any>(null);
  let caseLoading = $state(false);
  let caseError = $state('');

  async function openMemberCase(userId: string, userName: string) {
    if (!staff.guildId || !userId || !canOpenMemberCase) return;
    caseUserId = userId;
    caseUserName = userName;
    caseOpen = true;
    caseLoading = true;
    caseError = '';
    caseData = null;
    try {
      caseData = await fetchMemberCase(userId, staff.guildId);
    } catch (err) {
      caseError = errorMessage(err) ?? 'Impossible de charger le dossier';
    } finally {
      caseLoading = false;
    }
  }

  const openCase = $derived(canOpenMemberCase ? openMemberCase : undefined);

  /** Membre du staff ouvert dans le dossier : il gagne l'onglet « Staff », ouvert d'emblee. */
  const caseIsStaff = $derived(!!caseUserId && !!staff.memberByUserId(caseUserId));
</script>

<svelte:head>
  <title>{m.sm_header_title()}</title>
</svelte:head>

<ModulePage title={m.sm_header_title()} description={m.sm_header_desc()} icon="users" featureKey="staff_directory">
  {#snippet actions()}
    {#if staff.canManageSettings && hasAccess}
      <Button icon="settings" title={m.sm_header_config_title()} onclick={() => (staff.dialogs.settings = true)}>{m.sm_header_settings()}</Button>
    {/if}
  {/snippet}

  {#if !authStore.token}
    <Callout variant="danger">{m.sm_err_unauthenticated()}</Callout>
  {:else if !hasAccess}
    <Callout variant="warning" icon="lock">{m.sm_err_insufficient_access()}</Callout>
  {:else}
    <!-- Chiffres cles : un clic mene a l'onglet qui les detaille. -->
    <section class="section-card p-5" data-tour="staff-stats" aria-label={m.sx_kpi_label()}>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
        {#each visibleStats as stat (stat.id)}
          <div class="min-w-0 lg:border-l lg:border-outline-variant lg:pl-5 lg:first:border-l-0 lg:first:pl-0">
            <button type="button" class="kpi group" onclick={() => switchTab(stat.id)}>
              <dt class="flex items-center gap-1.5 text-xs text-on-surface-variant">
                <Papicon icon={stat.icon} size={14} />
                <span class="truncate">{stat.label}</span>
                <Papicon icon="arrow-right" size={12} class="opacity-0 transition-opacity group-hover:opacity-100" />
              </dt>
              <dd class="mt-0.5">
                {#if stat.loading}
                  <span class="block h-7 w-12 animate-pulse rounded bg-surface-container-high"></span>
                {:else}
                  <span class="block text-2xl font-semibold tabular-nums tracking-tight text-on-surface {stat.tone}">{stat.value}</span>
                {/if}
                <span class="block truncate text-xs text-on-surface-variant {stat.loading ? 'invisible' : ''} {stat.tone}">{stat.note}</span>
              </dd>
            </button>
          </div>
        {/each}
      </dl>
    </section>

    <div class="space-y-5">
      <Tabs label={m.nav_group_staff()} {tabs} active={activeTab} onchange={(id) => switchTab(id as StaffTab)} />

      <div data-tour="staff-panel">
        {#if activeTab === 'members'}
          <StaffDirectory {openCase} />
        {:else if activeTab === 'roles'}
          <StaffRoles />
          <StaffListPanels />
        {:else if activeTab === 'organigramme'}
          {#if staff.loading.organigramme && !staff.hierarchySchema}
            <div class="section-card h-[60vh] animate-pulse" aria-busy="true"></div>
          {:else}
            <OrgChart schema={staff.hierarchySchema} />
          {/if}
        {:else if activeTab === 'warnings'}
          <StaffWarnings {openCase} />
        {:else if activeTab === 'blacklist'}
          <StaffBlacklist />
        {:else if activeTab === 'polls'}
          <StaffPolls />
        {:else if activeTab === 'leadership'}
          <StaffLeadership {openCase} />
        {:else if activeTab === 'permissions'}
          <div class="space-y-4">
            <p class="max-w-prose text-sm text-on-surface-variant">{m.sm_perms_desc()}</p>
            <RolePermissionSettings title={m.sm_perms_directory_title()} description={m.sm_perms_directory_desc()} featureKey="staff_directory" />
            <RolePermissionSettings title={m.sm_perms_roles_title()} description={m.sm_perms_roles_desc()} featureKey="staff_roles" />
          </div>
        {/if}
      </div>
    </div>
  {/if}
</ModulePage>

<StaffDialogs />

{#snippet staffCaseTab()}
  {#if caseUserId}<StaffCaseTab userId={caseUserId} />{/if}
{/snippet}

<MemberCaseModal
  open={caseOpen}
  extraTab={caseIsStaff ? { label: m.sx_case_tab(), icon: 'shield', content: staffCaseTab } : null}
  initialTab={caseIsStaff ? 'extra' : 'resume'}
  userId={caseUserId}
  userName={caseUserName}
  {caseData}
  loading={caseLoading}
  error={caseError}
  onClose={() => (caseOpen = false)}
  onSelectUser={(newUserId) => {
    const node = caseData?.interactionGraph?.nodes?.find((n: any) => n.id === newUserId);
    void openMemberCase(newUserId, node?.label || 'Membre');
  }}
/>

<style>
  .kpi {
    display: block;
    width: calc(100% + 0.75rem);
    margin: -0.375rem;
    padding: 0.375rem;
    border-radius: 0.5rem;
    text-align: left;
    transition: background-color 0.15s ease;
  }
  .kpi:hover {
    background: var(--surface-hover);
  }
</style>
