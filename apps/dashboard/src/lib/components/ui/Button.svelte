<!--
  Bouton du dashboard. Quatre variantes, deux tailles, et c'est tout :
  - primary   : l'action principale de la zone, une seule par zone
  - secondary : les actions courantes
  - ghost     : les actions discretes (annuler, fermer, liens d'appoint)
  - danger    : supprimer, revoquer, reinitialiser
  Avec `href`, il rend un lien qui a l'apparence d'un bouton.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Papicon from '../Papicon.svelte';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

  // Avertissement propre aux custom elements, que le dashboard n'emploie pas :
  // svelte.config.ts le filtre déjà à la compilation, le lint ne lit pas ce filtre.
  // svelte-ignore custom_element_props_identifier
  const {
    variant = 'secondary',
    size = 'md',
    icon = '',
    iconRight = '',
    loading = false,
    fullWidth = false,
    href = undefined,
    target = undefined,
    type = 'button',
    disabled = false,
    class: className = '',
    children,
    ...rest
  }: {
    variant?: Variant;
    size?: 'sm' | 'md';
    /** Icone avant le libelle. Seule, sans libelle, le bouton devient carre : passer alors `aria-label`. */
    icon?: string;
    iconRight?: string;
    /** Affiche un indicateur et bloque le clic pendant une action en cours. */
    loading?: boolean;
    fullWidth?: boolean;
    href?: string;
    /** Avec `href` : `_blank` ouvre un nouvel onglet (rel=noopener pose d'office). */
    target?: string;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    class?: string;
    children?: Snippet;
  } & Omit<HTMLButtonAttributes, 'type' | 'disabled' | 'class'> = $props();

  const VARIANT_CLASS: Record<Variant, string> = {
    primary: 'btn-primary',
    secondary: 'btn-tonal',
    ghost: 'btn-ghost',
    danger: 'btn-danger',
  };

  const iconSize = $derived(size === 'sm' ? 13 : 15);
  const iconOnly = $derived(!children && !!icon);
  const classes = $derived(
    [
      'btn',
      VARIANT_CLASS[variant],
      size === 'sm' ? 'btn-sm' : '',
      iconOnly ? 'btn-icon' : '',
      fullWidth ? 'w-full' : '',
      className,
    ].filter(Boolean).join(' '),
  );
</script>

{#snippet content()}
  {#if loading}
    <span class="btn-spinner" aria-hidden="true"></span>
  {:else if icon}
    <Papicon {icon} size={iconSize} />
  {/if}
  {@render children?.()}
  {#if iconRight}
    <Papicon icon={iconRight} size={iconSize} />
  {/if}
{/snippet}

{#if href && !disabled}
  <a
    {href}
    {target}
    rel={target === '_blank' ? 'noopener noreferrer' : undefined}
    class={classes}
    {...rest as Record<string, unknown>}
  >
    {@render content()}
  </a>
{:else}
  <button
    {type}
    class={classes}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    {...rest}
  >
    {@render content()}
  </button>
{/if}
