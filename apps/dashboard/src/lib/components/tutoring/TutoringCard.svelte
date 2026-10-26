<!-- Un tutorat en un coup d'œil : qui, avec qui, où il en est, et le prochain point d'étape. -->
<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import type { TutoringSummary } from '../../api/tutoring';
  import { STATUS_META, formatDay, memberAvatar, memberName, nextReportText, progressPercent } from '../../tutoring';

  const { tutoring, showMentor = true }: { tutoring: TutoringSummary; showMentor?: boolean } = $props();

  const percent = $derived(progressPercent(tutoring));
  const next = $derived(nextReportText(tutoring));
</script>

<a class="tu-card section-card" href={`/tutoring/${tutoring.id}`}>
  <div class="flex items-center gap-3">
    <img class="h-10 w-10 shrink-0 rounded-full" src={memberAvatar(tutoring.apprentice)} alt="" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-body-sm font-semibold text-on-surface">{memberName(tutoring.apprentice)}</p>
      <p class="truncate text-2xs text-on-surface-variant">
        {tutoring.targetGrade ? m.tu_card_target({ grade: tutoring.targetGrade }) : m.tu_card_no_target()}
        {#if showMentor}· {tutoring.mentor ? m.tu_card_mentor({ name: memberName(tutoring.mentor) }) : m.tu_no_mentor()}{/if}
      </p>
    </div>
    {#if tutoring.status !== 'ONGOING'}
      <span class="badge {STATUS_META[tutoring.status].badge}">{STATUS_META[tutoring.status].label()}</span>
    {/if}
  </div>

  <div class="space-y-1">
    <div class="flex items-center justify-between text-2xs text-on-surface-variant">
      <span>{m.tu_card_objectives({ acquired: tutoring.progress.acquired, total: tutoring.progress.total })}</span>
      <span>
        {tutoring.status === 'ONGOING'
          ? m.tu_card_day({ day: tutoring.daysElapsed, planned: tutoring.plannedDurationDays })
          : tutoring.endDate ? m.tu_card_ended({ date: formatDay(tutoring.endDate) }) : ''}
      </span>
    </div>
    <div class="tu-bar" aria-hidden="true"><span style="width: {percent}%"></span></div>
  </div>

  {#if next}
    <p class="inline-flex items-center gap-1 text-2xs {tutoring.reportOverdue ? 'font-semibold text-error' : 'text-on-surface-variant'}">
      <Papicon icon="calendar" size={12} /> {next}
    </p>
  {/if}
</a>

<style>
  .tu-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    transition: border-color 0.15s ease;
  }
  .tu-card:hover,
  .tu-card:focus-visible {
    border-color: var(--color-primary);
  }
  .tu-card:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .tu-bar {
    display: block;
    height: 0.25rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    overflow: hidden;
  }
  .tu-bar span {
    display: block;
    height: 100%;
    background: var(--color-primary);
  }
</style>
