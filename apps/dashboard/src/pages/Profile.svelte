<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { Button, Callout, SectionCard, Tabs } from '../lib/components/ui';
  import { authStore } from '../lib/stores/auth.svelte';
  import {
    API_BASE_URL,
    fetchMyApiKeys,
    deleteMyApiKey,
    fetchManagerNotes,
    addManagerNote,
    deleteManagerNote, dashboardFetch } from '../lib/api';
  import type { APIKey, StaffMember, TestingPeriod, StaffManagerNote } from '../lib/types';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import RankCardCustomizer from '../lib/components/RankCardCustomizer.svelte';
  import Chart from '../lib/components/charts/Chart.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';

  import { errorMessage } from '@kotbo/shared';
  interface Props {
    userId?: string;
  }
  const { userId }: Props = $props();

  const targetUserId = $derived(userId || authStore.user?.id || '');

  let staffMember: StaffMember | null = $state(null);
  let publicProfile: any = $state(null);
  let apiKeys: APIKey[] = $state([]);
  let isBlacklisted = $state(false);
  let blacklistReason = $state('');
  let blacklistEndDate: string | null = $state(null);
  let blacklistHistory: any[] = $state([]);
  let warnings: any[] = $state([]);
  let absences: any[] = $state([]);
  let testingPeriods: TestingPeriod[] = $state([]);
  let activities: any[] = $state([]);
  let notesAbout: StaffManagerNote[] = $state([]);
  let gradeHistory: any[] = $state([]);
  let stats: any = $state(null);
  let visibility = $state({ discipline: false, absences: false, tutoring: false, managerNotes: false, apiKeys: false });
  let scorecard = $state<any>(null);
  let loadingScorecard = $state(false);
  
  let loading = $state(true);
  let error = $state('');
  const profileTabs = ['staff_overview', 'staff_activity', 'community_overview', 'rank_card', 'api_keys'] as const;
  let activeTab = $state('staff_overview');

  const profileBase = $derived(userId ? `/profile/${userId}` : '/profile');

  $effect(() => {
    const _path = $router.path;
    const tab = resolveTabFromUrl(profileBase, profileTabs, 'staff_overview');
    activeTab = tab;
  });

  // API Keys Form
  let showNewKeyForm = $state(false);
  let newKeyName = $state(m.pf_my_api_key());
  let copiedKeyId = $state('');
  let newKeyCreatedValue = $state('');
  let permRecruitment = $state(false);
  let permDailyAlgo = $state(true);

  // Manager Notes Form
  let newNoteContent = $state('');
  let sendingNote = $state(false);

  // Resignation
  let pendingResignation = $state<any>(null);
  let showResignationForm = $state(false);
  let resignationReason = $state('');
  let submittingResignation = $state(false);

  const isOwnProfile = $derived(targetUserId === authStore.user?.id);

  // Une seule teinte pour toutes les pastilles de chiffres : la couleur ne dit
  // rien de plus que le libelle, elle ne faisait que bigarrer la page.
  const NEUTRAL_TONE = 'bg-surface-container text-on-surface-variant';

  const profileName = $derived(
    staffMember?.displayName || publicProfile?.displayName || publicProfile?.username || authStore.user?.username || '',
  );
  const profileUsername = $derived(
    publicProfile?.username || staffMember?.username || authStore.user?.username || '',
  );

  const tabs = $derived([
    ...(staffMember ? [
      { id: 'staff_overview', label: m.pf_tab_staff_overview(), icon: 'Grid' },
      { id: 'staff_activity', label: m.pf_tab_staff_activity(), icon: 'TrendingUp' }
    ] : []),
    ...(publicProfile ? [
      { id: 'community_overview', label: m.pf_tab_community(), icon: 'User' }
    ] : []),
    ...(isOwnProfile ? [
      { id: 'rank_card', label: m.pf_tab_rank_card(), icon: 'Sparkles' }
    ] : []),
    ...(staffMember && isOwnProfile && visibility.apiKeys ? [
      { id: 'api_keys', label: m.pf_tab_api_keys(), icon: 'Lock' }
    ] : [])
  ]);

  // Reactive effect to load profile when targetUserId changes
  $effect(() => {
    if (targetUserId) {
      loadProfile(targetUserId);
    }
  });

  // L onglet choisi dans l URL prime sur le defaut deduit du type de profil,
  // sinon un lien direct vers un onglet serait ecrase a la fin du chargement.
  function applyDefaultTab(fallback: string) {
    activeTab = resolveTabFromUrl(profileBase, profileTabs, fallback);
  }

  async function loadProfile(id: string) {
    loading = true;
    error = '';
    
    if (!authStore.token) {
      error = m.pf_not_authenticated();
      loading = false;
      return;
    }

    try {
      const guildId = authStore.selectedGuildId;
      // Fetch private staff profile details
      const res = await fetch(`${API_BASE_URL}/api/dashboard/users/${id}/profile${guildId ? `?guildId=${guildId}` : ''}`, {
        headers: { Authorization: `Bearer ${authStore.token}` }
      });

      if (res.ok) {
        const data = await res.json();
        staffMember = data.staffMember;
        publicProfile = data.publicProfile;
        apiKeys = data.apiKeys || [];
        warnings = data.warnings || [];
        absences = data.absences || [];
        testingPeriods = data.testingPeriods || [];
        activities = data.activities || [];
        notesAbout = data.notesAbout || [];
        gradeHistory = data.gradeHistory || [];
        stats = data.stats;
        isBlacklisted = data.isBlacklisted;
        blacklistReason = data.blacklistReason;
        blacklistEndDate = data.blacklistEndDate;
        blacklistHistory = data.blacklistHistory || [];
        visibility = { ...visibility, ...data.visibility };
        
        // Default active tab
        if (staffMember) {
          applyDefaultTab('staff_overview');
          await loadScorecard(staffMember.guildId, id);
        } else {
          applyDefaultTab('community_overview');
        }

        // Load pending resignation if own profile
        if (data.staffMember && id === authStore.user?.id) {
          await loadPendingResignation(data.staffMember.guildId);
        }
      } else {
        // Not a staff member or unauthorized for staff details
        // Try fetching only public community profile
        const pubRes = await fetch(`${API_BASE_URL}/api/public/profile/${id}`, {
          headers: { Authorization: `Bearer ${authStore.token}` }
        });
        if (pubRes.ok) {
          publicProfile = await pubRes.json();
          staffMember = null;
          applyDefaultTab('community_overview');
        } else {
          throw new Error(m.pf_load_error());
        }
      }
    } catch (err) {
      console.error('Impossible de charger le profil :', err);
      // Un membre sans fiche staff ni profil de serveur n'a rien a afficher ici,
      // mais sa carte de rang ne depend d'aucun des deux : sur son propre profil
      // on garde la page accessible au lieu de la remplacer par une erreur.
      if (isOwnProfile) {
        staffMember = null;
        publicProfile = null;
        applyDefaultTab('rank_card');
      } else {
        error = errorMessage(err) || 'Impossible de charger le profil. Réessaie.';
      }
    } finally {
      loading = false;
    }
  }

  async function loadScorecard(guildId: string, userId: string) {
    loadingScorecard = true;
    try {
      const res = await dashboardFetch(`/staff/members/${userId}/scorecard`, { guildId,
        });
      if (res.ok) {
        const data = await res.json();
        scorecard = data.scorecard;
      } else {
        scorecard = null;
      }
    } catch (err) {
      console.error('Error loading staff scorecard:', err);
      scorecard = null;
    } finally {
      loadingScorecard = false;
    }
  }

  const getUserAvatar = () => {
    const own = isOwnProfile && authStore.user?.avatar
      ? `https://cdn.discordapp.com/avatars/${authStore.user.id}/${authStore.user.avatar}.png`
      : null;
    // Sans photo, l'avatar Discord par defaut est identique pour tout le monde :
    // memberAvatarSrc rend alors une initiale coloree par l'identifiant.
    return memberAvatarSrc(
      staffMember?.avatarUrl || publicProfile?.avatar || own,
      staffMember?.displayName || publicProfile?.displayName || publicProfile?.username || authStore.user?.username,
      targetUserId,
    );
  };

  const gradeIcon = (grade: string) => {
    const g = grade?.toLowerCase() || '';
    if (g.includes('fondateur') || g.includes('direction')) return 'Crown';
    if (g.includes('admin')) return 'Shield';
    if (g.includes('manager') || g.includes('responsable')) return 'ShieldCheck';
    if (g.includes('mod')) return 'ShieldHalf';
    if (g.includes('dev')) return 'Code';
    if (g.includes('helper') || g.includes('test')) return 'LifeBuoy';
    return 'Badge';
  };

  async function createNewAPIKey() {
    if (!staffMember) return;
    
    const permissions: string[] = [];
    if (permRecruitment) permissions.push('recruitment:forms');
    if (permDailyAlgo) permissions.push('daily_algo:create_exercise');

    if (permissions.length === 0) {
      toast.error(m.pf_select_permission());
      return;
    }

    try {
      const res = await dashboardFetch(`/api-keys`, {
        method: 'POST',
        guildId: staffMember.guildId,
        body: JSON.stringify({
          name: newKeyName,
          permissions
        })
      });

      if (!res.ok) throw new Error('Impossible de créer la clé API. Réessaie.');

      const data = await res.json();
      newKeyCreatedValue = data.fullKey;
      
      // Reload keys
      const keysRes = await fetchMyApiKeys(staffMember.guildId);
      apiKeys = keysRes?.keys || [];
      showNewKeyForm = false;
      newKeyName = m.pf_my_api_key();
      permRecruitment = false;
      permDailyAlgo = true;
      toast.success(m.pf_key_created());
    } catch (err) {
      console.error(err);
      toast.error(m.pf_key_create_error());
    }
  }

  async function deleteKey(keyId: string) {
    if (!staffMember || !(await confirmDialog.danger(m.pf_revoke_key_q(), '', m.pf_revoke()))) return;
    try {
      const success = await deleteMyApiKey(keyId, staffMember.guildId);
      if (success) {
        const keysRes = await fetchMyApiKeys(staffMember.guildId);
        apiKeys = keysRes?.keys || [];
        toast.success(m.pf_key_revoked());
      }
    } catch (err) {
      console.error(err);
      toast.error(m.pf_revoke_error());
    }
  }

  function copyToClipboard(text: string, keyId: string) {
    navigator.clipboard.writeText(text);
    copiedKeyId = keyId;
    toast.success(m.pf_copied());
    setTimeout(() => { copiedKeyId = ''; }, 2000);
  }

  // Manager Notes Methods
  async function submitManagerNote() {
    if (!newNoteContent.trim() || !staffMember) return;
    sendingNote = true;
    try {
      const success = await addManagerNote(staffMember.userId, newNoteContent.trim(), staffMember.guildId);
      if (success) {
        newNoteContent = '';
        toast.success(m.pf_note_added());
        // Reload notes
        notesAbout = await fetchManagerNotes(staffMember.userId, staffMember.guildId);
      }
    } catch (err) {
      console.error(err);
      toast.error(m.pf_note_add_error());
    } finally {
      sendingNote = false;
    }
  }

  async function removeNote(noteId: string) {
    if (!staffMember || !(await confirmDialog.danger(m.pf_delete_note_q()))) return;
    try {
      const success = await deleteManagerNote(staffMember.userId, noteId, staffMember.guildId);
      if (success) {
        toast.success(m.pf_note_deleted());
        notesAbout = await fetchManagerNotes(staffMember.userId, staffMember.guildId);
      }
    } catch (err) {
      console.error(err);
      toast.error(m.home_delete_error());
    }
  }

  async function loadPendingResignation(guildId: string) {
    if (!authStore.token) return;
    try {
      const res = await dashboardFetch(`/staff/resignations`, { guildId,
        });
      if (res.ok) {
        const data = await res.json();
        const myId = staffMember?.id;
        pendingResignation = (data.resignations || []).find(
          (r: any) => r.staffUserId === myId && r.status === 'PENDING'
        ) || null;
      }
    } catch (err) {
      console.error('Erreur chargement résignation:', err);
    }
  }

  async function submitResignation() {
    if (!staffMember || !resignationReason.trim()) return;
    submittingResignation = true;
    try {
      const res = await dashboardFetch(`/staff/resignations`, {
        method: 'POST',
        guildId: staffMember.guildId,
        body: JSON.stringify({ reason: resignationReason.trim() })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Impossible d\'envoyer. Réessaie.');
      }
      const data = await res.json();
      pendingResignation = data.resignation;
      showResignationForm = false;
      resignationReason = '';
      toast.success(m.pf_resignation_submitted());
    } catch (err) {
      console.error(err);
      toast.error(errorMessage(err) || m.pf_submit_error());
    } finally {
      submittingResignation = false;
    }
  }

  function formatDate(date: string | Date | null | undefined) {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function formatTimeAgo(dateStr: string | null) {
    if (!dateStr) return m.pf_never();
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return m.home_rel_now();
    if (diffMins < 60) return m.pf_ago_min({ n: diffMins });
    if (diffHours < 24) return m.pf_ago_hours({ n: diffHours });
    if (diffDays === 1) return m.home_rel_yesterday();
    return m.pf_ago_days({ n: diffDays });
  }

  function getDurationSince(value: string | Date | null | undefined) {
    if (!value) return m.pf_unknown();
    const start = new Date(value);
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    if (months < 0) { years--; months += 12; }

    const parts: string[] = [];
    if (years > 0) parts.push(m.pf_years({ n: years }));
    if (months > 0) parts.push(m.pf_months({ n: months }));
    if (parts.length === 0) {
       const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
       return days <= 0 ? m.pf_today() : m.pf_days_short({ n: days });
    }
    return parts.join(', ');
  }

  // L'API rend les jours du plus recent au plus ancien : sans ce tri, la
  // courbe se lisait de droite a gauche.
  const chronologicalActivities = $derived(
    [...activities].sort((a, b) => new Date(a.activityDate).getTime() - new Date(b.activityDate).getTime()),
  );

  const chartData = $derived(
    chronologicalActivities.length > 0 ? {
      labels: chronologicalActivities.map(a => new Date(a.activityDate).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short' })),
      datasets: [
        {
          label: 'Messages',
          data: chronologicalActivities.map(a => a.messageCount),
          borderColor: 'var(--color-primary)',
          backgroundColor: 'rgba(var(--color-primary), 0.12)',
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 0
        },
        {
          label: m.pf_voice_min(),
          data: chronologicalActivities.map(a => a.voiceMinutes || 0),
          borderColor: 'var(--color-success)',
          backgroundColor: 'rgba(var(--color-success), 0.10)',
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 0
        }
      ]
    } : null
  );

</script>

<div class="space-y-6 pb-16">
  {#if loading}
    <div class="space-y-6 animate-pulse" aria-busy="true">
      <div class="flex items-center gap-4">
        <div class="w-16 h-16 rounded-full bg-surface-container"></div>
        <div class="space-y-2">
          <div class="h-5 w-48 rounded bg-surface-container"></div>
          <div class="h-3.5 w-32 rounded bg-surface-container"></div>
        </div>
      </div>
      <div class="h-10 w-80 max-w-full rounded-lg bg-surface-container"></div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="h-40 rounded-xl bg-surface-container"></div>
        <div class="h-40 rounded-xl bg-surface-container"></div>
        <div class="h-40 rounded-xl bg-surface-container"></div>
      </div>
    </div>
  {:else if error}
    <div class="section-card max-w-lg mx-auto p-8 text-center">
      <Papicon icon="AlertTriangle" size={22} class="text-error mx-auto mb-3" />
      <h3 class="text-base font-semibold text-on-surface">{m.pf_error_label()}</h3>
      <p class="mt-1 text-body-sm text-on-surface-variant">{error}</p>
    </div>
  {:else}

    <!-- Identite : pas de banniere vide ni de halo, l'avatar et le nom suffisent. -->
    <header class="flex flex-col sm:flex-row sm:items-center gap-4">
      <img
        src={getUserAvatar()}
        alt=""
        width="64"
        height="64"
        class="w-16 h-16 rounded-full object-cover bg-surface-container shrink-0"
      />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-semibold text-on-surface truncate">{profileName}</h1>
          {#if staffMember}
            <span class="inline-flex items-center gap-1.5 rounded-md border border-outline-variant px-2 py-0.5 text-xs font-medium text-on-surface-variant">
              <Papicon icon={gradeIcon(staffMember.grade)} size={13} />
              {staffMember.grade}
            </span>
          {/if}
          {#if isBlacklisted}
            <span class="inline-flex items-center gap-1.5 rounded-md bg-error/10 px-2 py-0.5 text-xs font-medium text-error">
              <Papicon icon="Slash" size={13} />
              {m.pf_restricted_account()}
            </span>
          {/if}
        </div>
        <p class="mt-0.5 text-body-sm text-on-surface-variant truncate">
          @{profileUsername} · <span class="font-mono text-xs">{targetUserId}</span>
        </p>
      </div>
      {#if isOwnProfile}
        <Button href="/me" size="sm" icon="edit">{m.me_edit_profile()}</Button>
      {/if}
    </header>

    <div class="sticky z-30 top-[calc(var(--app-navbar-height)+0.5rem)]">
      <Tabs
        label={m.nav_my_profile()}
        {tabs}
        active={activeTab}
        onchange={(id) => gotoTab(profileBase, id, 'staff_overview')}
      />
    </div>

    <div>
      {#if activeTab === 'staff_overview' && staffMember}
        <div class="space-y-6">
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard label="Messages" value={`${stats?.totalMessages ?? 0}`} note={m.pf_total_sent()} icon="MessageSquare" toneClass={NEUTRAL_TONE} />
            <MetricCard label={m.home_opt_voice()} value={`${Math.round((stats?.totalVoiceMinutes ?? 0))}m`} note={m.pf_time_spent()} icon="Mic" toneClass={NEUTRAL_TONE} />
            {#if visibility.discipline}
              <MetricCard label="Sanctions" value={`${stats?.sanctionsIssued ?? 0}`} note="Avertissements et liste noire" icon="Hammer" toneClass={NEUTRAL_TONE} />
              <MetricCard label={m.pf_warnings_label()} value={`${stats?.activeWarnings ?? 0}`} note={m.pf_active_received()} icon="ShieldAlert" toneClass={NEUTRAL_TONE} />
            {/if}
          </div>

          {#if isBlacklisted}
            <Callout variant="danger" title={m.pf_restricted_account()}>
              <p>{blacklistReason}</p>
              <p class="mt-1">
                {blacklistEndDate ? m.pf_restriction_end({ date: formatDate(blacklistEndDate) }) : m.pf_permanent_restriction()}
              </p>
            </Callout>
          {/if}

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SectionCard title={m.pf_identity_seniority()} description={m.pf_staff_career()}>
              <dl class="grid grid-cols-2 gap-x-6 gap-y-5">
                <div>
                  <dt class="text-xs text-on-surface-variant">{m.pf_staff_since()}</dt>
                  <dd class="mt-0.5 text-base font-semibold text-on-surface">{getDurationSince(staffMember.joinedStaffAt)}</dd>
                  <dd class="text-xs text-on-surface-variant">{formatDate(staffMember.joinedStaffAt)}</dd>
                </div>
                <div>
                  <dt class="text-xs text-on-surface-variant">{m.pf_current_grade_since()}</dt>
                  <dd class="mt-0.5 text-base font-semibold text-on-surface">{getDurationSince(staffMember.currentRoleStartedAt)}</dd>
                  <dd class="text-xs text-on-surface-variant">{formatDate(staffMember.currentRoleStartedAt)}</dd>
                </div>
                <div>
                  <dt class="text-xs text-on-surface-variant">{m.pf_tutor_status()}</dt>
                  <dd class="mt-1">
                    <span class="inline-flex rounded-md px-2 py-0.5 text-xs font-medium {staffMember.isTutor ? 'bg-success/10 text-success' : 'bg-surface-container text-on-surface-variant'}">
                      {staffMember.isTutor ? m.pf_active_tutor() : m.pf_not_tutor()}
                    </span>
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs text-on-surface-variant">{m.pf_unique_id()}</dt>
                  <dd class="mt-1 text-xs font-mono text-on-surface truncate">{staffMember.id}</dd>
                </div>
              </dl>
            </SectionCard>

            <SectionCard title={m.pf_promotions_history()}>
              {#if gradeHistory.length > 0}
                <ol class="space-y-3 max-h-60 overflow-y-auto pr-1">
                  {#each gradeHistory as event}
                    <li class="flex items-start gap-3">
                      <span class="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0"></span>
                      <div>
                        <p class="text-sm text-on-surface">{event.details}</p>
                        <p class="text-xs text-on-surface-variant mt-0.5">{formatDate(event.dateIso)} · {m.pf_by_user_cap({ user: event.user })}</p>
                      </div>
                    </li>
                  {/each}
                </ol>
              {:else}
                <p class="text-body-sm text-on-surface-variant">{m.pf_no_grade_history()}</p>
              {/if}
            </SectionCard>
          </div>

          {#if visibility.discipline || visibility.absences}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {#if visibility.discipline}
                <SectionCard title={m.pf_warnings_received()}>
                  {#if warnings.length > 0}
                    <ul class="divide-y divide-outline-variant/60">
                      {#each warnings as warn}
                        <li class="py-3 first:pt-0 last:pb-0">
                          <div class="flex items-center justify-between gap-3">
                            <span class="text-xs font-medium {warn.isActive ? 'text-warning' : 'text-on-surface-variant'}">
                              {warn.isActive ? m.pf_active() : m.pf_expired()}
                            </span>
                            <span class="text-xs text-on-surface-variant">{formatDate(warn.createdAt)}</span>
                          </div>
                          <p class="mt-1 text-sm text-on-surface">{warn.reason}</p>
                          {#if warn.expiresAt}
                            <p class="mt-1 text-xs text-on-surface-variant">{m.pf_expires_on({ date: formatDate(warn.expiresAt) })}</p>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="text-body-sm text-on-surface-variant">{m.pf_no_warnings()}</p>
                  {/if}
                </SectionCard>
              {/if}

              {#if visibility.absences}
                <SectionCard title={m.pf_declared_absences()}>
                  {#if absences.length > 0}
                    <ul class="divide-y divide-outline-variant/60 max-h-80 overflow-y-auto pr-1">
                      {#each absences as abs}
                        <li class="py-3 first:pt-0 last:pb-0">
                          <div class="flex items-center justify-between gap-3">
                            <span class="text-xs font-medium text-on-surface">{abs.type}</span>
                            <span class="rounded-md px-2 py-0.5 text-xs font-medium {abs.status === 'APPROVED' ? 'bg-success/10 text-success' : (abs.status === 'PENDING' ? 'bg-warning/10 text-warning' : 'bg-surface-container text-on-surface-variant')}">
                              {abs.status}
                            </span>
                          </div>
                          <p class="mt-1 text-sm text-on-surface">{abs.reason}</p>
                          <p class="mt-1 text-xs text-on-surface-variant">
                            {m.pf_from_to({ from: formatDate(abs.startDate), to: abs.isIndefinite ? m.pf_indefinite() : formatDate(abs.endDate) })}
                          </p>
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="text-body-sm text-on-surface-variant">{m.pf_no_absences()}</p>
                  {/if}
                </SectionCard>
              {/if}
            </div>
          {/if}

          {#if testingPeriods.length > 0}
            <SectionCard title={m.pf_testing_periods()}>
              <div class="space-y-4">
                {#each testingPeriods as period}
                  <div class="rounded-lg border border-outline-variant p-4 space-y-3">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <p class="text-xs text-on-surface-variant">{m.pf_objective()}</p>
                        <p class="text-sm font-semibold text-on-surface">{period.targetGrade || m.pf_staff_grade()}</p>
                      </div>
                      <div class="text-right">
                        <span class="rounded-md px-2 py-0.5 text-xs font-medium {period.status === 'PASSED' ? 'bg-success/10 text-success' : (period.status === 'ONGOING' ? 'bg-warning/10 text-warning' : 'bg-error/10 text-error')}">
                          {period.status === 'PASSED' ? m.pf_passed() : (period.status === 'ONGOING' ? m.home_in_progress() : m.pf_failed())}
                        </span>
                        <p class="mt-1 text-xs text-on-surface-variant">{m.pf_start_date({ date: formatDate(period.startDate) })}</p>
                      </div>
                    </div>

                    {#if period.mentor}
                      <p class="text-xs text-on-surface-variant">{m.pf_assigned_mentor()} <span class="font-medium text-on-surface">@{period.mentor.username}</span></p>
                    {/if}

                    {#if period.reports && period.reports.length > 0}
                      <div class="space-y-2">
                        <p class="text-xs text-on-surface-variant">{m.pf_mentor_reports()}</p>
                        {#each period.reports as rep}
                          <div class="rounded-md bg-surface-container px-3 py-2">
                            <div class="flex items-center justify-between gap-3">
                              <span class="text-xs font-medium {rep.type === 'POSITIVE' ? 'text-success' : (rep.type === 'NEGATIVE' ? 'text-error' : 'text-on-surface-variant')}">
                                {rep.type}
                              </span>
                              <span class="text-xs text-on-surface-variant">{formatDate(rep.createdAt)}</span>
                            </div>
                            <p class="mt-1 text-sm text-on-surface">{rep.content}</p>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </SectionCard>
          {/if}

          {#if visibility.managerNotes}
            <SectionCard title={m.pf_manager_notes()}>
              <ul class="divide-y divide-outline-variant/60 mb-4">
                {#each notesAbout as note}
                  <li class="flex items-start justify-between gap-4 py-3 first:pt-0">
                    <div>
                      <p class="text-sm text-on-surface">{note.content}</p>
                      <p class="mt-1 text-xs text-on-surface-variant">
                        {m.pf_posted_on({ date: formatDate(note.createdAt), author: note.author?.username || m.pf_a_manager() })}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" icon="Trash" aria-label={m.pf_delete_note_q()} onclick={() => removeNote(note.id)} />
                  </li>
                {:else}
                  <li class="text-body-sm text-on-surface-variant">{m.pf_no_notes()}</li>
                {/each}
              </ul>

              <div class="flex flex-col md:flex-row gap-3 md:items-end">
                <div class="flex-1">
                  <FormInput id="new-note" placeholder={m.pf_add_note_ph()} bind:value={newNoteContent} className="w-full" />
                </div>
                <Button variant="primary" onclick={submitManagerNote} loading={sendingNote} disabled={!newNoteContent.trim()}>
                  {m.pf_add_note()}
                </Button>
              </div>
            </SectionCard>
          {/if}

          {#if isOwnProfile && staffMember}
            <SectionCard title={m.pf_resignation()} description={pendingResignation ? '' : m.pf_resignation_info()}>
              {#if pendingResignation}
                <Callout variant="warning" icon="Clock" title={m.pf_resignation_pending()}>
                  <p>« {pendingResignation.reason} »</p>
                  <p class="mt-1">{m.pf_submitted_on({ date: formatDate(pendingResignation.createdAt) })}</p>
                </Callout>
                <p class="mt-3 text-body-sm text-on-surface-variant">{m.pf_resignation_review()}</p>
              {:else if showResignationForm}
                <div class="space-y-3">
                  <div>
                    <label for="resignation-reason" class="field-label">{m.pf_resignation_reason()}</label>
                    <textarea
                      id="resignation-reason"
                      bind:value={resignationReason}
                      placeholder={m.pf_resignation_ph()}
                      maxlength={500}
                      rows={4}
                      class="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary resize-none"
                    ></textarea>
                    <p class="mt-1 text-right text-xs text-on-surface-variant">{resignationReason.length}/500</p>
                  </div>
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" onclick={() => { showResignationForm = false; resignationReason = ''; }}>
                      {m.common_cancel()}
                    </Button>
                    <Button
                      id="btn-submit-resignation"
                      variant="danger"
                      onclick={submitResignation}
                      loading={submittingResignation}
                      disabled={!resignationReason.trim()}
                    >
                      {m.pf_submit_request()}
                    </Button>
                  </div>
                </div>
              {:else}
                <Button id="btn-open-resignation" variant="danger" icon="LogOut" onclick={() => showResignationForm = true}>
                  {m.pf_request_resignation()}
                </Button>
              {/if}
            </SectionCard>
          {/if}
        </div>

      {:else if activeTab === 'staff_activity' && staffMember}
        <div class="space-y-6">
          {#if scorecard}
            {#if scorecard.burnoutRisk}
              <Callout variant="danger" icon="ShieldAlert" title={m.pf_burnout_risk()}>
                {m.pf_burnout_pre()} <strong>{scorecard.activityDropPercent}%</strong> {m.pf_burnout_post()}
              </Callout>
            {/if}

            <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div class="section-card md:col-span-2 p-5 flex flex-col items-center justify-center text-center">
                <p class="text-xs text-on-surface-variant">{m.pf_overall_score()}</p>
                <div class="relative mt-2 flex items-center justify-center h-28 w-28 text-primary">
                  <svg class="w-full h-full -rotate-90" viewBox="0 0 112 112" aria-hidden="true">
                    <circle cx="56" cy="56" r="48" class="stroke-surface-container-high" stroke-width="8" fill="transparent" />
                    <circle cx="56" cy="56" r="48" stroke="currentColor" stroke-width="8" stroke-linecap="round" fill="transparent"
                      stroke-dasharray={2 * Math.PI * 48}
                      stroke-dashoffset={2 * Math.PI * 48 * (1 - scorecard.scores.overall / 100)}
                    />
                  </svg>
                  <span class="absolute text-2xl font-semibold text-on-surface">{scorecard.scores.overall}%</span>
                </div>
                <p class="mt-2 text-xs text-on-surface-variant">{m.pf_health_index()}</p>
              </div>

              <div class="md:col-span-3 grid grid-cols-2 gap-4">
                {#each [
                  { label: 'Messages', score: scorecard.scores.messages, bar: 'bg-primary', now: m.pf_this_week({ v: `${scorecard.messageCount} msg` }), before: m.pf_last_week({ v: `${scorecard.previousMessageCount} msg` }) },
                  { label: m.home_opt_voice(), score: scorecard.scores.voice, bar: 'bg-success', now: m.pf_this_week({ v: `${scorecard.voiceMinutes} min` }), before: m.pf_last_week({ v: `${scorecard.previousVoiceMinutes} min` }) },
                  { label: m.home_mod_moderation_title(), score: scorecard.scores.moderation, bar: 'bg-warning', now: m.pf_sanctions_count({ n: scorecard.sanctionsCount }), before: m.pf_last_week({ v: String(scorecard.previousSanctionsCount) }) },
                  { label: 'Support', score: scorecard.scores.support, bar: 'bg-tertiary', now: m.pf_tickets_closed({ n: scorecard.ticketsClosed }), before: m.pf_last_week({ v: String(scorecard.previousTicketsClosed) }) },
                ] as sub (sub.label)}
                  <div class="section-card p-4">
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-medium text-on-surface">{sub.label}</span>
                      <span class="text-xs font-semibold text-on-surface">{sub.score}%</span>
                    </div>
                    <div class="mt-2 h-1.5 w-full rounded-full bg-surface-container-high overflow-hidden">
                      <div class="h-full rounded-full {sub.bar}" style="width: {sub.score}%"></div>
                    </div>
                    <p class="mt-2 text-xs text-on-surface">{sub.now}</p>
                    <p class="text-xs text-on-surface-variant">{sub.before}</p>
                  </div>
                {/each}
              </div>
            </div>

            <p class="text-body-sm text-on-surface-variant">
              {m.pf_meetings_attended()} <strong class="font-semibold text-on-surface">{scorecard.meetingsAttended}</strong> {m.pf_meetings_last_week({ n: scorecard.previousMeetingsAttended })}
            </p>
          {/if}

          <SectionCard title={m.pf_activity_trend()}>
            {#snippet actions()}
              {#if chartData}
                <div class="flex items-center gap-4 text-xs text-on-surface-variant">
                  <span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-primary"></span>Messages</span>
                  <span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-success"></span>{m.pf_voice_min()}</span>
                </div>
              {/if}
            {/snippet}
            {#if chartData}
              <div class="h-70 w-full">
                <Chart data={chartData} height={280} />
              </div>
            {:else}
              <p class="py-16 text-center text-body-sm text-on-surface-variant">{m.pf_not_enough_data()}</p>
            {/if}
          </SectionCard>
        </div>

      {:else if activeTab === 'community_overview' && publicProfile}
        <div class="space-y-6">
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard label="Messages" value={publicProfile.messageCount?.toLocaleString() || '0'} note={m.pf_total_sent_pl()} icon="MessageSquare" toneClass={NEUTRAL_TONE} />
            <MetricCard label={m.home_opt_voice()} value={`${Math.round((publicProfile.voiceTimeSeconds || 0) / 60)} min`} note={m.pf_time_spent()} icon="Mic" toneClass={NEUTRAL_TONE} />
            <MetricCard label={m.home_mod_events_title()} value={`${publicProfile.eventParticipations?.length || 0}`} note="Participations" icon="Zap" toneClass={NEUTRAL_TONE} />
            <MetricCard label={m.pf_seniority()} value={getDurationSince(publicProfile.guildJoinedAt)} note={m.pf_since_arrival()} icon="Calendar" toneClass={NEUTRAL_TONE} />
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div class="space-y-4">
              <SectionCard title={m.pf_bio_title()}>
                <p class="text-sm text-on-surface leading-relaxed whitespace-pre-line">
                  {publicProfile.bio?.trim() || m.pf_no_bio()}
                </p>
              </SectionCard>

              <SectionCard title={m.pf_account_details()}>
                <dl class="divide-y divide-outline-variant/60">
                  <div class="flex items-center justify-between gap-3 pb-2">
                    <dt class="text-xs text-on-surface-variant">{m.pf_creation()}</dt>
                    <dd class="text-xs font-medium text-on-surface">{formatDate(publicProfile.accountCreatedAt)}</dd>
                  </div>
                  <div class="flex items-center justify-between gap-3 py-2">
                    <dt class="text-xs text-on-surface-variant">{m.pf_arrival()}</dt>
                    <dd class="text-xs font-medium text-on-surface">{formatDate(publicProfile.guildJoinedAt)}</dd>
                  </div>
                  <div class="flex items-center justify-between gap-3 pt-2">
                    <dt class="text-xs text-on-surface-variant">{m.pf_last_seen()}</dt>
                    <dd class="text-xs font-medium text-on-surface">{formatTimeAgo(publicProfile.lastSeenAt)}</dd>
                  </div>
                </dl>
              </SectionCard>

              {#if publicProfile.roles && publicProfile.roles.length > 0}
                <SectionCard title={m.pf_roles()}>
                  <div class="flex flex-wrap gap-1.5">
                    {#each publicProfile.roles as role}
                      <span class="rounded-md border border-outline-variant px-2 py-0.5 text-xs text-on-surface">{role.name}</span>
                    {/each}
                  </div>
                </SectionCard>
              {/if}
            </div>

            <div class="lg:col-span-2">
              <SectionCard title={m.pf_events_history()} description={m.pf_recent_participations()}>
                {#if publicProfile.eventParticipations && publicProfile.eventParticipations.length > 0}
                  <ul class="divide-y divide-outline-variant/60">
                    {#each publicProfile.eventParticipations as event}
                      <li class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                        <div class="min-w-0">
                          <p class="text-sm font-medium text-on-surface truncate">{event.title}</p>
                          <p class="text-xs text-on-surface-variant">{event.type} · {formatDate(event.date)}</p>
                        </div>
                        <span class="shrink-0 text-sm font-semibold text-on-surface">{event.score} pts</span>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="py-10 text-center text-body-sm text-on-surface-variant">{m.pf_no_participations()}</p>
                {/if}
              </SectionCard>
            </div>
          </div>
        </div>

      {:else if activeTab === 'rank_card' && isOwnProfile}
        <div class="section-card p-5">
          <RankCardCustomizer />
        </div>

      {:else if activeTab === 'api_keys' && staffMember && isOwnProfile && visibility.apiKeys}
        <div class="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
          <SectionCard title={m.pf_personal_api_keys()}>
            {#snippet actions()}
              <Button
                size="sm"
                variant={showNewKeyForm ? 'ghost' : 'primary'}
                icon={showNewKeyForm ? 'Cross' : 'Plus'}
                onclick={() => { showNewKeyForm = !showNewKeyForm; newKeyCreatedValue = ''; }}
              >
                {showNewKeyForm ? m.common_cancel() : m.pf_create_key()}
              </Button>
            {/snippet}

            {#if newKeyCreatedValue}
              <Callout variant="success" title={m.pf_key_generated()} class="mb-4">
                <div class="flex items-center gap-2 mt-1">
                  <code class="flex-1 min-w-0 break-all rounded-md bg-surface-container px-2 py-1 text-xs font-mono text-on-surface">{newKeyCreatedValue}</code>
                  <Button variant="ghost" size="sm" icon="Paper" aria-label={m.pf_copied()} onclick={() => copyToClipboard(newKeyCreatedValue, 'new-key')} />
                </div>
                <p class="mt-2 text-error">{m.pf_copy_key_warning()}</p>
              </Callout>
            {/if}

            {#if showNewKeyForm}
              <div class="mb-4 rounded-lg border border-outline-variant p-4 space-y-4">
                <div>
                  <label for="key-name" class="field-label">{m.pf_key_name_label()}</label>
                  <FormInput id="key-name" bind:value={newKeyName} placeholder={m.pf_key_name_ph()} className="w-full" />
                </div>

                <fieldset>
                  <legend class="field-label">{m.pf_key_permissions()}</legend>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label class="flex items-start gap-3 rounded-lg border border-outline-variant p-3 cursor-pointer hover:bg-surface-container">
                      <input type="checkbox" bind:checked={permRecruitment} class="mt-0.5 accent-primary" />
                      <span>
                        <span class="block text-sm font-medium text-on-surface">Module Recrutement</span>
                        <span class="block mt-0.5 text-xs text-on-surface-variant leading-relaxed">
                          Lier un formulaire externe (ex: Google Forms) pour enregistrer les candidatures sur Kotbo.
                        </span>
                      </span>
                    </label>
                    <label class="flex items-start gap-3 rounded-lg border border-outline-variant p-3 cursor-pointer hover:bg-surface-container">
                      <input type="checkbox" bind:checked={permDailyAlgo} class="mt-0.5 accent-primary" />
                      <span>
                        <span class="block text-sm font-medium text-on-surface">Daily Algo API</span>
                        <span class="block mt-0.5 text-xs text-on-surface-variant leading-relaxed">{m.pf_daily_algo_perm()}</span>
                      </span>
                    </label>
                  </div>
                </fieldset>

                <div class="flex justify-end">
                  <Button variant="primary" icon="Check" onclick={createNewAPIKey}>{m.pf_confirm_creation()}</Button>
                </div>
              </div>
            {/if}

            {#if apiKeys.length > 0}
              <ul class="divide-y divide-outline-variant/60">
                {#each apiKeys as key (key.id)}
                  <li class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-sm font-medium text-on-surface">{key.name}</span>
                        {#each key.permissions as perm}
                          <span class="rounded-md bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant">
                            {perm === 'recruitment:forms' ? 'Recrutement' : perm === 'daily_algo:create_exercise' ? 'Daily Algo' : perm}
                          </span>
                        {/each}
                      </div>
                      <div class="mt-1 flex flex-wrap items-center gap-2">
                        <code class="rounded-md bg-surface-container px-2 py-0.5 text-xs font-mono text-on-surface-variant">{key.displayKey}</code>
                        <span class="text-xs text-on-surface-variant">{m.pf_used_on({ date: formatDate(key.lastUsedAt) })}</span>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" icon="Trash" aria-label={m.pf_revoke()} onclick={() => deleteKey(key.id)} />
                  </li>
                {/each}
              </ul>
            {:else}
              <div class="py-10 text-center">
                <p class="text-sm font-medium text-on-surface">{m.pf_no_active_keys()}</p>
                <p class="mt-1 text-body-sm text-on-surface-variant">{m.pf_generate_key_hint()}</p>
              </div>
            {/if}
          </SectionCard>

          <SectionCard title={m.pf_api_key_security()}>
            <ul class="list-disc pl-4 space-y-2 text-body-sm text-on-surface-variant">
              <li>{m.pf_revoke_hint()}</li>
              <li>{m.pf_no_share_keys()}</li>
            </ul>
          </SectionCard>
        </div>
      {/if}
    </div>
  {/if}
</div>
