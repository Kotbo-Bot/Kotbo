<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { FUN_GAMES, activeGameCount, gamesInGroup, type FunGame, type FunGameId } from '../lib/funGames';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import MemberName from '../lib/components/MemberName.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Field from '../lib/components/ui/Field.svelte';
  import Tabs, { type TabItem } from '../lib/components/ui/Tabs.svelte';
  import FunGameCard from '../lib/components/fun/FunGameCard.svelte';
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
    funConfessionCooldownSeconds: 60,
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
    funConfessionCooldownSeconds: 60,
    funPunitiveMode: true,
    funEmojiRiddleUseDefaults: true
  });

  let confessions = $state<{ number: number; content: string; createdAt: string; revealedAt: string | null; deletedAt: string | null }[]>([]);

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
      funConfessionCooldownSeconds: source.funConfessionCooldownSeconds ?? 60,
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
      // Un champ numérique vidé vaut null : on l'enregistre comme « aucun délai ».
      const res = await updateFunConfig({ ...config, funConfessionCooldownSeconds: config.funConfessionCooldownSeconds ?? 0 });
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

  /** Relance une partie après confirmation : comptage, nombre mystère, chaîne, rébus. */
  async function resetGame(
    id: FunGameId,
    reset: () => Promise<{ gameState?: unknown } | null | undefined>,
    texts: { title: string; confirm: string; toast: string },
    variant?: 'warning'
  ) {
    if (!canManageSettings) return;
    if (!(await confirmDialog.ask({ title: texts.title, confirmLabel: texts.confirm, variant }))) return;

    resetting = id;
    try {
      await actionState.run(async () => {
        const res = await reset();
        if (res && res.gameState) {
          gameState = mapGameState(res.gameState);
        }
        return true;
      }, { successMessage: texts.toast });
    } finally {
      resetting = null;
    }
  }

  let resetting = $state<FunGameId | null>(null);

  const resetCounting = () => resetGame('counting', resetCountingGame, {
    title: m.fun_reset_counting_confirm_title(), confirm: m.fun_reset_counting_confirm_btn(), toast: m.fun_reset_counting_toast()
  }, 'warning');
  const resetGuess = () => {
    guessRevealed = false;
    return resetGame('guess', resetGuessNumberGame, {
      title: m.fun_reset_guess_confirm_title(), confirm: m.fun_reset_guess_confirm_btn(), toast: m.fun_reset_guess_toast()
    });
  };
  const resetWordChain = () => resetGame('wordchain', resetWordChainGame, {
    title: m.fun_reset_wordchain_confirm_title(), confirm: m.fun_reset_wordchain_confirm_btn(), toast: m.fun_reset_wordchain_toast()
  }, 'warning');
  const resetEmojiRiddle = () => resetGame('emojiriddle', resetEmojiRiddleGame, {
    title: m.fun_reset_emojiriddle_confirm_title(), confirm: m.fun_reset_emojiriddle_confirm_btn(), toast: m.fun_reset_emojiriddle_toast()
  });

  type Tab = 'games' | 'confessions' | 'riddles';
  let activeTab = $state<Tab>('games');

  let tabsAnchor = $state<HTMLDivElement>();

  /** Depuis la carte Rébus, plus bas dans la page : l'onglet s'ouvre en haut, on y remonte. */
  function showRiddles() {
    activeTab = 'riddles';
    tabsAnchor?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /** La cible du nombre mystère reste cachée : une capture d'écran ne doit pas la livrer. */
  let guessRevealed = $state(false);

  const channelOptions = $derived(availableChannels.map((c) => ({ id: c.id, name: channelDisplayName(c) })));
  const activeCount = $derived(activeGameCount(config));
  const scoreGames = gamesInGroup('score');
  const ruleGames = gamesInGroup('rule');

  const tabItems = $derived<TabItem[]>([
    { id: 'games', label: m.fun_tab_games(), icon: 'Gamepad2', badge: `${activeCount}/${FUN_GAMES.length}` },
    { id: 'confessions', label: m.fun_tab_confessions(), icon: 'MessageCircle' },
    { id: 'riddles', label: m.fun_tab_riddles(), icon: 'Puzzle' },
  ]);

  const gameTexts = $derived<Record<FunGameId, { title: string; subtitle: string; rule?: string }>>({
    counting: { title: m.fun_counting_title(), subtitle: m.fun_counting_subtitle() },
    guess: { title: m.fun_guess_title(), subtitle: m.fun_guess_subtitle() },
    wordchain: { title: m.fun_wordchain_title(), subtitle: m.fun_wordchain_subtitle() },
    emojiriddle: { title: m.fun_emojiriddle_title(), subtitle: m.fun_emojiriddle_subtitle() },
    oneword: { title: m.fun_oneword_title(), subtitle: m.fun_oneword_subtitle(), rule: m.fun_oneword_hint() },
    neversay: { title: m.fun_neversay_title(), subtitle: m.fun_neversay_subtitle(), rule: m.fun_neversay_hint() },
    emojionly: { title: m.fun_emojionly_title(), subtitle: m.fun_emojionly_subtitle(), rule: m.fun_emojionly_hint() },
    imageofday: { title: m.fun_imageofday_title(), subtitle: m.fun_imageofday_subtitle(), rule: m.fun_imageofday_hint() },
  });

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  }
</script>

