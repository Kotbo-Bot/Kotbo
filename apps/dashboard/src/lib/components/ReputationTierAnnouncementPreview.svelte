<script lang="ts">
  /**
   * Aperçu de l'annonce d'un palier de réputation, tel qu'il tombera dans le salon.
   *
   * Comme pour les drops, les textes sont ceux du bot dans la langue du serveur
   * (gabarits renvoyés par la route) ; seules les valeurs viennent du formulaire.
   */
  import { m } from '../i18n';
  import DiscordEmbedPreview from './DiscordEmbedPreview.svelte';
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

  const body = $derived(fillDropTemplate(labels.body, {
    user: `@${m.rep_tier_preview_member()}`,
    role: `@${roleName}`,
    threshold: new Intl.NumberFormat(labels.locale === 'fr' ? 'fr-FR' : 'en-US').format(threshold),
  }));
</script>

<DiscordEmbedPreview title={labels.title} {body} />
