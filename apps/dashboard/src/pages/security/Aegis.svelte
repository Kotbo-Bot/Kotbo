<script lang="ts">
  /**
   * Sécurité > AegisAI.
   *
   * Ancien onglet « IA · AegisAI » de Filtres : il porte sa propre
   * configuration (AegisConfig), sa file de revue et ses modules dérivés, ce
   * qui en faisait une page dans la page. Le droit reste celui d'AutoMod, qui
   * garde aussi les routes `/aegis*` de l'API.
   *
   * AutoMod est gratuit, l'IA non : le bot la lit comme éteinte sur `FREE`
   * (`aegisConfig.ts`). La page reste réglable, l'encadré dit pourquoi rien ne
   * part.
   */
  import { m } from '../../lib/i18n';
  import ModulePage from '../../lib/components/ModulePage.svelte';
  import AegisPanel from '../../lib/components/aegis/AegisPanel.svelte';
  import Callout from '../../lib/components/ui/Callout.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import { dashboardStore } from '../../lib/stores/dashboard.svelte';

  const onFreePlan = $derived(dashboardStore.state.plan === 'FREE');
</script>

<ModulePage title={m.aegis_title()} description={m.aegis_subtitle()} icon="sparkles" featureKey="automod">
  {#if onFreePlan}
    <Callout variant="info" icon="Lock" title="L'IA de modération fait partie de l'offre complète">
      AutoMod et ses filtres tournent en gratuit. AegisAI lit le ton des messages, repère le harcèlement et la toxicité : règle-le dès maintenant, il s'active avec l'abonnement.
      {#snippet actions()}
        <Button href="/billing" variant="primary" size="sm" iconRight="ArrowRight">Voir les offres</Button>
      {/snippet}
    </Callout>
  {/if}
  <AegisPanel />
</ModulePage>
