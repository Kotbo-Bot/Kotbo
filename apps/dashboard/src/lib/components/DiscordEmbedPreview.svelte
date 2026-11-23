<script lang="ts">
  /**
   * Embed Discord tel qu'il tombera dans le salon : titre et corps en Markdown
   * Discord. Les textes viennent du bot, dans la langue du serveur. `children`
   * se place sous l'embed, dans le même fond : les boutons du message, par
   * exemple. `content` est le texte du message au-dessus de l'embed, `footer`
   * la ligne discrète qui le ferme.
   */
  import type { Snippet } from 'svelte';
  import { Embed, Markdown, type EmbedView, type MessageEntities } from '@arcscord/discord-ui-svelte';
  import DiscordScope from './discord/DiscordScope.svelte';

  /** Couleur de l'embed côté bot (`COLORS.primary`), sauf message qui a la sienne. */
  const {
    title,
    body,
    color = '#5865f2',
    content,
    footer,
    entities = {},
    children,
  }: {
    title: string;
    body: string;
    color?: string;
    content?: string;
    footer?: string;
    /** Noms des mentions et émojis cités (`<@&id>` d'un rôle mentionné, par exemple). */
    entities?: MessageEntities;
    children?: Snippet;
  } = $props();

  const embed = $derived<EmbedView>({
    id: 'preview',
    title,
    description: body,
    color,
    footer: footer ? { text: footer } : undefined,
  });
</script>

<DiscordScope class="discord-preview" {entities}>
  {#if content}
    <div class="message-content"><Markdown {content} /></div>
  {/if}
  <Embed {embed} />
  {@render children?.()}
</DiscordScope>

<style>
  :global(.arcscord-discord-ui.discord-preview) {
    border-radius: 0.75rem;
    padding: 1rem;
  }

  .message-content {
    margin-bottom: 0.375rem;
  }
</style>
