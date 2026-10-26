<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DOING_LIST_MODULES,
    DOING_LIST_PRIORITIES,
    type DoingListChecklistEntry,
    type DoingListModule,
    type DoingListPriority,
    type DoingListSource,
  } from '@kotbo/contracts';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, Callout, EmptyState, Field, Menu, Modal, type MenuItem } from '../lib/components/ui';
  import { m, dateLocale } from '../lib/i18n';
  import { moduleName } from '../lib/moduleLabels';
  import { localInitialAvatar } from '../lib/discordMedia';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    addDoingListItem,
    createDoingList,
    createDoingListColumn,
    deleteDoingList,
    deleteDoingListColumn,
    fetchDoingList,
    fetchDoingListAssignees,
    fetchDoingLists,
    removeDoingListItem,
    reorderDoingListColumns,
    updateDoingList,
    updateDoingListColumn,
    updateDoingListItem,
    type DoingList,
    type DoingListAssignee,
    type DoingListColumn,
    type DoingListItem,
  } from '../lib/api';

  const rights = $derived(dashboardStore.state.featureAccess?.doing_lists);
  const isAdmin = $derived(!!dashboardStore.state.access?.canManageSettings);
  const canEdit = $derived(isAdmin || !!rights?.canModerate || !!rights?.canConfigure);
  const canDelete = $derived(isAdmin || !!rights?.canDelete);
  const myId = $derived((authStore.user as { id?: string } | null)?.id);

  let loading = $state(true);
  let lists = $state<DoingList[]>([]);
  let selectedId = $state<string | null>(null);
  let columns = $state<DoingListColumn[]>([]);
  let items = $state<DoingListItem[]>([]);
  let assignees = $state<DoingListAssignee[]>([]);
  let loadingBoard = $state(false);
  let search = $state('');
  let onlyMine = $state(false);
  // Carte à ouvrir une fois la liste chargée (?card= dans l'adresse).
  let pendingCardId: string | null = null;

  const selected = $derived(lists.find((list) => list.id === selectedId) ?? null);
  const sortedColumns = $derived([...columns].sort((a, b) => a.position - b.position));
  const filtering = $derived(!!search.trim() || onlyMine);
  // Glisser une carte dans une vue filtrée la poserait à une place qu'on ne voit pas.
  const canDrag = $derived(canEdit && !filtering);

  const PRIORITY_LABEL: Record<DoingListPriority, () => string> = {
    LOW: m.dl_priority_low,
    MEDIUM: m.dl_priority_medium,
    HIGH: m.dl_priority_high,
  };
  const PRIORITY_BADGE: Record<DoingListPriority, string> = {
    LOW: 'badge-neutral',
    MEDIUM: 'badge-warning',
    HIGH: 'badge-danger',
  };

  // Où ouvrir l'élément d'origine.
  const SOURCE_HREF: Record<DoingListSource, (id: string) => string> = {
    suggestions: () => '/suggestions',
    tickets: (id) => `/tickets?ticket=${encodeURIComponent(id)}`,
    tasks: () => '/planning',
  };

  function sourceName(source: DoingListSource) {
    return source === 'tasks' ? m.dl_source_tasks() : moduleName(source, source);
  }

  function errorText(err: unknown, fallback: string) {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  function memberName(member: DoingListAssignee | null | undefined) {
    return member?.displayName || member?.username || member?.userId || '';
  }

  function memberAvatar(member: DoingListAssignee) {
    return member.avatarUrl || localInitialAvatar(memberName(member), member.userId);
  }

  function labelHue(label: string) {
    let hash = 0;
    for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
  }

  function formatDue(value: string) {
    return new Date(value).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
  }

  function isDoneColumn(columnId: string) {
    return !!columns.find((column) => column.id === columnId)?.isDone;
  }

  function isOverdue(item: DoingListItem) {
    return !!item.dueDate && new Date(item.dueDate).getTime() < Date.now() && !isDoneColumn(item.columnId);
  }

  function matches(item: DoingListItem) {
    if (onlyMine && item.staffTask?.assignee?.userId !== myId) return false;
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return item.title.toLowerCase().includes(query)
      || item.labels.some((label) => label.toLowerCase().includes(query))
      || memberName(item.staffTask?.assignee).toLowerCase().includes(query);
  }

  const board = $derived(
    sortedColumns.map((column) => {
      const all = items.filter((item) => item.columnId === column.id);
      return {
        ...column,
        count: all.length,
        items: all.filter(matches).sort((a, b) => a.position - b.position),
      };
    }),
  );

  async function loadLists() {
    const res = await fetchDoingLists();
    lists = res.lists ?? [];
    if (!selectedId || !lists.some((list) => list.id === selectedId)) selectedId = lists[0]?.id ?? null;
  }

  async function loadBoard(listId: string) {
    loadingBoard = true;
    try {
      const res = await fetchDoingList(listId);
      if (selectedId !== listId) return;
      columns = res.columns ?? [];
      items = res.items ?? [];
      if (pendingCardId) {
        const card = items.find((item) => item.id === pendingCardId);
        pendingCardId = null;
        if (card) openCard(card);
      }
    } catch (err) {
      toast.error(errorText(err, m.dl_load_error()));
    } finally {
      loadingBoard = false;
    }
  }

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    selectedId = params.get('list');
    pendingCardId = params.get('card');
    try {
      await loadLists();
    } catch (err) {
      toast.error(errorText(err, m.dl_load_error()));
    } finally {
      loading = false;
    }
    // La liste des personnes à qui attribuer ne bloque pas l'affichage du tableau.
    fetchDoingListAssignees().then((res) => { assignees = res.members ?? []; }).catch(() => {});
  });

  $effect(() => {
    if (selectedId) void loadBoard(selectedId);
    else {
      columns = [];
      items = [];
    }
  });

  function syncCounts() {
    if (!selected) return;
    selected.counts = { total: items.length, done: items.filter((item) => isDoneColumn(item.columnId)).length };
  }

  function replaceItem(item: DoingListItem) {
    items = items.map((entry) => (entry.id === item.id ? item : entry));
  }

  // ── Création / modification d'une liste ──────────────────────
  let formOpen = $state(false);
  let formEditingId = $state<string | null>(null);
  let formName = $state('');
  let formDescription = $state('');
  let formModules = $state<DoingListModule[]>([]);
  let formSaving = $state(false);
  let formError = $state('');

  function openForm(list: DoingList | null = null) {
    formEditingId = list?.id ?? null;
    formName = list?.name ?? '';
    formDescription = list?.description ?? '';
    formModules = [...(list?.modules ?? [])];
    formError = '';
    formOpen = true;
  }

  function toggleModule(module: DoingListModule) {
    formModules = formModules.includes(module) ? formModules.filter((key) => key !== module) : [...formModules, module];
  }

  async function submitForm(event: SubmitEvent) {
    event.preventDefault();
    if (!formName.trim()) {
      formError = m.dl_form_name_required();
      return;
    }
    formSaving = true;
    formError = '';
    const payload = { name: formName, description: formDescription || null, modules: formModules };
    try {
      if (formEditingId) {
        const { list } = await updateDoingList(formEditingId, payload);
        lists = lists.map((entry) => (entry.id === list.id ? { ...entry, ...list } : entry));
      } else {
        const { list } = await createDoingList({ ...payload, columns: [m.dl_status_todo(), m.dl_status_doing(), m.dl_status_done()] });
        lists = [...lists, list];
        selectedId = list.id;
      }
      formOpen = false;
    } catch (err) {
      formError = errorText(err, m.dl_save_error());
    } finally {
      formSaving = false;
    }
  }

  async function removeList(list: DoingList) {
    const total = list.counts?.total ?? 0;
    const impacts = total > 0 ? [m.dl_delete_impact({ count: total })] : [];
    if (!(await confirmDialog.danger(m.dl_delete_title({ name: list.name }), m.dl_delete_desc(), m.common_delete(), impacts))) return;
    try {
      await deleteDoingList(list.id);
      lists = lists.filter((entry) => entry.id !== list.id);
      if (selectedId === list.id) selectedId = lists[0]?.id ?? null;
    } catch (err) {
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  function listMenu(list: DoingList): MenuItem[] {
    return [
      { label: m.dl_edit(), icon: 'edit', onselect: () => openForm(list) },
      { label: m.dl_column_add(), icon: 'plus', onselect: () => openColumnForm() },
      ...(canDelete ? [{ label: m.common_delete(), icon: 'delete', onselect: () => void removeList(list) }] : []),
    ];
  }

  // ── Étapes ───────────────────────────────────────────────────
  let columnFormOpen = $state(false);
  let columnEditingId = $state<string | null>(null);
  let columnName = $state('');
  let columnLimit = $state<number | null>(null);
  let columnDone = $state(false);
  let columnSaving = $state(false);
  let columnError = $state('');

  function openColumnForm(column: DoingListColumn | null = null) {
    columnEditingId = column?.id ?? null;
    columnName = column?.name ?? '';
    columnLimit = column?.wipLimit ?? null;
    columnDone = column?.isDone ?? false;
    columnError = '';
    columnFormOpen = true;
  }

  async function submitColumn(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedId) return;
    if (!columnName.trim()) {
      columnError = m.dl_column_name_required();
      return;
    }
    columnSaving = true;
    columnError = '';
    const payload = { name: columnName, wipLimit: columnLimit && columnLimit > 0 ? Math.floor(columnLimit) : null, isDone: columnDone };
    try {
      if (columnEditingId) {
        const { column } = await updateDoingListColumn(selectedId, columnEditingId, payload);
        columns = columns.map((entry) => (entry.id === column.id ? column : entry));
      } else {
        const { column } = await createDoingListColumn(selectedId, payload);
        columns = [...columns, column];
      }
      syncCounts();
      columnFormOpen = false;
    } catch (err) {
      columnError = errorText(err, m.dl_save_error());
    } finally {
      columnSaving = false;
    }
  }

  async function saveColumnOrder(ids: string[]) {
    if (!selectedId) return;
    const snapshot = columns;
    const position = new Map(ids.map((id, index) => [id, index]));
    columns = columns.map((column) => ({ ...column, position: position.get(column.id) ?? column.position }));
    try {
      const res = await reorderDoingListColumns(selectedId, ids);
      columns = res.columns;
    } catch (err) {
      columns = snapshot;
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  function shiftColumn(column: DoingListColumn, delta: number) {
    const ids = sortedColumns.map((entry) => entry.id);
    const from = ids.indexOf(column.id);
    const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, column.id);
    void saveColumnOrder(ids);
  }

  async function removeColumn(column: DoingListColumn) {
    if (!selectedId) return;
    const target = sortedColumns.find((entry) => entry.id !== column.id);
    if (!target) return;
    const count = items.filter((item) => item.columnId === column.id).length;
    const impacts = count > 0 ? [m.dl_column_delete_impact({ count, target: target.name })] : [];
    if (!(await confirmDialog.danger(m.dl_column_delete_title({ name: column.name }), m.dl_column_delete_desc(), m.common_delete(), impacts))) return;
    try {
      await deleteDoingListColumn(selectedId, column.id, target.id);
      await loadBoard(selectedId);
      syncCounts();
    } catch (err) {
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  function columnMenu(column: DoingListColumn, index: number): MenuItem[] {
    return [
      { label: m.dl_column_edit(), icon: 'edit', onselect: () => openColumnForm(column) },
      ...(index > 0 ? [{ label: m.dl_column_move_left(), icon: 'arrow-left', onselect: () => shiftColumn(column, -1) }] : []),
      ...(index < sortedColumns.length - 1 ? [{ label: m.dl_column_move_right(), icon: 'arrow-right', onselect: () => shiftColumn(column, 1) }] : []),
      ...(sortedColumns.length > 1 ? [{ label: m.common_delete(), icon: 'delete', onselect: () => void removeColumn(column) }] : []),
    ];
  }

  // ── Cartes ───────────────────────────────────────────────────
  let addingIn = $state<string | null>(null);
  let newTitle = $state('');

  async function addItem(event: SubmitEvent, columnId: string) {
    event.preventDefault();
    if (!selectedId || !newTitle.trim()) return;
    try {
      const { item } = await addDoingListItem(selectedId, { title: newTitle, columnId });
      items = [...items, item];
      newTitle = '';
      syncCounts();
    } catch (err) {
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  /** Pose la carte à l'indice voulu de l'étape (indice compté avec la carte encore à sa place). */
  async function moveItem(itemId: string, columnId: string, index: number) {
    if (!selectedId) return;
    const item = items.find((entry) => entry.id === itemId);
    const column = columns.find((entry) => entry.id === columnId);
    if (!item || !column) return;
    const ordered = items.filter((entry) => entry.columnId === columnId).sort((a, b) => a.position - b.position);
    let target = index;
    if (item.columnId === columnId) {
      const from = ordered.findIndex((entry) => entry.id === itemId);
      if (from < target) target -= 1;
      if (from === target) return;
    } else if (column.wipLimit && ordered.length >= column.wipLimit) {
      toast.error(m.dl_column_full({ name: column.name, limit: column.wipLimit }));
      return;
    }

    const snapshot = items;
    const rest = ordered.filter((entry) => entry.id !== itemId);
    rest.splice(target, 0, item);
    const positions = new Map(rest.map((entry, position) => [entry.id, position]));
    items = items.map((entry) => {
      const position = positions.get(entry.id);
      if (entry.id === itemId) return { ...entry, columnId, position: position ?? 0 };
      return position === undefined ? entry : { ...entry, position };
    });
    syncCounts();
    try {
      const res = await updateDoingListItem(selectedId, itemId, { columnId, index: target });
      replaceItem({ ...res.item, position: positions.get(itemId) ?? res.item.position });
    } catch (err) {
      items = snapshot;
      syncCounts();
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  function itemMenu(item: DoingListItem): MenuItem[] {
    return sortedColumns
      .filter((column) => column.id !== item.columnId)
      .map((column) => ({
        label: m.dl_move_to({ status: column.name }),
        icon: column.isDone ? 'check' : 'arrow-right',
        onselect: () => void moveItem(item.id, column.id, Number.MAX_SAFE_INTEGER),
      }));
  }

  // ── Glisser-déposer ──────────────────────────────────────────
  let drag = $state<{ kind: 'item' | 'column'; id: string } | null>(null);
  let dropAt = $state<{ columnId: string; index: number } | null>(null);
  let dropColumnAt = $state<number | null>(null);

  function startDrag(event: DragEvent, kind: 'item' | 'column', id: string) {
    drag = { kind, id };
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function endDrag() {
    drag = null;
    dropAt = null;
    dropColumnAt = null;
  }

  function overCard(event: DragEvent, columnId: string, index: number) {
    if (drag?.kind !== 'item') return;
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = { columnId, index: event.clientY > rect.top + rect.height / 2 ? index + 1 : index };
  }

  function overColumn(event: DragEvent, columnId: string, columnIndex: number, count: number) {
    if (!drag) return;
    event.preventDefault();
    if (drag.kind === 'column') dropColumnAt = columnIndex;
    // Entre deux cartes, on garde la place calculée sur la carte survolée.
    else if (dropAt?.columnId !== columnId) dropAt = { columnId, index: count };
  }

  function dropOnColumn(event: DragEvent) {
    event.preventDefault();
    const current = drag;
    const at = dropAt;
    const columnAt = dropColumnAt;
    endDrag();
    if (!current) return;
    if (current.kind === 'item' && at) void moveItem(current.id, at.columnId, at.index);
    if (current.kind === 'column' && columnAt !== null) {
      const ids = sortedColumns.map((column) => column.id).filter((id) => id !== current.id);
      ids.splice(columnAt, 0, current.id);
      if (ids.join() !== sortedColumns.map((column) => column.id).join()) void saveColumnOrder(ids);
    }
  }

  // ── Fiche d'une carte ────────────────────────────────────────
  let cardOpen = $state(false);
  let card = $state<DoingListItem | null>(null);
  let cardTitle = $state('');
  let cardDescription = $state('');
  let cardColumnId = $state('');
  let cardAssigneeId = $state('');
  let cardPriority = $state<DoingListPriority | ''>('');
  let cardDue = $state('');
  let cardLabels = $state<string[]>([]);
  let cardChecklist = $state<DoingListChecklistEntry[]>([]);
  let newLabel = $state('');
  let newCheck = $state('');
  let cardSaving = $state(false);
  let cardError = $state('');

  const checklistDone = $derived(cardChecklist.filter((entry) => entry.done).length);

  function toDateInput(value: string | null) {
    if (!value) return '';
    const date = new Date(value);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function openCard(item: DoingListItem) {
    card = item;
    cardTitle = item.title;
    cardDescription = item.description ?? '';
    cardColumnId = item.columnId;
    cardAssigneeId = item.staffTask?.assignee?.id ?? '';
    cardPriority = item.priority ?? '';
    cardDue = toDateInput(item.dueDate);
    cardLabels = [...item.labels];
    cardChecklist = item.checklist.map((entry) => ({ ...entry }));
    newLabel = '';
    newCheck = '';
    cardError = '';
    cardOpen = true;
  }

  function addLabel(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const label = newLabel.trim().slice(0, 30);
    if (label && !cardLabels.includes(label) && cardLabels.length < 10) cardLabels = [...cardLabels, label];
    newLabel = '';
  }

  function addCheck(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = newCheck.trim();
    if (text && cardChecklist.length < 50) cardChecklist = [...cardChecklist, { id: crypto.randomUUID().slice(0, 12), text, done: false }];
    newCheck = '';
  }

  async function saveCard(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedId || !card) return;
    if (!cardTitle.trim()) {
      cardError = m.dl_card_title_required();
      return;
    }
    cardSaving = true;
    cardError = '';
    const previousAssignee = card.staffTask?.assignee?.id ?? '';
    try {
      const { item } = await updateDoingListItem(selectedId, card.id, {
        title: cardTitle,
        description: cardDescription || null,
        priority: cardPriority || null,
        // Midi, heure locale : la date reste la même quel que soit le fuseau.
        dueDate: cardDue ? new Date(`${cardDue}T12:00:00`).toISOString() : null,
        labels: cardLabels,
        checklist: cardChecklist,
        ...(cardColumnId !== card.columnId ? { columnId: cardColumnId } : {}),
        ...(cardAssigneeId !== previousAssignee ? { assigneeId: cardAssigneeId || null } : {}),
      });
      replaceItem(item);
      syncCounts();
      if (cardAssigneeId && cardAssigneeId !== previousAssignee) toast.success(m.dl_card_assigned({ name: memberName(item.staffTask?.assignee) }));
      cardOpen = false;
    } catch (err) {
      cardError = errorText(err, m.dl_save_error());
    } finally {
      cardSaving = false;
    }
  }

  async function removeCard() {
    if (!selectedId || !card) return;
    const target = card;
    const impacts = target.staffTask?.assignee ? [m.dl_card_remove_task_kept({ name: memberName(target.staffTask.assignee) })] : [];
    if (!(await confirmDialog.danger(m.dl_card_remove_title({ title: target.title }), target.sourceModule ? m.dl_item_remove_hint() : m.dl_card_remove_desc(), m.dl_item_remove(), impacts))) return;
    try {
      await removeDoingListItem(selectedId, target.id);
      items = items.filter((entry) => entry.id !== target.id);
      syncCounts();
      cardOpen = false;
    } catch (err) {
      toast.error(errorText(err, m.dl_save_error()));
    }
  }
</script>

<ModulePage title={m.dl_page_title()} description={m.dl_page_desc()} icon="list-checks" featureKey="doing_lists">
  {#snippet actions()}
    {#if canEdit}
      <Button variant="primary" icon="plus" onclick={() => openForm()}>{m.dl_new_list()}</Button>
    {/if}
  {/snippet}

  {#if loading}
    <Skeleton height="320px" radius="1rem" />
  {:else if lists.length === 0}
    <div class="section-card">
      {#if canEdit}
        <EmptyState icon="list-checks" title={m.dl_empty_title()} description={m.dl_empty_desc()} actionLabel={m.dl_empty_action()} onAction={() => openForm()} />
      {:else}
        <EmptyState icon="list-checks" title={m.dl_empty_title()} description={m.dl_empty_desc()} reason="read-only" />
      {/if}
    </div>
  {:else}
    <div class="space-y-4">
      <nav class="flex gap-2 overflow-x-auto pb-1" aria-label={m.dl_page_title()}>
        {#each lists as list (list.id)}
          <button
            type="button"
            class="dl-list {list.id === selectedId ? 'dl-list--active' : ''}"
            aria-current={list.id === selectedId ? 'true' : undefined}
            onclick={() => (selectedId = list.id)}
          >
            <span class="text-body-sm font-medium text-on-surface truncate">{list.name}</span>
            <span class="text-2xs text-on-surface-variant">{m.dl_list_progress({ done: list.counts?.done ?? 0, total: list.counts?.total ?? 0 })}</span>
          </button>
        {/each}
      </nav>

      {#if selected}
        <section class="section-card p-5 space-y-4 min-w-0">
          <header class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 space-y-1">
              <h2 class="text-base font-semibold text-on-surface">{selected.name}</h2>
              {#if selected.description}
                <p class="text-body-sm text-on-surface-variant whitespace-pre-wrap">{selected.description}</p>
              {/if}
              <div class="flex flex-wrap gap-1.5 pt-1">
                {#each selected.modules as module (module)}
                  <span class="dl-chip">{moduleName(module, module)}</span>
                {:else}
                  <span class="text-2xs text-on-surface-variant">{m.dl_no_module()}</span>
                {/each}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <input class="input text-body-sm w-48" type="search" bind:value={search} placeholder={m.dl_search_ph()} aria-label={m.dl_search_ph()} />
              <label class="flex items-center gap-1.5 text-body-sm text-on-surface whitespace-nowrap">
                <input type="checkbox" bind:checked={onlyMine} /> {m.dl_only_mine()}
              </label>
              {#if canEdit}
                <Menu items={listMenu(selected)} label={m.dl_list_options({ name: selected.name })} />
              {/if}
            </div>
          </header>

          {#if canEdit && filtering}
            <p class="text-2xs text-on-surface-variant">{m.dl_drag_disabled_filter()}</p>
          {/if}

          {#if loadingBoard && columns.length === 0}
            <Skeleton height="240px" radius="1rem" />
          {:else}
            <div class="dl-board" role="list">
              {#each board as column, columnIndex (column.id)}
                {@const full = !!column.wipLimit && column.count >= column.wipLimit}
                {@const over = !!column.wipLimit && column.count > column.wipLimit}
                <div
                  class="dl-column {dropColumnAt === columnIndex && drag?.kind === 'column' ? 'dl-column--drop' : ''} {drag?.kind === 'column' && drag.id === column.id ? 'opacity-50' : ''}"
                  role="listitem"
                  ondragover={(event) => overColumn(event, column.id, columnIndex, column.items.length)}
                  ondrop={dropOnColumn}
                >
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <header
                    class="dl-column-head {canEdit ? 'cursor-grab' : ''}"
                    draggable={canEdit}
                    ondragstart={(event) => startDrag(event, 'column', column.id)}
                    ondragend={endDrag}
                  >
                    <h3 class="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-on-surface-variant">
                      {#if column.isDone}<Papicon icon="check" size={12} class="inline -mt-0.5" />{/if}
                      {column.name}
                    </h3>
                    <span
                      class="text-2xs font-semibold {over ? 'text-error' : full ? 'text-warning' : 'text-on-surface-variant'}"
                      title={column.wipLimit ? m.dl_column_limit_hint({ limit: column.wipLimit }) : undefined}
                    >
                      {column.count}{column.wipLimit ? ` / ${column.wipLimit}` : ''}
                    </span>
                    {#if canEdit}
                      <Menu items={columnMenu(column, columnIndex)} label={m.dl_column_options({ name: column.name })} />
                    {/if}
                  </header>

                  <div class="dl-column-body">
                    {#each column.items as item, index (item.id)}
                      {@const done = column.isDone}
                      {@const checks = item.checklist.length}
                      {@const checked = item.checklist.filter((entry) => entry.done).length}
                      <div
                        class="dl-card {dropAt?.columnId === column.id && dropAt.index === index && drag?.kind === 'item' ? 'dl-card--drop' : ''} {drag?.kind === 'item' && drag.id === item.id ? 'opacity-40' : ''}"
                        draggable={canDrag}
                        ondragstart={(event) => startDrag(event, 'item', item.id)}
                        ondragend={endDrag}
                        ondragover={(event) => overCard(event, column.id, index)}
                        role="button"
                        tabindex="0"
                        aria-label={m.dl_card_open({ title: item.title })}
                        onclick={() => openCard(item)}
                        onkeydown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openCard(item); } }}
                      >
                        {#if item.labels.length > 0}
                          <div class="flex flex-wrap gap-1">
                            {#each item.labels as label (label)}
                              <span class="dl-chip"><span class="dl-dot" style="background: hsl({labelHue(label)} 65% 50%)"></span>{label}</span>
                            {/each}
                          </div>
                        {/if}
                        <div class="flex items-start gap-2">
                          <p class="min-w-0 flex-1 text-body-sm text-on-surface wrap-break-word {done ? 'line-through opacity-60' : ''}">{item.title}</p>
                          {#if canEdit}
                            <!-- Le menu ne doit pas ouvrir la fiche de la carte. -->
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
                              <Menu items={itemMenu(item)} label={m.dl_item_options({ title: item.title })} />
                            </div>
                          {/if}
                        </div>
                        <div class="flex flex-wrap items-center gap-2 text-2xs text-on-surface-variant">
                          {#if item.priority}
                            <span class="badge {PRIORITY_BADGE[item.priority]}">{PRIORITY_LABEL[item.priority]()}</span>
                          {/if}
                          {#if item.dueDate}
                            <span class="inline-flex items-center gap-1 {isOverdue(item) ? 'text-error font-semibold' : ''}">
                              <Papicon icon="calendar" size={12} /> {formatDue(item.dueDate)}
                            </span>
                          {/if}
                          {#if checks > 0}
                            <span class="inline-flex items-center gap-1 {checked === checks ? 'text-success' : ''}">
                              <Papicon icon="check-square" size={12} /> {checked}/{checks}
                            </span>
                          {/if}
                          {#if item.description}
                            <Papicon icon="align-left" size={12} />
                          {/if}
                          {#if item.sourceModule}
                            <span class="dl-chip">{sourceName(item.sourceModule)}</span>
                          {/if}
                          {#if item.staffTask?.assignee}
                            <img
                              class="ml-auto h-5 w-5 rounded-full"
                              src={memberAvatar(item.staffTask.assignee)}
                              alt={memberName(item.staffTask.assignee)}
                              title={memberName(item.staffTask.assignee)}
                            />
                          {/if}
                        </div>
                      </div>
                    {:else}
                      <p class="text-2xs text-on-surface-variant px-1 py-3">{filtering ? m.dl_column_no_match() : m.dl_column_empty()}</p>
                    {/each}
                    {#if dropAt?.columnId === column.id && dropAt.index === column.items.length && drag?.kind === 'item'}
                      <div class="dl-drop-end" aria-hidden="true"></div>
                    {/if}
                  </div>

                  {#if canEdit}
                    {#if addingIn === column.id}
                      <form class="space-y-2" onsubmit={(event) => addItem(event, column.id)}>
                        <!-- svelte-ignore a11y_autofocus -->
                        <input
                          class="input w-full text-body-sm"
                          maxlength="200"
                          bind:value={newTitle}
                          placeholder={m.dl_add_item_ph()}
                          aria-label={m.dl_add_item_ph()}
                          autofocus
                          onkeydown={(event) => { if (event.key === 'Escape') addingIn = null; }}
                        />
                        <div class="flex gap-2">
                          <Button type="submit" size="sm" icon="plus" disabled={!newTitle.trim()} disabledReason={m.common_reason_fill_field()}>{m.dl_add_item()}</Button>
                          <Button size="sm" variant="ghost" onclick={() => (addingIn = null)}>{m.common_cancel()}</Button>
                        </div>
                      </form>
                    {:else}
                      <Button variant="ghost" size="sm" icon="plus" fullWidth onclick={() => { addingIn = column.id; newTitle = ''; }}>{m.dl_add_card()}</Button>
                    {/if}
                  {/if}
                </div>
              {/each}
              {#if canEdit}
                <button type="button" class="dl-column-add" onclick={() => openColumnForm()}>
                  <Papicon icon="plus" size={14} /> {m.dl_column_add()}
                </button>
              {/if}
            </div>
            {#if selected.modules.length > 0}
              <p class="text-2xs text-on-surface-variant">{m.dl_pin_hint()}</p>
            {/if}
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</ModulePage>

<Modal bind:open={formOpen} title={formEditingId ? m.dl_form_edit_title() : m.dl_form_create_title()} size="md">
  <form id="dl-form" class="space-y-4" onsubmit={submitForm}>
    <Field label={m.dl_form_name()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full" maxlength="80" bind:value={formName} placeholder={m.dl_form_name_ph()} />
      {/snippet}
    </Field>
    <Field label={m.dl_form_description()}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input w-full h-20 resize-none" maxlength="500" bind:value={formDescription}></textarea>
      {/snippet}
    </Field>
    <fieldset class="space-y-2">
      <legend class="text-body-sm font-medium text-on-surface mb-1">{m.dl_form_modules()}</legend>
      <p class="text-2xs text-on-surface-variant">{m.dl_form_modules_hint()}</p>
      {#each DOING_LIST_MODULES as module (module)}
        <label class="flex items-center gap-2 text-body-sm text-on-surface">
          <input type="checkbox" checked={formModules.includes(module)} onchange={() => toggleModule(module)} />
          {moduleName(module, module)}
        </label>
      {/each}
    </fieldset>
    {#if !formEditingId}
      <p class="text-2xs text-on-surface-variant">{m.dl_form_columns_hint()}</p>
    {/if}
    {#if formError}
      <Callout variant="danger">{formError}</Callout>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (formOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="dl-form" loading={formSaving}>
      {formEditingId ? m.common_save() : m.dl_form_create()}
    </Button>
  {/snippet}
</Modal>

<Modal bind:open={columnFormOpen} title={columnEditingId ? m.dl_column_edit() : m.dl_column_add()} size="sm">
  <form id="dl-column-form" class="space-y-4" onsubmit={submitColumn}>
    <Field label={m.dl_column_name()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full" maxlength="80" bind:value={columnName} placeholder={m.dl_column_name_ph()} />
      {/snippet}
    </Field>
    <Field label={m.dl_column_limit()} hint={m.dl_column_limit_field_hint()}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-32" type="number" min="1" max="999" bind:value={columnLimit} />
      {/snippet}
    </Field>
    <label class="flex items-start gap-2 text-body-sm text-on-surface">
      <input type="checkbox" class="mt-0.5" bind:checked={columnDone} />
      <span>
        {m.dl_column_done()}
        <span class="block text-2xs text-on-surface-variant">{m.dl_column_done_hint()}</span>
      </span>
    </label>
    {#if columnError}
      <Callout variant="danger">{columnError}</Callout>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (columnFormOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="dl-column-form" loading={columnSaving}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={cardOpen} title={m.dl_card_title()} size="lg">
  {#if card}
    <form id="dl-card-form" class="space-y-4" onsubmit={saveCard}>
      <Field label={m.dl_card_field_title()} required>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} class="input w-full" maxlength="200" bind:value={cardTitle} disabled={!canEdit} />
        {/snippet}
      </Field>

      <div class="grid gap-4 sm:grid-cols-2">
        <Field label={m.dl_card_field_column()}>
          {#snippet children(id, describedBy)}
            <select {id} aria-describedby={describedBy} class="input w-full" bind:value={cardColumnId} disabled={!canEdit}>
              {#each sortedColumns as column (column.id)}
                <option value={column.id}>{column.name}{column.wipLimit ? ` (${items.filter((item) => item.columnId === column.id).length}/${column.wipLimit})` : ''}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.dl_card_field_assignee()} hint={m.dl_card_assignee_hint()}>
          {#snippet children(id, describedBy)}
            <select {id} aria-describedby={describedBy} class="input w-full" bind:value={cardAssigneeId} disabled={!canEdit}>
              {#if card?.sourceModule !== 'tasks'}
                <option value="">{m.dl_card_nobody()}</option>
              {/if}
              {#each assignees as member (member.id)}
                <option value={member.id}>{memberName(member)}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.dl_card_field_priority()}>
          {#snippet children(id, describedBy)}
            <select {id} aria-describedby={describedBy} class="input w-full" bind:value={cardPriority} disabled={!canEdit}>
              <option value="">{m.dl_priority_none()}</option>
              {#each DOING_LIST_PRIORITIES as priority (priority)}
                <option value={priority}>{PRIORITY_LABEL[priority]()}</option>
              {/each}
            </select>
          {/snippet}
        </Field>
        <Field label={m.dl_card_field_due()}>
          {#snippet children(id, describedBy)}
            <input {id} aria-describedby={describedBy} class="input w-full" type="date" bind:value={cardDue} disabled={!canEdit} />
          {/snippet}
        </Field>
      </div>

      <Field label={m.dl_card_field_labels()} hint={canEdit ? m.dl_card_labels_hint() : undefined}>
        {#snippet children(id, describedBy)}
          <div class="space-y-2">
            {#if cardLabels.length > 0}
              <div class="flex flex-wrap gap-1.5">
                {#each cardLabels as label (label)}
                  <span class="dl-chip">
                    <span class="dl-dot" style="background: hsl({labelHue(label)} 65% 50%)"></span>{label}
                    {#if canEdit}
                      <button type="button" class="hover:text-on-surface" aria-label={m.dl_card_label_remove({ label })} onclick={() => (cardLabels = cardLabels.filter((entry) => entry !== label))}>
                        <Papicon icon="x" size={10} />
                      </button>
                    {/if}
                  </span>
                {/each}
              </div>
            {/if}
            {#if canEdit}
              <input {id} aria-describedby={describedBy} class="input w-full" maxlength="30" bind:value={newLabel} onkeydown={addLabel} placeholder={m.dl_card_labels_ph()} />
            {/if}
          </div>
        {/snippet}
      </Field>

      <Field label={m.dl_card_field_description()}>
        {#snippet children(id, describedBy)}
          <textarea {id} aria-describedby={describedBy} class="input w-full h-32 resize-y" maxlength="4000" bind:value={cardDescription} disabled={!canEdit} placeholder={m.dl_card_description_ph()}></textarea>
        {/snippet}
      </Field>

      <fieldset class="space-y-2">
        <legend class="text-body-sm font-medium text-on-surface mb-1">
          {m.dl_card_field_checklist()}{cardChecklist.length > 0 ? ` · ${checklistDone}/${cardChecklist.length}` : ''}
        </legend>
        {#if cardChecklist.length > 0}
          <div class="dl-progress" aria-hidden="true"><span style="width: {(checklistDone / cardChecklist.length) * 100}%"></span></div>
        {/if}
        {#each cardChecklist as entry (entry.id)}
          <div class="flex items-center gap-2 text-body-sm text-on-surface">
            <input type="checkbox" bind:checked={entry.done} disabled={!canEdit} aria-label={entry.text} />
            <span class="min-w-0 flex-1 wrap-break-word {entry.done ? 'line-through text-on-surface-variant' : ''}">{entry.text}</span>
            {#if canEdit}
              <button type="button" class="text-on-surface-variant hover:text-on-surface" aria-label={m.dl_card_check_remove({ text: entry.text })} onclick={() => (cardChecklist = cardChecklist.filter((other) => other.id !== entry.id))}>
                <Papicon icon="x" size={12} />
              </button>
            {/if}
          </div>
        {/each}
        {#if canEdit}
          <input class="input w-full text-body-sm" maxlength="200" bind:value={newCheck} onkeydown={addCheck} placeholder={m.dl_card_check_ph()} aria-label={m.dl_card_check_ph()} />
        {/if}
      </fieldset>

      {#if card.sourceModule && card.sourceId}
        <a class="inline-flex items-center gap-1 text-body-sm text-primary hover:underline" href={SOURCE_HREF[card.sourceModule](card.sourceId)}>
          <Papicon icon="external-link" size={12} /> {m.dl_card_open_source({ source: sourceName(card.sourceModule) })}
        </a>
      {/if}
      {#if card.staffTask && card.sourceModule !== 'tasks'}
        <p class="text-2xs text-on-surface-variant">{m.dl_card_in_planning({ name: memberName(card.staffTask.assignee) })}</p>
      {/if}

      {#if cardError}
        <Callout variant="danger">{cardError}</Callout>
      {/if}
    </form>
  {/if}
  {#snippet footer()}
    {#if canEdit}
      <Button variant="ghost" icon="delete" onclick={removeCard}>{m.dl_item_remove()}</Button>
      <span class="flex-1"></span>
      <Button variant="ghost" onclick={() => (cardOpen = false)}>{m.common_cancel()}</Button>
      <Button variant="primary" type="submit" form="dl-card-form" loading={cardSaving}>{m.common_save()}</Button>
    {:else}
      <Button variant="ghost" onclick={() => (cardOpen = false)}>{m.common_close()}</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .dl-list {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 10rem;
    max-width: 16rem;
    text-align: left;
    padding: 0.625rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-outline-variant) 15%, transparent);
    background: var(--color-surface-container-low);
    transition: border-color 0.15s ease;
  }
  .dl-list:hover,
  .dl-list--active {
    border-color: var(--color-primary);
  }
  .dl-board {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    overflow-x: auto;
    padding-bottom: 0.5rem;
  }
  .dl-column {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 0.5rem;
    width: 17.5rem;
    max-width: 85vw;
    padding: 0.75rem;
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    border: 1px solid transparent;
    transition: border-color 0.15s ease;
  }
  .dl-column--drop {
    border-color: var(--color-primary);
  }
  .dl-column-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.25rem;
  }
  .dl-column-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 3rem;
  }
  .dl-column-add {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 0.375rem;
    width: 17.5rem;
    padding: 0.75rem;
    border-radius: 0.75rem;
    border: 1px dashed var(--color-outline-variant);
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }
  .dl-column-add:hover {
    color: var(--color-on-surface);
    border-color: var(--color-primary);
  }
  .dl-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-surface-container);
    border: 1px solid transparent;
    transition: border-color 0.15s ease;
  }
  .dl-card {
    cursor: pointer;
  }
  .dl-card[draggable='true'] {
    cursor: grab;
  }
  .dl-card:hover {
    border-color: color-mix(in srgb, var(--color-outline-variant) 60%, transparent);
  }
  .dl-card:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .dl-card--drop {
    box-shadow: 0 -3px 0 0 var(--color-primary);
  }
  .dl-drop-end {
    height: 3px;
    border-radius: 999px;
    background: var(--color-primary);
  }
  .dl-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    color: var(--color-on-surface-variant);
  }
  .dl-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
  }
  .dl-progress {
    height: 0.25rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    overflow: hidden;
  }
  .dl-progress span {
    display: block;
    height: 100%;
    background: var(--color-primary);
    transition: width 0.2s ease;
  }
</style>
