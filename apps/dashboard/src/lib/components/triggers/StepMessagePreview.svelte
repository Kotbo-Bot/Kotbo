<script lang="ts">
  import DiscordPreview from '../onboarding/DiscordPreview.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { previewChannelName, previewTemplate, previewText } from '../../workflowPreview';
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

  const channel = $derived(previewChannelName(step.values.channel, channels));
  const isEmbed = $derived(step.action === 'SendEmbed');
  const text = $derived(render(step.values.text));
  const title = $derived(render(step.values.title));
  const description = $derived(render(step.values.description));
  // Seule une couleur hexadécimale entre dans le style : le champ reste une saisie.
  const color = $derived.by(() => {
    const ref = step.values.color;
    return ref?.from === 'text' && /^#[0-9a-f]{6}$/i.test(ref.template) ? ref.template : '#5865F2';
  });
</script>

{#if isEmbed}
  <DiscordPreview {channel}>
    <div class="mt-1 max-w-md rounded border-l-4 bg-[#2b2d31] px-3 py-2.5" style="border-left-color: {color}">
      {#if title}
        <p class="text-sm font-semibold text-[#f2f3f5] break-words">{title}</p>
      {/if}
      {#if description}
        <p class="mt-1 text-sm leading-[1.4] text-[#dbdee1] whitespace-pre-wrap break-words">{description}</p>
      {/if}
    </div>
  </DiscordPreview>
{:else}
  <DiscordPreview {channel} content={text} />
{/if}
