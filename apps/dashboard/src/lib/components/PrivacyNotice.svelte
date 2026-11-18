<script lang="ts">
  import { m } from '../i18n';
  const {
    text,
    compact = false,
    showDpa = false,
  } = $props<{ text?: string; compact?: boolean; showDpa?: boolean }>();
</script>

<div class="rounded-lg border border-outline-variant/30 bg-surface-container-low/40 text-on-surface-variant {compact ? 'px-3 py-2 text-2xs' : 'px-4 py-3 text-xs'} leading-relaxed">
  <span>{text ?? m.d1_privacy_default_text()}</span>{' '}
  <a href="https://kotbo.fr/terms" target="_blank" rel="noopener noreferrer" class="font-semibold text-primary hover:underline">{m.d1_privacy_link()}</a>
  <span aria-hidden="true"> · </span>
  {#if showDpa}
    <a href="https://kotbo.fr/dpa" target="_blank" rel="noopener noreferrer" class="font-semibold text-primary hover:underline">{m.d1_gdpr_link()}</a>
    <span aria-hidden="true"> · </span>
  {/if}
  <a href="https://kotbo.fr/cookies" target="_blank" rel="noopener noreferrer" class="font-semibold text-primary hover:underline">{m.d1_cookies_link()}</a>
</div>
