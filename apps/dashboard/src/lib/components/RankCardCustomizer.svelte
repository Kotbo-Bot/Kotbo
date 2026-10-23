<script lang="ts">
  import { explainDisabled } from '../actions/explainDisabled';
  import { onDestroy } from 'svelte';
  import {
    getRankCardAchievement,
    isManualRankCardAchievement,
    isRankCardItemUnlocked,
    normalizeRankCardCustomization,
    rankCardBadgeImageUrl,
    rankCardEmojiImageUrl,
    rankCardFontStack,
    DEFAULT_RANK_CARD_CUSTOMIZATION,
    RANK_CARD_ACHIEVEMENTS,
    RANK_CARD_BACKGROUNDS,
    RANK_CARD_BADGE_ICONS,
    RANK_CARD_BAR_STYLES,
    RANK_CARD_EMOJIS,
    RANK_CARD_FONTS,
    RANK_CARD_FRAMES,
    RANK_CARD_MAX_BADGES,
    RANK_CARD_MAX_EMOJIS,
    RANK_CARD_PATTERNS,
    RANK_CARD_TIER_COLORS,
    type RankCardAchievement,
    type RankCardAchievementMetrics,
    type RankCardBackgroundPreset,
    type RankCardCustomization,
    type RankCardDecorPreset,
  } from '@kotbo/shared';
  import { fetchRankCardCustomization, fetchRankCardPreview, saveRankCard } from '../api/rankCard';
  import { authStore } from '../stores/auth.svelte';
  import { toast } from '../stores/toast.svelte';
  import { m, getLocale } from '../i18n';
  import Papicon from './Papicon.svelte';

  // Catalogues compiles avec la page : c est la meme source que le canvas
  // serveur, donc aucune divergence possible entre choix offerts et rendu.
  const backgrounds = RANK_CARD_BACKGROUNDS;
  const fonts = RANK_CARD_FONTS;
  const availableEmojis = RANK_CARD_EMOJIS.map((emoji) => emoji.value);
  const maxEmojis = RANK_CARD_MAX_EMOJIS;
  const maxBadges = RANK_CARD_MAX_BADGES;
  const tiers = Object.entries(RANK_CARD_TIER_COLORS);

  let loading = $state(true);
  let saving = $state(false);

  let backgroundId = $state(DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId);
  let fontId = $state(DEFAULT_RANK_CARD_CUSTOMIZATION.fontId);
  let emojis = $state<string[]>([]);
  let frameId = $state(DEFAULT_RANK_CARD_CUSTOMIZATION.frameId);
  let patternId = $state(DEFAULT_RANK_CARD_CUSTOMIZATION.patternId);
  let barStyleId = $state(DEFAULT_RANK_CARD_CUSTOMIZATION.barStyleId);
  let titleId = $state<string | null>(null);
  let badges = $state<string[]>([]);
  let savedSignature = $state('');

  let unlockedIds = $state<string[]>([]);
  let grantedByStaffIds = $state<string[]>([]);
  let metrics = $state<Partial<RankCardAchievementMetrics>>({});
  const unlocked = $derived(new Set(unlockedIds));
  const unlockedAchievements = $derived(RANK_CARD_ACHIEVEMENTS.filter((achievement) => unlocked.has(achievement.id)));

  let previewUrl = $state<string | null>(null);
  let previewLoading = $state(false);
  let previewFailed = $state(false);
  let previewIsReal = $state(false);
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewToken = 0;

  const draft = $derived<RankCardCustomization>({
    backgroundId,
    fontId,
    emojis: [...emojis],
    frameId,
    patternId,
    barStyleId,
    titleId,
    badges: [...badges],
  });
  const dirty = $derived(signatureOf(draft) !== savedSignature);
  const customized = $derived(signatureOf(draft) !== signatureOf(DEFAULT_RANK_CARD_CUSTOMIZATION));

  /** Signature canonique : ne pas dependre de l ordre des cles renvoyees par l API. */
  function signatureOf(customization: RankCardCustomization): string {
    return JSON.stringify([
      customization.backgroundId,
      customization.fontId,
      customization.emojis,
      customization.frameId,
      customization.patternId,
      customization.barStyleId,
      customization.titleId,
      customization.badges,
    ]);
  }

  function label(text: { fr: string; en: string }): string {
    return getLocale() === 'fr' ? text.fr : text.en;
  }

  function lockReason(unlockedBy: string | undefined): string {
    const achievement = unlockedBy ? getRankCardAchievement(unlockedBy) : null;
    return achievement ? m.rc_locked_by({ name: label(achievement.label) }) : '';
  }

  function progressOf(achievement: RankCardAchievement): string | null {
    if (achievement.threshold <= 1) return null;
    const value = Math.min(metrics[achievement.metric] ?? 0, achievement.threshold);
    return `${value.toLocaleString(getLocale())} / ${achievement.threshold.toLocaleString(getLocale())}`;
  }

  /**
   * Reconstruit la vignette d un fond a partir de la meme recette que le canvas
   * serveur : le degrade seul, le rendu ne peignant plus les halos.
   */
  function swatchStyle(preset: RankCardBackgroundPreset): string {
    const base = preset.gradient
      .map((stop) => `${stop.color} ${Math.round(stop.offset * 100)}%`)
      .join(', ');
    return `background: linear-gradient(135deg, ${base});`;
  }

  function accentStyle(preset: RankCardBackgroundPreset): string {
    const stops = preset.accentBar
      .map((stop) => `${stop.color} ${Math.round(stop.offset * 100)}%`)
      .join(', ');
    return `background: linear-gradient(90deg, ${stops});`;
  }

  function applyCustomization(customization: RankCardCustomization) {
    backgroundId = customization.backgroundId;
    fontId = customization.fontId;
    emojis = [...customization.emojis];
    frameId = customization.frameId;
    patternId = customization.patternId;
    barStyleId = customization.barStyleId;
    titleId = customization.titleId;
    badges = [...customization.badges];
  }

  function releasePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  async function refreshPreview(customization: RankCardCustomization, guildId: string | null) {
    const token = ++previewToken;
    previewLoading = true;
    try {
      const preview = await fetchRankCardPreview(customization, getLocale() === 'en' ? 'en' : 'fr', guildId);
      if (token !== previewToken) {
        if (preview) URL.revokeObjectURL(preview.url);
        return;
      }
      if (preview) {
        releasePreview();
        previewUrl = preview.url;
        previewIsReal = preview.realProgression;
        previewFailed = false;
      } else {
        previewFailed = true;
      }
    } catch {
      if (token === previewToken) previewFailed = true;
    } finally {
      if (token === previewToken) previewLoading = false;
    }
  }

  function toggleEmoji(emoji: string) {
    if (emojis.includes(emoji)) {
      emojis = emojis.filter((entry) => entry !== emoji);
      return;
    }
    if (emojis.length >= maxEmojis) {
      toast.warning(m.rc_emoji_limit({ count: maxEmojis }));
      return;
    }
    emojis = [...emojis, emoji];
  }

  function toggleBadge(id: string) {
    if (!unlocked.has(id)) return;
    if (badges.includes(id)) {
      badges = badges.filter((entry) => entry !== id);
      return;
    }
    if (badges.length >= maxBadges) {
      toast.warning(m.rc_badge_limit({ count: maxBadges }));
      return;
    }
    badges = [...badges, id];
  }

  function reset() {
    applyCustomization(DEFAULT_RANK_CARD_CUSTOMIZATION);
  }

  async function save() {
    saving = true;
    try {
      const raw = await saveRankCard(draft);
      if (!raw) {
        toast.error(m.rc_save_error());
        return;
      }
      const result = normalizeRankCardCustomization(raw, unlocked);
      applyCustomization(result);
      savedSignature = signatureOf(result);
      toast.success(m.rc_saved());
    } catch {
      toast.error(m.rc_save_error());
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    // Le rendu passe par le bot : on attend une pause dans les clics pour ne
    // pas enchainer un aller-retour par vignette survolee.
    //
    // Le serveur est lu ici et non dans `refreshPreview` : depuis le setTimeout
    // il sortirait du suivi reactif, et changer de serveur laisserait l apercu
    // sur la progression du precedent.
    const customization = draft;
    const guildId = authStore.selectedGuildId;
    if (loading) return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => refreshPreview(customization, guildId), 250);
  });

  $effect(() => {
    void (async () => {
      try {
        const result = await fetchRankCardCustomization();
        if (result) {
          const ids = result.achievements.unlocked.map((entry) => entry.id);
          const customization = normalizeRankCardCustomization(result.customization, new Set(ids));
          unlockedIds = ids;
          grantedByStaffIds = result.achievements.unlocked.filter((entry) => entry.grantedByStaff).map((entry) => entry.id);
          metrics = result.achievements.metrics;
          applyCustomization(customization);
          savedSignature = signatureOf(customization);
        } else {
          toast.error(m.rc_load_error());
        }
      } catch {
        toast.error(m.rc_load_error());
      } finally {
        loading = false;
      }
    })();
  });

  onDestroy(() => {
    if (previewTimer) clearTimeout(previewTimer);
    releasePreview();
  });
