<script lang="ts">
  import { fetchAdvancedAnalytics, updateChannelsManagementConfig, type AdvancedAnalyticsSection } from '../../api';
  import SectionCard from '../SectionCard.svelte';
  import Papicon from '../Papicon.svelte';
  import EmptyState from '../EmptyState.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { inviteDetailsModal } from '../../stores/inviteDetailsModal.svelte';
  import { m, dateLocale } from '../../i18n';

  import { errorMessage } from '@kotbo/shared';
  const { section, onOpenMember }: {
    section: AdvancedAnalyticsSection;
    /** Ouvre la fiche modération d'un membre (montée par la page parente). */
    onOpenMember?: (userId: string, name: string) => void;
  } = $props();

  let data: any = $state(null);
  /**
   * Section à laquelle `data` appartient. Indispensable : les $effect s'exécutent
   * après le rendu, donc le template voit d'abord la nouvelle `section` avec les
   * anciennes données. Sans cette garde, on lit des champs inexistants (crash).
   */
  let loadedSection: AdvancedAnalyticsSection | null = $state(null);
  let loading = $state(true);
  let error = $state('');
  let enablingWords = $state(false);

  const cache = new Map<string, any>();
  let requestId = 0;

  /** Les données affichables correspondent bien à la section demandée. */
  const ready = $derived(data !== null && loadedSection === section);

  async function load(s: AdvancedAnalyticsSection) {
    const id = ++requestId;

    if (cache.has(s)) {
      data = cache.get(s);
      loadedSection = s;
      error = '';
      loading = false;
      return;
    }

    loading = true; error = ''; data = null; loadedSection = null;
    try {
      const res = await fetchAdvancedAnalytics(s);
      cache.set(s, res);
      // Une navigation rapide peut faire arriver une réponse périmée : on l'ignore.
      if (id !== requestId) return;
      data = res;
      loadedSection = s;
    } catch (e) {
      if (id !== requestId) return;
      error = errorMessage(e) || m.an_adv_error_load();
    } finally {
      if (id === requestId) loading = false;
    }
  }

  $effect(() => { load(section); });

  function channelName(channelId: string): string {
    const c = dashboardStore.state.discordChannels?.find((ch: any) => ch.id === channelId);
    return c ? `#${c.name}` : `#${channelId.slice(-4)}`;
  }

  /** Nom sans le `#`, pour l'en-tête de la vue détaillée qui l'ajoute déjà. */
  function rawChannelName(channelId: string): string | null {
    return dashboardStore.state.discordChannels?.find((ch: any) => ch.id === channelId)?.name ?? null;
  }

  /**
   * Le service remplace un code d'invitation manquant par cette valeur : ouvrir
   * la vue détaillée dessus produirait un 404, on laisse la ligne inerte.
   */
  const UNKNOWN_INVITE_CODE = 'inconnu';

  function isKnownInvite(code: string | null | undefined): boolean {
    return !!code && code !== UNKNOWN_INVITE_CODE;
  }

  function openInvite(code: string) {
    if (!isKnownInvite(code)) return;
    inviteDetailsModal.show(code);
  }

  function openMember(userId: string | null | undefined, name: string | null | undefined) {
    if (!userId) return;
    onOpenMember?.(userId, name ?? userId);
  }

  function fmtDuration(seconds: number | null): string {
    if (seconds == null) return '-';
    if (seconds < 60) return m.an_adv_duration_seconds({ n: seconds });
    if (seconds < 3600) return m.an_adv_duration_minutes({ n: Math.round(seconds / 60) });
    if (seconds < 86400) return m.an_adv_duration_hours({ n: Math.round(seconds / 3600) });
    return m.an_adv_duration_days({ n: Math.round(seconds / 86400) });
  }

  function fmtHours(hours: number | null): string {
    if (hours == null) return '-';
    if (hours < 1) return m.an_adv_duration_under_hour();
    if (hours < 48) return m.an_adv_duration_hours({ n: hours });
    return m.an_adv_duration_days({ n: Math.round(hours / 24) });
  }

  function pctColor(pct: number): string {
    if (pct >= 70) return 'text-success';
    if (pct >= 40) return 'text-warning';
    return 'text-error';
  }

  function trendBadge(pct: number): { cls: string; label: string } {
    if (pct > 0) return { cls: 'text-success bg-success/10', label: `+${pct}%` };
    if (pct < 0) return { cls: 'text-error bg-error/10', label: `${pct}%` };
    return { cls: 'text-on-surface-variant bg-surface-container', label: '0%' };
  }

  async function enableWordStats() {
    enablingWords = true;
    try {
      const ok = await updateChannelsManagementConfig({ wordStatsEnabled: true });
      if (!ok) throw new Error();
      toast.success(m.an_adv_words_enabled_toast());
      cache.delete('words');
      await load('words');
    } catch {
      toast.error(m.an_adv_words_enable_error());
    } finally {
      enablingWords = false;
    }
  }

  const DOW_LABELS = $derived([
    m.an_adv_dow_mon(), m.an_adv_dow_tue(), m.an_adv_dow_wed(), m.an_adv_dow_thu(),
    m.an_adv_dow_fri(), m.an_adv_dow_sat(), m.an_adv_dow_sun(),
  ]);

  function heatColor(count: number, max: number): string {
    if (count === 0 || max === 0) return 'bg-surface-container';
    const ratio = count / max;
    if (ratio > 0.75) return 'bg-primary';
    if (ratio > 0.5) return 'bg-primary/70';
    if (ratio > 0.25) return 'bg-primary/40';
    return 'bg-primary/15';
  }
