<script lang="ts">
  import { stripCustomEmoji } from '../../emojiParser';
  /**
   * Pêche du RPG : espèces du serveur et récompenses du carnet.
   *
   * Les espèces livrées de base ne se modifient pas : on en crée une version propre au
   * serveur, sous le même nom, que supprimer rétablit. Le nom est verrouillé parce que les
   * prises des joueurs y sont rattachées : le changer effacerait leur carnet.
   */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import {
    deleteRpgFish,
    fetchRpgFish,
    fetchRpgItems,
    fetchRpgTitles,
    resetRpgFishBookReward,
    saveRpgFish,
    saveRpgFishBookReward,
    setRpgFishEnabled,
  } from '../../api';
  import Papicon from '../Papicon.svelte';
  import EmojiPicker from '../EmojiPicker.svelte';
  import EmojiText from '../EmojiText.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';

  const { canManage = false, disabled = false, currencyName = '' }: { canManage?: boolean; disabled?: boolean; currencyName?: string } = $props();

  const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;
  type Rarity = (typeof RARITIES)[number];
  type Tier = Rarity | 'COMPLETE';

  type Fish = {
    key: string;
    id: string | null;
    name: string;
    emoji: string;
    rarity: Rarity;
    value: number;
    xp: number;
    enabled: boolean;
    scope: 'DEFAULT' | 'GUILD';
    overridesDefault: boolean;
    caught: number;
  };
  type Reward = {
    tier: Tier;
    coinReward: number;
    xpReward: number;
    clanPoints: number;
    itemName: string | null;
    roleId: string | null;
    titleId: string | null;
    custom: boolean;
    titleName: string | null;
  };

  const actionState = createAsyncActionState();
  let species = $state<Fish[]>([]);
  let rewards = $state<Reward[]>([]);
  let weights = $state<Record<string, number>>({});
  let loading = $state(true);
  let items = $state<{ name: string; emoji: string; guildId: string | null }[]>([]);
  let titles = $state<{ id: string; name: string }[]>([]);

  let editingFish = $state<{ key?: string; name: string; emoji: string; rarity: Rarity; value: number; xp: number; enabled: boolean; nameLocked: boolean } | null>(null);
  let editingReward = $state<{ tier: Tier; coinReward: number; xpReward: number; clanPoints: number; itemName: string | null; roleId: string | null; titleId: string | null } | null>(null);

  const roles = $derived((dashboardStore.state.discordRoles || []).map((role: any) => ({ id: role.id, name: `@${role.name}` })));
  const itemOptions = $derived.by(() => {
    const byName = new Map<string, { name: string; emoji: string; guildId: string | null }>();
    for (const item of items) {
      if (!byName.has(item.name) || item.guildId) byName.set(item.name, item);
    }
    return [...byName.values()].map((item) => ({ id: item.name, name: `${stripCustomEmoji(item.emoji)} ${item.name}` }));
  });
  const titleOptions = $derived(titles.map((title) => ({ id: title.id, name: title.name })));
  const byRarity = $derived(RARITIES.map((rarity) => ({ rarity, fish: species.filter((fish) => fish.rarity === rarity) })));

  // Chance réelle d'une rareté : son poids, rapporté aux raretés qui ont au moins une espèce active.
  const rarityChance = $derived.by(() => {
    const active = RARITIES.filter((rarity) => species.some((fish) => fish.rarity === rarity && fish.enabled));
    const total = active.reduce((sum, rarity) => sum + (weights[rarity] ?? 0), 0);
    return Object.fromEntries(RARITIES.map((rarity) => [rarity, active.includes(rarity) && total > 0 ? ((weights[rarity] ?? 0) / total) * 100 : 0]));
  });

  function rarityLabel(tier: Tier): string {
    switch (tier) {
      case 'COMMON': return m.eco_fish_rarity_common();
      case 'UNCOMMON': return m.eco_fish_rarity_uncommon();
      case 'RARE': return m.eco_fish_rarity_rare();
      case 'EPIC': return m.eco_fish_rarity_epic();
      case 'LEGENDARY': return m.eco_fish_rarity_legendary();
      default: return m.eco_fish_tier_complete();
    }
  }

  const RARITY_DOT: Record<Tier, string> = {
    COMMON: 'bg-slate-400',
    UNCOMMON: 'bg-emerald-400',
    RARE: 'bg-sky-400',
    EPIC: 'bg-purple-400',
    LEGENDARY: 'bg-amber-400',
    COMPLETE: 'bg-primary',
  };

  async function load() {
    loading = true;
    try {
      const res = await fetchRpgFish();
      if (res) {
        species = res.species ?? [];
        rewards = res.rewards ?? [];
        weights = res.rarityWeights ?? {};
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  async function loadReferences() {
    try {
      const [itemRes, titleRes] = await Promise.all([fetchRpgItems(), fetchRpgTitles()]);
      if (itemRes?.items) items = itemRes.items;
      if (titleRes?.titles) titles = titleRes.titles;
    } catch (err) {
      console.error(err);
    }
  }

  onMount(() => {
    void load();
    void loadReferences();
  });

  function openNewFish() {
    editingFish = { name: '', emoji: '🐟', rarity: 'COMMON', value: 10, xp: 5, enabled: true, nameLocked: false };
  }

  function openEditFish(fish: Fish) {
    editingFish = {
      key: fish.key,
      name: fish.name,
      emoji: fish.emoji,
      rarity: fish.rarity,
      value: fish.value,
      xp: fish.xp,
      enabled: fish.enabled,
      nameLocked: fish.scope === 'DEFAULT' || fish.overridesDefault,
    };
  }

  async function saveFish() {
    if (!editingFish) return;
    const draft = editingFish;
    await actionState.run(async () => {
      await saveRpgFish({
        key: draft.key,
        name: draft.name,
        emoji: draft.emoji,
        rarity: draft.rarity,
        value: Number(draft.value) || 0,
        xp: Number(draft.xp) || 0,
        enabled: draft.enabled,
      });
      editingFish = null;
      await load();
      return true;
    });
  }

  async function toggleFish(fish: Fish, enabled: boolean) {
    await actionState.run(async () => {
      await setRpgFishEnabled(fish.key, enabled);
      await load();
      return true;
    });
  }

  async function removeFish(fish: Fish) {
    const confirmed = fish.overridesDefault
      ? await confirmDialog.ask({ title: m.eco_fish_restore_confirm(), description: m.eco_fish_restore_confirm_desc(), confirmLabel: m.eco_fish_restore_btn(), variant: 'warning' })
      : await confirmDialog.danger(m.eco_fish_delete_confirm({ name: fish.name }));
    if (!confirmed) return;

    await actionState.run(async () => {
      await deleteRpgFish(fish.key);
      await load();
      return true;
    });
  }

  function openEditReward(reward: Reward) {
    editingReward = {
      tier: reward.tier,
      coinReward: reward.coinReward,
      xpReward: reward.xpReward,
      clanPoints: reward.clanPoints,
      itemName: reward.itemName,
      roleId: reward.roleId,
      titleId: reward.titleId,
    };
  }

  async function saveReward() {
    if (!editingReward) return;
    const draft = editingReward;
    await actionState.run(async () => {
      await saveRpgFishBookReward(draft.tier, {
        coinReward: Number(draft.coinReward) || 0,
        xpReward: Number(draft.xpReward) || 0,
        clanPoints: Number(draft.clanPoints) || 0,
        itemName: draft.itemName || null,
        roleId: draft.roleId || null,
        titleId: draft.titleId || null,
      });
      editingReward = null;
      await load();
      return true;
    });
  }

  async function resetReward(reward: Reward) {
    const confirmed = await confirmDialog.ask({
      title: m.eco_fish_reward_reset_confirm(),
      description: m.eco_fish_reward_reset_confirm_desc(),
      confirmLabel: m.eco_fish_reward_reset_btn(),
      variant: 'warning',
    });
    if (!confirmed) return;
    await actionState.run(async () => {
      await resetRpgFishBookReward(reward.tier);
      await load();
      return true;
    });
  }

  function roleName(roleId: string | null): string | null {
    return roleId ? roles.find((role) => role.id === roleId)?.name ?? roleId : null;
  }
</script>

<div class="space-y-6 transition-opacity duration-300 {disabled ? 'opacity-60' : ''}">
  <InlineFeedback state={actionState} />

  <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/15 pb-4">
      <div>
        <h3 class="text-lg font-semibold">{m.eco_fish_title()}</h3>
        <p class="text-xs text-on-surface-variant mt-1 leading-relaxed max-w-2xl">{m.eco_fish_desc()}</p>
      </div>
      {#if canManage}
        <button
          type="button"
          onclick={openNewFish}
          disabled={disabled}
          class="px-4 py-2.5 bg-primary hover:bg-primary-hover text-on-primary text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Papicon icon="Plus" size={14} /> {m.eco_fish_new_btn()}
        </button>
      {/if}
    </div>

    {#if loading}
      <div class="flex items-center justify-center py-12">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    {:else}
      {#each byRarity as group (group.rarity)}
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full {RARITY_DOT[group.rarity]}"></span>
            <h4 class="text-sm font-semibold">{rarityLabel(group.rarity)}</h4>
            <span class="text-2xs text-on-surface-variant">{m.eco_fish_rarity_chance({ chance: rarityChance[group.rarity].toFixed(rarityChance[group.rarity] < 10 ? 1 : 0) })}</span>
          </div>
          {#if group.fish.length === 0}
            <p class="text-2xs text-on-surface-variant italic">{m.eco_fish_rarity_empty()}</p>
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {#each group.fish as fish (fish.key)}
                <div class="bg-surface-container-high/30 border border-outline-variant/10 p-4 rounded-xl space-y-3 {fish.enabled ? '' : 'opacity-60'}">
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex items-center gap-3 min-w-0">
                      <EmojiText value={fish.emoji} size="1.125rem" class="text-lg" />
                      <div class="min-w-0">
                        <p class="font-semibold text-sm truncate">{fish.name}</p>
                        <span class="text-xs font-semibold px-2 py-0.5 rounded-full inline-block mt-1 {fish.scope === 'DEFAULT' ? 'bg-outline-variant/15 text-on-surface-variant' : fish.overridesDefault ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary'}">
                          {fish.scope === 'DEFAULT' ? m.eco_fish_scope_default() : fish.overridesDefault ? m.eco_fish_scope_override() : m.eco_fish_scope_guild()}
                        </span>
                      </div>
                    </div>
                    {#if canManage}
                      <ToggleSwitch
                        checked={fish.enabled}
                        disabled={disabled}
                        ariaLabel={m.eco_fish_toggle_aria()}
                        onToggle={(value: boolean) => toggleFish(fish, value)}
                      />
                    {/if}
                  </div>

                  <div class="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
                    <span class="text-warning font-bold">+{fish.value} {currencyName}</span>
                    <span class="text-sky-400 font-bold">+{fish.xp} XP</span>
                    <span class="text-on-surface-variant">{m.eco_fish_caught({ count: fish.caught })}</span>
                  </div>

                  {#if canManage}
                    <div class="flex items-center justify-end gap-2 pt-2 border-t border-outline-variant/5">
                      <button
                        type="button"
                        onclick={() => openEditFish(fish)}
                        disabled={disabled}
                        class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Papicon icon="edit" size={12} /> {fish.scope === 'DEFAULT' ? m.eco_fish_customize_btn() : m.eco_btn_edit()}
                      </button>
                      {#if fish.scope === 'GUILD'}
                        <button
                          type="button"
                          onclick={() => removeFish(fish)}
                          disabled={disabled}
                          class="px-3 py-1.5 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Papicon icon={fish.overridesDefault ? 'RotateCcw' : 'trash'} size={12} />
                          {fish.overridesDefault ? m.eco_fish_restore_btn() : m.eco_fish_delete_btn()}
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
    <div class="border-b border-outline-variant/15 pb-4">
      <h3 class="text-lg font-semibold">{m.eco_fish_rewards_title()}</h3>
      <p class="text-xs text-on-surface-variant mt-1 leading-relaxed max-w-2xl">{m.eco_fish_rewards_desc()}</p>
    </div>

    {#if !loading}
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {#each rewards as reward (reward.tier)}
          <div class="bg-surface-container-high/30 border border-outline-variant/10 p-4 rounded-xl space-y-3">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full {RARITY_DOT[reward.tier]}"></span>
                <p class="font-semibold text-sm">{reward.tier === 'COMPLETE' ? m.eco_fish_tier_complete() : m.eco_fish_tier_rarity({ rarity: rarityLabel(reward.tier) })}</p>
              </div>
              <span class="text-xs font-semibold px-2 py-0.5 rounded-full {reward.custom ? 'bg-primary/10 text-primary' : 'bg-outline-variant/15 text-on-surface-variant'}">
                {reward.custom ? m.eco_fish_reward_custom() : m.eco_fish_reward_default()}
              </span>
            </div>

            <div class="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
              {#if reward.coinReward > 0}<span class="text-warning font-bold">+{reward.coinReward} {currencyName}</span>{/if}
              {#if reward.xpReward > 0}<span class="text-sky-400 font-bold">+{reward.xpReward} XP</span>{/if}
              {#if reward.clanPoints > 0}<span class="text-success font-bold flex items-center gap-1"><Papicon icon="Shield" size={11} /> +{reward.clanPoints}</span>{/if}
              {#if reward.itemName}<span class="font-semibold flex items-center gap-1"><Papicon icon="package" size={11} /> {reward.itemName}</span>{/if}
              {#if reward.titleName}<span class="font-semibold text-amber-300 flex items-center gap-1"><Papicon icon="award" size={11} /> {reward.titleName}</span>{/if}
              {#if reward.roleId}<span class="font-semibold text-primary">{roleName(reward.roleId)}</span>{/if}
              {#if !reward.coinReward && !reward.xpReward && !reward.clanPoints && !reward.itemName && !reward.titleName && !reward.roleId}
                <span class="text-on-surface-variant italic">{m.eco_fish_reward_none()}</span>
              {/if}
            </div>

            {#if canManage}
              <div class="flex items-center justify-end gap-2 pt-2 border-t border-outline-variant/5">
                <button
                  type="button"
                  onclick={() => openEditReward(reward)}
                  disabled={disabled}
                  class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Papicon icon="edit" size={12} /> {m.eco_btn_edit()}
                </button>
                {#if reward.custom}
                  <button
                    type="button"
                    onclick={() => resetReward(reward)}
                    disabled={disabled}
                    class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Papicon icon="RotateCcw" size={12} /> {m.eco_fish_reward_reset_btn()}
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if editingFish}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-lg space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{editingFish.key ? m.eco_fish_modal_edit() : m.eco_fish_modal_new()}</h3>

      {#if editingFish.nameLocked}
        <p class="text-2xs text-on-surface-variant bg-surface-container-high/40 rounded-lg px-3 py-2 leading-relaxed">{m.eco_fish_name_locked_hint()}</p>
      {:else if editingFish.key}
        <p class="text-2xs text-on-surface-variant bg-surface-container-high/40 rounded-lg px-3 py-2 leading-relaxed">{m.eco_fish_rename_hint()}</p>
      {/if}

      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2 space-y-1">
          <label for="fishName" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_fish_field_name()}</label>
          <input id="fishName" type="text" maxlength="40" disabled={editingFish.nameLocked} bind:value={editingFish.name} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none disabled:opacity-60" />
        </div>
        <div class="space-y-1">
          <label for="fishEmoji" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_item_emoji()}</label>
          <div class="flex gap-2">
            <input id="fishEmoji" type="text" bind:value={editingFish.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
            <EmojiPicker bind:value={editingFish.emoji} />
          </div>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div class="space-y-1">
          <label for="fishRarity" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_fish_field_rarity()}</label>
          <select id="fishRarity" bind:value={editingFish.rarity} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none">
            {#each RARITIES as rarity}
              <option value={rarity}>{rarityLabel(rarity)}</option>
            {/each}
          </select>
        </div>
        <div class="space-y-1">
          <label for="fishValue" class="text-xs font-semibold text-on-surface-variant ml-2">{currencyName || m.eco_fish_field_value()}</label>
          <input id="fishValue" type="number" min="0" bind:value={editingFish.value} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="fishXp" class="text-xs font-semibold text-on-surface-variant ml-2">XP</label>
          <input id="fishXp" type="number" min="0" bind:value={editingFish.xp} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
        </div>
      </div>

      <div class="flex items-center justify-between pt-2 border-t border-outline-variant/5">
        <div>
          <h4 class="text-sm font-bold">{m.eco_fish_enabled_title()}</h4>
          <p class="text-xs text-on-surface-variant mt-0.5">{m.eco_fish_enabled_desc()}</p>
        </div>
        <ToggleSwitch checked={editingFish.enabled} onToggle={(value: boolean) => { if (editingFish) editingFish.enabled = value; }} />
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button type="button" onclick={() => editingFish = null} class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all">
          {m.eco_btn_cancel()}
        </button>
        <button
          type="button"
          onclick={saveFish}
          disabled={actionState.state.loading}
          class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50"
        >
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if editingReward}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-lg space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{editingReward.tier === 'COMPLETE' ? m.eco_fish_tier_complete() : m.eco_fish_tier_rarity({ rarity: rarityLabel(editingReward.tier) })}</h3>
      <p class="text-2xs text-on-surface-variant leading-relaxed">{m.eco_fish_reward_modal_hint()}</p>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="rewardCoins" class="text-xs font-semibold text-on-surface-variant ml-2">{currencyName || m.eco_fish_field_value()}</label>
          <input id="rewardCoins" type="number" min="0" bind:value={editingReward.coinReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="rewardXp" class="text-xs font-semibold text-on-surface-variant ml-2">XP</label>
          <input id="rewardXp" type="number" min="0" bind:value={editingReward.xpReward} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="col-span-2 space-y-1">
          <label for="rewardClan" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_fish_reward_clan_points()}</label>
          <input id="rewardClan" type="number" min="0" bind:value={editingReward.clanPoints} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
          <p class="text-2xs text-on-surface-variant leading-relaxed mt-1">{m.eco_fish_reward_clan_points_hint()}</p>
        </div>
        <div class="col-span-2 space-y-1">
          <span class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_fish_reward_item()}</span>
          <SearchableSelect
            value={editingReward.itemName || null}
            options={itemOptions}
            placeholder={m.eco_fish_reward_item_none()}
            clearable={true}
            showId={false}
            className="w-full"
            on:change={(e: any) => { if (editingReward) editingReward.itemName = e.detail?.value ?? null; }}
          />
        </div>
        <div class="col-span-2 space-y-1">
          <span class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_fish_reward_role()}</span>
          <SearchableSelect
            value={editingReward.roleId || null}
            options={roles}
            placeholder={m.eco_fish_reward_role_none()}
            clearable={true}
            className="w-full"
            on:change={(e: any) => { if (editingReward) editingReward.roleId = e.detail?.value ?? null; }}
          />
          <p class="text-2xs text-on-surface-variant leading-relaxed mt-1">{m.eco_bestiary_first_kill_role_hint()}</p>
        </div>
        <div class="col-span-2 space-y-1">
          <span class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_fish_reward_title()}</span>
          <SearchableSelect
            value={editingReward.titleId || null}
            options={titleOptions}
            placeholder={titles.length > 0 ? m.eco_bestiary_title_none() : m.eco_bestiary_title_empty()}
            clearable={true}
            showId={false}
            className="w-full"
            on:change={(e: any) => { if (editingReward) editingReward.titleId = e.detail?.value ?? null; }}
          />
        </div>
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button type="button" onclick={() => editingReward = null} class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all">
          {m.eco_btn_cancel()}
        </button>
        <button
          type="button"
          onclick={saveReward}
          disabled={actionState.state.loading}
          class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50"
        >
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}
