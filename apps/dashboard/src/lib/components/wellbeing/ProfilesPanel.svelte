<!--
  Fiches confidentielles : ce que la cellule sait d'une personne, en notes
  datées, sans rien à traiter. Chaque note a sa date d'effacement et se
  prolonge avec un motif. Les dossiers de la personne s'ouvrent depuis sa fiche.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { dashboardFetch, type GuildMemberSearchResult } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { wbStatusLabel } from '../../wellbeingLabels';
  import { wbStatusTone } from '../../wellbeingView';
  import MemberSearchSelect from '../MemberSearchSelect.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, EmptyState } from '../ui';

  type ProfileHeader = { id: string; subjectUserId: string; subjectName: string; subjectLeftAt: string | null; noteCount: number; nextExpiry: string | null };
  type ProfileNote = { id: string; authorId: string; authorName: string; content: string; createdAt: string; expiresAt: string; extendedAt: string | null; extendedByName: string | null; extendedReason: string | null };
  type Profile = { id: string; subjectUserId: string; subjectName: string; subjectLeftAt: string | null; notes: ProfileNote[] };
  type CaseHeader = { id: string; title: string; status: string; subjectUserId?: string | null };

  const {
    cases,
    hidden,
    checkReauth,
    onopencase,
    onnewcase,
  }: {
    /** En-têtes des dossiers déjà chargés par la page. */
    cases: CaseHeader[];
    /** Mode discret : les notes ne sont pas rendues. */
    hidden: boolean;
    /** Connexion trop ancienne : la page propose de se reconnecter. */
    checkReauth: (res: Response) => Promise<boolean>;
    onopencase: (caseId: string) => void;
    onnewcase: (prefill: { subjectUserId: string; subjectName: string }) => void;
  } = $props();

  /** Mêmes plafonds que le bot. */
  const NOTE_MAX = 4000;
  const REASON_MAX = 500;

  let profiles = $state<ProfileHeader[]>([]);
  let search = $state('');
  let pickedId = $state('');
  let subject = $state<{ userId: string; name: string } | null>(null);
  let profile = $state<Profile | null>(null);
  let loading = $state(false);
  let text = $state('');
  let saving = $state(false);
  let extendingId = $state<string | null>(null);
  let reason = $state('');

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(dateLocale());
  const visible = $derived(profiles.filter((item) => item.subjectName.toLowerCase().includes(search.trim().toLowerCase())));
  const subjectCases = $derived(subject ? cases.filter((item) => item.subjectUserId === subject?.userId) : []);

  async function loadList() {
    const res = await dashboardFetch('/wellbeing/profiles').catch(() => null);
    if (!res || (await checkReauth(res))) return;
    if (res.ok) profiles = (await res.json()).profiles ?? [];
  }

  onMount(() => void loadList());

  async function open(userId: string, name: string) {
    subject = { userId, name };
    profile = null;
    text = '';
    extendingId = null;
    loading = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${userId}`);
      if (await checkReauth(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      profile = data.profile;
      if (profile) subject = { userId, name: profile.subjectName };
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_load_failed());
    } finally {
      loading = false;
    }
  }

  function pick(member: GuildMemberSearchResult) {
    pickedId = '';
    void open(member.id, member.displayName || member.username);
  }

  async function addNote() {
    const content = text.trim();
    if (!subject || !content || saving) return;
    saving = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${subject.userId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, subjectName: subject.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      profile = profile
        ? { ...profile, notes: [...profile.notes, data.note] }
        : { id: data.note.profileId, subjectUserId: subject.userId, subjectName: subject.name, subjectLeftAt: null, notes: [data.note] };
      text = '';
      toast.success(m.toast_wb_note_saved());
      void loadList();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      saving = false;
    }
  }

  async function remove(note: ProfileNote) {
    if (!subject || !profile || saving) return;
    if (!(await confirmDialog.danger(m.wb_profiles_delete_q(), m.wb_profiles_delete_warn(), m.wb_profiles_delete_confirm()))) return;
    saving = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${subject.userId}/notes/${note.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      profile = { ...profile, notes: profile.notes.filter((item) => item.id !== note.id) };
      toast.success(m.toast_wb_profile_note_deleted());
      void loadList();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      saving = false;
    }
  }

  async function extend(note: ProfileNote) {
    if (!subject || !profile || saving || !reason.trim()) return;
    saving = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${subject.userId}/notes/${note.id}/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      profile = { ...profile, notes: profile.notes.map((item) => (item.id === note.id ? data.note : item)) };
      extendingId = null;
      reason = '';
      toast.success(m.toast_wb_profile_note_extended());
      void loadList();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      saving = false;
    }
  }
</script>

<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
  <section class="space-y-3" aria-labelledby="wb-profiles-title">
    <div class="space-y-1">
      <h2 id="wb-profiles-title" class="text-sm font-semibold flex items-center gap-2 text-on-surface">
        <Papicon icon="StickyNote" size={15} /> {m.wb_profiles_title({ count: profiles.length })}
      </h2>
      <p class="text-xs text-on-surface-variant">{m.wb_profiles_desc()}</p>
    </div>
    <div class="space-y-1.5">
      <label for="wb-profile-pick" class="text-xs font-medium text-on-surface-variant">{m.wb_profiles_open()}</label>
      <MemberSearchSelect id="wb-profile-pick" bind:value={pickedId} placeholder={m.wb_profiles_open_ph()} onselect={pick} />
    </div>
    {#if profiles.length > 0}
      <label for="wb-profile-search" class="sr-only">{m.wb_profiles_search()}</label>
      <input id="wb-profile-search" type="search" class="input w-full" placeholder={m.wb_profiles_search()} bind:value={search} />
      <ul class="space-y-1.5">
        {#each visible as item (item.id)}
          <li>
            <button type="button" class="w-full rounded-lg border px-3 py-2 text-left text-sm {subject?.userId === item.subjectUserId ? 'border-primary/40 bg-primary/5' : 'border-outline-variant/30 bg-surface-container-lowest'}"
              aria-current={subject?.userId === item.subjectUserId} onclick={() => void open(item.subjectUserId, item.subjectName)}>
              <span class="font-semibold text-on-surface">{item.subjectName}</span>
              <span class="block text-2xs text-on-surface-variant">
                {m.wb_profiles_count({ count: item.noteCount })}{#if item.nextExpiry} · {m.wb_profiles_next_expiry({ date: formatDate(item.nextExpiry) })}{/if}{#if item.subjectLeftAt} · {m.wb_profiles_left()}{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-4 space-y-4 min-h-48" aria-live="polite">
    {#if !subject}
      <EmptyState icon="StickyNote" title={m.wb_profiles_empty_title()} description={m.wb_profiles_empty_desc()} />
    {:else}
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 class="text-base font-semibold text-on-surface">{subject.name}</h3>
          {#if profile?.subjectLeftAt}
            <p class="text-xs text-on-surface-variant">{m.wb_profiles_left_hint({ date: formatDate(profile.subjectLeftAt) })}</p>
          {/if}
        </div>
        <Button size="sm" variant="secondary" icon="FolderPlus" onclick={() => subject && onnewcase({ subjectUserId: subject.userId, subjectName: subject.name })}>{m.wb_profiles_new_case()}</Button>
      </div>

      {#if subjectCases.length > 0}
        <div class="space-y-1.5">
          <p class="text-xs font-medium text-on-surface-variant">{m.wb_profiles_cases({ count: subjectCases.length })}</p>
          <ul class="flex flex-wrap gap-2">
            {#each subjectCases as item (item.id)}
              <li>
                <button type="button" class="rounded-lg border border-outline-variant/30 px-2.5 py-1 text-xs flex items-center gap-1.5" onclick={() => onopencase(item.id)}>
                  {item.title} <span class="rounded-full px-1.5 py-0.5 text-2xs {wbStatusTone(item.status)}">{wbStatusLabel(item.status)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if loading}
        <p class="text-sm text-on-surface-variant flex items-center gap-2"><Papicon icon="Loader" size={14} /> {m.wb_profiles_loading()}</p>
      {:else if hidden}
        <p class="text-sm text-on-surface-variant">{m.wb_discreet_hidden()}</p>
      {:else}
        {#if profile && profile.notes.length > 0}
          <ul class="space-y-2">
            {#each profile.notes as note (note.id)}
              <li class="rounded-lg bg-surface-container-high/30 px-3 py-2 space-y-1.5">
                <p class="text-2xs text-on-surface-variant">
                  {note.authorName} · {formatDate(note.createdAt)} · {m.wb_profiles_note_expiry({ date: formatDate(note.expiresAt) })}
                </p>
                <p class="whitespace-pre-wrap text-sm">{note.content}</p>
                {#if note.extendedAt && note.extendedReason}
                  <p class="text-2xs text-on-surface-variant">{m.wb_profiles_note_extended({ name: note.extendedByName ?? '', date: formatDate(note.extendedAt), reason: note.extendedReason })}</p>
                {/if}
                {#if extendingId === note.id}
                  <div class="space-y-1.5">
                    <label for="wb-extend-{note.id}" class="text-xs font-medium text-on-surface-variant">{m.wb_profiles_extend_reason()}</label>
                    <input id="wb-extend-{note.id}" class="input w-full" maxlength={REASON_MAX} bind:value={reason} />
                    <div class="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onclick={() => { extendingId = null; reason = ''; }}>{m.wb_profiles_extend_cancel()}</Button>
                      <Button size="sm" variant="primary" icon="Clock" disabled={!reason.trim()} loading={saving} onclick={() => void extend(note)}>{m.wb_profiles_extend_confirm()}</Button>
                    </div>
                  </div>
                {:else}
                  <div class="flex justify-end gap-2">
                    {#if note.authorId === authStore.user?.id}
                      <Button size="sm" variant="ghost" icon="Trash2" disabled={saving} onclick={() => void remove(note)}>{m.wb_profiles_delete()}</Button>
                    {/if}
                    <Button size="sm" variant="ghost" icon="Clock" onclick={() => { extendingId = note.id; reason = ''; }}>{m.wb_profiles_extend()}</Button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-on-surface-variant">{m.wb_profiles_no_note()}</p>
        {/if}
        <div class="space-y-1.5">
          <label for="wb-profile-note" class="text-xs font-medium text-on-surface-variant">{m.wb_profiles_note_label()}</label>
          <textarea id="wb-profile-note" class="input w-full min-h-20" maxlength={NOTE_MAX} bind:value={text}></textarea>
          <p class="text-2xs text-on-surface-variant">{m.wb_profiles_note_hint()}</p>
          <div class="flex justify-end">
            <Button size="sm" variant="primary" icon="Send" disabled={!text.trim()} loading={saving} onclick={() => void addNote()}>{m.wb_profiles_note_add()}</Button>
          </div>
        </div>
      {/if}
    {/if}
  </section>
</div>
