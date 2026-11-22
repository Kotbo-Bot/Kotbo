<!--
  Corbeille des infractions : relire ce qu'était une infraction supprimée et la
  restaurer. Réservé aux administrateurs (l'API refuse les autres).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { m, dateLocale } from '../../i18n';
  import { dashboardFetch } from '../../api';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { durationLabel, typeLabel } from '../../sanctions/formatters';

  type Snapshot = {
    type: string;
    targetTag: string | null;
    targetUserId: string;
    moderatorTag: string | null;
    reason: string;
    durationSeconds: number | null;
    createdAt: string;
  };
  type Deletion = {
    id: string;
    sanctionId: string;
    snapshot: Snapshot;
    reportIds: string[];
    evidenceFileIds: string[];
    deletedByTag: string | null;
    deletedByUserId: string;
    deletedAt: string;
  };

  let items = $state<Deletion[]>([]);
  let retentionDays = $state(90);
  let loading = $state(true);
  let busyId = $state<string | null>(null);

  const fmt = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function load() {
    loading = true;
    try {
      const res = await dashboardFetch('/sanctions/deleted');
      if (!res.ok) return;
      const payload = await res.json();
      items = payload.items ?? [];
      retentionDays = payload.retentionDays ?? 90;
    } catch {
      // Panneau secondaire : un échec laisse simplement la liste vide.
    } finally {
      loading = false;
    }
  }

  async function restore(item: Deletion) {
    if (!(await confirmDialog.ask({ title: m.sc_trash_restore_q(), description: m.sc_trash_restore_desc(), confirmLabel: m.sc_trash_restore() }))) return;
    busyId = item.id;
    try {
      const res = await dashboardFetch(`/sanctions/deleted/${item.id}/restore`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || m.sc_update_error());
        return;
      }
      toast.success(m.sc_trash_restored());
      await Promise.all([load(), dashboardStore.refresh()]);
    } catch {
      toast.error(m.sc_update_error());
    } finally {
      busyId = null;
    }
  }

  onMount(load);
</script>

<section class="section-card-flush font-inter mt-8">
  <div class="px-6 py-5 border-b border-outline-variant">
    <h3 class="text-lg font-semibold">{m.sc_trash_title()}</h3>
    <p class="text-xs text-on-surface-variant mt-1">{m.sc_trash_hint({ days: retentionDays })}</p>
  </div>

  {#if !loading && items.length === 0}
    <p class="px-6 py-10 text-center text-on-surface-variant">{m.sc_trash_empty()}</p>
  {:else}
    <ul class="divide-y divide-outline-variant">
      {#each items as item (item.id)}
        <li class="px-6 py-4">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <p class="font-semibold truncate">
                {typeLabel(item.snapshot.type)} · {item.snapshot.targetTag ?? item.snapshot.targetUserId}
              </p>
              <p class="text-xs text-on-surface-variant">
                {m.sc_trash_by({ name: item.deletedByTag ?? item.deletedByUserId, date: fmt(item.deletedAt) })}
              </p>
            </div>
            <button
              class="btn-secondary shrink-0"
              disabled={busyId === item.id}
              onclick={() => restore(item)}
            >{m.sc_trash_restore()}</button>
          </div>
          <details class="mt-2 text-sm">
            <summary class="cursor-pointer text-on-surface-variant">{m.sc_trash_details()}</summary>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt class="text-on-surface-variant">{m.sc_trash_reason()}</dt>
              <dd class="whitespace-pre-wrap break-words">{item.snapshot.reason}</dd>
              <dt class="text-on-surface-variant">{m.sc_trash_moderator()}</dt>
              <dd>{item.snapshot.moderatorTag ?? '—'}</dd>
              <dt class="text-on-surface-variant">{m.sc_trash_duration()}</dt>
              <dd>{durationLabel(item.snapshot.durationSeconds)}</dd>
              <dt class="text-on-surface-variant">{m.sc_trash_created()}</dt>
              <dd>{fmt(item.snapshot.createdAt)}</dd>
              <dt class="text-on-surface-variant">{m.sc_trash_attached()}</dt>
              <dd>{m.sc_trash_attached_value({ reports: item.reportIds.length, files: item.evidenceFileIds.length })}</dd>
            </dl>
          </details>
        </li>
      {/each}
    </ul>
  {/if}
</section>
