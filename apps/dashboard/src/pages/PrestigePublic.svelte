<script lang="ts">
  import PublicShell from '../lib/components/public/PublicShell.svelte';
  /**
   * Classement RP public : la meme page que le classement de niveaux, cote
   * prestige. Aucune authentification, le lien se partage tel quel - c'est ce
   * qui manquait au module, dont le classement ne vivait que dans le dashboard.
   */
  import { onMount } from 'svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { fetchPublicRanked } from '../lib/api';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { DEFAULT_RANKED_LADDER, errorMessage, rankedProgress, type RankedLadder } from '@kotbo/shared';
  import { m, dateLocale } from '../lib/i18n';

  interface Props {
    serverId: string;
  }
  const { serverId }: Props = $props();

  type Entry = {
    rank: number;
    userId: string;
    rp: number;
    streakDays: number;
    flames: number;
    percent: number;
    tier: { key: string; name: string; color: string; minRp: number };
    displayName?: string | null;
    avatarUrl?: string | null;
  };


  let loading = $state(true);
  let errorMsg = $state<string | null>(null);
  let guildName = $state('Kotbo Server');
  let guildIcon = $state<string | null>(null);
  let enabled = $state(false);
  let entries = $state<Entry[]>([]);
  let ladder = $state<RankedLadder>(DEFAULT_RANKED_LADDER);
  let searchQuery = $state('');

  onMount(async () => {
    try {
      const res = await fetchPublicRanked(serverId);
      if (res) {
        enabled = res.enabled ?? false;
        guildName = res.guildName ?? 'Kotbo Server';
        guildIcon = res.guildIcon ?? null;
        entries = res.entries ?? [];
        if (Array.isArray(res.ladder) && res.ladder.length > 0) ladder = res.ladder;
      }
    } catch (err) {
      console.error(err);
      errorMsg = errorMessage(err) || m.prestige_public_error_loading();
    } finally {
      loading = false;
    }
  });

  /** Recherche insensible aux accents, comme celle du classement de niveaux. */
  function normalize(value: string): string {
    return value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  const filtered = $derived(entries.filter((entry) => {
    const query = normalize(searchQuery);
    if (!query) return true;
    return normalize(entry.displayName ?? '').includes(query) || entry.userId.includes(searchQuery);
  }));

  const podium = $derived(searchQuery ? [] : entries.slice(0, 3));

  const totalRp = $derived(entries.reduce((sum, entry) => sum + entry.rp, 0));
  const topTier = $derived(entries[0]?.tier.name ?? '-');
  const bestStreak = $derived(entries.reduce((best, entry) => Math.max(best, entry.streakDays), 0));

  function formatRp(rp: number): string {
    if (rp >= 1_000_000) return `${(rp / 1_000_000).toFixed(1)}M`;
    if (rp >= 1_000) return `${(rp / 1_000).toFixed(1)}k`;
    return rp.toLocaleString(dateLocale());
  }

  /** Progression dans le palier : la barre a la meme regle que la carte de rang. */
  function progressOf(entry: Entry): number {
    return rankedProgress(entry.rp, ladder).percent;
  }

  function medal(index: number): string {
    if (index === 0) return '\u{1F947}';
    if (index === 1) return '\u{1F948}';
    if (index === 2) return '\u{1F949}';
    return '';
  }
</script>

<svelte:head>
  <title>{m.prestige_public_page_title({ guildName })}</title>
  <meta name="description" content={m.prestige_public_meta_desc({ guildName })} />
</svelte:head>

<PublicShell {serverId} subtitle={m.prestige_public_header_subtitle()} icon={'Shield'} {guildName} {guildIcon} width="narrow" live>


    {#if loading}
      <div class="space-y-6">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {#each Array(4) as _}
            <Skeleton height="85px" radius="1rem" />
          {/each}
        </div>
        <Skeleton height="200px" radius="1.25rem" />
        <Skeleton height="450px" radius="1.25rem" />
      </div>

    {:else if errorMsg}
      <div class="bg-surface-container-low border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-on-surface font-semibold text-lg">{m.prestige_public_error_title()}</p>
          <p class="text-on-surface-variant text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>

    {:else if !enabled}
      <div class="bg-surface-container-low border border-outline-variant p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-14 h-14 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant">
          <Papicon icon="Lock" size={24} />
        </div>
        <div class="space-y-1.5 max-w-sm">
          <h2 class="text-xl font-bold text-on-surface">{m.prestige_public_disabled_title()}</h2>
          <p class="text-on-surface-variant text-sm leading-relaxed">{m.prestige_public_disabled_desc()}</p>
        </div>
      </div>

    {:else}
      {#if entries.length > 0}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface">{entries.length}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.prestige_public_stat_members()}</p>
          </div>
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface truncate">{topTier}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.prestige_public_stat_top_tier()}</p>
          </div>
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface">{bestStreak}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.prestige_public_stat_streak()}</p>
          </div>
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface">{formatRp(totalRp)}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.prestige_public_stat_total_rp()}</p>
          </div>
        </div>
      {/if}

      {#if podium.length === 3}
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {#each [podium[1], podium[0], podium[2]] as entry, index (entry.userId)}
            <div class="pub-card rounded-xl p-5 text-center space-y-2 {index === 1 ? 'sm:-translate-y-2' : ''}">
              <span class="text-xl leading-none">{medal(index === 1 ? 0 : index === 0 ? 1 : 2)}</span>
              <img
                src={memberAvatarSrc(entry.avatarUrl, entry.displayName ?? entry.userId, entry.userId)}
                alt={entry.displayName ?? entry.userId}
                class="w-12 h-12 rounded-full mx-auto object-cover border-2"
                style="border-color:{entry.tier.color}"
              />
              <p class="text-sm font-semibold text-on-surface truncate">{entry.displayName ?? entry.userId}</p>
              <p class="text-xs font-semibold" style="color:{entry.tier.color}">{entry.tier.name}</p>
              <p class="text-lg font-bold text-on-surface tabular-nums">{entry.rp.toLocaleString(dateLocale())} <span class="text-2xs font-medium text-on-surface-variant">RP</span></p>
            </div>
          {/each}
        </div>
      {/if}

      <section class="pub-card rounded-xl overflow-hidden">
        <div class="p-4 border-b border-outline-variant">
          <div class="relative">
            <input aria-label={m.prestige_public_search_placeholder()}
              type="search"
              bind:value={searchQuery}
              placeholder={m.prestige_public_search_placeholder()}
              class="w-full bg-surface-container border border-field-border rounded-lg pl-9 pr-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
              <Papicon icon="search" size={14} />
            </span>
          </div>
        </div>

        {#if filtered.length === 0}
          <div class="p-12 text-center space-y-2">
            <p class="text-on-surface font-semibold">{m.prestige_public_no_result()}</p>
            {#if searchQuery}
              <button onclick={() => (searchQuery = '')} class="text-primary text-xs font-bold underline">
                {m.prestige_public_clear_search()}
              </button>
            {/if}
          </div>
        {:else}
          <div class="divide-y divide-outline-variant/50">
            {#each filtered as entry (entry.userId)}
              <div class="flex items-center gap-3 px-4 py-3">
                <span class="w-10 text-right text-sm font-bold text-on-surface-variant tabular-nums">#{entry.rank}</span>
                <img
                  src={memberAvatarSrc(entry.avatarUrl, entry.displayName ?? entry.userId, entry.userId)}
                  alt={entry.displayName ?? entry.userId}
                  class="w-8 h-8 rounded-full object-cover shrink-0"
                />
                <div class="min-w-0 flex-1 space-y-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <p class="text-sm font-medium text-on-surface truncate">{entry.displayName ?? entry.userId}</p>
                    {#if entry.flames > 0}
                      <span class="text-xs" title={m.prestige_public_streak({ days: entry.streakDays })}>{'🔥'.repeat(entry.flames)}</span>
                    {/if}
                  </div>
                  <div class="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                    <div class="h-full rounded-full" style="width:{progressOf(entry)}%; background:{entry.tier.color}"></div>
                  </div>
                </div>
                <span class="px-2 py-0.5 rounded-full text-2xs font-semibold shrink-0" style="background:{entry.tier.color}22;color:{entry.tier.color}">
                  {entry.tier.name}
                </span>
                <span class="text-sm font-mono text-on-surface-variant w-20 text-right tabular-nums">{entry.rp.toLocaleString(dateLocale())}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>

    {/if}
</PublicShell>
