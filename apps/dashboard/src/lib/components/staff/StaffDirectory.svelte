<!--
  Annuaire du staff : un tableau qu'on parcourt d'un coup d'oeil, une fiche
  laterale pour le detail. Monter ou descendre un grade reste a un clic sur la
  ligne ; le reste passe par le menu « ... ».
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import EmptyState from '../EmptyState.svelte';
  import { Button, FilterPills, Menu } from '../ui';
  import StaffAvatar from './StaffAvatar.svelte';
  import GradeChip from './GradeChip.svelte';
  import WarnMeter from './WarnMeter.svelte';
  import HierarchyIcon from './HierarchyIcon.svelte';
  import { staff, staffName } from './staffStore.svelte';
  import { memberMenuItems } from './memberActions';
  import { formatNumber, formatTenure, formatVoice, formatDate } from './format';
  import type { StaffMember } from '../../types';
  import { m } from '../../i18n';

  const { openCase }: { openCase?: (userId: string, name: string) => void } = $props();

  type Filter = 'all' | 'active' | 'suspended' | 'tutors' | 'warned';
  type Sort = 'grade' | 'name' | 'tenure' | 'activity';

  let query = $state('');
  let filter = $state<Filter>('all');
  let sort = $state<Sort>('grade');

  const threshold = $derived(staff.config.warnsToDemote || 3);
  const members = $derived(staff.activeMembers);

  const counts = $derived({
    all: members.length,
    active: members.filter((s) => !s.suspendedAt).length,
    suspended: members.filter((s) => !!s.suspendedAt).length,
    tutors: members.filter((s) => s.isTutor).length,
    warned: members.filter((s) => (s.warnings?.length ?? 0) > 0).length,
  });

  const filterOptions = $derived(
    [
      { value: 'all' as const, label: m.common_all(), count: counts.all },
      { value: 'active' as const, label: m.sx_filter_active(), count: counts.active },
      { value: 'suspended' as const, label: m.sx_filter_suspended(), count: counts.suspended },
      { value: 'tutors' as const, label: m.sx_filter_tutors(), count: counts.tutors },
      { value: 'warned' as const, label: m.sx_filter_warned(), count: counts.warned },
    ].filter((option) => option.value === 'all' || option.value === 'active' || option.count > 0 || option.value === filter),
  );

  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = members.filter((member) => {
      if (filter === 'active' && member.suspendedAt) return false;
      if (filter === 'suspended' && !member.suspendedAt) return false;
      if (filter === 'tutors' && !member.isTutor) return false;
      if (filter === 'warned' && !(member.warnings?.length)) return false;
      if (!q) return true;
      return [member.displayName, member.username, member.userTag, member.userId, member.grade]
        .some((value) => value?.toLowerCase().includes(q));
    });
    const byGrade = (a: StaffMember, b: StaffMember) => {
      const ia = staff.gradeIndex(a.grade);
      const ib = staff.gradeIndex(b.grade);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    };
    return list.sort((a, b) => {
      if (sort === 'name') return staffName(a).localeCompare(staffName(b));
      if (sort === 'tenure') return new Date(a.joinedStaffAt).getTime() - new Date(b.joinedStaffAt).getTime();
      if (sort === 'activity') return (b.stats?.totalMessages ?? 0) - (a.stats?.totalMessages ?? 0);
      return byGrade(a, b) || staffName(a).localeCompare(staffName(b));
    });
  });

  /** Un clic ouvre le dossier membre, la meme fenetre que sur les autres pages. */
  function open(member: StaffMember) {
    openCase?.(member.userId, staffName(member));
  }

  function onRowKey(event: KeyboardEvent, member: StaffMember) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(member);
    }
  }

  function menuFor(member: StaffMember) {
    return memberMenuItems(member);
  }

  function resetFilters() {
    query = '';
    filter = 'all';
  }
</script>

