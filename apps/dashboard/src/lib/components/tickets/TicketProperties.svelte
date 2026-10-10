<!--
  Propriétés du ticket ouvert : priorité, personne en charge, étiquettes et
  échéances de service. La colonne de droite d'un ticket Zendesk, posée ici en
  bandeau au-dessus de la conversation.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import {
    assignTicket,
    fetchTicketAgents,
    updateTicketProperties,
    type SlaClock,
    type TicketAgent,
    type TicketPriority,
    type TicketSla,
  } from '../../api';

  const {
    ticket,
    knownTags = [],
    onchange,
  }: {
    ticket: {
      id: string;
      status: string;
      priority?: TicketPriority;
      tags?: string[];
      claimedById: string | null;
      claimedByName: string | null;
      sla?: TicketSla | null;
    };
    /** Étiquettes déjà utilisées sur le serveur, proposées à la saisie. */
    knownTags?: string[];
    onchange: (patch: Record<string, unknown>) => void;
  } = $props();

  const active = $derived(ticket.status === 'OPEN' || ticket.status === 'CLAIMED');

  // ── Staff ──────────────────────────────────────────────
  let agents = $state<TicketAgent[]>([]);
  onMount(async () => {
    try {
      agents = (await fetchTicketAgents())?.agents ?? [];
    } catch {
      agents = [];
    }
  });

  let saving = $state(false);

  async function setPriority(priority: TicketPriority) {
    saving = true;
    try {
      const res = await updateTicketProperties(ticket.id, { priority });
      if (res) onchange({ priority: res.ticket.priority });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.th_save_error());
    } finally {
      saving = false;
    }
  }

  async function setAssignee(userId: string) {
    saving = true;
    try {
      const res = await assignTicket(ticket.id, userId || null);
      if (res) {
        onchange({ status: res.ticket.status, claimedById: res.ticket.claimedById, claimedByName: res.ticket.claimedByName });
        toast.success(userId ? m.th_assigned({ name: res.ticket.claimedByName ?? '' }) : m.th_unassigned_done());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.th_save_error());
    } finally {
      saving = false;
    }
  }

  // ── Étiquettes ─────────────────────────────────────────
  let tagInput = $state('');
  const tags = $derived(ticket.tags ?? []);

  async function saveTags(next: string[]) {
    saving = true;
    try {
      const res = await updateTicketProperties(ticket.id, { tags: next });
      if (res) onchange({ tags: res.ticket.tags });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.th_save_error());
    } finally {
      saving = false;
    }
  }

  function addTag() {
    const tag = tagInput.trim().toLowerCase().replace(/\s+/g, '-');
    tagInput = '';
    if (!tag || tags.includes(tag)) return;
    void saveTags([...tags, tag]);
  }

  function onTagKey(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag();
    } else if (event.key === 'Backspace' && !tagInput && tags.length > 0) {
      void saveTags(tags.slice(0, -1));
    }
  }

  // ── Échéances ──────────────────────────────────────────
  let now = $state(Date.now());
  let tick: ReturnType<typeof setInterval> | null = null;
  onMount(() => { tick = setInterval(() => (now = Date.now()), 30_000); });
  onDestroy(() => { if (tick) clearInterval(tick); });

  function span(ms: number): string {
    const minutes = Math.round(Math.abs(ms) / 60_000);
    if (minutes < 60) return m.th_min({ count: Math.max(1, minutes) });
    const hours = Math.round(minutes / 60);
    return hours < 48 ? m.th_hours({ count: hours }) : m.th_days({ count: Math.round(hours / 24) });
  }

  function describe(clock: SlaClock): { text: string; tone: string } {
    if (clock.status === 'met') return { text: m.th_sla_met(), tone: 'text-success' };
    if (clock.completedAt) return { text: m.th_sla_late({ time: span(new Date(clock.completedAt).getTime() - new Date(clock.dueAt).getTime()) }), tone: 'text-error' };
    const left = new Date(clock.dueAt).getTime() - now;
    if (left < 0) return { text: m.th_sla_overdue({ time: span(left) }), tone: 'text-error' };
    return { text: m.th_sla_left({ time: span(left) }), tone: clock.status === 'at_risk' ? 'text-warning' : 'text-on-surface' };
  }

  const PRIORITIES: Array<{ value: TicketPriority; label: () => string }> = [
    { value: 'LOW', label: () => m.th_priority_low() },
    { value: 'NORMAL', label: () => m.th_priority_normal() },
    { value: 'HIGH', label: () => m.th_priority_high() },
    { value: 'URGENT', label: () => m.th_priority_urgent() },
  ];

  const tagListId = `ticket-tags-${Math.random().toString(36).slice(2)}`;
