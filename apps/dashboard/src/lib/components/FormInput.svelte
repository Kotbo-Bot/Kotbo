<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { FormInput as KotboFormInput } from '@kotbo/ui';

  type InputValue = string | number;

  let {
    id = '',
    type = 'text',
    value = $bindable<InputValue>(''),
    placeholder = '',
    disabled = false,
    readonly = false,
    autocomplete,
    className = '',
    label = '',
    ariaLabel,
    describedBy = undefined,
    'aria-describedby': ariaDescribedBy = undefined,
    icon = '',
    required = false,
    oninput,
    onchange,
  }: {
    id?: string;
    type?: string;
    value?: InputValue;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    className?: string;
    label?: string;
    ariaLabel?: string;
    describedBy?: string | undefined;
    'aria-describedby'?: string | undefined;
    icon?: string;
    required?: boolean;
    oninput?: (event: Event) => void;
    onchange?: (event: Event) => void;
  } = $props();
</script>

<KotboFormInput
  {id}
  {type}
  bind:value
  {placeholder}
  {disabled}
  {readonly}
  {autocomplete}
  {className}
  {label}
  {ariaLabel}
  {describedBy}
  aria-describedby={ariaDescribedBy}
  {icon}
  {required}
  {oninput}
  {onchange}
/>
