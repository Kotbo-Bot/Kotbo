<!--
  Référent et échéance de suivi d'un dossier. Le référent est choisi parmi la
  cellule, jamais la personne concernée ; l'échéance a ses raccourcis.
-->
<script lang="ts">
  import { m } from '../../i18n';
  import MemberName from '../MemberName.svelte';
  import { Button, Field } from '../ui';
  import { WB_REVIEW_SHORTCUTS, wbReviewShortcut } from '../../wellbeingView';

  type FollowUpPatch = { assigneeId?: string | null; reviewAt?: string | null };

  const {
    item,
    canWrite,
    busy,
    viewerId,
    candidates,
    onpatch,
  }: {
    item: { subjectUserId?: string | null; assigneeId?: string | null; reviewAt?: string | null };
    canWrite: boolean;
    /** Un geste est en cours : les contrôles attendent. */
    busy: boolean;
    viewerId: string | undefined;
    /** Membres de la cellule proposables, sans la personne concernée. */
    candidates: Array<{ id: string; name: string }>;
    onpatch: (patch: FollowUpPatch) => void;
  } = $props();

  let candidate = $state('');
</script>

<div class="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-xl bg-surface-container-high/20 p-4">
  <Field label={m.wb_assignee()} hint={m.wb_assignee_hint()}>
    {#snippet children(id, describedBy)}
      {#if item.assigneeId}
        <div class="flex items-center justify-between gap-2 text-sm min-h-9">
          <MemberName userId={item.assigneeId} />
          {#if canWrite}
            <Button size="sm" variant="ghost" icon="X" disabled={busy} aria-label={m.wb_assignee_clear()} onclick={() => onpatch({ assigneeId: null })} />
          {/if}
        </div>
      {:else if canWrite}
        <div class="space-y-1.5">
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={candidate} disabled={busy}
            onchange={() => { const assigneeId = candidate; candidate = ''; if (assigneeId) onpatch({ assigneeId }); }}>
            <option value="">{m.wb_member_pick()}</option>
            {#each candidates as member (member.id)}
              <option value={member.id}>{member.name}</option>
            {/each}
          </select>
          {#if viewerId && viewerId !== item.subjectUserId}
            <Button size="sm" variant="ghost" icon="User" disabled={busy} onclick={() => onpatch({ assigneeId: viewerId })}>{m.wb_assign_me()}</Button>
          {/if}
        </div>
      {:else}
        <p class="text-sm text-on-surface-variant min-h-9 flex items-center">{m.wb_assignee_none()}</p>
      {/if}
    {/snippet}
  </Field>
  <Field label={m.wb_review_at()} hint={m.wb_review_hint()}>
    {#snippet children(id, describedBy)}
      <div class="space-y-1.5">
        <div class="flex items-center gap-2">
          <input {id} aria-describedby={describedBy} type="date" class="input w-full" disabled={busy || !canWrite}
            value={item.reviewAt ? item.reviewAt.slice(0, 10) : ''}
            onchange={(e) => onpatch({ reviewAt: e.currentTarget.value || null })} />
          {#if item.reviewAt && canWrite}
            <Button size="sm" variant="ghost" icon="X" disabled={busy} aria-label={m.wb_review_clear()} onclick={() => onpatch({ reviewAt: null })} />
          {/if}
        </div>
        {#if canWrite}
          <div role="group" aria-label={m.wb_review_shortcuts()} class="flex flex-wrap gap-1.5">
            {#each WB_REVIEW_SHORTCUTS as days (days)}
              <Button size="sm" variant="ghost" disabled={busy} onclick={() => onpatch({ reviewAt: wbReviewShortcut(new Date(), days) })}>{m.wb_review_in_days({ days })}</Button>
            {/each}
          </div>
        {/if}
      </div>
    {/snippet}
  </Field>
</div>
