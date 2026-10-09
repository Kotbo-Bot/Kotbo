<script lang="ts">
  /**
   * Apparence du site : thème (qui fixe aussi la disposition du menu), mode
   * clair ou sombre par défaut, accent, polices, arrondis, fond, logo,
   * bannière, favicon et CSS libre. L'aperçu reprend la structure du site
   * publié (barre, bannière d'accueil, cartes, pied de page) avec les mêmes
   * jetons, dans l'une ou l'autre palette.
   */
  import { untrack } from 'svelte';
  import {
    resolveSiteTheme,
    siteFontStylesheetUrl,
    SITE_FONTS,
    SITE_THEME_KEYS,
    type SiteColorMode,
    type SitePalette,
    type SiteThemeSettings,
  } from '@kotbo/shared';
  import { Button, Field, FilterPills, SectionCard, type FilterOption } from '../ui';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { updateSite, type SiteState } from '../../api/site';
  import AssetPicker from './editor/AssetPicker.svelte';
  import { siteErrorMessage } from './siteErrors';

  let { siteState, guildId, onChanged }: { siteState: SiteState; guildId: string; onChanged: () => void } = $props();

  const site = $derived(siteState.site!);
  // Valeurs de départ du formulaire, modifiées localement jusqu'à l'enregistrement.
  const initial = untrack(() => siteState.site!);
  let theme = $state(initial.theme);
  let settings = $state<SiteThemeSettings>({ ...(initial.themeSettings ?? {}) });
  let customCss = $state(initial.customCss ?? '');
  let logoUrl = $state(initial.logoUrl);
  let bannerUrl = $state(initial.bannerUrl);
  let faviconUrl = $state(initial.faviconUrl);
  let saving = $state(false);
  let picking = $state<'logo' | 'banner' | 'favicon' | null>(null);
  let pickerOpen = $state(false);

  const resolved = $derived(resolveSiteTheme(theme, settings));
  let previewMode = $state<'light' | 'dark'>(untrack(() => (resolveSiteTheme(initial.theme, initial.themeSettings).mode === 'dark' ? 'dark' : 'light')));
  const dirty = $derived(
    theme !== site.theme ||
      JSON.stringify(settings) !== JSON.stringify(site.themeSettings ?? {}) ||
      (customCss || null) !== (site.customCss || null) ||
      logoUrl !== site.logoUrl ||
      bannerUrl !== site.bannerUrl ||
      faviconUrl !== site.faviconUrl,
  );

  const THEME_LABELS: Record<string, () => string> = {
    azur: () => m.ste_theme_azur(),
    carbone: () => m.ste_theme_carbone(),
    aurore: () => m.ste_theme_aurore(),
    braise: () => m.ste_theme_braise(),
    foret: () => m.ste_theme_foret(),
    royaume: () => m.ste_theme_royaume(),
    papier: () => m.ste_theme_papier(),
    documentation: () => m.ste_theme_documentation(),
  };

  const MODE_LABELS: Record<SiteColorMode, () => string> = {
    auto: () => m.ste_mode_auto(),
    light: () => m.ste_mode_light(),
    dark: () => m.ste_mode_dark(),
  };
  const modeOptions: FilterOption<SiteColorMode>[] = [
    { value: 'auto', label: m.ste_mode_auto() },
    { value: 'light', label: m.ste_mode_light() },
    { value: 'dark', label: m.ste_mode_dark() },
  ];
  const previewOptions: FilterOption<'light' | 'dark'>[] = [
    { value: 'light', label: m.ste_mode_light() },
    { value: 'dark', label: m.ste_mode_dark() },
  ];

  function pickTheme(key: string) {
    theme = key;
    // Les réglages fins repartent du thème : un accent pensé pour l'ancien ne suit pas.
    settings = {};
    const mode = resolveSiteTheme(key, {}).mode;
    previewMode = mode === 'dark' ? 'dark' : 'light';
  }

  function setMode(mode: SiteColorMode) {
    settings = { ...settings, mode };
    if (mode !== 'auto') previewMode = mode;
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

  function paletteStyle(p: SitePalette): string {
    return `--bg:${p.bg};--surface:${p.surface};--surface-strong:${p.surfaceStrong};--text:${p.text};--muted:${p.muted};--border:${p.border};--header:${p.header};--header-text:${p.headerText};--footer:${p.footer};--footer-text:${p.footerText}`;
  }

  const palette = $derived(previewMode === 'dark' ? resolved.dark : resolved.light);
  const banner = $derived(bannerUrl || siteState.guild?.bannerUrl || null);
  const logo = $derived(logoUrl || siteState.guild?.iconUrl || null);
  const siteName = $derived(site.name || siteState.guild?.name || site.slug);
  const previewStyle = $derived(
    `${paletteStyle(palette)};--accent:${resolved.accent};--on-accent:${resolved.onAccent};--radius:${resolved.radius}px;--font:"${resolved.font}";--heading:"${resolved.headingFont}"${banner ? `;--banner:url("${banner.replace(/["\\]/g, '')}")` : ''}`,
  );
