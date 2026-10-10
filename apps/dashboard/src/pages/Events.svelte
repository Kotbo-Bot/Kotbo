<script lang="ts">
  import { onMount } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { dashboardFetch } from '../lib/api';
  import { m } from '../lib/i18n';

  let events = $state<any[]>([]);
  let isFetching = $state(false);
  let showTypeModal = $state(false);
  let isCreating = $state(false);

  const EVENT_TYPES = $derived([
    {
      type: 'QUIZ',
      label: 'Quiz',
      icon: 'HelpCircle',
      description: m.ev_quiz_desc(),
      color: 'from-blue-500/20 to-indigo-500/20',
      border: 'border-blue-500/30 hover:border-blue-400/60',
      iconBg: 'bg-blue-500/10 text-blue-400',
      tag: m.ev_quiz_tag(),
      tagColor: 'bg-blue-500/15 text-blue-400',
    },
    {
      type: 'CTF',
      label: 'Capture The Flag',
      icon: 'Flag',
      description: m.ev_ctf_desc(),
      color: 'from-emerald-500/20 to-teal-500/20',
      border: 'border-success/30 hover:border-success/60',
      iconBg: 'bg-success/10 text-success',
      tag: m.ev_ctf_tag(),
      tagColor: 'bg-success/15 text-success',
    },
    {
      type: 'CUSTOM',
      label: 'Événement Personnalisé',
      icon: 'Calendar',
      description: m.ev_custom_desc(),
      color: 'from-purple-500/20 to-pink-500/20',
      border: 'border-purple-500/30 hover:border-purple-400/60',
      iconBg: 'bg-purple-500/10 text-purple-400',
      tag: m.ev_custom_tag(),
      tagColor: 'bg-purple-500/15 text-purple-400',
    },
  ]);

  const canManageEvents = $derived(
    !!dashboardStore.state.featureAccess?.events?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
      || !!dashboardStore.state.access?.canModerateContent
  );

  onMount(async () => {
    await loadEvents();
  });

  async function loadEvents() {
    isFetching = true;
    try {
      const guildId = authStore.selectedGuildId;
      if (!guildId) return;
      const res = await dashboardFetch(`/events`, { guildId,
        });
      const data = await res.json();
      events = data.events || [];
    } catch (err) {
      toast.error('Erreur lors du chargement des événements');
    } finally {
      isFetching = false;
    }
  }

  function getStatusLabel(status: string) {
    switch (status) {
      case 'DRAFT': return m.ev_status_draft();
      case 'PUBLISHED': return m.ev_status_published();
      case 'ONGOING': return m.ev_status_ongoing();
      case 'COMPLETED': return m.ev_status_completed();
      case 'CANCELLED': return m.ev_status_cancelled();
      default: return status;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'DRAFT': return 'bg-on-surface/5 text-on-surface-variant/60';
      case 'PUBLISHED': return 'bg-blue-500/10 text-blue-500';
      case 'ONGOING': return 'bg-success/10 text-success';
      case 'COMPLETED': return 'bg-purple-500/10 text-purple-500';
      case 'CANCELLED': return 'bg-error/10 text-error';
      default: return 'bg-on-surface/5 text-on-surface-variant/60';
    }
  }

  async function createEventWithType(type: 'QUIZ' | 'CTF' | 'CUSTOM') {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    isCreating = true;
    try {
      const res = await dashboardFetch(`/events`, { guildId,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify({
          title: type === 'CTF' ? m.ev_new_ctf() : type === 'CUSTOM' ? m.ev_new_event() : m.ev_new_quiz(),
          type,
          description: m.ev_default_description()
        })
      });
      const data = await res.json();
      if (data.event) {
        toast.success(m.ev_created_toast());
        showTypeModal = false;
        router.goto(`/events/edit/${data.event.id}`);
      }
    } catch (err) {
      toast.error('Erreur lors de la création');
    } finally {
      isCreating = false;
    }
  }

  async function deleteEvent(eventId: string, title: string) {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;

    const confirmDelete = await confirmDialog.danger(
      m.ev_delete_confirm_title({ title }),
      m.ev_delete_confirm_desc(),
    );
    if (!confirmDelete) return;

    try {
      const res = await dashboardFetch(`/events/${eventId}`, { guildId,
        method: 'DELETE'
        });
      if (res.ok) {
        toast.success(m.ev_deleted_toast());
        await loadEvents();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Erreur lors de la suppression');
      }
    } catch (err) {
      toast.error('Erreur de connexion avec le serveur');
    }
  }
</script>

