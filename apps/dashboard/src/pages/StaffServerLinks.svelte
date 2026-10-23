<script lang="ts">
  import { m } from '../lib/i18n';
  import { onMount } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import {
    fetchStaffServerLinks,
    createStaffServerLink,
    updateStaffServerLink,
    deleteStaffServerLink,
    addStaffServerRoleMapping,
    deleteStaffServerRoleMapping,
    syncStaffServerRoles,
    fetchStaffServerChannels,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Modal from '../lib/components/Modal.svelte';

  let links = $state<any[]>([]);
  let loading = $state(true);

  // Create link modal
  let showCreateModal = $state(false);
  let newStaffGuildId = $state('');
  let newSyncMode = $state('MAIN_TO_STAFF');
  let newSimpleStaffRoleId = $state('');
  let newMainLogChannelId = $state('');

  // Mapping modal
  let showMappingModal = $state(false);
  let mappingLinkId = $state('');
  let newMainRoleId = $state('');
  let newStaffRoleId = $state('');

  // Sync state
  let syncingLinkId = $state('');

  // Delete confirm
  let showDeleteModal = $state(false);
  let deleteTargetId = $state('');

  // Expanded link details
  let expandedLinkId = $state<string | null>(null);

  const saveAction = createAsyncActionState();

  const channels = $derived(
    dashboardStore.state.discordChannels?.filter((c: any) => c.type === 'text') ?? []
  );
  const roles = $derived(
    dashboardStore.state.discordRoles ?? []
  );

  const syncModeLabels: Record<string, () => string> = {
    MAIN_TO_STAFF: () => m.staff_server_mode_main_to_staff(),
    STAFF_TO_MAIN: () => m.staff_server_mode_staff_to_main(),
    BIDIRECTIONAL: () => m.channel_links_direction_bidirectional(),
  };

  const syncModeDescriptions: Record<string, () => string> = {
    MAIN_TO_STAFF: () => m.staff_server_mode_main_to_staff_desc(),
    STAFF_TO_MAIN: () => m.staff_server_mode_staff_to_main_desc(),
    BIDIRECTIONAL: () => m.staff_server_mode_bidirectional_desc(),
  };

  async function loadData() {
    loading = true;
    try {
      const data = await fetchStaffServerLinks();
      links = data ?? [];
    } catch (err) {
      toast.error(m.staff_server_load_error());
    } finally {
      loading = false;
    }
  }

  // Salons du serveur staff lié, pour les pickers de notifications cross-serveur
  let staffChannels = $state<any[]>([]);
  let staffCategories = $state<any[]>([]);
  let staffGuildChannelsName = $state<string | null>(null);

  async function loadStaffChannels() {
    try {
      const data = await fetchStaffServerChannels();
      if (data?.staffGuildId) {
        staffChannels = data.channels ?? [];
        staffCategories = data.categories ?? [];
        staffGuildChannelsName = data.staffGuildName ?? data.staffGuildId;
      }
    } catch {
      // pas de lien actif côté principal
    }
  }

  async function handleConfigChange(linkId: string, field: string, value: unknown) {
    try {
      await updateStaffServerLink(linkId, { [field]: value });
      toast.success(m.staff_server_config_saved_toast());
      await loadData();
    } catch {
      toast.error(m.staff_server_save_error());
    }
  }

  onMount(() => {
    dashboardStore.refresh();
    loadData();
    loadStaffChannels();
  });

  async function handleCreate() {
    if (!newStaffGuildId) {
      toast.error(m.staff_server_err_id_required());
      return;
    }
    await saveAction.run(async () => {
      const result = await createStaffServerLink({
        staffGuildId: newStaffGuildId,
        syncMode: newSyncMode,
        simpleStaffRoleId: newSimpleStaffRoleId || null,
        mainLogChannelId: newMainLogChannelId || null,
      });
      if (result) {
        showCreateModal = false;
        newStaffGuildId = '';
        await loadData();
        return true;
      }
      return false;
    }, { successMessage: m.staff_server_linked_toast() });
  }

  async function handleToggle(linkId: string, enabled: boolean) {
    await updateStaffServerLink(linkId, { enabled });
    await loadData();
  }

  async function handleAddMapping() {
    if (!newMainRoleId && !newStaffRoleId) {
      toast.error(m.staff_server_err_role_required());
      return;
    }
    await saveAction.run(async () => {
      const result = await addStaffServerRoleMapping(mappingLinkId, {
        mainDiscordRoleId: newMainRoleId || null,
        staffDiscordRoleId: newStaffRoleId || null,
      });
      if (result) {
        showMappingModal = false;
        newMainRoleId = '';
        newStaffRoleId = '';
        await loadData();
        return true;
      }
      return false;
    }, { successMessage: m.staff_server_mapping_added_toast() });
  }

  async function handleDeleteMapping(linkId: string, mappingId: string) {
    const ok = await deleteStaffServerRoleMapping(linkId, mappingId);
    if (ok) await loadData();
  }

  async function handleSync(linkId: string) {
    syncingLinkId = linkId;
    try {
      const result = await syncStaffServerRoles(linkId);
      if (result) {
        toast.success(m.staff_server_sync_finished_toast({ synced: result.synced, errors: result.errors }));
      }
    } catch {
      toast.error(m.staff_server_sync_error());
    } finally {
      syncingLinkId = '';
    }
  }

  async function handleDelete() {
    if (!deleteTargetId) return;
    const ok = await deleteStaffServerLink(deleteTargetId);
    if (ok) {
      showDeleteModal = false;
      await loadData();
    }
  }

  function openMappingModal(linkId: string) {
    mappingLinkId = linkId;
    showMappingModal = true;
  }

  function confirmDelete(id: string) {
    deleteTargetId = id;
    showDeleteModal = true;
  }

  function toggleExpanded(linkId: string) {
    expandedLinkId = expandedLinkId === linkId ? null : linkId;
  }
</script>

<ModulePage
  title={m.staff_server_page_title()}
  description={m.staff_server_page_desc()}
  icon="shield"
  featureKey="staff_server"
>
  {#snippet actions()}
    <RefreshButton onclick={loadData} />
  {/snippet}

  {#snippet children()}
    <InlineFeedback state={saveAction} />

    <div class="flex flex-col gap-6">
      <!-- Actions bar -->
      <div class="flex items-center justify-between">
        <p class="text-sm text-on-surface-variant">{m.staff_server_linked_count({ count: links.length })}</p>
        <button
          onclick={() => { showCreateModal = true; }}
          class="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
        >
          <Papicon icon="plus" size={16} />
          {m.staff_server_link_btn()}
        </button>
      </div>

      <!-- Links list -->
      {#if loading}
        <div class="flex items-center justify-center py-16">
          <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
        </div>
      {:else if links.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <div class="w-16 h-16 bg-surface-container-low rounded-2xl flex items-center justify-center mb-4">
            <Papicon icon="shield" size={32} class="text-on-surface-variant/40" />
          </div>
          <h3 class="text-lg font-semibold text-on-surface mb-1">{m.staff_server_empty_title()}</h3>
          <p class="text-sm text-on-surface-variant max-w-sm">
            {m.staff_server_empty_desc()}
          </p>
        </div>
      {:else}
        <div class="grid gap-4">
          {#each links as link}
            <div class="bg-surface-container-low/40 rounded-xl border border-outline-variant/30 overflow-hidden transition-all {expandedLinkId === link.id ? 'border-primary/30' : ''}">
              <!-- Header -->
              <div class="p-5">
                <div class="flex items-start justify-between gap-4">
                  <div class="flex items-center gap-3 flex-1 min-w-0">
                    {#if link.otherGuildIcon}
                      <img src={link.otherGuildIcon} alt="" class="w-10 h-10 rounded-lg" />
                    {:else}
                      <div class="w-10 h-10 rounded-lg bg-surface-container flex items-center justify-center">
                        <Papicon icon="server" size={20} class="text-on-surface-variant" />
                      </div>
                    {/if}
                    <div>
                      <h4 class="text-sm font-semibold text-on-surface">{link.otherGuildName}</h4>
                      <div class="flex items-center gap-2 mt-0.5">
                        <span class="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                          {link.isMain ? m.staff_server_badge_staff_server() : m.staff_server_badge_main_server()}
                        </span>
                        <span class="text-xs px-2 py-0.5 rounded-full bg-surface-container border border-outline-variant/15 text-on-surface-variant">
                          {syncModeLabels[link.syncMode]?.() ?? link.syncMode}
                        </span>
                        {#if link.hierarchy}
                          <span class="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400">
                            {link.hierarchy.name}
                          </span>
                        {/if}
                      </div>
                    </div>
                  </div>

                  <div class="flex items-center gap-2">
                    <ToggleSwitch
                      checked={link.enabled}
                      onToggle={(v) => handleToggle(link.id, v)}
                    />
                    <button
                      onclick={() => handleSync(link.id)}
                      disabled={syncingLinkId === link.id}
                      class="p-2 rounded-lg hover:bg-surface-container transition-colors disabled:opacity-50"
                      title={m.staff_server_sync_tooltip()}
                    >
                      <Papicon icon="refresh-cw" size={16} class="text-on-surface-variant {syncingLinkId === link.id ? 'animate-spin' : ''}" />
                    </button>
                    <button
                      onclick={() => toggleExpanded(link.id)}
                      class="p-2 rounded-lg hover:bg-surface-container transition-colors"
                      title={m.staff_server_details_tooltip()}
                    >
                      <Papicon icon={expandedLinkId === link.id ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant" />
                    </button>
                    <button
                      onclick={() => confirmDelete(link.id)}
                      class="p-2 rounded-lg hover:bg-error/10 transition-colors"
                      title={m.common_delete()}
                    >
                      <Papicon icon="trash-2" size={16} class="text-error" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Expanded: Role Mappings -->
              {#if expandedLinkId === link.id}
                <div class="border-t border-outline-variant/20 bg-surface-container/20 p-5">
                  <div class="flex items-center justify-between mb-4">
                    <h5 class="text-sm font-semibold text-on-surface">{m.staff_server_mappings_heading()}</h5>
                    <button
                      onclick={() => openMappingModal(link.id)}
                      class="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors text-xs font-medium"
                    >
                      <Papicon icon="plus" size={14} />
                      {m.common_add()}
                    </button>
                  </div>

                  {#if link.roleMappings.length === 0}
                    <p class="text-sm text-on-surface-variant text-center py-4">
                      {m.staff_server_no_mappings_desc()}
                    </p>
                  {:else}
                    <div class="space-y-2">
                      {#each link.roleMappings as mapping}
                        <div class="flex items-center justify-between bg-surface-container-low/60 rounded-lg px-4 py-3 border border-outline-variant/10">
                          <div class="flex items-center gap-4">
                            <div class="flex items-center gap-2">
                              {#if mapping.mainRoleColor}
                                <span class="w-3 h-3 rounded-full" style="background-color: {mapping.mainRoleColor}"></span>
                              {/if}
                              <span class="text-sm font-medium text-on-surface">{mapping.mainRoleName ?? '-'}</span>
                            </div>
                            <Papicon icon="arrow-right" size={14} class="text-on-surface-variant/40" />
                            <div class="flex items-center gap-2">
                              {#if mapping.staffRoleColor}
                                <span class="w-3 h-3 rounded-full" style="background-color: {mapping.staffRoleColor}"></span>
                              {/if}
                              <span class="text-sm font-medium text-on-surface">{mapping.staffRoleName ?? '-'}</span>
                            </div>
                          </div>
                          <button
                            onclick={() => handleDeleteMapping(link.id, mapping.id)}
                            class="p-1.5 rounded-md hover:bg-error/10 transition-colors"
                          >
                            <Papicon icon="x" size={14} class="text-error" />
                          </button>
                        </div>
                      {/each}
                    </div>
                  {/if}

                  {#if link.isMain}
                    <div class="mt-5 pt-4 border-t border-outline-variant/10">
                      <h5 class="text-sm font-semibold text-on-surface mb-1">{m.staff_server_cross_notifs_heading()}</h5>
                      <p class="text-xs text-on-surface-variant mb-4">
                        {m.staff_server_cross_notifs_desc()}
                      </p>

                      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {#each [
                          { field: 'modlogMirrorChannelId', label: m.staff_server_field_modlog_mirror(), hint: m.staff_server_hint_modlog_mirror() },
                          { field: 'sanctionReportChannelId', label: m.staff_server_field_sanction_report(), hint: m.staff_server_hint_sanction_report() },
                          { field: 'recruitmentAlertChannelId', label: m.staff_server_field_recruitment_alert(), hint: m.staff_server_hint_recruitment_alert() },
                          { field: 'offboardingAlertChannelId', label: m.staff_server_field_offboarding_alert(), hint: m.staff_server_hint_offboarding_alert() },
                          { field: 'onboardingInviteChannelId', label: m.staff_server_field_onboarding_invite(), hint: m.staff_server_hint_onboarding_invite() },
                        ] as cfg}
                          <div>
                            <label for="config-{cfg.field}" class="block text-xs font-medium text-on-surface mb-1">{cfg.label}</label>
                            <select
                              id="config-{cfg.field}"
                              value={link[cfg.field] ?? ''}
                              onchange={(e) => handleConfigChange(link.id, cfg.field, (e.target as HTMLSelectElement).value || null)}
                              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
                            >
                              <option value="">{m.common_none()}</option>
                              {#each staffChannels as ch}
                                <option value={ch.id}>#{ch.name}</option>
                              {/each}
                            </select>
                            <p class="text-2xs text-on-surface-variant/40 mt-1">{cfg.hint}</p>
                          </div>
                        {/each}

                        <div>
                          <label for="recruitment-category" class="block text-xs font-medium text-on-surface mb-1">{m.staff_server_field_recruitment_category()}</label>
                          <select
                            id="recruitment-category"
                            value={link.staffRecruitmentCategoryId ?? ''}
                            onchange={(e) => handleConfigChange(link.id, 'staffRecruitmentCategoryId', (e.target as HTMLSelectElement).value || null)}
                            class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
                          >
                            <option value="">{m.common_none()}</option>
                            {#each staffCategories as cat}
                              <option value={cat.id}>{cat.name}</option>
                            {/each}
                          </select>
                          <p class="text-2xs text-on-surface-variant/40 mt-1">{m.staff_server_hint_recruitment_category()}</p>
                        </div>
                      </div>

                      <div class="mt-4 space-y-3">
                        <div class="flex items-center justify-between">
                          <div>
                            <p class="text-xs font-medium text-on-surface">{m.staff_server_toggle_onboarding_title()}</p>
                            <p class="text-2xs text-on-surface-variant/40">{m.staff_server_toggle_onboarding_desc()}</p>
                          </div>
                          <ToggleSwitch
                            checked={!!link.onboardingInviteEnabled}
                            onToggle={(checked) => handleConfigChange(link.id, 'onboardingInviteEnabled', checked)}
                          />
                        </div>
                        <div class="flex items-center justify-between">
                          <div>
                            <p class="text-xs font-medium text-on-surface">{m.staff_server_toggle_recruitment_title()}</p>
                            <p class="text-2xs text-on-surface-variant/40">{m.staff_server_toggle_recruitment_desc()}</p>
                          </div>
                          <ToggleSwitch
                            checked={!!link.recruitmentOnStaffServer}
                            onToggle={(checked) => handleConfigChange(link.id, 'recruitmentOnStaffServer', checked)}
                          />
                        </div>
                      </div>
                    </div>
                  {/if}

                  <div class="mt-4 pt-3 border-t border-outline-variant/10">
                    <p class="text-xs text-on-surface-variant">
                      Mode : {syncModeDescriptions[link.syncMode]?.() ?? link.syncMode}
                    </p>
                    <p class="text-xs text-on-surface-variant/40 mt-1">
                      ID : <code class="font-mono">{link.id}</code>
                    </p>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Create Link Modal -->
      <Modal bind:open={showCreateModal} title={m.staff_server_modal_create_title()}>
        <div class="flex flex-col gap-5">
          <div>
            <label for="new-staff-guild-id" class="block text-sm font-medium text-on-surface mb-1.5">{m.staff_server_field_staff_guild_id()}</label>
            <input
              id="new-staff-guild-id"
              type="text"
              bind:value={newStaffGuildId}
              placeholder="Ex: 123456789012345678"
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary/50 outline-none placeholder:text-on-surface-variant/30"
            />
            <p class="text-xs text-on-surface-variant mt-1">{m.staff_server_hint_bot_present()}</p>
          </div>

          <div>
            <label for="new-sync-mode" class="block text-sm font-medium text-on-surface mb-1.5">{m.staff_server_field_sync_mode()}</label>
            <select
              id="new-sync-mode"
              bind:value={newSyncMode}
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
            >
              <option value="MAIN_TO_STAFF">{m.staff_server_mode_main_to_staff()}</option>
              <option value="STAFF_TO_MAIN">{m.staff_server_mode_staff_to_main()}</option>
              <option value="BIDIRECTIONAL">{m.channel_links_direction_bidirectional()}</option>
            </select>
            <p class="text-xs text-on-surface-variant mt-1">{syncModeDescriptions[newSyncMode]?.() ?? newSyncMode}</p>
          </div>

          <div>
            <label for="new-simple-staff-role-id" class="block text-sm font-medium text-on-surface mb-1.5">{m.staff_server_field_simple_role()}</label>
            <select
              id="new-simple-staff-role-id"
              bind:value={newSimpleStaffRoleId}
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
            >
              <option value="">{m.common_none()}</option>
              {#each roles as role}
                <option value={role.id}>{role.name}</option>
              {/each}
            </select>
          </div>

          <div>
            <label for="new-main-log-channel-id" class="block text-sm font-medium text-on-surface mb-1.5">{m.staff_server_field_main_log()}</label>
            <select
              id="new-main-log-channel-id"
              bind:value={newMainLogChannelId}
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
            >
              <option value="">{m.common_none()}</option>
              {#each channels as ch}
                <option value={ch.id}>#{ch.name}</option>
              {/each}
            </select>
          </div>

          <button
            onclick={handleCreate}
            disabled={saveAction.state.loading}
            class="w-full px-4 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {saveAction.state.loading ? m.staff_server_linking() : m.staff_server_link_submit()}
          </button>
        </div>
      </Modal>

    <!-- Mapping Modal -->
      <Modal bind:open={showMappingModal} title={m.staff_server_modal_mapping_title()}>
        <div class="flex flex-col gap-5">
          <div>
            <label for="new-main-role-id" class="block text-sm font-medium text-on-surface mb-1.5">{m.staff_server_field_main_role()}</label>
            <select
              id="new-main-role-id"
              bind:value={newMainRoleId}
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm outline-none"
            >
              <option value="">{m.common_select()}</option>
              {#each roles as role}
                <option value={role.id}>{role.name}</option>
              {/each}
            </select>
          </div>

          <div class="flex items-center justify-center">
            <Papicon icon="arrow-down" size={20} class="text-on-surface-variant/40" />
          </div>

          <div>
            <label for="new-staff-role-id" class="block text-sm font-medium text-on-surface mb-1.5">{m.staff_server_field_staff_role_id()}</label>
            <input
              id="new-staff-role-id"
              type="text"
              bind:value={newStaffRoleId}
              placeholder="Ex: 123456789012345678"
              class="w-full px-3 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary/50 outline-none placeholder:text-on-surface-variant/30"
            />
          </div>

          <button
            onclick={handleAddMapping}
            disabled={saveAction.state.loading}
            class="w-full px-4 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {saveAction.state.loading ? m.staff_server_adding() : m.staff_server_add_mapping_submit()}
          </button>
        </div>
      </Modal>

    <!-- Delete Confirm Modal -->
      <Modal bind:open={showDeleteModal} title={m.staff_server_delete_modal_title()}>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-on-surface-variant">
            {m.staff_server_delete_modal_desc()}
          </p>
          <div class="flex gap-3 justify-end">
            <button
              onclick={() => { showDeleteModal = false; }}
              class="px-4 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-on-surface text-sm hover:bg-surface-container-high transition-colors"
            >
              {m.common_cancel()}
            </button>
            <button
              onclick={handleDelete}
              class="px-4 py-2 rounded-lg bg-red-500 text-white text-sm hover:bg-red-600 transition-colors"
            >
              {m.common_delete()}
            </button>
          </div>
        </div>
      </Modal>
  {/snippet}
</ModulePage>
