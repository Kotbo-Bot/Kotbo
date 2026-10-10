<script lang="ts">
  /**
   * Sécurité > AegisAI.
   *
   * Ancien onglet « IA · AegisAI » de Filtres : il porte sa propre
   * configuration (AegisConfig), sa file de revue et ses modules dérivés, ce
   * qui en faisait une page dans la page. Le droit reste celui d'AutoMod, qui
   * garde aussi les routes `/aegis*` de l'API.
   */
  import { m } from '../../lib/i18n';
  import ModulePage from '../../lib/components/ModulePage.svelte';
  import AegisPanel from '../../lib/components/aegis/AegisPanel.svelte';
</script>

<ModulePage title={m.aegis_title()} description={m.aegis_subtitle()} icon="sparkles" featureKey="automod">
  <AegisPanel />
</ModulePage>
