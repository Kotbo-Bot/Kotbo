<!--
  Journal de l'AutoMod natif de Discord : règles Kotbo comme règles propres au
  serveur. Réutilisé dans Sanctions, Détections et Journaux ; `compact` ne
  garde que le résumé (utile dans une carte d'analytics).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Skeleton from '../Skeleton.svelte';
  import BarList from '../analytics/BarList.svelte';
  import { fmtNumber } from '../analytics/analyticsFormat';
  import { EmptyState, FilterPills, SectionCard, type FilterOption } from '../ui';
  import { m, dateLocale } from '../../i18n';
  import { fetchDiscordAutomodEvents, type DiscordAutomodReport } from '../../api';

  let { compact = false, userId = undefined }: { compact?: boolean; userId?: string } = $props();

  let days = $state('7');
  let report = $state<DiscordAutomodReport | null>(null);
  let loading = $state(true);
  let failed = $state(false);

  const periodOptions = $derived<FilterOption[]>([
    { value: '7', label: m.dam_period_7() },
    { value: '30', label: m.dam_period_30() },
    { value: '90', label: m.dam_period_90() },
  ]);

  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const actionLabel = (a: string) => (a === 'BLOCK' ? m.dam_action_block() : a === 'TIMEOUT' ? m.dam_action_timeout() : m.dam_action_alert());

  async function load() {
    loading = true;
    failed = false;
    try {
      report = await fetchDiscordAutomodEvents({ days: Number(days), userId, limit: compact ? 1 : 100 });
      failed = report === null;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-body-sm text-on-surface-variant">{m.dam_desc()}</p>
    <FilterPills label={m.dam_period()} options={periodOptions} value={days} onchange={(value) => { days = value; load(); }} />
  </div>

  {#if loading && !report}
    <Skeleton class="h-48 w-full" />
  {:else if failed || !report}
    <p class="text-body-sm text-error" role="alert">{m.dam_error()}</p>
  {:else if report.total === 0}
    <EmptyState icon="check-circle" title={m.dam_empty_title()} description={m.dam_empty_desc()} reason="all-clear" />
  {:else}
    <div class="grid gap-6 lg:grid-cols-2">
      <SectionCard title={m.dam_by_rule({ total: fmtNumber(report.total) })}>
        <div class="p-4">
          <BarList items={report.byRule.map((r) => ({ id: r.ruleId, label: r.ruleName, value: r.count, sub: r.managed ? m.dam_kotbo() : m.dam_server() }))} empty="" />
        </div>
      </SectionCard>
      <SectionCard title={m.dam_top_users()}>
        <div class="p-4">
          <BarList items={report.topUsers.map((u) => ({ id: u.userId, label: u.name, value: u.count }))} empty="" />
        </div>
      </SectionCard>
    </div>

    {#if !compact}
      <SectionCard title={m.dam_events()} flush>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm" aria-label={m.dam_events()}>
            <thead class="text-xs uppercase text-on-surface-variant">
              <tr>
                <th class="px-4 py-3">{m.dam_col_date()}</th>
                <th class="px-4 py-3">{m.dam_col_member()}</th>
                <th class="px-4 py-3">{m.dam_col_rule()}</th>
                <th class="px-4 py-3">{m.dam_col_action()}</th>
                <th class="px-4 py-3">{m.dam_col_match()}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant">
              {#each report.events as event (event.id)}
                <tr>
                  <td class="px-4 py-3 whitespace-nowrap text-on-surface-variant">{formatDate(event.createdAt)}</td>
                  <td class="px-4 py-3">{event.user.name}</td>
                  <td class="px-4 py-3">{event.ruleName}</td>
                  <td class="px-4 py-3">{actionLabel(event.action)}</td>
                  <td class="px-4 py-3 max-w-xs truncate" title={event.content ?? ''}>{event.keyword ?? event.content ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SectionCard>
    {/if}
  {/if}
</div>
