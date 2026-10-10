<!--
  Onglet « Fils automatiques » de la page Salons.

  Un salon peut porter plusieurs configurations, évaluées dans l'ordre : la
  première qui accepte le message ouvre le fil. Chaque configuration se règle
  en trois temps (où, quels messages, quel nom) ; l'onglet « Suppression
  automatique » dit quoi faire des messages qu'aucune n'accepte.

  Le brouillon est validé avec les mêmes règles que le bot (@kotbo/shared),
  et l'aperçu du titre utilise la même fonction que lui.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    AUTO_THREAD_ARCHIVE_MINUTES,
    AUTO_THREAD_LIMITS,
    AUTO_THREAD_NAMING_RULE_TYPES,
    AUTO_THREAD_PLACEHOLDERS,
    autoThreadAcceptsEverything,
    buildAutoThreadName,
    defaultAutoThreadConfig,
    exportAutoThreadConfig,
    normalizeAutoThreadConfig,
    parseAutoThreadImport,
    sampleAutoThreadFacts,
    type AutoThreadConfigData,
    type AutoThreadNamingMode,
    type AutoThreadNamingRuleType,
    type AutoThreadRejectAction,
    type AutoThreadRenamePermission,
    type AutoThreadTrigger,
  } from '@kotbo/shared';
  import { Button, Callout, EmptyState, Field, Tabs, ToggleSwitch } from '../ui';
  import SearchableSelect from '../SearchableSelect.svelte';
  import Papicon from '../Papicon.svelte';
  import ConditionEditor from './AutoThreadConditionEditor.svelte';
  import {
    createAutoThreadConfig,
    deleteAutoThreadConfig,
    duplicateAutoThreadConfig,
    fetchAutoThreadConfigs,
    reorderAutoThreadConfigs,
    updateAutoThreadConfig,
    type AutoThreadConfigRow,
  } from '../../api';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m, getLocale } from '../../i18n';

  const {
    channels,
    roles,
  }: {
    /** Salons textuels et d'annonces proposés, nom déjà mis en forme. */
    channels: Array<{ id: string; name: string }>;
    roles: Array<{ id: string; name: string }>;
  } = $props();

  type Draft = AutoThreadConfigData & { id: string | null; channelId: string };

  let configs = $state<AutoThreadConfigRow[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let draft = $state<Draft | null>(null);
  /** Brouillon tel qu'enregistré, pour savoir s'il a changé. Vide : jamais enregistré. */
  let baseline = $state('');
  let tab = $state<'config' | 'reject'>('config');
  let importText = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);

  const locale = getLocale() === 'fr' ? 'fr' : 'en';

  // ── Libellés ────────────────────────────────────────────────────────────
  const TRIGGERS: Array<{ value: AutoThreadTrigger; label: () => string; hint: () => string }> = [
    { value: 'all', label: () => m.at_trigger_all(), hint: () => m.at_trigger_all_hint() },
    { value: 'text', label: () => m.at_trigger_text(), hint: () => m.at_trigger_text_hint() },
    { value: 'links', label: () => m.at_trigger_links(), hint: () => m.at_trigger_links_hint() },
    { value: 'media', label: () => m.at_trigger_media(), hint: () => m.at_trigger_media_hint() },
    { value: 'custom', label: () => m.at_trigger_custom(), hint: () => m.at_trigger_custom_hint() },
  ];

  const NAMING: Array<{ value: AutoThreadNamingMode; label: () => string }> = [
    { value: 'first_line', label: () => m.at_naming_first_line() },
    { value: 'author', label: () => m.at_naming_author() },
    { value: 'author_first_line', label: () => m.at_naming_author_first_line() },
    { value: 'date', label: () => m.at_naming_date() },
    { value: 'custom', label: () => m.at_naming_custom() },
  ];

  const RULE_TYPES: Record<AutoThreadNamingRuleType, () => string> = {
    template: () => m.at_rule_template(),
    first_line: () => m.at_rule_first_line(),
    embed_title: () => m.at_rule_embed_title(),
    regex: () => m.at_rule_regex(),
  };

  const ARCHIVE_LABEL: Record<number, () => string> = {
    60: () => m.at_archive_1h(),
    1440: () => m.at_archive_24h(),
    4320: () => m.at_archive_3d(),
    10080: () => m.at_archive_1w(),
  };

  const RENAME: Array<{ value: AutoThreadRenamePermission; label: () => string }> = [
    { value: 'moderators', label: () => m.at_rename_moderators() },
    { value: 'author_and_moderators', label: () => m.at_rename_author() },
    { value: 'everyone', label: () => m.at_rename_everyone() },
  ];

  const REJECT: Array<{ value: AutoThreadRejectAction; label: () => string; hint: () => string }> = [
    { value: 'keep', label: () => m.at_reject_keep(), hint: () => m.at_reject_keep_hint() },
    { value: 'warn', label: () => m.at_reject_warn(), hint: () => m.at_reject_warn_hint() },
    { value: 'delete', label: () => m.at_reject_delete(), hint: () => m.at_reject_delete_hint() },
  ];

  const ERRORS: Record<string, () => string> = {
    name_required: () => m.at_err_name_required(),
    conditions_too_large: () => m.at_err_conditions_too_large(),
    conditions_too_deep: () => m.at_err_conditions_too_deep(),
    condition_value_required: () => m.at_err_condition_value_required(),
    regex_invalid: () => m.at_err_regex_invalid(),
    regex_unsafe: () => m.at_err_regex_unsafe(),
    naming_rules_too_many: () => m.at_err_naming_rules_too_many(),
    naming_rule_value_required: () => m.at_err_naming_rule_value_required(),
    json_invalid: () => m.at_err_json_invalid(),
  };

  function channelName(id: string): string {
    return channels.find((c) => c.id === id)?.name ?? (id ? `#${id}` : m.at_no_channel());
  }

  // ── Brouillon ───────────────────────────────────────────────────────────
  function toDraft(row: AutoThreadConfigRow): Draft {
    const normalized = normalizeAutoThreadConfig(row);
    const data = normalized.ok ? normalized.value : { ...defaultAutoThreadConfig(), name: row.name };
    return { ...data, id: row.id, channelId: row.channelId };
  }

  function snapshot(d: Draft | null): string {
    return d ? JSON.stringify(d) : '';
  }

  const dirty = $derived(!!draft && snapshot(draft) !== baseline);
  const savedRow = $derived(draft?.id ? configs.find((c) => c.id === draft!.id) ?? null : null);

  function open(d: Draft | null, saved: boolean) {
    draft = d;
    baseline = saved ? snapshot(d) : '';
    importText = '';
  }

  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true;
    return confirmDialog.ask({
      title: m.at_discard_title(),
      description: m.at_discard_desc(),
      confirmLabel: m.at_discard_confirm(),
      variant: 'danger',
    });
  }

  async function load(selectId: string | null = null) {
    const res = await fetchAutoThreadConfigs();
    configs = res?.configs ?? [];
    const target = configs.find((c) => c.id === selectId) ?? configs[0] ?? null;
    open(target ? toDraft(target) : null, true);
  }

  onMount(async () => {
    try {
      await load();
    } finally {
      loading = false;
    }
  });

  async function selectConfig(id: string) {
    if (id === draft?.id) return;
    if (!(await confirmDiscard())) return;
    const row = configs.find((c) => c.id === id);
    if (row) open(toDraft(row), true);
  }

  async function addConfig() {
    if (!(await confirmDiscard())) return;
    open({
      ...defaultAutoThreadConfig(),
      name: m.at_default_name(),
      id: null,
      channelId: draft?.channelId ?? '',
    }, false);
    tab = 'config';
  }

  function setTrigger(value: AutoThreadTrigger) {
    if (!draft) return;
    draft.trigger = value;
    if (value === 'custom' && !draft.conditions) {
      draft.conditions = { kind: 'group', op: 'all', children: [{ kind: 'rule', type: 'has_text' }] };
    }
  }

  function setNamingMode(value: AutoThreadNamingMode) {
    if (!draft) return;
    draft.namingMode = value;
    if (value === 'custom' && draft.namingRules.length === 0) {
      draft.namingRules = [
        { type: 'template', value: '{firstLine}' },
        { type: 'template', value: '{displayName}' },
      ];
    }
  }

  function addRule() {
    if (!draft || draft.namingRules.length >= AUTO_THREAD_LIMITS.namingRules) return;
    draft.namingRules.push({ type: 'template', value: '{displayName}' });
  }

  function moveRule(index: number, delta: number) {
    if (!draft) return;
    const target = index + delta;
    if (target < 0 || target >= draft.namingRules.length) return;
    const rules = [...draft.namingRules];
    [rules[index], rules[target]] = [rules[target], rules[index]];
    draft.namingRules = rules;
  }

  function setRuleType(index: number, type: AutoThreadNamingRuleType) {
    if (!draft) return;
    draft.namingRules[index] = type === 'template' || type === 'regex'
      ? { type, value: type === 'regex' ? '' : '{displayName}' }
      : { type };
  }

  // ── Dérivés d'affichage ─────────────────────────────────────────────────
  const acceptsEverything = $derived(draft ? autoThreadAcceptsEverything(draft) : true);

  const preview = $derived.by(() => {
    if (!draft) return '';
    return buildAutoThreadName(draft, sampleAutoThreadFacts(locale), {
      locale,
      count: (savedRow?.threadCount ?? 0) + 1,
    });
  });

  const validation = $derived(draft ? normalizeAutoThreadConfig(draft) : null);
  const validationError = $derived(
    validation && 'error' in validation ? (ERRORS[validation.error]?.() ?? validation.error) : '',
  );

  /** Configurations du salon du brouillon, dans l'ordre d'évaluation. */
  const channelOrder = $derived(
    draft ? configs.filter((c) => c.channelId === draft!.channelId).sort((a, b) => a.position - b.position) : [],
  );

  function triggerLabel(d: Draft): string {
    return TRIGGERS.find((t) => t.value === d.trigger)?.label() ?? d.trigger;
  }

  function rejectSummary(d: Draft): string {
    const label = REJECT.find((r) => r.value === d.rejectAction)?.label() ?? d.rejectAction;
    if (d.rejectAction === 'keep' || autoThreadAcceptsEverything(d)) return REJECT[0].label();
    return `${label} · ${m.at_seconds({ count: d.rejectDelaySeconds })}`;
  }

  function optionLabel(row: AutoThreadConfigRow): string {
    const state = row.enabled ? m.at_state_on() : m.at_state_off();
    return `${channelName(row.channelId)} · ${row.name} · ${state}`;
  }

  const configOptions = $derived([
    ...configs.map((row) => ({ id: row.id, name: optionLabel(row) })),
    ...(draft && !draft.id ? [{ id: '__new__', name: m.at_new_config() }] : []),
  ]);

  // ── Actions ─────────────────────────────────────────────────────────────
  async function save() {
    if (!draft) return;
    if (!draft.channelId) {
      toast.error(m.at_err_channel_required());
      return;
    }
    if (validationError) {
      toast.error(validationError);
      return;
    }
    busy = true;
    try {
      const { id, ...payload } = $state.snapshot(draft);
      const res = id ? await updateAutoThreadConfig(id, payload) : await createAutoThreadConfig(payload);
      if (!res?.ok || !res.config) throw new Error(res?.error || m.at_save_failed());
      await load(res.config.id);
      toast.success(m.at_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.at_save_failed());
    } finally {
      busy = false;
    }
  }

  async function revert() {
    if (!draft) return;
    if (draft.id && baseline) {
      draft = JSON.parse(baseline);
      return;
    }
    const first = configs[0];
    open(first ? toDraft(first) : null, true);
  }

  async function duplicate() {
    if (!draft?.id) return;
    if (!(await confirmDiscard())) return;
    busy = true;
    try {
      const res = await duplicateAutoThreadConfig(draft.id);
      if (!res?.ok || !res.config) throw new Error(res?.error || m.at_duplicate_failed());
      await load(res.config.id);
      toast.success(m.at_duplicated());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.at_duplicate_failed());
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!draft) return;
    if (!draft.id) {
      await revert();
      return;
    }
    if (!(await confirmDialog.ask({
      title: m.at_delete_title(),
      description: m.at_delete_desc({ name: draft.name }),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    }))) return;
    busy = true;
    try {
      const res = await deleteAutoThreadConfig(draft.id);
      if (!res?.ok) throw new Error(res?.error || m.at_delete_failed());
      await load();
      toast.success(m.at_deleted());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.at_delete_failed());
    } finally {
      busy = false;
    }
  }

  async function move(id: string, delta: number) {
    if (!draft) return;
    const ids = channelOrder.map((c) => c.id);
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    busy = true;
    try {
      const res = await reorderAutoThreadConfigs(draft.channelId, ids);
      if (!res?.ok || !res.configs) throw new Error(res?.error || m.at_reorder_failed());
      configs = res.configs;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.at_reorder_failed());
    } finally {
      busy = false;
    }
  }

  // ── Import / export ─────────────────────────────────────────────────────
  function exportText(): string | null {
    if (!validation || !('value' in validation)) {
      toast.error(validationError || m.at_err_json_invalid());
      return null;
    }
    return JSON.stringify(exportAutoThreadConfig(validation.value), null, 2);
  }

  async function copyJson() {
    const text = exportText();
    if (!text) return;
    await navigator.clipboard.writeText(text).then(
      () => toast.success(m.at_json_copied()),
      () => toast.error(m.at_clipboard_failed()),
    );
  }

  function downloadJson() {
    const text = exportText();
    if (!text || !draft) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `autothread-${draft.name.toLowerCase().replace(/[^a-z0-9]+/gi, '-') || 'config'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function pasteJson() {
    importText = await navigator.clipboard.readText().catch(() => {
      toast.error(m.at_clipboard_failed());
      return importText;
    });
  }

  async function openFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    importText = await file.text();
    (event.currentTarget as HTMLInputElement).value = '';
  }

  function importJson() {
    if (!draft) return;
    const result = parseAutoThreadImport(importText);
    if ('error' in result) {
      toast.error(ERRORS[result.error]?.() ?? result.error);
      return;
    }
    draft = { ...result.value, id: draft.id, channelId: draft.channelId };
    toast.success(m.at_imported());
  }
</script>

<section class="at-panel">
  <header class="at-panel__head">
    <div>
      <h3 class="text-base font-semibold text-on-surface">{m.at_title()}</h3>
      <p class="text-body-sm text-on-surface-variant mt-0.5">{m.at_desc()}</p>
    </div>
    <Button icon="plus" onclick={addConfig} disabled={busy}>{m.at_add_config()}</Button>
  </header>

  {#if loading}
    <div class="flex justify-center py-12" aria-busy="true">
      <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
    </div>
  {:else if !draft}
    <EmptyState icon="chat" title={m.at_empty_title()} description={m.at_empty_desc()}>
      {#snippet action()}
        <Button variant="primary" icon="plus" onclick={addConfig}>{m.at_add_config()}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <Field label={m.at_config_select_label()}>
      {#snippet children(id)}
        <select
          {id}
          class="input"
          value={draft?.id ?? '__new__'}
          onchange={(e) => {
            const value = (e.currentTarget as HTMLSelectElement).value;
            if (value !== '__new__') void selectConfig(value);
            (e.currentTarget as HTMLSelectElement).value = draft?.id ?? '__new__';
          }}
        >
          {#each configOptions as option (option.id)}
            <option value={option.id}>{option.name}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <div class="at-panel__title">
      <h4 class="text-xl font-semibold text-on-surface truncate">
        {draft.channelId ? channelName(draft.channelId) : m.at_new_config()}
      </h4>
      <label class="inline-flex items-center gap-2 text-sm text-on-surface-variant">
        <ToggleSwitch checked={draft.enabled} onToggle={(v) => draft && (draft.enabled = v)} ariaLabel={m.at_enabled()} />
        {draft.enabled ? m.at_state_on() : m.at_state_off()}
      </label>
    </div>

    <Tabs
      label={m.at_tabs_label()}
      active={tab}
      onchange={(id) => (tab = id as 'config' | 'reject')}
      tabs={[
        { id: 'config', label: m.at_tab_config() },
        { id: 'reject', label: m.at_tab_reject() },
      ]}
    />

    <div class="at-panel__body">
      <div class="at-panel__main">
        {#if tab === 'config'}
          <!-- 1. Où -->
          <section class="at-step">
            <h5 class="at-step__title"><span class="at-step__num">1</span>{m.at_step_where()}</h5>
            <p class="at-step__desc">{m.at_step_where_desc()}</p>
            <div class="grid gap-4 sm:grid-cols-2">
              <Field label={m.at_channel_label()}>
                {#snippet children(id)}
                  <SearchableSelect {id} options={channels} bind:value={draft!.channelId} placeholder={m.cm_select_channel_placeholder()} clearable={false} />
                {/snippet}
              </Field>
              <Field label={m.at_name_label()}>
                {#snippet children(id, describedBy)}
                  <input {id} aria-describedby={describedBy} class="input" maxlength={AUTO_THREAD_LIMITS.name} bind:value={draft!.name} />
                {/snippet}
              </Field>
            </div>
          </section>

          <!-- 2. Quels messages -->
          <section class="at-step">
            <h5 class="at-step__title"><span class="at-step__num">2</span>{m.at_step_trigger()}</h5>
            <p class="at-step__desc">{m.at_step_trigger_desc()}</p>
            <fieldset class="at-choices">
              <legend class="sr-only">{m.at_step_trigger()}</legend>
              {#each TRIGGERS as option (option.value)}
                <label class="at-choice">
                  <input type="radio" name="at-trigger" checked={draft.trigger === option.value} onchange={() => setTrigger(option.value)} />
                  <span>
                    <strong>{option.label()}</strong>
                    <small>{option.hint()}</small>
                  </span>
                </label>
              {/each}
            </fieldset>
            {#if draft.trigger === 'custom' && draft.conditions}
              <div class="mt-3">
                <ConditionEditor node={draft.conditions} roleOptions={roles} />
              </div>
            {/if}
          </section>

          <!-- 3. Nom du fil -->
          <section class="at-step">
            <h5 class="at-step__title"><span class="at-step__num">3</span>{m.at_step_naming()}</h5>
            <p class="at-step__desc">{m.at_step_naming_desc()}</p>
            <Field label={m.at_naming_label()}>
              {#snippet children(id)}
                <select {id} class="input" value={draft!.namingMode} onchange={(e) => setNamingMode((e.currentTarget as HTMLSelectElement).value as AutoThreadNamingMode)}>
                  {#each NAMING as option (option.value)}
                    <option value={option.value}>{option.label()}</option>
                  {/each}
                </select>
              {/snippet}
            </Field>

            {#if draft.namingMode === 'custom'}
              <div class="mt-4 grid gap-3">
                <p class="text-body-sm text-on-surface-variant" id="at-rules-help">{m.at_rules_help()}</p>
                {#each draft.namingRules as rule, index (index)}
                  <div class="at-rule">
                    <div class="at-rule__head">
                      <span class="text-xs font-semibold text-on-surface-variant">{m.at_rule_n({ n: index + 1 })}</span>
                      <select
                        class="input at-rule__type"
                        aria-label={m.at_rule_type_label({ n: index + 1 })}
                        value={rule.type}
                        onchange={(e) => setRuleType(index, (e.currentTarget as HTMLSelectElement).value as AutoThreadNamingRuleType)}
                      >
                        {#each AUTO_THREAD_NAMING_RULE_TYPES as type (type)}
                          <option value={type}>{RULE_TYPES[type]()}</option>
                        {/each}
                      </select>
                      <Button variant="ghost" size="sm" icon="chevron-up" aria-label={m.at_rule_up({ n: index + 1 })} disabled={index === 0} onclick={() => moveRule(index, -1)} />
                      <Button variant="ghost" size="sm" icon="chevron-down" aria-label={m.at_rule_down({ n: index + 1 })} disabled={index === draft.namingRules.length - 1} onclick={() => moveRule(index, 1)} />
                      <Button variant="ghost" size="sm" icon="trash-2" aria-label={m.at_rule_remove({ n: index + 1 })} onclick={() => draft!.namingRules.splice(index, 1)} />
                    </div>
                    {#if rule.type === 'template' || rule.type === 'regex'}
                      <input
                        class="input mt-2"
                        aria-label={RULE_TYPES[rule.type]()}
                        aria-describedby="at-rules-help"
                        maxlength={AUTO_THREAD_LIMITS.namingValue}
                        placeholder={rule.type === 'regex' ? m.at_rule_regex_placeholder() : '{displayName}'}
                        bind:value={rule.value}
                      />
                    {/if}
                  </div>
                {/each}
                <div class="flex flex-wrap items-center gap-3">
                  <Button variant="secondary" size="sm" icon="plus" onclick={addRule} disabled={draft.namingRules.length >= AUTO_THREAD_LIMITS.namingRules}>
                    {m.at_rule_add()}
                  </Button>
                  <span class="text-xs text-on-surface-variant">{m.at_rule_max({ max: AUTO_THREAD_LIMITS.namingRules })}</span>
                </div>
                <p class="text-xs text-on-surface-variant">{m.at_placeholders({ list: AUTO_THREAD_PLACEHOLDERS.join(' ') })}</p>
              </div>
            {/if}

            <div class="mt-4">
              <p class="field-label">{m.at_preview_label()}</p>
              <div class="at-preview" aria-live="polite">
                <Papicon icon="chat" size={14} />
                <span>{preview}</span>
              </div>
            </div>
          </section>

          <!-- Réglages avancés -->
          <details class="at-advanced">
            <summary>
              <Papicon icon="chevron-right" size={16} />
              <span>
                <strong>{m.at_advanced()}</strong>
                <small>{m.at_advanced_desc()}</small>
              </span>
            </summary>

            <div class="grid gap-4 sm:grid-cols-2 mt-4">
              <Field label={m.at_archive_label()} hint={m.at_archive_hint()}>
                {#snippet children(id, describedBy)}
                  <select {id} aria-describedby={describedBy} class="input" bind:value={draft!.archiveMinutes}>
                    {#each AUTO_THREAD_ARCHIVE_MINUTES as minutes (minutes)}
                      <option value={minutes}>{ARCHIVE_LABEL[minutes]()}</option>
                    {/each}
                  </select>
                {/snippet}
              </Field>
              <Field label={m.at_rename_label()} hint={m.at_rename_hint()}>
                {#snippet children(id, describedBy)}
                  <select {id} aria-describedby={describedBy} class="input" bind:value={draft!.renamePermission}>
                    {#each RENAME as option (option.value)}
                      <option value={option.value}>{option.label()}</option>
                    {/each}
                  </select>
                {/snippet}
              </Field>
            </div>

            <div class="at-row mt-4">
              <div>
                <p class="text-sm font-semibold text-on-surface">{m.at_bots_label()}</p>
                <p class="text-body-sm text-on-surface-variant">{m.at_bots_desc()}</p>
              </div>
              <ToggleSwitch checked={draft.allowBots} onToggle={(v) => draft && (draft.allowBots = v)} ariaLabel={m.at_bots_label()} />
            </div>

            <div class="mt-5">
              <p class="text-sm font-semibold text-on-surface">{m.at_order_label()}</p>
              <p class="text-body-sm text-on-surface-variant">{m.at_order_desc()}</p>
              {#if !draft.id}
                <p class="text-body-sm text-on-surface-variant mt-2">{m.at_order_save_first()}</p>
              {:else if channelOrder.length < 2}
                <p class="text-body-sm text-on-surface-variant mt-2">{m.at_order_single()}</p>
              {:else}
                <ol class="at-order">
                  {#each channelOrder as row, index (row.id)}
                    <li class={row.id === draft.id ? 'is-current' : ''}>
                      <span class="at-order__pos">{index + 1}</span>
                      <span class="truncate flex-1">{row.name}{row.enabled ? '' : ` · ${m.at_state_off()}`}</span>
                      <Button variant="ghost" size="sm" icon="chevron-up" aria-label={m.at_order_up({ name: row.name })} disabled={busy || index === 0} onclick={() => move(row.id, -1)} />
                      <Button variant="ghost" size="sm" icon="chevron-down" aria-label={m.at_order_down({ name: row.name })} disabled={busy || index === channelOrder.length - 1} onclick={() => move(row.id, 1)} />
                    </li>
                  {/each}
                </ol>
              {/if}
            </div>

            <div class="mt-5 grid gap-3">
              <p class="text-sm font-semibold text-on-surface">{m.at_json_title()}</p>
              <p class="text-body-sm text-on-surface-variant">{m.at_json_desc()}</p>
              <div class="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" icon="copy" onclick={copyJson}>{m.at_json_copy()}</Button>
                <Button variant="secondary" size="sm" icon="download" onclick={downloadJson}>{m.at_json_download()}</Button>
                <Button variant="secondary" size="sm" icon="clipboard" onclick={pasteJson}>{m.at_json_paste()}</Button>
                <Button variant="secondary" size="sm" icon="upload" onclick={() => fileInput?.click()}>{m.at_json_open()}</Button>
                <input bind:this={fileInput} class="sr-only" type="file" accept=".json,application/json" tabindex="-1" aria-hidden="true" onchange={openFile} />
              </div>
              <textarea class="input font-mono text-sm" rows="6" spellcheck="false" aria-label={m.at_json_area()} bind:value={importText}></textarea>
              <div>
                <Button variant="secondary" size="sm" onclick={importJson} disabled={!importText.trim()}>{m.at_json_import()}</Button>
              </div>
            </div>
          </details>
        {:else}
          <!-- Suppression automatique -->
          <section class="at-step">
            <h5 class="at-step__title">{m.at_reject_title()}</h5>
            <p class="at-step__desc">{m.at_reject_desc()}</p>
            {#if acceptsEverything}
              <Callout variant="info">{m.at_reject_disabled()}</Callout>
            {/if}
            <fieldset class="at-choices at-choices--stacked" disabled={acceptsEverything}>
              <legend class="sr-only">{m.at_reject_title()}</legend>
              {#each REJECT as option (option.value)}
                <label class="at-choice">
                  <input type="radio" name="at-reject" checked={draft.rejectAction === option.value} onchange={() => draft && (draft.rejectAction = option.value)} />
                  <span>
                    <strong>{option.label()}</strong>
                    <small>{option.hint()}</small>
                  </span>
                </label>
              {/each}
            </fieldset>

            {#if draft.rejectAction !== 'keep' && !acceptsEverything}
              <div class="grid gap-4 mt-4">
                <Field label={m.at_reject_delay_label()} hint={m.at_reject_delay_hint()}>
                  {#snippet children(id, describedBy)}
                    <input
                      {id}
                      aria-describedby={describedBy}
                      class="input w-40"
                      type="number"
                      min={AUTO_THREAD_LIMITS.rejectDelayMin}
                      max={AUTO_THREAD_LIMITS.rejectDelayMax}
                      bind:value={draft!.rejectDelaySeconds}
                    />
                  {/snippet}
                </Field>
                <Field label={m.at_reject_message_label()} hint={m.at_reject_message_hint()}>
                  {#snippet children(id, describedBy)}
                    <textarea
                      {id}
                      aria-describedby={describedBy}
                      class="input"
                      rows="3"
                      maxlength={AUTO_THREAD_LIMITS.rejectMessage}
                      placeholder={draft!.rejectAction === 'delete' ? m.at_reject_message_placeholder_delete() : m.at_reject_message_placeholder_warn()}
                      value={draft!.rejectMessage ?? ''}
                      oninput={(e) => draft && (draft.rejectMessage = (e.currentTarget as HTMLTextAreaElement).value || null)}
                    ></textarea>
                  {/snippet}
                </Field>
                <p class="text-body-sm text-on-surface-variant">{m.at_reject_exempt()}</p>
              </div>
            {/if}
          </section>
        {/if}
      </div>

      <aside class="at-summary" aria-label={m.at_summary()}>
        <h5 class="text-base font-semibold text-on-surface mb-4">{m.at_summary()}</h5>
        <dl>
          <div><dt>{m.at_channel_label()}</dt><dd>{channelName(draft.channelId)}</dd></div>
          <div><dt>{m.at_summary_trigger()}</dt><dd>{triggerLabel(draft)}</dd></div>
          <div><dt>{m.at_summary_naming()}</dt><dd>{NAMING.find((n) => n.value === draft!.namingMode)?.label()}</dd></div>
          <div><dt>{m.at_tab_reject()}</dt><dd>{rejectSummary(draft)}</dd></div>
          <div><dt>{m.at_summary_state()}</dt><dd>{draft.enabled ? m.at_state_on() : m.at_state_off()}</dd></div>
        </dl>
        {#if validationError}
          <p class="text-body-sm text-error mt-4" role="alert">{validationError}</p>
        {/if}
      </aside>
    </div>

    <footer class="at-footer">
      <div class="flex flex-wrap gap-2">
        {#if draft.id}
          <Button variant="secondary" icon="copy" onclick={duplicate} disabled={busy}>{m.at_duplicate()}</Button>
        {/if}
        <Button variant="danger" icon="trash-2" onclick={remove} disabled={busy}>{m.common_delete()}</Button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#if dirty}
          <span class="text-body-sm text-on-surface-variant">{m.at_unsaved()}</span>
          <Button variant="ghost" onclick={revert} disabled={busy}>{m.at_revert()}</Button>
        {/if}
        <Button variant="primary" onclick={save} loading={busy} disabled={!dirty}>{m.common_save()}</Button>
      </div>
    </footer>
  {/if}
</section>

<style>
  .at-panel {
    display: grid;
    gap: 1.25rem;
  }

  .at-panel__head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .at-panel__title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding-top: 0.5rem;
  }

  .at-panel__body {
    display: grid;
    gap: 1.5rem;
    align-items: start;
  }

  @media (min-width: 1100px) {
    .at-panel__body {
      grid-template-columns: minmax(0, 1fr) 240px;
    }
  }

  .at-panel__main {
    min-width: 0;
    display: grid;
  }

  .at-step {
    padding-bottom: 1.25rem;
  }

  .at-step + .at-step {
    border-top: 1px solid var(--color-outline-variant);
    padding-top: 1.25rem;
  }

  .at-step__title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1.0625rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .at-step__num {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 999px;
    background: var(--color-primary);
    color: var(--color-on-primary, #fff);
    font-size: 0.8125rem;
  }

  .at-step__desc {
    margin: 0.375rem 0 0.875rem;
    font-size: 0.875rem;
    color: var(--color-on-surface-variant);
  }

  .at-choices {
    display: grid;
    gap: 0.625rem;
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }

  @media (min-width: 640px) {
    .at-choices:not(.at-choices--stacked) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .at-choices:disabled {
    opacity: 0.55;
  }

  .at-choice {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    cursor: pointer;
  }

  .at-choice:has(input:checked) {
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  }

  .at-choice input {
    margin-top: 0.2rem;
    accent-color: var(--color-primary);
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  .at-choice strong {
    display: block;
    font-size: 0.875rem;
    color: var(--color-on-surface);
  }

  .at-choice small {
    display: block;
    margin-top: 0.125rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .at-rule {
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.75rem;
    background: var(--color-surface-container-low);
  }

  .at-rule__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .at-rule__type {
    flex: 1 1 10rem;
    width: auto;
  }

  .at-preview {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.375rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    color: var(--color-on-surface);
    font-weight: 600;
    word-break: break-word;
  }

  .at-advanced {
    border-top: 1px solid var(--color-outline-variant);
    padding-top: 1.25rem;
  }

  .at-advanced > summary {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.75rem;
    cursor: pointer;
    list-style: none;
  }

  .at-advanced > summary::-webkit-details-marker {
    display: none;
  }

  .at-advanced > summary :global(svg) {
    transition: transform 0.15s ease;
    flex-shrink: 0;
  }

  .at-advanced[open] > summary :global(svg) {
    transform: rotate(90deg);
  }

  .at-advanced summary strong {
    display: block;
    color: var(--color-on-surface);
  }

  .at-advanced summary small {
    display: block;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .at-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .at-order {
    display: grid;
    gap: 0.375rem;
    margin: 0.75rem 0 0;
    padding: 0;
    list-style: none;
  }

  .at-order li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.625rem;
    font-size: 0.875rem;
  }

  .at-order li.is-current {
    border-color: var(--color-primary);
  }

  .at-order__pos {
    display: inline-grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .at-summary {
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    padding: 1.25rem;
  }

  .at-summary dl {
    display: grid;
    gap: 1rem;
    margin: 0;
  }

  .at-summary dt {
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .at-summary dd {
    margin: 0.125rem 0 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-on-surface);
    word-break: break-word;
  }

  .at-footer {
    position: sticky;
    bottom: 0.75rem;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  }
</style>
