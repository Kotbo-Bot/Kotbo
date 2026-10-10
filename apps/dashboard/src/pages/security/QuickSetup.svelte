<script lang="ts">
  /**
   * Securite > Configuration rapide : les niveaux de protection, seuls.
   *
   * Ils reglent d'un coup les filtres AutoMod et les seuils anti-raid, donc ils
   * ne relevent d'aucune page thematique. Ils vivaient en tete de la vue
   * d'ensemble, ou ils passaient derriere le score d'audit ; leur propre entree
   * de menu en fait le chemin le plus court pour qui veut se proteger sans rien
   * regler en detail.
   */
  import ModulePage from '../../lib/components/ModulePage.svelte';
  import SecurityQuickSetup from '../../lib/components/security/SecurityQuickSetup.svelte';
</script>

<ModulePage
  title="Configuration rapide"
  description="Un niveau de protection règle d'un coup les filtres et l'anti-raid"
  icon="Sparkles"
  featureKey="automod"
>
  <SecurityQuickSetup />
</ModulePage>
