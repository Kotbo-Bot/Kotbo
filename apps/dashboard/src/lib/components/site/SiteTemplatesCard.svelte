<script lang="ts">
  /**
   * Carte « Modèles » de l'onglet Apparence : ouvrir la galerie, partager son
   * site en modèle, et juste après l'application d'un modèle, le garder ou
   * revenir en arrière.
   */
  import { Button, Callout, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m, dateLocale } from '../../i18n';
  import { keepSiteTemplate, undoSiteTemplate, type SiteState } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';
  import SiteTemplateGallery from './SiteTemplateGallery.svelte';

  let { siteState, guildId, onChanged }: { siteState: SiteState; guildId: string; onChanged: () => void } = $props();

  let galleryOpen = $state(false);
  let shareFirst = $state(false);
  let busy = $state(false);
  const undo = $derived(siteState.site?.settings?.templateUndo ?? null);

  function openGallery(share: boolean) {
    shareFirst = share;
    galleryOpen = true;
  }

  async function revert() {
    const ok = await confirmDialog.ask({ title: m.ste_gal_undo_title(), description: m.ste_gal_undo_desc(), impacts: [m.ste_gal_undo_impact_pages(), m.ste_gal_undo_impact_theme()], confirmLabel: m.ste_gal_undo(), variant: 'danger' });
    if (!ok) return;
    busy = true;
    try {
      await undoSiteTemplate(guildId);
      toast.success(m.ste_gal_undone());
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      busy = false;
    }
  }

  async function keep() {
    busy = true;
    try {
      await keepSiteTemplate(guildId);
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      busy = false;
    }
  }
</script>

<SectionCard title={m.ste_gal_card_title()} description={m.ste_gal_card_desc()} icon="layout-template">
  <div class="px-5 pb-5 flex flex-col gap-3">
    {#if undo}
      <Callout variant="info" title={m.ste_gal_undo_banner({ date: new Date(undo.appliedAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })}>
        <p>{m.ste_gal_undo_banner_desc()}</p>
        <div class="flex flex-wrap gap-2 mt-2">
          <Button size="sm" variant="primary" disabled={busy} onclick={keep}>{m.ste_gal_keep()}</Button>
          <Button size="sm" variant="ghost" icon="rotate-ccw" disabled={busy} onclick={revert}>{m.ste_gal_undo()}</Button>
        </div>
      </Callout>
    {/if}
    <div class="flex flex-wrap gap-2">
      <Button variant="primary" icon="layout-template" onclick={() => openGallery(false)}>{m.ste_gal_browse()}</Button>
      {#if siteState.rights.manage}<Button icon="send" onclick={() => openGallery(true)}>{m.ste_gal_share()}</Button>{/if}
    </div>
  </div>
</SectionCard>

<SiteTemplateGallery bind:open={galleryOpen} {guildId} canManage={siteState.rights.manage} startWithShare={shareFirst} onApplied={onChanged} />
