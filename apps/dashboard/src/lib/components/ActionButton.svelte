<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ActionButton as KotboActionButton } from '@kotbo/ui';

  type ButtonVariant = 'primary' | 'success' | 'muted' | 'danger' | 'neutral' | 'warning';
  type ButtonSize = 'sm' | 'md' | 'lg';

  const {
    onClick,
    onclick,
    type = 'button',
    variant = 'neutral',
    size = 'md',
    fullWidth = false,
    disabled = false,
    title = '',
    icon = '',
    label,
    className = '',
    children,
  }: {
    onClick?: (event: MouseEvent) => void;
    onclick?: (event: MouseEvent) => void;
    type?: 'button' | 'submit' | 'reset';
    variant?: ButtonVariant;
    size?: ButtonSize;
    fullWidth?: boolean;
    disabled?: boolean;
    title?: string;
    icon?: string;
    label: string;
    className?: string;
    children?: Snippet;
  } = $props();
</script>

<KotboActionButton
  {onClick}
  {onclick}
  {type}
  {variant}
  {size}
  {fullWidth}
  {disabled}
  {title}
  {icon}
  {label}
  {className}
  {children}
/>
