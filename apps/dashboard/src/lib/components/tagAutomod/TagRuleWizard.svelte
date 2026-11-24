<script lang="ts">
  /**
   * Assistant de règle de l'automod des tags, en quatre étapes :
   * 1. quoi viser (un serveur recensé par Kotbo, ou un texte de tag) ;
   * 2. quoi faire (réponse, durée, message, escalade) ;
   * 3. qui est concerné aujourd'hui (aperçu sur les membres actuels) ;
   * 4. nom et enregistrement.
   * Ouvert vide, depuis un modèle (pré-rempli) ou pour modifier une règle.
   */
  import Modal from '../Modal.svelte';
  import Papicon from '../Papicon.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import DurationPresets from '../DurationPresets.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';
  import { tagPatternMaxLength } from '@kotbo/shared';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import {
    createTagRule,
    updateTagRule,
    searchTagServers,
    scanTagMembers,
    type TagAction,
    type TagAutomodRule,
    type TagRuleDraft,
    type TagScanResult,
    type TagServerResult,
  } from '../../api';
  import { DURATION_PRESETS, ESCALATION_ACTIONS, ESCALATION_DELAY_PRESETS, TAG_ACTIONS, tagActionMeta } from './tagAutomodLabels';

  type Step = 'target' | 'response' | 'preview' | 'confirm';

  let {
    open = $bindable(false),
    initial = null,
    editing = null,
    jailConfigured = true,
    aboveCase = false,
    onSaved,
  }: {
    open?: boolean;
    /** Pré-remplissage (modèle, fiche serveur). */
    initial?: TagRuleDraft | null;
    /** Règle existante à modifier. */
    editing?: TagAutomodRule | null;
    jailConfigured?: boolean;
    /** Ouvert depuis une fiche (serveur, membre) : passe au-dessus d'elle. */
    aboveCase?: boolean;
    onSaved?: (rule: TagAutomodRule) => void;
  } = $props();

  const blank = (): TagRuleDraft => ({
    name: '', effect: 'BLOCK', targetType: 'SERVER', targetGuildId: null, targetName: null, targetIcon: null,
    pattern: '', matchMode: 'EXACT', action: 'TICKET', durationMin: 60, roleId: null, message: '',
    escalateAfterMin: null, escalateAction: null, escalateDurationMin: null,
  });

  let draft = $state<TagRuleDraft>(blank());
  let step = $state<Step>('target');
  let query = $state('');
  let results = $state<TagServerResult[]>([]);
  let searching = $state(false);
  let preview = $state<TagScanResult | null>(null);
  let previewing = $state(false);
  let saving = $state(false);
  let escalate = $state(false);
  let nameTouched = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const roles = $derived((dashboardStore.state.discordRoles ?? []).filter((r) => r.name !== '@everyone').map((r) => ({ id: r.id, name: r.name, color: r.color ?? null })));
  const steps = $derived<Step[]>(draft.effect === 'ALLOW' ? ['target', 'preview', 'confirm'] : ['target', 'response', 'preview', 'confirm']);
  const stepIndex = $derived(steps.indexOf(step));
  const meta = $derived(tagActionMeta((draft.action ?? 'ALERT') as TagAction));
  const patternMax = $derived(tagPatternMaxLength(draft.matchMode));
  const patternTooLong = $derived((draft.pattern?.trim().length ?? 0) > patternMax);
  const targetReady = $derived(draft.targetType === 'SERVER' ? Boolean(draft.targetGuildId) : Boolean(draft.pattern?.trim()) && !patternTooLong);
  const responseReady = $derived(draft.action !== 'ROLE' || Boolean(draft.roleId));
  const canNext = $derived(step === 'target' ? targetReady : step === 'response' ? responseReady : true);
  const targetLabel = $derived(draft.targetType === 'SERVER' ? (draft.targetName ?? draft.targetGuildId ?? '') : `« ${draft.pattern ?? ''} »`);

  // Réinitialise à chaque ouverture, d'après la règle modifiée ou le modèle.
  $effect(() => {
    if (!open) return;
    const base = editing ? { ...editing } : { ...blank(), ...(initial ?? {}) };
    draft = base;
    escalate = Boolean(base.escalateAfterMin && base.escalateAction);
    nameTouched = Boolean(editing || initial?.name);
    preview = null;
    query = '';
    step = editing || (initial && (initial.targetGuildId || initial.pattern)) ? (base.effect === 'ALLOW' ? 'preview' : 'response') : 'target';
    void runSearch('');
  });

  // Nom proposé tant que la personne ne l'a pas saisi elle-même.
  $effect(() => {
    if (nameTouched) return;
    const target = draft.targetType === 'SERVER' ? (draft.targetName ?? '') : (draft.pattern ?? '');
    draft.name = target ? (draft.effect === 'ALLOW' ? m.tam_wiz_name_allow({ target }) : m.tam_wiz_name_block({ target })) : '';
  });

  async function runSearch(q: string) {
    searching = true;
    try {
      results = (await searchTagServers(q))?.servers ?? [];
    } catch {
      results = [];
    } finally {
      searching = false;
    }
  }

  function onQuery(value: string) {
    query = value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(value.trim()), 250);
  }

  function pickServer(server: TagServerResult) {
    draft.targetGuildId = server.guildId;
    draft.targetName = server.name;
    draft.targetIcon = server.iconUrl;
  }

  async function loadPreview() {
    previewing = true;
    try {
      preview = await scanTagMembers({ ...draft, name: draft.name || 'draft' });
    } catch {
      preview = null;
    } finally {
      previewing = false;
    }
  }

  function go(delta: number) {
    const next = steps[stepIndex + delta];
    if (!next) return;
    step = next;
    if (next === 'preview' && !preview) void loadPreview();
  }

  async function save() {
    if (saving) return;
    saving = true;
    const payload: TagRuleDraft = {
      ...draft,
      escalateAfterMin: escalate ? draft.escalateAfterMin ?? 1440 : null,
      escalateAction: escalate ? draft.escalateAction ?? 'KICK' : null,
      escalateDurationMin: escalate ? draft.escalateDurationMin ?? null : null,
      durationMin: meta.needsDuration ? draft.durationMin ?? null : null,
      source: initial && !editing ? 'TEMPLATE' : (editing?.source === 'TEMPLATE' ? 'TEMPLATE' : 'MANUAL'),
    };
    try {
      const res = editing ? await updateTagRule(editing.id, payload) : await createTagRule(payload);
      if (res?.rule) {
        toast.success(editing ? m.tam_wiz_updated() : m.tam_wiz_created());
        onSaved?.(res.rule);
        open = false;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.tam_err_save());
    } finally {
      saving = false;
    }
  }

  const VARIABLES = ['{user}', '{tag}', '{server}', '{delay}'];
