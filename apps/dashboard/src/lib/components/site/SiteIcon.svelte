<script lang="ts">
  /** Icône du jeu partagé avec le site public (tracés fixes, générés depuis Lucide). */
  import { siteIconSvg, type SiteIconName } from '@kotbo/shared';

  let { name, size = 18 }: { name: SiteIconName; size?: number } = $props();
</script>

<!-- Contenu sûr : SVG constant du paquet partagé, aucune donnée saisie. -->
<span class="site-icon" aria-hidden="true">{@html siteIconSvg(name, size)}</span>

<style>
  .site-icon { display: inline-flex; flex: none; line-height: 0; }
</style>
