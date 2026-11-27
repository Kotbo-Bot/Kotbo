<!--
  Création d'un dossier de suivi : depuis le bouton de la page, une fiche ou
  un signal de détresse. Le référent le moins chargé est proposé par le bot ;
  la page reçoit le dossier créé et l'ouvre.
-->
<script lang="ts" module>
  export type NewCasePrefill = { subjectUserId?: string; subjectName?: string; severity?: string; signalId?: string };
</script>

<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import MemberSearchSelect from '../MemberSearchSelect.svelte';
  import { Button, Callout, Field, Modal } from '../ui';
  import { WB_CATEGORIES, WB_SEVERITIES, wbCategoryLabel, wbIsSummaryTemplate, wbSeverityLabel, wbSummaryTemplate } from '../../wellbeingLabels';
  import { WB_REVIEW_SHORTCUTS, wbReviewShortcut, wbSeverityTone } from '../../wellbeingView';

  let {
    open = $bindable(false),
    viewerId,
    teamFor,
    oncreated,
  }: {
    open?: boolean;
    viewerId: string | undefined;
    /** Membres de la cellule proposables comme référent, sans la personne concernée. */
    teamFor: (subjectUserId: string) => Array<{ id: string; name: string }>;
    /** Dossier créé ; `fromSignal` : il venait d'un signal de détresse, à relire. */
    oncreated: (item: any, fromSignal: boolean) => void;
  } = $props();

  // Membre choisi : lie le dossier à sa fiche. Le nom reste modifiable, ou libre hors serveur.
  let subjectUserId = $state('');
  let subjectName = $state('');
  let title = $state('');
  let category = $state('SOUTIEN');
  let severity = $state('NORMAL');
  let summary = $state('');
  let assigneeId = $state('');
  let reviewAt = $state('');
  let creating = $state(false);
  /** Signal de détresse d'où vient le dossier : il sera marqué traité. */
  let signalId = $state('');
  /** Référent proposé par le bot : le membre de la cellule le moins chargé. */
  let suggestedAssigneeId = $state('');

  /** Ouvre la fenêtre, avec le référent le moins chargé proposé. */
  export async function openWith(prefill: NewCasePrefill = {}) {
    // Un brouillon venu d'un signal puis abandonné ne doit pas servir à un autre dossier.
    if (signalId && !prefill.signalId) {
      subjectUserId = '';
      subjectName = '';
      severity = 'NORMAL';
    }
    signalId = prefill.signalId ?? '';
    if (prefill.subjectUserId !== undefined) subjectUserId = prefill.subjectUserId;
    if (prefill.subjectName !== undefined) subjectName = prefill.subjectName;
    if (prefill.severity) severity = prefill.severity;
    if (wbIsSummaryTemplate(summary)) summary = wbSummaryTemplate(category);
    open = true;
    const query = subjectUserId ? `?subjectUserId=${encodeURIComponent(subjectUserId)}` : '';
    const res = await dashboardFetch(`/wellbeing/assignee-suggestion${query}`).catch(() => null);
    const suggested = res?.ok ? (await res.json()).userId : null;
    suggestedAssigneeId = typeof suggested === 'string' ? suggested : '';
    if (suggestedAssigneeId && !assigneeId) assigneeId = suggestedAssigneeId;
  }

  // Le référent proposé ne peut pas être la personne concernée, choisie après coup.
  $effect(() => {
    if (assigneeId && assigneeId === suggestedAssigneeId && assigneeId === subjectUserId) assigneeId = '';
  });

  /**
   * Un dossier sur soi-même serait aussitôt masqué à son auteur (conflit
   * d'intérêts) : le bot le refuse, le formulaire le dit avant l'envoi.
   */
  const subjectIsSelf = $derived(!!subjectUserId && subjectUserId === viewerId);

  /** La trame proposée n'est pas un résumé : elle doit être remplie avant la création. */
  let summaryError = $state('');

  /** Change la catégorie ; sa trame remplace un résumé encore vide ou resté tel quel. */
  function pickCategory(code: string) {
    category = code;
    if (wbIsSummaryTemplate(summary)) summary = wbSummaryTemplate(code);
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (creating || subjectIsSelf) return;
    if (wbIsSummaryTemplate(summary)) {
      summaryError = m.wb_summary_template_error();
      return;
    }
    creating = true;
    try {
      const res = await dashboardFetch('/wellbeing/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectUserId: subjectUserId || undefined,
          subjectName: subjectName.trim(),
          title: title.trim(),
          category,
          severity,
          summary: summary.trim(),
          assigneeId: assigneeId || undefined,
          reviewAt: reviewAt || undefined,
          signalId: signalId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '');
      const fromSignal = !!signalId;
      open = false;
      subjectUserId = '';
      subjectName = '';
      title = '';
      summary = '';
      assigneeId = '';
      reviewAt = '';
      signalId = '';
      oncreated(data.item, fromSignal);
      toast.success(m.toast_wb_file_created());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_create_failed());
    } finally {
      creating = false;
    }
  }
