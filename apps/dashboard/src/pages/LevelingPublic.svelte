<script lang="ts">
  import { onMount } from 'svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { fetchPublicLeveling } from '../lib/api';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { DEFAULT_LEVEL_CURVE, errorMessage, levelFromXp, normalizeLevelCurve, type LevelCurve, xpForLevel } from '@kotbo/shared';
  import { m, dateLocale, getLocale, locales, type Locale } from '../lib/i18n';
  import { themeStore } from '../lib/stores/theme.svelte';
  import { userPrefs } from '../lib/stores/userPreferences.svelte';

  interface Props {
    serverId: string;
    initialUserId?: string;
  }
  const { serverId, initialUserId }: Props = $props();

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
  let levels = $state<Array<{ userId: string; xp: number; level: number; username?: string; displayName?: string; avatarUrl?: string }>>([]);
  let searchQuery = $state('');
  let highlightedUserId = $state<string | null>(null);
  let shareCopied = $state(false);
  let curve = $state<LevelCurve>(DEFAULT_LEVEL_CURVE);

  onMount(async () => {
    const queryUser =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('user') ??
          new URLSearchParams(window.location.search).get('userId')
        : null;
    const focusUserId = initialUserId || queryUser;
    if (focusUserId) highlightedUserId = focusUserId;

    try {
      const res = await fetchPublicLeveling(serverId);
      if (res) {
        enabled = res.enabled ?? false;
        guildName = res.guildName ?? 'Kotbo Server';
        guildIcon = res.guildIcon ?? null;
        levels = res.levels || [];
        curve = normalizeLevelCurve(res.curve);
      }
    } catch (err) {
      console.error(err);
      errorMsg = errorMessage(err) || m.leveling_public_error_loading();
    } finally {
      loading = false;
      if (focusUserId && typeof document !== 'undefined') {
        requestAnimationFrame(() => {
          document.getElementById(`member-row-${focusUserId}`)?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      }
    }
  });

  // Même calcul que le bot, courbe de la guilde comprise : les deux importent
  // la logique de `@kotbo/shared`.
  const getXpForLevel = (level: number) => xpForLevel(level, curve);
  const getLevelFromXp = (xp: number) => levelFromXp(xp, curve);

  const filteredLevels = $derived(
    levels.filter(u => {
      const q = searchQuery.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      const name = u.displayName?.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '') || '';
      const username = u.username?.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '') || '';
      return name.includes(q) || username.includes(q) || u.userId.includes(searchQuery);
    })
  );

  // Stats globales
  const totalXp = $derived(levels.reduce((sum, u) => sum + u.xp, 0));
  const avgLevel = $derived(levels.length > 0 ? Math.round(levels.reduce((sum, u) => sum + getLevelFromXp(u.xp), 0) / levels.length) : 0);
  const maxLevel = $derived(levels.length > 0 ? getLevelFromXp(levels[0]?.xp ?? 0) : 0);

  const highlightedIndex = $derived(
    highlightedUserId ? levels.findIndex((u) => u.userId === highlightedUserId) : -1
  );
  const highlightedMember = $derived(highlightedIndex >= 0 ? levels[highlightedIndex] : null);
  const memberAhead = $derived(highlightedIndex > 0 ? levels[highlightedIndex - 1] : null);

  function selectMember(userId: string) {
    const next = highlightedUserId === userId ? null : userId;
    highlightedUserId = next;
    if (typeof window !== 'undefined') {
      const nextPath = next
        ? `/${serverId}/leveling/classement/${next}`
        : `/${serverId}/leveling/classement`;
      window.history.replaceState(null, '', nextPath);
    }
  }

  async function copyMemberShareUrl(userId: string) {
    if (typeof window === 'undefined') return;
    const shareUrl = `${window.location.origin}/${serverId}/leveling/classement/${userId}`;
    await navigator.clipboard.writeText(shareUrl).catch(() => null);
    shareCopied = true;
    setTimeout(() => {
      shareCopied = false;
    }, 2000);
  }

  function formatXp(xp: number): string {
    if (xp >= 1_000_000) return `${(xp / 1_000_000).toFixed(1)}M`;
    if (xp >= 1_000) return `${(xp / 1_000).toFixed(1)}k`;
    return xp.toLocaleString(dateLocale());
  }

  function getRankColor(index: number) {
    if (index === 0) return 'amber';
    if (index === 1) return 'silver';
    if (index === 2) return 'bronze';
    return 'default';
  }
