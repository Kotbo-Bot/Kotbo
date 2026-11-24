<script lang="ts">
  import PublicShell from '../lib/components/public/PublicShell.svelte';
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
  import { m, dateLocale } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  interface Props {
    serverId: string;
    /** Absent sur la liste, renseigné sur la fiche d'un concours. */
    giveawayId?: string;
  }
  const { serverId, giveawayId }: Props = $props();


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
    if (status === 'ACTIVE') return 'bg-primary/10 text-primary border-primary/20';
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
        class="rounded-full object-cover border border-outline-variant {size === 'md' ? 'w-8 h-8' : 'w-6 h-6'}"
      />
    {:else}
      <div
        class="rounded-full bg-surface-container-high border border-outline-variant flex items-center justify-center text-[10px] font-bold text-on-surface-variant {size === 'md' ? 'w-8 h-8' : 'w-6 h-6'}"
      >
        {person.displayName.slice(0, 2).toUpperCase()}
      </div>
    {/if}
    <span class="{size === 'md' ? 'text-sm' : 'text-xs'} font-semibold text-on-surface truncate">
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
      <span class="inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-1 rounded-full bg-outline/10 text-on-surface-variant border border-outline-variant/15">
        <Papicon icon="AlertTriangle" size={11} />{m.giveaway_public_validation_required()}
      </span>
    {/if}
  </div>
{/snippet}

