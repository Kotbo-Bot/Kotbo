<!--
  Documents Google Drive d'un dossier : seul le lien est gardé, chiffré par le
  bot ; l'accès au fichier reste réglé par son partage dans Drive.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button } from '../ui';

  type Attachment = { id: string; label: string; url: string; addedByName: string };

  const {
    caseId,
    attachments = [],
    canWrite,
    hidden,
    onchange,
  }: {
    caseId: string;
    attachments?: Attachment[];
    canWrite: boolean;
    /** Mode discret : les liens ne sont pas rendus. */
    hidden: boolean;
    onchange: (item: any) => void;
  } = $props();

  /** Même plafond que le bot (MAX_CASE_ATTACHMENTS). */
  const MAX_ATTACHMENTS = 20;
  /** Un lien illisible (clé changée) ne devient jamais un href. */
  const isDriveLink = (url: string) => /^https:\/\/(drive|docs)\.google\.com\//.test(url);

  let label = $state('');
  let url = $state('');
  let adding = $state(false);
  let removingId = $state<string | null>(null);

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (adding) return;
    adding = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), url: url.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      onchange(data.item);
      label = '';
      url = '';
      toast.success(m.toast_wb_attachment_added());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_attachment_failed());
    } finally {
      adding = false;
    }
  }

  async function remove(attachmentId: string) {
    if (removingId) return;
    if (!(await confirmDialog.danger(m.wb_attachment_remove_q(), m.wb_attachment_remove_warn()))) return;
    removingId = attachmentId;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/attachments/${attachmentId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      onchange(data.item);
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_attachment_failed());
    } finally {
      removingId = null;
    }
  }
</script>

<div class="space-y-2">
  <p class="text-xs text-on-surface-variant">{m.wb_attachments_desc()}</p>
  {#if hidden && attachments.length > 0}
    <p class="text-xs italic text-on-surface-variant">{m.wb_discreet_attachments_hidden({ count: attachments.length })}</p>
  {:else}
    {#each attachments as attachment (attachment.id)}
      <div class="flex items-center justify-between gap-2 rounded-lg bg-surface-container-high/20 px-3 py-2 text-sm">
        <span class="flex items-center gap-2 min-w-0">
          <Papicon icon="file-text" size={14} />
          {#if isDriveLink(attachment.url)}
            <a href={attachment.url} target="_blank" rel="noopener noreferrer" class="text-primary hover:underline truncate">{attachment.label}</a>
          {:else}
            <span class="truncate text-on-surface-variant">{attachment.label}</span>
          {/if}
        </span>
        <span class="flex items-center gap-1 shrink-0 text-xs text-on-surface-variant">
          {attachment.addedByName}
          {#if canWrite}
            <Button size="sm" variant="ghost" icon="trash" loading={removingId === attachment.id}
              aria-label={m.wb_attachment_remove({ name: attachment.label })}
              onclick={() => void remove(attachment.id)} />
          {/if}
        </span>
      </div>
    {/each}
  {/if}
  {#if canWrite && attachments.length < MAX_ATTACHMENTS}
    <form onsubmit={add} class="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
      <input bind:value={label} maxlength={120} class="input text-sm" aria-label={m.wb_attachment_label()} placeholder={m.wb_attachment_label()} />
      <input bind:value={url} type="url" required maxlength={500} class="input text-sm" aria-label={m.wb_attachment_url()} placeholder={m.wb_attachment_url_ph()} />
      <Button type="submit" size="sm" variant="secondary" icon="Plus" loading={adding}>{m.common_add()}</Button>
    </form>
  {/if}
</div>
