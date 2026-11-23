<script lang="ts">
  import Skeleton from '../Skeleton.svelte';

  // `compact` : squelette d'une liste à l'intérieur d'une carte. La version
  // pleine page (grille 4 colonnes + graphique) déborde d'une carte étroite.
  const { compact = false, rows = 5 }: { compact?: boolean; rows?: number } = $props();
</script>

{#if compact}
  <div class="space-y-3" aria-busy="true">
    {#each Array(rows) as _}
      <div class="flex items-center gap-3">
        <Skeleton width="w-8" height="h-8" rounded="rounded-lg" class="shrink-0" />
        <div class="min-w-0 flex-1 space-y-1.5">
          <Skeleton width="w-full" height="h-3" />
          <Skeleton width="w-1/2" height="h-2" />
        </div>
      </div>
    {/each}
  </div>
{:else}
<div class="space-y-6">
  <!-- Top Stats Grid -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
    {#each Array(4) as _}
      <div class="premium-card p-6 rounded-xl flex flex-col gap-4">
        <div class="flex justify-between items-start">
          <Skeleton width="w-10" height="h-10" rounded="rounded-xl" />
          <Skeleton width="w-16" height="h-3" />
        </div>
        <div class="space-y-2">
          <Skeleton width="w-24" height="h-8" />
          <Skeleton width="w-32" height="h-3" />
        </div>
      </div>
    {/each}
  </div>

  <!-- Main Grid Section -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- Large Chart Card -->
    <div class="lg:col-span-2 premium-card p-8 rounded-xl space-y-6">
      <div class="flex justify-between items-center">
        <div class="flex items-center gap-3">
          <Skeleton width="w-12" height="h-12" rounded="rounded-lg" />
          <div class="space-y-2">
            <Skeleton width="w-32" height="h-5" />
            <Skeleton width="w-24" height="h-3" />
          </div>
        </div>
        <Skeleton width="w-20" height="h-8" rounded="rounded-xl" />
      </div>
      <Skeleton width="w-full" height="h-64" rounded="rounded-xl" />
    </div>

    <!-- Side Bento Column -->
    <div class="space-y-6">
      <div class="premium-card p-6 rounded-xl space-y-4">
        <Skeleton width="w-full" height="h-40" rounded="rounded-lg" />
        <div class="space-y-2">
          <Skeleton width="w-3/4" height="h-4" />
          <Skeleton width="w-1/2" height="h-3" />
        </div>
      </div>
      <div class="premium-card p-6 rounded-xl space-y-4">
        <div class="flex items-center gap-3">
          <Skeleton width="w-8" height="h-8" circle />
          <Skeleton width="w-24" height="h-4" />
        </div>
        <div class="space-y-3">
          {#each Array(3) as _}
            <div class="flex items-center gap-3">
              <Skeleton width="w-10" height="h-10" rounded="rounded-lg" />
              <div class="space-y-1 flex-grow">
                <Skeleton width="w-full" height="h-3" />
                <Skeleton width="w-1/2" height="h-2" />
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>
{/if}

<style>
  .premium-card {
    background: rgba(var(--color-surface-container-low), 0.4);
    backdrop-filter: blur(24px);
    border: 1px solid rgba(var(--color-outline-variant), 0.1);
  }

  :global(.dark) .premium-card {
    background: rgba(var(--color-surface-container-low), 0.15);
    border: 1px solid rgba(255, 255, 255, 0.03);
  }
</style>

