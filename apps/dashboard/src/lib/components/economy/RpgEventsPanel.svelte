<script lang="ts">
  /**
   * Événements de voyage du RPG.
   *
   * Les événements livrés de base sont partagés par tous les serveurs : on ne les modifie
   * pas, on en crée une version propre au serveur, qui les remplace sous le même titre.
   * Supprimer cette version rétablit l'original.
   */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import { deleteRpgEvent, fetchRpgEvents, fetchRpgTitles, saveRpgEvent, setRpgEventEnabled } from '../../api';
  import Papicon from '../Papicon.svelte';
  import EmojiPicker from '../EmojiPicker.svelte';
  import EmojiText from '../EmojiText.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';

  const { canManage = false, disabled = false }: { canManage?: boolean; disabled?: boolean } = $props();

  type Choice = { text: string; hpEffect: number; coinEffect: number; xpEffect: number; minLevel: number; titleId: string | null };
  type AdventureEvent = {
    id: string;
    title: string;
    description: string;
    emoji: string;
    choices: Choice[];
    scope: 'GLOBAL' | 'GUILD';
    overridesGlobal: boolean;
    enabled: boolean;
  };

  const actionState = createAsyncActionState();
  let events = $state<AdventureEvent[]>([]);
  let loading = $state(true);
  let limits = $state({ titleMax: 100, descriptionMax: 1000, choicesMax: 5, choiceTextMax: 80 });
  // Titres du serveur, pour la récompense de titre d'un choix.
  let titles = $state<{ id: string; name: string; color: string }[]>([]);
  let editing = $state<(Omit<AdventureEvent, 'id' | 'scope' | 'overridesGlobal' | 'enabled'> & { id?: string; titleLocked: boolean }) | null>(null);

  const sorted = $derived(
    [...events].sort((a, b) => Number(b.scope === 'GUILD') - Number(a.scope === 'GUILD') || a.title.localeCompare(b.title)),
  );

  async function load() {
    loading = true;
    try {
      const res = await fetchRpgEvents();
      if (res) {
        events = res.events ?? [];
        if (res.limits) limits = res.limits;
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  async function loadTitles() {
    try {
      const res = await fetchRpgTitles();
      if (res) titles = res.titles ?? [];
    } catch (err) {
      console.error(err);
    }
  }

  onMount(() => {
    void load();
    void loadTitles();
  });

  function titleOf(titleId: string | null) {
    return titleId ? titles.find((title) => title.id === titleId) ?? null : null;
  }

  const blankChoice = (): Choice => ({ text: '', hpEffect: 0, coinEffect: 0, xpEffect: 10, minLevel: 0, titleId: null });

  function openNew() {
    editing = { title: '', description: '', emoji: '🌲', choices: [blankChoice()], titleLocked: false };
  }

  function openEdit(event: AdventureEvent) {
    // Une copie qui retire l'événement du tirage n'a aucun choix : on repart de ceux de
    // l'original pour que l'édition ne commence pas sur une fiche vide.
    editing = {
      id: event.id,
      title: event.title,
      description: event.description,
      emoji: event.emoji,
      choices: event.choices.length > 0 ? event.choices.map((choice) => ({ ...choice, titleId: choice.titleId ?? null })) : [blankChoice()],
      titleLocked: event.scope === 'GLOBAL' || event.overridesGlobal,
    };
  }

  function addChoice() {
    if (!editing || editing.choices.length >= limits.choicesMax) return;
    editing.choices = [...editing.choices, blankChoice()];
  }

  function removeChoice(index: number) {
    if (!editing || editing.choices.length <= 1) return;
    editing.choices = editing.choices.filter((_, i) => i !== index);
  }

  async function save() {
    if (!editing) return;
    const draft = editing;
    await actionState.run(async () => {
      await saveRpgEvent({
        id: draft.id,
        title: draft.title,
        description: draft.description,
        emoji: draft.emoji,
        choices: draft.choices.map((choice) => ({
          text: choice.text,
          hpEffect: Number(choice.hpEffect) || 0,
          coinEffect: Number(choice.coinEffect) || 0,
          xpEffect: Number(choice.xpEffect) || 0,
          minLevel: Number(choice.minLevel) || 0,
          titleId: choice.titleId || null,
        })),
      });
      editing = null;
      await load();
      return true;
    });
  }

  async function toggle(event: AdventureEvent, enabled: boolean) {
    await actionState.run(async () => {
      await setRpgEventEnabled(event.id, enabled);
      await load();
      return true;
    });
  }

  async function remove(event: AdventureEvent) {
    const confirmed = event.overridesGlobal
      ? await confirmDialog.ask({ title: m.eco_events_restore_confirm(), description: m.eco_events_restore_confirm_desc(), confirmLabel: m.eco_events_restore_btn(), variant: 'warning' })
      : await confirmDialog.danger(m.eco_events_delete_confirm({ title: event.title }));
    if (!confirmed) return;

    await actionState.run(async () => {
      await deleteRpgEvent(event.id);
      await load();
      return true;
    });
  }

  function effectLabel(value: number, unit: string): string {
    return `${value > 0 ? '+' : ''}${value} ${unit}`;
  }
</script>

<div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 transition-opacity duration-300 {disabled ? 'opacity-60' : ''}">
  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/15 pb-4">
    <div>
      <h3 class="text-lg font-semibold">{m.eco_events_title()}</h3>
      <p class="text-xs text-on-surface-variant mt-1 leading-relaxed max-w-2xl">{m.eco_events_desc()}</p>
    </div>
    {#if canManage}
      <button
        type="button"
        onclick={openNew}
        disabled={disabled}
        class="px-4 py-2.5 bg-primary hover:bg-primary-hover text-on-primary text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Papicon icon="Plus" size={14} /> {m.eco_events_new_btn()}
      </button>
    {/if}
  </div>

  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="flex items-center justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  {:else if sorted.length === 0}
    <p class="text-center py-8 text-on-surface-variant italic text-xs">{m.eco_events_empty()}</p>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {#each sorted as event (event.id)}
        <div class="bg-surface-container-high/30 border border-outline-variant/10 p-5 rounded-xl space-y-3 {event.enabled ? '' : 'opacity-60'}">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <EmojiText value={event.emoji} size="1.125rem" class="text-lg" />
              <div class="min-w-0">
                <h4 class="font-semibold text-sm truncate">{event.title}</h4>
                <span class="text-2xs font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full inline-block mt-1 {event.scope === 'GLOBAL' ? 'bg-outline-variant/15 text-on-surface-variant' : event.overridesGlobal ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary'}">
                  {event.scope === 'GLOBAL' ? m.eco_events_scope_global() : event.overridesGlobal ? (event.enabled ? m.eco_events_scope_override() : m.eco_events_scope_disabled()) : m.eco_events_scope_guild()}
                </span>
              </div>
            </div>
            {#if canManage && (event.scope === 'GLOBAL' || (event.overridesGlobal && !event.enabled))}
              <ToggleSwitch
                checked={event.enabled}
                disabled={disabled}
                ariaLabel={m.eco_events_toggle_aria()}
                onToggle={(value: boolean) => toggle(event, value)}
              />
            {/if}
          </div>

          <p class="text-xs text-on-surface-variant leading-relaxed">{event.description}</p>

          {#if event.choices.length > 0}
            <ul class="space-y-1.5">
              {#each event.choices as choice}
                <li class="text-2xs bg-surface-container-high/40 rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span class="font-semibold text-on-surface">{choice.text}</span>
                  {#if choice.hpEffect}<span class="{choice.hpEffect < 0 ? 'text-error' : 'text-success'} font-bold">{effectLabel(choice.hpEffect, m.eco_events_unit_hp())}</span>{/if}
                  {#if choice.coinEffect}<span class="{choice.coinEffect < 0 ? 'text-error' : 'text-warning'} font-bold">{effectLabel(choice.coinEffect, m.eco_events_unit_coins())}</span>{/if}
                  {#if choice.xpEffect}<span class="text-sky-400 font-bold">{effectLabel(choice.xpEffect, 'XP')}</span>{/if}
                  {#if choice.minLevel > 1}<span class="text-on-surface-variant">{m.eco_events_min_level({ level: choice.minLevel })}</span>{/if}
                  {#if titleOf(choice.titleId)}
                    <span class="font-bold flex items-center gap-1" style="color: {titleOf(choice.titleId)?.color}"><Papicon icon="award" size={11} /> {titleOf(choice.titleId)?.name}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-2xs text-warning/90 italic">{m.eco_events_disabled_hint()}</p>
          {/if}

          {#if canManage}
            <div class="flex items-center justify-end gap-2 pt-2 border-t border-outline-variant/5">
              <button
                type="button"
                onclick={() => openEdit(event)}
                disabled={disabled}
                class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Papicon icon="edit" size={12} /> {event.scope === 'GLOBAL' ? m.eco_events_customize_btn() : m.eco_btn_edit()}
              </button>
              {#if event.scope === 'GUILD'}
                <button
                  type="button"
                  onclick={() => remove(event)}
                  disabled={disabled}
                  class="px-3 py-1.5 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Papicon icon={event.overridesGlobal ? 'RotateCcw' : 'trash'} size={12} />
                  {event.overridesGlobal ? m.eco_events_restore_btn() : m.eco_events_delete_btn()}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if editing}
  <div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-8 w-full max-w-2xl space-y-6 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
      <h3 class="text-xl font-semibold">{editing.id ? m.eco_events_modal_edit() : m.eco_events_modal_new()}</h3>

      {#if editing.titleLocked}
        <p class="text-2xs text-on-surface-variant bg-surface-container-high/40 rounded-lg px-3 py-2 leading-relaxed">{m.eco_events_title_locked_hint()}</p>
      {/if}

      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2 space-y-1">
          <label for="eventTitle" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_events_field_title()}</label>
          <input id="eventTitle" type="text" maxlength={limits.titleMax} disabled={editing.titleLocked} bind:value={editing.title} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none disabled:opacity-60" />
        </div>
        <div class="space-y-1">
          <label for="eventEmoji" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_item_emoji()}</label>
          <div class="flex gap-2">
            <input id="eventEmoji" type="text" bind:value={editing.emoji} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none" />
            <EmojiPicker bind:value={editing.emoji} />
          </div>
        </div>
      </div>

      <div class="space-y-1">
        <label for="eventDesc" class="text-xs font-semibold text-on-surface-variant ml-2">{m.eco_events_field_description()}</label>
        <textarea id="eventDesc" maxlength={limits.descriptionMax} bind:value={editing.description} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs focus:outline-none h-20 resize-none"></textarea>
      </div>

      <fieldset class="border border-outline-variant/10 p-4 rounded-lg space-y-4">
        <legend class="text-xs font-semibold text-on-surface-variant px-2">{m.eco_events_choices_legend({ max: limits.choicesMax })}</legend>

        {#each editing.choices as choice, index}
          <div class="space-y-2 bg-surface-container-high/20 rounded-lg p-3">
            <div class="flex items-center gap-2">
              <input
                type="text"
                aria-label={m.eco_events_field_choice_text()}
                placeholder={m.eco_events_field_choice_text()}
                maxlength={limits.choiceTextMax}
                bind:value={choice.text}
                class="flex-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
              />
              <button
                type="button"
                onclick={() => removeChoice(index)}
                disabled={editing.choices.length <= 1}
                aria-label={m.eco_events_remove_choice()}
                class="p-2 text-error/80 hover:bg-error/10 rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Papicon icon="trash" size={13} />
              </button>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <label class="space-y-1 text-xs font-semibold text-on-surface-variant">
                {m.eco_events_field_hp()}
                <input type="number" bind:value={choice.hpEffect} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs font-normal normal-case tracking-normal focus:outline-none" />
              </label>
              <label class="space-y-1 text-xs font-semibold text-on-surface-variant">
                {m.eco_events_field_coins()}
                <input type="number" bind:value={choice.coinEffect} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs font-normal normal-case tracking-normal focus:outline-none" />
              </label>
              <label class="space-y-1 text-xs font-semibold text-on-surface-variant">
                XP
                <input type="number" min="0" bind:value={choice.xpEffect} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs font-normal normal-case tracking-normal focus:outline-none" />
              </label>
              <label class="space-y-1 text-xs font-semibold text-on-surface-variant">
                {m.eco_events_field_min_level()}
                <input type="number" min="0" bind:value={choice.minLevel} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs font-normal normal-case tracking-normal focus:outline-none" />
              </label>
            </div>
            <label class="block space-y-1 text-xs font-semibold text-on-surface-variant">
              {m.eco_events_field_reward_title()}
              <select bind:value={choice.titleId} class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs font-normal normal-case tracking-normal focus:outline-none">
                <option value={null}>{titles.length > 0 ? m.eco_bestiary_title_none() : m.eco_bestiary_title_empty()}</option>
                {#each titles as title (title.id)}
                  <option value={title.id}>{title.name}</option>
                {/each}
              </select>
            </label>
          </div>
        {/each}

        <button
          type="button"
          onclick={addChoice}
          disabled={editing.choices.length >= limits.choicesMax}
          class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Papicon icon="Plus" size={12} /> {m.eco_events_add_choice()}
        </button>
        <p class="text-2xs text-on-surface-variant leading-relaxed">{m.eco_events_effects_hint()}</p>
      </fieldset>

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
