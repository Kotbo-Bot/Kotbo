<!--
  Historique d'un dossier : notes et gestes, du plus récent au plus ancien.
  Une note se corrige par son auteur dans les 48 heures, la version d'origine
  reste lisible. Les gestes à la suite se replient ; « Notes seulement » est
  retenu par navigateur. La page monte un composant par dossier ouvert.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import MemberName from '../MemberName.svelte';
  import Papicon from '../Papicon.svelte';
  import WellbeingMemberList from '../WellbeingMemberList.svelte';
  import { Button } from '../ui';
  import { wbCaseEventLabel } from '../../wellbeingLabels';
  import { wbCaseTimeline, wbCompactTimeline } from '../../wellbeingView';

  const {
    item,
    canWrite,
    hidden,
    viewerId,
    candidates,
    onchange,
    onreload,
  }: {
    /** Dossier ouvert, avec ses notes et son historique. */
    item: any;
    canWrite: boolean;
    /** Mode discret : le contenu des notes n'est pas rendu. */
    hidden: boolean;
    viewerId: string | undefined;
    /** Collègues de la cellule à prévenir d'une note. */
    candidates: Array<{ id: string; name: string }>;
    /** Dossier renvoyé par le bot après un geste. */
    onchange: (item: any) => void;
    /** Relit le dossier depuis le bot. */
    onreload: () => Promise<void>;
  } = $props();

  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());
  const formatDay = (iso: string) => new Date(iso).toLocaleDateString(dateLocale());

  const timeline = $derived(wbCaseTimeline(item));
  const NOTES_ONLY_KEY = 'kotbo:wellbeing:notes-only';
  let notesOnly = $state(typeof localStorage !== 'undefined' && localStorage.getItem(NOTES_ONLY_KEY) === '1');
  let expandedGroups = $state<string[]>([]);
  const compactTimeline = $derived(wbCompactTimeline(timeline, { notesOnly, expanded: expandedGroups }));
  function setNotesOnly(value: boolean) {
    notesOnly = value;
    try { localStorage.setItem(NOTES_ONLY_KEY, value ? '1' : '0'); } catch { /* stockage indisponible : réglage gardé pour la session */ }
  }

  // Nouvelle note, et collègues de la cellule prévenus en privé.
  let newNote = $state('');
  let noteNotify = $state<string[]>([]);
  let noteInput = $state<HTMLTextAreaElement>();
  let addingNote = $state(false);

  /** Raccourci « n » de la page : le champ de note prend la main. */
  export async function focusNote() {
    await tick();
    noteInput?.focus();
  }

  async function addNote(event: SubmitEvent) {
    event.preventDefault();
    if (!newNote.trim() || addingNote) return;
    addingNote = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${item.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newNote.trim(), notifyUserIds: noteNotify }),
      });
      if (!res.ok) throw new Error('note');
      newNote = '';
      noteNotify = [];
      await onreload();
    } catch {
      toast.error(m.toast_wb_note_failed());
    } finally {
      addingNote = false;
    }
  }

  // Correction d'une note par son auteur, dans le même délai que le bot (NOTE_EDIT_HOURS).
  const NOTE_EDIT_MS = 48 * 60 * 60 * 1000;
  let editingNoteId = $state<string | null>(null);
  let editingText = $state('');
  let savingNote = $state(false);
  let originalShown = $state<Record<string, boolean>>({});
  const canEditNote = (note: any) => canWrite && note.authorId === viewerId && Date.now() - new Date(note.createdAt).getTime() < NOTE_EDIT_MS;

  async function saveNoteEdit() {
    const noteId = editingNoteId;
    if (!noteId || !editingText.trim() || savingNote) return;
    savingNote = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${item.id}/notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editingText.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      onchange(data.item);
      editingNoteId = null;
      toast.success(m.toast_wb_note_edited());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_note_failed());
    } finally {
      savingNote = false;
    }
  }
</script>

