<script lang="ts">
  import { KpiTile as KotboKpiTile } from '@kotbo/ui/analytics';

  const {
    label,
    value,
    delta = undefined,
    unit = 'pct',
    compare = false,
    hint = '',
  }: {
    label: string;
    value: string;
    delta?: number | null;
    unit?: 'pct' | 'pts' | 'abs';
    compare?: boolean;
    hint?: string;
  } = $props();
</script>

<KotboKpiTile {label} {value} {delta} {unit} {compare} {hint} />