</script>

<svelte:head><link rel="stylesheet" href={siteFontStylesheetUrl(resolved)} /></svelte:head>

<div class="appearance">
  <div class="space-y-4 min-w-0">
    <SectionCard title={m.ste_theme()} description={m.ste_theme_desc()} icon="palette">
      <div class="px-5 pb-5 theme-grid">
        {#each SITE_THEME_KEYS as key (key)}
          {@const t = resolveSiteTheme(key, {})}
          <button type="button" class="theme-card" class:is-selected={resolved.key === key} aria-pressed={resolved.key === key} onclick={() => pickTheme(key)}>
            <span class="theme-swatch" style="--accent:{t.accent}">
              {#each [t.light, t.dark] as p, i (i)}
                <span class="sw-half" style={paletteStyle(p)}>
                  <span class="sw-bar" class:sw-side={t.navLayout === 'side'}><span class="sw-dot"></span></span>
                  <span class="sw-card"></span>
                </span>
              {/each}
            </span>
            <span class="theme-name">{THEME_LABELS[key]?.() ?? key}</span>
            <span class="theme-meta">{t.navLayout === 'side' ? m.ste_nav_side() : m.ste_nav_top()} · {MODE_LABELS[t.mode]()}</span>
          </button>
        {/each}
      </div>
    </SectionCard>

    <SectionCard title={m.ste_theme_fine()} icon="sliders">
      <div class="px-5 pb-5 grid gap-4 sm:grid-cols-2">
        <div class="sm:col-span-2">
          <Field label={m.ste_mode()} hint={m.ste_mode_hint()}>
            {#snippet children()}
              <FilterPills label={m.ste_mode()} options={modeOptions} value={resolved.mode} onchange={setMode} />
            {/snippet}
          </Field>
        </div>
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
            <input {id} aria-describedby={describedBy} type="range" min="0" max="24" class="w-full" value={resolved.radius} oninput={(e) => (settings = { ...settings, radius: Number((e.currentTarget as HTMLInputElement).value) })} />
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
              <option value="banner">{m.ste_bg_banner()}</option>
            </select>
          {/snippet}
        </Field>
      </div>
    </SectionCard>

    <SectionCard title={m.ste_branding()} description={m.ste_branding_desc()} icon="image">
      <div class="px-5 pb-5 brand-grid">
        {#each [['logo', logoUrl, siteState.guild?.iconUrl, m.ste_logo()], ['banner', bannerUrl, siteState.guild?.bannerUrl, m.ste_banner()], ['favicon', faviconUrl, siteState.guild?.iconUrl, m.ste_favicon()]] as [key, value, fallback, label] (key)}
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
        <textarea class="input w-full font-mono text-xs" rows="10" spellcheck="false" maxlength="30000" placeholder=".site-root h2 &#123; &#125;" bind:value={customCss}></textarea>
        <p class="text-2xs text-on-surface-variant">{m.ste_custom_css_rules()}</p>
      </div>
    </SectionCard>

    <div class="flex justify-end gap-2">
      <Button variant="primary" icon="check" loading={saving} disabled={!dirty} onclick={save}>{m.common_save()}</Button>
    </div>
  </div>

  <aside class="preview-wrap" aria-label={m.ste_preview_live()}>
    <div class="flex items-center justify-between gap-2 mb-2">
      <p class="text-body-sm font-medium text-on-surface">{m.ste_preview_live()}</p>
      <FilterPills label={m.ste_preview_live()} options={previewOptions} value={previewMode} onchange={(v) => (previewMode = v)} />
    </div>
    <div class="preview" style={previewStyle}>
      <div class="pv-header">
        <span class="pv-logo">{#if logo}<img src={logo} alt="" />{:else}{siteName.slice(0, 1).toUpperCase()}{/if}</span>
        <strong class="pv-name">{siteName}</strong>
        <span class="pv-links"><span class="is-current">{m.ste_link_home()}</span><span>{m.ste_link_wiki()}</span><span>{m.ste_link_blog()}</span></span>
      </div>
      <div class="pv-hero" class:has-image={Boolean(banner)}>
        <strong class="pv-hero-title">{siteName}</strong>
        <span class="pv-hero-lead">{site.tagline || m.ste_preview_text()}</span>
        <span class="pv-hero-stats"><span class="pv-dot"></span>128 {m.ste_preview_online()} · 1 284 {m.ste_preview_members()}</span>
        <span class="pv-btn">{m.ste_preview_join()}</span>
      </div>
      <div class="pv-body">
        <p class="pv-section">{m.ste_preview_news()}</p>
        <div class="pv-cards">
          {#each [m.ste_preview_card_one(), m.ste_preview_card_two()] as title (title)}
            <div class="pv-card"><span class="pv-cover"></span><span class="pv-card-title">{title}</span><span class="pv-card-date">12/10</span></div>
          {/each}
        </div>
      </div>
      <div class="pv-footer">© {siteName}</div>
    </div>
  </aside>
</div>

<AssetPicker
  bind:open={pickerOpen}
  {guildId}
  canDelete={siteState.rights.manage}
  onPick={(asset) => {
    if (picking === 'logo') logoUrl = asset.url;
    else if (picking === 'banner') bannerUrl = asset.url;
    else if (picking === 'favicon') faviconUrl = asset.url;
  }}
/>

<style>
  .appearance { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; }
  @media (max-width: 1100px) { .appearance { grid-template-columns: 1fr; } }

  .theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .theme-card { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 8px; border: 1px solid var(--color-outline-variant); background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .theme-card:hover { background: var(--color-surface-hover); }
  .theme-card.is-selected { border-color: var(--color-primary); box-shadow: inset 0 0 0 1px var(--color-primary); }
  .theme-swatch { display: grid; grid-template-columns: 1fr 1fr; height: 64px; border-radius: 6px; overflow: hidden; border: 1px solid var(--color-outline-variant); }
  .sw-half { position: relative; background: var(--bg); }
  .sw-bar { position: absolute; left: 0; right: 0; top: 0; height: 12px; background: var(--header); border-bottom: 1px solid var(--border); }
  .sw-bar.sw-side { right: auto; width: 30%; height: 100%; border-bottom: 0; border-right: 1px solid var(--border); }
  .sw-dot { position: absolute; left: 5px; top: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .sw-card { position: absolute; right: 6px; bottom: 6px; width: 46%; height: 26px; border-radius: 3px; background: var(--surface); border: 1px solid var(--border); border-top: 3px solid var(--accent); }
  .theme-name { font-weight: 600; font-size: 0.86rem; }
  .theme-meta { font-size: 0.75rem; color: var(--color-on-surface-variant); }

  .brand-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .brand-slot { display: flex; flex-direction: column; gap: 6px; }
  .brand-preview { height: 72px; width: 72px; border-radius: 8px; overflow: hidden; display: grid; place-items: center; background: var(--color-surface-container); border: 1px solid var(--color-outline-variant); }
  .brand-preview.is-banner { width: 100%; }
  .brand-preview img { width: 100%; height: 100%; object-fit: cover; }

  .preview-wrap { position: sticky; top: 16px; }
  .preview { overflow: hidden; border-radius: 8px; background: var(--bg); color: var(--text); font-family: var(--font), system-ui, sans-serif; border: 1px solid var(--color-outline-variant); font-size: 12px; }
  .pv-header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--header); color: var(--header-text); border-bottom: 1px solid var(--border); }
  .pv-logo { width: 22px; height: 22px; border-radius: 50%; overflow: hidden; flex: none; display: grid; place-items: center; background: var(--accent); color: var(--on-accent); font-weight: 700; font-size: 11px; }
  .pv-logo img { width: 100%; height: 100%; object-fit: cover; }
  .pv-name { font-family: var(--heading), var(--font), sans-serif; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pv-links { margin-left: auto; display: flex; gap: 8px; font-weight: 600; opacity: 0.8; white-space: nowrap; }
  .pv-links .is-current { color: var(--accent); opacity: 1; }
  .pv-hero { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 22px 12px; text-align: center; background: var(--header); color: var(--header-text); border-bottom: 1px solid var(--border); }
  .pv-hero.has-image { color: #fff; background: linear-gradient(rgb(0 0 0 / 0.5), rgb(0 0 0 / 0.68)), var(--banner) center / cover no-repeat, #111; }
  .pv-hero-title { font-family: var(--heading), var(--font), sans-serif; font-size: 18px; line-height: 1.1; }
  .pv-hero-lead { opacity: 0.85; max-width: 28ch; }
  .pv-hero-stats { display: flex; align-items: center; gap: 5px; font-weight: 600; }
  .pv-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; }
  .pv-btn { margin-top: 4px; padding: 5px 12px; border-radius: calc(var(--radius) * 0.6); background: var(--accent); color: var(--on-accent); font-weight: 600; }
  .pv-body { padding: 12px; }
  .pv-section { margin: 0 0 8px; padding-bottom: 5px; font-family: var(--heading), var(--font), sans-serif; font-weight: 700; font-size: 13px; border-bottom: 2px solid var(--border); position: relative; }
  .pv-section::after { content: ""; position: absolute; left: 0; bottom: -2px; width: 28px; height: 2px; background: var(--accent); }
  .pv-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pv-card { display: flex; flex-direction: column; overflow: hidden; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); }
  .pv-cover { height: 38px; background: var(--surface-strong); }
  .pv-card-title { padding: 6px 8px 0; font-weight: 600; line-height: 1.25; }
  .pv-card-date { padding: 2px 8px 7px; color: var(--muted); font-size: 11px; }
  .pv-footer { padding: 9px 12px; background: var(--footer); color: var(--footer-text); font-size: 11px; }
</style>
