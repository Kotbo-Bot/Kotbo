<!-- Un grade : une pastille de la couleur de son pole, puis son nom. -->
<script lang="ts">
  const { name, color = null, small = false }: { name: string; color?: string | null; small?: boolean } = $props();
</script>

<span class="inline-flex min-w-0 items-center gap-1.5 {small ? 'text-xs text-on-surface-variant' : 'text-sm text-on-surface'}">
  <span
    class="h-2 w-2 shrink-0 rounded-full"
    style="background: {color || 'var(--outline)'};"
    aria-hidden="true"
  ></span>
  <span class="truncate">{name}</span>
</span>
