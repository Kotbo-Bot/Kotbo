<script lang="ts">
  import { RefreshButton as KotboRefreshButton } from '@kotbo/ui';

  const {
    onClick,
    onclick,
    loading = false,
    label,
    iconOnly = false,
    ariaLabel,
    className = '',
    iconClass = 'text-sm',
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
</script>

<KotboRefreshButton {onClick} {onclick} {loading} {label} {iconOnly} {ariaLabel} {className} {iconClass} />
