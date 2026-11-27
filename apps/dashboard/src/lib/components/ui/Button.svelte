<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { Button as KotboButton } from '@kotbo/ui';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

  // svelte-ignore custom_element_props_identifier
  const {
    variant = 'secondary',
    size = 'md',
    icon = '',
    iconRight = '',
    loading = false,
    fullWidth = false,
    href = undefined,
    target = undefined,
    type = 'button',
    disabled = false,
    disabledReason = '',
    class: className = '',
    children,
    onclick,
    ...rest
  }: {
    variant?: Variant;
    size?: 'sm' | 'md';
    icon?: string;
    iconRight?: string;
    loading?: boolean;
    fullWidth?: boolean;
    href?: string;
    target?: string;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    disabledReason?: string;
    class?: string;
    children?: Snippet;
  } & Omit<HTMLButtonAttributes, 'type' | 'disabled' | 'class'> = $props();
</script>

<KotboButton
  {variant}
  {size}
  {icon}
  {iconRight}
  {loading}
  {fullWidth}
  {href}
  {target}
  {type}
  {disabled}
  {disabledReason}
  class={className}
  {onclick}
  {...rest}
>
  {@render children?.()}
</KotboButton>
