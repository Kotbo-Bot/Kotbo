<script lang="ts">
  /**
   * Site communautaire : création depuis un modèle, puis gestion du site en
   * cinq onglets (aperçu et fréquentation, contenu, apparence et menu,
   * croissance : votes et forum, réglages). L'édition d'une page ouvre
   * l'éditeur WYSIWYG (/site/edit/:id).
   *
   * Les anciennes adresses d'onglet restent valables : /site/wiki, /site/blog
   * et /site/commentaires ouvrent Contenu sur le bon filtre (l'éditeur et le
   * registre des modules y renvoient), /site/menu ouvre Apparence, etc.
   */
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, Callout, EmptyState, FilterPills, Tabs, type FilterOption } from '../lib/components/ui';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';
  import { createInstantSite, fetchSiteCatalog, fetchSiteState, type SiteCatalog, type SiteState } from '../lib/api/site';
  import AgentLockBanner from '../lib/components/site/AgentLockBanner.svelte';
  import SiteCreateWizard from '../lib/components/site/SiteCreateWizard.svelte';
  import SiteOverview from '../lib/components/site/SiteOverview.svelte';
  import SitePagesList from '../lib/components/site/SitePagesList.svelte';
  import SiteAppearance from '../lib/components/site/SiteAppearance.svelte';
  import SiteNavigationEditor from '../lib/components/site/SiteNavigationEditor.svelte';
  import SiteComments from '../lib/components/site/SiteComments.svelte';
  import SiteAnalyticsPanel from '../lib/components/site/SiteAnalyticsPanel.svelte';
  import SiteSettings from '../lib/components/site/SiteSettings.svelte';
  import SiteVotes from '../lib/components/site/SiteVotes.svelte';
  import SiteForum from '../lib/components/site/SiteForum.svelte';

  const TABS = ['apercu', 'contenu', 'apparence', 'croissance', 'reglages'] as const;
  type Tab = (typeof TABS)[number];
  type ContentView = 'pages' | 'wiki' | 'blog' | 'commentaires';

  // Anciens onglets → onglet qui les porte désormais.
  const LEGACY_TABS: Record<string, Tab> = {
    pages: 'contenu',
    wiki: 'contenu',
    blog: 'contenu',
    commentaires: 'contenu',
    menu: 'apparence',
    votes: 'croissance',
    forum: 'croissance',
    frequentation: 'apercu',
  };

  const guildId = $derived(authStore.selectedGuildId ?? '');
  let siteState = $state<SiteState | null>(null);
  let catalog = $state<SiteCatalog | null>(null);
  let loading = $state(true);
  let agentLocked = $state(false);
  // Pas de site : Kotbo le compose d'après le serveur, sans question. L'assistant
  // ne sert plus que de repli si cette composition échoue.
  let composing = $state(false);
  let instantFailed = $state(false);

  const segment = $derived(decodeURIComponent($router.path.split('/')[2] ?? ''));
  const active = $derived.by<Tab>(() => {
    void $router.path;
    return LEGACY_TABS[segment] ?? (resolveTabFromUrl('/site', TABS, 'apercu') as Tab);
  });

  async function load() {
    loading = true;
    try {
      const [s, c] = await Promise.all([fetchSiteState(guildId), fetchSiteCatalog(guildId).catch(() => null)]);
      siteState = s;
      catalog = c;
      if (s && !s.site && s.rights.manage && !instantFailed) {
        composing = true;
        try {
          await createInstantSite(guildId);
          siteState = await fetchSiteState(guildId);
        } catch {
          instantFailed = true;
        } finally {
          composing = false;
        }
      }
    } catch {
      toast.error(m.ste_load_error());
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const rights = $derived(siteState?.rights);

  // Filtres de l'onglet Contenu que la personne peut ouvrir.
  const contentViews = $derived.by<FilterOption<ContentView>[]>(() => {
    if (!siteState?.site) return [];
    const views: FilterOption<ContentView>[] = [];
    if (rights?.manage) views.push({ value: 'pages', label: m.ste_tab_pages() });
    if (rights?.wiki && siteState.modules.site_wiki) views.push({ value: 'wiki', label: m.ste_tab_wiki() });
    if (rights?.blog && siteState.modules.site_blog) views.push({ value: 'blog', label: m.ste_tab_blog() });
    if (rights?.moderateComments && siteState.modules.site_blog) views.push({ value: 'commentaires', label: m.ste_tab_comments() });
    return views;
  });
  const contentView = $derived.by<ContentView>(() => {
    const wanted = (['wiki', 'blog', 'commentaires'] as const).find((v) => v === segment) ?? 'pages';
    return contentViews.some((v) => v.value === wanted) ? wanted : (contentViews[0]?.value ?? 'pages');
  });

  const visibleTab = (id: string) => {
    if (!siteState?.site) return false;
    if (id === 'contenu') return contentViews.length > 0;
    if (id === 'croissance') return Boolean(rights?.manage || rights?.moderateComments);
    if (id === 'apparence' || id === 'reglages') return Boolean(rights?.manage);
    return true;
  };
</script>

<ModulePage title={m.nav_site()} description={m.ste_page_desc()} icon="globe" featureKey="site">
  {#snippet actions()}
    {#if siteState?.site}
      <Button size="sm" variant="ghost" icon="external-link" href={`${siteState.baseUrl}${siteState.site.slug}`} target="_blank">{m.ste_open_site()}</Button>
    {/if}
  {/snippet}

  {#if loading && !siteState}
    <div class="space-y-3"><Skeleton height="h-24" /><Skeleton height="h-64" /></div>
  {:else if !siteState}
    <EmptyState icon="alert-circle" title={m.ste_load_error()} actionLabel={m.common_retry()} actionIcon="RefreshCw" onAction={load} />
  {:else if !siteState.site}
    {#if composing}
      <div class="composing" role="status" aria-live="polite">
        <p class="text-body font-semibold text-on-surface">{m.ste_instant_composing()}</p>
        <p class="text-body-sm text-on-surface-variant">{m.ste_instant_composing_desc()}</p>
        <div class="space-y-3 mt-4"><Skeleton height="h-24" /><Skeleton height="h-48" /></div>
      </div>
    {:else if siteState.rights.manage}
      <SiteCreateWizard {siteState} {guildId} onCreated={load} />
    {:else}
      <EmptyState icon="globe" title={m.ste_no_site()} description={m.ste_no_site_desc()} />
    {/if}
  {:else}
    <AgentLockBanner {guildId} siteId={siteState.site.id} canManage={siteState.rights.manage} onChange={(locked) => (agentLocked = locked)} />
    {#if !siteState.modules.site}
      <Callout variant="warning" title={m.ste_module_off_title()} class="mb-4">{m.ste_module_off_desc()}</Callout>
    {/if}
    {#if siteState.site.suspendedAt}
      <Callout variant="danger" title={m.ste_suspended_title()} class="mb-4">{siteState.site.suspendedReason ?? m.ste_suspended_desc()}</Callout>
    {/if}

    <Tabs label={m.nav_site()} class="mb-6" tabs={pageTabItems('/site', visibleTab)} active={active} onchange={(id) => gotoTab('/site', id, 'apercu')} />

    <div class:site-locked={agentLocked} inert={agentLocked && active !== 'apercu'}>
      {#if active === 'apercu'}
        <div class="stack">
          <SiteOverview {siteState} {guildId} onChanged={load} />
          {#if rights?.viewStats}<SiteAnalyticsPanel {guildId} />{/if}
        </div>
      {:else if active === 'contenu'}
        {#if contentViews.length > 1}
          <FilterPills class="mb-4" label={m.ste_tab_content()} options={contentViews} value={contentView} onchange={(v) => router.goto(v === 'pages' ? '/site/contenu' : `/site/${v}`)} />
        {/if}
        {#if contentView === 'pages'}
          <SitePagesList {siteState} {guildId} kind="PAGE" onChanged={load} />
        {:else if contentView === 'wiki'}
          <SitePagesList {siteState} {guildId} kind="WIKI" onChanged={load} />
        {:else if contentView === 'blog'}
          <SitePagesList {siteState} {guildId} kind="BLOG" onChanged={load} />
        {:else}
          <SiteComments {guildId} />
        {/if}
      {:else if active === 'apparence'}
        <div class="stack">
          <SiteAppearance {siteState} {guildId} onChanged={load} />
          <SiteNavigationEditor {siteState} {guildId} onChanged={load} />
        </div>
      {:else if active === 'croissance'}
        <div class="stack">
          {#if rights?.manage}<SiteVotes {guildId} />{/if}
          <SiteForum {guildId} canManage={Boolean(rights?.manage)} siteUrl={`${siteState.baseUrl}${siteState.site.slug}`} />
        </div>
      {:else if active === 'reglages'}
        <SiteSettings {siteState} {catalog} {guildId} onChanged={load} />
      {/if}
    </div>
  {/if}
</ModulePage>

<style>
  .site-locked { opacity: 0.7; }
  .composing { padding: 8px 0; }
  .stack { display: flex; flex-direction: column; gap: 24px; }
</style>
