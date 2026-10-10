<!--
  Fiche membre complète.

  Construite comme la fiche contact d'un CRM : une identité en tête avec les
  signaux qui demandent l'attention, une colonne « en bref » pour ce que le
  membre pèse sur le serveur, au centre son activité et la chronologie de tout
  ce qui le concerne, et à droite ses relations (salons, interlocuteurs).
  Le dossier détaillé (messages, permissions, graphe, notes) reste à un clic,
  dans la fenêtre que le reste du dashboard ouvre déjà.
-->
<script lang="ts">
  import { router } from 'tinro';
  import Papicon from '../Papicon.svelte';
  import Skeleton from '../Skeleton.svelte';
  import MemberCaseModal from '../MemberCaseModal.svelte';
  import BarList from '../analytics/BarList.svelte';
  import MemberClimateCard from '../aegis/MemberClimateCard.svelte';
  import { fmtNumber } from '../analytics/analyticsFormat';
  import { Button, Callout, EmptyState, FilterPills, SectionCard, type FilterOption } from '../ui';
  import { memberAvatarSrc } from '../../discordMedia';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import {
    fetchMemberCase,
    fetchMemberSummary,
    fetchMemberTimeline,
    type MemberActivityStats,
    type MemberClimate,
    type MemberSummary,
    type TimelineCategory,
    type TimelineItem,
  } from '../../api';
  import type { MemberCaseResponse } from '@kotbo/contracts';

  const { userId }: { userId: string } = $props();

  let caseData = $state<MemberCaseResponse | null>(null);
  let caseLoading = $state(true);
  let caseError = $state('');
  let summary = $state<MemberSummary | null>(null);
  let stats = $state<MemberActivityStats | null>(null);
  let climate = $state<MemberClimate | null>(null);
  let summaryLoading = $state(true);

  async function loadCase(id: string) {
    caseLoading = true;
    caseError = '';
    try {
      caseData = await fetchMemberCase(id);
    } catch (err) {
      caseError = err instanceof Error ? err.message : m.mp_load_error();
    } finally {
      caseLoading = false;
    }
  }

  async function loadSummary(id: string) {
    summaryLoading = true;
    try {
      const res = await fetchMemberSummary(id);
      summary = res?.summary ?? null;
      stats = res?.insights ?? null;
      climate = res?.climate ?? null;
    } catch {
      summary = null;
      stats = null;
      climate = null;
    } finally {
      summaryLoading = false;
    }
  }

  $effect(() => {
    const id = userId;
    caseData = null;
    summary = null;
    stats = null;
    climate = null;
    void loadCase(id);
    void loadSummary(id);
  });

  const profile = $derived(caseData?.profile ?? null);
  const displayName = $derived(profile?.displayName || profile?.globalName || profile?.username || m.mb_member_fallback());

  // ── Chronologie ────────────────────────────────────────
  type CategoryFilter = 'all' | TimelineCategory;
  let category = $state<CategoryFilter>('all');
  let items = $state<TimelineItem[]>([]);
  let nextBefore = $state<string | null>(null);
  let timelineLoading = $state(false);

  const categoryOptions: FilterOption<CategoryFilter>[] = $derived([
    { value: 'all', label: m.mp_cat_all() },
    { value: 'membership', label: m.mp_cat_membership() },
    { value: 'moderation', label: m.mp_cat_moderation() },
    { value: 'support', label: m.mp_cat_support() },
    { value: 'community', label: m.mp_cat_community() },
    { value: 'changes', label: m.mp_cat_changes() },
  ]);

  async function loadTimeline(reset: boolean) {
    timelineLoading = true;
    try {
      const res = await fetchMemberTimeline(userId, {
        before: reset ? null : nextBefore,
        categories: category === 'all' ? [] : [category],
      });
      if (res) {
        items = reset ? res.items : [...items, ...res.items];
        nextBefore = res.nextBefore;
      }
    } catch {
      toast.error(m.mp_timeline_error());
    } finally {
      timelineLoading = false;
    }
  }

  $effect(() => {
    void userId;
    void category;
    items = [];
    nextBefore = null;
    void loadTimeline(true);
  });

  /** Regroupe la chronologie par mois, comme un fil d'activité. */
  const groups = $derived.by(() => {
    const result: Array<{ key: string; label: string; items: TimelineItem[] }> = [];
    for (const item of items) {
      const date = new Date(item.at);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      let group = result[result.length - 1];
      if (!group || group.key !== key) {
        group = { key, label: date.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }), items: [] };
        result.push(group);
      }
      group.items.push(item);
    }
    return result;
  });

  const TONE_DOT: Record<TimelineItem['tone'], string> = {
    neutral: 'bg-outline-variant',
    info: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-error',
  };

  const CATEGORY_ICON: Record<TimelineCategory, string> = {
    membership: 'log-in',
    moderation: 'shield',
    support: 'message-square',
    community: 'sparkles',
    changes: 'edit',
  };

  const SIGNAL_CLASS = {
    danger: 'bg-error/10 text-error',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-surface-container text-on-surface-variant',
  } as const;

  // ── Dossier détaillé ───────────────────────────────────
  let modalOpen = $state(false);
  let modalTab = $state<'resume' | 'notes' | 'messages' | 'sanctions'>('resume');

  function openCase(tab: typeof modalTab) {
    modalTab = tab;
    modalOpen = true;
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(userId);
      toast.success(m.mp_id_copied());
    } catch {
      /* presse-papiers refusé : rien d'utile à dire */
    }
  }

  // ── Formats ────────────────────────────────────────────
  const formatDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const formatTime = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function relativeDays(iso: string | null | undefined): string {
    if (!iso) return '—';
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    if (days <= 0) return m.mp_today();
    if (days === 1) return m.mp_yesterday();
    return m.mp_days_ago({ count: days });
  }

  function rankLabel(rank: number | null | undefined, total?: number): string {
    if (!rank) return '';
    return total ? m.mp_rank_of({ rank, total: fmtNumber(total) }) : m.mp_rank({ rank });
  }

  const trend = $derived(stats?.activity.dailyTrend ?? []);
  const maxMessages = $derived(Math.max(1, ...trend.map((day) => day.messages)));
  const voiceHours = $derived(Math.round((stats?.activity.totalVoiceMinutes ?? 0) / 6) / 10);
