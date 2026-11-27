<script lang="ts" module>
  export type TabItem = import('@kotbo/ui').TabItem;
</script>

<script lang="ts">
  import { Tabs as KotboTabs } from '@kotbo/ui';

  const {
    tabs,
    active,
    onchange,
    label,
    class: className = '',
  }: {
    tabs: TabItem[];
    active: string;
    onchange: (id: string) => void;
    label: string;
    class?: string;
  } = $props();
</script>

<KotboTabs {tabs} {active} {onchange} {label} class={className} />
