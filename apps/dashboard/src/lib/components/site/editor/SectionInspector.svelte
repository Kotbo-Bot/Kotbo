<script lang="ts">
  /**
   * Réglages de la section où se trouve le curseur, façon constructeur de
   * site : disposition des colonnes, fond (couleur, dégradé, image), marges,
   * largeur, hauteur, animation d'apparition, visibilité et ancre. Chaque
   * réglage s'applique tout de suite au canevas (transaction de l'éditeur,
   * donc partagée avec les autres éditeurs).
   */
  import type { Editor } from '@tiptap/core';
  import {
    SITE_SECTION_GRADIENTS,
    SITE_SECTION_LAYOUTS,
    type SiteSectionAttrs,
    type SiteSectionLayout,
  } from '@kotbo/shared';
  import { Button, Field, FilterPills } from '../../ui';
  import { m } from '../../../i18n';
  import { setSectionAttrs, setSectionLayout } from './sectionCommands';
  import type { ActiveSection } from './SiteEditor.svelte';
  import AssetPicker from './AssetPicker.svelte';
  import ImageSourcesModal from './ImageSourcesModal.svelte';

  let {
    editor,
    section,
    guildId,
    canManageAssets = false,
  }: {
    editor: Editor;
    section: ActiveSection;
    guildId: string;
    canManageAssets?: boolean;
  } = $props();

  const attrs = $derived(section.attrs as unknown as SiteSectionAttrs);
  let pickerOpen = $state(false);
  let sourcesMode = $state<'visuals' | 'stock' | null>(null);

  function set(patch: Partial<SiteSectionAttrs>) {
    setSectionAttrs(editor, section.pos, patch);
  }

  function setImage(url: string) {
    set({ background: 'image', bgImage: url });
  }

  const GRADIENT_CSS: Record<string, string> = {
    accent: 'linear-gradient(135deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 45%, #000))',
    sunset: 'linear-gradient(135deg, #c2410c, #9d174d)',
    ocean: 'linear-gradient(135deg, #0369a1, #1e3a8a)',
    forest: 'linear-gradient(135deg, #15803d, #064e3b)',
    night: 'linear-gradient(160deg, #312e81, #0f172a)',
    aurora: 'linear-gradient(135deg, #0e7490, #6d28d9)',
  };

  const backgrounds = $derived([
    { value: 'none', label: m.ste_bg_none() },
    { value: 'surface', label: m.ste_bg_surface() },
    { value: 'accent', label: m.ste_bg_accent() },
    { value: 'dark', label: m.ste_bg_dark() },
    { value: 'color', label: m.ste_bg_color() },
    { value: 'gradient', label: m.ste_bg_gradient() },
    { value: 'image', label: m.ste_bg_image() },
  ] as const);

  function pickBackground(value: SiteSectionAttrs['background']) {
    if (value === 'color' && !attrs.bgColor) set({ background: value, bgColor: '#1f2937' });
    else if (value === 'image' && !attrs.bgImage) pickerOpen = true;
    else set({ background: value });
  }

  function cleanAnchor(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }
</script>

