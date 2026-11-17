<!--
  Badge de booster, comme sur Discord : la gemme change de teinte avec
  l'ancienneté du boost (1, 2, 3, 6, 9, 12, 15, 18, 24 mois). Durée exacte et
  palier suivant au survol.
-->
<script lang="ts">
  import { boostBadge } from '@kotbo/contracts';
  import Papicon from './Papicon.svelte';
  import { m, dateLocale } from '../i18n';

  const { since, size = 13 }: { since: string; size?: number } = $props();

  // Une teinte par palier, du rose du premier mois à l'orange des deux ans.
  const STEP_COLORS = ['#f47fff', '#e879f9', '#c084fc', '#a78bfa', '#818cf8', '#60a5fa', '#22d3ee', '#fbbf24', '#f97316'];

  const badge = $derived(boostBadge(since));
  const date = $derived(new Date(since).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' }));
  const title = $derived(
    [
      m.boost_badge_title({ date, months: String(badge.months) }),
      badge.nextMonths ? m.boost_badge_next({ months: String(badge.nextMonths) }) : null,
    ].filter(Boolean).join('\n'),
  );
</script>

<span class="booster-badge" style="color: {STEP_COLORS[badge.step]}" {title} role="img" aria-label={title}>
  <Papicon icon="gem" {size} />
</span>

<style>
  .booster-badge {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
  }
</style>
