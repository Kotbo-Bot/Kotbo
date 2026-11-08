<!--
  Pilotage d'un tournoi depuis le dashboard : génération de l'arbre, saisie
  des scores en cliquant sur un match, classement, têtes de série, export en
  image et lien vers la page publique de suivi.
-->
<script lang="ts">
  import { onDestroy, onMount, tick, type Snippet } from 'svelte';
  import { Button, Callout, EmptyState, Menu, SectionCard, Tabs } from '../ui';
  import TournamentBoard from './TournamentBoard.svelte';
  import TournamentMatchDialog from './TournamentMatchDialog.svelte';
  import TournamentStandings from './TournamentStandings.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { subscribeRealtime } from '../../stores/realtime.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    clearTournamentMatch,
    fetchTournament,
    generateTournament,
    resetTournament,
    saveTournamentMatch,
    swapTournamentSeeds,
    tournamentPublicPath,
    type Tournament,
    type TournamentMatch,
  } from '../../api/tournaments';
  import { m } from '../../i18n';

  let { eventId, registrations }: { eventId: string; registrations: Snippet } = $props();

  let tournament = $state<Tournament | null>(null);
  let tab = $state<'board' | 'standings' | 'seeds' | 'registrations'>('board');
  let busy = $state(false);
  let editing = $state<TournamentMatch | null>(null);
  let board = $state<ReturnType<typeof TournamentBoard>>();
  let unsubscribe: (() => void) | null = null;

  const publicUrl = $derived(tournament ? `${window.location.origin}${tournamentPublicPath(tournament.event.guildId, eventId)}` : '');
  const played = $derived(tournament?.stages.some((s) => s.rounds.flat().some((mt) => mt.status === 'done' || mt.status === 'live')) ?? false);

  async function load() {
    tournament = await fetchTournament(eventId).catch(() => tournament);
  }

  onMount(async () => {
    await load();
    if (tournament && !tournament.seeded) tab = 'registrations';
    unsubscribe = subscribeRealtime({ reasons: ['events_updated'], fallbackMs: 10000, onUpdate: () => void load() });
  });
  onDestroy(() => unsubscribe?.());

  async function run(action: () => Promise<Tournament | null>, success?: string) {
    busy = true;
    try {
      const next = await action();
      if (next) {
        tournament = next;
        if (success) toast.success(success);
      }
      return !!next;
    } catch {
      // Le client d'API a déjà affiché l'erreur (score refusé, réseau…).
      return false;
    } finally {
      busy = false;
    }
  }

  async function generate(shuffle: boolean) {
    if (tournament?.seeded && !(await confirmDialog.ask({
      title: m.tn_regenerate_confirm_title(),
      description: m.tn_regenerate_confirm_desc(),
      confirmLabel: m.tn_regenerate_confirm_btn(),
      variant: 'warning',
    }))) return;
    if (await run(() => generateTournament(eventId, shuffle), m.tn_generated_toast())) tab = 'board';
  }

  async function reset() {
    if (!(await confirmDialog.danger(m.tn_reset_confirm_title(), m.tn_reset_confirm_desc(), m.tn_reset_confirm_btn()))) return;
    if (await run(() => resetTournament(eventId), m.tn_reset_toast())) tab = 'registrations';
  }

  async function saveMatch(score: { score1: number; score2: number } | { sets: [number, number][] }) {
    if (!editing) return;
    const match = editing;
    if (await run(() => saveTournamentMatch(eventId, match, score), m.tn_score_saved_toast())) editing = null;
  }

  async function clearMatch() {
    if (!editing) return;
    const match = editing;
    if (await run(() => clearTournamentMatch(eventId, match))) editing = null;
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success(m.tn_link_copied());
    } catch {
      toast.error(m.tn_link_copy_failed());
    }
  }

  async function exportImage() {
    // Le tableau n'existe que sous son onglet : on y passe avant d'exporter.
    tab = 'board';
    await tick();
    try {
      await board?.exportPng(tournament?.event.title ?? 'tournoi');
    } catch {
      toast.error(m.tn_export_failed());
    }
  }

  const formatLabel = $derived(
    !tournament ? '' :
    tournament.settings.format === 'DOUBLE' ? m.tn_format_double() :
    tournament.settings.format === 'GROUPS' ? m.tn_format_groups() : m.tn_format_single(),
  );
</script>