</script>

<svelte:head>
  <title>{m.leveling_public_page_title({ guildName })}</title>
  <meta name="description" content={m.leveling_public_meta_desc({ guildName })} />
</svelte:head>

<div class="min-h-screen whiteboard-container relative overflow-x-hidden py-12 px-4 sm:px-6 z-10">
  
  <div class="relative z-10 w-full max-w-4xl mx-auto space-y-10 animate-in fade-in duration-300">

    <!-- ─── En-tête style Feuille Index épuré ─── -->
    <header class="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-5 rounded-lg shadow-sm overflow-hidden group">
      <div class="tape-accent"></div>

      <div class="flex items-center gap-4">
        {#if guildIcon}
          <div class="relative shrink-0">
            <img src={guildIcon} alt="{guildName} Logo" class="w-11 h-11 rounded-lg object-cover border border-slate-200 dark:border-slate-800" />
          </div>
        {:else}
          <div class="relative w-11 h-11 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-center font-bold text-sm text-slate-800 dark:text-slate-100 shrink-0">
            <span>{guildName.slice(0, 2).toUpperCase()}</span>
          </div>
        {/if}

        <div class="relative">
          <h1 class="text-lg font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            {guildName}
          </h1>
          <div class="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-semibold text-xs">
            <span class="text-amber-500"><Papicon icon="Trophy" size={14} /></span>
            <span>{m.leveling_public_header_subtitle()}</span>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-3 self-start sm:self-auto">
        <!-- Sélecteur de langue -->
        <div class="flex items-center rounded-full border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0c1322] p-0.5 text-xs font-semibold">
          {#each locales as loc}
            <button
              type="button"
              onclick={() => switchLocale(loc)}
              class="px-2.5 py-1 rounded-full transition-colors {currentLocale === loc ? 'bg-white dark:bg-[#111a2e] text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}"
            >{loc}</button>
          {/each}
        </div>

        <!-- Bascule thème clair/sombre -->
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

        <!-- Badge "Live" -->
        <div class="relative flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 dark:border-emerald-500/10 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 absolute"></span>
          <span class="ml-2.5 text-xs">{m.leveling_public_live_badge()}</span>
        </div>
      </div>
    </header>

    {#if loading}
      <!-- Loading Skeleton épuré -->
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
      <!-- Erreur épurée -->
      <div class="bg-white dark:bg-[#111a2e] border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-semibold text-lg">{m.leveling_public_error_title()}</p>
          <p class="text-slate-500 dark:text-slate-400 text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>

    {:else if !enabled}
      <!-- Module désactivé -->
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-14 h-14 rounded-full bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-400">
          <Papicon icon="Lock" size={24} />
        </div>
        <div class="space-y-1.5 max-w-sm">
          <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100">{m.leveling_public_disabled_title()}</h2>
          <p class="text-slate-505 dark:text-slate-400 text-sm leading-relaxed">
            {m.leveling_public_disabled_desc()}
          </p>
        </div>
      </div>

    {:else}

      {#if highlightedMember}
        {@const hRank = highlightedIndex + 1}
        {@const hLvl = getLevelFromXp(highlightedMember.xp)}
        {@const gapAhead = memberAhead ? Math.max(1, memberAhead.xp - highlightedMember.xp) : 0}
        <div class="clean-card rounded-xl p-5 sm:p-6 border-l-4 border-l-indigo-500 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="flex items-center gap-4 min-w-0">
            <img
              src={memberAvatarSrc(highlightedMember.avatarUrl, highlightedMember.displayName || highlightedMember.username, highlightedMember.userId)}
              alt=""
              class="w-12 h-12 rounded-full object-cover border border-slate-200 dark:border-slate-800 shrink-0"
            />
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-mono font-bold text-xs">
                  #{hRank} / {levels.length}
                </span>
                <p class="font-bold text-slate-800 dark:text-slate-100 truncate text-base">
                  {highlightedMember.displayName || highlightedMember.username || m.leveling_public_unknown_member()}
                </p>
                <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  · {m.leveling_public_level_n({ n: hLvl })} ({formatXp(highlightedMember.xp)} XP)
                </span>
              </div>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {#if memberAhead}
                  {currentLocale === 'fr'
                    ? `À ${formatXp(gapAhead)} XP de #${hRank - 1} (${memberAhead.displayName || memberAhead.username})`
                    : `${formatXp(gapAhead)} XP behind #${hRank - 1} (${memberAhead.displayName || memberAhead.username})`}
                {:else}
                  {currentLocale === 'fr' ? 'En tête du classement du serveur' : 'Leading the server leaderboard'}
                {/if}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onclick={() => copyMemberShareUrl(highlightedMember.userId)}
              class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 transition-colors flex items-center gap-1.5"
            >
              <Papicon icon={shareCopied ? 'Check' : 'Share'} size={13} />
              <span>{shareCopied ? (currentLocale === 'fr' ? 'Lien copié' : 'Link copied') : (currentLocale === 'fr' ? 'Partager ce rang' : 'Share standing')}</span>
            </button>
          </div>
        </div>
      {/if}

      <!-- ─── Cartes de statistiques globales épurées ─── -->
      {#if levels.length > 0}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100">{levels.length}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.leveling_public_stat_members()}</p>
          </div>
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100">{maxLevel}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.leveling_public_stat_max_level()}</p>
          </div>
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100">{avgLevel}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.leveling_public_stat_avg_level()}</p>
          </div>
          <div class="clean-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-slate-800 dark:text-slate-100">{formatXp(totalXp)}</p>
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.leveling_public_stat_total_xp()}</p>
          </div>
        </div>
      {/if}

      <!-- ─── Section Top 3 Épuré ─── -->
      {#if !searchQuery && levels.length > 0}
        <div class="space-y-4">
          <h3 class="text-body-sm font-medium text-slate-400 dark:text-slate-500 flex items-center gap-2 ml-1">
            <span class="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block"></span>
            <span>{m.leveling_public_top_trio()}</span>
          </h3>
          
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 relative z-10">
            
            <!-- Rank 2 Card (Silver Border Accent) -->
            {#if levels[1]}
              <div class="relative clean-card border-t-2 border-slate-300 dark:border-slate-600 rounded-xl p-6 flex flex-col justify-between order-2 sm:order-1">
                <div class="flex items-start justify-between">
                  <div class="space-y-3 w-full">
                    <span class="text-xl font-semibold text-slate-400/80">{m.leveling_public_rank_2()}</span>
                    <div class="flex items-center gap-3">
                      <img
                        src={memberAvatarSrc(levels[1].avatarUrl, levels[1].displayName || levels[1].username, levels[1].userId)}
                        alt=""
                        class="w-12 h-12 rounded-full object-cover border border-slate-200 dark:border-slate-800"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="font-bold text-slate-800 dark:text-slate-100 truncate text-sm" title={levels[1].displayName}>
                          {levels[1].displayName || levels[1].username || m.leveling_public_unknown_member()}
                        </p>
                        <p class="text-xs text-slate-400 dark:text-slate-500">{m.leveling_public_level_n({ n: getLevelFromXp(levels[1].xp) })}</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mt-4 text-xs font-mono text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800/80 pt-3 flex justify-between">
                  <span>{m.leveling_public_total_xp_label()}</span>
                  <span class="font-bold text-slate-700 dark:text-slate-300">{formatXp(levels[1].xp)}</span>
                </div>
              </div>
            {/if}

            <!-- Rank 1 Card (Gold Border Accent) -->
            {#if levels[0]}
              <div class="relative clean-card border-t-2 border-amber-400 dark:border-amber-500 rounded-xl p-6 flex flex-col justify-between order-1 sm:order-2">
                <div class="flex items-start justify-between">
                  <div class="space-y-3 w-full">
                    <span class="text-2xl font-semibold text-amber-500 flex items-center gap-1.5">
                      <span>{m.leveling_public_rank_1()}</span>
                      <span class="text-amber-500"><Papicon icon="Crown" size={18} /></span>
                    </span>
                    <div class="flex items-center gap-3.5">
                      <img
                        src={memberAvatarSrc(levels[0].avatarUrl, levels[0].displayName || levels[0].username, levels[0].userId)}
                        alt=""
                        class="w-14 h-14 rounded-full object-cover border border-slate-200 dark:border-slate-800"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="font-semibold text-slate-800 dark:text-slate-100 truncate text-base" title={levels[0].displayName}>
                          {levels[0].displayName || levels[0].username || m.leveling_public_unknown_member()}
                        </p>
                        <p class="text-xs text-amber-500 dark:text-amber-400 font-bold">{m.leveling_public_level_n({ n: getLevelFromXp(levels[0].xp) })}</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mt-4 text-xs font-mono text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800/80 pt-3 flex justify-between">
                  <span>{m.leveling_public_total_xp_label()}</span>
                  <span class="font-bold text-amber-500 dark:text-amber-400">{formatXp(levels[0].xp)}</span>
                </div>
              </div>
            {/if}

            <!-- Rank 3 Card (Bronze/Copper Border Accent) -->
            {#if levels[2]}
              <div class="relative clean-card border-t-2 border-amber-600 dark:border-amber-700/80 rounded-xl p-6 flex flex-col justify-between order-3">
                <div class="flex items-start justify-between">
                  <div class="space-y-3 w-full">
                    <span class="text-xl font-semibold text-amber-700/80 dark:text-amber-600">{m.leveling_public_rank_3()}</span>
                    <div class="flex items-center gap-3">
                      <img
                        src={memberAvatarSrc(levels[2].avatarUrl, levels[2].displayName || levels[2].username, levels[2].userId)}
                        alt=""
                        class="w-12 h-12 rounded-full object-cover border border-slate-200 dark:border-slate-800"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="font-bold text-slate-800 dark:text-slate-100 truncate text-sm" title={levels[2].displayName}>
                          {levels[2].displayName || levels[2].username || m.leveling_public_unknown_member()}
                        </p>
                        <p class="text-xs text-slate-400 dark:text-slate-500">{m.leveling_public_level_n({ n: getLevelFromXp(levels[2].xp) })}</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mt-4 text-xs font-mono text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800/80 pt-3 flex justify-between">
                  <span>{m.leveling_public_total_xp_label()}</span>
                  <span class="font-bold text-slate-700 dark:text-slate-300">{formatXp(levels[2].xp)}</span>
                </div>
              </div>
            {/if}

          </div>
        </div>
      {/if}

      <!-- ─── Liste Principale Tableau Épuré ─── -->
      <section class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-lg p-6 sm:p-8 space-y-6 shadow-sm">
        
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">
            {m.leveling_public_members_title()}
          </h3>

          <!-- Barre de recherche -->
          <div class="relative w-full sm:w-80">
            <input
              type="text"
              id="leaderboard-search"
              placeholder={m.leveling_public_search_placeholder()}
              bind:value={searchQuery}
              class="w-full bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 pl-10 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:bg-white dark:focus:bg-[#111a2e] focus:border-slate-300 dark:focus:border-slate-700 transition-all font-semibold"
            />
            <div class="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 flex items-center">
              <Papicon icon="Search" size={14} />
            </div>
            {#if searchQuery}
              <button
                onclick={() => searchQuery = ''}
                aria-label={m.leveling_public_clear_search()}
                class="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 hover:bg-red-100 dark:hover:bg-red-950/45 hover:text-red-700 dark:hover:text-red-300 text-slate-500 dark:text-slate-400 flex items-center justify-center transition-all"
              ><Papicon icon="x" size={10} /></button>
            {/if}
          </div>
        </div>

        <!-- Tableau des joueurs -->
        <div class="border border-slate-200 dark:border-slate-800/80 rounded-xl overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-50 dark:bg-[#0c1322] border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-400 dark:text-slate-500">
                <th class="px-5 py-3.5 w-16 text-center">{m.leveling_public_col_rank()}</th>
                <th class="px-6 py-3.5">{m.leveling_public_col_member()}</th>
                <th class="px-6 py-3.5 w-24">{m.leveling_public_col_level()}</th>
                <th class="px-6 py-3.5 w-24">{m.leveling_public_col_xp()}</th>
                <th class="px-6 py-3.5 w-48">{m.leveling_public_col_progress()}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#111a2e]">
              {#each filteredLevels as userLvl}
                {@const index = levels.findIndex(l => l.userId === userLvl.userId)}
                {@const lvl = getLevelFromXp(userLvl.xp)}
                {@const nextLvlXp = getXpForLevel(lvl)}
                {@const prevLvlXp = getXpForLevel(lvl - 1)}
                {@const progress = nextLvlXp - prevLvlXp > 0 ? ((userLvl.xp - prevLvlXp) / (nextLvlXp - prevLvlXp)) * 100 : 0}
                {@const percent = Math.min(100, Math.max(0, progress))}
                {@const color = getRankColor(index)}

                <tr
                  id="member-row-{userLvl.userId}"
                  class="group hover:bg-slate-50/50 dark:hover:bg-[#142036]/30 transition-colors duration-150 cursor-pointer
 {highlightedUserId === userLvl.userId ? 'bg-indigo-50/30 dark:bg-indigo-950/10 ring-1 ring-inset ring-indigo-500/40' : ''}"
                  onclick={() => selectMember(userLvl.userId)}
                >
                  <!-- Rang -->
                  <td class="px-5 py-4 text-center font-bold text-slate-500 dark:text-slate-400 font-mono text-sm">
                    {#if index === 0}
                      <span class="text-amber-500">1</span>
                    {:else if index === 1}
                      <span class="text-slate-400">2</span>
                    {:else if index === 2}
                      <span class="text-amber-700">3</span>
                    {:else}
                      {index + 1}
                    {/if}
                  </td>

                  <!-- Membre -->
                  <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                      <img
                        src={memberAvatarSrc(userLvl.avatarUrl, userLvl.displayName || userLvl.username, userLvl.userId)}
                        alt=""
                        class="w-8 h-8 rounded-full object-cover border border-slate-200 dark:border-slate-800"
                      />
                      <div class="min-w-0">
                        <span class="font-bold text-slate-800 dark:text-slate-100 text-sm truncate block">{userLvl.displayName || userLvl.username || m.leveling_public_unknown_member()}</span>
                        {#if userLvl.username && userLvl.displayName !== userLvl.username}
                          <span class="text-2xs text-slate-400 dark:text-slate-500 font-mono">@{userLvl.username}</span>
                        {/if}
                      </div>
                    </div>
                  </td>

                  <!-- Niveau -->
                  <td class="px-6 py-4 font-bold text-slate-700 dark:text-slate-300 text-sm">
                    {lvl}
                  </td>

                  <!-- XP -->
                  <td class="px-6 py-4 font-mono text-slate-600 dark:text-slate-400 text-xs">
                    {formatXp(userLvl.xp)}
                  </td>

                  <!-- Progression -->
                  <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                      <div class="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          class="h-full rounded-full transition-all duration-700
 {color === 'amber' ? 'bg-amber-500 dark:bg-amber-400' :
                             color === 'silver' ? 'bg-slate-400 dark:bg-slate-500' :
                             color === 'bronze' ? 'bg-amber-600 dark:bg-amber-500' :
                             'bg-indigo-500 dark:bg-indigo-400'}"
                          style="width: {percent}%"
                        ></div>
                      </div>
                      <span class="text-2xs font-mono text-slate-400 dark:text-slate-500 whitespace-nowrap">{Math.round(percent)}%</span>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr>
                  <td colspan="5" class="px-6 py-20 text-center">
                    <div class="flex flex-col items-center justify-center space-y-3">
                      <div class="text-slate-400 dark:text-slate-600"><Papicon icon="Search" size={20} /></div>
                      <p class="text-slate-500 dark:text-slate-400 font-semibold text-sm">
                        {#if searchQuery}{m.leveling_public_no_member_found({ query: searchQuery })}{:else}{m.leveling_public_leaderboard_empty()}{/if}
                      </p>
                      {#if searchQuery}
                        <button onclick={() => searchQuery = ''} class="text-indigo-500 dark:text-indigo-400 text-xs font-bold underline">{m.leveling_public_clear_filter()}</button>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <!-- ─── Footer épuré ─── -->
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
  /* Styles pour isoler le style du tableau blanc épuré */
  .whiteboard-container {
    background-color: #faf9f6;
    background-image: 
      radial-gradient(#cbd5e1 1.2px, transparent 1.2px);
    background-size: 24px 24px;
    color: #0f172a;
    font-family: 'Outfit', sans-serif;
    transition: background-color 0.3s ease, color 0.3s ease;
  }

  /* Mode sombre épuré - pas de tableau vert ardoise, juste du marine/anthracite premium */
  :global(.dark) .whiteboard-container {
    background-color: #090d16 !important;
    background-image: radial-gradient(#1e293b 1.2px, transparent 1.2px) !important;
    color: #f8fafc !important;
  }
  /*
   * `dark:selection:bg-slate-850` ne designait aucune couleur : slate ne va pas
   * au-dela de 900. La regle sombre ne s'appliquait donc jamais, et la
   * selection restait sur le jaune pale du theme clair - illisible sous le
   * texte clair du theme sombre. Les deux couples fond/texte sont poses ici.
   */
  .whiteboard-container :global(::selection) {
    background: #fde68a;
    color: #0f172a;
  }
  :global(.dark) .whiteboard-container :global(::selection) {
    background: rgba(251, 191, 36, 0.32);
    color: #f8fafc;
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

  .clean-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 12px -3px rgba(0, 0, 0, 0.04), 0 3px 6px -3px rgba(0, 0, 0, 0.04);
  }
  :global(.dark) .clean-card:hover {
    box-shadow: 0 8px 12px -3px rgba(0, 0, 0, 0.25), 0 3px 6px -3px rgba(0, 0, 0, 0.25) !important;
  }

  .tape-accent {
    position: absolute;
    top: -8px;
    right: 24px;
    width: 80px;
    height: 20px;
    background-color: rgba(251, 191, 36, 0.22);
    border-left: 1px dashed rgba(0,0,0,0.1);
    border-right: 1px dashed rgba(0,0,0,0.1);
    transform: rotate(3deg);
    z-index: 10;
  }
  :global(.dark) .tape-accent {
    background-color: rgba(251, 191, 36, 0.1) !important;
    border-left: 1px dashed rgba(255,255,255,0.08) !important;
    border-right: 1px dashed rgba(255,255,255,0.08) !important;
  }

  /* Custom scrollbar */
  ::-webkit-scrollbar {
    width: 6px;
  }
  ::-webkit-scrollbar-track {
    background: #f1f5f9;
    border-radius: 4px;
  }
  :global(.dark) ::-webkit-scrollbar-track {
    background: #0c1322;
  }
  ::-webkit-scrollbar-thumb {
    background: #cbd5e1;
    border-radius: 4px;
  }
  :global(.dark) ::-webkit-scrollbar-thumb {
    background: #1e293b;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: #94a3b8;
  }
  :global(.dark) ::-webkit-scrollbar-thumb:hover {
    background: #334155;
  }
</style>
