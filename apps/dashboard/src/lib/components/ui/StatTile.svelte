<!--
  Chiffre clé en tête de page : une icône teintée, une valeur, un libellé.
  `tone` porte les classes de fond et de texte de la pastille d'icône.
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';

  const {
    icon,
    tone,
    value,
    label,
  }: {
    icon: string;
    tone: string;
    value: string | number;
    label: string;
  } = $props();
</script>

<div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
  <div class="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 {tone}">
    <Papicon {icon} size={20} />
  </div>
  <div class="flex flex-col min-w-0">
    <span class="text-xl font-bold text-on-surface truncate">{value}</span>
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
  </div>
</div>
