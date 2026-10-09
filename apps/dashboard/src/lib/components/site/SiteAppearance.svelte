<script lang="ts">
  /**
   * Apparence du site : thème (qui fixe aussi la disposition du menu), accent,
   * polices, arrondis, fond, logo, bannière, favicon et CSS libre. Aperçu en
   * direct avec les mêmes jetons que le site publié.
   */
  import { resolveSiteTheme, siteFontStylesheetUrl, SITE_FONTS, SITE_THEME_KEYS, type SiteThemeSettings } from '@kotbo/shared';
  import { Button, Field, SectionCard } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { updateSite, type SiteState } from '../../api/site';
  import AssetPicker from './editor/AssetPicker.svelte';
  import { siteErrorMessage } from './siteErrors';

  let { state, guildId, onChanged }: { state: SiteState; guildId: string; onChanged: () => void } = $props();

  const site = $derived(state.site!);
  let theme = $state(state.site!.theme);
  let settings = $state<SiteThemeSettings>({ ...(state.site!.themeSettings ?? {}) });
  let customCss = $state(state.site!.customCss ?? '');
  let logoUrl = $state(state.site!.logoUrl);
  let bannerUrl = $state(state.site!.bannerUrl);
  let faviconUrl = $state(state.site!.faviconUrl);
  let saving = $state(false);
  let picking = $state<'logo' | 'banner' | 'favicon' | null>(null);
  let pickerOpen = $state(false);

  const resolved = $derived(resolveSiteTheme(theme, settings));
  const dirty = $derived(
    theme !== site.theme ||
      JSON.stringify(settings) !== JSON.stringify(site.themeSettings ?? {}) ||
      (customCss || null) !== (site.customCss || null) ||
      logoUrl !== site.logoUrl ||
      bannerUrl !== site.bannerUrl ||
      faviconUrl !== site.faviconUrl,
  );

  const THEME_LABELS: Record<string, () => string> = {
    verre: () => m.ste_theme_verre(),
    neon: () => m.ste_theme_neon(),
    clair: () => m.ste_theme_clair(),
    documentation: () => m.ste_theme_documentation(),
    nuit: () => m.ste_theme_nuit(),
    papier: () => m.ste_theme_papier(),
    arcade: () => m.ste_theme_arcade(),
    royaume: () => m.ste_theme_royaume(),
  };

  function pickTheme(key: string) {
    theme = key;
    // Les réglages fins repartent du thème : un accent pensé pour l'ancien ne suit pas.
    settings = {};
  }

  async function save() {
    saving = true;
    try {
      await updateSite({ theme, themeSettings: settings, customCss: customCss.trim() || null, logoUrl, bannerUrl, faviconUrl }, guildId);
      toast.success(m.ste_appearance_saved());
      onChanged();
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      saving = false;
    }
  }

  function openPicker(target: 'logo' | 'banner' | 'favicon') {
    picking = target;
    pickerOpen = true;
  }

  const previewStyle = $derived(
    `--bg:${resolved.bg};--surface:${resolved.surface};--surface-strong:${resolved.surfaceStrong};--text:${resolved.text};--muted:${resolved.muted};--border:${resolved.border};--accent:${resolved.accent};--on-accent:${resolved.onAccent};--radius:${resolved.radius}px;--font:"${resolved.font}";--heading:"${resolved.headingFont}"`,
  );
</script>

<svelte:head><link rel="stylesheet" href={siteFontStylesheetUrl(resolved)} /></svelte:head>

