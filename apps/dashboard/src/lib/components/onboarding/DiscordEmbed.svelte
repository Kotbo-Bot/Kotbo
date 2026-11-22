<script lang="ts">
  /**
   * Un embed Discord, tel que le bot le publiera.
   *
   * La barre de couleur a gauche est ce qui rend le choix de teinte lisible :
   * une pastille dans un selecteur ne dit pas a quoi ressemblera le panneau
   * poste dans le salon, et c'est pourtant la seule question qu'on se pose en
   * choisissant une couleur.
   *
   * Rendu par @arcscord/discord-ui, dans un `DiscordPreview` : les noms des
   * mentions et des emojis sont declares au cadre du message. Seul, l'embed
   * pose son propre cadre.
   */
  import { getContext, onDestroy } from 'svelte';
  import { ActionRow, Button, Embed, Markdown, type EmbedView } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../discord/DiscordScope.svelte';
  import { mergeEntities, PREVIEW_ENTITIES, type PreviewEntities, toPreviewMarkdown } from '../discord/previewEntities.svelte';

  const {
    color,
    title,
    description,
    fields = [],
    buttons = [],
  }: {
    color: string;
    title?: string;
    description?: string;
    fields?: { emoji?: string | null; name: string; value?: string | null }[];
    buttons?: { emoji?: string | null; label: string }[];
  } = $props();

  const prepared = $derived.by(() => {
    // Titre et noms de champs : Discord n'y résout pas les mentions.
    const titleText = title ? toPreviewMarkdown(title, { mentions: false }) : null;
    const descriptionText = description ? toPreviewMarkdown(description) : null;
    const fieldTexts = fields.map((field) => ({
      name: toPreviewMarkdown(field.emoji ? `${field.emoji} ${field.name}` : field.name, { mentions: false }),
      value: toPreviewMarkdown(field.value ?? ''),
    }));
    const buttonEmojis = buttons.map((button) => (button.emoji ? toPreviewMarkdown(button.emoji) : null));
    const embed: EmbedView = {
      id: 'preview',
      color,
      ...(titleText ? { title: titleText.markdown } : {}),
      ...(descriptionText ? { description: descriptionText.markdown } : {}),
      ...(fieldTexts.length
        ? { fields: fieldTexts.map((field, index) => ({ id: String(index), name: field.name.markdown, value: field.value.markdown })) }
        : {}),
    };
    const entities = mergeEntities([
      titleText?.entities ?? {},
      descriptionText?.entities ?? {},
      ...fieldTexts.flatMap((field) => [field.name.entities, field.value.entities]),
      ...buttonEmojis.map((emoji) => emoji?.entities ?? {}),
    ]);
    return { embed, entities, buttonEmojis: buttonEmojis.map((emoji) => emoji?.markdown ?? null) };
  });

  // Dans un DiscordPreview, les noms remontent au cadre du message.
  const registry = getContext<PreviewEntities | undefined>(PREVIEW_ENTITIES);
  const key = `embed-${Math.random().toString(36).slice(2)}`;
  $effect(() => {
    registry?.set(key, prepared.entities);
  });
  onDestroy(() => registry?.remove(key));
</script>

{#snippet content()}
  <Embed embed={prepared.embed} />
  {#if buttons.length}
    <!-- Les boutons vivent sous l'embed, pas dedans : c'est la place que Discord leur donne. -->
    <ActionRow>
      {#each buttons as button, index (index)}
        {@const emoji = prepared.buttonEmojis[index]}
        {#if emoji}
          {#snippet buttonEmoji()}<Markdown inline content={emoji} />{/snippet}
          <Button label={button.label} variant="primary" emoji={buttonEmoji} />
        {:else}
          <Button label={button.label} variant="primary" />
        {/if}
      {/each}
    </ActionRow>
  {/if}
{/snippet}

{#if registry}
  {@render content()}
{:else}
  <DiscordScope entities={prepared.entities}>{@render content()}</DiscordScope>
{/if}
