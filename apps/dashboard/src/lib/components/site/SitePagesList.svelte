<script lang="ts">
  /**
   * Pages d'un type : pages libres (menu, accueil), wiki (arborescence) ou blog
   * (par date). Création, ordre, page d'accueil, suppression ; l'édition ouvre
   * l'éditeur WYSIWYG.
   */
  import { router } from 'tinro';
  import { Button, EmptyState, Field, Modal, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m, dateLocale } from '../../i18n';
  import {
    createSitePage,
    deleteSitePage,
    reorderSitePages,
    updateSite,
    type SitePageKind,
    type SitePageSummary,
    type SiteState,
  } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { siteState, guildId, kind, onChanged }: { siteState: SiteState; guildId: string; kind: SitePageKind; onChanged: () => void } = $props();

  const site = $derived(siteState.site!);
  let createOpen = $state(false);
  let newTitle = $state('');
  let newParent = $state('');
  let creating = $state(false);
  let query = $state('');

  const pages = $derived(siteState.pages.filter((p) => p.kind === kind));

  /** Lignes affichées : arborescence pour le wiki, date pour le blog, ordre du menu sinon. */
  const rows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q) return pages.filter((p) => p.title.toLowerCase().includes(q) || p.slug.includes(q)).map((page) => ({ page, depth: 0 }));
    if (kind === 'BLOG') {
      return [...pages]
        .sort((a, b) => (b.firstPublishedAt ?? b.updatedAt).localeCompare(a.firstPublishedAt ?? a.updatedAt))
        .map((page) => ({ page, depth: 0 }));
    }
    if (kind === 'WIKI') {
      const ids = new Set(pages.map((p) => p.id));
      const out: Array<{ page: SitePageSummary; depth: number }> = [];
      const walk = (parentId: string | null, depth: number) => {
        pages
          .filter((p) => (p.parentId && ids.has(p.parentId) ? p.parentId : null) === parentId)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .forEach((page) => {
            out.push({ page, depth });
            if (depth < 8) walk(page.id, depth + 1);
          });
      };
      walk(null, 0);
      return out;
    }
    return [...pages].sort((a, b) => a.sortOrder - b.sortOrder).map((page) => ({ page, depth: 0 }));
  });

  function publicUrl(page: SitePageSummary): string {
    const base = `${siteState.baseUrl}${site.slug}`;
    if (page.id === site.homePageId) return base;
    return kind === 'WIKI' ? `${base}/wiki/${page.slug}` : kind === 'BLOG' ? `${base}/blog/${page.slug}` : `${base}/${page.slug}`;
  }

  function status(page: SitePageSummary): { label: string; tone: string } {
    if (page.scheduledAt) return { label: m.ste_status_scheduled({ date: new Date(page.scheduledAt).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) }), tone: 'info' };
    if (!page.publishedAt) return { label: m.ste_status_draft(), tone: 'muted' };
    if (page.hasUnpublishedChanges) return { label: m.ste_status_changes(), tone: 'warning' };
    return { label: m.ste_status_published(), tone: 'ok' };
  }

  const VISIBILITY_ICON: Record<string, string> = { PUBLIC: '🌐', MEMBERS: '👥', ROLES: '🎭', STAFF: '🛡️' };

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    creating = true;
    try {
      const { page } = await createSitePage({ kind, title: newTitle.trim(), parentId: kind === 'WIKI' && newParent ? newParent : null }, guildId);
      createOpen = false;
      newTitle = '';
      router.goto(`/site/edit/${page.id}`);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      creating = false;
    }
  }

  /** Échange une page avec sa voisine parmi ses sœurs (même parent pour le wiki). */
  async function move(page: SitePageSummary, direction: -1 | 1) {
    const siblings = pages.filter((p) => (kind === 'WIKI' ? (p.parentId ?? null) === (page.parentId ?? null) : true)).sort((a, b) => a.sortOrder - b.sortOrder);
    const index = siblings.findIndex((p) => p.id === page.id);
    const target = index + direction;
    if (target < 0 || target >= siblings.length) return;
    const ordered = [...siblings];
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    try {
      await reorderSitePages(kind, ordered.map((p) => p.id), guildId);
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function setHome(page: SitePageSummary) {
    try {
      await updateSite({ homePageId: page.id }, guildId);
      toast.success(m.ste_home_set());
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function remove(page: SitePageSummary) {
    const ok = await confirmDialog.ask({ title: m.ste_delete_page_title(), description: m.ste_delete_page_confirm({ title: page.title }), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteSitePage(page.id, guildId);
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  const titles: Record<SitePageKind, () => string> = { PAGE: () => m.ste_kind_pages(), WIKI: () => m.ste_kind_wiki(), BLOG: () => m.ste_kind_blog() };
  const descriptions: Record<SitePageKind, () => string> = { PAGE: () => m.ste_pages_desc(), WIKI: () => m.ste_wiki_desc(), BLOG: () => m.ste_blog_desc() };
  const newLabels: Record<SitePageKind, () => string> = { PAGE: () => m.ste_new_page(), WIKI: () => m.ste_new_wiki_page(), BLOG: () => m.ste_new_article() };
</script>

<SectionCard title={titles[kind]()} description={descriptions[kind]()} flush>
  {#snippet actions()}
    <input class="input input-sm w-48" type="search" placeholder={m.ste_search_pages()} aria-label={m.ste_search_pages()} bind:value={query} />
    <Button size="sm" variant="primary" icon="plus" onclick={() => (createOpen = true)}>{newLabels[kind]()}</Button>
  {/snippet}

  {#if rows.length === 0}
    <div class="p-6"><EmptyState icon="file-text" title={query ? m.ste_search_none() : m.ste_pages_empty()} description={query ? '' : m.ste_pages_empty_desc()} /></div>
  {:else}
    <ul class="page-list">
      {#each rows as { page, depth } (page.id)}
        {@const st = status(page)}
        <li style="--depth:{depth}">
          <a class="page-main" href={`/site/edit/${page.id}`}>
            <span class="page-vis" title={page.visibility} aria-hidden="true">{VISIBILITY_ICON[page.visibility]}</span>
            <span class="min-w-0">
              <span class="page-title">{page.title}{#if page.id === site.homePageId}<span class="page-home">{m.ste_home_badge()}</span>{/if}</span>
              <span class="page-sub">/{page.slug}{#if page.tags.length} · {page.tags.join(', ')}{/if} · {new Date(page.updatedAt).toLocaleDateString(dateLocale(), { dateStyle: 'medium' })}</span>
            </span>
          </a>
          <span class="page-pill page-pill-{st.tone}">{st.label}</span>
          <div class="page-actions">
            {#if kind !== 'BLOG' && !query}
              <Button size="sm" variant="ghost" icon="arrow-up" aria-label={m.ste_move_up()} onclick={() => move(page, -1)} />
              <Button size="sm" variant="ghost" icon="arrow-down" aria-label={m.ste_move_down()} onclick={() => move(page, 1)} />
            {/if}
            {#if kind === 'PAGE' && page.id !== site.homePageId && siteState.rights.manage}
              <Button size="sm" variant="ghost" icon="home" aria-label={m.ste_set_home()} title={m.ste_set_home()} onclick={() => setHome(page)} />
            {/if}
            {#if page.publishedAt}
              <Button size="sm" variant="ghost" icon="external-link" aria-label={m.ste_view()} href={publicUrl(page)} target="_blank" />
            {/if}
            <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => remove(page)} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</SectionCard>

<Modal bind:open={createOpen} title={newLabels[kind]()} size="sm">
  <form id="site-new-page" class="space-y-4" onsubmit={create}>
    <Field label={m.ste_page_title()} required>
      {#snippet children(id)}
        <!-- svelte-ignore a11y_autofocus -->
        <input {id} class="input w-full" maxlength="140" bind:value={newTitle} autofocus />
      {/snippet}
    </Field>
    {#if kind === 'WIKI'}
      <Field label={m.ste_parent()}>
        {#snippet children(id)}
          <select {id} class="input w-full" bind:value={newParent}>
            <option value="">{m.ste_parent_root()}</option>
            {#each pages as page (page.id)}<option value={page.id}>{page.title}</option>{/each}
          </select>
        {/snippet}
      </Field>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (createOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="site-new-page" loading={creating} disabled={!newTitle.trim()}>{m.ste_create_and_edit()}</Button>
  {/snippet}
</Modal>

<style>
  .page-list { list-style: none; margin: 0; padding: 0; }
  .page-list li { display: flex; align-items: center; gap: 12px; padding: 10px 16px 10px calc(16px + var(--depth) * 22px); border-top: 1px solid rgb(255 255 255 / 0.06); }
  .page-main { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; text-decoration: none; color: inherit; }
  .page-main:hover .page-title { color: rgb(167 139 250); }
  .page-vis { flex: none; width: 24px; text-align: center; }
  .page-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.92rem; }
  .page-home { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 6px; border-radius: 999px; background: rgb(124 108 255 / 0.2); color: #c4b5fd; }
  .page-sub { display: block; font-size: 0.75rem; color: rgb(255 255 255 / 0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .page-pill { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: rgb(255 255 255 / 0.08); color: rgb(255 255 255 / 0.7); }
  .page-pill-ok { background: rgb(34 197 94 / 0.14); color: #4ade80; }
  .page-pill-warning { background: rgb(245 158 11 / 0.14); color: #fbbf24; }
  .page-pill-info { background: rgb(59 130 246 / 0.14); color: #60a5fa; }
  .page-actions { flex: none; display: flex; gap: 2px; }
  @media (max-width: 720px) { .page-pill { display: none; } }
</style>
