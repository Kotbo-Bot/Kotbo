<script lang="ts">
  import { AnalyticsSkeleton as KotboAnalyticsSkeleton } from '@kotbo/ui/analytics';

  const { compact = false, rows = 5 }: { compact?: boolean; rows?: number } = $props();
</script>

<KotboAnalyticsSkeleton {compact} {rows} />
