<script lang="ts">
  import { m } from '../i18n';
  import {
    CONDITION_PERIODS,
    CONDITION_TYPES,
    DAYS_TYPES,
    MIN_TYPES,
    PERIOD_TYPES,
    ROLE_TYPES,
    TEXT_TYPES,
    defaultCondition,
    isConditionComplete,
    type ConditionType,
    type GiveawayConditionDraft,
  } from '../giveawayConditions';
  import MultiSelect from './MultiSelect.svelte';
  import Papicon from './Papicon.svelte';

  let {
    value = $bindable<GiveawayConditionDraft[]>([]),
    roles = [],
    idPrefix = 'giveaway-cond',
  }: {
    value: GiveawayConditionDraft[];
    roles?: Array<{ id: string; name: string }>;
    idPrefix?: string;
  } = $props();

  const roleOptions = $derived(roles.map((r) => ({ id: r.id, name: `@${r.name}` })));

  // Les clefs sont écrites en toutes lettres : Paraglide les repère à l'analyse du code.
  const typeLabels: Record<ConditionType, () => string> = {
    roles_all: () => m.giv_cond_type_roles_all(),
    roles_any: () => m.giv_cond_type_roles_any(),
    roles_none: () => m.giv_cond_type_roles_none(),
    account_age: () => m.giv_cond_type_account_age(),
    member_age: () => m.giv_cond_type_member_age(),
    booster: () => m.giv_cond_type_booster(),
    avatar: () => m.giv_cond_type_avatar(),
    banner: () => m.giv_cond_type_banner(),
    server_tag: () => m.giv_cond_type_server_tag(),
    topgg_vote: () => m.giv_cond_type_topgg_vote(),
    nickname_contains: () => m.giv_cond_type_nickname_contains(),
    status_contains: () => m.giv_cond_type_status_contains(),
    messages: () => m.giv_cond_type_messages(),
    voice_minutes: () => m.giv_cond_type_voice_minutes(),
    invites: () => m.giv_cond_type_invites(),
    level: () => m.giv_cond_type_level(),
    xp: () => m.giv_cond_type_xp(),
    coins: () => m.giv_cond_type_coins(),
    reputation: () => m.giv_cond_type_reputation(),
    in_guild: () => m.giv_cond_type_in_guild(),
  };
  const periodLabels = {
    total: () => m.giv_cond_period_total(),
    '7d': () => m.giv_cond_period_7d(),
    '30d': () => m.giv_cond_period_30d(),
    since_start: () => m.giv_cond_period_since_start(),
  } as const;

  const fieldClass = 'w-full bg-surface-container-high/45 border border-field-border rounded-lg px-3 py-2.5 text-sm text-on-surface focus:ring-2 focus:ring-primary/30 transition-all focus:outline-none';

  function add() {
    value = [...value, defaultCondition('roles_any')];
  }
  function remove(index: number) {
    value = value.filter((_, i) => i !== index);
  }
  function changeType(index: number, type: ConditionType) {
    // Garde le groupe : changer de type ne doit pas sortir la ligne de son « ou ».
    value = value.map((c, i) => (i === index ? defaultCondition(type, c.group) : c));
  }
</script>

