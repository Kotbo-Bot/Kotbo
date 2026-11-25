<!--
  Réglages de la cellule bien-être (propriétaire du serveur).

  Première configuration : un parcours en étapes (composition, direction,
  alertes, signalements, récapitulatif). Ensuite : le score de sécurité et le
  tableau « qui peut quoi » en tête, puis des sections repliables. Les
  modifications passent par la barre commune « modifications non enregistrées ».
-->
<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import { dashboardFetch } from '../../api';
  import { dateLocale, m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { useUnsavedChanges } from '../../useUnsavedChanges.svelte';
  import { channelDisplayName } from '../../channelUtils';
  import { WB_ALERT_EVENTS, wbAlertEventLabel } from '../../wellbeingLabels';
  import {
    WB_SETUP_STEPS,
    wbAccessMatrix,
    wbConfigFromApi,
    wbConfigToApi,
    wbFirstSetup,
    wbSecurityChecks,
    wbSecurityScore,
    wbStepComplete,
    type WbAccessLevel,
    type WbConfigForm,
    type WbSecurityCheckId,
    type WbSettingsSection,
    type WbSetupStep,
  } from '../../wellbeingSettings';
  import MultiSelect from '../MultiSelect.svelte';
  import WellbeingMemberList from '../WellbeingMemberList.svelte';
  import Papicon from '../Papicon.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { Button, Callout, SettingsRow, ToggleSwitch } from '../ui';

  const {
    accessReviewDue,
    onsaved,
    onreviewed,
  }: {
    accessReviewDue: boolean;
    /** Après un enregistrement : la page relit l'état de la cellule. */
    onsaved: () => Promise<void>;
    /** Après la confirmation de la revue des accès. */
    onreviewed: () => void;
  } = $props();

  /** Mêmes plafonds que le bot (MAX_ALERT_USERS, membres désignés). */
  const MAX_NAMED_MEMBERS = 25;
  const MAX_ALERT_USERS = 10;

  const clone = (form: WbConfigForm): WbConfigForm => JSON.parse(JSON.stringify(form));
  let form = $state<WbConfigForm>(wbConfigFromApi({}));
  let saved = $state<WbConfigForm>(wbConfigFromApi({}));
  let loaded = $state(false);
  let accessReviewedAt = $state<string | null>(null);
  let previews = $state<Record<string, string>>({});

  const roleOptions = $derived(((dashboardStore.state.discordRoles ?? []) as Array<{ id: string; name: string }>)
    .map((role) => ({ id: role.id, name: `@${role.name}` })));
  const alertChannels = $derived(((dashboardStore.state.discordChannels ?? []) as Array<{ id: string; name: string; type?: string }>)
    .filter((channel) => channel.type === undefined || channel.type === 'text' || channel.type === 'announcement'));

  const checks = $derived(wbSecurityChecks(form, { accessReviewDue }));
  const score = $derived(wbSecurityScore(checks));
  const matrix = $derived(wbAccessMatrix(form));

  async function load() {
    try {
      const [configRes, previewRes] = await Promise.all([
        dashboardFetch('/wellbeing/config'),
        dashboardFetch('/wellbeing/alert-preview'),
      ]);
      if (!configRes.ok) throw new Error('config');
      const { config } = await configRes.json();
      form = wbConfigFromApi(config);
      saved = clone(form);
      accessReviewedAt = config.accessReviewedAt ?? null;
      if (previewRes.ok) previews = (await previewRes.json()).previews ?? {};
      loaded = true;
    } catch {
      toast.error(m.toast_wb_management_only());
    }
  }

  onMount(() => { void load(); });

  async function save(): Promise<boolean> {
    try {
      const res = await dashboardFetch('/wellbeing/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wbConfigToApi(form)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      // Désactiver une cellule active est différé : on le dit plutôt que « enregistré ».
      const requestedOff = !form.enabled && saved.enabled;
      if (requestedOff && data.config?.dissolutionAt) {
        toast.success(m.toast_wb_dissolution_scheduled({ date: new Date(data.config.dissolutionAt).toLocaleString(dateLocale()) }));
      } else {
        toast.success(m.toast_wb_config_saved());
      }
      // Ce que le bot a retenu fait foi (une désactivation différée laisse la cellule active).
      form = wbConfigFromApi(data.config ?? wbConfigToApi(form));
      saved = clone(form);
      await onsaved();
      return true;
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_save_failed());
      return false;
    }
  }

  useUnsavedChanges({
    id: 'wellbeing-settings',
    label: m.wb_cfg_label(),
    getConfig: () => form,
    getSaved: () => saved,
    onSave: save,
    onReset: () => { form = clone(saved); },
  });

  let confirmingReview = $state(false);
  async function confirmReview() {
    if (confirmingReview) return;
    confirmingReview = true;
    try {
      const res = await dashboardFetch('/wellbeing/access-review', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      accessReviewedAt = data.accessReviewedAt;
      onreviewed();
      toast.success(m.toast_wb_review_confirmed());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_save_failed());
    } finally {
      confirmingReview = false;
    }
  }

  function toggleEvent(code: string, on: boolean) {
    form.alertEvents = on ? [...new Set([...form.alertEvents, code])] : form.alertEvents.filter((event) => event !== code);
  }

  // ── Parcours de première configuration ──
  let wizardDismissed = $state(false);
  const wizard = $derived(loaded && !wizardDismissed && wbFirstSetup(saved));
  let stepIndex = $state(0);
  const step = $derived<WbSetupStep>(WB_SETUP_STEPS[stepIndex] ?? 'summary');
  const STEP_LABELS: Record<WbSetupStep, () => string> = {
    team: () => m.wb_set_team(),
    direction: () => m.wb_set_access(),
    alerts: () => m.wb_alerts_title(),
    reports: () => m.wb_set_reports(),
    summary: () => m.wb_setup_summary(),
  };

  let activating = $state(false);
  async function activate() {
    if (activating) return;
    activating = true;
    form.enabled = true;
    if (!(await save())) form.enabled = false;
    activating = false;
  }

  // ── Sections repliables ──
  let open = $state<Record<WbSettingsSection | 'general', boolean>>({ review: false, general: false, team: false, direction: false, alerts: false, reports: false, care: false, signals: false, pulse: false });

  async function goTo(section: WbSettingsSection) {
    open = { ...open, [section]: true };
    await tick();
    document.getElementById(`wb-section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const CHECK_TEXT: Record<WbSecurityCheckId, { ok: () => string; ko: () => string }> = {
    named_members: { ok: () => m.wb_check_named_ok(), ko: () => m.wb_check_named_ko() },
    two_keys: { ok: () => m.wb_check_two_keys_ok(), ko: () => m.wb_check_two_keys_ko() },
    require_reason: { ok: () => m.wb_check_reason_ok(), ko: () => m.wb_check_reason_ko() },
    alerts: { ok: () => m.wb_check_alerts_ok(), ko: () => m.wb_check_alerts_ko() },
    backup: { ok: () => m.wb_check_backup_ok(), ko: () => m.wb_check_backup_ko() },
    review: { ok: () => m.wb_check_review_ok(), ko: () => m.wb_check_review_ko() },
    reports_noticed: { ok: () => m.wb_check_reports_ok(), ko: () => m.wb_check_reports_ko() },
    distress_noticed: { ok: () => m.wb_check_distress_ok(), ko: () => m.wb_check_distress_ko() },
  };
  const ROW_LABELS = { team: () => m.wb_who_team(), direction: () => m.wb_who_direction(), owner: () => m.wb_who_owner(), backup: () => m.wb_who_backup() };
  const LEVEL_LABELS: Record<WbAccessLevel, () => string> = {
    yes: () => m.wb_level_yes(),
    no: () => m.wb_level_no(),
    emergency: () => m.wb_level_emergency(),
    emergency_two_keys: () => m.wb_level_emergency_two_keys(),
  };
  const LEVEL_TONES: Record<WbAccessLevel, string> = {
    yes: 'text-on-success-container',
    no: 'text-on-surface-variant',
    emergency: 'text-on-warning-container',
    emergency_two_keys: 'text-on-warning-container',
  };
  const scoreTone = $derived(score >= 80 ? 'bg-success/10 text-on-success-container' : score >= 50 ? 'bg-warning/10 text-on-warning-container' : 'bg-error/10 text-on-error-container');
</script>

{#snippet teamFields()}
  <Callout variant="info">{m.wb_cfg_named_advice()}</Callout>
  <SettingsRow label={m.wb_cfg_team_members()} description={m.wb_cfg_named_hint()} labelFor="wb-team-users" stacked>
    <WellbeingMemberList id="wb-team-users" bind:ids={form.teamUserIds} max={MAX_NAMED_MEMBERS} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_team_roles()} description={m.wb_cfg_roles_hint()} labelFor="wb-team-roles" stacked>
    <MultiSelect id="wb-team-roles" bind:values={form.teamRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_backup()} description={m.wb_cfg_backup_hint()} labelFor="wb-backup-user" stacked>
    <WellbeingMemberList id="wb-backup-user"
      bind:ids={() => (form.backupUserId ? [form.backupUserId] : []), (next) => (form.backupUserId = next[0] ?? null)} max={1} />
  </SettingsRow>
{/snippet}

{#snippet directionFields()}
  <SettingsRow label={m.wb_cfg_director_members()} description={m.wb_cfg_named_hint()} labelFor="wb-director-users" stacked>
    <WellbeingMemberList id="wb-director-users" bind:ids={form.directorUserIds} max={MAX_NAMED_MEMBERS} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_director_roles()} description={m.wb_cfg_roles_hint()} labelFor="wb-director-roles" stacked>
    <MultiSelect id="wb-director-roles" bind:values={form.directorRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_require_reason()}>
    <ToggleSwitch checked={form.requireReason} onToggle={(v) => (form.requireReason = v)} ariaLabel={m.wb_cfg_require_reason()} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_break_glass_approval()} description={m.wb_bg_approval_hint()}>
    <ToggleSwitch checked={form.breakGlassApproval} onToggle={(v) => (form.breakGlassApproval = v)} ariaLabel={m.wb_cfg_break_glass_approval()} />
  </SettingsRow>
{/snippet}

{#snippet alertFields()}
  <p class="text-xs text-on-surface-variant px-1">{m.wb_alerts_desc()}</p>
  <SettingsRow label={m.wb_alerts_channel()} labelFor="wb-alert-channel" stacked>
    <select id="wb-alert-channel" bind:value={form.alertChannelId} class="input w-full">
      <option value="">{m.wb_alerts_channel_none()}</option>
      {#each alertChannels as channel (channel.id)}
        <option value={channel.id}>{channelDisplayName(channel)}</option>
      {/each}
    </select>
  </SettingsRow>
  <SettingsRow label={m.wb_alerts_users({ max: MAX_ALERT_USERS })} labelFor="wb-alert-users" stacked>
    <WellbeingMemberList id="wb-alert-users" bind:ids={form.alertUserIds} max={MAX_ALERT_USERS} />
  </SettingsRow>
  <ul class="divide-y divide-outline-variant/30">
    {#each WB_ALERT_EVENTS as code (code)}
      <li class="py-2 space-y-1.5">
        <div class="flex items-center justify-between gap-3">
          <span class="text-sm text-on-surface">{wbAlertEventLabel(code)}</span>
          <ToggleSwitch size="sm" checked={form.alertEvents.includes(code)} onToggle={(v) => toggleEvent(code, v)} ariaLabel={wbAlertEventLabel(code)} />
        </div>
        {#if previews[code]}
          <p class="text-2xs text-on-surface-variant bg-surface-container-high/30 rounded-md px-2 py-1.5 {form.alertEvents.includes(code) ? '' : 'opacity-60'}">
            <span class="font-semibold">{m.wb_alert_preview()}</span> {previews[code]}
          </p>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet reportFields()}
  <SettingsRow label={m.wb_cfg_report_enabled()} description={m.wb_cfg_report_hint()}>
    <ToggleSwitch checked={form.reportEnabled} onToggle={(v) => (form.reportEnabled = v)} ariaLabel={m.wb_cfg_report_enabled()} />
  </SettingsRow>
  {#if form.reportEnabled && (!form.alertEvents.includes('REPORT') || (!form.alertChannelId && form.alertUserIds.length === 0))}
    <Callout variant="warning">{m.wb_cfg_report_unnoticed()}</Callout>
  {/if}
  <SettingsRow label={m.wb_cfg_stale_days()} description={m.wb_cfg_stale_hint()} labelFor="wb-stale-days">
    <input id="wb-stale-days" type="number" min="0" max="90" step="1" bind:value={form.staleCriticalDays} class="input w-24" />
  </SettingsRow>
{/snippet}

{#snippet careFields()}
  <SettingsRow label={m.wb_cfg_crisis()} description={m.wb_cfg_crisis_hint()}>
    <ToggleSwitch checked={form.crisisProtocol} onToggle={(v) => (form.crisisProtocol = v)} ariaLabel={m.wb_cfg_crisis()} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_follow_up()} description={m.wb_cfg_follow_up_hint()} labelFor="wb-follow-up-days">
    <input id="wb-follow-up-days" type="number" min="0" max="180" step="1" bind:value={form.followUpDays} class="input w-24" />
  </SettingsRow>
{/snippet}

{#snippet signalFields()}
  <Callout variant="warning">{m.wb_cfg_signals_privacy()}</Callout>
  <SettingsRow label={m.wb_cfg_sanction_signal()} description={m.wb_cfg_sanction_signal_hint()}>
    <ToggleSwitch checked={form.sanctionSignal} onToggle={(v) => (form.sanctionSignal = v)} ariaLabel={m.wb_cfg_sanction_signal()} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_distress()} description={m.wb_cfg_distress_hint()}>
    <ToggleSwitch checked={form.distressWatch} onToggle={(v) => (form.distressWatch = v)} ariaLabel={m.wb_cfg_distress()} />
  </SettingsRow>
  {#if form.distressWatch && (!form.alertEvents.includes('DISTRESS') || (!form.alertChannelId && form.alertUserIds.length === 0))}
    <Callout variant="warning">{m.wb_cfg_distress_unnoticed()}</Callout>
  {/if}
{/snippet}

{#snippet pulseFields()}
  <p class="text-xs text-on-surface-variant px-1">{m.wb_cfg_pulse_desc()}</p>
  <SettingsRow label={m.wb_cfg_pulse()}>
    <ToggleSwitch checked={form.pulseEnabled} onToggle={(v) => (form.pulseEnabled = v)} ariaLabel={m.wb_cfg_pulse()} />
  </SettingsRow>
  <SettingsRow label={m.wb_cfg_pulse_roles()} description={m.wb_cfg_pulse_roles_hint()} labelFor="wb-pulse-roles" stacked>
    <MultiSelect id="wb-pulse-roles" bind:values={form.pulseRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
  </SettingsRow>
{/snippet}

{#snippet whoCanDoWhat()}
  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-5 space-y-3">
    <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="Users" size={16} /> {m.wb_who_title()}</h3>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-on-surface-variant">
            <th scope="col" class="py-1.5 pr-3 font-medium">{m.wb_who_col_who()}</th>
            <th scope="col" class="py-1.5 pr-3 font-medium">{m.wb_who_col_read()}</th>
            <th scope="col" class="py-1.5 pr-3 font-medium">{m.wb_who_col_write()}</th>
            <th scope="col" class="py-1.5 pr-3 font-medium">{m.wb_who_col_configure()}</th>
            <th scope="col" class="py-1.5 font-medium">{m.wb_who_col_reminders()}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          {#each matrix as row (row.id)}
            <tr>
              <th scope="row" class="py-2 pr-3 text-left font-medium text-on-surface">
                {ROW_LABELS[row.id]()}
                {#if row.id === 'team' || row.id === 'direction'}
                  <span class="block text-2xs font-normal text-on-surface-variant">{m.wb_who_count({ members: row.members, roles: row.roles })}</span>
                {/if}
              </th>
              {#each [row.read, row.write, row.configure, row.reminders] as level, index (index)}
                <td class="py-2 pr-3 text-xs {LEVEL_TONES[level]}">{LEVEL_LABELS[level]()}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-2xs text-on-surface-variant">{m.wb_who_admins()}</p>
  </section>
{/snippet}

{#snippet section(id: WbSettingsSection | 'general', title: string, icon: string, body: Snippet, badge: string = '')}
  <details id="wb-section-{id}" class="group bg-surface-container-low/40 border border-outline-variant/30 rounded-xl scroll-mt-4"
    open={open[id]} ontoggle={(event) => (open = { ...open, [id]: (event.currentTarget as HTMLDetailsElement).open })}>
    <summary class="flex items-center justify-between gap-3 px-5 py-4 cursor-pointer list-none">
      <span class="text-base font-semibold flex items-center gap-2"><Papicon {icon} size={16} /> {title}</span>
      <span class="flex items-center gap-2">
        {#if badge}<span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-warning/10 text-on-warning-container">{badge}</span>{/if}
        <span class="transition-transform group-open:rotate-90"><Papicon icon="ChevronRight" size={14} /></span>
      </span>
    </summary>
    <div class="px-5 pb-5 space-y-2">{@render body()}</div>
  </details>
{/snippet}

{#snippet reviewBody()}
  <SettingsRow label={accessReviewedAt ? m.wb_review_last({ date: new Date(accessReviewedAt).toLocaleDateString(dateLocale()) }) : m.wb_review_never()}
    description={accessReviewDue ? m.wb_review_due_desc() : m.wb_review_hint_ok()}>
    <Button variant={accessReviewDue ? 'primary' : 'secondary'} icon="Check" loading={confirmingReview} onclick={() => void confirmReview()}>{m.wb_review_confirm()}</Button>
  </SettingsRow>
  <p class="text-xs text-on-surface-variant">{m.wb_review_desc()}</p>
{/snippet}

{#snippet generalBody()}
  <SettingsRow label={m.wb_cfg_enabled()} description={form.enabled ? m.wb_cfg_enabled_on_hint() : m.wb_desc()}>
    <ToggleSwitch checked={form.enabled} onToggle={(v) => (form.enabled = v)} ariaLabel={m.wb_cfg_enabled()} />
  </SettingsRow>
  {#if saved.enabled && !form.enabled}
    <Callout variant="warning">{m.wb_cfg_disable_deferred()}</Callout>
  {/if}
{/snippet}

{#if !loaded}
  <Skeleton height="320px" />
{:else if wizard}
  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-5 max-w-3xl">
    <div class="space-y-1">
      <h2 class="text-lg font-semibold text-on-surface">{m.wb_setup_title()}</h2>
      <p class="text-sm text-on-surface-variant">{m.wb_setup_desc()}</p>
    </div>
    <ol class="flex flex-wrap gap-2" aria-label={m.wb_setup_steps_label()}>
      {#each WB_SETUP_STEPS as key, index (key)}
        <li>
          <button type="button" aria-current={index === stepIndex ? 'step' : undefined} onclick={() => (stepIndex = index)}
            class="text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors {index === stepIndex ? 'bg-primary/10 text-primary border-primary/30' : 'border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
            {#if key !== 'summary' && wbStepComplete(form, key)}<Papicon icon="Check" size={11} class="inline -mt-0.5 mr-1" />{/if}{index + 1}. {STEP_LABELS[key]()}
          </button>
        </li>
      {/each}
    </ol>

    <div class="space-y-2">
      {#if step === 'team'}
        {@render teamFields()}
      {:else if step === 'direction'}
        <p class="text-sm text-on-surface-variant">{m.wb_bg_modal_desc()}</p>
        {@render directionFields()}
      {:else if step === 'alerts'}
        {@render alertFields()}
      {:else if step === 'reports'}
        {@render reportFields()}
      {:else}
        {@render whoCanDoWhat()}
        <ul class="space-y-1.5">
          {#each checks as check (check.id)}
            <li class="flex items-center gap-2 text-sm {check.ok ? 'text-on-surface' : 'text-on-warning-container'}">
              <Papicon icon={check.ok ? 'Check' : 'AlertTriangle'} size={14} /> {check.ok ? CHECK_TEXT[check.id].ok() : CHECK_TEXT[check.id].ko()}
            </li>
          {/each}
        </ul>
        {#if !wbStepComplete(form, 'team')}
          <Callout variant="warning">{m.wb_setup_team_missing()}</Callout>
        {/if}
      {/if}
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant/30 pt-4">
      <Button variant="ghost" onclick={() => (wizardDismissed = true)}>{m.wb_setup_skip()}</Button>
      <div class="flex gap-2">
        {#if stepIndex > 0}
          <Button variant="secondary" icon="ArrowLeft" onclick={() => (stepIndex -= 1)}>{m.wb_setup_previous()}</Button>
        {/if}
        {#if step !== 'summary'}
          <Button variant="primary" icon="ArrowRight" onclick={() => (stepIndex += 1)}>{m.wb_setup_next()}</Button>
        {:else}
          <Button variant="primary" icon="Check" loading={activating} disabled={!wbStepComplete(form, 'team')} onclick={() => void activate()}>{m.wb_setup_activate()}</Button>
        {/if}
      </div>
    </div>
  </section>
{:else}
  <div class="space-y-6">
    <div class="grid grid-cols-1 xl:grid-cols-[1fr_1.4fr] gap-6 items-start">
      <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-5 space-y-3">
        <div class="flex items-center gap-3">
          <div class="h-14 w-14 rounded-xl flex items-center justify-center text-lg font-bold {scoreTone}">{score}</div>
          <div>
            <h3 class="text-base font-semibold text-on-surface">{m.wb_score_title()}</h3>
            <p class="text-xs text-on-surface-variant">{m.wb_score_desc({ ok: checks.filter((check) => check.ok).length, total: checks.length })}</p>
          </div>
        </div>
        <ul class="space-y-1.5">
          {#each checks as check (check.id)}
            <li class="flex items-center justify-between gap-2 text-sm">
              <span class="flex items-center gap-2 {check.ok ? 'text-on-surface' : 'text-on-warning-container'}">
                <Papicon icon={check.ok ? 'Check' : 'AlertTriangle'} size={14} /> {check.ok ? CHECK_TEXT[check.id].ok() : CHECK_TEXT[check.id].ko()}
              </span>
              {#if !check.ok}
                <Button size="sm" variant="ghost" onclick={() => void goTo(check.section)}>{m.wb_score_fix()}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
      {@render whoCanDoWhat()}
    </div>

    {@render section('review', m.wb_review_title(), 'ShieldCheck', reviewBody, accessReviewDue ? m.wb_badge_todo() : '')}
    {@render section('general', m.wb_set_general(), 'Gears', generalBody)}
    {@render section('team', m.wb_set_team(), 'Users', teamFields, wbStepComplete(form, 'team') ? '' : m.wb_badge_todo())}
    {@render section('direction', m.wb_set_access(), 'lock', directionFields)}
    {@render section('alerts', m.wb_alerts_title(), 'Bell', alertFields, wbStepComplete(form, 'alerts') ? '' : m.wb_badge_todo())}
    {@render section('reports', m.wb_set_reports(), 'MessageSquare', reportFields)}
    {@render section('care', m.wb_set_care(), 'heart', careFields)}
    {@render section('signals', m.wb_set_signals(), 'AlertTriangle', signalFields)}
    {@render section('pulse', m.wb_set_pulse(), 'Sun', pulseFields, wbStepComplete(form, 'pulse') ? '' : m.wb_badge_todo())}

    <p class="text-xs text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Info" size={12} /> {m.wb_settings_save_hint()}</p>
  </div>
{/if}
