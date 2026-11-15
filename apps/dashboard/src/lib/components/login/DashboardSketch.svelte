<script lang="ts">
  /**
   * Croquis du tableau de bord, trace « au crayon ».
   *
   * La page de connexion ne peut montrer aucune vraie capture : le visiteur
   * n'est pas encore authentifie, et un screenshot figé vieillirait a chaque
   * refonte du dashboard. Un wireframe assume l'inverse - il promet une forme,
   * pas un pixel - et se met a jour en changeant trois coordonnees.
   *
   * L'irregularite du trait vient d'un `feDisplacementMap` applique aux seuls
   * traits : le texte des annotations reste net, sinon les libelles devenaient
   * illisibles en dessous de 13px. L'amplitude est volontairement basse
   * (`scale` ~1.4) pour rester du cote « esquisse propre » plutot que gribouilli.
   *
   * Le SVG est decoratif (`aria-hidden`) : les trois arguments qu'il illustre
   * sont repris en texte par la page, qui reste donc lisible au lecteur d'ecran
   * et quand les images ne se chargent pas.
   */
  const {
    labelServers,
    labelAnalytics,
    labelLogs,
    class: className = ''
  } = $props<{
    labelServers: string;
    labelAnalytics: string;
    labelLogs: string;
    class?: string;
  }>();
</script>

<svg
  viewBox="0 0 600 400"
  class="dashboard-sketch {className}"
  fill="none"
  aria-hidden="true"
  focusable="false"