<div class="appearance">
  <div class="space-y-4 min-w-0">
    <SectionCard title={m.ste_theme()} description={m.ste_theme_desc()} icon="palette">
      <div class="px-5 pb-5 theme-grid">
        {#each SITE_THEME_KEYS as key (key)}
          {@const t = resolveSiteTheme(key, {})}
          <button type="button" class="theme-card" class:is-selected={theme === key} aria-pressed={theme === key} onclick={() => pickTheme(key)}>
            <span class="theme-swatch" style="--bg:{t.bg};--surface:{t.surface};--accent:{t.accent};--text:{t.text}">
              <span class="sw-nav" class:sw-side={t.navLayout === 'side'}></span>
              <span class="sw-accent"></span>
            </span>
            <span class="theme-name">{THEME_LABELS[key]?.() ?? key}</span>
            <span class="theme-meta">{t.navLayout === 'side' ? m.ste_nav_side() : m.ste_nav_top()} · {t.dark ? m.ste_dark() : m.ste_light()}</span>
          </button>
        {/each}
      </div>
    </SectionCard>

    <SectionCard title={m.ste_theme_fine()} icon="sliders">
      <div class="px-5 pb-5 grid gap-4 sm:grid-cols-2">
        <Field label={m.ste_accent()}>
          {#snippet children(id)}
            <div class="flex items-center gap-2">
              <input {id} type="color" class="h-9 w-12 rounded cursor-pointer bg-transparent" value={resolved.accent} oninput={(e) => (settings = { ...settings, accent: (e.currentTarget as HTMLInputElement).value })} />
              <span class="font-mono text-body-sm">{resolved.accent}</span>
              {#if settings.accent}<Button size="sm" variant="ghost" onclick={() => { const { accent: _a, ...rest } = settings; settings = rest; }}>{m.ste_reset()}</Button>{/if}
            </div>
          {/snippet}
        </Field>
        <Field label={m.ste_radius()} hint={`${resolved.radius}px`}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} type="range" min="0" max="28" class="w-full" value={resolved.radius} oninput={(e) => (settings = { ...settings, radius: Number((e.currentTarget as HTMLInputElement).value) })} />
          {/snippet}
        </Field>
        <Field label={m.ste_font()}>
          {#snippet children(id)}
            <select {id} class="input w-full" value={resolved.font} onchange={(e) => (settings = { ...settings, font: (e.currentTarget as HTMLSelectElement).value as SiteThemeSettings['font'] })}>
              {#each SITE_FONTS as font (font)}<option value={font}>{font}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_heading_font()}>
          {#snippet children(id)}
            <select {id} class="input w-full" value={resolved.headingFont} onchange={(e) => (settings = { ...settings, headingFont: (e.currentTarget as HTMLSelectElement).value as SiteThemeSettings['font'] })}>
              {#each SITE_FONTS as font (font)}<option value={font}>{font}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.ste_background()}>
          {#snippet children(id)}
            <select {id} class="input w-full" value={resolved.background} onchange={(e) => (settings = { ...settings, background: (e.currentTarget as HTMLSelectElement).value as SiteThemeSettings['background'] })}>
              <option value="plain">{m.ste_bg_plain()}</option>
              <option value="gradient">{m.ste_bg_gradient()}</option>
              <option value="banner">{m.ste_bg_banner()}</option>
            </select>
          {/snippet}
        </Field>
      </div>
    </SectionCard>

    <SectionCard title={m.ste_branding()} description={m.ste_branding_desc()} icon="image">
      <div class="px-5 pb-5 brand-grid">
        {#each [['logo', logoUrl, state.guild?.iconUrl, m.ste_logo()], ['banner', bannerUrl, state.guild?.bannerUrl, m.ste_banner()], ['favicon', faviconUrl, state.guild?.iconUrl, m.ste_favicon()]] as [key, value, fallback, label] (key)}
          <div class="brand-slot">
            <p class="text-body-sm font-medium text-on-surface">{label}</p>
            <div class="brand-preview" class:is-banner={key === 'banner'}>
              {#if value || fallback}<img src={(value || fallback) as string} alt="" />{:else}<span class="text-2xs text-on-surface-variant">—</span>{/if}
            </div>
            <p class="text-2xs text-on-surface-variant">{value ? m.ste_brand_custom() : m.ste_brand_discord()}</p>
            <div class="flex gap-2">
              <Button size="sm" onclick={() => openPicker(key as 'logo' | 'banner' | 'favicon')}>{m.ste_brand_change()}</Button>
              {#if value}
                <Button size="sm" variant="ghost" onclick={() => { if (key === 'logo') logoUrl = null; else if (key === 'banner') bannerUrl = null; else faviconUrl = null; }}>{m.ste_brand_reset()}</Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </SectionCard>

    <SectionCard title={m.ste_custom_css()} description={m.ste_custom_css_desc()} icon="code">
      <div class="px-5 pb-5 space-y-2">
        <textarea class="input w-full font-mono text-xs" rows="10" spellcheck="false" maxlength="30000" placeholder=".site-root h2 &#123; letter-spacing: 0.02em; &#125;" bind:value={customCss}></textarea>
        <p class="text-2xs text-on-surface-variant">{m.ste_custom_css_rules()}</p>
      </div>
    </SectionCard>

    <div class="flex justify-end gap-2">
      <Button variant="primary" icon="check" loading={saving} disabled={!dirty} onclick={save}>{m.common_save()}</Button>
    </div>
  </div>

  <aside class="preview-wrap" aria-label={m.ste_preview_live()}>
    <p class="text-2xs uppercase tracking-wider text-on-surface-variant mb-2">{m.ste_preview_live()}</p>
    <div class="preview" style={previewStyle}>
      <div class="pv-header">
        <span class="pv-logo">{#if logoUrl || state.guild?.iconUrl}<img src={(logoUrl || state.guild?.iconUrl) as string} alt="" />{/if}</span>
        <strong>{site.name || state.guild?.name || site.slug}</strong>
        <span class="pv-nav">{m.ste_preview_nav()}</span>
      </div>
      <h3 class="pv-title">{m.ste_preview_heading()}</h3>
      <p class="pv-text">{m.ste_preview_text()}</p>
      <div class="pv-bento">
        <div class="pv-cell"><span class="pv-stat">1 284</span><span class="pv-muted">{m.ste_preview_members()}</span></div>
        <div class="pv-cell"><span class="pv-btn">{m.ste_preview_join()}</span></div>
      </div>
    </div>
  </aside>
</div>

<AssetPicker
  bind:open={pickerOpen}
  {guildId}
  canDelete={state.rights.manage}
  onPick={(asset) => {
    if (picking === 'logo') logoUrl = asset.url;
    else if (picking === 'banner') bannerUrl = asset.url;
    else if (picking === 'favicon') faviconUrl = asset.url;
  }}
/>

<style>
  .appearance { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; align-items: start; }
  @media (max-width: 1100px) { .appearance { grid-template-columns: 1fr; } }
  .theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .theme-card { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 12px; border: 1px solid rgb(255 255 255 / 0.08); background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .theme-card.is-selected { border-color: rgb(124 108 255 / 0.8); background: rgb(124 108 255 / 0.08); }
  .theme-swatch { position: relative; display: block; height: 64px; border-radius: 8px; background: var(--bg); overflow: hidden; }
  .sw-nav { position: absolute; left: 6px; right: 6px; top: 6px; height: 9px; border-radius: 4px; background: var(--surface); }
  .sw-nav.sw-side { right: auto; width: 26%; height: auto; bottom: 6px; }
  .sw-accent { position: absolute; right: 10px; bottom: 10px; width: 30px; height: 10px; border-radius: 5px; background: var(--accent); }
  .theme-name { font-weight: 600; font-size: 0.85rem; }
  .theme-meta { font-size: 0.72rem; color: rgb(255 255 255 / 0.5); }
  .brand-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .brand-slot { display: flex; flex-direction: column; gap: 6px; }
  .brand-preview { height: 72px; width: 72px; border-radius: 12px; overflow: hidden; display: grid; place-items: center; background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.08); }
  .brand-preview.is-banner { width: 100%; }
  .brand-preview img { width: 100%; height: 100%; object-fit: cover; }
  .preview-wrap { position: sticky; top: 16px; }
  .preview { padding: 14px; border-radius: 16px; background: var(--bg); color: var(--text); font-family: var(--font), system-ui, sans-serif; border: 1px solid var(--border); }
  .pv-header { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); font-family: var(--heading), var(--font), sans-serif; font-size: 0.85rem; }
  .pv-logo { width: 22px; height: 22px; border-radius: 6px; overflow: hidden; background: var(--surface-strong); }
  .pv-logo img { width: 100%; height: 100%; object-fit: cover; }
  .pv-nav { margin-left: auto; font-size: 0.75rem; color: var(--muted); }
  .pv-title { font-family: var(--heading), var(--font), sans-serif; margin: 16px 0 4px; font-size: 1.2rem; }
  .pv-text { margin: 0 0 12px; color: var(--muted); font-size: 0.85rem; }
  .pv-bento { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pv-cell { padding: 12px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); display: flex; flex-direction: column; justify-content: center; }
  .pv-stat { font-family: var(--heading), var(--font), sans-serif; font-size: 1.2rem; font-weight: 700; }
  .pv-muted { font-size: 0.72rem; color: var(--muted); }
  .pv-btn { align-self: flex-start; padding: 6px 12px; border-radius: calc(var(--radius) * 0.6); background: var(--accent); color: var(--on-accent); font-size: 0.8rem; font-weight: 600; }
</style>
