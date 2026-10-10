<script lang="ts">
  import { Tabs } from '../lib/components/ui';
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardFetch } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import Chart from '../lib/components/charts/Chart.svelte';

  const { formId }: { formId: string } = $props();

  interface Submission {
    id: string;
    userId: string | null;
    username: string | null;
    userTag: string | null;
    avatarUrl: string | null;
    data: Record<string, unknown>;
    createdAt: string;
  }

  interface FormInfo { id: string; name: string; structure?: any; _count?: { submissions?: number } }

  let form = $state<FormInfo | null>(null);
  let responses = $state<Submission[]>([]);
  let responseTotal = $state(0);
  let loadingMore = $state(false);
  let loading = $state(true);
  let error = $state('');
  let selectedResponse = $state<Submission | null>(null);
  let searchQuery = $state('');
  let activeTab = $state<'list' | 'analytics'>('list');

  const analytics = $derived(() => {
    if (!form || !form.structure || !form.structure.fields || !responses.length) return [];
    
    return form.structure.fields.map((field: any) => {
      const fieldId = field.id;
      const label = field.label;
      const type = field.type;
      
      const fieldResponses = responses.map(r => r.data?.[fieldId]).filter(v => v !== undefined && v !== null && v !== '');
      const totalResponses = fieldResponses.length;
      
      if (['multiple_choice', 'dropdown', 'checkboxes'].includes(type) || field.options?.length) {
        const optionsCount: Record<string, number> = {};
        // Initialize options with 0
        if (field.options) {
          field.options.forEach((opt: string) => {
            optionsCount[opt] = 0;
          });
        }
        
        fieldResponses.forEach(val => {
          if (Array.isArray(val)) {
            val.forEach(v => {
              const strVal = String(v);
              optionsCount[strVal] = (optionsCount[strVal] ?? 0) + 1;
            });
          } else {
            const strVal = String(val);
            optionsCount[strVal] = (optionsCount[strVal] ?? 0) + 1;
          }
        });
        
        return {
          fieldId,
          label,
          type,
          optionsCount,
          totalResponses
        };
      } else if (type === 'number') {
        const nums = fieldResponses.map(Number).filter(n => !isNaN(n));
        if (nums.length === 0) return { fieldId, label, type, totalResponses: 0 };
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        const sum = nums.reduce((a, b) => a + b, 0);
        const average = parseFloat((sum / nums.length).toFixed(2));
        return {
          fieldId,
          label,
          type,
          totalResponses,
          min,
          max,
          average
        };
      } else {
        // Text responses
        const textResponses = fieldResponses.map(String);
        return {
          fieldId,
          label,
          type,
          totalResponses,
          recentResponses: textResponses
        };
      }
    });
  });

  function getChartData(fieldAnalytics: any) {
    const labels = Object.keys(fieldAnalytics.optionsCount || {});
    const counts = Object.values(fieldAnalytics.optionsCount || {});
    
    return {
      labels,
      datasets: [
        {
          label: 'Nombre de réponses',
          data: counts,
          backgroundColor: [
            'rgba(99, 102, 241, 0.6)',
            'rgba(16, 185, 129, 0.6)',
            'rgba(245, 158, 11, 0.6)',
            'rgba(239, 68, 68, 0.6)',
            'rgba(139, 92, 246, 0.6)',
            'rgba(236, 72, 153, 0.6)',
          ],
          borderColor: [
            'rgb(99, 102, 241)',
            'rgb(16, 185, 129)',
            'rgb(245, 158, 11)',
            'rgb(239, 68, 68)',
            'rgb(139, 92, 246)',
            'rgb(236, 72, 153)',
          ],
          borderWidth: 1
        }
      ]
    };
  }

  const fieldLabelMap = $derived<Record<string, string>>(
    Object.fromEntries((form?.structure?.fields || []).map((f: any) => [f.id, f.label]))
  );

  const filtered = $derived(responses.filter(r => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q ||
      r.userId?.includes(q) ||
      r.username?.toLowerCase().includes(q) ||
      r.userTag?.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q);
    return matchesSearch;
  }));

  onMount(async () => {
    if (!authStore.selectedGuildId) return;
    try {
      const requestHeaders = { Authorization: `Bearer ${authStore.token}` };
      const [fRes, rRes] = await Promise.all([
        dashboardFetch(`/custom-forms/${formId}`, { headers: requestHeaders }),
        dashboardFetch(`/custom-forms/${formId}/submissions?limit=100`, { headers: requestHeaders }),
      ]);
      if (fRes.ok) {
        const data = await fRes.json();
        form = data.form;
      }

      if (!rRes.ok) throw new Error('Impossible de charger les réponses');
      const rData = await rRes.json();
      responses = rData.submissions || [];
      responseTotal = rData.total ?? responses.length;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : 'Erreur inconnue';
    } finally {
      loading = false;
    }
  });

  async function loadMore() {
    if (!authStore.selectedGuildId || loadingMore || responses.length >= responseTotal) return;
    loadingMore = true;
    try {
      const res = await dashboardFetch(`/custom-forms/${formId}/submissions?limit=100&offset=${responses.length}`);
      if (!res.ok) throw new Error('Impossible de charger les réponses suivantes');
      const data = await res.json();
      responses = [...responses, ...(data.submissions || [])];
      responseTotal = data.total ?? responseTotal;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      loadingMore = false;
    }
  }

  function exportCsv() {
    if (!responses.length) return;
    // Collect all field keys
    const allKeys = new Set<string>();
    responses.forEach(r => Object.keys(r.data || {}).forEach(k => allKeys.add(k)));
    const keys = ['id', 'userId', 'username', 'userTag', 'createdAt', ...allKeys];

    const header = keys.join(',');
    const rows = filtered.map(r =>
      keys.map(k => {
        const val = k in r ? (r as any)[k] : (r.data || {})[k];
        const str = Array.isArray(val) ? val.join('; ') : (val ?? '');
        return `"${String(str).replace(/"/g, '""')}"`;
      }).join(',')
    );

    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `responses-${formId}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success('Export CSV téléchargé !');
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
</script>

<ModulePage
  title={form ? `Réponses - ${form.name}` : 'Réponses au formulaire'}
  description="Consulte et exporte toutes les réponses reçues."
  icon="assignment"
  featureKey="custom_forms"
>
  <div class="space-y-5">

    <!-- Top bar -->
    <div class="flex flex-wrap items-center gap-3">
      <button onclick={() => router.goto('/forms')}
        class="flex items-center gap-2 text-sm font-semibold text-on-surface-variant/60 hover:text-primary transition-colors">
        <Papicon icon="arrow_back" size={16} />
        Retour aux formulaires
      </button>
      <div class="flex-1"></div>
      {#if form}
        <span class="text-xs font-semibold text-on-surface-variant/50 bg-surface-container px-3 py-1.5 rounded-full">
          {responseTotal} soumission{responseTotal !== 1 ? 's' : ''}
        </span>
      {/if}
      {#if responses.length < responseTotal}
        <button onclick={loadMore} disabled={loadingMore}
          class="px-3 py-1.5 rounded-xl bg-surface-container text-xs font-bold disabled:opacity-50">
          {loadingMore ? 'Chargement…' : `Charger plus (${responses.length}/${responseTotal})`}
        </button>
      {/if}
      <button onclick={exportCsv}
        class="flex items-center gap-2 px-4 py-2 rounded-xl bg-surface-container hover:bg-surface-container-high text-sm font-bold transition-colors">
        <Papicon icon="download" size={16} />
        Export CSV
      </button>
    </div>

    <!-- Tabs Switch -->
    {#if form && responses.length > 0}
      <Tabs
        label={form.name}
        class="mb-4"
        tabs={[
          { id: 'list', label: 'Individuel', icon: 'assignment', badge: filtered.length },
          { id: 'analytics', label: 'Statistiques', icon: 'pie_chart' },
        ]}
        active={activeTab}
        onchange={(id) => (activeTab = id as typeof activeTab)}
      />
    {/if}

    {#if loading}
      <div class="flex items-center justify-center py-20">
        <div class="w-10 h-10 border-3 border-primary/20 border-t-primary rounded-full animate-spin"></div>
      </div>
    {:else if error}
      <div class="rounded-lg bg-error/10 border border-error/20 p-5 text-error text-sm">{error}</div>
    {:else if responses.length === 0}
      <div class="rounded-lg border-2 border-dashed border-outline-variant/20 p-16 text-center text-on-surface-variant/40">
        <Papicon icon="inbox" size={48} class="mb-3" />
        <p class="text-sm font-sans">Aucune réponse trouvée</p>
      </div>
    {:else}
      {#if activeTab === 'list'}
        <!-- Filters -->
        <div class="flex flex-wrap gap-3 mb-4">
          <div class="relative flex-1 min-w-48">
            <Papicon icon="search" size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/40" />
            <input bind:value={searchQuery} placeholder="Rechercher par ID, utilisateur, tag…"
              class="w-full bg-surface-container rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none focus:ring-2 ring-primary/20 transition-all" />
          </div>
        </div>

        {#if filtered.length === 0}
          <div class="rounded-lg border-2 border-dashed border-outline-variant/20 p-16 text-center text-on-surface-variant/40">
            <Papicon icon="inbox" size={48} class="mb-3" />
            <p class="text-sm font-sans">Aucune réponse correspondante</p>
          </div>
        {:else}
          <div class="rounded-lg border border-outline-variant/20 overflow-x-auto shadow-sm">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-surface-container-low/60 border-b border-outline-variant/10">
                  <th class="text-left px-5 py-3 font-semibold text-on-surface-variant/60 text-xs">ID</th>
                  <th class="text-left px-5 py-3 font-semibold text-on-surface-variant/60 text-xs">Utilisateur Discord</th>
                  <th class="text-left px-5 py-3 font-semibold text-on-surface-variant/60 text-xs">Date de Soumission</th>
                  <th class="text-left px-5 py-3 font-semibold text-on-surface-variant/60 text-xs"></th>
                </tr>
              </thead>
              <tbody>
                {#each filtered as r}
                  <tr class="border-b border-outline-variant/5 hover:bg-surface-container-low/40 transition-colors cursor-pointer"
                    onclick={() => selectedResponse = r}>
                    <td class="px-5 py-3 font-mono text-xs text-on-surface-variant/50">{r.id.slice(0,8)}…</td>
                    <td class="px-5 py-3">
                      {#if r.username || r.userId}
                        <UserDisplay
                          userId={r.userId}
                          name={r.username}
                          avatarUrl={r.avatarUrl}
                          subtitle={r.userTag}
                          size="sm"
                        />
                      {:else}
                        <span class="text-on-surface-variant/30 italic font-sans">Anonyme</span>
                      {/if}
                    </td>
                    <td class="px-5 py-3 text-xs text-on-surface-variant/50 font-sans">{formatDate(r.createdAt)}</td>
                    <td class="px-5 py-3 text-right">
                      <Papicon icon="chevron_right" size={16} class="text-on-surface-variant/30 inline-block" />
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <p class="text-xs text-on-surface-variant/40 text-right font-sans">{filtered.length} résultat{filtered.length !== 1 ? 's' : ''}</p>
        {/if}
      {:else if activeTab === 'analytics'}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {#each analytics() as item}
            <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-6 space-y-4 flex flex-col justify-between">
              <div>
                <div class="flex items-start justify-between border-b border-outline-variant/5 pb-2 mb-4">
                  <h4 class="font-semibold text-on-surface font-sans text-sm">{item.label}</h4>
                  <span class="text-xs font-semibold text-on-surface-variant/50 bg-surface-container px-2.5 py-1 rounded-full shrink-0 ml-2">
                    {item.totalResponses} réponse{item.totalResponses !== 1 ? 's' : ''}
                  </span>
                </div>
                
                {#if ['multiple_choice', 'dropdown', 'checkboxes'].includes(item.type) || item.optionsCount}
                  <div class="h-[250px]">
                    <Chart 
                      data={getChartData(item)} 
                      type="bar" 
                      height={250} 
                      options={{ 
                        indexAxis: 'y',
                        plugins: { legend: { display: false } },
                        scales: {
                          x: { ticks: { precision: 0 } }
                        }
                      }} 
                    />
                  </div>
                {:else if item.type === 'number'}
                  <div class="grid grid-cols-3 gap-3 text-center my-4">
                    <div class="bg-surface-container/30 border border-outline-variant/5 rounded-xl p-3">
                      <span class="text-body-sm text-on-surface-variant/50 font-semibold block mb-1">Moyenne</span>
                      <span class="text-lg font-bold text-primary">{item.average ?? 0}</span>
                    </div>
                    <div class="bg-surface-container/30 border border-outline-variant/5 rounded-xl p-3">
                      <span class="text-body-sm text-on-surface-variant/50 font-semibold block mb-1">Min</span>
                      <span class="text-lg font-bold text-on-surface">{item.min ?? 0}</span>
                    </div>
                    <div class="bg-surface-container/30 border border-outline-variant/5 rounded-xl p-3">
                      <span class="text-body-sm text-on-surface-variant/50 font-semibold block mb-1">Max</span>
                      <span class="text-lg font-bold text-on-surface">{item.max ?? 0}</span>
                    </div>
                  </div>
                {:else}
                  <!-- Text responses list -->
                  <div class="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                    {#if item.recentResponses && item.recentResponses.length > 0}
                      {#each item.recentResponses as resp}
                        <div class="bg-surface-container/30 border border-outline-variant/5 rounded-xl p-3 text-xs text-on-surface font-sans leading-relaxed">
                          {resp}
                        </div>
                      {/each}
                    {:else}
                      <span class="text-xs italic text-on-surface-variant/40">Aucune réponse</span>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</ModulePage>

<!-- Detail modal -->
{#if selectedResponse}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4"
    role="dialog" aria-modal="true" tabindex="-1" onkeydown={(e) => { if (e.key === 'Escape') selectedResponse = null; }}>
    <!-- Backdrop -->
    <button
      type="button"
      class="absolute inset-0 bg-black/40 border-none cursor-default w-full h-full text-left p-0"
      onclick={() => selectedResponse = null}
      aria-label="Fermer"
    ></button>

    <!-- Detail panel -->
    <div class="relative z-10 bg-surface rounded-xl shadow-sm max-w-lg w-full max-h-[80vh] overflow-y-auto">
      <div class="sticky top-0 bg-surface border-b border-outline-variant/10 px-6 py-4 flex items-start justify-between rounded-t-3xl">
        <div>
          <h2 class="font-semibold text-on-surface text-lg font-sans">Réponse détaillée</h2>
          <p class="text-xs font-mono text-on-surface-variant/40 mt-0.5">{selectedResponse.id}</p>
        </div>
        <button onclick={() => selectedResponse = null}
          class="p-2 rounded-xl hover:bg-surface-container transition-colors">
          <Papicon icon="close" size={18} />
        </button>
      </div>

      <div class="p-6 space-y-4">
        <!-- Metadata -->
        <div class="grid grid-cols-2 gap-3 text-sm">
          {#if selectedResponse.userId}
            <div class="bg-surface-container rounded-xl p-3">
              <p class="text-xs text-on-surface-variant/50 font-semibold mb-1 font-sans">Discord ID</p>
              <p class="font-mono text-xs text-on-surface">{selectedResponse.userId}</p>
            </div>
          {/if}
          {#if selectedResponse.username}
            <div class="bg-surface-container rounded-xl p-3">
              <p class="text-xs text-on-surface-variant/50 font-semibold mb-1 font-sans">Pseudo / Tag</p>
              <p class="text-on-surface font-sans">{selectedResponse.username}{selectedResponse.userTag ? ` (${selectedResponse.userTag})` : ''}</p>
            </div>
          {/if}
          <div class="bg-surface-container rounded-xl p-3 col-span-2">
            <p class="text-xs text-on-surface-variant/50 font-semibold mb-1 font-sans">Date de soumission</p>
            <p class="text-xs text-on-surface font-sans">{formatDate(selectedResponse.createdAt)}</p>
          </div>
        </div>

        <!-- Answers -->
        <div>
          <h3 class="text-sm font-semibold text-on-surface-variant/60 mb-3 font-sans">Réponses aux questions</h3>
          <div class="space-y-3">
            {#each Object.entries(selectedResponse.data || {}) as [key, value]}
              <div class="bg-surface-container/60 rounded-xl p-3">
                <p class="text-xs font-bold text-on-surface-variant/50 mb-1 font-sans">{fieldLabelMap[key] || key}</p>
                <p class="text-sm text-on-surface font-sans">
                  {Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '-')}
                </p>
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
