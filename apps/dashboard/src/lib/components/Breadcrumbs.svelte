<script lang="ts">
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import { buildCrumbs } from '../breadcrumbs';

  // On phones the top bar already states where you are and how to go back, so
  // this strip is desktop and tablet only (hidden via app.css).
  const crumbs = $derived(buildCrumbs($router.path));
</script>

{#if crumbs.length > 0}
  <nav class="breadcrumbs flex items-center gap-1.5 text-xs text-on-surface-variant mb-5 select-none" aria-label="Fil d’Ariane">
    {#each crumbs as crumb, i (crumb.href + i)}
      {#if i > 0}
        <span class="text-on-surface-variant/30" aria-hidden="true">/</span>
      {/if}

      {#if i === crumbs.length - 1}
        <span class="text-on-surface font-medium">{crumb.name}</span>
      {:else}
        <a href={crumb.href} class="hover:text-on-surface transition-colors flex items-center gap-1">
          {#if i === 0}
            <Papicon icon="Home" size={12} />
          {/if}
          {crumb.name}
        </a>
      {/if}
    {/each}
  </nav>
{/if}
