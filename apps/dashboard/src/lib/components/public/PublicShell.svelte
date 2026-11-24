<script lang="ts">
  /**
   * Coque commune des pages publiques d'un serveur : fond, en-tête, langue,
   * thème clair/sombre et pied de page. Elle lit l'habillage du serveur et le
   * traduit en variables CSS, si bien que tout ce qu'elle contient - cartes,
   * boutons, textes - prend les couleurs du serveur sans règle par page.
   *
   * Les cartes de contenu portent `.pub-card` : fond, bordure et rayon suivent
   * le thème (verre dépoli compris).
   */
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import { fetchPublicTheme } from '../../api/publicTheme';
  import { publicThemeStyle, type PublicTheme } from '../../publicTheme';
  import { m, locales, getLocale, type Locale } from '../../i18n';
  import { themeStore } from '../../stores/theme.svelte';
  import { userPrefs } from '../../stores/userPreferences.svelte';

  interface Props {
    serverId: string;
    /** Sous-titre de l'en-tête : ce que la page montre (« Classement », « Clans »...). */
    subtitle: string;
    icon?: string;
    guildName?: string | null;
    guildIcon?: string | null;
    /** Largeur utile du contenu. */
    width?: 'narrow' | 'default' | 'wide';
    /** Badge « en direct » à droite de l'en-tête. */
    live?: boolean;
    /** Thème imposé (aperçu de l'éditeur) : aucune requête n'est faite. */
    theme?: PublicTheme | null;
    /** Aperçu intégré : ni hauteur d'écran, ni pied de page. */
    embedded?: boolean;
    /** Pastilles sous le sous-titre (saison en cours, échéance...). */
    meta?: Snippet;
    children: Snippet;
  }
  const {
    serverId, subtitle, icon = 'Trophy', guildName = null, guildIcon = null,
    width = 'default', live = false, theme: themeProp, embedded = false, meta, children,
  }: Props = $props();

  let fetched = $state<{ theme: PublicTheme | null; guildName: string | null; guildIcon: string | null } | null>(null);
  onMount(async () => {
    if (themeProp !== undefined) return;
    fetched = await fetchPublicTheme(serverId);
  });

  const theme = $derived(themeProp !== undefined ? themeProp : fetched?.theme ?? null);
  const name = $derived(theme?.siteTitle || guildName || fetched?.guildName || 'Kotbo');
  const logo = $derived(theme?.logoUrl || guildIcon || fetched?.guildIcon || null);
  const maxW = $derived({ narrow: 'max-w-3xl', default: 'max-w-5xl', wide: 'max-w-6xl' }[width]);
  const rootStyle = $derived(publicThemeStyle(theme));
  const currentLocale = $derived(getLocale());

  function switchLocale(loc: Locale) {
    if (loc !== currentLocale) userPrefs.set('language', loc);
  }
  // Le CSS personnalisé a déjà été assaini par l'API ; on le circonscrit à la coque.
  const customCss = $derived((theme?.customCss ?? '').replace(/<\/style/gi, ''));
</script>

