<!--
  Sécurité → AegisAI : tout le contenu de la page, dont l'en-tête porte déjà
  le nom du partenariat et sa présentation.

  Charge et enregistre sa propre configuration (AegisConfig), comme le panneau
  anti-spam de l'onglet Comportemental. Deux réglages s'appliquent tout de
  suite : la mise en route du module, qui pose d'abord la question du partage
  pour l'entraînement, et ce partage lui-même. Le reste passe par la barre
  d'enregistrement globale.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Button, Callout, Field, SectionCard, SettingsRow, Tabs, ToggleSwitch, FilterPills } from '../ui';
  import Papicon from '../Papicon.svelte';
  import FormSelect from '../FormSelect.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import MultiSelect from '../MultiSelect.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { channelDisplayName } from '../../channelUtils';
  import { useUnsavedChanges } from '../../useUnsavedChanges.svelte';
  import { fetchAegis, updateAegis, type AegisConfig, type AegisConfigPatch, type AegisState } from '../../api';
  import AegisScale from './AegisScale.svelte';
  import AegisTester from './AegisTester.svelte';
  import AegisReviewQueue from './AegisReviewQueue.svelte';
  import AegisConsentModal from './AegisConsentModal.svelte';
  import { PRESETS, presetOf, type PresetId } from './aegisFormat';

  /** Réglages enregistrés d'un coup, à part : la barre ne les suit pas. */
  const IMMEDIATE = ['enabled', 'trainingConsent', 'trainingConsentById', 'trainingConsentAt', 'guildId'] as const;
  type Editable = Omit<AegisConfig, (typeof IMMEDIATE)[number]>;

  function editable(config: AegisConfig): Editable {
    const copy: Record<string, unknown> = { ...config };
    for (const key of IMMEDIATE) delete copy[key];
    return copy as Editable;
  }

  let panel = $state<AegisState | null>(null);
  let config = $state<AegisConfig | null>(null);
  let saved = $state<AegisConfig | null>(null);
  let loadError = $state('');
  let sub = $state<'settings' | 'review' | 'modules'>('settings');
  let consentOpen = $state(false);
  let consentBusy = $state(false);
  let toggling = $state(false);

  const canEdit = $derived(panel?.canEdit ?? false);
  const canReview = $derived(panel?.canReview ?? false);
  const api = $derived(panel?.status.api ?? null);
  const queue = $derived(panel?.status.queue ?? null);
  const textChannels = $derived(
    (dashboardStore.state.discordChannels ?? [])
      .filter((c) => !c.type || c.type === 'text' || c.type === 'announcement')
      .map((c) => ({ id: c.id, name: channelDisplayName(c) })),
  );
  const allChannels = $derived((dashboardStore.state.discordChannels ?? []).map((c) => ({ id: c.id, name: channelDisplayName(c) })));
  const roles = $derived((dashboardStore.state.discordRoles ?? []).map((r) => ({ id: r.id, name: `@${r.name}` })));

  async function load() {
    try {
      const next = await fetchAegis();
      panel = next;
      config = structuredClone(next.config);
      saved = structuredClone(next.config);
      loadError = '';
      if (next.pendingCount > 0) sub = 'review';
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  /** État de l'API et de la file, sans toucher aux réglages en cours d'édition. */
  async function refreshStatus() {
    try {
      const next = await fetchAegis();
      if (panel) panel = { ...panel, status: next.status, pendingCount: next.pendingCount };
    } catch {
      // L'affichage garde le dernier état connu.
    }
  }

  let statusTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    void load();
    statusTimer = setInterval(() => void refreshStatus(), 20_000);
  });
  onDestroy(() => {
    if (statusTimer) clearInterval(statusTimer);
  });

  useUnsavedChanges({
    id: 'aegis-settings',
    label: m.aegis_unsaved_label(),
    getConfig: () => (config ? editable(config) : null),
    getSaved: () => (saved ? editable(saved) : null),
    canEdit: () => canEdit,
    onSave: async () => {
      if (!config || !saved) return false;
      const before = editable(saved) as Record<string, unknown>;
      const after = editable(config) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(after)) {
        if (JSON.stringify(value) !== JSON.stringify(before[key])) patch[key] = value;
      }
      try {
        const res = await updateAegis(patch as AegisConfigPatch);
        saved = structuredClone(res.config);
        config = { ...structuredClone(res.config) };
        toast.success(m.aegis_saved());
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    onReset: () => {
      if (saved && config) config = { ...structuredClone(saved), enabled: config.enabled, trainingConsent: config.trainingConsent };
    },
  });

  /** Enregistre tout de suite un réglage hors barre et le reporte des deux côtés. */
  async function applyNow(patch: AegisConfigPatch, message: string): Promise<boolean> {
    try {
      const res = await updateAegis(patch);
      for (const target of [config, saved]) {
        if (!target) continue;
        target.enabled = res.config.enabled;
        target.trainingConsent = res.config.trainingConsent;
        target.trainingConsentAt = res.config.trainingConsentAt;
        target.trainingConsentById = res.config.trainingConsentById;
      }
      toast.success(message);
      void refreshStatus();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function toggleEnabled(next: boolean) {
    if (!config) return;
    if (next && config.trainingConsent === null) {
      consentOpen = true;
      return;
    }
    toggling = true;
    await applyNow({ enabled: next }, next ? m.aegis_enabled_toast() : m.aegis_disabled_toast());
    toggling = false;
  }

  async function chooseConsent(consent: boolean) {
    consentBusy = true;
    const ok = await applyNow({ trainingConsent: consent, enabled: true }, m.aegis_enabled_toast());
    consentBusy = false;
    if (ok) consentOpen = false;
  }

  // ── Sensibilité ────────────────────────────────────────────────────────────
  const preset = $derived<PresetId>(config ? presetOf(config.reviewThreshold, config.autoThreshold) : 'balanced');
  const thresholdError = $derived(config && config.autoThreshold <= config.reviewThreshold ? m.aegis_threshold_error() : '');

  function applyPreset(id: PresetId) {
    if (!config || id === 'custom') return;
    config.reviewThreshold = PRESETS[id].reviewThreshold;
    config.autoThreshold = PRESETS[id].autoThreshold;
  }

  const apiTone = $derived(!api?.configured ? 'text-error' : api.circuit === 'open' ? 'text-warning' : 'text-success');
  const apiLabel = $derived(
    !api?.configured
      ? m.aegis_status_off()
      : api.circuit === 'open'
        ? m.aegis_status_open({ seconds: String(Math.max(1, Math.ceil(((api.openUntil ?? Date.now()) - Date.now()) / 1000))) })
        : m.aegis_status_ok(),
  );

  const subTabs = $derived([
    { id: 'settings', label: m.aegis_sub_settings(), icon: 'settings' },
    { id: 'review', label: m.aegis_sub_review(), icon: 'inbox', badge: panel?.pendingCount ? panel.pendingCount : undefined },
    { id: 'modules', label: m.aegis_sub_modules(), icon: 'activity' },
  ]);
</script>

{#if loadError && !config}
  <Callout variant="danger" title={m.aegis_title()}>
    {loadError}
    {#snippet actions()}<Button size="sm" onclick={() => load()}>{m.common_retry()}</Button>{/snippet}
  </Callout>
{:else if !config || !panel}
  <div class="flex flex-col gap-4">
    <Skeleton height="120px" radius="0.75rem" />
    <Skeleton height="320px" radius="0.75rem" />
  </div>
{:else}
  <div class="aegis">
    <!-- En-tête : état de l'API et interrupteur. Le nom du partenariat est
         le titre de la page. -->
    <section class="hero">
      <div class="hero__brand">
        <span class="hero__logo" aria-hidden="true"><Papicon icon="ShieldCheck" size={22} /></span>
        <div class="min-w-0">
          <h2 class="hero__title">{m.aegis_enable_label()}</h2>
          <div class="hero__status">
            <span class="pill {apiTone}"><span class="pill__dot" aria-hidden="true"></span>{apiLabel}{#if api?.configured && api.circuit === 'closed' && api.latencyP50Ms !== null} · {m.aegis_status_latency({ ms: String(api.latencyP50Ms) })}{/if}</span>
            {#if queue && config.enabled}
              <span class="pill text-on-surface-variant">{m.aegis_queue({ depth: String(queue.depth), concurrency: String(queue.concurrency) })}</span>
            {/if}
          </div>
        </div>
      </div>
      <div class="hero__toggle">
        <ToggleSwitch
          checked={config.enabled}
          disabled={!canEdit || toggling || !api?.configured}
          onToggle={(v: boolean) => void toggleEnabled(v)}
          ariaLabel={m.aegis_enable_label()}
        />
      </div>
    </section>

    {#if !api?.configured}
      <Callout variant="warning">{m.aegis_off_api()}</Callout>
    {:else if !config.enabled}
      <Callout variant="info" title={m.aegis_disabled_title()}>{m.aegis_disabled_desc()}</Callout>
    {/if}

    <Tabs label={m.aegis_title()} tabs={subTabs} active={sub} onchange={(id) => (sub = id as typeof sub)} />

    {#if sub === 'review'}
      <SectionCard title={m.aegis_sub_review()} description={m.aegis_review_desc()} icon="inbox">
        <AegisReviewQueue {canReview} review={saved?.reviewThreshold ?? 80} auto={saved?.autoThreshold ?? 95} onchange={() => void refreshStatus()} />
      </SectionCard>

    {:else if sub === 'settings'}
      <div class="grid">
        <div class="col">
          <SectionCard title={m.aegis_sensitivity_title()} description={m.aegis_sensitivity_desc()} icon="sliders">
            <div class="flex flex-col gap-5">
              <FilterPills
                label={m.aegis_preset_label()}
                options={[
                  { value: 'tolerant', label: m.aegis_preset_tolerant() },
                  { value: 'balanced', label: m.aegis_preset_balanced() },
                  { value: 'strict', label: m.aegis_preset_strict() },
                  { value: 'custom', label: m.aegis_preset_custom() },
                ]}
                value={preset}
                onchange={(v) => applyPreset(v as PresetId)}
                disabled={!canEdit}
              />
              <AegisScale review={config.reviewThreshold} auto={config.autoThreshold} />
              <div class="pair">
                <Field label={m.aegis_review_threshold()} hint={m.aegis_review_threshold_hint()}>
                  {#snippet children(id, describedBy)}
                    <div class="range">
                      <input {id} aria-describedby={describedBy} type="range" min="50" max="99" bind:value={config!.reviewThreshold} disabled={!canEdit} />
                      <output class="tabular-nums">{config!.reviewThreshold}</output>
                    </div>
                  {/snippet}
                </Field>
                <Field label={m.aegis_auto_threshold()} hint={m.aegis_auto_threshold_hint()} error={thresholdError}>
                  {#snippet children(id, describedBy)}
                    <div class="range">
                      <input {id} aria-describedby={describedBy} type="range" min="51" max="100" bind:value={config!.autoThreshold} disabled={!canEdit} />
                      <output class="tabular-nums">{config!.autoThreshold}</output>
                    </div>
                  {/snippet}
                </Field>
              </div>
              <AegisTester review={config.reviewThreshold} auto={config.autoThreshold} disabled={!canReview || !api?.configured} />
            </div>
          </SectionCard>

          <SectionCard title={m.aegis_action_title()} description={m.aegis_action_desc()} icon="gavel">
            <div class="flex flex-col gap-4">
              <Field label={m.aegis_action_label()}>
                {#snippet children(id)}
                  <FormSelect {id} bind:value={config!.autoAction} className="input" disabled={!canEdit}>
                    <option value="DELETE">{m.aegis_action_delete()}</option>
                    <option value="DELETE_AND_WARN">{m.aegis_action_warn()}</option>
                    <option value="DELETE_AND_TIMEOUT">{m.aegis_action_timeout()}</option>
                  </FormSelect>
                {/snippet}
              </Field>
              {#if config.autoAction === 'DELETE_AND_WARN'}
                <Field label={m.aegis_warn_weight()} hint={m.aegis_warn_weight_hint()}>
                  {#snippet children()}
                    <FilterPills
                      label={m.aegis_warn_weight()}
                      options={[
                        { value: '1', label: m.aegis_weight_1() },
                        { value: '2', label: m.aegis_weight_2() },
                        { value: '3', label: m.aegis_weight_3() },
                      ]}
                      value={String(config!.warnWeight)}
                      onchange={(v) => (config!.warnWeight = Number(v))}
                      disabled={!canEdit}
                    />
                  {/snippet}
                </Field>
              {/if}
              {#if config.autoAction === 'DELETE_AND_TIMEOUT'}
                <Field label={m.aegis_timeout_minutes()}>
                  {#snippet children(id)}
                    <input {id} class="input" type="number" min="1" max="40320" bind:value={config!.timeoutMinutes} disabled={!canEdit} />
                  {/snippet}
                </Field>
              {/if}
              <div class="rows">
                <SettingsRow label={m.aegis_notify_member()} description={m.aegis_notify_member_desc()}>
                  <ToggleSwitch checked={config.notifyMember} onToggle={(v: boolean) => (config!.notifyMember = v)} disabled={!canEdit} ariaLabel={m.aegis_notify_member()} />
                </SettingsRow>
              </div>
              <Field label={m.aegis_review_channel()} hint={m.aegis_review_channel_hint()}>
                {#snippet children(id)}
                  <SearchableSelect {id} bind:value={config!.reviewChannelId} options={textChannels} placeholder={m.aegis_channel_placeholder()} disabled={!canEdit} />
                {/snippet}
              </Field>
            </div>
          </SectionCard>
        </div>

        <div class="col">
          <SectionCard title={m.aegis_scope_title()} description={m.aegis_scope_desc()} icon="search">
            <div class="rows">
              <SettingsRow label={m.aegis_edits()} description={m.aegis_edits_desc()}>
                <ToggleSwitch checked={config.analyzeEdits} onToggle={(v: boolean) => (config!.analyzeEdits = v)} disabled={!canEdit} ariaLabel={m.aegis_edits()} />
              </SettingsRow>
              <SettingsRow label={m.aegis_nicknames()} description={m.aegis_nicknames_desc()}>
                <ToggleSwitch checked={config.analyzeNicknames} onToggle={(v: boolean) => (config!.analyzeNicknames = v)} disabled={!canEdit} ariaLabel={m.aegis_nicknames()} />
              </SettingsRow>
              <SettingsRow label={m.aegis_tickets()} description={m.aegis_tickets_desc()}>
                <ToggleSwitch checked={config.analyzeTickets} onToggle={(v: boolean) => (config!.analyzeTickets = v)} disabled={!canEdit} ariaLabel={m.aegis_tickets()} />
              </SettingsRow>
              {#if config.analyzeTickets}
                <SettingsRow label={m.aegis_ticket_boost()} description={m.aegis_ticket_boost_desc()}>
                  <ToggleSwitch checked={config.ticketPriorityBoost} onToggle={(v: boolean) => (config!.ticketPriorityBoost = v)} disabled={!canEdit} ariaLabel={m.aegis_ticket_boost()} />
                </SettingsRow>
              {/if}
            </div>
          </SectionCard>

          <SectionCard title={m.aegis_exempt_title()} description={m.aegis_exempt_desc()} icon="unlock">
            <div class="flex flex-col gap-4">
              <Field label={m.aegis_exempt_channels()}>
                {#snippet children(id)}
                  <MultiSelect {id} bind:values={config!.exemptChannelIds} options={allChannels} placeholder={m.aegis_exempt_channels_placeholder()} disabled={!canEdit} />
                {/snippet}
              </Field>
              <Field label={m.aegis_exempt_roles()}>
                {#snippet children(id)}
                  <MultiSelect {id} bind:values={config!.exemptRoleIds} options={roles} placeholder={m.aegis_exempt_roles_placeholder()} disabled={!canEdit} />
                {/snippet}
              </Field>
            </div>
          </SectionCard>

          <SectionCard title={m.aegis_privacy_title()} icon="lock">
            <div class="flex flex-col gap-4">
              <ul class="privacy">
                <li><Papicon icon="send" size={14} class="shrink-0 mt-0.5 text-on-surface-variant" /><span>{m.aegis_privacy_sent()}</span></li>
                <li><Papicon icon="database" size={14} class="shrink-0 mt-0.5 text-on-surface-variant" /><span>{m.aegis_privacy_kept()}</span></li>
              </ul>
              <Field label={m.aegis_training_label()} hint={m.aegis_training_desc()}>
                {#snippet children()}
                  <FilterPills
                    label={m.aegis_training_label()}
                    options={[
                      { value: 'yes', label: m.aegis_training_yes() },
                      { value: 'no', label: m.aegis_training_no() },
                    ]}
                    value={config!.trainingConsent === null ? '' : config!.trainingConsent ? 'yes' : 'no'}
                    onchange={(v) => void applyNow({ trainingConsent: v === 'yes' }, m.aegis_consent_saved())}
                    disabled={!canEdit}
                  />
                {/snippet}
              </Field>
              {#if config.trainingConsent === null}
                <p class="text-body-sm text-on-surface-variant">{m.aegis_training_unset()}</p>
              {/if}
            </div>
          </SectionCard>
        </div>
      </div>

    {:else}
      <div class="grid grid--3">
        <SectionCard title={m.aegis_conflict_title()} description={m.aegis_conflict_desc()} icon="flame">
          {#snippet actions()}
            <ToggleSwitch checked={config!.conflictEnabled} onToggle={(v: boolean) => (config!.conflictEnabled = v)} disabled={!canEdit} ariaLabel={m.aegis_conflict_title()} />
          {/snippet}
          <div class="module" class:module--off={!config.conflictEnabled}>
            <Field label={m.aegis_conflict_threshold()}>
              {#snippet children(id)}<input {id} class="input" type="number" min="2" max="30" bind:value={config!.conflictMessageThreshold} disabled={!canEdit} />{/snippet}
            </Field>
            <Field label={m.aegis_conflict_window()}>
              {#snippet children(id)}<input {id} class="input" type="number" min="30" max="900" bind:value={config!.conflictWindowSec} disabled={!canEdit} />{/snippet}
            </Field>
            <Field label={m.aegis_conflict_slowmode()}>
              {#snippet children(id)}<input {id} class="input" type="number" min="1" max="21600" bind:value={config!.conflictSlowmodeSec} disabled={!canEdit} />{/snippet}
            </Field>
            <Field label={m.aegis_conflict_duration()}>
              {#snippet children(id)}<input {id} class="input" type="number" min="1" max="240" bind:value={config!.conflictDurationMin} disabled={!canEdit} />{/snippet}
            </Field>
          </div>
        </SectionCard>

        <SectionCard title={m.aegis_harassment_title()} description={m.aegis_harassment_desc()} icon="target">
          {#snippet actions()}
            <ToggleSwitch checked={config!.harassmentEnabled} onToggle={(v: boolean) => (config!.harassmentEnabled = v)} disabled={!canEdit} ariaLabel={m.aegis_harassment_title()} />
          {/snippet}
          <div class="module" class:module--off={!config.harassmentEnabled}>
            <Field label={m.aegis_harassment_threshold()}>
              {#snippet children(id)}<input {id} class="input" type="number" min="2" max="20" bind:value={config!.harassmentThreshold} disabled={!canEdit} />{/snippet}
            </Field>
            <Field label={m.aegis_harassment_window()}>
              {#snippet children(id)}<input {id} class="input" type="number" min="5" max="1440" bind:value={config!.harassmentWindowMin} disabled={!canEdit} />{/snippet}
            </Field>
            <Field label={m.aegis_harassment_action()}>
              {#snippet children(id)}
                <FormSelect {id} bind:value={config!.harassmentAction} className="input" disabled={!canEdit}>
                  <option value="ALERT">{m.aegis_harassment_alert()}</option>
                  <option value="TIMEOUT">{m.aegis_harassment_timeout()}</option>
                </FormSelect>
              {/snippet}
            </Field>
          </div>
        </SectionCard>

        <SectionCard title={m.aegis_distress_title()} description={m.aegis_distress_desc()} icon="heart">
          {#snippet actions()}
            <ToggleSwitch checked={config!.distressEnabled} onToggle={(v: boolean) => (config!.distressEnabled = v)} disabled={!canEdit} ariaLabel={m.aegis_distress_title()} />
          {/snippet}
          <div class="module" class:module--off={!config.distressEnabled}>
            <Field label={m.aegis_distress_threshold()}>
              {#snippet children(id)}
                <div class="range">
                  <input {id} type="range" min="50" max="100" bind:value={config!.distressThreshold} disabled={!canEdit} />
                  <output class="tabular-nums">{config!.distressThreshold}</output>
                </div>
              {/snippet}
            </Field>
            <Field label={m.aegis_distress_channel()} hint={m.aegis_distress_channel_hint()}>
              {#snippet children(id)}
                <SearchableSelect {id} bind:value={config!.distressChannelId} options={textChannels} placeholder={m.aegis_review_channel()} disabled={!canEdit} />
              {/snippet}
            </Field>
            <Field label={m.aegis_distress_cooldown()}>
              {#snippet children(id)}<input {id} class="input" type="number" min="1" max="168" bind:value={config!.distressCooldownHours} disabled={!canEdit} />{/snippet}
            </Field>
            <Callout variant="info">{m.aegis_distress_note()}</Callout>
          </div>
        </SectionCard>
      </div>
    {/if}

    <p class="powered">{m.aegis_powered()}</p>
  </div>

  <AegisConsentModal bind:open={consentOpen} busy={consentBusy} onchoose={(c) => void chooseConsent(c)} />
{/if}

<style>
  .aegis {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .hero {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background:
      radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--color-primary) 10%, transparent), transparent 60%),
      var(--color-surface-container-lowest);
  }

  .hero__brand {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    min-width: 0;
    flex: 1 1 20rem;
  }

  .hero__logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    border-radius: 0.625rem;
    background: color-mix(in srgb, var(--color-primary) 16%, transparent);
    color: var(--color-primary);
  }

  .hero__title {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }


  .hero__status {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.625rem;
  }

  .hero__toggle {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1875rem 0.625rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .pill__dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 999px;
    background: currentColor;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
    gap: 1rem;
    align-items: start;
  }

  .grid--3 {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  }

  .col {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }

  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
    gap: 1rem;
  }

  .range {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .range input {
    flex: 1;
    accent-color: var(--color-primary);
  }

  .range output {
    min-width: 2rem;
    text-align: right;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .rows {
    margin: 0 -1rem;
  }

  .module {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    transition: opacity 150ms ease;
  }

  .module--off {
    opacity: 0.55;
  }

  .privacy {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--color-on-surface);
  }

  .privacy li {
    display: flex;
    gap: 0.5rem;
  }

  .powered {
    margin: 0;
    text-align: right;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }
</style>
