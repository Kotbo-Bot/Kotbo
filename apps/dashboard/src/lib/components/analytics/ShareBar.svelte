<script lang="ts" module>
  export type ShareSegment = import('@kotbo/ui/analytics').ShareSegment;
</script>

<script lang="ts">
  import { ShareBar as KotboShareBar } from '@kotbo/ui/analytics';

  const {
    segments,
    columns = 3,
    showCounts = false,
  }: {
    segments: ShareSegment[];
    columns?: number;
    showCounts?: boolean;
  } = $props();
</script>

<KotboShareBar {segments} {columns} {showCounts} />