</script>

<div class="tp-grid" aria-busy={saving}>
  <label class="tp-field">
    <span>{m.th_priority()}</span>
    <select class="input tp-select" value={ticket.priority ?? 'NORMAL'} onchange={(event) => setPriority(event.currentTarget.value as TicketPriority)}>
      {#each PRIORITIES as option (option.value)}<option value={option.value}>{option.label()}</option>{/each}
    </select>
  </label>

  <label class="tp-field">
    <span>{m.th_assignee()}</span>
    <select class="input tp-select" value={ticket.claimedById ?? ''} disabled={!active} onchange={(event) => setAssignee(event.currentTarget.value)}>
      <option value="">{m.th_nobody()}</option>
      {#if ticket.claimedById && !agents.some((agent) => agent.id === ticket.claimedById)}
        <option value={ticket.claimedById}>{ticket.claimedByName ?? ticket.claimedById}</option>
      {/if}
      {#each agents as agent (agent.id)}
        <option value={agent.id}>{agent.name}{agent.openTickets ? ` · ${m.th_agent_load({ count: agent.openTickets })}` : ''}</option>
      {/each}
    </select>
  </label>

  <div class="tp-field tp-field--wide">
    <span>{m.th_tags()}</span>
    <div class="tp-tags">
      {#each tags as tag (tag)}
        <span class="tp-tag">#{tag}<button type="button" aria-label={m.th_remove_tag({ tag })} onclick={() => saveTags(tags.filter((t) => t !== tag))}><Papicon icon="x" size={10} /></button></span>
      {/each}
      <input
        class="tp-tag-input"
        list={tagListId}
        placeholder={tags.length ? '' : m.th_add_tag()}
        bind:value={tagInput}
        onkeydown={onTagKey}
        onblur={addTag}
        maxlength="30"
      />
      <datalist id={tagListId}>{#each knownTags.filter((tag) => !tags.includes(tag)) as tag (tag)}<option value={tag}></option>{/each}</datalist>
    </div>
  </div>

  {#if ticket.sla?.firstResponse || ticket.sla?.resolution}
    <div class="tp-field">
      <span>{m.th_sla()}</span>
      <div class="flex flex-col text-2xs leading-snug">
        {#if ticket.sla.firstResponse}
          {@const d = describe(ticket.sla.firstResponse)}
          <span>{m.th_sla_first()} <strong class="font-medium {d.tone}">{d.text}</strong></span>
        {/if}
        {#if ticket.sla.resolution}
          {@const d = describe(ticket.sla.resolution)}
          <span>{m.th_sla_resolution()} <strong class="font-medium {d.tone}">{d.text}</strong></span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .tp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: 0.6rem 0.9rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--outline-variant) 60%, transparent);
  }
  .tp-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .tp-field > span {
    font-size: 0.6875rem;
    color: var(--on-surface-variant);
  }
  .tp-field--wide {
    grid-column: span 2;
  }
  .tp-select {
    padding: 0.35rem 0.55rem;
    font-size: 0.8125rem;
  }
  .tp-tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    min-height: 2rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.5rem;
    background: var(--surface-container-lowest);
  }
  .tp-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.05rem 0.35rem 0.05rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-container);
    color: var(--on-surface);
    font-size: 0.6875rem;
  }
  .tp-tag button {
    display: inline-flex;
    color: var(--on-surface-variant);
  }
  .tp-tag-input {
    flex: 1;
    min-width: 5rem;
    border: none;
    outline: none;
    background: transparent;
    color: var(--on-surface);
    font-size: 0.75rem;
  }
  @media (max-width: 640px) {
    .tp-field--wide {
      grid-column: auto;
    }
  }
</style>
