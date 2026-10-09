<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { m } from '../lib/i18n';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs } from '../lib/components/ui';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import AntiSpamPanel from '../lib/components/AntiSpamPanel.svelte';
  import {
    fetchAutoModConfig,
    updateAutoModConfig
  } from '../lib/api';

  const actionState = createAsyncActionState();
  let loading = $state(false);
  const FILTER_TABS = ['bot', 'discord', 'security', 'behavioral', 'exceptions'] as const;
  let activeTab = $state<string>('bot');

  // L'onglet vit dans l'URL, comme ailleurs : la palette de commandes propose
  // /security/filters/discord, qui ouvrait jusqu'ici toujours le premier onglet.
  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/security/filters', FILTER_TABS, 'bot');
  });

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.automod?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  let isOwner = $state(false);

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  let config = $state({
    discordAutoModEnabled: true,
    spamEnabled: false,
    spamLimit: 5,
    spamIntervalSeconds: 5,
    spamAction: 'TIMEOUT',

    linksEnabled: false,
    linksAction: 'DELETE_AND_WARN',
    linksWhitelist: [] as string[],

    capsEnabled: false,
    capsThresholdPercent: 80,
    capsMinLength: 10,

    emojisEnabled: false,
    emojisLimit: 10,

    mentionsEnabled: false,
    mentionsLimit: 5,

    ghostPingEnabled: false,
    ghostPingAction: 'ALERT',

    antiEveryoneEnabled: false,
    antiEveryoneAction: 'DELETE_AND_WARN',

    customWordsEnabled: false,
    customWordsAction: 'BLOCK',
    customWords: [] as string[],
    customWordsAllowList: [] as string[],
    customWordsTimeoutSec: 60,

    profanityEnabled: false,
    profanityPresetProfanity: true,
    profanityPresetSexual: true,
    profanityPresetSlurs: true,
    profanityAction: 'BLOCK',
    profanityAllowList: [] as string[],
    profanityTimeoutSec: 60,

    inviteFilterEnabled: false,
    inviteFilterAction: 'BLOCK',
    inviteFilterAllowedGuilds: [] as string[],
    inviteFilterTimeoutSec: 60,

    antiBotEnabled: false,
    antiBotAction: 'KICK',
    antiBotBypassUsers: [] as string[],

    adminLockEnabled: false,
    adminLockAction: 'BLOCK',
    adminLockSecurityRoleIds: [] as string[],
    adminLockNotifyChannelId: null as string | null,

    burstSuspendEnabled: false,
    burstSuspendFastLimit: 5,
    burstSuspendFastWindowSec: 1,
    burstSuspendSlowLimit: 10,
    burstSuspendSlowWindowSec: 60,

    bypassRoles: [] as string[],
    bypassChannels: [] as string[]
  });

  // Snapshot of last-saved state
  let savedConfig = $state(JSON.parse(JSON.stringify({
    discordAutoModEnabled: true,
    spamEnabled: false, spamLimit: 5, spamIntervalSeconds: 5, spamAction: 'TIMEOUT',
    linksEnabled: false, linksAction: 'DELETE_AND_WARN', linksWhitelist: [],
    capsEnabled: false, capsThresholdPercent: 80, capsMinLength: 10,
    emojisEnabled: false, emojisLimit: 10,
    mentionsEnabled: false, mentionsLimit: 5,
    ghostPingEnabled: false, ghostPingAction: 'ALERT',
    antiEveryoneEnabled: false, antiEveryoneAction: 'DELETE_AND_WARN',
    customWordsEnabled: false, customWordsAction: 'BLOCK', customWords: [], customWordsAllowList: [], customWordsTimeoutSec: 60,
    profanityEnabled: false, profanityPresetProfanity: true, profanityPresetSexual: true, profanityPresetSlurs: true, profanityAction: 'BLOCK', profanityAllowList: [], profanityTimeoutSec: 60,
    inviteFilterEnabled: false, inviteFilterAction: 'BLOCK', inviteFilterAllowedGuilds: [], inviteFilterTimeoutSec: 60,
    antiBotEnabled: false, antiBotAction: 'KICK', antiBotBypassUsers: [],
    adminLockEnabled: false, adminLockAction: 'BLOCK', adminLockSecurityRoleIds: [], adminLockNotifyChannelId: null,
    burstSuspendEnabled: false, burstSuspendFastLimit: 5, burstSuspendFastWindowSec: 1, burstSuspendSlowLimit: 10, burstSuspendSlowWindowSec: 60,
    bypassRoles: [], bypassChannels: []
  })));

  $effect(() => {
    const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'automod',
          label: m.am_page_title(),
          onSave: () => handleSave(),
          onReset: () => {
            config = JSON.parse(JSON.stringify(savedConfig));
            whitelistInput = config.linksWhitelist.join('\n');
            customWordsInput = (config.customWords || []).join('\n');
            customWordsAllowInput = (config.customWordsAllowList || []).join('\n');
            profanityAllowInput = (config.profanityAllowList || []).join('\n');
            inviteAllowedGuildsInput = (config.inviteFilterAllowedGuilds || []).join('\n');
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('automod');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('automod');
  });

  // Helper local states for lists editing
  let whitelistInput = $state('');
  let customWordsInput = $state('');
  let customWordsAllowInput = $state('');
  let profanityAllowInput = $state('');
  let inviteAllowedGuildsInput = $state('');
  let selectedBypassRole = $state('');
  let selectedBypassChannel = $state('');
  let antiBotBypassInput = $state('');
  let selectedAdminLockSecurityRole = $state('');

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchAutoModConfig();
      if (res && res.config) {
        config = res.config;
        savedConfig = JSON.parse(JSON.stringify(res.config));
        whitelistInput = config.linksWhitelist.join('\n');
        customWordsInput = (config.customWords || []).join('\n');
        customWordsAllowInput = (config.customWordsAllowList || []).join('\n');
        profanityAllowInput = (config.profanityAllowList || []).join('\n');
        inviteAllowedGuildsInput = (config.inviteFilterAllowedGuilds || []).join('\n');
        if (res.isOwner) isOwner = true;
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  async function handleSave(): Promise<boolean> {
    if (!canManageSettings) return false;

    config.linksWhitelist = whitelistInput
      .split('\n').map(d => d.trim().toLowerCase()).filter(d => d.length > 0);
    config.customWords = customWordsInput
      .split('\n').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
    config.customWordsAllowList = customWordsAllowInput
      .split('\n').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
    config.profanityAllowList = profanityAllowInput
      .split('\n').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
    config.inviteFilterAllowedGuilds = inviteAllowedGuildsInput
      .split('\n').map(g => g.trim()).filter(g => g.length > 0);
    let success = false;
    let syncWarning: string | null = null;
    await actionState.run(async () => {
      if (JSON.stringify(config) !== JSON.stringify(savedConfig)) {
        const res = await updateAutoModConfig(config);
        if (!res || !res.config) throw new Error(m.am_err_save_automod());
        config = res.config;
        savedConfig = JSON.parse(JSON.stringify(res.config));
        syncWarning = res.syncWarning ?? null;
      }

      success = true;
      if (syncWarning) {
        throw new Error(syncWarning);
      }
      return true;
    }, { successMessage: m.am_toast_saved() });
    return success;
  }

  function addBypassRole() {
    if (!selectedBypassRole) return;
    if (!config.bypassRoles.includes(selectedBypassRole)) {
      config.bypassRoles = [...config.bypassRoles, selectedBypassRole];
    }
    selectedBypassRole = '';
  }

  function removeBypassRole(roleId: string) {
    config.bypassRoles = config.bypassRoles.filter(id => id !== roleId);
  }

  function addBypassChannel() {
    if (!selectedBypassChannel) return;
    if (!config.bypassChannels.includes(selectedBypassChannel)) {
      config.bypassChannels = [...config.bypassChannels, selectedBypassChannel];
    }
    selectedBypassChannel = '';
  }

  function removeBypassChannel(channelId: string) {
    config.bypassChannels = config.bypassChannels.filter(id => id !== channelId);
  }

  function getRoleName(roleId: string) {
    const role = availableRoles.find(r => r.id === roleId);
    return role ? `@${role.name}` : roleId;
  }

  function getChannelName(channelId: string) {
    const chan = availableChannels.find(c => c.id === channelId);
    return chan ? `#${chan.name}` : channelId;
  }

  function addAntiBotBypassUser() {
    const userId = antiBotBypassInput.trim();
    if (!userId || !/^\d{17,20}$/.test(userId)) return;
    if (!config.antiBotBypassUsers.includes(userId)) {
      config.antiBotBypassUsers = [...config.antiBotBypassUsers, userId];
    }
    antiBotBypassInput = '';
  }

  function removeAntiBotBypassUser(userId: string) {
    config.antiBotBypassUsers = config.antiBotBypassUsers.filter(id => id !== userId);
  }

  function addAdminLockSecurityRole() {
    if (!selectedAdminLockSecurityRole) return;
    if (!config.adminLockSecurityRoleIds.includes(selectedAdminLockSecurityRole)) {
      config.adminLockSecurityRoleIds = [...config.adminLockSecurityRoleIds, selectedAdminLockSecurityRole];
    }
    selectedAdminLockSecurityRole = '';
  }

  function removeAdminLockSecurityRole(roleId: string) {
    config.adminLockSecurityRoleIds = config.adminLockSecurityRoleIds.filter(id => id !== roleId);
  }

  // Les niveaux de protection vivent desormais dans Securite > Vue d'ensemble :
  // ils deplacent aussi les seuils anti-raid, que cette page n'affiche pas, et
  // les proposer ici laissait croire qu'ils ne touchaient qu'aux filtres.
</script>

<ModulePage
  title={m.am_page_title()}
  description={m.am_page_description()}
  icon="shield-alert"
  featureKey="automod"
>
  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <Skeleton height="400px" radius="2.5rem" />
      <Skeleton height="400px" radius="2.5rem" />
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else}
    <Tabs
      label={m.am_page_title()}
      tabs={pageTabItems('/security/filters')}
      active={activeTab}
      onchange={(id) => gotoTab('/security/filters', id, 'bot')}
    />

    {#if activeTab === 'bot'}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 animate-in fade-in duration-300">
        <!-- Left Column: Primary Chat Filters -->
        <div class="space-y-8">
          <!-- Anti-Spam -->
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6" data-tour="automod-spam">
            <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
              <h3 class="text-lg font-semibold flex items-center gap-3">
                <Papicon icon="Clock" size={20} class="text-primary" />
                {m.am_spam_title()}
              </h3>
              <ToggleSwitch 
                checked={config.spamEnabled} 
                onToggle={(v: boolean) => config.spamEnabled = v} 
                disabled={!canManageSettings}
              />
            </div>

            {#if config.spamEnabled}
              <div class="grid grid-cols-2 gap-4 animate-in fade-in duration-300" data-tour="automod-spam-threshold">
                <div class="space-y-1.5">
                  <label for="spamLimit" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_spam_max_messages()}</label>
                  <input 
                    id="spamLimit"
                    type="number" 
                    min="2"
                    max="20"
                    bind:value={config.spamLimit} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                    disabled={!canManageSettings}
                  />
                </div>

                <div class="space-y-1.5">
                  <label for="spamInterval" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_spam_interval()}</label>
                  <input 
                    id="spamInterval"
                    type="number" 
                    min="1"
                    max="30"
                    bind:value={config.spamIntervalSeconds} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                    disabled={!canManageSettings}
                  />
                </div>

                <div class="col-span-2 space-y-1.5">
                  <label for="spamAction" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_spam_action_label()}</label>
                  <select 
                    id="spamAction"
                    bind:value={config.spamAction}
                    class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  >
                    <option value="WARN">{m.am_action_warn()}</option>
                    <option value="TIMEOUT">{m.am_action_timeout_10()}</option>
                  </select>
                </div>
              </div>
            {/if}
          </section>

          <!-- Anti-Links & Discord invites -->
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
            <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
              <h3 class="text-lg font-semibold flex items-center gap-3">
                <Papicon icon="Link" size={20} class="text-secondary" />
                {m.am_links_title()}
              </h3>
              <ToggleSwitch 
                checked={config.linksEnabled} 
                onToggle={(v: boolean) => config.linksEnabled = v} 
                disabled={!canManageSettings}
              />
            </div>

            {#if config.linksEnabled}
              <div class="space-y-4 animate-in fade-in duration-300">
                <div class="space-y-1.5">
                  <label for="linksAction" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_links_action_label()}</label>
                  <select 
                    id="linksAction"
                    bind:value={config.linksAction}
                    class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  >
                    <option value="DELETE_AND_WARN">{m.am_action_delete_warn()}</option>
                    <option value="DELETE_ONLY">{m.am_action_delete_silent()}</option>
                  </select>
                </div>

                <div class="space-y-1.5">
                  <label for="whitelist" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_links_whitelist_label()}</label>
                  <textarea 
                    id="whitelist"
                    bind:value={whitelistInput} 
                    placeholder="github.com&#10;google.com"
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none h-24 resize-none font-mono"
                    disabled={!canManageSettings}
                  ></textarea>
                </div>
              </div>
            {/if}
          </section>

          <!-- Anti-Caps (MAJUSCULES) -->
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
            <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
              <h3 class="text-lg font-semibold flex items-center gap-3">
                <Papicon icon="Font" size={20} class="text-tertiary" />
                {m.am_caps_title()}
              </h3>
              <ToggleSwitch 
                checked={config.capsEnabled} 
                onToggle={(v: boolean) => config.capsEnabled = v} 
                disabled={!canManageSettings}
              />
            </div>

            {#if config.capsEnabled}
              <div class="grid grid-cols-2 gap-4 animate-in fade-in duration-300">
                <div class="space-y-1.5">
                  <label for="capsThresh" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_caps_threshold()}</label>
                  <input 
                    id="capsThresh"
                    type="number" 
                    min="20"
                    max="100"
                    bind:value={config.capsThresholdPercent} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                    disabled={!canManageSettings}
                  />
                </div>

                <div class="space-y-1.5">
                  <label for="capsMin" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_caps_minlength()}</label>
                  <input 
                    id="capsMin"
                    type="number" 
                    min="4"
                    bind:value={config.capsMinLength} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                    disabled={!canManageSettings}
                  />
                </div>
              </div>
            {/if}
          </section>
        </div>

        <!-- Right Column: Secondary & Mentions Filters -->
        <div class="space-y-8">
          <!-- Emojis & Mentions Spam (Grouped Side-by-Side in Sub-grid) -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6" data-tour="automod-more">
            <!-- Emojis Flood -->
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-4">
              <div class="flex items-center justify-between border-b border-outline-variant/15 pb-3">
                <h3 class="text-sm font-semibold flex items-center gap-2">
                  <Papicon icon="Emoji" size={18} class="text-warning" />
                  {m.am_emojis_title()}
                </h3>
                <ToggleSwitch 
                  checked={config.emojisEnabled} 
                  onToggle={(v: boolean) => config.emojisEnabled = v} 
                  disabled={!canManageSettings}
                />
              </div>

              {#if config.emojisEnabled}
                <div class="space-y-1.5 animate-in fade-in duration-300">
                  <label for="emojisLim" class="text-xs font-semibold text-on-surface-variant/60 ml-1">{m.am_limit_per_message()}</label>
                  <input 
                    id="emojisLim"
                    type="number" 
                    min="1"
                    bind:value={config.emojisLimit} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                    disabled={!canManageSettings}
                  />
                </div>
              {:else}
                <p class="text-xs text-on-surface-variant/50">{m.am_emojis_disabled()}</p>
              {/if}
            </section>

            <!-- Mentions Flood -->
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-4">
              <div class="flex items-center justify-between border-b border-outline-variant/15 pb-3">
                <h3 class="text-sm font-semibold flex items-center gap-2">
                  <Papicon icon="User" size={18} class="text-purple-400" />
                  {m.am_mentions_title()}
                </h3>
                <ToggleSwitch 
                  checked={config.mentionsEnabled} 
                  onToggle={(v: boolean) => config.mentionsEnabled = v} 
                  disabled={!canManageSettings}
                />
              </div>

              {#if config.mentionsEnabled}
                <div class="space-y-1.5 animate-in fade-in duration-300">
                  <label for="mentionsLim" class="text-xs font-semibold text-on-surface-variant/60 ml-1">{m.am_limit_per_message()}</label>
                  <input 
                    id="mentionsLim"
                    type="number" 
                    min="1"
                    bind:value={config.mentionsLimit} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                    disabled={!canManageSettings}
                  />
                </div>
              {:else}
                <p class="text-xs text-on-surface-variant/50">{m.am_mentions_disabled()}</p>
              {/if}
            </section>
          </div>

          <!-- Ghost Ping & Anti-Everyone (Grouped Side-by-Side in Sub-grid) -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <!-- Anti-Ghost Ping -->
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-4">
              <div class="flex items-center justify-between border-b border-outline-variant/15 pb-3">
                <h3 class="text-sm font-semibold flex items-center gap-2">
                  <Papicon icon="Ghost" size={18} class="text-error" />
                  {m.am_ghostping_title()}
                </h3>
                <ToggleSwitch 
                  checked={config.ghostPingEnabled} 
                  onToggle={(v: boolean) => config.ghostPingEnabled = v} 
                  disabled={!canManageSettings}
                />
              </div>

              <p class="text-2xs text-on-surface-variant/70 leading-relaxed">
                {m.am_ghostping_desc()}
                <span class="text-warning/90 font-medium block mt-1">{m.am_ghostping_cache_warning()}</span>
              </p>

              {#if config.ghostPingEnabled}
                <div class="space-y-1.5 animate-in fade-in duration-300">
                  <label for="ghostPingAction" class="text-xs font-semibold text-on-surface-variant/60 ml-1">{m.am_sanction_label()}</label>
                  <select 
                    id="ghostPingAction"
                    bind:value={config.ghostPingAction}
                    class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  >
                    <option value="ALERT">{m.am_ghostping_action_alert()}</option>
                    <option value="WARN">{m.am_ghostping_action_warn()}</option>
                  </select>
                </div>
              {/if}
            </section>

            <!-- Anti-Everyone/Here Troll -->
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-4">
              <div class="flex items-center justify-between border-b border-outline-variant/15 pb-3">
                <h3 class="text-sm font-semibold flex items-center gap-2">
                  <Papicon icon="ShieldAlert" size={18} class="text-error" />
                  {m.am_everyone_title()}
                </h3>
                <ToggleSwitch 
                  checked={config.antiEveryoneEnabled} 
                  onToggle={(v: boolean) => config.antiEveryoneEnabled = v} 
                  disabled={!canManageSettings}
                />
              </div>

              <p class="text-2xs text-on-surface-variant/70 leading-relaxed">
                {m.am_everyone_desc()}
              </p>

              {#if config.antiEveryoneEnabled}
                <div class="space-y-1.5 animate-in fade-in duration-300">
                  <label for="antiEveryoneAction" class="text-xs font-semibold text-on-surface-variant/60 ml-1">{m.am_sanction_label()}</label>
                  <select 
                    id="antiEveryoneAction"
                    bind:value={config.antiEveryoneAction}
                    class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  >
                    <option value="DELETE_ONLY">{m.am_everyone_delete_only()}</option>
                    <option value="DELETE_AND_WARN">{m.am_everyone_delete_warn()}</option>
                    <option value="TIMEOUT">{m.am_everyone_timeout()}</option>
                  </select>
                </div>
              {/if}
            </section>
          </div>
        </div>
      </div>

    {:else if activeTab === 'discord'}
      <div class="space-y-6 animate-in fade-in duration-300">
        <!-- Native Discord AutoMod Header -->
        <div class="bg-surface-container-low/40 p-6 rounded-xl border border-outline-variant/20 flex flex-col md:flex-row md:items-center gap-4">
          <div class="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center text-primary shrink-0">
            <Papicon icon="Shield" size={20} />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-on-surface flex items-center gap-2">
              {m.am_discord_native_title()}
            </h2>
            <p class="text-xs text-on-surface-variant/70 mt-1">
              {m.am_discord_native_desc()}
            </p>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <!-- Custom Words Filter -->
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
            <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
              <h3 class="text-lg font-semibold flex items-center gap-3">
                <Papicon icon="Filter" size={20} class="text-orange-400" />
                {m.am_customwords_title()}
              </h3>
              <ToggleSwitch
                checked={config.customWordsEnabled}
                onToggle={(v: boolean) => config.customWordsEnabled = v}
                disabled={!canManageSettings}
              />
            </div>

            <p class="text-xs text-on-surface-variant/70 leading-relaxed">
              {m.am_customwords_desc()}
            </p>

            {#if config.customWordsEnabled}
              <div class="space-y-4 animate-in fade-in duration-300">
                <div class="space-y-1.5">
                  <label for="customWordsAction" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_action_label()}</label>
                  <select
                    id="customWordsAction"
                    bind:value={config.customWordsAction}
                    class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  >
                    <option value="BLOCK">{m.am_action_block()}</option>
                    <option value="TIMEOUT">{m.am_action_block_timeout()}</option>
                    <option value="ALERT">{m.am_action_alert_only()}</option>
                  </select>
                </div>

                {#if config.customWordsAction === 'TIMEOUT'}
                  <div class="space-y-1.5">
                    <label for="customWordsTimeout" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_timeout_duration_sec()}</label>
                    <input
                      id="customWordsTimeout"
                      type="number" min="5" max="2419200"
                      bind:value={config.customWordsTimeoutSec}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                      disabled={!canManageSettings}
                    />
                  </div>
                {/if}

                <div class="space-y-1.5">
                  <label for="customWords" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_customwords_list_label()}</label>
                  <textarea
                    id="customWords"
                    bind:value={customWordsInput}
                    placeholder={m.am_ph_words_example()}
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none h-32 resize-none font-mono"
                    disabled={!canManageSettings}
                  ></textarea>
                  <p class="text-2xs text-on-surface-variant/50 ml-2">{m.am_customwords_wildcard_hint()}</p>
                </div>

                <div class="space-y-1.5">
                  <label for="customWordsAllow" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_customwords_allow_label()}</label>
                  <textarea
                    id="customWordsAllow"
                    bind:value={customWordsAllowInput}
                    placeholder="exception1&#10;exception2"
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none h-20 resize-none font-mono"
                    disabled={!canManageSettings}
                  ></textarea>
                </div>
              </div>
            {/if}
          </section>

          <!-- Profanity Filter -->
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
            <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
              <h3 class="text-lg font-semibold flex items-center gap-3">
                <Papicon icon="ShieldX" size={20} class="text-error" />
                {m.am_profanity_title()}
              </h3>
              <ToggleSwitch
                checked={config.profanityEnabled}
                onToggle={(v: boolean) => config.profanityEnabled = v}
                disabled={!canManageSettings}
              />
            </div>

            <p class="text-xs text-on-surface-variant/70 leading-relaxed">
              {m.am_profanity_desc()}
            </p>

            {#if config.profanityEnabled}
              <div class="space-y-4 animate-in fade-in duration-300">
                <div class="space-y-3">
                  <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_profanity_categories()}</span>
                  <div class="space-y-2">
                    <label class="flex items-center gap-3 p-3 bg-surface-container-high/30 rounded-lg cursor-pointer hover:bg-surface-container-high/50 transition-colors">
                      <input type="checkbox" bind:checked={config.profanityPresetProfanity} disabled={!canManageSettings} class="rounded border-outline-variant/30" />
                      <div>
                        <span class="text-sm font-medium">{m.am_profanity_cat_insults()}</span>
                        <p class="text-2xs text-on-surface-variant/50">{m.am_profanity_cat_insults_desc()}</p>
                      </div>
                    </label>
                    <label class="flex items-center gap-3 p-3 bg-surface-container-high/30 rounded-lg cursor-pointer hover:bg-surface-container-high/50 transition-colors">
                      <input type="checkbox" bind:checked={config.profanityPresetSexual} disabled={!canManageSettings} class="rounded border-outline-variant/30" />
                      <div>
                        <span class="text-sm font-medium">{m.am_profanity_cat_sexual()}</span>
                        <p class="text-2xs text-on-surface-variant/50">{m.am_profanity_cat_sexual_desc()}</p>
                      </div>
                    </label>
                    <label class="flex items-center gap-3 p-3 bg-surface-container-high/30 rounded-lg cursor-pointer hover:bg-surface-container-high/50 transition-colors">
                      <input type="checkbox" bind:checked={config.profanityPresetSlurs} disabled={!canManageSettings} class="rounded border-outline-variant/30" />
                      <div>
                        <span class="text-sm font-medium">{m.am_profanity_cat_slurs()}</span>
                        <p class="text-2xs text-on-surface-variant/50">{m.am_profanity_cat_slurs_desc()}</p>
                      </div>
                    </label>
                  </div>
                </div>

                <div class="space-y-1.5">
                  <label for="profanityAction" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_action_label()}</label>
                  <select
                    id="profanityAction"
                    bind:value={config.profanityAction}
                    class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  >
                    <option value="BLOCK">{m.am_action_block()}</option>
                    <option value="TIMEOUT">{m.am_action_block_timeout()}</option>
                    <option value="ALERT">{m.am_action_alert_only()}</option>
                  </select>
                </div>

                {#if config.profanityAction === 'TIMEOUT'}
                  <div class="space-y-1.5">
                    <label for="profanityTimeout" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_timeout_duration_sec()}</label>
                    <input
                      id="profanityTimeout"
                      type="number" min="5" max="2419200"
                      bind:value={config.profanityTimeoutSec}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                      disabled={!canManageSettings}
                    />
                  </div>
                {/if}

                <div class="space-y-1.5">
                  <label for="profanityAllow" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_profanity_allow_label()}</label>
                  <textarea
                    id="profanityAllow"
                    bind:value={profanityAllowInput}
                    placeholder={m.am_ph_profanity_allow_example()}
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none h-20 resize-none font-mono"
                    disabled={!canManageSettings}
                  ></textarea>
                </div>
              </div>
            {/if}
          </section>

          <!-- Invite Filter -->
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
            <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
              <h3 class="text-lg font-semibold flex items-center gap-3">
                <Papicon icon="UserPlus" size={20} class="text-indigo-400" />
                {m.am_invitefilter_title()}
              </h3>
              <ToggleSwitch
                checked={config.inviteFilterEnabled}
                onToggle={(v: boolean) => config.inviteFilterEnabled = v}
                disabled={!canManageSettings}
              />
            </div>

            <p class="text-xs text-on-surface-variant/70 leading-relaxed">
              {m.am_invitefilter_desc()}
            </p>

            {#if config.inviteFilterEnabled}
              <div class="space-y-4 animate-in fade-in duration-300">
                <div class="space-y-1.5">
                  <label for="inviteFilterAction" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_action_label()}</label>
                  <select
                    id="inviteFilterAction"
                    bind:value={config.inviteFilterAction}
                    class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  >
                    <option value="BLOCK">{m.am_action_block()}</option>
                    <option value="TIMEOUT">{m.am_action_block_timeout()}</option>
                    <option value="ALERT">{m.am_action_alert_only()}</option>
                  </select>
                </div>

                {#if config.inviteFilterAction === 'TIMEOUT'}
                  <div class="space-y-1.5">
                    <label for="inviteFilterTimeout" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_timeout_duration_sec()}</label>
                    <input
                      id="inviteFilterTimeout"
                      type="number" min="5" max="2419200"
                      bind:value={config.inviteFilterTimeoutSec}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                      disabled={!canManageSettings}
                    />
                  </div>
                {/if}

                <div class="space-y-1.5">
                  <label for="inviteAllowed" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_invitefilter_allowed_label()}</label>
                  <textarea
                    id="inviteAllowed"
                    bind:value={inviteAllowedGuildsInput}
                    placeholder={m.am_ph_invite_codes_example()}
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none h-20 resize-none font-mono"
                    disabled={!canManageSettings}
                  ></textarea>
                  <p class="text-2xs text-on-surface-variant/50 ml-2">{m.am_invitefilter_allowed_hint()}</p>
                </div>
              </div>
            {/if}
          </section>
        </div>
      </div>

    {:else if activeTab === 'security'}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 animate-in fade-in duration-300">
        <!-- Anti-Bot (Mode Sécurisé) -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
            <h3 class="text-lg font-semibold flex items-center gap-3">
              <Papicon icon="ShieldCheck" size={20} class="text-cyan-400" />
              {m.am_antibot_title()}
            </h3>
            <ToggleSwitch
              checked={config.antiBotEnabled}
              onToggle={(v: boolean) => config.antiBotEnabled = v}
              disabled={!isOwner}
            />
          </div>

          {#if !isOwner}
            <div class="p-3 bg-error/10 border border-error/20 rounded-lg">
              <p class="text-xs text-error/90 font-medium">
                {m.am_antibot_owner_only()}
              </p>
            </div>
          {/if}

          <p class="text-xs text-on-surface-variant/70 leading-relaxed">
            {m.am_antibot_desc()}
          </p>

          {#if config.antiBotEnabled}
            <div class="space-y-5 animate-in fade-in duration-300">
              <div class="space-y-1.5">
                <label for="antiBotAction" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_antibot_action_label()}</label>
                <select
                  id="antiBotAction"
                  bind:value={config.antiBotAction}
                  class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                  disabled={!isOwner}
                >
                  <option value="KICK">{m.am_antibot_kick()}</option>
                  <option value="BAN">{m.am_antibot_ban()}</option>
                </select>
              </div>

              <!-- Bypass users -->
              <div class="space-y-3 pt-2 border-t border-outline-variant/10">
                <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_antibot_bypass_title()}</span>
                <p class="text-xs text-on-surface-variant/50 ml-2">{m.am_antibot_bypass_desc()}</p>
                {#if isOwner}
                  <div class="flex gap-2">
                    <input
                      type="text"
                      bind:value={antiBotBypassInput}
                      placeholder={m.am_antibot_user_id_placeholder()}
                      class="flex-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/20 transition-all"
                      onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addAntiBotBypassUser(); } }}
                    />
                    <button
                      type="button"
                      onclick={addAntiBotBypassUser}
                      disabled={!antiBotBypassInput.trim() || !/^\d{17,20}$/.test(antiBotBypassInput.trim())}
                      class="px-4 py-2.5 bg-outline-variant/20 hover:bg-outline-variant/35 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
                    >
                      {m.common_add()}
                    </button>
                  </div>
                {/if}

                <div class="flex flex-wrap gap-2">
                  {#each config.antiBotBypassUsers as userId}
                    <div class="flex items-center gap-1.5 px-3 py-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-xl text-xs font-bold font-mono">
                      <span>{userId}</span>
                      {#if isOwner}
                        <button type="button" onclick={() => removeAntiBotBypassUser(userId)} class="text-error hover:text-error/80 transition-colors ml-1 text-sm font-bold leading-none">&times;</button>
                      {/if}
                    </div>
                  {:else}
                    <span class="text-xs text-on-surface-variant/40 italic ml-2">{m.am_antibot_bypass_empty()}</span>
                  {/each}
                </div>
              </div>

              <div class="p-3 bg-warning/10 border border-warning/20 rounded-lg">
                <p class="text-xs text-warning/90 font-medium">
                  {m.am_antibot_notice()}
                </p>
              </div>
            </div>
          {/if}
        </section>

        <!-- Admin Permission Lock -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
            <h3 class="text-lg font-semibold flex items-center gap-3">
              <Papicon icon="lock" size={20} class="text-error" />
              {m.am_admin_lock()}
            </h3>
            <ToggleSwitch
              checked={config.adminLockEnabled}
              onToggle={(v: boolean) => config.adminLockEnabled = v}
              disabled={!isOwner}
            />
          </div>

          {#if !isOwner}
            <div class="p-3 bg-error/10 border border-error/20 rounded-lg">
              <p class="text-xs text-error/90 font-medium">
                {m.am_adminlock_owner_only()}
              </p>
            </div>
          {/if}

          <p class="text-xs text-on-surface-variant/70 leading-relaxed">
            {m.am_adminlock_desc_before()}{m.am_adminlock_desc_after()}
          </p>

          {#if config.adminLockEnabled}
            <div class="space-y-5 animate-in fade-in duration-300">
              <a href="/security/sanctions/admin-approval" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition-colors">
                <Papicon icon="inbox" size={14} /> {m.am_adminlock_view_requests()}
              </a>

              <!-- Rôles sécurité -->
              <div class="space-y-3 pt-2 border-t border-outline-variant/10">
                <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_adminlock_security_roles()}</span>
                <p class="text-xs text-on-surface-variant/50 ml-2">{m.am_adminlock_security_roles_desc()}</p>
                {#if isOwner}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect
                        id="adminLockSecurityRoleSelect"
                        bind:value={selectedAdminLockSecurityRole}
                        options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
                        placeholder={m.am_adminlock_add_role_placeholder()}
                        className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-primary/20 transition-all"
                      />
                    </div>
                    <button
                      type="button"
                      onclick={addAdminLockSecurityRole}
                      disabled={!selectedAdminLockSecurityRole}
                      class="px-4 py-2.5 bg-outline-variant/20 hover:bg-outline-variant/35 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
                    >
                      {m.common_add()}
                    </button>
                  </div>
                {/if}

                <div class="flex flex-wrap gap-2">
                  {#each config.adminLockSecurityRoleIds as roleId}
                    <div class="flex items-center gap-1.5 px-3 py-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-xl text-xs font-bold">
                      <span>{getRoleName(roleId)}</span>
                      {#if isOwner}
                        <button type="button" onclick={() => removeAdminLockSecurityRole(roleId)} class="text-error hover:text-error/80 transition-colors ml-1 text-sm font-bold leading-none">&times;</button>
                      {/if}
                    </div>
                  {:else}
                    <span class="text-xs text-on-surface-variant/40 italic ml-2">{m.am_adminlock_roles_empty()}</span>
                  {/each}
                </div>
              </div>

              <!-- Salon de notification -->
              <div class="space-y-1.5 pt-2 border-t border-outline-variant/10">
                <label for="adminLockNotifyChannel" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_adminlock_notify_channel()}</label>
                <p class="text-xs text-on-surface-variant/50 ml-2 mb-1">{m.am_adminlock_notify_channel_desc()}</p>
                <select
                  id="adminLockNotifyChannel"
                  bind:value={config.adminLockNotifyChannelId}
                  class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                  disabled={!isOwner}
                >
                  <option value={null}>{m.am_adminlock_default_log_channel()}</option>
                  {#each availableChannels as c}
                    <option value={c.id}># {channelDisplayName(c)}</option>
                  {/each}
                </select>
              </div>

              <!-- Anti-rafale -->
              <div class="space-y-4 pt-2 border-t border-outline-variant/10">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_burst_title()}</span>
                    <p class="text-xs text-on-surface-variant/50 ml-2 mt-1">
                      {m.am_burst_desc()}
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={config.burstSuspendEnabled}
                    onToggle={(v: boolean) => config.burstSuspendEnabled = v}
                    disabled={!isOwner}
                  />
                </div>

                {#if config.burstSuspendEnabled}
                  <div class="grid grid-cols-2 gap-4 animate-in fade-in duration-300">
                    <div class="space-y-1.5">
                      <label for="burstFastLimit" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_burst_fast()}</label>
                      <div class="flex items-center gap-2">
                        <input id="burstFastLimit" type="number" min="1" max="100" bind:value={config.burstSuspendFastLimit} disabled={!isOwner}
                          class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none" />
                        <span class="text-xs text-on-surface-variant/50 whitespace-nowrap">{m.am_burst_act_per()}</span>
                        <input type="number" min="1" max="3600" bind:value={config.burstSuspendFastWindowSec} disabled={!isOwner}
                          class="w-20 bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none" />
                        <span class="text-xs text-on-surface-variant/50">s</span>
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      <label for="burstSlowLimit" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_burst_slow()}</label>
                      <div class="flex items-center gap-2">
                        <input id="burstSlowLimit" type="number" min="1" max="500" bind:value={config.burstSuspendSlowLimit} disabled={!isOwner}
                          class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none" />
                        <span class="text-xs text-on-surface-variant/50 whitespace-nowrap">{m.am_burst_act_per()}</span>
                        <input type="number" min="1" max="3600" bind:value={config.burstSuspendSlowWindowSec} disabled={!isOwner}
                          class="w-20 bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-sm text-on-surface focus:outline-none" />
                        <span class="text-xs text-on-surface-variant/50">s</span>
                      </div>
                    </div>
                  </div>
                {/if}
              </div>

              <div class="p-3 bg-warning/10 border border-warning/20 rounded-lg">
                <p class="text-xs text-warning/90 font-medium">
                  {m.am_adminlock_notice()}
                </p>
              </div>
            </div>
          {/if}
        </section>
      </div>

      <!-- Le captcha, la detection de vague d'arrivees et les verrous d'urgence
           etaient edites ici en parallele de la page anti-raid, sur la meme
           RaidProtectionConfig. Ils n'ont plus qu'un seul point d'entree. -->
      <a
        href="/security/anti-raid"
        class="mt-8 flex items-center justify-between gap-4 rounded-xl border border-outline-variant/30 bg-surface-container-low/40 px-5 py-4 transition-colors hover:border-primary/40"
      >
        <div class="flex items-center gap-3">
          <Papicon icon="ShieldAlert" size={20} class="text-orange-400" />
          <div>
            <p class="text-sm font-semibold text-on-surface">Captcha, détection de raid et verrous d'urgence</p>
            <p class="text-xs text-on-surface-variant/70">Regroupés dans la page Anti-raid.</p>
          </div>
        </div>
        <Papicon icon="chevron-right" size={16} class="shrink-0 text-on-surface-variant/60" />
      </a>

    {:else if activeTab === 'behavioral'}
      <!-- Le panneau gere son propre chargement et son propre enregistrement :
           il s'appuie sur SpamDetectionConfig, pas sur AutoModConfig. -->
      <AntiSpamPanel />

    {:else if activeTab === 'exceptions'}
      <div class="animate-in fade-in duration-300">
        <!-- Exempt rules (Bypass) -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <h3 class="text-xl font-semibold flex items-center gap-3 border-b border-outline-variant/15 pb-4">
            <Papicon icon="Unlock" size={20} class="text-success" />
            {m.am_exceptions_title()}
          </h3>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <!-- Ignored roles -->
            <div class="space-y-3">
              <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_exempt_roles()}</span>
              {#if canManageSettings}
                <div class="flex gap-2">
                  <div class="flex-1">
                    <SearchableSelect 
                      id="bypassRoleSelect"
                      bind:value={selectedBypassRole} 
                      options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                      placeholder={m.am_add_role_placeholder()} 
                      className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-primary/20 transition-all"
                    />
                  </div>
                  <button 
                    type="button"
                    onclick={addBypassRole}
                    disabled={!selectedBypassRole}
                    class="px-4 py-2.5 bg-outline-variant/20 hover:bg-outline-variant/35 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
                  >
                    {m.common_add()}
                  </button>
                </div>
              {/if}

              <div class="flex flex-wrap gap-2">
                {#each config.bypassRoles as roleId}
                  <div class="flex items-center gap-1.5 px-3 py-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-xl text-xs font-bold">
                    <span>{getRoleName(roleId)}</span>
                    {#if canManageSettings}
                      <button type="button" onclick={() => removeBypassRole(roleId)} class="text-error hover:text-error/80 transition-colors ml-1 text-sm font-bold leading-none">×</button>
                    {/if}
                  </div>
                {:else}
                  <span class="text-xs text-on-surface-variant/40 italic ml-2">{m.am_no_exempt_role()}</span>
                {/each}
              </div>
            </div>

            <!-- Ignored channels -->
            <div class="space-y-3 lg:border-l lg:border-outline-variant/10 lg:pl-8">
              <span class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.am_exempt_channels()}</span>
              {#if canManageSettings}
                <div class="flex gap-2">
                  <div class="flex-1">
                    <SearchableSelect 
                      id="bypassChanSelect"
                      bind:value={selectedBypassChannel} 
                      options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} 
                      placeholder={m.am_add_channel_placeholder()} 
                      className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-primary/20 transition-all"
                    />
                  </div>
                  <button 
                    type="button"
                    onclick={addBypassChannel}
                    disabled={!selectedBypassChannel}
                    class="px-4 py-2.5 bg-outline-variant/20 hover:bg-outline-variant/35 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
                  >
                    {m.common_add()}
                  </button>
                </div>
              {/if}

              <div class="flex flex-wrap gap-2">
                {#each config.bypassChannels as channelId}
                  <div class="flex items-center gap-1.5 px-3 py-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-xl text-xs font-bold">
                    <span>{getChannelName(channelId)}</span>
                    {#if canManageSettings}
                      <button type="button" onclick={() => removeBypassChannel(channelId)} class="text-error hover:text-error/80 transition-colors ml-1 text-sm font-bold leading-none">×</button>
                    {/if}
                  </div>
                {:else}
                  <span class="text-xs text-on-surface-variant/40 italic ml-2">{m.am_no_exempt_channel()}</span>
                {/each}
              </div>
            </div>
          </div>
        </section>
      </div>
    {/if}
  {/if}
</ModulePage>
