<script lang="ts">
  /**
   * « Rédaction » dans Mon espace : les wikis et blogs où la personne est
   * rédactrice par un rôle du serveur, sans avoir besoin du dashboard.
   */
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { Button, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { createSitePage, fetchMyEditorSites, type MyEditorSite, type SitePageKind } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';
  import SiteIcon from './SiteIcon.svelte';

  let sites = $state<MyEditorSite[]>([]);
  let loaded = $state(false);
  let creating = $state<string | null>(null);

  onMount(async () => {
    try {
      sites = (await fetchMyEditorSites()).sites;
    } catch {
      sites = [];
    } finally {
      loaded = true;
    }
  });

  async function create(site: MyEditorSite, kind: SitePageKind) {
    const title = kind === 'WIKI' ? m.ste_untitled_wiki() : m.ste_untitled_article();
    creating = `${site.guildId}:${kind}`;
    try {
      const { page } = await createSitePage({ kind, title }, site.guildId);
      router.goto(`/site/edit/${page.id}?guild=${site.guildId}`);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      creating = null;
    }
  }
</script>

{#if loaded && sites.length > 0}
  <SectionCard title={m.ste_space_title()} description={m.ste_space_desc()} icon="edit-2">
    <div class="px-5 pb-5 space-y-5">
      {#each sites as site (site.guildId)}
        <div class="space-y-2">
          <div class="flex items-center gap-3 flex-wrap">
            {#if site.guildIcon}<img src={site.guildIcon} alt="" class="w-7 h-7 rounded-lg" />{/if}
            <a class="font-semibold text-on-surface hover:underline" href={site.site.url} target="_blank" rel="noopener">{site.site.name || site.guildName}</a>
            <span class="flex-1"></span>
            {#each site.kinds as kind (kind)}
              <Button size="sm" icon="plus" loading={creating === `${site.guildId}:${kind}`} onclick={() => create(site, kind)}>
                {kind === 'WIKI' ? m.ste_new_wiki_page() : m.ste_new_article()}
              </Button>
            {/each}
          </div>
          <ul class="space-y-1">
            {#each site.pages.slice(0, 12) as page (page.id)}
              <li>
                <a class="space-page" href={`/site/edit/${page.id}?guild=${site.guildId}`}>
                  <span class="space-title"><SiteIcon name={page.kind === 'WIKI' ? 'book' : 'pen'} size={16} />{page.title}</span>
                  <span class="text-2xs text-on-surface-variant">{page.publishedAt ? (page.hasUnpublishedChanges ? m.ste_status_changes() : m.ste_status_published()) : m.ste_status_draft()}</span>
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  </SectionCard>
{/if}

<style>
  .space-page { display: flex; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 8px; text-decoration: none; color: inherit; font-size: 0.9rem; }
  .space-page:hover { background: var(--color-surface-hover); }
  .space-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; color: var(--color-on-surface); }
  .space-title :global(.site-icon) { color: var(--color-on-surface-variant); }
</style>
