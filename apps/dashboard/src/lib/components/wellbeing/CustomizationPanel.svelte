<!--
  Réglages de la cellule de suivi, tenus par la cellule elle-même : catégories
  et trames, étiquettes, protocole de crise et plans d'action types. Chaque
  bloc s'enregistre à part. Gravités, statuts et motifs de clôture restent
  fixes : relances, effacement et bilan en dépendent.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button, Callout } from '../ui';
  import { wbCategories, type WbCategory, type WbCrisisTask, type WbTag, type WbTaskPlan } from '../../wellbeingCustom';
  import { wbCustom } from '../../stores/wellbeingCustomization.svelte';

  type Kind = 'categories' | 'tags' | 'crisisTasks' | 'taskPlans';

  /** Mêmes plafonds que le bot. */
  const MAX = { categories: 12, tags: 12, crisisTasks: 10, taskPlans: 10, planTasks: 15 };

  function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }
  let categories = $state<WbCategory[]>(copy(wbCategories(wbCustom.value)));
  let tags = $state<WbTag[]>(copy(wbCustom.value.tags));
  let crisisTasks = $state<WbCrisisTask[]>(copy(wbCustom.value.crisisTasks));
  let taskPlans = $state<WbTaskPlan[]>(copy(wbCustom.value.taskPlans));
  let saving = $state<Kind | null>(null);

  /** Enregistre un bloc ; le bot renvoie les réglages nettoyés, repris tels quels. */
  async function save(kind: Kind, value: unknown) {
    if (saving) return;
    saving = kind;
    try {
      const res = await dashboardFetch('/wellbeing/customization', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [kind]: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      wbCustom.value = data.customization;
      if (kind === 'categories') categories = copy(wbCategories(wbCustom.value));
      if (kind === 'tags') tags = copy(wbCustom.value.tags);
      if (kind === 'crisisTasks') crisisTasks = copy(wbCustom.value.crisisTasks);
      if (kind === 'taskPlans') taskPlans = copy(wbCustom.value.taskPlans);
      toast.success(m.toast_wb_custom_saved());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_save_failed());
    } finally {
      saving = null;
    }
  }

  /** Délai saisi ; vide : aucune échéance. */
  const daysOf = (value: string): number | null => (value.trim() === '' ? null : Number(value));
</script>

