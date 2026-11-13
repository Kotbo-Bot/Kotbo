<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchReputationData } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import { memberCaseModal } from '../lib/stores/memberCaseModal.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import { m, dateLocale } from '../lib/i18n';

  let loading = $state(true);
  let data: any = $state(null);

  /** Clic sur un pseudo : ouvre sa fiche, seulement pour qui a accès à « Membres ». */
  function openMemberOnClick(name: string | null | undefined) {
    return memberCaseModal.canOpen ? (userId: string) => memberCaseModal.show(userId, name || userId) : null;
  }

  /** Pastille du podium : or, argent, bronze ; rien au-delà, le numéro suffit. */
  const PODIUM = ['rep-podium-gold', 'rep-podium-silver', 'rep-podium-bronze'];

  async function load() {
    loading = true;
    try {
      data = await fetchReputationData();
    } catch {
      toast.error(m.rep_load_error());
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<ModulePage
  title={m.rep_page_title()}
  description={m.rep_page_desc()}
  icon="star"
  featureKey="reputation"
>

<!-- Loading -->
{#if loading}
  <LoadingHint context="data" />
{:else if data}
  <!-- Stats Row -->
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
        <Papicon icon="Heart" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.totalVotes}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.rep_total_votes()}</span>
      </div>
    </div>
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-success/10 flex items-center justify-center text-success shrink-0">
        <Papicon icon="Users" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.leaderboard.totalVoters}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.rep_unique_voters()}</span>
      </div>
    </div>
    <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
      <div class="h-9 w-9 rounded-lg bg-warning/10 flex items-center justify-center text-warning shrink-0">
        <Papicon icon="Star" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-xl font-bold text-on-surface">{data.votesLast7Days}</span>
        <span class="text-xs font-medium text-on-surface-variant">{m.rep_votes_last_7_days()}</span>
      </div>
    </div>
  </div>

  <!-- Two-column grid: Leaderboard + Recent Votes -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- Leaderboard -->
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="Crown" size={16} />
        {m.rep_ranking_title()}
      </h3>
      {#if data.leaderboard.entries.length === 0}
        <EmptyState icon="star" title={m.rep_no_votes_title()} description={m.rep_no_votes_desc()} reason="accumulating" />
      {:else}
        <div class="space-y-1">
          {#each data.leaderboard.entries as entry, i}
            <div class="reputation-leaderboard-row grid items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors hover:bg-surface-container-high/20 {i < 3 ? 'bg-surface-container-high/10' : ''}">
              <span class="flex h-6 w-6 items-center justify-center rounded-full {PODIUM[i] ?? ''}" aria-hidden="true">
                {#if i === 0}<Papicon icon="Crown" size={13} />{/if}
              </span>
              <span class="font-semibold text-on-surface-variant text-xs">#{entry.rank}</span>
              <UserDisplay
                userId={entry.userId}
                name={entry.displayName}
                avatarUrl={entry.avatarUrl}
                onClick={openMemberOnClick(entry.displayName)}
                size="xs"
              />
              <div class="h-2 bg-surface-container-high rounded-full overflow-hidden">
                <div
                  class="h-2 rounded-full transition-all duration-500 bg-success"
                  style="width: {Math.min(100, (entry.totalRep / Math.max(data.leaderboard.entries[0]?.totalRep ?? 1, 1)) * 100)}%"
                ></div>
              </div>
              <span class="font-bold text-success text-right text-xs">+{entry.totalRep}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Recent Votes -->
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="Clock" size={16} />
        {m.rep_recent_votes_title()}
      </h3>
      {#if data.recentVotes.length === 0}
        <EmptyState icon="heart" title={m.rep_no_recent_title()} reason="accumulating" />
      {:else}
        <div class="space-y-2">
          {#each data.recentVotes.slice(0, 20) as vote}
            <div class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-3 space-y-2">
              <!-- Vote flow: giver -> receiver -->
              <div class="flex items-center gap-2 flex-wrap">
                <UserDisplay
                  userId={vote.giverId}
                  name={vote.giverName}
                  avatarUrl={vote.giverAvatarUrl}
                  onClick={openMemberOnClick(vote.giverName)}
                  size="xs"
                  class="max-w-40"
                />
                <div class="text-primary flex items-center">
                  <Papicon icon="ArrowRight" size={14} />
                </div>
                <UserDisplay
                  userId={vote.receiverId}
                  name={vote.receiverName}
                  avatarUrl={vote.receiverAvatarUrl}
                  onClick={openMemberOnClick(vote.receiverName)}
                  size="xs"
                  class="max-w-40"
                />
              </div>
              {#if vote.reason}
                <p class="text-xs text-on-surface-variant italic">{vote.reason}</p>
              {/if}
              <span class="text-2xs text-on-surface-variant/30 block">{new Date(vote.createdAt).toLocaleDateString(dateLocale())}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
</ModulePage>

<style>
  .rep-podium-gold {
    background: color-mix(in srgb, var(--color-warning) 22%, transparent);
    color: var(--color-warning);
  }

  .rep-podium-silver {
    background: color-mix(in srgb, var(--color-on-surface-variant) 18%, transparent);
  }

  .rep-podium-bronze {
    background: color-mix(in srgb, var(--color-tertiary) 20%, transparent);
  }

  .reputation-leaderboard-row {
    grid-template-columns: 28px 36px 1fr 80px 60px;
  }

  /* The progress bar is the first thing to go: the number next to it already
     carries the value. */
  @media (max-width: 767px) {
    .reputation-leaderboard-row {
      gap: 0.375rem;
      grid-template-columns: 1.5rem 2rem minmax(0, 1fr) auto;
    }

    .reputation-leaderboard-row > :nth-child(3) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .reputation-leaderboard-row > :nth-child(4) {
      display: none;
    }
  }
</style>
