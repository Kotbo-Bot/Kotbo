<script lang="ts">
  /**
   * Donjons du RPG : suites de boss du bestiaire, à enchaîner sans repos.
   *
   * Les étages désignent leur boss par son nom, comme le reste du bestiaire. Un boss
   * désactivé dans le bestiaire reste jouable ici : c'est ainsi qu'on réserve un boss à un
   * donjon. Un boss supprimé ou redevenu monstre ordinaire ferme le donjon jusqu'à ce qu'on
   * remplace son étage.
   */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import {
    deleteRpgDungeon,
    fetchRpgDungeons,
    fetchRpgItems,
    fetchRpgTitles,
    resetRpgDungeonFirstClear,
    saveRpgDungeon,
    setRpgDungeonEnabled,
  } from '../../api';
  import Papicon from '../Papicon.svelte';
  import EmojiPicker from '../EmojiPicker.svelte';
  import EmojiText from '../EmojiText.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';

  const { canManage = false, disabled = false, currencyName = '' }: { canManage?: boolean; disabled?: boolean; currencyName?: string } = $props();

  type Floor = { bossName: string; found: boolean; emoji: string | null; level: number | null; bossEnabled: boolean | null };
  type Dungeon = {
    id: string;
    name: string;
    description: string;
    emoji: string;
    levelRequired: number;
    energyCost: number;
    cooldownHours: number;
    bossNames: string[];
    completionCoins: number;
    completionXp: number;
    completionItemName: string | null;
    completionTitleId: string | null;
    completionRoleId: string | null;
    firstClearCoins: number;
    firstClearXp: number;
    firstClearItemName: string | null;
    firstClearTitleId: string | null;
    firstClearRoleId: string | null;
    enabled: boolean;
    floors: Floor[];
    runs: number;
    completions: number;
    defeats: number;
    completionTitle: { name: string } | null;
    firstClearTitle: { name: string } | null;
    firstClear: { userId: string; displayName: string | null; at: string | null } | null;
  };
  type Boss = {
    name: string;
    emoji: string;
    level: number;
    health: number;
    attack: number;
    defense: number;
    speed: number;
    xpReward: number;
    coinReward: number;
    enabled: boolean;
  };
  type Draft = {
    id?: string;
    name: string;
    description: string;
    emoji: string;
    levelRequired: number;
    energyCost: number;
    cooldownHours: number;
    bossNames: string[];
    completionCoins: number;
    completionXp: number;
    completionItemName: string | null;
    completionTitleId: string | null;
    completionRoleId: string | null;
    firstClearCoins: number;
    firstClearXp: number;
    firstClearItemName: string | null;
    firstClearTitleId: string | null;
    firstClearRoleId: string | null;
    /** Section du premier vainqueur ouverte. Fermée, le donjon n'a pas de prime. */
    firstClearOn: boolean;
    enabled: boolean;
  };

  const actionState = createAsyncActionState();
  let dungeons = $state<Dungeon[]>([]);
  let bosses = $state<Boss[]>([]);
  let limits = $state({ floorsMax: 10, dungeonsMax: 20 });
  let loading = $state(true);
  let items = $state<{ name: string; emoji: string; guildId: string | null }[]>([]);
  let titles = $state<{ id: string; name: string }[]>([]);
  let editing = $state<Draft | null>(null);
  // Le sélecteur d'ajout garde sa dernière valeur : le recréer le remet à vide.
  let addFloorKey = $state(0);

  const bossByName = $derived(new Map(bosses.map((boss) => [boss.name, boss])));
  const bossOptions = $derived(bosses.map((boss) => ({
    id: boss.name,
    name: `${boss.emoji} ${boss.name} · ${m.eco_dungeon_level_short({ level: boss.level })}${boss.enabled ? '' : ` · ${m.eco_dungeon_boss_exclusive()}`}`,
  })));
  const roles = $derived((dashboardStore.state.discordRoles || []).map((role: any) => ({ id: role.id, name: `@${role.name}` })));
  const titleOptions = $derived(titles.map((title) => ({ id: title.id, name: title.name })));
  const itemOptions = $derived.by(() => {
    const byName = new Map<string, { name: string; emoji: string; guildId: string | null }>();
    for (const item of items) {
      if (!byName.has(item.name) || item.guildId) byName.set(item.name, item);
    }
    return [...byName.values()].map((item) => ({ id: item.name, name: `${item.emoji} ${item.name}` }));
  });

  // Ce que les boss rapportent au minimum sur une partie complète, coffre compris : l'aléa
  // et le butin ne font qu'ajouter.
  const draftTotals = $derived.by(() => {
    if (!editing) return null;
    const floors = editing.bossNames.map((name) => bossByName.get(name)).filter((boss): boss is Boss => !!boss);
    return {
      xp: floors.reduce((sum, boss) => sum + boss.xpReward, 0) + (Number(editing.completionXp) || 0),
      coins: floors.reduce((sum, boss) => sum + boss.coinReward, 0) + (Number(editing.completionCoins) || 0),
      health: floors.reduce((sum, boss) => sum + boss.health, 0),
      topLevel: floors.reduce((max, boss) => Math.max(max, boss.level), 0),
    };
  });

  async function load() {
    loading = true;
    try {
      const res = await fetchRpgDungeons();
      if (res) {
        dungeons = res.dungeons ?? [];
        bosses = res.bosses ?? [];
        if (res.limits) limits = res.limits;
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

  function roleName(roleId: string | null): string | null {
    return roleId ? roles.find((role) => role.id === roleId)?.name ?? roleId : null;
  }

  onMount(() => {
    void load();
    void loadReferences();
  });

  function openNew() {
    editing = {
      name: '',
      description: '',
      emoji: '🏰',
      levelRequired: 1,
      energyCost: 40,
      cooldownHours: 24,
      bossNames: [],
      completionCoins: 0,
      completionXp: 0,
      completionItemName: null,
      completionTitleId: null,
      completionRoleId: null,
      firstClearCoins: 0,
      firstClearXp: 0,
      firstClearItemName: null,
      firstClearTitleId: null,
      firstClearRoleId: null,
      firstClearOn: false,
      enabled: true,
    };
  }

  function openEdit(dungeon: Dungeon) {
    editing = {
      id: dungeon.id,
      name: dungeon.name,
      description: dungeon.description,
      emoji: dungeon.emoji,
      levelRequired: dungeon.levelRequired,
      energyCost: dungeon.energyCost,
      cooldownHours: dungeon.cooldownHours,
      bossNames: [...dungeon.bossNames],
      completionCoins: dungeon.completionCoins,
      completionXp: dungeon.completionXp,
      completionItemName: dungeon.completionItemName,
      completionTitleId: dungeon.completionTitleId,
      completionRoleId: dungeon.completionRoleId,
      firstClearCoins: dungeon.firstClearCoins,
      firstClearXp: dungeon.firstClearXp,
      firstClearItemName: dungeon.firstClearItemName,
      firstClearTitleId: dungeon.firstClearTitleId,
      firstClearRoleId: dungeon.firstClearRoleId,
      firstClearOn: dungeon.firstClearCoins > 0
        || dungeon.firstClearXp > 0
        || !!dungeon.firstClearItemName
        || !!dungeon.firstClearTitleId
        || !!dungeon.firstClearRoleId,
      enabled: dungeon.enabled,
    };
  }

  function addFloor(bossName: string | null) {
    if (!editing || !bossName || editing.bossNames.length >= limits.floorsMax) return;
    editing.bossNames = [...editing.bossNames, bossName];
    addFloorKey += 1;
  }

  function moveFloor(index: number, delta: number) {
    if (!editing) return;
    const target = index + delta;
    if (target < 0 || target >= editing.bossNames.length) return;
    const next = [...editing.bossNames];
    [next[index], next[target]] = [next[target], next[index]];
    editing.bossNames = next;
  }

  function removeFloor(index: number) {
    if (!editing) return;
    editing.bossNames = editing.bossNames.filter((_, i) => i !== index);
  }

  async function save() {
    if (!editing) return;
    const draft = editing;
    await actionState.run(async () => {
      await saveRpgDungeon({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        emoji: draft.emoji,
        levelRequired: Number(draft.levelRequired) || 1,
        energyCost: Number(draft.energyCost) || 0,
        cooldownHours: Number(draft.cooldownHours) || 0,
        bossNames: draft.bossNames,
        completionCoins: Number(draft.completionCoins) || 0,
        completionXp: Number(draft.completionXp) || 0,
        completionItemName: draft.completionItemName || null,
        completionTitleId: draft.completionTitleId || null,
        completionRoleId: draft.completionRoleId || null,
        // Section fermée : aucune prime, et donc aucune annonce à la première victoire.
        firstClearCoins: draft.firstClearOn ? Number(draft.firstClearCoins) || 0 : 0,
        firstClearXp: draft.firstClearOn ? Number(draft.firstClearXp) || 0 : 0,
        firstClearItemName: draft.firstClearOn ? draft.firstClearItemName || null : null,
        firstClearTitleId: draft.firstClearOn ? draft.firstClearTitleId || null : null,
        firstClearRoleId: draft.firstClearOn ? draft.firstClearRoleId || null : null,
        enabled: draft.enabled,
      });
      editing = null;
      await load();
      return true;
    });
  }

  async function toggle(dungeon: Dungeon, enabled: boolean) {
    await actionState.run(async () => {
      await setRpgDungeonEnabled(dungeon.id, enabled);
      await load();
      return true;
    });
  }

  async function resetFirstClear(dungeon: Dungeon) {
    const confirmed = await confirmDialog.ask({
      title: m.eco_dungeon_first_clear_reset_confirm(),
      description: m.eco_dungeon_first_clear_reset_confirm_desc(),
      confirmLabel: m.eco_dungeon_first_clear_reset_btn(),
      variant: 'warning',
    });
    if (!confirmed) return;
    await actionState.run(async () => {
      await resetRpgDungeonFirstClear(dungeon.id);
      await load();
      return true;
    });
  }

  async function remove(dungeon: Dungeon) {
    const confirmed = await confirmDialog.danger(m.eco_dungeon_delete_confirm({ name: dungeon.name }), m.eco_dungeon_delete_confirm_desc());
    if (!confirmed) return;
    await actionState.run(async () => {
      await deleteRpgDungeon(dungeon.id);
      await load();
      return true;
    });
  }
</script>

<div class="space-y-6 transition-opacity duration-300 {disabled ? 'opacity-60' : ''}">
  <InlineFeedback state={actionState} />

  <div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/15 pb-4">
      <div>
        <h3 class="text-lg font-semibold">{m.eco_dungeon_title()}</h3>
        <p class="text-xs text-on-surface-variant/60 mt-1 leading-relaxed max-w-2xl">{m.eco_dungeon_desc()}</p>
      </div>
      {#if canManage}
        <button
          type="button"
          onclick={openNew}
          disabled={disabled || dungeons.length >= limits.dungeonsMax || bosses.length === 0}
          class="px-4 py-2.5 bg-primary hover:bg-primary-hover text-on-primary text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Papicon icon="Plus" size={14} /> {m.eco_dungeon_new_btn()}
        </button>
      {/if}
    </div>

    {#if loading}
      <div class="flex items-center justify-center py-12">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    {:else if bosses.length === 0}
      <p class="text-xs text-on-surface-variant/60 italic">{m.eco_dungeon_no_boss()}</p>
    {:else if dungeons.length === 0}
      <p class="text-xs text-on-surface-variant/60 italic">{m.eco_dungeon_empty()}</p>
    {:else}
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {#each dungeons as dungeon (dungeon.id)}
          {@const broken = dungeon.floors.some((floor) => !floor.found)}
          <div class="bg-surface-container-high/30 border border-outline-variant/10 p-4 rounded-xl space-y-3 {dungeon.enabled ? '' : 'opacity-60'}">
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <EmojiText value={dungeon.emoji} size="1.25rem" class="text-xl" />
                <div class="min-w-0">
                  <p class="font-semibold text-sm truncate">{dungeon.name}</p>
                  {#if dungeon.description}
                    <p class="text-2xs text-on-surface-variant/60 line-clamp-2">{dungeon.description}</p>
                  {/if}
                </div>
              </div>
              {#if canManage}
                <ToggleSwitch
                  checked={dungeon.enabled}
                  disabled={disabled}
                  ariaLabel={m.eco_dungeon_toggle_aria()}
                  onToggle={(value: boolean) => toggle(dungeon, value)}
                />
              {/if}
            </div>

            {#if broken}
              <p class="text-2xs text-warning bg-warning/10 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <Papicon icon="AlertTriangle" size={12} /> {m.eco_dungeon_broken()}
              </p>
            {/if}

            <ol class="space-y-1">
              {#each dungeon.floors as floor, index}
                <li class="flex items-center gap-2 text-xs">
                  <span class="w-5 text-right text-on-surface-variant/50 font-mono">{index + 1}.</span>
                  {#if floor.found}
                    <EmojiText value={floor.emoji ?? ''} size="0.875rem" />
                    <span class="font-semibold truncate">{floor.bossName}</span>
                    <span class="text-on-surface-variant/50">{m.eco_dungeon_level_short({ level: floor.level ?? 0 })}</span>
                    {#if floor.bossEnabled === false}
                      <span class="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">{m.eco_dungeon_boss_exclusive()}</span>
                    {/if}
                  {:else}
                    <span class="text-warning font-semibold truncate">{m.eco_dungeon_floor_missing({ name: floor.bossName })}</span>
                  {/if}
                </li>
              {/each}
            </ol>

            <div class="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-on-surface-variant/70">
              <span class="flex items-center gap-1"><Papicon icon="lock" size={11} /> {m.eco_dungeon_level_short({ level: dungeon.levelRequired })}</span>
              <span class="flex items-center gap-1"><Papicon icon="zap" size={11} /> {dungeon.energyCost}</span>
              <span class="flex items-center gap-1"><Papicon icon="clock" size={11} /> {dungeon.cooldownHours > 0 ? m.eco_dungeon_cooldown_value({ hours: dungeon.cooldownHours }) : m.eco_dungeon_cooldown_none()}</span>
            </div>

            <div class="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
              <span class="text-on-surface-variant/60">{m.eco_dungeon_chest()}</span>
              {#if dungeon.completionCoins > 0}<span class="text-warning font-bold">+{dungeon.completionCoins} {currencyName}</span>{/if}
              {#if dungeon.completionXp > 0}<span class="text-sky-400 font-bold">+{dungeon.completionXp} {m.eco_dungeon_rpg_xp()}</span>{/if}
              {#if dungeon.completionItemName}<span class="font-semibold flex items-center gap-1"><Papicon icon="package" size={11} /> {dungeon.completionItemName}</span>{/if}
              {#if dungeon.completionTitle}<span class="font-semibold text-amber-300 flex items-center gap-1"><Papicon icon="award" size={11} /> {dungeon.completionTitle.name}</span>{/if}
              {#if dungeon.completionRoleId}<span class="font-semibold text-primary">{roleName(dungeon.completionRoleId)}</span>{/if}
              {#if !dungeon.completionCoins && !dungeon.completionXp && !dungeon.completionItemName && !dungeon.completionTitle && !dungeon.completionRoleId}
                <span class="text-on-surface-variant/50 italic">{m.eco_dungeon_chest_empty()}</span>
              {/if}
            </div>

            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
              <span class="text-on-surface-variant/60">{m.eco_dungeon_first_clear()}</span>
              {#if dungeon.firstClear}
                <span class="font-semibold flex items-center gap-1"><Papicon icon="Trophy" size={11} /> {dungeon.firstClear.displayName ?? dungeon.firstClear.userId}</span>
                {#if canManage}
                  <button
                    type="button"
                    onclick={() => resetFirstClear(dungeon)}
                    disabled={disabled}
                    class="px-2 py-0.5 bg-outline-variant/10 hover:bg-outline-variant/25 rounded-md font-bold transition-all flex items-center gap-1 disabled:opacity-50"
                  >
                    <Papicon icon="RotateCcw" size={10} /> {m.eco_dungeon_first_clear_reset_btn()}
                  </button>
                {/if}
              {:else}
                {#if dungeon.firstClearCoins > 0}<span class="text-warning font-bold">+{dungeon.firstClearCoins} {currencyName}</span>{/if}
                {#if dungeon.firstClearXp > 0}<span class="text-sky-400 font-bold">+{dungeon.firstClearXp} {m.eco_dungeon_rpg_xp()}</span>{/if}
                {#if dungeon.firstClearItemName}<span class="font-semibold flex items-center gap-1"><Papicon icon="package" size={11} /> {dungeon.firstClearItemName}</span>{/if}
                {#if dungeon.firstClearTitle}<span class="font-semibold text-amber-300 flex items-center gap-1"><Papicon icon="award" size={11} /> {dungeon.firstClearTitle.name}</span>{/if}
                {#if dungeon.firstClearRoleId}<span class="font-semibold text-primary">{roleName(dungeon.firstClearRoleId)}</span>{/if}
                {#if !dungeon.firstClearCoins && !dungeon.firstClearXp && !dungeon.firstClearItemName && !dungeon.firstClearTitle && !dungeon.firstClearRoleId}
                  <span class="text-on-surface-variant/50 italic">{m.eco_dungeon_first_clear_none()}</span>
                {/if}
              {/if}
            </div>

            <p class="text-2xs text-on-surface-variant/50">
              {m.eco_dungeon_stats({ runs: dungeon.runs, completions: dungeon.completions, defeats: dungeon.defeats })}
            </p>

            {#if canManage}
              <div class="flex items-center justify-end gap-2 pt-2 border-t border-outline-variant/5">
                <button
                  type="button"
                  onclick={() => openEdit(dungeon)}
                  disabled={disabled}
                  class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Papicon icon="edit" size={12} /> {m.eco_btn_edit()}
                </button>
                <button
                  type="button"
                  onclick={() => remove(dungeon)}
                  disabled={disabled}
                  class="px-3 py-1.5 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Papicon icon="trash" size={12} /> {m.eco_dungeon_delete_btn()}
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if editing}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-2xl space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{editing.id ? m.eco_dungeon_modal_edit() : m.eco_dungeon_modal_new()}</h3>

      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2 space-y-1">
          <label for="dungeonName" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_dungeon_field_name()}</label>
          <input id="dungeonName" type="text" maxlength="50" bind:value={editing.name} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="dungeonEmoji" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_item_emoji()}</label>
          <div class="flex gap-2">
            <input id="dungeonEmoji" type="text" bind:value={editing.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
            <EmojiPicker bind:value={editing.emoji} />
          </div>
        </div>
        <div class="col-span-3 space-y-1">
          <label for="dungeonDescription" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_dungeon_field_description()}</label>
          <textarea id="dungeonDescription" rows="2" maxlength="300" bind:value={editing.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none resize-none"></textarea>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div class="space-y-1">
          <label for="dungeonLevel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_dungeon_field_level()}</label>
          <input id="dungeonLevel" type="number" min="1" bind:value={editing.levelRequired} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="dungeonEnergy" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_dungeon_field_energy()}</label>
          <input id="dungeonEnergy" type="number" min="0" bind:value={editing.energyCost} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="dungeonCooldown" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_dungeon_field_cooldown()}</label>
          <input id="dungeonCooldown" type="number" min="0" max="720" bind:value={editing.cooldownHours} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
        </div>
      </div>
      <p class="text-2xs text-on-surface-variant/50 leading-relaxed -mt-3">{m.eco_dungeon_field_cooldown_hint()}</p>

      <div class="space-y-3 pt-2 border-t border-outline-variant/5">
        <div>
          <h4 class="text-sm font-bold">{m.eco_dungeon_floors_title({ count: editing.bossNames.length, max: limits.floorsMax })}</h4>
          <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_dungeon_floors_hint()}</p>
        </div>

        {#if editing.bossNames.length === 0}
          <p class="text-2xs text-on-surface-variant/50 italic">{m.eco_dungeon_floors_empty()}</p>
        {:else}
          <ol class="space-y-1.5">
            {#each editing.bossNames as bossName, index (`${index}:${bossName}`)}
              {@const boss = bossByName.get(bossName)}
              <li class="flex items-center gap-2 bg-surface-container-high/30 border border-outline-variant/10 rounded-lg px-3 py-2">
                <span class="w-5 text-right text-xs text-on-surface-variant/50 font-mono">{index + 1}.</span>
                <div class="flex-1 min-w-0 flex items-center gap-2 text-xs">
                  {#if boss}
                    <EmojiText value={boss.emoji} size="0.875rem" />
                    <span class="font-semibold truncate">{boss.name}</span>
                    <span class="text-on-surface-variant/50 whitespace-nowrap">{m.eco_dungeon_level_short({ level: boss.level })} · {m.eco_dungeon_boss_hp({ hp: boss.health })}</span>
                    {#if !boss.enabled}
                      <span class="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary whitespace-nowrap">{m.eco_dungeon_boss_exclusive()}</span>
                    {/if}
                  {:else}
                    <span class="text-warning font-semibold truncate">{m.eco_dungeon_floor_missing({ name: bossName })}</span>
                  {/if}
                </div>
                <button type="button" onclick={() => moveFloor(index, -1)} disabled={index === 0} aria-label={m.eco_dungeon_floor_up()} class="p-1.5 rounded-lg hover:bg-outline-variant/20 disabled:opacity-30">
                  <Papicon icon="ArrowUp" size={12} />
                </button>
                <button type="button" onclick={() => moveFloor(index, 1)} disabled={index === editing.bossNames.length - 1} aria-label={m.eco_dungeon_floor_down()} class="p-1.5 rounded-lg hover:bg-outline-variant/20 disabled:opacity-30">
                  <Papicon icon="ArrowDown" size={12} />
                </button>
                <button type="button" onclick={() => removeFloor(index)} aria-label={m.eco_dungeon_floor_remove()} class="p-1.5 rounded-lg text-error hover:bg-error/10">
                  <Papicon icon="x" size={12} />
                </button>
              </li>
            {/each}
          </ol>
        {/if}

        {#if editing.bossNames.length < limits.floorsMax}
          {#key addFloorKey}
            <SearchableSelect
              value={null}
              options={bossOptions}
              placeholder={m.eco_dungeon_floor_add()}
              clearable={false}
              showId={false}
              className="w-full"
              on:change={(e: any) => addFloor(e.detail?.value ?? null)}
            />
          {/key}
        {/if}

        {#if draftTotals && editing.bossNames.length > 0}
          <p class="text-2xs text-on-surface-variant/60 leading-relaxed">
            {m.eco_dungeon_totals({ health: draftTotals.health, level: draftTotals.topLevel, xp: draftTotals.xp, coins: draftTotals.coins, currency: currencyName })}
          </p>
        {/if}
      </div>

      <div class="space-y-3 pt-2 border-t border-outline-variant/5">
        <div>
          <h4 class="text-sm font-bold">{m.eco_dungeon_chest()}</h4>
          <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_dungeon_chest_hint()}</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="dungeonCoins" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{currencyName || m.eco_fish_field_value()}</label>
            <input id="dungeonCoins" type="number" min="0" bind:value={editing.completionCoins} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="dungeonXp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_dungeon_rpg_xp()}</label>
            <input id="dungeonXp" type="number" min="0" bind:value={editing.completionXp} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="col-span-2 space-y-1">
            <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_fish_reward_item()}</span>
            <SearchableSelect
              value={editing.completionItemName || null}
              options={itemOptions}
              placeholder={m.eco_fish_reward_item_none()}
              clearable={true}
              showId={false}
              className="w-full"
              on:change={(e: any) => { if (editing) editing.completionItemName = e.detail?.value ?? null; }}
            />
          </div>
          <div class="space-y-1">
            <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_fish_reward_title()}</span>
            <SearchableSelect
              value={editing.completionTitleId || null}
              options={titleOptions}
              placeholder={titles.length > 0 ? m.eco_bestiary_title_none() : m.eco_bestiary_title_empty()}
              clearable={true}
              showId={false}
              className="w-full"
              on:change={(e: any) => { if (editing) editing.completionTitleId = e.detail?.value ?? null; }}
            />
          </div>
          <div class="space-y-1">
            <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_fish_reward_role()}</span>
            <SearchableSelect
              value={editing.completionRoleId || null}
              options={roles}
              placeholder={m.eco_fish_reward_role_none()}
              clearable={true}
              className="w-full"
              on:change={(e: any) => { if (editing) editing.completionRoleId = e.detail?.value ?? null; }}
            />
          </div>
        </div>
      </div>

      <div class="space-y-3 pt-2 border-t border-outline-variant/5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h4 class="text-sm font-bold">{m.eco_dungeon_first_clear()}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-0.5 leading-relaxed">{m.eco_dungeon_first_clear_hint()}</p>
          </div>
          <ToggleSwitch
            checked={editing.firstClearOn}
            ariaLabel={m.eco_dungeon_first_clear_toggle_aria()}
            onToggle={(value: boolean) => { if (editing) editing.firstClearOn = value; }}
          />
        </div>
        {#if editing.firstClearOn}
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="firstClearCoins" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{currencyName || m.eco_fish_field_value()}</label>
            <input id="firstClearCoins" type="number" min="0" bind:value={editing.firstClearCoins} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="space-y-1">
            <label for="firstClearXp" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_dungeon_rpg_xp()}</label>
            <input id="firstClearXp" type="number" min="0" bind:value={editing.firstClearXp} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs focus:outline-none" />
          </div>
          <div class="col-span-2 space-y-1">
            <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_fish_reward_item()}</span>
            <SearchableSelect
              value={editing.firstClearItemName || null}
              options={itemOptions}
              placeholder={m.eco_fish_reward_item_none()}
              clearable={true}
              showId={false}
              className="w-full"
              on:change={(e: any) => { if (editing) editing.firstClearItemName = e.detail?.value ?? null; }}
            />
          </div>
          <div class="space-y-1">
            <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_fish_reward_title()}</span>
            <SearchableSelect
              value={editing.firstClearTitleId || null}
              options={titleOptions}
              placeholder={titles.length > 0 ? m.eco_bestiary_title_none() : m.eco_bestiary_title_empty()}
              clearable={true}
              showId={false}
              className="w-full"
              on:change={(e: any) => { if (editing) editing.firstClearTitleId = e.detail?.value ?? null; }}
            />
          </div>
          <div class="space-y-1">
            <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_fish_reward_role()}</span>
            <SearchableSelect
              value={editing.firstClearRoleId || null}
              options={roles}
              placeholder={m.eco_fish_reward_role_none()}
              clearable={true}
              className="w-full"
              on:change={(e: any) => { if (editing) editing.firstClearRoleId = e.detail?.value ?? null; }}
            />
          </div>
        </div>
        <p class="text-2xs text-on-surface-variant/50 leading-relaxed">{m.eco_bestiary_first_kill_role_hint()}</p>
        {/if}
      </div>

      <div class="flex items-center justify-between pt-2 border-t border-outline-variant/5">
        <div>
          <h4 class="text-sm font-bold">{m.eco_dungeon_enabled_title()}</h4>
          <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.eco_dungeon_enabled_desc()}</p>
        </div>
        <ToggleSwitch checked={editing.enabled} onToggle={(value: boolean) => { if (editing) editing.enabled = value; }} />
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button type="button" onclick={() => editing = null} class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all">
          {m.eco_btn_cancel()}
        </button>
        <button
          type="button"
          onclick={save}
          disabled={actionState.state.loading || editing.bossNames.length === 0 || !editing.name.trim()}
          class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50"
        >
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}
