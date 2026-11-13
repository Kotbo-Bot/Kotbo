<script lang="ts">
  import { m } from '../../i18n';
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
  import { formatRelative } from '../staff/format';

  let { channels = [] }: { channels?: { id: string; name: string }[] } = $props();

  const SANCTIONS: { value: VisionSanction; label: string }[] = [
    { value: 'DELETE', label: m.arx_sanction_delete_only() },
    { value: 'WARN', label: m.arx_sanction_warn() },
    { value: 'TIMEOUT', label: 'Timeout' },
    { value: 'JAIL', label: m.arx_jail_title() },
    { value: 'KICK', label: m.arx_sanction_kick() },
    { value: 'SOFTBAN', label: 'Softban' },
    { value: 'BAN', label: m.arx_sanction_ban() },
  ];
  const DURATIONS: { value: number | null; label: string }[] = [
    { value: 5, label: '5 minutes' },
    { value: 60, label: m.arx_duration_1h() },
    { value: 1440, label: m.arx_duration_1d() },
    { value: 10080, label: m.arx_duration_7d() },
    { value: 43200, label: m.arx_duration_30d() },
    { value: null, label: m.arx_duration_permanent() },
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

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      overview = await fetchVision(authStore.selectedGuildId);
    } catch {
      toast.error(m.vis_load_error());
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
      toast.error(m.ste_assets_load_error());
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
      toast.success(m.vis_list_created({ name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_create_failed());
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
      toast.error(err instanceof Error ? err.message : m.vis_update_failed());
    } finally {
      busy = null;
    }
  }

  async function removeList(list: VisionList) {
    const ok = await confirmDialog.ask({
      title: m.vis_delete_list_title({ name: list.name }),
      description: m.vis_delete_list_desc({ count: list.imageCount }),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    });
    if (!ok) return;
    busy = list.id;
    try {
      await deleteVisionList(list.id, authStore.selectedGuildId);
      if (overview) overview.lists = overview.lists.filter((l) => l.id !== list.id);
      if (openedList === list.id) openedList = undefined;
      toast.success(m.vis_list_deleted());
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
        reject(new Error(m.vis_unreadable()));
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
    toast.success(m.vis_import_summary({ added: total.added, variants: total.variants, duplicates: total.duplicates, refused: total.refused }));
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
      toast.success(decision === 'confirm' ? (res?.sanction ? m.vis_image_banned_sanctioned({ sanction: res.sanction }) : m.vis_image_banned()) : m.vis_image_dismissed());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_decision_failed());
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
      <div class="text-xs text-on-surface-variant">{m.vis_stat_blocked()}</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.blockedTotal}</div>
    </div>
    <div class="rounded-xl border border-outline-variant/30 px-4 py-3">
      <div class="text-xs text-on-surface-variant">{m.vis_stat_global()}</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.globalCatalogCount}</div>
    </div>
    <div class="rounded-xl border border-outline-variant/30 px-4 py-3">
      <div class="text-xs text-on-surface-variant">{m.vis_server_catalog()}</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.guildCatalogCount}</div>
    </div>
    <div class="rounded-xl border border-outline-variant/30 px-4 py-3">
      <div class="text-xs text-on-surface-variant">{m.vis_stat_lists()}</div>
      <div class="text-[15px] font-semibold text-on-surface tabular-nums">{overview.lists.length} / {overview.maxLists}</div>
    </div>
  </div>

  <SectionCard
    title={m.vis_review_title()}
    description={m.vis_review_desc()}
    icon="Eye"
  >
    {#if overview.reviews.length === 0}
      <EmptyState icon="CheckCircle" title={m.vis_review_empty()} description={m.vis_review_empty_desc()} reason="all-clear" />
    {:else}
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each overview.reviews as review (review.id)}
          <div class="rounded-xl border border-outline-variant/30 overflow-hidden">
            {#if review.thumb}
              <img src={review.thumb} alt={m.vis_review_alt()} class="w-full h-40 object-contain bg-surface-container" />
            {/if}
            <div class="p-3 space-y-2">
              <p class="text-xs text-on-surface">
                {m.vis_close_to()} <strong>{Math.round(review.score * 100)} %</strong>
                {#if review.listId}{m.vis_from_list({ name: overview.lists.find((l) => l.id === review.listId)?.name ?? '?' })}{/if}
              </p>
              <p class="text-xs text-on-surface-variant">{m.vis_author()} <span class="font-mono">{review.authorId}</span> · #{channelName(review.channelId)} · {formatRelative(review.createdAt)}</p>
              <div class="flex gap-2">
                <Button size="sm" variant="danger" disabled={busy !== null} onclick={() => decide(review.id, 'confirm')}>{m.vis_confirm()}</Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onclick={() => decide(review.id, 'dismiss')}>{m.vis_dismiss()}</Button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </SectionCard>

  <SectionCard
    title={m.vis_stat_lists()}
    description={m.vis_lists_desc()}
    icon="ImageOff"
  >
    <div class="space-y-2">
      <button
        type="button"
        class="w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors {openedList === null ? 'border-primary/50 bg-primary/5' : 'border-outline-variant/30 hover:border-outline-variant'}"
        onclick={() => openList(null)}
      >
        <div class="min-w-0">
          <p class="text-body-sm font-medium text-on-surface">{m.vis_server_catalog()}</p>
          <p class="text-xs text-on-surface-variant">{m.vis_server_catalog_desc()}</p>
        </div>
        <span class="text-xs text-on-surface-variant tabular-nums shrink-0">{m.vis_image_count({ count: overview.guildCatalogCount })}</span>
      </button>

      {#each overview.lists as list (list.id)}
        <div class="rounded-xl border px-4 py-3 space-y-3 {openedList === list.id ? 'border-primary/50 bg-primary/5' : 'border-outline-variant/30'}">
          <div class="flex items-center justify-between gap-3">
            <button type="button" class="min-w-0 text-left" onclick={() => openList(list.id)}>
              <p class="text-body-sm font-medium text-on-surface truncate">{list.name}</p>
              <p class="text-xs text-on-surface-variant">{m.vis_image_count({ count: list.imageCount })} · {list.reviewChannelId ? m.vis_review_in({ channel: channelName(list.reviewChannelId) }) : m.vis_review_none()}</p>
            </button>
            <div class="flex items-center gap-2 shrink-0">
              <ToggleSwitch checked={list.enabled} disabled={busy !== null} ariaLabel={m.vis_enable_list()} onToggle={(v) => patchList(list, { enabled: v })} />
              <Button size="sm" variant="ghost" icon="Trash2" disabled={busy !== null} onclick={() => removeList(list)}>{m.common_delete()}</Button>
            </div>
          </div>
          {#if openedList === list.id}
            <div class="grid sm:grid-cols-3 gap-3">
              <label class="block">
                <span class="text-xs font-medium text-on-surface-variant">{m.arx_vision_review_channel()}</span>
                <select
                  value={list.reviewChannelId}
                  onchange={(e) => patchList(list, { reviewChannelId: e.currentTarget.value || null })}
                  class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
                >
                  <option value="">{m.common_none()}</option>
                  {#each channels as channel (channel.id)}
                    <option value={channel.id}>#{channel.name}</option>
                  {/each}
                </select>
              </label>
              <label class="block">
                <span class="text-xs font-medium text-on-surface-variant">{m.arx_vision_sanction()}</span>
                <select
                  value={list.sanction ?? ''}
                  onchange={(e) => patchList(list, { sanction: (e.currentTarget.value || null) as VisionSanction | null })}
                  class="mt-1 w-full rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
                >
                  <option value="">{m.vis_default_sanction()}</option>
                  {#each SANCTIONS as s (s.value)}
                    <option value={s.value}>{s.label}</option>
                  {/each}
                </select>
              </label>
              {#if list.sanction && list.sanction !== 'DELETE' && list.sanction !== 'WARN' && list.sanction !== 'KICK' && list.sanction !== 'SOFTBAN'}
                <label class="block">
                  <span class="text-xs font-medium text-on-surface-variant">{m.arx_vision_duration()}</span>
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
          placeholder={canCreateList ? m.vis_new_list_ph() : m.vis_max_lists()}
          disabled={!canCreateList}
          class="flex-1 rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-2 text-body-sm text-on-surface"
        />
        <Button type="submit" size="sm" icon="Plus" disabled={!canCreateList || !newListName.trim() || busy !== null}>{m.vis_create()}</Button>
      </form>
    </div>
  </SectionCard>

  {#if openedList !== undefined}
    <SectionCard
      title={openedListMeta ? m.vis_list_images({ name: openedListMeta.name }) : m.vis_catalog_images()}
      description={m.vis_images_desc()}
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
            <span class="text-body-sm text-on-surface">{m.vis_uploading({ done: uploading.done, total: uploading.total })}</span>
          {:else}
            <span class="text-body-sm text-on-surface">{m.vis_drop()}</span>
            <span class="text-xs text-on-surface-variant">{m.vis_drop_hint({ count: UPLOAD_BATCH })}</span>
          {/if}
        </label>

        {#if imagesLoading}
          <LoadingHint context="config" />
        {:else if images.length === 0}
          <EmptyState icon="Image" title={m.vis_no_images()} description={m.vis_no_images_desc()} reason="instruction" />
        {:else}
          <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {#each images as image (image.id)}
              <div class="rounded-xl border overflow-hidden {image.status === 'ALLOWED' ? 'border-outline-variant/30 opacity-60' : 'border-outline-variant/30'}">
                {#if image.thumb}
                  <img src={image.thumb} alt={image.filename ?? m.vis_banned_image()} class="w-full h-24 object-contain bg-surface-container" />
                {:else}
                  <div class="w-full h-24 flex items-center justify-center bg-surface-container text-xs text-on-surface-variant">{m.vis_no_preview()}</div>
                {/if}
                <div class="p-2 space-y-1">
                  <p class="text-xs text-on-surface truncate" title={image.filename ?? ''}>{image.filename ?? m.vis_unnamed()}</p>
                  <p class="text-xs text-on-surface-variant">
                    {image.parentId ? m.vis_src_variant() : image.source === 'HONEYPOT' ? 'Honeypot' : image.source === 'REVIEW' ? m.vis_src_confirmed() : image.source === 'DISMISSED' ? m.vis_src_dismissed() : m.vis_src_added()}
                    · {m.vis_hits({ count: image.hits })}
                  </p>
                  <div class="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={busy !== null} onclick={() => toggleImage(image)}>
                      {image.status === 'BLOCKED' ? m.vis_allow() : m.vis_ban()}
                    </Button>
                    <Button size="sm" variant="ghost" icon="Trash2" aria-label={m.vis_delete_image()} disabled={busy !== null} onclick={() => removeImage(image)} />
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </SectionCard>
  {:else}
    <Callout variant="info">{m.vis_open_hint()}</Callout>
  {/if}
{/if}
