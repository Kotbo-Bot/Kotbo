<script lang="ts">
  const { message }: { message: string } = $props();
</script>

<!-- Affiche pendant le mode simple quand la configuration enregistree ne tombe
     sur aucun cran : le curseur montre alors le plus proche, qui n'est pas la
     valeur reelle. On le dit plutot que de modifier la configuration d'office. -->
<p class="p-3 bg-warning/10 border border-warning/20 rounded-lg text-2xs text-on-warning-container leading-relaxed">
  {message}
</p>
