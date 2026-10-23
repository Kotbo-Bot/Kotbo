<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSeasonsData, createSeason, startSeason, endSeason } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import { m } from '../lib/i18n';

  let loading = $state(true);
  let data: any = $state(null);
  let showCreate = $state(false);
  let newSeason = $state({ name: '', startDate: '', endDate: '' });

  async function load() {
    loading = true;
    try {
      data = await fetchSeasonsData();
    } catch {
      toast.error(m.sea_load_error());
    } finally {
      loading = false;
    }
  }

  async function handleCreate() {
    if (!newSeason.name || !newSeason.startDate || !newSeason.endDate) {
      toast.error(m.sea_required_fields_toast());
      return;
    }
    try {
      await createSeason(newSeason);
      showCreate = false;
      newSeason = { name: '', startDate: '', endDate: '' };
      await load();
    } catch {
      toast.error(m.sea_create_error_toast());
    }
  }

  async function handleStart(seasonId: string) {
    try {
      await startSeason(seasonId);
      await load();
    } catch {
      toast.error(m.sea_start_error_toast());
    }
  }

  async function handleEnd(seasonId: string) {
    try {
      await endSeason(seasonId);
      await load();
    } catch {
      toast.error(m.sea_end_error_toast());
    }
  }

  function getStatusBadge(status: string) {
    const map: Record<string, { label: string; cls: string }> = {
      UPCOMING: { label: m.sea_status_upcoming(), cls: 'bg-primary/10 text-primary' },
      ACTIVE: { label: m.sea_status_active(), cls: 'bg-success/10 text-success' },
      ENDED: { label: m.sea_status_ended(), cls: 'bg-warning/10 text-warning' },
      ARCHIVED: { label: m.sea_status_archived(), cls: 'bg-surface-container-high/40 text-on-surface-variant' },
    };
    return map[status] ?? { label: status, cls: 'bg-surface-container-high/40 text-on-surface-variant' };
  }

  function getDotColor(status: string): string {
    if (status === 'ACTIVE') return 'bg-emerald-500';
    if (status === 'UPCOMING') return 'bg-primary';
    if (status === 'ENDED') return 'bg-amber-500';
    return 'bg-on-surface-variant/40';
  }

  function getMedal(index: number): string {
    if (index === 0) return '\u{1F947}';
    if (index === 1) return '\u{1F948}';
    if (index === 2) return '\u{1F949}';
    return '';
  }

  onMount(load);
</script>

<ModulePage
  title={m.sea_page_title()}
  description={m.sea_page_desc()}
  icon="flag"
  featureKey="seasons"