{#if !tournament}
  <div class="h-64 animate-pulse rounded-xl bg-surface-container-low"></div>
{:else}
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-on-surface-variant">
        {formatLabel} · BO{tournament.settings.bestOf}{#if tournament.settings.finalBestOf}{' '}· {m.tn_final_bo({ bestOf: tournament.settings.finalBestOf })}{/if}
        · {tournament.settings.teamSize > 1 ? m.tn_teams_of({ size: tournament.settings.teamSize }) : m.tn_solo()}
      </p>
      <div class="flex flex-wrap gap-2">
        {#if tournament.seeded}
          <Button variant="secondary" icon="Image" onclick={exportImage}>{m.tn_export_png()}</Button>
          <Button variant="secondary" icon="Link" onclick={copyLink}>{m.tn_copy_link()}</Button>
          <Button variant="ghost" icon="ExternalLink" href={publicUrl} target="_blank">{m.tn_open_public()}</Button>
          <Menu
            label={m.tn_more_actions()}
            items={[
              { label: m.tn_regenerate_random(), description: m.tn_regenerate_desc(), icon: 'RefreshCw', onselect: () => generate(true) },
              { label: m.tn_reset(), description: m.tn_reset_desc(), icon: 'RotateCcw', onselect: reset },
            ]}
          />
        {:else}
          <Button variant="secondary" icon="RefreshCw" loading={busy} disabled={tournament.registrations < 2} disabledReason={m.tn_need_two()} onclick={() => generate(true)}>{m.tn_generate_random()}</Button>
          <Button variant="primary" icon="GitBranch" loading={busy} disabled={tournament.registrations < 2} disabledReason={m.tn_need_two()} onclick={() => generate(false)}>{m.tn_generate_ordered()}</Button>
        {/if}
      </div>
    </div>

    {#if !tournament.seeded}
      <Callout variant="info" title={m.tn_not_generated_title()}>
        {m.tn_not_generated_desc({ count: tournament.registrations })}
      </Callout>
    {/if}

    <Tabs
      label={m.tn_tabs_label()}
      active={tab}
      onchange={(id) => (tab = id as typeof tab)}
      tabs={[
        { id: 'board', label: m.tn_tab_board(), icon: 'GitBranch', disabled: !tournament.seeded },
        { id: 'standings', label: m.tn_tab_standings(), icon: 'Trophy', disabled: !tournament.seeded },
        { id: 'seeds', label: m.tn_tab_seeds(), icon: 'Hash', disabled: !tournament.seeded },
        { id: 'registrations', label: m.tn_tab_registrations(), icon: 'Users', badge: tournament.registrations },
      ]}
    />

    {#if tab === 'board' && tournament.seeded}
      <p class="text-sm text-on-surface-variant">{m.tn_board_hint()}</p>
      <div class="overflow-x-auto rounded-xl border border-outline-variant">
        <TournamentBoard bind:this={board} {tournament} live={tournament.event.status === 'ONGOING'} onMatchClick={(match) => (editing = match)} />
      </div>
    {:else if tab === 'standings' && tournament.seeded}
      <TournamentStandings {tournament} />
    {:else if tab === 'seeds' && tournament.seeded}
      <SectionCard title={m.tn_tab_seeds()} description={m.tn_seeds_desc()} icon="Hash" flush>
        {#if played}
          <div class="p-4 pb-0"><Callout variant="warning">{m.tn_seeds_played_warning()}</Callout></div>
        {/if}
        <ul class="divide-y divide-outline-variant">
          {#each [...tournament.entrants].sort((a, b) => a.seed - b.seed) as entrant (entrant.id)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-3">
              <span class="w-8 text-center font-semibold text-on-surface">{entrant.seed}</span>
              <span class="min-w-0 flex-1 truncate text-on-surface">{entrant.name}</span>
              <label class="sr-only" for="swap-{entrant.seed}">{m.tn_swap_with({ name: entrant.name })}</label>
              <select
                id="swap-{entrant.seed}"
                class="input w-48"
                disabled={busy}
                value=""
                onchange={(e) => {
                  const target = Number((e.currentTarget as HTMLSelectElement).value);
                  if (target) void run(() => swapTournamentSeeds(eventId, entrant.seed, target), m.tn_seeds_swapped());
                }}
              >
                <option value="">{m.tn_swap_placeholder()}</option>
                {#each tournament.entrants.filter((o) => o.id !== entrant.id).sort((a, b) => a.seed - b.seed) as other (other.id)}
                  <option value={other.seed}>{other.seed}. {other.name}</option>
                {/each}
              </select>
            </li>
          {/each}
        </ul>
      </SectionCard>
    {:else if tab === 'registrations'}
      {@render registrations()}
    {:else}
      <EmptyState icon="GitBranch" title={m.tn_not_generated_title()} reason="instruction" description={m.tn_not_generated_desc({ count: tournament.registrations })} />
    {/if}
  </div>

  {#if editing}
    <TournamentMatchDialog
      match={editing}
      setDetail={tournament.settings.setDetail}
      saving={busy}
      onSave={saveMatch}
      onClear={clearMatch}
      onClose={() => (editing = null)}
    />
  {/if}
{/if}
