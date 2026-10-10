<script lang="ts">
  /**
   * Galerie de thèmes partagés : publier le style de son site (avec pages
   * modèles et menu au choix) et appliquer celui d'un autre serveur.
   */
  import { onMount } from 'svelte';
  import { Button, EmptyState, Field, Modal, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m } from '../../i18n';
  import {
    deleteThemeShare,
    fetchGallery,
    installThemeShare,
    publishThemeShare,
    reportThemeShare,
    type GalleryCard,
    type GalleryState,
    type SiteState,
  } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { siteState, guildId, onChanged }: { siteState: SiteState; guildId: string; onChanged: () => void } = $props();

  let gallery = $state<GalleryState | null>(null);
  let loading = $state(true);
  let sort = $state<'popular' | 'recent'>('popular');
  let search = $state('');
  let page = $state(1);

  async function load() {
    loading = true;
    try {
      gallery = await fetchGallery({ sort, q: search.trim(), page }, guildId);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      loading = false;
    }
  }

  onMount(load);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function onSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      void load();
    }, 300);
  }

  // ─── Publier ──────────────────────────────────────────────────────────────

  const sitePages = $derived(siteState.pages.filter((p) => p.kind === 'PAGE'));
  let publishOpen = $state(false);
  let publishing = $state(false);
  let draft = $state({ id: '' as string, name: '', description: '', includeCss: true, includeMenu: true, pageIds: [] as string[] });

  function openPublish(own?: { id: string; name: string; description: string }) {
    draft = { id: own?.id ?? '', name: own?.name ?? siteState.site?.name ?? siteState.guild?.name ?? '', description: own?.description ?? '', includeCss: true, includeMenu: true, pageIds: [] };
    publishOpen = true;
  }

  function togglePage(id: string) {
    draft.pageIds = draft.pageIds.includes(id) ? draft.pageIds.filter((p) => p !== id) : draft.pageIds.length < 8 ? [...draft.pageIds, id] : draft.pageIds;
  }

  async function publish(event: SubmitEvent) {
    event.preventDefault();
    publishing = true;
    try {
      await publishThemeShare({ ...draft, id: draft.id || undefined }, guildId);
      toast.success(m.ste_gallery_published());
      publishOpen = false;
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      publishing = false;
    }
  }

  async function removeOwn(id: string, name: string) {
    const ok = await confirmDialog.ask({ title: m.ste_gallery_delete_title(), description: m.ste_gallery_delete_confirm({ name }), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteThemeShare(id, guildId);
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  // ─── Appliquer ────────────────────────────────────────────────────────────

  let installing = $state<GalleryCard | null>(null);
  let installOpen = $state(false);
  let installBusy = $state(false);
  let parts = $state({ style: true, css: false, templates: false, menu: false });

  function openInstall(card: GalleryCard) {
    installing = card;
    parts = { style: true, css: card.hasCss, templates: card.templates.length > 0, menu: false };
    installOpen = true;
  }

  async function install() {
    if (!installing) return;
    installBusy = true;
    try {
      const { pagesCreated } = await installThemeShare(installing.id, parts, guildId);
      toast.success(pagesCreated > 0 ? m.ste_gallery_installed_pages({ count: pagesCreated }) : m.ste_gallery_installed());
      installOpen = false;
      onChanged();
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      installBusy = false;
    }
  }

  async function report(card: GalleryCard) {
    const ok = await confirmDialog.ask({ title: m.ste_gallery_report_title(), description: m.ste_gallery_report_confirm({ name: card.name }), confirmLabel: m.ste_gallery_report() });
    if (!ok) return;
    try {
      await reportThemeShare(card.id, '', guildId);
      toast.success(m.ste_gallery_reported());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  const FONT_STACK = (font: string) => `'${font}', system-ui, sans-serif`;
</script>

<div class="space-y-4">
  <SectionCard title={m.ste_gallery_mine()} description={m.ste_gallery_mine_desc()} icon="upload">
    {#snippet actions()}
      <Button size="sm" icon="upload" onclick={() => openPublish()} disabled={(gallery?.own.length ?? 0) >= 5}>{m.ste_gallery_publish()}</Button>
    {/snippet}
    <div class="px-5 pb-5">
      {#if gallery && gallery.own.length > 0}
        <ul class="own-list">
          {#each gallery.own as own (own.id)}
            <li>
              <div class="min-w-0 flex-1">
                <p class="own-name">{own.name}{#if own.hidden} <span class="own-hidden">{m.ste_gallery_hidden()}</span>{/if}</p>
                <p class="own-meta">{m.ste_gallery_installs({ count: own.installs })}</p>
              </div>
              <Button size="sm" variant="ghost" onclick={() => openPublish(own)}>{m.ste_gallery_update()}</Button>
              <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => removeOwn(own.id, own.name)} />
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-body-sm text-on-surface-variant">{m.ste_gallery_mine_empty()}</p>
      {/if}
    </div>
  </SectionCard>

  <SectionCard title={m.ste_gallery_title()} description={m.ste_gallery_desc()} icon="layers">
    <div class="px-5 pb-5 space-y-4">
      <div class="flex flex-wrap items-center gap-3">
        <input class="input flex-1 min-w-[200px]" type="search" placeholder={m.ste_gallery_search()} bind:value={search} oninput={onSearch} />
        <select class="input w-auto" bind:value={sort} onchange={() => { page = 1; void load(); }}>
          <option value="popular">{m.ste_gallery_sort_popular()}</option>
          <option value="recent">{m.ste_gallery_sort_recent()}</option>
        </select>
      </div>

      {#if !loading && gallery && gallery.items.length === 0}
        <EmptyState icon="layers" title={m.ste_gallery_none()} description={m.ste_gallery_none_desc()} />
      {:else if gallery}
        <div class="gallery-grid">
          {#each gallery.items as card (card.id)}
            {@const p = card.preview.mode === 'dark' ? card.preview.dark : card.preview.light}
            <article class="gallery-card">
              <div class="preview" style="background:{p.bg};color:{p.text};font-family:{FONT_STACK(card.preview.font)};border-radius:{Math.min(card.preview.radius, 14)}px" aria-hidden="true">
                <div class="preview-bar" style="background:{p.header};border-color:{p.border}">
                  <span class="preview-dot" style="background:{p.accent}"></span>
                  <span class="preview-line" style="background:{p.muted}"></span>
                </div>
                <div class="preview-body">
                  <span class="preview-title" style="font-family:{FONT_STACK(card.preview.headingFont)}">Aa</span>
                  <span class="preview-card" style="background:{p.surface};border-color:{p.border};border-radius:{Math.min(card.preview.radius, 10)}px">
                    <span class="preview-line" style="background:{p.muted}"></span>
                    <span class="preview-btn" style="background:{p.accent};border-radius:{Math.min(card.preview.radius, 8)}px"></span>
                  </span>
                </div>
              </div>
              <div class="card-body">
                <p class="card-name">{card.name}</p>
                <p class="card-meta">{m.ste_gallery_by({ name: card.authorName })} · {m.ste_gallery_installs({ count: card.installs })}</p>
                {#if card.description}<p class="card-desc">{card.description}</p>{/if}
                <p class="card-chips">
                  {#if card.hasCss}<span>{m.ste_gallery_has_css()}</span>{/if}
                  {#if card.templates.length}<span>{m.ste_gallery_has_pages({ count: card.templates.length })}</span>{/if}
                  {#if card.hasMenu}<span>{m.ste_gallery_has_menu()}</span>{/if}
                  {#if card.installed}<span>{m.ste_gallery_installed_badge()}</span>{/if}
                </p>
                <div class="card-actions">
                  <Button size="sm" variant="primary" onclick={() => openInstall(card)}>{m.ste_gallery_apply()}</Button>
                  {#if !card.own}<Button size="sm" variant="ghost" onclick={() => report(card)}>{m.ste_gallery_report()}</Button>{/if}
                </div>
              </div>
            </article>
          {/each}
        </div>
        {#if gallery.pages > 1}
          <div class="flex items-center justify-between">
            <Button size="sm" variant="ghost" disabled={page <= 1} onclick={() => { page -= 1; void load(); }}>{m.ste_gallery_prev()}</Button>
            <span class="text-body-sm text-on-surface-variant">{page} / {gallery.pages}</span>
            <Button size="sm" variant="ghost" disabled={page >= gallery.pages} onclick={() => { page += 1; void load(); }}>{m.ste_gallery_next()}</Button>
          </div>
        {/if}
      {/if}
    </div>
  </SectionCard>
</div>

<Modal bind:open={publishOpen} title={draft.id ? m.ste_gallery_update() : m.ste_gallery_publish()} size="md">
  <form id="gallery-publish-form" class="space-y-4" onsubmit={publish}>
    <Field label={m.ste_gallery_name()} required>
      {#snippet children(id)}
        <input {id} class="input w-full" maxlength="60" required bind:value={draft.name} />
      {/snippet}
    </Field>
    <Field label={m.ste_gallery_description()}>
      {#snippet children(id)}
        <textarea {id} class="input w-full" rows="2" maxlength="300" bind:value={draft.description}></textarea>
      {/snippet}
    </Field>
    <p class="text-body-sm text-on-surface-variant">{m.ste_gallery_style_always()}</p>
    <label class="flex items-center gap-2 text-body-sm"><input type="checkbox" bind:checked={draft.includeCss} /> {m.ste_gallery_include_css()}</label>
    <label class="flex items-center gap-2 text-body-sm"><input type="checkbox" bind:checked={draft.includeMenu} /> {m.ste_gallery_include_menu()}</label>
    {#if sitePages.length > 0}
      <div class="space-y-1">
        <p class="text-body-sm font-medium text-on-surface">{m.ste_gallery_include_pages()}</p>
        <p class="text-body-sm text-on-surface-variant">{m.ste_gallery_include_pages_hint()}</p>
        <div class="page-grid">
          {#each sitePages as sitePage (sitePage.id)}
            <label class="flex items-center gap-2 text-body-sm">
              <input type="checkbox" checked={draft.pageIds.includes(sitePage.id)} onchange={() => togglePage(sitePage.id)} />
              <span>{sitePage.title}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
    <p class="text-body-sm text-on-surface-variant">{m.ste_gallery_public_notice()}</p>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (publishOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="gallery-publish-form" loading={publishing}>{m.ste_gallery_publish_confirm()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={installOpen} title={m.ste_gallery_apply_title({ name: installing?.name ?? '' })} size="sm">
  <div class="space-y-3">
    <label class="flex items-center gap-2 text-body-sm"><input type="checkbox" bind:checked={parts.style} /> {m.ste_gallery_part_style()}</label>
    {#if installing?.hasCss}
      <label class="flex items-center gap-2 text-body-sm"><input type="checkbox" bind:checked={parts.css} /> {m.ste_gallery_part_css()}</label>
    {/if}
    {#if installing && installing.templates.length > 0}
      <label class="flex items-center gap-2 text-body-sm"><input type="checkbox" bind:checked={parts.templates} /> {m.ste_gallery_part_pages({ count: installing.templates.length })}</label>
    {/if}
    {#if installing?.hasMenu}
      <label class="flex items-center gap-2 text-body-sm"><input type="checkbox" bind:checked={parts.menu} /> {m.ste_gallery_part_menu()}</label>
    {/if}
    <p class="text-body-sm text-on-surface-variant">{m.ste_gallery_apply_hint()}</p>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (installOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" loading={installBusy} disabled={!parts.style && !parts.css && !parts.templates && !parts.menu} onclick={install}>{m.ste_gallery_apply()}</Button>
  {/snippet}
</Modal>

<style>
  .own-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .own-list li { display: flex; align-items: center; gap: 8px; }
  .own-name { margin: 0; font-weight: 600; color: var(--color-on-surface); }
  .own-meta { margin: 0; font-size: 0.82rem; color: var(--color-on-surface-variant); }
  .own-hidden { font-size: 0.72rem; font-weight: 500; padding: 1px 7px; border-radius: 4px; background: var(--color-surface-container); color: var(--color-warning); }
  .gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .gallery-card { border: 1px solid var(--color-outline-variant); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; background: var(--color-surface); }
  .preview { margin: 10px 10px 0; height: 120px; overflow: hidden; border: 1px solid var(--color-outline-variant); display: flex; flex-direction: column; }
  .preview-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid; }
  .preview-dot { width: 10px; height: 10px; border-radius: 50%; }
  .preview-line { display: block; height: 5px; width: 50%; border-radius: 3px; opacity: 0.6; }
  .preview-body { flex: 1; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .preview-title { font-weight: 700; font-size: 1.1rem; line-height: 1; }
  .preview-card { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 1px solid; }
  .preview-btn { width: 36px; height: 14px; }
  .card-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .card-name { margin: 0; font-weight: 600; color: var(--color-on-surface); }
  .card-meta { margin: 0; font-size: 0.8rem; color: var(--color-on-surface-variant); }
  .card-desc { margin: 2px 0 0; font-size: 0.85rem; color: var(--color-on-surface); }
  .card-chips { margin: 4px 0 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .card-chips span { font-size: 0.72rem; padding: 1px 7px; border-radius: 4px; background: var(--color-surface-container); color: var(--color-on-surface-variant); }
  .card-actions { margin-top: auto; padding-top: 8px; display: flex; gap: 6px; }
  .page-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 12px; max-height: 160px; overflow: auto; }
</style>
