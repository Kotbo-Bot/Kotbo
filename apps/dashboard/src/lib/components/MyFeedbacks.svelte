<script lang="ts">
  /** « Mes retours » : statut de chaque retour envoyé et conversation avec l'équipe. */
  import { onMount } from 'svelte';
  import Papicon from './Papicon.svelte';
  import Button from './ui/Button.svelte';
  import FormTextarea from './FormTextarea.svelte';
  import { toast } from '../stores/toast.svelte';
  import { errorMessage } from '@kotbo/shared';
  import {
    fetchFeedback,
    fetchMyFeedbacks,
    replyToFeedback,
    type FeedbackDetail,
    type FeedbackStatus,
    type FeedbackSummary,
  } from '../api';
  import { m } from '../i18n';

  const STATUS_LABEL: Record<FeedbackStatus, () => string> = {
    NEW: m.d1_fb_status_NEW,
    ACKNOWLEDGED: m.d1_fb_status_ACKNOWLEDGED,
    PLANNED: m.d1_fb_status_PLANNED,
    DONE: m.d1_fb_status_DONE,
    DECLINED: m.d1_fb_status_DECLINED,
  };

  /** Revenir à l'envoi : un historique vide ne doit pas être un cul-de-sac. */
  const { onwrite }: { onwrite: () => void } = $props();

  let items = $state<FeedbackSummary[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let detail = $state<FeedbackDetail | null>(null);
  let reply = $state('');
  let busy = $state(false);

  onMount(async () => {
    try {
      items = (await fetchMyFeedbacks()).feedbacks;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  });

  async function open(id: string) {
    try {
      detail = (await fetchFeedback(id)).feedback;
      reply = '';
    } catch (err) {
      toast.error(errorMessage(err) || m.d1_fb_mine_load_failed());
    }
  }

  async function send() {
    if (!detail || !reply.trim() || busy) return;
    busy = true;
    try {
      await replyToFeedback(detail.id, reply.trim());
      reply = '';
      detail = (await fetchFeedback(detail.id)).feedback;
    } catch (err) {
      toast.error(errorMessage(err) || m.d1_fb_reply_failed());
    } finally {
      busy = false;
    }
  }

  const date = (iso: string) => new Date(iso).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
</script>

<div class="p-6 space-y-3 relative z-10 min-h-48">
  {#if detail}
    <button type="button" class="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline" onclick={() => (detail = null)}>
      <Papicon icon="arrow-left" size={12} />{m.d1_fb_tab_mine()}
    </button>
    <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3.5 space-y-1.5">
      <span class="inline-flex rounded-full bg-primary/12 px-2 py-0.5 text-2xs font-semibold text-primary">{STATUS_LABEL[detail.status]()}</span>
      <p class="text-body-sm text-on-surface whitespace-pre-wrap break-words">{detail.message}</p>
    </div>
    <ul class="space-y-2 max-h-64 overflow-y-auto">
      {#each detail.messages as message (message.id)}
        <li class="rounded-xl border p-3 text-body-sm {message.fromStaff ? 'border-primary/25 bg-primary/6 mr-6' : 'border-outline-variant/25 bg-surface-container-lowest/70 ml-6'}">
          <p class="text-2xs font-semibold text-on-surface-variant mb-1">{message.fromStaff ? m.d1_fb_team() : message.authorName} · {date(message.createdAt)}</p>
          <p class="text-on-surface whitespace-pre-wrap break-words">{message.content}</p>
        </li>
      {/each}
    </ul>
    <FormTextarea
      ariaLabel={m.d1_fb_reply_ph()}
      bind:value={reply}
      rows={3}
      placeholder={m.d1_fb_reply_ph()}
      disabled={busy}
      className="w-full rounded-lg border border-field-border bg-surface-container-low px-3 py-2 text-sm text-on-surface"
    />
    <div class="flex justify-end">
      <button
        type="button"
        onclick={send}
        disabled={busy || !reply.trim()}
        class="px-4 py-2 text-xs rounded-xl font-semibold bg-primary text-on-primary disabled:cursor-not-allowed disabled:opacity-60"
      >{m.d1_fb_reply_send()}</button>
    </div>
  {:else if loading}
    <div class="h-16 rounded-xl bg-on-surface/6 animate-pulse"></div>
  {:else if failed}
    <p class="text-body-sm text-error">{m.d1_fb_mine_load_failed()}</p>
  {:else if items.length === 0}
    <div class="flex flex-col items-center gap-3 py-8 text-center">
      <span class="icon-disc" aria-hidden="true"><Papicon icon="MessageCircle" size={16} /></span>
      <p class="text-sm text-on-surface-variant">{m.d1_fb_mine_empty()}</p>
      <Button variant="primary" size="sm" icon="edit" onclick={onwrite}>{m.d1_fb_write()}</Button>
    </div>
  {:else}
    <ul class="space-y-1.5 max-h-80 overflow-y-auto">
      {#each items as item (item.id)}
        <li>
          <button
            type="button"
            onclick={() => open(item.id)}
            class="w-full text-left rounded-xl border border-outline-variant/25 bg-surface-container-lowest/70 p-3 space-y-1 hover:border-primary/35 transition focus-visible:outline-2 focus-visible:outline-primary"
          >
            <div class="flex items-center gap-2">
              <span class="rounded-full bg-primary/12 px-2 py-0.5 text-2xs font-semibold text-primary">{STATUS_LABEL[item.status]()}</span>
              <span class="ml-auto text-2xs text-on-surface-variant tabular-nums">{date(item.createdAt)}</span>
            </div>
            <p class="text-body-sm text-on-surface line-clamp-2">{item.message}</p>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
