<script lang="ts">
  import { m } from '../../lib/i18n';
  /**
   * Journal d'audit de la console admin.
   *
   * Page nouvelle : jusqu'ici, les actions globales (départ forcé d'un serveur,
   * redémarrage de shard, envoi d'annonce, blacklist) ne laissaient aucune
   * trace horodatée nommant leur auteur. Une action destructrice était donc
   * indistinguable d'un bug.
   */
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import {
    fetchAdminAudit,
    fetchAdminAuditActions,
    type AdminAuditEntry,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import MetricTabs from '../../lib/components/analytics/MetricTabs.svelte';
  import { SERIES, fmtNumber } from '../../lib/components/analytics/analyticsFormat';
  import { Button, EmptyState, FilterPills } from '../../lib/components/ui';
  import type { AdminTone } from '../../lib/components/admin/types';

  let entries = $state<AdminAuditEntry[]>([]);
  let actionTypes = $state<{ action: string; count: number }[]>([]);
  let nextCursor = $state<string | null>(null);

  let loading = $state(true);
  let loadingMore = $state(false);

  let search = $state('');
  let actionFilter = $state('');
  let outcomeFilter = $state('ALL');
  let windowHours = $state(168);

  let detailOpen = $state(false);
  let selected = $state<AdminAuditEntry | null>(null);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const windows = [
    { value: 24, label: '24 h' },
    { value: 168, label: '7 j' },
    { value: 720, label: '30 j' },
    { value: 0, label: 'Tout' },
  ];

  async function load() {
    loading = true;
    try {
      const result = await fetchAdminAudit({
        search: search.trim() || undefined,
        action: actionFilter || undefined,
        outcome: outcomeFilter === 'ALL' ? undefined : (outcomeFilter as 'OK' | 'FAILED'),
        sinceHours: windowHours || undefined,
        limit: 60,
      });
      entries = result?.entries ?? [];
      nextCursor = result?.nextCursor ?? null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.d7_loading_error());
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      const result = await fetchAdminAudit({
        search: search.trim() || undefined,
        action: actionFilter || undefined,
        outcome: outcomeFilter === 'ALL' ? undefined : (outcomeFilter as 'OK' | 'FAILED'),
        sinceHours: windowHours || undefined,
        limit: 60,
        cursor: nextCursor,
      });
      entries = [...entries, ...(result?.entries ?? [])];
      nextCursor = result?.nextCursor ?? null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.d7_loading_error());
    } finally {
      loadingMore = false;
    }
  }

  onMount(async () => {
    await Promise.all([
      load(),
      fetchAdminAuditActions().then((data) => { actionTypes = data?.actions ?? []; }).catch(() => {}),
    ]);
  });

  // Le filtrage se fait côté serveur : on temporise la frappe pour ne pas
  // déclencher une requête par caractère.
  $effect(() => {
    void search;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 350);
    return () => { if (searchTimer) clearTimeout(searchTimer); };
  });

  function applyFilter(action: string) {
    actionFilter = actionFilter === action ? '' : action;
    void load();
  }

  function applyOutcome(outcome: string) {
    outcomeFilter = outcome;
    void load();
  }

  function applyWindow(hours: number) {
    windowHours = hours;
    void load();
  }

  // ── Dérivés ───────────────────────────────────────────────────────────────
  const failedCount = $derived(entries.filter((entry) => entry.outcome === 'FAILED').length);
  const actorCount = $derived(new Set(entries.map((entry) => entry.actorId)).size);

  /** Regroupe par jour : un journal brut de 60 lignes se lit mal sans repères. */
  const grouped = $derived.by(() => {
    const map = new Map<string, AdminAuditEntry[]>();
    for (const entry of entries) {
      const day = new Date(entry.createdAt).toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
      const bucket = map.get(day);
      if (bucket) bucket.push(entry);
      else map.set(day, [entry]);
    }
    return [...map.entries()];
  });

  // ── Affichage ─────────────────────────────────────────────────────────────
  /** Ton et icône déduits du domaine de l'action (`domaine.verbe`). */
  function actionVisual(action: string): { tone: AdminTone; icon: string } {
    const domain = action.split('.')[0];
    switch (domain) {
      case 'broadcast': return { tone: 'warning', icon: 'Megaphone' };
      case 'guild': return { tone: 'primary', icon: 'Server' };
      case 'shard': return { tone: 'info', icon: 'Zap' };
      case 'admin': return { tone: 'danger', icon: 'ShieldCheck' };
      case 'blacklist': return { tone: 'danger', icon: 'Ban' };
      case 'whitelabel': return { tone: 'info', icon: 'Layers' };
      case 'gdpr': return { tone: 'neutral', icon: 'ShieldCheck' };
      default: return { tone: 'neutral', icon: 'ClipboardList' };
    }
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatFull(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function openDetail(entry: AdminAuditEntry) {
    selected = entry;
    detailOpen = true;
  }

  /** Export CSV de la fenêtre affichée, pour archivage ou analyse externe. */
  function exportCsv() {
    const header = ['date', 'action', 'auteur', 'cible', 'resultat', 'resume', 'ip'];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = entries.map((entry) => [
      entry.createdAt,
      entry.action,
      entry.actorName ?? entry.actorId,
      entry.targetId ?? '',
      entry.outcome,
      entry.summary,
      entry.ip ?? '',
    ].map(escape).join(','));

    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kotbo-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(m.aaud_exported({ count: entries.length }));
  }
</script>

<AdminShell
  title="Journal d’audit"
  description="Trace horodatée des actions sensibles réalisées depuis la console admin globale."
>
  {#snippet actions()}
    <Button
      icon="Download"
      disabled={entries.length === 0}
      disabledReason={m.common_reason_select_one()}
      onclick={exportCsv}
    >
      Exporter en CSV
    </Button>
    <Button icon="RefreshCw" {loading} onclick={load}>Actualiser</Button>
  {/snippet}

  <MetricTabs
    interactive={false}
    active=""
    onchange={() => {}}
    label="Indicateurs du journal d’audit"
    metrics={[
      { id: 'entries', label: 'Entrées affichées', value: fmtNumber(entries.length), color: SERIES[0] },
      { id: 'failed', label: 'Échecs', value: fmtNumber(failedCount), color: SERIES[3] },
      { id: 'actors', label: 'Auteurs distincts', value: fmtNumber(actorCount), color: SERIES[1] },
      { id: 'types', label: 'Types d’action', value: fmtNumber(actionTypes.length), color: SERIES[2] },
    ]}
  />

  <div class="flex flex-col gap-3">
    <AdminToolbar bind:search placeholder="Rechercher un résumé, une action, un auteur ou un ID cible…">
      {#snippet actions()}
        <FilterPills
          label="Fenêtre"
          value={String(windowHours)}
          onchange={(v) => applyWindow(Number(v))}
          options={windows.map((w) => ({ value: String(w.value), label: w.label }))}
        />
        <FilterPills
          label="Résultat"
          value={outcomeFilter}
          onchange={(v) => applyOutcome(v)}
          options={[
            { value: 'ALL', label: 'Tous' },
            { value: 'OK', label: 'Réussis' },
            { value: 'FAILED', label: 'Échecs' },
          ]}
        />
      {/snippet}
    </AdminToolbar>

    {#if actionTypes.length > 0}
      <div class="flex flex-wrap gap-1.5">
        {#each actionTypes as entry (entry.action)}
          <button
            type="button"
            onclick={() => applyFilter(entry.action)}
            aria-pressed={actionFilter === entry.action}
            class="admin-press inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-xs font-mono font-medium transition
              {actionFilter === entry.action
                ? 'bg-on-surface text-background'
                : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}"
          >
            {entry.action}
            <span class="tabular-nums text-2xs opacity-70">{entry.count}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="space-y-2">
      {#each Array(8) as _, index (index)}
        <div class="h-16 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/each}
    </div>
  {:else if entries.length === 0}
    <EmptyState
      icon="ClipboardList"
      title="Aucune entrée"
      description="Le journal est alimenté à partir de cette mise à jour : les actions antérieures n’y figurent pas. Élargis la fenêtre ou retire les filtres."
      reason="nothing-matches"
    />
  {:else}
    <div class="space-y-5">
      {#each grouped as [day, dayEntries] (day)}
        <div class="space-y-2">
          <div class="flex items-center gap-3">
            <p class="text-xs font-semibold text-on-surface-variant">{day}</p>
            <div class="flex-1 h-px bg-outline-variant/25"></div>
            <span class="text-2xs text-on-surface-variant tabular-nums">{dayEntries.length}</span>
          </div>

          <ul class="space-y-1.5">
            {#each dayEntries as entry (entry.id)}
              {@const visual = actionVisual(entry.action)}
              <li>
                <button
                  type="button"
                  onclick={() => openDetail(entry)}
                  class="w-full text-left rounded-xl border border-outline-variant/25 bg-surface-container-lowest/70 p-3 flex items-start gap-3
                    hover:border-primary/35 hover:bg-surface-container-low/60 transition focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <div
                    class="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center
                      {visual.tone === 'danger' ? 'bg-error/12 text-error'
                        : visual.tone === 'warning' ? 'bg-warning/12 text-warning'
                          : visual.tone === 'info' ? 'bg-sky-500/12 text-sky-500'
                            : visual.tone === 'primary' ? 'bg-primary/12 text-primary'
                              : 'bg-on-surface/8 text-on-surface-variant'}"
                  >
                    <Papicon icon={visual.icon} size={14} />
                  </div>

                  <div class="min-w-0 flex-1">
                    <p class="text-body-sm text-on-surface leading-snug">{entry.summary}</p>
                    <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1">
                      <span class="text-2xs font-mono text-on-surface-variant">{entry.action}</span>
                      <span class="text-2xs text-on-surface-variant">·</span>
                      <span class="text-2xs text-on-surface-variant">{entry.actorName ?? entry.actorId}</span>
                      {#if entry.targetId}
                        <span class="text-2xs text-on-surface-variant">·</span>
                        <span class="text-2xs font-mono text-on-surface-variant truncate max-w-40">{entry.targetId}</span>
                      {/if}
                    </div>
                  </div>

                  <div class="shrink-0 flex flex-col items-end gap-1">
                    <span class="text-2xs text-on-surface-variant tabular-nums">{formatTime(entry.createdAt)}</span>
                    {#if entry.outcome === 'FAILED'}
                      <AdminBadge size="sm" label="Échec" tone="danger" />
                    {/if}
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/each}

      {#if nextCursor}
        <button
          type="button"
          onclick={loadMore}
          disabled={loadingMore}
          class="w-full h-11 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-body-sm font-semibold text-on-surface-variant hover:text-on-surface transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          {#if loadingMore}
            <span class="w-3.5 h-3.5 rounded-full border-2 border-on-surface-variant/30 border-t-on-surface-variant animate-spin"></span>
            Chargement…
          {:else}
            Charger plus d’entrées
          {/if}
        </button>
      {/if}
    </div>
  {/if}
</AdminShell>

<AdminDrawer bind:open={detailOpen} width="sm" title="Détail de l’action" subtitle={selected?.action ?? ''}>
  {#if selected}
    {@const entry = selected}
    <div class="space-y-4">
      <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3.5">
        <p class="text-body-sm text-on-surface leading-relaxed">{entry.summary}</p>
      </div>

      <dl class="space-y-2.5">
        {#each [
          { label: 'Action', value: entry.action, mono: true },
          { label: 'Résultat', value: entry.outcome === 'OK' ? 'Réussie' : 'En échec', mono: false },
          { label: 'Auteur', value: entry.actorName ?? '-', mono: false },
          { label: 'ID auteur', value: entry.actorId, mono: true },
          { label: 'Type de cible', value: entry.targetType ?? '-', mono: false },
          { label: 'ID cible', value: entry.targetId ?? '-', mono: true },
          { label: 'Adresse IP', value: entry.ip ?? '-', mono: true },
          { label: 'Horodatage', value: formatFull(entry.createdAt), mono: false },
        ] as field (field.label)}
          <div class="flex items-start justify-between gap-3">
            <dt class="text-xs text-on-surface-variant shrink-0">{field.label}</dt>
            <dd class="text-xs text-on-surface text-right break-all {field.mono ? 'font-mono' : 'font-medium'}">
              {field.value}
            </dd>
          </div>
        {/each}
      </dl>

      {#if entry.metadata}
        <div>
          <p class="text-xs font-semibold text-on-surface-variant mb-1.5">Métadonnées</p>
          <pre class="text-2xs font-mono text-on-surface-variant bg-surface-container-low/60 border border-outline-variant/25 rounded-xl p-3 overflow-x-auto">{JSON.stringify(entry.metadata, null, 2)}</pre>
        </div>
      {/if}
    </div>
  {/if}
</AdminDrawer>
