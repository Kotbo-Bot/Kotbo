<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Papicon from './Papicon.svelte';

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
    icon?: string;
    required?: boolean;
    oninput?: (event: Event) => void;
    onchange?: (event: Event) => void;
  } = $props();
</script>

{#if label}
  <label for={id} class="flex min-w-0 flex-col gap-1.5">
    <span class="flex items-center gap-1.5 text-xs font-medium text-on-surface-variant">
      {#if icon}<Papicon {icon} size={13} />{/if}
      {label}{#if required}<span aria-hidden="true">*</span>{/if}
    </span>
    <input
      {id}
      {type}
      bind:value
      {placeholder}
      {disabled}
      {readonly}
      {required}
      {autocomplete}
      oninput={oninput}
      onchange={onchange}
      class="input {className}"
    />
  </label>
{:else}
  <input
    {id}
    {type}
    bind:value
    {placeholder}
    {disabled}
    {readonly}
    {required}
    {autocomplete}
    oninput={oninput}
    onchange={onchange}
    class="input {className}"
  />
{/if}
