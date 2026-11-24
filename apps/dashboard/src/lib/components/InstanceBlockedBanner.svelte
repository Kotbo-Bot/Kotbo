<script lang="ts">
  /**
   * Bandeau d'instance bloquée : l'API refuse tout tant que l'administration
   * Kotbo n'a pas autorisé cette instance. Il nomme la cause une fois, au lieu
   * de laisser chaque page échouer de son côté.
   */
  import { instanceBlock } from '../stores/instanceBlock.svelte';
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';
</script>

{#if instanceBlock.current}
  <div
    role="alert"
    aria-live="assertive"
    class="sticky top-0 z-[9000] flex flex-wrap items-center gap-3 border-b border-error/30 bg-red-950/90 px-4 py-3 text-sm backdrop-blur"
  >
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-error/15 text-red-300">
      <Papicon icon="Lock" size={18} />
    </span>
    <div class="min-w-0 flex-1">
      <p class="font-semibold text-red-100">{m.instance_blocked_title()}</p>
      <p class="text-red-200/80">{m.instance_blocked_desc()}</p>
      {#if instanceBlock.current.reason}
        <p class="text-red-200/80">{m.instance_blocked_reason({ reason: instanceBlock.current.reason })}</p>
      {/if}
    </div>
  </div>
{/if}
