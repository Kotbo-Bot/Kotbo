<script lang="ts" module>
  export type ClanSettings = {
    enabled: boolean;
    name: string;
    floorsAfter: 'GENERATE' | 'LOOP';
    generatedFog: boolean;
    weekday: number;
    hour: number;
    durationHours: number;
    pointsPerFloor: number;
    podiumPoints: number[];
    milestones: number[];
    announceChannelId: string | null;
    floors?: any[];
  };
  export type ClanStanding = {
    clanId: string;
    name: string;
    floors: number;
    rank: number;
    climbers: { userId: string; floors: number; displayName?: string }[];
    totalFloors?: number;
    milestones?: number;
  };
  export type ClanWeek = { startsAt: string; endsAt: string; standings: ClanStanding[] };
  export type ClanAward = { clanId: string; name: string; rank: number; floors: number; total: number };

  export function CLAN_DEFAULTS(): ClanSettings {
    return {
      enabled: false,
      name: 'Tour de clan',
      floorsAfter: 'GENERATE',
      generatedFog: true,
      weekday: 6,
      hour: 18,
      durationHours: 48,
      pointsPerFloor: 10,
      podiumPoints: [150, 100, 50],
      milestones: [10, 25, 50],
      announceChannelId: null,
    };
  }
</script>

<script lang="ts">
  /** La Tour de clan par section ; ses réglages sont chargés et enregistrés par RpgTowerPanel. */
  import { m } from '../../i18n';
  import { saveRpgClanTowerLayout } from '../../api';
  import Papicon from '../Papicon.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import { Callout, SectionCard, ToggleSwitch } from '../ui';
  import HintTip from './HintTip.svelte';
  import RpgTowerMapEditor from './RpgTowerMapEditor.svelte';

  type Foe = { name: string; emoji: string; isBoss: boolean; enabled: boolean };

  let {
    view,
    canManage = false,
    disabled = false,
    settings = $bindable(),
    clansEnabled = true,
    current = null,
    last = null,
    nextOpensAt = null,
    mapVersion = 0,
    foes = [],
    limits = {},
    channels = [],
    growthPercent = 8,
    onSaved,
  }: {
    view: string;
    canManage?: boolean;
    disabled?: boolean;
    settings: ClanSettings;
    clansEnabled?: boolean;
    current?: ClanWeek | null;
    last?: { endsAt: string; results: { awards?: ClanAward[] } | null } | null;
    nextOpensAt?: string | null;
    mapVersion?: number;
    foes?: Foe[];
    limits?: { mapSize?: { min: number; max: number }; mapRoomsMax?: number; floorsMax?: number };
    channels?: { id: string; name: string }[];
    growthPercent?: number;
    onSaved: () => void | Promise<void>;
  } = $props();

  // Mêmes valeurs que `CLAN_TOWER_MILESTONE_BONUSES` côté bot.
  const MILESTONE_BONUSES = [
    () => m.eco_clan_tower_milestone_bonus_1(),
    () => m.eco_clan_tower_milestone_bonus_2(),
    () => m.eco_clan_tower_milestone_bonus_3(),
  ];

  const WEEKDAYS = [
    () => m.eco_clan_tower_day_0(), () => m.eco_clan_tower_day_1(), () => m.eco_clan_tower_day_2(), () => m.eco_clan_tower_day_3(),
    () => m.eco_clan_tower_day_4(), () => m.eco_clan_tower_day_5(), () => m.eco_clan_tower_day_6(),
  ];

  const leader = $derived(current?.standings[0] ?? null);
  const topFloor = $derived(Math.max(1, leader?.floors ?? 1));

  const inputClass = 'w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-body-sm focus:outline-none focus:border-primary disabled:opacity-60';
  const labelClass = 'text-xs font-semibold text-on-surface-variant flex items-center gap-1.5';
  const choiceClass = 'text-left p-3.5 rounded-xl border transition-colors disabled:cursor-not-allowed';

  function when(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '—';
  }
</script>

