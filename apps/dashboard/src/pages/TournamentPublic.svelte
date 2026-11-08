<script lang="ts">
  /**
   * Page publique de suivi d'un tournoi (`/:serverId/tournaments/:eventId`),
   * liée depuis l'annonce Discord. Elle se rafraîchit seule pendant le direct
   * et permet à chacun d'exporter l'état du tableau en image.
   */
  import { tick } from 'svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, EmptyState, Tabs } from '../lib/components/ui';
  import TournamentBoard from '../lib/components/events/TournamentBoard.svelte';
  import TournamentStandings from '../lib/components/events/TournamentStandings.svelte';
  import { fetchPublicTournament, type PublicTournament } from '../lib/api/tournaments';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';

  const { serverId, eventId }: { serverId: string; eventId: string } = $props();

  const REFRESH_MS = 20_000;

  let tournament = $state<PublicTournament | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  let failed = $state(false);
  let tab = $state<'board' | 'standings'>('board');
  let board = $state<ReturnType<typeof TournamentBoard>>();

  const live = $derived(tournament?.event.status === 'ONGOING');

  async function load() {
    try {
      const next = await fetchPublicTournament(serverId, eventId);
      missing = !next;
      tournament = next;
      failed = false;
    } catch {
      // Un rafraîchissement raté garde l'affichage précédent ; seul le premier chargement montre l'erreur.
      failed = !tournament;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void serverId;
    void eventId;
    loading = true;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && tournament?.event.status === 'ONGOING') void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  });

  async function exportImage() {
    tab = 'board';
    await tick();
    try {
      await board?.exportPng(tournament?.event.title ?? 'tournoi');
    } catch {
      toast.error(m.tn_export_failed());
    }
  }
</script>

<svelte:head>
  <title>{tournament ? m.tn_public_page_title({ title: tournament.event.title, guild: tournament.guildName }) : m.tn_public_fallback_title()}</title>
  {#if tournament}
    <meta name="description" content={m.tn_public_meta_desc({ title: tournament.event.title, guild: tournament.guildName })} />
  {/if}
</svelte:head>

<div class="min-h-screen bg-surface px-4 py-8 sm:px-6">
  <div class="mx-auto max-w-7xl space-y-6">
    {#if loading && !tournament}
      <Skeleton height="h-16" />
      <Skeleton height="h-96" />
    {:else if missing || failed || !tournament}
      <EmptyState
        icon="Trophy"
        title={failed ? m.tn_public_error_title() : m.tn_public_missing_title()}
        description={failed ? m.tn_public_error_desc() : m.tn_public_missing_desc()}
        reason={failed ? 'instruction' : 'nothing-matches'}
        actionLabel={failed ? m.common_retry() : undefined}
        onAction={failed ? () => void load() : undefined}
      />
    {:else}
      <header class="section-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-center gap-4">
          {#if tournament.guildIcon}
            <img src={tournament.guildIcon} alt="" class="h-12 w-12 shrink-0 rounded-xl" />
          {:else}
            <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Papicon icon="Trophy" size={22} /></div>
          {/if}
          <div class="min-w-0">
            <p class="truncate text-sm text-on-surface-variant">{tournament.guildName}</p>
            <h1 class="truncate text-xl font-semibold text-on-surface">{tournament.event.title}</h1>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          {#if live}
            <span class="inline-flex items-center gap-2 rounded-lg bg-error/10 px-3 py-1.5 text-sm font-semibold text-error">
              <span class="h-2 w-2 animate-pulse rounded-full bg-error"></span>{m.tn_live()}
            </span>
          {:else if tournament.event.status === 'COMPLETED'}
            <span class="rounded-lg bg-surface-container-high px-3 py-1.5 text-sm font-medium text-on-surface">{m.ev_status_completed()}</span>
          {:else}
            <span class="rounded-lg bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary">{m.tn_registrations_open()}</span>
          {/if}
          {#if tournament.seeded}
            <Button variant="secondary" icon="Image" onclick={exportImage}>{m.tn_export_png()}</Button>
          {/if}
        </div>
      </header>

      {#if tournament.event.description}
        <p class="whitespace-pre-line text-on-surface-variant">{tournament.event.description}</p>
      {/if}

      {#if tournament.champion}
        <div class="section-card flex items-center gap-4 p-5">
          <span class="text-3xl" aria-hidden="true">🏆</span>
          <div>
            <p class="text-sm text-on-surface-variant">{m.tn_champion()}</p>
            <p class="text-lg font-semibold text-on-surface">{tournament.champion.name}</p>
          </div>
        </div>
      {/if}

      {#if !tournament.seeded}
        <EmptyState
          icon="Users"
          title={m.tn_public_not_started_title()}
          description={m.tn_public_not_started_desc({ count: tournament.registrations })}
          reason="accumulating"
        />
      {:else}
        <Tabs
          label={m.tn_tabs_label()}
          active={tab}
          onchange={(id) => (tab = id as typeof tab)}
          tabs={[
            { id: 'board', label: m.tn_tab_board(), icon: 'GitBranch' },
            { id: 'standings', label: m.tn_tab_standings(), icon: 'Trophy' },
          ]}
        />
        {#if tab === 'board'}
          <div class="overflow-x-auto rounded-xl border border-outline-variant">
            <TournamentBoard bind:this={board} {tournament} {live} />
          </div>
          {#if live}
            <p class="text-xs text-on-surface-variant">{m.tn_public_refresh_hint()}</p>
          {/if}
        {:else}
          <TournamentStandings {tournament} />
        {/if}
      {/if}

      <footer class="flex items-center justify-center gap-2 pt-4 text-xs text-on-surface-variant">
        <Papicon icon="Zap" size={12} /> {m.tn_powered_by()}
      </footer>
    {/if}
  </div>
</div>
