<script lang="ts">
  import { onMount } from 'svelte';
  import { DOING_LIST_MODULES, DOING_LIST_STATUSES, type DoingListModule, type DoingListStatus } from '@kotbo/contracts';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, Callout, EmptyState, Field, Menu, Modal, type MenuItem } from '../lib/components/ui';
  import { m } from '../lib/i18n';
  import { moduleName } from '../lib/moduleLabels';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    addDoingListItem,
    createDoingList,
    deleteDoingList,
    fetchDoingList,
    fetchDoingLists,
    removeDoingListItem,
    updateDoingList,
    updateDoingListItem,
    type DoingList,
    type DoingListItem,
  } from '../lib/api';

  const rights = $derived(dashboardStore.state.featureAccess?.doing_lists);
  const isAdmin = $derived(!!dashboardStore.state.access?.canManageSettings);
  const canEdit = $derived(isAdmin || !!rights?.canModerate || !!rights?.canConfigure);
  const canDelete = $derived(isAdmin || !!rights?.canDelete);

  let loading = $state(true);
  let lists = $state<DoingList[]>([]);
  let selectedId = $state<string | null>(null);
  let items = $state<DoingListItem[]>([]);
  let loadingItems = $state(false);
  let newTitle = $state('');

  const selected = $derived(lists.find((list) => list.id === selectedId) ?? null);

  const STATUS_LABEL: Record<DoingListStatus, () => string> = {
    TODO: m.dl_status_todo,
    DOING: m.dl_status_doing,
    DONE: m.dl_status_done,
  };

  // Où ouvrir l'élément d'origine.
  const SOURCE_HREF: Record<DoingListModule, (id: string) => string> = {
    suggestions: () => '/suggestions',
    tickets: (id) => `/tickets?ticket=${encodeURIComponent(id)}`,
  };

  function errorText(err: unknown, fallback: string) {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  async function loadLists() {
    const res = await fetchDoingLists();
    lists = res.lists ?? [];
    if (!selectedId || !lists.some((list) => list.id === selectedId)) selectedId = lists[0]?.id ?? null;
  }

  async function loadItems(listId: string) {
    loadingItems = true;
    try {
      const res = await fetchDoingList(listId);
      if (selectedId === listId) items = res.items ?? [];
    } catch (err) {
      toast.error(errorText(err, m.dl_load_error()));
    } finally {
      loadingItems = false;
    }
  }

  onMount(async () => {
    try {
      await loadLists();
    } catch (err) {
      toast.error(errorText(err, m.dl_load_error()));
    } finally {
      loading = false;
    }
  });

  $effect(() => {
    if (selectedId) void loadItems(selectedId);
    else items = [];
  });

  function syncCounts() {
    if (!selected) return;
    const counts = { TODO: 0, DOING: 0, DONE: 0 };
    for (const item of items) counts[item.status] += 1;
    selected.counts = counts;
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
        const { list } = await createDoingList(payload);
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
    const total = (list.counts?.TODO ?? 0) + (list.counts?.DOING ?? 0) + (list.counts?.DONE ?? 0);
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

  // ── Éléments ─────────────────────────────────────────────────
  async function addItem(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedId || !newTitle.trim()) return;
    try {
      const { item } = await addDoingListItem(selectedId, { title: newTitle });
      items = [...items, item];
      newTitle = '';
      syncCounts();
    } catch (err) {
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  async function moveItem(item: DoingListItem, status: DoingListStatus) {
    if (!selectedId) return;
    const position = items.filter((entry) => entry.status === status).length;
    try {
      const res = await updateDoingListItem(selectedId, item.id, { status, position });
      items = items.map((entry) => (entry.id === item.id ? res.item : entry));
      syncCounts();
    } catch (err) {
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  async function removeItem(item: DoingListItem) {
    if (!selectedId) return;
    try {
      await removeDoingListItem(selectedId, item.id);
      items = items.filter((entry) => entry.id !== item.id);
      syncCounts();
    } catch (err) {
      toast.error(errorText(err, m.dl_save_error()));
    }
  }

  function itemMenu(item: DoingListItem): MenuItem[] {
    return [
      ...DOING_LIST_STATUSES.filter((status) => status !== item.status).map((status) => ({
        label: m.dl_move_to({ status: STATUS_LABEL[status]() }),
        icon: status === 'DONE' ? 'check' : 'arrow-right',
        onselect: () => void moveItem(item, status),
      })),
      {
        label: m.dl_item_remove(),
        description: item.sourceModule ? m.dl_item_remove_hint() : undefined,
        icon: 'delete',
        onselect: () => void removeItem(item),
      },
    ];
  }

  function listMenu(list: DoingList): MenuItem[] {
    return [
      { label: m.dl_edit(), icon: 'edit', onselect: () => openForm(list) },
      ...(canDelete ? [{ label: m.common_delete(), icon: 'delete', onselect: () => void removeList(list) }] : []),
    ];
  }

  const columns = $derived(
    DOING_LIST_STATUSES.map((status) => ({
      status,
      items: items.filter((item) => item.status === status).sort((a, b) => a.position - b.position),
    })),
  );
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
    <div class="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <nav class="space-y-2" aria-label={m.dl_page_title()}>
        {#each lists as list (list.id)}
          <button
            type="button"
            class="dl-list {list.id === selectedId ? 'dl-list--active' : ''}"
            aria-current={list.id === selectedId ? 'true' : undefined}
            onclick={() => (selectedId = list.id)}
          >
            <span class="text-body-sm font-medium text-on-surface truncate">{list.name}</span>
            <span class="text-2xs text-on-surface-variant">
              {m.dl_list_counts({ todo: list.counts?.TODO ?? 0, doing: list.counts?.DOING ?? 0, done: list.counts?.DONE ?? 0 })}
            </span>
          </button>
        {/each}
      </nav>

      {#if selected}
        <section class="section-card p-5 space-y-5 min-w-0">
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
            {#if canEdit}
              <Menu items={listMenu(selected)} label={m.dl_list_options({ name: selected.name })} />
            {/if}
          </header>

          {#if canEdit}
            <form class="flex gap-2" onsubmit={addItem}>
              <input class="input flex-1" maxlength="200" bind:value={newTitle} placeholder={m.dl_add_item_ph()} aria-label={m.dl_add_item_ph()} />
              <Button type="submit" icon="plus" disabled={!newTitle.trim()} disabledReason={m.common_reason_fill_field()}>{m.dl_add_item()}</Button>
            </form>
          {/if}

          {#if loadingItems && items.length === 0}
            <Skeleton height="160px" radius="1rem" />
          {:else}
            <div class="grid gap-3 md:grid-cols-3">
              {#each columns as column (column.status)}
                <div class="dl-column">
                  <h3 class="text-2xs font-semibold uppercase tracking-wide text-on-surface-variant px-1">
                    {STATUS_LABEL[column.status]()} · {column.items.length}
                  </h3>
                  {#each column.items as item (item.id)}
                    <article class="dl-item">
                      <div class="min-w-0 flex-1 space-y-1">
                        <p class="text-body-sm text-on-surface break-words {item.status === 'DONE' ? 'line-through opacity-60' : ''}">{item.title}</p>
                        {#if item.sourceModule && item.sourceId}
                          <a class="dl-chip hover:text-primary" href={SOURCE_HREF[item.sourceModule](item.sourceId)}>
                            <Papicon icon="external-link" size={10} /> {moduleName(item.sourceModule, item.sourceModule)}
                          </a>
                        {/if}
                      </div>
                      {#if canEdit}
                        <Menu items={itemMenu(item)} label={m.dl_item_options({ title: item.title })} />
                      {/if}
                    </article>
                  {:else}
                    <p class="text-2xs text-on-surface-variant px-1 py-3">{m.dl_column_empty()}</p>
                  {/each}
                </div>
              {/each}
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

<style>
  .dl-list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    text-align: left;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-outline-variant) 15%, transparent);
    background: var(--color-surface-container-low);
    transition: border-color 0.15s ease;
  }
  .dl-list:hover,
  .dl-list--active {
    border-color: var(--color-primary);
  }
  .dl-column {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    min-width: 0;
  }
  .dl-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-surface-container);
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
</style>