{#snippet hintIcon(hint: string)}
  <HintTip text={hint} />
{/snippet}

{#snippet kpi(label: string, value: string | number, sub: string, icon: string)}
  <div class="flex flex-col gap-1 min-w-0 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3.5">
    <span class="text-body-sm text-on-surface-variant flex items-center gap-1.5"><Papicon {icon} size={13} /> {label}</span>
    <span class="font-headline text-2xl font-semibold tabular-nums truncate">{value}</span>
    {#if sub}<span class="text-2xs text-on-surface-variant/80 truncate">{sub}</span>{/if}
  </div>
{/snippet}

{#snippet awards()}
  {#if last?.results?.awards && last.results.awards.length > 0}
    <SectionCard title={m.eco_clan_tower_last_title({ end: when(last.endsAt) })} icon="calendar">
      <ol class="flex flex-col gap-1.5 text-xs">
        {#each last.results.awards.slice(0, 5) as award (award.clanId)}
          <li class="flex items-center gap-3 rounded-lg bg-surface-container-low px-3 py-2">
            <span class="w-6 text-right font-mono text-on-surface-variant">{award.rank}</span>
            <span class="flex-1 font-semibold truncate">{award.name}</span>
            <span class="text-on-surface-variant">+{award.total}</span>
            <span class="font-bold text-warning">{m.eco_tower_milestone_floor({ floor: award.floors })}</span>
          </li>
        {/each}
      </ol>
    </SectionCard>
  {/if}
{/snippet}

<div class="flex flex-col gap-4">
  {#if !clansEnabled}
    <Callout variant="warning">{m.eco_clan_tower_clans_off()}</Callout>
  {/if}

  {#if view === 'overview'}
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {@render kpi(
        m.eco_clan_tower_current_title(),
        current ? when(current.endsAt) : '—',
        current ? m.eco_clan_tower_kpi_until() : settings.enabled ? m.eco_clan_tower_next({ start: when(nextOpensAt) }) : m.eco_clan_tower_off(),
        'clock',
      )}
      {@render kpi(m.eco_clan_tower_kpi_clans(), current?.standings.length ?? 0, '', 'user')}
      {@render kpi(m.eco_clan_tower_kpi_leader(), leader?.name ?? '—', leader ? m.eco_tower_milestone_floor({ floor: leader.floors }) : '', 'crown')}
    </div>
    {@render awards()}
  {:else if view === 'board'}
    <SectionCard
      title={m.eco_clan_tower_current_title()}
      icon="crown"
      description={current ? m.eco_clan_tower_current_until({ end: when(current.endsAt) }) : settings.enabled ? m.eco_clan_tower_next({ start: when(nextOpensAt) }) : m.eco_clan_tower_off()}
    >
      {#if current && current.standings.length > 0}
        <ol class="flex flex-col gap-1.5 text-xs">
          {#each current.standings as standing (standing.clanId)}
            <li class="relative overflow-hidden flex items-center gap-3 rounded-lg px-3 py-2">
              <div class="absolute inset-y-0 left-0 bg-warning/10 pointer-events-none" style="width: {Math.round((standing.floors / topFloor) * 100)}%"></div>
              <span class="relative w-6 text-right font-mono text-on-surface-variant">{standing.rank}</span>
              <span class="relative flex-1 font-semibold truncate">{standing.name}</span>
              {#if standing.totalFloors !== undefined}
                <span class="relative text-2xs text-on-surface-variant hidden sm:inline" title={m.eco_clan_tower_total_tip()}>{m.eco_clan_tower_total({ floors: standing.totalFloors, reached: standing.milestones ?? 0 })}</span>
              {/if}
              {#if standing.climbers[0]}
                <span class="relative text-2xs text-on-surface-variant hidden md:inline">{standing.climbers[0].displayName ?? standing.climbers[0].userId} · {standing.climbers[0].floors}</span>
              {/if}
              <span class="relative font-bold text-warning whitespace-nowrap">{m.eco_tower_milestone_floor({ floor: standing.floors })}</span>
            </li>
          {/each}
        </ol>
      {:else if current}
        <p class="text-body-sm text-on-surface-variant">{m.eco_clan_tower_no_conquest()}</p>
      {/if}
    </SectionCard>
    {@render awards()}
  {:else if view === 'rules'}
    <SectionCard title={m.eco_clan_tower_title()} description={m.eco_clan_tower_desc()} icon="calendar">
      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="flex flex-col gap-1.5">
            <label for="clanTowerName" class={labelClass}>{m.eco_clan_tower_name()}</label>
            <input id="clanTowerName" type="text" maxlength="40" bind:value={settings.name} disabled={!canManage || disabled} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <span class={labelClass}>{m.eco_tower_announce_channel()} {@render hintIcon(m.eco_clan_tower_announce_hint())}</span>
            <SearchableSelect
              value={settings.announceChannelId}
              options={channels}
              placeholder={m.eco_tower_announce_none()}
              clearable={true}
              className="w-full"
              on:change={(e: any) => { settings.announceChannelId = e.detail?.value ?? null; }}
            />
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="flex flex-col gap-1.5">
            <label for="clanTowerDay" class={labelClass}>{m.eco_clan_tower_weekday()}</label>
            <select id="clanTowerDay" bind:value={settings.weekday} disabled={!canManage || disabled} class={inputClass}>
              {#each WEEKDAYS as label, index}<option value={index}>{label()}</option>{/each}
            </select>
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="clanTowerHour" class={labelClass}>{m.eco_clan_tower_hour()} {@render hintIcon(m.eco_clan_tower_attempts_hint())}</label>
            <input id="clanTowerHour" type="number" min="0" max="23" bind:value={settings.hour} disabled={!canManage || disabled} class={inputClass} />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="clanTowerDuration" class={labelClass}>{m.eco_clan_tower_duration()} {@render hintIcon(m.eco_clan_tower_duration_hint())}</label>
            <input id="clanTowerDuration" type="number" min="24" max="96" step="24" bind:value={settings.durationHours} disabled={!canManage || disabled} class={inputClass} />
          </div>
        </div>
      </div>
    </SectionCard>

    <SectionCard title={m.eco_tower_climb_title()} icon="walk">
      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {#each [
            { value: 'GENERATE' as const, title: m.eco_tower_floors_after_generate(), desc: m.eco_tower_floors_after_generate_desc() },
            { value: 'LOOP' as const, title: m.eco_tower_floors_after_loop(), desc: m.eco_tower_floors_after_loop_desc() },
          ] as option}
            <button type="button" disabled={!canManage || disabled} aria-pressed={settings.floorsAfter === option.value} onclick={() => { settings.floorsAfter = option.value; }}
              class="{choiceClass} {settings.floorsAfter === option.value ? 'border-primary bg-primary/10' : 'border-outline-variant hover:bg-surface-container-low'}">
              <p class="text-sm font-semibold {settings.floorsAfter === option.value ? 'text-primary' : ''}">{option.title}</p>
              <p class="text-2xs text-on-surface-variant mt-1 leading-relaxed">{option.desc}</p>
            </button>
          {/each}
        </div>
        <div class="flex items-center justify-between gap-4">
          <span class={labelClass}><Papicon icon="Eye" size={13} /> {m.eco_tower_generated_fog()}</span>
          <ToggleSwitch checked={settings.generatedFog} disabled={!canManage || disabled} ariaLabel={m.eco_tower_generated_fog()} onToggle={(value: boolean) => { settings.generatedFog = value; }} />
        </div>
      </div>
    </SectionCard>
  {:else if view === 'rewards'}
    <SectionCard title={m.eco_clan_tower_points_title()} description={m.eco_clan_tower_points_hint()} icon="star">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="flex flex-col gap-1.5">
          <label for="clanTowerPerFloor" class={labelClass}>{m.eco_clan_tower_per_floor()} {@render hintIcon(m.eco_clan_tower_per_floor_hint())}</label>
          <input id="clanTowerPerFloor" type="number" min="0" max="1000" bind:value={settings.pointsPerFloor} disabled={!canManage || disabled} class={inputClass} />
        </div>
        {#each [0, 1, 2] as index}
          <div class="flex flex-col gap-1.5">
            <label for="clanTowerPodium{index}" class={labelClass}>{m.eco_clan_tower_podium({ rank: index + 1 })}</label>
            <input id="clanTowerPodium{index}" type="number" min="0" max="100000" bind:value={settings.podiumPoints[index]} disabled={!canManage || disabled} class={inputClass} />
          </div>
        {/each}
      </div>
    </SectionCard>

    <SectionCard title={m.eco_clan_tower_milestones_title()} description={m.eco_clan_tower_milestones_hint()} icon="bookmark">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        {#each [0, 1, 2] as index}
          <div class="flex flex-col gap-1.5">
            <label for="clanTowerMilestone{index}" class={labelClass}>{m.eco_clan_tower_milestone({ rank: index + 1, bonus: MILESTONE_BONUSES[index]() })}</label>
            <input id="clanTowerMilestone{index}" type="number" min="1" max="10000" bind:value={settings.milestones[index]} disabled={!canManage || disabled} class={inputClass} />
          </div>
        {/each}
      </div>
    </SectionCard>
  {:else if view === 'map'}
    {#key mapVersion}
      <RpgTowerMapEditor
        {canManage}
        {disabled}
        initialFloors={settings.floors ?? []}
        floorsMax={limits.floorsMax ?? 300}
        {growthPercent}
        floorsAfter={settings.floorsAfter}
        {foes}
        sizeLimits={limits.mapSize ?? { min: 3, max: 20 }}
        roomsMax={limits.mapRoomsMax ?? 300}
        saveFloors={(floors) => saveRpgClanTowerLayout({ floors })}
        {onSaved}
      />
    {/key}
  {/if}
</div>
