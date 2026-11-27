<script lang="ts" module>
  export type BarListItem = import('@kotbo/ui/analytics').BarListItem;
</script>

<script lang="ts" generics="T extends BarListItem">
  import type { Snippet } from 'svelte';
  import { BarList as KotboBarList } from '@kotbo/ui/analytics';

  const {
    items,
    color = 'var(--series-1)',
    leading,
    trailing,
    onselect,
    empty = '',
    max = undefined,
  }: {
    items: T[];
    color?: string;
    leading?: Snippet<[T]>;
    trailing?: Snippet<[T]>;
    onselect?: (item: T) => void;
    empty?: string;
    max?: number;
  } = $props();
</script>

<KotboBarList {items} {color} {leading} {trailing} {onselect} {empty} {max} />
