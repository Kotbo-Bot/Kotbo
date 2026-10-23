<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import { m } from '../../i18n';

  const { onExportCSV, onExportXLSX, onExportImage } = $props<{
    onExportCSV?: () => void;
    onExportXLSX?: () => void;
    onExportImage?: () => void;
  }>();

  let open = $state(false);

  function handleAction(fn?: () => void) {
    fn?.();
    open = false;
  }
</script>

<div class="relative">
  <button
    onclick={() => open = !open}
    class="p-2 rounded-lg bg-surface-container-high/40 hover:bg-surface-container-high border border-outline-variant/10 text-on-surface-variant hover:text-on-surface transition-all"
    title={m.an_export_button()}
  >
    <Papicon icon="DownloadSimple" size={16} />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-40" onclick={() => open = false} onkeydown={() => {}}></div>
    <div class="absolute right-0 top-full mt-1 z-50 bg-surface-container border border-outline-variant/15 rounded-xl shadow-xl shadow-surface/40 overflow-hidden min-w-[160px] animate-in fade-in zoom-in-95 duration-150">
      {#if onExportCSV}
        <button
          onclick={() => handleAction(onExportCSV)}
          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-on-surface-variant hover:bg-primary/10 hover:text-primary transition-colors"
        >
          <Papicon icon="Table" size={14} />
          {m.an_export_csv()}
        </button>
      {/if}
      {#if onExportXLSX}
        <button
          onclick={() => handleAction(onExportXLSX)}
          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-on-surface-variant hover:bg-primary/10 hover:text-primary transition-colors"
        >
          <Papicon icon="FileXls" size={14} />
          {m.an_export_xlsx()}
        </button>
      {/if}
      {#if onExportImage}
        <button
          onclick={() => handleAction(onExportImage)}
          class="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-on-surface-variant hover:bg-primary/10 hover:text-primary transition-colors"
        >
          <Papicon icon="Image" size={14} />
          {m.an_export_image()}
        </button>
      {/if}
    </div>
  {/if}
</div>
