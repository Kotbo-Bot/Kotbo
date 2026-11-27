<!--
  Plan d'action d'un dossier : des tâches à cocher au fil du suivi. Chaque
  geste renvoie le dossier à jour, transmis à la page par `onchange`.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { wbTaskProgress } from '../../wellbeingView';
  import { Button } from '../ui';
  import { wbCustom } from '../../stores/wellbeingCustomization.svelte';

  type Task = { id: string; label: string; dueAt: string | null; doneAt: string | null; createdByName: string };

  const {
    caseId,
    tasks = [],
    canWrite,
    hidden,
    onchange,
  }: {
    caseId: string;
    tasks?: Task[];
    canWrite: boolean;
    /** Mode discret : les libellés ne sont pas rendus. */
    hidden: boolean;
    onchange: (item: any) => void;
  } = $props();

  /** Même plafond que le bot (MAX_CASE_TASKS). */
  const MAX_TASKS = 30;
  const progress = $derived(wbTaskProgress(tasks));
  let label = $state('');
  let dueAt = $state('');
  let busyId = $state<string | null>(null);

  const formatDay = (iso: string) => new Date(iso).toLocaleDateString(dateLocale());
  const overdue = (task: Task) => !task.doneAt && !!task.dueAt && task.dueAt.slice(0, 10) < new Date().toISOString().slice(0, 10);

  async function call(id: string, path: string, init: RequestInit) {
    if (busyId) return;
    busyId = id;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/tasks${path}`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      onchange(data.item);
      return true;
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
      return false;
    } finally {
      busyId = null;
    }
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const text = label.trim();
    if (!text) return;
    const ok = await call('new', '', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: text, dueAt: dueAt || null }),
    });
    if (ok) {
      label = '';
      dueAt = '';
    }
  }

  const toggle = (task: Task) => call(task.id, `/${task.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: !task.doneAt }),
  });

  const remove = (task: Task) => call(task.id, `/${task.id}`, { method: 'DELETE' });

  /** Plans d'action types de la cellule, appliqués d'un clic. */
  const plans = $derived(wbCustom.value.taskPlans);
  let planId = $state('');
  let applying = $state(false);
  async function applyPlan() {
    if (!planId || applying) return;
    applying = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      onchange(data.item);
      planId = '';
      toast.success(m.toast_wb_plan_applied({ count: data.added ?? 0 }));
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      applying = false;
    }
  }
</script>

<div class="space-y-4">
  {#if progress.total > 0}
    <div class="space-y-1.5">
      <div class="flex justify-between text-xs text-on-surface-variant">
        <span>{m.wb_tasks_progress({ done: progress.done, total: progress.total })}</span>
        <span>{progress.percent} %</span>
      </div>
      <div class="h-2 bg-surface-container-high rounded-full overflow-hidden" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label={m.wb_tasks_title()}>
        <div class="h-2 rounded-full bg-success transition-all duration-500" style="width: {progress.percent}%"></div>
      </div>
    </div>
  {/if}

  {#if tasks.length === 0}
    <p class="text-xs text-on-surface-variant">{m.wb_tasks_empty()}</p>
  {:else}
    <ul class="space-y-1.5">
      {#each tasks as task (task.id)}
        <li class="flex items-center gap-3 rounded-lg bg-surface-container-high/20 px-3 py-2">
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 accent-[var(--primary)]"
            checked={!!task.doneAt}
            disabled={!canWrite || busyId !== null}
            aria-label={hidden ? m.wb_tasks_toggle_hidden() : m.wb_tasks_toggle({ label: task.label })}
            onchange={() => void toggle(task)}
          />
          <div class="min-w-0 flex-1">
            {#if hidden}
              <p class="text-sm italic text-on-surface-variant">{m.wb_tasks_hidden()}</p>
            {:else}
              <p class="text-sm {task.doneAt ? 'line-through text-on-surface-variant' : 'text-on-surface'}">{task.label}</p>
            {/if}
            <p class="text-2xs text-on-surface-variant">
              {task.createdByName}
              {#if task.dueAt} · <span class={overdue(task) ? 'text-on-error-container font-semibold' : ''}>{m.wb_tasks_due({ date: formatDay(task.dueAt) })}</span>{/if}
            </p>
          </div>
          {#if canWrite}
            <Button size="sm" variant="ghost" icon="trash" loading={busyId === task.id} aria-label={m.wb_tasks_remove()} onclick={() => void remove(task)} />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if canWrite && tasks.length < MAX_TASKS}
    <form onsubmit={add} class="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2">
      <input bind:value={label} maxlength={200} required class="input text-sm" aria-label={m.wb_tasks_new()} placeholder={m.wb_tasks_new_ph()} />
      <input bind:value={dueAt} type="date" class="input text-sm" aria-label={m.wb_tasks_due_label()} />
      <Button type="submit" size="sm" variant="secondary" icon="Plus" loading={busyId === 'new'} disabled={!label.trim()}>{m.common_add()}</Button>
    </form>
    {#if plans.length > 0}
      <div class="flex flex-wrap items-center gap-2">
        <select bind:value={planId} class="input text-sm flex-1 min-w-40" aria-label={m.wb_plan_pick()}>
          <option value="">{m.wb_plan_pick_ph()}</option>
          {#each plans as plan (plan.id)}
            <option value={plan.id}>{plan.label} ({plan.tasks.length})</option>
          {/each}
        </select>
        <Button size="sm" variant="secondary" icon="ListChecks" loading={applying} disabled={!planId} onclick={() => void applyPlan()}>{m.wb_plan_apply()}</Button>
      </div>
    {/if}
  {/if}
</div>
