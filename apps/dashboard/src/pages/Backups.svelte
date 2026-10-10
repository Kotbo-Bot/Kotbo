<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { onMount } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import { fetchBackups, createBackup, deleteBackup, exportBackup, importBackup, restoreBackup, fetchMemberCase } from '../lib/api';

  const createAction = createAsyncActionState();
  const deleteAction = createAsyncActionState();
  const exportAction = createAsyncActionState();
  const importAction = createAsyncActionState();
  const restoreAction = createAsyncActionState();

  let loading = $state(false);
  let backups = $state<any[]>([]);
  let showCreateModal = $state(false);
  let showDeleteModal = $state(false);
  let showImportModal = $state(false);
  let showRestoreModal = $state(false);
  let selectedBackup = $state<any>(null);
  let importFile = $state<File | null>(null);

  // Member modal state
  let memberModalOpen = $state(false);
  let memberModalUserId = $state<string | null>(null);
  let memberModalUserName = $state('');
  let memberCaseData = $state<any>(null);
  let memberCaseLoading = $state(false);
  let memberCaseError = $state('');
  let creatingBackup = $state<{
    name: string;
    description: string;
    progress: number;
    statusText: string;
  } | null>(null);

  const canManageBackups = $derived(
    !!dashboardStore.state.access?.canManageSettings
  );

  let createOptions = $state({
    name: '',
    description: '',
    includeMessages: false,
    includeMembers: true,
    includeRoles: true,
    includeChannels: true,
    includeEmojis: true,
    includeStickers: true,
  });

  onMount(async () => {
    await loadBackups();
  });

  async function loadBackups() {
    loading = true;
    try {
      const data = await fetchBackups(authStore.selectedGuildId ?? '');
      backups = data || [];
    } catch (error) {
      console.error('Erreur lors du chargement des backups:', error);
    }
    loading = false;
  }

  async function handleCreateBackup() {
    const backupName = createOptions.name || m.backups_default_name({
      date: new Date().toLocaleDateString(dateLocale()),
      time: new Date().toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
    });
    const backupDesc = createOptions.description;
    
    // Close modal immediately
    showCreateModal = false;
    
    // Set active creating state
    creatingBackup = {
      name: backupName,
      description: backupDesc || m.backups_creating_desc(),
      progress: 0,
      statusText: m.backups_status_init()
    };
    
    // Start progress simulation
    const progressInterval = setInterval(() => {
      if (!creatingBackup) return;
      if (creatingBackup.progress < 30) {
        creatingBackup.progress += 5;
        creatingBackup.statusText = m.backups_status_connect();
      } else if (creatingBackup.progress < 70) {
        creatingBackup.progress += 3;
        creatingBackup.statusText = m.backups_status_extract();
      } else if (creatingBackup.progress < 90) {
        creatingBackup.progress += 1.5;
        creatingBackup.statusText = m.backups_status_permissions();
      } else if (creatingBackup.progress < 98) {
        creatingBackup.progress += 0.2;
        creatingBackup.statusText = m.backups_status_db();
      }
    }, 150);
    
    const optionsToCreate = { ...createOptions, name: backupName };
    
    // Reset options form
    createOptions = {
      name: '',
      description: '',
      includeMessages: false,
      includeMembers: true,
      includeRoles: true,
      includeChannels: true,
      includeEmojis: true,
      includeStickers: true,
    };
    
    await createAction.run(async () => {
      try {
        await createBackup(optionsToCreate, authStore.selectedGuildId ?? '');
        clearInterval(progressInterval);
        
        if (creatingBackup) {
          creatingBackup.progress = 100;
          creatingBackup.statusText = m.backups_status_done();
        }
        
        // Wait 800ms at 100% for the user to see the success before reloading
        await new Promise(resolve => setTimeout(resolve, 800));
        creatingBackup = null;
        await loadBackups();
        return true;
      } catch (error) {
        clearInterval(progressInterval);
        creatingBackup = null;
        throw error;
      }
    }, {
      successMessage: m.backups_create_toast()
    });
  }

  async function handleDeleteBackup() {
    if (!selectedBackup) return;
    await deleteAction.run(async () => {
      const ok = await deleteBackup(selectedBackup.id, authStore.selectedGuildId ?? '');
      if (!ok) return false;
      showDeleteModal = false;
      selectedBackup = null;
      await loadBackups();
      return true;
    }, {
      successMessage: m.backups_delete_toast()
    });
  }

  async function handleRestoreBackup() {
    if (!selectedBackup) return;
    await restoreAction.run(async () => {
      await restoreBackup(selectedBackup.id, authStore.selectedGuildId ?? '');
      showRestoreModal = false;
      selectedBackup = null;
      return true;
    }, {
      successMessage: m.backups_restore_toast()
    });
  }


  /**
   * Le dossier membre appartient a la section Membres : la fenetre ne s'ouvre
   * pas pour un role a qui le centre de gestion l'a fermee, quelle que soit la
   * page qui la demande.
   */
  const canOpenMemberCase = $derived(canViewFeature('members'));

  async function openMemberCase(backup: any) {
    if (!canOpenMemberCase) return;
    if (!backup.createdByUserId) return;
    memberModalUserId = backup.createdByUserId;
    memberModalUserName = backup.createdByUsername || m.backups_member_fallback();
    memberModalOpen = true;
    memberCaseLoading = true;
    memberCaseError = '';
    memberCaseData = null;
    try {
      memberCaseData = await fetchMemberCase(backup.createdByUserId, authStore.selectedGuildId ?? '');
      if (memberCaseData?.profile) {
        memberModalUserName = memberCaseData.profile.displayName || memberCaseData.profile.username || memberModalUserName;
      }
    } catch (error) {
      memberCaseError = error instanceof Error ? error.message : m.backups_case_error();
    } finally {
      memberCaseLoading = false;
    }
  }

  async function handleExportBackup(backup: any) {
    await exportAction.run(async () => {
      const response = await exportBackup(backup.id, authStore.selectedGuildId ?? '');
      if (!response) return false;
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${backup.name.replace(/[^a-zA-Z0-9]/g, '_')}_backup.json`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;
    }, {
      successMessage: m.backups_export_toast()
    });
  }

  async function handleImportBackup() {
    if (!importFile) return;
    const backupName = createOptions.name || m.backups_import_default_name({ name: importFile.name.replace('.json', '') });
    
    // Close modal immediately
    showImportModal = false;
    
    // Set active creating state
    creatingBackup = {
      name: backupName,
      description: m.backups_import_desc(),
      progress: 0,
      statusText: m.backups_import_status_load()
    };
    
    const progressInterval = setInterval(() => {
      if (!creatingBackup) return;
      if (creatingBackup.progress < 40) {
        creatingBackup.progress += 10;
        creatingBackup.statusText = m.backups_import_status_read();
      } else if (creatingBackup.progress < 85) {
        creatingBackup.progress += 5;
        creatingBackup.statusText = m.backups_import_status_limit();
      } else if (creatingBackup.progress < 98) {
        creatingBackup.progress += 2;
        creatingBackup.statusText = m.backups_import_status_create();
      }
    }, 100);
    
    const fileToImport = importFile;
    const nameToImport = createOptions.name || undefined;
    
    // Reset inputs
    importFile = null;
    createOptions.name = '';
    
    await importAction.run(async () => {
      const reader = new FileReader();
      return new Promise<boolean>((resolve, reject) => {
        reader.onload = async (e) => {
          try {
            const fileContent = e.target?.result as string;
            if (!fileContent) {
              clearInterval(progressInterval);
              creatingBackup = null;
              resolve(false);
              return;
            }
            await importBackup(fileContent, nameToImport, authStore.selectedGuildId ?? '');
            clearInterval(progressInterval);
            
            if (creatingBackup) {
              creatingBackup.progress = 100;
              creatingBackup.statusText = m.backups_import_status_done();
            }
            
            await new Promise(res => setTimeout(res, 800));
            creatingBackup = null;
            await loadBackups();
            resolve(true);
          } catch (error) {
            clearInterval(progressInterval);
            creatingBackup = null;
            reject(error);
          }
        };
        reader.onerror = () => {
          clearInterval(progressInterval);
          creatingBackup = null;
          resolve(false);
        };
        reader.readAsText(fileToImport);
      });
    }, {
      successMessage: m.backups_import_toast()
    });
  }

  function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  function formatDate(date: string): string {
    return new Date(date).toLocaleDateString(dateLocale(), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<ModulePage
  title={m.backups_page_title()}
  description={m.backups_page_desc()}
  icon="archive"
  featureKey="settings"
>
  {#snippet actions()}
    {#if canManageBackups}
      <ActionButton onClick={() => showCreateModal = true} variant="primary" label={m.backups_new_btn()} icon="plus" />
    {/if}
  {/snippet}

  <!-- Grid Layout -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    {#if loading}
      {#each Array(3) as _}
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 h-[320px]">
          <Skeleton height="100%" radius="1.5rem" />
        </div>
      {/each}
    {:else if backups.length === 0 && !creatingBackup}
      <div class="col-span-full bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-12 flex flex-col items-center justify-center text-center space-y-4">
        <div class="w-16 h-16 bg-surface-container-high/40 rounded-full flex items-center justify-center text-on-surface-variant/40 border border-outline-variant/10">
          <Papicon icon="archive" size={32} />
        </div>
        <div class="space-y-1">
          <h3 class="text-xl font-semibold">{m.backups_empty_title()}</h3>
          <p class="text-sm text-on-surface-variant/70 font-medium">{m.backups_empty_desc()}</p>
        </div>
        {#if canManageBackups}
          <ActionButton onClick={() => showCreateModal = true} variant="primary" label={m.backups_empty_btn()} icon="plus" />
        {/if}
      </div>
    {:else}
      {#if creatingBackup}
        <div class="relative overflow-hidden bg-surface-container-low/35 border-2 border-primary/30 rounded-xl p-6 flex flex-col justify-between transition-all duration-300 shadow-sm shadow-primary/5">
          <div>
            <div class="flex items-center gap-4 mb-4 relative">
              <div class="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 overflow-hidden flex items-center justify-center text-primary animate-bounce">
                <Papicon icon="archive" size={24} />
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-base font-semibold truncate leading-snug text-primary">{creatingBackup.name}</h3>
                <p class="text-xs text-on-surface-variant/60 font-semibold mt-0.5">{m.backups_in_progress()}</p>
              </div>
              <span class="px-2.5 py-1 bg-primary/10 border border-primary/20 text-primary text-xs font-semibold rounded-lg shrink-0">
                {Math.round(creatingBackup.progress)}%
              </span>
            </div>

            {#if creatingBackup.description}
              <p class="text-xs text-on-surface-variant/80 font-medium leading-relaxed mb-4 line-clamp-2">{creatingBackup.description}</p>
            {/if}

            <div class="space-y-2.5 bg-surface-container-high/10 border border-outline-variant/5 p-4 rounded-lg">
              <div class="flex justify-between text-xs font-bold text-on-surface-variant">
                <span class="truncate pr-2">{creatingBackup.statusText}</span>
                <span class="shrink-0">{Math.round(creatingBackup.progress)}%</span>
              </div>
              
              <!-- Progress Bar -->
              <div class="w-full bg-surface-container-high/40 rounded-full h-2 overflow-hidden border border-outline-variant/10">
                <div 
                  class="bg-linear-to-r from-primary to-secondary h-full rounded-full transition-all duration-150" 
                  style="width: {creatingBackup.progress}%"
                ></div>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between pt-3 border-t border-outline-variant/10 mt-6">
            <p class="text-2xs text-on-surface-variant/50 font-bold">
              {m.backups_background()}
            </p>
            <div class="flex items-center justify-center shrink-0">
              <div class="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
            </div>
          </div>
        </div>
      {/if}

      {#each backups as backup}
        <div class="relative overflow-hidden bg-surface-container-low/30 border border-outline-variant/10 hover:border-primary/30 rounded-xl p-6 flex flex-col justify-between transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/5">
          <div>
            <div class="flex items-center gap-4 mb-4 relative">
              <div class="w-12 h-12 rounded-xl bg-surface-container-high/50 border border-outline-variant/10 overflow-hidden flex items-center justify-center text-on-surface-variant">
                {#if backup.serverIcon}
                  <img src={backup.serverIcon} alt={backup.serverName} class="w-full h-full object-cover" />
                {:else}
                  <Papicon icon="server" size={24} />
                {/if}
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-base font-semibold truncate leading-snug">{backup.name}</h3>
                <p class="text-xs text-on-surface-variant/60 font-semibold mt-0.5">{formatDate(backup.createdAt)}</p>
              </div>
              {#if backup.isPreset}
                <span class="px-2.5 py-1 bg-primary/10 border border-primary/20 text-primary text-xs font-semibold rounded-lg shrink-0">{m.backups_preset_badge()}</span>
              {/if}
            </div>

            {#if backup.description}
              <p class="text-xs text-on-surface-variant/80 font-medium leading-relaxed mb-4 line-clamp-2">{backup.description}</p>
            {/if}

            <!-- Statistics Grid -->
            <div class="grid grid-cols-2 gap-2.5 mb-4 bg-surface-container-high/15 border border-outline-variant/5 p-4 rounded-lg">
              <div class="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
                <div class="text-primary/70 shrink-0"><Papicon icon="role" size={16} /></div>
                <span class="truncate">{m.backups_count_roles({ count: backup.rolesCount })}</span>
              </div>
              <div class="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
                <div class="text-primary/70 shrink-0"><Papicon icon="channel" size={16} /></div>
                <span class="truncate">{m.backups_count_channels({ count: backup.channelsCount })}</span>
              </div>
              <div class="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
                <div class="text-primary/70 shrink-0"><Papicon icon="user" size={16} /></div>
                <span class="truncate">{m.backups_count_members({ count: backup.membersCount })}</span>
              </div>
              <div class="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
                <div class="text-primary/70 shrink-0"><Papicon icon="emoji" size={16} /></div>
                <span class="truncate">{m.backups_count_emojis({ count: backup.emojisCount })}</span>
              </div>
              <div class="flex items-center gap-2 text-xs font-semibold text-on-surface-variant col-span-2 border-t border-outline-variant/5 pt-2 mt-1">
                <div class="text-primary/70 shrink-0"><Papicon icon="sticker" size={16} /></div>
                <span class="truncate">{m.backups_count_stickers({ count: backup.stickersCount, size: formatSize(backup.sizeBytes) })}</span>
              </div>
            </div>

            <!-- Enabled options list -->
            <div class="flex flex-wrap gap-1.5 mb-4">
              {#if backup.includeMessages}
                <span class="text-2xs font-bold bg-surface-container-high/40 border border-outline-variant/10 text-on-surface-variant px-2 py-0.5 rounded-lg">{m.backups_opt_messages()}</span>
              {/if}
              {#if backup.includeMembers}
                <span class="text-2xs font-bold bg-surface-container-high/40 border border-outline-variant/10 text-on-surface-variant px-2 py-0.5 rounded-lg">{m.backups_opt_members()}</span>
              {/if}
              {#if backup.includeRoles}
                <span class="text-2xs font-bold bg-surface-container-high/40 border border-outline-variant/10 text-on-surface-variant px-2 py-0.5 rounded-lg">{m.backups_opt_roles()}</span>
              {/if}
              {#if backup.includeChannels}
                <span class="text-2xs font-bold bg-surface-container-high/40 border border-outline-variant/10 text-on-surface-variant px-2 py-0.5 rounded-lg">{m.backups_opt_channels()}</span>
              {/if}
              {#if backup.includeEmojis}
                <span class="text-2xs font-bold bg-surface-container-high/40 border border-outline-variant/10 text-on-surface-variant px-2 py-0.5 rounded-lg">{m.backups_opt_emojis()}</span>
              {/if}
              {#if backup.includeStickers}
                <span class="text-2xs font-bold bg-surface-container-high/40 border border-outline-variant/10 text-on-surface-variant px-2 py-0.5 rounded-lg">{m.backups_opt_stickers()}</span>
              {/if}
            </div>
          </div>

          <!-- Le createur occupe sa propre ligne : partager la rangee avec
               trois boutons le confinait a 35% de la carte, ou son nom etait
               systematiquement coupe. -->
          <div class="pt-3 border-t border-outline-variant/10 mt-2 space-y-2">
            {#if backup.createdByUserId}
              <button
                onclick={() => openMemberCase(backup)}
                class="block w-full text-2xs text-on-surface-variant/50 font-bold truncate hover:text-primary transition-colors text-left"
                title={m.backups_view_case({ user: backup.createdByUsername })}
              >
                {m.backups_author({ user: `${backup.createdByUsername}#${backup.createdByTag || '0000'}` })}
              </button>
            {:else}
              <p
                class="text-2xs text-on-surface-variant/50 font-bold truncate"
                title={m.backups_author({ user: `${backup.createdByUsername}#${backup.createdByTag || '0000'}` })}
              >
                {m.backups_author({ user: `${backup.createdByUsername}#${backup.createdByTag || '0000'}` })}
              </p>
            {/if}
            <div class="flex flex-wrap justify-end gap-2">
              <ActionButton onClick={() => handleExportBackup(backup)} variant="muted" size="sm" label={m.backups_export_btn()} icon="download" />
              {#if canManageBackups}
                <ActionButton onClick={() => { selectedBackup = backup; showRestoreModal = true; }} variant="muted" size="sm" label={m.backups_restore_btn()} icon="rotate-ccw" />
                <ActionButton onClick={() => { selectedBackup = backup; showDeleteModal = true; }} variant="danger" size="sm" label={m.common_delete()} icon="trash" />
              {/if}
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Import Section -->
  {#if canManageBackups}
    <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-6">
      <div class="space-y-1">
        <h3 class="text-xl font-semibold">{m.backups_import_section_title()}</h3>
        <p class="text-sm text-on-surface-variant/70 font-medium">{m.backups_import_section_desc()}</p>
      </div>
      <ActionButton onClick={() => showImportModal = true} variant="muted" label={m.backups_import_section_btn()} icon="upload" />
    </section>
  {/if}
</ModulePage>

<!-- Modal de création de backup -->
<Modal bind:open={showCreateModal} title={m.backups_create_modal_title()}>
  <div class="space-y-6">
    <div class="space-y-2">
      <span class="block text-xs font-semibold text-on-surface-variant/60 ml-2">{m.backups_field_name()}</span>
      <input
        type="text"
        bind:value={createOptions.name}
        placeholder={m.backups_field_name_ph()}
        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
      />
    </div>
    
    <div class="space-y-2">
      <span class="block text-xs font-semibold text-on-surface-variant/60 ml-2">{m.backups_field_desc()}</span>
      <input
        type="text"
        bind:value={createOptions.description}
        placeholder={m.backups_field_desc_ph()}
        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
      />
    </div>

    <div class="space-y-3">
      <span class="block text-xs font-semibold text-on-surface-variant/60 ml-2">{m.backups_field_include()}</span>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 bg-surface-container-high/20 border border-outline-variant/5 p-4 rounded-lg">
        <label class="flex items-center gap-3 cursor-pointer group">
          <input 
            type="checkbox" 
            bind:checked={createOptions.includeMessages} 
            class="w-5 h-5 rounded-lg border-2 border-outline-variant/20 text-primary focus:ring-primary/40 transition-all checked:bg-primary checked:border-primary cursor-pointer accent-primary" 
          />
          <span class="text-xs font-semibold text-on-surface-variant group-hover:text-on-surface transition-colors">{m.backups_opt_messages_default_off()}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer group">
          <input 
            type="checkbox" 
            bind:checked={createOptions.includeMembers} 
            class="w-5 h-5 rounded-lg border-2 border-outline-variant/20 text-primary focus:ring-primary/40 transition-all checked:bg-primary checked:border-primary cursor-pointer accent-primary" 
          />
          <span class="text-xs font-semibold text-on-surface-variant group-hover:text-on-surface transition-colors">{m.backups_opt_members()}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer group">
          <input 
            type="checkbox" 
            bind:checked={createOptions.includeRoles} 
            class="w-5 h-5 rounded-lg border-2 border-outline-variant/20 text-primary focus:ring-primary/40 transition-all checked:bg-primary checked:border-primary cursor-pointer accent-primary" 
          />
          <span class="text-xs font-semibold text-on-surface-variant group-hover:text-on-surface transition-colors">{m.backups_opt_roles()}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer group">
          <input 
            type="checkbox" 
            bind:checked={createOptions.includeChannels} 
            class="w-5 h-5 rounded-lg border-2 border-outline-variant/20 text-primary focus:ring-primary/40 transition-all checked:bg-primary checked:border-primary cursor-pointer accent-primary" 
          />
          <span class="text-xs font-semibold text-on-surface-variant group-hover:text-on-surface transition-colors">{m.backups_opt_channels()}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer group">
          <input 
            type="checkbox" 
            bind:checked={createOptions.includeEmojis} 
            class="w-5 h-5 rounded-lg border-2 border-outline-variant/20 text-primary focus:ring-primary/40 transition-all checked:bg-primary checked:border-primary cursor-pointer accent-primary" 
          />
          <span class="text-xs font-semibold text-on-surface-variant group-hover:text-on-surface transition-colors">{m.backups_opt_emojis()}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer group">
          <input 
            type="checkbox" 
            bind:checked={createOptions.includeStickers} 
            class="w-5 h-5 rounded-lg border-2 border-outline-variant/20 text-primary focus:ring-primary/40 transition-all checked:bg-primary checked:border-primary cursor-pointer accent-primary" 
          />
          <span class="text-xs font-semibold text-on-surface-variant group-hover:text-on-surface transition-colors">{m.backups_opt_stickers()}</span>
        </label>
      </div>
    </div>

    <div class="flex justify-end gap-3 pt-2">
      <ActionButton onClick={() => showCreateModal = false} variant="muted" label={m.common_cancel()} />
      <ActionButton onClick={handleCreateBackup} variant="primary" label={m.backups_create_submit()} />
    </div>
    <InlineFeedback state={createAction} />
  </div>
</Modal>

<!-- Modal de suppression -->
<Modal bind:open={showDeleteModal} title={m.backups_delete_modal_title()}>
  <div class="space-y-4">
    <p class="text-sm font-medium">{m.backups_delete_confirm({ name: selectedBackup?.name ?? '' })}</p>
    <p class="text-xs text-error font-bold bg-error/10 border border-error/20 px-4 py-3 rounded-lg flex items-center gap-2">
      <Papicon icon="AlertTriangle" size={16} />
      {m.backups_irreversible()}
    </p>
    <div class="flex justify-end gap-3 pt-2">
      <ActionButton onClick={() => showDeleteModal = false} variant="muted" label={m.common_cancel()} />
      <ActionButton onClick={handleDeleteBackup} variant="danger" label={m.common_delete()} />
    </div>
    <InlineFeedback state={deleteAction} />
  </div>
</Modal>

<!-- Modal d'import -->
<Modal bind:open={showImportModal} title={m.backups_import_modal_title()}>
  <div class="space-y-6">
    <div class="space-y-2">
      <span class="block text-xs font-semibold text-on-surface-variant/60 ml-2">{m.backups_field_file()}</span>
      <input
        type="file"
        accept=".json" 
        onchange={(e) => importFile = (e.currentTarget as HTMLInputElement).files?.[0] || null} 
        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none file:mr-4 file:py-1.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-primary file:text-on-primary hover:file:bg-primary/90 file:cursor-pointer file:transition-all"
      />
    </div>
    
    <div class="space-y-2">
      <span class="block text-xs font-semibold text-on-surface-variant/60 ml-2">{m.backups_field_name_optional()}</span>
      <input
        type="text"
        bind:value={createOptions.name}
        placeholder={m.backups_field_name_ph()}
        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
      />
    </div>

    <div class="flex justify-end gap-3 pt-2">
      <ActionButton onClick={() => showImportModal = false} variant="muted" label={m.common_cancel()} />
      <ActionButton onClick={handleImportBackup} variant="primary" label={m.backups_import_submit()} disabled={!importFile} />
    </div>
    <InlineFeedback state={importAction} />
  </div>
</Modal>

<!-- Modal de restauration -->
<Modal bind:open={showRestoreModal} title={m.backups_restore_modal_title()}>
  <div class="space-y-4">
    <p class="text-sm font-medium">{m.backups_restore_confirm({ name: selectedBackup?.name ?? '' })}</p>
    <p class="text-xs text-warning font-bold bg-warning/10 border border-warning/20 px-4 py-3 rounded-lg flex items-center gap-2">
      <Papicon icon="AlertTriangle" size={16} />
      {m.backups_restore_warning()}
    </p>
    <div class="flex justify-end gap-3 pt-2">
      <ActionButton onClick={() => showRestoreModal = false} variant="muted" label={m.common_cancel()} />
      <ActionButton onClick={handleRestoreBackup} variant="primary" label={m.backups_restore_btn()} icon="rotate-ccw" />
    </div>
    <InlineFeedback state={restoreAction} />
  </div>
</Modal>

<!-- Modal dossier membre (auteur du backup) -->
<MemberCaseModal
  open={memberModalOpen}
  userId={memberModalUserId}
  userName={memberModalUserName}
  caseData={memberCaseData}
  loading={memberCaseLoading}
  error={memberCaseError}
  onClose={() => {
    memberModalOpen = false;
    memberModalUserId = null;
  }}
/>
