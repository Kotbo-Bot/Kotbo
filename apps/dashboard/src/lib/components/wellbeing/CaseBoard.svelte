<!--
  Vue en colonnes des dossiers : Ouvert, les étapes ajoutées par la cellule,
  Sous surveillance, Clos. Glisser une carte la déplace ; dans une étape, le
  dossier garde son statut. La cellule ajoute, renomme et supprime ses
  étapes ; au clavier, la fiche du dossier offre les mêmes choix.
-->
<script lang="ts">
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { wbSeverityLabel, wbStatusLabel } from '../../wellbeingLabels';
  import { wbCategoryName } from '../../wellbeingCustom';
  import { wbCustom } from '../../stores/wellbeingCustomization.svelte';
  import { wbBoardColumns, wbSeverityAccent, wbSeverityTone, wbStatusTone, type WbBoardStage, type WbBoardTarget, type WbCaseView } from '../../wellbeingView';
  import { Button } from '../ui';

  type BoardCase = WbCaseView & { title?: string; subjectName?: string; category?: string };

  const {
    cases,
    stages,
    selectedId,
    canWrite,
    onopen,
    onmove,
    onstages,
  }: {
    cases: BoardCase[];
    stages: WbBoardStage[];
    selectedId: string | null;
    canWrite: boolean;
    onopen: (caseId: string) => void;
    onmove: (caseId: string, target: WbBoardTarget) => void;
    /** Nouvelle liste des étapes, à enregistrer. */
    onstages: (stages: Array<{ id?: string; label: string }>) => Promise<boolean>;
  } = $props();

  /** Même plafond que le bot. */
  const STAGE_MAX = 6;
  const LABEL_MAX = 40;

  const columns = $derived(wbBoardColumns(cases, stages));
  let dragging = $state<string | null>(null);
  let over = $state<string | null>(null);
  let adding = $state(false);
  let newLabel = $state('');
  let renamingId = $state<string | null>(null);
  let renameLabel = $state('');

  function drop(key: string, target: WbBoardTarget) {
    const caseId = dragging;
    dragging = null;
    over = null;
    const card = cases.find((c) => c.id === caseId);
    if (!caseId || !card) return;
    const column = columns.find((item) => item.key === key);
    if (column?.cases.some((c) => c.id === caseId)) return;
    onmove(caseId, target);
  }

  async function addStage() {
    const label = newLabel.trim();
    if (!label) return;
    if (await onstages([...stages, { label }])) {
      newLabel = '';
      adding = false;
    }
  }

  async function renameStage(id: string) {
    const label = renameLabel.trim();
    if (!label) return;
    if (await onstages(stages.map((stage) => (stage.id === id ? { id, label } : stage)))) renamingId = null;
  }

  async function removeStage(stage: WbBoardStage) {
    if (!(await confirmDialog.danger(m.wb_board_stage_remove_q({ name: stage.label }), m.wb_board_stage_remove_warn(), m.wb_board_stage_remove_confirm()))) return;
    await onstages(stages.filter((item) => item.id !== stage.id));
  }
</script>

