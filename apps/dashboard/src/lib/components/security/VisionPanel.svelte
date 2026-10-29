<script lang="ts">
  /**
   * Kotbo Vision : file de vérification, listes personnalisées et catalogue.
   *
   * Les réglages globaux (activation, sanction, salon de vérification) vivent
   * dans le formulaire de la page Anti-raid ; ce panneau gère ce qui agit
   * immédiatement : listes, images et décisions sur les images incertaines.
   */
  import { onMount } from 'svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import {
    fetchVision,
    createVisionList,
    updateVisionList,
    deleteVisionList,
    fetchVisionImages,
    uploadVisionImage,
    setVisionImageStatus,
    deleteVisionImage,
    decideVisionReview,
    type VisionOverview,
    type VisionList,
    type VisionImage,
    type VisionSanction,
  } from '../../api';
  import SectionCard from '../SectionCard.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import EmptyState from '../EmptyState.svelte';
  import LoadingHint from '../LoadingHint.svelte';

  let { channels = [] }: { channels?: { id: string; name: string }[] } = $props();

  const SANCTIONS: { value: VisionSanction; label: string }[] = [
    { value: 'DELETE', label: 'Supprimer seulement' },
    { value: 'WARN', label: 'Avertissement' },
    { value: 'TIMEOUT', label: 'Timeout' },
    { value: 'JAIL', label: 'Quarantaine (Jail)' },
    { value: 'KICK', label: 'Expulsion' },
    { value: 'SOFTBAN', label: 'Softban' },
    { value: 'BAN', label: 'Bannissement' },
  ];
  const DURATIONS: { value: number | null; label: string }[] = [
    { value: 5, label: '5 minutes' },
    { value: 60, label: '1 heure' },
    { value: 1440, label: '1 jour' },
    { value: 10080, label: '7 jours' },
    { value: 43200, label: '30 jours' },
    { value: null, label: 'Permanente' },
  ];
  /** Le navigateur réduit l'image avant l'envoi : l'empreinte résiste au redimensionnement. */
  const UPLOAD_MAX_SIDE = 1280;
  const UPLOAD_BATCH = 25;

  let overview = $state<VisionOverview | null>(null);
  let loading = $state(true);
  let busy = $state<string | null>(null);

  /** null = catalogue du serveur. */
  let openedList = $state<string | null | undefined>(undefined);
  let images = $state<VisionImage[]>([]);
  let imagesLoading = $state(false);
  let uploading = $state<{ done: number; total: number } | null>(null);
  let dragOver = $state(false);

  let newListName = $state('');

  const openedListMeta = $derived(openedList ? overview?.lists.find((l) => l.id === openedList) ?? null : null);
  const canCreateList = $derived((overview?.lists.length ?? 0) < (overview?.maxLists ?? 10));

  function channelName(id: string | null): string {
    if (!id) return '-';
    return channels.find((c) => c.id === id)?.name ?? id;
  }

  function relative(value: string): string {
    const minutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
    if (minutes < 60) return `il y a ${minutes} min`;
    if (minutes < 1440) return `il y a ${Math.floor(minutes / 60)} h`;
    return `il y a ${Math.floor(minutes / 1440)} j`;
  }

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      overview = await fetchVision(authStore.selectedGuildId);
    } catch {
      toast.error('Impossible de charger Kotbo Vision');
    } finally {
      loading = false;
    }
  }

  async function openList(listId: string | null) {
    openedList = listId;
    imagesLoading = true;
    try {
      images = (await fetchVisionImages(listId, authStore.selectedGuildId))?.images ?? [];
    } catch {
      images = [];
      toast.error('Impossible de charger les images');
    } finally {
      imagesLoading = false;
    }
  }

  async function createList() {
    const name = newListName.trim();
    if (!name || busy) return;
    busy = 'create';
    try {
      const res = await createVisionList({ name }, authStore.selectedGuildId);
      if (res?.list && overview) overview.lists = [...overview.lists, res.list];
      newListName = '';
      if (res?.list) await openList(res.list.id);
      toast.success(`Liste « ${name} » créée`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Création impossible');
    } finally {
      busy = null;
    }
  }

  async function patchList(list: VisionList, patch: Partial<VisionList>) {
    busy = list.id;
    try {
      await updateVisionList(list.id, patch, authStore.selectedGuildId);
      Object.assign(list, patch);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Modification impossible');
    } finally {
      busy = null;
    }
  }

  async function removeList(list: VisionList) {
    const ok = await confirmDialog.ask({
      title: `Supprimer la liste « ${list.name} » ?`,
      description: `Ses ${list.imageCount} image(s) ne seront plus bloquées. C'est définitif.`,
      confirmLabel: 'Supprimer',
      variant: 'danger',
    });
    if (!ok) return;
    busy = list.id;
    try {
      await deleteVisionList(list.id, authStore.selectedGuildId);
      if (overview) overview.lists = overview.lists.filter((l) => l.id !== list.id);
      if (openedList === list.id) openedList = undefined;
      toast.success('Liste supprimée');
    } finally {
      busy = null;
    }
  }

  function readAsResizedDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.92));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Image illisible'));
      };
      img.src = url;
    });
  }

  async function upload(files: FileList | File[] | null) {
    if (!files || openedList === undefined || uploading) return;
    const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, UPLOAD_BATCH);
    if (list.length === 0) return;
    uploading = { done: 0, total: list.length };
    const total = { added: 0, variants: 0, duplicates: 0, refused: 0 };
    for (const file of list) {
      try {
        const dataUrl = await readAsResizedDataUrl(file);
        const res = await uploadVisionImage(openedList, file.name, dataUrl, authStore.selectedGuildId);
        if (res) for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += res[key];
      } catch {
        total.refused++;
      }
      uploading = { done: uploading.done + 1, total: list.length };
    }
    uploading = null;
    toast.success(`${total.added} ajoutée(s), ${total.variants} variante(s) rattachée(s), ${total.duplicates} doublon(s) ignoré(s), ${total.refused} refusée(s)`);
    await Promise.all([openList(openedList), load()]);
  }

  async function toggleImage(image: VisionImage) {
    const status = image.status === 'BLOCKED' ? 'ALLOWED' : 'BLOCKED';
    busy = image.id;
    try {
      await setVisionImageStatus(image.id, status, authStore.selectedGuildId);
      image.status = status;
    } finally {
      busy = null;
    }
  }

  async function removeImage(image: VisionImage) {
    busy = image.id;
    try {
      await deleteVisionImage(image.id, authStore.selectedGuildId);
      images = images.filter((i) => i.id !== image.id);
    } finally {
      busy = null;
    }
  }

  async function decide(reviewId: string, decision: 'confirm' | 'dismiss') {
    busy = reviewId;
    try {
      const res = await decideVisionReview(reviewId, decision, authStore.selectedGuildId);
      if (overview) overview.reviews = overview.reviews.filter((r) => r.id !== reviewId);
      toast.success(decision === 'confirm' ? `Image interdite${res?.sanction ? `, auteur sanctionné (${res.sanction})` : ''}` : 'Image écartée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Décision impossible');
    } finally {
      busy = null;
    }
  }

  onMount(load);

  $effect(() => {
    if (authStore.selectedGuildId) {
      openedList = undefined;
      void load();
    }
  });
