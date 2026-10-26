<!--
  Parcours de tutorat : les objectifs à acquérir, rangés par étape, et le rythme
  des tutorats (durée minimale, points d'étape). Les réglages s'enregistrent au
  fil de l'eau.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../ModulePage.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { Button, Callout, EmptyState, Field, Menu, Modal, type MenuItem } from '../ui';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    deleteTutoringItem,
    fetchTutoringCandidates,
    fetchTutoringConfig,
    fetchTutoringItems,
    saveTutoringItem,
    updateTutoringConfig,
    type TutoringCandidates,
    type TutoringConfig,
    type TutoringItem,
  } from '../../api/tutoring';

  let loading = $state(true);
  let config = $state<TutoringConfig | null>(null);
  let items = $state<TutoringItem[]>([]);
  let targets = $state<TutoringCandidates | null>(null);

  const steps = $derived.by(() => {
    const groups: Array<{ name: string; items: TutoringItem[] }> = [];
    for (const item of [...items].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const group = groups.find((entry) => entry.name === item.category);
      if (group) group.items.push(item);
      else groups.push({ name: item.category, items: [item] });
    }
    return groups;
  });

  function errorText(err: unknown, fallback: string) {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  function targetLabel(item: TutoringItem) {
    const hierarchy = targets?.hierarchies.find((entry) => entry.id === item.hierarchyId)?.name;
    if (!hierarchy && !item.grade) return m.tu_target_all();
    return [hierarchy, item.grade].filter(Boolean).join(' · ');
  }

  onMount(async () => {
    try {
      const [configRes, itemsRes, targetsRes] = await Promise.all([
        fetchTutoringConfig(),
        fetchTutoringItems(),
        fetchTutoringCandidates().catch(() => null),
      ]);
      config = configRes.config;
      items = itemsRes.items ?? [];
      targets = targetsRes;
    } catch (err) {
      toast.error(errorText(err, m.tu_load_error()));
    } finally {
      loading = false;
    }
  });

  // ── Rythme ─────────────────────────────────────────────────
  let configState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function saveConfig(patch: Partial<TutoringConfig>) {
    if (!config) return;
    const before = config;
    config = { ...config, ...patch };
    configState = 'saving';
    try {
      config = (await updateTutoringConfig(patch)).config;
      configState = 'saved';
    } catch (err) {
      config = before;
      configState = 'error';
      toast.error(errorText(err, m.tu_save_error()));
    }
  }

  function onDays(key: 'minTestDays' | 'reportIntervalDays' | 'reminderDaysBefore', event: Event) {
    const value = Math.floor(Number((event.currentTarget as HTMLInputElement).value));
    const min = key === 'reminderDaysBefore' ? 0 : 1;
    if (Number.isFinite(value) && value >= min && value <= 365) void saveConfig({ [key]: value });
  }

  // ── Objectifs ──────────────────────────────────────────────
  let itemOpen = $state(false);
  let editing = $state<TutoringItem | null>(null);
  let itemStep = $state('');
  let itemTitle = $state('');
  let itemDescription = $state('');
  let itemHierarchyId = $state('');
  let itemGrade = $state('');
  let itemSaving = $state(false);
  let itemError = $state('');

  function openItem(item: TutoringItem | null, step = '') {
    editing = item;
    itemStep = item?.category ?? step;
    itemTitle = item?.title ?? '';
    itemDescription = item?.description ?? '';
    itemHierarchyId = item?.hierarchyId ?? '';
    itemGrade = item?.grade ?? '';
    itemError = '';
    itemOpen = true;
  }

  async function submitItem(event: SubmitEvent) {
    event.preventDefault();
    if (!itemTitle.trim()) {
      itemError = m.tu_item_title_required();
      return;
    }
    itemSaving = true;
    itemError = '';
    try {
      const { item } = await saveTutoringItem({
        ...(editing ? { id: editing.id, sortOrder: editing.sortOrder } : { sortOrder: items.reduce((max, entry) => Math.max(max, entry.sortOrder), 0) + 1 }),
        category: itemStep.trim() || m.tu_step_default(),
        title: itemTitle,
        description: itemDescription || null,
        hierarchyId: itemHierarchyId || null,
        grade: itemGrade || null,
      });
      items = editing ? items.map((entry) => (entry.id === item.id ? item : entry)) : [...items, item];
      itemOpen = false;
    } catch (err) {
      itemError = errorText(err, m.tu_save_error());
    } finally {
      itemSaving = false;
    }
  }

  async function removeItem(item: TutoringItem) {
    if (!(await confirmDialog.danger(m.tu_item_delete_title({ title: item.title }), m.tu_item_delete_desc(), m.common_delete()))) return;
    try {
      await deleteTutoringItem(item.id);
      items = items.filter((entry) => entry.id !== item.id);
    } catch (err) {
      toast.error(errorText(err, m.tu_save_error()));
    }
  }

  function itemMenu(item: TutoringItem): MenuItem[] {
    return [
      { label: m.common_edit(), icon: 'edit', onselect: () => openItem(item) },
      { label: m.common_delete(), icon: 'delete', onselect: () => void removeItem(item) },
    ];
  }
</script>

<ModulePage title={m.tu_programs_title()} description={m.tu_programs_desc()} icon="book-open" featureKey="tutoring">
  {#snippet actions()}
    <Button variant="ghost" icon="arrow-left" onclick={() => router.goto('/tutoring')}>{m.tu_back()}</Button>
    <Button variant="primary" icon="plus" onclick={() => openItem(null)}>{m.tu_item_add()}</Button>
  {/snippet}

  {#if loading}
    <Skeleton height="240px" radius="1rem" />
  {:else}
    <div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section class="min-w-0 space-y-4">
        {#if steps.length === 0}
          <div class="section-card">
            <EmptyState icon="list-checks" title={m.tu_items_empty_title()} description={m.tu_items_empty_desc()} actionLabel={m.tu_item_add()} onAction={() => openItem(null)} />
          </div>
        {:else}
          {#each steps as step (step.name)}
            <div class="section-card p-5 space-y-3">
              <div class="flex items-center justify-between gap-2">
                <h2 class="text-base font-semibold text-on-surface">{step.name}</h2>
                <Button size="sm" variant="ghost" icon="plus" onclick={() => openItem(null, step.name)}>{m.tu_item_add_here()}</Button>
              </div>
              <ul class="space-y-1.5">
                {#each step.items as item (item.id)}
                  <li class="tu-item">
                    <div class="min-w-0 flex-1">
                      <p class="text-body-sm text-on-surface">{item.title}</p>
                      {#if item.description}<p class="text-2xs text-on-surface-variant">{item.description}</p>{/if}
                    </div>
                    <span class="badge badge-neutral">{targetLabel(item)}</span>
                    <Menu items={itemMenu(item)} label={m.tu_item_options({ title: item.title })} />
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        {/if}
      </section>

      {#if config}
        <aside class="section-card p-5 space-y-4">
          <div class="flex items-baseline justify-between gap-2">
            <h2 class="text-base font-semibold text-on-surface">{m.tu_rhythm_title()}</h2>
            <span class="text-2xs {configState === 'error' ? 'text-error' : 'text-on-surface-variant'}" aria-live="polite">
              {configState === 'saving' ? m.dl_autosave_saving() : configState === 'saved' ? m.dl_autosave_saved() : ''}
            </span>
          </div>
          <Field label={m.tu_rhythm_min()} hint={m.tu_rhythm_min_hint()}>
            {#snippet children(id, describedBy)}
              <input {id} aria-describedby={describedBy} class="input w-28" type="number" min="1" max="365" value={config?.minTestDays} onchange={(event) => onDays('minTestDays', event)} />
            {/snippet}
          </Field>
          <Field label={m.tu_rhythm_interval()} hint={m.tu_rhythm_interval_hint()}>
            {#snippet children(id, describedBy)}
              <input {id} aria-describedby={describedBy} class="input w-28" type="number" min="1" max="365" value={config?.reportIntervalDays} onchange={(event) => onDays('reportIntervalDays', event)} />
            {/snippet}
          </Field>
          <Field label={m.tu_rhythm_reminder()} hint={m.tu_rhythm_reminder_hint()}>
            {#snippet children(id, describedBy)}
              <input {id} aria-describedby={describedBy} class="input w-28" type="number" min="0" max="365" value={config?.reminderDaysBefore} onchange={(event) => onDays('reminderDaysBefore', event)} />
            {/snippet}
          </Field>
        </aside>
      {/if}
    </div>
  {/if}
</ModulePage>

<Modal bind:open={itemOpen} title={editing ? m.tu_item_edit() : m.tu_item_add()} size="md">
  <form id="tu-item" class="space-y-4" onsubmit={submitItem}>
    <Field label={m.tu_item_step()} hint={m.tu_item_step_hint()}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full" maxlength="80" list="tu-steps" bind:value={itemStep} placeholder={m.tu_item_step_ph()} />
        <datalist id="tu-steps">
          {#each steps as step (step.name)}<option value={step.name}></option>{/each}
        </datalist>
      {/snippet}
    </Field>
    <Field label={m.tu_item_title()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-full" maxlength="200" bind:value={itemTitle} placeholder={m.tu_item_title_ph()} />
      {/snippet}
    </Field>
    <Field label={m.tu_item_description()}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input h-20 w-full resize-y" maxlength="1000" bind:value={itemDescription}></textarea>
      {/snippet}
    </Field>
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label={m.tu_field_hierarchy()} hint={m.tu_item_target_hint()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={itemHierarchyId}>
            <option value="">{m.tu_any()}</option>
            {#each targets?.hierarchies ?? [] as hierarchy (hierarchy.id)}<option value={hierarchy.id}>{hierarchy.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.tu_field_grade()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={itemGrade}>
            <option value="">{m.tu_any()}</option>
            {#each (targets?.grades ?? []).filter((grade) => !itemHierarchyId || !grade.hierarchyId || grade.hierarchyId === itemHierarchyId) as grade ((grade.hierarchyId ?? '') + grade.name)}
              <option value={grade.name}>{grade.name}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
    </div>
    {#if itemError}<Callout variant="danger">{itemError}</Callout>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (itemOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="tu-item" loading={itemSaving}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<style>
  .tu-item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-surface-container-low);
  }
</style>
