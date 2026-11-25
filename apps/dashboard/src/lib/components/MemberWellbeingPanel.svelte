<!--
  Onglet « Bien-être » de la fiche membre : dossiers confidentiels de la
  personne et note rapide. Monté seulement pour la cellule bien-être : l'API
  refuse les autres (403), même admins, hors accès d'urgence.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { dashboardFetch } from '../api';
  import { toast } from '../stores/toast.svelte';
  import { dateLocale, m } from '../i18n';
  import { wbStatusLabel } from '../wellbeingLabels';
  import { Button } from './ui';
  import { authStore } from '../stores/auth.svelte';

  let { userId, userName, canWrite = false }: { userId: string; userName: string; canWrite?: boolean } = $props();

  type Note = { id: string; authorName: string; content: string; createdAt: string };
  /** En-tête de la liste ; le contenu se lit dossier par dossier, ce qui trace chaque ouverture. */
  type Case = { id: string; title: string; status: string; severity: string; createdAt: string };
  type CaseContent = { summary: string; notes: Note[]; createdByName: string };

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

  // Note rapide : un dossier « SUIVI » dont le titre est la première ligne.
  async function addQuickNote() {
    const summary = text.trim();
    if (!summary || busy) return;
    busy = true;
    try {
      const res = await dashboardFetch('/wellbeing/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectUserId: userId,
          subjectName: userName,
          title: summary.split('\n')[0].slice(0, 80),
          category: 'SUIVI',
          summary,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      cases = [data.item, ...cases];
      contents = { ...contents, [data.item.id]: { summary: data.item.summary, notes: data.item.notes ?? [], createdByName: data.item.createdByName } };
      text = '';
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

  {#if canWrite}
  <div>
    <label for="wb-quick-note" class="sr-only">{m.wb_panel_note_label()}</label>
    <textarea id="wb-quick-note" class="input min-h-[120px] resize-y" bind:value={text} placeholder={m.wb_panel_note_ph()}></textarea>
    <div class="mt-2 flex justify-end">
      <button class="btn-primary" disabled={busy || !text.trim()} onclick={addQuickNote}>{m.wb_panel_save()}</button>
    </div>
  </div>
  {:else}
  <p class="text-xs text-on-surface-variant">{m.wb_read_only_emergency()}</p>
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