<div class="space-y-3">
  {#if canWrite}
    <form onsubmit={addNote} class="space-y-2">
      <textarea bind:this={noteInput} bind:value={newNote} aria-label={m.a11y_wellbeing_note()} required rows={2} placeholder={m.wb_note_ph()} class="input w-full text-sm"></textarea>
      <div class="space-y-1">
        <label for="wb-note-notify" class="text-xs font-medium text-on-surface-variant">{m.wb_note_notify()}</label>
        <WellbeingMemberList id="wb-note-notify" bind:ids={noteNotify} max={5} {candidates} />
      </div>
      <div class="flex justify-end">
        <Button type="submit" size="sm" variant="primary" icon="Plus" loading={addingNote} disabled={!newNote.trim()}>{m.wb_note_add()}</Button>
      </div>
    </form>
  {/if}
  {#if timeline.length > 0}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div role="group" aria-label={m.wb_timeline_view_label()} class="inline-flex rounded-lg border border-outline-variant/40 bg-surface-container p-0.5 text-xs">
        <button type="button" aria-pressed={!notesOnly} onclick={() => setNotesOnly(false)}
          class="rounded-md px-2.5 py-1 {!notesOnly ? 'bg-surface-container-highest font-semibold text-on-surface' : 'text-on-surface-variant'}">{m.wb_timeline_all()}</button>
        <button type="button" aria-pressed={notesOnly} onclick={() => setNotesOnly(true)}
          class="rounded-md px-2.5 py-1 {notesOnly ? 'bg-surface-container-highest font-semibold text-on-surface' : 'text-on-surface-variant'}">{m.wb_timeline_notes_only()}</button>
      </div>
      {#if !notesOnly && expandedGroups.length > 0}
        <Button size="sm" variant="ghost" icon="ChevronUp" onclick={() => (expandedGroups = [])}>{m.wb_timeline_collapse_all()}</Button>
      {/if}
    </div>
  {/if}
  {#if compactTimeline.length === 0}
    <p class="text-xs text-on-surface-variant">{timeline.length === 0 ? m.wb_timeline_empty() : m.wb_timeline_no_note()}</p>
  {:else}
    <ol class="relative border-l border-outline-variant/50 ml-2 space-y-3">
      {#each compactTimeline as entry (entry.id)}
        <li class="ml-4">
          <span class="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full {entry.kind === 'note' ? 'bg-primary' : 'bg-outline-variant'}" aria-hidden="true"></span>
          {#if entry.kind === 'group'}
            <button type="button" aria-expanded="false" class="flex flex-wrap items-center gap-x-2 text-xs text-on-surface-variant hover:text-on-surface"
              onclick={() => (expandedGroups = [...expandedGroups, entry.id])}>
              <Papicon icon="ChevronDown" size={12} />
              <span class="font-medium">{m.wb_timeline_group({ count: entry.count })}</span>
              <span>· {formatDay(entry.entries[entry.entries.length - 1]!.at)} – {formatDay(entry.at)}</span>
            </button>
          {:else if entry.kind === 'note'}
            <div class="rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-3 text-sm">
              <div class="flex flex-wrap justify-between gap-2 text-xs text-on-surface-variant mb-1">
                <span class="font-semibold text-on-surface">{entry.note.authorName}</span>
                <span>{formatDate(entry.at)}</span>
              </div>
              {#if hidden}
                <p class="text-xs italic text-on-surface-variant">{m.wb_discreet_note_hidden()}</p>
              {:else if editingNoteId === entry.note.id}
                <div class="space-y-2">
                  <textarea bind:value={editingText} rows={3} class="input w-full text-sm" aria-label={m.wb_note_edit_label()}></textarea>
                  <div class="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onclick={() => (editingNoteId = null)}>{m.common_cancel()}</Button>
                    <Button size="sm" variant="primary" loading={savingNote} disabled={!editingText.trim()} onclick={() => void saveNoteEdit()}>{m.common_save()}</Button>
                  </div>
                </div>
              {:else}
                <p class="whitespace-pre-wrap text-on-surface">{entry.note.content}</p>
                <div class="flex flex-wrap items-center gap-2 mt-1.5 text-2xs text-on-surface-variant">
                  {#if entry.note.editedAt}
                    <span>{m.wb_note_edited({ date: formatDate(entry.note.editedAt) })}</span>
                    {#if entry.note.originalContent}
                      <button type="button" class="underline hover:text-on-surface" aria-expanded={!!originalShown[entry.note.id]}
                        onclick={() => (originalShown = { ...originalShown, [entry.note.id]: !originalShown[entry.note.id] })}>
                        {originalShown[entry.note.id] ? m.wb_note_hide_original() : m.wb_note_show_original()}
                      </button>
                    {/if}
                  {/if}
                  {#if canEditNote(entry.note)}
                    <button type="button" class="underline hover:text-on-surface" onclick={() => { editingNoteId = entry.note.id; editingText = entry.note.content; }}>{m.wb_note_edit()}</button>
                  {/if}
                </div>
                {#if entry.note.originalContent && originalShown[entry.note.id]}
                  <p class="mt-2 whitespace-pre-wrap text-xs text-on-surface-variant border-l-2 border-outline-variant pl-2">{entry.note.originalContent}</p>
                {/if}
              {/if}
            </div>
          {:else}
            <p class="flex flex-wrap items-center gap-x-2 text-xs text-on-surface-variant">
              <span class="font-medium text-on-surface">{entry.event.actorName}</span>
              <span>{wbCaseEventLabel(entry.event, formatDay)}</span>
              {#if entry.event.type === 'ASSIGNEE' && entry.event.toValue}<MemberName userId={entry.event.toValue} />{/if}
              <span>· {formatDate(entry.at)}</span>
            </p>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>
