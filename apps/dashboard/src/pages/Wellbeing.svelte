<script lang="ts">
  import { onMount } from 'svelte';
  import { dashboardFetch } from '../lib/api';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import { Button, Callout, EmptyState, Field, Modal, SectionCard } from '../lib/components/ui';

  type WellbeingStatus = {
    enabled: boolean;
    requireReason: boolean;
    isTeamMember: boolean;
    isDirector: boolean;
    hasCaseAccess: boolean;
    breakGlassExpiresAt: string | null;
  };

  let loading = $state(true);
  let status = $state<WellbeingStatus | null>(null);
  let cases = $state<any[]>([]);
  let logs = $state<any[]>([]);
  let selectedCaseId = $state<string | null>(null);

  const selectedCase = $derived(cases.find((c) => c.id === selectedCaseId) ?? null);
  const discordRoles = $derived((dashboardStore.state.discordRoles ?? []) as Array<{ id: string; name: string }>);

  const roleOptions = $derived(discordRoles.map((r) => ({ id: r.id, name: `@${r.name}` })));

  // Break-glass modal
  let breakGlassOpen = $state(false);
  let breakGlassReason = $state('');
  let breakGlassSubmitting = $state(false);

  // New case modal
  let newCaseOpen = $state(false);
  let newSubjectName = $state('');
  let newTitle = $state('');
  let newCategory = $state('SOUTIEN');
  let newSeverity = $state('NORMAL');
  let newSummary = $state('');
  let creatingCase = $state(false);

  // Note on selected case
  let newNote = $state('');
  let addingNote = $state(false);

  // Config modal (Direction)
  let configOpen = $state(false);
  let cfgEnabled = $state(false);
  let cfgRequireReason = $state(true);
  let cfgTeamRoleIds = $state<string[]>([]);
  let cfgDirectorRoleIds = $state<string[]>([]);
  let savingConfig = $state(false);

  async function loadAll() {
    loading = true;
    try {
      const stRes = await dashboardFetch('/wellbeing/status');
      if (!stRes.ok) throw new Error('status');
      status = await stRes.json();

      if (status?.hasCaseAccess) {
        const casesRes = await dashboardFetch('/wellbeing/cases');
        if (casesRes.ok) {
          const data = await casesRes.json();
          cases = data.cases ?? [];
          if (!selectedCaseId && cases.length > 0) selectedCaseId = cases[0].id;
        }
      } else {
        cases = [];
      }

      if (status?.isDirector || status?.isTeamMember) {
        const logsRes = await dashboardFetch('/wellbeing/break-glass-logs');
        if (logsRes.ok) {
          logs = (await logsRes.json()).logs ?? [];
        }
      }
    } catch {
      toast.error('Impossible de charger la cellule bien-être.');
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadAll();
  });

  async function openConfig() {
    try {
      const res = await dashboardFetch('/wellbeing/config');
      if (!res.ok) throw new Error('config');
      const { config } = await res.json();
      cfgEnabled = config.enabled === true;
      cfgRequireReason = config.requireReason !== false;
      cfgTeamRoleIds = [...(config.teamRoleIds ?? [])];
      cfgDirectorRoleIds = [...(config.directorRoleIds ?? [])];
      configOpen = true;
    } catch {
      toast.error('Accès réservé à la direction.');
    }
  }

  async function saveConfig(event: SubmitEvent) {
    event.preventDefault();
    savingConfig = true;
    try {
      const res = await dashboardFetch('/wellbeing/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: cfgEnabled,
          requireReason: cfgRequireReason,
          teamRoleIds: cfgTeamRoleIds,
          directorRoleIds: cfgDirectorRoleIds,
        }),
      });
      if (!res.ok) throw new Error('save');
      configOpen = false;
      toast.success('Configuration enregistrée');
      await loadAll();
    } catch {
      toast.error('Erreur lors de la sauvegarde.');
    } finally {
      savingConfig = false;
    }
  }

  async function activateBreakGlass(event: SubmitEvent) {
    event.preventDefault();
    if (breakGlassSubmitting) return;
    breakGlassSubmitting = true;
    try {
      const res = await dashboardFetch('/wellbeing/break-glass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: breakGlassReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refusé');
      breakGlassOpen = false;
      breakGlassReason = '';
      toast.success('Accès exceptionnel activé (2h) et journalisé.');
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || "Impossible d'activer l'accès.");
    } finally {
      breakGlassSubmitting = false;
    }
  }

  async function createCase(event: SubmitEvent) {
    event.preventDefault();
    if (creatingCase) return;
    creatingCase = true;
    try {
      const res = await dashboardFetch('/wellbeing/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectName: newSubjectName.trim(),
          title: newTitle.trim(),
          category: newCategory,
          severity: newSeverity,
          summary: newSummary.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur');
      cases = [data.item, ...cases];
      selectedCaseId = data.item.id;
      newCaseOpen = false;
      newSubjectName = '';
      newTitle = '';
      newSummary = '';
      toast.success('Dossier confidentiel créé');
    } catch (err: any) {
      toast.error(err?.message || 'Erreur lors de la création.');
    } finally {
      creatingCase = false;
    }
  }

  async function addNote(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedCase || !newNote.trim() || addingNote) return;
    addingNote = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${selectedCase.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newNote.trim() }),
      });
      if (!res.ok) throw new Error('note');
      const { note } = await res.json();
      cases = cases.map((c) => (c.id === selectedCase.id ? { ...c, notes: [...(c.notes ?? []), note] } : c));
      newNote = '';
    } catch {
      toast.error("Impossible d'ajouter la note.");
    } finally {
      addingNote = false;
    }
  }
