<!--
  Rapports planifiés : un récapitulatif hebdomadaire (7 derniers jours) ou
  mensuel (mois écoulé), envoyé à l'heure du serveur dans un salon et/ou en
  message privé. Chaque rapport choisit ses rubriques et peut être essayé
  tout de suite.
-->
<script lang="ts">
  import { Button, Callout, Modal, SectionCard, ToggleSwitch } from '../ui';
  import { removeWithUndo } from '../../undoRemoval';
  import FormSelect from '../FormSelect.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import RecipientsField, { loadRecipientOptions } from './RecipientsField.svelte';
  import {
    createReportSchedule,
    deleteReportSchedule,
    fetchReportSchedules,
    testReportSchedule,
    updateReportSchedule,
    type ReportSchedule,
    type ReportScheduleInput,
    type ReportSection,
  } from '../../api';
  import { authStore } from '../../stores/auth.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';

  let schedules = $state<ReportSchedule[]>([]);
  let loading = $state(true);
  let error = $state('');
  let channelNames = $state(new Map<string, string>());
  const canEdit = $derived(Boolean(dashboardStore.state.access?.canManageSettings));

  async function load() {
    try {
      schedules = (await fetchReportSchedules())?.schedules ?? [];
      error = '';
    } catch (e) {
      error = errorMessage(e) || m.an_error_generic();
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    authStore.selectedGuildId;
    void load();
    void loadRecipientOptions(authStore.selectedGuildId).then((o) => (channelNames = new Map(o.channels.map((c) => [c.id, c.name]))));
  });

  const SECTIONS: ReportSection[] = ['kotbo_work', 'overview', 'top_members', 'top_channels', 'anomalies', 'moderation', 'responses'];
  const sectionLabel = (s: ReportSection) =>
    ({ kotbo_work: m.anx_rep_s_kotbo_work(), overview: m.anx_rep_s_overview(), top_members: m.anx_top_members_messages(), top_channels: m.anx_top_channels_messages(), anomalies: m.anx_rep_s_anomalies(), moderation: m.anx_fact_sanctions(), responses: m.anx_tab_responses() })[s];
  const DAYS = $derived([m.anx_rep_day_0(), m.anx_rep_day_1(), m.anx_rep_day_2(), m.anx_rep_day_3(), m.anx_rep_day_4(), m.anx_rep_day_5(), m.anx_rep_day_6()]);

  function describe(s: ReportScheduleInput): string {
    const when = s.frequency === 'weekly'
      ? m.anx_rep_weekly_when({ day: DAYS[s.weekday] ?? '', hour: String(s.hour) })
      : m.anx_rep_monthly_when({ day: String(s.monthDay), hour: String(s.hour) });
    return when;
  }

  const date = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // ── Formulaire ─────────────────────────────────────────────────────────────
  type FormState = Omit<ReportScheduleInput, 'frequency' | 'weekday' | 'monthDay' | 'hour'> & { frequency: string; weekday: string; monthDay: string; hour: string };
  let open = $state(false);
  let editing = $state<string | null>(null);
  let saving = $state(false);
  let form = $state<FormState>(blank());

  function blank(): FormState {
    return { frequency: 'weekly', weekday: '1', monthDay: '1', hour: '9', channelId: null, userIds: [], sections: ['kotbo_work', 'overview', 'top_members', 'top_channels', 'anomalies'], enabled: true };
  }

  function openForm(s?: ReportSchedule) {
    editing = s?.id ?? null;
    form = s
      ? { frequency: s.frequency, weekday: String(s.weekday), monthDay: String(s.monthDay), hour: String(s.hour), channelId: s.channelId, userIds: [...s.userIds], sections: [...s.sections], enabled: s.enabled }
      : blank();
    open = true;
  }

  const toInput = (f: FormState): ReportScheduleInput => ({
    ...f,
    frequency: f.frequency === 'monthly' ? 'monthly' : 'weekly',
    weekday: Number(f.weekday),
    monthDay: Number(f.monthDay),
    hour: Number(f.hour),
  });

  function toggleSection(section: ReportSection) {
    form.sections = form.sections.includes(section) ? form.sections.filter((x) => x !== section) : [...form.sections, section];
  }

  const formError = $derived(!form.channelId && form.userIds.length === 0 ? m.anx_alert_err_recipients() : form.sections.length === 0 ? m.anx_rep_err_sections() : '');

  async function save() {
    if (formError) return;
    saving = true;
    try {
      if (editing) await updateReportSchedule(editing, toInput(form));
      else await createReportSchedule(toInput(form));
      open = false;
      toast.success(m.anx_rep_saved());
      await load();
    } catch (e) {
      toast.error(errorMessage(e) || m.an_error_generic());
    } finally {
      saving = false;
    }
  }

  async function toggle(s: ReportSchedule) {
    try {
      await updateReportSchedule(s.id, { ...s, enabled: !s.enabled });
      await load();
    } catch (e) {
      toast.error(errorMessage(e) || m.an_error_generic());
    }
  }

  async function test(s: ReportSchedule) {
    try {
      await testReportSchedule(s.id);
      toast.success(m.anx_rep_test_sent());
    } catch (e) {
      toast.error(errorMessage(e) || m.an_error_generic());
    }
  }

  async function remove(s: ReportSchedule) {
    await removeWithUndo({
      get: () => schedules,
      set: (next) => (schedules = next),
      match: (x) => x.id === s.id,
      message: m.anx_rep_deleted(),
      commit: () => deleteReportSchedule(s.id),
    });
  }
