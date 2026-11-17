<script lang="ts">
  import { onMount } from 'svelte';
  import { removeWithUndo } from '../../undoRemoval';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import Papicon from '../Papicon.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import EmojiPicker from '../EmojiPicker.svelte';
  import EmptyState from '../EmptyState.svelte';
  import Skeleton from '../Skeleton.svelte';
  import Button from '../ui/Button.svelte';
  import {
    fetchEmojiRiddles,
    createEmojiRiddle,
    updateEmojiRiddle,
    deleteEmojiRiddle,
  } from '../../api';

  type Riddle = { id: string; emojis: string; answers: string[] };

  const MAX_RIDDLES = 200;

  let {
    useDefaults = $bindable(true),
    canManage = false,
  }: {
    useDefaults: boolean;
    canManage?: boolean;
  } = $props();

  let riddles = $state<Riddle[]>([]);
  let defaults = $state<{ emojis: string; answers: string[] }[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let showDefaults = $state(false);

  /** Le formulaire reste replié tant qu'on n'ajoute ni ne modifie un rébus. */
  let formOpen = $state(false);
  let editingId = $state<string | null>(null);
  let emojisDraft = $state('');
  let answersDraft = $state('');
  let picked = $state('');

  const atLimit = $derived(!editingId && riddles.length >= MAX_RIDDLES);

  onMount(async () => {
    try {
      const res = await fetchEmojiRiddles();
      riddles = res?.riddles ?? [];
      defaults = res?.defaults ?? [];
    } catch {
      // Erreur déjà signalée par dashboardRequest.
    } finally {
      loading = false;
    }
  });

  // Le sélecteur n'expose qu'une valeur liée : on l'ajoute à la saisie puis on
  // la vide, pour que le même emoji puisse être choisi deux fois de suite.
  $effect(() => {
    if (!picked) return;
    const chosen = picked;
    picked = '';
    emojisDraft = `${emojisDraft}${chosen}`;
  });

  function parseAnswers(raw: string): string[] {
    return raw.split('\n').map((a) => a.trim()).filter(Boolean);
  }

  function resetForm() {
    formOpen = false;
    editingId = null;
    emojisDraft = '';
    answersDraft = '';
  }

  function openForm() {
    formOpen = true;
    // Le champ n'existe qu'une fois le formulaire affiché.
    queueMicrotask(() => document.getElementById('riddleEmojis')?.focus());
  }

  function startEdit(riddle: Riddle) {
    openForm();
    editingId = riddle.id;
    emojisDraft = riddle.emojis;
    answersDraft = riddle.answers.join('\n');
  }

  async function submit() {
    if (!canManage || busy) return;
    const payload = { emojis: emojisDraft.trim(), answers: parseAnswers(answersDraft) };
    if (!payload.emojis || payload.answers.length === 0) {
      toast.error(m.fun_riddles_error_incomplete());
      return;
    }

    busy = true;
    try {
      if (editingId) {
        const res = await updateEmojiRiddle(editingId, payload);
        riddles = riddles.map((r) => (r.id === res.riddle.id ? res.riddle : r));
      } else {
        const res = await createEmojiRiddle(payload);
        riddles = [...riddles, res.riddle];
      }
      // Après un ajout, le formulaire reste ouvert et vide pour enchaîner ; après une modification, il se replie.
      if (editingId) {
        resetForm();
      } else {
        emojisDraft = '';
        answersDraft = '';
        document.getElementById('riddleEmojis')?.focus();
      }
    } catch {
      // Erreur déjà signalée par dashboardRequest ; la saisie est conservée.
    } finally {
      busy = false;
    }
  }

  async function remove(riddle: Riddle) {
    if (!canManage || busy) return;
    if (editingId === riddle.id) resetForm();
    await removeWithUndo({
      get: () => riddles,
      set: (next) => (riddles = next),
      match: (r) => r.id === riddle.id,
      message: m.fun_riddles_deleted(),
      commit: () => deleteEmojiRiddle(riddle.id, undefined, { silent: true }),
    });
  }

  const CUSTOM_EMOJI_SPLIT = /(<a?:\w+:\d+>)/g;
  const CUSTOM_EMOJI_PARTS = /^<(a?):(\w+):(\d+)>$/;

  /** Les emojis du serveur sont stockés sous leur forme `<:nom:id>` : on les affiche en image. */
  function clueParts(emojis: string) {
    return emojis.split(CUSTOM_EMOJI_SPLIT).filter(Boolean).map((part) => {
      const custom = part.match(CUSTOM_EMOJI_PARTS);
      return custom
        ? { image: `https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'webp'}?size=48`, text: custom[2] }
        : { image: null, text: part };
    });
  }
</script>

{#snippet clue(emojis: string)}
  <span class="inline-flex items-center gap-0.5 text-2xl leading-none">
    {#each clueParts(emojis) as part}
      {#if part.image}
        <img src={part.image} alt={part.text} class="w-7 h-7" />
      {:else}
        <span>{part.text}</span>
      {/if}
    {/each}
  </span>
{/snippet}

<section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
  <div class="flex flex-wrap items-start justify-between gap-3 border-b border-outline-variant/15 pb-3">
    <div class="min-w-0">
      <h3 class="text-lg font-semibold flex items-center gap-2">
        <Papicon icon="Puzzle" size={18} />
        {m.fun_riddles_title()}
        <span class="text-xs font-medium text-on-surface-variant">{m.fun_riddles_count({ count: riddles.length, max: MAX_RIDDLES })}</span>
      </h3>
      <p class="text-xs text-on-surface-variant mt-1">{m.fun_riddles_desc()}</p>
    </div>
    {#if canManage && !formOpen && riddles.length > 0}
      <Button size="sm" variant="primary" icon="plus" disabled={atLimit} onclick={openForm}>{m.fun_riddles_add_open()}</Button>
    {/if}
  </div>

  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0">
      <p class="text-sm font-semibold text-on-surface">{m.fun_riddles_use_defaults_title()}</p>
      <p class="text-xs text-on-surface-variant">{m.fun_riddles_use_defaults_desc({ count: defaults.length })}</p>
    </div>
    <ToggleSwitch
      checked={useDefaults}
      disabled={!canManage}
      onToggle={() => (useDefaults = !useDefaults)}
      ariaLabel={m.fun_riddles_use_defaults_title()}
    />
  </div>

  {#if canManage && formOpen}
    <form
      class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-4 p-4 rounded-xl bg-surface-container-high/20 border border-outline-variant/10"
      onsubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <div>
        <label for="riddleEmojis" class="field-label">{m.fun_riddles_emojis_label()}</label>
        <div class="flex items-center gap-2">
          <input
            id="riddleEmojis"
            type="text"
            bind:value={emojisDraft}
            maxlength={100}
            placeholder={m.fun_riddles_emojis_placeholder()}
            disabled={busy}
            class="input flex-1 min-w-0 text-lg"
          />
          <EmojiPicker bind:value={picked} disabled={busy} />
        </div>
      </div>

      <div>
        <label for="riddleAnswers" class="field-label">{m.fun_riddles_answers_label()}</label>
        <textarea
          id="riddleAnswers"
          bind:value={answersDraft}
          rows={2}
          placeholder={m.fun_riddles_answers_placeholder()}
          disabled={busy}
          aria-describedby="riddleAnswersHint"
          class="input resize-y"
        ></textarea>
        <p id="riddleAnswersHint" class="field-hint">{m.fun_riddles_answers_hint()}</p>
      </div>

      <div class="md:col-span-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onclick={resetForm}>{m.common_cancel()}</Button>
        <Button size="sm" variant="primary" type="submit" loading={busy} disabled={atLimit}>
          {editingId ? m.common_save() : m.fun_riddles_add_btn()}
        </Button>
      </div>
    </form>
  {/if}

  {#if loading}
    <Skeleton height="48px" />
  {:else if riddles.length === 0}
    {#if !formOpen}
      <EmptyState icon="Puzzle" title={m.fun_riddles_empty_title()} description={m.fun_riddles_empty_desc()} actionLabel={canManage ? m.fun_riddles_empty_cta() : ''} actionIcon="plus" onAction={openForm} reason="read-only" />
    {/if}
  {:else}
    <ul class="divide-y divide-outline-variant/15">
      {#each riddles as riddle (riddle.id)}
        <li class="flex items-center gap-4 py-2.5 {editingId === riddle.id ? 'opacity-60' : ''}">
          <div class="shrink-0 min-w-24">{@render clue(riddle.emojis)}</div>
          <div class="flex-1 min-w-0 flex flex-wrap gap-1.5">
            {#each riddle.answers as answer}
              <span class="px-2 py-0.5 rounded-md bg-surface-container-high/50 text-xs text-on-surface truncate max-w-full">{answer}</span>
            {/each}
          </div>
          {#if canManage}
            <div class="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                icon="pencil"
                disabled={busy}
                aria-label={m.fun_riddles_edit_aria({ emojis: riddle.emojis })}
                onclick={() => startEdit(riddle)}
              />
              <Button
                size="sm"
                variant="ghost"
                icon="trash-2"
                class="text-error"
                disabled={busy}
                aria-label={m.fun_riddles_delete_aria({ emojis: riddle.emojis })}
                onclick={() => remove(riddle)}
              />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if defaults.length > 0}
    <div class="pt-2">
      <button
        type="button"
        class="text-xs font-medium text-on-surface-variant hover:text-on-surface flex items-center gap-1.5"
        onclick={() => (showDefaults = !showDefaults)}
        aria-expanded={showDefaults}
      >
        <Papicon icon={showDefaults ? 'chevron-down' : 'chevron-right'} size={12} />
        {m.fun_riddles_defaults_toggle({ count: defaults.length })}
      </button>
      {#if showDefaults}
        <ul class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 {useDefaults ? '' : 'opacity-50'}">
          {#each defaults as riddle}
            <li class="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-container-high/20">
              {@render clue(riddle.emojis)}
              <span class="text-xs text-on-surface-variant truncate">{riddle.answers[0]}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>
