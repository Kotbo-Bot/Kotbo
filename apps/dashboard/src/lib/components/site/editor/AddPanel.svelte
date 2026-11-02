<script lang="ts">
  /**
   * Panneau « + Ajouter » : sections prêtes (vignettes schématiques, par
   * catégorie) et éléments à poser dans la colonne courante (les mêmes que le
   * menu « / »). Une recherche filtre les deux.
   */
  import { siteIconSvg } from '@kotbo/shared';
  import { Tabs } from '../../ui';
  import { m } from '../../../i18n';
  import type { SiteCatalog } from '../../../api/site';
  import { PRESET_CATEGORIES, SECTION_PRESETS, type SectionPreset } from './sectionPresets';
  import type { SlashItem } from './slashMenu';

  let {
    catalog,
    elements,
    onAddSection,
    onAddElement,
  }: {
    catalog: SiteCatalog | null;
    elements: SlashItem[];
    onAddSection: (preset: SectionPreset) => void;
    onAddElement: (item: SlashItem) => void;
  } = $props();

  let tab = $state<'sections' | 'elements'>('sections');
  let query = $state('');

  const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const matches = (value: string) => !query.trim() || fold(value).includes(fold(query.trim()));
  const unavailable = $derived(new Set((catalog?.blocks ?? []).filter((b) => !b.available).map((b) => b.key)));

  const presetGroups = $derived(
    PRESET_CATEGORIES.map(([id, label]) => ({ id, label: label(), presets: SECTION_PRESETS.filter((p) => p.category === id && matches(p.label())) })).filter((g) => g.presets.length > 0),
  );
  const elementGroups = $derived.by(() => {
    const groups = new Map<string, SlashItem[]>();
    for (const item of elements) {
      if (!matches(`${item.label} ${item.description} ${item.keywords ?? ''}`)) continue;
      groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    }
    return [...groups.entries()];
  });
</script>

<div class="adp">
  <Tabs label={m.ste_add()} active={tab} onchange={(id) => (tab = id as 'sections' | 'elements')} tabs={[
    { id: 'sections', label: m.ste_add_sections() },
    { id: 'elements', label: m.ste_add_elements() },
  ]} />
  <input class="input w-full" type="search" bind:value={query} placeholder={m.ste_add_search()} aria-label={m.ste_add_search()} />

  {#if tab === 'sections'}
    {#each presetGroups as group (group.id)}
      <section class="adp-group">
        <h3>{group.label}</h3>
        <div class="adp-presets">
          {#each group.presets as preset (preset.id)}
            {@const off = preset.module ? unavailable.has(preset.module) : false}
            <button type="button" class="adp-preset" disabled={off} title={off ? m.ste_block_unavailable() : preset.label()} onclick={() => onAddSection(preset)}>
              <span class="adp-thumb adp-bg-{preset.thumb.background}" class:is-centered={preset.thumb.centered} aria-hidden="true">
                {#each preset.thumb.columns as parts, i (i)}
                  <span class="adp-col" style="flex:{preset.thumb.weights?.[i] ?? 1}">
                    {#each parts as part, j (j)}<span class="adp-part adp-{part}"></span>{/each}
                  </span>
                {/each}
              </span>
              <span class="adp-label">{preset.label()}</span>
            </button>
          {/each}
        </div>
      </section>
    {:else}
      <p class="text-body-sm text-on-surface-variant">{m.ste_slash_empty()}</p>
    {/each}
  {:else}
    {#each elementGroups as [group, items] (group)}
      <section class="adp-group">
        <h3>{group}</h3>
        <div class="adp-elements">
          {#each items as item (item.id)}
            <button type="button" class="adp-element" disabled={item.disabled} onclick={() => onAddElement(item)}>
              <span class="adp-element-icon" aria-hidden="true">{@html siteIconSvg(item.icon, 18)}</span>
              <span class="min-w-0"><span class="adp-element-label">{item.label}</span><span class="adp-element-desc">{item.description}</span></span>
            </button>
          {/each}
        </div>
      </section>
    {:else}
      <p class="text-body-sm text-on-surface-variant">{m.ste_slash_empty()}</p>
    {/each}
  {/if}
</div>

<style>
  .adp { display: flex; flex-direction: column; gap: 12px; }
  .adp-group h3 { margin: 4px 0 8px; font-size: 0.8125rem; font-weight: 600; color: var(--color-on-surface-variant); }
  .adp-presets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .adp-preset { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 10px; border: 1px solid var(--color-outline-variant); background: var(--color-surface-container); color: var(--color-on-surface); cursor: pointer; text-align: left; }
  .adp-preset:hover:not(:disabled) { border-color: var(--color-primary); }
  .adp-preset:disabled { opacity: 0.45; cursor: not-allowed; }
  .adp-label { font-size: 0.8125rem; line-height: 1.25; padding: 0 2px 2px; }
  .adp-thumb { display: flex; gap: 5px; aspect-ratio: 16 / 9; padding: 8px; border-radius: 6px; background: var(--color-surface-container-high); }
  .adp-bg-surface { background: color-mix(in srgb, var(--color-on-surface) 12%, var(--color-surface-container)); }
  .adp-bg-accent { background: var(--color-primary); }
  .adp-bg-dark { background: #14171c; }
  .adp-bg-gradient { background: linear-gradient(160deg, #312e81, #0f172a); }
  .adp-bg-image { background: linear-gradient(rgb(0 0 0 / 0.35), rgb(0 0 0 / 0.35)), linear-gradient(135deg, #0e7490, #6d28d9); }
  .adp-col { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; border-radius: 3px; outline: 1px dashed color-mix(in srgb, var(--color-on-surface) 18%, transparent); padding: 3px; }
  .adp-thumb.is-centered .adp-col { align-items: center; }
  .adp-part { display: block; border-radius: 2px; background: color-mix(in srgb, var(--color-on-surface) 45%, transparent); }
  .adp-bg-accent .adp-part, .adp-bg-dark .adp-part, .adp-bg-gradient .adp-part, .adp-bg-image .adp-part { background: rgb(255 255 255 / 0.75); }
  .adp-title { height: 6px; width: 70%; }
  .adp-text { height: 3px; width: 90%; opacity: 0.6; }
  .adp-button { height: 6px; width: 34%; border-radius: 6px; background: var(--color-primary) !important; }
  .adp-bg-accent .adp-button { background: #fff !important; }
  .adp-media { flex: 1; width: 100%; min-height: 20px; opacity: 0.5; }
  .adp-cards { height: 14px; width: 100%; opacity: 0.5; background: repeating-linear-gradient(90deg, currentColor 0 30%, transparent 30% 35%) !important; color: color-mix(in srgb, var(--color-on-surface) 45%, transparent); }
  .adp-list { height: 16px; width: 100%; opacity: 0.5; background: repeating-linear-gradient(180deg, currentColor 0 3px, transparent 3px 6px) !important; color: color-mix(in srgb, var(--color-on-surface) 45%, transparent); }
  .adp-elements { display: flex; flex-direction: column; gap: 4px; }
  .adp-element { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px; border-radius: 8px; border: 0; background: transparent; color: var(--color-on-surface); text-align: left; cursor: pointer; }
  .adp-element:hover:not(:disabled) { background: var(--color-surface-hover); }
  .adp-element:disabled { opacity: 0.45; }
  .adp-element-icon { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; background: var(--color-surface-container-high); }
  .adp-element-label { display: block; font-size: 0.875rem; font-weight: 500; }
  .adp-element-desc { display: block; font-size: 0.75rem; color: var(--color-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
