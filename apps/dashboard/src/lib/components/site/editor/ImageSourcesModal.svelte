<script lang="ts">
  /**
   * Images de fond qui ne viennent pas de la bibliothèque du site :
   *  - « visuels » : fonds générés depuis l'icône, la bannière et la couleur
   *    du serveur (rangés dans les images du site) ;
   *  - « banque » : recherche dans une banque d'images libre (CC0 et domaine
   *    public, aucun crédit à afficher), importée dans le site au choix.
   */
  import { Button, EmptyState, Modal } from '../../ui';
  import { toast } from '../../../stores/toast.svelte';
  import { m } from '../../../i18n';
  import { generateSiteVisuals, importStockImage, searchStockImages, type SiteVisualKind, type StockImage } from '../../../api/site';
  import { siteErrorMessage } from '../siteErrors';

  let {
    mode = $bindable<'visuals' | 'stock' | null>(null),
    guildId,
    onPick,
  }: { mode: 'visuals' | 'stock' | null; guildId: string; onPick: (url: string) => void } = $props();

  let open = $state(false);
  let visuals = $state<Array<{ kind: SiteVisualKind; url: string }>>([]);
  let generating = $state(false);
  let query = $state('');
  let results = $state<StockImage[]>([]);
  let searching = $state(false);
  let searched = $state(false);
  let importing = $state<string | null>(null);

  $effect(() => {
    open = mode !== null;
    if (mode === 'visuals' && visuals.length === 0 && !generating) void generate();
  });

  $effect(() => {
    if (!open) mode = null;
  });

  const VISUAL_LABELS: Record<SiteVisualKind, () => string> = {
    banner: () => m.ste_visual_banner(),
    glow: () => m.ste_visual_glow(),
    mesh: () => m.ste_visual_mesh(),
    pattern: () => m.ste_visual_pattern(),
    blur: () => m.ste_visual_blur(),
  };

  async function generate() {
    generating = true;
    try {
      visuals = (await generateSiteVisuals(guildId)).visuals;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      generating = false;
    }
  }

  async function search(event?: SubmitEvent) {
    event?.preventDefault();
    if (!query.trim()) return;
    searching = true;
    try {
      results = (await searchStockImages(query.trim(), 1, guildId)).images;
      searched = true;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      searching = false;
    }
  }

  async function pickStock(image: StockImage) {
    importing = image.id;
    try {
      const { asset } = await importStockImage(image.id, guildId);
      onPick(asset.url);
      mode = null;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      importing = null;
    }
  }

  function pick(url: string) {
    onPick(url);
    mode = null;
  }
</script>

<Modal bind:open title={mode === 'stock' ? m.ste_bg_stock() : m.ste_bg_server_visuals()} subtitle={mode === 'stock' ? m.ste_stock_desc() : m.ste_visuals_desc()} size="lg">
  {#if mode === 'visuals'}
    {#if generating && visuals.length === 0}
      <p class="text-body-sm text-on-surface-variant">{m.ste_visuals_generating()}</p>
    {:else if visuals.length === 0}
      <EmptyState icon="image" title={m.ste_visuals_empty()} description={m.ste_visuals_empty_desc()} actionLabel={m.common_retry()} onAction={generate} />
    {:else}
      <div class="iso-grid">
        {#each visuals as visual (visual.url)}
          <button type="button" class="iso-item" onclick={() => pick(visual.url)}>
            <img src={visual.url} alt="" loading="lazy" />
            <span>{VISUAL_LABELS[visual.kind]()}</span>
          </button>
        {/each}
      </div>
    {/if}
  {:else if mode === 'stock'}
    <form class="iso-search" onsubmit={search}>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input flex-1" type="search" bind:value={query} placeholder={m.ste_stock_placeholder()} aria-label={m.ste_stock_placeholder()} autofocus />
      <Button type="submit" variant="primary" icon="search" loading={searching}>{m.ste_stock_search()}</Button>
    </form>
    {#if searched && results.length === 0}
      <p class="text-body-sm text-on-surface-variant mt-3">{m.ste_stock_none()}</p>
    {:else}
      <div class="iso-grid mt-3">
        {#each results as image (image.id)}
          <button type="button" class="iso-item" disabled={importing !== null} aria-busy={importing === image.id} onclick={() => pickStock(image)}>
            <img src={image.thumb} alt={image.title} loading="lazy" referrerpolicy="no-referrer" />
            <span>{importing === image.id ? m.ste_stock_importing() : image.creator ?? image.title}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</Modal>

<style>
  .iso-search { display: flex; gap: 8px; }
  .iso-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
  .iso-item { display: flex; flex-direction: column; gap: 6px; padding: 0; border: 1px solid var(--color-outline-variant); border-radius: 10px; overflow: hidden; background: var(--color-surface-container); color: var(--color-on-surface-variant); font-size: 0.8125rem; text-align: left; cursor: pointer; }
  .iso-item:hover:not(:disabled) { border-color: var(--color-primary); }
  .iso-item:disabled { opacity: 0.6; cursor: progress; }
  .iso-item img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: var(--color-surface-container-high); }
  .iso-item span { padding: 0 8px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
