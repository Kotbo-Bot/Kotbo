<!--
  Échelle de toxicité de 0 à 100 avec ses trois zones : rien, à vérifier,
  action automatique. Un repère optionnel montre où tombe un score (essai
  d'une phrase, détection).
-->
<script lang="ts">
  import { m } from '../../i18n';

  const {
    review,
    auto,
    marker = null,
  }: {
    review: number;
    auto: number;
    /** Score à situer, en points (0-100). */
    marker?: number | null;
  } = $props();

  const clamp = (v: number) => Math.min(100, Math.max(0, v));
</script>

<div class="scale" role="img" aria-label={`${m.aegis_scale_label()} : ${m.aegis_zone_review()} ${review}, ${m.aegis_zone_auto()} ${auto}${marker !== null ? `, ${marker}` : ''}`}>
  <div class="scale__track">
    <span class="scale__zone scale__zone--none" style="width: {clamp(review)}%;"></span>
    <span class="scale__zone scale__zone--review" style="width: {clamp(auto) - clamp(review)}%;"></span>
    <span class="scale__zone scale__zone--auto" style="width: {100 - clamp(auto)}%;"></span>
    {#if marker !== null}
      <span class="scale__marker" style="left: {clamp(marker)}%;" aria-hidden="true"></span>
    {/if}
  </div>
  <div class="scale__labels" aria-hidden="true">
    <span style="left: 0;">0</span>
    <span style="left: {clamp(review)}%;">{review}</span>
    <span style="left: {clamp(auto)}%;">{auto}</span>
    <span style="left: 100%;">100</span>
  </div>
  <div class="scale__legend" aria-hidden="true">
    <span><i class="dot dot--none"></i>{m.aegis_zone_none()}</span>
    <span><i class="dot dot--review"></i>{m.aegis_zone_review()}</span>
    <span><i class="dot dot--auto"></i>{m.aegis_zone_auto()}</span>
  </div>
</div>

<style>
  .scale {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .scale__track {
    position: relative;
    display: flex;
    height: 0.625rem;
    border-radius: 999px;
    overflow: visible;
  }

  .scale__zone {
    height: 100%;
    transition: width 150ms ease;
  }

  .scale__zone--none {
    border-radius: 999px 0 0 999px;
    background: color-mix(in srgb, var(--color-success) 35%, var(--color-surface-container));
  }

  .scale__zone--review {
    background: color-mix(in srgb, var(--color-warning) 55%, var(--color-surface-container));
  }

  .scale__zone--auto {
    border-radius: 0 999px 999px 0;
    background: color-mix(in srgb, var(--color-error) 60%, var(--color-surface-container));
  }

  .scale__marker {
    position: absolute;
    top: -0.3125rem;
    width: 0.25rem;
    height: 1.25rem;
    border-radius: 999px;
    background: var(--color-on-surface);
    box-shadow: 0 0 0 2px var(--color-surface);
    transform: translateX(-50%);
    transition: left 200ms ease;
  }

  .scale__labels {
    position: relative;
    height: 1rem;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface-variant);
  }

  .scale__labels span {
    position: absolute;
    transform: translateX(-50%);
  }

  .scale__labels span:first-child {
    transform: none;
  }

  .scale__labels span:last-child {
    transform: translateX(-100%);
  }

  .scale__legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .scale__legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .dot {
    display: inline-block;
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 999px;
  }

  .dot--none {
    background: color-mix(in srgb, var(--color-success) 35%, var(--color-surface-container));
  }

  .dot--review {
    background: color-mix(in srgb, var(--color-warning) 55%, var(--color-surface-container));
  }

  .dot--auto {
    background: color-mix(in srgb, var(--color-error) 60%, var(--color-surface-container));
  }
</style>
