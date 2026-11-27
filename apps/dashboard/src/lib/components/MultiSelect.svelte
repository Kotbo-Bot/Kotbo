<script lang="ts">
  import { MultiSelect as KotboMultiSelect } from '@kotbo/ui';

  let {
    values = $bindable<string[]>([]),
    options = [],
    placeholder = undefined,
    disabled = false,
    accentClass = 'bg-primary/20 text-primary border-primary/40',
    id = '',
    describedBy = undefined,
    onchange,
  }: {
    values?: string[];
    options?: Array<{ id: string; name: string }>;
    placeholder?: string | undefined;
    disabled?: boolean;
    accentClass?: string;
    id?: string;
    describedBy?: string | undefined;
    onchange?: (values: string[]) => void;
  } = $props();
</script>

<KotboMultiSelect bind:values {options} {placeholder} {disabled} {accentClass} {id} {describedBy} {onchange} />
