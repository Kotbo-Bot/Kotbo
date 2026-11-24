<script lang="ts">
  /**
   * Sécurité > Filtres > Tags : automod des tags de serveur.
   *
   * Pensée pour une première configuration sans lecture : des modèles en un
   * clic, un assistant pour les règles, l'aperçu des membres touchés avant
   * d'agir et un mode test. Les réglages s'enregistrent au fil des clics.
   */
  import { onMount } from 'svelte';
  import { gotoTab } from '../../lib/tabRouting';
  import { pageTabItems } from '../../lib/config/pageTabs';
  import { Tabs } from '../../lib/components/ui';
  import ModulePage from '../../lib/components/ModulePage.svelte';
  import SectionCard from '../../lib/components/SectionCard.svelte';
  import ToggleSwitch from '../../lib/components/ToggleSwitch.svelte';
  import Callout from '../../lib/components/ui/Callout.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import LoadingHint from '../../lib/components/LoadingHint.svelte';
  import Modal from '../../lib/components/Modal.svelte';
  import Papicon from '../../lib/components/Papicon.svelte';
  import MultiSelect from '../../lib/components/MultiSelect.svelte';
  import SearchableSelect from '../../lib/components/SearchableSelect.svelte';
  import DurationPresets from '../../lib/components/DurationPresets.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import TagRuleWizard from '../../lib/components/tagAutomod/TagRuleWizard.svelte';
  import { DURATION_PRESETS, TAG_ACTIONS, tagActionMeta, tagStatusMeta, tagTriggerLabel } from '../../lib/components/tagAutomod/tagAutomodLabels';
  import { m, dateLocale } from '../../lib/i18n';
  import { authStore } from '../../lib/stores/auth.svelte';
  import { dashboardStore } from '../../lib/stores/dashboard.svelte';
  import { memberCaseModal } from '../../lib/stores/memberCaseModal.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { removeWithUndo } from '../../lib/undoRemoval';
  import { formatDuration } from '../../lib/durationFormat';
  import { DEFAULT_TAG_PRESET_CATEGORIES, TAG_PRESET_CATEGORIES, TAG_PRESET_LISTS, normalizeTagList } from '@kotbo/shared';
  import {
    fetchTagAutomod,
    updateTagAutomodConfig,
    updateTagRule,
    deleteTagRule,
    fetchTagAutomodEvents,
    scanTagMembers,
    rescanTagMembers,
    type TagAction,
    type TagAutomodConfig,
    type TagAutomodEvent,
    type TagAutomodRule,
    type TagAutomodState,
    type TagRuleDraft,
    type TagScanResult,
  } from '../../lib/api';

  let data = $state<TagAutomodState | null>(null);
  let loading = $state(true);
  let wizardOpen = $state(false);
  let wizardInitial = $state<TagRuleDraft | null>(null);
  let wizardEditing = $state<TagAutomodRule | null>(null);
  let showTemplates = $state(false);
  let events = $state<TagAutomodEvent[]>([]);
  let eventsMore = $state(false);
  let scanOpen = $state(false);
  let scan = $state<TagScanResult | null>(null);
  let scanning = $state(false);
  let applying = $state(false);
  let exemptRoles = $state<string[]>([]);

  const config = $derived(data?.config);
  const rules = $derived((data?.rules ?? []).filter((r) => r.source !== 'WAVE'));
  const waveBlocks = $derived((data?.rules ?? []).filter((r) => r.source === 'WAVE'));
  const isNew = $derived(Boolean(data && !data.configured && (data.rules?.length ?? 0) === 0));
  const channels = $derived((dashboardStore.state.discordChannels ?? []).filter((c) => c.type === undefined || c.type === 'text' || c.type === 'announcement').map((c) => ({ id: c.id, name: `#${c.name}` })));
  const roles = $derived((dashboardStore.state.discordRoles ?? []).filter((r) => r.name !== '@everyone').map((r) => ({ id: r.id, name: r.name })));

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      const [state, ev] = await Promise.all([fetchTagAutomod(), fetchTagAutomodEvents({ limit: 20 })]);
      data = state;
      exemptRoles = [...(state?.config.exemptRoleIds ?? [])];
      events = ev?.events ?? [];
      eventsMore = ev?.hasMore ?? false;
    } catch {
      toast.error(m.tam_load_error());
    } finally {
      loading = false;
    }
  }

  async function loadMoreEvents() {
    const last = events.at(-1);
    if (!last) return;
    const ev = await fetchTagAutomodEvents({ before: last.createdAt, limit: 20 }).catch(() => null);
    events = [...events, ...(ev?.events ?? [])];
    eventsMore = ev?.hasMore ?? false;
  }

  /** Enregistre aussitôt, avec retour arrière si l'appel échoue. */
  const PRESET_CATEGORY_LABELS: Record<string, () => string> = {
    HATE: () => m.tam_preset_cat_hate(),
    ANTISEMITISM: () => m.tam_preset_cat_antisemitism(),
    EXTREMISM: () => m.tam_preset_cat_extremism(),
    POLITICS: () => m.tam_preset_cat_politics(),
  };

  /** Liste de tags saisie à la main, séparée par virgules, espaces ou lignes. */
  function parseTagList(value: string): string[] {
    return normalizeTagList(value.split(/[\s,;]+/));
  }

  async function patch(partial: Partial<TagAutomodConfig>, success?: string) {
    if (!data) return;
    const before = data.config;
    data.config = { ...data.config, ...partial };
    try {
      const res = await updateTagAutomodConfig(partial);
      if (res?.config) data.config = res.config;
      data.configured = true;
      if (success) toast.success(success);
    } catch (err) {
      data.config = before;
      toast.error(err instanceof Error ? err.message : m.tam_err_save());
    }
  }

  function openWizard(initial: TagRuleDraft | null = null, editing: TagAutomodRule | null = null) {
    wizardInitial = initial;
    wizardEditing = editing;
    wizardOpen = true;
  }

  function onRuleSaved(rule: TagAutomodRule) {
    if (!data) return;
    const exists = data.rules.some((r) => r.id === rule.id);
    data.rules = exists ? data.rules.map((r) => (r.id === rule.id ? { ...r, ...rule } : r)) : [...data.rules, rule];
    showTemplates = false;
    // Première règle : l'automod s'allume, sinon elle n'agirait pas.
    if (!data.config.enabled) void patch({ enabled: true }, m.tam_enabled_with_rule());
  }

  async function toggleRule(rule: TagAutomodRule, enabled: boolean) {
    if (!data) return;
    data.rules = data.rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r));
    try {
      await updateTagRule(rule.id, { enabled });
    } catch {
      data.rules = data.rules.map((r) => (r.id === rule.id ? { ...r, enabled: !enabled } : r));
      toast.error(m.tam_err_save());
    }
  }

  function removeRule(rule: TagAutomodRule) {
    if (!data) return;
    void removeWithUndo({
      get: () => data!.rules,
      set: (next) => (data!.rules = next),
      match: (r) => r.id === rule.id,
      message: m.tam_rule_deleted({ name: rule.name }),
      commit: async () => {
        if (!(await deleteTagRule(rule.id))) throw new Error('delete failed');
      },
    });
  }

  async function makePermanent(rule: TagAutomodRule) {
    const res = await updateTagRule(rule.id, { permanent: true }).catch(() => null);
    if (res?.rule && data) {
      data.rules = data.rules.map((r) => (r.id === rule.id ? { ...r, ...res.rule } : r));
      toast.success(m.tam_block_permanent_done());
    }
  }

  // ── Modèles ────────────────────────────────────────────────────────────────

  type Template = { id: string; icon: string; title: string; desc: string; apply: () => void };
  const templates = $derived<Template[]>([
    {
      id: 'soft', icon: 'Ticket', title: m.tam_tpl_soft(), desc: m.tam_tpl_soft_desc(),
      apply: () => openWizard({ effect: 'BLOCK', targetType: 'SERVER', action: 'TICKET', escalateAfterMin: 1440, escalateAction: 'KICK' }),
    },
    {
      id: 'ban', icon: 'Ban', title: m.tam_tpl_ban(), desc: m.tam_tpl_ban_desc(),
      apply: () => openWizard({ effect: 'BLOCK', targetType: 'SERVER', action: 'BAN', durationMin: null }),
    },
    {
      id: 'text', icon: 'Tag', title: m.tam_tpl_text(), desc: m.tam_tpl_text_desc(),
      apply: () => openWizard({ effect: 'BLOCK', targetType: 'TEXT', matchMode: 'CONTAINS', action: 'JAIL', durationMin: null }),
    },
    {
      id: 'friends', icon: 'ShieldCheck', title: m.tam_tpl_friends(), desc: m.tam_tpl_friends_desc(),
      apply: () => openWizard({ effect: 'ALLOW', targetType: 'SERVER' }),
    },
    {
      id: 'wave', icon: 'Zap', title: m.tam_tpl_wave(), desc: m.tam_tpl_wave_desc(),
      apply: () => void patch({ enabled: true, waveEnabled: true, waveMode: 'ADAPTIVE', wavePreset: 'NORMAL', waveAction: 'JAIL', waveBlockHours: 24, waveReportFleet: true }, m.tam_tpl_applied()),
    },
    {
      id: 'shared', icon: 'Globe', title: m.tam_tpl_shared(), desc: m.tam_tpl_shared_desc(),
      apply: () => void patch({ enabled: true, sharedListEnabled: true, sharedListAction: 'JAIL' }, m.tam_tpl_applied()),
    },
    {
      id: 'mine', icon: 'Shield', title: m.tam_tpl_mine(), desc: m.tam_tpl_mine_desc(),
      apply: () => void patch({ enabled: true, impersonationEnabled: true, impersonationAction: 'JAIL' }, m.tam_tpl_applied()),
    },
    {
      id: 'young', icon: 'Hourglass', title: m.tam_tpl_young(), desc: m.tam_tpl_young_desc(),
      apply: () => void patch({ enabled: true, newAccountEnabled: true, newAccountDays: 7, newAccountAction: 'ALERT' }, m.tam_tpl_applied()),
    },
  ]);

  // ── Analyse du serveur ─────────────────────────────────────────────────────

  async function openScan() {
    scanOpen = true;
    scanning = true;
    scan = null;
    try {
      scan = await scanTagMembers(null);
    } catch {
      scan = null;
    } finally {
      scanning = false;
    }
  }

  async function applyScan() {
    if (!scan?.total) return;
    if (config?.testMode === false && !(await confirmDialog.ask({
      title: m.tam_scan_confirm_title({ count: scan.total }),
      description: m.tam_scan_confirm_desc(),
      confirmLabel: m.tam_scan_apply(),
      variant: 'warning',
    }))) return;
    applying = true;
    try {
      const res = await rescanTagMembers();
      toast.success(m.tam_scan_started({ count: res?.count ?? 0 }));
      scanOpen = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.tam_err_save());
    } finally {
      applying = false;
    }
  }

  // ── Affichage ──────────────────────────────────────────────────────────────

  const WAVE_STATUS = { OPEN: m.tam_wave_status_open, SANCTIONED: m.tam_wave_status_sanctioned, IGNORED: m.tam_wave_status_ignored, BLOCKED: m.tam_wave_status_blocked };

  function ruleTarget(rule: TagAutomodRule): string {
    if (rule.targetType === 'SERVER') return rule.targetName ?? rule.targetGuildId ?? '';
    const mode = rule.matchMode === 'REGEX' ? m.tam_wiz_match_regex() : rule.matchMode === 'CONTAINS' ? m.tam_wiz_match_contains() : m.tam_wiz_match_exact();
    return `${rule.pattern} · ${mode.toLowerCase()}`;
  }

  function actionText(action: TagAction, durationMin: number | null): string {
    const label = tagActionMeta(action).label;
    return durationMin && tagActionMeta(action).needsDuration ? `${label} · ${formatDuration(durationMin, dateLocale())}` : label;
  }

  function when(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // MultiSelect ne se lie qu'en valeur : la liste modifiée part dès qu'elle diffère.
  $effect(() => {
    const next = exemptRoles;
    if (data && next.join(',') !== data.config.exemptRoleIds.join(',')) void patch({ exemptRoleIds: [...next] });
  });

  onMount(load);
  $effect(() => {
    if (authStore.selectedGuildId) void load();
  });
</script>

{#snippet actionPicker(value: TagAction, onPick: (a: TagAction) => void, label: string)}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <select value={value} onchange={(e) => onPick(e.currentTarget.value as TagAction)} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface">
      {#each TAG_ACTIONS.filter((a) => a !== 'ROLE' && a !== 'TICKET') as a (a)}<option value={a}>{tagActionMeta(a).label}</option>{/each}
    </select>
  </label>
{/snippet}

{#snippet durationField(value: number | null, onSet: (v: number | null) => void, label: string)}
  <label class="block">
    <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    <input type="number" min="1" value={value ?? ''} placeholder={m.tam_permanent()} onchange={(e) => onSet(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
      class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" />
  </label>
{/snippet}

{#snippet detection(title: string, desc: string, icon: string, enabled: boolean, onToggle: (v: boolean) => void, body: import('svelte').Snippet)}
  <div class="rounded-2xl border p-4 flex flex-col gap-3 transition-colors {enabled ? 'border-primary/40 bg-primary/5' : 'border-outline-variant/30'}">
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-start gap-3 min-w-0">
        <span class="w-9 h-9 rounded-xl grid place-items-center shrink-0 {enabled ? 'bg-primary/15 text-primary' : 'bg-surface-container-high text-on-surface-variant'}"><Papicon {icon} size={18} /></span>
        <div class="min-w-0">
          <p class="text-body-sm font-medium text-on-surface">{title}</p>
          <p class="text-xs text-on-surface-variant mt-0.5 leading-relaxed">{desc}</p>
        </div>
      </div>
      <ToggleSwitch checked={enabled} onToggle={onToggle} />
    </div>
    {#if enabled}<div class="pt-1 space-y-3">{@render body()}</div>{/if}
  </div>
{/snippet}

<ModulePage title={m.am_page_title()} description={m.tam_page_desc()} icon="filter" featureKey="raid_protection">
  <Tabs label={m.am_page_title()} tabs={pageTabItems('/security/filters')} active="tags" onchange={(id) => gotoTab('/security/filters', id, 'bot')} />

  {#if loading && !data}
    <LoadingHint context="config" />
  {:else if data && config}
    <div class="space-y-6">
      <!-- État -->
      <div class="grid gap-3 lg:grid-cols-4">
        <div class="lg:col-span-2 rounded-2xl border border-outline-variant/30 p-5 flex flex-col gap-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-base font-semibold text-on-surface">{config.enabled ? (config.testMode ? m.tam_state_test() : m.tam_state_on()) : m.tam_state_off()}</p>
              <p class="text-xs text-on-surface-variant mt-1">{config.enabled ? (config.testMode ? m.tam_state_test_desc() : m.tam_state_on_desc()) : m.tam_state_off_desc()}</p>
            </div>
            <ToggleSwitch checked={config.enabled} onToggle={(v) => patch({ enabled: v })} />
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label class="inline-flex items-center gap-2 text-xs text-on-surface">
              <ToggleSwitch checked={config.testMode} onToggle={(v) => patch({ testMode: v }, v ? m.tam_test_on() : m.tam_test_off())} />
              {m.tam_test_mode()}
            </label>
            <Button size="sm" variant="secondary" icon="Search" onclick={openScan}>{m.tam_scan_btn()}</Button>
          </div>
          {#if data.ownTag}
            <p class="text-2xs text-on-surface-variant flex items-center gap-1.5">
              {m.tam_own_tag()}
              <span class="inline-flex items-center gap-1 rounded-md border border-outline-variant/40 px-1.5 py-0.5 font-mono text-on-surface">
                {#if data.ownBadgeUrl}<img src={data.ownBadgeUrl} alt="" class="w-3 h-3" />{/if}{data.ownTag}
              </span>
              {m.tam_own_tag_safe()}
            </p>
          {/if}
        </div>
        <div class="rounded-2xl bg-surface-container p-5">
          <p class="text-xs text-on-surface-variant">{m.tam_stat_other_tags()}</p>
          <p class="text-2xl font-semibold text-on-surface mt-1">{data.stats.membersWithOtherTag}</p>
          <p class="text-2xs text-on-surface-variant mt-1">{m.tam_stat_other_tags_hint()}</p>
        </div>
        <div class="rounded-2xl bg-surface-container p-5">
          <p class="text-xs text-on-surface-variant">{m.tam_stat_events()}</p>
          <p class="text-2xl font-semibold text-on-surface mt-1">{data.stats.events7d}</p>
          <p class="text-2xs text-on-surface-variant mt-1">
            {m.tam_stat_events_hint({ applied: data.stats.byStatus.APPLIED ?? 0, test: data.stats.byStatus.DRY_RUN ?? 0 })}
          </p>
        </div>
      </div>

      {#if !data.jailConfigured && rules.some((r) => r.action === 'JAIL')}
        <Callout variant="warning">{m.tam_no_jail()}</Callout>
      {/if}

      <!-- Premiers pas / modèles -->
      {#if isNew || showTemplates}
        <SectionCard title={isNew ? m.tam_start_title() : m.tam_templates_title()} description={isNew ? m.tam_start_desc() : m.tam_templates_desc()} icon="Sparkles">
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {#each templates as tpl (tpl.id)}
              <button type="button" onclick={tpl.apply} class="group text-left rounded-2xl border border-outline-variant/30 p-4 hover:border-primary/50 hover:bg-primary/5 transition-colors flex flex-col gap-2">
                <span class="w-9 h-9 rounded-xl grid place-items-center bg-primary/10 text-primary"><Papicon icon={tpl.icon} size={18} /></span>
                <span class="text-body-sm font-medium text-on-surface">{tpl.title}</span>
                <span class="text-xs text-on-surface-variant leading-relaxed">{tpl.desc}</span>
                <span class="mt-auto inline-flex items-center gap-1 text-xs font-medium text-primary">{m.tam_tpl_use()}<Papicon icon="ArrowRight" size={12} /></span>
              </button>
            {/each}
          </div>
          {#if isNew}
            <div class="mt-4 flex flex-wrap items-center gap-3">
              <Button icon="Plus" onclick={() => openWizard()}>{m.tam_new_rule()}</Button>
              <span class="text-xs text-on-surface-variant">{m.tam_start_hint()}</span>
            </div>
          {/if}
        </SectionCard>
      {/if}

      <!-- Règles -->
      {#if !isNew}
        <SectionCard title={m.tam_rules_title()} description={m.tam_rules_desc({ count: rules.length, max: data.maxRules })} icon="ListChecks">
          {#snippet actions()}
            <div class="flex gap-2">
              <Button size="sm" variant="ghost" icon="Sparkles" onclick={() => (showTemplates = !showTemplates)}>{m.tam_templates_btn()}</Button>
              <Button size="sm" icon="Plus" onclick={() => openWizard()} disabled={rules.length >= data.maxRules}>{m.tam_new_rule()}</Button>
            </div>
          {/snippet}
          {#if rules.length === 0}
            <EmptyState icon="Tag" title={m.tam_rules_empty()} description={m.tam_rules_empty_desc()} actionLabel={m.tam_new_rule()} onAction={() => openWizard()} />
          {:else}
            <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {#each rules as rule (rule.id)}
                <article class="rounded-2xl border p-4 flex flex-col gap-3 {rule.enabled ? 'border-outline-variant/40' : 'border-outline-variant/20 opacity-70'}">
                  <header class="flex items-start gap-3">
                    {#if rule.targetType === 'SERVER' && rule.targetIcon}
                      <img src={rule.targetIcon} alt="" class="w-10 h-10 rounded-xl shrink-0" loading="lazy" />
                    {:else}
                      <span class="w-10 h-10 rounded-xl grid place-items-center shrink-0 bg-surface-container-high text-on-surface-variant"><Papicon icon={rule.targetType === 'SERVER' ? 'Globe' : 'Tag'} size={18} /></span>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <p class="text-body-sm font-medium text-on-surface truncate">{rule.name}</p>
                      <p class="text-xs text-on-surface-variant truncate">{ruleTarget(rule)}</p>
                    </div>
                    <ToggleSwitch checked={rule.enabled} onToggle={(v) => toggleRule(rule, v)} />
                  </header>
                  <div class="flex flex-wrap gap-1.5">
                    {#if rule.effect === 'ALLOW'}
                      <span class="rounded-full border border-success/30 bg-success/10 text-on-success-container px-2 py-0.5 text-2xs font-medium">{m.tam_badge_allowed()}</span>
                    {:else}
                      <span class="rounded-full border px-2 py-0.5 text-2xs font-medium {tagActionMeta(rule.action).tone === 'strong' ? 'border-error/30 bg-error/10 text-on-error-container' : 'border-primary/30 bg-primary/10 text-primary'}">{actionText(rule.action, rule.durationMin)}</span>
                      {#if rule.escalateAction && rule.escalateAfterMin}
                        <span class="rounded-full border border-warning/30 bg-warning/10 text-on-warning-container px-2 py-0.5 text-2xs font-medium">
                          {m.tam_badge_escalate({ action: tagActionMeta(rule.escalateAction).label, delay: formatDuration(rule.escalateAfterMin, dateLocale()) })}
                        </span>
                      {/if}
                    {/if}
                    {#if (rule.fleetBlocks ?? 0) > 1}
                      <span class="rounded-full border border-outline-variant/40 px-2 py-0.5 text-2xs text-on-surface-variant">{m.tam_fleet_blocks({ count: rule.fleetBlocks ?? 0 })}</span>
                    {/if}
                  </div>
                  <footer class="flex justify-end gap-1 mt-auto">
                    <Button size="sm" variant="ghost" icon="Pencil" onclick={() => openWizard(null, rule)}>{m.tam_edit()}</Button>
                    <Button size="sm" variant="ghost" icon="Trash2" aria-label={m.tam_delete_rule({ name: rule.name })} onclick={() => removeRule(rule)} />
                  </footer>
                </article>
              {/each}
            </div>
          {/if}
          {#if waveBlocks.length > 0}
            <div class="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-3 space-y-2">
              <p class="text-xs font-medium text-on-surface">{m.tam_wave_blocks_title()}</p>
              {#each waveBlocks as rule (rule.id)}
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span class="text-on-surface">{rule.targetName ?? rule.targetGuildId} · {m.tam_until({ date: rule.expiresAt ? when(rule.expiresAt) : '' })}</span>
                  <span class="flex gap-1">
                    <Button size="sm" variant="secondary" onclick={() => makePermanent(rule)}>{m.tam_make_permanent()}</Button>
                    <Button size="sm" variant="ghost" icon="X" aria-label={m.tam_delete_rule({ name: rule.name })} onclick={() => removeRule(rule)} />
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </SectionCard>
      {/if}

      <!-- Détections automatiques -->
      <SectionCard title={m.tam_detect_title()} description={m.tam_detect_desc()} icon="ShieldAlert">
        <div class="grid gap-3 lg:grid-cols-2">
          {#snippet waveBody()}
            <div class="inline-flex rounded-full bg-surface-container p-1" role="radiogroup" aria-label={m.tam_wave_mode()}>
              {#each [{ v: 'ADAPTIVE', t: m.tam_wave_adaptive() }, { v: 'FIXED', t: m.tam_wave_fixed() }] as opt (opt.v)}
                <button type="button" role="radio" aria-checked={config.waveMode === opt.v} onclick={() => patch({ waveMode: opt.v as 'ADAPTIVE' | 'FIXED' })}
                  class="px-3 py-1 rounded-full text-xs font-medium {config.waveMode === opt.v ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant'}">{opt.t}</button>
              {/each}
            </div>
            <div class="flex flex-wrap gap-2" role="radiogroup" aria-label={m.tam_wave_preset()}>
              {#each [{ v: 'SOFT', t: m.tam_preset_soft(), d: '8 / 1 min', n: 8, w: 60 }, { v: 'NORMAL', t: m.tam_preset_normal(), d: '5 / 2 min', n: 5, w: 120 }, { v: 'STRICT', t: m.tam_preset_strict(), d: '3 / 5 min', n: 3, w: 300 }] as p (p.v)}
                {@const active = config.waveMode === 'ADAPTIVE' ? config.wavePreset === p.v : config.waveThreshold === p.n && config.waveWindowSec === p.w}
                <button type="button" role="radio" aria-checked={active} onclick={() => patch({ wavePreset: p.v as 'SOFT' | 'NORMAL' | 'STRICT', waveThreshold: p.n, waveWindowSec: p.w })}
                  class="rounded-xl border px-3 py-1.5 text-left {active ? 'border-primary/60 bg-primary/10' : 'border-outline-variant/30'}">
                  <span class="block text-xs font-medium text-on-surface">{p.t}</span>
                  <span class="block text-2xs text-on-surface-variant">{p.d}</span>
                </button>
              {/each}
            </div>
            <p class="text-2xs text-on-surface-variant">{config.waveMode === 'ADAPTIVE' ? m.tam_wave_adaptive_hint() : m.tam_wave_fixed_hint()}</p>
            {#if config.waveMode === 'FIXED'}
              <div class="grid grid-cols-2 gap-3">
                <label class="block"><span class="text-xs font-medium text-on-surface-variant">{m.tam_wave_threshold()}</span>
                  <input type="number" min="2" max="100" value={config.waveThreshold} onchange={(e) => patch({ waveThreshold: Number(e.currentTarget.value) })} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" /></label>
                <label class="block"><span class="text-xs font-medium text-on-surface-variant">{m.tam_wave_window()}</span>
                  <input type="number" min="10" max="3600" value={config.waveWindowSec} onchange={(e) => patch({ waveWindowSec: Number(e.currentTarget.value) })} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" /></label>
              </div>
            {/if}
            <div class="grid grid-cols-2 gap-3">
              {@render actionPicker(config.waveAction, (a) => patch({ waveAction: a }), m.tam_wave_action())}
              {#if tagActionMeta(config.waveAction).needsDuration}{@render durationField(config.waveDurationMin, (v) => patch({ waveDurationMin: v }), m.tam_wiz_duration())}{/if}
            </div>
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.tam_wave_block()}</span>
              <select value={config.waveBlockHours} onchange={(e) => patch({ waveBlockHours: Number(e.currentTarget.value) })} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface">
                {#each [0, 6, 24, 72, 168] as h (h)}<option value={h}>{h === 0 ? m.tam_wave_block_none() : formatDuration(h * 60, dateLocale())}</option>{/each}
              </select>
            </label>
            <label class="flex items-center justify-between gap-3 text-xs text-on-surface">
              <span>{m.tam_wave_report()}<span class="block text-2xs text-on-surface-variant">{m.tam_wave_report_hint()}</span></span>
              <ToggleSwitch checked={config.waveReportFleet} onToggle={(v) => patch({ waveReportFleet: v })} />
            </label>
          {/snippet}
          {@render detection(m.tam_wave_title(), m.tam_wave_desc(), 'Zap', config.waveEnabled, (v) => patch({ waveEnabled: v }), waveBody)}

          {#snippet adoptBody()}
            <div class="grid grid-cols-3 gap-3">
              <label class="block"><span class="text-xs font-medium text-on-surface-variant">{m.tam_adopt_threshold()}</span>
                <input type="number" min="2" max="100" value={config.massAdoptThreshold} onchange={(e) => patch({ massAdoptThreshold: Number(e.currentTarget.value) })} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" /></label>
              <label class="block"><span class="text-xs font-medium text-on-surface-variant">{m.tam_adopt_window()}</span>
                <input type="number" min="1" max="1440" value={config.massAdoptWindowMin} onchange={(e) => patch({ massAdoptWindowMin: Number(e.currentTarget.value) })} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" /></label>
              {@render actionPicker(config.massAdoptAction, (a) => patch({ massAdoptAction: a }), m.tam_wave_action())}
            </div>
          {/snippet}
          {@render detection(m.tam_adopt_title(), m.tam_adopt_desc(), 'Users', config.massAdoptEnabled, (v) => patch({ massAdoptEnabled: v }), adoptBody)}

          {#snippet youngBody()}
            <div class="grid grid-cols-2 gap-3">
              <label class="block"><span class="text-xs font-medium text-on-surface-variant">{m.tam_young_days()}</span>
                <input type="number" min="1" max="365" value={config.newAccountDays} onchange={(e) => patch({ newAccountDays: Number(e.currentTarget.value) })} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface" /></label>
              <label class="block"><span class="text-xs font-medium text-on-surface-variant">{m.tam_young_scope()}</span>
                <select value={config.newAccountScope} onchange={(e) => patch({ newAccountScope: e.currentTarget.value as 'ANY' | 'UNKNOWN' })} class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface">
                  <option value="UNKNOWN">{m.tam_young_scope_unknown()}</option>
                  <option value="ANY">{m.tam_young_scope_any()}</option>
                </select></label>
              {@render actionPicker(config.newAccountAction, (a) => patch({ newAccountAction: a }), m.tam_wave_action())}
              {#if tagActionMeta(config.newAccountAction).needsDuration}{@render durationField(config.newAccountDurationMin, (v) => patch({ newAccountDurationMin: v }), m.tam_wiz_duration())}{/if}
            </div>
          {/snippet}
          {@render detection(m.tam_young_title(), m.tam_young_desc(), 'Hourglass', config.newAccountEnabled, (v) => patch({ newAccountEnabled: v }), youngBody)}

          {#snippet mineBody()}
            {#if !data?.ownTag}<Callout variant="info">{m.tam_mine_no_tag()}</Callout>{/if}
            <div class="grid grid-cols-2 gap-3">
              {@render actionPicker(config.impersonationAction, (a) => patch({ impersonationAction: a }), m.tam_wave_action())}
              {#if tagActionMeta(config.impersonationAction).needsDuration}{@render durationField(config.impersonationDurationMin, (v) => patch({ impersonationDurationMin: v }), m.tam_wiz_duration())}{/if}
            </div>
          {/snippet}
          {@render detection(m.tam_mine_title(), m.tam_mine_desc(), 'Shield', config.impersonationEnabled, (v) => patch({ impersonationEnabled: v }), mineBody)}

          {#snippet sharedBody()}
            <p class="text-2xs text-on-surface-variant">{m.tam_shared_hint({ count: data?.fleetMinReporters ?? 3 })}</p>
            <div class="grid grid-cols-2 gap-3">
              {@render actionPicker(config.sharedListAction, (a) => patch({ sharedListAction: a }), m.tam_wave_action())}
              {#if tagActionMeta(config.sharedListAction).needsDuration}{@render durationField(config.sharedListDurationMin, (v) => patch({ sharedListDurationMin: v }), m.tam_wiz_duration())}{/if}
            </div>
          {/snippet}
          {@render detection(m.tam_shared_title(), m.tam_shared_desc(), 'Globe', config.sharedListEnabled, (v) => patch({ sharedListEnabled: v }), sharedBody)}

          {#snippet presetBody()}
            <fieldset class="space-y-2">
              <legend class="text-xs font-medium text-on-surface-variant">{m.tam_preset_categories()}</legend>
              {#each TAG_PRESET_CATEGORIES as category (category)}
                {@const active = config.presetCategories.includes(category)}
                <label class="flex items-start gap-2 rounded-xl border border-outline-variant/30 px-3 py-2 text-body-sm text-on-surface">
                  <input type="checkbox" class="mt-1" checked={active}
                    onchange={() => patch({ presetCategories: active ? config.presetCategories.filter((c) => c !== category) : [...config.presetCategories, category] })} />
                  <span class="min-w-0">
                    {PRESET_CATEGORY_LABELS[category]()}
                    <span class="block text-2xs text-on-surface-variant font-mono">{TAG_PRESET_LISTS[category].join(' · ')}</span>
                  </span>
                </label>
              {/each}
            </fieldset>
            <div class="grid grid-cols-2 gap-3">
              {@render actionPicker(config.presetAction, (a) => patch({ presetAction: a }), m.tam_wave_action())}
              {#if tagActionMeta(config.presetAction).needsDuration}{@render durationField(config.presetDurationMin, (v) => patch({ presetDurationMin: v }), m.tam_wiz_duration())}{/if}
            </div>
            <label class="block">
              <span class="text-xs font-medium text-on-surface-variant">{m.tam_preset_excluded()}</span>
              <input type="text" value={config.presetExcluded.join(', ')} placeholder={m.tam_preset_excluded_ph()}
                onchange={(e) => patch({ presetExcluded: parseTagList(e.currentTarget.value) })}
                class="mt-1 w-full rounded-xl bg-surface-container border border-field-border px-3 py-2 text-body-sm text-on-surface font-mono" />
              <span class="block text-2xs text-on-surface-variant mt-1">{m.tam_preset_excluded_hint()}</span>
            </label>
          {/snippet}
          {@render detection(m.tam_preset_title(), m.tam_preset_desc(), 'ListChecks', config.presetCategories.length > 0,
            (v) => patch({ presetCategories: v ? [...DEFAULT_TAG_PRESET_CATEGORIES] : [] }), presetBody)}

          {#snippet allowBody()}
            {#if !rules.some((r) => r.effect === 'ALLOW')}
              <Callout variant="warning">{m.tam_allow_empty()}</Callout>
            {/if}
            <div class="grid grid-cols-2 gap-3">
              {@render actionPicker(config.allowlistAction, (a) => patch({ allowlistAction: a }), m.tam_wave_action())}
              {#if tagActionMeta(config.allowlistAction).needsDuration}{@render durationField(config.allowlistDurationMin, (v) => patch({ allowlistDurationMin: v }), m.tam_wiz_duration())}{/if}
            </div>
            <Button size="sm" variant="secondary" icon="Plus" onclick={() => openWizard({ effect: 'ALLOW', targetType: 'SERVER' })}>{m.tam_allow_add()}</Button>
          {/snippet}
          {@render detection(m.tam_allow_title(), m.tam_allow_desc(), 'ShieldCheck', config.allowlistOnly, (v) => patch({ allowlistOnly: v }), allowBody)}
        </div>
      </SectionCard>

      <!-- Réglages -->
      <SectionCard title={m.tam_settings_title()} description={m.tam_settings_desc()} icon="Settings">
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-3">
            <label class="flex items-center justify-between gap-3 text-body-sm text-on-surface">{m.tam_on_join()}<ToggleSwitch checked={config.onJoin} onToggle={(v) => patch({ onJoin: v })} /></label>
            <label class="flex items-center justify-between gap-3 text-body-sm text-on-surface">{m.tam_on_change()}<ToggleSwitch checked={config.onTagChange} onToggle={(v) => patch({ onTagChange: v })} /></label>
            <div>
              <span class="text-xs font-medium text-on-surface-variant">{m.tam_alert_channel()}</span>
              <SearchableSelect options={channels} value={config.alertChannelId} placeholder={m.tam_alert_channel_ph()} on:change={(e) => patch({ alertChannelId: e.detail?.value ?? null })} />
              <p class="text-2xs text-on-surface-variant mt-1">{m.tam_alert_channel_hint()}</p>
            </div>
          </div>
          <div>
            <span class="text-xs font-medium text-on-surface-variant">{m.tam_exempt_roles()}</span>
            <MultiSelect options={roles} bind:values={exemptRoles} />
            <p class="text-2xs text-on-surface-variant mt-1">{m.tam_exempt_hint()}</p>
          </div>
        </div>
      </SectionCard>

      <!-- Journal -->
      <SectionCard title={m.tam_journal_title()} description={m.tam_journal_desc()} icon="ListChecks" flush>
        {#if events.length === 0}
          <div class="p-5"><EmptyState icon="ShieldCheck" title={m.tam_journal_empty()} description={m.tam_journal_empty_desc()} reason="all-clear" /></div>
        {:else}
          <ul class="divide-y divide-outline-variant/20">
            {#each events as ev (ev.id)}
              {@const st = tagStatusMeta(ev.status)}
              <li class="flex flex-wrap items-center gap-3 px-5 py-3">
                <button type="button" class="text-body-sm font-medium text-on-surface hover:text-primary truncate max-w-48" onclick={() => memberCaseModal.show(ev.userId, ev.userTag ?? ev.userId)}>{ev.userTag ?? ev.userId}</button>
                <span class="rounded-md border border-outline-variant/40 px-1.5 py-0.5 text-2xs font-mono text-on-surface">{ev.tag ?? '?'}</span>
                <span class="text-xs text-on-surface-variant">{tagTriggerLabel(ev.trigger)}</span>
                <span class="text-xs text-on-surface">→ {tagActionMeta(ev.action).label}</span>
                <span class="rounded-full border px-2 py-0.5 text-2xs font-medium {st.className}">{st.label}</span>
                {#if ev.status === 'PENDING' && ev.dueAt && ev.escalateAction}
                  <span class="text-2xs text-warning">{m.tam_pending_until({ action: tagActionMeta(ev.escalateAction).label, date: when(ev.dueAt) })}</span>
                {/if}
                <span class="ml-auto text-2xs text-on-surface-variant">{when(ev.createdAt)}</span>
              </li>
            {/each}
          </ul>
          {#if eventsMore}<div class="p-3 text-center"><Button size="sm" variant="ghost" onclick={loadMoreEvents}>{m.tam_load_more()}</Button></div>{/if}
        {/if}
      </SectionCard>

      {#if data.waves.length > 0}
        <SectionCard title={m.tam_waves_title()} description={m.tam_waves_desc()} icon="Zap">
          <ul class="space-y-2">
            {#each data.waves as wave (wave.id)}
              <li class="flex flex-wrap items-center gap-3 rounded-xl border border-outline-variant/30 px-3 py-2 text-xs">
                <span class="font-medium text-on-surface">{wave.kind === 'ARRIVALS' ? m.tam_wave_arrivals({ count: wave.userIds.length }) : m.tam_wave_adopt({ count: wave.userIds.length })}</span>
                <span class="rounded-md border border-outline-variant/40 px-1.5 py-0.5 font-mono text-on-surface">{wave.tag ?? '?'}</span>
                <span class="text-on-surface-variant">{WAVE_STATUS[wave.status]()}</span>
                <span class="ml-auto text-on-surface-variant">{when(wave.createdAt)}</span>
              </li>
            {/each}
          </ul>
        </SectionCard>
      {/if}
    </div>
  {/if}
</ModulePage>

<TagRuleWizard bind:open={wizardOpen} initial={wizardInitial} editing={wizardEditing} jailConfigured={data?.jailConfigured ?? true} onSaved={onRuleSaved} />

<Modal bind:open={scanOpen} title={m.tam_scan_title()} subtitle={m.tam_scan_subtitle()} size="lg" onClose={() => (scanOpen = false)}>
  {#if scanning}
    <p class="text-sm text-on-surface-variant py-8 text-center">{m.tam_wiz_previewing()}</p>
  {:else if scan}
    <div class="space-y-4">
      <div class="grid grid-cols-3 gap-2">
        <div class="rounded-xl bg-surface-container p-3"><p class="text-2xs text-on-surface-variant">{m.tam_wiz_prev_scanned()}</p><p class="text-lg font-semibold text-on-surface">{scan.scanned}</p></div>
        <div class="rounded-xl bg-surface-container p-3"><p class="text-2xs text-on-surface-variant">{m.tam_wiz_prev_with_tag()}</p><p class="text-lg font-semibold text-on-surface">{scan.withTag}</p></div>
        <div class="rounded-xl p-3 {scan.total > 0 ? 'bg-primary/10' : 'bg-surface-container'}"><p class="text-2xs text-on-surface-variant">{m.tam_wiz_prev_matching()}</p><p class="text-lg font-semibold text-on-surface">{scan.total}</p></div>
      </div>
      {#if scan.total === 0}
        <Callout variant="info">{m.tam_scan_none()}</Callout>
      {:else}
        <ul class="divide-y divide-outline-variant/20 max-h-80 overflow-y-auto rounded-xl border border-outline-variant/30">
          {#each scan.matches as match (match.userId)}
            <li class="flex items-center gap-3 px-3 py-2">
              <img src={match.avatarUrl} alt="" class="w-7 h-7 rounded-full" loading="lazy" />
              <span class="min-w-0 flex-1">
                <span class="block text-xs font-medium text-on-surface truncate">{match.displayName}</span>
                <span class="block text-2xs text-on-surface-variant truncate">{match.tag} · {match.ruleName ?? tagTriggerLabel(match.trigger)}</span>
              </span>
              <span class="text-xs text-on-surface">{tagActionMeta(match.action).label}</span>
            </li>
          {/each}
        </ul>
        {#if config?.testMode}<Callout variant="info">{m.tam_scan_test_note()}</Callout>{/if}
      {/if}
    </div>
  {:else}
    <Callout variant="warning">{m.tam_wiz_prev_failed()}</Callout>
  {/if}
  {#snippet footer()}
    <div class="flex justify-end gap-2 w-full">
      <Button variant="ghost" onclick={() => (scanOpen = false)}>{m.tam_close()}</Button>
      <Button icon="Play" onclick={applyScan} disabled={applying || !scan?.total} disabledReason={!scan?.total ? m.tam_scan_none() : undefined}>{m.tam_scan_apply()}</Button>
    </div>
  {/snippet}
</Modal>
