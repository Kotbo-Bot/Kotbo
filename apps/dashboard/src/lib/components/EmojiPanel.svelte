<script lang="ts">
  /**
   * Contenu du sélecteur d'emoji, partagé par EmojiPicker et l'éditeur Markdown.
   *
   * Une seule recherche couvre les emojis du serveur et tout le catalogue
   * Unicode par nom (« cœur », « fusée ») ; sans recherche, une liste continue
   * Récents → Ce serveur → catégories, que la barre du haut fait défiler. Le
   * bas du panneau montre l'emoji survolé en grand avec son nom, comme Discord.
   */
  import { onMount, tick } from 'svelte';
  import { m, getLocale } from '../i18n';
  import Papicon from './Papicon.svelte';
  import { Button } from './ui';
  import { toast } from '../stores/toast.svelte';
  import {
    fetchGuildEmojis,
    uploadGuildEmoji,
    sanitizeEmojiName,
    GUILD_EMOJI_ACCEPTED,
    GUILD_EMOJI_MAX_BYTES,
    type GuildEmoji,
    type GuildEmojiSet,
  } from '../api';
  import {
    loadEmojiCatalog,
    searchCatalog,
    matchesEmojiTerm,
    normalizeEmojiTerm,
    previewEmojiValue,
    readRecentEmojis,
    pushRecentEmoji,
    type CatalogGroup,
    type RecentEmoji,
  } from '../emojiCatalog';

  let {
    value = '',
    /** `mention` rend `<:nom:id>` ; `id` l'identifiant nu (clé de réaction). */
    format = 'mention',
    onpick,
    /** Affiche « Retirer » quand une valeur est choisie. */
    onclear,
    onclose,
  }: {
    value?: string;
    format?: 'mention' | 'id';
    onpick: (value: string) => void;
    onclear?: () => void;
    onclose?: () => void;
  } = $props();

  const COLUMNS = 8;

  let search = $state('');
  let view = $state<'browse' | 'upload'>('browse');
  let searchEl = $state<HTMLInputElement | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);
  let activeSection = $state('');

  let catalog = $state<CatalogGroup[] | null>(null);
  let catalogError = $state(false);
  let emojiSet = $state<GuildEmojiSet | null>(null);
  let loadingServer = $state(true);
  let serverError = $state('');
  let recents = $state<RecentEmoji[]>([]);
  let hovered = $state<{ unicode?: string; url?: string; label: string } | null>(null);

  // Dépôt d'une image.
  let uploadFile = $state<File | null>(null);
  let uploadName = $state('');
  let uploadPreview = $state('');
  let uploading = $state(false);
  let dragOver = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  const acceptAttr = GUILD_EMOJI_ACCEPTED.join(',');
  const maxKb = Math.round(GUILD_EMOJI_MAX_BYTES / 1024);

  const serverEmojis = $derived((emojiSet?.emojis ?? []).filter((e) => e.available));
  const emojiById = $derived(new Map(serverEmojis.map((e) => [e.id, e])));
  const showServer = $derived(loadingServer || !!serverError || !!emojiSet);
  const term = $derived(search.trim());

  // Un emoji d'un autre serveur ne s'affichera pas ici : on le retire des récents.
  type RecentCell = { unicode: string; label: string; custom?: undefined } | { custom: GuildEmoji; unicode?: undefined; label?: undefined };
  const recentCells = $derived(
    recents.flatMap((r): RecentCell[] => {
      if (r.kind === 'unicode') return [{ unicode: r.unicode, label: r.label }];
      const emoji = emojiById.get(r.id);
      return emoji ? [{ custom: emoji }] : [];
    }),
  );

  const serverMatches = $derived(
    term ? serverEmojis.filter((e) => matchesEmojiTerm(normalizeEmojiTerm(e.name.replace(/_/g, ' ')), term)) : [],
  );
  const unicodeMatches = $derived(term && catalog ? searchCatalog(catalog, term) : []);

  const sections = $derived([
    ...(recentCells.length ? [{ id: 'recent', label: m.d1_emoji_recent(), icon: '', papicon: 'clock' }] : []),
    ...(showServer ? [{ id: 'server', label: m.d1_emoji_this_server(), icon: '', papicon: 'server' }] : []),
    ...(catalog ?? []).map((g) => ({ id: g.key, label: g.label, icon: g.icon, papicon: '' })),
  ]);

  const current = $derived(previewEmojiValue(value));

  onMount(() => {
    recents = readRecentEmojis();
    searchEl?.focus();
    loadEmojiCatalog(getLocale())
      .then((groups) => (catalog = groups))
      .catch(() => (catalogError = true));
    void loadServerEmojis();
    return () => {
      if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    };
  });

  async function loadServerEmojis() {
    loadingServer = true;
    serverError = '';
    try {
      // `null` = aucun serveur sélectionné : la section disparaît.
      emojiSet = await fetchGuildEmojis();
    } catch (err) {
      serverError = err instanceof Error ? err.message : m.d1_emoji_server_unavailable();
    } finally {
      loadingServer = false;
    }
  }

  function pickUnicode(unicode: string, label: string) {
    recents = pushRecentEmoji({ kind: 'unicode', unicode, label });
    onpick(unicode);
  }

  function pickCustom(emoji: GuildEmoji) {
    recents = pushRecentEmoji({ kind: 'custom', id: emoji.id, name: emoji.name });
    onpick(format === 'id' ? emoji.id : emoji.mention);
  }

  // Un seul écouteur pour ~1 900 cases : chaque case porte ce qu'il faut en data-*.
  function cellOf(event: Event): HTMLElement | null {
    return (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-emoji]') ?? null;
  }

  function handleGridClick(event: MouseEvent) {
    const cell = cellOf(event);
    if (!cell) return;
    const { custom, emoji, label } = cell.dataset;
    if (custom) {
      const found = emojiById.get(custom);
      if (found) pickCustom(found);
    } else if (emoji) {
      pickUnicode(emoji, label ?? '');
    }
  }

  function handleGridHover(event: Event) {
    const cell = cellOf(event);
    if (!cell) return;
    const { custom, emoji, label = '' } = cell.dataset;
    hovered = custom ? { url: emojiById.get(custom)?.url, label } : { unicode: emoji, label };
  }

  function cells(): HTMLButtonElement[] {
    return Array.from(scrollEl?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? []);
  }

  // Flèches : gauche/droite d'une case, haut/bas d'une ligne, dans l'ordre affiché.
  function handleGridKeydown(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    const cell = cellOf(event);
    if (!step || !cell) return;
    event.preventDefault();
    const all = cells();
    const index = all.indexOf(cell as HTMLButtonElement) + step;
    if (index < 0) searchEl?.focus();
    else all[Math.min(index, all.length - 1)]?.focus();
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (serverMatches[0]) pickCustom(serverMatches[0]);
      else if (unicodeMatches[0]) pickUnicode(unicodeMatches[0].unicode, unicodeMatches[0].label);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      cells()[0]?.focus();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose?.();
    }
  }

  function syncActiveSection() {
    if (!scrollEl) return;
    const top = scrollEl.scrollTop + 8;
    let currentId = sections[0]?.id ?? '';
    for (const el of scrollEl.querySelectorAll<HTMLElement>('[data-section]')) {
      if (el.offsetTop <= top) currentId = el.dataset.section ?? currentId;
    }
    activeSection = currentId;
  }

  async function jumpTo(id: string) {
    if (term) {
      search = '';
      await tick();
    }
    const el = scrollEl?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (scrollEl && el) scrollEl.scrollTop = el.offsetTop;
    activeSection = id;
  }

  $effect(() => {
    // Première section active dès que la liste est prête.
    if (!activeSection && sections.length) activeSection = sections[0].id;
  });

  function openUpload() {
    view = 'upload';
    hovered = null;
  }

  function pickFile(file: File | null | undefined) {
    if (!file) return;
    if (!GUILD_EMOJI_ACCEPTED.includes(file.type)) {
      toast.error(m.d1_emoji_upload_bad_format());
      return;
    }
    if (file.size > GUILD_EMOJI_MAX_BYTES) {
      toast.error(m.d1_emoji_upload_too_big({ max: String(maxKb) }));
      return;
    }
    uploadFile = file;
    // Le nom du fichier est presque toujours le nom voulu : il reste modifiable.
    uploadName = sanitizeEmojiName(file.name.replace(/\.[^.]+$/, ''));
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    uploadPreview = URL.createObjectURL(file);
  }

  function clearUpload() {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    uploadFile = null;
    uploadName = '';
    uploadPreview = '';
    if (fileInput) fileInput.value = '';
  }

  async function submitUpload() {
    if (!uploadFile || uploading) return;
    uploading = true;
    try {
      const result = await uploadGuildEmoji(uploadFile, uploadName);
      emojiSet = result;
      clearUpload();
      view = 'browse';
      // L'emoji vient d'être créé pour servir : on le choisit tout de suite.
      if (result.created) {
        toast.success(m.d1_emoji_upload_done({ name: result.created.name }));
        pickCustom(result.created);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.d1_emoji_upload_failed());
    } finally {
      uploading = false;
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    pickFile(event.dataTransfer?.files?.[0]);
  }
</script>

{#snippet unicodeCell(unicode: string, label: string)}
  <button type="button" class="emoji-cell text-2xl" data-emoji={unicode} data-label={label} aria-label={label}>{unicode}</button>
{/snippet}

{#snippet customCell(emoji: GuildEmoji)}
  <button type="button" class="emoji-cell" data-emoji="" data-custom={emoji.id} data-label=":{emoji.name}:" aria-label=":{emoji.name}:">
    <img src={emoji.url} alt="" loading="lazy" class="h-7 w-7 object-contain" />
  </button>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="emoji-panel flex min-h-0 flex-col" role="dialog" aria-label={m.d1_emoji_open_picker()} tabindex="-1" onkeydown={handleKeydown}>
  {#if view === 'upload'}
    <div class="flex items-center gap-2 border-b border-outline-variant px-3 py-2">
      <Button size="sm" variant="ghost" icon="arrow-left" onclick={() => (view = 'browse')}>{m.common_back()}</Button>
      <span class="text-body-sm font-medium text-on-surface">{m.d1_emoji_upload_title()}</span>
    </div>
    <div class="flex flex-col gap-3 p-3">
      {#if emojiSet && !emojiSet.canUpload}
        <p class="py-4 text-center text-body-sm text-on-surface-variant">{m.d1_emoji_upload_forbidden()}</p>
      {:else}
        <input bind:this={fileInput} type="file" accept={acceptAttr} class="hidden" onchange={(e) => pickFile((e.currentTarget as HTMLInputElement).files?.[0])} />
        {#if uploadFile}
          <div class="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container p-3">
            <img src={uploadPreview} alt="" class="h-12 w-12 rounded object-contain" />
            <label class="min-w-0 flex-1">
              <span class="field-label">{m.d1_emoji_upload_name()}</span>
              <input
                type="text"
                class="input"
                value={uploadName}
                oninput={(e) => (uploadName = sanitizeEmojiName((e.currentTarget as HTMLInputElement).value))}
                maxlength="32"
              />
            </label>
            <button type="button" class="self-start rounded-md p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" aria-label={m.d1_emoji_upload_clear()} onclick={clearUpload}>
              <Papicon icon="x" size={14} />
            </button>
          </div>
          <Button
            variant="primary"
            fullWidth
            loading={uploading}
            disabled={uploadName.trim().length < 2}
            disabledReason={m.common_reason_fill_field()}
            onclick={submitUpload}
          >{m.d1_emoji_upload_submit()}</Button>
        {:else}
          <button
            type="button"
            onclick={() => fileInput?.click()}
            ondragover={(e) => { e.preventDefault(); dragOver = true; }}
            ondragleave={() => (dragOver = false)}
            ondrop={handleDrop}
            class="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-8 transition-colors {dragOver ? 'border-primary bg-primary/5' : 'border-outline-variant hover:border-on-surface-variant'}"
          >
            <Papicon icon="upload" size={22} class="text-on-surface-variant" />
            <span class="text-body-sm text-on-surface">{m.d1_emoji_upload_drop()}</span>
            <span class="text-xs text-on-surface-variant">{m.d1_emoji_upload_hint({ max: String(maxKb) })}</span>
          </button>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-2 border-b border-outline-variant p-3">
      <input
        bind:this={searchEl}
        bind:value={search}
        type="search"
        class="input"
        placeholder={m.d1_emoji_search()}
        aria-label={m.d1_emoji_search()}
        onkeydown={handleSearchKeydown}
      />
      <div class="flex gap-0.5 overflow-x-auto scrollbar-hide" role="tablist" aria-label={m.d1_emoji_categories()}>
        {#each sections as section (section.id)}
          <button
            type="button"
            role="tab"
            aria-selected={!term && activeSection === section.id}
            title={section.label}
            aria-label={section.label}
            onclick={() => jumpTo(section.id)}
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg transition-colors {!term && activeSection === section.id ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high'}"
          >
            {#if section.papicon}<Papicon icon={section.papicon} size={16} />{:else}{section.icon}{/if}
          </button>
        {/each}
      </div>
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_mouse_events_have_key_events -->
    <div
      bind:this={scrollEl}
      class="relative h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 select-none"
      onscroll={syncActiveSection}
      onclick={handleGridClick}
      onmouseover={handleGridHover}
      onfocusin={handleGridHover}
      onmouseleave={() => (hovered = null)}
      onkeydown={handleGridKeydown}
    >
      {#if term}
        {#if serverMatches.length || unicodeMatches.length}
          <div class="emoji-grid pt-2">
            {#each serverMatches as emoji (emoji.id)}{@render customCell(emoji)}{/each}
            {#each unicodeMatches as emoji (emoji.unicode)}{@render unicodeCell(emoji.unicode, emoji.label)}{/each}
          </div>
        {:else if !catalog && !catalogError}
          <p class="py-8 text-center text-body-sm text-on-surface-variant">{m.d1_emoji_catalog_loading()}</p>
        {:else}
          <p class="py-8 text-center text-body-sm text-on-surface-variant">{m.d1_emoji_no_match({ term })}</p>
        {/if}
      {:else}
        {#if recentCells.length}
          <section data-section="recent">
            <h4 class="emoji-heading">{m.d1_emoji_recent()}</h4>
            <div class="emoji-grid">
              {#each recentCells as cell, i (i)}
                {#if cell.custom}{@render customCell(cell.custom)}{:else}{@render unicodeCell(cell.unicode, cell.label)}{/if}
              {/each}
            </div>
          </section>
        {/if}

        {#if showServer}
          <section data-section="server">
            <h4 class="emoji-heading flex items-center justify-between gap-2">
              <span>{m.d1_emoji_this_server()}</span>
              {#if emojiSet}
                <span class="font-normal">{m.d1_emoji_server_slots({ used: String(emojiSet.slots.staticUsed), total: String(emojiSet.slots.total) })}</span>
              {/if}
            </h4>
            {#if loadingServer}
              <p class="px-1 py-3 text-body-sm text-on-surface-variant">{m.d1_emoji_server_loading()}</p>
            {:else if serverError}
              <p class="px-1 py-3 text-body-sm text-error">{serverError}</p>
            {:else}
              <div class="emoji-grid">
                {#each serverEmojis as emoji (emoji.id)}{@render customCell(emoji)}{/each}
                {#if emojiSet?.canUpload}
                  <button type="button" class="emoji-cell border border-dashed border-outline-variant text-on-surface-variant" title={m.d1_emoji_upload_title()} aria-label={m.d1_emoji_upload_title()} onclick={(e) => { e.stopPropagation(); openUpload(); }}>
                    <Papicon icon="plus" size={16} />
                  </button>
                {/if}
              </div>
              {#if serverEmojis.length === 0}
                <p class="px-1 pt-1 text-xs text-on-surface-variant">{m.d1_emoji_server_empty()}</p>
              {/if}
            {/if}
          </section>
        {/if}

        {#if catalog}
          {#each catalog as group (group.key)}
            <section data-section={group.key}>
              <h4 class="emoji-heading">{group.label}</h4>
              <div class="emoji-grid">
                {#each group.emojis as emoji (emoji.unicode)}{@render unicodeCell(emoji.unicode, emoji.label)}{/each}
              </div>
            </section>
          {/each}
        {:else if catalogError}
          <p class="py-6 text-center text-body-sm text-error">{m.d1_emoji_catalog_failed()}</p>
        {:else}
          <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.d1_emoji_catalog_loading()}</p>
        {/if}
      {/if}
    </div>

    <footer class="flex min-h-14 items-center gap-3 border-t border-outline-variant px-3 py-2">
      {#if hovered}
        <span class="flex h-9 w-9 shrink-0 items-center justify-center text-3xl">
          {#if hovered.url}<img src={hovered.url} alt="" class="h-8 w-8 object-contain" />{:else}{hovered.unicode}{/if}
        </span>
        <span class="min-w-0 truncate text-body-sm text-on-surface">{hovered.label}</span>
      {:else if current}
        <span class="flex h-9 w-9 shrink-0 items-center justify-center text-3xl">
          {#if current.kind === 'image'}<img src={current.url} alt="" class="h-8 w-8 object-contain" />{:else}{current.value}{/if}
        </span>
        <span class="min-w-0 flex-1 truncate text-body-sm text-on-surface-variant">{m.d1_emoji_selected()}</span>
        {#if onclear}
          <Button size="sm" variant="ghost" icon="x" onclick={onclear}>{m.d1_emoji_remove()}</Button>
        {/if}
      {:else}
        <span class="text-body-sm text-on-surface-variant">{m.d1_emoji_hover_hint()}</span>
      {/if}
    </footer>
  {/if}
</div>

<style>
  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 0.125rem;
  }

  .emoji-heading {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0.5rem 0.25rem 0.375rem;
    background: var(--surface-container-lowest);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--on-surface-variant);
  }

  .emoji-cell {
    display: flex;
    aspect-ratio: 1;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    line-height: 1;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .emoji-cell:hover,
  .emoji-cell:focus-visible {
    background: var(--surface-container-high);
  }

  .emoji-cell:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: -2px;
  }
</style>
