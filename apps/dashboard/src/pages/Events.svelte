<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { Button, EmptyState, FilterPills, Menu, Modal, SectionCard } from '../lib/components/ui';
  import { EVENT_TYPES, eventTypeMeta, statusLabel, statusTone, type EventType } from '../lib/components/events/eventTypes';
  import { tournamentPublicPath } from '../lib/api/tournaments';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { dashboardFetch } from '../lib/api';
  import { m, dateLocale } from '../lib/i18n';

  type EventRow = {
    id: string;
    guildId: string;
    title: string;
    description: string | null;
    type: EventType;
    status: string;
    triggerType: string | null;
    triggerValue: string | null;
    createdAt: string;
    _count?: { questions: number; ctfChallenges: number; participants: number; registrations: number };
  };
  type Filter = 'all' | 'draft' | 'live' | 'done';

  let events = $state<EventRow[]>([]);
  let loaded = $state(false);
  let isFetching = $state(false);
  let showTypeModal = $state(false);
  let creating = $state<EventType | null>(null);
  let filter = $state<Filter>('all');

  const canManageEvents = $derived(
    !!dashboardStore.state.featureAccess?.events?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
      || !!dashboardStore.state.access?.canModerateContent
  );

  const inFilter = (event: EventRow, f: Filter) =>
    f === 'all'
    || (f === 'draft' && event.status === 'DRAFT')
    || (f === 'live' && (event.status === 'PUBLISHED' || event.status === 'ONGOING'))
    || (f === 'done' && (event.status === 'COMPLETED' || event.status === 'CANCELLED'));

  const visible = $derived(events.filter((e) => inFilter(e, filter)));
  const filters = $derived<{ value: Filter; label: string; count: number }[]>([
    { value: 'all', label: m.ev_filter_all(), count: events.length },
    { value: 'draft', label: m.ev_filter_draft(), count: events.filter((e) => inFilter(e, 'draft')).length },
    { value: 'live', label: m.ev_filter_live(), count: events.filter((e) => inFilter(e, 'live')).length },
    { value: 'done', label: m.ev_filter_done(), count: events.filter((e) => inFilter(e, 'done')).length },
  ]);

  onMount(loadEvents);

  async function loadEvents() {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    isFetching = true;
    try {
      const res = await dashboardFetch(`/events`, { guildId });
      const data = await res.json();
      events = data.events || [];
    } catch {
      toast.error(m.ev_load_error());
    } finally {
      isFetching = false;
      loaded = true;
    }
  }

  function defaultTitle(type: EventType) {
    switch (type) {
      case 'QUIZ': return m.ev_new_quiz();
      case 'CTF': return m.ev_new_ctf();
      case 'TOURNAMENT': return m.ev_new_tournament();
      default: return m.ev_new_event();
    }
  }

  async function createEventWithType(type: EventType) {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    creating = type;
    try {
      const res = await dashboardFetch(`/events`, {
        guildId,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: defaultTitle(type), type, description: '' }),
      });
      const data = await res.json();
      if (!res.ok || !data.event) throw new Error(data.error);
      toast.success(m.ev_created_toast());
      showTypeModal = false;
      router.goto(`/events/edit/${data.event.id}`);
    } catch {
      toast.error(m.ev_create_error());
    } finally {
      creating = null;
    }
  }

  async function deleteEvent(event: EventRow) {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    const people = (event._count?.participants || 0) + (event._count?.registrations || 0);
    const confirmed = await confirmDialog.danger(
      m.ev_delete_confirm_title({ title: event.title }),
      m.ev_delete_confirm_desc(),
      m.ev_btn_delete(),
      people ? [m.ev_delete_impact_people({ count: people })] : [],
    );
    if (!confirmed) return;
    try {
      const res = await dashboardFetch(`/events/${event.id}`, { guildId, method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success(m.ev_deleted_toast());
      events = events.filter((e) => e.id !== event.id);
    } catch {
      toast.error(m.ev_delete_error());
    }
  }

  /** L'action qui fait avancer l'événement selon son état : préparer, piloter, suivre ou relire. */
  function primaryAction(event: EventRow): { label: string; icon: string; href: string } {
    if (event.status === 'DRAFT') return { label: m.ev_btn_prepare(), icon: 'Edit3', href: `/events/edit/${event.id}` };
    const control = `/events/control/${event.id}`;
    if (event.type === 'TOURNAMENT') return { label: m.ev_btn_manage_tournament(), icon: 'Trophy', href: control };
    if (event.type === 'CUSTOM') return { label: m.ev_btn_registrations(), icon: 'Users', href: control };
    if (event.status === 'COMPLETED' || event.status === 'CANCELLED') return { label: m.ev_btn_results(), icon: 'BarChart2', href: control };
    return { label: m.ev_btn_control(), icon: 'Play', href: control };
  }

  function countLabel(event: EventRow) {
    const c = event._count;
    if (event.type === 'QUIZ') return m.ev_count_questions({ count: c?.questions || 0 });
    if (event.type === 'CTF') return m.ev_count_challenges({ count: c?.ctfChallenges || 0 });
    return m.ev_count_registrations({ count: c?.registrations || 0 });
  }

  function dateLabel(event: EventRow) {
    const scheduled = event.triggerType === 'SCHEDULED' && event.triggerValue ? new Date(event.triggerValue) : null;
    const date = scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : new Date(event.createdAt);
    const text = date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
    return scheduled ? m.ev_scheduled_on({ date: text }) : m.ev_created_on({ date: text });
  }
</script>

<ModulePage title={m.ev_page_title()} description={m.ev_page_desc()} icon="Zap" featureKey="events">
  {#snippet actions()}
    <div class="flex gap-3">
      <RefreshButton onClick={loadEvents} loading={isFetching} label={m.common_refresh()} />
      {#if canManageEvents}
        <Button variant="primary" icon="Plus" onclick={() => (showTypeModal = true)}>{m.ev_new_event()}</Button>
      {/if}
    </div>
  {/snippet}

  <div class="space-y-6 pb-20">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <MetricCard label={m.ev_total_events()} value={events.length} icon="Zap" loading={!loaded} />
      <MetricCard label={m.ev_ongoing_events()} value={filters[2].count} icon="Play" toneClass="bg-success/10 text-success" loading={!loaded} />
      <MetricCard
        label={m.ev_participations_registrations()}
        value={events.reduce((acc, e) => acc + (e._count?.participants || 0) + (e._count?.registrations || 0), 0)}
        icon="Users"
        toneClass="bg-tertiary/10 text-tertiary"
        loading={!loaded}
      />
    </div>

    <SectionCard title={m.ev_list_title()} icon="Calendar" flush>
      {#snippet actions()}
        {#if events.length}
          <FilterPills label={m.ev_filter_label()} options={filters} value={filter} onchange={(v) => (filter = v)} />
        {/if}
      {/snippet}

      {#if !loaded}
        <div class="space-y-3 p-4">
          {#each [0, 1, 2] as i (i)}<div class="h-16 animate-pulse rounded-lg bg-surface-container-high"></div>{/each}
        </div>
      {:else if !events.length}
        <EmptyState
          icon="Zap"
          title={m.ev_no_event_title()}
          description={m.ev_no_event_desc()}
          reason={canManageEvents ? 'instruction' : 'read-only'}
          actionLabel={canManageEvents ? m.ev_create_first() : undefined}
          onAction={canManageEvents ? () => (showTypeModal = true) : undefined}
        />
      {:else if !visible.length}
        <EmptyState icon="Filter" title={m.ev_filter_empty()} reason="nothing-matches" actionLabel={m.ev_filter_all()} onAction={() => (filter = 'all')} />
      {:else}
        <ul class="divide-y divide-outline-variant">
          {#each visible as event (event.id)}
            {@const meta = eventTypeMeta(event.type)}
            {@const action = primaryAction(event)}
            <li class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
              <a href="/events/edit/{event.id}" class="flex min-w-0 flex-1 items-center gap-4 no-underline">
                <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg {meta.tone}">
                  <Papicon icon={meta.icon} size={20} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="truncate font-semibold text-on-surface">{event.title}</span>
                    <span class="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium {statusTone(event.status)}">{statusLabel(event.status)}</span>
                  </span>
                  <span class="mt-1 block truncate text-sm text-on-surface-variant">
                    {meta.label()} · {countLabel(event)} · {dateLabel(event)}
                  </span>
                </span>
              </a>
              <div class="flex shrink-0 items-center gap-2">
                <Button variant={event.status === 'DRAFT' ? 'secondary' : 'primary'} size="sm" icon={action.icon} href={action.href}>{action.label}</Button>
                {#if canManageEvents}
                  <Menu
                    label={m.ev_more_actions({ title: event.title })}
                    items={[
                      { label: m.ev_btn_edit(), icon: 'Edit3', onselect: () => router.goto(`/events/edit/${event.id}`) },
                      ...(event.type === 'TOURNAMENT' && event.status !== 'DRAFT'
                        ? [{ label: m.tn_open_public(), icon: 'ExternalLink', onselect: () => window.open(tournamentPublicPath(event.guildId, event.id), '_blank', 'noopener') }]
                        : []),
                      { label: m.ev_btn_delete(), description: m.ev_delete_menu_desc(), icon: 'Trash2', onselect: () => deleteEvent(event) },
                    ]}
                  />
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </SectionCard>
  </div>
</ModulePage>

<Modal open={showTypeModal} title={m.ev_select_type_title()} subtitle={m.ev_select_type_desc()} size="lg" onClose={() => { if (!creating) showTypeModal = false; }}>
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    {#each EVENT_TYPES as et (et.type)}
      <button
        type="button"
        onclick={() => createEventWithType(et.type)}
        disabled={!!creating}
        class="flex flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-low p-5 text-left transition-colors hover:border-primary/40 hover:bg-surface-container disabled:cursor-wait disabled:opacity-60"
      >
        <span class="flex items-center gap-3">
          <span class="flex h-10 w-10 items-center justify-center rounded-lg {et.tone}"><Papicon icon={et.icon} size={20} /></span>
          <span>
            <span class="block font-semibold text-on-surface">{et.label()}</span>
            <span class="block text-xs text-on-surface-variant">{et.tag()}</span>
          </span>
        </span>
        <span class="text-sm leading-relaxed text-on-surface-variant">{et.description()}</span>
        {#if creating === et.type}
          <span class="text-xs text-primary">{m.ev_creating()}</span>
        {/if}
      </button>
    {/each}
  </div>
</Modal>
