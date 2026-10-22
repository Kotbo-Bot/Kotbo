<!--
  Alertes sur seuil : « préviens-moi si les messages baissent de 30 % par
  rapport à d'habitude », « si #général dépasse 200 messages par heure ».
  Chaque règle se lit comme une phrase ; dessous, l'historique des
  déclenchements. La création et la modification passent par une modale.
-->
<script lang="ts">
  import { Button, Callout, Modal, SectionCard, ToggleSwitch } from '../ui';
  import { removeWithUndo } from '../../undoRemoval';
  import FormSelect from '../FormSelect.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import RecipientsField, { loadRecipientOptions } from './RecipientsField.svelte';
  import {
    createAlertRule,
    deleteAlertRule,
    fetchAlertRules,
    updateAlertRule,
    type AlertCondition,
    type AlertEvent,
    type AlertMetric,
    type AlertRule,
    type AlertRuleInput,
    type AlertWindow,
  } from '../../api';
  import { authStore } from '../../stores/auth.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { fmtNumber } from './analyticsFormat';

  let rules = $state<AlertRule[]>([]);
  let events = $state<AlertEvent[]>([]);
  let loading = $state(true);
  let error = $state('');
  let channelNames = $state(new Map<string, string>());

  const canEdit = $derived(Boolean(dashboardStore.state.access?.canManageSettings));

  async function load() {
    try {
      const res = await fetchAlertRules();
      rules = res?.rules ?? [];
      events = res?.events ?? [];
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

  const METRICS: AlertMetric[] = ['messages', 'activeMembers', 'voiceMinutes', 'joins', 'leaves', 'netJoins', 'sanctions', 'unansweredRate', 'pulseScore', 'channelRate'];
  const metricLabel = (x: AlertMetric) =>
    ({
      messages: m.anx_metric_messages(), activeMembers: m.anx_alert_m_active(), voiceMinutes: m.anx_alert_m_voice(), joins: m.anx_live_joins(),
      leaves: m.anx_growth_left(), netJoins: m.anx_metric_net_joins(), sanctions: m.anx_fact_sanctions(), unansweredRate: m.anx_resp_unanswered(),
      channelRate: m.anx_alert_m_channel_rate(), pulseScore: m.pulse_alert_metric(),
    })[x];
  const conditionLabel = (c: AlertCondition) =>
    ({ drop_pct: m.anx_alert_c_drop(), rise_pct: m.anx_alert_c_rise(), above: m.anx_alert_c_above(), below: m.anx_alert_c_below() })[c];
  const windowLabel = (w: AlertWindow) => ({ hour: m.anx_alert_w_hour(), day: m.anx_alert_w_day(), week: m.anx_alert_w_week() })[w];
  const windowsFor = (metric: AlertMetric): AlertWindow[] =>
    metric === 'channelRate' ? ['hour'] : ['messages', 'voiceMinutes', 'activeMembers', 'joins', 'leaves', 'netJoins'].includes(metric) ? ['hour', 'day', 'week'] : ['day', 'week'];

  function sentence(rule: AlertRuleInput): string {
    const relative = rule.condition === 'drop_pct' || rule.condition === 'rise_pct';
    const unit = relative || rule.metric === 'unansweredRate' ? ' %' : '';
    const where = rule.channelId ? ` ${m.anx_alert_in({ channel: channelNames.get(rule.channelId) ?? `#${rule.channelId}` })}` : '';
    return m.anx_alert_sentence({
      metric: metricLabel(rule.metric).toLowerCase(),
      where,
      condition: conditionLabel(rule.condition).toLowerCase(),
      threshold: `${fmtNumber(rule.threshold)}${unit}`,
      window: windowLabel(rule.window).toLowerCase(),
    });
  }

  // ── Formulaire ─────────────────────────────────────────────────────────────
  let editing = $state<string | null>(null);
  let open = $state(false);
  let saving = $state(false);
  /** Les listes déroulantes lisent des chaînes : le formulaire garde ces champs en `string`. */
  type FormState = Omit<AlertRuleInput, 'metric' | 'condition' | 'window'> & { metric: string; condition: string; window: string };
  let form = $state<FormState>(blank());
  const asInput = (f: FormState) => f as unknown as AlertRuleInput;

  function blank(): FormState {
    return { name: '', metric: 'messages', condition: 'drop_pct', threshold: 30, window: 'day', channelId: null, notifyChannelId: null, notifyUserIds: [], enabled: true, cooldownHours: 24 };
  }

  function openForm(rule?: AlertRule) {
    editing = rule?.id ?? null;
    form = rule
      ? { name: rule.name, metric: rule.metric, condition: rule.condition, threshold: rule.threshold, window: rule.window, channelId: rule.channelId, notifyChannelId: rule.notifyChannelId, notifyUserIds: [...rule.notifyUserIds], enabled: rule.enabled, cooldownHours: rule.cooldownHours }
      : blank();
    open = true;
  }

  // Une mesure qui ne se suit pas à ce pas bascule sur le premier pas permis.
  $effect(() => {
    const allowed = windowsFor(form.metric as AlertMetric);
    if (!allowed.includes(form.window as AlertWindow)) form.window = allowed[0]!;
    if (form.metric === 'channelRate' && (form.condition === 'drop_pct' || form.condition === 'rise_pct')) form.condition = 'above';
  });

  const formError = $derived(
    !form.name.trim() ? m.anx_alert_err_name()
      : form.metric === 'channelRate' && !form.channelId ? m.anx_alert_err_channel()
        : !form.notifyChannelId && form.notifyUserIds.length === 0 ? m.anx_alert_err_recipients()
          : '',
  );

  async function save() {
    if (formError) return;
    saving = true;
    try {
      const input = { ...asInput(form), threshold: Number(form.threshold), cooldownHours: Number(form.cooldownHours) };
      if (editing) await updateAlertRule(editing, input);
      else await createAlertRule(input);
      open = false;
      toast.success(m.anx_alert_saved());
      await load();
    } catch (e) {
      toast.error(errorMessage(e) || m.an_error_generic());
    } finally {
      saving = false;
    }
  }

  async function toggle(rule: AlertRule) {
    try {
      await updateAlertRule(rule.id, { ...rule, enabled: !rule.enabled });
      rule.enabled = !rule.enabled;
    } catch (e) {
      toast.error(errorMessage(e) || m.an_error_generic());
    }
  }

  async function remove(rule: AlertRule) {
    await removeWithUndo({
      get: () => rules,
      set: (next) => (rules = next),
      match: (r) => r.id === rule.id,
      message: m.anx_alert_deleted(),
      commit: () => deleteAlertRule(rule.id),
    });
  }

  const ruleName = (id: string) => rules.find((r) => r.id === id)?.name ?? m.anx_alert_deleted();
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
</script>

{#if loading}
  <AnalyticsSkeleton />
{:else if error}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else}
  <div class="flex flex-col gap-4">
    <SectionCard title={m.anx_alert_title()} description={m.anx_alert_desc()}>
      {#snippet actions()}
        {#if canEdit}<Button size="sm" variant="primary" icon="plus" onclick={() => openForm()}>{m.anx_alert_new()}</Button>{/if}
      {/snippet}
      {#if rules.length === 0}
        <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_alert_empty()}</p>
      {:else}
        <ul class="rules">
          {#each rules as rule (rule.id)}
            <li class="rule" class:rule--off={!rule.enabled}>
              <div class="min-w-0 flex-1">
                <p class="rule__name">{rule.name}</p>
                <p class="rule__sentence">{sentence(rule)}</p>
                <p class="rule__meta">
                  {#if rule.notifyChannelId}{channelNames.get(rule.notifyChannelId) ?? `#${rule.notifyChannelId}`}{/if}
                  {#if rule.notifyChannelId && rule.notifyUserIds.length > 0} · {/if}
                  {#if rule.notifyUserIds.length > 0}{m.anx_alert_dm_count({ count: String(rule.notifyUserIds.length) })}{/if}
                  · {rule.lastTriggeredAt ? m.anx_alert_last({ when: when(rule.lastTriggeredAt) }) : m.anx_alert_never()}
                </p>
              </div>
              {#if canEdit}
                <div class="rule__actions">
                  <ToggleSwitch checked={rule.enabled} onToggle={() => toggle(rule)} ariaLabel={m.anx_alert_enabled()} size="sm" />
                  <Button size="sm" variant="ghost" icon="pencil" aria-label={m.anx_alert_edit()} onclick={() => openForm(rule)} />
                  <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.anx_alert_delete()} onclick={() => remove(rule)} />
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </SectionCard>

    <SectionCard title={m.anx_alert_history()} description={m.anx_alert_history_desc()}>
      {#if events.length === 0}
        <p class="py-4 text-body-sm text-on-surface-variant">{m.anx_alert_history_empty()}</p>
      {:else}
        <ul class="history">
          {#each events as ev (ev.id)}
            <li class="history__row">
              <span class="history__when">{when(ev.triggeredAt)}</span>
              <span class="history__name">{ruleName(ev.ruleId)}</span>
              <span class="history__value">
                {fmtNumber(Math.round(ev.value * 10) / 10)}{#if ev.baseline !== null}<span class="text-on-surface-variant"> / ~{fmtNumber(Math.round(ev.baseline * 10) / 10)}</span>{/if}
              </span>
              {#if !ev.delivered}<span class="history__fail">{m.anx_alert_not_delivered()}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </SectionCard>
  </div>
{/if}

<Modal bind:open title={editing ? m.anx_alert_edit() : m.anx_alert_new()} size="md" onClose={() => (open = false)}>
  <form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); void save(); }}>
    <label class="field">
      <span class="field__label">{m.anx_alert_f_name()}</span>
      <input class="input" bind:value={form.name} maxlength="80" placeholder={m.anx_alert_f_name_placeholder()} required />
    </label>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="field">
        <span class="field__label">{m.anx_alert_f_metric()}</span>
        <FormSelect bind:value={form.metric} className="input w-full">
          {#each METRICS as x (x)}<option value={x}>{metricLabel(x)}</option>{/each}
        </FormSelect>
      </label>
      <label class="field">
        <span class="field__label">{m.anx_alert_f_window()}</span>
        <FormSelect bind:value={form.window} className="input w-full">
          {#each windowsFor(form.metric as AlertMetric) as w (w)}<option value={w}>{windowLabel(w)}</option>{/each}
        </FormSelect>
      </label>
      <label class="field">
        <span class="field__label">{m.anx_alert_f_condition()}</span>
        <FormSelect bind:value={form.condition} className="input w-full">
          {#each (form.metric === 'channelRate' ? ['above', 'below'] : ['drop_pct', 'rise_pct', 'above', 'below']) as c (c)}
            <option value={c}>{conditionLabel(c as AlertCondition)}</option>
          {/each}
        </FormSelect>
      </label>
      <label class="field">
        <span class="field__label">{m.anx_alert_f_threshold()}</span>
        <input class="input" type="number" min="0" step="any" bind:value={form.threshold} required />
      </label>
    </div>
    {#if form.metric === 'channelRate' || form.metric === 'messages'}
      <label class="field" for="alert-channel">
        <span class="field__label">{form.metric === 'channelRate' ? m.anx_alert_f_channel_required() : m.anx_alert_f_channel_optional()}</span>
        <SearchableSelect id="alert-channel" bind:value={form.channelId} options={[...channelNames].map(([id, name]) => ({ id, name }))} placeholder={m.anx_rcpt_channel_placeholder()} className="input w-full" showId={false} />
      </label>
    {/if}
    <p class="text-body-sm text-on-surface-variant">{m.anx_alert_preview()} {sentence(asInput(form))}</p>
    <RecipientsField idPrefix="alert" bind:channelId={form.notifyChannelId} bind:userIds={form.notifyUserIds} />
    <label class="field">
      <span class="field__label">{m.anx_alert_f_cooldown()}</span>
      <input class="input w-32" type="number" min="1" max="336" bind:value={form.cooldownHours} />
      <span class="field__hint">{m.anx_alert_f_cooldown_hint()}</span>
    </label>
    {#if formError}<p class="text-body-sm text-error">{formError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (open = false)}>{m.anx_note_cancel()}</Button>
      <Button variant="primary" type="submit" loading={saving} disabled={Boolean(formError)} disabledReason={formError}>{m.anx_alert_save()}</Button>
    </div>
  </form>
</Modal>

<style>
  .rules {
    display: flex;
    flex-direction: column;
  }

  .rule {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--color-outline-variant);
  }

  .rule--off {
    opacity: 0.6;
  }

  .rule__name {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .rule__sentence {
    font-size: 0.8125rem;
    color: var(--color-on-surface);
  }

  .rule__meta {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .rule__actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .history {
    display: flex;
    flex-direction: column;
    max-height: 20rem;
    overflow-y: auto;
  }

  .history__row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--color-outline-variant);
    font-size: 0.8125rem;
  }

  .history__when {
    width: 8rem;
    flex-shrink: 0;
    color: var(--color-on-surface-variant);
  }

  .history__name {
    flex: 1;
    min-width: 0;
    color: var(--color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .history__value {
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }

  .history__fail {
    font-size: 0.75rem;
    color: var(--color-error);
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

  .field__hint {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }
</style>
