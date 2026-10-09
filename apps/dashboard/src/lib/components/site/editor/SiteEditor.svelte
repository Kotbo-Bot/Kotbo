<script lang="ts">
  /**
   * Éditeur WYSIWYG d'une page du site.
   *
   * La page s'édite telle qu'elle s'affichera : canevas aux couleurs et polices
   * du thème du site. Barre flottante à la sélection, menu « / » pour insérer
   * un bloc, raccourcis Markdown à la frappe (ceux de Tiptap), images collées
   * ou déposées téléversées d'office.
   *
   * À plusieurs : le document vit dans Yjs, synchronisé par le serveur de
   * l'API (protocole y-websocket), avec le curseur et le nom de chacun. Si la
   * connexion ne s'établit pas, l'éditeur repasse seul, sur le brouillon, et
   * la page enregistre par l'API classique.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Editor, type JSONContent } from '@tiptap/core';
  import { NodeSelection } from '@tiptap/pm/state';
  import StarterKit from '@tiptap/starter-kit';
  import { TableKit } from '@tiptap/extension-table';
  import { TaskItem, TaskList } from '@tiptap/extension-list';
  import { TextAlign } from '@tiptap/extension-text-align';
  import { Subscript } from '@tiptap/extension-subscript';
  import { Superscript } from '@tiptap/extension-superscript';
  import { Placeholder } from '@tiptap/extensions';
  import { BubbleMenu } from '@tiptap/extension-bubble-menu';
  import { Collaboration } from '@tiptap/extension-collaboration';
  import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import {
    normalizeSiteDocument,
    resolveSiteTheme,
    sanitizeSiteHref,
    siteFontStylesheetUrl,
    siteIconSvg,
    sitePaletteVars,
    SITE_HIGHLIGHT_COLORS,
    isSiteModuleKey,
    type SiteDocument,
    type SiteIconName,
  } from '@kotbo/shared';
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { siteCollabUrl, uploadSiteAsset, type SiteCatalog, type SitePageSummary } from '../../../api/site';
  import { siteErrorMessage } from '../siteErrors';
  import {
    Callout,
    Faq,
    FaqItem,
    Grid,
    GridCell,
    isAllowedSiteUri,
    ModuleNode,
    SiteButton,
    SiteHighlight,
    SiteImage,
    SiteNodesBridge,
    Toc,
    Video,
    type ConfigureRequest,
  } from './siteNodes';
  import { SlashMenu } from './slashMenu';
  import { buildSlashItems, moduleLabel, moduleSummary, MODULE_ICONS } from './siteBlocks';
  import NodeConfigModal from './NodeConfigModal.svelte';
  import AssetPicker from './AssetPicker.svelte';
  import './siteCanvas.css';

  export type CollabStatus = 'solo' | 'connecting' | 'connected' | 'disconnected';
  export interface Collaborator {
    name: string;
    color: string;
  }

  let {
    guildId,
    pageId,
    initialContent,
    collaborative = true,
    wide = false,
    user,
    catalog,
    pages,
    theme,
    themeSettings,
    canManageAssets = false,
    readOnly = false,
    editor = $bindable<Editor | null>(null),
    onChange,
    onStatus,
    onPeers,
  }: {
    guildId: string;
    pageId: string;
    initialContent: SiteDocument;
    collaborative?: boolean;
    wide?: boolean;
    user: Collaborator;
    catalog: SiteCatalog | null;
    pages: SitePageSummary[];
    theme: string;
    themeSettings: unknown;
    canManageAssets?: boolean;
    /** Lecture seule : un agent tient la main sur le site. */
    readOnly?: boolean;
    editor?: Editor | null;
    /** Document modifié (mode solo uniquement : à plusieurs, le serveur enregistre). */
    onChange?: (doc: SiteDocument) => void;
    onStatus?: (status: CollabStatus) => void;
    onPeers?: (peers: Collaborator[]) => void;
  } = $props();

  const resolved = $derived(resolveSiteTheme(theme, themeSettings));
  const canvasStyle = $derived(
    [
      // Palette affichée par défaut sur le site (claire quand le mode suit l'appareil).
      sitePaletteVars(resolved.initial),
      `--site-accent:${resolved.accent}`,
      `--site-on-accent:${resolved.onAccent}`,
      `--site-radius:${resolved.radius}px`,
      `--site-font:"${resolved.font}"`,
      `--site-heading-font:"${resolved.headingFont}"`,
    ].join(';'),
  );

  let host = $state<HTMLDivElement | null>(null);
  let bubble = $state<HTMLDivElement | null>(null);
  let tick = $state(0);
  let configRequest = $state<ConfigureRequest | null>(null);
  let pickerOpen = $state(false);
  let pickerCallback: ((src: string) => void) | null = null;
  let videoCallback: ((attrs: { provider: string; videoId: string; caption: string }) => void) | null = null;
  let linkOpen = $state(false);
  let linkValue = $state('');
  let linkPage = $state('');

  let ydoc: Y.Doc | null = null;
  let provider: WebsocketProvider | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const active = $derived.by(() => {
    void tick;
    const e = editor;
    if (!e) return null;
    return {
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      table: e.isActive('table'),
      align: (['center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      highlight: SITE_HIGHLIGHT_COLORS.find((c) => e.isActive('highlight', { color: c })) ?? null,
    };
  });

  function describeModule(key: string, config: Record<string, unknown>): { label: string; summary: string; icon: SiteIconName; available: boolean } {
    if (!isSiteModuleKey(key)) return { label: key, summary: '', icon: 'puzzle', available: true };
    const block = catalog?.blocks.find((b) => b.key === key);
    return { label: moduleLabel(key), summary: moduleSummary(key, config, catalog), icon: MODULE_ICONS[key], available: block?.available !== false };
  }

  function insertUploaded(file: File, at?: number) {
    uploadSiteAsset(file, guildId)
      .then((asset) => {
        const chain = editor?.chain().focus();
        if (!chain) return;
        (typeof at === 'number' ? chain.insertContentAt(at, { type: 'image', attrs: { src: asset.url, alt: '', caption: '', width: 'wide' } }) : chain.insertContent({ type: 'image', attrs: { src: asset.url, alt: '', caption: '', width: 'wide' } })).run();
      })
      .catch((err) => toast.error(siteErrorMessage(err)));
  }

  function imageFiles(list: FileList | null | undefined): File[] {
    return [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
  }

  function createEditor(mode: 'collab' | 'solo') {
    if (!host || !bubble) return;
    const extensions = [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        undoRedo: mode === 'collab' ? false : undefined,
        link: { openOnClick: false, autolink: true, isAllowedUri: (url) => isAllowedSiteUri(url), HTMLAttributes: { rel: 'noopener noreferrer' } },
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Subscript,
      Superscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading' ? m.ste_placeholder_heading() : m.ste_placeholder()),
        includeChildren: false,
      }),
      SiteHighlight,
      SiteImage,
      Callout,
      Grid,
      GridCell,
      SiteButton,
      Faq,
      FaqItem,
      Video,
      Toc,
      ModuleNode,
      SiteNodesBridge,
      SlashMenu.configure({
        emptyLabel: m.ste_slash_empty(),
        items: () =>
          buildSlashItems({
            catalog,
            pickImage: (insertAt) => {
              pickerCallback = insertAt;
              pickerOpen = true;
            },
            pickVideo: (insert) => {
              videoCallback = insert;
              configRequest = { type: 'video', pos: -1, attrs: { provider: 'youtube', videoId: '', caption: '' } };
            },
            configureAt: (type, pos, attrs) => (configRequest = { type, pos, attrs }),
          }),
      }),
      BubbleMenu.configure({
        element: bubble,
        shouldShow: ({ state, editor: e }) => !state.selection.empty && !(state.selection instanceof NodeSelection) && e.isEditable,
      }),
    ];
    if (mode === 'collab' && ydoc && provider) {
      extensions.push(Collaboration.configure({ document: ydoc, field: 'default' }) as never);
      extensions.push(CollaborationCaret.configure({ provider, user }) as never);
    }

    const instance = new Editor({
      element: host,
      extensions,
      content: mode === 'solo' ? (initialContent as JSONContent) : undefined,
      editorProps: {
        attributes: { class: 'site-prose', spellcheck: 'true' },
        handlePaste: (_view, event) => {
          const files = imageFiles(event.clipboardData?.files);
          if (files.length === 0) return false;
          files.forEach((file) => insertUploaded(file));
          return true;
        },
        handleDrop: (view, event) => {
          const files = imageFiles((event as DragEvent).dataTransfer?.files);
          if (files.length === 0) return false;
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          files.forEach((file) => insertUploaded(file, coords?.pos));
          return true;
        },
      },
      onTransaction: () => {
        tick += 1;
      },
      onUpdate: ({ editor: e }) => {
        if (mode === 'solo') onChange?.(normalizeSiteDocument(e.getJSON()));
      },
    });
    instance.storage.siteNodes.onConfigure = (request) => (configRequest = request);
    instance.storage.siteNodes.describeModule = describeModule;
    instance.storage.siteNodes.labels = {
      configure: m.ste_configure(),
      moduleOff: m.ste_block_unavailable(),
      caption: m.ste_caption_placeholder(),
      altText: m.ste_alt_text(),
      width_small: m.ste_width_small(),
      width_medium: m.ste_width_medium(),
      width_wide: m.ste_width_wide(),
      width_full: m.ste_width_full(),
      calloutStyle: m.ste_callout_style(),
      cellSettings: m.ste_cell_title(),
      buttonEmpty: m.ste_button_default(),
      faqQuestion: m.ste_faq_question(),
      video: m.ste_item_video(),
      toc: m.ste_item_toc(),
      tocSummary: m.ste_item_toc_desc(),
    };
    editor = instance;
  }

  function startSolo() {
    teardownCollab();
    onStatus?.('solo');
    createEditor('solo');
  }

  function teardownCollab() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    provider?.destroy();
    provider = null;
    ydoc?.destroy();
    ydoc = null;
  }

  function startCollab() {
    ydoc = new Y.Doc();
    provider = new WebsocketProvider(siteCollabUrl(guildId), pageId, ydoc, { disableBc: true, maxBackoffTime: 5000 });
    provider.awareness.setLocalStateField('user', user);
    onStatus?.('connecting');
    let synced = false;
    provider.on('status', ({ status }: { status: string }) => {
      if (synced) onStatus?.(status === 'connected' ? 'connected' : 'disconnected');
    });
    provider.on('sync', (isSynced: boolean) => {
      if (!isSynced || synced || destroyed) return;
      synced = true;
      if (syncTimer) clearTimeout(syncTimer);
      onStatus?.('connected');
      createEditor('collab');
    });
    provider.on('connection-close', (event: CloseEvent | null) => {
      // Brouillon remplacé (restauration d'une révision) : on repart de zéro.
      if (event?.code === 4409 && !destroyed) {
        editor?.destroy();
        editor = null;
        teardownCollab();
        startCollab();
      }
    });
    provider.awareness.on('change', () => {
      const peers = [...(provider?.awareness.getStates().entries() ?? [])]
        .filter(([id]) => id !== provider?.awareness.clientID)
        .map(([, state]) => (state as { user?: Collaborator }).user)
        .filter((u): u is Collaborator => Boolean(u?.name));
      onPeers?.(peers);
    });
    // Pas de synchronisation à temps : l'éditeur passe seul plutôt que de rester vide.
    syncTimer = setTimeout(() => {
      if (!synced && !destroyed) {
        toast.info(m.ste_collab_unavailable());
        startSolo();
      }
    }, 6000);
  }

  $effect(() => {
    editor?.setEditable(!readOnly);
  });

  onMount(() => {
    if (collaborative) startCollab();
    else startSolo();
  });

  onDestroy(() => {
    destroyed = true;
    editor?.destroy();
    editor = null;
    teardownCollab();
  });

  function saveNode(pos: number, attrs: Record<string, unknown>) {
    if (!editor) return;
    if (pos < 0 && videoCallback) {
      videoCallback(attrs as { provider: string; videoId: string; caption: string });
      videoCallback = null;
      return;
    }
    editor.chain().command(({ tr }) => {
      const node = tr.doc.nodeAt(pos);
      if (!node) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      return true;
    }).run();
  }

  // ─── Lien ────────────────────────────────────────────────────────────────

  function openLink() {
    linkValue = (editor?.getAttributes('link').href as string | undefined) ?? '';
    linkPage = '';
    linkOpen = true;
  }

  function pageHref(page: SitePageSummary): string {
    return page.kind === 'WIKI' ? `/~/wiki/${page.slug}` : page.kind === 'BLOG' ? `/~/blog/${page.slug}` : `/~/${page.slug}`;
  }

  function applyLink() {
    if (!editor) return;
    const href = (linkPage || linkValue).trim();
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else if (sanitizeSiteHref(href)) {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    } else {
      toast.error(m.ste_link_invalid());
      return;
    }
    linkOpen = false;
  }
