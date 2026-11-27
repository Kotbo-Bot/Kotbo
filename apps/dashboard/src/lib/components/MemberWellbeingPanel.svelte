<!--
  Onglet « Suivi confidentiel » de la fiche membre : fiche confidentielle de la
  personne (note rapide, notes affichées à la demande) et ses dossiers. Monté
  seulement pour la cellule de suivi : l'API refuse les autres (403), même
  admins, hors accès d'urgence, qui n'ouvre que les dossiers.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { dashboardFetch } from '../api';
  import { toast } from '../stores/toast.svelte';
  import { dateLocale, m } from '../i18n';
  import { wbStatusLabel } from '../wellbeingLabels';
  import { Button } from './ui';
  import { authStore } from '../stores/auth.svelte';
  import { memberCaseModal } from '../stores/memberCaseModal.svelte';
  import { router } from 'tinro';

  let { userId, userName, canWrite = false }: { userId: string; userName: string; canWrite?: boolean } = $props();

  type Note = { id: string; authorName: string; content: string; createdAt: string };
  /** En-tête de la liste ; le contenu se lit dossier par dossier, ce qui trace chaque ouverture. */
  type Case = { id: string; title: string; status: string; severity: string; createdAt: string };
  type CaseContent = { summary: string; notes: Note[]; createdByName: string };

  type ProfileNote = { id: string; authorName: string; content: string; sensitive: boolean; createdAt: string; expiresAt: string };
  let sensitive = $state(false);
  /** Notes sensibles affichées d'un clic. */
  let shownSensitive = $state<string[]>([]);

  /** Notes de la fiche, lues seulement à la demande : chaque lecture est tracée. */
  let profileNotes = $state<ProfileNote[] | null>(null);
  let profileLoading = $state(false);

  async function revealProfile() {
    if (profileLoading) return;
    profileLoading = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${userId}`);
      if (await reauthAsked(res)) return;
      if (!res.ok) throw new Error('profile');
      profileNotes = (await res.json()).profile?.notes ?? [];
    } catch {
      toast.error(m.toast_wb_load_failed());
    } finally {
      profileLoading = false;
    }
  }

  function openInCell() {
    memberCaseModal.close();
    router.goto(`/wellbeing?profile=${encodeURIComponent(userId)}`);
  }

  let cases = $state<Case[]>([]);
  let contents = $state<Record<string, CaseContent>>({});
  let openingId = $state<string | null>(null);

  async function reveal(caseId: string) {
    if (contents[caseId] || openingId) return;
    openingId = caseId;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}`);
      if (await reauthAsked(res)) return;
      if (!res.ok) throw new Error('detail');
      const { item } = await res.json();
      contents = { ...contents, [caseId]: { summary: item.summary, notes: item.notes ?? [], createdByName: item.createdByName } };
    } catch {
      toast.error(m.toast_wb_load_failed());
    } finally {
      openingId = null;
    }
  }
  let loading = $state(true);
  let text = $state('');
  let busy = $state(false);

  const fmt = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  /** Le bot exige une connexion récente pour lire les dossiers de la cellule. */
  let reauth = $state(false);
  async function reauthAsked(res: Response): Promise<boolean> {
    if (res.status !== 403) return false;
    const data = await res.clone().json().catch(() => ({}));
    reauth = data.code === 'WELLBEING_REAUTH';
    return reauth;
  }

  async function load() {
    try {
      const res = await dashboardFetch(`/wellbeing/cases?subjectUserId=${encodeURIComponent(userId)}`);
      if (await reauthAsked(res)) return;
      if (res.ok) cases = (await res.json()).cases ?? [];
    } finally {
      loading = false;
    }
  }

  // Note rapide : elle va sur la fiche de la personne, sans ouvrir de dossier.
  async function addQuickNote() {
    const content = text.trim();
    if (!content || busy) return;
    busy = true;
    try {
      const res = await dashboardFetch(`/wellbeing/profiles/${userId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, subjectName: userName, sensitive }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      if (profileNotes) profileNotes = [...profileNotes, data.note];
      text = '';
      sensitive = false;
      toast.success(m.toast_wb_note_saved());
    } catch (err: any) {
      toast.error(err?.message || m.toast_save_error());
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<section class="section-card p-5 space-y-4">
  <p class="text-xs text-on-surface-variant">
    {m.wb_panel_intro()}
  </p>

  <!-- Sur sa propre fiche, pas de note : le dossier serait aussitôt masqué à son auteur. -->
  {#if canWrite && userId !== authStore.user?.id}
  <div>
    <label for="wb-quick-note" class="sr-only">{m.wb_panel_note_label()}</label>
    <textarea id="wb-quick-note" class="input min-h-[120px] resize-y" bind:value={text} placeholder={m.wb_panel_note_ph()}></textarea>
    <label class="mt-2 flex items-start gap-2 text-xs">
      <input type="checkbox" class="mt-0.5" bind:checked={sensitive} />
      <span>{m.wb_profiles_sensitive_label()} <span class="block text-2xs text-on-surface-variant">{m.wb_profiles_sensitive_hint()}</span></span>
    </label>
    <div class="mt-2 flex justify-end">
      <button class="btn-primary" disabled={busy || !text.trim()} onclick={addQuickNote}>{m.wb_panel_save()}</button>
    </div>
  </div>
  {:else if !canWrite}
  <p class="text-xs text-on-surface-variant">{m.wb_read_only_emergency()}</p>
  {/if}

  {#if canWrite && userId !== authStore.user?.id && !reauth}
    <div class="rounded-lg bg-surface-container px-4 py-3 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="font-semibold text-sm">{m.wb_panel_profile_title()}</p>
        <div class="flex gap-2">
          {#if !profileNotes}
            <Button size="sm" variant="secondary" icon="eye" loading={profileLoading} onclick={() => void revealProfile()}>{m.wb_panel_profile_reveal()}</Button>
          {/if}
          <Button size="sm" variant="ghost" icon="ExternalLink" onclick={openInCell}>{m.wb_panel_profile_open()}</Button>
        </div>
      </div>
      {#if profileNotes}
        {#each profileNotes as note (note.id)}
          <p class="border-l-2 border-outline-variant pl-3 text-sm">
            <span class="text-xs text-on-surface-variant">{note.sensitive ? `${m.wb_profiles_sensitive_badge()} · ` : ''}{note.authorName} · {fmt(note.createdAt)}</span><br />
            {#if note.sensitive && !shownSensitive.includes(note.id)}
              <button type="button" class="text-xs text-primary underline" onclick={() => (shownSensitive = [...shownSensitive, note.id])}>{m.wb_profiles_sensitive_reveal()}</button>
            {:else}
              <span class="whitespace-pre-wrap break-words">{note.content}</span>
            {/if}
          </p>
        {:else}
          <p class="text-sm text-on-surface-variant">{m.wb_profiles_no_note()}</p>
        {/each}
      {/if}
    </div>
  {/if}

  {#if reauth}
    <div class="rounded-lg bg-surface-container px-4 py-3 space-y-2">
      <p class="text-sm text-on-surface-variant">{m.wb_reauth_desc()}</p>
      <Button size="sm" variant="primary" icon="LogIn" onclick={() => void authStore.logout()}>{m.wb_reauth_action()}</Button>
    </div>
  {:else if !loading && cases.length === 0}
    <p class="text-sm text-on-surface-variant">{m.wb_panel_empty()}</p>
  {/if}

  <ul class="space-y-3">
    {#each cases as item (item.id)}
      {@const content = contents[item.id]}
      <li class="rounded-lg bg-surface-container px-4 py-3">
        <p class="font-semibold">{item.title}</p>
        <p class="text-xs text-on-surface-variant">{content ? `${content.createdByName} · ` : ''}{fmt(item.createdAt)} · {wbStatusLabel(item.status)}</p>
        {#if content}
          <p class="mt-2 whitespace-pre-wrap break-words text-sm">{content.summary}</p>
          {#each content.notes as note (note.id)}
            <p class="mt-2 border-l-2 border-outline-variant pl-3 text-sm">
              <span class="text-xs text-on-surface-variant">{note.authorName} · {fmt(note.createdAt)}</span><br />
              <span class="whitespace-pre-wrap break-words">{note.content}</span>
            </p>
          {/each}
        {:else}
          <div class="mt-2">
            <Button size="sm" variant="secondary" icon="eye" loading={openingId === item.id} onclick={() => void reveal(item.id)}>{m.wb_discreet_reveal()}</Button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>