</script>

{#if loading}
  <AnalyticsSkeleton />
{:else if error}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else}
  <SectionCard title={m.anx_rep_title()} description={m.anx_rep_desc()}>
    {#snippet actions()}
      {#if canEdit}<Button size="sm" variant="primary" icon="plus" onclick={() => openForm()}>{m.anx_rep_new()}</Button>{/if}
    {/snippet}
    {#if schedules.length === 0}
      <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_rep_empty()}</p>
    {:else}
      <ul class="reports">
        {#each schedules as s (s.id)}
          <li class="report" class:report--off={!s.enabled}>
            <div class="min-w-0 flex-1">
              <p class="report__name">{s.frequency === 'monthly' ? m.anx_rep_monthly() : m.anx_rep_weekly()} · {describe(s)}</p>
              <p class="report__meta">
                {s.sections.map((x) => sectionLabel(x)).join(', ')}
              </p>
              <p class="report__meta">
                {#if s.channelId}{channelNames.get(s.channelId) ?? `#${s.channelId}`}{/if}
                {#if s.channelId && s.userIds.length > 0} · {/if}
                {#if s.userIds.length > 0}{m.anx_alert_dm_count({ count: String(s.userIds.length) })}{/if}
                · {m.anx_rep_next({ when: date(s.nextRunAt) })}
              </p>
            </div>
            {#if canEdit}
              <div class="report__actions">
                <Button size="sm" variant="ghost" onclick={() => test(s)}>{m.anx_rep_test()}</Button>
                <ToggleSwitch checked={s.enabled} onToggle={() => toggle(s)} ariaLabel={m.anx_alert_enabled()} size="sm" />
                <Button size="sm" variant="ghost" icon="pencil" aria-label={m.anx_alert_edit()} onclick={() => openForm(s)} />
                <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.anx_alert_delete()} onclick={() => remove(s)} />
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </SectionCard>
{/if}

<Modal bind:open title={editing ? m.anx_rep_edit() : m.anx_rep_new()} size="md" onClose={() => (open = false)}>
  <form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); void save(); }}>
    <div class="grid gap-3 sm:grid-cols-3">
      <label class="field">
        <span class="field__label">{m.anx_rep_f_frequency()}</span>
        <FormSelect bind:value={form.frequency} className="input w-full">
          <option value="weekly">{m.anx_rep_weekly()}</option>
          <option value="monthly">{m.anx_rep_monthly()}</option>
        </FormSelect>
      </label>
      {#if form.frequency === 'weekly'}
        <label class="field">
          <span class="field__label">{m.anx_rep_f_weekday()}</span>
          <FormSelect bind:value={form.weekday} className="input w-full">
            {#each [1, 2, 3, 4, 5, 6, 0] as d (d)}<option value={String(d)}>{DAYS[d]}</option>{/each}
          </FormSelect>
        </label>
      {:else}
        <label class="field">
          <span class="field__label">{m.anx_rep_f_monthday()}</span>
          <FormSelect bind:value={form.monthDay} className="input w-full">
            {#each Array.from({ length: 28 }, (_, i) => i + 1) as d (d)}<option value={String(d)}>{d}</option>{/each}
          </FormSelect>
        </label>
      {/if}
      <label class="field">
        <span class="field__label">{m.anx_rep_f_hour()}</span>
        <FormSelect bind:value={form.hour} className="input w-full">
          {#each Array.from({ length: 24 }, (_, i) => i) as h (h)}<option value={String(h)}>{h} h</option>{/each}
        </FormSelect>
      </label>
    </div>
    <fieldset class="field">
      <legend class="field__label">{m.anx_rep_f_sections()}</legend>
      <div class="filter-pills mt-1.5">
        {#each SECTIONS as section (section)}
          <button type="button" class="filter-pill" aria-pressed={form.sections.includes(section)} onclick={() => toggleSection(section)}>{sectionLabel(section)}</button>
        {/each}
      </div>
    </fieldset>
    <RecipientsField idPrefix="report" bind:channelId={form.channelId} bind:userIds={form.userIds} />
    <p class="text-body-sm text-on-surface-variant">{m.anx_rep_tz_note()}</p>
    {#if formError}<p class="text-body-sm text-error">{formError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (open = false)}>{m.anx_note_cancel()}</Button>
      <Button variant="primary" type="submit" loading={saving} disabled={Boolean(formError)} disabledReason={formError}>{m.anx_alert_save()}</Button>
    </div>
  </form>
</Modal>

<style>
  .reports {
    display: flex;
    flex-direction: column;
  }

  .report {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--color-outline-variant);
  }

  .report--off {
    opacity: 0.6;
  }

  .report__name {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .report__meta {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .report__actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .field__label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-on-surface);
  }
</style>
