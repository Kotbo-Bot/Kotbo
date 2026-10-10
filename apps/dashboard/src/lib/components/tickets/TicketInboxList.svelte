<!--
  Boîte de réception du support.

  Une vue par file de travail (comme dans Zendesk ou Front) avec son
  compteur, une recherche, l'ordre de traitement, et pour chaque ticket ce
  qui décide de son urgence : priorité, échéance de service, et à qui revient
  la parole. `j` / `k` parcourent la liste au clavier.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import { FilterPills, type FilterOption } from '../ui';
  import { m } from '../../i18n';
  import type { InboxTicket, InboxView } from '../../api';
  import { EMOTION_COLORS, emotionLabel } from '../aegis/aegisFormat';

  const {
    tickets,
    view,
    counts,
    sort,
    loading = false,
    loadingMore = false,
    hasMore = false,
    selectedId = null,
    slaConfigured = false,
    statusLabel,
    onview,
    onsearch,
    onsort,
    onselect,
    onloadmore,
  }: {
    tickets: InboxTicket[];
    view: InboxView;
    counts: Partial<Record<InboxView, number>>;
    sort: 'newest' | 'oldest';
    loading?: boolean;
    loadingMore?: boolean;
    hasMore?: boolean;
    selectedId?: string | null;
    slaConfigured?: boolean;
    statusLabel: (status: string) => string;
    onview: (view: InboxView) => void;
    onsearch: (query: string) => void;
    onsort: (sort: 'newest' | 'oldest') => void;
    onselect: (ticketId: string) => void;
    onloadmore: () => void;
  } = $props();

  const viewOptions: FilterOption<InboxView>[] = $derived([
    { value: 'open', label: m.th_view_open(), count: counts.open },
    { value: 'unassigned', label: m.th_view_unassigned(), count: counts.unassigned },
    { value: 'mine', label: m.th_view_mine(), count: counts.mine },
    { value: 'waiting_staff', label: m.th_view_waiting(), count: counts.waiting_staff },
    ...(slaConfigured ? [{ value: 'breached' as const, label: m.th_view_breached(), count: counts.breached }] : []),
    ...((counts.pending ?? 0) > 0 || view === 'pending' ? [{ value: 'pending' as const, label: m.th_view_pending(), count: counts.pending }] : []),
    { value: 'closed', label: m.th_view_closed() },
    { value: 'all', label: m.th_view_all() },
  ]);

  // ── Recherche, en différé ──────────────────────────────
  let query = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function updateQuery(value: string) {
    query = value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => onsearch(query.trim()), 300);
  }

  // ── Horloge des échéances ──────────────────────────────
  let now = $state(Date.now());
  let tick: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    tick = setInterval(() => (now = Date.now()), 30_000);
    window.addEventListener('keydown', onKeydown);
  });
  onDestroy(() => {
    if (tick) clearInterval(tick);
    if (searchTimer) clearTimeout(searchTimer);
    window.removeEventListener('keydown', onKeydown);
  });

  /** `j` / `k` (et les flèches avec Alt) parcourent la liste, hors saisie. */
  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (event.ctrlKey || event.metaKey) return;
    const down = event.key === 'j' || (event.altKey && event.key === 'ArrowDown');
    const up = event.key === 'k' || (event.altKey && event.key === 'ArrowUp');
    if (!down && !up) return;
    if (tickets.length === 0) return;
    event.preventDefault();
    const index = tickets.findIndex((ticket) => ticket.id === selectedId);
    const next = index === -1 ? 0 : Math.min(tickets.length - 1, Math.max(0, index + (down ? 1 : -1)));
    onselect(tickets[next].id);
    document.getElementById(`inbox-row-${tickets[next].id}`)?.scrollIntoView({ block: 'nearest' });
  }

  function ago(iso: string | null): string {
    if (!iso) return '';
    const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
    if (minutes < 1) return m.th_now();
    if (minutes < 60) return m.th_min({ count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return m.th_hours({ count: hours });
    return m.th_days({ count: Math.round(hours / 24) });
  }

  function remaining(iso: string): string {
    const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
    if (minutes < 60) return m.th_min({ count: Math.max(1, minutes) });
    return m.th_hours({ count: Math.round(minutes / 60) });
  }

  /** Pastille de service : l'échéance la plus proche qui n'est pas tenue. */
  function slaBadge(ticket: InboxTicket): { label: string; tone: string } | null {
    const clocks = [ticket.sla.firstResponse, ticket.sla.resolution].filter((clock) => clock && !clock.completedAt);
    const breached = clocks.find((clock) => clock!.status === 'breached');
    if (breached) return { label: m.th_sla_breached({ time: ago(breached.dueAt) }), tone: 'bg-error/10 text-error' };
    const atRisk = clocks.find((clock) => clock!.status === 'at_risk');
    if (atRisk) return { label: m.th_sla_due({ time: remaining(atRisk.dueAt) }), tone: 'bg-warning/10 text-warning' };
    return null;
  }

  const PRIORITY_BAR: Record<string, string> = {
    URGENT: 'bg-error',
    HIGH: 'bg-warning',
    NORMAL: 'bg-transparent',
    LOW: 'bg-transparent',
  };
</script>

<div class="flex flex-col h-full min-h-0">
  <div class="space-y-3 mb-3">
    <label class="relative block">
      <span class="sr-only">{m.th_search()}</span>
      <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant"><Papicon icon="search" size={14} /></span>
      <input
        type="search"
        class="input w-full inbox-search"
        placeholder={m.th_search_placeholder()}
        value={query}
        oninput={(event) => updateQuery(event.currentTarget.value)}
      />
    </label>
    <FilterPills label={m.th_views()} options={viewOptions} value={view} onchange={onview} />
    <div class="flex items-center justify-between text-2xs text-on-surface-variant">
      <span>{m.th_shortcuts()}</span>
      <button type="button" class="flex items-center gap-1 hover:text-on-surface" onclick={() => onsort(sort === 'oldest' ? 'newest' : 'oldest')}>
        <Papicon icon={sort === 'oldest' ? 'arrow-up' : 'arrow-down'} size={12} />
        {sort === 'oldest' ? m.th_sort_oldest() : m.th_sort_newest()}
      </button>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto -mx-1 px-1 space-y-1.5" role="listbox" aria-label={m.th_views()}>
    {#if loading && tickets.length === 0}
      {#each Array(6) as _}
        <div class="h-[4.5rem] rounded-lg bg-surface-container/40 animate-pulse"></div>
      {/each}
    {:else if tickets.length === 0}
      <div class="flex flex-col items-center justify-center py-14 text-center text-on-surface-variant">
        <Papicon icon="inbox" size={26} />
        <p class="mt-2 text-body-sm font-medium text-on-surface">{view === 'open' || view === 'mine' || view === 'unassigned' || view === 'waiting_staff' || view === 'breached' ? m.th_empty_done() : m.th_empty()}</p>
        <p class="text-2xs mt-0.5">{m.th_empty_desc()}</p>
      </div>
    {:else}
      {#each tickets as ticket (ticket.id)}
        {@const badge = slaBadge(ticket)}
        <button
          type="button"
          id={`inbox-row-${ticket.id}`}
          role="option"
          aria-selected={selectedId === ticket.id}
          class="inbox-row {selectedId === ticket.id ? 'inbox-row--active' : ''}"
          onclick={() => onselect(ticket.id)}
        >
          <span class="inbox-row__priority {PRIORITY_BAR[ticket.priority] ?? 'bg-transparent'}" aria-hidden="true"></span>
          {#if ticket.userAvatar}
            <img src={ticket.userAvatar} alt="" class="w-8 h-8 rounded-lg object-cover shrink-0" />
          {:else}
            <span class="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-body-sm font-semibold text-on-surface-variant shrink-0">{ticket.username?.charAt(0).toUpperCase() || '?'}</span>
          {/if}
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline justify-between gap-2">
              <span class="text-body-sm font-semibold text-on-surface truncate">
                {#if ticket.waitingOn === 'staff'}<span class="inbox-dot" title={m.th_waiting_staff()}></span>{/if}
                @{ticket.username}
              </span>
              <span class="text-2xs text-on-surface-variant shrink-0 tabular-nums" title={new Date(ticket.createdAt).toLocaleString()}>{ago(ticket.lastMemberMessageAt ?? ticket.createdAt)}</span>
            </span>
            <span class="block text-2xs text-on-surface-variant truncate mt-0.5">
              {#if ticket.ticketTypeLabel}<span class="text-on-surface">{ticket.ticketTypeLabel}</span> · {/if}{ticket.reason}
            </span>
            <span class="flex flex-wrap items-center gap-1 mt-1.5">
              {#if ticket.status !== 'OPEN' && ticket.status !== 'CLAIMED'}
                <span class="inbox-chip bg-surface-container text-on-surface-variant">{statusLabel(ticket.status)}</span>
              {/if}
              {#if ticket.priority === 'URGENT' || ticket.priority === 'HIGH'}
                <span class="inbox-chip {ticket.priority === 'URGENT' ? 'bg-error/10 text-error' : 'bg-warning/10 text-warning'}">{ticket.priority === 'URGENT' ? m.th_priority_urgent() : m.th_priority_high()}</span>
              {/if}
              {#if badge}<span class="inbox-chip {badge.tone}">{badge.label}</span>{/if}
              {#if ticket.moodLabel === 'anger' || ticket.moodLabel === 'sad' || ticket.moodLabel === 'fear'}
                <span class="inbox-chip bg-surface-container text-on-surface-variant" title={m.aegis_ticket_mood({ mood: emotionLabel(ticket.moodLabel) })}>
                  <span class="inbox-mood" style="background: {EMOTION_COLORS[ticket.moodLabel]};" aria-hidden="true"></span>{emotionLabel(ticket.moodLabel)}
                </span>
              {/if}
              {#if ticket.waitingOn === 'member'}<span class="inbox-chip bg-surface-container text-on-surface-variant">{m.th_waiting_member()}</span>{/if}
              {#each ticket.tags.slice(0, 3) as tag (tag)}<span class="inbox-chip bg-surface-container text-on-surface-variant">#{tag}</span>{/each}
              {#if ticket.claimedByName}
                <span class="ml-auto flex items-center gap-1 text-2xs text-on-surface-variant" title={m.th_assigned_to({ name: ticket.claimedByName })}>
                  {#if ticket.claimedByAvatar}<img src={ticket.claimedByAvatar} alt="" class="w-4 h-4 rounded-full" />{:else}<Papicon icon="user" size={11} />{/if}
                  <span class="truncate max-w-[6rem]">{ticket.claimedByName}</span>
                </span>
              {/if}
            </span>
          </span>
        </button>
      {/each}
      {#if hasMore}
        <button type="button" class="w-full mt-1 py-2 rounded-lg text-xs text-on-surface-variant hover:bg-surface-container disabled:opacity-50" disabled={loadingMore} onclick={onloadmore}>
          {loadingMore ? m.e1_tickets_loading_more() : m.e1_tickets_load_more()}
        </button>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* `.input` fixe son propre retrait gauche : sans cette règle, plus précise,
     le texte passait sous la loupe. */
  .inbox-search {
    padding-left: 2.25rem;
  }
  .inbox-row {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    width: 100%;
    padding: 0.65rem 0.75rem 0.65rem 0.9rem;
    border: 1px solid transparent;
    border-radius: 0.625rem;
    text-align: left;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .inbox-row:hover {
    background: var(--surface-container-low);
  }
  .inbox-row--active {
    border-color: color-mix(in srgb, var(--primary) 45%, transparent);
    background: color-mix(in srgb, var(--primary) 7%, transparent);
  }
  .inbox-mood {
    display: inline-block;
    width: 0.4375rem;
    height: 0.4375rem;
    margin-right: 0.25rem;
    border-radius: 999px;
  }

  .inbox-row__priority {
    position: absolute;
    left: 0.3rem;
    top: 0.7rem;
    bottom: 0.7rem;
    width: 3px;
    border-radius: 999px;
  }
  .inbox-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    line-height: 1.4;
  }
  .inbox-dot {
    display: inline-block;
    width: 0.45rem;
    height: 0.45rem;
    margin-right: 0.3rem;
    border-radius: 999px;
    background: var(--primary);
    vertical-align: middle;
  }
</style>
