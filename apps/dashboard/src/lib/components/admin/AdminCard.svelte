<script lang="ts">
  /**
   * Conteneur de section de la console admin.
   *
   * Uniformise ce qui etait recopie a la main dans chaque page : rayon,
   * bordure, densite du titre et zone d'actions. Les pages ne decrivent plus
   * que leur contenu.
   */
  import type { Snippet } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import type { AdminTone } from './types';

  const {
    title = '',
    description = '',
    icon = '',
    tone = 'neutral',
    padded = true,
    class: className = '',
    actions,
    children,
  }: {
    title?: string;
    description?: string;
    icon?: string;
    tone?: AdminTone;
    padded?: boolean;
    class?: string;
    actions?: Snippet;
    children?: Snippet;
  } = $props();

  const toneClasses: Record<AdminTone, string> = {
    neutral: 'bg-on-surface/6 text-on-surface-variant',
    primary: 'bg-primary/12 text-primary',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/12 text-warning',
    danger: 'bg-error/12 text-error',
    info: 'bg-sky-500/12 text-sky-500',
  };
</script>

<section
  class="rounded-[20px] border border-outline-variant/60 bg-surface overflow-hidden {className}"
>
  {#if title || actions}
    <header class="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-outline-variant/40">
      <div class="flex items-start gap-3 min-w-0">
        {#if icon}
          <div class="w-9 h-9 shrink-0 rounded-[11px] flex items-center justify-center {toneClasses[tone]}">
            <Papicon {icon} size={17} />
          </div>
        {/if}
        <div class="min-w-0">
          <h2 class="font-headline text-base font-semibold text-on-surface leading-tight">{title}</h2>
          {#if description}
            <p class="text-body-sm text-on-surface-variant mt-0.5 leading-snug">{description}</p>
          {/if}
        </div>
      </div>
      {#if actions}
        <div class="flex items-center gap-2 shrink-0">{@render actions()}</div>
      {/if}
    </header>
  {/if}

  <div class={padded ? 'p-5' : ''}>
    {@render children?.()}
  </div>
</section>
