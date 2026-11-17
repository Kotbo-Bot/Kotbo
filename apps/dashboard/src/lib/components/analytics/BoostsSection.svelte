<!--
  Section « Boosts » : niveau du serveur, courbe des boosts et boosters,
  boosters actuels et anciens, journal des débuts/arrêts et calculateur de ce
  qu'il manque pour débloquer un ou plusieurs avantages.
-->
<script lang="ts">
  import { BOOST_PERKS, BOOST_TIER_THRESHOLDS, boostGoal, boostMargin, tierForPerks, type BoostPerkId } from '@kotbo/contracts';
  import { Callout, EmptyState, FilterPills, SectionCard } from '../ui';
  import KpiTile from './KpiTile.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import TimeSeriesChart from './TimeSeriesChart.svelte';
  import UserDisplay from '../UserDisplay.svelte';
  import { fetchBoostAnalytics, type BoostAnalytics } from '../../api';
  import { memberCaseModal } from '../../stores/memberCaseModal.svelte';
  import { m, dateLocale } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsFilters as filters } from './analyticsFilters.svelte';
  import { fmtNumber, shortDate, SERIES } from './analyticsFormat';

  let data = $state<BoostAnalytics | null>(null);
  let loading = $state(true);
  let error = $state('');
  let eventFilter = $state<'all' | 'START' | 'STOP'>('all');
  let wanted = $state<BoostPerkId[]>([]);
  let requestId = 0;

  $effect(() => {
    const days = filters.days;
    const id = ++requestId;
    loading = true;
    error = '';
    fetchBoostAnalytics(days)
      .then((res) => {
        if (id === requestId) data = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const openMember = $derived(memberCaseModal.canOpen ? (userId: string) => void memberCaseModal.show(userId) : null);

  function fmtDate(iso: string | null): string {
    return iso ? new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
  }

  function fmtDays(days: number | null): string {
    return days === null ? '-' : m.boost_days({ count: fmtNumber(days) });
  }

  function daysBetween(from: string, to: string | number = Date.now()): number {
    return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000));
  }

  const events = $derived((data?.events ?? []).filter((e) => eventFilter === 'all' || e.type === eventFilter));
  const margin = $derived(data ? boostMargin(data.boostCount) : null);
  const wantedTier = $derived(tierForPerks(wanted));
  const goal = $derived(data && wantedTier > 0 ? boostGoal(data.boostCount, wantedTier) : null);
  const nextGoal = $derived(data && data.tier < 3 ? boostGoal(data.boostCount, data.tier + 1) : null);

  function togglePerk(id: BoostPerkId) {
    wanted = wanted.includes(id) ? wanted.filter((p) => p !== id) : [...wanted, id];
  }

  const PERK_LABELS: Record<BoostPerkId, () => string> = {
    emoji_100: m.boost_perk_emoji_100,
    stickers_15: m.boost_perk_stickers_15,
    audio_128: m.boost_perk_audio_128,
    stream_720: m.boost_perk_stream_720,
    animated_icon: m.boost_perk_animated_icon,
    invite_background: m.boost_perk_invite_background,
    emoji_150: m.boost_perk_emoji_150,
    stickers_30: m.boost_perk_stickers_30,
    audio_256: m.boost_perk_audio_256,
    stream_1080: m.boost_perk_stream_1080,
    banner: m.boost_perk_banner,
    upload_50: m.boost_perk_upload_50,
    role_icons: m.boost_perk_role_icons,
    emoji_250: m.boost_perk_emoji_250,
    stickers_60: m.boost_perk_stickers_60,
    audio_384: m.boost_perk_audio_384,
    vanity_url: m.boost_perk_vanity_url,
    animated_banner: m.boost_perk_animated_banner,
    upload_100: m.boost_perk_upload_100,
  };
</script>

{#if loading && !data}
  <AnalyticsSkeleton />
{:else if error}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" aria-busy={loading}>
    <div class="kpi-grid kpi-grid--4">
      <KpiTile
        label={m.boost_kpi_boosts()}
        value={fmtNumber(data.boostCount)}
        hint={m.boost_tier_label({ tier: String(data.tier) })}
      />
      <KpiTile label={m.boost_kpi_boosters()} value={fmtNumber(data.boosterCount)} />
      <KpiTile
        label={m.boost_kpi_movements()}
        value={`+${fmtNumber(data.started)} / −${fmtNumber(data.stopped)}`}
        hint={m.boost_kpi_movements_hint()}
      />
      <KpiTile
        label={m.boost_kpi_avg_current()}
        value={fmtDays(data.avgCurrentDays)}
        hint={data.avgEndedDays !== null ? m.boost_kpi_avg_ended({ days: fmtDays(data.avgEndedDays) }) : undefined}
      />
    </div>

    <SectionCard title={m.boost_chart_title()} description={m.boost_chart_desc()}>
      <TimeSeriesChart
        labels={data.series.map((p) => shortDate(p.date))}
        mode="lines"
        stacks={[
          { label: m.boost_series_boosts(), values: data.series.map((p) => p.boostCount), color: SERIES[0] },
          { label: m.boost_series_boosters(), values: data.series.map((p) => p.boosterCount), color: SERIES[1] },
        ]}
        format={(v) => fmtNumber(v)}
        height={240}
      />
    </SectionCard>

    <div class="section-grid">
      <div class="span-6">
        <SectionCard
          title={m.boost_calc_title()}
          description={m.boost_calc_desc()}
        >
          <div class="flex flex-col gap-3">
            <p class="text-sm text-on-surface">
              {#if nextGoal}
                {m.boost_calc_next({ tier: String(nextGoal.tier), boosts: fmtNumber(nextGoal.missingBoosts), people: fmtNumber(nextGoal.missingNitroMembers) })}
              {:else}
                {m.boost_calc_max()}
              {/if}
              {#if margin !== null}
                <br /><span class="text-on-surface-variant">{m.boost_margin({ count: fmtNumber(margin), tier: String(data.tier - 1) })}</span>
              {/if}
            </p>

            {#each [1, 2, 3] as tier (tier)}
              <fieldset class="perk-group" class:perk-group--reached={data.tier >= tier}>
                <legend class="text-xs font-semibold text-on-surface-variant">
                  {m.boost_tier_label({ tier: String(tier) })} · {m.boost_tier_needs({ boosts: String(BOOST_TIER_THRESHOLDS[tier]) })}
                </legend>
                <div class="flex flex-wrap gap-1.5">
                  {#each BOOST_PERKS.filter((p) => p.tier === tier) as perk (perk.id)}
                    <label class="perk-chip" class:perk-chip--on={wanted.includes(perk.id)}>
                      <input
                        type="checkbox"
                        class="sr-only"
                        checked={wanted.includes(perk.id)}
                        onchange={() => togglePerk(perk.id)}
                      />
                      {PERK_LABELS[perk.id]()}
                    </label>
                  {/each}
                </div>
              </fieldset>
            {/each}

            <p class="text-sm font-medium text-on-surface" aria-live="polite">
              {#if !goal}
                <span class="text-on-surface-variant">{m.boost_calc_none()}</span>
              {:else if goal.missingBoosts === 0}
                {m.boost_calc_reached({ tier: String(goal.tier) })}
              {:else}
                {m.boost_calc_missing({ tier: String(goal.tier), boosts: fmtNumber(goal.missingBoosts), people: fmtNumber(goal.missingNitroMembers) })}
              {/if}
            </p>
          </div>
        </SectionCard>
      </div>

      <div class="span-6">
        <SectionCard title={m.boost_boosters_title()} description={m.boost_boosters_desc()} flush>
          {#if data.boosters.length === 0}
            <div class="p-6"><EmptyState icon="gem" title={m.boost_boosters_empty()} reason="accumulating" /></div>
          {:else}
            <ul class="max-h-[26rem] divide-y divide-outline-variant overflow-y-auto">
              {#each data.boosters as booster (booster.userId)}
                <li class="flex items-center justify-between gap-3 px-5 py-2.5">
                  <UserDisplay userId={booster.userId} size="sm" onClick={openMember} />
                  <span class="shrink-0 text-xs text-on-surface-variant">
                    {m.boost_since({ date: fmtDate(booster.since) })} · {fmtDays(daysBetween(booster.since))}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </SectionCard>
      </div>

      <div class="span-6">
        <SectionCard title={m.boost_events_title()} flush>
          <div class="border-b border-outline-variant px-5 py-3">
            <FilterPills
              label={m.boost_events_title()}
              value={eventFilter}
              onchange={(v) => (eventFilter = v)}
              options={[
                { value: 'all', label: m.boost_filter_all(), count: data.events.length },
                { value: 'START', label: m.boost_filter_start(), count: data.started },
                { value: 'STOP', label: m.boost_filter_stop(), count: data.stopped },
              ]}
            />
          </div>
          {#if events.length === 0}
            <div class="p-6"><EmptyState icon="gem" title={m.boost_events_empty()} reason="nothing-matches" /></div>
          {:else}
            <ul class="max-h-[26rem] divide-y divide-outline-variant overflow-y-auto">
              {#each events as event, i (`${event.userId}-${event.at}-${i}`)}
                <li class="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="event-dot" class:event-dot--stop={event.type === 'STOP'} aria-hidden="true"></span>
                    <UserDisplay userId={event.userId} size="xs" boost={false} onClick={openMember} />
                    <span class="truncate text-xs text-on-surface-variant">
                      {event.type === 'START' ? m.boost_event_start() : m.boost_event_stop({ days: fmtDays(event.since ? daysBetween(event.since, event.at) : null) })}
                    </span>
                  </div>
                  <span class="shrink-0 text-xs text-on-surface-variant">{fmtDate(event.at)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </SectionCard>
      </div>

      <div class="span-6">
        <SectionCard title={m.boost_former_title()} flush>
          {#if data.formerBoosters.length === 0}
            <div class="p-6"><EmptyState icon="gem" title={m.boost_former_empty()} reason="accumulating" /></div>
          {:else}
            <ul class="max-h-[26rem] divide-y divide-outline-variant overflow-y-auto">
              {#each data.formerBoosters as former (former.userId)}
                <li class="flex items-center justify-between gap-3 px-5 py-2.5">
                  <UserDisplay userId={former.userId} size="sm" boost={false} onClick={openMember} />
                  <span class="shrink-0 text-xs text-on-surface-variant">
                    {m.boost_ended({ date: fmtDate(former.endedAt) })}{#if former.since} · {fmtDays(daysBetween(former.since, former.endedAt))}{/if}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </SectionCard>
      </div>
    </div>
  </div>
{/if}

<style>
  .perk-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 0;
    padding: 0;
    margin: 0;
  }

  .perk-chip {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-low);
    font-size: 0.75rem;
    color: var(--color-on-surface);
    transition: border-color 140ms ease, background-color 140ms ease;
  }

  .perk-chip:hover {
    border-color: var(--color-primary);
  }

  .perk-chip:focus-within {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .perk-chip--on {
    border-color: var(--color-primary);
    background: var(--color-primary-container);
    color: var(--color-on-primary-container);
  }

  .perk-group--reached .perk-chip:not(.perk-chip--on) {
    color: var(--color-on-surface-variant);
  }

  .event-dot {
    width: 0.5rem;
    height: 0.5rem;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--color-success, #22c55e);
  }

  .event-dot--stop {
    background: var(--color-error, #ef4444);
  }
</style>
