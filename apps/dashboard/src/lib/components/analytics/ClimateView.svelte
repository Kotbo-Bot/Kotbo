<!--
  Climat (Kotbo × AegisAI) : toxicité et émotions des échanges. Courbe
  pilotée par les tuiles (taux de messages toxiques, nombre, moyenne,
  volume analysé), émotions jour par jour, heures sensibles, salons les plus
  vifs, membres au-dessus du seuil et sort des détections.

  Les agrégats du bot sont en UTC ; la carte jour × heure est ramenée à
  l'heure locale du lecteur.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Callout, SectionCard } from '../ui';
  import ActivityChartCard, { type ChartMetric } from './ActivityChartCard.svelte';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import TimeSeriesChart from './TimeSeriesChart.svelte';
  import Sparkline from './Sparkline.svelte';
  import BarList from './BarList.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchClimateAnalytics, type AegisEmotion, type ClimateAnalytics } from '../../api';
  import { memberAvatarSrc } from '../../discordMedia';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsAnnotations } from './annotations.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, shortDate, SERIES } from './analyticsFormat';
  import { EMOTION_COLORS, EMOTION_ORDER, emotionLabel, kindLabel, statusLabel } from '../aegis/aegisFormat';

  const { onOpenMember }: { onOpenMember: (userId: string, name: string) => void } = $props();

  const loader = analyticsLoader(() => fetchClimateAnalytics(filters.periodQuery), 'climate');
  const data = $derived(loader.data as ClimateAnalytics | null);

  $effect(() => {
    const period = filters.periodQuery;
    untrack(() => analyticsAnnotations.load(period));
  });

  const noData = $derived(!!data && data.current.analyzed === 0 && data.previous.analyzed === 0);
  const fmtPts = (v: number) => fmtNumber(Math.round(v * 10) / 10);

  let active = $state('toxicRate');
  const metrics: ChartMetric[] = $derived(
    data
      ? [
          {
            id: 'toxicRate',
            label: m.aegis_metric_toxic_rate(),
            hint: m.aegis_metric_toxic_rate_hint(),
            color: 'var(--color-error)',
            format: (v) => fmtPct(v),
            value: data.current.toxicRate === null ? '—' : fmtPct(data.current.toxicRate),
            delta: data.current.toxicRate !== null && data.previous.toxicRate !== null ? relativeDelta(data.current.toxicRate, data.previous.toxicRate) : null,
            invert: true,
            aggregate: 'avg',
            daily: data.daily.map((d) => d.toxicRate ?? 0),
            prevDaily: data.previousDaily.map((d) => d.toxicRate ?? 0),
          },
          {
            id: 'toxic',
            label: m.aegis_metric_toxic(),
            color: 'var(--color-error)',
            format: fmtNumber,
            value: fmtNumber(data.current.toxic),
            delta: relativeDelta(data.current.toxic, data.previous.toxic),
            invert: true,
            aggregate: 'sum',
            daily: data.daily.map((d) => d.toxic),
            prevDaily: data.previousDaily.map((d) => d.toxic),
          },
          {
            id: 'avgToxicity',
            label: m.aegis_metric_avg(),
            color: SERIES[3]!,
            format: fmtPts,
            value: data.current.avgToxicity === null ? '—' : `${fmtPts(data.current.avgToxicity)} / 100`,
            delta: data.current.avgToxicity !== null && data.previous.avgToxicity !== null ? relativeDelta(data.current.avgToxicity, data.previous.avgToxicity) : null,
            invert: true,
            aggregate: 'avg',
            daily: data.daily.map((d) => d.avgToxicity ?? 0),
            prevDaily: data.previousDaily.map((d) => d.avgToxicity ?? 0),
          },
          {
            id: 'analyzed',
            label: m.aegis_metric_analyzed(),
            color: SERIES[0]!,
            format: fmtNumber,
            value: fmtNumber(data.current.analyzed),
            delta: relativeDelta(data.current.analyzed, data.previous.analyzed),
            aggregate: 'sum',
            daily: data.daily.map((d) => d.analyzed),
            prevDaily: data.previousDaily.map((d) => d.analyzed),
          },
        ]
      : [],
  );

  const tiles: MetricTab[] = $derived(
    data
      ? [
          { id: 'dominant', label: m.aegis_metric_dominant(), value: emotionLabel(data.current.dominant) },
          { id: 'severe', label: m.aegis_zone_auto(), value: fmtNumber(data.current.severe), delta: relativeDelta(data.current.severe, data.previous.severe), invert: true },
          { id: 'detections', label: m.aegis_detections_title(), value: fmtNumber(data.detections.total) },
          {
            id: 'fp',
            label: m.aegis_metric_false_positive(),
            hint: m.aegis_metric_false_positive_hint(),
            value: data.detections.falsePositiveRate === null ? '—' : fmtPct(data.detections.falsePositiveRate),
          },
        ]
      : [],
  );

  // ── Émotions ───────────────────────────────────────────────────────────────
  const MOODS = EMOTION_ORDER.filter((e) => e !== 'neutral');
  const emotionStacks = $derived(
    data ? MOODS.map((e) => ({ label: emotionLabel(e), color: EMOTION_COLORS[e], values: data.daily.map((d) => d[e]) })) : [],
  );
  const emotionTotal = $derived(data ? EMOTION_ORDER.reduce((s, e) => s + data.current.emotions[e], 0) : 0);
  const emotionMix = $derived(
    data
      ? EMOTION_ORDER.map((e) => ({ emotion: e, count: data.current.emotions[e], share: emotionTotal ? (data.current.emotions[e] / emotionTotal) * 100 : 0 }))
      : [],
  );

  // ── Heures sensibles (UTC → heure locale) ──────────────────────────────────
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  const HOURS = Array.from({ length: 24 }, (_, h) => h);
  const DAYS = $derived([m.anx_day_mon(), m.anx_day_tue(), m.anx_day_wed(), m.anx_day_thu(), m.anx_day_fri(), m.anx_day_sat(), m.anx_day_sun()]);

  /** Grille locale [lundi=0][heure] du taux de messages toxiques. */
  const heat = $derived.by(() => {
    const grid = Array.from({ length: 7 }, () => HOURS.map(() => ({ analyzed: 0, toxic: 0 })));
    if (!data) return grid;
    data.heatmap.forEach((row, dow) => row.forEach((cell, hour) => {
      const shifted = dow * 24 + hour + Math.round(offsetHours);
      const wrapped = ((shifted % 168) + 168) % 168;
      const target = grid[Math.floor(wrapped / 24)]![wrapped % 24]!;
      target.analyzed += cell.analyzed;
      target.toxic += cell.toxic;
    }));
    return grid;
  });
  const heatMax = $derived(Math.max(0.0001, ...heat.flatMap((row) => row.map((c) => (c.analyzed ? c.toxic / c.analyzed : 0)))));

  function heatStyle(cell: { analyzed: number; toxic: number }): string {
    if (!cell.analyzed || !cell.toxic) return '';
    const t = Math.min(1, cell.toxic / cell.analyzed / heatMax);
    const strength = Math.round(12 + t * 78);
    return `background: color-mix(in srgb, var(--color-error) ${strength}%, var(--color-surface-container-lowest, var(--color-surface)));${strength > 55 ? ' color: #fff;' : ''}`;
  }

  // ── Détections ─────────────────────────────────────────────────────────────
  const byKind = $derived(
    data
      ? (['TOXIC', 'HARASSMENT', 'CONFLICT', 'DISTRESS'] as const)
        .map((k) => ({ id: k, label: kindLabel(k), value: data.detections.byKind[k] ?? 0 }))
        .filter((i) => i.value > 0)
      : [],
  );
  const byStatus = $derived(
    data
      ? (['AUTO', 'PENDING', 'CONFIRMED', 'DISMISSED'] as const)
        .map((s) => ({ id: s, label: statusLabel(s), value: data.detections.byStatus[s] ?? 0 }))
        .filter((i) => i.value > 0)
      : [],
  );

  const maxChannelToxic = $derived(Math.max(1, ...(data?.channels.map((c) => c.toxic) ?? [1])));