{#snippet header(icon: string, title: string, description: string)}
  <div>
    <h3 class="text-base font-semibold flex items-center gap-2"><Papicon {icon} size={16} /> {title}</h3>
    <p class="text-xs text-on-surface-variant mt-1">{description}</p>
  </div>
{/snippet}

{#snippet removeButton(name: string, onclick: () => void)}
  <Button size="sm" variant="ghost" icon="trash" aria-label={m.wb_custom_remove({ name })} {onclick} />
{/snippet}

<div class="space-y-6">
  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
    {@render header('Tag', m.wb_custom_categories_title(), m.wb_custom_categories_desc())}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each categories as category, index (index)}
        <div class="rounded-xl bg-surface-container-high/20 border border-outline-variant/30 p-4 space-y-2">
          <div class="flex items-center gap-2">
            <input bind:value={category.label} maxlength={40} class="input text-sm font-semibold flex-1" aria-label={m.wb_custom_category_label()} placeholder={m.wb_custom_category_label()} />
            {@render removeButton(category.label, () => (categories = categories.filter((_, i) => i !== index)))}
          </div>
          <textarea bind:value={category.template} maxlength={2000} rows={4} class="input text-sm w-full" aria-label={m.wb_custom_category_template()} placeholder={m.wb_custom_category_template()}></textarea>
        </div>
      {/each}
    </div>
    <div class="flex flex-wrap justify-between gap-2 border-t border-outline-variant/30 pt-4">
      <Button variant="ghost" icon="plus" disabled={categories.length >= MAX.categories}
        onclick={() => (categories = [...categories, { id: '', label: '', template: '' }])}>{m.wb_custom_add_category()}</Button>
      <Button variant="primary" loading={saving === 'categories'} disabled={categories.length === 0} onclick={() => void save('categories', categories)}>{m.wb_custom_save()}</Button>
    </div>
  </section>

  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
    {@render header('Tags', m.wb_custom_tags_title(), m.wb_custom_tags_desc())}
    <div class="flex flex-wrap gap-2">
      {#each tags as tag, index (index)}
        <div class="flex items-center gap-1 rounded-lg bg-surface-container-high/20 border border-outline-variant/30 pl-2">
          <input bind:value={tag.label} maxlength={30} class="input text-sm w-40" aria-label={m.wb_custom_tag_label()} placeholder={m.wb_custom_tag_label()} />
          {@render removeButton(tag.label, () => (tags = tags.filter((_, i) => i !== index)))}
        </div>
      {/each}
    </div>
    <div class="flex flex-wrap justify-between gap-2 border-t border-outline-variant/30 pt-4">
      <Button variant="ghost" icon="plus" disabled={tags.length >= MAX.tags} onclick={() => (tags = [...tags, { id: '', label: '' }])}>{m.wb_custom_add_tag()}</Button>
      <Button variant="primary" loading={saving === 'tags'} onclick={() => void save('tags', tags)}>{m.wb_custom_save()}</Button>
    </div>
  </section>

  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
    {@render header('AlertTriangle', m.wb_custom_crisis_title(), m.wb_custom_crisis_desc())}
    {#if wbCustom.value.crisisDefault}
      <Callout variant="info">{m.wb_custom_crisis_default()}</Callout>
    {/if}
    <ul class="space-y-2">
      {#each crisisTasks as task, index (index)}
        <li class="grid grid-cols-[1fr_auto_auto] items-center gap-2">
          <input bind:value={task.label} maxlength={200} class="input text-sm" aria-label={m.wb_custom_step_label()} placeholder={m.wb_custom_step_label()} />
          <span class="flex items-center gap-1.5">
            <input bind:value={task.dueHours} type="number" min={1} max={168} class="input text-sm w-20" aria-label={m.wb_custom_step_hours()} title={m.wb_custom_step_hours()} />
            <span class="text-xs text-on-surface-variant w-12">{m.wb_custom_unit_hours()}</span>
          </span>
          {@render removeButton(task.label, () => (crisisTasks = crisisTasks.filter((_, i) => i !== index)))}
        </li>
      {/each}
    </ul>
    <div class="flex flex-wrap justify-between gap-2 border-t border-outline-variant/30 pt-4">
      <div class="flex flex-wrap gap-2">
        <Button variant="ghost" icon="plus" disabled={crisisTasks.length >= MAX.crisisTasks}
          onclick={() => (crisisTasks = [...crisisTasks, { label: '', dueHours: 24 }])}>{m.wb_custom_add_step()}</Button>
        {#if !wbCustom.value.crisisDefault}
          <Button variant="ghost" icon="RotateCcw" disabled={saving !== null} onclick={() => void save('crisisTasks', [])}>{m.wb_custom_crisis_reset()}</Button>
        {/if}
      </div>
      <Button variant="primary" loading={saving === 'crisisTasks'} disabled={crisisTasks.length === 0} onclick={() => void save('crisisTasks', crisisTasks)}>{m.wb_custom_save()}</Button>
    </div>
  </section>

  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
    {@render header('ListChecks', m.wb_custom_plans_title(), m.wb_custom_plans_desc())}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each taskPlans as plan, index (index)}
        <div class="rounded-xl bg-surface-container-high/20 border border-outline-variant/30 p-4 space-y-2">
          <div class="flex items-center gap-2">
            <input bind:value={plan.label} maxlength={40} class="input text-sm font-semibold flex-1" aria-label={m.wb_custom_plan_label()} placeholder={m.wb_custom_plan_label()} />
            {@render removeButton(plan.label, () => (taskPlans = taskPlans.filter((_, i) => i !== index)))}
          </div>
          <ul class="space-y-1.5">
            {#each plan.tasks as task, taskIndex (taskIndex)}
              <li class="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                <input bind:value={task.label} maxlength={200} class="input text-sm" aria-label={m.wb_custom_plan_task()} placeholder={m.wb_custom_plan_task()} />
                <span class="flex items-center gap-1.5">
                  <input value={task.dueDays ?? ''} oninput={(event) => (task.dueDays = daysOf(event.currentTarget.value))} type="number" min={0} max={90}
                    class="input text-sm w-20" aria-label={m.wb_custom_plan_days()} title={m.wb_custom_plan_days()} />
                  <span class="text-xs text-on-surface-variant">{m.wb_custom_unit_days()}</span>
                </span>
                {@render removeButton(task.label, () => (plan.tasks = plan.tasks.filter((_, i) => i !== taskIndex)))}
              </li>
            {/each}
          </ul>
          <Button size="sm" variant="ghost" icon="plus" disabled={plan.tasks.length >= MAX.planTasks}
            onclick={() => (plan.tasks = [...plan.tasks, { label: '', dueDays: null }])}>{m.wb_custom_add_plan_task()}</Button>
        </div>
      {/each}
    </div>
    <div class="flex flex-wrap justify-between gap-2 border-t border-outline-variant/30 pt-4">
      <Button variant="ghost" icon="plus" disabled={taskPlans.length >= MAX.taskPlans}
        onclick={() => (taskPlans = [...taskPlans, { id: '', label: '', tasks: [{ label: '', dueDays: null }] }])}>{m.wb_custom_add_plan()}</Button>
      <Button variant="primary" loading={saving === 'taskPlans'} onclick={() => void save('taskPlans', taskPlans)}>{m.wb_custom_save()}</Button>
    </div>
  </section>
</div>
