<!--
  Vue détaillée d'une catégorie, présentée comme la fiche membre : tuiles qui
  pilotent la courbe (période précédente en pointillé), son poids dans le
  serveur, ses salons comparés et les membres qui la font vivre.
-->
<script lang="ts">
  import DetailSheet from '../DetailSheet.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, Callout, SectionCard } from '../ui';
  import BarList, { type BarListItem } from './BarList.svelte';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import TimeSeriesChart from './TimeSeriesChart.svelte';
  import { fetchCategoryDetail, type CategoryDetail } from '../../api';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { daysSince, fmtMinutes, fmtNumber, fmtPct, shortDate, SERIES } from './analyticsFormat';

  const {
    categoryId,
    categoryName,
    onClose,
    onOpenMember,
  }: {
    categoryId: string;
    categoryName: string;
    onClose: () => void;
    onOpenMember: (userId: string, name: string) => void;
  } = $props();

  type Tab = 'resume' | 'salons' | 'membres';
  type Metric = 'messages' | 'voice' | 'members';

  let open = $state(true);
  let detail = $state<CategoryDetail | null>(null);
  let loading = $state(true);
  let error = $state('');
  let activeTab = $state<Tab>('resume');
  let activeMetric = $state<Metric>('messages');

  $effect(() => {
    const query = filters.query;
    loading = true;
    error = '';
    fetchCategoryDetail(categoryId, query)
      .then((res) => (detail = res))
      .catch((e) => (error = errorMessage(e) || m.an_error_generic()))
      .finally(() => (loading = false));
  });

  function close() {
    open = false;
    onClose();
  }

  // Les fiches salon et membre sont montées avant cette modale : elle passerait
  // par-dessus. On la referme avant de les ouvrir.
  function openChannel(id: string, name: string) {
    close();
    channelDetailsModal.show(id, name);
  }

  function openMember(id: string, name: string) {
    close();
    onOpenMember(id, name);
  }

  const tabs = $derived([
    { id: 'resume', label: m.chd_tab_summary(), icon: 'Grid' },
    { id: 'salons', label: m.anx_category_channels_title(), icon: 'Hash' },
    { id: 'membres', label: m.anx_category_members_title(), icon: 'Users' },
  ]);

  const labels = $derived((detail?.series.current ?? []).map((d) => shortDate(d.dateKey)));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

  const metrics: MetricTab[] = $derived.by(() => {
    if (!detail) return [];
    const k = detail.kpis;
    const cur = detail.series.current;
    return [
      { id: 'messages', label: m.anx_kpi_messages(), value: fmtNumber(k.messages.value), delta: relativeDelta(k.messages.value, k.messages.previous), spark: cur.map((d) => d.messages), color: SERIES[0] },
      { id: 'voice', label: m.anx_kpi_voice(), value: fmtMinutes(k.voiceMinutes.value), delta: relativeDelta(k.voiceMinutes.value, k.voiceMinutes.previous), spark: cur.map((d) => d.voiceMinutes), color: SERIES[1] },
      { id: 'members', label: m.anx_kpi_active_members(), value: fmtNumber(k.activeMembers), hint: m.anx_category_active_hint(), spark: detail.daily.map((d) => d.textOnly + d.voiceOnly + d.both), color: SERIES[2] },
    ];
  });

  const chart = $derived.by(() => {
    if (!detail) return null;
    const { current, previous } = detail.series;
    if (activeMetric === 'members') {
      // Membres actifs : qui parle, qui est en vocal, qui fait les deux.
      return {
        mode: 'stacked' as const,
        stacks: [
          { label: m.anx_category_text_only(), values: detail.daily.map((d) => d.textOnly), color: SERIES[0]! },
          { label: m.anx_category_voice_only(), values: detail.daily.map((d) => d.voiceOnly), color: SERIES[1]! },
          { label: m.anx_category_both(), values: detail.daily.map((d) => d.both), color: SERIES[2]! },
        ],
        format: fmtNumber,
      };
    }
    const key = activeMetric === 'voice' ? 'voiceMinutes' : 'messages';
    return {
      mode: 'line' as const,
      main: { label: activeMetric === 'voice' ? m.anx_kpi_voice() : m.anx_kpi_messages(), color: activeMetric === 'voice' ? SERIES[1]! : SERIES[0]!, values: current.map((d) => d[key]) },
      previous: { label: m.anx_trend_previous(), values: previous.map((d) => d[key]) },
      format: activeMetric === 'voice' ? fmtMinutes : fmtNumber,
    };
  });

  function quiet(lastActiveDate: string | null): string | undefined {
    const days = daysSince(lastActiveDate);
    if (days === null) return m.anx_channel_never_active();
    return days >= 7 ? m.anx_channel_quiet({ days: String(days) }) : undefined;
  }

  const textChannels: BarListItem[] = $derived(
    (detail?.channels ?? []).filter((c) => c.kind !== 'voice').map((c) => ({
      id: c.id, label: `#${c.name}`, value: c.messages, sub: quiet(c.lastActiveDate),
    })),
  );

  const voiceChannels: BarListItem[] = $derived(
    (detail?.channels ?? []).filter((c) => c.kind === 'voice').map((c) => ({
      id: c.id, label: c.name, value: c.voiceMinutes, display: fmtMinutes(c.voiceMinutes),
    })),
  );

  type MemberItem = BarListItem & { avatarUrl: string | null };
  const memberItems: MemberItem[] = $derived(
    (detail?.topMembers ?? []).map((mb) => ({
      id: mb.userId,
      label: mb.name ?? mb.userId,
      value: mb.messages,
      display: m.anx_category_member_messages({ count: fmtNumber(mb.messages) }),
      sub: mb.voiceMinutes > 0 ? m.anx_category_member_voice({ time: fmtMinutes(mb.voiceMinutes) }) : undefined,
      avatarUrl: mb.avatarUrl,
    })),
  );
