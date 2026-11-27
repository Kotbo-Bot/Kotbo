<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Field as KotboField } from '@kotbo/ui';

  const {
    label,
    hint = '',
    error = '',
    required = false,
    id = undefined,
    class: className = '',
    children,
  }: {
    label: string;
    hint?: string;
    error?: string;
    required?: boolean;
    id?: string;
    class?: string;
    children: Snippet<[string, string | undefined]>;
  } = $props();
</script>

<KotboField {label} {hint} {error} {required} {id} class={className} {children} />