{#snippet giveawayCard(giveaway: PublicGiveaway)}
  <a
    href={detailPath(giveaway.id)}
    onclick={(event) => goto(event, detailPath(giveaway.id))}
    class="pub-card block p-5 rounded-lg space-y-4 no-underline"
  >
    <div class="flex items-start justify-between gap-3">
      <h3 class="text-base font-semibold text-on-surface leading-snug wrap-break-word">
        {giveaway.prize}
      </h3>
      <span class="shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full border {statusClasses(giveaway.status)}">
        {statusLabel(giveaway.status)}
      </span>
    </div>

    {#if giveaway.description}
      <p class="text-xs text-on-surface-variant leading-relaxed line-clamp-2">{giveaway.description}</p>
    {/if}

    <div class="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant font-medium">
      <span class="inline-flex items-center gap-1.5">
        <Papicon icon="Users" size={12} />{m.giveaway_public_participants({ count: giveaway.participantCount })}
      </span>
      <span class="inline-flex items-center gap-1.5">
        <Papicon icon="Crown" size={12} />{m.giveaway_public_winner_slots({ count: giveaway.winnerCount })}
      </span>
    </div>

    {#if giveaway.status === 'ACTIVE'}
      <div class="flex items-center justify-between gap-3 pt-3 border-t border-outline-variant/50">
        <span class="text-xs font-semibold text-on-surface-variant">
          {m.giveaway_public_time_left()}
        </span>
        <span class="text-sm font-bold text-primary tabular-nums">
          {countdown(giveaway.endsAt, now)}
        </span>
      </div>
    {:else if giveaway.winners.length > 0}
      <div class="pt-3 border-t border-outline-variant/50 space-y-2">
        <span class="text-xs font-semibold text-on-surface-variant">
          {m.giveaway_public_winners_title()}
        </span>
        <div class="flex flex-wrap gap-x-4 gap-y-2">
          {#each giveaway.winners as winner (winner.userId)}
            {@render identityChip(winner, 'sm')}
          {/each}
        </div>
      </div>
    {:else}
      <div class="pt-3 border-t border-outline-variant/50">
        <span class="text-xs text-on-surface-variant italic">{m.giveaway_public_no_winners()}</span>
      </div>
    {/if}
  </a>
{/snippet}

<PublicShell {serverId} subtitle={m.giveaway_public_header_subtitle()} icon={'Gift'} {guildName} {guildIcon} width="narrow" live>


    {#if loading}
      <div class="space-y-6">
        <Skeleton height="90px" radius="0.5rem" />
        <Skeleton height="220px" radius="0.5rem" />
        <Skeleton height="220px" radius="0.5rem" />
      </div>

    {:else if errorMsg}
      <div class="bg-surface-container-low border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-on-surface font-semibold text-lg">{m.giveaway_public_error_title()}</p>
          <p class="text-on-surface-variant text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>

    {:else if !enabled}
      <div class="bg-surface-container-low border border-outline-variant p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-surface-container border border-outline-variant rounded-full flex items-center justify-center text-on-surface-variant">
          <Papicon icon="Gift" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-on-surface font-semibold text-lg">{m.giveaway_public_disabled_title()}</p>
          <p class="text-on-surface-variant text-sm max-w-md">{m.giveaway_public_disabled_desc()}</p>
        </div>
      </div>

    {:else if notFound}
      <div class="bg-surface-container-low border border-outline-variant p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-surface-container border border-outline-variant rounded-full flex items-center justify-center text-on-surface-variant">
          <Papicon icon="Search" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-on-surface font-semibold text-lg">{m.giveaway_public_not_found_title()}</p>
          <p class="text-on-surface-variant text-sm max-w-md">{m.giveaway_public_not_found_desc()}</p>
        </div>
        <a
          href={listPath}
          onclick={(event) => goto(event, listPath)}
          class="inline-flex items-center gap-2 text-xs font-semibold text-on-surface hover:text-on-surface-variant transition-colors"
        >
          <Papicon icon="ArrowLeft" size={13} />{m.giveaway_public_back()}
        </a>
      </div>

    {:else if detail}
      <!-- ─── Fiche d'un giveaway ─── -->
      <a
        href={listPath}
        onclick={(event) => goto(event, listPath)}
        class="inline-flex items-center gap-2 text-xs font-semibold text-on-surface-variant hover:text-on-surface transition-colors"
      >
        <Papicon icon="ArrowLeft" size={13} />{m.giveaway_public_back()}
      </a>

      <section class="bg-surface-container-low border border-outline-variant rounded-lg shadow-sm overflow-hidden">
        <div class="p-6 sm:p-8 space-y-6">
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div class="space-y-2">
              <span class="inline-block text-xs font-semibold px-2.5 py-1 rounded-full border {statusClasses(detail.status)}">
                {statusLabel(detail.status)}
              </span>
              <h2 class="flex items-start gap-2 text-2xl font-semibold tracking-tight text-on-surface wrap-break-word">
                <Papicon icon="gift" size={22} class="mt-1 shrink-0" />
                <span>{detail.prize}</span>
              </h2>
            </div>

            {#if detail.messageUrl}
              <a
                href={detail.messageUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
              >
                <Papicon icon="ExternalLink" size={13} />{m.giveaway_public_view_on_discord()}
              </a>
            {/if}
          </div>

          <!-- Compte à rebours / date de fin -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="bg-surface-container border border-outline-variant rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-on-surface-variant">
                {detail.status === 'ACTIVE' ? m.giveaway_public_time_left() : m.giveaway_public_status_ended()}
              </p>
              <p class="text-base font-bold text-on-surface tabular-nums">
                {detail.status === 'ACTIVE' ? countdown(detail.endsAt, now) : formatDate(detail.endsAt)}
              </p>
            </div>
            <div class="bg-surface-container border border-outline-variant rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-on-surface-variant">
                {m.giveaway_public_stat_participants()}
              </p>
              <p class="text-base font-bold text-on-surface tabular-nums">{detail.participantCount}</p>
            </div>
            <div class="bg-surface-container border border-outline-variant rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-on-surface-variant">
                {m.giveaway_public_stat_winners()}
              </p>
              <p class="text-base font-bold text-on-surface tabular-nums">{detail.winnerCount}</p>
            </div>
            <div class="bg-surface-container border border-outline-variant rounded-lg p-4 space-y-1">
              <p class="text-xs font-semibold text-on-surface-variant">
                {m.giveaway_public_channel()}
              </p>
              <p class="text-base font-bold text-on-surface truncate">
                #{detail.channelName || detail.channelId}
              </p>
            </div>
          </div>

          {#if detail.description}
            <div class="space-y-2">
              <p class="text-xs font-semibold text-on-surface-variant">
                {m.giveaway_public_description_title()}
              </p>
              <p class="text-sm text-on-surface-variant leading-relaxed whitespace-pre-line wrap-break-word">
                {detail.description}
              </p>
            </div>
          {/if}

          {#if hasRewards(detail)}
            <div class="space-y-2">
              <p class="text-xs font-semibold text-on-surface-variant">
                {m.giveaway_public_rewards_title()}
              </p>
              {@render rewardTags(detail)}
            </div>
          {/if}

          <!-- Gagnants -->
          <div class="space-y-3">
            <p class="text-xs font-semibold text-on-surface-variant">
              {m.giveaway_public_winners_title()}
            </p>

            {#if detail.status === 'ACTIVE'}
              <p class="text-sm text-on-surface-variant italic">{m.giveaway_public_winners_hidden()}</p>
            {:else if detail.winners.length === 0}
              <p class="text-sm text-on-surface-variant italic">{m.giveaway_public_no_winners()}</p>
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
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-5 border-t border-outline-variant/50">
            <div class="space-y-1.5">
              <p class="text-xs font-semibold text-on-surface-variant">
                {m.giveaway_public_creator()}
              </p>
              {#if detail.creator}
                {@render identityChip(detail.creator, 'md')}
              {:else}
                <p class="text-sm text-on-surface-variant italic">{m.giveaway_public_creator_unknown()}</p>
              {/if}
            </div>
            <p class="text-xs text-on-surface-variant">
              {m.giveaway_public_created_on({ date: formatDate(detail.createdAt) })}
            </p>
          </div>

          {#if detail.status === 'ACTIVE'}
            <p class="text-xs text-on-surface-variant bg-surface-container border border-outline-variant rounded-lg px-3 py-2.5 flex items-center gap-2">
              <Papicon icon="Info" size={13} />{m.giveaway_public_join_hint()}
            </p>
          {/if}
        </div>
      </section>

    {:else if giveaways.length === 0}
      <div class="bg-surface-container-low border border-outline-variant p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-surface-container border border-outline-variant rounded-full flex items-center justify-center text-on-surface-variant">
          <Papicon icon="Gift" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-on-surface font-semibold text-lg">{m.giveaway_public_empty_title()}</p>
          <p class="text-on-surface-variant text-sm max-w-md">{m.giveaway_public_empty_desc()}</p>
        </div>
      </div>

    {:else}
      <!-- ─── Liste ─── -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="pub-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-on-surface-variant">{m.giveaway_public_stat_active()}</p>
          <p class="text-xl font-bold text-primary tabular-nums">{activeGiveaways.length}</p>
        </div>
        <div class="pub-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-on-surface-variant">{m.giveaway_public_stat_total()}</p>
          <p class="text-xl font-bold text-on-surface tabular-nums">{giveaways.length}</p>
        </div>
        <div class="pub-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-on-surface-variant">{m.giveaway_public_stat_participants()}</p>
          <p class="text-xl font-bold text-on-surface tabular-nums">{totalParticipations}</p>
        </div>
        <div class="pub-card p-4 rounded-lg space-y-1">
          <p class="text-xs font-semibold text-on-surface-variant">{m.giveaway_public_stat_winners()}</p>
          <p class="text-xl font-bold text-amber-500 tabular-nums">{totalWinners}</p>
        </div>
      </div>

      {#if activeGiveaways.length > 0}
        <section class="space-y-4">
          <h2 class="text-sm font-semibold text-on-surface-variant flex items-center gap-2">
            <span class="text-primary"><Papicon icon="Clock" size={15} /></span>
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
          <h2 class="text-sm font-semibold text-on-surface-variant flex items-center gap-2">
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

</PublicShell>
