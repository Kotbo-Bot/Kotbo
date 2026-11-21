<script lang="ts">
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
  import { m, dateLocale, getLocale, locales, type Locale } from '../lib/i18n';
  import { themeStore } from '../lib/stores/theme.svelte';
  import { userPrefs } from '../lib/stores/userPreferences.svelte';

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

  const currentLocale = getLocale();
  function switchLocale(loc: Locale) {
    if (loc === currentLocale) return;
    userPrefs.set('language', loc);
  }

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

<div class="min-h-screen whiteboard-container relative overflow-x-hidden py-12 px-4 sm:px-6 z-10">
  <div class="relative z-10 w-full max-w-4xl mx-auto space-y-10 animate-in fade-in duration-300">

    <header class="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-5 rounded-lg shadow-sm overflow-hidden">
      <div class="tape-accent"></div>

      <div class="flex items-center gap-4">
        {#if guildIcon}
          <img src={guildIcon} alt={guildName} class="w-11 h-11 rounded-lg object-cover border border-slate-200 dark:border-slate-800 shrink-0" />
        {:else}
          <div class="w-11 h-11 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-center font-bold text-sm text-slate-800 dark:text-slate-100 shrink-0">
            <span>{guildName.slice(0, 2).toUpperCase()}</span>
          </div>
        {/if}

        <div>
          <h1 class="text-lg font-semibold tracking-tight text-slate-800 dark:text-slate-100">{guildName}</h1>
          <div class="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-semibold text-xs">
            <span class="text-indigo-500"><Papicon icon="shield" size={14} /></span>
            <span>{m.prestige_public_header_subtitle()}</span>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-3 self-start sm:self-auto">
        <div class="flex items-center rounded-full border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0c1322] p-0.5 text-xs font-semibold">
          {#each locales as loc}
            <button
              type="button"
              onclick={() => switchLocale(loc)}
              class="px-2.5 py-1 rounded-full transition-colors {currentLocale === loc ? 'bg-white dark:bg-[#111a2e] text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}"
            >{loc}</button>
          {/each}
        </div>

        <button
          type="button"
          onclick={themeStore.toggle}
          aria-label={m.navbar_change_theme()}
          class="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
        >
          {#if themeStore.dark}
            <Papicon icon="sun" size={15} class="text-amber-500" />
          {:else}
            <Papicon icon="moon" size={15} />
          {/if}
        </button>
      </div>
    </header>

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
      <div class="bg-white dark:bg-[#111a2e] border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-semibold text-lg">{m.prestige_public_error_title()}</p>
          <p class="text-slate-500 dark:text-slate-400 text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>

    {:else if !enabled}
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-14 h-14 rounded-full bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-400">
          <Papicon icon="Lock" size={24} />
        </div>
        <div class="space-y-1.5 max-w-sm">
          <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100">{m.prestige_public_disabled_title()}</h2>
          <p class="text-slate-500 dark:text-slate-400 text-sm leading-relaxed">{m.prestige_public_disabled_desc()}</p>
        </div>
      </div>

    {:else}
      {#if entries.length > 0}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100">{entries.length}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.prestige_public_stat_members()}</p>
          </div>
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100 truncate">{topTier}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.prestige_public_stat_top_tier()}</p>
          </div>
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100">{bestStreak}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.prestige_public_stat_streak()}</p>
          </div>
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100">{formatRp(totalRp)}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.prestige_public_stat_total_rp()}</p>
          </div>
        </div>
      {/if}

      {#if podium.length === 3}
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {#each [podium[1], podium[0], podium[2]] as entry, index (entry.userId)}
            <div class="clean-card rounded-xl p-5 text-center space-y-2 {index === 1 ? 'sm:-translate-y-2' : ''}">
              <span class="text-xl leading-none">{medal(index === 1 ? 0 : index === 0 ? 1 : 2)}</span>
              <img
                src={memberAvatarSrc(entry.avatarUrl, entry.displayName ?? entry.userId, entry.userId)}
                alt={entry.displayName ?? entry.userId}
                class="w-12 h-12 rounded-full mx-auto object-cover border-2"
                style="border-color:{entry.tier.color}"
              />
              <p class="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{entry.displayName ?? entry.userId}</p>
              <p class="text-xs font-semibold" style="color:{entry.tier.color}">{entry.tier.name}</p>
              <p class="text-lg font-bold text-slate-800 dark:text-slate-100 tabular-nums">{entry.rp.toLocaleString(dateLocale())} <span class="text-2xs font-medium text-slate-400">RP</span></p>
            </div>
          {/each}
        </div>
      {/if}

      <section class="clean-card rounded-xl overflow-hidden">
        <div class="p-4 border-b border-slate-200 dark:border-slate-800">
          <div class="relative">
            <input aria-label={m.prestige_public_search_placeholder()}
              type="search"
              bind:value={searchQuery}
              placeholder={m.prestige_public_search_placeholder()}
              class="w-full bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <Papicon icon="search" size={14} />
            </span>
          </div>
        </div>

        {#if filtered.length === 0}
          <div class="p-12 text-center space-y-2">
            <p class="text-slate-800 dark:text-slate-100 font-semibold">{m.prestige_public_no_result()}</p>
            {#if searchQuery}
              <button onclick={() => (searchQuery = '')} class="text-indigo-500 dark:text-indigo-400 text-xs font-bold underline">
                {m.prestige_public_clear_search()}
              </button>
            {/if}
          </div>
        {:else}
          <div class="divide-y divide-slate-100 dark:divide-slate-800/60">
            {#each filtered as entry (entry.userId)}
              <div class="flex items-center gap-3 px-4 py-3">
                <span class="w-10 text-right text-sm font-bold text-slate-400 dark:text-slate-500 tabular-nums">#{entry.rank}</span>
                <img
                  src={memberAvatarSrc(entry.avatarUrl, entry.displayName ?? entry.userId, entry.userId)}
                  alt={entry.displayName ?? entry.userId}
                  class="w-8 h-8 rounded-full object-cover shrink-0"
                />
                <div class="min-w-0 flex-1 space-y-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <p class="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{entry.displayName ?? entry.userId}</p>
                    {#if entry.flames > 0}
                      <span class="text-xs" title={m.prestige_public_streak({ days: entry.streakDays })}>{'🔥'.repeat(entry.flames)}</span>
                    {/if}
                  </div>
                  <div class="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div class="h-full rounded-full" style="width:{progressOf(entry)}%; background:{entry.tier.color}"></div>
                  </div>
                </div>
                <span class="px-2 py-0.5 rounded-full text-2xs font-semibold shrink-0" style="background:{entry.tier.color}22;color:{entry.tier.color}">
                  {entry.tier.name}
                </span>
                <span class="text-sm font-mono text-slate-500 dark:text-slate-400 w-20 text-right tabular-nums">{entry.rp.toLocaleString(dateLocale())}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <footer class="flex flex-col sm:flex-row items-center justify-between gap-4 py-6 border-t border-slate-200 dark:border-slate-800 text-center relative z-10 text-xs text-slate-400 dark:text-slate-500">
        <p>
          {m.leveling_public_footer_powered_by()} <span class="text-slate-700 dark:text-slate-400 font-semibold">Kotbo</span> · {m.leveling_public_footer_synced()}
        </p>
        <a
          href="/"
          class="font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-500 dark:hover:text-slate-400 transition-colors flex items-center gap-1"
        >
          <span>{m.leveling_public_footer_dashboard()}</span>
          <span>→</span>
        </a>
      </footer>
    {/if}
  </div>
</div>

<style>
  /* Meme feuille que le classement de niveaux : les deux pages publiques se
     ressemblent, elles sortent du meme bot. */
  .whiteboard-container {
    background-color: #faf9f6;
    background-image: radial-gradient(#cbd5e1 1.2px, transparent 1.2px);
    background-size: 24px 24px;
    color: #0f172a;
    font-family: 'Outfit', sans-serif;
    transition: background-color 0.3s ease, color 0.3s ease;
  }
  :global(.dark) .whiteboard-container {
    background-color: #090d16 !important;
    background-image: radial-gradient(#1e293b 1.2px, transparent 1.2px) !important;
    color: #f8fafc !important;
  }

  .clean-card {
    background-color: #ffffff;
    border: 1px solid #e2e8f0;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -2px rgba(0, 0, 0, 0.02);
    transition: all 0.2s ease;
  }
  :global(.dark) .clean-card {
    background-color: #111a2e !important;
    border-color: #1e293b !important;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.15), 0 2px 4px -2px rgba(0, 0, 0, 0.15) !important;
  }

  .tape-accent {
    position: absolute;
    top: -8px;
    right: 24px;
    width: 80px;
    height: 20px;
    background-color: rgba(129, 140, 248, 0.22);
    border-left: 1px dashed rgba(0, 0, 0, 0.1);
    border-right: 1px dashed rgba(0, 0, 0, 0.1);
    transform: rotate(3deg);
    z-index: 10;
  }
  :global(.dark) .tape-accent {
    background-color: rgba(129, 140, 248, 0.12) !important;
    border-left: 1px dashed rgba(255, 255, 255, 0.08) !important;
    border-right: 1px dashed rgba(255, 255, 255, 0.08) !important;
  }
</style>
