<script lang="ts">
  /**
   * Site communautaire : création depuis un modèle, puis gestion du site
   * (pages, wiki, blog, apparence, menu, commentaires, fréquentation,
   * réglages). L'édition d'une page ouvre l'éditeur WYSIWYG (/site/edit/:id).
   */
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, Callout, EmptyState, Tabs } from '../lib/components/ui';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';
  import { fetchSiteCatalog, fetchSiteState, type SiteCatalog, type SiteState } from '../lib/api/site';
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

  const TABS = ['apercu', 'pages', 'wiki', 'blog', 'apparence', 'menu', 'votes', 'commentaires', 'frequentation', 'reglages'] as const;
  type Tab = (typeof TABS)[number];

  const guildId = $derived(authStore.selectedGuildId ?? '');
  let siteState = $state<SiteState | null>(null);
  let catalog = $state<SiteCatalog | null>(null);
  let loading = $state(true);
  let agentLocked = $state(false);

  const active = $derived.by<Tab>(() => {
    void $router.path;
    return resolveTabFromUrl('/site', TABS, 'apercu') as Tab;
  });

  async function load() {
    loading = true;
    try {
      const [s, c] = await Promise.all([fetchSiteState(guildId), fetchSiteCatalog(guildId).catch(() => null)]);
      siteState = s;
      catalog = c;
    } catch {
      toast.error(m.ste_load_error());
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const rights = $derived(siteState?.rights);
  const visibleTab = (id: string) => {
    if (!siteState?.site) return false;
    if (id === 'wiki') return Boolean(rights?.wiki) && siteState.modules.site_wiki;
    if (id === 'blog') return Boolean(rights?.blog) && siteState.modules.site_blog;
    if (id === 'commentaires') return Boolean(rights?.moderateComments) && siteState.modules.site_blog;
    if (id === 'frequentation') return Boolean(rights?.viewStats);
    if (['pages', 'apparence', 'menu', 'reglages', 'votes'].includes(id)) return Boolean(rights?.manage);
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
    <EmptyState icon="alert-circle" title={m.ste_load_error()} description="" />
  {:else if !siteState.site}
    {#if siteState.rights.manage}
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

    <div class:site-locked={agentLocked} inert={agentLocked && active !== 'apercu' && active !== 'frequentation'}>
      {#if active === 'apercu'}
        <SiteOverview {siteState} {guildId} onChanged={load} />
      {:else if active === 'pages'}
        <SitePagesList {siteState} {guildId} kind="PAGE" onChanged={load} />
      {:else if active === 'wiki'}
        <SitePagesList {siteState} {guildId} kind="WIKI" onChanged={load} />
      {:else if active === 'blog'}
        <SitePagesList {siteState} {guildId} kind="BLOG" onChanged={load} />
      {:else if active === 'apparence'}
        <SiteAppearance {siteState} {guildId} onChanged={load} />
      {:else if active === 'menu'}
        <SiteNavigationEditor {siteState} {guildId} onChanged={load} />
      {:else if active === 'votes'}
        <SiteVotes {guildId} />
      {:else if active === 'commentaires'}
        <SiteComments {guildId} />
      {:else if active === 'frequentation'}
        <SiteAnalyticsPanel {guildId} />
      {:else if active === 'reglages'}
        <SiteSettings {siteState} {catalog} {guildId} onChanged={load} />
      {/if}
    </div>
  {/if}
</ModulePage>

<style>
  .site-locked { opacity: 0.7; }
</style>
