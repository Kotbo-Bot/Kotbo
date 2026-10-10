<script lang="ts">
  /**
   * Édition d'une page du site (page libre, page du wiki, article du blog).
   *
   * Le titre se tape en tête, le contenu dans le canevas WYSIWYG, les réglages
   * (adresse, visibilité, étiquettes, couverture, référencement) dans le
   * panneau latéral. Le brouillon s'enregistre seul ; « Publier » le met en
   * ligne et crée une version dans l'historique, d'où l'on peut revenir.
   */
  import { onDestroy, onMount } from 'svelte';
  import { router } from 'tinro';
  import type { Editor } from '@tiptap/core';
  import type { SiteDocument } from '@kotbo/shared';
  import SiteEditor, { type CollabStatus, type Collaborator } from '../lib/components/site/editor/SiteEditor.svelte';
  import AssetPicker from '../lib/components/site/editor/AssetPicker.svelte';
  import AgentLockBanner from '../lib/components/site/AgentLockBanner.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, Callout, EmptyState, Field, Modal } from '../lib/components/ui';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import {
    createSitePreviewLink,
    deleteSitePage,
    fetchSiteCatalog,
    fetchSitePage,
    fetchSiteRevisions,
    fetchSiteState,
    publishSitePage,
    restoreSiteRevision,
    scheduleSitePage,
    unpublishSitePage,
    updateSitePage,
    type SiteCatalog,
    type SitePageDetail,
    type SitePagePatch,
    type SiteRevision,
    type SiteState,
    type SiteVisibility,
  } from '../lib/api/site';
  import { siteErrorMessage } from '../lib/components/site/siteErrors';

  let { pageId }: { pageId: string } = $props();

  // « Mon espace » ouvre l'éditeur avec ?guild= : le rédacteur n'a pas forcément de serveur sélectionné.
  const guildId = $derived(($router.query.guild as string | undefined) ?? authStore.selectedGuildId ?? '');
  const fromSpace = $derived(Boolean($router.query.guild));

  let siteState = $state<SiteState | null>(null);
  let page = $state<SitePageDetail | null>(null);
  let catalog = $state<SiteCatalog | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let editor = $state<Editor | null>(null);

  let collabStatus = $state<CollabStatus>('connecting');
  let peers = $state<Collaborator[]>([]);
  let saving = $state(false);
  let lastSavedAt = $state<Date | null>(null);
  let panelOpen = $state(true);
  let publishing = $state(false);

  let historyOpen = $state(false);
  let revisions = $state<SiteRevision[]>([]);
  let scheduleOpen = $state(false);
  let scheduleValue = $state('');
  let coverPickerOpen = $state(false);
  let tagsInput = $state('');
  let agentLocked = $state(false);
  let agentBanner = $state<{ refresh: () => void } | null>(null);

  const me = $derived<Collaborator>({
    name: authStore.user?.username ?? 'Kotbo',
    color: colorFor(authStore.user?.id ?? 'x'),
  });

  function colorFor(id: string): string {
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 70% 55%)`;
  }

  const kindRoot = $derived(fromSpace ? '/me' : page?.kind === 'WIKI' ? '/site/wiki' : page?.kind === 'BLOG' ? '/site/blog' : '/site/pages');
  const publicUrl = $derived.by(() => {
    if (!siteState?.site || !page) return null;
    const base = `${siteState.baseUrl}${siteState.site.slug}`;
    if (page.id === siteState.site.homePageId) return base;
    return page.kind === 'WIKI' ? `${base}/wiki/${page.slug}` : page.kind === 'BLOG' ? `${base}/blog/${page.slug}` : `${base}/${page.slug}`;
  });

  const status = $derived.by(() => {
    if (!page) return { label: '', tone: 'muted' };
    if (page.scheduledAt) return { label: m.ste_status_scheduled({ date: new Date(page.scheduledAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) }), tone: 'info' };
    if (!page.publishedAt) return { label: m.ste_status_draft(), tone: 'muted' };
    if (page.hasUnpublishedChanges) return { label: m.ste_status_changes(), tone: 'warning' };
    return { label: m.ste_status_published(), tone: 'ok' };
  });

  async function load() {
    loading = true;
    failed = false;
    try {
      const [s, p, c] = await Promise.all([fetchSiteState(guildId), fetchSitePage(pageId, guildId), fetchSiteCatalog(guildId)]);
      siteState = s;
      page = p.page;
      catalog = c;
      tagsInput = p.page.tags.join(', ');
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // ─── Enregistrement ────────────────────────────────────────────────────────

  let pending: SitePagePatch = {};
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function queue(patch: SitePagePatch, delay = 900) {
    pending = { ...pending, ...patch };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(), delay);
  }

  async function flush(): Promise<boolean> {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!page || Object.keys(pending).length === 0) return true;
    const patch = pending;
    pending = {};
    saving = true;
    try {
      const { page: saved } = await updateSitePage(page.id, patch, guildId);
      page = { ...page, ...patch, slug: saved.slug, hasUnpublishedChanges: saved.hasUnpublishedChanges };
      lastSavedAt = new Date();
      return true;
    } catch (err) {
      pending = { ...patch, ...pending };
      toast.error(siteErrorMessage(err));
      agentBanner?.refresh();
      return false;
    } finally {
      saving = false;
    }
  }

  onDestroy(() => {
    if (Object.keys(pending).length > 0) void flush();
  });

  function onDocChange(doc: SiteDocument) {
    if (page) page.hasUnpublishedChanges = true;
    queue({ draftContent: doc }, 1500);
  }

  function setField<K extends keyof SitePagePatch>(key: K, value: SitePagePatch[K]) {
    if (!page) return;
    (page as unknown as Record<string, unknown>)[key] = value;
    queue({ [key]: value } as SitePagePatch);
  }

  function commitTags() {
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10);
    setField('tags', tags);
  }

  // ─── Publication ───────────────────────────────────────────────────────────

  async function publish() {
    if (!page) return;
    publishing = true;
    try {
      if (!(await flush())) return;
      const { page: published } = await publishSitePage(page.id, undefined, guildId);
      page = { ...page, publishedAt: published.publishedAt, firstPublishedAt: page.firstPublishedAt ?? published.publishedAt, hasUnpublishedChanges: false, scheduledAt: null, publishedTitle: page.title };
      toast.success(m.ste_published_toast());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      publishing = false;
    }
  }

  async function unpublish() {
    if (!page) return;
    const ok = await confirmDialog.ask({ title: m.ste_unpublish_title(), description: m.ste_unpublish_confirm(), confirmLabel: m.ste_unpublish(), variant: 'danger' });
    if (!ok) return;
    try {
      await unpublishSitePage(page.id, guildId);
      page = { ...page, publishedAt: null, hasUnpublishedChanges: true };
      toast.success(m.ste_unpublished_toast());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function schedule(at: string | null) {
    if (!page) return;
    try {
      if (!(await flush())) return;
      const { scheduledAt } = await scheduleSitePage(page.id, at ? new Date(at).toISOString() : null, guildId);
      page = { ...page, scheduledAt };
      scheduleOpen = false;
      toast.success(scheduledAt ? m.ste_scheduled_toast() : m.ste_unscheduled_toast());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function preview() {
    if (!page) return;
    // Ouvert tout de suite (sinon bloqué comme fenêtre surgissante), rempli ensuite.
    const tab = window.open('about:blank', '_blank');
    try {
      await flush();
      const { url } = await createSitePreviewLink(page.id, guildId);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      }
      await navigator.clipboard?.writeText(url).catch(() => null);
      toast.info(m.ste_preview_copied());
    } catch (err) {
      tab?.close();
      toast.error(siteErrorMessage(err));
    }
  }

  async function openHistory() {
    if (!page) return;
    historyOpen = true;
    try {
      revisions = (await fetchSiteRevisions(page.id, guildId)).revisions;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function restore(revision: SiteRevision) {
    if (!page) return;
    const ok = await confirmDialog.ask({ title: m.ste_restore_title(), description: m.ste_restore_confirm(), confirmLabel: m.ste_restore() });
    if (!ok) return;
    try {
      await flush();
      const { page: restored } = await restoreSiteRevision(page.id, revision.id, guildId);
      historyOpen = false;
      // Mode seul : l'éditeur repart du brouillon restauré. À plusieurs, le serveur
      // a fermé la salle et l'éditeur s'y reconnecte de lui-même.
      if (collabStatus === 'solo') editor?.commands.setContent(restored.draftContent as never, { emitUpdate: false });
      page = { ...page, title: restored.title, hasUnpublishedChanges: true };
      toast.success(m.ste_restored_toast());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function remove() {
    if (!page) return;
    const ok = await confirmDialog.ask({ title: m.ste_delete_page_title(), description: m.ste_delete_page_confirm({ title: page.title }), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteSitePage(page.id, guildId);
      router.goto(kindRoot);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  const visibilityOptions: Array<[SiteVisibility, () => string]> = [
    ['PUBLIC', () => m.ste_vis_public()],
    ['MEMBERS', () => m.ste_vis_members()],
    ['ROLES', () => m.ste_vis_roles()],
    ['STAFF', () => m.ste_vis_staff()],
  ];

  function toggleRole(id: string) {
    if (!page) return;
    const next = page.visibleRoleIds.includes(id) ? page.visibleRoleIds.filter((r) => r !== id) : [...page.visibleRoleIds, id];
    setField('visibleRoleIds', next);
  }

  const wikiParents = $derived((siteState?.pages ?? []).filter((p) => p.kind === 'WIKI' && p.id !== page?.id));
  const minScheduleValue = $derived(new Date(Date.now() + 5 * 60_000).toISOString().slice(0, 16));
</script>

<svelte:head><title>{page?.title ?? m.ste_editor_title()} · Kotbo</title></svelte:head>

{#if loading}
  <div class="space-y-3 p-4"><Skeleton height="h-14" /><Skeleton height="h-96" /></div>
{:else if failed || !page || !siteState}
  <EmptyState icon="alert-circle" title={m.ste_err_page_missing()} description={m.ste_editor_load_error()} />
  <div class="flex justify-center"><Button variant="ghost" icon="arrow-left" href="/site">{m.ste_back()}</Button></div>
{:else}
  <div class="spe">
    <header class="spe-bar">
      <Button variant="ghost" size="sm" icon="arrow-left" href={kindRoot} aria-label={m.ste_back()} />
      <div class="spe-title-wrap">
        <input
          class="spe-title"
          value={page.title}
          maxlength="140"
          aria-label={m.ste_page_title()}
          placeholder={m.ste_page_title_placeholder()}
          readonly={agentLocked}
          oninput={(e) => setField('title', (e.currentTarget as HTMLInputElement).value)}
        />
        <div class="spe-meta">
          <span class="spe-pill spe-pill-{status.tone}">{status.label}</span>
          <span class="spe-save" aria-live="polite">
            {#if saving}{m.ste_saving()}{:else if collabStatus === 'connected'}{m.ste_saved_live()}{:else if lastSavedAt}{m.ste_saved_at({ time: lastSavedAt.toLocaleTimeString(dateLocale(), { timeStyle: 'short' }) })}{/if}
          </span>
          {#if collabStatus === 'disconnected'}<span class="spe-pill spe-pill-warning">{m.ste_collab_offline()}</span>{/if}
        </div>
      </div>
      {#if peers.length > 0}
        <ul class="spe-peers" aria-label={m.ste_peers_label()}>
          {#each peers.slice(0, 5) as peer (peer.name + peer.color)}
            <li title={peer.name} style="--peer:{peer.color}">{peer.name.slice(0, 1).toUpperCase()}</li>
          {/each}
          {#if peers.length > 5}<li class="spe-peers-more">+{peers.length - 5}</li>{/if}
        </ul>
      {/if}
      <div class="spe-actions">
        <Button size="sm" variant="ghost" icon="sliders" aria-pressed={panelOpen} onclick={() => (panelOpen = !panelOpen)}>{m.ste_settings()}</Button>
        <Button size="sm" variant="ghost" icon="history" onclick={openHistory}>{m.ste_history()}</Button>
        <Button size="sm" variant="ghost" icon="eye" onclick={preview}>{m.ste_preview()}</Button>
        {#if publicUrl && page.publishedAt}
          <Button size="sm" variant="ghost" icon="external-link" href={publicUrl} target="_blank">{m.ste_view()}</Button>
        {/if}
        <Button size="sm" icon="clock" onclick={() => (scheduleOpen = true)}>{m.ste_schedule()}</Button>
        <Button size="sm" variant="primary" icon="send" loading={publishing} disabled={agentLocked || (!!page.publishedAt && !page.hasUnpublishedChanges)} onclick={publish}>
          {page.publishedAt ? m.ste_publish_changes() : m.ste_publish()}
        </Button>
      </div>
    </header>

    <AgentLockBanner bind:this={agentBanner} {guildId} canManage={siteState.rights.manage} onChange={(locked) => (agentLocked = locked)} />

    {#if !siteState.modules.site}
      <Callout variant="warning" title={m.ste_module_off_title()} class="mb-3">{m.ste_module_off_desc()}</Callout>
    {/if}

    <div class="spe-body" class:has-panel={panelOpen}>
      <div class="spe-canvas">
        <SiteEditor
          {guildId}
          pageId={page.id}
          initialContent={page.draftContent}
          wide={page.kind === 'PAGE'}
          user={me}
          {catalog}
          pages={siteState.pages}
          theme={siteState.site?.theme ?? 'verre'}
          themeSettings={siteState.site?.themeSettings ?? {}}
          canManageAssets={siteState.rights.manage}
          readOnly={agentLocked}
          bind:editor
          onChange={onDocChange}
          onStatus={(s) => (collabStatus = s)}
          onPeers={(list) => (peers = list)}
        />
      </div>

      {#if panelOpen}
        <aside class="spe-panel" aria-label={m.ste_settings()} inert={agentLocked}>
          <Field label={m.ste_slug()} hint={publicUrl ?? ''}>
            {#snippet children(id, describedBy)}
              <input {id} aria-describedby={describedBy} class="input w-full font-mono" maxlength="80" value={page!.slug} onchange={(e) => setField('slug', (e.currentTarget as HTMLInputElement).value)} />
            {/snippet}
          </Field>

          <Field label={m.ste_visibility()}>
            {#snippet children(id)}
              <select {id} class="input w-full" value={page!.visibility} onchange={(e) => setField('visibility', (e.currentTarget as HTMLSelectElement).value as SiteVisibility)}>
                {#each visibilityOptions as [value, label] (value)}<option {value}>{label()}</option>{/each}
              </select>
            {/snippet}
          </Field>
          {#if page.visibility === 'ROLES'}
            <fieldset class="spe-roles">
              <legend class="text-body-sm font-medium text-on-surface">{m.ste_vis_roles_pick()}</legend>
              {#each catalog?.roles ?? [] as role (role.id)}
                <label class="flex items-center gap-2 text-body-sm">
                  <input type="checkbox" checked={page.visibleRoleIds.includes(role.id)} onchange={() => toggleRole(role.id)} />
                  <span style="color:{role.color === '#000000' ? 'inherit' : role.color}">@{role.name}</span>
                </label>
              {/each}
            </fieldset>
          {/if}

          {#if page.kind === 'WIKI'}
            <Field label={m.ste_parent()}>
              {#snippet children(id)}
                <select {id} class="input w-full" value={page!.parentId ?? ''} onchange={(e) => setField('parentId', (e.currentTarget as HTMLSelectElement).value || null)}>
                  <option value="">{m.ste_parent_root()}</option>
                  {#each wikiParents as parent (parent.id)}<option value={parent.id}>{parent.title}</option>{/each}
                </select>
              {/snippet}
            </Field>
          {/if}

          <Field label={m.ste_excerpt()} hint={page.kind === 'BLOG' ? m.ste_excerpt_hint_blog() : m.ste_excerpt_hint()}>
            {#snippet children(id, describedBy)}
              <textarea {id} aria-describedby={describedBy} class="input w-full" rows="3" maxlength="400" value={page!.excerpt ?? ''} oninput={(e) => setField('excerpt', (e.currentTarget as HTMLTextAreaElement).value)}></textarea>
            {/snippet}
          </Field>

          {#if page.kind !== 'PAGE'}
            <Field label={m.ste_tags()} hint={m.ste_tags_hint()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} class="input w-full" bind:value={tagsInput} onchange={commitTags} />
              {/snippet}
            </Field>
          {/if}

          <div class="spe-cover">
            <p class="text-body-sm font-medium text-on-surface">{m.ste_cover()}</p>
            {#if page.coverUrl}
              <img src={page.coverUrl} alt="" />
              <div class="flex gap-2">
                <Button size="sm" onclick={() => (coverPickerOpen = true)}>{m.ste_cover_change()}</Button>
                <Button size="sm" variant="ghost" onclick={() => setField('coverUrl', null)}>{m.ste_cover_remove()}</Button>
              </div>
            {:else}
              <Button size="sm" icon="image" onclick={() => (coverPickerOpen = true)}>{m.ste_cover_add()}</Button>
            {/if}
          </div>

          <Field label={m.ste_icon()} hint={m.ste_icon_hint()}>
            {#snippet children(id, describedBy)}
              <input {id} aria-describedby={describedBy} class="input w-24" maxlength="8" value={page!.icon ?? ''} onchange={(e) => setField('icon', (e.currentTarget as HTMLInputElement).value || null)} />
            {/snippet}
          </Field>

          {#if page.kind === 'BLOG'}
            <label class="flex items-center gap-2 text-body-sm text-on-surface">
              <input type="checkbox" checked={page.commentsEnabled} onchange={(e) => setField('commentsEnabled', (e.currentTarget as HTMLInputElement).checked)} />
              {m.ste_comments_enabled()}
            </label>
          {/if}

          <details class="spe-seo">
            <summary>{m.ste_seo()}</summary>
            <Field label={m.ste_seo_title()} hint={m.ste_seo_title_hint()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} class="input w-full" maxlength="70" value={page!.seoTitle ?? ''} oninput={(e) => setField('seoTitle', (e.currentTarget as HTMLInputElement).value || null)} />
              {/snippet}
            </Field>
            <Field label={m.ste_seo_description()} hint={m.ste_seo_description_hint()}>
              {#snippet children(id, describedBy)}
                <textarea {id} aria-describedby={describedBy} class="input w-full" rows="3" maxlength="200" value={page!.seoDescription ?? ''} oninput={(e) => setField('seoDescription', (e.currentTarget as HTMLTextAreaElement).value || null)}></textarea>
              {/snippet}
            </Field>
          </details>

          <div class="spe-danger">
            {#if page.publishedAt}<Button size="sm" variant="ghost" icon="eye-off" onclick={unpublish}>{m.ste_unpublish()}</Button>{/if}
            <Button size="sm" variant="danger" icon="trash-2" onclick={remove}>{m.ste_delete_page()}</Button>
          </div>
        </aside>
      {/if}
    </div>
  </div>

  <Modal bind:open={historyOpen} title={m.ste_history()} subtitle={m.ste_history_desc()} size="md">
    {#if revisions.length === 0}
      <p class="text-body-sm text-on-surface-variant">{m.ste_history_empty()}</p>
    {:else}
      <ol class="spe-revisions">
        {#each revisions as revision, index (revision.id)}
          <li>
            <div class="min-w-0">
              <p class="text-body-sm text-on-surface font-medium truncate">{revision.title}</p>
              <p class="text-2xs text-on-surface-variant">
                {new Date(revision.createdAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })}{revision.note ? ` · ${revision.note}` : ''}{index === 0 ? ` · ${m.ste_history_current()}` : ''}
              </p>
            </div>
            <Button size="sm" variant="ghost" icon="rotate-ccw" onclick={() => restore(revision)}>{m.ste_restore()}</Button>
          </li>
        {/each}
      </ol>
    {/if}
  </Modal>

  <Modal bind:open={scheduleOpen} title={m.ste_schedule()} subtitle={m.ste_schedule_desc()} size="sm">
    <Field label={m.ste_schedule_at()}>
      {#snippet children(id)}
        <input {id} class="input w-full" type="datetime-local" min={minScheduleValue} bind:value={scheduleValue} />
      {/snippet}
    </Field>
    {#snippet footer()}
      {#if page?.scheduledAt}<Button variant="ghost" onclick={() => schedule(null)}>{m.ste_unschedule()}</Button>{/if}
      <Button variant="primary" disabled={!scheduleValue} onclick={() => schedule(scheduleValue)}>{m.ste_schedule_confirm()}</Button>
    {/snippet}
  </Modal>

  <AssetPicker bind:open={coverPickerOpen} {guildId} canDelete={siteState.rights.manage} onPick={(asset) => setField('coverUrl', asset.url)} />
{/if}

<style>
  .spe { display: flex; flex-direction: column; gap: 12px; min-height: 100%; }
  .spe-bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--color-outline-variant); background: var(--color-surface-container); }
  .spe-title-wrap { flex: 1; min-width: 220px; }
  .spe-title { width: 100%; background: transparent; border: 0; outline: none; color: inherit; font: 700 1.25rem/1.3 'Space Grotesk', Inter, sans-serif; }
  .spe-title::placeholder { color: var(--color-on-surface-variant); }
  .spe-meta { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .spe-save { font-size: 12px; color: var(--color-on-surface-variant); }
  .spe-pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--color-surface-container); color: var(--color-on-surface-variant); }
  .spe-pill-ok { background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-success); }
  .spe-pill-warning { background: color-mix(in srgb, var(--color-warning) 14%, transparent); color: var(--color-warning); }
  .spe-pill-info { background: color-mix(in srgb, var(--color-primary) 14%, transparent); color: var(--color-primary); }
  .spe-peers { display: flex; list-style: none; margin: 0; padding: 0; }
  .spe-peers li { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: #fff; background: var(--peer, #555); border: 2px solid rgb(14 16 21); margin-left: -6px; }
  .spe-peers-more { background: var(--color-surface-container) !important; }
  .spe-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .spe-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
  .spe-body.has-panel { grid-template-columns: minmax(0, 1fr) 300px; }
  .spe-panel { position: sticky; top: 84px; display: flex; flex-direction: column; gap: 14px; padding: 16px; border-radius: 14px; border: 1px solid var(--color-outline-variant); background: var(--color-surface-container); max-height: calc(100vh - 110px); overflow-y: auto; }
  .spe-roles { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; border: 0; padding: 0; }
  .spe-cover { display: flex; flex-direction: column; gap: 8px; }
  .spe-cover img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 10px; }
  .spe-seo summary { cursor: pointer; font-size: 0.875rem; font-weight: 600; margin-bottom: 10px; }
  .spe-seo { display: flex; flex-direction: column; gap: 10px; }
  .spe-danger { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; border-top: 1px solid var(--color-outline-variant); }
  .spe-revisions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .spe-revisions li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 10px; background: var(--color-surface-container); }
  @media (max-width: 1100px) { .spe-body.has-panel { grid-template-columns: 1fr; } .spe-panel { position: static; max-height: none; } }
</style>
