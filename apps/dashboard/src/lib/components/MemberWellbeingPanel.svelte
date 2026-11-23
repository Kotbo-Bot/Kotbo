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

  let { userId, userName }: { userId: string; userName: string } = $props();

  type Note = { id: string; authorName: string; content: string; createdAt: string };
  type Case = { id: string; title: string; status: string; severity: string; summary: string; notes: Note[]; createdByName: string; createdAt: string };

  let cases = $state<Case[]>([]);
  let loading = $state(true);
  let text = $state('');
  let busy = $state(false);

  const fmt = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function load() {
    try {
      const res = await dashboardFetch(`/wellbeing/cases?subjectUserId=${encodeURIComponent(userId)}`);
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
      if (!res.ok) throw new Error(data.error || 'Erreur');
      cases = [data.item, ...cases];
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
    Espace confidentiel : visible uniquement par la cellule bien-être. Les autres membres du staff, même admins, ne voient pas ce contenu.
  </p>

  <div>
    <label for="wb-quick-note" class="sr-only">Nouvelle note confidentielle</label>
    <textarea id="wb-quick-note" class="input min-h-[120px] resize-y" bind:value={text} placeholder="Nouvelle note confidentielle…"></textarea>
    <div class="mt-2 flex justify-end">
      <button class="btn-primary" disabled={busy || !text.trim()} onclick={addQuickNote}>Enregistrer la note</button>
    </div>
  </div>

  {#if !loading && cases.length === 0}
    <p class="text-sm text-on-surface-variant">Aucun dossier sur cette personne.</p>
  {/if}

  <ul class="space-y-3">
    {#each cases as item (item.id)}
      <li class="rounded-lg bg-surface-container px-4 py-3">
        <p class="font-semibold">{item.title}</p>
        <p class="text-xs text-on-surface-variant">{item.createdByName} · {fmt(item.createdAt)} · {item.status}</p>
        <p class="mt-2 whitespace-pre-wrap break-words text-sm">{item.summary}</p>
        {#each item.notes as note (note.id)}
          <p class="mt-2 border-l-2 border-outline-variant pl-3 text-sm">
            <span class="text-xs text-on-surface-variant">{note.authorName} · {fmt(note.createdAt)}</span><br />
            <span class="whitespace-pre-wrap break-words">{note.content}</span>
          </p>
        {/each}
      </li>
    {/each}
  </ul>
</section>
