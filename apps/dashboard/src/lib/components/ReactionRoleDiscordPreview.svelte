<!--
  Message d'un menu de rôles tel que Discord l'affiche : embed (titre, texte,
  barre de couleur) puis boutons par rangées de cinq. Sert à l'aperçu de la
  fenêtre d'édition et, en version compacte, aux cartes des menus publiés.
  Rendu par @arcscord/discord-ui.
-->
<script lang="ts">
  import { ActionRow, Avatar, Button, Embed, Markdown, MessageFrame, MessageHeader, type EmbedView, type MessageAuthor } from '@arcscord/discord-ui-svelte';
  import { m } from '../i18n';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import DiscordScope from './discord/DiscordScope.svelte';
  import { mergeEntities, toPreviewMarkdown } from './discord/previewEntities.svelte';

  type PreviewStyle = 'secondary' | 'primary' | 'success' | 'danger';

  const {
    title,
    description,
    buttons,
    color = '#5865F2',
    compact = false,
  }: {
    title: string;
    description: string;
    /** `text` vide : bouton incomplet, montré grisé avec un libellé d'attente. */
    buttons: Array<{ emoji?: string; text: string; style: PreviewStyle }>;
    color?: string;
    /** Sans en-tête du bot, plus serré : pour les cartes. */
    compact?: boolean;
  } = $props();

  const rows = $derived.by(() => {
    const result: (typeof buttons)[] = [];
    for (let i = 0; i < buttons.length; i += 5) result.push(buttons.slice(i, i + 5));
    return result;
  });

  const embed = $derived<EmbedView>({
    id: 'reaction-roles',
    color,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  });

  /** Rôles du serveur pour les `<@&id>` du texte, émojis du serveur en image. */
  const entities = $derived.by(() => {
    const roles: Record<string, { name: string; color?: string }> = {};
    for (const role of dashboardStore.state.discordRoles || []) roles[role.id] = { name: role.name, ...(role.color ? { color: role.color } : {}) };
    const texts = [title, description, ...buttons.map((button) => button.emoji ?? '')].filter(Boolean);
    return mergeEntities([{ roles }, ...texts.map((text) => toPreviewMarkdown(text, { mentions: false }).entities)]);
  });

  const author: MessageAuthor = { id: 'preview-author', displayName: 'Kotbo', avatarUrl: '/favicon.svg', bot: true };
  const timestamp = new Date().toISOString();
</script>

{#snippet message()}
  <Embed {embed} />
  {#each rows as row, rowIndex (rowIndex)}
    <ActionRow>
      {#each row as button, index (index)}
        {@const label = button.text || m.reaction_roles_preview_button_default()}
        {#if button.emoji}
          {#snippet emoji()}<Markdown inline content={button.emoji ?? ''} />{/snippet}
          <Button {label} variant={button.style} disabled={!button.text} {emoji} />
        {:else}
          <Button {label} variant={button.style} disabled={!button.text} />
        {/if}
      {/each}
    </ActionRow>
  {/each}
{/snippet}

<DiscordScope class={compact ? 'rr-preview rr-preview--compact' : 'rr-preview'} {entities}>
  {#if compact}
    {@render message()}
  {:else}
    <MessageFrame>
      {#snippet avatar()}<Avatar {author} />{/snippet}
      {#snippet header()}<MessageHeader {author} {timestamp} />{/snippet}
      {@render message()}
    </MessageFrame>
  {/if}
</DiscordScope>

<style>
  :global(.arcscord-discord-ui.rr-preview) {
    padding: 1rem 0;
  }

  /* Carte d'un menu publié : plus serrée, le texte coupé à deux lignes. */
  :global(.arcscord-discord-ui.rr-preview--compact) {
    border-radius: 0.5rem;
    padding: 0.75rem;
    font-size: 13px;
  }

  :global(.arcscord-discord-ui.rr-preview--compact .dui-embed .dui-markdown) {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
