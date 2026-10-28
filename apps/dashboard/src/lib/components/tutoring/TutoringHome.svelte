<!--
  Accueil du tutorat. Pas d'onglets : la page montre ce qui concerne la
  personne, dans cet ordre — son propre tutorat, ses tutorés, puis tous les
  tutorats si elle en est responsable.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../ModulePage.svelte';
  import Skeleton from '../Skeleton.svelte';
  import TutoringCard from './TutoringCard.svelte';
  import { Button, Callout, EmptyState, Field, FilterPills, Modal, type FilterOption } from '../ui';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { memberName } from '../../tutoring';
  import {
    createTutoring,
    fetchTutoringCandidates,
    fetchTutoringOverview,
    type TutoringCandidates,
    type TutoringOverview,
  } from '../../api/tutoring';

  let loading = $state(true);
  let overview = $state<TutoringOverview | null>(null);
  let filter = $state<'ongoing' | 'ended'>('ongoing');
  let search = $state('');

  const filterOptions: FilterOption<'ongoing' | 'ended'>[] = [
    { value: 'ongoing', label: m.tu_filter_ongoing() },
    { value: 'ended', label: m.tu_filter_ended() },
  ];

  const shownAll = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return (overview?.all ?? []).filter((tutoring) => {
      if ((filter === 'ongoing') !== (tutoring.status === 'ONGOING')) return false;
      if (!query) return true;
      return [memberName(tutoring.apprentice), memberName(tutoring.mentor), tutoring.targetGrade ?? ''].some((text) => text.toLowerCase().includes(query));
    });
  });
  const overdueCount = $derived((overview?.all ?? []).filter((tutoring) => tutoring.reportOverdue).length);
  const nothing = $derived(!!overview && !overview.mine && overview.mentoring.length === 0 && !overview.canManage);

  async function load() {
    try {
      overview = await fetchTutoringOverview();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.tu_load_error());
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // ── Nouveau tutorat ─────────────────────────────────────────
  let createOpen = $state(false);
  let candidates = $state<TutoringCandidates | null>(null);
  let apprenticeId = $state('');
  let mentorId = $state('');
  let hierarchyId = $state('');
  let targetGrade = $state('');
  let duration = $state(14);
  let withMissions = $state(true);
  let creating = $state(false);
  let createError = $state('');

  const freeMembers = $derived((candidates?.members ?? []).filter((member) => !member.inTutoring));
  const tutors = $derived((candidates?.members ?? []).filter((member) => member.isTutor && member.id !== apprenticeId));
  const otherMentors = $derived((candidates?.members ?? []).filter((member) => !member.isTutor && member.id !== apprenticeId));
  const grades = $derived((candidates?.grades ?? []).filter((grade) => !hierarchyId || !grade.hierarchyId || grade.hierarchyId === hierarchyId));

  async function openCreate() {
    apprenticeId = '';
    mentorId = '';
    hierarchyId = '';
    targetGrade = '';
    duration = overview?.config.minTestDays ?? 14;
    withMissions = true;
    createError = '';
    createOpen = true;
    if (!candidates) {
      try {
        candidates = await fetchTutoringCandidates();
      } catch (err) {
        createError = err instanceof Error ? err.message : m.tu_load_error();
      }
    }
  }

  async function submitCreate(event: SubmitEvent) {
    event.preventDefault();
    if (!apprenticeId) {
      createError = m.tu_create_pick_apprentice();
      return;
    }
    creating = true;
    createError = '';
    try {
      const { period } = await createTutoring({
        staffMemberId: apprenticeId,
        mentorId: mentorId || null,
        plannedDurationDays: Math.max(1, Math.floor(Number(duration) || 14)),
        targetGrade: targetGrade || null,
        hierarchyId: hierarchyId || null,
        withMissions,
      });
      createOpen = false;
      candidates = null;
      router.goto(`/tutoring/${period.id}`);
    } catch (err) {
      createError = err instanceof Error ? err.message : m.tu_save_error();
    } finally {
      creating = false;
    }
  }
</script>

<ModulePage title={m.tu_page_title()} description={m.tu_page_desc()} icon="book-open" featureKey="tutoring">
  {#snippet actions()}
    {#if overview?.canManage}
      <Button variant="ghost" icon="list-checks" onclick={() => router.goto('/tutoring/programs')}>{m.tu_programs()}</Button>
      <Button variant="primary" icon="plus" onclick={openCreate}>{m.tu_new()}</Button>
    {/if}
  {/snippet}

  {#if loading}
    <Skeleton height="240px" radius="1rem" />
  {:else if overview}
    <div class="space-y-8">
      {#if overview.mine}
        <section class="space-y-3">
          <h2 class="text-base font-semibold text-on-surface">{m.tu_mine_title()}</h2>
          <div class="max-w-xl"><TutoringCard tutoring={overview.mine} /></div>
        </section>
      {/if}

      {#if overview.mentoring.length > 0}
        <section class="space-y-3">
          <h2 class="text-base font-semibold text-on-surface">{m.tu_mentoring_title({ count: overview.mentoring.length })}</h2>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {#each overview.mentoring as tutoring (tutoring.id)}
              <TutoringCard {tutoring} showMentor={false} />
            {/each}
          </div>
        </section>
      {/if}

      {#if overview.canManage}
        <section class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-on-surface">
              {m.tu_all_title()}
              {#if overdueCount > 0}<span class="ml-2 badge badge-danger">{m.tu_overdue_count({ count: overdueCount })}</span>{/if}
            </h2>
            <div class="flex flex-wrap items-center gap-3">
              <FilterPills label={m.tu_all_title()} options={filterOptions} value={filter} onchange={(value) => (filter = value)} />
              <input class="input w-48 text-body-sm" type="search" bind:value={search} placeholder={m.tu_search_ph()} aria-label={m.tu_search_ph()} />
            </div>
          </div>
          {#if overview.all.length === 0}
            <div class="section-card">
              <EmptyState icon="book-open" title={m.tu_empty_title()} description={m.tu_empty_desc()} actionLabel={m.tu_new()} onAction={openCreate} />
            </div>
          {:else if shownAll.length === 0}
            <p class="text-body-sm text-on-surface-variant">{m.tu_no_match()}</p>
          {:else}
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {#each shownAll as tutoring (tutoring.id)}
                <TutoringCard {tutoring} />
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      {#if nothing}
        <div class="section-card">
          <EmptyState icon="book-open" title={m.tu_none_title()} description={m.tu_none_desc()} reason="read-only" />
        </div>
      {/if}
    </div>
  {/if}
</ModulePage>

<Modal bind:open={createOpen} title={m.tu_new()} size="md">
  <form id="tu-create" class="space-y-4" onsubmit={submitCreate}>
    <Field label={m.tu_field_apprentice()} required hint={m.tu_field_apprentice_hint()}>
      {#snippet children(id, describedBy)}
        <select {id} aria-describedby={describedBy} class="input w-full" bind:value={apprenticeId}>
          <option value="">{m.tu_pick()}</option>
          {#each freeMembers as member (member.id)}
            <option value={member.id}>{memberName(member)} · {member.grade}</option>
          {/each}
        </select>
      {/snippet}
    </Field>
    <Field label={m.tu_field_mentor()} hint={m.tu_field_mentor_hint()}>
      {#snippet children(id, describedBy)}
        <select {id} aria-describedby={describedBy} class="input w-full" bind:value={mentorId}>
          <option value="">{m.tu_no_mentor_option()}</option>
          {#if tutors.length > 0}
            <optgroup label={m.tu_tutors_group()}>
              {#each tutors as member (member.id)}<option value={member.id}>{memberName(member)}</option>{/each}
            </optgroup>
          {/if}
          <optgroup label={m.tu_others_group()}>
            {#each otherMentors as member (member.id)}<option value={member.id}>{memberName(member)}</option>{/each}
          </optgroup>
        </select>
      {/snippet}
    </Field>
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label={m.tu_field_hierarchy()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={hierarchyId}>
            <option value="">{m.tu_any()}</option>
            {#each candidates?.hierarchies ?? [] as hierarchy (hierarchy.id)}<option value={hierarchy.id}>{hierarchy.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.tu_field_grade()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={targetGrade}>
            <option value="">{m.tu_any()}</option>
            {#each grades as grade ((grade.hierarchyId ?? '') + grade.name)}<option value={grade.name}>{grade.name}</option>{/each}
          </select>
        {/snippet}
      </Field>
    </div>
    <Field label={m.tu_field_duration()} hint={m.tu_field_duration_hint({ days: overview?.config.minTestDays ?? 14 })}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input w-32" type="number" min="1" max="365" bind:value={duration} />
      {/snippet}
    </Field>
    <label class="flex items-start gap-2 text-body-sm text-on-surface">
      <input type="checkbox" class="mt-0.5" bind:checked={withMissions} />
      <span>
        {m.tu_field_missions()}
        <span class="block text-2xs text-on-surface-variant">{m.tu_field_missions_hint()}</span>
      </span>
    </label>
    {#if createError}
      <Callout variant="danger">{createError}</Callout>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (createOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="tu-create" loading={creating}>{m.tu_create_submit()}</Button>
  {/snippet}
</Modal>
