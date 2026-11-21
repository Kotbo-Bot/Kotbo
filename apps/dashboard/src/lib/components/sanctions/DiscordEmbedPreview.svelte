<script lang="ts">
  /**
   * Embed d'un message Discord récupéré comme preuve, rendu par
   * @arcscord/discord-ui-svelte à partir du format renvoyé par l'API.
   */
  import { Embed, type EmbedView } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../discord/DiscordScope.svelte';

  interface ParsedEmbed {
    color: string | null;
    authorName: string | null;
    authorIconUrl: string | null;
    authorUrl: string | null;
    title: string | null;
    url: string | null;
    description: string | null;
    fields: { name: string; value: string; inline: boolean }[];
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string | null;
    footerIconUrl: string | null;
  }

  const { embed }: { embed: ParsedEmbed } = $props();

  const view = $derived<EmbedView>({
    id: 'evidence',
    color: embed.color ?? undefined,
    title: embed.title ?? undefined,
    url: embed.url ?? undefined,
    description: embed.description ?? undefined,
    author: embed.authorName
      ? { name: embed.authorName, url: embed.authorUrl ?? undefined, iconUrl: embed.authorIconUrl ?? undefined }
      : undefined,
    fields: embed.fields.map((field, index) => ({ id: String(index), ...field })),
    thumbnail: embed.thumbnailUrl ? { id: 'thumbnail', url: embed.thumbnailUrl, alt: '' } : undefined,
    image: embed.imageUrl ? { id: 'image', url: embed.imageUrl, alt: '' } : undefined,
    footer: embed.footerText ? { text: embed.footerText, iconUrl: embed.footerIconUrl ?? undefined } : undefined,
  });
</script>

<DiscordScope class="evidence-embed">
  <Embed embed={view} />
</DiscordScope>

<style>
  :global(.arcscord-discord-ui.evidence-embed) {
    margin-top: 8px;
    background: transparent;
  }
</style>
