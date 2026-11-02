<script lang="ts">
  /**
   * Galerie de modèles de site : officiels Kotbo d'abord, puis les modèles
   * partagés par les serveurs, les plus utilisés en tête. Appliquer remplace
   * le thème, le menu et l'accueil (annulable) ; partager publie le site du
   * serveur en modèle, textes remplacés par des textes d'exemple.
   */
  import { Button, EmptyState, Field, FilterPills, Modal } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m } from '../../i18n';
  import {
    applySiteTemplate,
    deleteSiteTemplate,
    fetchSiteTemplates,
    publishSiteTemplate,
    reportSiteTemplate,
    SITE_TEMPLATE_CATEGORIES,
    type GalleryTemplate,
    type SiteTemplateCategory,
  } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';
  import TemplateThumb from './TemplateThumb.svelte';

  let {
    open = $bindable(false),
    guildId,
    canManage,
    startWithShare = false,
    onApplied,
  }: { open: boolean; guildId: string; canManage: boolean; startWithShare?: boolean; onApplied: () => void } = $props();

  let templates = $state<GalleryTemplate[]>([]);
  let loading = $state(false);
  let category = $state<'all' | SiteTemplateCategory>('all');
  let query = $state('');
  let applying = $state<string | null>(null);
  let sharing = $state(false);
  let shareName = $state('');
  let shareDescription = $state('');
  let shareCategory = $state<SiteTemplateCategory>('general');
  let publishing = $state(false);

  $effect(() => {
    if (open) {
      sharing = startWithShare;
      void load();
    }
  });

  async function load() {
    loading = true;
    try {
      templates = (await fetchSiteTemplates({ category: category === 'all' ? undefined : category, q: query.trim() || undefined }, guildId)).templates;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      loading = false;
    }
  }

  const CATEGORY_LABELS: Record<SiteTemplateCategory, () => string> = {
    general: () => m.ste_tpl_general(),
    gaming: () => m.ste_tpl_gaming(),
    rp: () => m.ste_tpl_rp(),
    esport: () => m.ste_tpl_esport(),
    etude: () => m.ste_tpl_etude(),
    autre: () => m.ste_gal_cat_other(),
  };

  const categoryOptions = $derived([
    { value: 'all' as const, label: m.ste_gal_all() },
    ...SITE_TEMPLATE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c]() })),
  ]);

  const title = (t: GalleryTemplate) => (t.official ? (CATEGORY_LABELS[t.category as SiteTemplateCategory]?.() ?? t.name) : t.name);

  async function apply(t: GalleryTemplate) {
    const ok = await confirmDialog.ask({
      title: m.ste_gal_apply_title({ name: title(t) }),
      description: m.ste_gal_apply_desc(),
      impacts: [m.ste_gal_impact_theme(), m.ste_gal_impact_menu(), m.ste_gal_impact_pages({ count: t.pageCount }), m.ste_gal_impact_keep()],
      confirmLabel: m.ste_gal_apply(),
    });
    if (!ok) return;
    applying = t.id;
    try {
      const result = await applySiteTemplate(t.id, guildId);
      toast.success(m.ste_gal_applied({ count: result.pages }));
      open = false;
      onApplied();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      applying = null;
    }
  }

  async function report(t: GalleryTemplate) {
    const ok = await confirmDialog.ask({ title: m.ste_gal_report_title(), description: m.ste_gal_report_desc(), confirmLabel: m.ste_gal_report(), variant: 'danger' });
    if (!ok) return;
    try {
      await reportSiteTemplate(t.id, guildId);
      toast.success(m.ste_gal_reported());
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function remove(t: GalleryTemplate) {
    const ok = await confirmDialog.ask({ title: m.ste_gal_delete_title(), description: m.ste_gal_delete_desc({ name: t.name }), confirmLabel: m.common_delete(), variant: 'danger' });
    if (!ok) return;
    try {
      await deleteSiteTemplate(t.id, guildId);
      templates = templates.filter((x) => x.id !== t.id);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  async function share(event: SubmitEvent) {
    event.preventDefault();
    publishing = true;
    try {
      await publishSiteTemplate({ name: shareName.trim(), description: shareDescription.trim(), category: shareCategory }, guildId);
      toast.success(m.ste_gal_shared());
      sharing = false;
      shareName = shareDescription = '';
      await load();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      publishing = false;
    }
  }
</script>

<Modal bind:open title={sharing ? m.ste_gal_share_title() : m.ste_gal_title()} subtitle={sharing ? m.ste_gal_share_desc() : m.ste_gal_desc()} size="xl">
  {#if sharing}
    <form class="gal-share" onsubmit={share}>
      <Field label={m.ste_gal_share_name()}>
        {#snippet children(id)}<input {id} class="input w-full" maxlength="60" required bind:value={shareName} />{/snippet}
      </Field>
      <Field label={m.ste_gal_share_about()} hint={m.ste_gal_share_about_hint()}>
        {#snippet children(id, describedBy)}<textarea {id} aria-describedby={describedBy} class="input w-full" rows="3" maxlength="300" bind:value={shareDescription}></textarea>{/snippet}
      </Field>
      <Field label={m.ste_gal_share_category()}>
        {#snippet children()}
          <FilterPills label={m.ste_gal_share_category()} value={shareCategory} onchange={(v) => (shareCategory = v)} options={SITE_TEMPLATE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c]() }))} />
        {/snippet}
      </Field>
      <ul class="gal-share-notes">
        <li>{m.ste_gal_share_note_text()}</li>
        <li>{m.ste_gal_share_note_modules()}</li>
        <li>{m.ste_gal_share_note_images()}</li>
      </ul>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={() => (sharing = false)}>{m.ste_gal_back()}</Button>
        <Button type="submit" variant="primary" icon="send" loading={publishing} disabled={!shareName.trim()} disabledReason={m.ste_gal_share_name_missing()}>{m.ste_gal_share_submit()}</Button>
      </div>
    </form>
  {:else}
    <div class="gal-toolbar">
      <FilterPills label={m.ste_gal_category()} value={category} onchange={(v) => { category = v; void load(); }} options={categoryOptions} />
      <form class="gal-search" onsubmit={(e) => { e.preventDefault(); void load(); }}>
        <input class="input" type="search" bind:value={query} placeholder={m.ste_gal_search()} aria-label={m.ste_gal_search()} />
      </form>
      {#if canManage}<Button icon="send" onclick={() => (sharing = true)}>{m.ste_gal_share()}</Button>{/if}
    </div>

    {#if loading && templates.length === 0}
      <p class="text-body-sm text-on-surface-variant">{m.ste_gal_loading()}</p>
    {:else if templates.length === 0}
      <EmptyState icon="layout-template" title={m.ste_gal_empty()} description={m.ste_gal_empty_desc()} reason="nothing-matches" />
    {:else}
      <div class="gal-grid">
        {#each templates as t (t.id)}
          <article class="gal-card">
            <TemplateThumb home={t.home} theme={t.theme} themeSettings={t.themeSettings} />
            <div class="gal-body">
              <div class="gal-head">
                <h3>{title(t)}</h3>
                {#if t.official}<span class="gal-badge is-official">{m.ste_gal_official()}</span>{:else if t.mine}<span class="gal-badge">{m.ste_gal_mine()}</span>{/if}
              </div>
              {#if t.description}<p class="gal-desc">{t.description}</p>{/if}
              <p class="gal-meta">{m.ste_gal_pages({ count: t.pageCount })}{t.official ? '' : ` · ${m.ste_gal_uses({ count: t.uses })}`}</p>
              <div class="gal-actions">
                {#if canManage}
                  <Button size="sm" variant="primary" loading={applying === t.id} disabled={applying !== null} onclick={() => apply(t)}>{m.ste_gal_apply()}</Button>
                {/if}
                {#if t.mine && canManage}
                  <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.common_delete()} onclick={() => remove(t)} />
                {:else if !t.official}
                  <Button size="sm" variant="ghost" icon="flag" aria-label={m.ste_gal_report()} onclick={() => report(t)} />
                {/if}
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {/if}
</Modal>

<style>
  .gal-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; }
  .gal-search { flex: 1; min-width: 180px; display: flex; }
  .gal-search input { width: 100%; }
  .gal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .gal-card { display: flex; flex-direction: column; border: 1px solid var(--color-outline-variant); border-radius: 10px; overflow: hidden; background: var(--color-surface-container); }
  .gal-body { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 12px; flex: 1; }
  .gal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .gal-head h3 { margin: 0; font-size: 0.95rem; font-weight: 600; color: var(--color-on-surface); }
  .gal-badge { flex: none; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: var(--color-surface-container-high); color: var(--color-on-surface-variant); }
  .gal-badge.is-official { background: color-mix(in srgb, var(--color-primary) 18%, transparent); color: var(--color-primary); }
  .gal-desc { margin: 0; font-size: 0.8125rem; color: var(--color-on-surface-variant); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .gal-meta { margin: 0; font-size: 0.75rem; color: var(--color-on-surface-variant); }
  .gal-actions { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 6px; }
  .gal-share { display: flex; flex-direction: column; gap: 14px; }
  .gal-share-notes { margin: 0; padding-left: 18px; font-size: 0.8125rem; color: var(--color-on-surface-variant); display: flex; flex-direction: column; gap: 4px; }
</style>
