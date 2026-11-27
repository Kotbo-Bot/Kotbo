<!--
  Dossiers des autres serveurs du réseau confiés à la personne comme
  référent du réseau. Elle les lit et les annote ici ; la cellule d'origine
  garde la main sur le reste du dossier. Rien n'est affiché sans dossier.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { wbSeverityLabel, wbStatusLabel } from '../../wellbeingLabels';
  import { wbCategoryName } from '../../wellbeingCustom';
  import { wbCustom } from '../../stores/wellbeingCustomization.svelte';
  import { wbSeverityTone, wbStatusTone } from '../../wellbeingView';
  import Papicon from '../Papicon.svelte';
  import { Button } from '../ui';

  type NetworkCaseHeader = {
    id: string;
    guildName: string;
    title: string;
    subjectName: string;
    category: string;
    severity: string;
    status: string;
    updatedAt: string;
  };
  type NetworkNote = { id: string; authorName: string; content: string; createdAt: string };
  type NetworkCase = NetworkCaseHeader & { summary: string; notes: NetworkNote[] };

  const {
    hidden,
  }: {
    /** Mode discret : résumé et notes ne sont pas rendus. */
    hidden: boolean;
  } = $props();

  /** Même plafond que le bot. */
  const NOTE_MAX = 4000;
  let cases = $state<NetworkCaseHeader[]>([]);
  let opened = $state<NetworkCase | null>(null);
  let loadingId = $state<string | null>(null);
  let text = $state('');
  let sending = $state(false);
  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());

  onMount(() => {
    void (async () => {
      const res = await dashboardFetch('/wellbeing/network/cases').catch(() => null);
      if (res?.ok) cases = (await res.json()).cases ?? [];
    })();
  });

  async function open(item: NetworkCaseHeader) {
    if (loadingId) return;
    if (opened?.id === item.id) { opened = null; return; }
    loadingId = item.id;
    try {
      const res = await dashboardFetch(`/wellbeing/network/cases/${item.id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      opened = data.item;
      text = '';
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      loadingId = null;
    }
  }

  async function addNote() {
    const content = text.trim();
    if (!opened || !content || sending) return;
    sending = true;
    try {
      const res = await dashboardFetch(`/wellbeing/network/cases/${opened.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      opened = { ...opened, notes: [...opened.notes, data.note] };
      text = '';
      toast.success(m.toast_wb_note_saved());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      sending = false;
    }
  }
</script>

{#if cases.length > 0}
  <section class="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3 mb-6" aria-labelledby="wb-network-cases-title">
    <div class="space-y-1">
      <h2 id="wb-network-cases-title" class="text-sm font-semibold flex items-center gap-2 text-on-surface">
        <Papicon icon="Globe" size={15} /> {m.wb_network_cases_title({ count: cases.length })}
      </h2>
      <p class="text-xs text-on-surface-variant">{m.wb_network_cases_desc()}</p>
    </div>
    <ul class="space-y-2">
      {#each cases as item (item.id)}
        <li class="rounded-lg bg-surface-container-lowest border border-outline-variant/30">
          <button type="button" class="w-full flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm"
            aria-expanded={opened?.id === item.id} onclick={() => void open(item)}>
            <span class="min-w-0">
              <span class="font-semibold text-on-surface">{item.title}</span>
              <span class="text-xs text-on-surface-variant"> · {item.guildName} · {wbCategoryName(wbCustom.value, item.category)}</span>
            </span>
            <span class="flex items-center gap-1.5 text-2xs">
              <span class="rounded-full px-2 py-0.5 {wbSeverityTone(item.severity)}">{wbSeverityLabel(item.severity)}</span>
              <span class="rounded-full px-2 py-0.5 {wbStatusTone(item.status)}">{wbStatusLabel(item.status)}</span>
              {#if loadingId === item.id}<Papicon icon="Loader" size={12} />{/if}
            </span>
          </button>
          {#if opened?.id === item.id}
            <div class="border-t border-outline-variant/30 px-3 py-3 space-y-3 text-sm">
              {#if hidden}
                <p class="text-on-surface-variant">{m.wb_discreet_hidden()}</p>
              {:else}
                <p class="text-xs text-on-surface-variant">{m.wb_network_cases_subject({ name: opened.subjectName })}</p>
                <p class="whitespace-pre-wrap text-on-surface">{opened.summary}</p>
                {#if opened.notes.length > 0}
                  <ul class="space-y-2">
                    {#each opened.notes as note (note.id)}
                      <li class="rounded-lg bg-surface-container-high/30 px-3 py-2">
                        <p class="text-2xs text-on-surface-variant">{note.authorName} · {formatDate(note.createdAt)}</p>
                        <p class="whitespace-pre-wrap">{note.content}</p>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <div class="space-y-1.5">
                  <label for="wb-network-note" class="text-xs font-medium text-on-surface-variant">{m.wb_network_cases_note()}</label>
                  <textarea id="wb-network-note" class="input w-full min-h-20" maxlength={NOTE_MAX} bind:value={text}></textarea>
                  <div class="flex justify-end">
                    <Button size="sm" variant="primary" icon="Send" disabled={!text.trim()} loading={sending} onclick={() => void addNote()}>{m.wb_network_cases_note_add()}</Button>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