<div class="flex gap-4 overflow-x-auto pb-2 items-start">
  {#each columns as column (column.key)}
    {@const target = column.kind === 'status' ? { status: column.status } : { stage: column.stage }}
    {@const title = column.kind === 'status' ? wbStatusLabel(column.status) : column.label}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section
      aria-label={title}
      class="flex-none w-72 rounded-xl border p-3 space-y-2 min-h-40 transition-colors {over === column.key ? 'border-primary/50 bg-primary/5' : 'border-outline-variant/30 bg-surface-container-low/40'}"
      ondragover={(event) => { if (canWrite && dragging) { event.preventDefault(); over = column.key; } }}
      ondragleave={() => { if (over === column.key) over = null; }}
      ondrop={(event) => { event.preventDefault(); drop(column.key, target); }}
    >
      <header class="flex items-center justify-between gap-2 px-1">
        {#if column.kind === 'stage' && renamingId === column.stage}
          <form class="flex flex-1 gap-1.5" onsubmit={(event) => { event.preventDefault(); void renameStage(column.stage); }}>
            <label for="wb-stage-rename-{column.stage}" class="sr-only">{m.wb_board_stage_rename()}</label>
            <input id="wb-stage-rename-{column.stage}" class="input text-xs flex-1 py-1" maxlength={LABEL_MAX} bind:value={renameLabel} />
            <Button size="sm" variant="ghost" icon="Check" type="submit" aria-label={m.wb_board_stage_rename()} />
          </form>
        {:else}
          <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {column.kind === 'status' ? wbStatusTone(column.status) : 'bg-primary/10 text-primary border border-primary/20'}">{title}</span>
          <span class="flex items-center gap-1">
            <span class="text-xs text-on-surface-variant">{column.cases.length}</span>
            {#if canWrite && column.kind === 'stage'}
              {@const stage = stages.find((item) => item.id === column.stage)}
              <Button size="sm" variant="ghost" icon="Pencil" aria-label={m.wb_board_stage_rename()} onclick={() => { renamingId = column.stage; renameLabel = column.label; }} />
              {#if stage}
                <Button size="sm" variant="ghost" icon="Trash2" aria-label={m.wb_board_stage_remove()} onclick={() => void removeStage(stage)} />
              {/if}
            {/if}
          </span>
        {/if}
      </header>
      {#if column.kind === 'stage' && column.cases.length === 0}
        <p class="text-2xs text-on-surface-variant px-1">{m.wb_board_stage_hint()}</p>
      {/if}
      {#if column.cases.length === 0}
        <p class="text-xs text-on-surface-variant text-center py-6">{canWrite ? m.wb_board_drop_here() : m.wb_board_empty()}</p>
      {/if}
      <ul class="space-y-1.5">
        {#each column.cases as c (c.id)}
          <li>
            <button
              type="button"
              draggable={canWrite}
              aria-current={selectedId === c.id ? 'true' : undefined}
              ondragstart={(event) => { dragging = c.id; event.dataTransfer?.setData('text/plain', c.id); }}
              ondragend={() => { dragging = null; over = null; }}
              onclick={() => onopen(c.id)}
              class="w-full text-left rounded-lg border-l-4 {wbSeverityAccent(c.severity)} px-3 py-2 transition-colors {selectedId === c.id ? 'bg-primary/10 ring-1 ring-primary/30' : 'bg-surface-container-high/30 hover:bg-surface-container-high/50'} {canWrite ? 'cursor-grab active:cursor-grabbing' : ''}"
            >
              <p class="text-sm font-semibold text-on-surface line-clamp-2">{c.title}</p>
              <p class="text-xs text-on-surface-variant truncate mt-0.5">{c.subjectName} · {wbCategoryName(wbCustom.value, c.category ?? '')}</p>
              <span class="inline-flex flex-wrap gap-1 mt-1.5">
                <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {wbSeverityTone(c.severity)}">{wbSeverityLabel(c.severity)}</span>
                {#if column.kind === 'stage'}
                  <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {wbStatusTone(c.status)}">{wbStatusLabel(c.status)}</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  {#if canWrite && stages.length < STAGE_MAX}
    <section class="flex-none w-72 rounded-xl border border-dashed border-outline-variant/50 p-3 space-y-2">
      {#if adding}
        <form class="space-y-2" onsubmit={(event) => { event.preventDefault(); void addStage(); }}>
          <label for="wb-stage-new" class="text-xs font-medium text-on-surface-variant">{m.wb_board_stage_new_label()}</label>
          <input id="wb-stage-new" class="input w-full text-sm" maxlength={LABEL_MAX} placeholder={m.wb_board_stage_new_ph()} bind:value={newLabel} />
          <div class="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onclick={() => { adding = false; newLabel = ''; }}>{m.common_cancel()}</Button>
            <Button size="sm" variant="primary" icon="Plus" type="submit" disabled={!newLabel.trim()}>{m.wb_board_stage_add()}</Button>
          </div>
        </form>
      {:else}
        <button type="button" class="w-full h-full min-h-32 flex flex-col items-center justify-center gap-1 text-sm text-on-surface-variant hover:text-primary" onclick={() => (adding = true)}>
          <span class="text-xl leading-none">+</span>
          {m.wb_board_stage_add()}
          <span class="text-2xs">{m.wb_board_stage_add_hint()}</span>
        </button>
      {/if}
    </section>
  {/if}
</div>
