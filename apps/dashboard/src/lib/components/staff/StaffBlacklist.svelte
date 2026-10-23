<!--
  Liste noire du staff : qui ne peut plus revenir, pourquoi, et jusqu'a quand.
-->
<script lang="ts">
  import EmptyState from '../EmptyState.svelte';
  import { Button } from '../ui';
  import StaffAvatar from './StaffAvatar.svelte';
  import { staff, staffName } from './staffStore.svelte';
  import { formatDate, formatRelative } from './format';
  import { m } from '../../i18n';

  const rows = $derived(
    staff.blacklistedMembers.map((member) => ({ member, entry: member.blacklistEntries![0] })),
  );
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <p class="text-sm text-on-surface-variant">{m.sm_blacklist_desc()}</p>
    {#if staff.canModerate}
      <Button variant="danger" icon="slash" onclick={() => (staff.dialogs.blacklist = { userId: '' })}>{m.sm_btn_blacklist()}</Button>
    {/if}
  </div>

  {#if staff.loading.members && rows.length === 0}
    <div class="section-card h-32 animate-pulse" aria-busy="true"></div>
  {:else if rows.length === 0}
    <div class="section-card">
      <EmptyState
        icon="user-x"
        title={m.sm_blacklist_empty_title()}
        description={m.sm_blacklist_empty_desc()}
        actionLabel={staff.canModerate ? m.sm_btn_blacklist() : ''}
        actionIcon="slash"
        onAction={() => (staff.dialogs.blacklist = { userId: '' })}
      />
    </div>
  {:else}
    <ul class="section-card divide-y divide-outline-variant overflow-hidden">
      {#each rows as { member, entry } (member.id)}
        <li class="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-5">
          <div class="flex min-w-0 items-center gap-3 sm:w-56 sm:shrink-0">
            <StaffAvatar url={member.avatarUrl} name={staffName(member)} userId={member.userId} size={32} dimmed />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium text-on-surface">{staffName(member)}</span>
              <span class="block truncate text-xs text-on-surface-variant">@{member.username || member.userId}</span>
            </span>
          </div>
          <p class="min-w-0 flex-1 text-sm text-on-surface">{entry?.reason || '-'}</p>
          <div class="flex shrink-0 items-center gap-3">
            {#if entry?.endDate}
              <span class="badge badge-neutral" title={formatDate(entry.endDate)}>{m.sx_until({ when: formatRelative(entry.endDate) })}</span>
            {:else}
              <span class="badge badge-danger">{m.sm_permanent()}</span>
            {/if}
            {#if staff.canModerate}
              <Button variant="ghost" size="sm" icon="rotate-ccw" onclick={() => staff.liftBlacklist(member)}>{m.sm_btn_remove_blacklist()}</Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
