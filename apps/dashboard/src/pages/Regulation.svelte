<script lang="ts">
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmojiText from '../lib/components/EmojiText.svelte';
  import { stripCustomEmoji } from '../lib/emojiParser';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import {
    createRegulationArticle,
    deleteRegulationArticle,
    publishRegulation,
    reorderRegulationArticles,
    updateRegulationSettings,
    updateRegulationArticle,
    fetchFeatureConfigurations,
    updateFeatureConfiguration
  } from '../lib/api';
  import { onMount } from 'svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
import EmojiPicker from '../lib/components/EmojiPicker.svelte';


  type RegulationRule = {
    id: string;
    title: string;
    description: string;
    emoji: string | null;
    sortOrder: number;
    enabled: boolean;
  };

  type DraftMode = 'create' | 'edit';

  let feedbackMessage = $state('');
  let feedbackIsError = $state(false);
  let saving = $state(false);
  let publishing = $state(false);
  let deleteConfirmationText = $state('');
  let deletingRule = $state<RegulationRule | null>(null);
  let modalOpen = $state(false);
  let modalMode = $state<DraftMode>('create');
  let draftId = $state<string | null>(null);
  let draftTitle = $state('');
  let draftDescription = $state('');
  let draftEmoji = $state('');
  let draftEnabled = $state(true);
  let draggingRuleId = $state<string | null>(null);
  let dragOverRuleId = $state<string | null>(null);
  let reordering = $state(false);
  const saveAction = createAsyncActionState();
  let showVerificationWarningModal = $state(false);
  const guildState = $derived(dashboardStore.state as any);

  let featureConfig = $state<any>(null);

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
  const publicationStatusLabel = $derived(
    guildState.regulationMessageId ? m.regulation_msg_published() : m.regulation_msg_none()
  );

  function resetDraft() {
    draftId = null;
    draftTitle = '';
    draftDescription = '';
    draftEmoji = '';
    draftEnabled = true;
  }

  function normalizeRuleOrder(rules: RegulationRule[]) {
    return rules.map((rule, index) => ({
      ...rule,
      sortOrder: index,
    }));
  }

  function moveRule(rules: RegulationRule[], sourceId: string, targetId: string, placeAfter: boolean) {
    const nextRules = [...rules];
    const sourceIndex = nextRules.findIndex((rule) => rule.id === sourceId);
    if (sourceIndex === -1) return null;

    const [movedRule] = nextRules.splice(sourceIndex, 1);
    const targetIndex = nextRules.findIndex((rule) => rule.id === targetId);
    if (targetIndex === -1) return null;

    const insertAt = placeAfter ? targetIndex + 1 : targetIndex;
    nextRules.splice(insertAt, 0, movedRule);
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
    event.dataTransfer?.setDragImage?.(event.currentTarget as Element, 24, 24);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  function handleRuleDragEnd() {
    draggingRuleId = null;
    dragOverRuleId = null;
  }

  function handleRuleDragOver(event: DragEvent, ruleId: string) {
    if (!canManageSettings || !draggingRuleId) {
      return;
    }

    event.preventDefault();
    dragOverRuleId = ruleId;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  async function persistRuleOrder(nextRules: RegulationRule[]) {
    const previousRules = guildState.regulationRules || [];
    guildState.regulationRules = nextRules;
    reordering = true;

    try {
      const ok = await reorderRegulationArticles(nextRules.map((rule) => rule.id));
      if (!ok) {
        guildState.regulationRules = previousRules;
        feedbackMessage = m.regulation_reorder_failed();
        feedbackIsError = true;
        await dashboardStore.refresh();
        return;
      }

      await refreshState(m.regulation_reorder_success());
    } finally {
      reordering = false;
    }
  }

  async function moveRuleByOffset(ruleId: string, offset: number) {
    if (!canManageSettings || reordering) {
      return;
    }

    const sortedRules = [...regulationRules];
    const sourceIndex = sortedRules.findIndex((rule) => rule.id === ruleId);
    if (sourceIndex === -1) {
      return;
    }

    const targetIndex = sourceIndex + offset;
    if (targetIndex < 0 || targetIndex >= sortedRules.length) {
      return;
    }

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
    const targetElement = event.currentTarget as HTMLElement | null;
    const placeAfter = targetElement
      ? event.clientY > targetElement.getBoundingClientRect().top + targetElement.getBoundingClientRect().height / 2
      : false;
    const nextRules = moveRule(regulationRules, sourceRuleId, targetRuleId, placeAfter);

    handleRuleDragEnd();

    if (!nextRules) {
      return;
    }

    await persistRuleOrder(nextRules);
  }

  function openCreateModal() {
    feedbackMessage = '';
    feedbackIsError = false;
    modalMode = 'create';
    resetDraft();
    modalOpen = true;
  }

  function openEditModal(rule: RegulationRule) {
    feedbackMessage = '';
    feedbackIsError = false;
    modalMode = 'edit';
    draftId = rule.id;
    draftTitle = rule.title;
    draftDescription = rule.description;
    draftEmoji = rule.emoji ?? '';
    draftEnabled = rule.enabled;
    modalOpen = true;
  }

  function closeModal() {
    modalOpen = false;
  }

  function openDeleteModal(rule: RegulationRule) {
    feedbackMessage = '';
    feedbackIsError = false;
    deletingRule = rule;
    deleteConfirmationText = '';
  }

  function closeDeleteModal() {
    deletingRule = null;
    deleteConfirmationText = '';
  }

  function normalizeText(value: string) {
    return value.trim();
  }

  async function refreshState(message: string) {
    await dashboardStore.refresh();
    feedbackMessage = message;
    feedbackIsError = false;
  }

  async function saveRule() {
    feedbackMessage = '';
    feedbackIsError = false;

    const title = normalizeText(draftTitle);
    const description = normalizeText(draftDescription);
    const emoji = normalizeText(draftEmoji);

    if (!title || !description) {
      feedbackMessage = m.regulation_title_desc_required();
      feedbackIsError = true;
      return;
    }

    saving = true;
    try {
      const payload = {
        title,
        description,
        emoji: emoji || null,
        enabled: draftEnabled,
      };

      const ok = modalMode === 'create'
        ? await createRegulationArticle(payload)
        : draftId
          ? await updateRegulationArticle(draftId, payload)
          : false;

      if (!ok) {
        feedbackMessage = m.regulation_save_failed();
        feedbackIsError = true;
        return;
      }

      modalOpen = false;
      await refreshState(modalMode === 'create' ? m.regulation_article_added() : m.regulation_article_updated());
    } finally {
      saving = false;
    }
  }

  async function confirmDeleteRule() {
    if (!deletingRule) return;

    if (deleteConfirmationText.trim().toUpperCase() !== 'SUPPRIMER') {
      feedbackMessage = m.regulation_delete_cancelled();
      feedbackIsError = true;
      return;
    }

    const rule = deletingRule;
    deletingRule = null;
    deleteConfirmationText = '';
    saving = true;

    try {
      const ok = await deleteRegulationArticle(rule.id);
      if (!ok) {
        feedbackMessage = m.regulation_delete_failed();
        feedbackIsError = true;
        return;
      }

      await refreshState(m.regulation_article_deleted());
    } finally {
      saving = false;
    }
  }

  async function handlePublishRegulation() {
    feedbackMessage = '';
    feedbackIsError = false;

    if (!guildState.regulationChannelId && !guildState.configChannelId) {
      feedbackMessage = m.regulation_no_publish_channel();
      feedbackIsError = true;
      return;
    }

    publishing = true;
    try {
      await publishRegulation();
      await refreshState(guildState.regulationMessageId ? m.regulation_republished() : m.regulation_published());
    } catch (error) {
      feedbackMessage = error instanceof Error ? error.message : m.regulation_publish_failed();
      feedbackIsError = true;
    } finally {
      publishing = false;
    }
  }

  const availableRoles = $derived(guildState.discordRoles || []);

  async function handleRegulationChannelChange(channelId: string | null) {
    feedbackMessage = '';
    feedbackIsError = false;
    const previousChannelId = guildState.regulationChannelId;
    saving = true;

    try {
      const ok = await saveAction.run(async () => {
        const resOk = await updateRegulationSettings({ regulationChannelId: channelId });
        if (!resOk) throw new Error(m.common_error());

        if (featureConfig) {
          await updateFeatureConfiguration('regulation', { channelId });
          featureConfig.channelId = channelId;
        }
        return true;
      }, { successMessage: channelId ? m.regulation_channel_updated() : m.regulation_channel_removed() });
      
      if (!ok) {
        guildState.regulationChannelId = previousChannelId;
      } else {
        guildState.regulationChannelId = channelId ?? '';
      }
    } catch (err) {
      guildState.regulationChannelId = previousChannelId;
    } finally {
      saving = false;
    }
  }

  async function handleVerificationToggle(enabled: boolean) {
    if (!canManageSettings) return;

    if (enabled) {
      guildState.regulationVerificationEnabled = true;
      showVerificationWarningModal = true;
      return;
    }

    await saveVerificationSettings(false);
  }

  async function confirmVerificationToggle() {
    showVerificationWarningModal = false;
    await saveVerificationSettings(true);
  }

  function cancelVerificationToggle() {
    showVerificationWarningModal = false;
    guildState.regulationVerificationEnabled = false;
  }

  async function saveVerificationSettings(enabled: boolean) {
    const previous = enabled ? false : true;
    guildState.regulationVerificationEnabled = enabled;
    saving = true;
    try {
      const ok = await saveAction.run(async () => {
        const resOk = await updateRegulationSettings({ regulationVerificationEnabled: enabled });
        if (!resOk) throw new Error(m.common_error());
        return true;
      }, { successMessage: enabled ? m.regulation_verif_enabled_toast() : m.regulation_verif_disabled_toast() });
      
      if (!ok) {
        guildState.regulationVerificationEnabled = previous;
      }
    } catch (err) {
      guildState.regulationVerificationEnabled = previous;
    } finally {
      saving = false;
    }
  }

  async function handleRegulationRoleChange(roleId: string | null) {
    if (!canManageSettings) return;
    const previous = guildState.regulationRoleId;
    guildState.regulationRoleId = roleId ?? '';
    saving = true;
    try {
      const ok = await saveAction.run(async () => {
        const resOk = await updateRegulationSettings({ regulationRoleId: roleId });
        if (!resOk) throw new Error(m.common_error());
        return true;
      }, { successMessage: m.regulation_role_updated_toast() });
      
      if (!ok) {
        guildState.regulationRoleId = previous;
      }
    } catch (err) {
      guildState.regulationRoleId = previous;
    } finally {
      saving = false;
    }
  }

  async function handleLockToggle(enabled: boolean) {
    if (!canManageSettings) return;
    const previous = guildState.regulationLockEnabled;
    guildState.regulationLockEnabled = enabled;
    saving = true;
    try {
      const ok = await saveAction.run(async () => {
        const resOk = await updateRegulationSettings({ regulationLockEnabled: enabled });
        if (!resOk) throw new Error(m.common_error());
        return true;
      }, { successMessage: enabled ? m.regulation_lock_enabled_toast() : m.regulation_lock_disabled_toast() });

      if (!ok) {
        guildState.regulationLockEnabled = previous;
      }
    } catch (err) {
      guildState.regulationLockEnabled = previous;
    } finally {
      saving = false;
    }
  }
</script>

<ModulePage 
  title={m.regulation_page_title()} 
  description={m.regulation_page_desc()} 
  icon="gavel"
  featureKey="regulation"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <RefreshButton
        onClick={() => dashboardStore.refresh()}
        loading={guildState.loading}
        label={m.regulation_refresh_btn()}
        className="flex items-center gap-2 px-6 py-3 rounded-xl text-xs font-medium bg-on-surface text-surface shadow-sm  transition-all duration-300"
        iconClass="text-lg"
      />
    </div>
  {/snippet}

  {#if guildState.regulationRules}
    <div class="flex items-center gap-4 text-xs font-bold text-on-surface-variant/40 bg-surface-container-low/40 px-4 py-2 rounded-xl border border-outline-variant/5 mb-8">
       <div class="flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
          <span>{m.regulation_stats_active({ active: activeRules.length, total: regulationRules.length })}</span>
       </div>
       <span class="w-px h-3 bg-outline-variant/20"></span>
       <span>{m.regulation_last_sync({ time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) })}</span>
    </div>
  {/if}

  <!-- Config & Stats -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    <div class="bg-surface-container-low/30 p-6 rounded-xl border border-outline-variant/10 space-y-4">
      <div class="flex items-center gap-3">
        <div class="bg-primary/10 p-2 rounded-xl text-primary">
          <Papicon icon="Hash" size={18} />
        </div>
        <h3 class="text-sm font-semibold text-on-surface">{m.regulation_section_channel()}</h3>
      </div>
      <div class="space-y-4">
        <div class="flex flex-col gap-2 p-4 bg-surface-container-high/40 rounded-lg border border-outline-variant/10">
          <span class="text-body-sm font-medium text-on-surface-variant">{m.regulation_channel_current()}</span>
          <span class="text-sm font-semibold text-primary bg-primary/5 px-3 py-2 rounded-lg break-all">{regulationChannelLabel}</span>
        </div>
        {#if canManageSettings}
          <div class="space-y-2" data-guide="regulation-channel">
            <SearchableSelect id="regulation-channel-select" bind:value={guildState.regulationChannelId} options={(guildState.discordChannels || []).map((channel: any) => ({ id: channel.id, name: channelDisplayName(channel) }))} placeholder={m.regulation_channel_default_ph()} className="w-full" on:change={(e) => handleRegulationChannelChange(e.detail.value)} disabled={saving || guildState.loading || guildState.discordChannels.length === 0} />
          </div>
        {/if}
      </div>
    </div>

    <div class="bg-surface-container-low/30 p-6 rounded-xl border border-outline-variant/10 space-y-4">
      <div class="flex items-center gap-3">
        <div class="bg-secondary/10 p-2 rounded-xl text-secondary">
          <Papicon icon="PaperPlaneTilt" size={18} />
        </div>
        <h3 class="text-sm font-semibold text-on-surface">{m.regulation_section_msg_status()}</h3>
      </div>
      <div class="space-y-4">
        <div class="p-4 bg-surface-container-high/40 rounded-lg border border-outline-variant/10">
          <p class="text-sm font-bold text-on-surface leading-relaxed">{publicationStatusLabel}</p>
          <p class="mt-1 text-xs font-medium text-on-surface-variant">{m.regulation_msg_sync_active()}</p>
          <p class="mt-3 text-2xs text-on-surface-variant leading-tight">{m.regulation_staff_notice_hint()}</p>
        </div>
        <ActionButton
          onClick={handlePublishRegulation}
          disabled={!canManageSettings || publishing || reordering || regulationRules.length === 0}
          variant="primary"
          className="w-full py-4 rounded-xl "
          icon={guildState.regulationMessageId ? 'ArrowsCounterClockwise' : 'Megaphone'}
          label={publishing ? m.regulation_btn_publishing() : guildState.regulationMessageId ? m.regulation_btn_republish() : m.regulation_btn_publish()}
        />
      </div>
    </div>

    <div class="bg-surface-container-low/30 p-6 rounded-xl border border-outline-variant/10 space-y-4">
      <div class="flex items-center gap-3">
        <div class="bg-primary/10 p-2 rounded-xl text-primary">
          <Papicon icon="ShieldCheck" size={18} />
        </div>
        <h3 class="text-sm font-semibold text-on-surface">{m.regulation_section_verification()}</h3>
      </div>
      <div class="space-y-4">
        {#if canManageSettings}
          <div class="flex items-center justify-between p-4 bg-surface-container-high/40 rounded-lg border border-outline-variant/10">
            <div class="space-y-0.5">
              <span class="text-sm font-bold text-on-surface">{m.regulation_verif_title()}</span>
              <p class="text-2xs text-on-surface-variant leading-tight">{m.regulation_verif_desc()}</p>
            </div>
            <ToggleSwitch 
              checked={guildState.regulationVerificationEnabled}
              disabled={saving || guildState.loading}
              onToggle={() => handleVerificationToggle(!guildState.regulationVerificationEnabled)}
            />
          </div>

          {#if guildState.regulationVerificationEnabled}
            <div class="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
              <label class="field-label" for="regulation-role-select">{m.regulation_verif_role_label()}</label>
              <SearchableSelect 
                id="regulation-role-select" 
                bind:value={guildState.regulationRoleId} 
                options={availableRoles.map((role: any) => ({ id: role.id, name: `@${role.name}` }))} 
                placeholder={m.regulation_verif_role_ph()} 
                className="w-full" 
                on:change={(e) => handleRegulationRoleChange(e.detail.value)} 
                disabled={saving || guildState.loading} 
              />
            </div>

            <div class="flex items-center justify-between p-4 bg-surface-container-high/40 rounded-lg border border-outline-variant/10 animate-in fade-in slide-in-from-top-1 duration-200">
              <div class="space-y-0.5">
                <span class="text-sm font-bold text-on-surface">{m.regulation_lock_title()}</span>
                <p class="text-2xs text-on-surface-variant leading-tight">{m.regulation_lock_desc()}</p>
              </div>
              <ToggleSwitch 
                checked={guildState.regulationLockEnabled}
                disabled={saving || guildState.loading}
                onToggle={() => handleLockToggle(!guildState.regulationLockEnabled)}
              />
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </div>

  {#if featureConfig && canManageSettings}
    <div class="bg-surface-container-low/30 p-8 rounded-xl border border-outline-variant/10 mt-8 animate-in fade-in duration-500">
      <RolePermissionSettings 
        featureKey="regulation" 
        roleAccess={featureConfig.roleAccessByRole} 
      />
    </div>
  {/if}


  <!-- Articles List -->
  <div class="space-y-6">
    <div class="flex items-center justify-between px-2">
      <div class="flex items-center gap-3">
        <div class="bg-primary p-2 rounded-xl text-on-primary ">
          <Papicon icon="ListBullets" size={20} />
        </div>
        <div>
          <h3 class="text-xl font-semibold text-on-surface tracking-tight">{m.regulation_articles_header()}</h3>
          <p class="text-xs font-semibold text-on-surface-variant">{m.regulation_articles_sub()}</p>
        </div>
      </div>
      <ActionButton
        onclick={openCreateModal}
        onClick={openCreateModal}
        disabled={!canManageSettings || reordering}
        variant="primary"
        icon="Plus"
        label={m.regulation_new_article_btn()}
        className="px-6 py-3 rounded-xl shadow-sm shadow-primary/20"
      />
    </div>

    {#if feedbackMessage}
      <div class="animate-in zoom-in-95 duration-300 rounded-lg px-6 py-4 text-sm font-bold flex items-center gap-3 {feedbackIsError ? 'bg-error-container/10 text-error border border-error/20' : 'bg-primary/5 text-primary border border-primary/20'}">
        <Papicon icon={feedbackIsError ? "WarningCircle" : "CheckCircle"} size={20} />
        {feedbackMessage}
      </div>
    {/if}

    <div class="grid grid-cols-1 gap-4">
      {#if guildState.loading && regulationRules.length === 0}
        {#each Array(4) as _}
          <div class="h-32 rounded-xl bg-surface-container-low/30 border border-outline-variant/10 animate-pulse"></div>
        {/each}
      {:else if regulationRules.length === 0}
        <div class="flex flex-col items-center justify-center py-20 bg-surface-container-low/20 rounded-xl border border-dashed border-outline-variant/20 text-center space-y-4">
          <div class="bg-surface-container-high p-6 rounded-full text-on-surface-variant/20">
            <Papicon icon="Files" size={48} />
          </div>
          <div class="space-y-1">
            <h4 class="text-xl font-semibold text-on-surface">{m.regulation_no_articles_title()}</h4>
            <p class="text-on-surface-variant max-w-sm">{m.regulation_no_articles_desc()}</p>
          </div>
          <ActionButton onclick={openCreateModal} onClick={openCreateModal} disabled={!canManageSettings} variant="primary" icon="Plus" label={m.regulation_create_first_btn()} className="px-8 py-3 rounded-xl" />
        </div>
      {:else}
        {#each regulationRules as rule}
          <article
            class="group relative overflow-hidden bg-surface-container-low/40 hover:bg-surface-container-low/60 rounded-xl border border-outline-variant/10 p-6 md:p-8 transition-all duration-500 {draggingRuleId === rule.id ? 'opacity-40 scale-95' : 'hover:scale-[1.01] hover:shadow-sm hover:shadow-surface-container-high/50'} {dragOverRuleId === rule.id ? 'ring-2 ring-primary border-primary/30' : ''} {canManageSettings ? 'cursor-grab active:cursor-grabbing' : ''}"
            draggable={canManageSettings}
            ondragstart={(event) => handleRuleDragStart(event, rule.id)}
            ondragend={handleRuleDragEnd}
            ondragover={(event) => handleRuleDragOver(event, rule.id)}
            ondrop={(event) => handleRuleDrop(event, rule.id)}
          >
            <div class="relative flex flex-col md:flex-row gap-8 items-start">
              <!-- Sort & Status -->
              <div class="flex md:flex-col items-center gap-3 shrink-0">
                <div class="w-12 h-12 rounded-lg bg-surface-container-high flex items-center justify-center text-xl font-semibold text-primary border border-outline-variant/10 shadow-inner">
                  {rule.sortOrder + 1}
                </div>
                <div class="h-px w-4 md:w-px md:h-8 bg-outline-variant/20"></div>
                <div class="p-2 rounded-xl {rule.enabled ? 'bg-primary/10 text-primary' : 'bg-surface-container-high text-on-surface-variant/40'}">
                  <Papicon icon={rule.enabled ? "CheckCircle" : "Prohibit"} size={20} />
                </div>
              </div>

              <!-- Content -->
              <div class="flex-1 space-y-4">
                <div class="space-y-2">
                  <div class="flex items-center gap-3">
                    {#if rule.emoji}
                      <EmojiText value={rule.emoji} class="text-2xl drop-shadow-sm shrink-0" />
                    {/if}
                    <h4 class="text-2xl font-semibold text-on-surface tracking-tight group-hover:text-primary transition-colors"><EmojiText value={rule.title} /></h4>
                  </div>
                  <p class="text-on-surface-variant text-base leading-relaxed whitespace-pre-wrap max-w-4xl"><EmojiText value={rule.description} /></p>
                </div>
                
                <div class="flex flex-wrap items-center gap-2">
                   <span class="px-3 py-1 rounded-lg bg-surface-container-high/60 text-xs font-medium text-on-surface-variant border border-outline-variant/5">
                    {rule.enabled ? m.regulation_badge_visible() : m.regulation_badge_hidden()}
                   </span>
                   {#if canManageSettings}
                    <span class="px-3 py-1 rounded-lg bg-primary/5 text-xs font-medium text-primary/60 border border-primary/10 animate-pulse">
                      {m.regulation_drag_hint()}
                    </span>
                   {/if}
                </div>
              </div>

              <!-- Actions -->
              {#if canManageSettings}
                <div class="flex items-center gap-2 self-end md:self-start bg-surface-container-high/40 p-2 rounded-lg border border-outline-variant/10 opacity-0 group-hover:opacity-100 transition-all duration-300 -translate-y-2 group-hover:translate-y-0">
                  <button 
                    onclick={() => openEditModal(rule)}
                    class="p-3 rounded-xl hover:bg-primary/10 hover:text-primary text-on-surface-variant transition-all"
                    title={m.common_edit()}
                  >
                    <Papicon icon="PencilSimple" size={18} />
                  </button>
                  <button 
                    onclick={() => openDeleteModal(rule)}
                    class="p-3 rounded-xl hover:bg-error-container/20 hover:text-error text-on-surface-variant transition-all"
                    title={m.reaction_roles_delete_tooltip()}
                  >
                    <Papicon icon="Trash" size={18} />
                  </button>
                </div>
              {/if}
            </div>
            
            <!-- Mobile Sort Controls (Fallbacks) -->
            {#if canManageSettings}
              <div class="flex md:hidden items-center justify-center gap-4 mt-6 pt-6 border-t border-outline-variant/10">
                 <button 
                  onclick={() => moveRuleByOffset(rule.id, -1)}
                  disabled={reordering || rule.sortOrder === 0}
                  class="flex-1 py-3 rounded-xl bg-surface-container-high/60 text-body-sm font-medium disabled:opacity-30"
                 >
                  {m.regulation_move_up()}
                 </button>
                 <button 
                  onclick={() => moveRuleByOffset(rule.id, 1)}
                  disabled={reordering || rule.sortOrder === regulationRules.length - 1}
                  class="flex-1 py-3 rounded-xl bg-surface-container-high/60 text-body-sm font-medium disabled:opacity-30"
                 >
                  {m.regulation_move_down()}
                 </button>
              </div>
            {/if}
          </article>
        {/each}
      {/if}
    </div>
  </div>

{#if modalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop bg-surface/30" role="dialog" aria-modal="true" aria-labelledby="regulation-modal-title" tabindex="-1" onclick={closeModal}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-panel modal-panel-lg space-y-6 rounded-xl! border border-outline-variant/10 shadow-sm bg-surface-container-low!" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-start justify-between gap-4">
        <div class="flex items-center gap-4">
          <div class="bg-primary/10 p-3 rounded-lg text-primary">
            <Papicon icon={modalMode === 'create' ? "PlusCircle" : "PencilSimple"} size={24} />
          </div>
          <div>
            <p class="text-xs font-semibold text-on-surface-variant">{modalMode === 'create' ? m.regulation_modal_config_badge() : m.regulation_modal_edit_badge()}</p>
            <h3 id="regulation-modal-title" class="text-2xl font-semibold text-on-surface tracking-tight">{modalMode === 'create' ? m.regulation_modal_title_add() : m.regulation_modal_title_edit()}</h3>
          </div>
        </div>
        <button onclick={closeModal} aria-label={m.common_close()} class="p-2 rounded-xl hover:bg-surface-container-high transition-colors text-on-surface-variant/40">
          <Papicon icon="X" size={20} />
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="space-y-2">
          <label for="regulation-title" class="field-label">{m.regulation_field_title_label()}</label>
          <FormInput id="regulation-title" type="text" bind:value={draftTitle} className="w-full rounded-lg px-5 py-4 bg-surface-container-high/60 border border-outline-variant/10 font-bold text-on-surface focus:ring-2 focus:ring-primary/40 transition-all" placeholder={m.regulation_field_title_ph()} />
        </div>
        <div class="space-y-2">
          <label for="regulation-emoji" class="field-label">{m.regulation_field_emoji_label()}</label>
          <div class="flex gap-2">
            <FormInput id="regulation-emoji" type="text" bind:value={draftEmoji} className="w-full rounded-lg px-5 py-4 bg-surface-container-high/60 border border-outline-variant/10 font-bold text-on-surface focus:ring-2 focus:ring-primary/40 transition-all" placeholder={m.regulation_field_emoji_ph()} />
            <EmojiPicker bind:value={draftEmoji} />
          </div>
        </div>
        <div class="md:col-span-2">
          <label class="group flex items-center gap-4 rounded-xl border border-outline-variant/10 bg-surface-container-high/40 p-6 cursor-pointer hover:bg-surface-container-high/60 transition-all">
            <div class="relative flex items-center justify-center">
              <input type="checkbox" bind:checked={draftEnabled} class="peer h-6 w-6 rounded-lg border-2 border-outline-variant/20 text-primary focus:ring-primary/40 transition-all appearance-none checked:bg-primary checked:border-primary" />
              <div class="absolute pointer-events-none opacity-0 peer-checked:opacity-100 transition-opacity text-on-primary">
                <Papicon icon="Check" size={14} />
              </div>
            </div>
            <div class="flex-1">
              <span class="block text-sm font-semibold text-on-surface tracking-tight">{m.regulation_field_active_title()}</span>
              <span class="block text-xs font-semibold text-on-surface-variant mt-0.5">{m.regulation_field_active_desc()}</span>
            </div>
          </label>
        </div>
      </div>

      <div class="space-y-2">
        <label for="regulation-description" class="field-label">{m.regulation_field_desc_label()}</label>
        <FormTextarea
          id="regulation-description"
          bind:value={draftDescription}
          rows={5}
          className="w-full rounded-xl px-6 py-5 bg-surface-container-high/60 border border-outline-variant/10 font-medium text-on-surface leading-relaxed focus:ring-2 focus:ring-primary/40 transition-all"
          placeholder={m.regulation_field_desc_ph()}
        />
      </div>

      <!-- Preview -->
      <div class="relative overflow-hidden rounded-xl bg-primary/5 p-6 border border-primary/10">
        <div class="absolute top-0 right-0 p-4 opacity-10 text-primary">
           <Papicon icon="Eye" size={48} />
        </div>
        <p class="text-xs font-semibold text-primary/60 mb-3">{m.regulation_preview_badge()}</p>
        <div class="flex items-center gap-3 mb-2">
          {#if draftEmoji}
            <EmojiText value={draftEmoji} class="text-xl shrink-0" />
          {/if}
          <p class="text-lg font-semibold text-on-surface tracking-tight min-w-0 wrap-break-word"><EmojiText value={draftTitle || m.regulation_preview_title_ph()} /></p>
        </div>
        <p class="whitespace-pre-wrap text-sm font-medium text-on-surface-variant leading-relaxed"><EmojiText value={draftDescription || m.regulation_preview_desc_ph()} /></p>
      </div>

      <div class="flex items-center justify-end gap-3 pt-2">
        <button 
          onclick={closeModal} 
          class="px-8 py-4 rounded-xl text-body-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-all"
        >
          {m.common_cancel()}
        </button>
        <ActionButton
          onClick={saveRule}
          variant="primary"
          className="px-10 py-4 rounded-xl shadow-sm shadow-primary/20"
          label={saving ? m.regulation_save_saving() : modalMode === 'create' ? m.regulation_save_create_btn() : m.regulation_save_edit_btn()}
          disabled={saving || !canManageSettings}
        />
      </div>
    </div>
  </div>
{/if}

{#if deletingRule}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop bg-error/10" role="dialog" aria-modal="true" aria-labelledby="delete-rule-title" tabindex="-1" onclick={closeDeleteModal}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-panel max-w-lg rounded-xl! border border-error/20 shadow-sm bg-surface! space-y-6 p-8" onclick={(e) => e.stopPropagation()}>
      <div class="flex flex-col items-center text-center space-y-4">
        <div class="bg-error/10 p-5 rounded-full text-error">
          <Papicon icon="Warning" size={40} />
        </div>
        <div>
          <p class="text-xs font-semibold text-error/60">{m.regulation_delete_modal_badge()}</p>
          <h3 id="delete-rule-title" class="text-2xl font-semibold text-on-surface tracking-tight">{m.regulation_delete_modal_title()}</h3>
        </div>
        <p class="text-sm font-bold text-on-surface-variant leading-relaxed">
          {m.regulation_delete_modal_desc({ rule: [stripCustomEmoji(deletingRule.emoji), deletingRule.title].filter(Boolean).join(' ') })}
        </p>
      </div>

      <div class="space-y-3">
        <label for="delete-rule-confirm" class="field-label">{m.regulation_delete_confirm_prompt({ keyword: 'SUPPRIMER' })}</label>
        <FormInput
          id="delete-rule-confirm"
          type="text"
          bind:value={deleteConfirmationText}
          autocomplete="off"
          className="w-full rounded-lg px-5 py-4 bg-surface-container-high/60 border border-error/10 font-semibold text-center text-on-surface focus:ring-2 focus:ring-error/40 transition-all"
          placeholder="SUPPRIMER"
        />
      </div>

      <div class="flex flex-col gap-2">
        <ActionButton onClick={confirmDeleteRule} variant="danger" label={saving ? m.regulation_delete_deleting() : m.regulation_delete_confirm_btn()} disabled={saving} className="w-full py-4 rounded-xl shadow-sm shadow-error/20" />
        <button onclick={closeDeleteModal} class="w-full py-4 rounded-xl text-body-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-all">{m.common_cancel()}</button>
      </div>
    </div>
  </div>
{/if}

{#if showVerificationWarningModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop bg-warning/10" role="dialog" aria-modal="true" aria-labelledby="verification-warning-title" tabindex="-1" onclick={cancelVerificationToggle}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-panel max-w-lg rounded-xl! border border-warning/20 shadow-sm bg-surface! space-y-6 p-8" onclick={(e) => e.stopPropagation()}>
      <div class="flex flex-col items-center text-center space-y-4">
        <div class="bg-warning/10 p-5 rounded-full text-warning">
          <Papicon icon="Warning" size={40} />
        </div>
        <div>
          <p class="text-xs font-semibold text-warning/60">{m.regulation_warning_modal_badge()}</p>
          <h3 id="verification-warning-title" class="text-2xl font-semibold text-on-surface tracking-tight">{m.regulation_warning_modal_title()}</h3>
        </div>
        <p class="text-sm font-bold text-on-surface-variant leading-relaxed">
          {m.regulation_warning_modal_desc1({ everyone: '@everyone' })}
        </p>
        <p class="text-xs font-semibold text-on-surface-variant leading-relaxed">
          {m.regulation_warning_modal_desc2({ everyone: '@everyone' })}
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <button
          onclick={confirmVerificationToggle}
          class="w-full py-4 bg-amber-500 text-white rounded-xl text-body-sm font-medium active:scale-95 transition-all shadow-sm"
        >
          {m.regulation_warning_modal_confirm()}
        </button>
        <button onclick={cancelVerificationToggle} class="w-full py-4 rounded-xl text-body-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-all">{m.common_cancel()}</button>
      </div>
    </div>
  </div>
{/if}
</ModulePage>
