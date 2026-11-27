<script lang="ts">
  import type { Snippet } from 'svelte';
  import { SectionCard as KotboSectionCard } from '@kotbo/ui';

  const {
    title = '',
    description = '',
    icon = '',
    flush = false,
    actions,
    children,
  }: {
    title?: string;
    description?: string;
    icon?: string;
    flush?: boolean;
    actions?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<KotboSectionCard {title} {description} {icon} {flush} {actions} {children} />
