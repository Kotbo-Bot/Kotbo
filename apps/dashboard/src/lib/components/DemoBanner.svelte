<script lang="ts">
  import { DEMO_MODE, DEMO_INVITE_URL } from '../demo/mode';
  import { demoDb } from '../demo/db';
  import { demoTour } from '../demo/tour.svelte';
  import { m } from '../i18n';

  let dismissed = $state(false);

  function handleReset() {
    if (confirm(m.dbx_reset_confirm())) {
      demoDb.reset();
      window.location.reload();
    }
  }
</script>

{#if DEMO_MODE && !dismissed}
  <div data-tour="demo-banner" class="section-card relative z-20 mb-5 px-4 py-2.5 text-on-surface">
    <div class="flex items-center justify-between gap-3 text-xs">
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <span class="px-2.5 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-semibold shrink-0">
          {m.demo_mode()}
        </span>
        <span class="text-on-surface-variant hidden md:block truncate">{m.demo_description()}</span>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onclick={() => demoTour.start()}
          class="btn btn-ghost btn-sm"
        >
          {m.demo_tour_restart()}
        </button>

        <button
          type="button"
          onclick={handleReset}
          class="btn btn-ghost btn-sm"
          title={m.demo_reset_title()}
        >
          {m.demo_reset()}
        </button>

        <a
          href={DEMO_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-primary btn-sm"
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
          class="btn btn-ghost btn-sm btn-icon"
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
