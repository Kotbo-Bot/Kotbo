<!--
  Filtres globaux de la page Analytics, sur une seule rangée au-dessus des
  sections. La période et la comparaison valent partout ; le salon, le rôle
  et l'exclusion du staff ne valent que là où les données le permettent, et
  la barre le dit quand la section ouverte les ignore.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, FilterPills, type FilterOption } from '../ui';
  import SearchableSelect from '../SearchableSelect.svelte';
  import { fetchAnalyticsFilterOptions, type AnalyticsFilterOptions } from '../../api';
  import { m } from '../../i18n';
  import { analyticsFilters as filters, type PeriodPreset } from './analyticsFilters.svelte';

  const {
    scopeSupport = 'full',
  }: {
    /** full : tous les filtres ; period : la période seule. */
    scopeSupport?: 'full' | 'period';
  } = $props();

  let options = $state<AnalyticsFilterOptions | null>(null);

  onMount(async () => {
    options = await fetchAnalyticsFilterOptions().catch(() => null);
  });

  const periodOptions: FilterOption<PeriodPreset>[] = $derived([
    { value: '1' as PeriodPreset, label: m.an_period_24h() },
    { value: '7' as PeriodPreset, label: m.an_period_7d() },
    { value: '30' as PeriodPreset, label: m.an_period_30d() },
    { value: '90' as PeriodPreset, label: m.an_period_90d() },
    { value: '365' as PeriodPreset, label: m.an_period_365d() },
    { value: 'custom' as PeriodPreset, label: m.an_period_custom() },
  ].filter((option) => !filters.limitDays || (option.value !== 'custom' && Number(option.value) <= filters.limitDays)));

  const channelOptions = $derived(
    (options?.categories ?? []).flatMap((cat) => [
      ...(cat.id ? [{ id: cat.id, name: m.anx_filter_category_option({ name: cat.name ?? '' }), icon: 'folder' }] : []),
      ...cat.channels.map((c) => ({
        id: c.id,
        name: c.kind === 'voice' ? c.name : `#${c.name}`,
        icon: c.kind === 'voice' ? 'Microphone' : undefined,
      })),
    ]),
  );

  const roleOptions = $derived(
    (options?.roles ?? []).map((r) => ({
      id: r.id,
      name: m.anx_filter_role_option({ name: r.name, count: String(r.members) }),
      color: r.color === '#000000' ? null : r.color,
    })),
  );
</script>

<div class="filter-bar">
  <div class="flex flex-wrap items-center gap-2">
    <FilterPills
      label={m.anx_filter_period_label()}
      options={periodOptions}
      value={filters.period}
      onchange={(v) => filters.setPeriod(v)}
    />
    <Button
      size="sm"
      variant={filters.compare ? 'primary' : 'secondary'}
      icon="GitCompare"
      aria-pressed={filters.compare}
      onclick={() => filters.toggleCompare()}
    >
      {m.anx_filter_compare()}
    </Button>
  </div>

  {#if filters.period === 'custom'}
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1 text-2xs text-on-surface-variant">
        {m.anx_filter_from()}
        <input type="datetime-local" class="input" bind:value={filters.customStart} />
      </label>
      <label class="flex flex-col gap-1 text-2xs text-on-surface-variant">
        {m.anx_filter_to()}
        <input type="datetime-local" class="input" bind:value={filters.customEnd} />
      </label>
      <Button size="sm" variant="primary" onclick={() => filters.applyCustom()}>{m.an_apply()}</Button>
    </div>
  {/if}

  {#if filters.limitDays}
    <p class="text-body-sm text-on-surface-variant">
      En gratuit, Analytics garde {filters.limitDays} jours d'historique. Avec Plus : 30 jours, 90 jours, un an, des dates libres et les filtres par salon ou rôle.
      <a href="/billing" class="font-medium text-primary hover:underline">Voir l'offre Plus</a>
    </p>
  {:else}
  <div class="flex flex-wrap items-center gap-3">
    <div class="filter-bar__select">
      <SearchableSelect
        bind:value={filters.channel}
        options={channelOptions}
        placeholder={m.anx_filter_channel_all()}
        showId={false}
      />
    </div>
    <div class="filter-bar__select">
      <SearchableSelect
        bind:value={filters.role}
        options={roleOptions}
        placeholder={m.anx_filter_role_all()}
        showId={false}
      />
    </div>
    <label class="inline-flex items-center gap-2 text-body-sm text-on-surface">
      <input type="checkbox" class="h-4 w-4 rounded accent-primary" bind:checked={filters.excludeStaff} />
      {m.anx_filter_exclude_staff()}
    </label>
    <label class="inline-flex items-center gap-2 text-body-sm text-on-surface" title={m.anx_filter_bots_hint()}>
      <input type="checkbox" class="h-4 w-4 rounded accent-primary" bind:checked={filters.includeBots} />
      {m.anx_filter_include_bots()}
    </label>
    {#if filters.activeScopeFilters > 0}
      <Button size="sm" variant="ghost" icon="x" onclick={() => filters.clearScope()}>{m.anx_filter_clear()}</Button>
    {/if}
  </div>
  {/if}

  {#if scopeSupport === 'period' && filters.activeScopeFilters > 0}
    <p class="text-2xs text-on-surface-variant">{m.anx_filter_period_only()}</p>
  {/if}
</div>

<style>
  .filter-bar {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-low);
  }

  .filter-bar__select {
    width: min(100%, 15rem);
  }

  @media (max-width: 639px) {
    .filter-bar__select {
      width: 100%;
    }
  }
</style>
