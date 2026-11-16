<script lang="ts">
  /**
   * Embed Discord tel qu'il tombera dans le salon : titre et corps en Markdown
   * Discord, une ligne par paragraphe. Les textes viennent du bot, dans la
   * langue du serveur. `children` se place sous l'embed, dans le même fond :
   * les boutons du message, par exemple.
   */
  import type { Snippet } from 'svelte';
  import DiscordMarkdownText from './sanctions/DiscordMarkdownText.svelte';

  /** Couleur de l'embed côté bot (`COLORS.primary`), sauf message qui a la sienne. */
  const { title, body, color = '#5865f2', children }: { title: string; body: string; color?: string; children?: Snippet } = $props();
</script>

<div class="discord">
  <div class="embed" style="border-left-color: {color}">
    <p class="embed-title">{title}</p>
    {#each body.split('\n') as line, index (index)}
      {#if line}
        <p class="embed-body"><DiscordMarkdownText text={line} /></p>
      {:else}
        <p class="embed-gap" aria-hidden="true"></p>
      {/if}
    {/each}
  </div>
  {@render children?.()}
</div>

<style>
  /* Fond sombre quel que soit le thème : Discord n'a pas celui du dashboard. */
  .discord {
    background: #313338;
    border-radius: 0.75rem;
    padding: 1rem;
    color: #dbdee1;
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .embed {
    background: #2b2d31;
    border-left: 4px solid;
    border-radius: 0.25rem;
    padding: 0.75rem 1rem;
    max-width: 32rem;
  }

  .discord .embed-title {
    font-weight: 600;
    color: #f2f3f5;
    margin: 0 0 0.5rem;
  }

  .discord .embed-body { margin: 0; color: #dbdee1; }

  .discord .embed-gap { margin: 0; height: 0.5rem; }

  .discord :global(strong) { color: #f2f3f5; }
</style>
