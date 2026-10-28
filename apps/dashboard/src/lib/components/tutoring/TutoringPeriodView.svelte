<!--
  Fiche d'un tutorat. En haut, où il en est et ce qu'il y a à faire ensuite ;
  au milieu, les objectifs du parcours, les missions et le carnet de bord ; sur
  le côté, les points d'étape et la décision.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../ModulePage.svelte';
  import Papicon from '../Papicon.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { Button, Callout, EmptyState, Field, Menu, Modal, type MenuItem } from '../ui';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    OBJECTIVE_STATES,
    REPORT_META,
    STATUS_META,
    formatDay,
    memberAvatar,
    memberName,
    nextReportText,
    progressPercent,
  } from '../../tutoring';
  import {
    addTutoringLog,
    addTutoringReport,
    createTutoringMissionsBoard,
    decideTutoring,
    deleteTutoring,
    fetchTutoringCandidates,
    fetchTutoringPeriod,
    setTutoringObjective,
    updateTutoring,
    type TutoringCandidates,
    type TutoringDetail,
    type TutoringObjectiveState,
    type TutoringReportType,
    type TutoringRole,
  } from '../../api/tutoring';
  import { addDoingListItem, updateDoingListItem } from '../../api/doingLists';

  const { periodId }: { periodId: string } = $props();

  let loading = $state(true);
  let notFound = $state(false);
  let period = $state<TutoringDetail | null>(null);
  let role = $state<TutoringRole | null>(null);

  const canCoach = $derived(role === 'manager' || role === 'mentor');
  const isManager = $derived(role === 'manager');
  const ongoing = $derived(period?.status === 'ONGOING');
  const percent = $derived(period ? progressPercent(period) : 0);

  // Objectifs dans l'ordre du parcours, regroupés par étape.
  const steps = $derived.by(() => {
    const groups: Array<{ name: string; items: TutoringDetail['objectives'] }> = [];
    for (const objective of period?.objectives ?? []) {
      const group = groups.find((entry) => entry.name === objective.category);
      if (group) group.items.push(objective);
      else groups.push({ name: objective.category, items: [objective] });
    }
    return groups;
  });

  function errorText(err: unknown, fallback: string) {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  function apply(res: { period: TutoringDetail; role: TutoringRole }) {
    period = res.period;
    role = res.role;
  }

  async function load() {
    try {
      apply(await fetchTutoringPeriod(periodId));
      notFound = false;
    } catch (err) {
      notFound = true;
      toast.error(errorText(err, m.tu_load_error()));
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // ── Objectifs ──────────────────────────────────────────────
  async function setObjective(objectiveId: string, state: TutoringObjectiveState) {
    if (!period) return;
    const before = period;
    // Mise à jour sur place : cocher un objectif doit répondre tout de suite.
    const objectives = period.objectives.map((objective) => (objective.id === objectiveId ? { ...objective, state } : objective));
    period = {
      ...period,
      objectives,
      progress: {
        ...period.progress,
        acquired: objectives.filter((objective) => objective.state === 'ACQUIRED').length,
        learning: objectives.filter((objective) => objective.state === 'KNOWN').length,
      },
    };
    try {
      await setTutoringObjective(periodId, objectiveId, state);
    } catch (err) {
      period = before;
      toast.error(errorText(err, m.tu_save_error()));
    }
  }

  // ── Missions ───────────────────────────────────────────────
  let newMission = $state('');
  let addingMission = $state(false);

  async function createBoard() {
    try {
      apply(await createTutoringMissionsBoard(periodId));
    } catch (err) {
      toast.error(errorText(err, m.tu_save_error()));
    }
  }

  /** Une mission est une carte de la liste, attribuée au tutoré : elle arrive dans son planning. */
  async function addMission(event: SubmitEvent) {
    event.preventDefault();
    if (!period?.missions || !newMission.trim()) return;
    addingMission = true;
    try {
      const { item } = await addDoingListItem(period.missions.list.id, { title: newMission });
      await updateDoingListItem(period.missions.list.id, item.id, { assigneeId: period.apprentice.id });
      newMission = '';
      apply(await fetchTutoringPeriod(periodId));
    } catch (err) {
      toast.error(errorText(err, m.tu_save_error()));
    } finally {
      addingMission = false;
    }
  }

  // ── Carnet de bord ─────────────────────────────────────────
  let newLog = $state('');
  let addingLog = $state(false);

  async function addLog(event: SubmitEvent) {
    event.preventDefault();
    if (!period || !newLog.trim()) return;
    addingLog = true;
    try {
      const { log } = await addTutoringLog(periodId, newLog);
      period = { ...period, logs: [log, ...period.logs] };
      newLog = '';
    } catch (err) {
      toast.error(errorText(err, m.tu_save_error()));
    } finally {
      addingLog = false;
    }
  }

  // ── Point d'étape ──────────────────────────────────────────
  let reportOpen = $state(false);
  let reportType = $state<TutoringReportType>('POSITIVE');
  let reportContent = $state('');
  let reportSaving = $state(false);
  let reportError = $state('');

  function openReport() {
    reportType = 'POSITIVE';
    reportContent = '';
    reportError = '';
    reportOpen = true;
  }

  async function submitReport(event: SubmitEvent) {
    event.preventDefault();
    if (!reportContent.trim()) {
      reportError = m.tu_report_required();
      return;
    }
    reportSaving = true;
    reportError = '';
    try {
      apply(await addTutoringReport(periodId, reportType, reportContent));
      reportOpen = false;
      toast.success(m.tu_report_saved());
    } catch (err) {
      reportError = errorText(err, m.tu_save_error());
    } finally {
      reportSaving = false;
    }
  }

  // ── Décision ───────────────────────────────────────────────
  let decisionOpen = $state(false);
  let decision = $state<'PASSED' | 'FAILED'>('PASSED');
  let decisionNotes = $state('');
  let decisionSaving = $state(false);
  let decisionError = $state('');
  let canForce = $state(false);

  function openDecision(status: 'PASSED' | 'FAILED') {
    decision = status;
    decisionNotes = '';
    decisionError = '';
    canForce = false;
    decisionOpen = true;
  }

  async function submitDecision(force = false) {
    decisionSaving = true;
    decisionError = '';
    try {
      apply(await decideTutoring(periodId, { status: decision, notes: decisionNotes || undefined, force }));
      decisionOpen = false;
      toast.success(decision === 'PASSED' ? m.tu_decision_passed_done() : m.tu_decision_failed_done());
    } catch (err) {
      decisionError = errorText(err, m.tu_save_error());
      // L'API dit si un administrateur peut passer outre la durée minimale.
      canForce = !!(err as { data?: { canForce?: boolean } })?.data?.canForce;
    } finally {
      decisionSaving = false;
    }
  }

  // ── Modifier / supprimer ───────────────────────────────────
  let editOpen = $state(false);
  let candidates = $state<TutoringCandidates | null>(null);
  let editMentorId = $state('');
  let editDuration = $state(14);
  let editHierarchyId = $state('');
  let editGrade = $state('');
  let editSaving = $state(false);
  let editError = $state('');

  async function openEdit() {
    if (!period) return;
    editMentorId = period.mentor?.id ?? '';
    editDuration = period.plannedDurationDays;
    editHierarchyId = period.hierarchyId ?? '';
    editGrade = period.targetGrade ?? '';
    editError = '';
    editOpen = true;
    if (!candidates) {
      try {
        candidates = await fetchTutoringCandidates();
      } catch (err) {
        editError = errorText(err, m.tu_load_error());
      }
    }
  }

  async function submitEdit(event: SubmitEvent) {
    event.preventDefault();
    editSaving = true;
    editError = '';
    try {
      apply(await updateTutoring(periodId, {
        mentorId: editMentorId || null,
        plannedDurationDays: Math.max(1, Math.floor(Number(editDuration) || 14)),
        hierarchyId: editHierarchyId || null,
        targetGrade: editGrade || null,
      }));
      editOpen = false;
    } catch (err) {
      editError = errorText(err, m.tu_save_error());
    } finally {
      editSaving = false;
    }
  }

  async function remove() {
    if (!period) return;
    if (!(await confirmDialog.danger(m.tu_delete_title({ name: memberName(period.apprentice) }), m.tu_delete_desc(), m.common_delete()))) return;
    try {
      await deleteTutoring(periodId);
      router.goto('/tutoring');
    } catch (err) {
      toast.error(errorText(err, m.tu_save_error()));
    }
  }

  const menuItems = $derived<MenuItem[]>([
    { label: m.tu_edit(), icon: 'edit', onselect: () => void openEdit() },
    { label: m.common_delete(), icon: 'delete', onselect: () => void remove() },
  ]);

  const READY_LABEL: Record<string, (check: { value: number; target: number }) => string> = {
    duration: (check) => m.tu_ready_duration({ value: check.value, target: check.target }),
    objectives: (check) => m.tu_ready_objectives({ value: check.value, target: check.target }),
    reports: (check) => m.tu_ready_reports({ value: check.value }),
  };
</script>

<ModulePage
  title={period ? memberName(period.apprentice) : m.tu_page_title()}
  description={period ? (period.targetGrade ? m.tu_detail_desc_grade({ grade: period.targetGrade }) : m.tu_detail_desc()) : ''}
  icon="book-open"
  featureKey="tutoring"
>
  {#snippet actions()}
    <Button variant="ghost" icon="arrow-left" onclick={() => router.goto('/tutoring')}>{m.tu_back()}</Button>
    {#if isManager && period}
      <Menu items={menuItems} label={m.tu_options()} />
    {/if}
  {/snippet}

  {#if loading}
    <Skeleton height="320px" radius="1rem" />
  {:else if notFound || !period}
    <div class="section-card">
      <EmptyState icon="book-open" title={m.tu_not_found_title()} description={m.tu_not_found_desc()} actionLabel={m.tu_back()} onAction={() => router.goto('/tutoring')} />
    </div>
  {:else}
    <div class="space-y-6">
      <!-- Où il en est, et la prochaine chose à faire. -->
      <section class="section-card p-5">
        <div class="flex flex-wrap items-center gap-4">
          <img class="h-12 w-12 rounded-full" src={memberAvatar(period.apprentice)} alt="" />
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="badge {STATUS_META[period.status].badge}">{STATUS_META[period.status].label()}</span>
              <span class="text-body-sm text-on-surface-variant">
                {period.mentor ? m.tu_card_mentor({ name: memberName(period.mentor) }) : m.tu_no_mentor()}
              </span>
            </div>
            <p class="text-body-sm text-on-surface">
              {ongoing
                ? m.tu_card_day({ day: period.daysElapsed, planned: period.plannedDurationDays })
                : period.endDate ? m.tu_card_ended({ date: formatDay(period.endDate) }) : ''}
              · {m.tu_card_objectives({ acquired: period.progress.acquired, total: period.progress.total })}
            </p>
            <div class="tu-bar max-w-md" aria-hidden="true"><span style="width: {percent}%"></span></div>
            {#if nextReportText(period)}
              <p class="text-2xs {period.reportOverdue ? 'font-semibold text-error' : 'text-on-surface-variant'}">{nextReportText(period)}</p>
            {/if}
          </div>
          {#if canCoach && ongoing}
            <div class="flex flex-wrap gap-2">
              <Button variant={period.reportOverdue ? 'primary' : 'secondary'} icon="message-square" onclick={openReport}>{m.tu_report_new()}</Button>
              <Button variant="ghost" icon="check" onclick={() => openDecision('PASSED')}>{m.tu_conclude()}</Button>
            </div>
          {/if}
        </div>
      </section>

      <div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div class="min-w-0 space-y-6">
          <!-- Objectifs du parcours -->
          <section class="section-card p-5 space-y-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="text-base font-semibold text-on-surface">{m.tu_objectives_title()}</h2>
              {#if canCoach && ongoing}<p class="text-2xs text-on-surface-variant">{m.tu_objectives_hint()}</p>{/if}
            </div>
            {#if steps.length === 0}
              <p class="text-body-sm text-on-surface-variant">
                {m.tu_objectives_empty()}
                {#if isManager}<a class="text-primary hover:underline" href="/tutoring/programs">{m.tu_objectives_empty_link()}</a>{/if}
              </p>
            {:else}
              {#each steps as step (step.name)}
                {@const done = step.items.filter((objective) => objective.state === 'ACQUIRED').length}
                <div class="space-y-2">
                  <h3 class="text-2xs font-semibold uppercase tracking-wide text-on-surface-variant">{step.name} · {done}/{step.items.length}</h3>
                  <ul class="space-y-1.5">
                    {#each step.items as objective (objective.id)}
                      <li class="tu-objective">
                        <div class="min-w-0 flex-1">
                          <p class="text-body-sm text-on-surface {objective.state === 'ACQUIRED' ? 'line-through opacity-70' : ''}">{objective.title}</p>
                          {#if objective.description}<p class="text-2xs text-on-surface-variant">{objective.description}</p>{/if}
                        </div>
                        {#if canCoach && ongoing}
                          <div class="tu-segment" role="radiogroup" aria-label={objective.title}>
                            {#each OBJECTIVE_STATES as option (option.value)}
                              <button
                                type="button"
                                role="radio"
                                aria-checked={objective.state === option.value}
                                class={objective.state === option.value ? 'tu-segment--on' : ''}
                                onclick={() => setObjective(objective.id, option.value)}
                              >{option.label()}</button>
                            {/each}
                          </div>
                        {:else}
                          <span class="badge {objective.state === 'ACQUIRED' ? 'badge-success' : objective.state === 'KNOWN' ? 'badge-info' : 'badge-neutral'}">
                            {OBJECTIVE_STATES.find((option) => option.value === objective.state)?.label()}
                          </span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/each}
            {/if}
          </section>

          <!-- Missions : une liste de suivi dont les cartes vont au planning du tutoré -->
          <section class="section-card p-5 space-y-3">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="text-base font-semibold text-on-surface">{m.tu_missions_title()}</h2>
              {#if period.missions}
                <a class="text-2xs text-primary hover:underline" href={`/doing-lists/${period.missions.list.id}`}>{m.tu_missions_open({ key: period.missions.list.key })}</a>
              {/if}
            </div>
            {#if period.missions}
              {#if period.missions.items.length === 0}
                <p class="text-body-sm text-on-surface-variant">{m.tu_missions_empty()}</p>
              {:else}
                <ul class="space-y-1">
                  {#each period.missions.items as mission (mission.id)}
                    <li>
                      <a class="tu-row" href={`/doing-lists/${period.missions.list.id}?card=${mission.id}`}>
                        <Papicon icon={mission.done ? 'check-circle' : 'circle'} size={14} class={mission.done ? 'text-success' : 'text-on-surface-variant'} />
                        <span class="font-mono text-2xs font-semibold text-on-surface-variant">{mission.key}</span>
                        <span class="min-w-0 flex-1 truncate {mission.done ? 'line-through text-on-surface-variant' : 'text-on-surface'}">{mission.title}</span>
                        <span class="badge badge-neutral">{mission.column}</span>
                      </a>
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if canCoach && ongoing}
                <form class="flex gap-2" onsubmit={addMission}>
                  <input class="input flex-1 text-body-sm" maxlength="200" bind:value={newMission} placeholder={m.tu_mission_ph()} aria-label={m.tu_mission_ph()} />
                  <Button type="submit" size="sm" icon="plus" loading={addingMission} disabled={!newMission.trim()} disabledReason={m.common_reason_fill_field()}>{m.tu_mission_add()}</Button>
                </form>
                <p class="text-2xs text-on-surface-variant">{m.tu_missions_hint()}</p>
              {/if}
            {:else if canCoach}
              <p class="text-body-sm text-on-surface-variant">{m.tu_missions_none()}</p>
              <Button size="sm" icon="list-checks" onclick={createBoard}>{m.tu_missions_create()}</Button>
            {:else}
              <p class="text-body-sm text-on-surface-variant">{m.tu_missions_none_apprentice()}</p>
            {/if}
          </section>

          <!-- Carnet de bord : tenu par le tutoré, lu par le tuteur -->
          <section class="section-card p-5 space-y-3">
            <h2 class="text-base font-semibold text-on-surface">{m.tu_logbook_title()}</h2>
            <p class="text-2xs text-on-surface-variant">{role === 'apprentice' ? m.tu_logbook_hint_self() : m.tu_logbook_hint_other()}</p>
            {#if (role === 'apprentice' || isManager) && ongoing}
              <form class="space-y-2" onsubmit={addLog}>
                <textarea class="input h-20 w-full resize-y text-body-sm" maxlength="4000" bind:value={newLog} placeholder={m.tu_logbook_ph()} aria-label={m.tu_logbook_ph()}></textarea>
                <div class="flex justify-end">
                  <Button type="submit" size="sm" loading={addingLog} disabled={!newLog.trim()} disabledReason={m.common_reason_fill_field()}>{m.tu_logbook_add()}</Button>
                </div>
              </form>
            {/if}
            {#if period.logs.length === 0}
              <p class="text-body-sm text-on-surface-variant">{m.tu_logbook_empty()}</p>
            {:else}
              <ol class="space-y-2">
                {#each period.logs as log (log.id)}
                  <li class="tu-entry">
                    <p class="text-2xs text-on-surface-variant">{formatDay(log.date)}</p>
                    <p class="whitespace-pre-wrap wrap-break-word text-body-sm text-on-surface">{log.content}</p>
                  </li>
                {/each}
              </ol>
            {/if}
          </section>
        </div>

        <aside class="min-w-0 space-y-6">
          {#if ongoing && canCoach}
            <section class="section-card p-5 space-y-3">
              <h2 class="text-base font-semibold text-on-surface">{m.tu_decision_title()}</h2>
              <ul class="space-y-1.5">
                {#each period.readiness as check (check.key)}
                  <li class="flex items-start gap-2 text-body-sm">
                    <Papicon icon={check.ok ? 'check-circle' : check.blocking ? 'x-circle' : 'alert-circle'} size={16} class="mt-0.5 shrink-0 {check.ok ? 'text-success' : check.blocking ? 'text-error' : 'text-warning'}" />
                    <span class="text-on-surface">{READY_LABEL[check.key](check)}</span>
                  </li>
                {/each}
              </ul>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" icon="check" onclick={() => openDecision('PASSED')}>{m.tu_decision_pass()}</Button>
                <Button size="sm" variant="ghost" icon="x" onclick={() => openDecision('FAILED')}>{m.tu_decision_fail()}</Button>
              </div>
            </section>
          {:else if !ongoing}
            <section class="section-card p-5 space-y-2">
              <h2 class="text-base font-semibold text-on-surface">{m.tu_conclusion_title()}</h2>
              <span class="badge {STATUS_META[period.status].badge}">{STATUS_META[period.status].label()}</span>
              {#if period.notes}<p class="whitespace-pre-wrap text-body-sm text-on-surface">{period.notes}</p>{/if}
            </section>
          {/if}

          <section class="section-card p-5 space-y-3">
            <div class="flex items-baseline justify-between gap-2">
              <h2 class="text-base font-semibold text-on-surface">{m.tu_reports_title()}</h2>
              <span class="text-2xs text-on-surface-variant">{m.tu_reports_every({ days: period.config.reportIntervalDays })}</span>
            </div>
            {#if period.reports.length === 0}
              <p class="text-body-sm text-on-surface-variant">{m.tu_reports_empty()}</p>
            {:else}
              <ol class="space-y-2">
                {#each period.reports as report (report.id)}
                  <li class="tu-entry">
                    <div class="flex flex-wrap items-center gap-2 text-2xs text-on-surface-variant">
                      <span class="badge {REPORT_META[report.type].badge}">{REPORT_META[report.type].label()}</span>
                      <span>{memberName(report.author)} · {formatDay(report.createdAt)}</span>
                    </div>
                    <p class="mt-1 whitespace-pre-wrap wrap-break-word text-body-sm text-on-surface">{report.content}</p>
                  </li>
                {/each}
              </ol>
            {/if}
          </section>

          <section class="section-card p-5 space-y-2">
            <h2 class="text-base font-semibold text-on-surface">{m.tu_presence_title()}</h2>
            {#if period.vocalStats}
              <p class="text-body-sm text-on-surface">{m.tu_presence_voice({ hours: Math.round(period.vocalStats.voiceTimeSeconds / 3600), sessions: period.vocalStats.voiceSessionCount })}</p>
            {/if}
            {#if period.absences.length === 0}
              <p class="text-body-sm text-on-surface-variant">{m.tu_presence_no_absence()}</p>
            {:else}
              <ul class="space-y-1">
                {#each period.absences as absence (absence.id)}
                  <li class="text-body-sm text-on-surface">
                    {formatDay(absence.startDate)} → {absence.isIndefinite || !absence.endDate ? m.tu_presence_open_ended() : formatDay(absence.endDate)}
                    <span class="text-2xs text-on-surface-variant">· {absence.reason}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        </aside>
      </div>
    </div>
  {/if}
</ModulePage>

<Modal bind:open={reportOpen} title={m.tu_report_new()} size="md">
  <form id="tu-report" class="space-y-4" onsubmit={submitReport}>
    <fieldset class="space-y-2">
      <legend class="mb-1 text-body-sm font-medium text-on-surface">{m.tu_report_feeling()}</legend>
      <div class="tu-segment" role="radiogroup" aria-label={m.tu_report_feeling()}>
        {#each Object.entries(REPORT_META) as [type, meta] (type)}
          <button type="button" role="radio" aria-checked={reportType === type} class={reportType === type ? 'tu-segment--on' : ''} onclick={() => (reportType = type as TutoringReportType)}>
            {meta.label()}
          </button>
        {/each}
      </div>
    </fieldset>
    <Field label={m.tu_report_content()} required hint={m.tu_report_content_hint()}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input h-36 w-full resize-y" maxlength="4000" bind:value={reportContent}></textarea>
      {/snippet}
    </Field>
    {#if reportError}<Callout variant="danger">{reportError}</Callout>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (reportOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="tu-report" loading={reportSaving}>{m.tu_report_submit()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={decisionOpen} title={m.tu_decision_title()} size="md">
  <div class="space-y-4">
    <div class="tu-segment" role="radiogroup" aria-label={m.tu_decision_title()}>
      <button type="button" role="radio" aria-checked={decision === 'PASSED'} class={decision === 'PASSED' ? 'tu-segment--on' : ''} onclick={() => (decision = 'PASSED')}>{m.tu_decision_pass()}</button>
      <button type="button" role="radio" aria-checked={decision === 'FAILED'} class={decision === 'FAILED' ? 'tu-segment--on' : ''} onclick={() => (decision = 'FAILED')}>{m.tu_decision_fail()}</button>
    </div>
    <p class="text-body-sm text-on-surface-variant">{decision === 'PASSED' ? m.tu_decision_pass_desc() : m.tu_decision_fail_desc()}</p>
    <Field label={m.tu_decision_notes()} hint={m.tu_decision_notes_hint()}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input h-24 w-full resize-y" maxlength="4000" bind:value={decisionNotes}></textarea>
      {/snippet}
    </Field>
    {#if decisionError}<Callout variant="danger">{decisionError}</Callout>{/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (decisionOpen = false)}>{m.common_cancel()}</Button>
    {#if canForce}
      <Button variant="ghost" onclick={() => submitDecision(true)} loading={decisionSaving}>{m.tu_decision_force()}</Button>
    {/if}
    <Button variant="primary" onclick={() => submitDecision(false)} loading={decisionSaving}>{m.tu_decision_confirm()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={editOpen} title={m.tu_edit()} size="md">
  <form id="tu-edit" class="space-y-4" onsubmit={submitEdit}>
    <Field label={m.tu_field_mentor()}>
      {#snippet children(id, describedBy)}
        <select {id} aria-describedby={describedBy} class="input w-full" bind:value={editMentorId}>
          <option value="">{m.tu_no_mentor_option()}</option>
          {#each (candidates?.members ?? []).filter((member) => member.id !== period?.apprentice.id) as member (member.id)}
            <option value={member.id}>{memberName(member)}{member.isTutor ? ` · ${m.tu_tutor_tag()}` : ''}</option>
          {/each}
        </select>
      {/snippet}
    </Field>
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label={m.tu_field_hierarchy()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={editHierarchyId}>
            <option value="">{m.tu_any()}</option>
            {#each candidates?.hierarchies ?? [] as hierarchy (hierarchy.id)}<option value={hierarchy.id}>{hierarchy.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.tu_field_grade()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={editGrade}>
            <option value="">{m.tu_any()}</option>
            {#each (candidates?.grades ?? []).filter((grade) => !editHierarchyId || !grade.hierarchyId || grade.hierarchyId === editHierarchyId) as grade ((grade.hierarchyId ?? '') + grade.name)}
              <option value={grade.name}>{grade.name}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
    </div>
    <Field label={m.tu_field_duration()}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-32" type="number" min="1" max="365" bind:value={editDuration} />
      {/snippet}
    </Field>
    {#if editError}<Callout variant="danger">{editError}</Callout>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="tu-edit" loading={editSaving}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<style>
  .tu-bar {
    display: block;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    overflow: hidden;
  }
  .tu-bar span {
    display: block;
    height: 100%;
    background: var(--color-primary);
    transition: width 0.2s ease;
  }
  .tu-objective {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-surface-container-low);
  }
  .tu-segment {
    display: inline-flex;
    padding: 0.125rem;
    border-radius: 0.5rem;
    background: var(--color-surface-container-high);
  }
  .tu-segment button {
    padding: 0.25rem 0.625rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }
  .tu-segment button:hover {
    color: var(--color-on-surface);
  }
  .tu-segment button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .tu-segment .tu-segment--on {
    background: var(--color-surface-container-lowest);
    color: var(--color-on-surface);
    box-shadow: 0 1px 2px color-mix(in srgb, black 15%, transparent);
  }
  .tu-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
  }
  .tu-row:hover {
    background: var(--color-surface-container);
  }
  .tu-entry {
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-surface-container-low);
  }
</style>