</script>

<svelte:head>
  <link rel="stylesheet" href={siteFontStylesheetUrl(resolved)} />
</svelte:head>

<div class="site-canvas" class:is-wide={wide} class:is-readonly={readOnly} style={canvasStyle}>
  <div bind:this={host}></div>
</div>

<div bind:this={bubble} class="site-bubble" role="toolbar" aria-label={m.ste_toolbar_label()}>
  {#if active}
    {#if linkOpen}
      <form class="site-bubble-link" onsubmit={(e) => { e.preventDefault(); applyLink(); }}>
        <select class="site-bubble-select" bind:value={linkPage} aria-label={m.ste_link_page()}>
          <option value="">{m.ste_link_url()}</option>
          {#each pages as page (page.id)}
            <option value={pageHref(page)}>{page.title}</option>
          {/each}
        </select>
        {#if !linkPage}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="site-bubble-input" type="text" placeholder="https://" bind:value={linkValue} autofocus />
        {/if}
        <button type="submit" class="site-bubble-btn">{m.ste_link_apply()}</button>
        <button type="button" class="site-bubble-btn" onclick={() => (linkOpen = false)}>×</button>
      </form>
    {:else}
      <button type="button" class="site-bubble-btn" class:is-on={active.bold} aria-pressed={active.bold} title={m.ste_fmt_bold()} onclick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
      <button type="button" class="site-bubble-btn" class:is-on={active.italic} aria-pressed={active.italic} title={m.ste_fmt_italic()} onclick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
      <button type="button" class="site-bubble-btn" class:is-on={active.underline} aria-pressed={active.underline} title={m.ste_fmt_underline()} onclick={() => editor?.chain().focus().toggleUnderline().run()}><u>U</u></button>
      <button type="button" class="site-bubble-btn" class:is-on={active.strike} aria-pressed={active.strike} title={m.ste_fmt_strike()} onclick={() => editor?.chain().focus().toggleStrike().run()}><s>S</s></button>
      <button type="button" class="site-bubble-btn" class:is-on={active.code} aria-pressed={active.code} title={m.ste_fmt_code()} onclick={() => editor?.chain().focus().toggleCode().run()}>&lt;/&gt;</button>
      <button type="button" class="site-bubble-btn" class:is-on={active.link} aria-pressed={active.link} title={m.ste_fmt_link()} onclick={openLink}>{@html siteIconSvg('link', 16)}</button>
      <span class="site-bubble-sep" aria-hidden="true"></span>
      {#each SITE_HIGHLIGHT_COLORS as color (color)}
        <button
          type="button"
          class="site-bubble-swatch hl-{color}"
          class:is-on={active.highlight === color}
          aria-pressed={active.highlight === color}
          title={m.ste_fmt_highlight()}
          aria-label={`${m.ste_fmt_highlight()} ${color}`}
          onclick={() => editor?.chain().focus().toggleMark('highlight', { color }).run()}
        ></button>
      {/each}
      <span class="site-bubble-sep" aria-hidden="true"></span>
      {#each [['left', 'align-left'], ['center', 'align-center'], ['right', 'align-right']] as const as [align, glyph] (align)}
        <button type="button" class="site-bubble-btn" class:is-on={active.align === align} aria-pressed={active.align === align} title={m.ste_fmt_align()} onclick={() => editor?.chain().focus().setTextAlign(align).run()}>{@html siteIconSvg(glyph, 16)}</button>
      {/each}
      <button type="button" class="site-bubble-btn" class:is-on={active.sup} aria-pressed={active.sup} title={m.ste_fmt_sup()} onclick={() => editor?.chain().focus().toggleSuperscript().run()}>x²</button>
      <button type="button" class="site-bubble-btn" class:is-on={active.sub} aria-pressed={active.sub} title={m.ste_fmt_sub()} onclick={() => editor?.chain().focus().toggleSubscript().run()}>x₂</button>
      {#if active.table}
        <span class="site-bubble-sep" aria-hidden="true"></span>
        <button type="button" class="site-bubble-btn" title={m.ste_table_row()} onclick={() => editor?.chain().focus().addRowAfter().run()}>{@html siteIconSvg('row-add', 16)}</button>
        <button type="button" class="site-bubble-btn" title={m.ste_table_col()} onclick={() => editor?.chain().focus().addColumnAfter().run()}>{@html siteIconSvg('col-add', 16)}</button>
        <button type="button" class="site-bubble-btn" title={m.ste_table_del_row()} onclick={() => editor?.chain().focus().deleteRow().run()}>{@html siteIconSvg('row-remove', 16)}</button>
        <button type="button" class="site-bubble-btn" title={m.ste_table_del_col()} onclick={() => editor?.chain().focus().deleteColumn().run()}>{@html siteIconSvg('col-remove', 16)}</button>
        <button type="button" class="site-bubble-btn" title={m.ste_table_delete()} onclick={() => editor?.chain().focus().deleteTable().run()}>{@html siteIconSvg('trash', 16)}</button>
      {/if}
    {/if}
  {/if}
</div>

<NodeConfigModal bind:request={configRequest} {catalog} {pages} onSave={saveNode} />
<AssetPicker
  bind:open={pickerOpen}
  {guildId}
  canDelete={canManageAssets}
  onPick={(asset) => {
    pickerCallback?.(asset.url);
    pickerCallback = null;
  }}
/>

<style>
  .site-bubble {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-high);
    box-shadow: 0 10px 26px rgb(0 0 0 / 0.25);
    z-index: 50;
  }
  .site-bubble-btn {
    min-width: 30px;
    height: 30px;
    padding: 0 6px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--color-on-surface);
    font: 600 13px/1 Inter, system-ui, sans-serif;
    cursor: pointer;
  }
  .site-bubble-btn:hover { background: var(--color-surface-hover); }
  .site-bubble-btn.is-on { background: color-mix(in srgb, var(--color-primary) 28%, transparent); color: #fff; }
  .site-bubble-sep { width: 1px; height: 20px; background: var(--color-surface-container); margin: 0 3px; }
  .site-bubble-swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; margin: 0 1px; }
  .site-bubble-swatch.is-on { border-color: #fff; }
  .site-bubble-swatch.hl-accent { background: var(--site-accent, var(--color-primary)); } .site-bubble-swatch.hl-yellow { background: #facc15; } .site-bubble-swatch.hl-green { background: #22c55e; }
  .site-bubble-swatch.hl-blue { background: #3b82f6; } .site-bubble-swatch.hl-pink { background: #ec4899; } .site-bubble-swatch.hl-red { background: #ef4444; }
  .site-bubble-link { display: flex; align-items: center; gap: 4px; }
  .site-bubble-input, .site-bubble-select { height: 30px; border-radius: 7px; border: 1px solid var(--color-outline-variant); background: var(--color-surface-container); color: var(--color-on-surface); padding: 0 8px; font: 13px Inter, system-ui, sans-serif; }
  .site-bubble-input { width: 220px; }
  .site-bubble-select { max-width: 180px; }
</style>
