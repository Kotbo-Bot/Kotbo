<!--
  Signaux de détresse à examiner : des messages du serveur repérés par le bot.
  Seul un lien vers le message est gardé, jamais son texte. La cellule ouvre
  un dossier (pré-rempli) ou écarte le signal ; rien n'est créé sans elle.
-->
<script lang="ts" module>
  export interface DistressSignal {
    id: string;
    userId: string;
    userName: string;
    url: string;
    createdAt: string;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button } from '../ui';

  const { onopen }: { onopen: (signal: DistressSignal) => void } = $props();

  let signals = $state<DistressSignal[]>([]);
  let busyId = $state<string | null>(null);
  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());

  /** Relu par la page après la création d'un dossier depuis un signal. */
  export async function reload() {
    const res = await dashboardFetch('/wellbeing/signals');
    if (res.ok) signals = (await res.json()).signals ?? [];
  }

  onMount(() => { void reload(); });

  async function dismiss(signal: DistressSignal) {
    if (busyId) return;
    busyId = signal.id;
    try {
      const res = await dashboardFetch(`/wellbeing/signals/${signal.id}/dismiss`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      signals = signals.filter((item) => item.id !== signal.id);
      toast.success(m.toast_wb_signal_dismissed());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      busyId = null;
    }
  }
</script>

{#if signals.length > 0}
  <section class="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-3 mb-6" aria-labelledby="wb-signals-title">
    <div class="space-y-1">
      <h2 id="wb-signals-title" class="text-sm font-semibold flex items-center gap-2 text-on-surface">
        <Papicon icon="AlertTriangle" size={15} /> {m.wb_signals_title({ count: signals.length })}
      </h2>
      <p class="text-xs text-on-surface-variant">{m.wb_signals_desc()}</p>
    </div>
    <ul class="space-y-1.5">
      {#each signals as signal (signal.id)}
        <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-container-lowest border border-outline-variant/30 px-3 py-2 text-sm">
          <span class="min-w-0">
            <span class="font-semibold text-on-surface">{signal.userName}</span>
            <span class="text-xs text-on-surface-variant"> · {formatDate(signal.createdAt)}</span>
          </span>
          <span class="flex flex-wrap items-center gap-1.5">
            <a href={signal.url} target="_blank" rel="noopener noreferrer" class="text-xs text-primary hover:underline">{m.wb_signals_view()}</a>
            <Button size="sm" variant="primary" icon="plus" disabled={!!busyId} onclick={() => onopen(signal)}>{m.wb_signals_open_case()}</Button>
            <Button size="sm" variant="ghost" icon="X" loading={busyId === signal.id} onclick={() => void dismiss(signal)}>{m.wb_signals_dismiss()}</Button>
          </span>
        </li>
      {/each}
    </ul>
  </section>
{/if}
