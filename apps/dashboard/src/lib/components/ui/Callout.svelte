<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Callout as KotboCallout } from '@kotbo/ui';

  type Variant = 'info' | 'success' | 'warning' | 'danger';

  const {
    variant = 'info',
    title = '',
    icon = '',
    class: className = '',
    children,
    actions,
  }: {
    variant?: Variant;
    title?: string;
    icon?: string;
    class?: string;
    children?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<KotboCallout {variant} {title} {icon} class={className} {actions}>
  {@render children?.()}
</KotboCallout>
