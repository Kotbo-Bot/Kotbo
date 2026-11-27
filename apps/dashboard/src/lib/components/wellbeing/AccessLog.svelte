<!--
  Journal des accès d'urgence de la cellule, avec l'arrêt d'un accès en cours
  et l'export CSV du journal (sans contenu de dossier) pour un audit externe.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import MemberName from '../MemberName.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, EmptyState } from '../ui';
  import { wbStatusTone } from '../../wellbeingView';

  const {
    logs,
    viewerId,
    canRevokeOthers,
    endingLogId,
    onend,
  }: {
    logs: any[];
    viewerId: string | undefined;
    /** Cellule et propriétaire : arrêtent aussi l'accès des autres. */
    canRevokeOthers: boolean;
    endingLogId: string | null;
    onend: (logId: string) => void;
  } = $props();

  const LOG_STATUS: Record<string, () => string> = {
    PENDING: () => m.wb_log_status_PENDING(),
    APPROVED: () => m.wb_log_status_APPROVED(),
    REJECTED: () => m.wb_log_status_REJECTED(),
    ENDED: () => m.wb_log_status_ENDED(),
  };
  const LOG_TONES: Record<string, string> = {
    PENDING: 'bg-warning/10 text-on-warning-container border border-warning/20',
    APPROVED: 'bg-success/10 text-on-success-container border border-success/20',
    REJECTED: 'bg-error/10 text-on-error-container border border-error/20',
    ENDED: 'bg-surface-container-high/40 text-on-surface-variant border border-outline-variant/30',
  };

  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());
  const canEndLog = (log: any) => log.actorId === viewerId || canRevokeOthers;
  const isLiveLog = (log: any) => ['APPROVED', 'PENDING'].includes(log.status) && new Date(log.expiresAt) > new Date();

  let exportingJournal = $state(false);
  /** Journal de la cellule en CSV, sans contenu de dossier, pour un audit externe. */
  async function exportJournal() {
    if (exportingJournal) return;
    exportingJournal = true;
    try {
      const res = await dashboardFetch('/wellbeing/journal');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '');
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `journal-cellule-bien-etre-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_load_failed());
    } finally {
      exportingJournal = false;
    }
  }
</script>

<section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="eye" size={16} /> {m.wb_logs_title()}</h3>
    <Button size="sm" variant="secondary" icon="Download" loading={exportingJournal} onclick={() => void exportJournal()}>{m.wb_journal_export()}</Button>
  </div>
  <p class="text-xs text-on-surface-variant">{m.wb_journal_desc()}</p>
  {#if logs.length === 0}
    <EmptyState icon="eye" title={m.wb_access_empty()} reason="accumulating" />
  {:else}
    <ul class="space-y-1.5">
      {#each logs as log (log.id)}
        <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-container-high/20 px-3 py-2.5 text-sm">
          <div class="min-w-0">
            <span class="font-semibold text-on-surface">{log.actorName}</span>
            {#if log.reason}<span class="text-on-surface-variant"> · {log.reason}</span>{/if}
            {#if log.subjectUserId}
              <span class="text-xs text-on-surface-variant flex items-center gap-1 mt-0.5">{m.wb_pending_scope()} <MemberName userId={log.subjectUserId} /></span>
            {/if}
          </div>
          <span class="flex items-center gap-2 text-xs text-on-surface-variant shrink-0">
            <span class="text-2xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap {LOG_TONES[log.status] ?? wbStatusTone('')}">{LOG_STATUS[log.status]?.() ?? log.status}</span>
            {formatDate(log.createdAt)}
            {#if log.status === 'APPROVED' && isLiveLog(log) && canEndLog(log)}
              <Button size="sm" variant="danger" icon="X" loading={endingLogId === log.id} onclick={() => onend(log.id)}>
                {log.actorId === viewerId ? m.wb_bg_end_now() : m.wb_bg_revoke()}
              </Button>
            {/if}
          </span>
          {#if log.endedByName}
            <p class="w-full text-xs text-on-surface-variant">{m.wb_bg_ended_by({ name: log.endedByName, date: formatDate(log.endedAt) })}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
