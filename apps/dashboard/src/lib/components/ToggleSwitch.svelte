<script lang="ts">
  import { ToggleSwitch as KotboToggleSwitch } from '@kotbo/ui';

  // Le composant @kotbo/ui applique flex-shrink: 0 (equivalent shrink-0) sur .kotbo-switch.
  const {
    checked = false,
    disabled = false,
    onToggle = (_v: boolean) => {},
    size = 'md',
    activeClass = '',
    id = undefined,
    ariaLabel = undefined,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onToggle?: (checked: boolean) => void;
    size?: 'sm' | 'md' | 'lg';
    activeClass?: string;
    id?: string | undefined;
    ariaLabel?: string | undefined;
  } = $props();
</script>

<KotboToggleSwitch {checked} {disabled} {onToggle} {size} {activeClass} {id} {ariaLabel} />