</script>

<Modal bind:open title={m.wb_new_modal_title()} size="md">
  <form id="wb-case-form" onsubmit={create} class="space-y-4">
    {#if signalId}
      <Callout variant="info">{m.wb_new_from_signal()}</Callout>
    {/if}
    <Field label={m.wb_member()} hint={m.wb_member_hint()} error={subjectIsSelf ? m.wb_subject_self_error() : ''}>
      {#snippet children(id, describedBy)}
        <MemberSearchSelect {id} {describedBy} bind:value={subjectUserId} placeholder={m.wb_member_ph()}
          onselect={(member) => (subjectName = member.displayName || member.username)} />
      {/snippet}
    </Field>
    <Field label={m.wb_subject()} hint={m.wb_subject_hint()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} bind:value={subjectName} required class="input w-full" placeholder={m.wb_subject_ph()} />
      {/snippet}
    </Field>
    <Field label={m.wb_case_title()} required>
      {#snippet children(id)}
        <input {id} bind:value={title} required class="input w-full" placeholder={m.wb_case_title_ph()} />
      {/snippet}
    </Field>
    <div class="space-y-1.5">
      <p class="text-xs font-semibold text-on-surface-variant">{m.wb_category()}</p>
      <div role="group" aria-label={m.wb_category()} class="flex flex-wrap gap-1.5">
        {#each WB_CATEGORIES as code (code)}
          <button type="button" aria-pressed={category === code} onclick={() => pickCategory(code)}
            class="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors {category === code ? 'bg-primary/10 text-primary border border-primary/30' : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
            {wbCategoryLabel(code)}
          </button>
        {/each}
      </div>
    </div>
    <div class="space-y-1.5">
      <p class="text-xs font-semibold text-on-surface-variant">{m.wb_severity_label()}</p>
      <div role="group" aria-label={m.wb_severity_label()} class="flex flex-wrap gap-1.5">
        {#each WB_SEVERITIES as code (code)}
          <button type="button" aria-pressed={severity === code} onclick={() => (severity = code)}
            class="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors {severity === code ? wbSeverityTone(code) : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
            {wbSeverityLabel(code)}
          </button>
        {/each}
      </div>
    </div>
    <Field label={m.wb_summary()} required error={summaryError}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} bind:value={summary} required rows={6} class="input w-full" placeholder={m.wb_summary_ph()}
          oninput={() => (summaryError = '')}></textarea>
      {/snippet}
    </Field>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label={m.wb_assignee()} hint={suggestedAssigneeId && assigneeId === suggestedAssigneeId ? m.wb_assignee_suggested() : m.wb_assignee_hint()}>
        {#snippet children(id, describedBy)}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={assigneeId}>
            <option value="">{m.wb_member_pick()}</option>
            {#each teamFor(subjectUserId) as member (member.id)}
              <option value={member.id}>{member.name}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.wb_review_at()} hint={m.wb_review_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} type="date" bind:value={reviewAt} class="input w-full" />
          <div role="group" aria-label={m.wb_review_shortcuts()} class="flex flex-wrap gap-1.5 mt-1.5">
            {#each WB_REVIEW_SHORTCUTS as days (days)}
              <Button size="sm" variant="ghost" onclick={() => (reviewAt = wbReviewShortcut(new Date(), days))}>{m.wb_review_in_days({ days })}</Button>
            {/each}
          </div>
        {/snippet}
      </Field>
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="wb-case-form" loading={creating}>{m.wb_create()}</Button>
  {/snippet}
</Modal>
