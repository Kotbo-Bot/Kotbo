<!--
  Adaptateur Kotbo pour le tableau de cohortes (@kotbo/ui/analytics CohortTable) :
  charge les cohortes d'activité selon le filtre global et alimente l'export.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { CohortTable as KotboCohortTable } from '@kotbo/ui/analytics';
  import { fetchActivityCohorts, type ActivityCohorts } from '../../api';
  import { m } from '../../i18n';
  import { analyticsExport, analyticsFilters as filters } from './analyticsFilters.svelte';

  let data = $state<ActivityCohorts | null>(null);
  let failed = $state(false);
  let loading = $state(true);

  $effect(() => {
    const query = filters.query;
    untrack(() => {
      failed = false;
      loading = true;
      fetchActivityCohorts(query)
        .then((res) => {
          data = res;
          analyticsExport.activityCohorts = res;
        })
        .catch(() => {
          failed = true;
        })
        .finally(() => {
          loading = false;
        });
    });
  });
</script>

<KotboCohortTable
  title={m.anx_cohort_title()}
  description={m.anx_cohort_desc()}
  cohorts={data?.cohorts ?? []}
  weeks={data?.weeks ?? 0}
  {loading}
  error={failed ? m.an_error_generic() : ''}
  notice={data?.channelIgnored ? m.anx_channel_filter_ignored() : ''}
/>
