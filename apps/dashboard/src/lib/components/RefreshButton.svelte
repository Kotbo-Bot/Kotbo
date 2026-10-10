<script lang="ts">
  import { m } from '../i18n';

  const {
    onClick,
    onclick,
    loading = false,
    label = m.d6_refresh(),
    iconOnly = false,
    ariaLabel = m.d6_refresh(),
    className = '',
    iconClass = 'text-sm'
  }: {
    onClick?: (event: MouseEvent) => void | Promise<void>;
    onclick?: (event: MouseEvent) => void | Promise<void>;
    loading?: boolean;
    label?: string;
    iconOnly?: boolean;
    ariaLabel?: string;
    className?: string;
    iconClass?: string;
  } = $props();

  import Papicon from './Papicon.svelte';

  /**
   * Les donnees se rechargent seules (temps reel, retour sur la page) :
   * actualiser est un recours, pas l'action principale. Le bouton plein,
   * couleur primaire, etait le plus visible de vingt pages ; il devient une
   * icone discrete. `iconOnly` reste accepte, `label` sert d'infobulle.
   */
  function getBaseClass() {
    return 'inline-flex items-center justify-center w-9 h-9 shrink-0 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors';
  }
</script>

<button
  type="button"
  onclick={onClick ?? onclick}
  aria-label={ariaLabel}
  aria-busy={loading}
  title={label}
  class="{getBaseClass()} {iconOnly ? className : ''}"
>
  <Papicon 
    icon="refresh-cw" 
    size={16}
    class="{iconClass} {loading ? 'animate-spin' : ''}"
  />
</button>
