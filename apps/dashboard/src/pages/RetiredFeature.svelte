<script lang="ts">
  import { router } from 'tinro';
  import Papicon from '../lib/components/Papicon.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import { m } from '../lib/i18n';

  /**
   * Adresse d'une fonctionnalité retirée en v10.0 (Partenariats, Daily Algo) :
   * un ancien lien ou un favori dit ce qui s'est passé au lieu d'une 404.
   */
  let { feature }: { feature: 'partnerships' | 'daily_algo' } = $props();
  const name = $derived(feature === 'partnerships' ? m.retired_partnerships() : m.retired_daily_algo());
</script>

<div class="min-h-[60vh] flex flex-col items-center justify-center p-6 text-center">
  <div class="mb-6 p-5 rounded-full bg-surface-variant/20">
    <Papicon name="warning" size={48} class="text-on-surface-variant" />
  </div>
  <h1 class="text-lg font-bold mb-3">{m.retired_title({ feature: name })}</h1>
  <p class="text-on-surface-variant mb-6 max-w-md">{m.retired_desc()}</p>
  <Button variant="secondary" icon="home" onclick={() => router.goto('/')}>{m.nf_back_home()}</Button>
</div>
