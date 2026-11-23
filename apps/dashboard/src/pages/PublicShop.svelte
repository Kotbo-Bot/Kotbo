<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { router } from 'tinro';
  import { API_BASE_URL } from '../lib/api/client';
  import { Callout, SectionCard } from '../lib/components/ui';
  import Papicon from '../lib/components/Papicon.svelte';

  const guildId = $derived($router.path.split('/').filter(Boolean)[1] ?? '');

  let loading = $state(true);
  let error = $state('');
  let shop = $state<{
    guildName: string;
    iconUrl: string | null;
    enabled: boolean;
    branding: {
      title: string;
      description: string;
      accentColor: string;
      bannerUrl: string | null;
      customCss: string;
    };
    currency: { name: string; emoji: string };
    offers: Array<{
      id: string;
      name: string;
      description: string | null;
      kind: string;
      price: number;
      durationDays: number | null;
      stock: number | null;
    }>;
  } | null>(null);

  const KIND_LABEL: Record<string, string> = {
    ROLE: 'Rôle',
    ITEM: 'Objet',
    XP: 'XP',
    SUBSCRIPTION: 'Abonnement',
    CUSTOM: 'Sur demande',
  };

  // Le CSS du serveur est posé comme texte d'un <style> : aucun HTML n'est interprété,
  // contrairement à un {@html} qu'un « </style> » déguisé pourrait refermer.
  let styleEl: HTMLStyleElement | null = null;
  $effect(() => {
    const css = shop?.branding.customCss ?? '';
    if (!css) {
      styleEl?.remove();
      styleEl = null;
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  });
  onDestroy(() => styleEl?.remove());

  onMount(async () => {
    if (!guildId) {
      error = 'Serveur introuvable';
      loading = false;
      return;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/public/shop/${encodeURIComponent(guildId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Boutique introuvable');
      shop = data;
    } catch (err: any) {
      error = err?.message || 'Impossible de charger la boutique.';
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>{shop?.branding.title || 'Boutique'}</title>
</svelte:head>

<main class="min-h-screen bg-surface text-on-surface px-4 py-10" style:--shop-accent={shop?.branding.accentColor ?? '#818cf8'}>
  <div class="max-w-4xl mx-auto space-y-6 shop-public-root">
    {#if loading}
      <div class="flex items-center justify-center py-20 text-on-surface-variant text-sm">
        <Papicon icon="loader-2" size={18} class="animate-spin mr-2" />
        Chargement de la boutique…
      </div>
    {:else if error}
      <Callout variant="danger">{error}</Callout>
    {:else if shop && !shop.enabled}
      <Callout variant="warning">La boutique web publique n'est pas activée sur ce serveur.</Callout>
    {:else if shop}
      {#if shop.branding.bannerUrl}
        <div class="h-44 rounded-2xl overflow-hidden border border-outline-variant">
          <img src={shop.branding.bannerUrl} alt="" class="w-full h-full object-cover" />
        </div>
      {/if}

      <header class="flex items-center gap-4">
        {#if shop.iconUrl}
          <img src={shop.iconUrl} alt="" class="w-12 h-12 rounded-xl object-cover border border-outline-variant" />
        {/if}
        <div>
          <h1 class="text-2xl font-semibold text-on-surface">{shop.branding.title}</h1>
          {#if shop.branding.description}
            <p class="text-sm text-on-surface-variant mt-0.5">{shop.branding.description}</p>
          {/if}
        </div>
      </header>

      {#if shop.offers.length === 0}
        <SectionCard title="Catalogue" icon="shopping-bag">
          <p class="p-6 text-sm text-on-surface-variant">Aucune offre disponible pour le moment.</p>
        </SectionCard>
      {:else}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {#each shop.offers as offer (offer.id)}
            <article class="rounded-xl border border-outline-variant bg-surface-container-low p-5 flex flex-col justify-between gap-4">
              <div>
                <div class="flex items-center justify-between gap-2 mb-2">
                  <span class="text-2xs font-semibold px-2 py-0.5 rounded-full" style="background: color-mix(in srgb, var(--shop-accent) 15%, transparent); color: var(--shop-accent);">
                    {KIND_LABEL[offer.kind] ?? offer.kind}
                  </span>
                  {#if offer.stock === 0}
                    <span class="text-2xs font-semibold text-error">Épuisé</span>
                  {:else if offer.stock !== null}
                    <span class="text-2xs text-on-surface-variant">Stock : {offer.stock}</span>
                  {/if}
                </div>
                <h2 class="text-base font-semibold text-on-surface">{offer.name}</h2>
                {#if offer.description}
                  <p class="text-xs text-on-surface-variant mt-1">{offer.description}</p>
                {/if}
              </div>

              <div class="pt-3 border-t border-outline-variant flex items-center justify-between">
                <span class="text-base font-bold text-on-surface tabular-nums">
                  {offer.price.toLocaleString('fr-FR')} {shop.currency.emoji} {shop.currency.name}
                  {#if offer.kind === 'SUBSCRIPTION'}
                    <span class="text-2xs font-normal text-on-surface-variant">/ {offer.durationDays ?? 30} j</span>
                  {/if}
                </span>
                <span class="text-2xs text-on-surface-variant">À acheter sur Discord</span>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</main>
