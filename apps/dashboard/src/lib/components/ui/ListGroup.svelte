<!-- Groupe façon tafac : un titre discret, une carte, des lignes séparées par un filet rentré. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  const {
    title = '',
    footer = '',
    id = undefined,
    children,
  }: { title?: string; footer?: string; id?: string; children: Snippet } = $props();
</script>

<section {id} class="list-group" aria-label={title || undefined}>
  {#if title}<h2 class="list-group__title">{title}</h2>{/if}
  <div class="section-card-flush list-rows">{@render children()}</div>
  {#if footer}<p class="list-group__footer">{footer}</p>{/if}
</section>
