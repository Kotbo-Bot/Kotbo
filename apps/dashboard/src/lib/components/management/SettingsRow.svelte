<script lang="ts">
  import type { Snippet } from 'svelte';
  import { SettingsRow as KotboSettingsRow } from '@kotbo/ui';

  const {
    label = '',
    description = '',
    labelFor = undefined,
    stacked = false,
    children,
  }: {
    label?: string;
    description?: string;
    labelFor?: string | undefined;
    stacked?: boolean;
    children?: Snippet;
  } = $props();
</script>

<KotboSettingsRow {label} {description} {labelFor} {stacked} {children} />