{#snippet statValue(label: string, value: string, tone = 'text-on-surface')}
  <div class="min-w-0">
    <p class="text-xs text-on-surface-variant">{label}</p>
    <p class="mt-0.5 truncate text-2xl font-bold {tone}">{value}</p>
  </div>
{/snippet}

{#snippet lastPlayer(label: string, userId: string | null)}
  <div class="min-w-0">
    <p class="text-xs text-on-surface-variant">{label}</p>
    <p class="mt-1 text-sm font-semibold text-on-surface">
      {#if userId}
        <MemberName {userId} />
      {:else}
        {m.fun_none()}
      {/if}
    </p>
  </div>
{/snippet}

{#snippet gameStateView(game: FunGame)}
  {#if game.id === 'counting'}
    <div class="grid grid-cols-2 gap-4">
      {@render statValue(m.fun_counting_number(), String(gameState.countingCurrent), 'text-warning')}
      {@render lastPlayer(m.fun_last_player(), gameState.countingLastUserId)}
    </div>
  {:else if game.id === 'guess'}
    <div class="flex items-center justify-between gap-3">
      {@render statValue(m.fun_guess_target(), guessRevealed && gameState.guessNumberTarget ? String(gameState.guessNumberTarget) : '•••', 'text-success')}
      <Button
        variant="ghost"
        size="sm"
        icon={guessRevealed ? 'EyeOff' : 'Eye'}
        aria-label={m.fun_guess_reveal()}
        aria-pressed={guessRevealed}
        onclick={() => (guessRevealed = !guessRevealed)}
      />
    </div>
  {:else if game.id === 'wordchain'}
    <div class="grid grid-cols-2 gap-4">
      {@render statValue(m.fun_wordchain_last_word(), gameState.wordChainLastWord || m.fun_none(), 'text-sky-500')}
      {@render lastPlayer(m.fun_last_player(), gameState.wordChainLastUserId)}
    </div>
  {:else if game.id === 'emojiriddle'}
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-xs text-on-surface-variant">{m.fun_emojiriddle_current_clue()}</p>
        <p class="mt-1 text-3xl">{gameState.emojiRiddleEmojis || '❓'}</p>
      </div>
      <Button variant="ghost" size="sm" icon="Puzzle" onclick={showRiddles}>{m.fun_riddles_manage()}</Button>
    </div>
  {:else if game.id === 'oneword'}
    {@render lastPlayer(m.fun_last_author(), gameState.oneWordStoryLastUserId)}
  {/if}
{/snippet}

{#snippet resetButton(id: FunGameId, label: string, onclick: () => void)}
  <Button
    size="sm"
    icon="refresh-cw"
    loading={resetting === id}
    disabled={!canManageSettings}
    disabledReason={m.common_reason_no_permission()}
    {onclick}
  >{label}</Button>
{/snippet}

{#snippet gameActionsView(game: FunGame)}
  {#if game.id === 'counting'}
    {@render resetButton('counting', m.fun_reset_counting_btn(), resetCounting)}
  {:else if game.id === 'guess'}
    {@render resetButton('guess', m.fun_reset_guess_btn(), resetGuess)}
  {:else if game.id === 'wordchain'}
    {@render resetButton('wordchain', m.fun_reset_wordchain_btn(), resetWordChain)}
  {:else if game.id === 'emojiriddle'}
    {@render resetButton('emojiriddle', m.fun_reset_emojiriddle_btn(), resetEmojiRiddle)}
  {/if}
{/snippet}

{#snippet gameGroup(title: string, description: string, games: FunGame[])}
  <section class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-on-surface">{title}</h2>
      <p class="text-xs text-on-surface-variant mt-0.5">{description}</p>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each games as game (game.id)}
        {@const texts = gameTexts[game.id]}
        <FunGameCard
          {game}
          title={texts.title}
          subtitle={texts.subtitle}
          rule={texts.rule}
          bind:channelId={config[game.channelKey]}
          channels={channelOptions}
          canManage={canManageSettings}
        >
          {@render gameStateView(game)}
          {#snippet actions()}
            {@render gameActionsView(game)}
          {/snippet}
        </FunGameCard>
      {/each}
    </div>
  </section>
{/snippet}

<ModulePage
  title={m.fun_page_title()}
  description={m.fun_page_desc()}
  icon="Smile"
  featureKey="fun"
>
  <InlineFeedback state={actionState} />

  <div bind:this={tabsAnchor} class="mb-6 scroll-mt-4">
    <Tabs label={m.fun_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => (activeTab = id as Tab)} />
  </div>

  {#if loading}
    <div class="space-y-6">
      <Skeleton height="96px" />
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton height="260px" />
        <Skeleton height="260px" />
      </div>
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else if activeTab === 'games'}
    <div class="space-y-8">
      <section class="grid gap-6 rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:items-center">
        <div class="space-y-3">
          <div>
            <p class="text-xs text-on-surface-variant">{m.fun_active_summary()}</p>
            <p class="mt-0.5 text-2xl font-bold text-on-surface">{activeCount} / {FUN_GAMES.length}</p>
          </div>
          <div class="flex gap-1.5" aria-hidden="true">
            {#each FUN_GAMES as game (game.id)}
              <span class="h-2 flex-1 rounded-full {config[game.channelKey] ? 'bg-success' : 'bg-surface-container-high'}"></span>
            {/each}
          </div>
        </div>
        <div class="flex items-center justify-between gap-4 md:border-l md:border-outline-variant/20 md:pl-6">
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
      </section>

      {@render gameGroup(m.fun_group_score_title(), m.fun_group_score_desc(), scoreGames)}
      {@render gameGroup(m.fun_group_rule_title(), m.fun_group_rule_desc(), ruleGames)}
    </div>
  {:else if activeTab === 'confessions'}
    <div class="space-y-6">
      <section class="space-y-5 rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-6">
        <div class="flex items-start gap-3 border-b border-outline-variant/15 pb-3">
          <div class="h-10 w-10 shrink-0 rounded-xl flex items-center justify-center bg-violet-500/10 text-violet-500">
            <Papicon icon="MessageCircle" size={20} />
          </div>
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-on-surface">{m.fun_confession_title()}</h3>
            <p class="text-xs text-on-surface-variant">{m.fun_confession_subtitle()}</p>
          </div>
        </div>

        <div class="grid gap-5 md:grid-cols-3">
          <Field label={m.fun_channel_label()}>
            {#snippet children(id)}
              <SearchableSelect {id} bind:value={config.funConfessionChannelId} options={channelOptions} placeholder={m.fun_no_channel()} disabled={!canManageSettings} />
            {/snippet}
          </Field>
          <Field label={m.fun_confession_log_label()}>
            {#snippet children(id)}
              <SearchableSelect {id} bind:value={config.funConfessionLogChannelId} options={channelOptions} placeholder={m.fun_no_channel()} disabled={!canManageSettings} />
            {/snippet}
          </Field>
          <Field label={m.fun_confession_cooldown_label()} hint={m.fun_confession_cooldown_hint()}>
            {#snippet children(id, describedBy)}
              <input
                {id}
                aria-describedby={describedBy}
                type="number"
                min="0"
                max="86400"
                step="1"
                bind:value={config.funConfessionCooldownSeconds}
                class="input"
                disabled={!canManageSettings}
              />
            {/snippet}
          </Field>
        </div>

        <p class="flex items-start gap-2 text-xs text-on-surface-variant">
          <Papicon icon="info" size={14} class="mt-0.5 shrink-0" />
          <span>{m.fun_confession_hint()}</span>
        </p>
      </section>

      <section class="space-y-4 rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-6">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="List" size={16} />
          {m.fun_confession_recent_title()}
        </h3>
        {#if confessions.length === 0}
          <EmptyState icon="MessageCircle" title={m.fun_confession_empty()} reason="accumulating" />
        {:else}
          <ul class="space-y-3">
            {#each confessions as c (c.number)}
              <li class="rounded-xl border border-outline-variant/10 bg-surface-container-high/20 p-4 {c.deletedAt ? 'opacity-60' : ''}">
                <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                  <span class="rounded-full bg-violet-500/10 px-2 py-0.5 font-semibold text-violet-500">#{c.number}</span>
                  <span>{formatDate(c.createdAt)}</span>
                  {#if c.revealedAt}
                    <span class="rounded-full bg-warning/10 px-2 py-0.5 font-semibold text-warning">{m.fun_confession_revealed()}</span>
                  {/if}
                  {#if c.deletedAt}
                    <span class="rounded-full bg-error/10 px-2 py-0.5 font-semibold text-error">{m.fun_confession_deleted()}</span>
                  {/if}
                </div>
                <p class="whitespace-pre-wrap break-words text-sm text-on-surface {c.deletedAt ? 'line-through' : ''}">{c.content}</p>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {:else}
    <EmojiRiddleEditor bind:useDefaults={config.funEmojiRiddleUseDefaults} canManage={canManageSettings} />
  {/if}
</ModulePage>
