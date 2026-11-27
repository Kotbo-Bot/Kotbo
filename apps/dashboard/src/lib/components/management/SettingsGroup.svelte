<script lang="ts">
  import type { Snippet } from 'svelte';
  import { SettingsGroup as KotboSettingsGroup } from '@kotbo/ui';

  const {
    title = '',
    description = '',
    actions,
    children,
  }: {
    title?: string;
    description?: string;
    actions?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<KotboSettingsGroup {title} {description} {actions} {children} />
