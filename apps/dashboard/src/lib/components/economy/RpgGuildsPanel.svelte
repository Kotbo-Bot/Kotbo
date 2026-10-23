<script lang="ts">
  /**
   * Administration des guildes RPG.
   *
   * Le jeu ne laisse agir que le chef, et seulement sur sa guilde. Une guilde abandonnée,
   * au nom déplacé ou au trésor à corriger ne pouvait jusqu'ici se régler qu'en
   * réinitialisant toutes les guildes du serveur.
   */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import { dissolveRpgGuild, fetchRpgGuilds, removeRpgGuildMember, updateRpgGuild } from '../../api';
  import Papicon from '../Papicon.svelte';
  import EmojiPicker from '../EmojiPicker.svelte';
  import EmojiText from '../EmojiText.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';

  const {
    canManage = false,
    disabled = false,
    currencyName = '',
  }: { canManage?: boolean; disabled?: boolean; currencyName?: string } = $props();

  type Member = { userId: string; level: number; xp: number; displayName: string };
  type Building = { id: string; name: string; emoji: string; level: number; maxLevel: number; effect: string | null };
  type RpgGuild = {
    id: string;
    name: string;
    description: string | null;
    emoji: string;
    ownerId: string;
    ownerName: string;
    level: number;
    xp: number;
    treasury: number;
    capacity: number;
    members: Member[];
    buildings: Building[];
  };

  const actionState = createAsyncActionState();
  let guilds = $state<RpgGuild[]>([]);
  let loading = $state(true);
  let search = $state('');
  let expandedId = $state<string | null>(null);
  let editing = $state<{ id: string; name: string; description: string; emoji: string; treasury: number; ownerId: string; members: Member[] } | null>(null);

  const filtered = $derived(
    guilds.filter((rpgGuild) => rpgGuild.name.toLowerCase().includes(search.trim().toLowerCase())),
  );

  async function load() {
    loading = true;
    try {
      const res = await fetchRpgGuilds();
      if (res) guilds = res.guilds ?? [];
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openEdit(rpgGuild: RpgGuild) {
    editing = {
      id: rpgGuild.id,
      name: rpgGuild.name,
      description: rpgGuild.description ?? '',
      emoji: rpgGuild.emoji,
      treasury: rpgGuild.treasury,
      ownerId: rpgGuild.ownerId,
      members: rpgGuild.members,
    };
  }

  async function save() {
    if (!editing) return;
    const draft = editing;
    await actionState.run(async () => {
      await updateRpgGuild(draft.id, {
        name: draft.name,
        description: draft.description,
        emoji: draft.emoji,
        treasury: Number(draft.treasury),
        ownerId: draft.ownerId,
      });
      editing = null;
      await load();
      return true;
    });
  }

  async function kick(rpgGuild: RpgGuild, member: Member) {
    if (!(await confirmDialog.danger(m.eco_guilds_kick_confirm({ name: member.displayName, guild: rpgGuild.name }), '', m.eco_guilds_kick_btn()))) return;
    await actionState.run(async () => {
      await removeRpgGuildMember(rpgGuild.id, member.userId);
      await load();
      return true;
    });
  }

  async function dissolve(rpgGuild: RpgGuild) {
    const confirmed = await confirmDialog.ask({
      title: m.eco_guilds_dissolve_confirm({ name: rpgGuild.name }),
      description: m.eco_guilds_dissolve_confirm_desc({ members: rpgGuild.members.length, treasury: rpgGuild.treasury }),
      confirmLabel: m.eco_guilds_dissolve_btn(),
      variant: 'danger',
      requireInput: rpgGuild.name,
    });
    if (!confirmed) return;

    await actionState.run(async () => {
      await dissolveRpgGuild(rpgGuild.id);
      await load();
      return true;
    });
  }
</script>

<div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 transition-opacity duration-300 {disabled ? 'opacity-60' : ''}">
  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/15 pb-4">
    <div>
      <h3 class="text-lg font-semibold">{m.eco_guilds_title()}</h3>
      <p class="text-xs text-on-surface-variant mt-1 leading-relaxed max-w-2xl">{m.eco_guilds_desc()}</p>
    </div>
    <input
      type="search"
      placeholder={m.eco_guilds_search_ph()}
      bind:value={search}
      class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none w-full md:w-64"
    />
  </div>

  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="flex items-center justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  {:else if filtered.length === 0}
    <p class="text-center py-8 text-on-surface-variant italic text-xs">{m.eco_guilds_empty()}</p>
  {:else}
    <div class="space-y-3">
      {#each filtered as rpgGuild (rpgGuild.id)}
        <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl">
          <div class="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div class="flex items-center gap-3 min-w-0">
              <EmojiText value={rpgGuild.emoji} size="1.25rem" class="text-xl" />
              <div class="min-w-0">
                <h4 class="font-semibold text-sm truncate">{rpgGuild.name}</h4>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-on-surface-variant mt-0.5">
                  <span>{m.eco_guilds_level({ level: rpgGuild.level, xp: rpgGuild.xp })}</span>
                  <span>{m.eco_guilds_members({ count: rpgGuild.members.length, capacity: rpgGuild.capacity })}</span>
                  <span>{m.eco_guilds_treasury({ amount: rpgGuild.treasury, currency: currencyName })}</span>
                  <span class="flex items-center gap-1"><Papicon icon="Crown" size={11} /> {rpgGuild.ownerName}</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onclick={() => expandedId = expandedId === rpgGuild.id ? null : rpgGuild.id}
                class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5"
              >
                <Papicon icon="users" size={12} /> {expandedId === rpgGuild.id ? m.eco_guilds_hide_details() : m.eco_guilds_show_details()}
              </button>
              {#if canManage}
                <button
                  type="button"
                  onclick={() => openEdit(rpgGuild)}
                  disabled={disabled}
                  class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Papicon icon="edit" size={12} /> {m.eco_btn_edit()}
                </button>
                <button
                  type="button"
                  onclick={() => dissolve(rpgGuild)}
                  disabled={disabled}
                  class="px-3 py-1.5 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Papicon icon="trash" size={12} /> {m.eco_guilds_dissolve_btn()}
                </button>
              {/if}
            </div>
          </div>

          {#if expandedId === rpgGuild.id}
            <div class="border-t border-outline-variant/10 p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div class="space-y-2">
                <h5 class="text-xs font-semibold text-on-surface-variant">{m.eco_guilds_members_title()}</h5>
                {#if rpgGuild.description}
                  <p class="text-xs text-on-surface-variant italic">{rpgGuild.description}</p>
                {/if}
                <ul class="space-y-1">
                  {#each rpgGuild.members as member (member.userId)}
                    <li class="flex items-center justify-between gap-3 text-xs bg-surface-container-high/40 rounded-lg px-3 py-2">
                      <span class="flex items-center gap-2 min-w-0">
                        {#if member.userId === rpgGuild.ownerId}<Papicon icon="Crown" size={12} class="text-warning" />{/if}
                        <span class="truncate font-semibold">{member.displayName}</span>
                        <span class="text-on-surface-variant">{m.eco_player_level_xp({ level: member.level, xp: member.xp })}</span>
                      </span>
                      {#if canManage && member.userId !== rpgGuild.ownerId}
                        <button
                          type="button"
                          onclick={() => kick(rpgGuild, member)}
                          disabled={disabled}
                          aria-label={m.eco_guilds_kick_btn()}
                          title={m.eco_guilds_kick_btn()}
                          class="p-1.5 text-error/80 hover:bg-error/10 rounded-lg transition-all disabled:opacity-40"
                        >
                          <Papicon icon="UserMinus" size={13} />
                        </button>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </div>
              <div class="space-y-2">
                <h5 class="text-xs font-semibold text-on-surface-variant">{m.eco_guilds_village_title()}</h5>
                {#if rpgGuild.buildings.length === 0}
                  <p class="text-xs text-on-surface-variant italic">{m.eco_guilds_village_empty()}</p>
                {:else}
                  <ul class="space-y-1">
                    {#each rpgGuild.buildings as building (building.id)}
                      <li class="text-xs bg-surface-container-high/40 rounded-lg px-3 py-2">
                        <span class="font-semibold"><EmojiText value={building.emoji} /> {building.name}</span>
                        <span class="text-on-surface-variant ml-2">{m.eco_guilds_building_level({ level: building.level, max: building.maxLevel })}</span>
                        {#if building.effect}<div class="text-2xs text-on-surface-variant mt-0.5">{building.effect}</div>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if editing}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-lg space-y-6 animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{m.eco_guilds_modal_edit()}</h3>

      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2 space-y-1">
          <label for="guildName" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_guilds_field_name()}</label>
          <input id="guildName" type="text" maxlength="32" bind:value={editing.name} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="guildEmoji" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_guilds_field_emoji()}</label>
          <div class="flex gap-2">
            <input id="guildEmoji" type="text" bind:value={editing.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
            <EmojiPicker bind:value={editing.emoji} />
          </div>
        </div>
      </div>

      <div class="space-y-1">
        <label for="guildDesc" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_guilds_field_description()}</label>
        <textarea id="guildDesc" maxlength="300" bind:value={editing.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none h-16 resize-none"></textarea>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="guildTreasury" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_guilds_field_treasury({ currency: currencyName })}</label>
          <input id="guildTreasury" type="number" min="0" bind:value={editing.treasury} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
        </div>
        <div class="space-y-1">
          <label for="guildOwner" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_guilds_field_owner()}</label>
          <select id="guildOwner" bind:value={editing.ownerId} class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none text-on-surface">
            {#each editing.members as member (member.userId)}
              <option value={member.userId}>{member.displayName}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
        <button
          type="button"
          onclick={() => editing = null}
          class="px-5 py-2.5 bg-outline-variant/10 hover:bg-outline-variant/20 rounded-xl text-xs font-bold transition-all"
        >
          {m.eco_btn_cancel()}
        </button>
        <button
          type="button"
          onclick={save}
          disabled={actionState.state.loading}
          class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50"
        >
          {m.eco_btn_save()}
        </button>
      </div>
    </div>
  </div>
{/if}
