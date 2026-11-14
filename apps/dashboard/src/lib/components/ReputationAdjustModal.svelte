<script lang="ts">
  import { REPUTATION_ADJUSTMENT } from '@kotbo/shared';
  import { adjustReputation } from '../api';
  import { m } from '../i18n';
  import Modal from './Modal.svelte';
  import MemberSearchSelect from './MemberSearchSelect.svelte';
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import FilterPills from './ui/FilterPills.svelte';

  const REASON_MAX = 200;

  interface Props {
    open?: boolean;
    /** Membre déjà choisi (classement, fiche). Absent : le staff le cherche dans la fenêtre. */
    member?: { id: string; name: string } | null;
    /** Ouverte depuis la fiche membre : passe au-dessus d'elle. */
    aboveCase?: boolean;
    onDone?: (result: { before: number; after: number }) => void;
  }

  let { open = $bindable(false), member = null, aboveCase = false, onDone }: Props = $props();

  let direction = $state<'add' | 'remove'>('add');
  let amount = $state(1);
  let reason = $state('');
  let pickedId = $state('');
  let saving = $state(false);

  const userId = $derived(member?.id ?? pickedId);
  const amountValid = $derived(Number.isInteger(amount) && amount >= 1 && amount <= REPUTATION_ADJUSTMENT.max);
  const reasonValid = $derived(reason.trim().length <= REASON_MAX);
  const canSubmit = $derived(!!userId && amountValid && reasonValid && !saving);

  const directionOptions = $derived([
    { value: 'add' as const, label: m.rep_adjust_add() },
    { value: 'remove' as const, label: m.rep_adjust_remove() },
  ]);

  $effect(() => {
    if (open) {
      direction = 'add';
      amount = 1;
      reason = '';
      pickedId = '';
    }
  });

  async function submit() {
    if (!canSubmit) return;
    saving = true;
    try {
      const result = await adjustReputation({
        userId,
        amount: direction === 'add' ? amount : -amount,
        reason: reason.trim() || null,
      });
      if (!result) return;
      open = false;
      onDone?.(result);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  bind:open
  onClose={() => open = false}
  title={m.rep_adjust_title()}
  subtitle={member ? member.name : m.rep_adjust_subtitle()}
  size="sm"
  {aboveCase}
>
  <div class="space-y-5">
    {#if !member}
      <Field id="rep-adjust-member" label={m.rep_adjust_member_label()}>
        {#snippet children(id)}
          <MemberSearchSelect {id} bind:value={pickedId} placeholder={m.rep_adjust_member_placeholder()} />
        {/snippet}
      </Field>
    {/if}

    <FilterPills label={m.rep_adjust_direction_label()} options={directionOptions} value={direction} onchange={(value) => direction = value} />

    <Field
      id="rep-adjust-amount"
      label={m.rep_adjust_amount_label()}
      hint={direction === 'remove' ? m.rep_adjust_remove_hint() : m.rep_adjust_add_hint()}
      error={amountValid ? undefined : m.rep_adjust_amount_error({ max: REPUTATION_ADJUSTMENT.max })}
    >
      {#snippet children(id, describedBy)}
        <input {id} type="number" class="input max-w-32" min="1" max={REPUTATION_ADJUSTMENT.max} bind:value={amount} aria-describedby={describedBy} />
      {/snippet}
    </Field>

    <Field
      id="rep-adjust-reason"
      label={m.rep_adjust_reason_label()}
      hint={m.rep_adjust_reason_hint()}
      error={reasonValid ? undefined : m.rep_adjust_reason_error({ max: REASON_MAX })}
    >
      {#snippet children(id, describedBy)}
        <input {id} type="text" class="input" maxlength={REASON_MAX} bind:value={reason} aria-describedby={describedBy} />
      {/snippet}
    </Field>
  </div>

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => open = false}>{m.common_cancel()}</Button>
      <Button
        variant="primary"
        icon={direction === 'add' ? 'Plus' : 'Minus'}
        loading={saving}
        disabled={!canSubmit}
        onclick={submit}
      >
        {direction === 'add' ? m.rep_adjust_submit_add({ count: amountValid ? amount : 0 }) : m.rep_adjust_submit_remove({ count: amountValid ? amount : 0 })}
      </Button>
    </div>
  {/snippet}
</Modal>
