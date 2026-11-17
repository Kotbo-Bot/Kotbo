<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { FUN_GAMES, activeGames, type FunGame, type FunGameId } from '../lib/funGames';
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
  import Modal from '../lib/components/Modal.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
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

  const dirty = $derived(JSON.stringify(config) !== JSON.stringify(savedConfig));
  // Le choix « rébus fournis » vit dans l'onglet Rébus : il marque cet onglet, pas Réglages.
  const riddlesDirty = $derived(config.funEmojiRiddleUseDefaults !== savedConfig.funEmojiRiddleUseDefaults);
  const settingsDirty = $derived(
    JSON.stringify({ ...config, funEmojiRiddleUseDefaults: null }) !== JSON.stringify({ ...savedConfig, funEmojiRiddleUseDefaults: null })
  );

  // Detect changes and register/deregister with the global bar
  $effect(() => {
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

  const RESETS: Partial<Record<FunGameId, () => Promise<void>>> = {
    counting: () => resetGame('counting', resetCountingGame, {
      title: m.fun_reset_counting_confirm_title(), confirm: m.fun_reset_counting_confirm_btn(), toast: m.fun_reset_counting_toast()
    }, 'warning'),
    guess: () => {
      guessRevealed = false;
      return resetGame('guess', resetGuessNumberGame, {
        title: m.fun_reset_guess_confirm_title(), confirm: m.fun_reset_guess_confirm_btn(), toast: m.fun_reset_guess_toast()
      });
    },
    wordchain: () => resetGame('wordchain', resetWordChainGame, {
      title: m.fun_reset_wordchain_confirm_title(), confirm: m.fun_reset_wordchain_confirm_btn(), toast: m.fun_reset_wordchain_toast()
    }, 'warning'),
    emojiriddle: () => resetGame('emojiriddle', resetEmojiRiddleGame, {
      title: m.fun_reset_emojiriddle_confirm_title(), confirm: m.fun_reset_emojiriddle_confirm_btn(), toast: m.fun_reset_emojiriddle_toast()
    }),
  };

  const RESET_LABELS = $derived<Partial<Record<FunGameId, string>>>({
    counting: m.fun_reset_counting_btn(),
    guess: m.fun_reset_guess_btn(),
    wordchain: m.fun_reset_wordchain_btn(),
    emojiriddle: m.fun_reset_emojiriddle_btn(),
  });

  type Tab = 'overview' | 'confessions' | 'riddles' | 'settings';
  let activeTab = $state<Tab>('overview');

  /** Sur grand écran, l'état du module reste à côté du contenu ; sinon il s'ouvre en fenêtre. */
  const wide = new MediaQuery('min-width: 64rem');
  let statusOpen = $state(false);

  /** La cible du nombre mystère reste cachée : une capture d'écran ne doit pas la livrer. */
  let guessRevealed = $state(false);

  const channelOptions = $derived(availableChannels.map((c) => ({ id: c.id, name: channelDisplayName(c) })));
  // Le suivi et l'état du module montrent ce qui tourne sur Discord, donc la
  // configuration enregistrée : un salon choisi mais pas encore enregistré
  // n'est pas encore un jeu actif.
  const running = $derived(activeGames(savedConfig));

  function channelName(channelId: string | null): string {
    if (!channelId) return m.fun_status_inactive();
    return channelOptions.find((channel) => channel.id === channelId)?.name ?? m.fun_channel_gone();
  }

  const tabItems = $derived<TabItem[]>([
    { id: 'overview', label: m.fun_tab_overview(), icon: 'Gamepad2' },
    { id: 'confessions', label: m.fun_tab_confessions(), icon: 'MessageCircle' },
    { id: 'riddles', label: m.fun_tab_riddles(), icon: 'Puzzle', badge: riddlesDirty ? m.fun_tab_modified() : undefined },
    { id: 'settings', label: m.fun_tab_settings(), icon: 'Gears', badge: settingsDirty ? m.fun_tab_modified() : undefined },
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

{#snippet statTile(icon: string, tone: string, value: string, label: string)}
  <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
    <div class="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 {tone}">
      <Papicon {icon} size={20} />
    </div>
    <div class="flex flex-col min-w-0">
      <span class="text-xl font-bold text-on-surface truncate">{value}</span>
      <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    </div>
  </div>
{/snippet}

{#snippet sectionHeader(icon: string, title: string, description: string)}
  <div class="border-b border-outline-variant/15 pb-3">
    <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon {icon} size={18} /> {title}</h3>
    <p class="text-xs text-on-surface-variant mt-1">{description}</p>
  </div>
{/snippet}

{#snippet gameIcon(game: FunGame)}
  <div class="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 {game.tone}">
    <Papicon icon={game.icon} size={18} />
  </div>
{/snippet}

{#snippet player(userId: string | null)}
  {#if userId}
    <MemberName {userId} />
  {:else}
    {m.fun_none()}
  {/if}
{/snippet}

<!-- Ce que la partie montre au staff : une ligne courte, sous le nom du jeu. -->
{#snippet gameStatus(game: FunGame)}
  {#if game.id === 'counting'}
    <span>{m.fun_stat_counting()} :</span>
    <span class="font-semibold text-on-surface">{gameState.countingCurrent}</span>
    <span>· {m.fun_last_player()} :</span> {@render player(gameState.countingLastUserId)}
  {:else if game.id === 'guess'}
    <span>{m.fun_guess_target()} :</span>
    <span class="font-semibold text-on-surface">{guessRevealed && gameState.guessNumberTarget ? gameState.guessNumberTarget : '•••'}</span>
    <Button
      variant="ghost"
      size="sm"
      icon={guessRevealed ? 'EyeOff' : 'Eye'}
      aria-label={m.fun_guess_reveal()}
      aria-pressed={guessRevealed}
      onclick={() => (guessRevealed = !guessRevealed)}
    />
  {:else if game.id === 'wordchain'}
    <span>{m.fun_wordchain_last_word()} :</span>
    <span class="font-semibold text-on-surface">{gameState.wordChainLastWord || m.fun_none()}</span>
    <span>· {m.fun_last_player()} :</span> {@render player(gameState.wordChainLastUserId)}
  {:else if game.id === 'emojiriddle'}
    <span>{m.fun_emojiriddle_current_clue()} :</span>
    <span class="text-lg leading-none">{gameState.emojiRiddleEmojis || '❓'}</span>
  {:else if game.id === 'oneword'}
    <span>{m.fun_last_author()} :</span> {@render player(gameState.oneWordStoryLastUserId)}
  {:else}
    <span>{gameTexts[game.id].subtitle}</span>
  {/if}
{/snippet}

{#snippet statusPanel()}
  {#if loading}
    <Skeleton height="160px" />
  {:else}
    <dl class="space-y-2 text-sm">
      {#each FUN_GAMES as game (game.id)}
        <div class="flex items-center justify-between gap-3">
          <dt class="text-on-surface-variant truncate">{gameTexts[game.id].title}</dt>
          <dd class="font-semibold text-right truncate {savedConfig[game.channelKey] ? '' : 'text-on-surface-variant'}">{channelName(savedConfig[game.channelKey])}</dd>
        </div>
      {/each}
      <div class="flex items-center justify-between gap-3 border-t border-outline-variant/15 pt-2">
        <dt class="text-on-surface-variant">{m.fun_confession_title()}</dt>
        <dd class="font-semibold text-right truncate {savedConfig.funConfessionChannelId ? '' : 'text-on-surface-variant'}">{channelName(savedConfig.funConfessionChannelId)}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.fun_punitive_title()}</dt>
        <dd class="font-semibold">{savedConfig.funPunitiveMode ? m.fun_status_on() : m.fun_status_off()}</dd>
      </div>
    </dl>
  {/if}
{/snippet}

<ModulePage
  title={m.fun_page_title()}
  description={m.fun_page_desc()}
  icon="Smile"
  featureKey="fun"
>
  <InlineFeedback state={actionState} />

  {#if !wide.current}
    <div class="mb-4">
      <Button size="sm" icon="List" onclick={() => (statusOpen = true)}>{m.fun_status_title()}</Button>
    </div>
    <Modal bind:open={statusOpen} onClose={() => (statusOpen = false)} title={m.fun_status_title()}>
      {@render statusPanel()}
    </Modal>
  {/if}

  <!-- Sur grand écran, l'état du module reste à côté du contenu, quel que soit l'onglet. -->
  <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
    <div class="min-w-0">
      <Tabs label={m.fun_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => (activeTab = id as Tab)} class="mb-6" />

      {#if loading}
        <div class="space-y-6">
          <Skeleton height="80px" />
          <Skeleton height="300px" />
        </div>
        <div class="flex justify-center mt-4">
          <LoadingHint context="config" />
        </div>
      {:else if activeTab === 'overview'}
        <div class="space-y-6">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {@render statTile('Gamepad2', 'bg-primary/10 text-primary', `${running.length} / ${FUN_GAMES.length}`, m.fun_active_summary())}
            {@render statTile('Binary', 'bg-warning/10 text-warning', savedConfig.funCountingChannelId ? String(gameState.countingCurrent) : '-', m.fun_stat_counting())}
            {@render statTile('Shield', 'bg-secondary/10 text-secondary', savedConfig.funPunitiveMode ? m.fun_status_on() : m.fun_status_off(), m.fun_punitive_title())}
          </div>

          {#if running.length === 0}
            <Callout variant="info" title={m.fun_empty_title()}>
              <p>{m.fun_empty_desc()}</p>
              {#snippet actions()}
                <Button size="sm" icon="Gears" onclick={() => (activeTab = 'settings')}>{m.fun_empty_action()}</Button>
              {/snippet}
            </Callout>
          {:else}
            <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <h3 class="text-base font-semibold flex items-center gap-2.5">
                  <Papicon icon="Gamepad2" size={16} />
                  {m.fun_running_title()}
                </h3>
                <Button variant="ghost" size="sm" icon="Gears" onclick={() => (activeTab = 'settings')}>{m.fun_running_edit()}</Button>
              </div>
              <ul class="space-y-3">
                {#each running as game (game.id)}
                  {@const reset = RESETS[game.id]}
                  <li class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 flex flex-wrap items-center gap-3">
                    {@render gameIcon(game)}
                    <div class="min-w-0 flex-1 space-y-0.5">
                      <p class="text-sm font-semibold text-on-surface">
                        {gameTexts[game.id].title}
                        <span class="font-normal text-on-surface-variant">· {channelName(savedConfig[game.channelKey])}</span>
                      </p>
                      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-on-surface-variant">
                        {@render gameStatus(game)}
                      </div>
                    </div>
                    {#if reset}
                      <Button
                        size="sm"
                        icon="refresh-cw"
                        loading={resetting === game.id}
                        disabled={!canManageSettings}
                        disabledReason={m.common_reason_no_permission()}
                        onclick={reset}
                      >{RESET_LABELS[game.id]}</Button>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>
      {:else if activeTab === 'confessions'}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="List" size={16} />
            {m.fun_confession_recent_title()}
          </h3>
          {#if !savedConfig.funConfessionChannelId && confessions.length === 0}
            <Callout variant="info" title={m.fun_confession_off_title()}>
              <p>{m.fun_confession_subtitle()}</p>
              {#snippet actions()}
                <Button size="sm" icon="Gears" onclick={() => (activeTab = 'settings')}>{m.fun_empty_action()}</Button>
              {/snippet}
            </Callout>
          {:else if confessions.length === 0}
            <EmptyState icon="MessageCircle" title={m.fun_confession_empty()} reason="accumulating" />
          {:else}
            <ul class="space-y-3">
              {#each confessions as c (c.number)}
                <li class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 space-y-2 {c.deletedAt ? 'opacity-60' : ''}">
                  <div class="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                    <span class="font-semibold text-on-surface">#{c.number}</span>
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
      {:else if activeTab === 'riddles'}
        <EmojiRiddleEditor bind:useDefaults={config.funEmojiRiddleUseDefaults} canManage={canManageSettings} />
      {:else}
        <div class="space-y-6">
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            {@render sectionHeader('Gamepad2', m.fun_settings_games_title(), m.fun_settings_games_desc())}
            <ul class="divide-y divide-outline-variant/15">
              {#each FUN_GAMES as game (game.id)}
                {@const texts = gameTexts[game.id]}
                <li class="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_16rem] md:items-start">
                  <div class="flex items-start gap-3 min-w-0">
                    {@render gameIcon(game)}
                    <div class="min-w-0">
                      <p class="text-sm font-semibold text-on-surface">{texts.title}</p>
                      <p class="text-xs text-on-surface-variant">{texts.rule ?? texts.subtitle}</p>
                    </div>
                  </div>
                  <div>
                    <label class="sr-only" for="fun-channel-{game.id}">{m.fun_channel_aria({ game: texts.title })}</label>
                    <SearchableSelect
                      id="fun-channel-{game.id}"
                      bind:value={config[game.channelKey]}
                      options={channelOptions}
                      placeholder={m.fun_no_channel()}
                      disabled={!canManageSettings}
                    />
                  </div>
                </li>
              {/each}
            </ul>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            {@render sectionHeader('Shield', m.fun_settings_rules_title(), m.fun_settings_rules_desc())}
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm font-semibold">{m.fun_punitive_title()}</p>
                <p class="text-xs text-on-surface-variant">{m.fun_punitive_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.funPunitiveMode}
                disabled={!canManageSettings}
                onToggle={(value) => (config.funPunitiveMode = value)}
                ariaLabel={m.fun_punitive_title()}
              />
            </div>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            {@render sectionHeader('MessageCircle', m.fun_confession_title(), m.fun_confession_subtitle())}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
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
            <p class="text-xs text-on-surface-variant">{m.fun_confession_hint()}</p>
          </section>
        </div>
      {/if}
    </div>

    {#if wide.current}
      <aside class="sticky top-4 space-y-4" aria-label={m.fun_status_title()}>
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-4 rounded-xl space-y-3">
          <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="List" size={15} /> {m.fun_status_title()}</h3>
          {@render statusPanel()}
        </section>
      </aside>
    {/if}
  </div>
</ModulePage>
