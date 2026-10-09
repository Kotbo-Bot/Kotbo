<script lang="ts">
  import { DEMO_MODE, DEMO_INVITE_URL } from '../demo/mode';
  import { demoDb } from '../demo/db';
  import { demoTour } from '../demo/tour.svelte';
  import { m } from '../i18n';

  let dismissed = $state(false);

  function handleReset() {
    if (confirm('Remettre la démo dans son état d\'origine ? Tes changements seront perdus.')) {
      demoDb.reset();
      window.location.reload();
    }
  }
</script>

{#if DEMO_MODE && !dismissed}
  <div data-tour="demo-banner" class="relative z-20 mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-primary/8 px-4 py-2.5 text-sm">
    <p class="min-w-0 flex-1 text-on-surface">
      <span class="font-semibold">Démo</span>
      <span class="text-on-surface-variant"> · Un serveur fictif pour tout essayer. Tes changements restent sur cet appareil.</span>
    </p>

    <div class="flex items-center gap-1 shrink-0">
      <button
        type="button"
        onclick={() => demoTour.start()}
        class="px-2.5 py-1 rounded-md text-xs font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
      >
        {m.demo_tour_restart()}
      </button>
      <button
        type="button"
        onclick={handleReset}
        class="px-2.5 py-1 rounded-md text-xs font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
        title="Remet la démo dans son état d'origine"
      >
        Tout remettre à zéro
      </button>
      <a
        href={DEMO_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="ml-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-opacity"
      >
        Ajouter Kotbo à mon serveur
      </a>
      <button
        type="button"
        onclick={() => (dismissed = true)}
        class="p-1.5 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
        aria-label="Masquer ce bandeau"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  </div>
{/if}