</script>

{#if loading && !overview}
  <LoadingHint context="config" />
{:else if overview}
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <div class="rounded-xl border border-outline-variant/30 px-4 py-3">
      <div class="text-xs text-on-surface-variant">Images bloquées</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.blockedTotal}</div>
    </div>
    <div class="rounded-xl border border-outline-variant/30 px-4 py-3">
      <div class="text-xs text-on-surface-variant">Catalogue global</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.globalCatalogCount}</div>
    </div>
    <div class="rounded-xl border border-outline-variant/30 px-4 py-3">
      <div class="text-xs text-on-surface-variant">Catalogue du serveur</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.guildCatalogCount}</div>
    </div>
    <div class="rounded-xl border border-outline-variant/30 px-4 py-3">
      <div class="text-xs text-on-surface-variant">Listes personnalisées</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.lists.length} / {overview.maxLists}</div>
    </div>
  </div>

  <SectionCard
    title="À vérifier"
    description="Images proches d'une image interdite, sans certitude. Le message a été supprimé par précaution, sans sanction : à toi de trancher."
    icon="Eye"
  >
    {#if overview.reviews.length === 0}
      <EmptyState icon="CheckCircle" title="Rien à vérifier" description="Les images incertaines arriveront ici, et dans le salon de vérification s'il est configuré." reason="all-clear" />
    {:else}
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each overview.reviews as review (review.id)}
          <div class="rounded-xl border border-outline-variant/30 overflow-hidden">
            {#if review.thumb}
              <img src={review.thumb} alt="À vérifier" class="w-full h-40 object-contain bg-surface-container" />
            {/if}
            <div class="p-3 space-y-2">
              <p class="text-xs text-on-surface">
                Proche à <strong>{Math.round(review.score * 100)} %</strong>
                {#if review.listId}de la liste « {overview.lists.find((l) => l.id === review.listId)?.name ?? '?'} »{/if}
              </p>
              <p class="text-xs text-on-surface-variant">Auteur <span class="font-mono">{review.authorId}</span> · #{channelName(review.channelId)} · {relative(review.createdAt)}</p>
              <div class="flex gap-2">
                <Button size="sm" variant="danger" disabled={busy !== null} onclick={() => decide(review.id, 'confirm')}>Confirmer</Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onclick={() => decide(review.id, 'dismiss')}>Écarter</Button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </SectionCard>

  <SectionCard
    title="Listes personnalisées"
    description="Tes propres images interdites, quel que soit leur contenu. Une liste = un seul type d'image : mélanger des contenus sans rapport fausse la détection des variantes."
    icon="ImageOff"
  >
    <div class="space-y-2">
      <button
        type="button"
        class="w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors {openedList === null ? 'border-primary/50 bg-primary/5' : 'border-outline-variant/30 hover:border-outline-variant'}"
        onclick={() => openList(null)}
      >
        <div class="min-w-0">
          <p class="text-body-sm font-medium text-on-surface">Catalogue du serveur</p>
          <p class="text-xs text-on-surface-variant">Images captées par le honeypot, confirmées en vérification ou ajoutées par clic droit.</p>
        </div>
        <span class="text-xs text-on-surface-variant tabular-nums shrink-0">{overview.guildCatalogCount} image(s)</span>
      </button>

      {#each overview.lists as list (list.id)}
        <div class="rounded-xl border px-4 py-3 space-y-3 {openedList === list.id ? 'border-primary/50 bg-primary/5' : 'border-outline-variant/30'}">
          <div class="flex items-center justify-between gap-3">
            <button type="button" class="min-w-0 text-left" onclick={() => openList(list.id)}>
              <p class="text-body-sm font-medium text-on-surface truncate">{list.name}</p>
              <p class="text-xs text-on-surface-variant">{list.imageCount} image(s) · vérification : {list.reviewChannelId ? `#${channelName(list.reviewChannelId)}` : 'aucune (les doutes restent silencieux)'}</p>
            </button>
            <div class="flex items-center gap-2 shrink-0">
              <ToggleSwitch checked={list.enabled} disabled={busy !== null} ariaLabel="Activer la liste" onToggle={(v) => patchList(list, { enabled: v })} />
              <Button size="sm" variant="ghost" icon="Trash2" disabled={busy !== null} onclick={() => removeList(list)}>Supprimer</Button>
            </div>
          </div>
          {#if openedList === list.id}
            <div class="grid sm:grid-cols-3 gap-3">
              <label class="block">
                <span class="text-xs font-medium text-on-surface-variant">Salon de vérification</span>
                <select
                  value={list.reviewChannelId}
                  onchange={(e) => patchList(list, { reviewChannelId: e.currentTarget.value || null })}
                  class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
                >
                  <option value="">Aucun</option>
                  {#each channels as channel (channel.id)}
                    <option value={channel.id}>#{channel.name}</option>
                  {/each}
                </select>
              </label>
              <label class="block">
                <span class="text-xs font-medium text-on-surface-variant">Sanction</span>
                <select
                  value={list.sanction ?? ''}
                  onchange={(e) => patchList(list, { sanction: (e.currentTarget.value || null) as VisionSanction | null })}
                  class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
                >
                  <option value="">Celle de Kotbo Vision</option>
                  {#each SANCTIONS as s (s.value)}
                    <option value={s.value}>{s.label}</option>
                  {/each}
                </select>
              </label>
              {#if list.sanction && list.sanction !== 'DELETE' && list.sanction !== 'WARN' && list.sanction !== 'KICK' && list.sanction !== 'SOFTBAN'}
                <label class="block">
                  <span class="text-xs font-medium text-on-surface-variant">Durée</span>
                  <select
                    value={list.durationMin === null ? '' : String(list.durationMin)}
                    onchange={(e) => patchList(list, { durationMin: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
                    class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
                  >
                    {#each DURATIONS as d (d.label)}
                      {#if d.value !== null || list.sanction === 'BAN' || list.sanction === 'JAIL'}
                        <option value={d.value === null ? '' : String(d.value)}>{d.label}</option>
                      {/if}
                    {/each}
                  </select>
                </label>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      <form class="flex gap-2 pt-1" onsubmit={(e) => { e.preventDefault(); void createList(); }}>
        <input
          type="text"
          maxlength="60"
          bind:value={newListName}
          placeholder={canCreateList ? 'Nom de la nouvelle liste (ex. Faux support)' : 'Nombre maximum de listes atteint'}
          disabled={!canCreateList}
          class="flex-1 rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
        />
        <Button type="submit" size="sm" icon="Plus" disabled={!canCreateList || !newListName.trim() || busy !== null}>Créer</Button>
      </form>
    </div>
  </SectionCard>

  {#if openedList !== undefined}
    <SectionCard
      title={openedListMeta ? `Images de « ${openedListMeta.name} »` : 'Images du catalogue du serveur'}
      description="Une image ajoutée est bloquée dès qu'elle réapparaît, recadrée, retournée, recompressée ou dans une capture. Une image très proche d'une autre est rangée comme sa variante."
      icon="Image"
    >
      <div class="space-y-4">
        <label
          class="flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-colors {dragOver ? 'border-primary bg-primary/5' : 'border-outline-variant/40 hover:border-outline-variant'}"
          ondragover={(e) => { e.preventDefault(); dragOver = true; }}
          ondragleave={() => (dragOver = false)}
          ondrop={(e) => { e.preventDefault(); dragOver = false; void upload(e.dataTransfer?.files ?? null); }}
        >
          <input type="file" accept="image/*" multiple class="sr-only" onchange={(e) => upload(e.currentTarget.files)} disabled={uploading !== null} />
          {#if uploading}
            <span class="text-body-sm text-on-surface">Analyse en cours… {uploading.done} / {uploading.total}</span>
          {:else}
            <span class="text-body-sm text-on-surface">Dépose des images ici ou clique pour les choisir</span>
            <span class="text-xs text-on-surface-variant">{UPLOAD_BATCH} images au plus par envoi. Astuce : sur Discord, clic droit sur un message → Apps → Kotbo → Ajouter à Kotbo Vision.</span>
          {/if}
        </label>

        {#if imagesLoading}
          <LoadingHint context="config" />
        {:else if images.length === 0}
          <EmptyState icon="Image" title="Aucune image" description="Ajoute les images que tu veux interdire sur le serveur." reason="instruction" />
        {:else}
          <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {#each images as image (image.id)}
              <div class="rounded-xl border overflow-hidden {image.status === 'ALLOWED' ? 'border-outline-variant/30 opacity-60' : 'border-outline-variant/30'}">
                {#if image.thumb}
                  <img src={image.thumb} alt={image.filename ?? 'Image interdite'} class="w-full h-24 object-contain bg-surface-container" />
                {:else}
                  <div class="w-full h-24 flex items-center justify-center bg-surface-container text-xs text-on-surface-variant">Sans aperçu</div>
                {/if}
                <div class="p-2 space-y-1">
                  <p class="text-xs text-on-surface truncate" title={image.filename ?? ''}>{image.filename ?? 'sans nom'}</p>
                  <p class="text-xs text-on-surface-variant">
                    {image.parentId ? 'Variante' : image.source === 'HONEYPOT' ? 'Honeypot' : image.source === 'REVIEW' ? 'Confirmée' : image.source === 'DISMISSED' ? 'Écartée' : 'Ajoutée'}
                    · {image.hits} blocage(s)
                  </p>
                  <div class="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={busy !== null} onclick={() => toggleImage(image)}>
                      {image.status === 'BLOCKED' ? 'Autoriser' : 'Interdire'}
                    </Button>
                    <Button size="sm" variant="ghost" icon="Trash2" disabled={busy !== null} onclick={() => removeImage(image)} />
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </SectionCard>
  {:else}
    <Callout variant="info">Ouvre une liste ou le catalogue du serveur pour voir ses images et en ajouter.</Callout>
  {/if}
{/if}
