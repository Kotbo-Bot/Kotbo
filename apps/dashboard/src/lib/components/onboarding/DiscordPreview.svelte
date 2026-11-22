<script lang="ts">
  /**
   * Ce que Discord affichera, montre pendant qu'on le regle.
   *
   * Le parcours faisait relire des gabarits : « Bienvenue {user} sur
   * **{server}** ! ». Personne ne juge une phrase a travers ses variables et ses
   * asterisques. Ici, la meme phrase est rendue la ou elle atterrira - salon,
   * avatar, pseudo, badge du bot -, et la question « est-ce que ca sonne bien ? »
   * redevient une question a laquelle on peut repondre.
   *
   * Rendu par @arcscord/discord-ui, en theme sombre quel que soit celui du
   * tableau de bord : l'apercu doit ressembler a Discord, pas a la page. Le
   * texte est du Markdown Discord ; les `@pseudo` en clair deviennent des
   * mentions. `children` se place dans le message, sous le texte : un embed.
   */
  import { setContext, type Snippet } from 'svelte';
  import { Avatar, ChannelHeader, Markdown, MessageFrame, MessageHeader, type MessageAuthor, type MessageEntities } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../discord/DiscordScope.svelte';
  import { mergeEntities, PREVIEW_ENTITIES, PreviewEntities, toPreviewMarkdown } from '../discord/previewEntities.svelte';

  const {
    channel,
    author = 'Kotbo',
    avatarUrl = '/favicon.svg',
    bot = true,
    content,
    mentions = true,
    entities: extraEntities = {},
    children,
  }: {
    channel: string;
    author?: string;
    avatarUrl?: string;
    bot?: boolean;
    /** Texte du message, en Markdown Discord. */
    content?: string;
    /**
     * `@pseudo` en clair rendus comme des mentions : vrai pour un gabarit
     * (« Bienvenue @Lina »), faux pour un vrai message, où Discord laisse
     * `@pseudo` en texte et ne résout que `<@id>`.
     */
    mentions?: boolean;
    /** Noms des rôles, salons ou émojis cités, en plus de ceux du texte. */
    entities?: MessageEntities;
    children?: Snippet;
  } = $props();

  const registry = new PreviewEntities();
  setContext(PREVIEW_ENTITIES, registry);

  const text = $derived(content ? toPreviewMarkdown(content, { mentions }) : null);
  const entities = $derived(mergeEntities([extraEntities, text?.entities ?? {}, ...Object.values(registry.sources)]));
  const messageAuthor = $derived<MessageAuthor>({ id: 'preview-author', displayName: author, avatarUrl, bot });
  const timestamp = new Date().toISOString();
</script>

<DiscordScope class="discord-preview-card" {entities}>
  <ChannelHeader name={channel} />
  <div class="discord-preview-body">
    <MessageFrame>
      {#snippet avatar()}<Avatar author={messageAuthor} />{/snippet}
      {#snippet header()}<MessageHeader author={messageAuthor} {timestamp} />{/snippet}
      {#if text}<Markdown content={text.markdown} />{/if}
      {@render children?.()}
    </MessageFrame>
  </div>
</DiscordScope>

<style>
  :global(.arcscord-discord-ui.discord-preview-card) {
    border-radius: 0.75rem;
    overflow: hidden;
    border: 1px solid rgb(0 0 0 / 0.25);
  }

  .discord-preview-body {
    padding: 0.5rem 0;
  }
</style>
