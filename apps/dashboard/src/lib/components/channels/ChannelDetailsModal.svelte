<script lang="ts">
  /**
   * Vue détaillée d'un salon, ouverte par `channelDetailsModal.show(id, name)`.
   * Montée une seule fois dans App.svelte : les listes de salons n'ont qu'à
   * appeler le store, sans gérer d'état local ni remonter d'événement.
   *
   * Même présentation que la fiche membre : chiffres en tuiles qui pilotent la
   * courbe, période précédente en pointillé, sections en cartes.
   */
  import { router } from 'tinro';
  import Papicon from '../Papicon.svelte';
  import DetailSheet from '../DetailSheet.svelte';
  import { Button, Callout, FilterPills, SectionCard, type FilterOption } from '../ui';
  import MetricTabs, { type MetricTab } from '../analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../analytics/TimeSeriesChart.svelte';
  import { fmtMinutes, fmtNumber, shortDate, SERIES } from '../analytics/analyticsFormat';
  import { relativeDelta } from '../analytics/analyticsFilters.svelte';
  import { memberAvatarSrc } from '../../discordMedia';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { fetchChannelDetails } from '../../api';
  import { m, dateLocale } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';

  type ChannelTab = 'resume' | 'activite' | 'membres' | 'contenu' | 'moderation' | 'config';
  type MetricKey = 'messages' | 'uniqueAuthors' | 'voiceMinutes';
  type DayRow = { dateKey: string; messages: number; uniqueAuthors: number; voiceMinutes: number };

  let details = $state<any>(null);
  let loading = $state(false);
  let error = $state('');
  let days = $state<'7' | '30' | '90'>('30');
  let activeTab = $state<ChannelTab>('resume');
  let activeMetric = $state<MetricKey>('messages');

  const isOpen = $derived(channelDetailsModal.open);
  const channelId = $derived(channelDetailsModal.channelId);
  const displayName = $derived(details?.channel?.name ?? channelDetailsModal.channelName ?? channelId ?? '');

  const typeIcon = $derived.by(() => {
    switch (details?.channel?.type) {
      case 'voice':
      case 'stage': return 'Mic';
      case 'forum': return 'ChatBubbles';
      case 'media': return 'Image';
      case 'announcement': return 'Megaphone';
      case 'thread': return 'GitBranch';
      default: return 'Hash';
    }
  });

  $effect(() => {
    if (!isOpen || !channelId) return;
    void days;
    void loadDetails();
  });

  $effect(() => {
    if (isOpen) return;
    details = null;
    error = '';
    loading = false;
    activeTab = 'resume';
  });

  async function loadDetails() {
    if (!channelId) return;
    loading = true;
    error = '';
    try {
      details = await fetchChannelDetails(channelId, { days: Number(days) });
    } catch (err) {
      error = errorMessage(err) || m.chd_load_error();
      details = null;
    } finally {
      loading = false;
    }
  }

  function closeModal() {
    channelDetailsModal.close();
  }

  function openMember(userId: string) {
    closeModal();
    router.goto(`/members/${userId}`);
  }

  function formatDate(value: string | Date | null | undefined) {
    if (!value) return m.chd_unknown();
    return new Date(value).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatDateTime(value: string | Date | null | undefined) {
    if (!value) return m.chd_unknown();
    return new Date(value).toLocaleString(dateLocale());
  }

  function truncate(text: string | null | undefined, max = 140) {
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  const HEALTH_STYLES: Record<string, { label: () => string; badge: string }> = {
    HEALTHY: { label: () => m.chd_health_healthy(), badge: 'badge-success' },
    OVERLOADED: { label: () => m.chd_health_overloaded(), badge: 'badge-warning' },
    UNDERUSED: { label: () => m.chd_health_underused(), badge: 'badge-warning' },
    DEAD: { label: () => m.chd_health_dead(), badge: 'badge-danger' },
    UNKNOWN: { label: () => m.chd_health_unknown(), badge: 'badge-neutral' },
  };
  const healthStyle = $derived(HEALTH_STYLES[details?.health?.status ?? 'UNKNOWN'] ?? HEALTH_STYLES.UNKNOWN);

  const tabs = $derived([
    { id: 'resume', label: m.chd_tab_summary(), icon: 'Grid' },
    { id: 'activite', label: m.chd_tab_activity(), icon: 'ChartLineUp' },
    { id: 'membres', label: m.chd_tab_people(), icon: 'Users' },
    { id: 'contenu', label: m.chd_tab_content(), icon: 'FileText' },
    { id: 'moderation', label: m.chd_tab_moderation(), icon: 'Gavel' },
    { id: 'config', label: m.chd_tab_config(), icon: 'Settings' },
  ]);

  const periodOptions: FilterOption<'7' | '30' | '90'>[] = $derived([
    { value: '7', label: m.chd_days_7() },
    { value: '30', label: m.chd_days_30() },
    { value: '90', label: m.chd_days_90() },
  ]);

  // ── Courbes : la période et celle d'avant, jour pour jour ──
  const daily = $derived<DayRow[]>(details?.activity?.daily ?? []);
  const previousDaily = $derived<DayRow[]>(details?.activity?.previousDaily ?? []);
  const labels = $derived(daily.map((d) => shortDate(d.dateKey)));

  const METRICS: Array<{ id: MetricKey; label: () => string; color: string; format: (v: number) => string; average?: boolean }> = [
    { id: 'messages', label: () => m.chd_metric_messages(), color: SERIES[0]!, format: fmtNumber },
    { id: 'uniqueAuthors', label: () => m.chd_metric_authors(), color: SERIES[1]!, format: fmtNumber, average: true },
    { id: 'voiceMinutes', label: () => m.chd_metric_voice(), color: SERIES[2]!, format: fmtMinutes },
  ];

  const metrics = $derived(METRICS.map((metric) => {
    const values = daily.map((d) => d[metric.id] ?? 0);
    const prev = previousDaily.map((d) => d[metric.id] ?? 0);
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    // Les auteurs se comptent par jour : la somme n'aurait pas de sens, la moyenne si.
    const total = metric.average ? sum(values) / Math.max(1, values.length) : sum(values);
    const prevTotal = metric.average ? sum(prev) / Math.max(1, prev.length) : sum(prev);
    return {
      ...metric,
      label: metric.label(),
      value: metric.format(Math.round(total * 10) / 10),
      delta: prev.length ? relativeDelta(total, prevTotal) : null,
      spark: values,
      daily: values,
      prevDaily: prev,
    };
  }));
  const metricTabs: MetricTab[] = $derived(metrics.map(({ id, label, value, delta, spark, color }) => ({ id, label, value, delta, spark, color })));
  const selected = $derived(metrics.find((metric) => metric.id === activeMetric) ?? metrics[0]);
  const hasActivity = $derived(daily.some((d) => d.messages > 0 || d.voiceMinutes > 0));

  const heatmapMax = $derived.by(() => {
    const matrix: number[][] = details?.heatmap?.matrix ?? [];
    let max = 0;
    for (const row of matrix) for (const v of row) if (v > max) max = v;
    return max;
  });

  const dayNames = $derived([
    m.chd_day_mon(), m.chd_day_tue(), m.chd_day_wed(),
    m.chd_day_thu(), m.chd_day_fri(), m.chd_day_sat(), m.chd_day_sun(),
  ]);

  function heatCellStyle(value: number) {
    // `--primary-color` et non `--color-primary` : color-mix a besoin d'une
    // couleur résolue, c'est le jeton de base du thème.
    if (heatmapMax <= 0 || value <= 0) {
      return 'background: color-mix(in srgb, var(--outline-variant) 25%, transparent)';
    }
    const intensity = Math.max(0.12, value / heatmapMax);
    return `background: color-mix(in srgb, var(--primary-color) ${Math.round(intensity * 85)}%, transparent)`;
  }
</script>

{#snippet facts(rows: Array<{ label: string; value: string; tone?: string }>)}
  <dl class="sheet-facts">
    {#each rows as row (row.label)}
      <div><dt>{row.label}</dt><dd class={row.tone ?? ''}>{row.value}</dd></div>
    {/each}
  </dl>
{/snippet}

{#snippet empty(text: string)}
  <p class="py-6 text-center text-sm text-on-surface-variant">{text}</p>
{/snippet}

{#snippet contributorRows(items: any[])}
  <ul class="divide-y divide-outline-variant">
    {#each items as person, index (person.userId)}
      <li>
        <button type="button" class="sheet-row" onclick={() => openMember(person.userId)}>
          <span class="w-5 shrink-0 text-xs tabular-nums text-on-surface-variant">{index + 1}</span>
          <img src={memberAvatarSrc(person.avatarUrl, person.userTag, person.userId)} alt="" class="h-8 w-8 shrink-0 rounded-lg object-cover" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center justify-between gap-3 text-sm">
              <span class="truncate font-medium text-on-surface">{person.userTag}</span>
              <span class="shrink-0 tabular-nums text-on-surface-variant">{fmtNumber(person.messages)} · {person.sharePct} %</span>
            </span>
            <span class="sheet-bar"><span style="width: {Math.min(100, person.sharePct)}%"></span></span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

<DetailSheet
  open={isOpen}
  onClose={closeModal}
  icon={typeIcon}
  title={`#${displayName}`}
  subtitle={details?.channel?.categoryName ? m.chd_subtitle_with_category({ category: details.channel.categoryName }) : m.chd_subtitle()}
  tabs={details && !error ? tabs : []}
  active={activeTab}
  onchange={(id) => (activeTab = id as ChannelTab)}
>
  {#snippet badges()}
    {#if details}
      <span class="badge {healthStyle.badge}">{healthStyle.label()}</span>
      {#if details.channel?.isPrivate}<span class="badge badge-warning"><Papicon icon="lock" size={11} />{m.chd_private()}</span>{/if}
    {/if}
  {/snippet}
  {#snippet actions()}
    <FilterPills label={m.chd_trend_title()} options={periodOptions} value={days} onchange={(value) => (days = value)} />
    <Button size="sm" variant="ghost" icon="x" aria-label={m.chd_close()} onclick={closeModal} />
  {/snippet}

  {#if loading && !details}
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]" aria-busy="true">
      <div class="space-y-4">
        <div class="section-card h-28 animate-pulse"></div>
        <div class="section-card h-64 animate-pulse"></div>
      </div>
      <div class="section-card h-80 animate-pulse"></div>
    </div>
  {:else if error}
    <Callout variant="danger" title={m.chd_load_error()}>{error}</Callout>
  {:else if details}
    <div class="space-y-4" class:opacity-60={loading}>
      {#if !details.channel}
        <Callout variant="warning">{m.chd_channel_gone()}</Callout>
      {/if}

      <!-- ══════════════ RÉSUMÉ ══════════════ -->
      {#if activeTab === 'resume'}
        <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div class="min-w-0 space-y-4">
            <SectionCard title={m.chd_trend_title()} description={m.chd_trend_subtitle({ days: details.period })}>
              {#snippet actions()}
                {#if details.activity.totals.peakDateKey}
                  <span class="badge badge-warning">{m.chd_peak({ date: formatDate(details.activity.totals.peakDateKey), count: details.activity.totals.peakMessages })}</span>
                {/if}
              {/snippet}
              {#if hasActivity && selected}
                <div class="space-y-3">
                  <MetricTabs metrics={metricTabs} active={selected.id} onchange={(id) => (activeMetric = id as MetricKey)} compare label={m.chd_trend_title()} />
                  <TimeSeriesChart
                    {labels}
                    mode="line"
                    main={{ label: selected.label, color: selected.color, values: selected.daily }}
                    previous={selected.prevDaily.length ? { label: m.anx_trend_previous(), values: selected.prevDaily } : null}
                    format={selected.format}
                    height={220}
                  />
                </div>
              {:else}
                {@render empty(m.chd_no_data())}
              {/if}
            </SectionCard>

            <section class="section-card p-5">
              <dl class="sheet-kpis">
                <div>
                  <dt><Papicon icon="pie-chart" size={13} />{m.chd_kpi_share()}</dt>
                  <dd>{details.activity.share.messagesPct} %</dd>
                  <span>{details.activity.share.rank ? m.chd_kpi_rank({ rank: details.activity.share.rank, total: details.activity.share.channelCount }) : '–'}</span>
                </div>
                <div>
                  <dt><Papicon icon="calendar" size={13} />{m.chd_kpi_active_days()}</dt>
                  <dd>{details.activity.totals.activeDays}<span class="inline text-sm">/{details.period}</span></dd>
                  <span>{m.chd_kpi_avg_per_day({ value: details.activity.totals.avgMessagesPerDay })}</span>
                </div>
                <div>
                  <dt><Papicon icon="users" size={13} />{m.chd_kpi_authors()}</dt>
                  <dd>{details.activity.totals.uniqueAuthorsAvg}</dd>
                  <span>{m.chd_kpi_authors_hint()}</span>
                </div>
                <div>
                  <dt><Papicon icon="mic" size={13} />{m.chd_kpi_voice()}</dt>
                  <dd>{fmtMinutes(details.activity.totals.voiceMinutes)}</dd>
                  <span>{details.activity.share.voicePct} %</span>
                </div>
              </dl>
            </section>

            <SectionCard title={m.chd_top_contributors()} flush>
              {#snippet actions()}
                <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => (activeTab = 'membres')}>{m.chd_tab_people()}</Button>
              {/snippet}
              {#if details.contributors.available && details.contributors.items.length > 0}
                {@render contributorRows(details.contributors.items.slice(0, 5))}
              {:else}
                {@render empty(details.contributors.available ? m.chd_no_data() : m.chd_logging_required())}
              {/if}
            </SectionCard>
          </div>

          <div class="space-y-4">
            <SectionCard title={m.chd_health_title()} description={details.health.configured ? m.chd_health_configured() : m.chd_health_not_configured()}>
              {@render facts([
                { label: m.chd_health_msg_day(), value: String(details.health.metrics.avgMsgPerDay) },
                { label: m.chd_health_msg_hour(), value: String(details.health.metrics.avgMsgPerHour) },
                { label: m.chd_health_authors(), value: String(details.health.metrics.uniqueAuthorsAvg) },
              ])}
              {#if details.health.excluded}
                <p class="mt-3 text-xs text-warning">{m.chd_health_excluded()}</p>
              {/if}
            </SectionCard>

            <SectionCard title={m.chd_quick_meta()}>
              {@render facts([
                { label: m.chd_meta_category(), value: details.channel?.categoryName ?? '–' },
                { label: m.chd_meta_created(), value: formatDate(details.channel?.createdAt) },
                { label: m.chd_meta_slowmode(), value: details.channel?.rateLimitPerUser ? m.chd_seconds({ value: details.channel.rateLimitPerUser }) : m.chd_none() },
                { label: m.chd_meta_visibility(), value: details.channel?.isPrivate ? m.chd_private() : m.chd_public(), tone: details.channel?.isPrivate ? 'text-warning' : '' },
                { label: m.chd_meta_threads(), value: String(details.content.threads.length) },
                { label: m.chd_meta_pinned(), value: String(details.content.pinned.length) },
              ])}
            </SectionCard>
          </div>
        </div>

      <!-- ══════════════ ACTIVITÉ ══════════════ -->
      {:else if activeTab === 'activite'}
        {#if hasActivity}
          <div class="grid gap-4 lg:grid-cols-3">
            {#each metrics as metric (metric.id)}
              <SectionCard title={metric.label} description={m.chd_trend_subtitle({ days: details.period })}>
                {#snippet actions()}
                  <span class="text-right">
                    <span class="block text-lg font-semibold tabular-nums text-on-surface">{metric.value}</span>
                    {#if metric.delta !== null && metric.delta !== undefined}
                      <span class="block text-xs {metric.delta >= 0 ? 'text-success' : 'text-error'}">{metric.delta >= 0 ? '+' : ''}{Math.round(metric.delta)} %</span>
                    {/if}
                  </span>
                {/snippet}
                <TimeSeriesChart
                  {labels}
                  mode="line"
                  main={{ label: metric.label, color: metric.color, values: metric.daily }}
                  previous={metric.prevDaily.length ? { label: m.anx_trend_previous(), values: metric.prevDaily } : null}
                  format={metric.format}
                  height={180}
                />
              </SectionCard>
            {/each}
          </div>
        {/if}

        <SectionCard title={m.chd_heatmap_title()} description={m.chd_heatmap_subtitle()}>
          {#snippet actions()}
            {#if details.heatmap.available && details.heatmap.peak}
              <span class="badge badge-warning">
                {m.chd_heatmap_peak({ day: dayNames[details.heatmap.peak.day], hour: String(details.heatmap.peak.hour).padStart(2, '0'), count: details.heatmap.peak.count })}
              </span>
            {/if}
          {/snippet}
          {#if details.heatmap.available && heatmapMax > 0}
            <div class="overflow-x-auto">
              <div class="min-w-140 space-y-1">
                <div class="flex items-center gap-1 pl-10">
                  {#each Array.from({ length: 24 }, (_, h) => h) as hour (hour)}
                    <div class="flex-1 text-center">
                      {#if hour % 3 === 0}<span class="text-2xs text-on-surface-variant">{String(hour).padStart(2, '0')}</span>{/if}
                    </div>
                  {/each}
                </div>
                {#each details.heatmap.matrix as row, day (day)}
                  <div class="flex items-center gap-1">
                    <span class="w-10 pr-1 text-right text-2xs text-on-surface-variant">{dayNames[day]}</span>
                    {#each row as value, hour (hour)}
                      <div class="aspect-square flex-1 rounded" style={heatCellStyle(value)} title={m.chd_heatmap_cell({ day: dayNames[day], hour: String(hour).padStart(2, '0'), count: value })}></div>
                    {/each}
                  </div>
                {/each}
              </div>
            </div>
          {:else}
            {@render empty(details.heatmap.available ? m.chd_no_data() : m.chd_logging_required())}
          {/if}
        </SectionCard>

        <SectionCard title={m.chd_daily_table()} flush>
          <div class="max-h-80 overflow-y-auto">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">{m.chd_col_date()}</th>
                  <th scope="col" class="num">{m.chd_metric_messages()}</th>
                  <th scope="col" class="num">{m.chd_metric_authors()}</th>
                  <th scope="col" class="num">{m.chd_metric_voice()}</th>
                </tr>
              </thead>
              <tbody>
                {#each [...daily].reverse() as row (row.dateKey)}
                  <tr>
                    <th scope="row">{formatDate(row.dateKey)}</th>
                    <td class="num">{fmtNumber(row.messages)}</td>
                    <td class="num">{fmtNumber(row.uniqueAuthors)}</td>
                    <td class="num">{fmtMinutes(row.voiceMinutes)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </SectionCard>

      <!-- ══════════════ MEMBRES ══════════════ -->
      {:else if activeTab === 'membres'}
        <SectionCard title={m.chd_top_contributors()} description={m.chd_click_to_open_member()} flush>
          {#snippet actions()}
            <span class="badge badge-neutral">{m.chd_logged_messages({ count: details.contributors.total })}</span>
          {/snippet}
          {#if details.contributors.available && details.contributors.items.length > 0}
            {@render contributorRows(details.contributors.items)}
          {:else}
            {@render empty(details.contributors.available ? m.chd_no_data() : m.chd_logging_required())}
          {/if}
        </SectionCard>

      <!-- ══════════════ CONTENU ══════════════ -->
      {:else if activeTab === 'contenu'}
        <section class="section-card p-5">
          <dl class="sheet-kpis" style="--kpis: 3">
            <div><dt><Papicon icon="paperclip" size={13} />{m.chd_counter_attachments()}</dt><dd>{fmtNumber(details.content.counters.attachments)}</dd></div>
            <div><dt><Papicon icon="corner-up-left" size={13} />{m.chd_counter_replies()}</dt><dd>{fmtNumber(details.content.counters.replies)}</dd></div>
            <div><dt><Papicon icon="cpu" size={13} />{m.chd_counter_bots()}</dt><dd>{fmtNumber(details.content.counters.botMessages)}</dd></div>
          </dl>
        </section>

        <div class="grid gap-4 md:grid-cols-2">
          <SectionCard title={m.chd_pinned_title()} flush>
            {#if details.content.pinned.length > 0}
              <ul class="max-h-80 divide-y divide-outline-variant overflow-y-auto">
                {#each details.content.pinned as pin, i (i)}
                  <li class="px-5 py-3">
                    <p class="text-xs text-on-surface-variant">{pin.authorName} · {formatDateTime(pin.createdAt)}</p>
                    <p class="mt-1 text-sm text-on-surface wrap-break-word">{truncate(pin.content) || m.chd_empty_message()}</p>
                  </li>
                {/each}
              </ul>
            {:else}
              {@render empty(m.chd_no_pinned())}
            {/if}
          </SectionCard>

          <SectionCard title={m.chd_threads_title()} flush>
            {#if details.content.threads.length > 0}
              <ul class="max-h-80 divide-y divide-outline-variant overflow-y-auto">
                {#each details.content.threads as thread, i (i)}
                  <li class="flex items-center justify-between gap-3 px-5 py-3">
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium text-on-surface">{thread.name}</span>
                      <span class="block text-xs text-on-surface-variant">{m.chd_thread_stats({ messages: thread.messageCount ?? 0, members: thread.memberCount ?? 0 })}</span>
                    </span>
                    {#if thread.locked}
                      <span class="badge badge-danger">{m.chd_thread_locked()}</span>
                    {:else if thread.archived}
                      <span class="badge badge-neutral">{m.chd_thread_archived()}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              {@render empty(m.chd_no_threads())}
            {/if}
          </SectionCard>
        </div>

        <SectionCard title={m.chd_recent_messages()} flush>
          {#if details.content.logging.available && details.content.recentMessages.length > 0}
            <ul class="max-h-96 divide-y divide-outline-variant overflow-y-auto">
              {#each details.content.recentMessages as msg, i (i)}
                <li class="px-5 py-3">
                  <div class="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                    <img src={memberAvatarSrc(msg.authorAvatar, msg.authorName, msg.authorId)} alt="" class="h-5 w-5 rounded-md object-cover" />
                    <span class="font-medium text-on-surface">{msg.authorName}</span>
                    {#if msg.isBot}<span class="badge badge-info">BOT</span>{/if}
                    <span>{formatDateTime(msg.createdAt)}</span>
                    {#if msg.editedAt}<span class="text-warning">{m.chd_edited()}</span>{/if}
                  </div>
                  <p class="mt-1 text-sm text-on-surface wrap-break-word">{truncate(msg.content, 240) || m.chd_empty_message()}</p>
                  {#if msg.hasAttachment || msg.embedCount > 0}
                    <p class="mt-1 text-xs text-primary">{m.chd_has_media()}</p>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            {@render empty(details.content.logging.available ? m.chd_no_data() : m.chd_logging_required())}
          {/if}
        </SectionCard>

        {#if details.content.links.length > 0}
          <SectionCard title={m.chd_links_title()} flush>
            <ul class="divide-y divide-outline-variant">
              {#each details.content.links as link, i (i)}
                <li class="flex items-center justify-between gap-3 px-5 py-3">
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium text-on-surface">{link.otherGuildName ?? link.otherGuildId} · #{link.otherChannelName ?? link.otherChannelId}</span>
                    <span class="block text-xs text-on-surface-variant">{link.direction}</span>
                  </span>
                  <span class="badge {link.enabled ? 'badge-success' : 'badge-neutral'}">{link.enabled ? m.chd_link_enabled() : m.chd_link_disabled()}</span>
                </li>
              {/each}
            </ul>
          </SectionCard>
        {/if}

      <!-- ══════════════ MODÉRATION ══════════════ -->
      {:else if activeTab === 'moderation'}
        {#if !details.moderation.available}
          <SectionCard>{@render empty(m.chd_logging_required())}</SectionCard>
        {:else}
          <section class="section-card p-5">
            <dl class="sheet-kpis" style="--kpis: 2">
              <div><dt><Papicon icon="trash" size={13} />{m.chd_deleted_messages()}</dt><dd class="text-error">{fmtNumber(details.moderation.deleted)}</dd></div>
              <div><dt><Papicon icon="edit" size={13} />{m.chd_edited_messages()}</dt><dd>{fmtNumber(details.moderation.edited)}</dd></div>
            </dl>
          </section>

          <div class="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
            <SectionCard title={m.chd_top_deleted()} flush>
              {#if details.moderation.topDeleted.length > 0}
                <ul class="divide-y divide-outline-variant">
                  {#each details.moderation.topDeleted as row (row.userId)}
                    <li>
                      <button type="button" class="sheet-row justify-between" onclick={() => openMember(row.userId)}>
                        <span class="truncate text-sm text-on-surface">{row.userTag}</span>
                        <span class="text-sm tabular-nums text-error">{row.count}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else}
                {@render empty(m.chd_no_deleted())}
              {/if}
            </SectionCard>

            <SectionCard title={m.chd_recent_deleted()} flush>
              {#if details.moderation.recentDeleted.length > 0}
                <ul class="max-h-96 divide-y divide-outline-variant overflow-y-auto">
                  {#each details.moderation.recentDeleted as msg, i (i)}
                    <li class="px-5 py-3">
                      <div class="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                        <img src={memberAvatarSrc(msg.authorAvatar, msg.authorName, msg.authorId)} alt="" class="h-5 w-5 rounded-md object-cover" />
                        <span class="font-medium text-on-surface">{msg.authorName}</span>
                        <span>{m.chd_deleted_at({ date: formatDateTime(msg.deletedAt) })}</span>
                      </div>
                      <p class="mt-1 text-sm text-on-surface wrap-break-word">{truncate(msg.content, 240) || m.chd_empty_message()}</p>
                    </li>
                  {/each}
                </ul>
              {:else}
                {@render empty(m.chd_no_deleted())}
              {/if}
            </SectionCard>
          </div>
        {/if}

        {#if details.health.alerts.length > 0}
          <SectionCard title={m.chd_health_alerts()} flush>
            <ul class="divide-y divide-outline-variant">
              {#each details.health.alerts as alert, i (i)}
                <li class="px-5 py-3">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-sm font-medium text-on-surface">{alert.type}</span>
                    <span class="badge badge-neutral">{alert.status}</span>
                  </div>
                  <p class="mt-1 text-xs text-on-surface-variant">{alert.reason ?? '–'}</p>
                  <p class="mt-1 text-xs text-on-surface-variant">{formatDateTime(alert.createdAt)} · {m.chd_confidence({ value: alert.confidence })}</p>
                </li>
              {/each}
            </ul>
          </SectionCard>
        {/if}

      <!-- ══════════════ CONFIG ══════════════ -->
      {:else if activeTab === 'config'}
        <div class="grid gap-4 md:grid-cols-2">
          <SectionCard title={m.chd_config_title()}>
            {@render facts([
              { label: m.chd_meta_id(), value: details.channelId },
              { label: m.chd_meta_type(), value: details.channel?.type ?? '–' },
              { label: m.chd_meta_category(), value: details.channel?.categoryName ?? '–' },
              { label: m.chd_meta_position(), value: String(details.channel?.position ?? '–') },
              { label: m.chd_meta_created(), value: formatDate(details.channel?.createdAt) },
              { label: m.chd_meta_slowmode(), value: details.channel?.rateLimitPerUser ? m.chd_seconds({ value: details.channel.rateLimitPerUser }) : m.chd_none() },
              { label: m.chd_meta_nsfw(), value: details.channel?.nsfw ? m.chd_yes() : m.chd_no(), tone: details.channel?.nsfw ? 'text-error' : '' },
              ...(details.channel?.bitrate ? [
                { label: m.chd_meta_bitrate(), value: `${Math.round(details.channel.bitrate / 1000)} kbps` },
                { label: m.chd_meta_user_limit(), value: details.channel.userLimit ? String(details.channel.userLimit) : m.chd_unlimited() },
              ] : []),
            ])}
            {#if details.channel?.topic}
              <p class="mt-4 text-xs text-on-surface-variant">{m.chd_meta_topic()}</p>
              <p class="mt-1 text-sm text-on-surface wrap-break-word">{details.channel.topic}</p>
            {/if}
          </SectionCard>

          <SectionCard title={m.chd_permissions_title()} flush>
            {#if (details.channel?.roleOverwrites?.length ?? 0) > 0}
              <ul class="max-h-80 divide-y divide-outline-variant overflow-y-auto">
                {#each details.channel.roleOverwrites as overwrite, i (i)}
                  <li class="flex items-center justify-between gap-3 px-5 py-2.5">
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="h-2 w-2 shrink-0 rounded-full" style="background: {overwrite.color ?? 'var(--primary-color)'}"></span>
                      <span class="truncate text-sm text-on-surface">{overwrite.isEveryone ? '@everyone' : overwrite.name}</span>
                    </span>
                    <span class="shrink-0 text-xs tabular-nums">
                      <span class="text-success">+{overwrite.allow}</span>
                      <span class="mx-1 text-on-surface-variant">/</span>
                      <span class="text-error">−{overwrite.deny}</span>
                    </span>
                  </li>
                {/each}
              </ul>
            {:else}
              {@render empty(m.chd_no_overwrites())}
            {/if}
          </SectionCard>
        </div>

        <SectionCard title={m.chd_audit_title()} description={m.chd_audit_subtitle()} flush>
          {#if details.auditTrail.length > 0}
            <ul class="max-h-80 divide-y divide-outline-variant overflow-y-auto">
              {#each details.auditTrail as event, i (i)}
                <li class="px-5 py-3">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-sm font-medium text-on-surface">{event.eventType}</span>
                    <span class="text-xs text-on-surface-variant">{formatDateTime(event.createdAt)}</span>
                  </div>
                  <p class="mt-1 text-xs text-on-surface-variant">
                    {m.chd_audit_by({ author: event.executorName ?? m.chd_unknown() })}{#if event.changedFields?.length} · {event.changedFields.join(', ')}{/if}
                  </p>
                </li>
              {/each}
            </ul>
          {:else}
            {@render empty(m.chd_no_audit())}
          {/if}
        </SectionCard>
      {/if}
    </div>
  {/if}
</DetailSheet>