>
  {#snippet actions()}
    <button
      class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
      onclick={() => showCreate = !showCreate}
    >
      <Papicon icon="plus" size={16} />
      {m.sea_btn_new_season()}
    </button>
  {/snippet}

<!-- ======================== CREATE FORM ======================== -->
{#if showCreate}
  <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4 mb-6">
    <h3 class="text-base font-semibold flex items-center gap-2.5">{m.sea_create_title()}</h3>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="space-y-1">
        <label for="season-name" class="field-label">{m.sea_field_name()}</label>
        <input
          id="season-name"
          type="text"
          bind:value={newSeason.name}
          placeholder={m.sea_name_ph()}
          class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm"
        />
      </div>
      <div class="space-y-1">
        <label for="season-start-date" class="field-label">{m.sea_field_start_date()}</label>
        <input
          id="season-start-date"
          type="date"
          bind:value={newSeason.startDate}
          class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm"
        />
      </div>
      <div class="space-y-1">
        <label for="season-end-date" class="field-label">{m.sea_field_end_date()}</label>
        <input
          id="season-end-date"
          type="date"
          bind:value={newSeason.endDate}
          class="w-full px-3 py-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg text-on-surface text-sm"
        />
      </div>
    </div>
    <div class="flex justify-end gap-2 pt-2">
      <button
        class="px-4 py-2 bg-surface-container-high/40 text-on-surface-variant rounded-xl text-xs font-bold hover:bg-surface-container-high/60 transition-all"
        onclick={() => showCreate = false}
      >{m.sea_btn_cancel()}</button>
      <button
        class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
        onclick={handleCreate}
      >{m.sea_btn_create()}</button>
    </div>
  </div>
{/if}

<!-- ======================== CONTENT ======================== -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-4">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    <p class="text-sm">{m.sea_loading()}</p>
  </div>
{:else if data}

  <!-- ==================== HERO: ACTIVE SEASON ==================== -->
  {#if data.activeSeason}
    <div class="rounded-xl p-[2px] mb-6" style="background: linear-gradient(135deg, var(--primary-color), #10b981, var(--primary-color))">
      <div class="bg-surface-container-low rounded-xl p-6 space-y-4">
        <!-- Top: name + badge + dates -->
        <div>
          <div class="flex items-center gap-3 mb-1">
            <h2 class="text-xl font-bold text-on-surface">{data.activeSeason.name}</h2>
            <span class="px-2.5 py-0.5 bg-success/10 text-success text-xs font-medium rounded-full">{m.sea_status_active()}</span>
          </div>
          <p class="flex items-center gap-1.5 text-xs text-on-surface-variant">
            <Papicon icon="calendar" size={14} />
            {new Date(data.activeSeason.startDate).toLocaleDateString('fr-FR')}
            &mdash;
            {new Date(data.activeSeason.endDate).toLocaleDateString('fr-FR')}
          </p>
        </div>

        <!-- Leaderboard : XP et RP cote a cote. Une saison porte les deux
             compteurs, et la page n'en montrait qu'un. -->
        {#if data.activeLeaderboard.length > 0 || (data.activeRankedLeaderboard?.length ?? 0) > 0}
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {#if data.activeLeaderboard.length > 0}
              <div class="space-y-3">
                <h4 class="text-sm font-semibold flex items-center gap-2 text-on-surface-variant">
                  <Papicon icon="crown" size={16} />
                  {m.sea_current_ranking()}
                </h4>
                <div class="space-y-0.5">
                  {#each data.activeLeaderboard as entry, i}
                    <div class="season-leaderboard-row grid items-center py-2 px-3 rounded-lg text-sm transition-colors hover:bg-surface-container-high/10 {i < 3 ? 'bg-surface-container-high/5' : ''}">
                      <span class="text-base leading-none">{getMedal(i)}</span>
                      <span class="font-semibold text-on-surface-variant">#{entry.rank}</span>
                      <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="xs" class="min-w-0" />
                      <span class="text-primary font-medium text-xs">Niv. {entry.level}</span>
                      <span class="text-right text-xs text-on-surface-variant">{entry.xp.toLocaleString()} XP</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            {#if (data.activeRankedLeaderboard?.length ?? 0) > 0}
              <div class="space-y-3">
                <h4 class="text-sm font-semibold flex items-center gap-2 text-on-surface-variant">
                  <Papicon icon="shield" size={16} />
                  {m.sea_current_ranking_rp()}
                </h4>
                <div class="space-y-0.5">
                  {#each data.activeRankedLeaderboard as entry, i}
                    <div class="season-leaderboard-row grid items-center py-2 px-3 rounded-lg text-sm transition-colors hover:bg-surface-container-high/10 {i < 3 ? 'bg-surface-container-high/5' : ''}">
                      <span class="text-base leading-none">{getMedal(i)}</span>
                      <span class="font-semibold text-on-surface-variant">#{entry.rank}</span>
                      <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="xs" class="min-w-0" />
                      <span class="font-medium text-xs truncate" style="color:{entry.tier.color}">{entry.tier.name}</span>
                      <span class="text-right text-xs text-on-surface-variant">{entry.rp.toLocaleString()} RP</span>
                    </div>
                  {/each}
                </div>
                <p class="text-2xs text-on-surface-variant">{m.sea_ranking_rp_hint()}</p>
              </div>
            {/if}
          </div>
        {/if}

        <!-- End season button -->
        <div class="pt-2">
          <button
            class="px-4 py-2 bg-error/10 text-error rounded-xl text-xs font-bold hover:bg-error/20 transition-all flex items-center gap-2"
            onclick={() => handleEnd(data.activeSeason.id)}
          >
            <Papicon icon="x" size={14} />
            {m.sea_btn_end_season()}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ==================== ALL SEASONS TIMELINE ==================== -->
  {#if data.seasons.length > 0}
    <h3 class="text-base font-semibold flex items-center gap-2.5 mb-4">{m.sea_all_seasons()}</h3>

    <div class="relative pl-6">
      <!-- Vertical line -->
      <div class="absolute left-1.75 top-0 bottom-0 w-0.5 bg-outline-variant/30"></div>

      {#each data.seasons as season}
        {@const badge = getStatusBadge(season.status)}
        <div class="relative mb-3">
          <!-- Dot -->
          <div class="absolute -left-6 top-4.5 w-3 h-3 rounded-full border-2 border-surface z-10 {getDotColor(season.status)}"></div>

          <!-- Card -->
          <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 hover:border-primary/30 transition-colors">
            <div class="flex items-center gap-3 mb-2">
              <h4 class="text-sm font-semibold text-on-surface">#{season.number} &mdash; {season.name}</h4>
              <span class="px-2.5 py-0.5 text-xs font-medium rounded-full {badge.cls}">{badge.label}</span>
            </div>
            <div class="flex flex-wrap gap-4 text-xs text-on-surface-variant">
              <span class="flex items-center gap-1">
                <Papicon icon="calendar" size={13} />
                {new Date(season.startDate).toLocaleDateString('fr-FR')} &mdash; {new Date(season.endDate).toLocaleDateString('fr-FR')}
              </span>
              <span class="flex items-center gap-1">
                <Papicon icon="users" size={13} />
                {m.sea_participants_count({ count: season._count?.snapshots ?? 0 })}
              </span>
            </div>
            {#if season.status === 'UPCOMING'}
              <div class="mt-3">
                <button
                  class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-1.5"
                  onclick={() => handleStart(season.id)}
                >
                  <Papicon icon="zap" size={13} />
                  {m.sea_btn_start()}
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <!-- Empty state -->
    <EmptyState icon="flag" title={m.sea_empty_title()} description={m.sea_empty_desc()} actionLabel={m.sea_empty_cta()} onAction={() => (showCreate = true)} />
  {/if}
{/if}
</ModulePage>

<style>
  .season-leaderboard-row {
    grid-template-columns: 28px 40px 1fr 80px 100px;
  }

  /* Level and user id compete for the same space on a phone: keep the rank,
     the name and the score, and let the level go. */
  @media (max-width: 767px) {
    .season-leaderboard-row {
      gap: 0.375rem;
      grid-template-columns: 1.5rem 2rem minmax(0, 1fr) auto;
    }

    .season-leaderboard-row > :nth-child(3) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .season-leaderboard-row > :nth-child(4) {
      display: none;
    }

    .season-leaderboard-row > :last-child {
      white-space: nowrap;
    }
  }
</style>
