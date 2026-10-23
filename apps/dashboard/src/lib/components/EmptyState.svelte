<!--
  Un ecran vide n'est pas une impasse : il dit pourquoi il n'y a rien et quelle
  est la prochaine etape, avec le bouton pour la faire. « Aucune donnée » tout
  seul abandonne l'utilisateur la ou il hesite le plus.

    <EmptyState
      title="Aucune annonce pour l'instant"
      description="Une annonce part dans le salon de ton choix, tout de suite ou à l'heure prévue."
      actionLabel="Créer ma première annonce"
      onAction={() => (editorOpen = true)}
    />

  Pour une action plus riche (plusieurs boutons, un menu), passer le snippet `action`.

  Sans action, l'ecran dit pourquoi avec `reason` - c'est ce que le garde-fou
  uxGuard.test.ts verifie :
  - `all-clear`       : bonne nouvelle, rien a traiter (icone teintee en vert) ;
  - `accumulating`    : les donnees arrivent avec le temps, rien a faire ;
  - `nothing-matches` : le filtre ou la recherche ne trouve rien ;
  - `read-only`       : la personne n'a pas les droits pour agir ici ;
  - `instruction`     : l'ecran explique quoi faire avec les controles au-dessus.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Papicon from './Papicon.svelte';
  import Button from './ui/Button.svelte';

  const {
    icon = 'inbox',
    title = 'Rien à afficher',
    description = '',
    action,
    actionLabel = '',
    actionHref = undefined,
    actionIcon = 'plus',
    onAction = undefined,
    reason = undefined,
  }: {
    icon?: string;
    title?: string;
    description?: string;
    /** Bouton ou lien d'action optionnel affiché sous le message */
    action?: Snippet;
    /** Libellé de l'étape suivante : « Créer mon premier ticket », pas « Créer ». */
    actionLabel?: string;
    actionHref?: string;
    actionIcon?: string;
    onAction?: () => void;
    /** Pourquoi il n'y a pas d'action : voir l'en-tete. */
    reason?: 'all-clear' | 'accumulating' | 'nothing-matches' | 'read-only' | 'instruction';
  } = $props();
</script>

<div class="flex flex-col items-center justify-center text-center py-14 px-6 gap-1.5">
  <div class="w-12 h-12 rounded-full flex items-center justify-center mb-2 {reason === 'all-clear' ? 'bg-success/10 text-success' : 'bg-surface-container text-on-surface-variant'}">
    <Papicon {icon} size={22} />
  </div>
  <p class="text-sm font-medium text-on-surface">{title}</p>
  {#if description}
    <p class="text-body-sm text-on-surface-variant max-w-sm leading-relaxed">{description}</p>
  {/if}
  {#if action}
    <div class="mt-3">
      {@render action()}
    </div>
  {:else if actionLabel && (actionHref || onAction)}
    <div class="mt-3">
      <Button variant="primary" icon={actionIcon} href={actionHref} onclick={onAction}>{actionLabel}</Button>
    </div>
  {/if}
</div>
