<!--
  Tutorat : une seule route `/tutoring/*`, trois vues. Les routes de Tinro ne
  s'excluent pas : `/tutoring/programs` et `/tutoring/:id` déclarées à côté
  s'afficheraient l'une sous l'autre.
-->
<script lang="ts">
  import { router } from 'tinro';
  import TutoringHome from '../lib/components/tutoring/TutoringHome.svelte';
  import TutoringPeriodView from '../lib/components/tutoring/TutoringPeriodView.svelte';
  import TutoringPrograms from '../lib/components/tutoring/TutoringPrograms.svelte';

  const segment = $derived($router.path.replace(/^\/tutoring\/?/, '').split('/')[0] ?? '');
</script>

{#if segment === ''}
  <TutoringHome />
{:else if segment === 'programs'}
  <TutoringPrograms />
{:else}
  {#key segment}
    <TutoringPeriodView periodId={segment} />
  {/key}
{/if}
