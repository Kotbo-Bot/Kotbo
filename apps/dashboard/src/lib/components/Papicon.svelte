<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Papicon as KotboPapicon } from '@kotbo/ui/icons';

  const {
    icon = '',
    name = '',
    size = 24,
    class: className = '',
    className: classNameAlias = '',
    class_: legacyClassName = '',
    style = '',
    children,
  }: {
    icon?: string;
    name?: string;
    size?: number;
    class?: string;
    className?: string;
    class_?: string;
    style?: string;
    children?: Snippet;
  } = $props();
</script>

<KotboPapicon {icon} {name} {size} class={className} className={classNameAlias} class_={legacyClassName} {style} {children} />
