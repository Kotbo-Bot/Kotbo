<script lang="ts">
  /**
   * Aperçu fidèle de l'embed tel que Discord l'affichera, rendu par
   * @arcscord/discord-ui.
   *
   * L'ancien aperçu rendait l'image même quand elle était incompatible, ce qui
   * donnait exactement le faux positif à l'origine du bug signalé : ça marche
   * dans le dashboard, ça casse dans Discord. Ici, une image que Discord ne
   * saura pas charger est rendue comme Discord la rend - en cadre d'échec.
   */
  import { Avatar, Embed, MessageFrame, MessageHeader, type EmbedView, type MessageAuthor, type MessageEntities } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../discord/DiscordScope.svelte';

  const {
    title = '',
    message = '',
    color = '#5865F2',
    imageUrl = '',
    thumbnailUrl = '',
    footerText = '',
    botName = 'Kotbo',
    botAvatar = '',
    renderEmoji = (text: string) => text,
    renderTitle = (text: string) => text,
    entities = {},
  }: {
    title?: string;
    message?: string;
    color?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    footerText?: string;
    botName?: string;
    botAvatar?: string;
    /** Prépare la description (Markdown) : raccourcis `:nom:` en émojis du serveur. */
    renderEmoji?: (text: string) => string;
    /** Prépare le titre et le pied (texte) : raccourcis en équivalent unicode. */
    renderTitle?: (text: string) => string;
    /** Images des émojis du serveur cités. */
    entities?: MessageEntities;
  } = $props();

  /**
   * Une URL que Discord refusera de charger : lien signé et expirant du CDN
   * Discord, ou image intégrée. Le navigateur l'afficherait, Discord non.
   */
  function isUnloadable(url: string): boolean {
    const value = url.trim();
    if (!value) return false;
    if (value.startsWith('data:')) return true;
    try {
      const parsed = new URL(value);
      const isDiscordCdn = /(^|\.)cdn\.discordapp\.com$/.test(parsed.hostname)
        || /(^|\.)media\.discordapp\.net$/.test(parsed.hostname);
      return isDiscordCdn && parsed.searchParams.has('ex') && parsed.searchParams.has('hm');
    } catch {
      return true;
    }
  }

  /** Adresse refusée par la lib : elle affiche alors son cadre « média indisponible », comme Discord. */
  const UNLOADABLE = 'about:blank#discord-ne-chargera-pas';

  function media(id: string, url: string) {
    const value = url.trim();
    return value ? { id, url: isUnloadable(value) ? UNLOADABLE : value, alt: '' } : undefined;
  }

  const embed = $derived<EmbedView>({
    id: 'broadcast',
    color,
    ...(title ? { title: renderTitle(title) } : {}),
    ...(message ? { description: renderEmoji(message) } : {}),
    ...(media('thumbnail', thumbnailUrl) ? { thumbnail: media('thumbnail', thumbnailUrl) } : {}),
    ...(media('image', imageUrl) ? { image: media('image', imageUrl) } : {}),
    // Comme l'envoi : la date accompagne le pied de page.
    ...(footerText ? { footer: { text: renderTitle(footerText) }, timestamp: new Date().toISOString() } : {}),
  });

  const author = $derived<MessageAuthor>({ id: 'preview-author', displayName: botName, avatarUrl: botAvatar || '/favicon.svg', bot: true });
  const timestamp = new Date().toISOString();
</script>

<!-- Fond Discord : la couleur de l'embed doit être jugée sur le vrai fond -->
<DiscordScope class="broadcast-preview" {entities}>
  <MessageFrame>
    {#snippet avatar()}<Avatar {author} />{/snippet}
    {#snippet header()}<MessageHeader {author} {timestamp} />{/snippet}
    <Embed {embed} />
    {#if !message}
      <p class="broadcast-preview__empty">Le message apparaîtra ici…</p>
    {/if}
  </MessageFrame>
</DiscordScope>

<style>
  :global(.arcscord-discord-ui.broadcast-preview) {
    border-radius: 0.75rem;
    padding: 0.5rem 0;
  }

  .broadcast-preview__empty {
    margin-top: 0.25rem;
    font-size: 0.875rem;
    font-style: italic;
    opacity: 0.6;
  }
</style>
