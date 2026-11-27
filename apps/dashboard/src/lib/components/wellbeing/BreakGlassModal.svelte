<!--
  Demande d'accès d'urgence par la direction : motif obligatoire, portée
  limitable à un membre. Selon les réglages, une seconde personne valide.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import MemberSearchSelect from '../MemberSearchSelect.svelte';
  import { Button, Callout, Field, Modal } from '../ui';

  let {
    open = $bindable(false),
    approvalRequired,
    ondone,
  }: {
    open?: boolean;
    /** Une seconde personne doit valider la demande. */
    approvalRequired: boolean;
    /** Demande envoyée : la page relit son état. */
    ondone: () => Promise<void>;
  } = $props();

  let reason = $state('');
  let subjectUserId = $state('');
  let submitting = $state(false);

  async function activate(event: SubmitEvent) {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    try {
      const res = await dashboardFetch('/wellbeing/break-glass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), subjectUserId: subjectUserId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '');
      open = false;
      reason = '';
      subjectUserId = '';
      toast.success(data.pending ? m.toast_wb_break_glass_pending() : m.toast_wb_break_glass_on());
      await ondone();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_break_glass_failed());
    } finally {
      submitting = false;
    }
  }
</script>

<Modal bind:open title={m.wb_bg_modal_title()} size="sm">
  <form id="bg-form" onsubmit={activate} class="space-y-4">
    <Callout variant="warning">
      {m.wb_bg_modal_desc()}
    </Callout>
    <Field label={m.wb_bg_reason()} required>
      {#snippet children(id)}
        <textarea {id} bind:value={reason} required minlength={8} rows={3} class="input w-full" placeholder={m.wb_bg_reason_ph()}></textarea>
      {/snippet}
    </Field>
    <Field label={m.wb_bg_scope()} hint={m.wb_bg_scope_hint()}>
      {#snippet children(id, describedBy)}
        <MemberSearchSelect {id} {describedBy} bind:value={subjectUserId} placeholder={m.wb_member_ph()} />
      {/snippet}
    </Field>
    {#if approvalRequired}
      <p class="text-xs text-on-surface-variant">{m.wb_bg_approval_hint()}</p>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="bg-form" loading={submitting}>{m.wb_bg_confirm()}</Button>
  {/snippet}
</Modal>