</script>

{#snippet badgeIcon(achievement: RankCardAchievement, size: number)}
  {#if achievement.image}
    <!-- Meme fichier que le canvas serveur, servi depuis `public/rank-badges`. -->
    <img src={rankCardBadgeImageUrl(achievement.image)} alt="" width={size} height={size} class="rounded-[22%]" />
  {:else}
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={RANK_CARD_BADGE_ICONS[achievement.icon]} fill="url(#rc-tier-{achievement.tier})" fill-rule="evenodd" />
    </svg>
  {/if}
{/snippet}

{#snippet decorChoices(presets: RankCardDecorPreset[], selectedId: string, select: (id: string) => void)}
  <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {#each presets as preset (preset.id)}
      {@const available = isRankCardItemUnlocked(preset.unlockedBy, unlocked)}
      <button
        type="button"
        onclick={() => available && select(preset.id)}
        disabled={!available}
        aria-pressed={selectedId === preset.id}
        title={available ? undefined : lockReason(preset.unlockedBy)}
        class="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 {selectedId === preset.id ? 'border-primary ring-2 ring-primary/40' : 'border-outline-variant enabled:hover:border-primary/50'}"
      >
        <span class="truncate text-body-sm text-on-surface">{label(preset.label)}</span>
        {#if !available}
          <Papicon icon="Lock" size={13} class="shrink-0 text-on-surface-variant" />
        {:else if selectedId === preset.id}
          <Papicon icon="Check" size={13} class="shrink-0 text-primary" />
        {/if}
      </button>
    {/each}
  </div>
{/snippet}

<svg width="0" height="0" class="absolute" aria-hidden="true">
  <defs>
    {#each tiers as [tier, colors] (tier)}
      <linearGradient id="rc-tier-{tier}" x1="0" y1="0" x2="1" y2="1">
        {#each colors as color, index (index)}
          <stop offset={colors.length === 1 ? 0 : index / (colors.length - 1)} stop-color={color} />
        {/each}
      </linearGradient>
    {/each}
  </defs>
</svg>

<div class="space-y-6">
  <div>
    <h3 class="text-[15px] font-semibold text-on-surface">{m.rc_title()}</h3>
    <p class="mt-1 text-body-sm text-on-surface-variant">{m.rc_subtitle()}</p>
  </div>

  {#if loading}
    <div class="h-[180px] animate-pulse rounded-xl bg-surface-container-low"></div>
  {:else}
    <div class="relative overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low">
      {#if previewUrl}
        <img src={previewUrl} alt={m.rc_preview_alt()} class="w-full" />
      {:else if previewFailed}
        <div class="flex aspect-[934/282] w-full items-center justify-center px-4 text-center text-body-sm text-on-surface-variant">
          {m.rc_preview_error()}
        </div>
      {:else}
        <div class="aspect-[934/282] w-full animate-pulse bg-surface-container-high"></div>
      {/if}
      {#if previewLoading}
        <div class="absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-2xs text-white">
          {m.rc_preview_loading()}
        </div>
      {/if}
    </div>
    <p class="text-xs text-on-surface-variant">
      {previewIsReal ? m.rc_preview_note_real() : m.rc_preview_note()}
    </p>

    <div>
      <h4 class="mb-1 text-body-sm font-medium text-on-surface">
        {m.rc_achievements_title()}
        <span class="ml-1 font-normal text-on-surface-variant">
          {m.rc_unlocked_count({ count: unlockedAchievements.length, total: RANK_CARD_ACHIEVEMENTS.length })}
        </span>
      </h4>
      <p class="mb-2 text-xs text-on-surface-variant">
        {m.rc_achievements_hint({ count: maxBadges })}
        <span class="ml-1">{badges.length}/{maxBadges}</span>
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {#each RANK_CARD_ACHIEVEMENTS as achievement (achievement.id)}
          {@const isUnlocked = unlocked.has(achievement.id)}
          {@const progress = isUnlocked && !grantedByStaffIds.includes(achievement.id) ? null : progressOf(achievement)}
          <button
            type="button"
            onclick={() => toggleBadge(achievement.id)}
            disabled={!isUnlocked}
            aria-pressed={badges.includes(achievement.id)}
            class="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed {badges.includes(achievement.id) ? 'border-primary bg-primary/10 ring-2 ring-primary/40' : 'border-outline-variant enabled:hover:border-primary/50'}"
          >
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/70 {isUnlocked ? '' : 'opacity-40 grayscale'}">
              {@render badgeIcon(achievement, 20)}
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-body-sm font-medium {isUnlocked ? 'text-on-surface' : 'text-on-surface-variant'}">{label(achievement.label)}</span>
                {#if !isUnlocked}
                  <Papicon icon="Lock" size={12} class="shrink-0 text-on-surface-variant" />
                {:else if badges.includes(achievement.id)}
                  <Papicon icon="Check" size={12} class="shrink-0 text-primary" />
                {/if}
              </span>
              <span class="block text-2xs leading-snug text-on-surface-variant">{label(achievement.description)}</span>
              {#if progress}
                <span class="mt-0.5 block text-2xs font-medium text-on-surface-variant">{progress}</span>
              {:else if !isUnlocked && isManualRankCardAchievement(achievement)}
                <span class="mt-0.5 block text-2xs font-medium text-on-surface-variant">{m.rc_manual_hint()}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    </div>

    <div>
      <h4 class="mb-2 text-body-sm font-medium text-on-surface">{m.rc_title_title()}</h4>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={() => (titleId = null)}
          aria-pressed={titleId === null}
          class="rounded-lg border px-3 py-1.5 text-body-sm text-on-surface transition-all {titleId === null ? 'border-primary ring-2 ring-primary/40' : 'border-outline-variant hover:border-primary/50'}"
        >
          {m.rc_title_none()}
        </button>
        {#each unlockedAchievements as achievement (achievement.id)}
          <button
            type="button"
            onclick={() => (titleId = achievement.id)}
            aria-pressed={titleId === achievement.id}
            class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-body-sm font-semibold text-on-surface transition-all {titleId === achievement.id ? 'border-primary ring-2 ring-primary/40' : 'border-outline-variant hover:border-primary/50'}"
          >
            {@render badgeIcon(achievement, 14)}
            {label(achievement.title)}
          </button>
        {/each}
      </div>
      {#if unlockedAchievements.length === 0}
        <p class="mt-2 text-xs text-on-surface-variant">{m.rc_title_hint()}</p>
      {/if}
    </div>

    <div>
      <h4 class="mb-2 text-body-sm font-medium text-on-surface">{m.rc_background_title()}</h4>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {#each backgrounds as preset (preset.id)}
          {@const available = isRankCardItemUnlocked(preset.unlockedBy, unlocked)}
          <button
            type="button"
            onclick={() => available && (backgroundId = preset.id)}
            disabled={!available}
            aria-pressed={backgroundId === preset.id}
            title={available ? undefined : lockReason(preset.unlockedBy)}
            class="group overflow-hidden rounded-lg border text-left transition-all disabled:cursor-not-allowed {backgroundId === preset.id ? 'border-primary ring-2 ring-primary/40' : 'border-outline-variant enabled:hover:border-primary/50'}"
          >
            <div class="relative h-14 w-full" style={swatchStyle(preset)}>
              <div class="h-[3px] w-full" style={accentStyle(preset)}></div>
              {#if !available}
                <div class="absolute inset-0 flex items-center justify-center bg-black/50">
                  <Papicon icon="Lock" size={16} class="text-white" />
                </div>
              {/if}
            </div>
            <div class="flex items-center justify-between px-2 py-1.5">
              <span class="truncate text-xs {available ? 'text-on-surface' : 'text-on-surface-variant'}">{label(preset.label)}</span>
              {#if backgroundId === preset.id}
                <Papicon icon="Check" size={13} class="text-primary" />
              {/if}
            </div>
          </button>
        {/each}
      </div>
    </div>

    <div>
      <h4 class="mb-2 text-body-sm font-medium text-on-surface">{m.rc_frame_title()}</h4>
      {@render decorChoices(RANK_CARD_FRAMES, frameId, (id) => (frameId = id))}
    </div>

    <div>
      <h4 class="mb-2 text-body-sm font-medium text-on-surface">{m.rc_pattern_title()}</h4>
      {@render decorChoices(RANK_CARD_PATTERNS, patternId, (id) => (patternId = id))}
    </div>

    <div>
      <h4 class="mb-2 text-body-sm font-medium text-on-surface">{m.rc_bar_title()}</h4>
      {@render decorChoices(RANK_CARD_BAR_STYLES, barStyleId, (id) => (barStyleId = id))}
    </div>

    <div>
      <h4 class="mb-2 text-body-sm font-medium text-on-surface">{m.rc_font_title()}</h4>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {#each fonts as preset (preset.id)}
          <button
            type="button"
            onclick={() => (fontId = preset.id)}
            aria-pressed={fontId === preset.id}
            class="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-all {fontId === preset.id ? 'border-primary ring-2 ring-primary/40' : 'border-outline-variant hover:border-primary/50'}"
          >
            <!-- L echantillon est ecrit dans la police proposee : un nom de
                 famille ne dit rien de son allure. -->
            <span
              class="truncate text-[15px] font-bold text-on-surface"
              style="font-family: {rankCardFontStack(preset)};"
            >
              {label(preset.label)}
            </span>
            {#if fontId === preset.id}
              <Papicon icon="Check" size={13} class="shrink-0 text-primary" />
            {/if}
          </button>
        {/each}
      </div>
    </div>

    <div>
      <h4 class="mb-2 text-body-sm font-medium text-on-surface">
        {m.rc_emojis_title()}
        <span class="ml-1 font-normal text-on-surface-variant">{emojis.length}/{maxEmojis}</span>
      </h4>
      <div class="flex flex-wrap gap-2">
        {#each availableEmojis as emoji (emoji)}
          <button
            type="button"
            onclick={() => toggleEmoji(emoji)}
            aria-pressed={emojis.includes(emoji)}
            class="flex h-10 w-10 items-center justify-center rounded-lg border transition-all {emojis.includes(emoji) ? 'border-primary bg-primary/10' : 'border-outline-variant hover:border-primary/50'}"
          >
            <!-- Meme asset que le canvas serveur : la police emoji du systeme
                 ne ressemble pas au rendu de la carte. -->
            <img src={rankCardEmojiImageUrl(emoji)} alt={emoji} class="h-5 w-5" />
          </button>
        {/each}
      </div>
    </div>

    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={save}
        disabled={saving}
        use:explainDisabled={(!dirty) ? m.common_reason_no_changes() : ''}
        class="rounded-lg bg-primary px-4 py-2 text-body-sm font-medium text-on-primary transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? m.rc_saving() : m.rc_save()}
      </button>
      <button
        type="button"
        onclick={reset}
        disabled={saving || !customized}
        class="rounded-lg border border-outline-variant px-4 py-2 text-body-sm font-medium text-on-surface transition-all hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {m.rc_reset()}
      </button>
      {#if dirty}
        <span class="text-xs text-on-surface-variant">{m.rc_unsaved()}</span>
      {/if}
    </div>
  {/if}
</div>