</script>

{#snippet members(items: MemberItem[])}
  <BarList {items} empty={m.anx_category_no_members()} onselect={(item) => openMember(item.id, item.label)}>
    {#snippet leading(item)}
      {#if item.avatarUrl}
        <img src={item.avatarUrl} alt="" width="28" height="28" class="h-7 w-7 shrink-0 rounded-full" loading="lazy" />
      {:else}
        <span class="h-7 w-7 shrink-0 rounded-full bg-surface-container"></span>
      {/if}
    {/snippet}
  </BarList>
{/snippet}

<DetailSheet
  {open}
  onClose={close}
  icon="Folder"
  title={detail?.name ?? categoryName}
  subtitle={m.anx_category_subtitle()}
  tabs={detail ? tabs : []}
  active={activeTab}
  onchange={(id) => (activeTab = id as Tab)}
>
  {#snippet badges()}
    {#if detail}<span class="badge badge-neutral">{m.anx_category_channels_title()} · {detail.channels.length}</span>{/if}
  {/snippet}
  {#snippet actions()}
    <Button size="sm" variant="ghost" icon="x" aria-label={m.chd_close()} onclick={close} />
  {/snippet}

  {#if loading && !detail}
    <div class="space-y-4" aria-busy="true">
      <div class="section-card h-28 animate-pulse"></div>
      <div class="section-card h-64 animate-pulse"></div>
    </div>
  {:else if error}
    <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
  {:else if detail}
    {@const k = detail.kpis}
    <div class="space-y-4" class:opacity-60={loading}>
      {#if detail.range.days > detail.voiceHistoryDays}
        <Callout variant="info">{m.anx_category_voice_history({ days: String(detail.voiceHistoryDays) })}</Callout>
      {/if}

      {#if activeTab === 'resume'}
        <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div class="min-w-0 space-y-4">
            <SectionCard title={m.anx_category_daily_title()} description={m.anx_category_daily_desc()}>
              <div class="space-y-3">
                <MetricTabs {metrics} active={activeMetric} onchange={(id) => (activeMetric = id as Metric)} compare={filters.compare} label={m.anx_category_daily_title()} />
                {#if chart}
                  <TimeSeriesChart {labels} mode={chart.mode} main={chart.main ?? null} previous={filters.compare ? chart.previous ?? null : null} stacks={chart.stacks ?? []} format={chart.format} height={220} />
                {/if}
              </div>
            </SectionCard>

            <SectionCard title={m.anx_category_members_title()}>
              {#snippet actions()}
                <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => (activeTab = 'membres')}>{m.anx_category_members_title()}</Button>
              {/snippet}
              {@render members(memberItems.slice(0, 5))}
            </SectionCard>
          </div>

          <div class="space-y-4">
            <section class="section-card p-5">
              <dl class="sheet-kpis" style="--kpis: 1">
                <div>
                  <dt><Papicon icon="pie-chart" size={13} />{m.anx_category_share()}</dt>
                  <dd>{fmtPct(k.messageShare.value)}</dd>
                  <span>{m.anx_category_share_hint({ voice: fmtPct(k.voiceShare) })}</span>
                </div>
              </dl>
            </section>
            <SectionCard title={m.anx_category_channels_title()}>
              {#snippet actions()}
                <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => (activeTab = 'salons')}>{fmtNumber(detail.channels.length)}</Button>
              {/snippet}
              <BarList items={textChannels.slice(0, 5)} empty={m.anx_category_no_text()} onselect={(item) => openChannel(item.id, item.label)} />
            </SectionCard>
          </div>
        </div>

      {:else if activeTab === 'salons'}
        <div class="grid gap-4 md:grid-cols-2">
          <SectionCard title={m.anx_category_channels_title()}>
            <BarList items={textChannels} empty={m.anx_category_no_text()} onselect={(item) => openChannel(item.id, item.label)} />
          </SectionCard>
          {#if voiceChannels.length > 0}
            <SectionCard title={m.anx_category_voice_channels()}>
              <BarList items={voiceChannels} color={SERIES[1]} onselect={(item) => openChannel(item.id, item.label)} />
            </SectionCard>
          {/if}
        </div>

      {:else if activeTab === 'membres'}
        <SectionCard title={m.anx_category_members_title()}>
          {@render members(memberItems)}
        </SectionCard>
      {/if}
    </div>
  {/if}
</DetailSheet>