<!-- ── Modal sélection du type d'événement ───────────────────────── -->
{#if showTypeModal}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="modal-title"
    tabindex="-1"
    class="fixed inset-0 z-50 flex items-center justify-center p-6"
    onkeydown={(e) => { if (e.key === 'Escape' && !isCreating) showTypeModal = false; }}
  >
    <!-- Backdrop -->
    <button
      type="button"
      class="absolute inset-0 bg-black/40 border-none cursor-default w-full h-full text-left p-0"
      onclick={() => { if (!isCreating) showTypeModal = false; }}
      aria-label="Fermer"
    ></button>

    <!-- Panneau -->
    <div
      class="relative z-10 bg-surface-container rounded-xl border border-outline-variant/20 shadow-sm w-full max-w-2xl p-10 flex flex-col gap-8"
    >
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 id="modal-title" class="text-2xl font-semibold text-on-surface">{m.ev_select_type_title()}</h2>
          <p class="text-on-surface-variant/50 text-sm mt-1">{m.ev_select_type_desc()}</p>
        </div>
        <button
          onclick={() => showTypeModal = false}
          class="w-10 h-10 rounded-lg bg-on-surface/5 hover:bg-on-surface/10 flex items-center justify-center text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
          aria-label="Fermer la modale"
          disabled={isCreating}
        >
          <Papicon icon="X" size={18} />
        </button>
      </div>

      <!-- Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {#each EVENT_TYPES as et}
          <button
            onclick={() => createEventWithType(et.type as 'CUSTOM' | 'QUIZ' | 'CTF')}
            disabled={isCreating}
            class="group relative flex flex-col gap-5 p-7 rounded-xl border bg-gradient-to-br text-left
 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed
                   {et.color} {et.border}"
          >
            <!-- Icon -->
            <div class="w-14 h-14 rounded-[1.2rem] {et.iconBg} flex items-center justify-center transition-transform">
              <Papicon icon={et.icon} size={26} />
            </div>

            <!-- Text -->
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-3">
                <span class="text-lg font-semibold text-on-surface">{et.label}</span>
                <span class="px-2.5 py-0.5 rounded-lg text-xs font-semibold {et.tagColor}">
                  {et.tag}
                </span>
              </div>
              <p class="text-on-surface-variant/60 text-sm leading-relaxed">{et.description}</p>
            </div>

            <!-- Arrow indicator -->
            <div class="absolute bottom-6 right-6 opacity-0 group-hover:opacity-100 transition-opacity text-on-surface-variant/40">
              <Papicon icon="ArrowRight" size={18} />
            </div>
          </button>
        {/each}
      </div>

      {#if isCreating}
        <p class="text-center text-on-surface-variant/50 text-sm animate-pulse">{m.ev_creating()}</p>
      {/if}
    </div>
  </div>
{/if}

<!-- ── Page principale ─────────────────────────────────────────────── -->
<ModulePage 
  title={m.ev_page_title()} 
  description={m.ev_page_desc()} 
  icon="Zap"
  featureKey="events"
>
  {#snippet actions()}
    <div class="flex gap-3">
      <RefreshButton
        onClick={loadEvents}
        loading={isFetching}
        label={m.common_refresh()}
      />
      {#if canManageEvents}
        <button
          onclick={() => showTypeModal = true}
          class="px-4 py-2 bg-primary text-on-primary rounded-xl font-medium text-body-sm transition-transform"
        >
          {m.ev_new_event()}
        </button>
      {/if}
    </div>
  {/snippet}

  <div class="space-y-10 pb-20">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="bg-surface-container-low/40 rounded-xl p-8 border border-outline-variant/10">
        <p class="text-xs font-medium text-on-surface-variant/40">{m.ev_total_events()}</p>
        <p class="text-lg font-semibold text-on-surface mt-2">{events.length}</p>
      </div>
      <div class="bg-surface-container-low/40 rounded-xl p-8 border border-outline-variant/10">
        <p class="text-xs font-medium text-on-surface-variant/40">{m.ev_ongoing_events()}</p>
        <p class="text-lg font-semibold text-success mt-2">{events.filter(e => e.status === 'ONGOING').length}</p>
      </div>
      <div class="bg-surface-container-low/40 rounded-xl p-8 border border-outline-variant/10">
        <p class="text-xs font-medium text-on-surface-variant/40">{m.ev_participations_registrations()}</p>
        <p class="text-lg font-semibold text-on-surface mt-2">{events.reduce((acc, e) => acc + (e._count?.participants || 0) + (e._count?.registrations || 0), 0)}</p>
      </div>
    </div>

    <section class="space-y-6">
      <h3 class="text-xl font-semibold text-on-surface px-2">{m.ev_list_title()}</h3>

      <div class="grid grid-cols-1 gap-4">
        {#each events as event}
          <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 group hover:bg-surface-container-low/50 transition-colors">
            <!-- min-w-0 en cascade : sans lui, une description longue etire la
                 colonne au lieu d'etre tronquee, ce qui comprime l'icone et
                 pousse les boutons hors de la carte. -->
            <div class="flex items-center gap-6 min-w-0 flex-1">
              <div class="w-16 h-16 shrink-0 rounded-xl flex items-center justify-center
 {event.type === 'CTF' ? 'bg-success/10 text-success' : event.type === 'CUSTOM' ? 'bg-purple-500/10 text-purple-400' : 'bg-blue-500/10 text-blue-400'}">
                <Papicon icon={event.type === 'CTF' ? 'Flag' : event.type === 'CUSTOM' ? 'Calendar' : 'HelpCircle'} size={24} />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center flex-wrap gap-x-3 gap-y-1.5">
                  <h4 class="text-xl font-semibold text-on-surface truncate">{event.title}</h4>
                  <span class="shrink-0 px-3 py-1 rounded-lg text-xs font-semibold {getStatusColor(event.status)} border border-current/10">
                    {getStatusLabel(event.status)}
                  </span>
                  <span class="shrink-0 px-2.5 py-0.5 rounded-lg text-2xs font-semibold uppercase tracking-widest
 {event.type === 'CTF' ? 'bg-success/15 text-success' : event.type === 'CUSTOM' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'}">
                    {event.type === 'CTF' ? 'CTF' : event.type === 'CUSTOM' ? 'Custom' : 'Quiz'}
                  </span>
                </div>
                <p class="text-on-surface-variant/60 mt-1 line-clamp-1">{event.description || m.ev_no_description()}</p>
                <div class="flex items-center flex-wrap gap-4 mt-3">
                  {#if event.type === 'CTF'}
                    <span class="text-2xs font-bold text-on-surface-variant/40 flex items-center gap-1.5">
                      <Papicon icon="Flag" size={12} /> {m.ev_count_challenges({ count: event._count?.ctfChallenges || 0 })}
                    </span>
                  {:else if event.type === 'QUIZ'}
                    <span class="text-2xs font-bold text-on-surface-variant/40 flex items-center gap-1.5">
                      <Papicon icon="HelpCircle" size={12} /> {m.ev_count_questions({ count: event._count?.questions || 0 })}
                    </span>
                  {/if}
                  {#if event.type === 'CUSTOM'}
                    <span class="text-2xs font-bold text-on-surface-variant/40 flex items-center gap-1.5">
                      <Papicon icon="UserPlus" size={12} /> {m.ev_count_registrations({ count: event._count?.registrations || 0 })}
                    </span>
                  {:else}
                    <span class="text-2xs font-bold text-on-surface-variant/40 flex items-center gap-1.5">
                      <Papicon icon="Users" size={12} /> {m.ev_count_participants({ count: event._count?.participants || 0 })}
                    </span>
                  {/if}
                </div>
              </div>
            </div>

            <div class="flex items-center flex-wrap md:justify-end gap-3 shrink-0">
              {#if (event.status === 'ONGOING' || event.status === 'PUBLISHED') && event.type !== 'CUSTOM'}
                <button
                  onclick={() => router.goto(`/events/control/${event.id}`)}
                  class="px-6 py-3 bg-emerald-500 text-white rounded-lg text-xs font-medium transition-transform flex items-center gap-2 whitespace-nowrap"
                >
                  <Papicon icon="Play" size={12} /> {m.ev_btn_control()}
                </button>
              {/if}
              {#if event.type === 'CUSTOM' && (event.status === 'PUBLISHED' || event.status === 'ONGOING' || event.status === 'COMPLETED')}
                <button
                  onclick={() => router.goto(`/events/control/${event.id}`)}
                  class="px-6 py-3 bg-purple-500/10 text-purple-400 rounded-lg text-xs font-medium border border-purple-500/20 hover:bg-purple-500/20 transition-colors flex items-center gap-2 whitespace-nowrap"
                >
                  <Papicon icon="Users" size={12} /> {m.ev_btn_registrations()}
                </button>
              {/if}
              {#if event.status === 'COMPLETED' && event.type !== 'CUSTOM'}
                <button
                  onclick={() => router.goto(`/events/control/${event.id}`)}
                  class="px-6 py-3 bg-primary/10 text-primary rounded-lg text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors flex items-center gap-2 whitespace-nowrap"
                >
                  <Papicon icon="BarChart2" size={12} /> {m.ev_btn_stats()}
                </button>
              {/if}
              <button 
                onclick={() => router.goto(`/events/edit/${event.id}`)}
                class="px-6 py-3 bg-surface-container-high rounded-lg text-xs font-medium border border-outline-variant/10 hover:bg-surface-container-highest transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                <Papicon icon="Edit3" size={12} /> {m.ev_btn_edit()}
              </button>
              {#if canManageEvents}
                <button 
                  onclick={() => deleteEvent(event.id, event.title)}
                  class="px-6 py-3 bg-error/10 text-error rounded-lg text-xs font-medium border border-error/20 hover:bg-error/20 transition-colors flex items-center gap-2 whitespace-nowrap"
                >
                  <Papicon icon="Trash" size={12} /> {m.ev_btn_delete()}
                </button>
              {/if}
            </div>
          </div>
        {:else}
          <div class="py-20 text-center bg-surface-container-low/20 rounded-xl border border-dashed border-outline-variant/20">
            <div class="w-20 h-20 bg-on-surface/5 rounded-full flex items-center justify-center mx-auto mb-6 text-on-surface-variant/20">
              <Papicon icon="Zap" size={40} />
            </div>
            <p class="text-on-surface-variant/60 font-semibold text-xl">{m.ev_no_event_title()}</p>
            {#if canManageEvents}
              <button onclick={() => showTypeModal = true} class="mt-6 text-primary font-semibold text-xs hover:underline">
                {m.ev_create_first()}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  </div>
</ModulePage>
