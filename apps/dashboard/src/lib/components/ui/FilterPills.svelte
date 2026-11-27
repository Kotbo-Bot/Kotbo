<script lang="ts" module>
  export type FilterOption<T extends string = string> = import('@kotbo/ui').FilterOption<T>;
</script>

<script lang="ts" generics="T extends string">
  import { FilterPills as KotboFilterPills } from '@kotbo/ui';

  const {
    options,
    value,
    onchange,
    label,
    describedBy = undefined,
    disabled = false,
    class: className = '',
  }: {
    options: FilterOption<T>[];
    value: T;
    onchange: (value: T) => void;
    label: string;
    describedBy?: string;
    disabled?: boolean;
    class?: string;
  } = $props();
</script>

<KotboFilterPills {options} {value} {onchange} {label} {describedBy} {disabled} class={className} />
