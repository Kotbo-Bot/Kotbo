<script lang="ts">
  /**
   * Chassis commun aux pages du groupe Securite.
   *
   * Les cinq pages partagent la meme mecanique : un en-tete, une barre
   * d'onglets adossee a l'URL, et parfois un second niveau. Le factoriser ici
   * evite la derive qui avait produit des barres d'onglets differentes sur
   * chaque page de securite.
   *
   * L'onglet vit dans l'URL (`/security/anti-raid/captcha`) pour que les liens
   * profonds, le bouton retour et les favoris fonctionnent.
   */
  import type { Snippet } from 'svelte';
  import { router } from 'tinro';
  import Papicon from '../Papicon.svelte';
  import { resolveTabFromUrl, gotoTab } from '../../tabRouting';
  import { navigationStore } from '../../stores/navigation.svelte';

  export type SecurityTab = {
    key: string;
    label: string;
    icon: string;
    /** Pastille de comptage (constats en attente, detections non traitees...). */
    count?: number;
    /** Onglet masque quand la fonction sous-jacente est desactivee. */
    hidden?: boolean;
  };

  type Props = {
    basePath: string;
    title: string;
    description: string;
    /** Accepte pour compatibilite ; l'en-tete n'affiche plus d'icone. */
    icon?: string;
    tabs: SecurityTab[];
    /** Rendu du contenu, l'onglet actif est passe en argument. */
    children: Snippet<[string]>;
    /** Actions libres a droite de l'en-tete. */
    actions?: Snippet;
  };

  const { basePath, title, description, tabs, children, actions }: Props = $props();

  const visibleTabs = $derived(tabs.filter((tab) => !tab.hidden));
  const defaultTab = $derived(visibleTabs[0]?.key ?? '');

  // Le chemin vient de `$router`, pas de `window.location` : c'est sa lecture
  // qui fait recalculer l'onglet a chaque navigation. Sans elle, le clic
  // changeait bien l'URL mais l'onglet affiche ne bougeait pas.
  const activeTab = $derived(
    resolveTabFromUrl(basePath, visibleTabs.map((tab) => tab.key), defaultTab, $router.path),
  );

  const readOnly = $derived(!navigationStore.canManageSecurity);
</script>

<div class="flex flex-col gap-6">
  <!-- Meme en-tete que ModulePage : un titre, une phrase, les actions. -->
  <header class="flex flex-col gap-x-6 gap-y-3 md:flex-row md:items-end md:justify-between">
    <div class="min-w-0">
      <h1 class="font-headline text-2xl font-semibold leading-tight tracking-tight text-on-surface">
        {title}
      </h1>
      <p class="mt-1 max-w-prose text-sm text-on-surface-variant">{description}</p>
    </div>

    <div class="flex items-center gap-2">
      {#if readOnly}
        <span
          class="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-2.5 py-1.5 text-2xs font-medium text-on-surface-variant"
          title="Seuls les administrateurs peuvent modifier la configuration de sécurité."
        >
          <Papicon icon="Eye" size={13} />
          Lecture seule
        </span>
      {/if}
      {#if actions}{@render actions()}{/if}
    </div>
  </header>

  {#if visibleTabs.length > 1}
    <nav class="flex flex-nowrap md:flex-wrap gap-1 overflow-x-auto [scrollbar-width:none] border-b border-outline-variant/30" aria-label={title}>
      {#each visibleTabs as tab (tab.key)}
        <button
          type="button"
          onclick={() => gotoTab(basePath, tab.key, defaultTab)}
          aria-current={activeTab === tab.key ? 'page' : undefined}
          class="
            -mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-body-sm font-medium
            transition-colors duration-150
            {activeTab === tab.key
              ? 'border-primary text-primary'
              : 'border-transparent text-on-surface-variant hover:border-outline-variant hover:text-on-surface'}
          "
        >
          <Papicon icon={tab.icon} size={15} />
          {tab.label}
          {#if tab.count !== undefined && tab.count > 0}
            <span
              class="rounded-full bg-primary/12 px-1.5 py-0.5 text-2xs font-semibold leading-none text-primary"
            >
              {tab.count > 99 ? '99+' : tab.count}
            </span>
          {/if}
        </button>
      {/each}
    </nav>
  {/if}

  <main class="flex-1">
    {@render children(activeTab)}
  </main>
</div>
