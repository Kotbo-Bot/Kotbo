<!--
  Sous un champ de durée en minutes : son équivalent lisible (« = 6 h ») et des crans
  qui le remplissent d'un clic. Le champ garde la saisie libre ; un cran n'est qu'un
  raccourci, et une valeur réglée finement reste telle quelle tant qu'on n'en choisit pas.
-->
<script lang="ts">
  import { formatDuration } from '../durationFormat';
  import { dateLocale } from '../i18n';

  let {
    value = $bindable(),
    presets,
    label,
    disabled = false,
  }: {
    value: number;
    presets: number[];
    /** Nom du groupe de crans, pour les lecteurs d'écran. */
    label: string;
    disabled?: boolean;
  } = $props();

  const readable = $derived(formatDuration(value, dateLocale()));
</script>

<div class="mt-1.5 space-y-1.5">
  {#if readable}
    <p class="text-2xs font-semibold text-primary">= {readable}</p>
  {/if}
  {#if presets.length > 0}
    <div class="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {#each presets as preset (preset)}
        <button
          type="button"
          onclick={() => value = preset}
          aria-pressed={value === preset}
          {disabled}
          class="px-2 py-0.5 rounded-full border text-2xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed {value === preset
            ? 'bg-primary/10 border-primary/40 text-primary'
            : 'border-outline-variant/20 text-on-surface-variant hover:border-outline-variant/40'}"
        >
          {formatDuration(preset, dateLocale())}
        </button>
      {/each}
    </div>
  {/if}
</div>
