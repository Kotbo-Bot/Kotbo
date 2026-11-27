<script lang="ts">
  import type { Snippet } from 'svelte';
  import { EmptyState as KotboEmptyState } from '@kotbo/ui';

  const {
    icon = 'inbox',
    title,
    description = '',
    action,
    actionLabel = '',
    actionHref = undefined,
    actionIcon = 'plus',
    onAction = undefined,
    reason = undefined,
  }: {
    icon?: string;
    title?: string;
    description?: string;
    action?: Snippet;
    actionLabel?: string;
    actionHref?: string;
    actionIcon?: string;
    onAction?: () => void;
    reason?: 'all-clear' | 'accumulating' | 'nothing-matches' | 'read-only' | 'instruction';
  } = $props();
</script>

<KotboEmptyState
  {icon}
  {title}
  {description}
  {action}
  {actionLabel}
  {actionHref}
  {actionIcon}
  {onAction}
  {reason}
/>
