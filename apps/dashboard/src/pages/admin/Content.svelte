<script lang="ts">
  import { m } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    fetchGlobalBannedWords,
    saveGlobalBannedWords,
    cleanupGlobalBannedWords,
    updateGlobalBannedWord,
    deleteGlobalBannedWord,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import { Button, Callout, ToggleSwitch } from '../../lib/components/ui';

  import { errorMessage } from '@kotbo/shared';
  type BannedWordEntry = {
    id: string;
    word: string;
    category: string;
    enabled: boolean;
    guildId: string | null;
  };

  type ImportDraft = {
    id: string;
    word: string;
    category: string;
    enabled: boolean;
  };

  const BANNED_WORD_CATEGORIES = {
    custom: 'Personnalisé',
    racism: 'Racisme',
    threat: 'Menace',
    sexual: 'Sexuel',
    lgbtphobia: 'LGBTphobie',
    hate: 'Haine',
    insult: 'Insulte',
  } as const;

  const BANNED_WORD_CATEGORY_KEYS = Object.keys(BANNED_WORD_CATEGORIES) as Array<keyof typeof BANNED_WORD_CATEGORIES>;

  let globalBannedWords = $state<BannedWordEntry[]>([]);
  let globalBannedWordsLoading = $state(false);
  let globalBannedWordsLoaded = $state(false);
  let globalBannedWordsError = $state('');
  let globalBannedWordsPage = $state(1);
  let globalImportText = $state('');
  let globalImportFileName = $state('');
  let globalImportDrafts = $state<ImportDraft[]>([]);
  let globalImportError = $state('');
  let globalImportLoading = $state(false);
  let globalWordSavingId = $state('');
  const globalWordSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let globalCleanupLoading = $state(false);
  const GLOBAL_BANNED_WORDS_PAGE_SIZE = 25;

  let search = $state('');
  let categoryFilter = $state('ALL');

  const filteredGlobalBannedWords = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    return globalBannedWords.filter(
      (entry) => (categoryFilter === 'ALL' || entry.category === categoryFilter) && entry.word.toLowerCase().includes(needle),
    );
  });

  const wordColumns: AdminTableColumn[] = [
    { key: 'word', label: 'Mot' },
    { key: 'category', label: 'Catégorie', width: 'w-48' },
    { key: 'enabled', label: 'Actif', align: 'center', width: 'w-24' },
    { key: 'actions', label: '', align: 'right', width: 'w-16' },
  ];

  const globalBannedWordsTotalPages = $derived(
    Math.max(1, Math.ceil(filteredGlobalBannedWords.length / GLOBAL_BANNED_WORDS_PAGE_SIZE))
  );

  const paginatedGlobalBannedWords = $derived(
    filteredGlobalBannedWords.slice(
      (globalBannedWordsPage - 1) * GLOBAL_BANNED_WORDS_PAGE_SIZE,
      globalBannedWordsPage * GLOBAL_BANNED_WORDS_PAGE_SIZE
    )
  );

  async function loadGlobalBannedWords() {
    globalBannedWordsLoading = true;
    globalBannedWordsError = '';
    try {
      const data = await fetchGlobalBannedWords();
      globalBannedWords = data.words ?? [];
      globalBannedWordsLoaded = true;
      globalBannedWordsPage = 1;
    } catch (err) {
      globalBannedWordsError = errorMessage(err) || 'Impossible de charger les mots globaux.';
    } finally {
      globalBannedWordsLoading = false;
    }
  }

  onMount(() => {
    void loadGlobalBannedWords();
  });

  $effect(() => {
    const maxPage = globalBannedWordsTotalPages;
    if (globalBannedWordsPage > maxPage) globalBannedWordsPage = maxPage;
    if (globalBannedWordsPage < 1) globalBannedWordsPage = 1;
  });

  function normalizeGlobalWordValue(value: string) {
    return value.trim().toLowerCase().slice(0, 100);
  }

  function parseGlobalWordRows(text: string): ImportDraft[] {
    const source = text.trim();
    if (!source) return [];

    const drafts: ImportDraft[] = [];

    const addDraft = (word: string, category = 'custom', enabled = true) => {
      const normalizedWord = normalizeGlobalWordValue(word);
      if (!normalizedWord) return;

      const safeCategory = BANNED_WORD_CATEGORY_KEYS.includes(category as keyof typeof BANNED_WORD_CATEGORIES)
        ? category
        : 'custom';

      drafts.push({
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        word: normalizedWord,
        category: safeCategory,
        enabled,
      });
    };

    const parsedJson = (() => {
      try {
        return JSON.parse(source);
      } catch {
        return null;
      }
    })();

    if (parsedJson) {
      const rows = Array.isArray(parsedJson)
        ? parsedJson
        : Array.isArray(parsedJson?.words)
          ? parsedJson.words
          : [];

      for (const row of rows) {
        if (typeof row === 'string') {
          addDraft(row);
          continue;
        }

        if (row && typeof row === 'object') {
          addDraft(
            String((row as any).word ?? ''),
            String((row as any).category ?? 'custom'),
            (row as any).enabled !== false,
          );
        }
      }

      return drafts;
    }

    const rows = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const row of rows) {
      const line = row.replace(/^\uFEFF/, '');
      const parts = line.split(/[;,\t]/).map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      if (/^word$/i.test(parts[0]) && parts.length > 1) continue;

      const enabledToken = parts[2];
      drafts.push({
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        word: normalizeGlobalWordValue(parts[0]),
        category: BANNED_WORD_CATEGORY_KEYS.includes((parts[1] ?? 'custom') as keyof typeof BANNED_WORD_CATEGORIES)
          ? (parts[1] ?? 'custom')
          : 'custom',
        enabled: enabledToken ? !/^(false|0|off|no|non)$/i.test(enabledToken) : true,
      });
    }

    return drafts.filter((draft) => draft.word.length > 0);
  }

  function ingestGlobalImport(text: string, fileName = '') {
    globalImportText = text;
    globalImportFileName = fileName;
    globalImportDrafts = parseGlobalWordRows(text);
    globalImportError = globalImportDrafts.length === 0 ? 'Aucun mot valide détecté.' : '';
  }

  async function handleImportFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    ingestGlobalImport(await file.text(), file.name);
    input.value = '';
  }

  function handleAnalyzeGlobalImport() {
    ingestGlobalImport(globalImportText, globalImportFileName);
  }

  function updateDraft(id: string, patch: Partial<ImportDraft>) {
    globalImportDrafts = globalImportDrafts.map((draft) => draft.id === id ? { ...draft, ...patch } : draft);
    globalImportError = globalImportDrafts.length > 0 ? '' : globalImportError;
  }

  function removeDraft(id: string) {
    globalImportDrafts = globalImportDrafts.filter((draft) => draft.id !== id);
    if (globalImportDrafts.length === 0) {
      globalImportError = 'Aucun mot valide détecté.';
    }
  }

  function resetGlobalImport() {
    globalImportText = '';
    globalImportFileName = '';
    globalImportDrafts = [];
    globalImportError = '';
  }

  async function handleSaveGlobalImport() {
    const payload = globalImportDrafts
      .map((draft) => ({ word: normalizeGlobalWordValue(draft.word), category: draft.category, enabled: draft.enabled }))
      .filter((draft) => draft.word.length > 0);

    if (payload.length === 0) {
      globalImportError = 'Ajoute au moins un mot valide avant d\'enregistrer.';
      return;
    }

    globalImportLoading = true;
    try {
      const result = await saveGlobalBannedWords(payload);
      globalBannedWords = result.words ?? [];
      globalBannedWordsLoaded = true;
      globalBannedWordsPage = 1;
      toast.success(m.acnt_global_words_updated({ created: result.createdCount ?? 0, updated: result.updatedCount ?? 0 }));
      resetGlobalImport();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      globalImportLoading = false;
    }
  }

  function updateGlobalWordField(id: string, patch: Partial<BannedWordEntry>) {
    globalBannedWords = globalBannedWords.map((word) => word.id === id ? { ...word, ...patch } : word);
    const previousTimer = globalWordSaveTimers.get(id);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(() => {
      void handleSaveGlobalWord(id);
    }, 650);

    globalWordSaveTimers.set(id, timer);
  }

  async function handleSaveGlobalWord(id: string) {
    const entry = globalBannedWords.find((word) => word.id === id);
    if (!entry) return;

    const nextWord = normalizeGlobalWordValue(entry.word);
    if (!nextWord) {
      globalImportError = 'Le mot ne peut pas être vide.';
      return;
    }

    const previousTimer = globalWordSaveTimers.get(id);
    if (previousTimer) {
      clearTimeout(previousTimer);
      globalWordSaveTimers.delete(id);
    }

    globalWordSavingId = id;
    try {
      const result = await updateGlobalBannedWord(id, {
        word: nextWord,
        category: entry.category,
        enabled: entry.enabled,
      });

      if (result?.word) {
        globalBannedWords = globalBannedWords.map((word) => word.id === id ? result.word : word);
      } else {
        const refreshed = await fetchGlobalBannedWords();
        globalBannedWords = refreshed.words ?? [];
      }

      globalBannedWordsLoaded = true;

      toast.success(m.acnt_global_word_updated());
    } catch (err) {
      globalImportError = errorMessage(err);
      const refreshed = await fetchGlobalBannedWords().catch(() => null);
      if (refreshed?.words) {
        globalBannedWords = refreshed.words;
        globalBannedWordsLoaded = true;
      }
    } finally {
      globalWordSavingId = '';
    }
  }

  async function handleDeleteGlobalWord(entry: BannedWordEntry) {
    if (!(await confirmDialog.danger(`Supprimer le mot global « ${entry.word} » ?`))) return;
    try {
      const timer = globalWordSaveTimers.get(entry.id);
      if (timer) clearTimeout(timer);
      globalWordSaveTimers.delete(entry.id);
      await deleteGlobalBannedWord(entry.id);
      globalBannedWords = globalBannedWords.filter((word) => word.id !== entry.id);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleCleanupGlobalWords() {
    if (!(await confirmDialog.ask({ title: 'Nettoyer les mots globaux ?', description: 'Les doublons seront supprimés automatiquement.', confirmLabel: 'Nettoyer', variant: 'warning' }))) return;

    globalCleanupLoading = true;
    globalImportError = '';
    try {
      const result = await cleanupGlobalBannedWords();
      globalBannedWords = result.words ?? [];
      globalBannedWordsLoaded = true;
      globalBannedWordsPage = 1;
      toast.success(m.acnt_cleanup_done({ kept: result.cleanedCount ?? 0, removed: result.duplicateCount ?? 0 }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      globalCleanupLoading = false;
    }
  }

  function goToGlobalBannedWordsPage(nextPage: number) {
    globalBannedWordsPage = Math.min(globalBannedWordsTotalPages, Math.max(1, nextPage));
  }
</script>

<AdminShell title="Mots globaux" description="Liste de mots interdits appliquée à tous les serveurs.">
  {#snippet actions()}
    <Button icon="RefreshCw" loading={globalBannedWordsLoading} onclick={loadGlobalBannedWords}>Rafraîchir</Button>
    <Button icon="Sparkles" loading={globalCleanupLoading} onclick={handleCleanupGlobalWords}>Retirer les doublons</Button>
  {/snippet}

  {#if globalBannedWordsError}
    <Callout variant="danger">
      {globalBannedWordsError}
      {#snippet actions()}
        <Button size="sm" icon="RefreshCw" onclick={loadGlobalBannedWords}>Réessayer</Button>
      {/snippet}
    </Callout>
  {/if}

  <!-- La liste d'abord : on vient ici pour retrouver ou corriger un mot bien
       plus souvent que pour en importer un lot. -->
  <AdminToolbar
    bind:search
    bind:activeFilter={categoryFilter}
    placeholder="Rechercher un mot…"
    filters={[
      { value: 'ALL', label: 'Toutes', count: globalBannedWords.length },
      ...BANNED_WORD_CATEGORY_KEYS.map((key) => ({
        value: key,
        label: BANNED_WORD_CATEGORIES[key],
        count: globalBannedWords.filter((word) => word.category === key).length,
      })).filter((option) => option.count > 0),
    ]}
    resultCount={filteredGlobalBannedWords.length}
    resultLabel="mot"
  />

  <AdminTable
    columns={wordColumns}
    rows={paginatedGlobalBannedWords}
    loading={globalBannedWordsLoading && !globalBannedWordsLoaded}
    emptyIcon="filter"
    emptyTitle={globalBannedWords.length === 0 ? 'Aucun mot global configuré' : 'Aucun mot ne correspond'}
    emptyHint={globalBannedWords.length === 0 ? 'Importe une première liste ci-dessous.' : 'Élargis la recherche ou change de catégorie.'}
  >
    {#snippet row(item, _index)}
      {@const entry = item as BannedWordEntry}
      <tr class="border-b border-outline-variant/12">
        <td class="px-4 py-2">
          <input
            type="text"
            value={entry.word}
            aria-label="Mot"
            oninput={(event) => updateGlobalWordField(entry.id, { word: (event.currentTarget as HTMLInputElement).value })}
            class="input font-mono {entry.enabled ? '' : 'opacity-60'}"
            maxlength="100"
          />
        </td>
        <td class="px-4 py-2">
          <select
            value={entry.category}
            aria-label="Catégorie"
            onchange={(event) => updateGlobalWordField(entry.id, { category: (event.currentTarget as HTMLSelectElement).value })}
            class="input"
          >
            {#each Object.entries(BANNED_WORD_CATEGORIES) as [key, label] (key)}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </td>
        <td class="px-4 py-2">
          <div class="flex items-center justify-center gap-2">
            <ToggleSwitch
              size="sm"
              checked={entry.enabled}
              ariaLabel="Activer « {entry.word} »"
              onToggle={(checked) => updateGlobalWordField(entry.id, { enabled: checked })}
            />
            {#if globalWordSavingId === entry.id}
              <span class="w-3 h-3 rounded-full border-2 border-on-surface-variant/30 border-t-on-surface-variant animate-spin" aria-hidden="true"></span>
            {/if}
          </div>
        </td>
        <td class="px-4 py-2 text-right">
          <Button size="sm" variant="danger" icon="Trash" title="Supprimer" aria-label="Supprimer « {entry.word} »" onclick={() => handleDeleteGlobalWord(entry)} />
        </td>
      </tr>
    {/snippet}

    {#snippet footer()}
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-on-surface-variant tabular-nums">Page {globalBannedWordsPage} sur {globalBannedWordsTotalPages}</p>
        <div class="flex items-center gap-2">
          <Button size="sm" icon="ChevronLeft" disabled={globalBannedWordsPage === 1} onclick={() => goToGlobalBannedWordsPage(globalBannedWordsPage - 1)}>
            Précédent
          </Button>
          <Button
            size="sm"
            iconRight="ChevronRight"
            disabled={globalBannedWordsPage === globalBannedWordsTotalPages}
            onclick={() => goToGlobalBannedWordsPage(globalBannedWordsPage + 1)}
          >
            Suivant
          </Button>
        </div>
      </div>
    {/snippet}
  </AdminTable>

  <AdminCard
    title="Importer des mots"
    description="Colle un CSV, un JSON ou une liste de mots. Tu choisis les catégories à la main avant d’enregistrer ; les doublons sont écartés."
    icon="Upload"
    tone="primary"
  >
    <div class="space-y-4">
      <p class="text-xs text-on-surface-variant">
        Format accepté : <span class="font-mono">mot</span>, <span class="font-mono">mot,catégorie</span>,
        <span class="font-mono">mot,catégorie,true/false</span> ou JSON avec <span class="font-mono">word</span>,
        <span class="font-mono">category</span>, <span class="font-mono">enabled</span>.
      </p>

      <textarea
        bind:value={globalImportText}
        rows="6"
        aria-label="Mots à importer"
        placeholder={'word,category\nmenace,threat\ninsulte,insult'}
        class="input font-mono"
      ></textarea>

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="Search" onclick={handleAnalyzeGlobalImport}>Analyser</Button>
        <!-- Le champ fichier natif reste le contrôle réel ; le bouton n'en est que l'habillage. -->
        <label class="btn btn-tonal cursor-pointer focus-within:outline-2 focus-within:outline-primary">
          <Papicon icon="Upload" size={14} />
          Charger un fichier
          <input type="file" accept=".csv,.json,.txt,.tsv" onchange={handleImportFileChange} class="sr-only" />
        </label>
        {#if globalImportText || globalImportDrafts.length > 0}
          <Button variant="ghost" onclick={resetGlobalImport}>Réinitialiser</Button>
        {/if}
        {#if globalImportFileName}
          <span class="text-xs text-on-surface-variant">Fichier chargé : {globalImportFileName}</span>
        {/if}
      </div>

      {#if globalImportError}
        <Callout variant="warning">{globalImportError}</Callout>
      {/if}

      {#if globalImportDrafts.length > 0}
        <div class="space-y-3 pt-4 border-t border-outline-variant/20">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold text-on-surface">Prévisualisation ({globalImportDrafts.length})</h3>
              <p class="text-xs text-on-surface-variant">Modifie les catégories avant validation.</p>
            </div>
            <Button variant="primary" icon="Check" loading={globalImportLoading} onclick={handleSaveGlobalImport}>
              Enregistrer les mots
            </Button>
          </div>

          <AdminTable columns={wordColumns} rows={globalImportDrafts}>
            {#snippet row(item, _index)}
              {@const draft = item as ImportDraft}
              <tr class="border-b border-outline-variant/12">
                <td class="px-4 py-2">
                  <input
                    type="text"
                    value={draft.word}
                    aria-label="Mot"
                    oninput={(event) => updateDraft(draft.id, { word: (event.currentTarget as HTMLInputElement).value })}
                    class="input font-mono"
                  />
                </td>
                <td class="px-4 py-2">
                  <select
                    value={draft.category}
                    aria-label="Catégorie"
                    onchange={(event) => updateDraft(draft.id, { category: (event.currentTarget as HTMLSelectElement).value })}
                    class="input"
                  >
                    {#each Object.entries(BANNED_WORD_CATEGORIES) as [key, label] (key)}
                      <option value={key}>{label}</option>
                    {/each}
                  </select>
                </td>
                <td class="px-4 py-2">
                  <div class="flex justify-center">
                    <ToggleSwitch size="sm" checked={draft.enabled} ariaLabel="Activer « {draft.word} »" onToggle={(checked) => updateDraft(draft.id, { enabled: checked })} />
                  </div>
                </td>
                <td class="px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" icon="X" title="Retirer" aria-label="Retirer « {draft.word} »" onclick={() => removeDraft(draft.id)} />
                </td>
              </tr>
            {/snippet}
          </AdminTable>
        </div>
      {/if}
    </div>
  </AdminCard>
</AdminShell>
