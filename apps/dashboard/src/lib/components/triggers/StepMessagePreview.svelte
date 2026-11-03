<script lang="ts">
  import DiscordMessage from '../workflows/DiscordMessage.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { previewChannelName, previewTemplate, previewText } from '../../workflowPreview';
  import { embedColor, type MessagePreview } from '../../workflowReplay';
  import type { ActionStep, ValueRef } from '@kotbo/shared';

  /**
   * Ce que Discord affichera pour une étape « Envoyer un message » ou
   * « Envoyer un encadré », variables remplies par un exemple.
   */
  const {
    step,
    triggerType,
    channels = [],
  }: {
    step: ActionStep;
    triggerType: string;
    channels?: { id: string; name: string }[];
  } = $props();

  const guildName = $derived(authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)?.name);

  function render(ref: ValueRef | undefined): string {
    if (ref?.from !== 'text') return '';
    return previewText(previewTemplate(ref.template, triggerType, { guildName }));
  }

  const message = $derived.by((): MessagePreview => {
    const channel = previewChannelName(step.values.channel, channels);
    if (step.action !== 'SendEmbed') return { channel, content: render(step.values.text) };
    const color = step.values.color?.from === 'text' ? step.values.color.template : undefined;
    return {
      channel,
      embed: { title: render(step.values.title), description: render(step.values.description), color: embedColor(color) },
    };
  });
</script>

<DiscordMessage {message} />