{#snippet hierarchyStack(member: StaffMember)}
  {#if member.hierarchyGrades?.length}
    <span class="flex items-center -space-x-1.5">
      {#each member.hierarchyGrades.slice(0, 3) as grade (grade.id)}
        {@const hierarchy = grade.hierarchy ?? staff.hierarchyById(grade.hierarchyId)}
        <span class="rounded-lg ring-2 ring-surface-container-lowest" title="{hierarchy?.name ?? ''} · {grade.grade}">
          <HierarchyIcon icon={hierarchy?.icon} color={hierarchy?.color} size={24} />
        </span>
      {/each}
      {#if member.hierarchyGrades.length === 1}
        {@const only = member.hierarchyGrades[0].hierarchy ?? staff.hierarchyById(member.hierarchyGrades[0].hierarchyId)}
        <span class="pl-3 text-sm text-on-surface-variant truncate">{only?.name ?? ''}</span>
      {/if}
    </span>
  {:else}
    <span class="text-sm text-on-surface-variant">-</span>
  {/if}
{/snippet}

{#snippet quickActions(member: StaffMember, compact = false)}
  <div class="flex items-center justify-end gap-0.5">
    {#if staff.canManageSettings}
      <!-- Toujours visibles : monter ou descendre quelqu'un est l'action la plus
           courante de l'annuaire. Le clic ne doit pas ouvrir la fiche. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="mr-1 flex items-center gap-1" onclick={(e) => e.stopPropagation()}>
        <Button
          variant="secondary"
          size={compact ? 'sm' : 'md'}
          icon="chevrons-up"
          aria-label="{m.sm_title_promote()} {staffName(member)}"
          title={m.sm_title_promote()}
          disabled={!staff.canPromote(member)}
          disabledReason={m.sm_toast_grade_max()}
          onclick={() => staff.shiftGrade(member, 'up')}
        />
        <Button
          variant="secondary"
          size={compact ? 'sm' : 'md'}
          icon="chevrons-down"
          aria-label="{m.sm_title_demote()} {staffName(member)}"
          title={m.sm_title_demote()}
          disabled={!staff.canDemote(member)}
          disabledReason={m.sm_toast_grade_min()}
          onclick={() => staff.shiftGrade(member, 'down')}
        />
      </span>
    {/if}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span onclick={(e) => e.stopPropagation()}>
      <Menu label={m.sx_member_menu({ name: staffName(member) })} items={menuFor(member)} />
    </span>
  </div>
{/snippet}

<div class="space-y-4">
  <!-- Barre d'outils -->
  <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
    <div class="relative flex-1 lg:max-w-sm">
      <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant">
        <Papicon icon="search" size={15} />
      </span>
      <input
        type="search"
        class="input" style="padding-left: 2.25rem;"
        placeholder={m.sx_search_members()}
        aria-label={m.sx_search_members()}
        bind:value={query}
      />
    </div>
    <FilterPills label={m.sx_filter_label()} options={filterOptions} value={filter} onchange={(v) => (filter = v)} />
    <div class="flex flex-wrap items-center gap-2 lg:ml-auto">
      <select class="input h-9 py-0 pr-8 text-sm" style="width: auto;" aria-label={m.sx_sort_label()} bind:value={sort}>
        <option value="grade">{m.sx_sort_by({ what: m.sx_sort_grade() })}</option>
        <option value="name">{m.sx_sort_by({ what: m.sx_sort_name() })}</option>
        <option value="tenure">{m.sx_sort_by({ what: m.sx_sort_tenure() })}</option>
        <option value="activity">{m.sx_sort_by({ what: m.sx_sort_activity() })}</option>
      </select>
      {#if staff.canConfigureDirectory}
        <Button variant="primary" icon="plus" onclick={() => (staff.dialogs.addMember = true)}>{m.sm_btn_add_member()}</Button>
      {/if}
    </div>
  </div>

  {#if staff.loading.members && members.length === 0}
    <div class="section-card overflow-hidden" aria-busy="true">
      {#each Array(5) as _}
        <div class="flex items-center gap-4 border-b border-outline-variant px-4 py-3.5 last:border-b-0">
          <span class="h-8 w-8 animate-pulse rounded-full bg-surface-container-high"></span>
          <span class="h-3 w-40 animate-pulse rounded bg-surface-container-high"></span>
          <span class="ml-auto h-3 w-24 animate-pulse rounded bg-surface-container-high"></span>
        </div>
      {/each}
    </div>
  {:else if members.length === 0}
    <div class="section-card">
      <EmptyState
        icon="users"
        title={m.sm_empty_members_title()}
        description={m.sm_empty_members_desc()}
        actionLabel={staff.canConfigureDirectory ? m.sx_empty_members_action() : ''}
        onAction={() => (staff.dialogs.addMember = true)}
      />
    </div>
  {:else if visible.length === 0}
    <div class="section-card">
      <EmptyState icon="search" title={m.sx_no_match_title()} description={m.sx_no_match_desc()}>
        {#snippet action()}
          <Button variant="secondary" icon="rotate-ccw" onclick={resetFilters}>{m.sx_reset_filters()}</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <!-- Tableau (ecrans larges) -->
    <div class="section-card hidden overflow-hidden md:block">
      <table class="staff-table w-full">
        <thead>
          <tr>
            <th scope="col">{m.sm_col_member()}</th>
            <th scope="col">{m.sx_col_grade()}</th>
            <th scope="col" class="hidden xl:table-cell">{m.sx_col_hierarchies()}</th>
            <th scope="col" class="hidden lg:table-cell">{m.sx_col_activity()}</th>
            <th scope="col">{m.sx_col_discipline()}</th>
            <th scope="col" class="hidden lg:table-cell">{m.sx_col_tenure()}</th>
            <th scope="col"><span class="sr-only">{m.sm_col_actions()}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each visible as member (member.id)}
            <tr
              class="staff-row"
              class:staff-row--suspended={!!member.suspendedAt}
              class:staff-row--static={!openCase}
              tabindex={openCase ? 0 : undefined}
              aria-label={openCase ? m.sx_open_member({ name: staffName(member) }) : undefined}
              onclick={() => open(member)}
              onkeydown={(e) => onRowKey(e, member)}
            >
              <td>
                <div class="flex min-w-0 items-center gap-3">
                  <StaffAvatar url={member.avatarUrl} name={staffName(member)} userId={member.userId} size={32} dimmed={!!member.suspendedAt} />
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="truncate text-sm font-medium text-on-surface">{staffName(member)}</span>
                      {#if member.isTutor}
                        <span class="text-primary" title={m.sm_tutor_badge()}><Papicon icon="user-check" size={13} /></span>
                      {/if}
                    </div>
                    {#if member.suspendedAt}
                      <span class="text-xs text-warning">{m.sx_suspended_since({ date: formatDate(member.suspendedAt) })}</span>
                    {:else}
                      <span class="block truncate text-xs text-on-surface-variant">@{member.username || member.userTag || member.userId}</span>
                    {/if}
                  </div>
                </div>
              </td>
              <td><GradeChip name={member.grade} color={staff.gradeColor(member.grade)} /></td>
              <td class="hidden xl:table-cell">{@render hierarchyStack(member)}</td>
              <td class="hidden lg:table-cell">
                {#if member.stats}
                  <span class="text-sm tabular-nums text-on-surface">{formatNumber(member.stats.totalMessages)}</span>
                  <span class="text-xs text-on-surface-variant"> {m.sm_word_msg()} · {formatVoice(member.stats.totalVoiceMinutes)}</span>
                {:else}
                  <span class="text-sm text-on-surface-variant">-</span>
                {/if}
              </td>
              <td><WarnMeter count={member.warnings?.length ?? 0} {threshold} /></td>
              <td class="hidden lg:table-cell">
                <span class="text-sm text-on-surface" title={formatDate(member.joinedStaffAt)}>{formatTenure(member.joinedStaffAt)}</span>
              </td>
              <td class="whitespace-nowrap text-right">{@render quickActions(member)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="border-t border-outline-variant px-4 py-2.5 text-xs text-on-surface-variant">
        {m.sx_showing({ shown: visible.length, total: members.length })}
      </p>
    </div>

    <!-- Liste (mobile) -->
    <ul class="section-card divide-y divide-outline-variant overflow-hidden md:hidden">
      {#each visible as member (member.id)}
        <li class="flex items-center gap-3 px-4 py-3">
          <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" onclick={() => open(member)} disabled={!openCase}>
            <StaffAvatar url={member.avatarUrl} name={staffName(member)} userId={member.userId} size={40} dimmed={!!member.suspendedAt} />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-sm font-medium text-on-surface">{staffName(member)}</span>
                {#if member.suspendedAt}<span class="badge badge-warning">{m.sm_suspended_badge()}</span>{/if}
              </span>
              <span class="mt-1 flex items-center gap-3">
                <GradeChip name={member.grade} color={staff.gradeColor(member.grade)} />
                {#if member.warnings?.length}<WarnMeter count={member.warnings.length} {threshold} showLabel={false} />{/if}
              </span>
            </span>
          </button>
          {@render quickActions(member, true)}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .staff-table {
    border-collapse: collapse;
    text-align: left;
  }
  .staff-table th {
    padding: 0.625rem 1rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--on-surface-variant);
    background: var(--surface-container);
    border-bottom: 1px solid var(--outline-variant);
    white-space: nowrap;
  }
  .staff-table td {
    padding: 0.625rem 1rem;
    vertical-align: middle;
    border-bottom: 1px solid var(--outline-variant);
  }
  .staff-table tbody tr:last-child td {
    border-bottom: none;
  }
  .staff-row {
    cursor: pointer;
    transition: background-color 0.12s ease;
  }
  .staff-row:hover,
  .staff-row:focus-visible {
    background: var(--surface-hover);
  }
  .staff-row:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: -2px;
  }
  .staff-row--static {
    cursor: default;
  }
  .staff-row--suspended td:not(:last-child) {
    opacity: 0.75;
  }

</style>
