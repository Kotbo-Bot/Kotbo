<script lang="ts">
  /** De quoi sont faits les messages : type, longueur, maniere d'ecrire. */
  import type { ContentMix } from '../../api/adminInsights';
  import { formatCompact, formatPercent } from './format';

  const { content }: { content: ContentMix } = $props();

  const types = $derived(
    [
      { label: 'Texte', value: content.typeText },
      { label: 'Images', value: content.typeImage },
      { label: 'GIF', value: content.typeGif },
      { label: 'Vidéos', value: content.typeVideo },
      { label: 'Stickers', value: content.typeSticker },
      { label: 'Fichiers', value: content.typeFile },
      { label: 'Messages vocaux', value: content.typeVoice },
      { label: 'Sondages', value: content.typePoll },
    ]
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value),
  );
  const typeMax = $derived(Math.max(1, ...types.map((entry) => entry.value)));

  const habits = $derived([
    { label: 'Réponses à un message', value: content.styleReply },
    { label: 'Avec une mention', value: content.styleMention },
    { label: 'Avec un lien', value: content.withLink },
    { label: 'Avec un emoji', value: content.withEmoji },
    { label: 'Dans un fil', value: content.styleThread },
    { label: 'Longs (plus de 200 caractères)', value: content.lenLong },
    { label: 'Courts (moins de 20 caractères)', value: content.lenShort },
  ]);
</script>

{#if content.messages === 0}
  <p class="text-body-sm text-on-surface-variant py-4">Pas encore de mesure du contenu sur la période.</p>
{:else}
  <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
    <div class="space-y-2">
      <p class="text-xs font-semibold text-on-surface-variant">Type de message</p>
      {#each types as entry (entry.label)}
        <div class="flex items-center gap-3">
          <span class="w-28 shrink-0 text-body-sm text-on-surface truncate">{entry.label}</span>
          <span class="flex-1 h-2 rounded-full bg-surface-container overflow-hidden">
            <span class="block h-full rounded-full bg-primary" style="width: {(entry.value / typeMax) * 100}%"></span>
          </span>
          <span class="w-12 text-right text-xs font-semibold text-on-surface tabular-nums">{formatPercent(entry.value, content.messages)}</span>
        </div>
      {/each}
    </div>
    <dl class="space-y-2">
      <p class="text-xs font-semibold text-on-surface-variant">Manière d’écrire</p>
      {#each habits as entry (entry.label)}
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-body-sm text-on-surface">{entry.label}</dt>
          <dd class="text-body-sm tabular-nums">
            <span class="font-semibold text-on-surface">{formatPercent(entry.value, content.messages)}</span>
            <span class="text-xs text-on-surface-variant"> · {formatCompact(entry.value)}</span>
          </dd>
        </div>
      {/each}
    </dl>
  </div>
{/if}
