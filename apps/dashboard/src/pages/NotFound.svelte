<script lang="ts">
  import { router } from 'tinro';
  import Papicon from '../lib/components/Papicon.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { searchStore } from '../lib/stores/search.svelte';
  import { feedbackModal } from '../lib/stores/feedbackModal.svelte';
  import { m } from '../lib/i18n';

  /**
   * Une page introuvable guide au lieu de s'excuser : on propose de chercher
   * la bonne page, de revenir a l'accueil, et de signaler le lien casse. Les
   * deux premieres demandent une session ; un visiteur anonyme garde l'accueil.
   */
  const signedIn = $derived(authStore.isAuthenticated);
</script>

<div class="min-h-screen flex flex-col items-center justify-center p-6 text-center">
  <div class="mb-8 p-6 rounded-full bg-surface-variant/20">
    <Papicon name="warning" size={64} class="text-primary" />
  </div>

  <h1 class="text-lg font-bold mb-4">{m.nf_title()}</h1>
  <p class="text-on-surface-variant mb-8 max-w-md">
    {m.nf_desc()}
  </p>

  <div class="flex flex-wrap items-center justify-center gap-2">
    {#if signedIn}
      <Button variant="primary" icon="Search" onclick={() => (searchStore.open = true)}>{m.nf_search()}</Button>
      <Button variant="secondary" icon="home" onclick={() => router.goto('/')}>{m.nf_back_home()}</Button>
    {:else}
      <Button variant="primary" icon="home" onclick={() => router.goto('/')}>{m.nf_back_home()}</Button>
    {/if}
  </div>

  {#if signedIn}
    <button
      type="button"
      class="mt-6 text-sm text-on-surface-variant underline-offset-2 hover:text-on-surface hover:underline"
      onclick={() => feedbackModal.show()}
    >
      {m.nf_report_link()}
    </button>
  {/if}
</div>