<div class="sin">
  <p class="sin-title">{m.ste_section_n({ n: section.index + 1 })}</p>

  <Field label={m.ste_layout()}>
    {#snippet children()}
      <div class="sin-layouts" role="group" aria-label={m.ste_layout()}>
        {#each SITE_SECTION_LAYOUTS as layout (layout)}
          <button type="button" class="sin-layout" aria-pressed={attrs.layout === layout} title={layout} onclick={() => setSectionLayout(editor, section.pos, layout as SiteSectionLayout)}>
            {#each layout.split('-') as part, i (i)}<span style="flex:{part}"></span>{/each}
          </button>
        {/each}
      </div>
    {/snippet}
  </Field>

  <Field label={m.ste_background()}>
    {#snippet children()}
      <div class="sin-bgs" role="group" aria-label={m.ste_background()}>
        {#each backgrounds as bg (bg.value)}
          <button type="button" class="sin-bg sin-bg-{bg.value}" aria-pressed={attrs.background === bg.value} onclick={() => pickBackground(bg.value)}>
            <span class="sin-bg-swatch" aria-hidden="true"></span>{bg.label}
          </button>
        {/each}
      </div>
    {/snippet}
  </Field>

  {#if attrs.background === 'color'}
    <div class="sin-row">
      <input type="color" class="sin-color" value={attrs.bgColor || '#1f2937'} aria-label={m.ste_bg_color()} oninput={(e) => set({ bgColor: (e.currentTarget as HTMLInputElement).value })} />
      <input class="input font-mono w-28" maxlength="7" value={attrs.bgColor} aria-label={m.ste_bg_color_hex()} onchange={(e) => {
        const v = (e.currentTarget as HTMLInputElement).value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) set({ bgColor: v.toLowerCase() });
      }} />
    </div>
  {:else if attrs.background === 'gradient'}
    <div class="sin-gradients" role="group" aria-label={m.ste_bg_gradient()}>
      {#each SITE_SECTION_GRADIENTS as gradient (gradient)}
        <button type="button" class="sin-gradient" style="background:{GRADIENT_CSS[gradient]}" aria-pressed={attrs.bgGradient === gradient} aria-label={gradient} onclick={() => set({ bgGradient: gradient })}></button>
      {/each}
    </div>
  {:else if attrs.background === 'image'}
    <div class="sin-image">
      {#if attrs.bgImage}<img src={attrs.bgImage} alt="" />{/if}
      <div class="sin-image-actions">
        <Button size="sm" icon="image" onclick={() => (pickerOpen = true)}>{m.ste_bg_my_images()}</Button>
        <Button size="sm" icon="sparkles" onclick={() => (sourcesMode = 'visuals')}>{m.ste_bg_server_visuals()}</Button>
        <Button size="sm" icon="search" onclick={() => (sourcesMode = 'stock')}>{m.ste_bg_stock()}</Button>
      </div>
      <label class="sin-slider">
        <span>{m.ste_bg_overlay({ value: attrs.overlay })}</span>
        <input type="range" min="0" max="80" step="5" value={attrs.overlay} oninput={(e) => set({ overlay: Number((e.currentTarget as HTMLInputElement).value) })} />
      </label>
    </div>
  {/if}

  <Field label={m.ste_spacing()}>
    {#snippet children()}
      <FilterPills label={m.ste_spacing()} value={attrs.padding} onchange={(v) => set({ padding: v })} options={[
        { value: 'none', label: m.ste_spacing_none() },
        { value: 'small', label: m.ste_size_small() },
        { value: 'medium', label: m.ste_size_medium() },
        { value: 'large', label: m.ste_size_large() },
      ]} />
    {/snippet}
  </Field>

  <Field label={m.ste_width()} hint={m.ste_width_hint()}>
    {#snippet children()}
      <FilterPills label={m.ste_width()} value={attrs.width} onchange={(v) => set({ width: v })} options={[
        { value: 'contained', label: m.ste_width_contained() },
        { value: 'full', label: m.ste_width_full_bg() },
        { value: 'edge', label: m.ste_width_edge() },
      ]} />
    {/snippet}
  </Field>

  <Field label={m.ste_height()}>
    {#snippet children()}
      <FilterPills label={m.ste_height()} value={attrs.height} onchange={(v) => set({ height: v })} options={[
        { value: 'auto', label: m.ste_height_auto() },
        { value: 'tall', label: m.ste_height_tall() },
        { value: 'screen', label: m.ste_height_screen() },
      ]} />
    {/snippet}
  </Field>

  <Field label={m.ste_valign()}>
    {#snippet children()}
      <FilterPills label={m.ste_valign()} value={attrs.align} onchange={(v) => set({ align: v })} options={[
        { value: 'top', label: m.ste_valign_top() },
        { value: 'center', label: m.ste_valign_center() },
        { value: 'bottom', label: m.ste_valign_bottom() },
      ]} />
    {/snippet}
  </Field>

  <Field label={m.ste_animation()} hint={m.ste_animation_hint()}>
    {#snippet children()}
      <FilterPills label={m.ste_animation()} value={attrs.animation} onchange={(v) => set({ animation: v })} options={[
        { value: 'none', label: m.ste_animation_none() },
        { value: 'fade', label: m.ste_animation_fade() },
        { value: 'slide-up', label: m.ste_animation_slide() },
        { value: 'zoom', label: m.ste_animation_zoom() },
      ]} />
    {/snippet}
  </Field>

  <Field label={m.ste_visible_on()}>
    {#snippet children()}
      <FilterPills label={m.ste_visible_on()} value={attrs.visibleOn} onchange={(v) => set({ visibleOn: v })} options={[
        { value: 'all', label: m.ste_visible_all() },
        { value: 'desktop', label: m.ste_visible_desktop() },
        { value: 'mobile', label: m.ste_visible_mobile() },
      ]} />
    {/snippet}
  </Field>

  <Field label={m.ste_anchor()} hint={attrs.anchor ? m.ste_anchor_hint_set({ anchor: attrs.anchor }) : m.ste_anchor_hint()}>
    {#snippet children(id, describedBy)}
      <input {id} aria-describedby={describedBy} class="input w-full font-mono" maxlength="60" value={attrs.anchor} placeholder="rejoindre" onchange={(e) => set({ anchor: cleanAnchor((e.currentTarget as HTMLInputElement).value) })} />
    {/snippet}
  </Field>
</div>

<AssetPicker bind:open={pickerOpen} {guildId} canDelete={canManageAssets} onPick={(asset) => setImage(asset.url)} />
<ImageSourcesModal bind:mode={sourcesMode} {guildId} onPick={setImage} />

<style>
  .sin { display: flex; flex-direction: column; gap: 16px; }
  .sin-title { margin: 0; font-weight: 600; color: var(--color-on-surface); }
  .sin-layouts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .sin-layout { display: flex; gap: 3px; height: 34px; padding: 6px; border-radius: 8px; border: 1px solid var(--color-outline-variant); background: var(--color-surface-container); cursor: pointer; }
  .sin-layout span { border-radius: 3px; background: var(--color-on-surface-variant); opacity: 0.45; }
  .sin-layout[aria-pressed='true'] { border-color: var(--color-primary); }
  .sin-layout[aria-pressed='true'] span { background: var(--color-primary); opacity: 1; }
  .sin-bgs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .sin-bg { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--color-outline-variant); background: var(--color-surface-container); color: var(--color-on-surface); font-size: 0.875rem; text-align: left; cursor: pointer; }
  .sin-bg[aria-pressed='true'] { border-color: var(--color-primary); box-shadow: inset 0 0 0 1px var(--color-primary); }
  .sin-bg-swatch { width: 18px; height: 18px; flex: none; border-radius: 5px; border: 1px solid var(--color-outline-variant); }
  .sin-bg-none .sin-bg-swatch { background: repeating-linear-gradient(45deg, transparent 0 4px, var(--color-outline-variant) 4px 5px); }
  .sin-bg-surface .sin-bg-swatch { background: var(--color-surface-container-high); }
  .sin-bg-accent .sin-bg-swatch { background: var(--color-primary); }
  .sin-bg-dark .sin-bg-swatch { background: #14171c; }
  .sin-bg-color .sin-bg-swatch { background: conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444); }
  .sin-bg-gradient .sin-bg-swatch { background: linear-gradient(135deg, #0e7490, #6d28d9); }
  .sin-bg-image .sin-bg-swatch { background: linear-gradient(160deg, #94a3b8 40%, #475569 40%); }
  .sin-row { display: flex; align-items: center; gap: 8px; }
  .sin-color { width: 44px; height: 38px; padding: 2px; border-radius: 8px; border: 1px solid var(--color-outline-variant); background: transparent; cursor: pointer; }
  .sin-gradients { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
  .sin-gradient { aspect-ratio: 1; border-radius: 8px; border: 2px solid transparent; cursor: pointer; }
  .sin-gradient[aria-pressed='true'] { border-color: var(--color-on-surface); }
  .sin-image { display: flex; flex-direction: column; gap: 8px; }
  .sin-image img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; }
  .sin-image-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .sin-slider { display: flex; flex-direction: column; gap: 4px; font-size: 0.8125rem; color: var(--color-on-surface-variant); }
</style>