>
  <defs>
    <filter id="sketch-pencil" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="2" seed="7" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" xChannelSelector="R" yChannelSelector="G" />
    </filter>
    <marker id="sketch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 1 1 L 9 5 L 1 9" class="sketch-accent-stroke" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round" />
    </marker>
  </defs>

  <!-- Tout le trace passe par le filtre ; les libelles, eux, restent nets. -->
  <g filter="url(#sketch-pencil)" stroke-linecap="round" stroke-linejoin="round">
    <!-- Chassis de la fenetre -->
    <rect x="140" y="80" width="380" height="250" rx="10" class="sketch-ink-strong" stroke-width="1.7" />
    <line x1="140" y1="108" x2="520" y2="108" class="sketch-ink" stroke-width="1.3" />
    <circle cx="158" cy="94" r="3.2" class="sketch-ink" stroke-width="1.3" />
    <circle cx="170" cy="94" r="3.2" class="sketch-ink" stroke-width="1.3" />
    <circle cx="182" cy="94" r="3.2" class="sketch-ink" stroke-width="1.3" />

    <!-- Rail de navigation -->
    <line x1="192" y1="108" x2="192" y2="330" class="sketch-ink" stroke-width="1.3" />
    <rect x="152" y="124" width="30" height="6" rx="3" class="sketch-ink" stroke-width="1.2" />
    <rect x="152" y="140" width="30" height="6" rx="3" class="sketch-ink" stroke-width="1.2" />
    <rect x="152" y="156" width="30" height="6" rx="3" class="sketch-ink" stroke-width="1.2" />
    <rect x="152" y="172" width="22" height="6" rx="3" class="sketch-ink" stroke-width="1.2" />

    <!-- Carte principale : la courbe d'activite -->
    <rect x="204" y="122" width="304" height="92" rx="8" class="sketch-ink" stroke-width="1.4" />
    <line x1="218" y1="136" x2="262" y2="136" class="sketch-ink-faint" stroke-width="1.2" />
    <line x1="218" y1="204" x2="494" y2="204" class="sketch-ink-faint" stroke-width="1.1" stroke-dasharray="3 5" />
    <path
      d="M 220 194 L 252 170 L 284 180 L 316 150 L 348 160 L 380 136 L 412 152 L 444 130 L 476 140"
      class="sketch-accent-stroke"
      stroke-width="2"
    />
    <circle cx="476" cy="140" r="3.4" class="sketch-accent-fill" />

    <!-- Carte secondaire gauche : histogramme -->
    <rect x="204" y="226" width="146" height="48" rx="8" class="sketch-ink" stroke-width="1.4" />
    <line x1="216" y1="264" x2="338" y2="264" class="sketch-ink-faint" stroke-width="1.1" />
    <line x1="224" y1="264" x2="224" y2="248" class="sketch-ink-strong" stroke-width="3.4" />
    <line x1="242" y1="264" x2="242" y2="240" class="sketch-ink-strong" stroke-width="3.4" />
    <line x1="260" y1="264" x2="260" y2="252" class="sketch-ink-strong" stroke-width="3.4" />
    <line x1="278" y1="264" x2="278" y2="238" class="sketch-accent-stroke" stroke-width="3.4" />
    <line x1="296" y1="264" x2="296" y2="246" class="sketch-ink-strong" stroke-width="3.4" />

    <!-- Carte secondaire droite : repartition -->
    <rect x="362" y="226" width="146" height="48" rx="8" class="sketch-ink" stroke-width="1.4" />
    <circle cx="394" cy="250" r="15" class="sketch-ink" stroke-width="1.6" />
    <path d="M 394 235 A 15 15 0 0 1 407 258" class="sketch-accent-stroke" stroke-width="2.6" />
    <line x1="424" y1="242" x2="488" y2="242" class="sketch-ink-faint" stroke-width="1.2" />
    <line x1="424" y1="252" x2="470" y2="252" class="sketch-ink-faint" stroke-width="1.2" />
    <line x1="424" y1="262" x2="480" y2="262" class="sketch-ink-faint" stroke-width="1.2" />

    <!-- Bandeau du journal -->
    <rect x="204" y="286" width="304" height="32" rx="8" class="sketch-ink" stroke-width="1.4" />
    <circle cx="220" cy="302" r="3.2" class="sketch-accent-fill" />
    <line x1="234" y1="298" x2="352" y2="298" class="sketch-ink-faint" stroke-width="1.2" />
    <line x1="234" y1="307" x2="300" y2="307" class="sketch-ink-faint" stroke-width="1.2" />
    <line x1="470" y1="302" x2="494" y2="302" class="sketch-ink-faint" stroke-width="1.2" />

    <!-- Fleches d'annotation -->
    <path d="M 128 146 C 146 150 154 152 166 152" class="sketch-accent-stroke" stroke-width="1.4" marker-end="url(#sketch-arrow)" />
    <path d="M 528 62 C 508 86 494 116 482 142" class="sketch-accent-stroke" stroke-width="1.4" marker-end="url(#sketch-arrow)" />
    <path d="M 352 372 C 344 352 340 336 336 322" class="sketch-accent-stroke" stroke-width="1.4" marker-end="url(#sketch-arrow)" />
  </g>

  <!-- Libelles hors filtre : le crayon tremble, pas le texte. -->
  <text x="120" y="142" text-anchor="end" class="sketch-label">{labelServers}</text>
  <text x="592" y="52" text-anchor="end" class="sketch-label">{labelAnalytics}</text>
  <text x="362" y="380" text-anchor="start" class="sketch-label">{labelLogs}</text>
</svg>

<style>
  .dashboard-sketch {
    width: 100%;
    height: auto;
    color: var(--on-surface-variant);
  }

  .sketch-ink-strong {
    stroke: currentColor;
    opacity: 0.7;
  }

  .sketch-ink {
    stroke: currentColor;
    opacity: 0.45;
  }

  .sketch-ink-faint {
    stroke: currentColor;
    opacity: 0.28;
  }

  .sketch-accent-stroke {
    stroke: var(--primary-color);
  }

  .sketch-accent-fill {
    fill: var(--primary-color);
  }

  .sketch-label {
    fill: var(--on-surface-variant);
    font-family: var(--font-body);
    font-size: 13px;
    font-style: italic;
    letter-spacing: 0.01em;
  }

  /* En dessous de `lg` la page masque le croquis, mais un zoom texte important
     peut le laisser visible sur une colonne etroite : les libelles tomberaient
     alors sous la barre des 11px effectifs. On les remonte plutot que de les
     laisser retrecir avec le viewBox. */
  @media (max-width: 1280px) {
    .sketch-label {
      font-size: 14px;
    }
  }
</style>