<div class="space-y-3">
  <div>
    <h3 class="text-sm font-semibold text-on-surface">{m.giv_cond_title()}</h3>
    <p class="field-hint">{m.giv_cond_help()}</p>
  </div>

  {#if value.length === 0}
    <p class="text-xs text-on-surface-variant">{m.giv_cond_empty()}</p>
  {/if}

  {#each value as condition, index (index)}
    {@const incomplete = !isConditionComplete(condition)}
    <div class="rounded-xl border p-3 space-y-3 {incomplete ? 'border-error/40' : 'border-outline-variant/20'}">
      <div class="flex items-end gap-2">
        <div class="flex-1 min-w-0">
          <label class="field-label" for="{idPrefix}-type-{index}">{m.giv_cond_type()}</label>
          <select
            id="{idPrefix}-type-{index}"
            value={condition.type}
            onchange={(e) => changeType(index, (e.currentTarget as HTMLSelectElement).value as ConditionType)}
            class="{fieldClass} cursor-pointer"
          >
            {#each CONDITION_TYPES as type}
              <option value={type}>{typeLabels[type]()}</option>
            {/each}
          </select>
        </div>
        <button
          type="button"
          class="p-2.5 rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
          aria-label={m.giv_cond_remove()}
          onclick={() => remove(index)}
        >
          <Papicon icon="trash" size={16} />
        </button>
      </div>

      {#if ROLE_TYPES.includes(condition.type)}
        <div>
          <span class="field-label">{m.giv_cond_roles()}</span>
          <MultiSelect
            id="{idPrefix}-roles-{index}"
            bind:values={condition.roleIds}
            options={roleOptions}
            accentClass="bg-primary/20 text-primary border-primary/40"
          />
        </div>
      {/if}

      {#if DAYS_TYPES.includes(condition.type)}
        <div>
          <label class="field-label" for="{idPrefix}-days-{index}">{m.giv_cond_days()}</label>
          <input id="{idPrefix}-days-{index}" type="number" min="1" max="3650" bind:value={condition.days} class={fieldClass} />
        </div>
      {/if}

      {#if MIN_TYPES.includes(condition.type)}
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="field-label" for="{idPrefix}-min-{index}">{m.giv_cond_min()}</label>
            <input id="{idPrefix}-min-{index}" type="number" min="1" bind:value={condition.min} class={fieldClass} />
          </div>
          {#if PERIOD_TYPES.includes(condition.type)}
            <div>
              <label class="field-label" for="{idPrefix}-period-{index}">{m.giv_cond_period()}</label>
              <select id="{idPrefix}-period-{index}" bind:value={condition.period} class="{fieldClass} cursor-pointer">
                {#each CONDITION_PERIODS as period}
                  <option value={period}>{periodLabels[period]()}</option>
                {/each}
              </select>
            </div>
          {/if}
        </div>
      {/if}

      {#if condition.type === 'booster'}
        <div>
          <label class="field-label" for="{idPrefix}-mode-{index}">{m.giv_cond_mode()}</label>
          <select id="{idPrefix}-mode-{index}" bind:value={condition.mode} class="{fieldClass} cursor-pointer">
            <option value="required">{m.giv_cond_mode_required()}</option>
            <option value="excluded">{m.giv_cond_mode_excluded()}</option>
          </select>
        </div>
      {/if}

      {#if TEXT_TYPES.includes(condition.type)}
        <div>
          <label class="field-label" for="{idPrefix}-text-{index}">{m.giv_cond_text()}</label>
          <input id="{idPrefix}-text-{index}" type="text" maxlength="64" bind:value={condition.text} class={fieldClass} />
        </div>
      {/if}

      {#if condition.type === 'in_guild'}
        <div>
          <label class="field-label" for="{idPrefix}-guild-{index}">{m.giv_cond_guild_id()}</label>
          <input id="{idPrefix}-guild-{index}" type="text" inputmode="numeric" bind:value={condition.guildId} class={fieldClass} />
          <p class="field-hint">{m.giv_cond_guild_hint()}</p>
        </div>
      {/if}

      <div>
        <label class="field-label" for="{idPrefix}-group-{index}">{m.giv_cond_group()}</label>
        <input
          id="{idPrefix}-group-{index}"
          type="text"
          maxlength="64"
          placeholder={m.giv_cond_group_ph()}
          bind:value={condition.group}
          class={fieldClass}
        />
      </div>

      {#if incomplete}
        <p class="text-2xs text-error">{m.giv_cond_incomplete()}</p>
      {/if}
    </div>
  {/each}

  <button
    type="button"
    class="inline-flex items-center gap-2 text-sm text-primary hover:underline cursor-pointer"
    onclick={add}
  >
    <Papicon icon="plus" size={16} />
    {m.giv_cond_add()}
  </button>
</div>
