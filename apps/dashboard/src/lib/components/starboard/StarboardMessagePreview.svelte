<script lang="ts">
  /**
   * Message à la une tel qu'il tombera dans le salon : compteur au-dessus,
   * embed à la couleur choisie, pied des votes quand le vote négatif existe,
   * bouton vers le message d'origine.
   *
   * Les textes sont ceux du bot dans la langue du serveur ; le compteur et
   * l'auteur sont des exemples. Un emoji personnalisé ne se dessine pas dans
   * le texte de l'aperçu : seul le score est alors montré.
   */
  import { m } from '../../i18n';
  import { ActionRow, LinkButton } from '@arcscord/discord-ui-svelte';
  import DiscordEmbedPreview from '../DiscordEmbedPreview.svelte';
  import { fillDropTemplate } from '../../dropPreview';
  import type { StarboardMessageLabels } from '../../api';

  const {
    labels,
    color,
    upvoteEmoji,
    hasDownvotes,
    threshold,
  }: {
    labels: StarboardMessageLabels;
    color: string;
    upvoteEmoji: string | undefined;
    hasDownvotes: boolean;
    threshold: number;
  } = $props();

  const CUSTOM_EMOJI_ID = /^\d{15,25}$/;

  /** Un exemple juste au-dessus du seuil : ce que verra le serveur au premier passage. */
  const down = 1;
  const up = $derived(threshold + 2);
  const score = $derived(up - (hasDownvotes ? down : 0));

  const emoji = $derived(upvoteEmoji && !CUSTOM_EMOJI_ID.test(upvoteEmoji) ? `${upvoteEmoji} ` : '');
  const content = $derived(`${emoji}**${score}** | #${m.starboard_preview_channel()}`);
  const footer = $derived(hasDownvotes ? fillDropTemplate(labels.footerVotes, { up: String(up), down: String(down) }) : undefined);
</script>

<DiscordEmbedPreview title={m.starboard_preview_author()} body={m.starboard_preview_content()} {color} {content} {footer}>
  <ActionRow>
    <!-- Lien vers le message d'origine : en aperçu, vers Discord. -->
    <LinkButton label={labels.jumpButton} url="https://discord.com/channels/@me" />
  </ActionRow>
</DiscordEmbedPreview>

