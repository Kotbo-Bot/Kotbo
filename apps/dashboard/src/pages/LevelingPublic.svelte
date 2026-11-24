<script lang="ts">
  import PublicShell from '../lib/components/public/PublicShell.svelte';
  import { onMount } from 'svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { fetchPublicLeveling } from '../lib/api';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { DEFAULT_LEVEL_CURVE, errorMessage, levelFromXp, normalizeLevelCurve, type LevelCurve, xpForLevel } from '@kotbo/shared';
  import { m, dateLocale } from '../lib/i18n';

  interface Props {
    serverId: string;
    initialUserId?: string;
  }
  const { serverId, initialUserId }: Props = $props();


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

<PublicShell {serverId} subtitle={m.leveling_public_header_subtitle()} icon={'Trophy'} {guildName} {guildIcon} width="narrow" live>


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
      <div class="bg-surface-container-low border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-on-surface font-semibold text-lg">{m.leveling_public_error_title()}</p>
          <p class="text-on-surface-variant text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>

    {:else if !enabled}
      <!-- Module désactivé -->
      <div class="bg-surface-container-low border border-outline-variant p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-14 h-14 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant">
          <Papicon icon="Lock" size={24} />
        </div>
        <div class="space-y-1.5 max-w-sm">
          <h2 class="text-xl font-bold text-on-surface">{m.leveling_public_disabled_title()}</h2>
          <p class="text-on-surface-variant text-sm leading-relaxed">
            {m.leveling_public_disabled_desc()}
          </p>
        </div>
      </div>

    {:else}

      {#if highlightedMember}
        {@const hRank = highlightedIndex + 1}
        {@const hLvl = getLevelFromXp(highlightedMember.xp)}
        {@const gapAhead = memberAhead ? Math.max(1, memberAhead.xp - highlightedMember.xp) : 0}
        <div class="pub-card rounded-xl p-5 sm:p-6 border-l-4 border-l-primary flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="flex items-center gap-4 min-w-0">
            <img
              src={memberAvatarSrc(highlightedMember.avatarUrl, highlightedMember.displayName || highlightedMember.username, highlightedMember.userId)}
              alt=""
              class="w-12 h-12 rounded-full object-cover border border-outline-variant shrink-0"
            />
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="px-2 py-0.5 rounded-md bg-primary/15 text-primary font-mono font-bold text-xs">
                  #{hRank} / {levels.length}
                </span>
                <p class="font-bold text-on-surface truncate text-base">
                  {highlightedMember.displayName || highlightedMember.username || m.leveling_public_unknown_member()}
                </p>
                <span class="text-xs font-semibold text-on-surface-variant">
                  · {m.leveling_public_level_n({ n: hLvl })} ({formatXp(highlightedMember.xp)} XP)
                </span>
              </div>
              <p class="text-xs text-on-surface-variant mt-1">
                {#if memberAhead}
                  {m.lpx_gap({ xp: formatXp(gapAhead), rank: hRank - 1, name: memberAhead.displayName || memberAhead.username })}
                {:else}
                  {m.lpx_leading()}
                {/if}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onclick={() => copyMemberShareUrl(highlightedMember.userId)}
              class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary/10 hover:bg-primary/20 text-primary transition-colors flex items-center gap-1.5"
            >
              <Papicon icon={shareCopied ? 'Check' : 'Share'} size={13} />
              <span>{shareCopied ? m.lpx_copied() : m.lpx_share()}</span>
            </button>
          </div>
        </div>
      {/if}

      <!-- ─── Cartes de statistiques globales épurées ─── -->
      {#if levels.length > 0}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface">{levels.length}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.leveling_public_stat_members()}</p>
          </div>
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface">{maxLevel}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.leveling_public_stat_max_level()}</p>
          </div>
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface">{avgLevel}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.leveling_public_stat_avg_level()}</p>
          </div>
          <div class="pub-card rounded-xl p-5 text-center space-y-1">
            <p class="text-2xl font-semibold text-on-surface">{formatXp(totalXp)}</p>
            <p class="text-xs font-semibold text-on-surface-variant">{m.leveling_public_stat_total_xp()}</p>
          </div>
        </div>
      {/if}

      <!-- ─── Section Top 3 Épuré ─── -->
      {#if !searchQuery && levels.length > 0}
        <div class="space-y-4">
          <h3 class="text-body-sm font-medium text-on-surface-variant flex items-center gap-2 ml-1">
            <span class="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block"></span>
            <span>{m.leveling_public_top_trio()}</span>
          </h3>
          
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 relative z-10">
            
            <!-- Rank 2 Card (Silver Border Accent) -->
            {#if levels[1]}
              <div class="relative pub-card border-t-2 border-outline-variant rounded-xl p-6 flex flex-col justify-between order-2 sm:order-1">
                <div class="flex items-start justify-between">
                  <div class="space-y-3 w-full">
                    <span class="text-xl font-semibold text-on-surface-variant">{m.leveling_public_rank_2()}</span>
                    <div class="flex items-center gap-3">
                      <img
                        src={memberAvatarSrc(levels[1].avatarUrl, levels[1].displayName || levels[1].username, levels[1].userId)}
                        alt=""
                        class="w-12 h-12 rounded-full object-cover border border-outline-variant"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="font-bold text-on-surface truncate text-sm" title={levels[1].displayName}>
                          {levels[1].displayName || levels[1].username || m.leveling_public_unknown_member()}
                        </p>
                        <p class="text-xs text-on-surface-variant">{m.leveling_public_level_n({ n: getLevelFromXp(levels[1].xp) })}</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mt-4 text-xs font-mono text-on-surface-variant border-t border-outline-variant/50 pt-3 flex justify-between">
                  <span>{m.leveling_public_total_xp_label()}</span>
                  <span class="font-bold text-on-surface">{formatXp(levels[1].xp)}</span>
                </div>
              </div>
            {/if}

            <!-- Rank 1 Card (Gold Border Accent) -->
            {#if levels[0]}
              <div class="relative pub-card border-t-2 border-amber-400 dark:border-amber-500 rounded-xl p-6 flex flex-col justify-between order-1 sm:order-2">
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
                        class="w-14 h-14 rounded-full object-cover border border-outline-variant"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="font-semibold text-on-surface truncate text-base" title={levels[0].displayName}>
                          {levels[0].displayName || levels[0].username || m.leveling_public_unknown_member()}
                        </p>
                        <p class="text-xs text-amber-500 dark:text-amber-400 font-bold">{m.leveling_public_level_n({ n: getLevelFromXp(levels[0].xp) })}</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mt-4 text-xs font-mono text-on-surface-variant border-t border-outline-variant/50 pt-3 flex justify-between">
                  <span>{m.leveling_public_total_xp_label()}</span>
                  <span class="font-bold text-amber-500 dark:text-amber-400">{formatXp(levels[0].xp)}</span>
                </div>
              </div>
            {/if}

            <!-- Rank 3 Card (Bronze/Copper Border Accent) -->
            {#if levels[2]}
              <div class="relative pub-card border-t-2 border-amber-600 dark:border-amber-700/80 rounded-xl p-6 flex flex-col justify-between order-3">
                <div class="flex items-start justify-between">
                  <div class="space-y-3 w-full">
                    <span class="text-xl font-semibold text-amber-700/80 dark:text-amber-600">{m.leveling_public_rank_3()}</span>
                    <div class="flex items-center gap-3">
                      <img
                        src={memberAvatarSrc(levels[2].avatarUrl, levels[2].displayName || levels[2].username, levels[2].userId)}
                        alt=""
                        class="w-12 h-12 rounded-full object-cover border border-outline-variant"
                      />
                      <div class="min-w-0 flex-1">
                        <p class="font-bold text-on-surface truncate text-sm" title={levels[2].displayName}>
                          {levels[2].displayName || levels[2].username || m.leveling_public_unknown_member()}
                        </p>
                        <p class="text-xs text-on-surface-variant">{m.leveling_public_level_n({ n: getLevelFromXp(levels[2].xp) })}</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mt-4 text-xs font-mono text-on-surface-variant border-t border-outline-variant/50 pt-3 flex justify-between">
                  <span>{m.leveling_public_total_xp_label()}</span>
                  <span class="font-bold text-on-surface">{formatXp(levels[2].xp)}</span>
                </div>
              </div>
            {/if}

          </div>
        </div>
      {/if}

      <!-- ─── Liste Principale Tableau Épuré ─── -->
      <section class="bg-surface-container-low border border-outline-variant rounded-lg p-6 sm:p-8 space-y-6 shadow-sm">
        
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <h3 class="text-base font-semibold text-on-surface">
            {m.leveling_public_members_title()}
          </h3>

          <!-- Barre de recherche -->
          <div class="relative w-full sm:w-80">
            <input aria-label={m.leveling_public_search_placeholder()}
              type="text"
              id="leaderboard-search"
              placeholder={m.leveling_public_search_placeholder()}
              bind:value={searchQuery}
              class="w-full bg-surface-container border border-field-border rounded-xl px-4 py-2.5 pl-10 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:bg-white focus:border-field-border transition-all font-semibold"
            />
            <div class="absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant flex items-center">
              <Papicon icon="Search" size={14} />
            </div>
            {#if searchQuery}
              <button
                onclick={() => searchQuery = ''}
                aria-label={m.leveling_public_clear_search()}
                class="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-surface-container-highest hover:bg-red-100 dark:hover:bg-red-950/45 hover:text-red-700 dark:hover:text-red-300 text-on-surface-variant flex items-center justify-center transition-all"
              ><Papicon icon="x" size={10} /></button>
            {/if}
          </div>
        </div>

        <!-- Tableau des joueurs -->
        <div class="border border-outline-variant rounded-xl overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-surface-container border-b border-outline-variant text-xs font-semibold text-on-surface-variant">
                <th class="px-5 py-3.5 w-16 text-center">{m.leveling_public_col_rank()}</th>
                <th class="px-6 py-3.5">{m.leveling_public_col_member()}</th>
                <th class="px-6 py-3.5 w-24">{m.leveling_public_col_level()}</th>
                <th class="px-6 py-3.5 w-24">{m.leveling_public_col_xp()}</th>
                <th class="px-6 py-3.5 w-48">{m.leveling_public_col_progress()}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/50 bg-surface-container-low">
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
                  class="group hover:bg-surface-container/50 transition-colors duration-150 cursor-pointer
 {highlightedUserId === userLvl.userId ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}"
                  onclick={() => selectMember(userLvl.userId)}
                >
                  <!-- Rang -->
                  <td class="px-5 py-4 text-center font-bold text-on-surface-variant font-mono text-sm">
                    {#if index === 0}
                      <span class="text-amber-500">1</span>
                    {:else if index === 1}
                      <span class="text-on-surface-variant">2</span>
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
                        class="w-8 h-8 rounded-full object-cover border border-outline-variant"
                      />
                      <div class="min-w-0">
                        <span class="font-bold text-on-surface text-sm truncate block">{userLvl.displayName || userLvl.username || m.leveling_public_unknown_member()}</span>
                        {#if userLvl.username && userLvl.displayName !== userLvl.username}
                          <span class="text-2xs text-on-surface-variant font-mono">@{userLvl.username}</span>
                        {/if}
                      </div>
                    </div>
                  </td>

                  <!-- Niveau -->
                  <td class="px-6 py-4 font-bold text-on-surface text-sm">
                    {lvl}
                  </td>

                  <!-- XP -->
                  <td class="px-6 py-4 font-mono text-on-surface-variant text-xs">
                    {formatXp(userLvl.xp)}
                  </td>

                  <!-- Progression -->
                  <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                      <div class="flex-1 h-2 bg-surface-container-high rounded-full overflow-hidden">
                        <div
                          class="h-full rounded-full transition-all duration-700
 {color === 'amber' ? 'bg-amber-500 dark:bg-amber-400' :
                             color === 'silver' ? 'bg-outline' :
                             color === 'bronze' ? 'bg-amber-600 dark:bg-amber-500' :
                             'bg-primary'}"
                          style="width: {percent}%"
                        ></div>
                      </div>
                      <span class="text-2xs font-mono text-on-surface-variant whitespace-nowrap">{Math.round(percent)}%</span>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr>
                  <td colspan="5" class="px-6 py-20 text-center">
                    <div class="flex flex-col items-center justify-center space-y-3">
                      <div class="text-on-surface-variant"><Papicon icon="Search" size={20} /></div>
                      <p class="text-on-surface-variant font-semibold text-sm">
                        {#if searchQuery}{m.leveling_public_no_member_found({ query: searchQuery })}{:else}{m.leveling_public_leaderboard_empty()}{/if}
                      </p>
                      {#if searchQuery}
                        <button onclick={() => searchQuery = ''} class="text-primary text-xs font-bold underline">{m.leveling_public_clear_filter()}</button>
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

    {/if}
</PublicShell>
