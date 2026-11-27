<script lang="ts">
  import { StatTile as KotboStatTile } from '@kotbo/ui';

  const {
    icon,
    tone,
    value,
    label,
  }: {
    icon: string;
    tone: string;
    value: string | number;
    label: string;
  } = $props();
</script>

<KotboStatTile {icon} {tone} {value} {label} />
