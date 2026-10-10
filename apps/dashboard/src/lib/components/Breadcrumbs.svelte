<script lang="ts">
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import { buildCrumbs } from '../breadcrumbs';
  import { m } from '../i18n';

  // On phones the top bar already states where you are and how to go back, so
  // this strip is desktop and tablet only (hidden via app.css).
  const crumbs = $derived(buildCrumbs($router.path));

  /**
   * « Accueil / Membres » au-dessus d'un titre « Membres » ne disait rien que
   * la page ne dise deja, et le menu montre ou l'on se trouve. Il ne reste
   * qu'un lien vers la page parente, et seulement quand il y en a une autre
   * que l'accueil : une fiche de membre, un evenement en cours d'edition.
   */
  const parent = $derived(crumbs.length > 2 ? crumbs[crumbs.length - 2] : null);
</script>

{#if parent}
  <nav class="breadcrumbs mb-4 select-none" aria-label="Fil d’Ariane">
    <a
      href={parent.href}
      class="inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded-md text-body-sm text-on-surface-variant hover:text-on-surface transition-colors"
    >
      <Papicon icon="chevron-left" size={14} />
      {m.nav_back_to({ page: parent.name })}
    </a>
  </nav>
{/if}
