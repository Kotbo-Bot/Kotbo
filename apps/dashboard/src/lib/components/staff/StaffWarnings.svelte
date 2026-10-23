<!--
  Registre des avertissements du staff. Les membres proches du seuil passent
  en tete : c'est la qu'une decision se prend. Une ligne supprimee part avec
  « Annuler », sans fenetre de confirmation.
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import EmptyState from '../EmptyState.svelte';
  import { Button, FilterPills, Callout } from '../ui';
  import StaffAvatar from './StaffAvatar.svelte';
  import WarnMeter from './WarnMeter.svelte';
  import { staff, staffName, type StaffWarning } from './staffStore.svelte';

  const { openCase }: { openCase?: (userId: string, name: string) => void } = $props();
  import { formatDate, formatRelative } from './format';
  import { m } from '../../i18n';

  type Filter = 'active' | 'expired' | 'all';
  let filter = $state<Filter>('active');
  let query = $state('');

  const threshold = $derived(staff.config.warnsToDemote || 3);

  const counts = $derived({
    active: staff.warnings.filter((w) => w.isActive).length,
    expired: staff.warnings.filter((w) => !w.isActive).length,
    all: staff.warnings.length,
  });

  /** Membres a un avertissement (ou moins) du seuil de retrogradation. */
  const nearThreshold = $derived(
    staff.activeMembers
      .filter((member) => (member.warnings?.length ?? 0) > 0 && (member.warnings?.length ?? 0) >= threshold - 1)
      .sort((a, b) => (b.warnings?.length ?? 0) - (a.warnings?.length ?? 0)),
  );

  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return staff.warnings
      .filter((w) => (filter === 'all' ? true : filter === 'active' ? w.isActive : !w.isActive))
      .filter((w) => !q || [w.staffDisplayName, w.reason, w.issuedByTag, w.staffUserId].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  });

  function memberOf(warning: StaffWarning) {
    return staff.memberByUserId(warning.staffUserId);
  }
</script>

<div class="space-y-4">
  {#if nearThreshold.length > 0}
    <Callout variant="warning" title={m.sx_near_threshold_title({ n: nearThreshold.length })}>
      {m.sx_near_threshold_desc({ n: threshold })}
      {#snippet actions()}
        {#each nearThreshold.slice(0, 4) as member (member.id)}
          <button type="button" class="near-chip" onclick={() => openCase?.(member.userId, staffName(member))}>
            <StaffAvatar url={member.avatarUrl} name={staffName(member)} userId={member.userId} size={20} />
            <span class="text-sm text-on-surface">{staffName(member)}</span>
            <WarnMeter count={member.warnings?.length ?? 0} {threshold} />
          </button>
        {/each}
      {/snippet}
    </Callout>
  {/if}

  <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
    <div class="relative flex-1 lg:max-w-sm">
      <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant"><Papicon icon="search" size={15} /></span>
      <input type="search" class="input" style="padding-left: 2.25rem;" placeholder={m.sx_search_warnings()} aria-label={m.sx_search_warnings()} bind:value={query} />
    </div>
    <FilterPills
      label={m.sx_filter_label()}
      value={filter}
      onchange={(v) => (filter = v)}
      options={[
        { value: 'active', label: m.sx_filter_in_force(), count: counts.active },
        { value: 'expired', label: m.sx_filter_expired(), count: counts.expired },
        { value: 'all', label: m.common_all(), count: counts.all },
      ]}
    />
    {#if staff.canModerate}
      <Button variant="primary" icon="plus" class="lg:ml-auto" onclick={() => (staff.dialogs.warn = { userId: '' })}>{m.sm_btn_new_warning()}</Button>
    {/if}
  </div>

  {#if staff.loading.warnings && staff.warnings.length === 0}
    <div class="section-card overflow-hidden" aria-busy="true">
      {#each Array(3) as _}
        <div class="h-14 animate-pulse border-b border-outline-variant last:border-b-0"></div>
      {/each}
    </div>
  {:else if staff.warnings.length === 0}
    <div class="section-card">
      <EmptyState
        icon="shield-check"
        title={m.sm_empty_warnings_title()}
        description={m.sm_empty_warnings_desc()}
        actionLabel={staff.canModerate ? m.sm_btn_new_warning() : ''}
        onAction={() => (staff.dialogs.warn = { userId: '' })}
      />
    </div>
  {:else if visible.length === 0}
    <div class="section-card">
      <EmptyState
        icon="search"
        title={m.sx_no_match_title()}
        description={filter === 'active' ? m.sx_no_active_warning() : m.sx_no_match_desc()}
        actionLabel={m.sx_show_all_warnings()}
        actionIcon="list"
        onAction={() => { query = ''; filter = 'all'; }}
      />
    </div>
  {:else}
    <ul class="section-card divide-y divide-outline-variant overflow-hidden">
      {#each visible as warning (warning.id)}
        {@const member = memberOf(warning)}
        <li class="warn-row" class:warn-row--expired={!warning.isActive}>
          <button
            type="button"
            class="flex min-w-0 items-center gap-3 rounded-lg text-left sm:w-56 sm:shrink-0"
            onclick={() => openCase?.(warning.staffUserId, warning.staffDisplayName || staffName(member))}
            disabled={!openCase}
          >
            <StaffAvatar url={warning.staffAvatarUrl ?? member?.avatarUrl} name={warning.staffDisplayName ?? staffName(member)} userId={warning.staffUserId} size={32} />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium text-on-surface">{warning.staffDisplayName || staffName(member)}</span>
              <span class="block truncate text-xs text-on-surface-variant">{member?.grade ?? warning.staffUserId}</span>
            </span>
          </button>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-on-surface">{warning.reason}</p>
            <p class="mt-0.5 text-xs text-on-surface-variant">
              {#if warning.issuedByTag}{m.sx_by({ name: warning.issuedByTag })} · {/if}
              <time datetime={warning.createdAt} title={formatDate(warning.createdAt)}>{formatRelative(warning.createdAt)}</time>
              {#if warning.isActive && warning.expiresAt}
                · {m.sx_expires({ when: formatRelative(warning.expiresAt) })}
              {/if}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-3">
            {#if warning.isActive}
              <span class="badge badge-warning">{m.sm_status_active()}</span>
            {:else}
              <span class="badge badge-neutral">{m.sm_status_expired()}</span>
            {/if}
            {#if staff.canModerate}
              <Button variant="ghost" size="sm" icon="trash-2" aria-label={m.sm_title_delete_warning()} title={m.sm_title_delete_warning()} onclick={() => staff.deleteWarning(warning)} />
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .warn-row {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
  }
  @media (min-width: 640px) {
    .warn-row {
      flex-direction: row;
      align-items: center;
      gap: 1.25rem;
    }
  }
  .warn-row--expired > :not(:last-child) {
    opacity: 0.65;
  }
  .near-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.625rem 0.25rem 0.25rem;
    border-radius: 9999px;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
    transition: background-color 0.15s ease;
  }
  .near-chip:hover {
    background: var(--surface-hover);
  }
</style>
