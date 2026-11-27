<script lang="ts">
  import { ConfirmModal as KotboConfirmModal } from '@kotbo/ui';

  interface Props {
    open?: boolean;
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
    requireInput?: string;
    impacts?: string[];
    loading?: boolean;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
  }

  let {
    open = $bindable(false),
    title,
    description = '',
    confirmLabel,
    cancelLabel,
    variant = 'default',
    requireInput = '',
    impacts = [],
    loading = false,
    onConfirm,
    onCancel,
  }: Props = $props();
</script>

<KotboConfirmModal
  bind:open
  {title}
  {description}
  {confirmLabel}
  {cancelLabel}
  {variant}
  {requireInput}
  {impacts}
  {loading}
  {onConfirm}
  {onCancel}
/>
