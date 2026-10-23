<script lang="ts">
  import { memberAvatarSrc } from '../../discordMedia';

  const {
    url = null,
    name = null,
    userId = null,
    size = 32,
    dimmed = false,
  }: { url?: string | null; name?: string | null; userId?: string | null; size?: number; dimmed?: boolean } = $props();
</script>

<img
  src={memberAvatarSrc(url, name, userId)}
  alt=""
  loading="lazy"
  class="shrink-0 rounded-full object-cover bg-surface-container {dimmed ? 'grayscale opacity-60' : ''}"
  style="width: {size}px; height: {size}px;"
/>
