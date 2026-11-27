<!--
  Étiquettes de la cellule posées sur un dossier ou une fiche : un clic pose
  ou retire. Sans droit d'écriture, seules les étiquettes posées s'affichent.
-->
<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import { wbCaseTags } from '../../wellbeingCustom';
  import { wbCustom } from '../../stores/wellbeingCustomization.svelte';

  const {
    tagIds = [],
    canWrite,
    busy = false,
    onchange,
  }: {
    tagIds?: string[];
    canWrite: boolean;
    busy?: boolean;
    onchange: (tagIds: string[]) => void;
  } = $props();

  const tags = $derived(wbCustom.value.tags);
  const shown = $derived(canWrite ? tags : wbCaseTags(wbCustom.value, tagIds));

  function toggle(id: string) {
    onchange(tagIds.includes(id) ? tagIds.filter((tagId) => tagId !== id) : [...tagIds, id]);
  }
</script>

<div class="space-y-1.5">
  <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1"><Papicon icon="Tag" size={12} /> {m.wb_tags_label()}</p>
  {#if shown.length === 0}
    <p class="text-2xs text-on-surface-variant">{canWrite ? m.wb_tags_none() : '-'}</p>
  {:else}
    <div role="group" aria-label={m.wb_tags_label()} class="flex flex-wrap gap-1.5">
      {#each shown as tag (tag.id)}
        {@const selected = tagIds.includes(tag.id)}
        {#if canWrite}
          <button type="button" aria-pressed={selected} disabled={busy} onclick={() => toggle(tag.id)}
            class="text-2xs font-semibold px-2.5 py-1 rounded-full transition-colors disabled:opacity-60 {selected ? 'bg-primary/10 text-primary border border-primary/30' : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
            {tag.label}
          </button>
        {:else}
          <span class="text-2xs font-semibold px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/30">{tag.label}</span>
        {/if}
      {/each}
    </div>
  {/if}
</div>
