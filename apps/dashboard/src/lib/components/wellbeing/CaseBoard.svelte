<!--
  Vue en colonnes des dossiers, une par statut. Glisser une carte dans une
  autre colonne change son statut ; au clavier, les boutons de statut de la
  fiche font la même chose. Fermer passe par la confirmation de la page.
-->
<script lang="ts">
  import { m } from '../../i18n';
  import { wbCategoryLabel, wbSeverityLabel, wbStatusLabel } from '../../wellbeingLabels';
  import { wbBoardColumns, wbSeverityAccent, wbSeverityTone, wbStatusTone, type WbCaseView } from '../../wellbeingView';

  type BoardCase = WbCaseView & { title?: string; subjectName?: string; category?: string };

  const {
    cases,
    selectedId,
    canWrite,
    onopen,
    onmove,
  }: {
    cases: BoardCase[];
    selectedId: string | null;
    canWrite: boolean;
    onopen: (caseId: string) => void;
    onmove: (caseId: string, status: string) => void;
  } = $props();

  const columns = $derived(wbBoardColumns(cases));
  let dragging = $state<string | null>(null);
  let over = $state<string | null>(null);

  function drop(status: string) {
    const caseId = dragging;
    dragging = null;
    over = null;
    const card = cases.find((c) => c.id === caseId);
    if (caseId && card && card.status !== status) onmove(caseId, status);
  }
</script>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
  {#each columns as column (column.status)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section
      aria-label={wbStatusLabel(column.status)}
      class="rounded-xl border p-3 space-y-2 min-h-40 transition-colors {over === column.status ? 'border-primary/50 bg-primary/5' : 'border-outline-variant/30 bg-surface-container-low/40'}"
      ondragover={(event) => { if (canWrite && dragging) { event.preventDefault(); over = column.status; } }}
      ondragleave={() => { if (over === column.status) over = null; }}
      ondrop={(event) => { event.preventDefault(); drop(column.status); }}
    >
      <header class="flex items-center justify-between px-1">
        <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {wbStatusTone(column.status)}">{wbStatusLabel(column.status)}</span>
        <span class="text-xs text-on-surface-variant">{column.cases.length}</span>
      </header>
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
              <p class="text-xs text-on-surface-variant truncate mt-0.5">{c.subjectName} · {wbCategoryLabel(c.category ?? '')}</p>
              <span class="inline-block mt-1.5 text-2xs font-semibold px-2 py-0.5 rounded-full {wbSeverityTone(c.severity)}">{wbSeverityLabel(c.severity)}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
