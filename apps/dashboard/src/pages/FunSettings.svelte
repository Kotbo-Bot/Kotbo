<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import EmojiRiddleEditor from '../lib/components/fun/EmojiRiddleEditor.svelte';
  import {
    fetchFunConfig,
    fetchConfessions,
    updateFunConfig,
    resetCountingGame,
    resetGuessNumberGame,
    resetWordChainGame,
    resetEmojiRiddleGame
  } from '../lib/api';

  const actionState = createAsyncActionState();
  let loading = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.fun?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  let config = $state({
    funCountingChannelId: null as string | null,
    funOneWordStoryChannelId: null as string | null,
    funGuessNumberChannelId: null as string | null,
    funWordChainChannelId: null as string | null,
    funEmojiRiddleChannelId: null as string | null,
    funNeverSayChannelId: null as string | null,
    funEmojiOnlyChannelId: null as string | null,
    funImageOfDayChannelId: null as string | null,
    funConfessionChannelId: null as string | null,
    funConfessionLogChannelId: null as string | null,
    funPunitiveMode: true,
    funEmojiRiddleUseDefaults: true
  });

  let savedConfig = $state({
    funCountingChannelId: null as string | null,
    funOneWordStoryChannelId: null as string | null,
    funGuessNumberChannelId: null as string | null,
    funWordChainChannelId: null as string | null,
    funEmojiRiddleChannelId: null as string | null,
    funNeverSayChannelId: null as string | null,
    funEmojiOnlyChannelId: null as string | null,
    funImageOfDayChannelId: null as string | null,
    funConfessionChannelId: null as string | null,
    funConfessionLogChannelId: null as string | null,
    funPunitiveMode: true,
    funEmojiRiddleUseDefaults: true
  });

  let confessions = $state<{ number: number; content: string; createdAt: string; revealedAt: string | null }[]>([]);

  let gameState = $state({
    countingCurrent: 0,
    countingLastUserId: null as string | null,
    oneWordStoryLastUserId: null as string | null,
    guessNumberTarget: 0,
    wordChainLastWord: null as string | null,
    wordChainLastUserId: null as string | null,
    emojiRiddleEmojis: null as string | null
  });

  // Detect changes and register/deregister with the global bar
  $effect(() => {
    const current = JSON.stringify(config);
    const saved = JSON.stringify(savedConfig);
    const dirty = current !== saved;

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'fun-settings',
          label: m.fun_unsaved_label(),
          onSave: () => handleSave(),
          onReset: () => { config = { ...savedConfig }; }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('fun-settings');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('fun-settings');
  });

  function mapConfig(source: any) {
    return {
      funCountingChannelId: source.funCountingChannelId ?? null,
      funOneWordStoryChannelId: source.funOneWordStoryChannelId ?? null,
      funGuessNumberChannelId: source.funGuessNumberChannelId ?? null,
      funWordChainChannelId: source.funWordChainChannelId ?? null,
      funEmojiRiddleChannelId: source.funEmojiRiddleChannelId ?? null,
      funNeverSayChannelId: source.funNeverSayChannelId ?? null,
      funEmojiOnlyChannelId: source.funEmojiOnlyChannelId ?? null,
      funImageOfDayChannelId: source.funImageOfDayChannelId ?? null,
      funConfessionChannelId: source.funConfessionChannelId ?? null,
      funConfessionLogChannelId: source.funConfessionLogChannelId ?? null,
      funPunitiveMode: source.funPunitiveMode ?? true,
      funEmojiRiddleUseDefaults: source.funEmojiRiddleUseDefaults ?? true
    };
  }

  function mapGameState(source: any) {
    return {
      countingCurrent: source.countingCurrent ?? 0,
      countingLastUserId: source.countingLastUserId ?? null,
      oneWordStoryLastUserId: source.oneWordStoryLastUserId ?? null,
      guessNumberTarget: source.guessNumberTarget ?? 0,
      wordChainLastWord: source.wordChainLastWord ?? null,
      wordChainLastUserId: source.wordChainLastUserId ?? null,
      emojiRiddleEmojis: source.emojiRiddleEmojis ?? null
    };
  }

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const [res, confRes] = await Promise.all([fetchFunConfig(), fetchConfessions()]);
      confessions = confRes?.confessions ?? [];
      if (res && res.config) {
        const loaded = mapConfig(res.config);
        config = loaded;
        savedConfig = { ...loaded };
      }
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  async function handleSave(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await actionState.run(async () => {
      const res = await updateFunConfig(config);
      if (!res) throw new Error(m.fun_save_error());
      const saved = mapConfig(res.config);
      config = saved;
      savedConfig = { ...saved };

      if (res.gameState) {
        gameState = mapGameState(res.gameState);
      }

      success = true;
      return true;
    }, { successMessage: m.fun_save_success() });
    return success;
  }

  async function handleResetCounting() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_counting_confirm_title(), confirmLabel: m.fun_reset_counting_confirm_btn(), variant: 'warning' }))) return;

    await actionState.run(async () => {
      const res = await resetCountingGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_counting_toast() });
  }

  async function handleResetGuessNumber() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_guess_confirm_title(), confirmLabel: m.fun_reset_guess_confirm_btn() }))) return;

    await actionState.run(async () => {
      const res = await resetGuessNumberGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_guess_toast() });
  }

  async function handleResetWordChain() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_wordchain_confirm_title(), confirmLabel: m.fun_reset_wordchain_confirm_btn(), variant: 'warning' }))) return;

    await actionState.run(async () => {
      const res = await resetWordChainGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_wordchain_toast() });
  }

  async function handleResetEmojiRiddle() {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: m.fun_reset_emojiriddle_confirm_title(), confirmLabel: m.fun_reset_emojiriddle_confirm_btn() }))) return;

    await actionState.run(async () => {
      const res = await resetEmojiRiddleGame();
      if (res && res.gameState) {
        gameState = mapGameState(res.gameState);
      }
      return true;
    }, { successMessage: m.fun_reset_emojiriddle_toast() });
  }
