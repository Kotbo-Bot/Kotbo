<!--
  Membres : la carte de courbe (effectif, arrivées, départs, solde, en ligne,
  porteurs du tag de clan), puis d'où viennent les arrivées (type de source,
  liens, inviteurs et part encore présente), la qualité des nouveaux (âge des
  comptes, onboarding, départs en moins de 24 h), les rôles et les membres
  les plus actifs. Période seule.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Callout, SectionCard } from '../ui';
  import ActivityChartCard, { type ChartMetric } from './ActivityChartCard.svelte';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import TopList from './TopList.svelte';
  import BarList from './BarList.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import {
    fetchActivityRankings,
    fetchMemberOverview,
    rescanMemberStats,
    type MemberOverview,
  } from '../../api';
  import { memberAvatarSrc } from '../../discordMedia';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsAnnotations } from './annotations.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDelta, fmtNumber, fmtPct, SERIES, SERIES_NEUTRAL } from './analyticsFormat';

  const {
    legacy,
    onOpenMember,
  }: {
    /** Réponse de l'ancien /analytics : rôles, tag de clan. */
    legacy: any;
    onOpenMember: (userId: string, name: string) => void;
  } = $props();

  const loader = analyticsLoader(() => fetchMemberOverview({ ...filters.periodQuery, includeBots: filters.includeBots }), 'members');
  const data = $derived(loader.data as MemberOverview | null);

  $effect(() => {
    const period = filters.periodQuery;
    untrack(() => analyticsAnnotations.load(period));
  });

  let active = $state('members');

  // Tag de clan : courbe reprise de l'ancienne réponse quand elle est au pas du jour.
  const tagByDay = $derived(
    new Map<string, number>((legacy?.dailyTrend ?? []).map((d: any) => [String(d.dateKey).slice(0, 10), d.taggedMembersCount ?? 0])),
  );

  const metrics: ChartMetric[] = $derived.by(() => {
    if (!data) return [];
    const s = data.series;
    const sum = (k: 'joined' | 'left' | 'prevJoined' | 'prevLeft') => s.reduce((acc, d) => acc + d[k], 0);
    const avg = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0);
    const last = s[s.length - 1];
    const net = sum('joined') - sum('left');
    const prevNet = sum('prevJoined') - sum('prevLeft');
    const list: ChartMetric[] = [
      {
        id: 'members',
        label: m.anx_mem_count(),
        color: SERIES[0]!,
        format: fmtNumber,
        value: fmtNumber(data.memberCount ?? last?.members ?? 0),
        delta: last && last.prevMembers > 0 ? relativeDelta(last.members, last.prevMembers) : undefined,
        aggregate: 'avg',
        daily: s.map((d) => d.members),
        prevDaily: s.map((d) => d.prevMembers),
      },
      {
        id: 'joined',
        label: m.anx_funnel_joined(),
        color: SERIES[2]!,
        format: fmtNumber,
        value: fmtNumber(sum('joined')),
        delta: relativeDelta(sum('joined'), sum('prevJoined')),
        aggregate: 'sum',
        daily: s.map((d) => d.joined),
        prevDaily: s.map((d) => d.prevJoined),
      },
      {
        id: 'left',
        label: m.anx_growth_left(),
        color: SERIES[1]!,
        format: fmtNumber,
        value: fmtNumber(sum('left')),
        delta: relativeDelta(sum('left'), sum('prevLeft')),
        invert: true,
        aggregate: 'sum',
        daily: s.map((d) => d.left),
        prevDaily: s.map((d) => d.prevLeft),
      },
      {
        id: 'net',
        label: m.anx_metric_net_joins(),
        color: SERIES[3]!,
        format: fmtNumber,
        value: `${net > 0 ? '+' : ''}${fmtNumber(net)}`,
        delta: prevNet > 0 ? relativeDelta(net, prevNet) : undefined,
        aggregate: 'sum',
        daily: s.map((d) => d.joined - d.left),
        prevDaily: s.map((d) => d.prevJoined - d.prevLeft),
      },
      {
        id: 'online',
        label: m.anx_mem_peak_online(),
        hint: m.anx_mem_peak_online_hint(),
        color: SERIES[6]!,
        format: fmtNumber,
        value: fmtNumber(Math.round(avg(s.map((d) => d.peakOnline)))),
        delta: relativeDelta(avg(s.map((d) => d.peakOnline)), avg(s.map((d) => d.prevPeakOnline))),
        aggregate: 'avg',
        daily: s.map((d) => d.peakOnline),
        prevDaily: s.map((d) => d.prevPeakOnline),
      },
    ];
    if (legacy?.clanTag && tagByDay.size > 0) {
      const tagged = s.map((d) => tagByDay.get(d.dateKey) ?? 0);
      list.push({
        id: 'tag',
        label: m.anx_mem_tagged({ tag: legacy.clanTag }),
        color: SERIES[4]!,
        format: fmtNumber,
        value: fmtNumber(legacy.clanTaggedMembersCount ?? tagged[tagged.length - 1] ?? 0),
        aggregate: 'avg',
        daily: tagged,
        prevDaily: [],
      });
    }
    return list;
  });

  // ── Sources ────────────────────────────────────────────────────────────────
  const kindLabel = (k: string) =>
    ({ invite: m.anx_mem_src_invite(), vanity: m.anx_mem_src_vanity(), label: m.anx_mem_src_label(), unknown: m.anx_mem_src_unknown() })[k] ?? k;
  const KIND_COLOR: Record<string, string> = { invite: SERIES[0]!, label: SERIES[2]!, vanity: SERIES[6]!, unknown: SERIES_NEUTRAL };
  const kindItems = $derived(
    (data?.sources.kinds ?? [])
      .filter((k) => k.joined > 0)
      .sort((a, b) => b.joined - a.joined)
      .map((k) => ({ id: k.kind, label: kindLabel(k.kind), value: k.joined, color: KIND_COLOR[k.kind], sub: k.retention === null ? '' : m.anx_mem_still_here({ pct: fmtPct(k.retention, 0) }) })),
  );

  // ── Nouveaux ───────────────────────────────────────────────────────────────
  const ageLabel = (k: string) =>
    ({ under1d: m.anx_tenure_1d(), under7d: m.anx_tenure_7d(), under30d: m.anx_tenure_30d(), under365d: m.anx_mem_age_year(), over365d: m.anx_mem_age_more() })[k] ?? k;
  const young = $derived.by(() => {
    const a = data?.newcomers.accountAge;
    if (!a || a.known === 0) return null;
    const n = a.buckets.filter((b) => b.key === 'under1d' || b.key === 'under7d').reduce((s, b) => s + b.count, 0);
    return (n / a.known) * 100;
  });
  const ageMax = $derived(Math.max(1, ...(data?.newcomers.accountAge.buckets.map((b) => b.count) ?? [1])));

  const qualityTiles: MetricTab[] = $derived.by(() => {
    if (!data) return [];
    const n = data.newcomers;
    return [
      { id: 'joined', label: m.anx_mem_newcomers(), value: fmtNumber(n.joined), color: SERIES[0] },
      { id: 'young', label: m.anx_mem_young(), hint: m.anx_mem_young_hint(), value: young === null ? '–' : fmtPct(young, 0), color: SERIES[0] },
      ...(n.onboarding ? [{ id: 'onboarding', label: m.anx_mem_onboarding(), hint: m.anx_mem_onboarding_hint(), value: n.onboarding.rate === null ? '–' : fmtPct(n.onboarding.rate, 0), color: SERIES[0] }] : []),
      { id: 'left24h', label: m.anx_growth_quick_leave(), hint: m.anx_growth_quick_leave_hint(), value: n.left24h.rate === null ? '–' : fmtPct(n.left24h.rate, 0), color: SERIES[0] },
    ];
  });

  // ── Rôles ──────────────────────────────────────────────────────────────────
  const roleItems = $derived(
    (legacy?.roleDistribution ?? []).map((r: any) => ({
      id: r.roleId,
      label: r.roleName,
      value: r.count ?? 0,
      color: r.color && r.color !== '#000000' && r.color !== '#99AAB5' ? r.color : SERIES_NEUTRAL,
    })),
  );

  let syncing = $state(false);
  async function syncMembers() {
    syncing = true;
    try {
      const res = await rescanMemberStats({ force: false });
      if (res?.ok) toast.success(m.an_mem_sync_started());
      else toast.error(res?.error || m.an_mem_sync_error());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : m.an_mem_sync_error());
    } finally {
      syncing = false;
    }
  }
