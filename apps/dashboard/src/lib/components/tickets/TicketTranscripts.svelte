<!--
  Transcriptions des tickets fermés (et des /transcript) : consultation et,
  pour qui gère les réglages, suppression. Onglet autonome de la page Tickets.
-->
<script lang="ts">
  import { m, dateLocale } from '../../i18n';
  import { authStore } from '../../stores/auth.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { dashboardFetch, deleteTranscript } from '../../api';
  import { errorMessage } from '@kotbo/shared';
  import Papicon from '../Papicon.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';

  /** Incrémenté par la page (bouton Actualiser) pour relire la liste. */
  const { refreshToken = 0 }: { refreshToken?: number } = $props();

  let transcripts = $state<any[]>([]);
  let loading = $state(true);
  let error = $state('');

  // La page « Transcriptions » autonome a ete fondue dans cet onglet : il
  // reprend sa suppression, reservee a qui gere les reglages.
  const canDeleteTranscripts = $derived(dashboardStore.state.access?.canManageSettings === true);

  async function removeTranscript(transcript: { id: string; channelName: string }) {
    const confirmed = await confirmDialog.danger(
      m.e1_tickets_transcript_delete_title({ channel: transcript.channelName }),
      m.e1_tickets_transcript_delete_desc(),
      m.common_delete(),
    );
    if (!confirmed) return;
    if (await deleteTranscript(transcript.id)) {
      transcripts = transcripts.filter((t) => t.id !== transcript.id);
    }
  }

  // Fetch transcripts for this guild
  async function loadTranscripts() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const res = await dashboardFetch(`/tickets/transcripts?includeTotal=false`);
      if (!res.ok) throw new Error(m.e1_tickets_err_load_transcripts());
      const data = await res.json();
      transcripts = data.transcripts || [];
    } catch (err) {
      error = errorMessage(err) || 'Une erreur est survenue';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void refreshToken;
    void loadTranscripts();
  });
</script>

<div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-4 lg:p-6 flex flex-col min-h-[40vh]">
  <div class="mb-4">
    <h3 class="text-lg font-semibold text-on-surface">{m.e1_tickets_transcripts_title()}</h3>
    <p class="text-on-surface-variant text-xs mt-0.5">{m.e1_tickets_transcripts_desc()}</p>
  </div>

  {#if error}
    <Callout variant="danger">{error}</Callout>
  {:else if loading}
    <div class="flex items-center justify-center py-16">
      <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
    </div>
  {:else if transcripts.length === 0}
    <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
      <Papicon icon="inbox" size={36} class="opacity-50 mb-2" />
      <p class="text-xs font-bold">{m.e1_tickets_transcripts_empty()}</p>
    </div>
  {:else}
    <!-- Mobile: card layout / Desktop: table -->
    <div class="hidden md:block overflow-x-auto w-full">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="border-b border-outline-variant/15 text-xs font-medium text-on-surface-variant/70">
            <th class="py-3 px-4">{m.e1_tickets_th_channel()}</th>
            <th class="py-3 px-4">{m.e1_tickets_th_type()}</th>
            <th class="py-3 px-4">{m.e1_tickets_th_period()}</th>
            <th class="py-3 px-4">{m.e1_tickets_th_generated()}</th>
            <th class="py-3 px-4 text-right">{m.e1_tickets_th_action()}</th>
          </tr>
        </thead>
        <tbody>
          {#each transcripts as t}
            <tr class="border-b border-outline-variant/10 hover:bg-white/5 transition-colors">
              <td class="py-3 px-4 font-mono text-sm font-bold text-on-surface">
                <span class="text-primary/70">#</span>{t.channelName}
              </td>
              <td class="py-3 px-4">
                {#if t.channelName.startsWith('ticket-') || t.channelName.startsWith('fermer-')}
                  <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">{m.e1_tickets_badge_ticket()}</span>
                {:else}
                  <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-success/10 text-success border border-success/20">/transcript</span>
                {/if}
              </td>
              <td class="py-3 px-4 text-xs text-on-surface-variant">
                {#if t.startTime && t.endTime}
                  {new Date(t.startTime).toLocaleDateString(dateLocale())} - {new Date(t.endTime).toLocaleDateString(dateLocale())}
                {:else}
                  <span class="text-on-surface-variant/40 italic">{m.e1_tickets_period_all()}</span>
                {/if}
              </td>
              <td class="py-3 px-4 text-xs text-on-surface-variant">
                {new Date(t.createdAt).toLocaleDateString(dateLocale())}
              </td>
              <td class="py-3 px-4">
                <div class="flex items-center justify-end gap-2">
                  <Button href="/transcripts/{t.id}" target="_blank" size="sm" icon="external-link">{m.e1_tickets_view_btn()}</Button>
                  {#if canDeleteTranscripts}
                    <Button variant="danger" size="sm" icon="trash" aria-label={m.common_delete()} onclick={() => removeTranscript(t)} />
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Mobile cards -->
    <div class="md:hidden space-y-3">
      {#each transcripts as t}
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container/20 p-3.5">
          <div class="flex items-center justify-between gap-2 mb-2">
            <span class="font-mono text-sm font-bold text-on-surface truncate"><span class="text-primary/70">#</span>{t.channelName}</span>
            {#if t.channelName.startsWith('ticket-') || t.channelName.startsWith('fermer-')}
              <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">{m.e1_tickets_badge_ticket()}</span>
            {:else}
              <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-success/10 text-success border border-success/20 shrink-0">/transcript</span>
            {/if}
          </div>
          <p class="text-2xs text-on-surface-variant/60 mb-2">
            {new Date(t.createdAt).toLocaleDateString(dateLocale())}
            {#if t.startTime && t.endTime}
              - Du {new Date(t.startTime).toLocaleDateString(dateLocale())} au {new Date(t.endTime).toLocaleDateString(dateLocale())}
            {/if}
          </p>
          <div class="flex items-center gap-2">
            <Button href="/transcripts/{t.id}" target="_blank" size="sm" icon="external-link">{m.e1_tickets_view_btn()}</Button>
            {#if canDeleteTranscripts}
              <Button variant="danger" size="sm" icon="trash" aria-label={m.common_delete()} onclick={() => removeTranscript(t)} />
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
