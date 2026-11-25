<!--
  Échanges anonymes avec l'auteur d'un signalement. Il lit les messages de la
  cellule avec son code de suivi (/bienetre suivi) et lui répond de même
  (/bienetre repondre) : la cellule ne sait jamais qui il est.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button } from '../ui';

  type ReporterMessage = { id: string; fromReporter: boolean; content: string; createdAt: string };

  const {
    caseId,
    messages = [],
    canWrite,
    hidden,
    onchange,
  }: {
    caseId: string;
    messages?: ReporterMessage[];
    canWrite: boolean;
    /** Mode discret : le contenu des messages n'est pas rendu. */
    hidden: boolean;
    onchange: (item: any) => void;
  } = $props();

  /** Même plafond que le bot (REPORTER_REPLY_MAX). */
  const MESSAGE_MAX = 500;
  let text = $state('');
  let sending = $state(false);
  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());

  async function send() {
    const message = text.trim();
    if (!message || sending) return;
    sending = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/reporter-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      onchange(data.item);
      text = '';
      toast.success(m.toast_wb_reply_saved());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      sending = false;
    }
  }
</script>

<div class="rounded-xl border border-outline-variant/40 p-4 space-y-3">
  <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="MessageSquare" size={15} /> {m.wb_reply_title()}</h3>
  <p class="text-xs text-on-surface-variant">{m.wb_reply_desc()}</p>
  {#if messages.length > 0}
    {#if hidden}
      <p class="text-xs italic text-on-surface-variant">{m.wb_thread_hidden({ count: messages.length })}</p>
    {:else}
      <ol class="space-y-2" aria-label={m.wb_thread_label()}>
        {#each messages as message (message.id)}
          <li class="rounded-lg p-3 text-sm space-y-1 {message.fromReporter ? 'bg-surface-container-high/30 mr-8' : 'bg-primary/5 border border-primary/20 ml-8'}">
            <p class="text-2xs font-semibold text-on-surface-variant">
              {message.fromReporter ? m.wb_thread_from_reporter() : m.wb_thread_from_cell()} · {formatDate(message.createdAt)}
            </p>
            <p class="whitespace-pre-wrap text-on-surface">{message.content}</p>
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
  {#if canWrite}
    <textarea bind:value={text} maxlength={MESSAGE_MAX} rows={2} class="input w-full text-sm"
      aria-label={m.wb_reply_label()} placeholder={m.wb_reply_ph()}></textarea>
    <div class="flex justify-end">
      <Button size="sm" variant="primary" icon="Send" loading={sending} disabled={!text.trim()} onclick={() => void send()}>{m.wb_reply_save()}</Button>
    </div>
  {/if}
</div>
