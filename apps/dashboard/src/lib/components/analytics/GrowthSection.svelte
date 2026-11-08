<!--
  Croissance : arrivées, départs et solde de la période, rétention et
  ancienneté, puis qui fait venir du monde, où en sont les candidatures, et
  les derniers arrivés et partis. Cohortes et risque de départ ont leurs
  propres sous-onglets.
-->
<script lang="ts">
  import { SectionCard } from '../ui';
  import KpiTile from './KpiTile.svelte';
  import TrendChart from './TrendChart.svelte';
  import BarList, { type BarListItem } from './BarList.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchActivityAnalytics, type ActivityAnalytics } from '../../api';
  import { m, dateLocale } from '../../i18n';
  import { analyticsFilters as filters } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, SERIES } from './analyticsFormat';

  const {
    legacy,
    legacyLoading,
    onOpenMember,
  }: {
    /** Réponse de l'ancien /analytics : rétention, inviteurs, candidatures, arrivées. */
    legacy: any;
    legacyLoading: boolean;
    onOpenMember?: (userId: string, name: string) => void;
  } = $props();

  let activity = $state<ActivityAnalytics | null>(null);
  let requestId = 0;

  $effect(() => {
    // Arrivées et départs sont comptés pour tout le serveur : seule la période compte.
    const query = { ...filters.periodQuery, includeBots: filters.includeBots };
    const id = ++requestId;
    fetchActivityAnalytics(query)
      .then((res) => {
        if (id === requestId) activity = res;
      })
      .catch(() => {
        if (id === requestId) activity = null;
      });
  });

  const k = $derived(activity?.kpis);
  const totals = $derived(legacy?.totals ?? null);
  const trend = $derived(legacy?.dailyTrend ?? []);

  const inviters: BarListItem[] = $derived(
    (legacy?.topInviters ?? []).slice(0, 10).map((i: any) => ({
      id: i.inviterId ?? i.tag,
      label: i.tag ?? m.an_member_fallback(),
      value: i.count ?? 0,
    })),
  );

  const statusLabel = (status: string) => ({
    PENDING: m.anx_recruit_pending(),
    ORAL: m.anx_recruit_oral(),
    APPROVED: m.anx_recruit_approved(),
    REJECTED: m.anx_recruit_rejected(),
    AUTO_REJECTED: m.anx_recruit_auto_rejected(),
  })[status] ?? status;

  const pipeline: BarListItem[] = $derived(
    (legacy?.recruitmentPipeline ?? []).map((p: any, i: number) => ({
      id: p.status,
      label: statusLabel(p.status),
      value: p.count ?? 0,
      color: SERIES[i % SERIES.length],
    })),
  );

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) : '';

  interface RecentMember {
    id: string;
    name: string;
    avatarUrl: string | null;
    date: string;
  }

  const toRecent = (list: any[] | undefined): RecentMember[] =>
    (list ?? []).slice(0, 10).map((j) => ({ id: j.userId, name: j.name ?? m.an_member_fallback(), avatarUrl: j.avatarUrl ?? null, date: fmtDate(j.date) }));

  const recentJoins = $derived(toRecent(legacy?.recentJoins));
  const recentLeaves = $derived(toRecent(legacy?.recentLeaves));
</script>