<svelte:head>
  {#if customCss}
    {@html `<style>${customCss}</style>`}
  {/if}
</svelte:head>

<div
  class="pub-root relative overflow-x-hidden bg-surface text-on-surface {embedded ? '' : 'min-h-screen'}"
  class:pub-compact={theme?.density === 'compact'}
  data-bg={theme?.background ?? 'plain'}
  data-glass={theme?.glass ? 'true' : undefined}
  style={rootStyle}
>
  <div class="relative z-10 mx-auto w-full {maxW} px-4 sm:px-6 {theme?.density === 'compact' ? 'py-6 space-y-5' : 'py-10 space-y-8'}">
    {#if theme?.bannerUrl}
      <img src={theme.bannerUrl} alt="" class="pub-banner h-32 sm:h-44 w-full object-cover" loading="lazy" />
    {/if}

    <header class="pub-card flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 sm:p-5">
      <div class="flex items-center gap-3.5 min-w-0">
        {#if logo}
          <img src={logo} alt="" class="w-11 h-11 rounded-[calc(var(--pub-radius,14px)-4px)] object-cover border border-outline-variant shrink-0" />
        {:else}
          <div class="w-11 h-11 rounded-[calc(var(--pub-radius,14px)-4px)] bg-surface-container border border-outline-variant flex items-center justify-center text-sm font-semibold shrink-0">
            {name.slice(0, 2).toUpperCase()}
          </div>
        {/if}
        <div class="min-w-0">
          <h1 class="text-lg font-semibold tracking-tight font-headline truncate">{name}</h1>
          <p class="flex items-center gap-1.5 text-xs text-on-surface-variant">
            <span class="text-primary"><Papicon icon={icon} size={14} /></span>
            <span class="truncate">{subtitle}</span>
          </p>
          {#if meta}<div class="mt-1.5">{@render meta()}</div>{/if}
        </div>
      </div>

      <div class="flex items-center gap-2 self-start sm:self-auto">
        {#if live}
          <span class="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 text-xs font-semibold text-on-success-container">
            <span class="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></span>
            {m.leveling_public_live_badge()}
          </span>
        {/if}
        <div class="flex items-center rounded-full border border-outline-variant bg-surface-container p-0.5 text-xs font-semibold" role="group" aria-label={m.pub_shell_language()}>
          {#each locales as loc}
            <button
              type="button"
              onclick={() => switchLocale(loc)}
              aria-pressed={currentLocale === loc}
              class="px-2.5 py-1 rounded-full transition-colors {currentLocale === loc ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}"
            >{loc}</button>
          {/each}
        </div>
        <button
          type="button"
          onclick={themeStore.toggle}
          aria-label={m.navbar_change_theme()}
          class="w-8 h-8 rounded-full border border-outline-variant bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <Papicon icon={themeStore.dark ? 'sun' : 'moon'} size={15} />
        </button>
      </div>
    </header>

    {#if theme?.welcomeText}
      <p class="text-sm leading-relaxed text-on-surface-variant whitespace-pre-line">{theme.welcomeText}</p>
    {/if}

    {@render children()}

    {#if !embedded}
      <footer class="flex flex-col sm:flex-row items-center justify-between gap-2 border-t border-outline-variant pt-5 text-xs text-on-surface-variant">
        <p>{m.leveling_public_footer_powered_by()} <span class="font-semibold text-on-surface">Kotbo</span> · {m.leveling_public_footer_synced()}</p>
        <a href="/" class="font-semibold text-on-surface hover:text-primary transition-colors">{m.leveling_public_footer_dashboard()} →</a>
      </footer>
    {/if}
  </div>
</div>

<style>
  .pub-root {
    font-family: var(--pub-font, var(--font-body));
    min-height: inherit;
  }
  .pub-root :global(h1), .pub-root :global(h2), .pub-root :global(h3) {
    font-family: var(--pub-font, var(--font-headline));
  }
  /* Fonds : discrets, tirés de la couleur d'accent pour suivre le thème. */
  .pub-root[data-bg='grid']::before,
  .pub-root[data-bg='glow']::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
  }
  .pub-root[data-bg='grid']::before {
    background-image:
      linear-gradient(color-mix(in srgb, var(--color-on-surface) 5%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--color-on-surface) 5%, transparent) 1px, transparent 1px);
    background-size: 32px 32px;
    mask-image: linear-gradient(to bottom, black, transparent 85%);
  }
  .pub-root[data-bg='glow']::before {
    background: radial-gradient(60rem 28rem at 50% -8rem, color-mix(in srgb, var(--color-primary) 18%, transparent), transparent 70%);
  }

  /* Carte de contenu : le rayon, le fond et le verre viennent du thème. */
  .pub-root :global(.pub-card), .pub-banner {
    border-radius: var(--pub-radius, 14px);
  }
  .pub-root :global(.pub-card) {
    background: var(--color-surface-container-low);
    border: 1px solid var(--color-outline-variant);
  }
  .pub-root[data-glass='true'] :global(.pub-card) {
    background: color-mix(in srgb, var(--color-surface-container-low) 62%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }
  .pub-root :global(.pub-card-hover) {
    transition: border-color 0.15s, transform 0.15s;
  }
  .pub-root :global(.pub-card-hover:hover) {
    border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-outline-variant));
    transform: translateY(-1px);
  }
  @media (prefers-reduced-motion: reduce) {
    .pub-root :global(.pub-card-hover) { transition: none; }
    .pub-root :global(.pub-card-hover:hover) { transform: none; }
  }
</style>
