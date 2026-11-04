<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { fetchReactionRoleMenus, createReactionRoleMenu, updateReactionRoleMenu, deleteReactionRoleMenu, applyReactionRolePreset, type ReactionRoleButtonMode, type ReactionRoleButtonStyle, type ReactionRoleMenuMode, type ReactionRolePresetKey } from '../lib/api';
  import { normalizeMenuMode, resolveButtonMode, REACTION_ROLE_PRESET_KEYS, type BotRoleAccess, type RoleBlocker } from '@kotbo/contracts';
  import { dashboardRoleBlocker } from '../lib/reactionRoleBlockers';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import EmojiPicker from '../lib/components/EmojiPicker.svelte';
  import { parseDiscordEmojisAndMarkdown } from '../lib/emojiParser';

  const actionState = createAsyncActionState();
  let loading = $state(false);
  let showModal = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.reaction_roles?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  let menus = $state<Array<{
    id: string;
    channelId: string;
    messageId: string | null;
    title: string;
    buttonMode?: string;
    options: any; // Array of { emoji?: string; label: string; roleId: string; mode?: 'toggle' | 'add_only' }
    createdAt: string;
  }>>([]);

  /** Ce que le bot peut attribuer : sert à signaler les rôles qu'il ne pourra pas donner. */
  let botRoleAccess = $state<BotRoleAccess | null>(null);

  // Form states
  let editingMenuId = $state<string | null>(null);
  let formTitle = $state('');
  let formChannelId = $state('');
  let formButtonMode = $state<ReactionRoleMenuMode>('toggle');
  let applyingPreset = $state<ReactionRolePresetKey | null>(null);
  // `mode: ''` = le bouton suit le mode du panneau.
  let formOptions = $state<Array<{ emoji: string; label: string; roleId: string; mode: ReactionRoleButtonMode | ''; style: ReactionRoleButtonStyle }>>([
    { emoji: '', label: '', roleId: '', mode: '', style: 'secondary' }
  ]);

  // Les couleurs Discord des quatre styles de bouton, reprises telles quelles
  // pour que l'aperçu montre ce que les membres verront.
  const PREVIEW_STYLE_CLASSES: Record<ReactionRoleButtonStyle, string> = {
    secondary: 'bg-[#4f545c] hover:bg-[#686d73]',
    primary: 'bg-[#5865f2] hover:bg-[#4752c4]',
    success: 'bg-[#248046] hover:bg-[#1a6334]',
    danger: 'bg-[#da373c] hover:bg-[#a12828]',
  };

  const STYLE_BADGE_CLASSES: Record<ReactionRoleButtonStyle, string> = {
    secondary: 'bg-[#4f545c]/15 text-[#8e9297] border-[#4f545c]/30',
    primary: 'bg-[#5865f2]/15 text-[#5865f2] border-[#5865f2]/30',
    success: 'bg-[#248046]/15 text-[#3ba55d] border-[#248046]/30',
    danger: 'bg-[#da373c]/15 text-[#da373c] border-[#da373c]/30',
  };

  function modeLabel(mode: string | null | undefined) {
    switch (normalizeMenuMode(mode)) {
      case 'add_only': return m.reaction_roles_mode_add_only_label();
      case 'exclusive': return m.reaction_roles_mode_exclusive_label();
      default: return m.reaction_roles_mode_toggle_label();
    }
  }

  const MODE_ICONS: Record<ReactionRoleMenuMode, string> = {
    toggle: 'Settings',
    add_only: 'Lock',
    exclusive: 'CheckCircle',
  };

  function modeDescription(mode: ReactionRoleMenuMode) {
    switch (mode) {
      case 'add_only': return m.reaction_roles_mode_add_only_desc();
      case 'exclusive': return m.reaction_roles_mode_exclusive_desc();
      default: return m.reaction_roles_mode_toggle_desc();
    }
  }

  const BLOCKER_MESSAGES: Record<RoleBlocker, () => string> = {
    missing: m.reaction_roles_blocked_missing,
    managed: m.reaction_roles_blocked_managed,
    no_permission: m.reaction_roles_blocked_no_permission,
    too_high: m.reaction_roles_blocked_too_high,
  };

  function blockerOf(roleId: string): RoleBlocker | null {
    return dashboardRoleBlocker(roleId, availableRoles, botRoleAccess);
  }

  /** Rôles distincts du menu que le bot ne pourra pas donner. */
  function blockedRoleIds(options: unknown): string[] {
    if (!Array.isArray(options)) return [];
    return [...new Set(options.map((opt: { roleId?: string }) => opt?.roleId ?? ''))].filter((id) => !!blockerOf(id));
  }

  const PRESET_LABELS: Record<ReactionRolePresetKey, () => string> = {
    colors: m.reaction_roles_preset_colors,
    pronouns: m.reaction_roles_preset_pronouns,
    notifications: m.reaction_roles_preset_notifications,
  };

  const PRESET_ICONS: Record<ReactionRolePresetKey, string> = {
    colors: 'Palette',
    pronouns: 'User',
    notifications: 'Bell',
  };

  function resolveStyle(style: string | null | undefined): ReactionRoleButtonStyle {
    return style === 'primary' || style === 'success' || style === 'danger' ? style : 'secondary';
  }

  function styleLabel(style: string | null | undefined) {
    switch (resolveStyle(style)) {
      case 'primary': return m.reaction_roles_style_primary_label();
      case 'success': return m.reaction_roles_style_success_label();
      case 'danger': return m.reaction_roles_style_danger_label();
      default: return m.reaction_roles_style_secondary_label();
    }
  }

  const editedMenu = $derived(menus.find(item => item.id === editingMenuId) ?? null);

  const previewSubtitle = $derived.by(() => {
    if (formButtonMode === 'exclusive') return m.reaction_roles_preview_subtitle_exclusive();
    const modes = new Set(formOptions.map(opt => resolveButtonMode(opt.mode, formButtonMode)));
    if (modes.size > 1) return m.reaction_roles_preview_subtitle_mixed();
    if (modes.has('add_only')) return m.reaction_roles_preview_subtitle_add_only();
    return m.reaction_roles_preview_subtitle();
  });

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchReactionRoleMenus();
      if (res && res.menus) {
        menus = res.menus;
        botRoleAccess = res.botRoleAccess ?? null;
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  function openCreateModal() {
    editingMenuId = null;
    formTitle = '';
    formChannelId = '';
    formButtonMode = 'toggle';
    formOptions = [{ emoji: '', label: '', roleId: '', mode: '', style: 'secondary' }];
    actionState.clearFeedback();
    showModal = true;
  }

  function openEditModal(menu: (typeof menus)[number]) {
    editingMenuId = menu.id;
    formTitle = menu.title;
    formChannelId = menu.channelId;
    formButtonMode = normalizeMenuMode(menu.buttonMode);

    const options = Array.isArray(menu.options) ? menu.options : [];
    formOptions = options.map((opt: any) => ({
      emoji: opt?.emoji ?? '',
      label: opt?.label ?? '',
      roleId: opt?.roleId ?? '',
      mode: opt?.mode === 'add_only' || opt?.mode === 'toggle' ? opt.mode : '',
      style: resolveStyle(opt?.style),
    }));

    if (formOptions.length === 0) {
      formOptions = [{ emoji: '', label: '', roleId: '', mode: '', style: 'secondary' }];
    }

    actionState.clearFeedback();
    showModal = true;
  }

  function addOption() {
    if (formOptions.length >= 20) return;
    formOptions = [...formOptions, { emoji: '', label: '', roleId: '', mode: '', style: 'secondary' }];
  }

  function removeOption(idx: number) {
    if (formOptions.length === 1) return;
    formOptions = formOptions.filter((_, i) => i !== idx);
  }

  async function handleSubmit() {
    if (!canManageSettings || !formTitle || !formChannelId || formOptions.length === 0) return;

    const invalidOpt = formOptions.some(o => !o.label || !o.roleId);
    if (invalidOpt) {
      actionState.setError(m.reaction_roles_all_buttons_required_error());
      return;
    }

    const payload = {
      title: formTitle,
      channelId: formChannelId,
      buttonMode: formButtonMode,
      options: formOptions.map(opt => ({
        emoji: opt.emoji,
        label: opt.label,
        roleId: opt.roleId,
        // Un menu « un seul rôle » n'a pas de mode par bouton.
        ...(opt.mode && formButtonMode !== 'exclusive' ? { mode: opt.mode } : {}),
        ...(opt.style !== 'secondary' ? { style: opt.style } : {}),
      })),
    };

    const menuId = editingMenuId;

    if (menuId) {
      await actionState.run(async () => {
        const res = await updateReactionRoleMenu(menuId, payload);
        if (!res || !res.menu) throw new Error(m.reaction_roles_update_error());
        menus = menus.map(item => (item.id === menuId ? res.menu : item));
        showModal = false;
        return true;
      }, { successMessage: m.reaction_roles_update_success() });
      return;
    }

    await actionState.run(async () => {
      const res = await createReactionRoleMenu(payload);

      if (!res || !res.menu) throw new Error(m.reaction_roles_deploy_error());
      menus = [res.menu, ...menus];
      showModal = false;
      return true;
    }, { successMessage: m.reaction_roles_deploy_success() });
  }

  /**
   * Crée les rôles d'un menu tout prêt puis remplit le formulaire. Le salon
   * reste à choisir : rien n'est publié avant l'envoi du formulaire.
   */
  async function applyPreset(key: ReactionRolePresetKey) {
    if (!canManageSettings || applyingPreset) return;
    applyingPreset = key;
    try {
      await actionState.run(async () => {
        const res = await applyReactionRolePreset(key);
        const preset = res?.preset;
        if (!preset) throw new Error(m.reaction_roles_preset_error());
        // Les rôles créés doivent figurer dans les listes avant d'être affichés.
        await dashboardStore.refresh();
        formTitle = preset.title;
        formButtonMode = normalizeMenuMode(preset.buttonMode);
        formOptions = preset.options.map((opt: { label: string; roleId: string }) => ({
          emoji: '', label: opt.label, roleId: opt.roleId, mode: '' as const, style: 'secondary' as const,
        }));
        actionState.setMessage(m.reaction_roles_preset_applied({ n: preset.createdRoles }));
        return true;
      });
    } finally {
      applyingPreset = null;
    }
  }

  async function handleDelete(id: string) {
    if (!canManageSettings) return;
    if (!(await confirmDialog.danger(m.reaction_roles_confirm_delete_title(), m.reaction_roles_confirm_delete_desc()))) return;
    await actionState.run(async () => {
      const ok = await deleteReactionRoleMenu(id);
      if (!ok) throw new Error(m.reaction_roles_delete_error());
      menus = menus.filter(m => m.id !== id);
      return true;
    }, { successMessage: m.reaction_roles_delete_success() });
  }

  function getChannelName(channelId: string) {
    const channel = availableChannels.find(c => c.id === channelId);
    return channel ? channelDisplayName(channel) : m.reaction_roles_channel_unknown({ id: channelId });
  }

  function getRoleName(roleId: string) {
    const role = availableRoles.find(r => r.id === roleId);
    return role ? `@${role.name}` : m.reaction_roles_role_unknown({ id: roleId });
  }
</script>

<ModulePage
  title={m.reaction_roles_title()}
  description={m.reaction_roles_desc()}
  icon="mouse-pointer"
  featureKey="reaction_roles"
>
  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="space-y-4">
      <Skeleton height="100px" radius="2rem" />
      <Skeleton height="100px" radius="2rem" />
      <Skeleton height="100px" radius="2rem" />
    </div>
  {:else}
    <div class="space-y-6">
      <!-- Title & Actions Bar -->
      <div class="flex items-center justify-between gap-4 flex-wrap">
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="List" size={20} class="text-secondary" />
          {m.reaction_roles_deployed_panels({ n: menus.length })}
        </h3>

        {#if canManageSettings}
          <button
            onclick={openCreateModal}
            class="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary font-medium text-body-sm rounded-lg transition-all cursor-pointer"
          >
            <Papicon icon="Add" size={16} />
            {m.reaction_roles_deploy_panel_btn()}
          </button>
        {/if}
      </div>

      <!-- Menus list -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {#each menus as menu}
          {@const blocked = blockedRoleIds(menu.options)}
          <div class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl flex flex-col justify-between hover:bg-surface-container-low/50 hover:border-outline-variant/20 hover:shadow-sm hover:shadow-primary/5 transition-all duration-300 relative group">
            <div class="space-y-4">
              <div class="flex items-start justify-between gap-4">
                <!-- Menu info -->
                <div class="space-y-1.5 flex-1 min-w-0">
                  <h4 class="text-lg font-semibold text-on-surface leading-tight group-hover:text-primary transition-colors duration-300 wrap-break-word">{@html parseDiscordEmojisAndMarkdown(menu.title)}</h4>
                  <div class="flex flex-wrap gap-2 text-2xs text-on-surface-variant font-semibold">
                    <span class="flex items-center gap-1 bg-surface-container-high/40 px-2 py-0.5 rounded"><Papicon icon="Hash" size={10} />{getChannelName(menu.channelId)}</span>
                    {#if menu.messageId}
                      <span class="flex items-center gap-1 bg-surface-container-high/40 px-2 py-0.5 rounded"><Papicon icon="Link" size={10} />ID : {menu.messageId}</span>
                    {/if}
                    <span class="flex items-center gap-1 bg-surface-container-high/40 px-2 py-0.5 rounded">
                      <Papicon icon={MODE_ICONS[normalizeMenuMode(menu.buttonMode)]} size={10} />{modeLabel(menu.buttonMode)}
                    </span>
                  </div>
                  {#if blocked.length > 0}
                    <p class="flex items-center gap-1.5 text-2xs font-semibold text-error">
                      <Papicon icon="AlertTriangle" size={12} />{m.reaction_roles_blocked_summary({ n: blocked.length })}
                    </p>
                  {/if}
                </div>

                {#if canManageSettings}
                  <div class="flex items-center gap-1 shrink-0">
                    <button
                      onclick={() => openEditModal(menu)}
                      class="p-2 text-on-surface-variant hover:text-primary hover:bg-primary/10 border border-transparent rounded-xl transition-all cursor-pointer"
                      title={m.reaction_roles_edit_button_title()}
                    >
                      <Papicon icon="Pencil" size={16} />
                    </button>
                    <button
                      onclick={() => handleDelete(menu.id)}
                      class="p-2 text-error hover:bg-error/10 border border-transparent rounded-xl transition-all cursor-pointer"
                      title={m.reaction_roles_delete_tooltip()}
                    >
                      <Papicon icon="Trash" size={16} />
                    </button>
                  </div>
                {/if}
              </div>

              <!-- Buttons listing -->
              <div class="flex flex-wrap gap-2 pt-4 border-t border-outline-variant/10">
                {#if Array.isArray(menu.options)}
                  {#each menu.options as opt}
                    {@const blocker = blockerOf(opt.roleId)}
                    <div class="flex items-center gap-2 px-3 py-2 bg-surface-container-high/60 border border-outline-variant/10 rounded-xl text-xs font-bold text-on-surface hover:bg-surface-container-high transition-all">
                      {#if opt.emoji}<span class="text-base">{@html parseDiscordEmojisAndMarkdown(opt.emoji)}</span>{/if}
                      <span>{opt.label}</span>
                      {#if blocker}
                        <span
                          class="flex items-center gap-1 text-2xs bg-error/10 text-error border border-error/30 px-1.5 py-0.5 rounded font-semibold"
                          title={BLOCKER_MESSAGES[blocker]()}
                        >
                          <Papicon icon="AlertTriangle" size={10} />{getRoleName(opt.roleId)}
                        </span>
                      {:else}
                        <span class="text-2xs bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded font-semibold">
                          {getRoleName(opt.roleId)}
                        </span>
                      {/if}
                      {#if opt.mode && opt.mode !== menu.buttonMode && normalizeMenuMode(menu.buttonMode) !== 'exclusive'}
                        <span class="text-2xs bg-secondary/10 text-secondary border border-secondary/20 px-1.5 py-0.5 rounded font-semibold">
                          {modeLabel(opt.mode)}
                        </span>
                      {/if}
                      {#if opt.style && opt.style !== 'secondary'}
                        <span class="text-2xs border px-1.5 py-0.5 rounded font-semibold {STYLE_BADGE_CLASSES[resolveStyle(opt.style)]}">
                          {styleLabel(opt.style)}
                        </span>
                      {/if}
                    </div>
                  {/each}
                {:else}
                  <p class="text-xs text-on-surface-variant/40 italic">{m.reaction_roles_invalid_options()}</p>
                {/if}
              </div>
            </div>
          </div>
        {:else}
          <div class="col-span-full flex flex-col items-center justify-center py-20 bg-surface-container-low/20 border border-outline-variant/10 rounded-xl text-center">
            <Papicon icon="MousePointer" size={32} class="text-on-surface-variant/20 mb-3" />
            <p class="text-sm text-on-surface-variant font-medium">{m.reaction_roles_empty_title()}</p>
            {#if canManageSettings}
              <button
                onclick={openCreateModal}
                class="mt-4 flex items-center gap-2 px-4 py-2 bg-primary/10 hover:bg-primary/20 text-primary font-bold text-xs rounded-lg transition-all cursor-pointer"
              >
                <Papicon icon="Add" size={14} /> {m.reaction_roles_empty_btn()}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</ModulePage>

<!-- Modal Déployer un Panel -->
{#if showModal}
  <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
    <div class="bg-surface-container-low/95 border border-outline-variant/20 max-w-3xl w-full rounded-xl p-8 space-y-6 shadow-sm relative max-h-[90vh] overflow-y-auto" transition:scale={{ start: 0.97, duration: 150 }}>

      <!-- Close button -->
      <button
        onclick={() => showModal = false}
        class="absolute top-6 right-6 p-2 rounded-full bg-surface-container-high/40 hover:bg-error/15 hover:text-error text-on-surface-variant transition-colors cursor-pointer z-10"
        title={m.reaction_roles_close()}
      >
        <Papicon icon="Cross" size={20} />
      </button>

      <!-- Modal Header -->
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center text-primary shadow-inner">
          <Papicon icon={editingMenuId ? 'Pencil' : 'Add'} size={24} />
        </div>
        <div>
          <h3 class="text-2xl font-semibold tracking-tight">
            {editingMenuId ? m.reaction_roles_modal_title_edit() : m.reaction_roles_modal_title()}
          </h3>
          <p class="text-xs text-on-surface-variant/80 font-medium">
            {editingMenuId ? m.reaction_roles_modal_desc_edit() : m.reaction_roles_modal_desc()}
          </p>
        </div>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-6 pt-2">
        <InlineFeedback state={actionState} />

        {#if !editingMenuId && canManageSettings}
          <div class="p-4 rounded-lg bg-surface-container-high/40 border border-outline-variant/10 space-y-3">
            <div>
              <p class="text-sm font-medium text-on-surface">{m.reaction_roles_presets_title()}</p>
              <p class="text-2xs text-on-surface-variant mt-0.5">{m.reaction_roles_presets_desc()}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              {#each REACTION_ROLE_PRESET_KEYS as key (key)}
                <button
                  type="button"
                  onclick={() => applyPreset(key)}
                  disabled={applyingPreset !== null}
                  aria-busy={applyingPreset === key}
                  class="flex items-center gap-2 min-h-11 px-4 rounded-lg bg-surface-container border border-outline-variant/20 text-xs font-semibold text-on-surface hover:border-primary/40 hover:text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                >
                  <Papicon icon={PRESET_ICONS[key]} size={14} />
                  {PRESET_LABELS[key]()}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label for="modal-title" class="text-xs font-semibold text-on-surface-variant ml-2">{m.reaction_roles_field_title()}</label>
            <input
              id="modal-title"
              type="text"
              bind:value={formTitle}
              placeholder={m.reaction_roles_field_title_ph()}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
              required
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="modal-channel" class="text-xs font-semibold text-on-surface-variant ml-2">{m.reaction_roles_field_channel()}</label>
            <SearchableSelect
              id="modal-channel"
              bind:value={formChannelId}
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
              placeholder={m.announcements_select_channel_placeholder()}
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        {#if editedMenu && formChannelId && formChannelId !== editedMenu.channelId}
          <p class="flex items-center gap-2 text-2xs text-on-surface-variant/80 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2">
            <Papicon icon="Info" size={14} />
            {m.reaction_roles_moved_channel_notice()}
          </p>
        {/if}

        <div class="space-y-1.5">
          <label for="modal-mode" class="text-xs font-semibold text-on-surface-variant ml-2">{m.reaction_roles_field_mode()}</label>
          <FormSelect
            id="modal-mode"
            bind:value={formButtonMode}
            disabled={!canManageSettings}
            className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
          >
            <option value="toggle">{m.reaction_roles_mode_toggle_label()}</option>
            <option value="add_only">{m.reaction_roles_mode_add_only_label()}</option>
            <option value="exclusive">{m.reaction_roles_mode_exclusive_label()}</option>
          </FormSelect>
          <p class="text-2xs text-on-surface-variant ml-2">
            {modeDescription(formButtonMode)}
          </p>
        </div>

        <!-- Live Discord Message Preview -->
        <div class="p-5 rounded-xl bg-[#36393f] border border-[#202225] text-[#dcddde] font-sans space-y-3 shadow-inner">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-[#8e9297] select-none">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> {m.reaction_roles_live_preview()}
          </div>

          <div class="flex items-start gap-4">
            <!-- Bot Avatar Mock -->
            <div class="w-10 h-10 rounded-full bg-[#5865f2] flex items-center justify-center text-white font-bold shrink-0 shadow-md">
              K
            </div>

            <!-- Message content -->
            <div class="space-y-3 flex-1 min-w-0">
              <div class="flex items-center gap-2 select-none">
                <span class="font-bold text-white text-sm hover:underline cursor-pointer">Kotbo</span>
                <span class="bg-[#5865f2] text-white text-2xs font-bold px-1.5 py-0.5 rounded uppercase">Bot</span>
                <span class="text-xs text-[#72767d]">{m.announcements_today_at({ time: '12:00' })}</span>
              </div>

              <!-- Message Embed / Text -->
              <div class="bg-[#2f3136] border-l-4 border-[#5865f2] rounded-r p-3 max-w-[520px] space-y-1 shadow-sm">
                <div class="text-sm font-bold text-white wrap-break-word">
                  {@html parseDiscordEmojisAndMarkdown(formTitle || m.reaction_roles_field_title_ph())}
                </div>
                <div class="text-xs text-[#b9bbbe]">
                  {previewSubtitle}
                </div>
              </div>

              <!-- Buttons Row -->
              <div class="flex flex-wrap gap-2 pt-1">
                {#each formOptions as opt}
                  {#if opt.label || opt.emoji}
                    <button
                      type="button"
                      class="flex items-center gap-1.5 px-3 py-1.5 text-white text-xs font-semibold rounded transition-colors {PREVIEW_STYLE_CLASSES[resolveStyle(opt.style)]}"
                    >
                      {#if opt.emoji}<span>{@html parseDiscordEmojisAndMarkdown(opt.emoji)}</span>{/if}
                      <span>{opt.label || m.reaction_roles_preview_button_default()}</span>
                    </button>
                  {/if}
                {/each}
              </div>
            </div>
          </div>
        </div>

        <!-- Options / Boutons -->
        <div class="space-y-3 pt-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-on-surface-variant ml-2">
              {m.reaction_roles_buttons_config({ n: formOptions.length })}
              {#if formButtonMode === 'exclusive'}
                <span class="block font-normal text-2xs">{m.reaction_roles_exclusive_buttons_note()}</span>
              {/if}
            </span>
            <button
              type="button"
              onclick={addOption}
              disabled={formOptions.length >= 20}
              use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
              class="text-xs font-bold text-primary hover:text-primary/80 transition-colors flex items-center gap-1 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Papicon icon="Plus" size={14} /> {m.reaction_roles_add_button()}
            </button>
          </div>

          <div class="space-y-4">
            {#each formOptions as opt, idx}
              <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-3">
                <div class="flex items-center justify-between">
                  <p class="text-sm font-bold flex items-center gap-1.5">
                    <Papicon icon="MousePointer" size={16} />
                    {m.reaction_roles_button_num({ n: idx + 1 })}
                  </p>
                  {#if formOptions.length > 1 && canManageSettings}
                    <button
                      type="button"
                      onclick={() => removeOption(idx)}
                      class="p-2 text-error hover:bg-error/10 rounded-lg transition-all cursor-pointer"
                      title={m.reaction_roles_remove_button_title()}
                    >
                      <Papicon icon="Minus" size={16} />
                    </button>
                  {/if}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div class="space-y-1">
                    <label for={`modal-emoji-${idx}`} class="text-2xs font-semibold text-on-surface-variant uppercase">{m.reaction_roles_field_emoji()}</label>
                    <div class="flex gap-2 items-center">
                      <input
                        id={`modal-emoji-${idx}`}
                        type="text"
                        bind:value={opt.emoji}
                        placeholder="📢"
                        class="flex-1 bg-surface-container rounded-lg px-3 py-2 text-xs text-on-surface border border-outline-variant/10 focus:ring-2 focus:ring-primary/30 focus:outline-none transition-all"
                        disabled={!canManageSettings}
                      />
                      <EmojiPicker bind:value={opt.emoji} disabled={!canManageSettings} />
                    </div>
                  </div>

                  <div class="space-y-1">
                    <label for={`modal-label-${idx}`} class="text-2xs font-semibold text-on-surface-variant uppercase">{m.reaction_roles_field_label()}</label>
                    <input
                      id={`modal-label-${idx}`}
                      type="text"
                      bind:value={opt.label}
                      placeholder={m.reaction_roles_field_label_ph()}
                      class="w-full bg-surface-container rounded-lg px-3 py-2 text-xs text-on-surface border border-outline-variant/10 focus:ring-2 focus:ring-primary/30 focus:outline-none transition-all"
                      required
                      disabled={!canManageSettings}
                    />
                  </div>
                </div>

                <div class="grid grid-cols-1 gap-3 {formButtonMode === 'exclusive' ? 'md:grid-cols-2' : 'md:grid-cols-3'}">
                  <div class="space-y-1">
                    <label for={`modal-role-${idx}`} class="text-2xs font-semibold text-on-surface-variant uppercase">{m.reaction_roles_field_role()}</label>
                    <SearchableSelect
                      id={`modal-role-${idx}`}
                      bind:value={opt.roleId}
                      options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
                      placeholder={m.reaction_roles_select_role_ph()}
                      className="w-full rounded-lg bg-surface-container px-3 py-2 text-xs text-on-surface focus:ring-2 focus:ring-primary/30 transition-all"
                      disabled={!canManageSettings}
                    />
                    {#if blockerOf(opt.roleId)}
                      {@const blocker = blockerOf(opt.roleId)!}
                      <p class="flex items-start gap-1 text-2xs text-error">
                        <Papicon icon="AlertTriangle" size={12} class="mt-px shrink-0" />{BLOCKER_MESSAGES[blocker]()}
                      </p>
                    {/if}
                  </div>

                  {#if formButtonMode !== 'exclusive'}
                  <div class="space-y-1">
                    <label for={`modal-mode-${idx}`} class="text-2xs font-semibold text-on-surface-variant uppercase">{m.reaction_roles_button_mode()}</label>
                    <FormSelect
                      id={`modal-mode-${idx}`}
                      bind:value={opt.mode}
                      disabled={!canManageSettings}
                      className="w-full rounded-lg bg-surface-container px-3 py-2 text-xs text-on-surface border border-outline-variant/10 focus:ring-2 focus:ring-primary/30 focus:outline-none transition-all"
                    >
                      <option value="">{m.reaction_roles_mode_inherit()} ({modeLabel(formButtonMode)})</option>
                      <option value="toggle">{m.reaction_roles_mode_toggle_label()}</option>
                      <option value="add_only">{m.reaction_roles_mode_add_only_label()}</option>
                    </FormSelect>
                  </div>
                  {/if}

                  <div class="space-y-1">
                    <label for={`modal-style-${idx}`} class="text-2xs font-semibold text-on-surface-variant uppercase">{m.reaction_roles_button_style()}</label>
                    <FormSelect
                      id={`modal-style-${idx}`}
                      bind:value={opt.style}
                      disabled={!canManageSettings}
                      className="w-full rounded-lg bg-surface-container px-3 py-2 text-xs text-on-surface border border-outline-variant/10 focus:ring-2 focus:ring-primary/30 focus:outline-none transition-all"
                    >
                      <option value="secondary">{m.reaction_roles_style_secondary_label()}</option>
                      <option value="primary">{m.reaction_roles_style_primary_label()}</option>
                      <option value="success">{m.reaction_roles_style_success_label()}</option>
                      <option value="danger">{m.reaction_roles_style_danger_label()}</option>
                    </FormSelect>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        </div>

        <div class="flex justify-end gap-3 pt-4 border-t border-outline-variant/10">
          <button
            type="button"
            onclick={() => showModal = false}
            class="px-6 py-3 bg-outline-variant/20 hover:bg-outline-variant/30 text-on-surface text-body-sm font-medium rounded-lg transition-all cursor-pointer"
          >
            {m.reaction_roles_cancel()}
          </button>
          {#if canManageSettings}
            <button
              type="submit"
              class="px-8 py-3 bg-primary text-on-primary font-medium text-body-sm rounded-lg transition-all cursor-pointer"
            >
              {editingMenuId ? m.reaction_roles_save_confirm() : m.reaction_roles_deploy_confirm()}
            </button>
          {/if}
        </div>
      </form>
    </div>
  </div>
{/if}
