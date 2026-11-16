<script lang="ts">
  import {
    SEASON_NAME_MAX,
    SEASON_REWARDS_MAX,
    SEASON_REWARD_COINS,
    SEASON_REWARD_RANK,
    SEASON_DURATION_DAYS,
    SEASON_TIERS_MAX,
    SEASON_TIER_XP,
    validateSeasonRewards,
    validateSeasonSchedule,
    validateSeasonTiers,
    type SeasonAnnouncementLabels,
    type SeasonRewardError,
    type SeasonScheduleError,
    type SeasonTierError,
  } from '@kotbo/shared';
  import type { BotRoleAccess } from '@kotbo/contracts';
  import { createSeason, updateSeason, type Season, type SeasonPayload } from '../../api/seasons';
  import { m, dateLocale } from '../../i18n';
  import Modal from '../Modal.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import Papicon from '../Papicon.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';
  import Field from '../ui/Field.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import SeasonAnnouncementPreview from './SeasonAnnouncementPreview.svelte';
  import { seasonRoleRefusal } from './seasonRoleBlockers';

  let {
    open = $bindable(false),
    season = null,
    roles,
    channels,
    economyActive,
    activeName = null,
    botRoleAccess = null,
    labels = null,
    nextNumber,
    onDone,
  }: {
    open?: boolean;
    /** Saison à modifier ; `null` pour en créer une. */
    season?: Season | null;
    roles: Array<{ id: string; name: string; position?: number }>;
    channels: Array<{ id: string; name: string }>;
    economyActive: boolean;
    /** Nom de la saison en cours, `null` sans saison en cours. */
    activeName?: string | null;
    /** Ce que le bot peut attribuer : un rôle qu'il ne pourra pas donner est signalé. */
    botRoleAccess?: BotRoleAccess | null;
    /** Gabarits des annonces ; absents d'un bot plus ancien, l'aperçu est alors masqué. */
    labels?: SeasonAnnouncementLabels | null;
    /** Numéro que prendra une nouvelle saison. */
    nextNumber: number;
    onDone?: () => void;
  } = $props();

  /**
   * Une ligne de récompense, de rang ou de palier : `at` est le rang ou le
   * seuil d'XP. `key` : repère stable, pour que supprimer une ligne ne décale
   * pas les sélecteurs des suivantes.
   */
  type Row = { key: number; at: number; roleId: string | null; coins: number; rotate: boolean };
  type RowKind = 'rank' | 'tier';
  let nextRowKey = 0;
  const toRow = (at: number, reward: { roleId: string | null; coins: number; rotate?: boolean }): Row =>
    ({ key: nextRowKey++, at, roleId: reward.roleId, coins: reward.coins, rotate: !!reward.rotate });
  const fromRow = (row: Row) => ({ roleId: row.roleId ?? '', coins: row.coins, rotate: row.rotate });

  let name = $state('');
  let startDay = $state('');
  let endDay = $state('');
  let topRoleId = $state<string | null>(null);
  let announceChannelId = $state<string | null>(null);
  let rewards = $state<Row[]>([]);
  let tiers = $state<Row[]>([]);
  let autoRenew = $state(false);
  let remindBeforeEnd = $state(false);
  let saving = $state(false);

  /** Une saison en cours garde sa date de début : l'XP de chacun y a été relevée. */
  const startLocked = $derived(season?.status === 'ACTIVE');

  function toDay(iso: string): string {
    const date = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function addDays(day: string, days: number): string {
    const date = new Date(`${day}T00:00`);
    date.setDate(date.getDate() + days);
    return toDay(date.toISOString());
  }

  /** Les jours choisis valent en heure locale : du début du premier à la fin du dernier. */
  function startIso(): string {
    if (startLocked && season) return season.startDate;
    return startDay ? new Date(`${startDay}T00:00`).toISOString() : '';
  }
  function endIso(): string {
    return endDay ? new Date(`${endDay}T23:59:59`).toISOString() : '';
  }

  $effect(() => {
    if (!open) return;
    const today = toDay(new Date().toISOString());
    name = season?.name ?? '';
    startDay = season ? toDay(season.startDate) : today;
    endDay = season ? toDay(season.endDate) : addDays(today, 30);
    topRoleId = season?.topRoleId ?? null;
    announceChannelId = season?.announceChannelId ?? null;
    rewards = (season?.rewards ?? []).map((reward) => toRow(reward.rank, reward));
    tiers = (season?.tiers ?? []).map((tier) => toRow(tier.minXp, tier));
    autoRenew = season?.autoRenew ?? false;
    remindBeforeEnd = season?.remindBeforeEnd ?? false;
  });

  /** Le rappel part dans le salon d'annonce : sans salon, il n'a nulle part où aller. */
  const reminderOn = $derived(remindBeforeEnd && !!announceChannelId);

  const refusal = (roleId: string | null) => seasonRoleRefusal(roleId, roles, botRoleAccess) ?? undefined;

  /** Un début passé ouvre la saison, sauf si une autre tourne : elle attend alors sa clôture. */
  const queued = $derived(!startLocked && !!activeName && !!startDay && new Date(startIso()).getTime() <= Date.now());

  const scheduleCheck = $derived(validateSeasonSchedule({ name, startDate: startIso(), endDate: endIso() }));
  const rewardsCheck = $derived(validateSeasonRewards(rewards.map((row) => ({ rank: row.at, ...fromRow(row) }))));
  const tiersCheck = $derived(validateSeasonTiers(tiers.map((row) => ({ minXp: row.at, ...fromRow(row) }))));

  const SCHEDULE_ERRORS: Record<SeasonScheduleError, () => string> = {
    BAD_NAME: () => m.sea_error_name({ max: SEASON_NAME_MAX }),
    BAD_DATE: () => m.sea_error_date(),
    END_BEFORE_START: () => m.sea_error_end_before_start(),
    END_IN_PAST: () => m.sea_error_end_in_past(),
    BAD_DURATION: () => m.sea_error_duration({ min: SEASON_DURATION_DAYS.min, max: SEASON_DURATION_DAYS.max }),
  };
  const REWARD_ERRORS: Record<SeasonRewardError, () => string> = {
    NOT_ARRAY: () => m.sea_error_reward_rank({ max: SEASON_REWARD_RANK.max }),
    TOO_MANY: () => m.sea_error_reward_too_many({ max: SEASON_REWARDS_MAX }),
    BAD_RANK: () => m.sea_error_reward_rank({ max: SEASON_REWARD_RANK.max }),
    BAD_ROLE: () => m.sea_error_reward_role(),
    BAD_COINS: () => m.sea_error_reward_coins({ max: SEASON_REWARD_COINS.max.toLocaleString() }),
    EMPTY_REWARD: () => m.sea_error_reward_empty(),
    DUPLICATE_RANK: () => m.sea_error_reward_duplicate(),
  };
  const TIER_ERRORS: Record<SeasonTierError, () => string> = {
    TIERS_NOT_ARRAY: () => m.sea_error_tier_xp({ max: SEASON_TIER_XP.max.toLocaleString(dateLocale()) }),
    TOO_MANY_TIERS: () => m.sea_error_tier_too_many({ max: SEASON_TIERS_MAX }),
    BAD_TIER_XP: () => m.sea_error_tier_xp({ max: SEASON_TIER_XP.max.toLocaleString(dateLocale()) }),
    BAD_TIER_ROLE: () => m.sea_error_reward_role(),
    BAD_TIER_COINS: () => m.sea_error_reward_coins({ max: SEASON_REWARD_COINS.max.toLocaleString() }),
    EMPTY_TIER: () => m.sea_error_reward_empty(),
    DUPLICATE_TIER: () => m.sea_error_tier_duplicate(),
  };

  const nameError = $derived('error' in scheduleCheck && scheduleCheck.error === 'BAD_NAME' && name.length > 0 ? SCHEDULE_ERRORS.BAD_NAME() : undefined);
  const datesError = $derived('error' in scheduleCheck && scheduleCheck.error !== 'BAD_NAME' ? SCHEDULE_ERRORS[scheduleCheck.error]() : undefined);
  const rewardsError = $derived('error' in rewardsCheck ? REWARD_ERRORS[rewardsCheck.error]() : null);
  const tiersError = $derived('error' in tiersCheck ? TIER_ERRORS[tiersCheck.error]() : null);
  const canSubmit = $derived('schedule' in scheduleCheck && 'rewards' in rewardsCheck && 'tiers' in tiersCheck && !saving);
  const hasCoins = $derived([...rewards, ...tiers].some((row) => row.coins > 0));

  function addReward() {
    const next = rewards.reduce((max, row) => Math.max(max, row.at), 0) + 1;
    rewards = [...rewards, toRow(Math.min(next, SEASON_REWARD_RANK.max), { roleId: null, coins: 0 })];
  }

  /** Un palier de plus double le seuil du dernier : 1 000, 2 000, 4 000... */
  function addTier() {
    const last = tiers.reduce((max, row) => Math.max(max, row.at), 0);
    tiers = [...tiers, toRow(Math.min(last > 0 ? last * 2 : 1000, SEASON_TIER_XP.max), { roleId: null, coins: 0 })];
  }

  async function submit() {
    if (!('schedule' in scheduleCheck) || !('rewards' in rewardsCheck) || !('tiers' in tiersCheck)) return;
    saving = true;
    try {
      const payload: SeasonPayload = {
        name: scheduleCheck.schedule.name,
        startDate: startIso(),
        endDate: endIso(),
        rewards: rewardsCheck.rewards,
        tiers: tiersCheck.tiers,
        topRoleId,
        announceChannelId,
        autoRenew,
        remindBeforeEnd: reminderOn,
      };
      const ok = season ? await updateSeason(season.id, payload) : await createSeason(payload);
      if (ok) {
        open = false;
        onDone?.();
      }
    } finally {
      saving = false;
    }
  }
</script>

{#snippet toggleRow(id: string, icon: string, label: string, description: string, checked: boolean, onToggle: (value: boolean) => void, disabled: boolean)}
  <div class="flex items-start justify-between gap-4 rounded-xl border border-outline-variant/20 bg-surface-container-high/10 p-3">
    <div class="min-w-0">
      <p class="text-sm font-semibold flex items-center gap-2"><Papicon {icon} size={15} /> {label}</p>
      <p class="text-xs text-on-surface-variant mt-1">{description}</p>
    </div>
    <ToggleSwitch {id} {checked} {onToggle} {disabled} ariaLabel={label} />
  </div>
{/snippet}

{#snippet rewardRow(row: Row, kind: RowKind, index: number, onRemove: () => void)}
  <li class="season-reward-row grid items-end gap-3">
    <Field id="season-{kind}-at-{index}" label={kind === 'rank' ? m.sea_reward_rank_label() : m.sea_tier_xp_label()}>
      {#snippet children(id)}
        <input
          {id}
          type="number"
          class="input"
          min={kind === 'rank' ? SEASON_REWARD_RANK.min : SEASON_TIER_XP.min}
          max={kind === 'rank' ? SEASON_REWARD_RANK.max : SEASON_TIER_XP.max}
          bind:value={row.at}
        />
      {/snippet}
    </Field>
    <Field id="season-{kind}-role-{index}" label={m.sea_reward_role_label()} error={refusal(row.roleId)}>
      {#snippet children(id)}
        <SearchableSelect
          {id}
          bind:value={row.roleId}
          options={roles.map((role) => ({ id: role.id, name: `@${role.name}` }))}
          placeholder={m.sea_role_none()}
        />
      {/snippet}
    </Field>
    <Field id="season-{kind}-coins-{index}" label={m.sea_reward_coins_label()}>
      {#snippet children(id)}
        <input {id} type="number" class="input" min={SEASON_REWARD_COINS.min} max={SEASON_REWARD_COINS.max} bind:value={row.coins} />
      {/snippet}
    </Field>
    <Button
      variant="ghost"
      icon="Trash"
      aria-label={kind === 'rank' ? m.sea_reward_remove({ rank: row.at }) : m.sea_tier_remove({ xp: row.at.toLocaleString(dateLocale()) })}
      onclick={onRemove}
    />
    <!-- Sans rôle, il n'y a rien à reprendre : la case attend qu'un rôle soit choisi. -->
    <label class="season-reward-rotate flex items-center gap-2 text-xs text-on-surface {row.roleId ? 'cursor-pointer' : 'opacity-60'}" title={m.sea_rotate_hint()}>
      <input type="checkbox" bind:checked={row.rotate} disabled={!row.roleId} class="accent-primary" />
      {m.sea_rotate_label()}
    </label>
  </li>
{/snippet}

<Modal
  bind:open
  onClose={() => open = false}
  title={season ? m.sea_edit_title() : m.sea_create_title()}
  subtitle={season ? `#${season.number}` : m.sea_create_subtitle()}
  size="md"
>
  <div class="space-y-5">
    <Field id="season-name" label={m.sea_field_name()} error={nameError}>
      {#snippet children(id, describedBy)}
        <input {id} type="text" class="input" maxlength={SEASON_NAME_MAX} placeholder={m.sea_name_ph()} bind:value={name} aria-describedby={describedBy} />
      {/snippet}
    </Field>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field id="season-start" label={m.sea_field_start_date()} hint={startLocked ? m.sea_start_locked_hint() : m.sea_start_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} type="date" class="input" bind:value={startDay} disabled={startLocked} aria-describedby={describedBy} />
        {/snippet}
      </Field>
      <Field id="season-end" label={m.sea_field_end_date()} error={datesError}>
        {#snippet children(id, describedBy)}
          <input {id} type="date" class="input" bind:value={endDay} aria-describedby={describedBy} />
        {/snippet}
      </Field>
    </div>

    {#if queued && activeName}
      <Callout variant="warning">
        <p>{m.sea_editor_queued({ name: activeName })}</p>
      </Callout>
    {/if}

    <Callout variant="info">
      <p>{m.sea_editor_explainer()}</p>
    </Callout>

    <Field id="season-announce-channel" label={m.sea_announce_channel_label()} hint={m.sea_announce_channel_hint()}>
      {#snippet children(id)}
        <SearchableSelect
          {id}
          bind:value={announceChannelId}
          options={channels.map((channel) => ({ id: channel.id, name: `#${channel.name}` }))}
          placeholder={m.sea_announce_channel_none()}
        />
      {/snippet}
    </Field>

    <div class="space-y-3">
      {@render toggleRow('season-auto-renew', 'RefreshCw', m.sea_auto_renew_label(), m.sea_auto_renew_desc(), autoRenew, (value) => autoRenew = value, false)}
      {@render toggleRow('season-reminder', 'Bell', m.sea_reminder_label(), announceChannelId ? m.sea_reminder_desc() : m.sea_reminder_needs_channel(), reminderOn, (value) => remindBeforeEnd = value, !announceChannelId)}
    </div>

    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Award" size={15} /> {m.sea_rewards_heading()}</h3>
        <p class="text-xs text-on-surface-variant mt-1">{m.sea_rewards_desc()}</p>
      </div>

      <Field id="season-top-role" label={m.sea_top_role_label()} hint={m.sea_top_role_hint()} error={refusal(topRoleId)}>
        {#snippet children(id)}
          <SearchableSelect
            {id}
            bind:value={topRoleId}
            options={roles.map((role) => ({ id: role.id, name: `@${role.name}` }))}
            placeholder={m.sea_role_none()}
          />
        {/snippet}
      </Field>

      {#if rewards.length > 0}
        <ul class="space-y-3">
          {#each rewards as row, index (row.key)}
            {@render rewardRow(row, 'rank', index, () => rewards = rewards.filter((other) => other.key !== row.key))}
          {/each}
        </ul>
      {/if}

      {#if rewardsError}
        <p class="text-xs text-error" role="alert">{rewardsError}</p>
      {/if}

      <Button
        size="sm"
        icon="Plus"
        disabled={rewards.length >= SEASON_REWARDS_MAX}
        disabledReason={m.sea_error_reward_too_many({ max: SEASON_REWARDS_MAX })}
        onclick={addReward}
      >
        {m.sea_reward_add()}
      </Button>
    </section>

    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Zap" size={15} /> {m.sea_tiers_heading()}</h3>
        <p class="text-xs text-on-surface-variant mt-1">{m.sea_tiers_desc()}</p>
      </div>

      {#if tiers.length > 0}
        <ul class="space-y-3">
          {#each tiers as row, index (row.key)}
            {@render rewardRow(row, 'tier', index, () => tiers = tiers.filter((other) => other.key !== row.key))}
          {/each}
        </ul>
      {/if}

      {#if tiersError}
        <p class="text-xs text-error" role="alert">{tiersError}</p>
      {/if}

      <Button
        size="sm"
        icon="Plus"
        disabled={tiers.length >= SEASON_TIERS_MAX}
        disabledReason={m.sea_error_tier_too_many({ max: SEASON_TIERS_MAX })}
        onclick={addTier}
      >
        {m.sea_tier_add()}
      </Button>
    </section>

    {#if hasCoins && !economyActive}
      <p class="text-xs text-warning">{m.sea_rewards_economy_off()}</p>
    {/if}

    {#if announceChannelId && labels}
      <SeasonAnnouncementPreview
        {labels}
        season={{ number: season?.number ?? nextNumber, name: name.trim(), endDate: endIso() }}
        rewards={'rewards' in rewardsCheck ? rewardsCheck.rewards : []}
        tiers={'tiers' in tiersCheck ? tiersCheck.tiers : []}
        {topRoleId}
        reminder={reminderOn}
        roleName={(roleId) => roles.find((role) => role.id === roleId)?.name ?? roleId}
      />
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => open = false}>{m.common_cancel()}</Button>
      <Button variant="primary" icon={season ? 'Check' : 'Plus'} loading={saving} disabled={!canSubmit} onclick={submit}>
        {season ? m.sea_btn_save() : m.sea_btn_create()}
      </Button>
    </div>
  {/snippet}
</Modal>

<style>
  .season-reward-row {
    grid-template-columns: 5.5rem minmax(0, 1fr) 8rem auto;
  }

  .season-reward-rotate {
    grid-column: 1 / -1;
  }

  @media (max-width: 639px) {
    .season-reward-row {
      grid-template-columns: 4.5rem minmax(0, 1fr) auto;
    }

    .season-reward-row > :nth-child(3) {
      grid-column: 1 / 3;
      grid-row: 2;
    }
  }
</style>