</script>

<Modal bind:open title={editing ? m.tam_wiz_title_edit() : m.tam_wiz_title()} subtitle={m.tam_wiz_subtitle()} size="lg" {aboveCase} onClose={() => (open = false)}>
  <!-- Progression -->
  <ol class="flex items-center gap-2 mb-6" aria-label={m.tam_wiz_progress()}>
    {#each steps as s, i (s)}
      <li class="flex items-center gap-2 flex-1 min-w-0">
        <span class="w-6 h-6 shrink-0 rounded-full grid place-items-center text-2xs font-bold {i < stepIndex ? 'bg-primary text-on-primary' : i === stepIndex ? 'bg-primary/15 text-primary border border-primary/40' : 'bg-surface-container-high text-on-surface-variant'}" aria-current={i === stepIndex ? 'step' : undefined}>
          {#if i < stepIndex}<Papicon icon="Check" size={12} />{:else}{i + 1}{/if}
        </span>
        <span class="text-xs truncate {i === stepIndex ? 'text-on-surface font-medium' : 'text-on-surface-variant'}">
          {s === 'target' ? m.tam_wiz_step_target() : s === 'response' ? m.tam_wiz_step_response() : s === 'preview' ? m.tam_wiz_step_preview() : m.tam_wiz_step_confirm()}
        </span>
        {#if i < steps.length - 1}<span class="hidden sm:block flex-1 h-px bg-outline-variant/30"></span>{/if}
      </li>
    {/each}
  </ol>

  {#if step === 'target'}
    <div class="space-y-5">
      <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label={m.tam_wiz_effect()}>
        {#each [{ v: 'BLOCK', icon: 'ShieldAlert', t: m.tam_wiz_effect_block(), d: m.tam_wiz_effect_block_hint() }, { v: 'ALLOW', icon: 'ShieldCheck', t: m.tam_wiz_effect_allow(), d: m.tam_wiz_effect_allow_hint() }] as opt (opt.v)}
          <button type="button" role="radio" aria-checked={draft.effect === opt.v} onclick={() => (draft.effect = opt.v as 'BLOCK' | 'ALLOW')}
            class="text-left rounded-xl border p-3 transition-colors {draft.effect === opt.v ? 'border-primary/60 bg-primary/10' : 'border-outline-variant/30 hover:border-outline-variant/60'}">
            <span class="flex items-center gap-2 text-body-sm font-medium text-on-surface"><Papicon icon={opt.icon} size={16} />{opt.t}</span>
            <span class="block text-xs text-on-surface-variant mt-1">{opt.d}</span>
          </button>
        {/each}
      </div>

      <div class="inline-flex rounded-full bg-surface-container p-1" role="tablist" aria-label={m.tam_wiz_target_kind()}>
        {#each [{ v: 'SERVER', t: m.tam_wiz_target_server() }, { v: 'TEXT', t: m.tam_wiz_target_text() }] as opt (opt.v)}
          <button type="button" role="tab" aria-selected={draft.targetType === opt.v} onclick={() => (draft.targetType = opt.v as 'SERVER' | 'TEXT')}
            class="px-4 py-1.5 rounded-full text-xs font-medium transition-colors {draft.targetType === opt.v ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant'}">{opt.t}</button>
        {/each}
      </div>

      {#if draft.targetType === 'SERVER'}
        <div class="space-y-3">
          <label class="relative block">
            <span class="sr-only">{m.tam_wiz_search_label()}</span>
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"><Papicon icon="Search" size={16} /></span>
            <input type="search" value={query} oninput={(e) => onQuery(e.currentTarget.value)} placeholder={m.tam_wiz_search_ph()}
              class="w-full rounded-xl bg-surface-container border border-field-border pl-9 pr-3 py-2.5 text-body-sm text-on-surface" />
          </label>
          <p class="text-2xs text-on-surface-variant">{query.trim() ? m.tam_wiz_search_results() : m.tam_wiz_search_default()}</p>
          <div class="grid gap-2 max-h-72 overflow-y-auto pr-1" role="listbox" aria-label={m.tam_wiz_search_label()}>
            {#if searching && results.length === 0}
              <p class="text-xs text-on-surface-variant py-6 text-center">{m.tam_wiz_searching()}</p>
            {:else if results.length === 0}
              <p class="text-xs text-on-surface-variant py-6 text-center">{query.trim() ? m.tam_wiz_search_empty() : m.tam_wiz_search_none_here()}</p>
            {/if}
            {#each results as server (server.guildId)}
              {@const selected = draft.targetGuildId === server.guildId}
              <button type="button" role="option" aria-selected={selected} onclick={() => pickServer(server)}
                class="flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors {selected ? 'border-primary/60 bg-primary/10' : 'border-outline-variant/30 hover:border-outline-variant/60'}">
                {#if server.iconUrl}
                  <img src={server.iconUrl} alt="" class="w-9 h-9 rounded-xl shrink-0" loading="lazy" />
                {:else}
                  <span class="w-9 h-9 rounded-xl shrink-0 grid place-items-center bg-surface-container-high text-on-surface-variant text-xs font-bold">{server.unlisted ? 'ID' : server.name.slice(0, 2)}</span>
                {/if}
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2 text-body-sm font-medium text-on-surface truncate">
                    {server.unlisted ? m.tam_wiz_unlisted_name() : server.name}
                    {#if server.tag}
                      <span class="inline-flex items-center gap-1 rounded-md border border-outline-variant/40 px-1.5 py-0.5 text-2xs font-mono">
                        {#if server.badgeUrl}<img src={server.badgeUrl} alt="" class="w-3 h-3" />{/if}{server.tag}
                      </span>
                    {/if}
                  </span>
                  <span class="block text-2xs text-on-surface-variant">
                    {#if server.unlisted}
                      {m.tam_wiz_unlisted_hint({ id: server.guildId })}
                    {:else}
                      {server.holders > 0 ? m.tam_wiz_holders({ count: server.holders }) : m.tam_wiz_no_holders()}
                    {/if}
                    {#if server.fleetBlocks > 0}<span class="text-error"> · {m.tam_fleet_blocks({ count: server.fleetBlocks })}</span>{/if}
                  </span>
                </span>
                {#if selected}<span class="text-primary"><Papicon icon="Check" size={16} /></span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">{m.tam_wiz_pattern()}</span>
            <input type="text" bind:value={draft.pattern} maxlength={patternMax} placeholder={m.tam_wiz_pattern_ph()}
              aria-invalid={patternTooLong} aria-describedby={patternTooLong ? 'tam-pattern-too-long' : undefined}
              class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2.5 text-body-sm text-on-surface font-mono" />
            {#if patternTooLong}
              <span id="tam-pattern-too-long" class="block text-2xs text-error mt-1">{m.tam_wiz_pattern_too_long({ max: patternMax })}</span>
            {/if}
          </label>
          <div class="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label={m.tam_wiz_match_mode()}>
            {#each [{ v: 'EXACT', t: m.tam_wiz_match_exact(), d: m.tam_wiz_match_exact_hint() }, { v: 'CONTAINS', t: m.tam_wiz_match_contains(), d: m.tam_wiz_match_contains_hint() }, { v: 'REGEX', t: m.tam_wiz_match_regex(), d: m.tam_wiz_match_regex_hint() }] as opt (opt.v)}
              <button type="button" role="radio" aria-checked={draft.matchMode === opt.v} onclick={() => (draft.matchMode = opt.v as 'EXACT' | 'CONTAINS' | 'REGEX')}
                class="text-left rounded-xl border p-2.5 transition-colors {draft.matchMode === opt.v ? 'border-primary/60 bg-primary/10' : 'border-outline-variant/30 hover:border-outline-variant/60'}">
                <span class="block text-xs font-medium text-on-surface">{opt.t}</span>
                <span class="block text-2xs text-on-surface-variant mt-0.5">{opt.d}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

  {:else if step === 'response'}
    <div class="space-y-5">
      <div>
        <p class="text-xs font-medium text-on-surface-variant mb-2">{m.tam_wiz_response_q({ target: targetLabel })}</p>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label={m.tam_wiz_step_response()}>
          {#each TAG_ACTIONS as a (a)}
            {@const am = tagActionMeta(a)}
            <button type="button" role="radio" aria-checked={draft.action === a} onclick={() => (draft.action = a)}
              class="text-left rounded-xl border p-2.5 transition-colors {draft.action === a ? (am.tone === 'strong' ? 'border-error/60 bg-error/10' : 'border-primary/60 bg-primary/10') : 'border-outline-variant/30 hover:border-outline-variant/60'}">
              <span class="flex items-center gap-1.5 text-xs font-medium text-on-surface"><Papicon icon={am.icon} size={14} />{am.label}</span>
              <span class="block text-2xs text-on-surface-variant mt-0.5 leading-snug">{am.hint}</span>
            </button>
          {/each}
        </div>
      </div>

      {#if draft.action === 'JAIL' && !jailConfigured}
        <Callout variant="warning">{m.tam_no_jail()}</Callout>
      {/if}

      {#if meta.needsDuration}
        <label class="block sm:w-1/2">
          <span class="text-xs font-medium text-on-surface-variant">{m.tam_wiz_duration()}</span>
          <input type="number" min="1" bind:value={draft.durationMin} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" />
          <DurationPresets bind:value={draft.durationMin as number} presets={DURATION_PRESETS} label={m.tam_wiz_duration()} />
          {#if draft.action === 'JAIL'}<p class="text-2xs text-on-surface-variant mt-1">{m.tam_wiz_jail_lift()}</p>{/if}
        </label>
      {/if}

      {#if draft.action === 'ROLE'}
        <div class="sm:w-1/2">
          <span class="text-xs font-medium text-on-surface-variant">{m.tam_wiz_role()}</span>
          <SearchableSelect options={roles} value={draft.roleId ?? null} placeholder={m.tam_wiz_role_ph()} on:change={(e) => (draft.roleId = e.detail?.value ?? null)} />
        </div>
      {/if}

      {#if draft.action === 'TICKET' || draft.action === 'DM'}
        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">{draft.action === 'TICKET' ? m.tam_wiz_ticket_msg() : m.tam_wiz_dm_msg()}</span>
          <textarea bind:value={draft.message} rows="3" maxlength={1500} placeholder={draft.action === 'TICKET' ? m.tam_wiz_ticket_ph() : m.tam_wiz_dm_ph()}
            class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface"></textarea>
          <span class="flex flex-wrap items-center gap-1.5 mt-1">
            <span class="text-2xs text-on-surface-variant">{m.tam_wiz_variables()}</span>
            {#each VARIABLES as v (v)}
              <button type="button" class="rounded-md border border-outline-variant/40 px-1.5 py-0.5 text-2xs font-mono text-on-surface hover:border-primary/50" onclick={() => (draft.message = `${draft.message ?? ''}${v}`)}>{v}</button>
            {/each}
          </span>
        </label>
      {/if}

      {#if !['KICK', 'SOFTBAN', 'BAN'].includes(draft.action ?? '')}
        <div class="rounded-xl border border-outline-variant/30 p-3 space-y-3">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-body-sm font-medium text-on-surface">{m.tam_wiz_escalate()}</p>
              <p class="text-xs text-on-surface-variant mt-0.5">{m.tam_wiz_escalate_hint()}</p>
            </div>
            <ToggleSwitch checked={escalate} onToggle={(v) => { escalate = v; if (v) { draft.escalateAfterMin ??= 1440; draft.escalateAction ??= 'KICK'; } }} />
          </div>
          {#if escalate}
            <div class="grid sm:grid-cols-2 gap-3">
              <label class="block">
                <span class="text-xs font-medium text-on-surface-variant">{m.tam_wiz_escalate_after()}</span>
                <input type="number" min="1" bind:value={draft.escalateAfterMin} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" />
                <DurationPresets bind:value={draft.escalateAfterMin as number} presets={ESCALATION_DELAY_PRESETS} label={m.tam_wiz_escalate_after()} />
              </label>
              <label class="block">
                <span class="text-xs font-medium text-on-surface-variant">{m.tam_wiz_escalate_then()}</span>
                <select bind:value={draft.escalateAction} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface">
                  {#each ESCALATION_ACTIONS as a (a)}<option value={a}>{tagActionMeta(a).label}</option>{/each}
                </select>
              </label>
            </div>
          {/if}
        </div>
      {/if}
    </div>

  {:else if step === 'preview'}
    <div class="space-y-4">
      {#if previewing}
        <p class="text-sm text-on-surface-variant py-8 text-center">{m.tam_wiz_previewing()}</p>
      {:else if preview}
        <div class="grid grid-cols-3 gap-2">
          <div class="rounded-xl bg-surface-container p-3"><p class="text-2xs text-on-surface-variant">{m.tam_wiz_prev_scanned()}</p><p class="text-lg font-semibold text-on-surface">{preview.scanned}</p></div>
          <div class="rounded-xl bg-surface-container p-3"><p class="text-2xs text-on-surface-variant">{m.tam_wiz_prev_with_tag()}</p><p class="text-lg font-semibold text-on-surface">{preview.withTag}</p></div>
          <div class="rounded-xl p-3 {preview.total > 0 ? 'bg-primary/10' : 'bg-surface-container'}"><p class="text-2xs text-on-surface-variant">{m.tam_wiz_prev_matching()}</p><p class="text-lg font-semibold text-on-surface">{preview.total}</p></div>
        </div>
        {#if preview.total === 0}
          <Callout variant="info">{m.tam_wiz_prev_none()}</Callout>
        {:else}
          <p class="text-xs text-on-surface-variant">{draft.effect === 'ALLOW' ? m.tam_wiz_prev_allow_note() : m.tam_wiz_prev_block_note()}</p>
          <ul class="grid sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
            {#each preview.matches as match (match.userId)}
              <li class="flex items-center gap-2 rounded-xl border border-outline-variant/30 px-2.5 py-1.5">
                <img src={match.avatarUrl} alt="" class="w-7 h-7 rounded-full" loading="lazy" />
                <span class="min-w-0">
                  <span class="block text-xs font-medium text-on-surface truncate">{match.displayName}</span>
                  <span class="block text-2xs text-on-surface-variant truncate">@{match.username} · {match.tag}</span>
                </span>
              </li>
            {/each}
          </ul>
          {#if preview.total > preview.matches.length}<p class="text-2xs text-on-surface-variant">{m.tam_wiz_prev_more({ count: preview.total - preview.matches.length })}</p>{/if}
        {/if}
      {:else}
        <Callout variant="warning">{m.tam_wiz_prev_failed()}</Callout>
      {/if}
    </div>

  {:else}
    <div class="space-y-4">
      <label class="block">
        <span class="text-xs font-medium text-on-surface-variant">{m.tam_wiz_name()}</span>
        <input type="text" bind:value={draft.name} oninput={() => (nameTouched = true)} maxlength={80}
          class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2.5 text-body-sm text-on-surface" />
      </label>
      <div class="rounded-xl bg-surface-container p-4 text-body-sm text-on-surface leading-relaxed">
        {#if draft.effect === 'ALLOW'}
          {m.tam_wiz_summary_allow({ target: targetLabel })}
        {:else}
          {m.tam_wiz_summary_block({ target: targetLabel, action: meta.label })}
          {#if escalate}{' '}{m.tam_wiz_summary_escalate({ action: tagActionMeta((draft.escalateAction ?? 'KICK') as TagAction).label })}{/if}
        {/if}
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <div class="flex items-center justify-between gap-2 w-full">
      <Button variant="ghost" onclick={() => (stepIndex === 0 ? (open = false) : go(-1))}>
        {stepIndex === 0 ? m.tam_cancel() : m.tam_back()}
      </Button>
      {#if step === 'confirm'}
        <Button icon="Check" onclick={save} disabled={saving || !draft.name?.trim()}>{editing ? m.tam_wiz_save() : m.tam_wiz_create()}</Button>
      {:else}
        <Button icon="ArrowRight" onclick={() => go(1)} disabled={!canNext} disabledReason={!targetReady ? m.tam_wiz_need_target() : !responseReady ? m.tam_wiz_need_role() : undefined}>{m.tam_next()}</Button>
      {/if}
    </div>
  {/snippet}
</Modal>
