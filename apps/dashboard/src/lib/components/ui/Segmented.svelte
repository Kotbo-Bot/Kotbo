<!-- Choix exclusif façon tafac : options côte à côte dans une piste, la choisie relevée. -->
<script lang="ts" generics="T extends string">
  import Papicon from '../Papicon.svelte';

  const {
    options,
    value,
    onchange,
    label,
    stretch = false,
  }: {
    options: ReadonlyArray<{ value: T; label: string; icon?: string; title?: string }>;
    value: T;
    onchange: (value: T) => void;
    label: string;
    stretch?: boolean;
  } = $props();

  let track = $state<HTMLDivElement>();

  /** Flèches : le choix et le focus avancent ensemble, comme un groupe de boutons radio. */
  function onkeydown(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const from = Math.max(0, options.findIndex((option) => option.value === value));
    const index = (from + step + options.length) % options.length;
    onchange(options[index].value);
    track?.querySelectorAll('button')[index]?.focus();
  }
</script>

<div
  bind:this={track}
  class="segmented"
  class:segmented--stretch={stretch}
  role="radiogroup"
  aria-label={label}
  tabindex="-1"
  {onkeydown}
>
  {#each options as option, index (option.value)}
    {@const checked = option.value === value}
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabindex={checked || (index === 0 && !options.some((o) => o.value === value)) ? 0 : -1}
      title={option.title}
      class="segmented__option"
      onclick={() => onchange(option.value)}
    >
      {#if option.icon}<Papicon icon={option.icon} size={13} />{/if}
      <span>{option.label}</span>
    </button>
  {/each}
</div>
