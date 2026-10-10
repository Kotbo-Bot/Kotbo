<!--
  Vue d'ensemble : la carte de courbe (messages, membres actifs, vocal,
  arrivées nettes), la présence en direct, les faits de la période et trois
  faits marquants qui mènent vers la section concernée.
-->
<script lang="ts">
  import { Button, Callout, SectionCard } from '../ui';
  import { untrack } from 'svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import ActivityChartCard from './ActivityChartCard.svelte';
  import LivePanel from './LivePanel.svelte';
  import { buildActivityMetrics } from './activityMetrics';
  import { analyticsAnnotations } from './annotations.svelte';
  import {
    fetchActivityAnalytics,
    fetchActivityBreakdown,
    fetchActivityHourly,
    fetchContentAnalytics,
    type ActivityAnalytics,
    type ContentAnalytics,
  } from '../../api';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters, pct } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, shortDate } from './analyticsFormat';

  const {
    onNavigate,
    legacy = null,
  }: {
    onNavigate: (tab: string) => void;
    /** Réponse de l'ancien /analytics : présence en direct et totaux de la période. */
    legacy?: any;
  } = $props();

  const live = $derived(legacy?.live ?? null);
  const totals = $derived(legacy?.totals ?? null);

  /** Jour où une mesure quotidienne a atteint son maximum. */
  function peakOf(key: 'peakOnline' | 'peakVoice'): { value: number; date: string | null } {
    let best: { value: number; date: string | null } = { value: 0, date: null };
    for (const d of legacy?.dailyTrend ?? []) {
      if ((d[key] ?? 0) > best.value) best = { value: d[key], date: d.dateKey };
    }
    return best;
  }

  const peakOnline = $derived(peakOf('peakOnline'));
  const peakVoice = $derived(peakOf('peakVoice'));

  let activity = $state<ActivityAnalytics | null>(null);
  let content = $state<ContentAnalytics | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const query = filters.query;
    const id = ++requestId;
    loading = true;
    error = '';
    Promise.all([fetchActivityAnalytics(query), fetchContentAnalytics(query).catch(() => null)])
      .then(([a, c]) => {
        if (id !== requestId) return;
        activity = a;
        content = c;
        analyticsExport.activity = a;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const k = $derived(activity?.kpis);
  const dates = $derived(activity?.series.map((d) => d.dateKey) ?? []);

  $effect(() => {
    const period = filters.periodQuery;
    untrack(() => analyticsAnnotations.load(period));
  });

  let activeMetric = $state('messages');
  const metrics = $derived(activity ? buildActivityMetrics(activity, ['messages', 'active', 'voice', 'net-joins']) : []);
  const hourlyPossible = $derived(filters.days <= 14 && !filters.channel && !filters.role && !filters.excludeStaff);

  const TYPE_KEYS: Array<[string, () => string]> = [
    ['typeImage', () => m.anx_type_image()], ['typeGif', () => m.anx_type_gif()], ['typeLink', () => m.anx_type_link()],
    ['typeVideo', () => m.anx_type_video()], ['typeSticker', () => m.anx_type_sticker()], ['typeForward', () => m.anx_type_forward()],
    ['typeVoice', () => m.anx_type_voice()],
  ];

  /** Le type (hors texte) dont la part a le plus progressé. */
  const risingType = $derived.by(() => {
    const t = content?.totals;
    const p = content?.previous;
    if (!t || !(t.messages > 0)) return null;
    let best: { label: string; share: number; delta: number | null } | null = null;
    for (const [key, label] of TYPE_KEYS) {
      const share = pct(t[key] ?? 0, t.messages);
      const delta = p && p.messages > 0 ? share - pct(p[key] ?? 0, p.messages) : null;
      const score = delta ?? share;
      if (!best || score > (best.delta ?? best.share)) best = { label: label(), share, delta };
    }
    return best;
  });

  const topEmoji = $derived(content?.emojis[0] ?? null);
  const topChannel = $derived(activity?.topChannels[0] ?? null);
</script>

{#if loading && !activity}
  <AnalyticsSkeleton />
{:else if error}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if activity && k}
  <div class="flex flex-col gap-4" aria-busy={loading}>
    <LivePanel compact />
    <ActivityChartCard
      {metrics}
      active={activeMetric}
      onchange={(id) => (activeMetric = id)}
      {dates}
      days={filters.days}
      compare={filters.compare}
      onToggleCompare={() => filters.toggleCompare()}
      {hourlyPossible}
      loadHourly={() => fetchActivityHourly(filters.query)}
      loadBreakdown={(metric, dimension) => fetchActivityBreakdown(filters.query, metric, dimension)}
      reloadKey={filters.key}
      anomalies={activity.anomalies ?? []}
      annotations={analyticsAnnotations.items}
      onAnnotate={(dateKey, label) => analyticsAnnotations.add(dateKey, label, filters.periodQuery)}
      onDeleteAnnotation={(id) => analyticsAnnotations.remove(id)}
      canDeleteAnnotation={(a) => analyticsAnnotations.canDelete(a)}
      busy={loading}
      forecastAllowed={!filters.isCustom}
    />

    {#if legacy}
      <div class="section-grid">
        {#if live}
          <div class="span-5">
            <SectionCard title={m.anx_live_title()} description={m.anx_live_desc()}>
              <dl class="fact-grid">
                <div><dt>{m.anx_live_online()}</dt><dd class="text-success">{fmtNumber(live.onlineMembers)}</dd></div>
                <div><dt>{m.anx_live_idle()}</dt><dd>{fmtNumber(live.idleMembers)}</dd></div>
                <div><dt>{m.anx_live_dnd()}</dt><dd>{fmtNumber(live.dndMembers)}</dd></div>
                <div><dt>{m.anx_live_voice()}</dt><dd>{fmtNumber(live.voiceConnected)}</dd></div>
                <div><dt>{m.anx_live_humans()}</dt><dd>{fmtNumber(live.humansCount)}</dd></div>
                <div><dt>{m.anx_live_bots()}</dt><dd>{fmtNumber(live.botsCount)}</dd></div>
                {#if k.memberCount !== null}
                  <div><dt>{filters.includeBots ? m.anx_kpi_members_with_bots() : m.anx_kpi_members()}</dt><dd>{fmtNumber(k.memberCount)}</dd></div>
                {/if}
              </dl>
            </SectionCard>
          </div>
        {/if}
        {#if totals}
          <div class={live ? 'span-7' : 'span-12'}>
            <SectionCard title={m.anx_period_facts_title()} description={m.anx_period_only_note()}>
              <dl class="fact-grid fact-grid--4">
                <div><dt>{m.anx_fact_active_days()}</dt><dd>{m.anx_fact_days({ count: fmtNumber(totals.activeDays) })}</dd></div>
                <div>
                  <dt>{m.anx_fact_sanctions()}</dt>
                  <dd><button type="button" class="fact-link" onclick={() => onNavigate('moderation')}>{fmtNumber(totals.sanctions)}</button></dd>
                </div>
                <div><dt>{m.anx_fact_retention()}</dt><dd>{fmtPct(totals.retentionRate ?? 0, 0)}</dd></div>
                <div><dt>{m.anx_fact_tenure()}</dt><dd>{m.anx_fact_days({ count: fmtNumber(Math.round(totals.avgTenureDays ?? 0)) })}</dd></div>
                <div><dt>{m.anx_fact_inactive()}</dt><dd>{fmtNumber(totals.inactiveMembers ?? 0)}</dd></div>
                <div>
                  <dt>{m.anx_fact_peak_online()}</dt>
                  <dd>{fmtNumber(peakOnline.value)}</dd>
                  {#if peakOnline.date}<span class="fact-sub">{shortDate(peakOnline.date)}</span>{/if}
                </div>
                <div>
                  <dt>{m.anx_fact_peak_voice()}</dt>
                  <dd>{fmtNumber(peakVoice.value)}</dd>
                  {#if peakVoice.date}<span class="fact-sub">{shortDate(peakVoice.date)}</span>{/if}
                </div>
                <div><dt>{m.anx_fact_trend()}</dt><dd class={(totals.messagesTrend ?? 0) >= 0 ? 'text-success' : 'text-error'}>{(totals.messagesTrend ?? 0) >= 0 ? '+' : '−'}{Math.abs(totals.messagesTrend ?? 0)} %</dd></div>
              </dl>
            </SectionCard>
          </div>
        {/if}
      </div>
    {/if}

    <div class="section-grid">
      <div class="span-4">
        <SectionCard>
          <div class="highlight">
            <span class="text-body-sm text-on-surface-variant">{m.anx_highlight_channel()}</span>
            <span class="highlight__title">{topChannel ? `#${topChannel.name ?? '?'}` : '—'}</span>
            {#if topChannel}
              <span class="text-body-sm text-on-surface-variant">{m.anx_highlight_channel_desc({ count: fmtNumber(topChannel.messages), share: fmtPct(pct(topChannel.messages, k.messages.value)) })}</span>
            {/if}
            <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => onNavigate('channels')}>{m.anx_highlight_channel_cta()}</Button>
          </div>
        </SectionCard>
      </div>
      <div class="span-4">
        <SectionCard>
          <div class="highlight">
            <span class="text-body-sm text-on-surface-variant">{m.anx_highlight_emoji()}</span>
            <span class="highlight__title flex items-center gap-2">
              {#if topEmoji?.imageUrl}
                <img src={topEmoji.imageUrl} alt="" width="28" height="28" class="h-7 w-7 object-contain" />
                <span>:{topEmoji.name ?? '?'}:</span>
              {:else}
                {topEmoji?.key ?? '—'}
              {/if}
            </span>
            {#if topEmoji}
              <span class="text-body-sm text-on-surface-variant">{m.anx_highlight_emoji_desc({ count: fmtNumber(topEmoji.count) })}</span>
            {/if}
            <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => onNavigate('emojis')}>{m.anx_highlight_content_cta()}</Button>
          </div>
        </SectionCard>
      </div>
      <div class="span-4">
        <SectionCard>
          <div class="highlight">
            <span class="text-body-sm text-on-surface-variant">{risingType?.delta !== null && filters.compare ? m.anx_highlight_type_rising() : m.anx_highlight_type_top()}</span>
            <span class="highlight__title">{risingType?.label ?? '—'}</span>
            {#if risingType}
              <span class="text-body-sm text-on-surface-variant">
                {m.anx_highlight_type_desc({ share: fmtPct(risingType.share) })}{#if risingType.delta !== null && filters.compare}, {risingType.delta >= 0 ? '+' : '−'}{m.anx_unit_points({ value: Math.abs(risingType.delta).toFixed(1).replace('.', ',') })}{/if}
              </span>
            {/if}
            <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => onNavigate('content')}>{m.anx_highlight_content_cta()}</Button>
          </div>
        </SectionCard>
      </div>
    </div>
  </div>
{/if}

<style>
  .highlight {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.375rem;
  }

  .highlight__title {
    font-family: var(--font-headline);
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .fact-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem 1.25rem;
    margin: 0;
  }

  .fact-grid--4 {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .fact-grid dt {
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .fact-grid dd {
    margin: 0.125rem 0 0;
    font-family: var(--font-headline);
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-on-surface);
    font-variant-numeric: tabular-nums;
  }

  .fact-grid dd.text-success {
    color: var(--color-success);
  }

  .fact-grid dd.text-error {
    color: var(--color-error);
  }

  .fact-sub {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .fact-link {
    border-radius: 0.25rem;
    color: inherit;
    text-decoration: underline;
    text-decoration-color: var(--color-outline);
    text-underline-offset: 3px;
  }

  .fact-link:hover {
    color: var(--color-primary);
  }

  @media (max-width: 767px) {
    .fact-grid,
    .fact-grid--4 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
