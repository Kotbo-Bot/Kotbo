<script lang="ts">
  /**
   * Pastille d'etat.
   *
   * Les couleurs sont portees ici plutot que recopiees dans chaque page :
   * un meme statut doit se lire pareil dans Serveurs, Shards et Broadcast.
   */
  import Papicon from '../Papicon.svelte';
  import type { AdminTone } from './types';

  const {
    label,
    tone = 'neutral',
    icon = '',
    dot = false,
    pulse = false,
    size = 'md',
  }: {
    label: string;
    tone?: AdminTone;
    icon?: string;
    dot?: boolean;
    pulse?: boolean;
    size?: 'sm' | 'md';
  } = $props();

  const tones: Record<AdminTone, { chip: string; dot: string }> = {
    primary: { chip: 'bg-primary/12 text-primary border-primary/25', dot: 'bg-primary' },
    success: { chip: 'bg-success/12 text-success border-success/25', dot: 'bg-emerald-500' },
    warning: { chip: 'bg-warning/12 text-warning border-warning/25', dot: 'bg-amber-500' },
    danger: { chip: 'bg-error/12 text-error border-error/25', dot: 'bg-red-500' },
    info: { chip: 'bg-sky-500/12 text-sky-600 dark:text-sky-400 border-sky-500/25', dot: 'bg-sky-500' },
    neutral: { chip: 'bg-on-surface/6 text-on-surface-variant border-outline-variant/25', dot: 'bg-on-surface-variant' },
  };

  const config = $derived(tones[tone] ?? tones.neutral);
  const sizeClass = $derived(size === 'sm' ? 'h-5 px-1.5 text-2xs gap-1' : 'h-6 px-2 text-2xs gap-1.5');
</script>

<span class="inline-flex items-center rounded-full font-semibold whitespace-nowrap {config.chip} {sizeClass}">
  {#if dot}
    <span class="w-1.5 h-1.5 rounded-full {config.dot} {pulse ? 'animate-pulse' : ''}"></span>
  {:else if icon}
    <Papicon {icon} size={size === 'sm' ? 10 : 12} />
  {/if}
  {label}
</span>
