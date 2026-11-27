<script lang="ts">
  import { dialogFocus } from '../actions/dialogFocus';
  import { portal } from '../actions/portal';
  import { fade, scale } from 'svelte/transition';
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';

  interface Shortcut {
    keys: string[];
    description: string;
    category: 'nav' | 'system';
  }

  const shortcuts: Shortcut[] = [
    { keys: ['G', 'D', 'ou', 'Ctrl', 'Shift', 'D'], get description() { return m.ksm_sc_dashboard(); }, category: 'nav' },
    { keys: ['G', 'M', 'ou', 'Ctrl', 'Shift', 'M'], get description() { return m.ksm_sc_members(); }, category: 'nav' },
    { keys: ['G', 'C', 'ou', 'Ctrl', 'Shift', 'C'], get description() { return m.ksm_sc_config(); }, category: 'nav' },
    { keys: ['G', 'L', 'ou', 'Ctrl', 'Shift', 'L'], get description() { return m.ksm_sc_logs(); }, category: 'nav' },
    { keys: ['/'], get description() { return m.ksm_sc_search(); }, category: 'nav' },
    { keys: ['Ctrl', 'K'], get description() { return m.ksm_sc_search_palette(); }, category: 'nav' },
    { keys: ['Ctrl', 'G'], get description() { return m.ksm_sc_server_switch(); }, category: 'nav' },
    { keys: ['Ctrl', 'Shift', 'N'], get description() { return m.ksm_sc_open_menu(); }, category: 'system' },
  ];

  const categories: { id: 'nav' | 'system'; label: string }[] = [
    { id: 'nav', get label() { return m.ksm_cat_navigation(); } },
    { id: 'system', get label() { return m.ksm_cat_system(); } },
  ];

  const { isOpen = false, onClose = () => {} }: { isOpen?: boolean; onClose?: () => void } = $props();

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
    }
  }
</script>

{#if isOpen}
  <div
    use:portal
    use:dialogFocus={{}}
    role="dialog"
    aria-modal="true"
    aria-labelledby="keyboard-shortcuts-title"
    class="keyboard-shortcuts-modal layer-command fixed inset-0 flex items-center justify-center px-4"
    onkeydown={handleKeyDown}
    tabindex="-1"
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/40 border-none cursor-default w-full h-full text-left p-0"
      onclick={onClose}
      aria-label={m.common_close()}
      transition:fade={{ duration: 100 }}
    ></button>

    <div
      class="keyboard-shortcuts-modal__panel tafac-panel relative z-10 max-w-2xl w-full max-h-[82vh] flex flex-col overflow-hidden"
      role="document"
      transition:scale={{ start: 0.98, duration: 150 }}
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-primary/12 text-primary flex items-center justify-center shrink-0">
            <Papicon icon="Keyboard" size={20} />
          </div>
          <div>
            <h2 id="keyboard-shortcuts-title" class="text-lg font-semibold font-headline text-on-surface leading-tight">{m.ksm_title()}</h2>
            <p class="text-xs text-on-surface-variant mt-0.5">{m.ksm_subtitle()}</p>
          </div>
        </div>
        <button
          type="button"
          onclick={onClose}
          aria-label={m.common_close()}
          class="btn btn-ghost btn-icon text-on-surface-variant"
        >
          <Papicon icon="X" size={18} />
        </button>
      </div>

      <!-- Content -->
      <div class="p-6 overflow-y-auto flex-1 space-y-6">
        {#each categories as cat}
          <div>
            <h3 class="text-xs font-semibold text-on-surface-variant mb-2.5">{cat.label}</h3>
            <div class="space-y-1.5">
              {#each shortcuts.filter(s => s.category === cat.id) as shortcut}
                <div class="keyboard-shortcuts-modal__row flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-surface-container-low hover:bg-surface-container transition-colors">
                  <p class="text-sm font-medium text-on-surface">{shortcut.description}</p>
                  <div class="keyboard-shortcuts-modal__keys flex items-center gap-1 shrink-0 flex-wrap justify-end">
                    {#each shortcut.keys as key}
                      {#if key === 'ou'}
                        <span class="text-xs font-medium text-on-surface-variant px-1">{m.ksm_or()}</span>
                      {:else}
                        <kbd class="kbd-key">
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
      <div class="px-6 py-3 border-t border-outline-variant bg-surface-container-low shrink-0">
        <p class="text-xs text-center text-on-surface-variant flex items-center justify-center gap-1.5">
          <span>{m.ksm_footer_before()}</span>
          <kbd class="kbd-key">Esc</kbd>
          <span>{m.ksm_footer_after()}</span>
        </p>
      </div>
    </div>
  </div>
{/if}
