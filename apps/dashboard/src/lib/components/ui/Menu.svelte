<script lang="ts" module>
  export type MenuItem = import('@kotbo/ui').MenuItem;
</script>

<script lang="ts">
  import { Menu as KotboMenu } from '@kotbo/ui';

  const {
    items,
    label,
    icon = 'more-horizontal',
    text = '',
  }: { items: MenuItem[]; label: string; icon?: string; text?: string } = $props();
</script>

<KotboMenu {items} {label} {icon} {text} />