<div class="flex flex-col gap-4">
  {#if k}
    <div class="kpi-grid kpi-grid--4">
      <KpiTile label={m.anx_growth_joined()} value={fmtNumber(k.joined)} />
      <KpiTile label={m.anx_growth_left()} value={fmtNumber(k.left)} />
      <KpiTile label={m.anx_kpi_net_joins()} value={`${k.netJoins.value > 0 ? '+' : ''}${fmtNumber(k.netJoins.value)}`} delta={k.netJoins.value - k.netJoins.previous} unit="abs" compare={filters.compare} />
      {#if k.memberCount !== null}
        <KpiTile label={filters.includeBots ? m.anx_kpi_members_with_bots() : m.anx_kpi_members()} value={fmtNumber(k.memberCount)} />
      {/if}
    </div>
  {/if}

  {#if legacyLoading && !legacy}
    <AnalyticsSkeleton />
  {:else if legacy}
    {#if totals}
      <div class="kpi-grid kpi-grid--4">
        <KpiTile label={m.anx_fact_retention()} value={fmtPct(totals.retentionRate ?? 0, 0)} hint={m.anx_growth_retention_hint()} />
        <KpiTile label={m.anx_fact_tenure()} value={m.anx_fact_days({ count: fmtNumber(Math.round(totals.avgTenureDays ?? 0)) })} />
        <KpiTile label={m.anx_fact_inactive()} value={fmtNumber(totals.inactiveMembers ?? 0)} />
        <KpiTile label={m.anx_growth_net()} value={`${(totals.netGrowth ?? 0) > 0 ? '+' : ''}${fmtNumber(totals.netGrowth ?? 0)}`} hint={m.anx_period_only_note()} />
      </div>
    {/if}

    {#if trend.length > 0}
      <div class="section-grid">
        <div class="span-6">
          <SectionCard title={m.anx_growth_joins_chart()}>
            <TrendChart
              dates={trend.map((d: any) => d.dateKey)}
              values={trend.map((d: any) => d.membersJoined ?? 0)}
              label={m.anx_growth_joined()}
              previousLabel=""
              color={SERIES[2]}
              format={fmtNumber}
              height={200}
            />
          </SectionCard>
        </div>
        <div class="span-6">
          <SectionCard title={m.anx_growth_leaves_chart()}>
            <TrendChart
              dates={trend.map((d: any) => d.dateKey)}
              values={trend.map((d: any) => d.membersLeft ?? 0)}
              label={m.anx_growth_left()}
              previousLabel=""
              color={SERIES[7]}
              format={fmtNumber}
              height={200}
            />
          </SectionCard>
        </div>
      </div>
    {/if}

    <div class="section-grid">
      <div class="span-6">
        <SectionCard title={m.anx_growth_inviters_title()} description={m.anx_growth_inviters_desc()}>
          <BarList items={inviters} color={SERIES[2]} empty={m.anx_growth_inviters_empty()} onselect={onOpenMember ? (item) => onOpenMember(item.id, item.label) : undefined} />
        </SectionCard>
      </div>
      <div class="span-6">
        <SectionCard title={m.anx_growth_recruit_title()} description={m.anx_period_only_note()}>
          <BarList items={pipeline} empty={m.anx_growth_recruit_empty()} />
        </SectionCard>
      </div>
    </div>

    <div class="section-grid">
      <div class="span-6">
        <SectionCard title={m.anx_growth_recent_joins()}>
          {@render memberList(recentJoins)}
        </SectionCard>
      </div>
      <div class="span-6">
        <SectionCard title={m.anx_growth_recent_leaves()}>
          {@render memberList(recentLeaves)}
        </SectionCard>
      </div>
    </div>
  {/if}
</div>

{#snippet memberList(list: RecentMember[])}
  {#if list.length === 0}
    <p class="text-body-sm text-on-surface-variant">{m.anx_growth_recent_empty()}</p>
  {:else}
    <ul class="flex flex-col gap-1">
      {#each list as member (member.id)}
        <li>
          <button type="button" disabled={!onOpenMember} class="member-row" onclick={() => onOpenMember?.(member.id, member.name)}>
            {#if member.avatarUrl}
              <img src={member.avatarUrl} alt="" width="28" height="28" class="h-7 w-7 shrink-0 rounded-full" loading="lazy" />
            {:else}
              <span class="h-7 w-7 shrink-0 rounded-full bg-surface-container"></span>
            {/if}
            <span class="flex-1 truncate text-body-sm text-on-surface">{member.name}</span>
            <span class="shrink-0 text-2xs text-on-surface-variant">{member.date}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<style>
  .member-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
  }

  .member-row:hover:not(:disabled) {
    background: var(--color-surface-container);
  }

  .member-row:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
</style>
