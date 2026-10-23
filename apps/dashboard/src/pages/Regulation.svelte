<script lang="ts">
  import { m } from '../lib/i18n';
  import { router } from 'tinro';
  import { channelDisplayName } from '../lib/channelUtils';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, Button, Callout, SectionCard, Modal, EmptyState, ToggleSwitch } from '../lib/components/ui';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmojiText from '../lib/components/EmojiText.svelte';
  import EmojiPicker from '../lib/components/EmojiPicker.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import CaptchaFields from '../lib/components/security/CaptchaFields.svelte';
  import IdentityVerificationPanel from '../lib/components/security/IdentityVerificationPanel.svelte';
  import { stripCustomEmoji } from '../lib/emojiParser';
  import {
    createRegulationArticle,
    deleteRegulationArticle,
    publishRegulation,
    reorderRegulationArticles,
    updateRegulationSettings,
    updateRegulationArticle,
    fetchFeatureConfigurations,
    updateFeatureConfiguration,
    fetchRaidProtection,
    updateRaidProtection,
  } from '../lib/api';
  import { onMount } from 'svelte';

  type RegulationRule = {
    id: string;
    title: string;
    description: string;
    emoji: string | null;
    sortOrder: number;
    enabled: boolean;
  };

  const regulationTabs = ['articles', 'verification', 'acces'] as const;
  type RegulationTab = (typeof regulationTabs)[number];
  const DEFAULT_TAB: RegulationTab = 'articles';
  let activeTab = $state<RegulationTab>(DEFAULT_TAB);

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/regulation', regulationTabs, DEFAULT_TAB) as RegulationTab;
  });

  let saving = $state(false);
  let publishing = $state(false);
  let reordering = $state(false);
  let modalOpen = $state(false);
  let modalMode = $state<'create' | 'edit'>('create');
  let draftId = $state<string | null>(null);
  let draftTitle = $state('');
  let draftDescription = $state('');
  let draftEmoji = $state('');
  let draftEnabled = $state(true);
  let draggingRuleId = $state<string | null>(null);
  let dragOverRuleId = $state<string | null>(null);
  let featureConfig = $state<any>(null);
  const guildState = $derived(dashboardStore.state as any);

  onMount(async () => {
    try {
      await dashboardStore.refresh();
      const configs = await fetchFeatureConfigurations();
      featureConfig = configs?.features?.find((c: any) => c.featureKey === 'regulation') || null;
    } catch (err) {
      console.error('Error fetching regulation config:', err);
    }
  });

  const canManageSettings = $derived(
    !!guildState.featureAccess?.regulation?.canConfigure
      || !!guildState.access?.canManageSettings
  );
  const regulationRules = $derived(
    [...(guildState.regulationRules || [])]
      .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title, 'fr'))
  );
  const activeRules = $derived(regulationRules.filter((rule) => rule.enabled));
  const regulationChannelLabel = $derived(
    (() => {
      const isFallback = !guildState.regulationChannelId;
      const channelId = guildState.regulationChannelId || guildState.configChannelId;
      if (!channelId) return m.regulation_no_channel();
      const channel = (guildState.discordChannels || []).find((c: any) => c.id === channelId);
      const name = channel ? channelDisplayName(channel) : m.regulation_channel_hash({ channelId });
      return name + (isFallback ? ` ${m.regulation_default_config_suffix()}` : '');
    })()
  );
  const availableRoles = $derived(guildState.discordRoles || []);

  function moduleActive(id: string) {
    return (guildState.modules as any[] | undefined)?.find((mod) => mod.id === id)?.status === 'active';
  }

  // ── Articles ──

  function normalizeRuleOrder(rules: RegulationRule[]) {
    return rules.map((rule, index) => ({ ...rule, sortOrder: index }));
  }

  function moveRule(rules: RegulationRule[], sourceId: string, targetId: string, placeAfter: boolean) {
    const nextRules = [...rules];
    const sourceIndex = nextRules.findIndex((rule) => rule.id === sourceId);
    if (sourceIndex === -1) return null;

    const [movedRule] = nextRules.splice(sourceIndex, 1);
    const targetIndex = nextRules.findIndex((rule) => rule.id === targetId);
    if (targetIndex === -1) return null;

    nextRules.splice(placeAfter ? targetIndex + 1 : targetIndex, 0, movedRule);
    return normalizeRuleOrder(nextRules);
  }

  function handleRuleDragStart(event: DragEvent, ruleId: string) {
    if (!canManageSettings) {
      event.preventDefault();
      return;
    }
    draggingRuleId = ruleId;
    dragOverRuleId = ruleId;
    event.dataTransfer?.setData('text/plain', ruleId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function handleRuleDragEnd() {
    draggingRuleId = null;
    dragOverRuleId = null;
  }

  function handleRuleDragOver(event: DragEvent, ruleId: string) {
    if (!canManageSettings || !draggingRuleId) return;
    event.preventDefault();
    dragOverRuleId = ruleId;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  async function persistRuleOrder(nextRules: RegulationRule[]) {
    const previousRules = guildState.regulationRules || [];
    guildState.regulationRules = nextRules;
    reordering = true;

    try {
      const ok = await reorderRegulationArticles(nextRules.map((rule) => rule.id));
      if (!ok) {
        guildState.regulationRules = previousRules;
        toast.error(m.regulation_reorder_failed());
        await dashboardStore.refresh();
        return;
      }
      await dashboardStore.refresh();
      toast.success(m.regulation_reorder_success());
    } finally {
      reordering = false;
    }
  }

  async function moveRuleByOffset(ruleId: string, offset: number) {
    if (!canManageSettings || reordering) return;

    const sortedRules = [...regulationRules];
    const sourceIndex = sortedRules.findIndex((rule) => rule.id === ruleId);
    const targetIndex = sourceIndex + offset;
    if (sourceIndex === -1 || targetIndex < 0 || targetIndex >= sortedRules.length) return;

    const [movedRule] = sortedRules.splice(sourceIndex, 1);
    sortedRules.splice(targetIndex, 0, movedRule);
    await persistRuleOrder(normalizeRuleOrder(sortedRules));
  }

  async function handleRuleDrop(event: DragEvent, targetRuleId: string) {
    if (!canManageSettings || !draggingRuleId) {
      handleRuleDragEnd();
      return;
    }

    event.preventDefault();
    const sourceRuleId = draggingRuleId;
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    const placeAfter = rect ? event.clientY > rect.top + rect.height / 2 : false;
    const nextRules = moveRule(regulationRules, sourceRuleId, targetRuleId, placeAfter);

    handleRuleDragEnd();
    if (nextRules) await persistRuleOrder(nextRules);
  }

  function openCreateModal() {
    modalMode = 'create';
    draftId = null;
    draftTitle = '';
    draftDescription = '';
    draftEmoji = '';
    draftEnabled = true;
    modalOpen = true;
  }

  function openEditModal(rule: RegulationRule) {
    modalMode = 'edit';
    draftId = rule.id;
    draftTitle = rule.title;
    draftDescription = rule.description;
    draftEmoji = rule.emoji ?? '';
    draftEnabled = rule.enabled;
    modalOpen = true;
  }

  async function saveRule() {
    const title = draftTitle.trim();
    const description = draftDescription.trim();
    const emoji = draftEmoji.trim();

    if (!title || !description) {
      toast.error(m.regulation_title_desc_required());
      return;
    }

    saving = true;
    try {
      const payload = { title, description, emoji: emoji || null, enabled: draftEnabled };
      const ok = modalMode === 'create'
        ? await createRegulationArticle(payload)
        : draftId
          ? await updateRegulationArticle(draftId, payload)
          : false;

      if (!ok) {
        toast.error(m.regulation_save_failed());
        return;
      }

      modalOpen = false;
      await dashboardStore.refresh();
      toast.success(modalMode === 'create' ? m.regulation_article_added() : m.regulation_article_updated());
    } finally {
      saving = false;
    }
  }

  async function toggleRuleVisibility(rule: RegulationRule, enabled: boolean) {
    if (!canManageSettings || saving) return;
    saving = true;
    try {
      const ok = await updateRegulationArticle(rule.id, {
        title: rule.title,
        description: rule.description,
        emoji: rule.emoji,
        enabled,
      });
      if (!ok) {
        toast.error(m.regulation_save_failed());
        return;
      }
      await dashboardStore.refresh();
      toast.success(m.regulation_article_visibility_updated());
    } finally {
      saving = false;
    }
  }

  async function deleteRule(rule: RegulationRule) {
    const label = [stripCustomEmoji(rule.emoji), rule.title].filter(Boolean).join(' ');
    if (!(await confirmDialog.danger(m.regulation_delete_modal_title(), m.regulation_delete_modal_desc({ rule: label })))) return;

    saving = true;
    try {
      const ok = await deleteRegulationArticle(rule.id);
      if (!ok) {
        toast.error(m.regulation_delete_failed());
        return;
      }
      await dashboardStore.refresh();
      toast.success(m.regulation_article_deleted());
    } finally {
      saving = false;
    }
  }

  // ── Publication ──

  async function handlePublishRegulation() {
    if (!guildState.regulationChannelId && !guildState.configChannelId) {
      toast.error(m.regulation_no_publish_channel());
      return;
    }

    const wasPublished = !!guildState.regulationMessageId;
    publishing = true;
    try {
      await publishRegulation();
      await dashboardStore.refresh();
      toast.success(wasPublished ? m.regulation_republished() : m.regulation_published());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : m.regulation_publish_failed());
    } finally {
      publishing = false;
    }
  }

  /** Enregistre un reglage du reglement, et revient en arriere si l'API refuse. */
  async function saveSetting(field: string, value: unknown, successMessage: string) {
    const previous = guildState[field];
    guildState[field] = value;
    saving = true;
    try {
      const ok = await updateRegulationSettings({ [field]: value });
      if (!ok) throw new Error(m.common_error());
      toast.success(successMessage);
      return true;
    } catch {
      guildState[field] = previous;
      return false;
    } finally {
      saving = false;
    }
  }

  async function handleRegulationChannelChange(channelId: string | null) {
    const ok = await saveSetting(
      'regulationChannelId',
      channelId,
      channelId ? m.regulation_channel_updated() : m.regulation_channel_removed(),
    );
    if (ok && featureConfig) {
      await updateFeatureConfiguration('regulation', { channelId });
      featureConfig.channelId = channelId;
    }
    if (ok) guildState.regulationChannelId = channelId ?? '';
  }

  // ── Verification : acceptation du reglement ──

  async function handleAcceptToggle(enabled: boolean) {
    if (!canManageSettings) return;
    if (enabled && !(await confirmDialog.ask({
      title: m.regulation_warning_modal_title(),
      description: `${m.regulation_warning_modal_desc1({ everyone: '@everyone' })} ${m.regulation_warning_modal_desc2({ everyone: '@everyone' })}`,
      confirmLabel: m.regulation_warning_modal_confirm(),
      variant: 'warning',
    }))) return;

    await saveSetting(
      'regulationVerificationEnabled',
      enabled,
      enabled ? m.regulation_verif_enabled_toast() : m.regulation_verif_disabled_toast(),
    );
  }

  // ── Verification : captcha d'entree (config partagee avec l'Anti-raid) ──

  const CAPTCHA_KEYS = [
    'captchaEnabled', 'captchaMode', 'captchaChannelId', 'captchaUnverifiedRoleId', 'captchaVerifiedRoleId',
    'captchaLogChannelId', 'captchaVoiceChannelId', 'captchaVoiceLocale', 'captchaVoiceQueueLimit',
    'captchaTimeoutMinutes', 'captchaMaxAttempts', 'captchaFailAction',
  ];
  const pickCaptcha = (config: Record<string, any>) => Object.fromEntries(CAPTCHA_KEYS.map((key) => [key, config?.[key] ?? null]));

  let captcha = $state<Record<string, any> | null>(null);
  let captchaSaved = $state('');
  let savingCaptcha = $state(false);
  let captchaFailed = $state(false);
  const captchaAvailable = $derived(moduleActive('raid_protection'));
  const captchaDirty = $derived(captcha !== null && JSON.stringify(captcha) !== captchaSaved);
  const captchaOn = $derived(captchaSaved ? !!JSON.parse(captchaSaved).captchaEnabled : false);

  let identityOn = $state(false);
  const identityAvailable = $derived(moduleActive('double_accounts'));

  async function loadCaptcha() {
    try {
      const res = await fetchRaidProtection();
      captcha = pickCaptcha(res?.config ?? {});
      captchaSaved = JSON.stringify(captcha);
    } catch {
      captchaFailed = true;
    }
  }

  async function saveCaptcha() {
    if (!captcha || !captchaDirty || savingCaptcha) return;
    savingCaptcha = true;
    try {
      const res = await updateRaidProtection({ ...captcha });
      captcha = pickCaptcha(res?.config ?? captcha);
      captchaSaved = JSON.stringify(captcha);
      toast.success(m.regulation_captcha_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_error());
    } finally {
      savingCaptcha = false;
    }
  }

  // Chargee seulement a l'ouverture de l'onglet, et seulement si le module tourne :
  // sa route se ferme avec lui.
  $effect(() => {
    if (activeTab === 'verification' && captchaAvailable && captcha === null && !captchaFailed) void loadCaptcha();
  });

  const flowSteps = $derived([
    { id: 'etape-captcha', title: m.regulation_step_captcha(), desc: m.regulation_step_captcha_desc(), icon: 'UserCheck', available: captchaAvailable, on: captchaOn },
    { id: 'etape-identite', title: m.regulation_step_identity(), desc: m.regulation_step_identity_desc(), icon: 'ShieldCheck', available: identityAvailable, on: identityOn },
    { id: 'etape-reglement', title: m.regulation_step_rules(), desc: m.regulation_step_rules_desc(), icon: 'gavel', available: true, on: !!guildState.regulationVerificationEnabled },
  ]);
</script>

<ModulePage
  title={m.regulation_page_title()}
  description={m.regulation_page_desc()}
  icon="gavel"
  featureKey="regulation"
>
  {#snippet actions()}
    <RefreshButton onclick={() => dashboardStore.refresh()} loading={guildState.loading} label={m.regulation_refresh_btn()} />
  {/snippet}

  {#if canManageSettings}
    <Tabs
      label={m.regulation_page_title()}
      tabs={pageTabItems('/regulation', (id) => id !== 'acces' || !!featureConfig)}
      active={activeTab}
      onchange={(id) => gotoTab('/regulation', id, DEFAULT_TAB)}
    />
  {/if}

  {#if activeTab === 'articles' || !canManageSettings}
    <!-- Publication : ou part le reglement, et le bouton qui l'y envoie -->
    <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/40 p-4 flex flex-col md:flex-row md:items-end gap-4">
      <div class="flex-1 min-w-0 space-y-1">
        <p class="flex items-center gap-2 text-body-sm font-medium text-on-surface">
          <span class="w-2 h-2 rounded-full shrink-0 {guildState.regulationMessageId ? 'bg-success' : 'bg-outline-variant'}"></span>
          {guildState.regulationMessageId ? m.regulation_pub_published({ channel: regulationChannelLabel }) : m.regulation_pub_unpublished()}
        </p>
        <p class="text-xs text-on-surface-variant">{m.regulation_staff_notice_hint()}</p>
      </div>
      {#if canManageSettings}
        <div class="md:w-72 space-y-1" data-guide="regulation-channel">
          <label class="text-xs font-medium text-on-surface-variant" for="regulation-channel-select">{m.regulation_pub_channel_label()}</label>
          <SearchableSelect
            id="regulation-channel-select"
            bind:value={guildState.regulationChannelId}
            options={(guildState.discordChannels || []).map((channel: any) => ({ id: channel.id, name: channelDisplayName(channel) }))}
            placeholder={m.regulation_channel_default_ph()}
            className="w-full"
            on:change={(e) => handleRegulationChannelChange(e.detail.value)}
            disabled={saving || guildState.loading || (guildState.discordChannels || []).length === 0}
          />
        </div>
        <Button
          variant="primary"
          icon={guildState.regulationMessageId ? 'ArrowsCounterClockwise' : 'Megaphone'}
          loading={publishing}
          disabled={reordering || regulationRules.length === 0}
          disabledReason={regulationRules.length === 0 ? m.regulation_no_articles_title() : ''}
          onclick={handlePublishRegulation}
        >
          {publishing ? m.regulation_btn_publishing() : guildState.regulationMessageId ? m.regulation_btn_republish() : m.regulation_btn_publish()}
        </Button>
      {/if}
    </div>

    <!-- Articles -->
    <div class="flex items-center justify-between gap-4 mt-8 mb-3">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-on-surface">{m.regulation_articles_header()}</h3>
        {#if regulationRules.length > 0}
          <p class="text-xs text-on-surface-variant">{m.regulation_stats_active({ active: activeRules.length, total: regulationRules.length })}</p>
        {/if}
      </div>
      {#if canManageSettings && regulationRules.length > 0}
        <Button variant="primary" icon="Plus" disabled={reordering} onclick={openCreateModal}>{m.regulation_new_article_btn()}</Button>
      {/if}
    </div>

    {#if guildState.loading && regulationRules.length === 0}
      <div class="space-y-2">
        {#each Array(4) as _}
          <div class="h-16 rounded-xl bg-surface-container-low/30 border border-outline-variant/10 animate-pulse"></div>
        {/each}
      </div>
    {:else if regulationRules.length === 0}
      <EmptyState
        icon="Files"
        title={m.regulation_no_articles_title()}
        description={m.regulation_no_articles_desc()}
        actionLabel={canManageSettings ? m.regulation_create_first_btn() : undefined}
        actionIcon="Plus"
        onAction={canManageSettings ? openCreateModal : undefined}
      />
    {:else}
      <ol class="space-y-2">
        {#each regulationRules as rule, index (rule.id)}
          <li
            class="group flex items-start gap-3 rounded-xl border bg-surface-container-low/40 px-3 py-3 transition-colors
              {dragOverRuleId === rule.id && draggingRuleId !== rule.id ? 'border-primary/60' : 'border-outline-variant/20 hover:border-outline-variant/40'}
              {draggingRuleId === rule.id ? 'opacity-40' : ''}"
            draggable={canManageSettings && !reordering}
            ondragstart={(event) => handleRuleDragStart(event, rule.id)}
            ondragend={handleRuleDragEnd}
            ondragover={(event) => handleRuleDragOver(event, rule.id)}
            ondrop={(event) => handleRuleDrop(event, rule.id)}
          >
            {#if canManageSettings}
              <span class="hidden md:flex pt-1.5 text-on-surface-variant cursor-grab active:cursor-grabbing" title={m.regulation_drag_hint()}>
                <Papicon icon="GripVertical" size={16} />
              </span>
            {/if}
            <span class="w-7 h-7 mt-0.5 shrink-0 rounded-lg bg-surface-container-high flex items-center justify-center text-xs font-semibold text-on-surface tabular-nums">
              {index + 1}
            </span>

            <button
              type="button"
              class="flex-1 min-w-0 text-left rounded-lg disabled:cursor-default"
              disabled={!canManageSettings}
              aria-label={m.regulation_article_open_edit({ n: index + 1 })}
              onclick={() => openEditModal(rule)}
            >
              <span class="flex items-center gap-2 min-w-0">
                {#if rule.emoji}<EmojiText value={rule.emoji} class="shrink-0" />{/if}
                <span class="text-body-sm font-semibold text-on-surface truncate {rule.enabled ? '' : 'opacity-60'}"><EmojiText value={rule.title} /></span>
                {#if !rule.enabled}
                  <span class="shrink-0 px-2 py-0.5 rounded-md bg-surface-container-high text-2xs font-medium text-on-surface-variant">{m.regulation_badge_hidden()}</span>
                {/if}
              </span>
              <span class="block mt-1 text-xs text-on-surface-variant leading-relaxed line-clamp-2 whitespace-pre-wrap"><EmojiText value={rule.description} /></span>
            </button>

            {#if canManageSettings}
              <div class="flex items-center gap-1 shrink-0">
                <ToggleSwitch
                  size="sm"
                  checked={rule.enabled}
                  disabled={saving}
                  ariaLabel={m.regulation_article_visible_toggle()}
                  onToggle={(v) => toggleRuleVisibility(rule, v)}
                />
                <Button variant="ghost" size="sm" icon="ArrowUp" aria-label={m.regulation_move_up()} disabled={reordering || index === 0} onclick={() => moveRuleByOffset(rule.id, -1)} />
                <Button variant="ghost" size="sm" icon="ArrowDown" aria-label={m.regulation_move_down()} disabled={reordering || index === regulationRules.length - 1} onclick={() => moveRuleByOffset(rule.id, 1)} />
                <Button variant="ghost" size="sm" icon="Trash" aria-label={m.common_delete()} disabled={saving} onclick={() => deleteRule(rule)} />
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}

  {#if activeTab === 'verification' && canManageSettings}
    <div class="space-y-6">
      <!-- Parcours d'arrivee : les trois etapes, dans l'ordre ou le membre les traverse -->
      <div>
        <h3 class="text-base font-semibold text-on-surface">{m.regulation_flow_title()}</h3>
        <p class="text-xs text-on-surface-variant mt-0.5">{m.regulation_flow_desc()}</p>
        <ol class="mt-3 grid gap-2 sm:grid-cols-3">
          {#each flowSteps as step, index (step.id)}
            <li>
              <button
                type="button"
                class="w-full h-full text-left rounded-xl border border-outline-variant/20 bg-surface-container-low/40 hover:border-outline-variant/50 px-4 py-3 transition-colors"
                onclick={() => document.getElementById(step.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="w-6 h-6 shrink-0 rounded-full bg-surface-container-high flex items-center justify-center text-xs font-semibold text-on-surface tabular-nums">{index + 1}</span>
                    <span class="text-body-sm font-medium text-on-surface truncate">{step.title}</span>
                  </span>
                  <span class="shrink-0 px-2 py-0.5 rounded-md text-2xs font-medium
                    {!step.available ? 'bg-surface-container-high text-on-surface-variant' : step.on ? 'bg-success/15 text-success' : 'bg-surface-container-high text-on-surface-variant'}">
                    {!step.available ? m.regulation_step_unavailable() : step.on ? m.regulation_step_on() : m.regulation_step_off()}
                  </span>
                </span>
                <span class="block mt-1.5 text-xs text-on-surface-variant leading-relaxed">{step.desc}</span>
              </button>
            </li>
          {/each}
        </ol>
      </div>

      <Callout variant="info" icon="Info">{m.regulation_flow_shared()}</Callout>

      <!-- 1. Captcha d'entree -->
      <div id="etape-captcha" class="scroll-mt-24">
        <SectionCard title="1. {m.regulation_step_captcha()}" description={m.regulation_step_captcha_desc()} icon="UserCheck">
          {#snippet actions()}
            <Button variant="ghost" size="sm" iconRight="ExternalLink" href="/security/anti-raid/captcha">{m.regulation_open_antiraid()}</Button>
          {/snippet}
          {#if !captchaAvailable || captchaFailed}
            <Callout variant="warning">{m.regulation_captcha_unavailable()}</Callout>
          {:else if captcha}
            <CaptchaFields bind:config={captcha} />
            <div class="flex justify-end gap-2 mt-4">
              {#if captchaDirty}
                <Button variant="ghost" disabled={savingCaptcha} onclick={() => (captcha = JSON.parse(captchaSaved))}>{m.common_cancel()}</Button>
              {/if}
              <Button variant="primary" icon="Save" loading={savingCaptcha} disabled={!captchaDirty} onclick={saveCaptcha}>{m.common_save()}</Button>
            </div>
          {:else}
            <div class="h-40 rounded-xl bg-surface-container-low/30 animate-pulse"></div>
          {/if}
        </SectionCard>
      </div>

      <!-- 2. Verification d'identite -->
      <div id="etape-identite" class="scroll-mt-24">
        <SectionCard title="2. {m.regulation_step_identity()}" description={m.regulation_step_identity_desc()} icon="ShieldCheck">
          {#snippet actions()}
            <Button variant="ghost" size="sm" iconRight="ExternalLink" href="/security/accounts/verification">{m.regulation_open_accounts()}</Button>
          {/snippet}
          {#if identityAvailable}
            <IdentityVerificationPanel showWarnSettings={false} bind:enabled={identityOn} />
          {:else}
            <Callout variant="warning">{m.regulation_identity_unavailable()}</Callout>
          {/if}
        </SectionCard>
      </div>

      <!-- 3. Acceptation du reglement -->
      <div id="etape-reglement" class="scroll-mt-24">
        <SectionCard title="3. {m.regulation_step_rules()}" description={m.regulation_step_rules_desc()} icon="gavel">
          <div class="rounded-xl border border-outline-variant/20 divide-y divide-outline-variant/20">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <p class="text-body-sm font-medium text-on-surface">{m.regulation_accept_toggle()}</p>
                <p class="text-xs text-on-surface-variant mt-0.5">{m.regulation_accept_toggle_desc()}</p>
              </div>
              <ToggleSwitch
                checked={!!guildState.regulationVerificationEnabled}
                disabled={saving || guildState.loading}
                ariaLabel={m.regulation_accept_toggle()}
                onToggle={(v) => handleAcceptToggle(v)}
              />
            </div>

            {#if guildState.regulationVerificationEnabled}
              <div class="px-4 py-3 space-y-1">
                <label class="text-body-sm font-medium text-on-surface" for="regulation-role-select">{m.regulation_verif_role_label()}</label>
                <p class="text-xs text-on-surface-variant">{m.regulation_accept_role_desc()}</p>
                <SearchableSelect
                  id="regulation-role-select"
                  bind:value={guildState.regulationRoleId}
                  options={availableRoles.map((role: any) => ({ id: role.id, name: `@${role.name}` }))}
                  placeholder={m.regulation_verif_role_ph()}
                  className="w-full mt-1"
                  on:change={(e) => saveSetting('regulationRoleId', e.detail.value ?? '', m.regulation_role_updated_toast())}
                  disabled={saving || guildState.loading}
                />
              </div>

              <div class="flex items-center justify-between gap-4 px-4 py-3">
                <div class="min-w-0">
                  <p class="text-body-sm font-medium text-on-surface">{m.regulation_lock_desc()}</p>
                  <p class="text-xs text-on-surface-variant mt-0.5">{m.regulation_lock_row_desc()}</p>
                </div>
                <ToggleSwitch
                  checked={!!guildState.regulationLockEnabled}
                  disabled={saving || guildState.loading}
                  ariaLabel={m.regulation_lock_desc()}
                  onToggle={(v) => saveSetting('regulationLockEnabled', v, v ? m.regulation_lock_enabled_toast() : m.regulation_lock_disabled_toast())}
                />
              </div>
            {/if}
          </div>
          <p class="text-xs text-on-surface-variant mt-3">{m.regulation_accept_republish_hint()}</p>
        </SectionCard>
      </div>
    </div>
  {/if}

  {#if activeTab === 'acces' && canManageSettings && featureConfig}
    <SectionCard>
      <RolePermissionSettings featureKey="regulation" roleAccess={featureConfig.roleAccessByRole} description={m.regulation_access_desc()} />
    </SectionCard>
  {/if}

  <Modal
    open={modalOpen}
    onClose={() => (modalOpen = false)}
    title={modalMode === 'create' ? m.regulation_modal_title_add() : m.regulation_modal_title_edit()}
    size="lg"
  >
    <div class="space-y-5">
      <div class="grid grid-cols-1 md:grid-cols-[1fr_14rem] gap-4">
        <div class="space-y-1.5">
          <label for="regulation-title" class="field-label">{m.regulation_field_title_label()}</label>
          <FormInput id="regulation-title" type="text" bind:value={draftTitle} className="w-full" placeholder={m.regulation_field_title_ph()} />
        </div>
        <div class="space-y-1.5">
          <label for="regulation-emoji" class="field-label">{m.regulation_field_emoji_label()}</label>
          <div class="flex gap-2">
            <FormInput id="regulation-emoji" type="text" bind:value={draftEmoji} className="w-full" placeholder={m.regulation_field_emoji_ph()} />
            <EmojiPicker bind:value={draftEmoji} />
          </div>
        </div>
      </div>

      <div class="space-y-1.5">
        <label for="regulation-description" class="field-label">{m.regulation_field_desc_label()}</label>
        <FormTextarea id="regulation-description" bind:value={draftDescription} rows={5} className="w-full" placeholder={m.regulation_field_desc_ph()} />
      </div>

      <div class="flex items-center justify-between gap-4 rounded-xl border border-outline-variant/20 px-4 py-3">
        <div class="min-w-0">
          <p class="text-body-sm font-medium text-on-surface">{m.regulation_field_active_title()}</p>
          <p class="text-xs text-on-surface-variant mt-0.5">{m.regulation_field_active_desc()}</p>
        </div>
        <ToggleSwitch checked={draftEnabled} ariaLabel={m.regulation_field_active_title()} onToggle={(v) => (draftEnabled = v)} />
      </div>

      <div class="rounded-xl border border-outline-variant/20 bg-surface-container-low/40 p-4">
        <p class="text-xs font-medium text-on-surface-variant mb-2">{m.regulation_preview_badge()}</p>
        <p class="flex items-center gap-2 text-body-sm font-semibold text-on-surface min-w-0 wrap-break-word">
          {#if draftEmoji}<EmojiText value={draftEmoji} class="shrink-0" />{/if}
          <EmojiText value={draftTitle || m.regulation_preview_title_ph()} />
        </p>
        <p class="mt-1 whitespace-pre-wrap text-xs text-on-surface-variant leading-relaxed"><EmojiText value={draftDescription || m.regulation_preview_desc_ph()} /></p>
      </div>
    </div>

    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" onclick={() => (modalOpen = false)}>{m.common_cancel()}</Button>
        <Button variant="primary" loading={saving} disabled={!canManageSettings} onclick={saveRule}>
          {modalMode === 'create' ? m.regulation_save_create_btn() : m.regulation_save_edit_btn()}
        </Button>
      </div>
    {/snippet}
  </Modal>
</ModulePage>
