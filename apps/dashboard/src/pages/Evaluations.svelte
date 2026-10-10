<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchEvaluations, generateEvaluation } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';

  let loading = $state(true);
  let generating = $state(false);
  let data: any = $state(null);

  async function load() {
    loading = true;
    try {
      data = await fetchEvaluations();
    } catch {
      toast.error('Erreur lors du chargement');
    } finally {
      loading = false;
    }
  }

  async function handleGenerateAll() {
    generating = true;
    try {
      const result = await generateEvaluation(undefined, 30);
      toast.success(`${result.count} évaluations générées`);
      await load();
    } catch {
      toast.error('Erreur lors de la génération');
    } finally {
      generating = false;
    }
  }

  function getScoreColor(score: number): string {
    if (score >= 80) return '#10b981';
    if (score >= 60) return 'var(--primary-color)';
    if (score >= 40) return '#f59e0b';
    return '#f43f5e';
  }

  function getTrendIcon(trend: string): string {
    if (trend === 'UP') return 'trending-up';
    if (trend === 'DOWN') return 'trending-down';
    return 'minus';
  }

  function getTrendClass(trend: string): string {
    if (trend === 'UP') return 'text-success';
    if (trend === 'DOWN') return 'text-error';
    return 'text-on-surface-variant';
  }

  onMount(load);
</script>

<ModulePage
  title="Évaluations Staff"
  description="Rapports de performance automatisés."
  icon="award"
  featureKey="evaluations"
>
  {#snippet actions()}
    <button
      class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
      onclick={handleGenerateAll}
      disabled={generating}
    >
      <Papicon icon="zap" size={16} />
      {generating ? 'Génération…' : 'Générer toutes'}
    </button>
  {/snippet}

<!-- ======================== CONTENT ======================== -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/50 gap-4">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    <p class="text-sm">Chargement des donnees...</p>
  </div>
{:else if data}

  <!-- ==================== OVERVIEW METRICS ==================== -->
  {#if data.averageScore > 0}
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 mb-6">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
          <div class="w-20 h-20 rounded-full border-[5px] flex flex-col items-center justify-center mx-auto mb-2" style="border-color: {getScoreColor(data.averageScore)}">
            <span class="text-2xl font-bold text-on-surface leading-none">{data.averageScore}</span>
            <span class="text-2xs text-on-surface-variant/60">/100</span>
          </div>
          <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Score moyen</div>
        </div>
        <div class="bg-surface-container-high/30 rounded-xl p-4 text-center flex flex-col items-center justify-center">
          <span class="text-3xl font-bold text-on-surface">{data.latestByStaff.length}</span>
          <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Staff evalues</div>
        </div>
        <div class="bg-surface-container-high/30 rounded-xl p-4 text-center flex flex-col items-center justify-center">
          <span class="text-3xl font-bold text-on-surface">{data.evaluations.length}</span>
          <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Evaluations totales</div>
        </div>
      </div>
    </div>
  {/if}

  <!-- ==================== SCORE TABLE ==================== -->
  {#if data.latestByStaff.length > 0}
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4 mb-6">
      <h3 class="text-base font-semibold flex items-center gap-2.5">Dernieres evaluations par staff</h3>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="border-b border-outline-variant/10">
              <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">Staff</th>
              <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">Activite</th>
              <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">Moderation</th>
              <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">Presence</th>
              <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">Global</th>
              <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">Tendance</th>
              <th class="px-3 py-2.5 text-left text-xs font-medium text-on-surface-variant/60">Periode</th>
            </tr>
          </thead>
          <tbody>
            {#each data.latestByStaff as ev}
              <tr class="border-b border-outline-variant/5 hover:bg-surface-container-high/10 transition-colors">
                <td class="px-3 py-2.5 font-mono text-xs text-on-surface-variant/60">{ev.staffUserId}</td>
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold" style="color: {getScoreColor(ev.activityScore)}">{ev.activityScore}</span>
                    <div class="flex-1 min-w-12">
                      <div class="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                        <div class="h-1.5 rounded-full transition-all duration-500" style="width: {ev.activityScore}%; background: {getScoreColor(ev.activityScore)}"></div>
                      </div>
                    </div>
                  </div>
                </td>
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold" style="color: {getScoreColor(ev.moderationScore)}">{ev.moderationScore}</span>
                    <div class="flex-1 min-w-12">
                      <div class="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                        <div class="h-1.5 rounded-full transition-all duration-500" style="width: {ev.moderationScore}%; background: {getScoreColor(ev.moderationScore)}"></div>
                      </div>
                    </div>
                  </div>
                </td>
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold" style="color: {getScoreColor(ev.presenceScore)}">{ev.presenceScore}</span>
                    <div class="flex-1 min-w-12">
                      <div class="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                        <div class="h-1.5 rounded-full transition-all duration-500" style="width: {ev.presenceScore}%; background: {getScoreColor(ev.presenceScore)}"></div>
                      </div>
                    </div>
                  </div>
                </td>
                <td class="px-3 py-2.5">
                  <span class="text-sm font-bold" style="color: {getScoreColor(ev.overallScore)}">{ev.overallScore}</span>
                </td>
                <td class="px-3 py-2.5">
                  <span class="flex items-center gap-1 text-xs font-semibold {getTrendClass(ev.trend)}">
                    <Papicon icon={getTrendIcon(ev.trend)} size={14} />
                    {ev.trendDelta > 0 ? '+' : ''}{ev.trendDelta}
                  </span>
                </td>
                <td class="px-3 py-2.5 text-xs text-on-surface-variant/60">
                  {new Date(ev.periodStart).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} &mdash; {new Date(ev.periodEnd).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {:else}
    <!-- Empty state -->
    <EmptyState icon="award" title="Aucune évaluation générée" description="Clique sur « Générer toutes » pour créer les premières évaluations." />
  {/if}

  <!-- ==================== HISTORY ==================== -->
  {#if data.evaluations.length > data.latestByStaff.length}
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">Historique complet</h3>
      <div class="space-y-0.5">
        {#each data.evaluations as ev}
          <div class="flex items-center gap-3 py-2.5 px-3 border-b border-outline-variant/5 last:border-b-0 hover:bg-surface-container-high/10 transition-colors rounded-lg">
            <span class="font-mono text-xs text-on-surface-variant/60 shrink-0">{ev.staffUserId}</span>
            <span class="text-sm font-bold shrink-0" style="color: {getScoreColor(ev.overallScore)}">{ev.overallScore}/100</span>
            <span class="flex-1 min-w-0 text-xs text-on-surface-variant/60 truncate">
              {ev.totalMessages} msg, {Math.round(ev.totalVoiceMinutes / 60)}h vocal, {ev.sanctionsHandled} sanctions, {ev.ticketsResolved} tickets
            </span>
            <span class="text-xs text-on-surface-variant/60 shrink-0">{new Date(ev.createdAt).toLocaleDateString('fr-FR')}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/if}
</ModulePage>
