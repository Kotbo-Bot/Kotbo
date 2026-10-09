<script lang="ts">
  /**
   * Bibliothèque d'images du site : téléverser (bouton ou glisser-déposer),
   * choisir une image déjà présente. Les images sont réencodées en WebP par le
   * serveur, métadonnées retirées.
   */
  import { Button, EmptyState, Modal } from '../../ui';
  import { toast } from '../../../stores/toast.svelte';
  import { m } from '../../../i18n';
  import { deleteSiteAsset, fetchSiteAssets, uploadSiteAsset, type SiteAsset } from '../../../api/site';
  import { siteErrorMessage } from '../siteErrors';

  let {
    open = $bindable(false),
    guildId,
    canDelete = false,
    onPick,
  }: { open: boolean; guildId: string; canDelete?: boolean; onPick: (asset: SiteAsset) => void } = $props();

  let assets = $state<SiteAsset[]>([]);
  let loading = $state(false);
  let uploading = $state(false);
  let dragging = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (open) void load();
  });

  async function load() {
    loading = true;
    try {
      assets = (await fetchSiteAssets(guildId)).assets;
    } catch {
      toast.error(m.ste_assets_load_error());
    } finally {
      loading = false;
    }
  }

  async function upload(files: FileList | File[]) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    uploading = true;
    try {
      for (const file of list) {
        const asset = await uploadSiteAsset(file, guildId);
        assets = [asset, ...assets.filter((a) => a.id !== asset.id)];
        if (list.length === 1) {
          onPick(asset);
          open = false;
        }
      }
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      uploading = false;
    }
  }

  async function remove(asset: SiteAsset) {
    try {
      await deleteSiteAsset(asset.id, guildId);
      assets = assets.filter((a) => a.id !== asset.id);
    } catch (err) {
      toast.error(siteErrorMessage(err));
    }
  }

  function formatSize(bytes: number): string {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.round(bytes / 1024)} Ko`;
  }
</script>

<Modal bind:open title={m.ste_assets_title()} subtitle={m.ste_assets_subtitle()} size="lg">
  <div
    class="asset-drop"
    class:is-dragging={dragging}
    role="region"
    aria-label={m.ste_assets_drop()}
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={(e) => {
      e.preventDefault();
      dragging = false;
      if (e.dataTransfer?.files) void upload(e.dataTransfer.files);
    }}
  >
    <p class="text-body-sm text-on-surface-variant">{m.ste_assets_drop()}</p>
    <Button size="sm" icon="upload" loading={uploading} onclick={() => input?.click()}>{m.ste_assets_upload()}</Button>
    <input bind:this={input} class="sr-only" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" multiple onchange={(e) => {
      const files = (e.currentTarget as HTMLInputElement).files;
      if (files) void upload(files);
      (e.currentTarget as HTMLInputElement).value = '';
    }} />
  </div>

  {#if !loading && assets.length === 0}
    <EmptyState icon="image" title={m.ste_assets_empty()} description={m.ste_assets_empty_desc()} />
  {:else}
    <ul class="asset-grid">
      {#each assets as asset (asset.id)}
        <li>
          <button type="button" class="asset-tile" onclick={() => { onPick(asset); open = false; }}>
            <img src={asset.url} alt="" loading="lazy" />
            <span class="asset-meta">{asset.width}×{asset.height} · {formatSize(asset.sizeBytes)}</span>
          </button>
          {#if canDelete}
            <button type="button" class="asset-remove" aria-label={m.common_delete()} onclick={() => remove(asset)}>×</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Modal>

<style>
  .asset-drop { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 22px; border: 1.5px dashed rgb(255 255 255 / 0.14); border-radius: 14px; margin-bottom: 16px; text-align: center; }
  .asset-drop.is-dragging { border-color: rgb(124 108 255 / 0.8); background: rgb(124 108 255 / 0.08); }
  .asset-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
  .asset-grid li { position: relative; }
  .asset-tile { display: block; width: 100%; padding: 0; border: 1px solid rgb(255 255 255 / 0.08); border-radius: 10px; overflow: hidden; background: rgb(255 255 255 / 0.03); cursor: pointer; text-align: left; }
  .asset-tile:hover, .asset-tile:focus-visible { border-color: rgb(124 108 255 / 0.7); }
  .asset-tile img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; }
  .asset-meta { display: block; padding: 4px 8px; font-size: 11px; color: rgb(255 255 255 / 0.55); }
  .asset-remove { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border-radius: 50%; border: 0; background: rgb(0 0 0 / 0.65); color: #fff; cursor: pointer; }
</style>
