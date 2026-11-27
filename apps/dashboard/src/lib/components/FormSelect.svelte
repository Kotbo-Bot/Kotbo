<script lang="ts">
  import type { Snippet } from 'svelte';
  import { FormSelect as KotboFormSelect } from '@kotbo/ui';

  type SelectValue = string | string[];

  let {
    id = '',
    ariaLabel,
    describedBy = undefined,
    'aria-describedby': ariaDescribedBy = undefined,
    value = $bindable<SelectValue>(),
    multiple = false,
    disabled = false,
    className = '',
    onchange,
    children,
  }: {
    id?: string;
    ariaLabel?: string;
    describedBy?: string | undefined;
    'aria-describedby'?: string | undefined;
    value?: SelectValue;
    multiple?: boolean;
    disabled?: boolean;
    className?: string;
    onchange?: (event: Event) => void;
    children?: Snippet;
  } = $props();
</script>

<KotboFormSelect
  {id}
  {ariaLabel}
  {describedBy}
  aria-describedby={ariaDescribedBy}
  bind:value
  {multiple}
  {disabled}
  {className}
  {onchange}
  {children}
/>
