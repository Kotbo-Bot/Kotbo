<!--
  Badge de booster, les vrais de Discord : la forme de la gemme change avec
  l'ancienneté du boost (1, 2, 3, 6, 9, 12, 15, 18, 24 mois). Durée exacte et
  palier suivant au survol.
-->
<script lang="ts">
  import { boostBadge } from '@kotbo/contracts';
  import { m, dateLocale } from '../i18n';

  const { since, size = 13 }: { since: string; size?: number } = $props();

  const badge = $derived(boostBadge(since));
  const date = $derived(new Date(since).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' }));
  const title = $derived(
    [
      m.boost_badge_title({ date, months: String(badge.months) }),
      badge.nextMonths ? m.boost_badge_next({ months: String(badge.nextMonths) }) : null,
    ].filter(Boolean).join('\n'),
  );
</script>

<span class="booster-badge" {title} role="img" aria-label={title}>
  <!-- Les vrais badges Boost de Discord, copiés dans `public/boost-badges` (un par palier). -->
  <img src="/boost-badges/{badge.step}.png" alt="" width={size} height={size} />
</span>

<style>
  .booster-badge {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
  }
</style>
