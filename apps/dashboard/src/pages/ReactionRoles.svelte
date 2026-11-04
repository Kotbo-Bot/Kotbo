<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { fade, fly, scale, slide } from 'svelte/transition';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { fetchReactionRoleMenus, createReactionRoleMenu, updateReactionRoleMenu, deleteReactionRoleMenu, fetchReactionRolePreset, republishReactionRoleMenu, type ReactionRoleButtonMode, type ReactionRoleButtonStyle, type ReactionRoleMenuMode, type ReactionRolePresetKey } from '../lib/api';
  import { BUTTON_LABEL_MAX_LENGTH, buttonLabelWithCount, normalizeMenuMode, resolveButtonMode, REACTION_ROLE_PRESET_KEYS, type BotRoleAccess, type RoleBlocker } from '@kotbo/contracts';
  import { dashboardRoleBlocker } from '../lib/reactionRoleBlockers';
  import EmojiPicker from '../lib/components/EmojiPicker.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import FormColorPicker from '../lib/components/FormColorPicker.svelte';
  import ReactionRoleDiscordPreview from '../lib/components/ReactionRoleDiscordPreview.svelte';
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
    description?: string | null;
    showCounts?: boolean;
    embedColor?: string | null;
    options: any; // Array of { emoji?: string; label: string; roleId: string; mode?: 'toggle' | 'add_only' }
    createdAt: string;
  }>>([]);

  /** Ce que le bot peut attribuer : sert à signaler les rôles qu'il ne pourra pas donner. */
  let botRoleAccess = $state<BotRoleAccess | null>(null);
  /** Membres qui portent chaque rôle des menus. */
  let memberCounts = $state<Record<string, number>>({});
  /** Le message de chaque menu est-il toujours sur Discord ? */
  type MessageStatus = 'ok' | 'missing' | 'unknown';
  let messageStatuses = $state<Record<string, MessageStatus>>({});
  let republishingId = $state<string | null>(null);

  // Form states
  let editingMenuId = $state<string | null>(null);
  let formTitle = $state('');
  /** Texte sous le titre ; vide, le bot affiche celui qui explique le mode. */
  let formDescription = $state('');
  /** Nombre de membres de chaque rôle affiché sur son bouton. */
  let formShowCounts = $state(false);
  /** Couleur de la barre de l'embed ; vide, le bleu Discord. */
  let formEmbedColor = $state('');
  let formChannelId = $state('');
  let formButtonMode = $state<ReactionRoleMenuMode>('toggle');
  let applyingPreset = $state<ReactionRolePresetKey | null>(null);
  /**
   * Volet « options secondaires », ouvert par l'onglet collé au bord de la
   * fenêtre : couleur et second clic bouton par bouton, rarement utiles.
   */
  let showAdvanced = $state(false);
  /** Aperçu Discord, dans un volet dépliant sous les étapes. */
  let showPreview = $state(false);
  // `mode: ''` = le bouton suit le mode du panneau.
  type NewRole = { name: string; color?: number };
  // `newRole` : rôle proposé par un modèle, créé seulement à la publication.
  let formOptions = $state<Array<{ emoji: string; label: string; roleId: string; mode: ReactionRoleButtonMode | ''; style: ReactionRoleButtonStyle; newRole?: NewRole | null }>>([
    { emoji: '', label: '', roleId: '', mode: '', style: 'secondary' }
  ]);

  // Les couleurs Discord des quatre styles de bouton, reprises telles quelles
  // pour que l'aperçu montre ce que les membres verront.
  const PREVIEW_STYLE_CLASSES: Record<ReactionRoleButtonStyle, string> = {
    secondary: 'bg-[#4e5058] hover:bg-[#6d6f78]',
    primary: 'bg-[#5865f2] hover:bg-[#4752c4]',
    success: 'bg-[#248046] hover:bg-[#1a6334]',
    danger: 'bg-[#da373c] hover:bg-[#a12828]',
  };

  /** Couleur de la barre de l'embed quand le staff n'en choisit pas. */
  const DEFAULT_EMBED_COLOR = '#5865F2';

  function modeLabel(mode: string | null | undefined) {
    switch (normalizeMenuMode(mode)) {
      case 'add_only': return m.reaction_roles_mode_add_only_label();
      case 'exclusive': return m.reaction_roles_mode_exclusive_label();
      default: return m.reaction_roles_mode_toggle_label();
    }
  }

  /** Mode propre à un bouton, nommé par ce qu'il fait au second clic. */
  function buttonModeLabel(mode: string | null | undefined) {
    return mode === 'add_only' ? m.reaction_roles_button_mode_add_only() : m.reaction_roles_button_mode_toggle();
  }

  /**
   * Le menu affiche-t-il les nombres ou une couleur à lui, ou un bouton a-t-il
   * une couleur ou un second clic à lui ? L'onglet le signale.
   * En mode « Un seul », le second clic d'un bouton ne compte pas : il est ignoré.
   */
  const hasCustomOptions = $derived(formShowCounts || !!formEmbedColor || formOptions.some(opt =>
    opt.style !== 'secondary' || (opt.mode !== '' && formButtonMode !== 'exclusive')));

  const BUTTON_STYLES: ReactionRoleButtonStyle[] = ['secondary', 'primary', 'success', 'danger'];

  const BUTTON_MODE_SEGMENTS: Array<{ value: ReactionRoleButtonMode | ''; label: () => string }> = [
    { value: '', label: m.reaction_roles_mode_inherit },
    { value: 'toggle', label: m.reaction_roles_button_mode_toggle },
    { value: 'add_only', label: m.reaction_roles_button_mode_add_only },
  ];

  /** Les trois réponses à « Combien de rôles un membre peut prendre ? ». */
  const MODE_CHOICES: ReactionRoleMenuMode[] = ['toggle', 'exclusive', 'add_only'];

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

  const PRESET_DESCRIPTIONS: Record<ReactionRolePresetKey, () => string> = {
    colors: m.reaction_roles_preset_colors_desc,
    pronouns: m.reaction_roles_preset_pronouns_desc,
    notifications: m.reaction_roles_preset_notifications_desc,
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

  /** Texte affiché par le bot quand le staff n'en a pas saisi : il dépend du mode. */
  function defaultSubtitle(mode: ReactionRoleMenuMode, options: Array<{ mode?: string | null }>): string {
    if (mode === 'exclusive') return m.reaction_roles_preview_subtitle_exclusive();
    const modes = new Set(options.map(opt => resolveButtonMode(opt.mode, mode)));
    if (modes.size > 1) return m.reaction_roles_preview_subtitle_mixed();
    if (modes.has('add_only')) return m.reaction_roles_preview_subtitle_add_only();
    return m.reaction_roles_preview_subtitle();
  }

  const previewSubtitle = $derived(defaultSubtitle(formButtonMode, formOptions));

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchReactionRoleMenus();
      if (res && res.menus) {
        menus = res.menus;
        botRoleAccess = res.botRoleAccess ?? null;
        memberCounts = res.memberCounts ?? {};
        messageStatuses = res.messageStatuses ?? {};
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  /** Formulaire vierge ; le salon choisi est gardé quand on repart de zéro. */
  function resetForm() {
    formTitle = '';
    formDescription = '';
    formShowCounts = false;
    formEmbedColor = '';
    formButtonMode = 'toggle';
    formOptions = [{ emoji: '', label: '', roleId: '', mode: '', style: 'secondary' }];
  }

  function openCreateModal() {
    editingMenuId = null;
    formChannelId = '';
    resetForm();
    showAdvanced = false;
    showPreview = false;
    actionState.clearFeedback();
    showModal = true;
  }

  /** Ouvre la création déjà remplie par un modèle, depuis la page vide. */
  async function startFromPreset(key: ReactionRolePresetKey) {
    openCreateModal();
    await applyPreset(key);
  }

  function openEditModal(menu: (typeof menus)[number]) {
    editingMenuId = menu.id;
    formTitle = menu.title;
    formDescription = menu.description ?? '';
    formShowCounts = menu.showCounts === true;
    formEmbedColor = menu.embedColor ?? '';
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

    showAdvanced = false;
    showPreview = false;
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

  /** Déplace un bouton dans la liste : l'ordre est celui du message publié. */
  function moveOption(from: number, to: number) {
    if (to < 0 || to >= formOptions.length || from === to) return;
    const next = [...formOptions];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    formOptions = next;
  }

  /** Réordonner n'a de sens qu'à partir de deux boutons, et pour qui peut configurer. */
  const canReorder = $derived(canManageSettings && formOptions.length > 1);

  /** Glisser-déposer : bouton saisi par sa poignée, et place visée. */
  let dragIndex = $state<number | null>(null);
  let dropIndex = $state<number | null>(null);

  function dropOption() {
    if (dragIndex !== null && dropIndex !== null) moveOption(dragIndex, dropIndex);
    dragIndex = null;
    dropIndex = null;
  }

  /** Flèches haut et bas sur la poignée : le même déplacement, au clavier. */
  function handleGripKeydown(event: KeyboardEvent, idx: number) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const to = event.key === 'ArrowUp' ? idx - 1 : idx + 1;
    moveOption(idx, to);
    // La poignée suit son bouton : on peut enchaîner les déplacements.
    requestAnimationFrame(() => document.getElementById(`reaction-role-grip-${to}`)?.focus());
  }

  async function handleSubmit() {
    if (!canManageSettings || !formTitle || !formChannelId || formOptions.length === 0) return;

    const invalidOpt = formOptions.some(o => !buttonLabel(o) || (!o.roleId && !o.newRole));
    if (invalidOpt) {
      actionState.setError(m.reaction_roles_all_buttons_required_error());
      return;
    }

    const payload = {
      title: formTitle,
      description: formDescription.trim() || null,
      showCounts: formShowCounts,
      embedColor: formEmbedColor || null,
      channelId: formChannelId,
      buttonMode: formButtonMode,
      options: formOptions.map(opt => ({
        emoji: opt.emoji,
        label: buttonLabel(opt),
        roleId: opt.roleId,
        ...(!opt.roleId && opt.newRole ? { newRole: opt.newRole } : {}),
        // Un menu « un seul rôle » n'a pas de mode par bouton.
        ...(opt.mode && formButtonMode !== 'exclusive' ? { mode: opt.mode } : {}),
        ...(opt.style !== 'secondary' ? { style: opt.style } : {}),
      })),
    };

    const menuId = editingMenuId;
    // Les rôles créés à la publication doivent rejoindre les listes du dashboard.
    const createsRoles = pendingNewRoles > 0;

    if (menuId) {
      await actionState.run(async () => {
        const res = await updateReactionRoleMenu(menuId, payload);
        if (!res || !res.menu) throw new Error(m.reaction_roles_update_error());
        menus = menus.map(item => (item.id === menuId ? res.menu : item));
        messageStatuses = { ...messageStatuses, [menuId]: res.menu.messageId ? 'ok' : 'missing' };
        if (createsRoles) await dashboardStore.refresh();
        showModal = false;
        return true;
      }, { successMessage: m.reaction_roles_update_success() });
      return;
    }

    await actionState.run(async () => {
      const res = await createReactionRoleMenu(payload);

      if (!res || !res.menu) throw new Error(m.reaction_roles_deploy_error());
      menus = [res.menu, ...menus];
      messageStatuses = { ...messageStatuses, [res.menu.id]: res.menu.messageId ? 'ok' : 'missing' };
      if (createsRoles) await dashboardStore.refresh();
      showModal = false;
      return true;
    }, { successMessage: m.reaction_roles_deploy_success() });
  }

  /** L'étape « modèle » n'existe qu'à la création, pour qui peut configurer. */
  const showPresetStep = $derived(!editingMenuId && canManageSettings);

  type FormOption = (typeof formOptions)[number];

  /** Même limite que le bot pour le texte du message. */
  const MENU_DESCRIPTION_MAX = 1000;


  /** Nom du rôle d'un bouton : choisi dans la liste, ou proposé par un modèle. */
  function roleNameOf(opt: FormOption): string {
    if (opt.roleId) return availableRoles.find(r => r.id === opt.roleId)?.name ?? '';
    return opt.newRole?.name ?? '';
  }

  /** Texte publié sur le bouton : celui saisi, sinon le nom de son rôle. */
  function buttonLabel(opt: FormOption): string {
    return (opt.label.trim() || roleNameOf(opt)).slice(0, BUTTON_LABEL_MAX_LENGTH);
  }

  /** Texte du bouton tel que le bot le publiera, nombre de membres compris. */
  function previewLabel(opt: FormOption): string {
    const label = buttonLabel(opt);
    return formShowCounts && label ? buttonLabelWithCount(label, memberCounts[opt.roleId] ?? 0) : label;
  }

  /**
   * Boutons de l'aperçu. Tous y figurent, même incomplets : en masquer un
   * faisait croire à une limite.
   */
  const previewButtons = $derived(formOptions.map(opt => ({ emoji: opt.emoji, text: previewLabel(opt), style: opt.style })));

  /** Boutons d'un menu publié, tels que les membres les voient. */
  function cardButtons(menu: (typeof menus)[number]) {
    const options: Array<{ emoji?: string; label?: string; roleId?: string; style?: string }> = Array.isArray(menu.options) ? menu.options : [];
    return options.map(opt => ({
      emoji: opt.emoji ?? '',
      text: menu.showCounts ? buttonLabelWithCount(opt.label ?? '', memberCounts[opt.roleId ?? '']) : (opt.label ?? ''),
      style: resolveStyle(opt.style),
    }));
  }

  function cardDescription(menu: (typeof menus)[number]): string {
    return menu.description || defaultSubtitle(normalizeMenuMode(menu.buttonMode), Array.isArray(menu.options) ? menu.options : []);
  }

  /** Numéro d'une étape, décalé quand l'étape « modèle » est absente. */
  function step(n: number): number {
    return showPresetStep ? n : n - 1;
  }

  /** Rôles proposés par un modèle et pas encore remplacés : créés à la publication. */
  const pendingNewRoles = $derived(formOptions.filter(opt => !opt.roleId && opt.newRole).length);

  function roleColor(color: number | undefined): string {
    return color === undefined ? '#99aab5' : `#${color.toString(16).padStart(6, '0')}`;
  }

  /**
   * Remplit le formulaire avec un menu tout prêt. Rien n'est créé sur le
   * serveur : les rôles manquants sont proposés, et ne le seront qu'à la
   * publication. Fermer la fenêtre ne laisse donc aucun rôle derrière soi.
   */
  async function applyPreset(key: ReactionRolePresetKey) {
    if (!canManageSettings || applyingPreset) return;
    applyingPreset = key;
    try {
      await actionState.run(async () => {
        const res = await fetchReactionRolePreset(key);
        const preset = res?.preset;
        if (!preset) throw new Error(m.reaction_roles_preset_error());
        formTitle = preset.title;
        formButtonMode = normalizeMenuMode(preset.buttonMode);
        formOptions = preset.options.map((opt: { label: string; roleId: string; newRole?: NewRole | null }) => ({
          emoji: '', label: opt.label, roleId: opt.roleId, mode: '' as const, style: 'secondary' as const, newRole: opt.newRole ?? null,
        }));
        return true;
      });
    } finally {
      applyingPreset = null;
    }
  }

  /** Remet en place le message d'un menu supprimé sur Discord. */
  async function republish(menuId: string) {
    if (!canManageSettings || republishingId) return;
    republishingId = menuId;
    try {
      await actionState.run(async () => {
        const res = await republishReactionRoleMenu(menuId);
        if (!res?.menu) throw new Error(m.reaction_roles_republish_error());
        menus = menus.map(item => (item.id === menuId ? res.menu : item));
        messageStatuses = { ...messageStatuses, [menuId]: res.messageStatus };
        // Salon disparu ou écriture refusée : le bot n'a rien pu reposter.
        if (res.messageStatus === 'missing') throw new Error(m.reaction_roles_republish_failed());
        return true;
      }, { successMessage: m.reaction_roles_republish_success() });
    } finally {
      republishingId = null;
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
                  {#if messageStatuses[menu.id] === 'missing'}
                    <div class="flex items-center justify-between gap-3 flex-wrap mt-1 px-3 py-2 rounded-lg bg-error/10 border border-error/25">
                      <p class="flex items-center gap-1.5 text-2xs font-semibold text-error">
                        <Papicon icon="AlertTriangle" size={12} />{m.reaction_roles_message_missing()}
                      </p>
                      {#if canManageSettings}
                        <button
                          type="button"
                          onclick={() => republish(menu.id)}
                          disabled={republishingId !== null}
                          aria-busy={republishingId === menu.id}
                          class="flex items-center gap-1 px-2.5 py-1 rounded-md bg-error text-on-error text-2xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                        >
                          <Papicon icon="Refresh" size={11} />{m.reaction_roles_republish()}
                        </button>
                      {/if}
                    </div>
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

              <!-- Le message tel que les membres le voient -->
              <ReactionRoleDiscordPreview
                compact
                title={menu.title}
                description={cardDescription(menu)}
                buttons={cardButtons(menu)}
                color={menu.embedColor ?? DEFAULT_EMBED_COLOR}
              />

              <!-- Rôle donné par chaque bouton, avec ses membres et ce qui bloque -->
              {#if Array.isArray(menu.options)}
                <ul class="flex flex-wrap gap-1.5">
                  {#each menu.options as opt}
                    {@const blocker = blockerOf(opt.roleId)}
                    <li
                      class="flex items-center gap-1.5 px-2 py-1 rounded-lg text-2xs font-semibold border {blocker ? 'bg-error/10 text-error border-error/30' : 'bg-surface-container-high/50 text-on-surface border-outline-variant/10'}"
                      title={blocker ? BLOCKER_MESSAGES[blocker]() : undefined}
                    >
                      {#if blocker}<Papicon icon="AlertTriangle" size={10} />{/if}
                      <span>{getRoleName(opt.roleId)}</span>
                      {#if memberCounts[opt.roleId] !== undefined}
                        <span
                          class="flex items-center gap-0.5 text-on-surface-variant"
                          title={m.reaction_roles_member_count({ n: memberCounts[opt.roleId] })}
                        >
                          <Papicon icon="Users" size={10} />{memberCounts[opt.roleId]}
                        </span>
                      {/if}
                      {#if opt.mode && opt.mode !== menu.buttonMode && normalizeMenuMode(menu.buttonMode) !== 'exclusive'}
                        <span class="text-secondary">· {buttonModeLabel(opt.mode)}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="text-xs text-on-surface-variant/40 italic">{m.reaction_roles_invalid_options()}</p>
              {/if}
            </div>
          </div>
        {:else}
          <!-- Page vide : les modèles sont proposés tout de suite, en un clic -->
          <div class="col-span-full flex flex-col items-center text-center py-12 px-4 bg-surface-container-low/20 border border-outline-variant/10 rounded-xl">
            <Papicon icon="MousePointer" size={32} class="text-on-surface-variant/30 mb-3" />
            <p class="text-sm text-on-surface font-semibold">{m.reaction_roles_empty_title()}</p>
            <p class="text-xs text-on-surface-variant mt-1 max-w-md">{m.reaction_roles_empty_desc()}</p>
            {#if canManageSettings}
              <div class="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 w-full max-w-3xl">
                {#each REACTION_ROLE_PRESET_KEYS as key (key)}
                  <button
                    type="button"
                    onclick={() => startFromPreset(key)}
                    class="flex flex-col items-start gap-2 p-4 rounded-xl border border-outline-variant/20 bg-surface-container text-left hover:border-primary/40 hover:bg-primary/5 transition-colors cursor-pointer"
                  >
                    <span class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                      <Papicon icon={PRESET_ICONS[key]} size={18} />
                    </span>
                    <span class="text-sm font-semibold text-on-surface">{PRESET_LABELS[key]()}</span>
                    <span class="text-2xs text-on-surface-variant leading-relaxed">{PRESET_DESCRIPTIONS[key]()}</span>
                  </button>
                {/each}
                <button
                  type="button"
                  onclick={openCreateModal}
                  class="flex flex-col items-start gap-2 p-4 rounded-xl border border-dashed border-outline-variant/30 text-left hover:border-primary/40 hover:bg-primary/5 transition-colors cursor-pointer"
                >
                  <span class="w-9 h-9 rounded-lg bg-surface-container-high/60 text-on-surface-variant flex items-center justify-center">
                    <Papicon icon="Add" size={18} />
                  </span>
                  <span class="text-sm font-semibold text-on-surface">{m.reaction_roles_empty_btn()}</span>
                  <span class="text-2xs text-on-surface-variant leading-relaxed">{m.reaction_roles_empty_blank_desc()}</span>
                </button>
              </div>
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
    <!--
      Fenêtre et volet des options secondaires. Le volet est posé en absolu :
      l'ouvrir ne change ni la largeur ni la place de la fenêtre, qui sinon
      sautait de côté pour lui faire de la place.
    -->
    <div class="relative w-full max-w-3xl" transition:scale={{ start: 0.97, duration: 150 }}>
    <div class="bg-surface-container-low/95 border border-outline-variant/20 w-full rounded-xl p-8 space-y-6 shadow-sm relative max-h-[90vh] overflow-y-auto">

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

      {#snippet stepTitle(n: number, title: string, hint: string)}
        <p class="flex items-center gap-2.5 text-sm font-semibold text-on-surface">
          <span class="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs flex items-center justify-center shrink-0">{n}</span>
          {title}
          {#if hint}<span class="text-2xs font-normal text-on-surface-variant">{hint}</span>{/if}
        </p>
      {/snippet}

      <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-7 pt-2">
        <InlineFeedback state={actionState} />

        <!-- Étape 1 : modèle (création seulement) -->
        {#if showPresetStep}
          <section class="space-y-3">
            {@render stepTitle(1, m.reaction_roles_presets_title(), m.reaction_roles_step_optional())}
            <p class="text-2xs text-on-surface-variant">{m.reaction_roles_presets_desc()}</p>
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
              <button
                type="button"
                onclick={resetForm}
                disabled={applyingPreset !== null}
                class="min-h-11 px-4 rounded-lg border border-dashed border-outline-variant/30 text-xs font-semibold text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer disabled:opacity-50"
              >
                {m.reaction_roles_preset_blank()}
              </button>
            </div>
          </section>
        {/if}

        <!-- Étape 2 : combien de rôles -->
        <section class="space-y-3">
          {@render stepTitle(step(2), m.reaction_roles_step_mode(), '')}
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label={m.reaction_roles_step_mode()}>
            {#each MODE_CHOICES as choice (choice)}
              <button
                type="button"
                role="radio"
                aria-checked={formButtonMode === choice}
                onclick={() => { formButtonMode = choice; }}
                disabled={!canManageSettings}
                class="text-left p-3 rounded-lg border transition-colors cursor-pointer disabled:cursor-not-allowed {formButtonMode === choice ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'border-outline-variant/20 bg-surface-container hover:border-primary/40'}"
              >
                <span class="flex items-center gap-1.5 text-sm font-semibold text-on-surface">
                  <Papicon icon={MODE_ICONS[choice]} size={14} />{modeLabel(choice)}
                </span>
                <span class="block mt-1 text-2xs text-on-surface-variant leading-relaxed">{modeDescription(choice)}</span>
              </button>
            {/each}
          </div>
        </section>

        <!-- Étape 3 : les boutons -->
        <section class="space-y-3">
          {@render stepTitle(step(3), m.reaction_roles_step_buttons(), '')}

          <div class="hidden md:grid grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_2.5rem] gap-2 pl-9 pr-1 text-2xs font-semibold text-on-surface-variant">
            <span>{m.reaction_roles_field_emoji()}</span>
            <span>{m.reaction_roles_field_label()}</span>
            <span>{m.reaction_roles_field_role()}</span>
            <span></span>
          </div>

          <div class="space-y-2">
            {#each formOptions as opt, idx}
              <!-- Discord passe à la ligne tous les cinq boutons : on le montre. -->
              {#if idx > 0 && idx % 5 === 0}
                <p class="flex items-center gap-2 text-2xs font-semibold text-on-surface-variant pt-1">
                  <span class="h-px flex-1 bg-outline-variant/30"></span>
                  {m.reaction_roles_row_label({ n: idx / 5 + 1 })}
                  <span class="h-px flex-1 bg-outline-variant/30"></span>
                </p>
              {/if}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="p-2 rounded-lg bg-surface-container-high/20 border transition-colors {dragIndex !== null && dropIndex === idx && dragIndex !== idx ? 'border-primary ring-1 ring-primary/40' : 'border-outline-variant/10'} {dragIndex === idx ? 'opacity-50' : ''}"
                ondragover={(event) => { if (dragIndex === null) return; event.preventDefault(); dropIndex = idx; }}
                ondrop={(event) => { event.preventDefault(); dropOption(); }}
              >
                <div class="flex gap-1 items-start">
                <!-- Pas un élément bouton : Firefox refuse de le faire glisser. -->
                <span
                  role="button"
                  tabindex={canReorder ? 0 : -1}
                  aria-disabled={!canReorder}
                  id={`reaction-role-grip-${idx}`}
                  draggable={canReorder ? 'true' : 'false'}
                  ondragstart={(event) => {
                    dragIndex = idx;
                    if (event.dataTransfer) {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', String(idx));
                    }
                  }}
                  ondragend={() => { dragIndex = null; dropIndex = null; }}
                  onkeydown={(event) => { if (canReorder) handleGripKeydown(event, idx); }}
                  aria-label={m.reaction_roles_reorder_handle({ n: idx + 1 })}
                  title={m.reaction_roles_reorder_handle({ n: idx + 1 })}
                  class="mt-1 w-7 h-8 shrink-0 flex items-center justify-center rounded-md text-on-surface-variant transition-colors {canReorder ? 'hover:text-on-surface hover:bg-surface-container-high/60 cursor-grab active:cursor-grabbing' : 'opacity-30'}"
                >
                  <Papicon icon="GripVertical" size={14} />
                </span>
                <div class="flex-1 min-w-0 grid grid-cols-[minmax(0,1fr)_2.5rem] md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_2.5rem] gap-2 items-start">
                  <div class="flex gap-1.5 items-center col-span-2 md:col-span-1">
                    <input
                      id={`modal-emoji-${idx}`}
                      type="text"
                      bind:value={opt.emoji}
                      placeholder="+"
                      aria-label={m.reaction_roles_field_emoji()}
                      class="w-full min-w-0 bg-surface-container rounded-lg px-3 py-2 text-xs text-on-surface border border-outline-variant/10 focus:ring-2 focus:ring-primary/30 focus:outline-none transition-all"
                      disabled={!canManageSettings}
                    />
                    <EmojiPicker bind:value={opt.emoji} disabled={!canManageSettings} />
                  </div>

                  <input
                    id={`modal-label-${idx}`}
                    type="text"
                    bind:value={opt.label}
                    placeholder={roleNameOf(opt) || m.reaction_roles_field_label_ph()}
                    maxlength={BUTTON_LABEL_MAX_LENGTH}
                    aria-label={m.reaction_roles_field_label()}
                    class="w-full bg-surface-container rounded-lg px-3 py-2 text-xs text-on-surface border border-outline-variant/10 focus:ring-2 focus:ring-primary/30 focus:outline-none transition-all"
                    disabled={!canManageSettings}
                  />

                  <div class="space-y-1 col-start-1 md:col-start-auto">
                    {#if !opt.roleId && opt.newRole}
                      <div class="rounded-lg bg-surface-container border border-dashed border-primary/40 px-3 py-2 space-y-1">
                        <p class="flex items-center gap-2 text-xs font-semibold text-on-surface">
                          <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {roleColor(opt.newRole.color)}"></span>
                          {m.reaction_roles_new_role_chip({ name: opt.newRole.name })}
                        </p>
                        <p class="text-2xs text-on-surface-variant">{m.reaction_roles_new_role_hint()}</p>
                        {#if botRoleAccess && !botRoleAccess.canManageRoles}
                          <p class="flex items-start gap-1 text-2xs text-error">
                            <Papicon icon="AlertTriangle" size={12} class="mt-px shrink-0" />{m.reaction_roles_blocked_no_permission()}
                          </p>
                        {/if}
                        {#if canManageSettings}
                          <button
                            type="button"
                            onclick={() => { opt.newRole = null; }}
                            class="text-2xs font-semibold text-primary hover:underline cursor-pointer"
                          >
                            {m.reaction_roles_new_role_replace()}
                          </button>
                        {/if}
                      </div>
                    {:else}
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
                    {/if}
                  </div>

                  <div class="row-start-2 col-start-2 md:row-start-auto md:col-start-auto flex justify-center">
                    {#if formOptions.length > 1 && canManageSettings}
                      <button
                        type="button"
                        onclick={() => removeOption(idx)}
                        class="p-2 text-on-surface-variant hover:text-error hover:bg-error/10 rounded-lg transition-all cursor-pointer"
                        title={m.reaction_roles_remove_button_title()}
                        aria-label={m.reaction_roles_remove_button_title()}
                      >
                        <Papicon icon="Cross" size={14} />
                      </button>
                    {/if}
                  </div>
                </div>
                </div>
              </div>
            {/each}
          </div>

          <div class="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onclick={addOption}
              disabled={formOptions.length >= 20}
              use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
              class="text-xs font-semibold text-primary hover:text-primary/80 transition-colors flex items-center gap-1 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              <Papicon icon="Plus" size={14} /> {m.reaction_roles_add_button()}
            </button>
          </div>
        </section>

        <!-- Étape 4 : où publier -->
        <section class="space-y-3">
          {@render stepTitle(step(4), m.reaction_roles_step_publish(), '')}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="space-y-1">
              <label for="modal-title" class="text-2xs font-semibold text-on-surface-variant">{m.reaction_roles_field_title()}</label>
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
            <div class="space-y-1">
              <label for="modal-channel" class="text-2xs font-semibold text-on-surface-variant">{m.reaction_roles_field_channel()}</label>
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

          <div class="space-y-1">
            <div class="flex items-baseline justify-between gap-2">
              <label for="modal-description" class="text-2xs font-semibold text-on-surface-variant">{m.reaction_roles_field_description()}</label>
              <span class="text-2xs text-on-surface-variant tabular-nums">{formDescription.length} / {MENU_DESCRIPTION_MAX}</span>
            </div>
            <textarea
              id="modal-description"
              bind:value={formDescription}
              rows="2"
              maxlength={MENU_DESCRIPTION_MAX}
              placeholder={previewSubtitle}
              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none resize-y"
              disabled={!canManageSettings}
            ></textarea>
            <p class="text-2xs text-on-surface-variant">{m.reaction_roles_field_description_hint()}</p>
          </div>

          {#if editedMenu && formChannelId && formChannelId !== editedMenu.channelId}
            <p class="flex items-center gap-2 text-2xs text-on-surface-variant/80 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2">
              <Papicon icon="Info" size={14} />
              {m.reaction_roles_moved_channel_notice()}
            </p>
          {/if}
        </section>

        <!-- Aperçu Discord, replié par défaut -->
        <section class="rounded-xl border border-outline-variant/15 overflow-hidden">
          <button
            type="button"
            onclick={() => { showPreview = !showPreview; }}
            aria-expanded={showPreview}
            aria-controls="reaction-roles-preview"
            class="w-full flex items-center justify-between gap-3 px-4 py-3 bg-surface-container-high/30 hover:bg-surface-container-high/50 transition-colors cursor-pointer text-left"
          >
            <span class="flex items-center gap-3 min-w-0">
              <span class="w-8 h-8 rounded-lg bg-[#5865f2]/15 text-[#5865f2] flex items-center justify-center shrink-0">
                <Papicon icon="Eye" size={16} />
              </span>
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-on-surface">{m.reaction_roles_preview_title()}</span>
                <span class="block text-2xs text-on-surface-variant">{m.reaction_roles_preview_desc()}</span>
              </span>
            </span>
            <Papicon icon={showPreview ? 'ChevronUp' : 'ChevronDown'} size={16} class="text-on-surface-variant shrink-0" />
          </button>

          {#if showPreview}
            <div id="reaction-roles-preview" transition:slide={{ duration: 160 }}>
              <ReactionRoleDiscordPreview
                title={formTitle || m.reaction_roles_field_title_ph()}
                description={formDescription.trim() || previewSubtitle}
                buttons={previewButtons}
                color={formEmbedColor || DEFAULT_EMBED_COLOR}
              />
            </div>
          {/if}
        </section>

        <div class="flex items-center justify-between gap-3 flex-wrap pt-4 border-t border-outline-variant/10">
          <p class="flex items-center gap-1.5 text-2xs text-on-surface-variant min-h-5">
            {#if pendingNewRoles > 0}
              <Papicon icon="Info" size={14} />
              {m.reaction_roles_new_roles_on_publish({ n: pendingNewRoles })}
            {/if}
          </p>
          <div class="flex gap-2 ml-auto">
            <button
              type="button"
              onclick={() => showModal = false}
              class="px-4 py-3 rounded-lg text-on-surface-variant text-body-sm font-medium hover:bg-surface-container-high/40 transition-all cursor-pointer"
            >
              {m.reaction_roles_cancel()}
            </button>
            {#if canManageSettings}
              <button
                type="submit"
                class="px-6 py-3 bg-primary text-on-primary font-medium text-body-sm rounded-lg transition-all cursor-pointer"
              >
                {editingMenuId ? m.reaction_roles_save_confirm() : m.reaction_roles_deploy_confirm()}
              </button>
            {/if}
          </div>
        </div>
      </form>
    </div>

    <!-- Onglet collé au bord droit : ouvre le volet des options secondaires -->
    <button
      type="button"
      onclick={() => { showAdvanced = !showAdvanced; }}
      aria-expanded={showAdvanced}
      aria-controls="reaction-roles-options"
      aria-label={m.reaction_roles_options_title()}
      title={m.reaction_roles_options_title()}
      class="absolute top-28 -right-4 z-20 w-8 h-14 flex items-center justify-center rounded-full bg-surface-container-low border border-outline-variant/30 shadow-sm text-on-surface-variant hover:text-primary hover:border-primary/40 transition-colors cursor-pointer"
    >
      <Papicon icon={showAdvanced ? 'ChevronLeft' : 'ChevronRight'} size={16} />
      {#if hasCustomOptions && !showAdvanced}
        <span class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-primary ring-2 ring-surface-container-low"></span>
      {/if}
    </button>

    {#if showAdvanced}
      <!--
        Par-dessus le bord droit de la fenêtre ; à côté d'elle seulement quand
        l'écran a la place de loger les deux sans déborder (1460 px).
      -->
      <aside
        id="reaction-roles-options"
        class="absolute z-30 inset-y-0 right-0 w-[min(20rem,calc(100%-1rem))] overflow-y-auto rounded-xl bg-surface-container-low border border-outline-variant/20 p-5 space-y-4 shadow-sm min-[1460px]:inset-y-auto min-[1460px]:top-0 min-[1460px]:right-auto min-[1460px]:left-full min-[1460px]:ml-5 min-[1460px]:w-80 min-[1460px]:max-h-[90vh]"
        transition:fly={{ x: -12, duration: 160 }}
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-semibold text-on-surface">{m.reaction_roles_options_title()}</p>
            <p class="text-2xs text-on-surface-variant mt-0.5">{m.reaction_roles_options_desc()}</p>
          </div>
          <button
            type="button"
            onclick={() => { showAdvanced = false; }}
            class="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-high/50 transition-colors cursor-pointer"
            aria-label={m.reaction_roles_close()}
          >
            <Papicon icon="Cross" size={14} />
          </button>
        </div>

        <div class="rounded-lg border border-outline-variant/15 bg-surface-container/60 p-3 space-y-1.5">
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs font-semibold text-on-surface">{m.reaction_roles_show_counts_title()}</p>
            <ToggleSwitch
              size="sm"
              ariaLabel={m.reaction_roles_show_counts_title()}
              checked={formShowCounts}
              onToggle={(value: boolean) => { formShowCounts = value; }}
              disabled={!canManageSettings}
            />
          </div>
          <p class="text-2xs text-on-surface-variant leading-relaxed">{m.reaction_roles_show_counts_desc()}</p>
        </div>

        <div class="rounded-lg border border-outline-variant/15 bg-surface-container/60 p-3 space-y-2">
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs font-semibold text-on-surface">{m.reaction_roles_embed_color_title()}</p>
            {#if formEmbedColor && canManageSettings}
              <button
                type="button"
                onclick={() => { formEmbedColor = ''; }}
                class="text-2xs font-semibold text-primary hover:underline cursor-pointer"
              >
                {m.reaction_roles_embed_color_reset()}
              </button>
            {/if}
          </div>
          {#if canManageSettings}
            <FormColorPicker bind:value={formEmbedColor} />
          {/if}
          <p class="text-2xs text-on-surface-variant leading-relaxed">{m.reaction_roles_embed_color_desc()}</p>
        </div>

        {#if formButtonMode === 'exclusive'}
          <p class="text-2xs text-on-surface-variant bg-surface-container-high/40 rounded-lg px-3 py-2">{m.reaction_roles_options_exclusive_note()}</p>
        {/if}

        {#each formOptions as opt, idx}
          <div class="rounded-lg border border-outline-variant/15 bg-surface-container/60 p-3 space-y-3">
            <p class="flex items-center gap-2 text-xs font-semibold text-on-surface min-w-0">
              <span class="text-2xs text-on-surface-variant shrink-0">{idx + 1}</span>
              {#if opt.emoji}<span class="shrink-0">{@html parseDiscordEmojisAndMarkdown(opt.emoji)}</span>{/if}
              <span class="truncate">{buttonLabel(opt) || m.reaction_roles_preview_button_default()}</span>
            </p>

            <div class="space-y-1.5">
              <p class="text-2xs font-semibold text-on-surface-variant">{m.reaction_roles_button_style()}</p>
              <div class="flex gap-2" role="radiogroup" aria-label={m.reaction_roles_button_style()}>
                {#each BUTTON_STYLES as style (style)}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={opt.style === style}
                    aria-label={styleLabel(style)}
                    title={styleLabel(style)}
                    onclick={() => { opt.style = style; }}
                    disabled={!canManageSettings}
                    class="w-7 h-7 rounded-md transition-shadow cursor-pointer disabled:cursor-not-allowed ring-offset-2 ring-offset-surface-container-low {PREVIEW_STYLE_CLASSES[style]} {opt.style === style ? 'ring-2 ring-primary' : ''}"
                  ></button>
                {/each}
              </div>
            </div>

            {#if formButtonMode !== 'exclusive'}
              <div class="space-y-1.5">
                <p class="text-2xs font-semibold text-on-surface-variant">{m.reaction_roles_button_mode()}</p>
                <div class="grid grid-cols-3 gap-0.5 rounded-lg bg-surface-container-high/50 p-0.5" role="radiogroup" aria-label={m.reaction_roles_button_mode()}>
                  {#each BUTTON_MODE_SEGMENTS as segment (segment.value)}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={opt.mode === segment.value}
                      onclick={() => { opt.mode = segment.value; }}
                      disabled={!canManageSettings}
                      class="px-1.5 py-1.5 rounded-md text-2xs font-semibold leading-tight transition-colors cursor-pointer disabled:cursor-not-allowed {opt.mode === segment.value ? 'bg-surface-container-lowest text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}"
                    >
                      {segment.label()}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </aside>
    {/if}
    </div>
  </div>
{/if}
