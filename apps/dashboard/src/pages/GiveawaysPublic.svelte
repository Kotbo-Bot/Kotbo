<script lang="ts">
  /**
   * Page publique des giveaways d'un serveur.
   *
   * Un seul composant sert la liste (`/:serverId/giveaways`) et la fiche d'un
   * concours (`/:serverId/giveaways/:giveawayId`) : les deux vues partagent
   * l'en-tête, le pied de page, la mise en forme des états et le compte à
   * rebours, et les séparer en deux fichiers reviendrait à tout dupliquer.
   *
   * Tout ce qui est affiché provient de l'API publique, qui reprend exactement
   * les états de l'embed Discord (couleur, gagnants annoncés, récompenses
   * bonus) : la page et le message racontent la même chose au même moment.
   */
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import {
    fetchPublicGiveaway,
    fetchPublicGiveaways,
    type PublicGiveaway,
    type PublicGiveawayStatus,
  } from '../lib/api';
  import { m, dateLocale, getLocale, locales, type Locale } from '../lib/i18n';
  import { themeStore } from '../lib/stores/theme.svelte';
  import { userPrefs } from '../lib/stores/userPreferences.svelte';

  import { errorMessage } from '@kotbo/shared';
  interface Props {
    serverId: string;
    /** Absent sur la liste, renseigné sur la fiche d'un concours. */
    giveawayId?: string;
  }
  const { serverId, giveawayId }: Props = $props();

  const currentLocale = getLocale();
  function switchLocale(loc: Locale) {
    if (loc === currentLocale) return;
    userPrefs.set('language', loc);
  }

  let loading = $state(true);
  let errorMsg = $state<string | null>(null);
  let notFound = $state(false);
  let enabled = $state(false);
  let guildName = $state('Kotbo Server');
  let guildIcon = $state<string | null>(null);
  let giveaways = $state<PublicGiveaway[]>([]);
  let detail = $state<PublicGiveaway | null>(null);

  /** Fait avancer les comptes à rebours sans re-solliciter l'API. */
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    const guild = serverId;
    const target = giveawayId;
    let cancelled = false;

    loading = true;
    errorMsg = null;
    notFound = false;

    (async () => {
      try {
        if (target) {
          const res = await fetchPublicGiveaway(guild, target);
          if (cancelled) return;
          enabled = res.enabled;
          guildName = res.guildName ?? 'Kotbo Server';
          guildIcon = res.guildIcon ?? null;
          detail = res.giveaway;
          giveaways = [];
          notFound = res.enabled && !res.giveaway;
        } else {
          const res = await fetchPublicGiveaways(guild);
          if (cancelled) return;
          enabled = res.enabled;
          guildName = res.guildName ?? 'Kotbo Server';
          guildIcon = res.guildIcon ?? null;
          giveaways = res.giveaways ?? [];
          detail = null;
        }
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        errorMsg = errorMessage(err) || m.giveaway_public_error_loading();
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => { cancelled = true; };
  });

  const activeGiveaways = $derived(giveaways.filter((g) => !g.ended));
  const endedGiveaways = $derived(giveaways.filter((g) => g.ended));
  const totalParticipations = $derived(giveaways.reduce((sum, g) => sum + g.participantCount, 0));
  const totalWinners = $derived(giveaways.reduce((sum, g) => sum + g.winners.length, 0));

  function statusLabel(status: PublicGiveawayStatus): string {
    if (status === 'ACTIVE') return m.giveaway_public_status_active();
    if (status === 'PENDING_VALIDATION') return m.giveaway_public_status_pending();
    if (status === 'VALIDATED') return m.giveaway_public_status_validated();
    return m.giveaway_public_status_ended();
  }

  /** Reprend les couleurs de l'embed Discord : blurple, ambre, vert, rouge. */
  function statusClasses(status: PublicGiveawayStatus): string {
    if (status === 'ACTIVE') return 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20';
    if (status === 'PENDING_VALIDATION') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
    if (status === 'VALIDATED') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';
    return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20';
  }

  function countdown(endsAt: string, nowMs: number): string {
    const diff = new Date(endsAt).getTime() - nowMs;
    if (diff <= 0) return m.giveaway_public_countdown_over();

    const totalSeconds = Math.floor(diff / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${m.giveaway_public_cd_days({ count: days })} ${m.giveaway_public_cd_hours({ count: hours })}`;
    if (hours > 0) return `${m.giveaway_public_cd_hours({ count: hours })} ${m.giveaway_public_cd_minutes({ count: minutes })}`;
    if (minutes > 0) return `${m.giveaway_public_cd_minutes({ count: minutes })} ${m.giveaway_public_cd_seconds({ count: seconds })}`;
    return m.giveaway_public_cd_seconds({ count: seconds });
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleString(dateLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function hasRewards(giveaway: PublicGiveaway): boolean {
    return giveaway.rewards.coins > 0 || giveaway.rewards.xp > 0 || !!giveaway.rewards.itemName || giveaway.needValidation;
  }

  const listPath = $derived(`/${serverId}/giveaways`);
  function detailPath(id: string) {
    return `/${serverId}/giveaways/${id}`;
  }

  function goto(event: MouseEvent, path: string) {
    // Le lien reste un vrai `href` (ouverture dans un onglet, partage, robots) ;
    // le clic simple est intercepté pour naviguer sans recharger la page.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    router.goto(path);
  }
</script>

<svelte:head>
  <title>
    {detail ? m.giveaway_public_detail_page_title({ prize: detail.prize, guildName }) : m.giveaway_public_page_title({ guildName })}
  </title>
  <meta name="description" content={m.giveaway_public_meta_desc({ guildName })} />
</svelte:head>

{#snippet identityChip(person: { displayName: string; avatarUrl: string | null }, size: 'sm' | 'md')}
  <div class="flex items-center gap-2">
    {#if person.avatarUrl}
      <img
        src={person.avatarUrl}
        alt=""
        class="rounded-full object-cover border border-slate-200 dark:border-slate-800 {size === 'md' ? 'w-8 h-8' : 'w-6 h-6'}"
      />
    {:else}
      <div
        class="rounded-full bg-slate-100 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-500 dark:text-slate-400 {size === 'md' ? 'w-8 h-8' : 'w-6 h-6'}"
      >
        {person.displayName.slice(0, 2).toUpperCase()}
      </div>
    {/if}
    <span class="{size === 'md' ? 'text-sm' : 'text-xs'} font-semibold text-slate-700 dark:text-slate-200 truncate">
      {person.displayName}
    </span>
  </div>
{/snippet}

{#snippet rewardTags(giveaway: PublicGiveaway)}
  <div class="flex flex-wrap gap-2">
    {#if giveaway.rewards.coins > 0}
      <span class="inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/15">
        <Papicon icon="Coins" size={11} />{m.giveaway_public_reward_coins({ count: giveaway.rewards.coins })}
      </span>
    {/if}
    {#if giveaway.rewards.xp > 0}
      <span class="inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-1 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/15">
        <Papicon icon="Sparkles" size={11} />{m.giveaway_public_reward_xp({ count: giveaway.rewards.xp })}
      </span>
    {/if}
    {#if giveaway.rewards.itemName}
      <span class="inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-1 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/15">
        <Papicon icon="Package" size={11} />{m.giveaway_public_reward_item({ name: giveaway.rewards.itemName })}
      </span>
    {/if}
    {#if giveaway.needValidation}
      <span class="inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-1 rounded-full bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/15">
        <Papicon icon="AlertTriangle" size={11} />{m.giveaway_public_validation_required()}
      </span>
    {/if}
  </div>
{/snippet}

{#snippet giveawayCard(giveaway: PublicGiveaway)}
  <a
    href={detailPath(giveaway.id)}
    onclick={(event) => goto(event, detailPath(giveaway.id))}
    class="clean-card block p-5 rounded-lg space-y-4 no-underline"
  >
    <div class="flex items-start justify-between gap-3">
      <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100 leading-snug wrap-break-word">
        {giveaway.prize}
      </h3>
      <span class="shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full border {statusClasses(giveaway.status)}">
        {statusLabel(giveaway.status)}
      </span>
    </div>

    {#if giveaway.description}
      <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-2">{giveaway.description}</p>
    {/if}

    <div class="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400 font-medium">
      <span class="inline-flex items-center gap-1.5">
        <Papicon icon="Users" size={12} />{m.giveaway_public_participants({ count: giveaway.participantCount })}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <Papicon icon="Crown" size={12} />{m.giveaway_public_winner_slots({ count: giveaway.winnerCount })}
      </span>
    </div>

    {#if giveaway.status === 'ACTIVE'}
      <div class="flex items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
        <span class="text-xs font-semibold text-slate-400 dark:text-slate-500">
          {m.giveaway_public_time_left()}
        </span>
        <span class="text-sm font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
          {countdown(giveaway.endsAt, now)}
        </span>
      </div>
    {:else if giveaway.winners.length > 0}
      <div class="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
        <span class="text-xs font-semibold text-slate-400 dark:text-slate-500">
          {m.giveaway_public_winners_title()}
        </span>
        <div class="flex flex-wrap gap-x-4 gap-y-2">
          {#each giveaway.winners as winner (winner.userId)}
            {@render identityChip(winner, 'sm')}
          {/each}
        </div>
      </div>
    {:else}
      <div class="pt-3 border-t border-slate-100 dark:border-slate-800">
        <span class="text-xs text-slate-400 dark:text-slate-500 italic">{m.giveaway_public_no_winners()}</span>
      </div>
    {/if}
  </a>
{/snippet}

<div class="min-h-screen whiteboard-container relative overflow-x-hidden py-12 px-4 sm:px-6 z-10">
  <div class="relative z-10 w-full max-w-4xl mx-auto space-y-10 animate-in fade-in duration-300">

    <!-- ─── En-tête ─── -->
    <header class="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-5 rounded-lg shadow-sm overflow-hidden">
      <div class="tape-accent"></div>

      <div class="flex items-center gap-4">
        {#if guildIcon}
          <img src={guildIcon} alt="" class="w-11 h-11 rounded-lg object-cover border border-slate-200 dark:border-slate-800 shrink-0" />
        {:else}
          <div class="w-11 h-11 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-center font-bold text-sm text-slate-800 dark:text-slate-100 shrink-0">
            <span>{guildName.slice(0, 2).toUpperCase()}</span>
          </div>
        {/if}

        <div>
          <h1 class="text-lg font-semibold tracking-tight text-slate-800 dark:text-slate-100">{guildName}</h1>
          <div class="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-semibold text-xs">
            <span class="text-indigo-500"><Papicon icon="Gift" size={14} /></span>
            <span>{m.giveaway_public_header_subtitle()}</span>
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

        <div class="relative flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 dark:border-emerald-500/10 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 absolute"></span>
          <span class="ml-2.5 text-xs">{m.giveaway_public_live_badge()}</span>
        </div>
      </div>
    </header>

    {#if loading}
      <div class="space-y-6">
        <Skeleton height="90px" radius="0.5rem" />
        <Skeleton height="220px" radius="0.5rem" />
        <Skeleton height="220px" radius="0.5rem" />
      </div>

    {:else if errorMsg}
      <div class="bg-white dark:bg-[#111a2e] border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-semibold text-lg">{m.giveaway_public_error_title()}</p>
          <p class="text-slate-500 dark:text-slate-400 text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>

    {:else if !enabled}
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-full flex items-center justify-center text-slate-400">
          <Papicon icon="Gift" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-semibold text-lg">{m.giveaway_public_disabled_title()}</p>
          <p class="text-slate-500 dark:text-slate-400 text-sm max-w-md">{m.giveaway_public_disabled_desc()}</p>
        </div>
      </div>

    {:else if notFound}
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-full flex items-center justify-center text-slate-400">
          <Papicon icon="Search" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-semibold text-lg">{m.giveaway_public_not_found_title()}</p>
          <p class="text-slate-500 dark:text-slate-400 text-sm max-w-md">{m.giveaway_public_not_found_desc()}</p>
        </div>
        <a
          href={listPath}
          onclick={(event) => goto(event, listPath)}
          class="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"
        >
          <Papicon icon="ArrowLeft" size={13} />{m.giveaway_public_back()}
        </a>
      </div>

    {:else if detail}
      <!-- ─── Fiche d'un giveaway ─── -->
      <a
        href={listPath}
        onclick={(event) => goto(event, listPath)}
        class="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
      >
        <Papicon icon="ArrowLeft" size={13} />{m.giveaway_public_back()}
      </a>

      <section class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm overflow-hidden">
        <div class="p-6 sm:p-8 space-y-6">
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div class="space-y-2">
              <span class="inline-block text-xs font-semibold px-2.5 py-1 rounded-full border {statusClasses(detail.status)}">
                {statusLabel(detail.status)}
              </span>
              <h2 class="flex items-start gap-2 text-2xl font-semibold tracking-tight text-slate-800 dark:text-slate-100 wrap-break-word">
                <Papicon icon="gift" size={22} class="mt-1 shrink-0" />
                <span>{detail.prize}</span>
              </h2>
            </div>

            {#if detail.messageUrl}
              <a
                href={detail.messageUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition-colors"
              >
                <Papicon icon="ExternalLink" size={13} />{m.giveaway_public_view_on_discord()}
              </a>
            {/if}
          </div>

          <!-- Compte à rebours / date de fin -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {detail.status === 'ACTIVE' ? m.giveaway_public_time_left() : m.giveaway_public_status_ended()}
              </p>
              <p class="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums">
                {detail.status === 'ACTIVE' ? countdown(detail.endsAt, now) : formatDate(detail.endsAt)}
              </p>
            </div>
            <div class="bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {m.giveaway_public_stat_participants()}
              </p>
              <p class="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums">{detail.participantCount}</p>
            </div>
            <div class="bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {m.giveaway_public_stat_winners()}
              </p>
              <p class="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums">{detail.winnerCount}</p>
            </div>
            <div class="bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {m.giveaway_public_channel()}
              </p>
              <p class="text-base font-bold text-slate-800 dark:text-slate-100 truncate">
                #{detail.channelName || detail.channelId}
              </p>
            </div>
          </div>

          {#if detail.description}
            <div class="space-y-2">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {m.giveaway_public_description_title()}
              </p>
              <p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line wrap-break-word">
                {detail.description}
              </p>
            </div>
          {/if}

          {#if hasRewards(detail)}
            <div class="space-y-2">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {m.giveaway_public_rewards_title()}
              </p>
              {@render rewardTags(detail)}
            </div>
          {/if}

          <!-- Gagnants -->
          <div class="space-y-3">
            <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
              {m.giveaway_public_winners_title()}
            </p>

            {#if detail.status === 'ACTIVE'}
              <p class="text-sm text-slate-400 dark:text-slate-500 italic">{m.giveaway_public_winners_hidden()}</p>
            {:else if detail.winners.length === 0}
              <p class="text-sm text-slate-400 dark:text-slate-500 italic">{m.giveaway_public_no_winners()}</p>
            {:else}
              {#if detail.winnersPending}
                <p class="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/5 border border-amber-500/15 rounded-lg px-3 py-2">
                  {m.giveaway_public_winners_pending_note()}
                </p>
              {/if}
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {#each detail.winners as winner (winner.userId)}
                  <div class="flex items-center gap-3 bg-emerald-500/5 border border-emerald-500/15 rounded-lg px-3 py-2.5">
                    <span class="text-emerald-500 shrink-0"><Papicon icon="Crown" size={14} /></span>
                    {@render identityChip(winner, 'md')}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Créateur & dates -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-5 border-t border-slate-100 dark:border-slate-800">
            <div class="space-y-1.5">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {m.giveaway_public_creator()}
              </p>
              {#if detail.creator}
                {@render identityChip(detail.creator, 'md')}
              {:else}
                <p class="text-sm text-slate-400 dark:text-slate-500 italic">{m.giveaway_public_creator_unknown()}</p>
              {/if}
            </div>
            <p class="text-xs text-slate-400 dark:text-slate-500">
              {m.giveaway_public_created_on({ date: formatDate(detail.createdAt) })}
            </p>
          </div>

          {#if detail.status === 'ACTIVE'}
            <p class="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2.5 flex items-center gap-2">
              <Papicon icon="Info" size={13} />{m.giveaway_public_join_hint()}
            </p>
          {/if}
        </div>
      </section>

    {:else if giveaways.length === 0}
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-full flex items-center justify-center text-slate-400">
          <Papicon icon="Gift" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-semibold text-lg">{m.giveaway_public_empty_title()}</p>
          <p class="text-slate-500 dark:text-slate-400 text-sm max-w-md">{m.giveaway_public_empty_desc()}</p>
        </div>
      </div>

    {:else}
      <!-- ─── Liste ─── -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="clean-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.giveaway_public_stat_active()}</p>
          <p class="text-xl font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">{activeGiveaways.length}</p>
        </div>
        <div class="clean-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.giveaway_public_stat_total()}</p>
          <p class="text-xl font-bold text-slate-800 dark:text-slate-100 tabular-nums">{giveaways.length}</p>
        </div>
        <div class="clean-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.giveaway_public_stat_participants()}</p>
          <p class="text-xl font-bold text-slate-800 dark:text-slate-100 tabular-nums">{totalParticipations}</p>
        </div>
        <div class="clean-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-slate-400 dark:text-slate-500">{m.giveaway_public_stat_winners()}</p>
          <p class="text-xl font-bold text-amber-500 tabular-nums">{totalWinners}</p>
        </div>
      </div>

      {#if activeGiveaways.length > 0}
        <section class="space-y-4">
          <h2 class="text-sm font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2">
            <span class="text-indigo-500"><Papicon icon="Clock" size={15} /></span>
            {m.giveaway_public_section_active({ count: activeGiveaways.length })}
          </h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            {#each activeGiveaways as giveaway (giveaway.id)}
              {@render giveawayCard(giveaway)}
            {/each}
          </div>
        </section>
      {/if}

      {#if endedGiveaways.length > 0}
        <section class="space-y-4">
          <h2 class="text-sm font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2">
            <span class="text-amber-500"><Papicon icon="Trophy" size={15} /></span>
            {m.giveaway_public_section_ended({ count: endedGiveaways.length })}
          </h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            {#each endedGiveaways as giveaway (giveaway.id)}
              {@render giveawayCard(giveaway)}
            {/each}
          </div>
        </section>
      {/if}
    {/if}

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
  </div>
</div>

<style>
  /* Reprise du "tableau blanc" des autres pages publiques (classement, clans). */
  .whiteboard-container {
    background-color: #faf9f6;
    background-image:
      linear-gradient(rgba(0, 0, 0, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 0, 0, 0.03) 1px, transparent 1px);
    background-size: 28px 28px;
  }
  :global(.dark) .whiteboard-container {
    background-color: #070d1a;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
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
    background-color: #111a2e;
    border-color: #1e293b;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.15), 0 2px 4px -2px rgba(0, 0, 0, 0.15);
  }

  .clean-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 12px -3px rgba(0, 0, 0, 0.04), 0 3px 6px -3px rgba(0, 0, 0, 0.04);
  }
  :global(.dark) .clean-card:hover {
    box-shadow: 0 8px 12px -3px rgba(0, 0, 0, 0.25), 0 3px 6px -3px rgba(0, 0, 0, 0.25);
  }

  .tape-accent {
    position: absolute;
    top: -8px;
    right: 24px;
    width: 80px;
    height: 20px;
    background-color: rgba(99, 102, 241, 0.18);
    border-left: 1px dashed rgba(0, 0, 0, 0.1);
    border-right: 1px dashed rgba(0, 0, 0, 0.1);
    transform: rotate(3deg);
    z-index: 10;
  }
  :global(.dark) .tape-accent {
    background-color: rgba(99, 102, 241, 0.12);
    border-left: 1px dashed rgba(255, 255, 255, 0.08);
    border-right: 1px dashed rgba(255, 255, 255, 0.08);
  }
</style>
