<script lang="ts">
  import {
    SEASON_NAME_MAX,
    SEASON_REWARDS_MAX,
    SEASON_REWARD_COINS,
    SEASON_REWARD_RANK,
    SEASON_DURATION_DAYS,
    validateSeasonRewards,
    validateSeasonSchedule,
    type SeasonRewardError,
    type SeasonScheduleError,
  } from '@kotbo/shared';
  import { createSeason, updateSeason, type Season, type SeasonPayload } from '../../api/seasons';
  import { m } from '../../i18n';
  import Modal from '../Modal.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import Papicon from '../Papicon.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';
  import Field from '../ui/Field.svelte';

  let {
    open = $bindable(false),
    season = null,
    roles,
    channels,
    economyActive,
    onDone,
  }: {
    open?: boolean;
    /** Saison à modifier ; `null` pour en créer une. */
    season?: Season | null;
    roles: Array<{ id: string; name: string }>;
    channels: Array<{ id: string; name: string }>;
    economyActive: boolean;
    onDone?: () => void;
  } = $props();

  type RewardRow = { rank: number; roleId: string | null; coins: number };

  let name = $state('');
  let startDay = $state('');
  let endDay = $state('');
  let topRoleId = $state<string | null>(null);
  let announceChannelId = $state<string | null>(null);
  let rewards = $state<RewardRow[]>([]);
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
    rewards = (season?.rewards ?? []).map((reward) => ({ ...reward }));
  });

  const scheduleCheck = $derived(validateSeasonSchedule({ name, startDate: startIso(), endDate: endIso() }));
  const rewardsCheck = $derived(validateSeasonRewards(rewards.map((reward) => ({ ...reward, roleId: reward.roleId ?? '' }))));

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

  const nameError = $derived('error' in scheduleCheck && scheduleCheck.error === 'BAD_NAME' && name.length > 0 ? SCHEDULE_ERRORS.BAD_NAME() : undefined);
  const datesError = $derived('error' in scheduleCheck && scheduleCheck.error !== 'BAD_NAME' ? SCHEDULE_ERRORS[scheduleCheck.error]() : undefined);
  const rewardsError = $derived('error' in rewardsCheck ? REWARD_ERRORS[rewardsCheck.error]() : null);
  const canSubmit = $derived('schedule' in scheduleCheck && 'rewards' in rewardsCheck && !saving);
  const hasCoins = $derived(rewards.some((reward) => reward.coins > 0));

  function addReward() {
    const next = rewards.reduce((max, reward) => Math.max(max, reward.rank), 0) + 1;
    rewards = [...rewards, { rank: Math.min(next, SEASON_REWARD_RANK.max), roleId: null, coins: 0 }];
  }

  function removeReward(index: number) {
    rewards = rewards.filter((_, i) => i !== index);
  }

  async function submit() {
    if (!('schedule' in scheduleCheck) || !('rewards' in rewardsCheck)) return;
    saving = true;
    try {
      const payload: SeasonPayload = {
        name: scheduleCheck.schedule.name,
        startDate: startIso(),
        endDate: endIso(),
        rewards: rewardsCheck.rewards,
        topRoleId,
        announceChannelId,
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

    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Award" size={15} /> {m.sea_rewards_heading()}</h3>
        <p class="text-xs text-on-surface-variant mt-1">{m.sea_rewards_desc()}</p>
      </div>

      <Field id="season-top-role" label={m.sea_top_role_label()} hint={m.sea_top_role_hint()}>
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
          {#each rewards as reward, index (index)}
            <li class="season-reward-row grid items-end gap-3">
              <Field id="season-reward-rank-{index}" label={m.sea_reward_rank_label()}>
                {#snippet children(id)}
                  <input {id} type="number" class="input" min={SEASON_REWARD_RANK.min} max={SEASON_REWARD_RANK.max} bind:value={reward.rank} />
                {/snippet}
              </Field>
              <Field id="season-reward-role-{index}" label={m.sea_reward_role_label()}>
                {#snippet children(id)}
                  <SearchableSelect
                    {id}
                    bind:value={reward.roleId}
                    options={roles.map((role) => ({ id: role.id, name: `@${role.name}` }))}
                    placeholder={m.sea_role_none()}
                  />
                {/snippet}
              </Field>
              <Field id="season-reward-coins-{index}" label={m.sea_reward_coins_label()}>
                {#snippet children(id)}
                  <input {id} type="number" class="input" min={SEASON_REWARD_COINS.min} max={SEASON_REWARD_COINS.max} bind:value={reward.coins} />
                {/snippet}
              </Field>
              <Button variant="ghost" icon="Trash" aria-label={m.sea_reward_remove({ rank: reward.rank })} onclick={() => removeReward(index)} />
            </li>
          {/each}
        </ul>
      {/if}

      {#if rewardsError}
        <p class="text-xs text-error" role="alert">{rewardsError}</p>
      {/if}
      {#if hasCoins && !economyActive}
        <p class="text-xs text-warning">{m.sea_rewards_economy_off()}</p>
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
