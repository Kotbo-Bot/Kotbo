<script lang="ts">
  import { Modal as KotboModal } from '@kotbo/ui';

  let {
    open = $bindable(false),
    onClose = () => {},
    title = '',
    ariaLabel = '',
    subtitle = '',
    size = 'md',
    showCloseButton = true,
    closeOnBackdropClick = true,
    closeOnEscape = true,
    aboveCase = false,
    flush = false,
    children,
    footer,
  } = $props<{
    open?: boolean;
    onClose?: (e?: unknown) => void;
    title?: string;
    ariaLabel?: string;
    subtitle?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'screen';
    showCloseButton?: boolean;
    closeOnBackdropClick?: boolean;
    closeOnEscape?: boolean;
    aboveCase?: boolean;
    flush?: boolean;
    children?: any;
    footer?: any;
  }>();
</script>

<KotboModal
  bind:open
  {onClose}
  {title}
  {ariaLabel}
  {subtitle}
  {size}
  {showCloseButton}
  {closeOnBackdropClick}
  {closeOnEscape}
  {aboveCase}
  {flush}
  {children}
  {footer}
/>
