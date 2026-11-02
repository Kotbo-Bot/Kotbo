<script lang="ts">
  /**
   * Vignette d'un modèle de site : son accueil redessiné en maquette, section
   * par section (fond, colonnes, titres, textes, boutons, blocs), aux couleurs
   * et à l'arrondi de son thème. Rien n'est chargé : tout vient du document.
   */
  import { resolveSiteTheme, sitePaletteVars, type SiteDocument, type SiteNode } from '@kotbo/shared';

  let { home, theme, themeSettings }: { home: SiteDocument | null; theme: string; themeSettings: unknown } = $props();

  type Part = 'title' | 'text' | 'button' | 'media' | 'cards';

  const resolved = $derived(resolveSiteTheme(theme, themeSettings));
  const style = $derived([sitePaletteVars(resolved.initial), `--site-accent:${resolved.accent}`, `--site-radius:${Math.min(resolved.radius, 8)}px`].join(';'));

  function parts(nodes: SiteNode[] | undefined): Part[] {
    const out: Part[] = [];
    for (const node of nodes ?? []) {
      if (out.length >= 4) break;
      if (node.type === 'heading') out.push('title');
      else if (node.type === 'paragraph' && node.content?.length) out.push('text');
      else if (node.type === 'button' || (node.type === 'module' && node.attrs?.module === 'join')) out.push('button');
      else if (['image', 'gallery', 'video', 'banner'].includes(node.type)) out.push('media');
      else if (node.type === 'module' || node.type === 'grid' || node.type === 'testimonials' || node.type === 'faq') out.push('cards');
    }
    return out;
  }

  const sections = $derived.by(() =>
    (home?.content ?? []).slice(0, 5).map((node) => {
      if (node.type !== 'section') return { background: 'none', tall: false, columns: [{ weight: 1, parts: parts([node]) }] };
      const weights = String(node.attrs?.layout ?? '1').split('-').map(Number);
      return {
        background: String(node.attrs?.background ?? 'none'),
        gradient: String(node.attrs?.bgGradient ?? 'accent'),
        tall: node.attrs?.height !== 'auto' && node.attrs?.height !== undefined,
        centered: (node.content?.[0]?.content ?? []).some((b) => b.attrs?.textAlign === 'center'),
        columns: (node.content ?? []).map((col, i) => ({ weight: weights[i] ?? 1, parts: parts(col.content) })),
      };
    }),
  );
</script>

<div class="tth" {style} aria-hidden="true">
  <div class="tth-nav"><span></span><span></span><span></span></div>
  {#each sections as section, i (i)}
    <div class="tth-sect tth-bg-{section.background} tth-grad-{section.gradient}" class:is-tall={section.tall} class:is-centered={section.centered}>
      {#each section.columns as column, j (j)}
        <div class="tth-col" style="flex:{column.weight}">
          {#each column.parts as part, k (k)}<span class="tth-{part}"></span>{/each}
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .tth { display: flex; flex-direction: column; aspect-ratio: 4 / 3; overflow: hidden; background: var(--site-bg); color: var(--site-text); border-radius: 8px 8px 0 0; }
  .tth-nav { display: flex; gap: 4px; justify-content: flex-end; padding: 5px 8px; background: var(--site-surface); border-bottom: 1px solid var(--site-border); }
  .tth-nav span { width: 14px; height: 3px; border-radius: 2px; background: var(--site-muted); opacity: 0.6; }
  .tth-sect { display: flex; gap: 6px; padding: 8px 10px; flex: none; }
  .tth-sect.is-tall { padding-top: 18px; padding-bottom: 18px; }
  .tth-sect.is-centered .tth-col { align-items: center; }
  .tth-bg-surface { background: var(--site-surface-strong); }
  .tth-bg-accent { background: var(--site-accent); color: #fff; }
  .tth-bg-dark, .tth-bg-image { background: #14171c; color: #fff; }
  .tth-bg-color { background: var(--site-surface-strong); }
  .tth-bg-gradient { color: #fff; background: linear-gradient(135deg, var(--site-accent), color-mix(in srgb, var(--site-accent) 45%, #000)); }
  .tth-bg-gradient.tth-grad-sunset { background: linear-gradient(135deg, #c2410c, #9d174d); }
  .tth-bg-gradient.tth-grad-ocean { background: linear-gradient(135deg, #0369a1, #1e3a8a); }
  .tth-bg-gradient.tth-grad-forest { background: linear-gradient(135deg, #15803d, #064e3b); }
  .tth-bg-gradient.tth-grad-night { background: linear-gradient(160deg, #312e81, #0f172a); }
  .tth-bg-gradient.tth-grad-aurora { background: linear-gradient(135deg, #0e7490, #6d28d9); }
  .tth-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .tth-col span { display: block; border-radius: 2px; background: currentColor; }
  .tth-title { height: 5px; width: 60%; opacity: 0.85; }
  .tth-text { height: 2px; width: 85%; opacity: 0.4; }
  .tth-button { height: 5px; width: 30%; border-radius: var(--site-radius) !important; background: var(--site-accent) !important; }
  .tth-bg-accent .tth-button { background: #fff !important; }
  .tth-media { height: 18px; width: 100%; opacity: 0.25; border-radius: var(--site-radius) !important; }
  .tth-cards { height: 12px; width: 100%; opacity: 0.18; border-radius: var(--site-radius) !important; }
</style>