</script>

{#if caseLoading && !caseData}
  <div class="space-y-4">
    <Skeleton height="h-36" />
    <div class="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)_18rem]">
      <Skeleton height="h-96" />
      <Skeleton height="h-96" />
      <Skeleton height="h-96" />
    </div>
  </div>
{:else if caseError || !caseData}
  <SectionCard>
    <EmptyState icon="user-x" title={m.mp_not_found()} description={caseError || m.mp_not_found_desc()} />
    <div class="flex justify-center pb-6"><Button variant="ghost" icon="arrow-left" href="/members">{m.mp_back()}</Button></div>
  </SectionCard>
{:else}
  <!-- Identité -->
  <section class="mp-header">
    <div class="flex items-start gap-4 min-w-0">
      <img src={memberAvatarSrc(profile?.avatarUrl, displayName, userId)} alt="" class="w-16 h-16 rounded-2xl shrink-0 object-cover" />
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold text-on-surface truncate">{displayName}</h2>
          {#if profile?.isOnServer}
            <span class="mp-chip bg-success/10 text-success">{m.mp_on_server()}</span>
          {:else}
            <span class="mp-chip bg-surface-container text-on-surface-variant">{m.mp_left()}</span>
          {/if}
          {#if profile?.isBot}<span class="mp-chip bg-surface-container text-on-surface-variant">Bot</span>{/if}
          {#if profile?.staffGrade}<span class="mp-chip bg-primary/10 text-primary">{profile.staffGrade}</span>{/if}
        </div>
        <p class="text-body-sm text-on-surface-variant mt-0.5">
          @{profile?.username ?? userId}
          {#if profile?.pronouns}· {profile.pronouns}{/if}
          <button type="button" class="ml-1 text-2xs text-primary hover:underline" onclick={copyId}>{m.mp_copy_id()}</button>
        </p>
        <dl class="mp-facts">
          <div><dt>{m.mp_joined()}</dt><dd>{formatDate(profile?.guildJoinedAt)}</dd></div>
          <div><dt>{m.mp_account_created()}</dt><dd>{formatDate(profile?.accountCreatedAt)}</dd></div>
          <div><dt>{m.mp_last_seen()}</dt><dd>{relativeDays(profile?.lastSeenAt ?? profile?.lastMessageAt)}</dd></div>
          {#if caseData.invite?.inviterTag}
            <div><dt>{m.mp_invited_by()}</dt><dd>
              {#if caseData.invite.inviterId}<a class="text-primary hover:underline" href={`/members/${caseData.invite.inviterId}`}>{caseData.invite.inviterTag}</a>{:else}{caseData.invite.inviterTag}{/if}
            </dd></div>
          {/if}
        </dl>
      </div>
    </div>
    <div class="flex flex-wrap gap-2 shrink-0">
      <Button variant="ghost" size="sm" icon="arrow-left" href="/members">{m.mp_back()}</Button>
      <Button size="sm" icon="message-square" onclick={() => openCase('messages')}>{m.mp_messages()}</Button>
      <Button size="sm" icon="folder" onclick={() => openCase('resume')}>{m.mp_open_case()}</Button>
      <Button size="sm" variant="primary" icon="shield" onclick={() => openCase('notes')}>{m.mp_moderate()}</Button>
    </div>
  </section>

  {#if summary && summary.signals.length > 0}
    <div class="flex flex-wrap gap-2 mt-3" aria-label={m.mp_signals()}>
      {#each summary.signals as signal (signal.key + signal.label)}
        <span class="mp-chip {SIGNAL_CLASS[signal.tone]}">
          <Papicon icon={signal.tone === 'info' ? 'info' : 'alert-triangle'} size={12} />
          {signal.label}
        </span>
      {/each}
    </div>
  {/if}

  {#if profile?.moderatorNote}
    <Callout variant="info" title={m.mp_note()} icon="edit" class="mt-4">
      <span class="whitespace-pre-line">{profile.moderatorNote}</span>
      {#snippet actions()}<Button size="sm" variant="ghost" onclick={() => openCase('notes')}>{m.mp_edit_note()}</Button>{/snippet}
    </Callout>
  {/if}

  <div class="grid gap-4 mt-4 xl:grid-cols-[18rem_minmax(0,1fr)_18rem] lg:grid-cols-[18rem_minmax(0,1fr)]">
    <!-- En bref -->
    <div class="space-y-4">
      <SectionCard title={m.mp_brief()}>
        {#if summaryLoading && !summary}
          <div class="p-5 space-y-2">{#each Array(5) as _}<Skeleton height="h-8" />{/each}</div>
        {:else}
          <dl class="mp-brief">
            <div>
              <dt>{m.mp_messages_90()}</dt>
              <dd>{fmtNumber(stats?.activity.totalMessages ?? profile?.messageCount ?? 0)}<span>{rankLabel(stats?.ranking.messages.rank, stats?.ranking.totalRankedMembers)}</span></dd>
            </div>
            <div>
              <dt>{m.mp_voice_90()}</dt>
              <dd>{voiceHours.toLocaleString(dateLocale())} h<span>{rankLabel(stats?.ranking.voice.rank)}</span></dd>
            </div>
            <div>
              <dt>{m.mp_active_days()}</dt>
              <dd>{stats?.activity.activeDays ?? 0}<span>{m.mp_streak({ current: stats?.activity.currentStreak ?? 0, best: stats?.activity.longestStreak ?? 0 })}</span></dd>
            </div>
            {#if summary?.level}
              <div><dt>{m.mp_level()}</dt><dd>{summary.level.level}<span>{fmtNumber(summary.level.xp)} XP · {rankLabel(summary.level.rank)}</span></dd></div>
            {/if}
            <div><dt>{m.mp_reputation()}</dt><dd>{summary?.reputation.received ?? 0}<span>{m.mp_rep_given({ count: summary?.reputation.given ?? 0 })}</span></dd></div>
            {#if summary?.economy}
              <div><dt>{m.mp_balance()}</dt><dd>{fmtNumber(summary.economy.balance)}<span>{rankLabel(summary.economy.rank)}</span></dd></div>
            {/if}
            <div><dt>{m.mp_invites()}</dt><dd>{summary?.invites.total ?? 0}<span>{m.mp_invites_stayed({ count: summary?.invites.stillHere ?? 0 })}</span></dd></div>
            <div>
              <dt>{m.mp_tickets()}</dt>
              <dd>{summary?.support.tickets ?? 0}<span>{summary?.support.averageRating !== null && summary?.support.averageRating !== undefined ? m.mp_tickets_rating({ rating: summary.support.averageRating }) : summary?.support.openTickets ? m.mp_tickets_open({ count: summary.support.openTickets }) : ''}</span></dd>
            </div>
            <div><dt>{m.mp_contributions()}</dt><dd>{(summary?.community.suggestions ?? 0) + (summary?.community.forms ?? 0)}<span>{m.mp_giveaways_won({ count: summary?.community.giveawayWins ?? 0 })}</span></dd></div>
          </dl>
        {/if}
      </SectionCard>

      {#if caseData.roles.length > 0}
        <SectionCard title={m.mp_roles({ count: caseData.roles.length })}>
          <div class="px-5 pb-5 pt-3 flex flex-wrap gap-1.5">
            {#each caseData.roles.slice(0, 30) as role (role.id)}
              <span class="mp-role"><span class="w-2 h-2 rounded-full" style="background: {role.color && role.color !== '#000000' ? role.color : 'var(--outline-variant)'}"></span>{role.name}</span>
            {/each}
          </div>
        </SectionCard>
      {/if}
    </div>

    <!-- Activité et chronologie -->
    <div class="space-y-4 min-w-0">
      <SectionCard title={m.mp_activity_title()} description={stats ? m.mp_activity_desc({ days: stats.period }) : ''}>
        <div class="px-5 pb-5 pt-4">
          {#if summaryLoading && !stats}
            <Skeleton height="h-24" />
          {:else if trend.length === 0 || trend.every((day) => day.messages === 0 && day.voiceMinutes === 0)}
            <p class="text-body-sm text-on-surface-variant">{m.mp_activity_empty()}</p>
          {:else}
            <div class="mp-bars" role="img" aria-label={m.mp_activity_title()}>
              {#each trend as day (day.dateKey)}
                <div class="mp-bar" title={`${day.dateKey} : ${day.messages} message(s), ${day.voiceMinutes} min de vocal`}>
                  <span class="mp-bar__fill" style="height: {day.messages === 0 ? 0 : Math.max(5, (day.messages / maxMessages) * 100)}%"></span>
                  {#if day.voiceMinutes > 0}<span class="mp-bar__voice" aria-hidden="true"></span>{/if}
                </div>
              {/each}
            </div>
            <div class="flex justify-between mt-1.5 text-2xs text-on-surface-variant">
              <span>{trend[0].dateKey}</span>
              <span class="flex items-center gap-3">
                <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm" style="background: var(--series-1)"></span>{m.mp_legend_messages()}</span>
                <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background: var(--series-2)"></span>{m.mp_legend_voice()}</span>
              </span>
              <span>{trend[trend.length - 1].dateKey}</span>
            </div>
          {/if}
        </div>
      </SectionCard>

      <SectionCard title={m.mp_timeline_title()} description={m.mp_timeline_desc()} flush>
        <div class="px-5 py-3 border-b border-outline-variant">
          <FilterPills label={m.mp_timeline_title()} options={categoryOptions} value={category} onchange={(value) => (category = value)} />
        </div>
        {#if timelineLoading && items.length === 0}
          <div class="p-5 space-y-2">{#each Array(5) as _}<Skeleton height="h-12" />{/each}</div>
        {:else if items.length === 0}
          <EmptyState icon="history" title={m.mp_timeline_empty()} description={m.mp_timeline_empty_desc()} />
        {:else}
          <div class="px-5 py-4 space-y-5">
            {#each groups as group (group.key)}
              <div>
                <h4 class="text-2xs font-medium text-on-surface-variant mb-2 first-letter:uppercase">{group.label}</h4>
                <ol class="mp-timeline">
                  {#each group.items as item (item.id)}
                    <li class="mp-event">
                      <span class="mp-event__dot {TONE_DOT[item.tone]}" aria-hidden="true"></span>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span class="flex items-center gap-1.5 text-body-sm text-on-surface">
                            <Papicon icon={CATEGORY_ICON[item.category]} size={13} class="text-on-surface-variant" />
                            {#if item.link}<a class="hover:underline" href={item.link}>{item.title}</a>{:else}{item.title}{/if}
                          </span>
                          <time class="text-2xs text-on-surface-variant tabular-nums" datetime={item.at}>{formatTime(item.at)}</time>
                        </div>
                        {#if item.description}<p class="text-body-sm text-on-surface-variant mt-0.5 wrap-break-word">{item.description}</p>{/if}
                        {#if item.actor?.name}
                          <p class="text-2xs text-on-surface-variant mt-0.5">
                            {m.mp_by()} {#if item.actor.id}<a class="text-primary hover:underline" href={`/members/${item.actor.id}`}>{item.actor.name}</a>{:else}{item.actor.name}{/if}
                          </p>
                        {/if}
                      </div>
                    </li>
                  {/each}
                </ol>
              </div>
            {/each}
          </div>
          {#if nextBefore}
            <div class="p-3 flex justify-center border-t border-outline-variant">
              <Button size="sm" variant="ghost" loading={timelineLoading} onclick={() => loadTimeline(false)}>{m.mp_load_more()}</Button>
            </div>
          {/if}
        {/if}
      </SectionCard>
    </div>

    <!-- Relations -->
    <div class="space-y-4 lg:col-span-2 xl:col-span-1">
      {#if stats}
        <SectionCard title={m.mp_risk_title()}>
          <div class="px-5 pb-5 pt-3 space-y-2">
            <div class="flex items-baseline justify-between">
              <span class="text-xl font-semibold text-on-surface tabular-nums">{stats.risk.riskLevel}/100</span>
              <span class="mp-chip {stats.risk.riskLevel >= 60 ? 'bg-error/10 text-error' : stats.risk.riskLevel >= 30 ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}">{stats.risk.riskLabel}</span>
            </div>
            <div class="mp-meter" aria-hidden="true"><span style="width: {stats.risk.riskLevel}%"></span></div>
            <p class="text-2xs text-on-surface-variant">
              {m.mp_risk_detail({ warns: stats.risk.warnCount, score: stats.risk.warnScore })}
              {#if stats.risk.daysSinceLastSanction !== null}· {m.mp_risk_last({ days: stats.risk.daysSinceLastSanction })}{/if}
            </p>
          </div>
        </SectionCard>

        {#if climate}
          <MemberClimateCard {climate} />
        {/if}

        <SectionCard title={m.mp_where()}>
          <div class="px-5 pb-5 pt-3">
            <BarList items={stats.social.topChannels.slice(0, 6).map((c) => ({ id: c.channelId, label: `#${c.channelName}`, value: c.count }))} empty={m.mp_where_empty()} />
          </div>
        </SectionCard>

        <SectionCard title={m.mp_with_whom()}>
          <ul class="px-5 pb-5 pt-3 space-y-2">
            {#each stats.social.topInterlocutors.slice(0, 6) as peer (peer.userId)}
              <li>
                <a class="flex items-center gap-2.5 rounded-lg -mx-1.5 px-1.5 py-1 hover:bg-surface-container-low" href={`/members/${peer.userId}`}>
                  <img src={memberAvatarSrc(peer.avatarUrl, peer.userTag, peer.userId)} alt="" class="w-6 h-6 rounded-full" />
                  <span class="text-body-sm text-on-surface truncate flex-1">{peer.userTag ?? peer.userId}</span>
                  <span class="text-2xs text-on-surface-variant tabular-nums">{peer.total}</span>
                </a>
              </li>
            {:else}
              <li class="text-body-sm text-on-surface-variant">{m.mp_with_whom_empty()}</li>
            {/each}
          </ul>
        </SectionCard>
      {/if}

      {#if caseData.linkedAccounts.length > 0}
        <SectionCard title={m.mp_linked()}>
          <ul class="px-5 pb-5 pt-3 space-y-2">
            {#each caseData.linkedAccounts as account (account.userId)}
              <li>
                <a class="flex items-center gap-2.5 rounded-lg -mx-1.5 px-1.5 py-1 hover:bg-surface-container-low" href={`/members/${account.userId}`}>
                  <img src={memberAvatarSrc(account.avatarUrl, account.userTag, account.userId)} alt="" class="w-6 h-6 rounded-full" />
                  <span class="text-body-sm text-on-surface truncate flex-1">{account.userTag ?? account.userId}</span>
                  <span class="text-2xs text-on-surface-variant">{account.status === 'VALIDATED' ? m.mp_linked_validated() : m.mp_linked_pending()}</span>
                </a>
              </li>
            {/each}
          </ul>
        </SectionCard>
      {/if}
    </div>
  </div>
{/if}

<MemberCaseModal
  open={modalOpen}
  {userId}
  userName={displayName}
  {caseData}
  loading={caseLoading}
  error={caseError}
  initialTab={modalTab}
  showProfileLink={false}
  onClose={() => {
    modalOpen = false;
    // Une action ou une note a pu changer le dossier : la fiche se relit.
    void loadCase(userId);
    void loadSummary(userId);
    void loadTimeline(true);
  }}
  onSelectUser={(id: string) => {
    modalOpen = false;
    router.goto(`/members/${id}`);
  }}
/>

<style>
  .mp-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem;
    border: 1px solid var(--outline-variant);
    border-radius: 1rem;
    background: var(--surface-container-lowest);
  }

  .mp-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 500;
  }

  .mp-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1.25rem;
    margin-top: 0.6rem;
    font-size: 0.75rem;
  }
  .mp-facts dt {
    color: var(--on-surface-variant);
  }
  .mp-facts dd {
    color: var(--on-surface);
  }

  .mp-brief {
    display: flex;
    flex-direction: column;
  }
  .mp-brief > div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 1.25rem;
    border-top: 1px solid color-mix(in srgb, var(--outline-variant) 50%, transparent);
  }
  .mp-brief > div:first-child {
    border-top: none;
  }
  .mp-brief dt {
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
  }
  .mp-brief dd {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--on-surface);
    font-variant-numeric: tabular-nums;
  }
  .mp-brief dd span {
    font-size: 0.6875rem;
    font-weight: 400;
    color: var(--on-surface-variant);
  }

  .mp-role {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--outline-variant);
    border-radius: 999px;
    font-size: 0.75rem;
    color: var(--on-surface);
  }

  .mp-bars {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 6rem;
  }
  .mp-bar {
    position: relative;
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
    border-radius: 2px;
    background: var(--surface-container-low);
  }
  .mp-bar__fill {
    width: 100%;
    border-radius: 2px;
    background: var(--series-1);
  }
  .mp-bar__voice {
    position: absolute;
    left: 50%;
    bottom: -0.45rem;
    width: 4px;
    height: 4px;
    margin-left: -2px;
    border-radius: 999px;
    background: var(--series-2);
  }

  .mp-timeline {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding-left: 1.1rem;
  }
  .mp-timeline::before {
    content: '';
    position: absolute;
    left: 0.25rem;
    top: 0.4rem;
    bottom: 0.4rem;
    width: 1px;
    background: var(--outline-variant);
  }
  .mp-event {
    position: relative;
    display: flex;
    gap: 0.75rem;
  }
  .mp-event__dot {
    position: absolute;
    left: -1.1rem;
    top: 0.35rem;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    box-shadow: 0 0 0 3px var(--surface-container-lowest);
  }

  .mp-meter {
    height: 6px;
    border-radius: 999px;
    background: var(--surface-container-low);
    overflow: hidden;
  }
  .mp-meter span {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--success), var(--warning), var(--error));
  }
</style>
