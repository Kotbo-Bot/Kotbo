<script lang="ts">
  import Papicon from './Papicon.svelte';
  
  let { value = $bindable('#5865F2') }: { value: string } = $props();

  let showModal = $state(false);
  // Repose sur openPicker() pour la valeur reelle : lire la prop ici n'en
  // capturerait que l'etat au montage, alors que la modale ouvre bien plus tard.
  let tempValue = $state('#5865F2');

  // A nice palette of standard Discord / modern UI colors
  const presetColors = [
    '#5865F2', // Blurple
    '#57F287', // Green
    '#FEE75C', // Yellow
    '#EB459E', // Fuchsia
    '#ED4245', // Red
    '#1ABC9C', // Aqua
    '#3498DB', // Blue
    '#9B59B6', // Purple
    '#E67E22', // Orange
    '#95A5A6', // Gray
    '#2C3E50', // Navy
    '#FFFFFF', // White
  ];

  function openPicker() {
    tempValue = value || '#5865F2';
    showModal = true;
  }

  function saveColor() {
    // Ensure hex hash is present
    if (tempValue && !tempValue.startsWith('#')) {
      tempValue = '#' + tempValue;
    }
    value = tempValue;
    showModal = false;
  }

  // Validate hex format dynamically
  function getPreviewColor(color: string) {
    if (!color) return 'transparent';
    const c = color.startsWith('#') ? color : '#' + color;
    return /^#([0-9A-F]{3}){1,2}$/i.test(c) ? c : 'transparent';
  }
</script>

<button 
  onclick={openPicker}
  class="w-full flex items-center justify-between bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all hover:bg-surface-container-high/60 group"
>
  <div class="flex items-center gap-3">
    <div 
      class="w-6 h-6 rounded-full border border-white/20 shadow-inner transition-transform" 
      style="background-color: {getPreviewColor(value)};"
    ></div>
    <span class="font-mono font-bold text-on-surface uppercase tracking-wider">{value || 'Aucune'}</span>
  </div>
  <Papicon icon="chevron-down" size={16} class="text-on-surface-variant" />
</button>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if showModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/40" onclick={() => showModal = false}>
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-sm shadow-sm p-8 animate-in zoom-in-95 duration-300" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center gap-3 mb-6">
        <Papicon icon="palette" size={28} class="text-primary" />
        <h3 class="text-xl font-semibold text-on-surface">Choisir une couleur</h3>
      </div>

      <div class="space-y-6">
        <!-- Live Preview Block -->
        <div class="w-full h-24 rounded-lg border border-white/10 flex flex-col items-center justify-center relative overflow-hidden transition-colors" style="background-color: {getPreviewColor(tempValue)};">
          <div class="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
          <span class="relative z-10 text-white font-mono font-semibold text-lg drop-shadow-md">{tempValue}</span>
          <span class="relative z-10 text-white/80 text-xs font-semibold drop-shadow-sm">Aperçu du rendu</span>
        </div>

        <!-- Custom HEX Input -->
        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant/40 ml-1 mb-2 block">Code Hexadécimal</span>
          <div class="relative">
            <input 
              type="text" 
              bind:value={tempValue} 
              class="w-full bg-surface-container rounded-xl px-4 py-3 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm font-mono uppercase"
              placeholder="#FFFFFF"
            />
          </div>
        </label>

        <!-- Preset Palette -->
        <div>
          <span class="text-xs font-medium text-on-surface-variant/40 ml-1 mb-3 block">Couleurs recommandées</span>
          <div class="form-color-modal__palette grid grid-cols-6 gap-3">
            {#each presetColors as pc}
              <button
                onclick={() => tempValue = pc}
                class="w-10 h-10 rounded-full border-2 transition-transform active:scale-95 {tempValue?.toLowerCase() === pc.toLowerCase() ? 'border-primary shadow-sm' : 'border-transparent'}"
                style="background-color: {pc};"
                title={pc}
              ></button>
            {/each}
          </div>
        </div>

        <div class="flex gap-3 pt-4 border-t border-outline-variant/10">
          <button onclick={() => showModal = false} class="flex-1 py-3 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors text-sm text-on-surface">Annuler</button>
          <button onclick={saveColor} class="flex-1 py-3 rounded-xl font-bold bg-primary text-white active:scale-[0.98] transition-transform text-sm">Appliquer</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Six swatches per row leaves each one under a fingertip; five is the most
     that stays tappable on a 360px screen. */
  @media (max-width: 767px) {
    .form-color-modal__palette {
      gap: 0.5rem;
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }

    .form-color-modal__palette > button {
      width: 100%;
      max-width: 2.5rem;
      justify-self: center;
    }
  }
</style>
