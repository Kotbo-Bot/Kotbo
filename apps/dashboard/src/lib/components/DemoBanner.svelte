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
  <div data-tour="demo-banner" class="relative z-20 mb-6 rounded-xl bg-surface-container-low border border-primary/30 text-on-surface p-3 sm:px-4 sm:py-3 shadow-sm transition-all">
    <div class="flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm">
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="inline-flex items-center justify-center w-6 h-6 rounded-md bg-primary/20 text-primary shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
        </span>
        <div class="min-w-0">
          <span class="font-semibold text-primary">{m.demo_mode()}</span>
          <span class="text-on-surface-variant hidden md:inline">{m.demo_description()}</span>
        </div>
      </div>

      <div class="flex items-center gap-2 shrink-0 ml-auto">
        <button
          type="button"
          onclick={() => demoTour.start()}
          class="px-2.5 py-1 rounded-md text-xs font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors cursor-pointer"
        >
          {m.demo_tour_restart()}
        </button>

        <button
          type="button"
          onclick={handleReset}
          class="px-2.5 py-1 rounded-md text-xs font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors cursor-pointer"
          title={m.demo_reset_title()}
        >
          {m.demo_reset()}
        </button>

        <a
          href={DEMO_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-opacity shadow-xs"
        >
          <span>{m.demo_add_kotbo()}</span>
          <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>

        <button
          type="button"
          onclick={() => (dismissed = true)}
          class="p-1 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors cursor-pointer"
          aria-label="{m.demo_dismiss()}"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  </div>
{/if}
