<script lang="ts">
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { API_BASE_URL } from '../lib/api';
  import { consumeLoginReturn } from '../lib/loginReturn';
  import { router } from 'tinro';
  import Papicon from '../lib/components/Papicon.svelte';
  import { brandingStore } from '../lib/stores/branding.svelte';
  import PrivacyNotice from '../lib/components/PrivacyNotice.svelte';
  import DashboardSketch from '../lib/components/login/DashboardSketch.svelte';
  import { m } from '../lib/i18n';
  import '../lib/components/admin/admin-theme.css';

  /*
   * La page reprend le langage de la console admin (SN Pro, cartes arrondies,
   * pilules) : ses jetons ne vivent que sous `html.admin-theme`.
   */
  onMount(() => {
    document.documentElement.classList.add('admin-theme');
    return () => {
      // Une image plus tard : si la console admin a pris le relais, elle garde le theme.
      requestAnimationFrame(() => {
        if (!document.querySelector('.admin-console')) {
          document.documentElement.classList.remove('admin-theme');
        }
      });
    };
  });

  let errorMessage = $state<string | null>(null);
  /**
   * Le va-et-vient vers Discord est une navigation plein page : entre le clic
   * et le changement d'URL, l'appel a `/api/config` peut prendre une seconde
   * sur une connexion lente. Sans ce drapeau la page restait parfaitement
   * immobile et le visiteur recliquait, relancant l'echange OAuth.
   */
  let isRedirecting = $state(false);
  /** Le bouton « Reessayer » ne redirige pas : il resonde seulement l'API. */
  let isRetrying = $state(false);

  /**
   * Ou revenir apres le va-et-vient Discord.
   *
   * L'API sait deja reposer quelqu'un ou il allait - `?returnTo=`, garde en
   * cookie pendant l'echange et relu au retour. Sans ce parametre, tout le
   * monde atterrit sur `/` : le visiteur venu de « Ajouter le bot » se
   * retrouvait sur le tableau de bord d'un serveur quelconque, au lieu de la
   * liste ou il devait choisir celui a equiper.
   *
   * L'adresse est consommee a la construction du lien, pas au clic : la page
   * de connexion ne se traverse qu'une fois par tentative, et une intention
   * qui survivrait a un retour en arriere detournerait la connexion suivante.
   */
  const returnTo = consumeLoginReturn();
  const oauthLoginUrl = `${API_BASE_URL || ''}/api/auth/discord/login${
    returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
  }`;

  async function hydrateOAuthConfig() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/config`, {
        headers: { Accept: 'application/json' }
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        errorMessage = API_BASE_URL
          ? m.login_api_config_invalid_url({ url: API_BASE_URL })
          : m.login_api_config_invalid();
        return;
      }

      const data = await response.json() as { discordClientId?: string; error?: string; missing?: string[] };

      if (!response.ok) {
        if (data?.missing?.length) {
          errorMessage = m.login_oauth_invalid({ missing: data.missing.join(', ') });
        } else if (data?.error) {
          errorMessage = data.error;
        }
        return;
      }
    } catch {
      errorMessage = API_BASE_URL
        ? m.login_api_unreachable_url({ url: API_BASE_URL })
        : m.login_api_unreachable();
    }
  }

  const loginWithDiscord = async () => {
    if (isRedirecting) return;

    isRedirecting = true;
    errorMessage = null;
    await hydrateOAuthConfig();

    if (errorMessage) {
      isRedirecting = false;
      return;
    }

    window.location.href = oauthLoginUrl;
  };

  /**
   * Une API momentanement injoignable condamnait la page : le message d'erreur
   * s'affichait au chargement et plus rien ne le relisait sans rechargement
   * complet. Ce bouton retente la sonde seule, sans engager de redirection.
   */
  const retryConfig = async () => {
    if (isRetrying) return;

    isRetrying = true;
    errorMessage = null;
    await hydrateOAuthConfig();
    isRetrying = false;
  };

  onMount(async () => {
    await hydrateOAuthConfig();

    if (authStore.isAuthenticated) {
      router.goto('/');
    }

    const urlParams = new URLSearchParams(window.location.search);
    const errorParam = urlParams.get('error');
    if (errorParam) {
      if (errorParam === 'auth_failed') {
        errorMessage = m.login_auth_failed();
      } else if (errorParam === 'no_code') {
        errorMessage = m.login_no_code();
      } else {
        errorMessage = m.login_unexpected_error();
      }

      window.history.replaceState({}, document.title, window.location.pathname);
    }
  });

  const year = new Date().getFullYear();

  /**
   * Les trois arguments que le croquis illustre.
   *
   * Ils remplacent l'ancienne ligne « OAuth 2.0 / AES-256 / 99.98% » : les deux
   * premiers etaient des details d'implementation, le troisieme un chiffre
   * ecrit en dur qu'aucune sonde ne mesurait.
   *
   * La liste sert deux fois : visible sous la carte tant que le croquis est
   * masque, puis reservee aux lecteurs d'ecran une fois qu'il apparait - le
   * SVG etant decoratif, c'est elle qui en porte le sens.
   */
  const highlights = $derived([
    { icon: 'server', label: m.login_sketch_servers() },
    { icon: 'chart', label: m.login_sketch_analytics() },
    { icon: 'shield', label: m.login_sketch_logs() }
  ]);
</script>

<div class="admin-wash min-h-screen w-full bg-background text-on-surface font-body lg:grid lg:grid-cols-[1.05fr_1fr] lg:min-h-0 lg:h-screen lg:max-h-screen lg:overflow-hidden">

  <!--
    Panneau vitrine, en carte flottante comme la barre laterale de la console.
    Masque sous `lg` : a cette largeur le croquis passerait sous 340px et ses
    annotations se chevaucheraient. Le mobile garde la liste d'arguments.
  -->
  <aside class="showcase relative hidden lg:flex flex-col justify-between m-3 px-12 py-10 xl:px-14">
    <div class="flex items-baseline gap-2.5">
      <img src={brandingStore.logoUrl || '/favicon.svg'} alt="" class="w-8 h-8 rounded-xl self-center" />
      <span class="font-headline text-2xl font-bold tracking-tight leading-none">{brandingStore.brandName}</span>
    </div>

    <div class="relative max-w-xl">
      <!--
        Accroche stylee comme un titre, mais ecrite en `<p>` : ce panneau
        precede le formulaire dans le DOM, un `<h2>` aurait annonce un niveau 2
        avant le `<h1>` de la carte.
      -->
      <p class="font-headline text-4xl xl:text-[2.6rem] font-bold leading-[1.15] tracking-tight text-balance">
        {m.login_pitch_lead()}
        <s class="struck">{m.login_pitch_struck()}</s>
        <span class="text-primary">{m.login_pitch_tail()}</span>
      </p>

      <p class="mt-3 text-sm text-on-surface-variant">{m.login_pitch_note()}</p>

      <figure class="sketch-frame mt-8 p-5">
        <DashboardSketch
          labelServers={m.login_sketch_servers()}
          labelAnalytics={m.login_sketch_analytics()}
          labelLogs={m.login_sketch_logs()}
        />
        <figcaption class="sr-only">{m.login_preview_caption()}</figcaption>
      </figure>
    </div>

    <p class="text-xs text-on-surface-variant">
      {brandingStore.brandName} &copy; {year}
    </p>
  </aside>

  <!-- Panneau de connexion -->
  <main class="flex flex-col min-h-screen lg:min-h-0 lg:overflow-y-auto px-4 sm:px-8 py-6 lg:py-10">

    <!-- Le panneau de gauche porte deja la marque : ce rappel ne sert qu'au mobile. -->
    <div class="flex items-center gap-2.5 lg:hidden">
      <img src={brandingStore.logoUrl || '/favicon.svg'} alt="" class="w-7 h-7 rounded-xl" />
      <span class="font-headline text-xl font-bold tracking-tight leading-none">{brandingStore.brandName}</span>
    </div>

    <div class="grow flex items-center justify-center py-10">
      <div class="w-full max-w-sm">

        <div class="admin-surface p-7 sm:p-8">
          <img
            src={brandingStore.logoUrl || '/favicon.svg'}
            alt="{brandingStore.brandName} logo"
            class="w-14 h-14 rounded-2xl mb-6"
          />

          <h1 class="font-headline text-2xl font-bold tracking-tight mb-1.5">{m.login_title()}</h1>
          <p class="text-sm text-on-surface-variant leading-relaxed mb-7">
            {m.login_subtitle()}
          </p>

          {#if errorMessage}
            <div role="alert" class="mb-5 px-4 py-3.5 rounded-2xl bg-error/10 border border-error/20">
              <div class="flex items-start gap-2.5">
                <Papicon icon="warning" size={16} class="text-error shrink-0 mt-0.5" />
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-error">{m.login_error_heading()}</p>
                  <p class="mt-1 text-xs text-error/90 wrap-break-word">{errorMessage}</p>
                  <button
                    type="button"
                    onclick={retryConfig}
                    disabled={isRetrying}
                    class="admin-press mt-2.5 h-8 px-3.5 rounded-full bg-error/15 text-xs font-semibold text-error hover:bg-error/25 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-error"
                  >
                    {m.login_retry()}
                  </button>
                </div>
              </div>
            </div>
          {/if}

          <button
            type="button"
            onclick={loginWithDiscord}
            disabled={isRedirecting}
            aria-busy={isRedirecting}
            class="admin-press w-full h-12 flex items-center justify-center gap-2.5 px-5 rounded-full bg-primary text-on-primary font-semibold text-sm shadow-sm hover:brightness-110 disabled:cursor-wait disabled:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {#if isRedirecting}
              <span class="spinner" aria-hidden="true"></span>
              {m.login_redirecting()}
            {:else}
              <Papicon icon="discord" size={18} />
              {m.login_with_discord()}
            {/if}
          </button>

          <div class="mt-5">
            <PrivacyNotice compact text={m.login_privacy_notice()} />
          </div>
        </div>

        <!--
          Visible tant que le croquis est masque, puis reservee au lecteur
          d'ecran : au-dela de `lg` le panneau de gauche dit deja tout cela.
        -->
        <ul class="mt-6 lg:sr-only flex flex-wrap gap-2">
          {#each highlights as highlight (highlight.label)}
            <li class="flex items-center gap-2 h-9 px-3.5 rounded-full bg-surface border border-on-surface/8 text-sm text-on-surface-variant">
              <Papicon icon={highlight.icon} size={15} class="text-primary shrink-0" />
              {highlight.label}
            </li>
          {/each}
        </ul>

        <p class="mt-8 text-center text-xs text-on-surface-variant lg:hidden">
          {brandingStore.brandName} &copy; {year}
        </p>
      </div>
    </div>
  </main>
</div>

<style>
  /* Meme carte flottante que la barre laterale de la console admin. */
  .showcase {
    background: var(--admin-sidebar);
    border: 1px solid var(--admin-line);
    border-radius: 31px;
    box-shadow: var(--admin-sidebar-shadow);
    max-height: calc(100vh - 1.5rem);
    overflow: hidden;
  }

  .sketch-frame {
    background: var(--surface);
    border: 1px solid var(--admin-line);
    border-radius: 24px;
    box-shadow: var(--admin-shadow);
  }

  /* Le mot reste lisible sous le trait, c'est tout l'effet. */
  .struck {
    color: var(--on-surface-variant);
    opacity: 0.6;
    text-decoration-color: var(--primary-color);
    text-decoration-thickness: 0.09em;
  }

  .spinner {
    width: 15px;
    height: 15px;
    border-radius: 9999px;
    border: 2px solid color-mix(in srgb, var(--color-on-primary) 35%, transparent);
    border-top-color: var(--color-on-primary);
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
  }
</style>