</script>

{#if loader.loading && !data}
  <AnalyticsSkeleton />
{:else if loader.error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{loader.error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loader.loading}>
    {#if !data.enabled && noData}
      <Callout variant="info" title={m.aegis_climate_off_title()}>
        {m.aegis_climate_off_desc()}
        {#snippet actions()}<Button size="sm" href="/security/filters/ai">{m.aegis_climate_open_settings()}</Button>{/snippet}
      </Callout>
    {:else if noData}
      <Callout variant="info" title={m.aegis_climate_empty_title()}>{m.aegis_climate_empty_desc()}</Callout>
    {:else}
      <ActivityChartCard
        {metrics}
        {active}
        onchange={(id) => (active = id)}
        dates={data.daily.map((d) => d.dateKey)}
        days={filters.days}
        compare={filters.compare}
        onToggleCompare={() => filters.toggleCompare()}
        loadHourly={async () => null}
        loadBreakdown={async () => null}
        reloadKey={filters.periodKey}
        annotations={analyticsAnnotations.items}
        onAnnotate={(dateKey, label) => analyticsAnnotations.add(dateKey, label, filters.periodQuery)}
        onDeleteAnnotation={(id) => analyticsAnnotations.remove(id)}
        canDeleteAnnotation={(a) => analyticsAnnotations.canDelete(a)}
        busy={loader.loading}
        forecastAllowed={false}
      />
      <MetricTabs metrics={tiles} active="" onchange={() => {}} compare={filters.compare} label={m.anx_tab_climate()} interactive={false} />

      <div class="climate-grid">
        <SectionCard title={m.aegis_emotions_title()} description={m.aegis_emotions_desc()}>
          <TimeSeriesChart labels={data.daily.map((d) => shortDate(d.dateKey))} mode="stacked" stacks={emotionStacks} format={fmtNumber} height={240} />
        </SectionCard>
        <SectionCard title={m.aegis_emotion_mix_title()}>
          <div class="mix" role="img" aria-label={emotionMix.map((e) => `${emotionLabel(e.emotion)} ${fmtPct(e.share)}`).join(', ')}>
            {#each emotionMix as e (e.emotion)}
              {#if e.share > 0}<span style="width: {e.share}%; background: {EMOTION_COLORS[e.emotion]};"></span>{/if}
            {/each}
          </div>
          <ul class="mix-legend">
            {#each emotionMix as e (e.emotion)}
              <li>
                <span class="dot" style="background: {EMOTION_COLORS[e.emotion as AegisEmotion]};" aria-hidden="true"></span>
                <span class="mix-legend__label">{emotionLabel(e.emotion)}</span>
                <span class="mix-legend__value tabular-nums">{fmtPct(e.share)}</span>
              </li>
            {/each}
          </ul>
        </SectionCard>
      </div>

      <SectionCard title={m.aegis_heatmap_title()} description={m.aegis_heatmap_desc()}>
        <div class="hm-wrap">
          <table class="hm">
            <caption class="sr-only">{m.aegis_heatmap_title()}</caption>
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">{m.anx_staff_day()}</span></th>
                {#each HOURS as h (h)}<th scope="col" class="hm__hour">{h % 3 === 0 ? `${h}h` : ''}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each heat as row, dow (dow)}
                <tr>
                  <th scope="row" class="hm__day">{DAYS[dow]}</th>
                  {#each row as cell, hour (hour)}
                    <td class="hm__cell" style={heatStyle(cell)} title={`${DAYS[dow]} ${hour} h : ${cell.analyzed ? fmtPct((cell.toxic / cell.analyzed) * 100) : '—'} (${fmtNumber(cell.toxic)} / ${fmtNumber(cell.analyzed)})`}></td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title={m.aegis_channels_title()} description={m.aegis_channels_desc()} flush>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{m.aegis_col_channel()}</th>
                <th scope="col" class="num">{m.aegis_col_toxic()}</th>
                <th scope="col" class="num">{m.aegis_col_rate()}</th>
                <th scope="col" class="num">{m.aegis_col_avg()}</th>
                <th scope="col">{m.aegis_col_mood()}</th>
                <th scope="col"><span class="sr-only">{m.aegis_col_trend()}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each data.channels as c (c.channelId)}
                <tr>
                  <th scope="row">
                    <span class="ch-name">#{c.name ?? m.aegis_unknown_channel()}</span>
                    <span class="ch-bar" aria-hidden="true"><span style="width: {Math.max(2, (c.toxic / maxChannelToxic) * 100)}%;"></span></span>
                  </th>
                  <td class="num">{fmtNumber(c.toxic)} <span class="text-on-surface-variant">/ {fmtNumber(c.analyzed)}</span></td>
                  <td class="num {c.toxicRate !== null && c.toxicRate >= 5 ? 'text-error' : ''}">{c.toxicRate === null ? '—' : fmtPct(c.toxicRate)}</td>
                  <td class="num">{c.avgToxicity === null ? '—' : fmtPts(c.avgToxicity)}</td>
                  <td>
                    {#if c.dominant}
                      <span class="mood"><span class="dot" style="background: {EMOTION_COLORS[c.dominant]};" aria-hidden="true"></span>{emotionLabel(c.dominant)}</span>
                    {:else}—{/if}
                  </td>
                  <td><Sparkline values={c.spark} width={64} height={18} fill={false} color="var(--color-error)" /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div class="climate-grid climate-grid--even">
        <SectionCard title={m.aegis_members_title()} description={m.aegis_members_desc()}>
          {#if data.members.length === 0}
            <p class="py-4 text-body-sm text-on-surface-variant">{m.aegis_members_empty()}</p>
          {:else}
            <ul class="users">
              {#each data.members as u, i (u.userId)}
                <li>
                  <button type="button" class="user" onclick={() => onOpenMember(u.userId, u.name ?? '')}>
                    <span class="user__rank">{i + 1}</span>
                    <img class="user__avatar" src={memberAvatarSrc(u.avatar, u.name, u.userId)} alt="" width="24" height="24" loading="lazy" />
                    <span class="user__name">{u.name ?? m.an_member_fallback()}</span>
                    <span class="user__meta">{u.toxicRate === null ? '' : fmtPct(u.toxicRate)}</span>
                    <span class="user__value">{fmtNumber(u.toxic)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </SectionCard>
        <SectionCard title={m.aegis_detections_title()} description={m.aegis_detections_desc()}>
          <div class="flex flex-col gap-4">
            <BarList items={byKind} color="var(--color-error)" empty={m.aegis_empty_desc()} />
            <BarList items={byStatus} color={SERIES[0]} />
          </div>
        </SectionCard>
      </div>
    {/if}
  </div>
{/if}

<style>
  .climate-grid {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 1rem;
  }

  .climate-grid--even {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 64rem) {
    .climate-grid,
    .climate-grid--even {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .mix {
    display: flex;
    height: 0.75rem;
    overflow: hidden;
    border-radius: 999px;
    background: var(--color-surface-container);
  }

  .mix span {
    height: 100%;
  }

  .mix-legend {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 1rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
  }

  .mix-legend li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .mix-legend__label {
    flex: 1;
    color: var(--color-on-surface);
  }

  .mix-legend__value {
    color: var(--color-on-surface-variant);
  }

  .dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    flex-shrink: 0;
    border-radius: 999px;
  }

  .mood {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .hm-wrap {
    overflow-x: auto;
  }

  .hm {
    width: 100%;
    min-width: 40rem;
    border-collapse: separate;
    border-spacing: 2px;
    font-size: 0.6875rem;
  }

  .hm__hour {
    font-weight: 400;
    text-align: left;
    color: var(--color-on-surface-variant);
  }

  .hm__day {
    padding-right: 0.5rem;
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    color: var(--color-on-surface-variant);
  }

  .hm__cell {
    height: 1.5rem;
    border-radius: 0.25rem;
    background: var(--color-surface-container);
  }

  .table-wrap {
    max-height: 30rem;
    overflow: auto;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .data-table th,
  .data-table td {
    padding: 0.5rem 1rem;
    text-align: left;
    border-bottom: 1px solid var(--color-outline-variant);
    white-space: nowrap;
    vertical-align: middle;
  }

  .data-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    font-weight: 500;
    color: var(--color-on-surface-variant);
    background: var(--color-surface-container-lowest, var(--color-surface));
  }

  .data-table tbody th {
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .ch-name {
    display: block;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ch-bar {
    display: block;
    height: 0.1875rem;
    margin-top: 0.25rem;
    border-radius: 999px;
    background: var(--color-surface-container);
  }

  .ch-bar span {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--color-error);
    opacity: 0.7;
  }

  .users {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .user {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.4375rem 0.25rem;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
    text-align: left;
    color: var(--color-on-surface);
  }

  .user:hover {
    background: var(--color-surface-container-low);
  }

  .user__rank {
    width: 1.25rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface-variant);
  }

  .user__avatar {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
  }

  .user__name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user__meta {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .user__value {
    min-width: 2.5rem;
    text-align: right;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