</script>

<ModulePage
  title="Cellule bien-être"
  description="Espace confidentiel cloisonné avec accès exceptionnel journalisé (break-glass)"
  icon="shield"
  featureKey="staff_directory"
>
  {#snippet actions()}
    <div class="flex flex-wrap items-center gap-2">
      {#if status?.hasCaseAccess}
        <Button variant="primary" icon="plus" onclick={() => (newCaseOpen = true)}>Nouveau dossier</Button>
      {/if}
      {#if status?.isDirector}
        <Button variant="ghost" icon="settings" onclick={() => void openConfig()}>Configuration</Button>
      {/if}
    </div>
  {/snippet}

  {#if loading}
    <p class="text-sm text-on-surface-variant">Chargement…</p>
  {:else if !status?.enabled}
    <EmptyState
      icon="shield"
      title="Cellule bien-être désactivée"
      description="Activez la cellule et désignez les rôles autorisés depuis la configuration."
      actionLabel={status?.isDirector ? 'Configurer' : undefined}
      onAction={status?.isDirector ? () => void openConfig() : undefined}
    />
  {:else if !status.hasCaseAccess}
    <div class="space-y-4">
      <Callout variant="warning" title="Espace confidentiel cloisonné">
        Les dossiers de la cellule bien-être sont strictement réservés aux membres habilités de la cellule.
        {#if status.isDirector}
          En tant que membre de la direction, vous pouvez déclencher un accès exceptionnel (« break-glass ») de 2 heures, intégralement journalisé.
        {/if}
      </Callout>
      {#if status.isDirector}
        <Button variant="primary" icon="lock" onclick={() => (breakGlassOpen = true)}>
          Activer l'accès exceptionnel (break-glass)
        </Button>
      {/if}
    </div>
  {:else}
    {#if status.breakGlassExpiresAt && !status.isTeamMember}
      <Callout variant="warning" title="Mode break-glass actif">
        Accès exceptionnel directionnel actif jusqu'à {new Date(status.breakGlassExpiresAt).toLocaleTimeString('fr-FR')}. Toutes vos consultations sont journalisées.
      </Callout>
    {/if}

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <SectionCard title="Dossiers confidentiels" icon="folder">
        <div class="divide-y divide-outline-variant">
          {#if cases.length === 0}
            <p class="p-4 text-sm text-on-surface-variant">Aucun dossier ouvert.</p>
          {:else}
            {#each cases as c (c.id)}
              <button
                type="button"
                onclick={() => (selectedCaseId = c.id)}
                class="w-full text-left p-4 hover:bg-surface-container-low transition-colors {selectedCaseId === c.id ? 'bg-primary/5' : ''}"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-semibold text-on-surface truncate">{c.title}</span>
                  <span class="text-2xs px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant">{c.status}</span>
                </div>
                <p class="text-xs text-on-surface-variant mt-1">{c.subjectName} · {c.category}</p>
              </button>
            {/each}
          {/if}
        </div>
      </SectionCard>

      <div class="lg:col-span-2 space-y-6">
        {#if selectedCase}
          <SectionCard title={selectedCase.title} description="Personne concernée : {selectedCase.subjectName} · {selectedCase.category}" icon="file-text">
            <div class="p-4 space-y-4">
              <p class="text-sm whitespace-pre-wrap text-on-surface bg-surface-container-low rounded-lg p-3 border border-outline-variant">
                {selectedCase.summary}
              </p>

              <div class="space-y-2">
                <h3 class="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Notes de suivi</h3>
                {#each selectedCase.notes ?? [] as note (note.id)}
                  <div class="rounded-lg border border-outline-variant p-3 text-xs bg-surface-container-lowest">
                    <div class="flex justify-between text-on-surface-variant mb-1">
                      <span class="font-semibold text-on-surface">{note.authorName}</span>
                      <span>{new Date(note.createdAt).toLocaleString('fr-FR')}</span>
                    </div>
                    <p class="whitespace-pre-wrap text-on-surface">{note.content}</p>
                  </div>
                {/each}
              </div>

              <form onsubmit={addNote} class="flex gap-2">
                <input bind:value={newNote} required placeholder="Ajouter une note confidentielle…" class="input flex-1 text-sm" />
                <Button type="submit" size="sm" variant="primary" loading={addingNote}>Ajouter</Button>
              </form>
            </div>
          </SectionCard>
        {/if}

        {#if logs.length > 0}
          <SectionCard title="Journal des accès break-glass" icon="eye">
            <div class="divide-y divide-outline-variant">
              {#each logs as log (log.id)}
                <div class="px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span class="font-semibold text-on-surface">{log.actorName}</span>
                    <span class="text-on-surface-variant"> — {log.reason}</span>
                  </div>
                  <span class="text-on-surface-variant">{new Date(log.createdAt).toLocaleString('fr-FR')}</span>
                </div>
              {/each}
            </div>
          </SectionCard>
        {/if}
      </div>
    </div>
  {/if}
</ModulePage>

<Modal bind:open={breakGlassOpen} title="Accès exceptionnel (Break-glass)" size="sm">
  <form id="bg-form" onsubmit={activateBreakGlass} class="space-y-4">
    <Callout variant="warning">
      Cet accès temporaire (2 heures) est destiné aux enquêtes internes et sera tracé dans le journal d'audit.
    </Callout>
    <Field label="Motif de l'accès" required>
      {#snippet children(id)}
        <textarea {id} bind:value={breakGlassReason} required minlength={8} rows={3} class="input w-full" placeholder="Ex. Enquête interne suite à un signalement…"></textarea>
      {/snippet}
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (breakGlassOpen = false)}>Annuler</Button>
    <Button variant="primary" type="submit" form="bg-form" loading={breakGlassSubmitting}>Confirmer l'accès</Button>
  {/snippet}
</Modal>

<Modal bind:open={newCaseOpen} title="Nouveau dossier confidentiel" size="md">
  <form id="wb-case-form" onsubmit={createCase} class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Personne concernée" required>
        {#snippet children(id)}
          <input {id} bind:value={newSubjectName} required class="input w-full" placeholder="Pseudo ou nom" />
        {/snippet}
      </Field>
      <Field label="Catégorie">
        {#snippet children(id)}
          <select {id} bind:value={newCategory} class="input w-full">
            <option value="SOUTIEN">Soutien</option>
            <option value="MEDIATION">Médiation</option>
            <option value="SIGNALEMENT">Signalement</option>
            <option value="SUIVI">Suivi</option>
          </select>
        {/snippet}
      </Field>
    </div>
    <Field label="Titre du dossier" required>
      {#snippet children(id)}
        <input {id} bind:value={newTitle} required class="input w-full" placeholder="Objet du dossier" />
      {/snippet}
    </Field>
    <Field label="Résumé confidentiel" required>
      {#snippet children(id)}
        <textarea {id} bind:value={newSummary} required rows={4} class="input w-full" placeholder="Contexte et éléments initiaux…"></textarea>
      {/snippet}
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (newCaseOpen = false)}>Annuler</Button>
    <Button variant="primary" type="submit" form="wb-case-form" loading={creatingCase}>Créer</Button>
  {/snippet}
</Modal>

<Modal bind:open={configOpen} title="Configuration Cellule bien-être" size="md">
  <form id="wb-cfg-form" onsubmit={saveConfig} class="space-y-4">
    <label class="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" bind:checked={cfgEnabled} />
      Activer l'espace confidentiel cloisonné
    </label>
    <label class="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" bind:checked={cfgRequireReason} />
      Exiger un motif obligatoire pour le break-glass direction
    </label>
    <Field label="Rôles membres de la cellule bien-être">
      {#snippet children(id)}
        <MultiSelect {id} bind:values={cfgTeamRoleIds} options={roleOptions} placeholder="Rechercher un rôle…" />
      {/snippet}
    </Field>
    <Field label="Rôles Direction autorisés (break-glass)">
      {#snippet children(id)}
        <MultiSelect {id} bind:values={cfgDirectorRoleIds} options={roleOptions} placeholder="Rechercher un rôle…" />
      {/snippet}
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (configOpen = false)}>Annuler</Button>
    <Button variant="primary" type="submit" form="wb-cfg-form" loading={savingConfig}>Enregistrer</Button>
  {/snippet}
</Modal>
