<!--
  Fil d'une carte de liste de suivi, façon Jira : commentaires et historique
  (créée, déplacée, attribuée, modifiée, liée) dans l'ordre où c'est arrivé.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, FilterPills, type FilterOption } from '../ui';
  import Papicon from '../Papicon.svelte';
  import { m, dateLocale } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    addDoingListComment,
    deleteDoingListComment,
    fetchDoingListEvents,
    updateDoingListComment,
    type DoingListEvent,
  } from '../../api/doingLists';

  const {
    listId,
    itemId,
    canEdit,
    canModerateAll,
    myId,
    linkLabel,
    oncommentcount,
  }: {
    listId: string;
    itemId: string;
    canEdit: boolean;
    /** Un admin peut supprimer le commentaire d'un autre. */
    canModerateAll: boolean;
    myId: string | undefined;
    linkLabel: (type: string) => string;
    oncommentcount?: (count: number) => void;
  } = $props();

  let events = $state<DoingListEvent[]>([]);
  let loading = $state(true);
  let filter = $state<'all' | 'comments'>('all');
  let draft = $state('');
  let posting = $state(false);
  let editingId = $state<string | null>(null);
  let editDraft = $state('');

  const filterOptions: FilterOption<'all' | 'comments'>[] = [
    { value: 'all', label: m.dl_activity_all() },
    { value: 'comments', label: m.dl_activity_comments() },
  ];

  const shown = $derived(filter === 'comments' ? events.filter((event) => event.kind === 'comment') : events);

  const FIELD_LABEL: Record<string, () => string> = {
    title: m.dl_card_field_title,
    description: m.dl_card_field_description,
    priority: m.dl_card_field_priority,
    dueDate: m.dl_card_field_due,
    labels: m.dl_card_field_labels,
    checklist: m.dl_card_field_checklist,
    type: m.dl_card_field_type,
    estimate: m.dl_card_field_estimate,
    parentId: m.dl_card_field_parent,
  };

  onMount(async () => {
    try {
      events = (await fetchDoingListEvents(listId, itemId)).events ?? [];
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.dl_load_error());
    } finally {
      loading = false;
    }
  });

  function reportCount() {
    oncommentcount?.(events.filter((event) => event.kind === 'comment').length);
  }

  function when(value: string) {
    return new Date(value).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function describe(event: DoingListEvent): string {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const name = event.actorName;
    switch (event.kind) {
      case 'created': return m.dl_ev_created({ name });
      case 'moved': return m.dl_ev_moved({ name, from: String(data.from ?? ''), to: String(data.to ?? '') });
      case 'assigned': return m.dl_ev_assigned({ name, assignee: String(data.name ?? '') });
      case 'unassigned': return m.dl_ev_unassigned({ name });
      case 'updated': {
        const fields = Array.isArray(data.fields) ? data.fields.map((field) => FIELD_LABEL[String(field)]?.() ?? String(field)) : [];
        return m.dl_ev_updated({ name, fields: fields.join(', ').toLowerCase() });
      }
      case 'linked': return m.dl_ev_linked({ name, from: String(data.from ?? ''), link: linkLabel(String(data.type ?? '')), to: String(data.to ?? '') });
      case 'unlinked': return m.dl_ev_unlinked({ name, from: String(data.from ?? ''), link: linkLabel(String(data.type ?? '')), to: String(data.to ?? '') });
      default: return name;
    }
  }

  async function post(event: SubmitEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    posting = true;
    try {
      const res = await addDoingListComment(listId, itemId, draft);
      events = [...events, res.event];
      draft = '';
      reportCount();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.dl_save_error());
    } finally {
      posting = false;
    }
  }

  async function saveEdit(entry: DoingListEvent) {
    if (!editDraft.trim()) return;
    try {
      const res = await updateDoingListComment(listId, itemId, entry.id, editDraft);
      events = events.map((other) => (other.id === entry.id ? res.event : other));
      editingId = null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.dl_save_error());
    }
  }

  async function remove(entry: DoingListEvent) {
    if (!(await confirmDialog.danger(m.dl_comment_delete_title(), m.dl_comment_delete_desc(), m.common_delete()))) return;
    try {
      await deleteDoingListComment(listId, itemId, entry.id);
      events = events.filter((other) => other.id !== entry.id);
      reportCount();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.dl_save_error());
    }
  }
</script>

<section class="space-y-3">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-body-sm font-semibold text-on-surface">{m.dl_activity_title()}</h3>
    <FilterPills label={m.dl_activity_title()} options={filterOptions} value={filter} onchange={(value) => (filter = value)} />
  </div>

  {#if canEdit}
    <form class="space-y-2" onsubmit={post}>
      <textarea class="input w-full h-20 resize-y text-body-sm" maxlength="4000" bind:value={draft} placeholder={m.dl_comment_ph()} aria-label={m.dl_comment_ph()}></textarea>
      <div class="flex justify-end">
        <Button type="submit" size="sm" icon="message-square" loading={posting} disabled={!draft.trim()} disabledReason={m.common_reason_fill_field()}>{m.dl_comment_send()}</Button>
      </div>
    </form>
  {/if}

  {#if loading}
    <p class="text-2xs text-on-surface-variant">{m.common_loading()}</p>
  {:else if shown.length === 0}
    <p class="text-2xs text-on-surface-variant">{filter === 'comments' ? m.dl_activity_no_comment() : m.dl_activity_empty()}</p>
  {:else}
    <ol class="space-y-2">
      {#each [...shown].reverse() as entry (entry.id)}
        {#if entry.kind === 'comment'}
          <li class="dl-comment">
            <div class="flex items-center justify-between gap-2 text-2xs text-on-surface-variant">
              <span><strong class="text-on-surface">{entry.actorName}</strong> · {when(entry.createdAt)}{entry.updatedAt !== entry.createdAt ? ` · ${m.dl_comment_edited()}` : ''}</span>
              {#if canEdit && (entry.actorId === myId || canModerateAll)}
                <span class="flex gap-2">
                  {#if entry.actorId === myId}
                    <button type="button" class="hover:text-on-surface" onclick={() => { editingId = entry.id; editDraft = entry.body ?? ''; }}>{m.common_edit()}</button>
                  {/if}
                  <button type="button" class="hover:text-error" onclick={() => remove(entry)}>{m.common_delete()}</button>
                </span>
              {/if}
            </div>
            {#if editingId === entry.id}
              <textarea class="input mt-1 w-full h-20 resize-y text-body-sm" maxlength="4000" bind:value={editDraft} aria-label={m.dl_comment_ph()}></textarea>
              <div class="mt-1 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onclick={() => (editingId = null)}>{m.common_cancel()}</Button>
                <Button size="sm" onclick={() => saveEdit(entry)}>{m.common_save()}</Button>
              </div>
            {:else}
              <p class="mt-1 whitespace-pre-wrap wrap-break-word text-body-sm text-on-surface">{entry.body}</p>
            {/if}
          </li>
        {:else}
          <li class="flex items-start gap-2 px-1 text-2xs text-on-surface-variant">
            <Papicon icon="clock" size={12} class="mt-0.5 shrink-0" />
            <span class="wrap-break-word">{describe(entry)} · {when(entry.createdAt)}</span>
          </li>
        {/if}
      {/each}
    </ol>
  {/if}
</section>

<style>
  .dl-comment {
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-surface-container);
  }
</style>
