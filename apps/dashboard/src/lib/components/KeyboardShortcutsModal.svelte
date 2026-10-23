<script lang="ts">
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';

  interface Shortcut {
    keys: string[];
    description: string;
    category: 'nav' | 'system';
  }

  const shortcuts: Shortcut[] = [
    { keys: ['G', 'D', 'ou', 'Ctrl', 'Shift', 'D'], description: m.ksm_sc_dashboard(), category: 'nav' },
    { keys: ['G', 'M', 'ou', 'Ctrl', 'Shift', 'M'], description: m.ksm_sc_members(), category: 'nav' },
    { keys: ['G', 'C', 'ou', 'Ctrl', 'Shift', 'C'], description: m.ksm_sc_config(), category: 'nav' },
    { keys: ['G', 'L', 'ou', 'Ctrl', 'Shift', 'L'], description: m.ksm_sc_logs(), category: 'nav' },
    { keys: ['/'], description: m.ksm_sc_search(), category: 'nav' },
    { keys: ['Ctrl', 'K'], description: m.ksm_sc_search_palette(), category: 'nav' },
    { keys: ['Ctrl', 'G'], description: m.ksm_sc_server_switch(), category: 'nav' },
    { keys: ['Ctrl', 'Shift', 'N'], description: m.ksm_sc_open_menu(), category: 'system' },
  ];

  const categories: { id: 'nav' | 'system'; label: string }[] = [
    { id: 'nav', label: m.ksm_cat_navigation() },
    { id: 'system', label: m.ksm_cat_system() },
  ];

  const { isOpen = false, onClose = () => {} }: { isOpen?: boolean; onClose?: () => void } = $props();

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
    }
  }
</script>

{#if isOpen}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="keyboard-shortcuts-title"
    class="keyboard-shortcuts-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onclick={handleBackdropClick}
    onkeydown={handleKeyDown}
    tabindex="-1"
  >
    <div class="keyboard-shortcuts-modal__panel bg-surface-container-low border border-outline-variant/20 rounded-xl shadow-sm max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
      <!-- Header -->
      <div class="flex items-center justify-between p-6 border-b border-outline-variant/10">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Papicon icon="Keyboard" size={20} class="text-primary" />
          </div>
          <div>
            <h2 id="keyboard-shortcuts-title" class="text-xl font-semibold">{m.ksm_title()}</h2>
            <p class="text-sm text-on-surface-variant">{m.ksm_subtitle()}</p>
          </div>
        </div>
        <button
          onclick={onClose}
          aria-label={m.common_close()}
          class="w-8 h-8 rounded-lg bg-surface-container-high/20 hover:bg-surface-container-high/40 flex items-center justify-center transition-colors"
        >
          <Papicon icon="X" size={18} class="text-on-surface-variant" />
        </button>
      </div>

      <!-- Content -->
      <div class="p-6 overflow-y-auto max-h-[60vh]">
        {#each categories as cat}
          <div class="mb-6 last:mb-0">
            <h3 class="text-xs font-semibold text-on-surface-variant mb-3">{cat.label}</h3>
            <div class="space-y-2">
              {#each shortcuts.filter(s => s.category === cat.id) as shortcut}
                <div class="keyboard-shortcuts-modal__row flex items-center justify-between gap-3 p-3 rounded-xl bg-surface-container-high/10 hover:bg-surface-container-high/20 transition-colors">
                  <p class="text-sm font-medium text-on-surface">{shortcut.description}</p>
                  <div class="keyboard-shortcuts-modal__keys flex items-center gap-1">
                    {#each shortcut.keys as key}
                      {#if key === 'ou'}
                        <span class="text-xs font-bold text-on-surface-variant mx-1">{m.ksm_or()}</span>
                      {:else}
                        <kbd class="px-2 py-1 rounded-lg bg-surface-container-high border border-outline-variant/20 text-xs font-bold text-on-surface-variant shadow-sm">
                          {key}
                        </kbd>
                      {/if}
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>

      <!-- Footer -->
      <div class="p-4 border-t border-outline-variant/10 bg-surface-container-high/10">
        <p class="text-xs text-center text-on-surface-variant">
          {m.ksm_footer_before()} <kbd class="px-1.5 py-0.5 rounded bg-surface-container-high border border-outline-variant/20 text-xs font-bold">Escape</kbd> {m.ksm_footer_after()}
        </p>
      </div>
    </div>
  </div>
{/if}