</script>

{#if loader.loading && !data}
  <AnalyticsSkeleton />
{:else if loader.error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{loader.error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4">
    <ActivityChartCard
      {metrics}
      {active}
      onchange={(id) => (active = id)}
      dates={data.series.map((d) => d.dateKey)}
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

    <div class="mem-grid">
      <SectionCard title={m.anx_mem_sources_title()} description={m.anx_mem_sources_desc({ count: fmtNumber(data.sources.tracked) })}>
        {#if kindItems.length === 0}
          <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_funnel_empty()}</p>
        {:else}
          <BarList items={kindItems} />
        {/if}
      </SectionCard>

      <SectionCard title={m.anx_mem_quality_title()} description={m.anx_mem_quality_desc()}>
        <div class="flex flex-col gap-4">
          <MetricTabs metrics={qualityTiles} active="" onchange={() => {}} label={m.anx_mem_quality_title()} interactive={false} />
          {#if data.newcomers.accountAge.known > 0}
            <div>
              <p class="mb-2 text-body-sm font-medium text-on-surface">{m.anx_mem_age_title()}</p>
              <ul class="age">
                {#each data.newcomers.accountAge.buckets as b (b.key)}
                  <li class="age__row">
                    <span class="age__label">{ageLabel(b.key)}</span>
                    <span class="age__track" aria-hidden="true">
                      <span class="age__fill" style="width: {Math.max(1, (b.count / ageMax) * 100)}%; background: {b.key === 'under1d' || b.key === 'under7d' ? 'var(--series-2)' : 'var(--series-1)'};"></span>
                    </span>
                    <span class="age__value">{fmtNumber(b.count)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      </SectionCard>
    </div>

    <div class="mem-grid">
      <SectionCard title={m.anx_mem_links_title()} description={m.anx_mem_links_desc()} flush>
        {#if data.sources.links.length === 0}
          <p class="px-5 py-6 text-body-sm text-on-surface-variant">{m.anx_mem_links_empty()}</p>
        {:else}
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">{m.anx_mem_link()}</th>
                  <th scope="col">{m.anx_mem_inviter()}</th>
                  <th scope="col" class="num">{m.anx_funnel_joined()}</th>
                  <th scope="col" class="num">{m.anx_mem_retention()}</th>
                </tr>
              </thead>
              <tbody>
                {#each data.sources.links as link (link.code)}
                  <tr>
                    <th scope="row">
                      <span class="link-code">{link.label ?? link.code}</span>
                      {#if link.label}<span class="row-sub">{link.code}</span>{/if}
                      {#if link.isVanity}<span class="row-sub">{m.anx_mem_src_vanity()}</span>{/if}
                    </th>
                    <td>{link.inviterTag ?? '–'}</td>
                    <td class="num">{fmtNumber(link.joined)}</td>
                    <td class="num">{link.retention === null ? '–' : fmtPct(link.retention, 0)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </SectionCard>

      <SectionCard title={m.anx_mem_inviters_title()} description={m.anx_mem_inviters_desc()} flush>
        {#if data.inviters.length === 0}
          <p class="px-5 py-6 text-body-sm text-on-surface-variant">{m.anx_growth_inviters_empty()}</p>
        {:else}
          <ul class="inviters">
            {#each data.inviters as inv, i (inv.userId)}
              <li>
                <button type="button" class="inviter" onclick={() => onOpenMember(inv.userId, inv.name ?? '')}>
                  <span class="inviter__rank">{i + 1}</span>
                  <img class="inviter__avatar" src={memberAvatarSrc(inv.avatarUrl, inv.name, inv.userId)} alt="" width="24" height="24" loading="lazy" />
                  <span class="inviter__name">{inv.name ?? m.an_member_fallback()}</span>
                  <span class="inviter__meta" title={m.anx_mem_retention()}>{inv.retention === null ? '' : m.anx_mem_still_here({ pct: fmtPct(inv.retention, 0) })}</span>
                  <span class="inviter__value">{fmtNumber(inv.joined)}</span>
                  {#if filters.compare}<span class="inviter__delta">{fmtDelta(relativeDelta(inv.joined, inv.previous), 'pct')}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </SectionCard>
    </div>

    <div class="mem-grid">
      <TopList
        title={m.anx_top_members_messages()}
        description={m.anx_mem_most_active_desc()}
        icon="UsersFour"
        kind="members"
        load={(limit) => fetchActivityRankings({ ...filters.periodQuery, includeBots: filters.includeBots }, 'messages', 'members', limit)}
        reloadKey={`${filters.periodKey}|members`}
        compare={filters.compare}
        onselect={(item) => onOpenMember(item.id, item.name ?? '')}
        exportName="membres_actifs"
      />
      {#if roleItems.length > 0}
        <SectionCard title={m.anx_roles_title()} description={m.anx_roles_desc()}>
          <BarList items={roleItems} />
        </SectionCard>
      {/if}
    </div>

    <div class="flex justify-end">
      <Button size="sm" variant="ghost" icon="refresh-cw" loading={syncing} onclick={syncMembers} title={m.an_mem_sync_title()}>{m.anx_mem_sync()}</Button>
    </div>
  </div>
{/if}

<style>
  .mem-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    align-items: start;
  }

  .age {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .age__row {
    display: grid;
    grid-template-columns: 8rem minmax(0, 1fr) 3rem;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.8125rem;
  }

  .age__label {
    color: var(--color-on-surface-variant);
  }

  .age__track {
    height: 0.5rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .age__fill {
    display: block;
    height: 100%;
    border-radius: 999px;
  }

  .age__value {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }

  .table-wrap {
    max-height: 26rem;
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
  }

  .data-table thead th {
    position: sticky;
    top: 0;
    background: var(--color-surface-container-low);
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .link-code {
    display: block;
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .row-sub {
    display: block;
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--color-on-surface-variant);
  }

  .inviters {
    display: flex;
    flex-direction: column;
    max-height: 26rem;
    overflow-y: auto;
    padding: 0.5rem;
  }

  .inviter {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
  }

  .inviter:hover {
    background: var(--color-surface-container);
  }

  .inviter__rank {
    width: 1.25rem;
    text-align: right;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .inviter__avatar {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    object-fit: cover;
  }

  .inviter__name {
    flex: 1;
    min-width: 0;
    font-size: 0.875rem;
    color: var(--color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inviter__meta {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .inviter__value {
    flex-shrink: 0;
    min-width: 2.5rem;
    text-align: right;
    font-size: 0.875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }

  .inviter__delta {
    flex-shrink: 0;
    min-width: 3.5rem;
    text-align: right;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }
</style>
