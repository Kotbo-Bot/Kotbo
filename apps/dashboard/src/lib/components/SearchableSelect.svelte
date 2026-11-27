<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { SearchableSelect as KotboSearchableSelect, type SearchableOption } from '@kotbo/ui';

  let {
    id = '',
    describedBy = undefined,
    value = $bindable<string | null>(null),
    options = [],
    placeholder = '',
    className = '',
    clearable = true,
    disabled = false,
    showId = true,
    onCreate = null,
    onchange,
    oninput,
  }: {
    id?: string;
    describedBy?: string | undefined;
    value?: string | null;
    options?: SearchableOption[];
    placeholder?: string;
    className?: string;
    clearable?: boolean;
    disabled?: boolean;
    showId?: boolean;
    onCreate?: ((name: string) => Promise<{ id: string; name: string } | null>) | null;
    onchange?: (value: string | null) => void;
    oninput?: (value: string | null) => void;
  } = $props();

  const dispatch = createEventDispatcher<{ change: { value: string | null }; input: { value: string | null } }>();

  function handleChange(next: string | null) {
    onchange?.(next);
    dispatch('change', { value: next });
  }

  function handleInput(next: string | null) {
    oninput?.(next);
    dispatch('input', { value: next });
  }
</script>

<KotboSearchableSelect
  {id}
  {describedBy}
  bind:value
  {options}
  {placeholder}
  {className}
  {clearable}
  {disabled}
  {showId}
  {onCreate}
  onchange={handleChange}
  oninput={handleInput}
/>
