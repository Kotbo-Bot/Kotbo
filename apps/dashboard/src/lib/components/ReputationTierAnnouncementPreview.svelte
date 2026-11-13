<script lang="ts">
  /**
   * Aperçu de l'annonce d'un palier de réputation, tel qu'il tombera dans le salon.
   *
   * Comme pour les drops, les textes sont ceux du bot dans la langue du serveur
   * (gabarits renvoyés par la route) ; seules les valeurs viennent du formulaire.
   */
  import { m } from '../i18n';
  import DiscordMarkdownText from './sanctions/DiscordMarkdownText.svelte';
  import { fillDropTemplate } from '../dropPreview';
  import type { ReputationAnnouncementLabels } from '../api';

  const {
    labels,
    threshold,
    roleName,
  }: {
    labels: ReputationAnnouncementLabels;
    threshold: number;
    roleName: string;
  } = $props();

  /** Couleur de l'embed côté bot (`COLORS.primary`). */
  const EMBED_COLOR = '#5865f2';

  const body = $derived(fillDropTemplate(labels.body, {
    user: `@${m.rep_tier_preview_member()}`,
    role: `@${roleName}`,
    threshold: new Intl.NumberFormat(labels.locale === 'fr' ? 'fr-FR' : 'en-US').format(threshold),
  }));
</script>

<div class="discord">
  <div class="embed" style="border-left-color: {EMBED_COLOR}">
    <p class="embed-title">{labels.title}</p>
    {#each body.split('\n') as line, index (index)}
      <p class="embed-body"><DiscordMarkdownText text={line} /></p>
    {/each}
  </div>
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

  .discord :global(strong) { color: #f2f3f5; }
</style>
