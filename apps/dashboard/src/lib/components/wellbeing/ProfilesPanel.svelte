<!--
  Page par personne : à gauche les personnes suivies (une fiche, des
  dossiers, ou les deux) ; à droite la personne choisie, ses notes en haut,
  ses dossiers en dessous, qui se déplient sur place avec tout leur détail.
  Chaque note a sa date d'effacement et se prolonge avec un motif.
-->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { dashboardFetch, type GuildMemberSearchResult } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { memberIdentities } from '../../stores/memberIdentities.svelte';
  import { wbSeverityLabel, wbStatusLabel } from '../../wellbeingLabels';
  import { wbSeverityTone, wbStatusTone } from '../../wellbeingView';
  import { wbPeople, type WbPersonCase } from '../../wellbeingPeople';
  import { wbCaseTags, wbFilterByTag } from '../../wellbeingCustom';
  import { wbCustom } from '../../stores/wellbeingCustomization.svelte';
  import TagPicker from './TagPicker.svelte';
  import MemberSearchSelect from '../MemberSearchSelect.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, Callout, EmptyState } from '../ui';

  type ProfileHeader = { id: string; subjectUserId: string; subjectName: string; subjectLeftAt: string | null; noteCount: number; nextExpiry: string | null; tagIds?: string[] };
  type ProfileNote = { id: string; authorId: string; authorName: string; content: string; sensitive: boolean; createdAt: string; expiresAt: string; extendedAt: string | null; extendedByName: string | null; extendedReason: string | null };
  type Profile = { id: string; subjectUserId: string; subjectName: string; subjectLeftAt: string | null; tagIds?: string[]; notes: ProfileNote[] };
  type CaseHeader = WbPersonCase & { title: string; severity: string; updatedAt?: string };

  const {
    cases,
    hidden,
    initialSubjectId = null,
    checkReauth,
    selectedCaseId,
    caseDetail,
    onselectcase,
    onnewcase,
  }: {
    /** En-têtes des dossiers déjà chargés par la page. */
    cases: CaseHeader[];
    /** Mode discret : les notes ne sont pas rendues. */
    hidden: boolean;
    /** Fiche ouverte d'emblée (lien depuis la fiche membre). */
    initialSubjectId?: string | null;
    /** Connexion trop ancienne : la page propose de se reconnecter. */
    checkReauth: (res: Response) => Promise<boolean>;
    /** Dossier déplié : son détail complet s'affiche sous sa ligne. */
    selectedCaseId: string | null;
    caseDetail: Snippet;
    /** Déplie un dossier (son ouverture est tracée), ou replie avec null. */
    onselectcase: (caseId: string | null) => void;
    onnewcase: (prefill: { subjectUserId: string; subjectName: string }) => void;
  } = $props();

  /** Mêmes plafonds que le bot. */
  const NOTE_MAX = 4000;
  const REASON_MAX = 500;

  let profiles = $state<ProfileHeader[]>([]);
  let search = $state('');
  let pickedId = $state('');
  /** Recherche d'un membre du serveur, ouverte seulement pour commencer une fiche. */
  let picking = $state(false);
  let subject = $state<{ userId: string; name: string } | null>(null);
  let profile = $state<Profile | null>(null);
  let loading = $state(false);
  let text = $state('');
  let sensitive = $state(false);
  /** Notes sensibles affichées d'un clic, le temps de la fiche ouverte. */
  let shownSensitive = $state<string[]>([]);
  let saving = $state(false);
  let extendingId = $state<string | null>(null);
  let reason = $state('');

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(dateLocale());
  const people = $derived(wbPeople(profiles, cases));
  /** Étiquette choisie pour filtrer les personnes ; `null` : toutes. */
  let tagFilter = $state<string | null>(null);
  const visible = $derived(wbFilterByTag(people, tagFilter).filter((person) => person.name.toLowerCase().includes(search.trim().toLowerCase())));
  /** Sa propre fiche ne s'ouvre pas : le bot la refuse, la page le dit avant. */
  const isSelf = $derived(!!subject && subject.userId === authStore.user?.id);
  const subjectCases = $derived(subject ? cases.filter((item) => item.subjectUserId === subject?.userId) : []);

  async function loadList() {
    const res = await dashboardFetch('/wellbeing/profiles').catch(() => null);
    if (!res || (await checkReauth(res))) return;
    if (res.ok) profiles = (await res.json()).profiles ?? [];
  }

  onMount(() => {
    void loadList();
    if (initialSubjectId) void open(initialSubjectId, memberIdentities.get(initialSubjectId)?.displayName ?? initialSubjectId);
  });

  async function open(userId: string, name: string) {
    subject = { userId, name };
    profile = null;
    text = '';
    sensitive = false;
    shownSensitive = [];
    extendingId = null;
    if (userId === authStore.user?.id) return;
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
    picking = false;
    void open(member.id, member.displayName || member.username);
  }

  let savingTags = $state(false);
  /** Étiquettes de la fiche ouverte : enregistrées aussitôt, la liste suit. */
  async function saveTags(tagIds: string[]) {
    const current = profile;
    if (!current || savingTags) return;
    savingTags = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${current.subjectUserId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      profile = { ...current, tagIds: data.tagIds };
      profiles = profiles.map((item) => (item.subjectUserId === current.subjectUserId ? { ...item, tagIds: data.tagIds } : item));
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      savingTags = false;
    }
  }

  async function addNote() {
    const content = text.trim();
    if (!subject || !content || saving) return;
    saving = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${subject.userId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, subjectName: subject.name, sensitive }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      profile = profile
        ? { ...profile, notes: [...profile.notes, data.note] }
        : { id: data.note.profileId, subjectUserId: subject.userId, subjectName: subject.name, subjectLeftAt: null, notes: [data.note] };
      if (sensitive) shownSensitive = [...shownSensitive, data.note.id];
      text = '';
      sensitive = false;
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
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="wb-profiles-title" class="text-sm font-semibold flex items-center gap-2 text-on-surface">
          <Papicon icon="StickyNote" size={15} /> {m.wb_profiles_title({ count: people.length })}
        </h2>
        <Button size="sm" variant={picking ? 'ghost' : 'secondary'} icon={picking ? 'X' : 'UserPlus'} aria-expanded={picking}
          onclick={() => { picking = !picking; pickedId = ''; }}>{picking ? m.common_cancel() : m.wb_profiles_new()}</Button>
      </div>
      <p class="text-xs text-on-surface-variant">{m.wb_profiles_desc()}</p>
    </div>
    {#if picking}
      <div class="space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <label for="wb-profile-pick" class="text-xs font-medium text-on-surface">{m.wb_profiles_open()}</label>
        <MemberSearchSelect id="wb-profile-pick" bind:value={pickedId} placeholder={m.wb_profiles_open_ph()} onselect={pick} />
        <p class="text-2xs text-on-surface-variant">{m.wb_profiles_open_hint()}</p>
      </div>
    {/if}
    {#if people.length > 0}
      <label for="wb-profile-search" class="text-xs font-medium text-on-surface-variant">{m.wb_profiles_search()}</label>
      <input id="wb-profile-search" type="search" class="input w-full" placeholder={m.wb_profiles_search_ph()} bind:value={search} />
      {#if wbCustom.value.tags.length > 0}
        <select value={tagFilter ?? ''} onchange={(event) => (tagFilter = event.currentTarget.value || null)} class="input w-full text-sm" aria-label={m.wb_tag_filter()}>
          <option value="">{m.wb_tag_filter_all()}</option>
          {#each wbCustom.value.tags as tag (tag.id)}<option value={tag.id}>{tag.label}</option>{/each}
        </select>
      {/if}
      <ul class="space-y-1.5">
        {#each visible as person (person.userId)}
          <li>
            <button type="button" class="w-full rounded-lg border px-3 py-2 text-left text-sm {subject?.userId === person.userId ? 'border-primary/40 bg-primary/5' : 'border-outline-variant/30 bg-surface-container-lowest'}"
              aria-current={subject?.userId === person.userId} onclick={() => void open(person.userId, person.name)}>
              <span class="font-semibold text-on-surface">{person.name}</span>
              {#each wbCaseTags(wbCustom.value, person.tagIds) as tag (tag.id)}
                <span class="ml-1 text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">{tag.label}</span>
              {/each}
              <span class="block text-2xs text-on-surface-variant">
                {m.wb_profiles_count({ count: person.noteCount })} · {m.wb_people_cases({ count: person.activeCases })}{#if person.nextExpiry} · {m.wb_profiles_next_expiry({ date: formatDate(person.nextExpiry) })}{/if}{#if person.leftAt} · {m.wb_profiles_left()}{/if}
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
        {#if !isSelf}
          <Button size="sm" variant="secondary" icon="FolderPlus" onclick={() => subject && onnewcase({ subjectUserId: subject.userId, subjectName: subject.name })}>{m.wb_profiles_new_case()}</Button>
        {/if}
      </div>

      {#if isSelf}
        <Callout variant="info" title={m.wb_profiles_self_title()}>{m.wb_profiles_self_desc()}</Callout>
      {:else}
      {#if profile}
        <TagPicker tagIds={profile.tagIds ?? []} canWrite={true} busy={savingTags} onchange={(tagIds) => void saveTags(tagIds)} />
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
                <p class="text-2xs text-on-surface-variant flex flex-wrap items-center gap-1.5">
                  {#if note.sensitive}<span class="rounded-full px-2 py-0.5 bg-warning/15 text-on-warning-container border border-warning/30">{m.wb_profiles_sensitive_badge()}</span>{/if}
                  {note.authorName} · {formatDate(note.createdAt)} · {m.wb_profiles_note_expiry({ date: formatDate(note.expiresAt) })}
                </p>
                {#if note.sensitive && !shownSensitive.includes(note.id)}
                  <Button size="sm" variant="secondary" icon="eye" onclick={() => (shownSensitive = [...shownSensitive, note.id])}>{m.wb_profiles_sensitive_reveal()}</Button>
                {:else}
                  <p class="whitespace-pre-wrap text-sm">{note.content}</p>
                {/if}
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
          <label class="flex items-start gap-2 text-xs text-on-surface">
            <input type="checkbox" class="mt-0.5" bind:checked={sensitive} />
            <span>{m.wb_profiles_sensitive_label()} <span class="block text-2xs text-on-surface-variant">{m.wb_profiles_sensitive_hint()}</span></span>
          </label>
          <p class="text-2xs text-on-surface-variant">{m.wb_profiles_note_hint()}</p>
          <div class="flex justify-end">
            <Button size="sm" variant="primary" icon="Send" disabled={!text.trim()} loading={saving} onclick={() => void addNote()}>{m.wb_profiles_note_add()}</Button>
          </div>
        </div>
      {/if}

      <div class="space-y-2 border-t border-outline-variant/30 pt-4">
        <h4 class="text-sm font-semibold text-on-surface flex items-center gap-2"><Papicon icon="folder" size={14} /> {m.wb_profiles_cases({ count: subjectCases.length })}</h4>
        {#if subjectCases.length === 0}
          <p class="text-sm text-on-surface-variant">{m.wb_people_no_case()}</p>
        {/if}
        <ul class="space-y-2">
          {#each subjectCases as item (item.id)}
            <li class="space-y-3">
              <button type="button" class="w-full rounded-lg border px-3 py-2 text-left text-sm flex flex-wrap items-center justify-between gap-2 {selectedCaseId === item.id ? 'border-primary/40 bg-primary/5' : 'border-outline-variant/30 bg-surface-container-lowest'}"
                aria-expanded={selectedCaseId === item.id} onclick={() => onselectcase(selectedCaseId === item.id ? null : item.id)}>
                <span class="font-semibold text-on-surface min-w-0 truncate">{item.title}</span>
                <span class="flex items-center gap-1.5 text-2xs">
                  <span class="rounded-full px-2 py-0.5 {wbSeverityTone(item.severity)}">{wbSeverityLabel(item.severity)}</span>
                  <span class="rounded-full px-2 py-0.5 {wbStatusTone(item.status)}">{wbStatusLabel(item.status)}</span>
                  <Papicon icon={selectedCaseId === item.id ? 'ChevronUp' : 'ChevronDown'} size={14} />
                </span>
              </button>
              {#if selectedCaseId === item.id}
                {@render caseDetail()}
              {/if}
            </li>
          {/each}
        </ul>
      </div>
      {/if}
    {/if}
  </section>
</div>
