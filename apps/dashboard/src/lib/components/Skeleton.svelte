<script lang="ts">
  import { Skeleton as KotboSkeleton } from '@kotbo/ui';

  const {
    class: className = '',
    width = 'w-full',
    height = 'h-4',
    rounded = 'rounded-lg',
    circle = false,
    radius = '',
    style = '',
    ...rest
  }: {
    class?: string;
    width?: string;
    height?: string;
    rounded?: string;
    circle?: boolean;
    radius?: string;
    style?: string;
    [key: string]: unknown;
  } = $props();
</script>

<KotboSkeleton class={className} {width} {height} {rounded} {circle} {radius} {style} {...rest} />