</script>

<ModulePage
  title={m.fun_page_title()}
  description={m.fun_page_desc()}
  icon="Smile"
  featureKey="fun"
>
  <InlineFeedback state={actionState} />

  {#if !loading}
    <div class="flex items-center justify-between gap-4 rounded-xl bg-surface-container-low/40 border border-outline-variant/30 p-6 mb-8">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-on-surface">{m.fun_punitive_title()}</p>
        <p class="text-xs text-on-surface-variant mt-1">{m.fun_punitive_desc()}</p>
      </div>
      <ToggleSwitch
        checked={config.funPunitiveMode}
        disabled={!canManageSettings}
        onToggle={() => (config.funPunitiveMode = !config.funPunitiveMode)}
        ariaLabel={m.fun_punitive_title()}
      />
    </div>
  {/if}

  {#if loading}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <Skeleton height="320px" radius="2.5rem" />
      <Skeleton height="320px" radius="2.5rem" />
      <Skeleton height="320px" radius="2.5rem" />
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Counting Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-warning/10 text-warning flex items-center justify-center">
              <Papicon icon="Binary" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_counting_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_counting_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="countingChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="countingChannel"
              bind:value={config.funCountingChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-warning/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant">{m.fun_game_state_title()}</p>
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center">
                <span class="text-2xs text-on-surface-variant uppercase font-bold">{m.fun_counting_number()}</span>
                <p class="text-2xl font-semibold text-warning mt-0.5">{gameState.countingCurrent}</p>
              </div>
              <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center flex flex-col justify-center min-w-0">
                <span class="text-2xs text-on-surface-variant uppercase font-bold truncate">{m.fun_last_player()}</span>
                <p class="text-xs font-bold text-on-surface mt-1 truncate" title={gameState.countingLastUserId || m.fun_none()}>
                  {gameState.countingLastUserId ? m.fun_user_id({ id: gameState.countingLastUserId }) : m.fun_none()}
                </p>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetCounting}
          disabled={actionState.state.loading}
          use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
          class="w-full py-3.5 bg-warning/10 hover:bg-warning/20 text-warning rounded-lg text-body-sm font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_counting_btn()}
        </button>
      </section>

      <!-- One Word Story Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-500 flex items-center justify-center">
              <Papicon icon="BookOpen" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_oneword_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_oneword_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="oneWordStoryChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="oneWordStoryChannel"
              bind:value={config.funOneWordStoryChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-purple-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant">{m.fun_game_state_title()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center flex flex-col justify-center min-w-0">
              <span class="text-2xs text-on-surface-variant uppercase font-bold truncate">{m.fun_last_author()}</span>
              <p class="text-xs font-bold text-on-surface mt-1 truncate" title={gameState.oneWordStoryLastUserId || m.fun_none()}>
                {gameState.oneWordStoryLastUserId ? m.fun_user_id({ id: gameState.oneWordStoryLastUserId }) : m.fun_none()}
              </p>
            </div>
          </div>
        </div>

        <div class="text-2xs text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_oneword_hint()}
        </div>
      </section>

      <!-- Guess Number Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-success/10 text-success flex items-center justify-center">
              <Papicon icon="Gamepad2" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_guess_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_guess_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="guessNumberChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="guessNumberChannel"
              bind:value={config.funGuessNumberChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-success/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant">{m.fun_game_state_title()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center">
              <span class="text-2xs text-on-surface-variant uppercase font-bold">{m.fun_guess_target()}</span>
              <p class="text-2xl font-semibold text-success mt-0.5">{gameState.guessNumberTarget || '???'}</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetGuessNumber}
          disabled={actionState.state.loading}
          use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
          class="w-full py-3.5 bg-success/10 hover:bg-success/20 text-success rounded-lg text-body-sm font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_guess_btn()}
        </button>
      </section>

      <!-- Word Chain Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-500 flex items-center justify-center">
              <Papicon icon="Link" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_wordchain_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_wordchain_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="wordChainChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="wordChainChannel"
              bind:value={config.funWordChainChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-sky-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant">{m.fun_game_state_title()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center flex flex-col justify-center min-w-0">
              <span class="text-2xs text-on-surface-variant uppercase font-bold truncate">{m.fun_wordchain_last_word()}</span>
              <p class="text-lg font-semibold text-sky-500 mt-0.5 truncate">{gameState.wordChainLastWord || m.fun_none()}</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetWordChain}
          disabled={actionState.state.loading}
          use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
          class="w-full py-3.5 bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 rounded-lg text-body-sm font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_wordchain_btn()}
        </button>
      </section>

      <!-- Emoji Riddle Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-error/10 text-error flex items-center justify-center">
              <Papicon icon="Puzzle" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_emojiriddle_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_emojiriddle_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="emojiRiddleChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="emojiRiddleChannel"
              bind:value={config.funEmojiRiddleChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-error/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-2.5">
            <p class="text-xs font-medium text-on-surface-variant">{m.fun_emojiriddle_current_clue()}</p>
            <div class="bg-surface-container-high/40 p-3 rounded-xl border border-outline-variant/10 text-center">
              <p class="text-2xl mt-0.5">{gameState.emojiRiddleEmojis || '❓'}</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onclick={handleResetEmojiRiddle}
          disabled={actionState.state.loading}
          use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
          class="w-full py-3.5 bg-error/10 hover:bg-error/20 text-error rounded-lg text-body-sm font-medium transition-all duration-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-40"
        >
          <Papicon icon="refresh-cw" size={14} />
          {m.fun_reset_emojiriddle_btn()}
        </button>
      </section>

      <!-- Never Say Yes/No Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-orange-500/10 text-orange-500 flex items-center justify-center">
              <Papicon icon="MessageSquareOff" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_neversay_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_neversay_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="neverSayChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="neverSayChannel"
              bind:value={config.funNeverSayChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-orange-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        <div class="text-2xs text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_neversay_hint()}
        </div>
      </section>

      <!-- Emoji Only Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-teal-500/10 text-teal-500 flex items-center justify-center">
              <Papicon icon="Sticker" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_emojionly_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_emojionly_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="emojiOnlyChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="emojiOnlyChannel"
              bind:value={config.funEmojiOnlyChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-teal-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        <div class="text-2xs text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_emojionly_hint()}
        </div>
      </section>

      <!-- Image du jour Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-pink-500/10 text-pink-500 flex items-center justify-center">
              <Papicon icon="Image" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_imageofday_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_imageofday_subtitle()}</p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="imageOfDayChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
            <SearchableSelect
              id="imageOfDayChannel"
              bind:value={config.funImageOfDayChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.fun_no_channel()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-pink-500/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        <div class="text-2xs text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_imageofday_hint()}
        </div>
      </section>

      <!-- Confessions Card -->
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-8 rounded-xl flex flex-col justify-between gap-6 hover:bg-surface-container-low/60 transition-all duration-300 md:col-span-2">
        <div class="space-y-4">
          <div class="flex items-center gap-3 pb-3 border-b border-outline-variant/15">
            <div class="w-10 h-10 rounded-xl bg-violet-500/10 text-violet-500 flex items-center justify-center">
              <Papicon icon="MessageCircle" size={20} />
            </div>
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-on-surface">{m.fun_confession_title()}</h3>
              <p class="text-xs text-on-surface-variant/55 font-semibold">{m.fun_confession_subtitle()}</p>
            </div>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <div class="space-y-1.5">
              <label for="confessionChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_channel_label()}</label>
              <SearchableSelect
                id="confessionChannel"
                bind:value={config.funConfessionChannelId}
                options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
                placeholder={m.fun_no_channel()}
                className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-violet-500/30 transition-all"
                disabled={!canManageSettings}
              />
            </div>
            <div class="space-y-1.5">
              <label for="confessionLogChannel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_confession_log_label()}</label>
              <SearchableSelect
                id="confessionLogChannel"
                bind:value={config.funConfessionLogChannelId}
                options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
                placeholder={m.fun_no_channel()}
                className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-violet-500/30 transition-all"
                disabled={!canManageSettings}
              />
            </div>
          </div>

          <div class="space-y-2">
            <h4 class="text-xs font-semibold text-on-surface-variant ml-2">{m.fun_confession_recent_title()}</h4>
            {#if confessions.length === 0}
              <p class="text-xs text-on-surface-variant/50 ml-2">{m.fun_confession_empty()}</p>
            {:else}
              <ul class="space-y-2 max-h-72 overflow-y-auto">
                {#each confessions as c (c.number)}
                  <li class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm">
                    <div class="flex items-center justify-between text-2xs text-on-surface-variant/55 font-semibold mb-1">
                      <span>#{c.number}</span>
                      <span>{new Date(c.createdAt).toLocaleString()}{c.revealedAt ? ` · ${m.fun_confession_revealed()}` : ''}</span>
                    </div>
                    <p class="text-on-surface whitespace-pre-wrap break-words">{c.content}</p>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>

        <div class="text-2xs text-on-surface-variant/40 italic text-center py-2 leading-relaxed font-medium">
          {m.fun_confession_hint()}
        </div>
      </section>
    </div>

    <EmojiRiddleEditor bind:useDefaults={config.funEmojiRiddleUseDefaults} canManage={canManageSettings} />
  {/if}
</ModulePage>