</script>

{#if loading}
  <div class="grid gap-4 grid-cols-1 md:grid-cols-2">
    {#each Array(4) as _}
      <div class="section-card p-5 space-y-3 animate-pulse">
        <div class="h-4 w-1/3 rounded bg-surface-container"></div>
        <div class="h-24 rounded bg-surface-container"></div>
      </div>
    {/each}
  </div>
{:else if error}
  <SectionCard title={m.an_adv_error_title()} icon="Warning">
    <EmptyState icon="warning" title={m.an_adv_error_section()} description={error} actionLabel={m.common_retry()} actionIcon="RefreshCw" onAction={() => load(section)} />
  </SectionCard>

<!-- ═══════════════ RÉTENTION ═══════════════ -->
{:else if section === 'retention' && ready}
  <div class="space-y-4">
    <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
      <SectionCard title={m.an_adv_returning_title()} description={m.an_adv_returning_desc()} icon="Refresh">
        <div class="flex items-baseline gap-2">
          <span class="text-4xl font-bold text-on-surface">{data.returningMembers}</span>
          <span class="text-sm text-on-surface-variant">{m.an_adv_returning_unit()}</span>
        </div>
      </SectionCard>
      <SectionCard title={m.an_adv_retention_source_title()} description={m.an_adv_retention_source_desc()} icon="MailOpen" flush>
        {#if data.retentionBySource.length === 0}
          <EmptyState icon="mailOpen" title={m.an_adv_retention_source_empty()} reason="accumulating" />
        {:else}
          <div class="divide-y divide-outline-variant/50">
            {#each data.retentionBySource as src}
              {@const clickable = isKnownInvite(src.inviteCode)}
              <button
                type="button"
                disabled={!clickable}
                onclick={() => openInvite(src.inviteCode)}
                class="w-full flex items-center justify-between px-5 py-2.5 text-sm text-left transition-colors {clickable ? 'hover:bg-surface-container-high/40' : 'cursor-default'}"
              >
                <div class="min-w-0">
                  <span class="font-mono text-xs text-on-surface">{src.inviteCode}</span>
                  {#if src.inviterTag}<span class="text-xs text-on-surface-variant ml-2">{m.an_adv_invited_by({ tag: src.inviterTag })}</span>{/if}
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-xs text-on-surface-variant">{m.an_adv_joined_count({ count: src.joined })}</span>
                  <span class="font-semibold {pctColor(src.retentionRate)}">{src.retentionRate}%</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </SectionCard>
    </div>

    <SectionCard title={m.an_adv_cohorts_title()} description={m.an_adv_cohorts_desc()} icon="UsersFour" flush>
      {#if data.cohorts.length === 0}
        <EmptyState icon="usersFour" title={m.an_adv_cohorts_empty()} description={m.an_adv_cohorts_empty_desc()} reason="accumulating" />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-on-surface-variant border-b border-outline-variant">
                <th class="px-5 py-3">{m.an_adv_col_week()}</th>
                <th class="px-3 py-3 text-right">{m.an_adv_col_joins()}</th>
                <th class="px-3 py-3 text-right">{m.an_adv_col_d1()}</th>
                <th class="px-3 py-3 text-right">{m.an_adv_col_d7()}</th>
                <th class="px-5 py-3 text-right">{m.an_adv_col_d30()}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/40">
              {#each data.cohorts as c}
                <tr>
                  <td class="px-5 py-2.5 font-mono text-xs text-on-surface">{c.week}</td>
                  <td class="px-3 py-2.5 text-right text-on-surface-variant">{c.joined}</td>
                  {#each [c.d1, c.d7, c.d30] as v, i}
                    <td class="px-3 py-2.5 text-right {i === 2 ? 'px-5' : ''}">
                      {#if v === null}
                        <span class="text-on-surface-variant/30">-</span>
                      {:else}
                        <span class="font-semibold {pctColor(v)}">{v}%</span>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </SectionCard>
  </div>

<!-- ═══════════════ ACTIVITÉ ═══════════════ -->
{:else if section === 'activity' && ready}
  <div class="space-y-4">
    <div class="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {#each [
        { label: m.an_adv_dau(), value: data.dau },
        { label: m.an_adv_wau(), value: data.wau },
        { label: m.an_adv_mau(), value: data.mau },
        { label: m.an_adv_stickiness(), value: `${data.stickiness}%` },
      ] as stat}
        <div class="section-card p-5">
          <p class="text-xs text-on-surface-variant font-semibold">{stat.label}</p>
          <p class="text-3xl font-bold text-on-surface mt-1.5">{stat.value}</p>
        </div>
      {/each}
    </div>

    <div class="grid gap-4 grid-cols-1 md:grid-cols-2">
      <SectionCard title={m.an_adv_comparison_title()} icon="Calendar" flush>
        <div class="divide-y divide-outline-variant/40">
          {#each [
            { label: m.an_adv_row_messages(), d: data.comparison.messages },
            { label: m.an_adv_row_voice_minutes(), d: data.comparison.voiceMinutes },
            { label: m.an_adv_row_joins(), d: data.comparison.joins },
            { label: m.an_adv_row_leaves(), d: data.comparison.leaves },
            { label: m.an_adv_row_reactions(), d: data.comparison.reactions },
            { label: m.an_adv_row_avg_active(), d: data.comparison.avgActiveMembers },
          ] as row}
            {@const badge = trendBadge(row.d.changePct)}
            <div class="flex items-center justify-between px-5 py-2.5 text-sm">
              <span class="text-on-surface-variant">{row.label}</span>
              <div class="flex items-center gap-3">
                <span class="text-on-surface font-medium">{row.d.current.toLocaleString(dateLocale())}</span>
                <span class="text-2xs font-bold px-2 py-0.5 rounded-md {badge.cls}">{badge.label}</span>
              </div>
            </div>
          {/each}
        </div>
      </SectionCard>

      <div class="space-y-4">
        <SectionCard title={m.an_adv_records_title()} icon="Fire" flush>
          <div class="divide-y divide-outline-variant/40">
            {#each [
              { label: m.an_adv_record_messages(), r: data.records.messages },
              { label: m.an_adv_record_voice(), r: data.records.peakVoice },
              { label: m.an_adv_record_online(), r: data.records.peakOnline },
            ] as row}
              <div class="flex items-center justify-between px-5 py-2.5 text-sm">
                <span class="text-on-surface-variant">{row.label}</span>
                {#if row.r}
                  <div class="flex items-center gap-3">
                    <span class="text-on-surface font-bold">{row.r.value.toLocaleString(dateLocale())}</span>
                    <span class="font-mono text-2xs text-on-surface-variant">{row.r.date}</span>
                  </div>
                {:else}
                  <span class="text-on-surface-variant/30">-</span>
                {/if}
              </div>
            {/each}
          </div>
        </SectionCard>

        <SectionCard title={m.an_adv_engagement_title()} icon="ChatBubbles">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <p class="text-2xl font-bold text-on-surface">{data.engagement.messagesPerActive}</p>
              <p class="text-xs text-on-surface-variant mt-0.5">{m.an_adv_messages_per_active()}</p>
            </div>
            <div>
              <p class="text-2xl font-bold text-on-surface">{data.engagement.voiceShare}%</p>
              <p class="text-xs text-on-surface-variant mt-0.5">{m.an_adv_voice_share()}</p>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  </div>

<!-- ═══════════════ CHURN ═══════════════ -->
{:else if section === 'churn' && ready}
  <div class="space-y-4">
    <div class="grid gap-4 grid-cols-1 md:grid-cols-2">
      <SectionCard title={m.an_adv_churn_tenure_title()} description={m.an_adv_churn_tenure_desc()} icon="TrendingUp">
        {@const total = (Object.values(data.churnByTenure) as number[]).reduce((s, v) => s + v, 0)}
        {#if total === 0}
          <EmptyState icon="usersFour" title={m.an_adv_churn_empty()} reason="all-clear" />
        {:else}
          <div class="space-y-3">
            {#each Object.entries(data.churnByTenure) as [bucket, count]}
              {@const pct = total > 0 ? Math.round(((count as number) / total) * 100) : 0}
              <div>
                <div class="flex justify-between text-xs mb-1">
                  <span class="text-on-surface-variant">{bucket === '<7j' ? m.an_adv_bucket_under_7d() : bucket === '7-30j' ? m.an_adv_bucket_7_30d() : bucket === '30-90j' ? m.an_adv_bucket_30_90d() : m.an_adv_bucket_over_90d()}</span>
                  <span class="text-on-surface font-medium">{count} ({pct}%)</span>
                </div>
                <div class="h-2 rounded-full bg-surface-container overflow-hidden">
                  <div class="h-full rounded-full {bucket === '<7j' ? 'bg-red-400' : bucket === '7-30j' ? 'bg-amber-500' : 'bg-primary/60'}" style="width: {pct}%"></div>
                </div>
              </div>
            {/each}
          </div>
          <p class="text-2xs text-on-surface-variant mt-3">{m.an_adv_churn_hint()}</p>
        {/if}
      </SectionCard>

      <SectionCard title={m.an_adv_onboarding_title()} description={m.an_adv_onboarding_desc()} icon="Sparkles">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-2xl font-bold text-on-surface">{fmtHours(data.onboarding.medianFirstMessageHours)}</p>
            <p class="text-xs text-on-surface-variant mt-0.5">{m.an_adv_first_message_delay()}</p>
          </div>
          <div>
            <p class="text-2xl font-bold {data.onboarding.completionRate != null ? pctColor(data.onboarding.completionRate) : 'text-on-surface'}">
              {data.onboarding.completionRate != null ? `${data.onboarding.completionRate}%` : '-'}
            </p>
            <p class="text-xs text-on-surface-variant mt-0.5">
              {m.an_adv_onboarding_completion({ done: data.onboarding.completed30d, total: data.onboarding.joined30d })}
            </p>
          </div>
        </div>
      </SectionCard>
    </div>

    <SectionCard title={m.an_adv_at_risk_title()} description={m.an_adv_at_risk_desc()} icon="Warning" flush>
      {#if data.atRisk.length === 0}
        <EmptyState icon="check" title={m.an_adv_at_risk_empty()} description={m.an_adv_at_risk_empty_desc()} reason="all-clear" />
      {:else}
        <div class="divide-y divide-outline-variant/40">
          {#each data.atRisk as member}
            <button
              type="button"
              onclick={() => openMember(member.userId, member.name)}
              class="w-full flex items-center justify-between px-5 py-2.5 text-left hover:bg-surface-container-high/40 transition-colors"
            >
              <div class="flex items-center gap-3 min-w-0">
                {#if member.avatarUrl}
                  <img src={member.avatarUrl} alt="" class="w-7 h-7 rounded-full shrink-0" />
                {:else}
                  <div class="w-7 h-7 rounded-full bg-surface-container shrink-0"></div>
                {/if}
                <span class="text-sm text-on-surface truncate">{member.name}</span>
              </div>
              <div class="flex items-center gap-4 text-xs shrink-0">
                <span class="text-on-surface-variant">{m.an_adv_active_days({ days: member.activeDays30 })}</span>
                <span class="text-warning font-medium">{m.an_adv_inactive_since({ date: member.lastActive })}</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </SectionCard>
  </div>

<!-- ═══════════════ CANAUX ═══════════════ -->
{:else if section === 'channels' && ready}
  <div class="space-y-4">
    <div class="grid gap-4 grid-cols-1 md:grid-cols-2">
      <SectionCard title={m.an_adv_channels_rising_title()} description={m.an_adv_channels_trend_desc()} icon="TrendingUp" flush>
        {#if data.trends.rising.length === 0}
          <EmptyState icon="chatBubbles" title={m.an_adv_channels_empty()} reason="accumulating" />
        {:else}
          <div class="divide-y divide-outline-variant/40">
            {#each data.trends.rising as t}
              {@const badge = trendBadge(t.changePct)}
              <button
                type="button"
                onclick={() => channelDetailsModal.show(t.channelId, rawChannelName(t.channelId))}
                class="w-full flex items-center justify-between px-5 py-2.5 text-sm text-left hover:bg-surface-container-high/40 transition-colors"
              >
                <span class="text-on-surface truncate">{channelName(t.channelId)}</span>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-xs text-on-surface-variant">{m.an_adv_unit_msg({ count: t.recent.toLocaleString(dateLocale()) })}</span>
                  <span class="text-2xs font-bold px-2 py-0.5 rounded-md {badge.cls}">{badge.label}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title={m.an_adv_channels_falling_title()} description={m.an_adv_channels_trend_desc()} icon="TrendingDown" flush>
        {#if data.trends.falling.length === 0}
          <EmptyState icon="chatBubbles" title={m.an_adv_channels_empty()} reason="accumulating" />
        {:else}
          <div class="divide-y divide-outline-variant/40">
            {#each data.trends.falling as t}
              {@const badge = trendBadge(t.changePct)}
              <button
                type="button"
                onclick={() => channelDetailsModal.show(t.channelId, rawChannelName(t.channelId))}
                class="w-full flex items-center justify-between px-5 py-2.5 text-sm text-left hover:bg-surface-container-high/40 transition-colors"
              >
                <span class="text-on-surface truncate">{channelName(t.channelId)}</span>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-xs text-on-surface-variant">{m.an_adv_unit_msg({ count: t.recent.toLocaleString(dateLocale()) })}</span>
                  <span class="text-2xs font-bold px-2 py-0.5 rounded-md {badge.cls}">{badge.label}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </SectionCard>
    </div>

    <SectionCard title={m.an_adv_coactivation_title()} description={m.an_adv_coactivation_desc()} icon="Compass" flush>
      {#if !data.coActivation.available}
        <EmptyState icon="lock" title={m.an_adv_logging_required()} description={m.an_adv_coactivation_locked_desc()} actionLabel={m.an_adv_logging_cta()} actionIcon="ArrowRight" actionHref="/channels-management" />
      {:else if data.coActivation.channels.length === 0}
        <EmptyState icon="compass" title={m.an_adv_coactivation_empty()} reason="accumulating" />
      {:else}
        <div class="overflow-x-auto p-5">
          <table class="text-2xs">
            <thead>
              <tr>
                <th class="p-1"></th>
                {#each data.coActivation.channels as c}
                  <th class="p-1 font-medium text-on-surface-variant max-w-16 truncate align-bottom" title={channelName(c)}>
                    <button
                      type="button"
                      onclick={() => channelDetailsModal.show(c, rawChannelName(c))}
                      class="block rotate-180 [writing-mode:vertical-rl] mx-auto max-h-24 truncate hover:text-primary transition-colors"
                    >{channelName(c)}</button>
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each data.coActivation.channels as rowC, i}
                {@const maxVal = Math.max(1, ...data.coActivation.matrix.flat())}
                <tr>
                  <td class="p-1 pr-2 font-medium whitespace-nowrap max-w-32 truncate">
                    <button
                      type="button"
                      onclick={() => channelDetailsModal.show(rowC, rawChannelName(rowC))}
                      class="text-on-surface-variant hover:text-primary transition-colors"
                      title={channelName(rowC)}
                    >{channelName(rowC)}</button>
                  </td>
                  {#each data.coActivation.channels as _, j}
                    {@const v = data.coActivation.matrix[i][j]}
                    <td class="p-0.5">
                      {#if i === j}
                        <div class="w-7 h-7 rounded bg-surface-container-low"></div>
                      {:else}
                        <div class="w-7 h-7 rounded flex items-center justify-center {heatColor(v, maxVal)} {v > maxVal * 0.5 ? 'text-on-primary' : 'text-on-surface-variant'}" title={m.an_adv_coactivation_cell({ a: channelName(rowC), b: channelName(data.coActivation.channels[j]), count: v })}>
                          {v > 0 ? v : ''}
                        </div>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </SectionCard>
  </div>

<!-- ═══════════════ SOCIAL ═══════════════ -->
{:else if section === 'social' && ready}
  {#if !data.available}
    <SectionCard title={m.an_adv_social_title()} icon="Users">
      <EmptyState icon="lock" title={m.an_adv_logging_required()} description={m.an_adv_social_locked_desc()} actionLabel={m.an_adv_logging_cta()} actionIcon="ArrowRight" actionHref="/channels-management" />
    </SectionCard>
  {:else}
    <div class="space-y-4">
      <div class="grid gap-4 grid-cols-1 md:grid-cols-3">
        <SectionCard title={m.an_adv_ping_title()} description={m.an_adv_ping_desc()} icon="Bell">
          <p class="text-3xl font-bold text-on-surface">{fmtDuration(data.pingReaction.medianSeconds)}</p>
          <p class="text-xs text-on-surface-variant mt-1">{m.an_adv_ping_samples({ count: data.pingReaction.samples.toLocaleString(dateLocale()) })}</p>
        </SectionCard>

        <div class="md:col-span-2">
          <SectionCard title={m.an_adv_centrality_title()} description={m.an_adv_centrality_desc()} icon="Users" flush>
            {#if data.centrality.length === 0}
              <EmptyState icon="users" title={m.an_adv_centrality_empty()} reason="accumulating" />
            {:else}
              <div class="divide-y divide-outline-variant/40">
                {#each data.centrality as member, i}
                  <button
                    type="button"
                    onclick={() => openMember(member.userId, member.name)}
                    class="w-full flex items-center justify-between px-5 py-2.5 text-left hover:bg-surface-container-high/40 transition-colors"
                  >
                    <div class="flex items-center gap-3 min-w-0">
                      <span class="text-2xs font-bold text-on-surface-variant/40 w-5">{i + 1}</span>
                      {#if member.avatarUrl}
                        <img src={member.avatarUrl} alt="" class="w-7 h-7 rounded-full shrink-0" />
                      {:else}
                        <div class="w-7 h-7 rounded-full bg-surface-container shrink-0"></div>
                      {/if}
                      <span class="text-sm text-on-surface truncate">{member.name}</span>
                    </div>
                    <div class="flex items-center gap-4 text-xs shrink-0 text-on-surface-variant">
                      <span class="flex items-center gap-1" title={m.an_adv_replies_received()}>
                        <Papicon icon="reply" size={13} />
                        {member.repliesReceived}
                      </span>
                      <span class="flex items-center gap-1" title={m.an_adv_mentions_received()}>@ {member.mentionsReceived}</span>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </SectionCard>
        </div>
      </div>
    </div>
  {/if}

<!-- ═══════════════ MOTS ═══════════════ -->
{:else if section === 'words' && ready}
  <SectionCard title={m.an_adv_words_title()} description={m.an_adv_words_desc()} icon="ChatCircleDots">
    {#if !data.enabled && data.topWords.length === 0}
      <EmptyState
        icon="chatCircleDots"
        title={m.an_adv_words_disabled()}
        description={data.messageLoggingEnabled
          ? m.an_adv_words_disabled_logged()
          : m.an_adv_words_disabled_unlogged()}
      >
        {#snippet action()}
          <button
            onclick={enableWordStats}
            disabled={enablingWords}
            class="bg-primary text-on-primary px-4 py-2 rounded-lg text-xs font-medium hover:brightness-110 transition-all disabled:opacity-50"
          >
            {enablingWords ? m.an_adv_words_enabling() : m.an_adv_words_enable()}
          </button>
        {/snippet}
      </EmptyState>
    {:else if data.backfill?.status === 'IN_PROGRESS'}
      {@const done = data.backfill.processedMessages ?? 0}
      {@const total = data.backfill.totalMessages ?? 0}
      {@const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0}
      <div class="py-10 px-6 text-center space-y-3">
        <p class="text-sm font-medium text-on-surface">{m.an_adv_backfill_title()}</p>
        <p class="text-body-sm text-on-surface-variant">
          {total > 0
            ? m.an_adv_backfill_progress_total({ done: done.toLocaleString(dateLocale()), total: total.toLocaleString(dateLocale()) })
            : m.an_adv_backfill_progress({ done: done.toLocaleString(dateLocale()) })}
        </p>
        {#if total > 0}
          <div class="h-2 max-w-sm mx-auto rounded-full bg-surface-container overflow-hidden">
            <div class="h-full rounded-full bg-primary transition-all duration-500" style="width: {pct}%"></div>
          </div>
        {/if}
        <p class="text-2xs text-on-surface-variant">{m.an_adv_backfill_hint()}</p>
      </div>
    {:else if data.backfill?.status === 'FAILED'}
      <EmptyState icon="warning" title={m.an_adv_backfill_failed()} description={data.backfill.error ?? m.an_adv_backfill_failed_desc()} reason="accumulating" />
    {:else if data.topWords.length === 0}
      <EmptyState
        icon="hourglass"
        title={m.an_adv_words_accumulating()}
        description={data.messageLoggingEnabled
          ? m.an_adv_words_accumulating_logged()
          : m.an_adv_words_accumulating_unlogged()} reason="accumulating" />
    {:else}
      {@const maxCount = data.topWords[0]?.count ?? 1}
      <div class="flex flex-wrap gap-2 items-baseline">
        {#each data.topWords as w}
          {@const scale = 0.75 + (w.count / maxCount) * 1.15}
          <span
            class="px-2.5 py-1 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors text-on-surface cursor-default"
            style="font-size: {scale}rem; opacity: {0.55 + (w.count / maxCount) * 0.45}"
            title={m.an_adv_word_occurrences({ count: w.count.toLocaleString(dateLocale()) })}
          >{w.word}</span>
        {/each}
      </div>
    {/if}
  </SectionCard>

<!-- ═══════════════ MODÉRATION ═══════════════ -->
{:else if section === 'moderation' && ready}
  <div class="space-y-4">
    <div class="grid gap-4 grid-cols-1 md:grid-cols-3">
      <SectionCard title={m.an_adv_recidivism_title()} icon="Gavel">
        <p class="text-3xl font-bold {data.recidivism.rate != null ? (data.recidivism.rate > 50 ? 'text-error' : data.recidivism.rate > 25 ? 'text-warning' : 'text-success') : 'text-on-surface'}">
          {data.recidivism.rate != null ? `${data.recidivism.rate}%` : '-'}
        </p>
        <p class="text-xs text-on-surface-variant mt-1">
          {m.an_adv_recidivism_detail({ recidivists: data.recidivism.recidivists, total: data.recidivism.firstWarned })}
          {#if data.recidivism.avgDaysToNext != null}{m.an_adv_recidivism_avg_days({ days: data.recidivism.avgDaysToNext })}{/if}
        </p>
      </SectionCard>

      <SectionCard title={m.an_adv_pressure_title()} description={m.an_adv_pressure_desc()} icon="Gavel">
        {#if data.pressure.length === 0}
          <EmptyState icon="gavel" title={m.an_adv_pressure_empty()} reason="accumulating" />
        {:else}
          {@const last = data.pressure.at(-1)}
          {@const maxP = Math.max(0.01, ...data.pressure.map((p: any) => p.per1000))}
          <p class="text-3xl font-bold text-on-surface">{last.per1000}</p>
          <p class="text-xs text-on-surface-variant mt-1 mb-3">{m.an_adv_pressure_current()}</p>
          <div class="flex items-end gap-1 h-12">
            {#each data.pressure as p}
              <div class="flex-1 bg-primary/50 rounded-t hover:bg-primary transition-colors" style="height: {Math.max(4, (p.per1000 / maxP) * 100)}%" title={m.an_adv_pressure_bar({ week: p.week, per1000: p.per1000, sanctions: p.sanctions })}></div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <SectionCard title={m.an_adv_bans_title()} description={m.an_adv_bans_desc()} icon="Trash">
        <p class="text-3xl font-bold text-on-surface">{data.cleanableBans}</p>
        <p class="text-xs text-on-surface-variant mt-1">{m.an_adv_bans_hint()}</p>
      </SectionCard>
    </div>

    <div class="grid gap-4 grid-cols-1 md:grid-cols-2">
      <SectionCard title={m.an_adv_mod_load_title()} description={m.an_adv_mod_load_desc()} icon="Users" flush>
        {#if data.moderatorLoad.length === 0}
          <EmptyState icon="users" title={m.an_adv_mod_load_empty()} reason="all-clear" />
        {:else}
          {@const maxLoad = data.moderatorLoad[0]?.count ?? 1}
          <div class="divide-y divide-outline-variant/40">
            {#each data.moderatorLoad as mod}
              <button
                type="button"
                onclick={() => openMember(mod.userId, mod.tag)}
                class="w-full px-5 py-2.5 text-left hover:bg-surface-container-high/40 transition-colors"
              >
                <div class="flex items-center justify-between text-sm mb-1">
                  <span class="text-on-surface truncate">{mod.tag ?? mod.userId}</span>
                  <span class="text-on-surface-variant text-xs">{mod.count}</span>
                </div>
                <div class="h-1.5 rounded-full bg-surface-container overflow-hidden">
                  <div class="h-full rounded-full bg-primary/60" style="width: {(mod.count / maxLoad) * 100}%"></div>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <div class="space-y-4">
        <SectionCard title={m.an_adv_account_age_title()} description={m.an_adv_account_age_desc()} icon="Clock">
          {@const totalAge = (Object.values(data.accountAgeBuckets) as number[]).reduce((s, v) => s + v, 0)}
          {#if totalAge === 0}
            <EmptyState icon="clock" title={m.an_adv_mod_load_empty()} reason="all-clear" />
          {:else}
            <div class="space-y-2.5">
              {#each Object.entries(data.accountAgeBuckets) as [bucket, count]}
                {@const pct = totalAge > 0 ? Math.round(((count as number) / totalAge) * 100) : 0}
                <div>
                  <div class="flex justify-between text-xs mb-1">
                    <span class="text-on-surface-variant">{m.an_adv_account_age_bucket({ bucket })}</span>
                    <span class="text-on-surface font-medium">{count} ({pct}%)</span>
                  </div>
                  <div class="h-2 rounded-full bg-surface-container overflow-hidden">
                    <div class="h-full rounded-full {bucket === '<30j' ? 'bg-red-400' : bucket === '30-180j' ? 'bg-amber-500' : 'bg-primary/60'}" style="width: {pct}%"></div>
                  </div>
                </div>
              {/each}
            </div>
            <p class="text-2xs text-on-surface-variant mt-3">{m.an_adv_account_age_hint()}</p>
          {/if}
        </SectionCard>

        <SectionCard title={m.an_adv_toxic_title()} description={m.an_adv_toxic_desc()} icon="Warning" flush>
          {#if data.toxicSources.length === 0}
            <EmptyState icon="check" title={m.an_adv_toxic_empty()} reason="all-clear" />
          {:else}
            <div class="divide-y divide-outline-variant/40">
              {#each data.toxicSources.filter((t: any) => t.sanctioned > 0) as t}
                {@const clickable = isKnownInvite(t.inviteCode)}
                <button
                  type="button"
                  disabled={!clickable}
                  onclick={() => openInvite(t.inviteCode)}
                  class="w-full flex items-center justify-between px-5 py-2.5 text-sm text-left transition-colors {clickable ? 'hover:bg-surface-container-high/40' : 'cursor-default'}"
                >
                  <span class="font-mono text-xs text-on-surface">{t.inviteCode}</span>
                  <div class="flex items-center gap-3 text-xs">
                    <span class="text-on-surface-variant">{m.an_adv_toxic_ratio({ sanctioned: t.sanctioned, invited: t.invited })}</span>
                    <span class="font-semibold {t.ratePct > 30 ? 'text-error' : t.ratePct > 10 ? 'text-warning' : 'text-on-surface-variant'}">{t.ratePct}%</span>
                  </div>
                </button>
              {:else}
                <EmptyState icon="check" title={m.an_adv_toxic_empty()} reason="all-clear" />
              {/each}
            </div>
          {/if}
        </SectionCard>
      </div>
    </div>

    <SectionCard title={m.an_adv_hot_hours_title()} description={m.an_adv_hot_hours_desc()} icon="Fire" flush>
      {@const maxHot = Math.max(1, ...data.hotHours.map((h: any) => h.count))}
      {@const hotMap = new Map<string, number>(data.hotHours.map((h: any) => [`${h.dow}-${h.hour}`, Number(h.count)]))}
      <div class="overflow-x-auto p-5">
        <div class="min-w-150">
          <div class="grid gap-0.5" style="grid-template-columns: 2.5rem repeat(24, 1fr)">
            <div></div>
            {#each Array(24) as _, h}
              <div class="text-center text-2xs text-on-surface-variant/40">{h}</div>
            {/each}
            {#each DOW_LABELS as day, d}
              <div class="text-2xs text-on-surface-variant flex items-center">{day}</div>
              {#each Array(24) as _, h}
                {@const v = hotMap.get(`${d + 1}-${h}`) ?? 0}
                <div class="aspect-square rounded-sm {heatColor(v, maxHot)}" title={m.an_adv_hot_hours_cell({ day, hour: h, count: v })}></div>
              {/each}
            {/each}
          </div>
        </div>
      </div>
    </SectionCard>
  </div>
{/if}
