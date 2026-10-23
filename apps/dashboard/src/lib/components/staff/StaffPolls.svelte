<!--
  Sondages internes du staff. Les votes sont ponderes par le grade ; les
  resultats ne s'affichent qu'apres avoir vote, pour ne pas orienter le choix.
-->
<script lang="ts">
  import Modal from '../Modal.svelte';
  import Papicon from '../Papicon.svelte';
  import EmptyState from '../EmptyState.svelte';
  import { Button, Field, FilterPills } from '../ui';
  import { authStore } from '../../stores/auth.svelte';
  import { staff, isPollClosed, type StaffPoll } from './staffStore.svelte';
  import { formatDate, formatRelative } from './format';
  import { m } from '../../i18n';

  type Filter = 'open' | 'closed';
  let filter = $state<Filter>('open');
  $effect(() => {
    // Rien en cours : on montre les resultats plutot qu'une liste vide.
    if (!staff.loading.polls && staff.openPolls.length === 0 && staff.polls.length > 0) filter = 'closed';
  });

  const visible = $derived(staff.polls.filter((poll) => (filter === 'open' ? !isPollClosed(poll) : isPollClosed(poll))));

  function voteWeight(v: { weight?: number }) {
    return v.weight || 1;
  }

  function results(poll: StaffPoll) {
    const votes = poll.votes ?? [];
    const total = votes.reduce((s, v) => s + voteWeight(v), 0);
    const options = poll.options.map((option) => {
      const optionVotes = votes.filter((v) => v.optionId === option.id);
      const weight = optionVotes.reduce((s, v) => s + voteWeight(v), 0);
      return { ...option, weight, voters: optionVotes.length, percent: total > 0 ? (weight / total) * 100 : 0 };
    });
    const top = Math.max(0, ...options.map((o) => o.weight));
    const mine = votes.find((v) => (v.staffMember?.userId ?? v.userId) === authStore.user?.id);
    return { total, options, top, mine, voters: votes.length };
  }

  // ── Creation ──
  let creating = $state(false);
  let title = $state('');
  let description = $state('');
  let options = $state<string[]>(['', '']);
  let closesAt = $state('');
  let saving = $state(false);

  function openCreate() {
    title = '';
    description = '';
    options = ['', ''];
    closesAt = '';
    creating = true;
  }

  async function submit() {
    saving = true;
    const ok = await staff.createPoll({ title, description, options, closesAt });
    saving = false;
    if (ok) {
      creating = false;
      filter = 'open';
    }
  }

  const canSubmit = $derived(!!title.trim() && options.filter((o) => o.trim()).length >= 2);
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <FilterPills
      label={m.sx_filter_label()}
      value={filter}
      onchange={(v) => (filter = v)}
      options={[
        { value: 'open', label: m.sm_poll_ongoing_badge(), count: staff.openPolls.length },
        { value: 'closed', label: m.sx_polls_closed(), count: staff.polls.length - staff.openPolls.length },
      ]}
    />
    {#if staff.canModerate}
      <Button variant="primary" icon="plus" onclick={openCreate}>{m.sm_btn_new_poll()}</Button>
    {/if}
  </div>

  {#if staff.loading.polls && staff.polls.length === 0}
    <div class="grid gap-4 lg:grid-cols-2">
      {#each Array(2) as _}<div class="section-card h-56 animate-pulse"></div>{/each}
    </div>
  {:else if visible.length === 0}
    <div class="section-card">
      <EmptyState
        icon="bar-chart"
        title={filter === 'open' ? m.sx_polls_none_open() : m.sm_empty_polls()}
        description={m.sx_polls_empty_desc()}
        actionLabel={staff.canModerate ? m.sx_polls_empty_action() : ''}
        onAction={openCreate}
      />
    </div>
  {:else}
    <div class="grid gap-4 lg:grid-cols-2">
      {#each visible as poll (poll.id)}
        {@const closed = isPollClosed(poll)}
        {@const r = results(poll)}
        {@const reveal = closed || !!r.mine}
        <article class="section-card flex flex-col p-5">
          <header class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-xs text-on-surface-variant">
                {#if closed}
                  <span class="badge badge-neutral">{m.sm_poll_closed_badge()}</span>
                {:else}
                  <span class="badge badge-success"><span class="h-1.5 w-1.5 rounded-full bg-success"></span>{m.sm_poll_ongoing_badge()}</span>
                {/if}
                <span class="truncate">{m.sm_poll_by({ author: poll.author?.displayName || poll.author?.username || '' })}</span>
              </div>
              <h3 class="mt-2 text-base font-semibold leading-snug text-on-surface">{poll.title}</h3>
              {#if poll.description}
                <p class="mt-1 text-sm text-on-surface-variant">{poll.description}</p>
              {/if}
            </div>
            {#if !closed && staff.canManageSettings}
              <Button variant="ghost" size="sm" icon="lock" title={m.sm_title_close_now()} aria-label={m.sm_title_close_now()} onclick={() => staff.closePoll(poll.id)} />
            {/if}
          </header>

          <div class="mt-4 space-y-2" role="group" aria-label={poll.title}>
            {#each r.options as option (option.id)}
              {@const isMine = r.mine?.optionId === option.id}
              {@const isTop = reveal && option.weight > 0 && option.weight === r.top}
              <button
                type="button"
                class="poll-option"
                class:poll-option--mine={isMine}
                class:poll-option--revealed={reveal}
                disabled={closed || !!r.mine}
                onclick={() => staff.vote(poll.id, option.id)}
                style="--fill: {reveal ? option.percent : 0}%"
              >
                <span class="relative flex min-w-0 items-center gap-2">
                  {#if isMine}<Papicon icon="check-circle" size={14} class="shrink-0 text-primary" />{/if}
                  <span class="truncate text-sm {isTop ? 'font-semibold text-on-surface' : 'text-on-surface'}">{option.text}</span>
                </span>
                {#if reveal}
                  <span class="relative shrink-0 text-xs tabular-nums text-on-surface-variant">{Math.round(option.percent)} %</span>
                {/if}
              </button>
            {/each}
          </div>

          <footer class="mt-4 flex items-center justify-between gap-3 border-t border-outline-variant pt-3 text-xs text-on-surface-variant">
            <span>{m.sx_poll_voters({ n: r.voters, weight: r.total.toFixed(1).replace(/\.0$/, '') })}</span>
            {#if !closed && poll.closesAt}
              <span class="inline-flex items-center gap-1" title={formatDate(poll.closesAt)}><Papicon icon="clock" size={12} />{m.sx_poll_ends({ when: formatRelative(poll.closesAt) })}</span>
            {:else if !closed && !r.mine}
              <span class="text-primary">{m.sx_poll_vote_to_see()}</span>
            {/if}
          </footer>
        </article>
      {/each}
    </div>
  {/if}
</div>

<Modal open={creating} onClose={() => (creating = false)} title={m.sm_btn_new_poll()} subtitle={m.sm_polls_desc()}>
  <div class="space-y-4">
    <Field label={m.sm_field_poll_title()} required>
      {#snippet children(id)}
        <input {id} class="input" type="text" placeholder={m.sm_placeholder_poll_title()} bind:value={title} />
      {/snippet}
    </Field>
    <Field label={m.sm_field_description()}>
      {#snippet children(id)}
        <textarea {id} class="input resize-none" rows="2" placeholder={m.sm_placeholder_poll_desc()} bind:value={description}></textarea>
      {/snippet}
    </Field>
    <fieldset class="space-y-2">
      <legend class="field-label">{m.sm_field_poll_options()}</legend>
      {#each options as _option, i (i)}
        <div class="flex items-center gap-2">
          <input class="input" aria-label={m.sm_placeholder_option_n({ n: i + 1 })} placeholder={m.sm_placeholder_option_n({ n: i + 1 })} bind:value={options[i]} />
          {#if options.length > 2}
            <Button variant="ghost" size="sm" icon="x" aria-label={m.sx_remove_option({ n: i + 1 })} onclick={() => (options = options.filter((_, j) => j !== i))} />
          {/if}
        </div>
      {/each}
      <Button variant="ghost" size="sm" icon="plus" onclick={() => (options = [...options, ''])}>{m.sm_btn_add_option()}</Button>
    </fieldset>
    <Field label={m.sm_field_poll_closes()} hint={m.sx_poll_closes_hint()}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input" type="datetime-local" bind:value={closesAt} />
      {/snippet}
    </Field>
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (creating = false)}>{m.common_cancel()}</Button>
      <Button variant="primary" icon="check-square" loading={saving} disabled={!canSubmit} disabledReason={m.sm_toast_poll_min_options()} onclick={submit}>{m.sm_btn_publish_poll()}</Button>
    </div>
  {/snippet}
</Modal>

<style>
  .poll-option {
    position: relative;
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    overflow: hidden;
    padding: 0.5625rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
    text-align: left;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }
  .poll-option::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--fill);
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
    transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .poll-option:not(:disabled):hover {
    border-color: var(--primary-color);
    background: color-mix(in srgb, var(--primary-color) 4%, transparent);
  }
  .poll-option:disabled {
    cursor: default;
  }
  .poll-option--mine {
    border-color: color-mix(in srgb, var(--primary-color) 50%, transparent);
  }
</style>
