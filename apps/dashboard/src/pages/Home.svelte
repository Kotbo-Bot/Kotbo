<script lang="ts">
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { notificationsStore } from '../lib/stores/notifications.svelte';
  import { staffStore } from '../lib/stores/staff.svelte';
  import { fetchAnalytics, fetchUserSettings, updateUserSettings, fetchChangelog, fetchStaffServerLinks, fetchHomeWidgets } from '../lib/api';
  import type { ChangelogCommit, HomeWidgetsData, HomeWidgetSection } from '../lib/api';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import HomeTodo from '../lib/components/home/HomeTodo.svelte';
  import ServerLocaleSettings from '../lib/components/ServerLocaleSettings.svelte';
  import { Button, Callout, Menu, type MenuItem } from '../lib/components/ui';
  import { toast } from '../lib/stores/toast.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import { isMobile } from '../lib/stores/media.svelte';
  import { navigationStore } from '../lib/stores/navigation.svelte';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { HOME_WIDGET_ACCESS } from '@kotbo/contracts';

  interface LayoutItem {
    id: string;
    colSpan: number;
    rowSpan: number;
    visible: boolean;
  }

  /**
   * Ce que voit un nouveau venu, sous « A traiter » : l'etat du serveur, rien
   * de plus. L'ancienne grille par defaut empilait douze blocs, dont deux
   * reglages du serveur (langue, fuseau), un doublon de la cloche et un etat
   * systeme toujours « Optimal ». Ils restent dans la bibliotheque, et les
   * dispositions deja enregistrees ne bougent pas.
   */
  const DEFAULT_LAYOUT: LayoutItem[] = [
    { id: 'liveStats', colSpan: 3, rowSpan: 1, visible: true },
    { id: 'analytics', colSpan: 2, rowSpan: 1, visible: true },
    { id: 'moderation', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'staff', colSpan: 1, rowSpan: 1, visible: true },
    { id: 'audit', colSpan: 2, rowSpan: 1, visible: true },
  ];

  const MODULE_CATALOG = [
    { id: 'liveStats', title: m.home_mod_livestats_title(), desc: m.home_mod_livestats_desc(), icon: 'users' },
    { id: 'analytics', title: m.home_mod_analytics_title(), desc: m.home_mod_analytics_desc(), icon: 'trending-up' },
    { id: 'system', title: m.home_mod_system_title(), desc: m.home_mod_system_desc(), icon: 'cpu' },
    { id: 'channels', title: m.home_mod_channels_title(), desc: m.home_mod_channels_desc(), icon: 'hash' },
    { id: 'moderation', title: m.home_mod_moderation_title(), desc: m.home_mod_moderation_desc(), icon: 'shield' },
    { id: 'members', title: m.home_mod_members_title(), desc: m.home_mod_members_desc(), icon: 'award' },
    { id: 'notifications', title: m.home_mod_notifications_title(), desc: m.home_mod_notifications_desc(), icon: 'inbox' },
    { id: 'staff', title: m.home_mod_staff_title(), desc: m.home_mod_staff_desc(), icon: 'users' },
    { id: 'audit', title: m.home_mod_audit_title(), desc: m.home_mod_audit_desc(), icon: 'activity' },
    { id: 'botLanguage', title: m.home_mod_botlanguage_title(), desc: m.home_mod_botlanguage_desc(), icon: 'globe' },
    { id: 'timezone', title: m.home_mod_timezone_title(), desc: m.home_mod_timezone_desc(), icon: 'clock' },
    { id: 'actions', title: m.home_mod_actions_title(), desc: m.home_mod_actions_desc(), icon: 'plus-circle' },
    { id: 'notes', title: m.home_mod_notes_title(), desc: m.home_mod_notes_desc(), icon: 'edit' },
    { id: 'serverInfo', title: m.home_mod_serverinfo_title(), desc: m.home_mod_serverinfo_desc(), icon: 'server' },
    { id: 'botHosting', title: m.home_mod_bothosting_title(), desc: m.home_mod_bothosting_desc(), icon: 'cpu' },
    { id: 'news', title: m.home_mod_news_title(), desc: m.home_mod_news_desc(), icon: 'book' },
    { id: 'quickGuide', title: m.home_mod_quickguide_title(), desc: m.home_mod_quickguide_desc(), icon: 'info' },
    { id: 'clockWeather', title: m.home_mod_clockweather_title(), desc: m.home_mod_clockweather_desc(), icon: 'clock' },
    { id: 'economy', title: m.home_mod_economy_title(), desc: m.home_mod_economy_desc(), icon: 'dollar-sign' },
    { id: 'leveling', title: m.home_mod_leveling_title(), desc: m.home_mod_leveling_desc(), icon: 'bar-chart-2' },
    { id: 'tickets', title: m.home_mod_tickets_title(), desc: m.home_mod_tickets_desc(), icon: 'message-square' },
    { id: 'invites', title: m.home_mod_invites_title(), desc: m.home_mod_invites_desc(), icon: 'user-plus' },
    { id: 'events', title: m.home_mod_events_title(), desc: m.home_mod_events_desc(), icon: 'calendar' },
    { id: 'polls', title: m.home_mod_polls_title(), desc: m.home_mod_polls_desc(), icon: 'bar-chart' },
    { id: 'staffServer', title: m.home_mod_staffserver_title(), desc: m.home_mod_staffserver_desc(), icon: 'shield' },
  ];

  /**
   * Blocs que ce compte a le droit de monter.
   *
   * La bibliotheque de modules offrait les vingt-cinq blocs a tout le monde :
   * un role prive de « Tickets » ou de « Membres » dans le centre de gestion
   * remettait la meme donnee sur son accueil en un clic, et « Langue du bot »
   * exposait un reglage de serveur a qui ne peut pas configurer. La regle est
   * partagee avec l'API, qui refuse les memes sections.
   */
  function canUseWidget(widgetId: string): boolean {
    const rule = HOME_WIDGET_ACCESS[widgetId];
    if (!rule) return true;
    if (rule.adminOnly) return navigationStore.isAdmin;
    return !rule.feature || canViewFeature(rule.feature);
  }

  let isEditing = $state(false);
  /** Disposition d'avant l'edition, pour que « Annuler » la rende telle quelle. */
  let layoutBeforeEdit: LayoutItem[] | null = null;

  function startEditing() {
    layoutBeforeEdit = userLayout.map((item) => ({ ...item }));
    isEditing = true;
  }

  function cancelEditing() {
    if (layoutBeforeEdit) userLayout = layoutBeforeEdit;
    layoutBeforeEdit = null;
    isEditing = false;
  }

  const editMenu = $derived<MenuItem[]>([
    {
      label: m.home_edit_presets(),
      description: m.home_edit_presets_desc(),
      icon: 'layers',
      onselect: () => { showPresetsModal = true; void loadPresets(); },
    },
    {
      label: m.home_edit_export(),
      description: m.home_edit_export_desc(),
      icon: 'download',
      onselect: exportCurrentLayout,
    },
    {
      label: m.home_edit_reset(),
      description: m.home_edit_reset_desc(),
      icon: 'rotate-ccw',
      onselect: () => (showResetConfirm = true),
    },
  ]);
  let showAddModuleModal = $state(false);
  let showResetConfirm = $state(false);
  let showPresetsModal = $state(false);
  let userLayout = $state<LayoutItem[]>([]);
  const availableCatalog = $derived(MODULE_CATALOG.filter((mod) => canUseWidget(mod.id)));

  /**
   * Une disposition enregistree avant un retrait de droit garde le bloc : le
   * filtre s'applique donc au rendu, pas seulement a la bibliotheque.
   */
  const visibleLayout = $derived(userLayout.filter((item) => item.visible && canUseWidget(item.id)));

  let dragOverIndex = $state<number | null>(null);
  let resizing = $state<{ id: string; axis: 'col' | 'row'; startX: number; startY: number; startSpan: number } | null>(null);
  let presets = $state<any[]>([]);
  let presetName = $state('');
  let presetDescription = $state('');
  let loadingPresets = $state(false);
  let presetImportJson = $state('');
  let changelogCommits = $state<ChangelogCommit[]>([]);
  let changelogLoading = $state(false);

  function getStorageKey(): string {
    const guildId = authStore.selectedGuildId || 'default';
    const userId = authStore.user?.id || 'default';
    return `bento_layout_${guildId}_${userId}`;
  }

  function ensureRowSpan(items: LayoutItem[]): LayoutItem[] {
    return items.map(item => ({ ...item, rowSpan: item.rowSpan || 1 }));
  }

  function completeLayout(items: LayoutItem[]): LayoutItem[] {
    const parsed = ensureRowSpan(items);
    const existingIds = new Set(parsed.map(item => item.id));
    const missingModules: LayoutItem[] = MODULE_CATALOG
      .filter(m => !existingIds.has(m.id))
      .map(m => ({ id: m.id, colSpan: 1, rowSpan: 1, visible: false }));
    return [...parsed, ...missingModules];
  }

  function defaultLayout(): LayoutItem[] {
    return completeLayout(DEFAULT_LAYOUT);
  }

  function loadLocalLayout(): LayoutItem[] {
    const key = getStorageKey();
    const saved = localStorage.getItem(key);

    if (saved) {
      try {
        return completeLayout(JSON.parse(saved) as LayoutItem[]);
      } catch (e) {
        console.error("Failed to parse saved layout, using default", e);
      }
    }

    return defaultLayout();
  }

  async function loadLayout() {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;

    // Le cache local permet de peindre la grille immédiatement. La version DB
    // est ensuite appliquée silencieusement dès qu'elle arrive.
    userLayout = loadLocalLayout();

    try {
      const data = await fetchUserSettings();
      if (authStore.selectedGuildId === guildId && data?.bentoLayout) {
        userLayout = completeLayout(data.bentoLayout as LayoutItem[]);
        localStorage.setItem(getStorageKey(), JSON.stringify(userLayout));
      }
    } catch (e) {
      console.warn("Failed to refresh layout from DB, keeping local layout", e);
    }
  }

  async function saveLayout() {
    // Save to DB
    try {
      await updateUserSettings({ bentoLayout: userLayout });
    } catch (e) {
      console.error("Failed to save layout to DB", e);
    }

    // Save to localStorage as redundancy
    const key = getStorageKey();
    localStorage.setItem(key, JSON.stringify(userLayout));

    layoutBeforeEdit = null;
    isEditing = false;
    toast.success(m.home_layout_saved());
  }

  async function resetLayout() {
    const defaultIds = new Set(DEFAULT_LAYOUT.map(item => item.id));
    const hiddenItems: LayoutItem[] = MODULE_CATALOG
      .filter(m => !defaultIds.has(m.id))
      .map(m => ({
        id: m.id,
        colSpan: 1,
        rowSpan: 1,
        visible: false
      }));
    userLayout = [...DEFAULT_LAYOUT, ...hiddenItems];
    
    // Reset in DB
    try {
      await updateUserSettings({ bentoLayout: null });
    } catch (e) {
      console.error("Failed to reset layout in DB", e);
    }

    showResetConfirm = false;
    layoutBeforeEdit = null;
    isEditing = false;
    
    // Reset in localStorage
    const key = getStorageKey();
    localStorage.removeItem(key);
    
    toast.success(m.home_layout_reset());
  }

  function toggleSize(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        let nextSpan = 1;
        if (item.colSpan === 1) nextSpan = 2;
        else if (item.colSpan === 2) nextSpan = 3;
        return { ...item, colSpan: nextSpan };
      }
      return item;
    });
  }

  function hideModule(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        return { ...item, visible: false };
      }
      return item;
    });
  }

  function addModule(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        return { ...item, visible: true, rowSpan: item.rowSpan || 1 };
      }
      return item;
    });
    toast.success(m.home_module_added());
  }

  /**
   * Deplacer un bloc, par identifiant et non par rang.
   *
   * Le rang venait de la grille affichee - les blocs visibles - alors que
   * l'echange se faisait dans la disposition complete, blocs masques compris.
   * Les deux listes ne coincident que pour qui n'a rien masque : partout
   * ailleurs, la fleche deplacait un autre bloc que celui montre.
   */
  function moveModule(id: string, direction: number) {
    const visibleIds = visibleLayout.map((item) => item.id);
    const position = visibleIds.indexOf(id);
    const neighbourId = visibleIds[position + direction];
    if (position < 0 || neighbourId === undefined) return;

    const items = [...userLayout];
    const from = items.findIndex((item) => item.id === id);
    const to = items.findIndex((item) => item.id === neighbourId);
    if (from < 0 || to < 0) return;

    [items[from], items[to]] = [items[to], items[from]];
    userLayout = items;
  }

  function toggleRowSize(id: string) {
    userLayout = userLayout.map(item => {
      if (item.id === id) {
        let nextRowSpan = 1;
        if (item.rowSpan === 1) nextRowSpan = 2;
        else if (item.rowSpan === 2) nextRowSpan = 3;
        return { ...item, rowSpan: nextRowSpan };
      }
      return item;
    });
  }

  // HTML5 Drag & Drop handlers
  let draggedIndex = $state<number | null>(null);

  function handleDragStart(e: DragEvent, index: number) {
    draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
    const target = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => target.classList.add('opacity-40', 'scale-95'));
  }

  function handleDragEnd(e: DragEvent) {
    const target = e.currentTarget as HTMLElement;
    target.classList.remove('opacity-40', 'scale-95');
    draggedIndex = null;
    dragOverIndex = null;
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) {
      dragOverIndex = index;
    }
  }

  function handleDragLeave(e: DragEvent) {
    dragOverIndex = null;
  }

  /**
   * Meme piege que `moveModule` : les rangs decrivent la grille affichee, le
   * deplacement s'applique a la disposition complete. On repasse par les
   * identifiants pour retomber sur le bon bloc.
   */
  function handleDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;

    const draggedId = visibleLayout[draggedIndex]?.id;
    const targetId = visibleLayout[targetIndex]?.id;
    draggedIndex = null;
    dragOverIndex = null;
    if (!draggedId || !targetId) return;

    const items = [...userLayout];
    const from = items.findIndex((item) => item.id === draggedId);
    const to = items.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;

    const [removed] = items.splice(from, 1);
    items.splice(to, 0, removed);
    userLayout = items;
  }

  // Border resize handlers
  function handleResizeStart(e: MouseEvent, itemId: string, axis: 'col' | 'row') {
    e.preventDefault();
    e.stopPropagation();
    const item = userLayout.find(i => i.id === itemId);
    if (!item) return;
    resizing = {
      id: itemId,
      axis,
      startX: e.clientX,
      startY: e.clientY,
      startSpan: axis === 'col' ? item.colSpan : (item.rowSpan || 1)
    };
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
  }

  function handleResizeMove(e: MouseEvent) {
    if (!resizing) return;
    const { id, axis, startX, startY, startSpan } = resizing;
    const delta = axis === 'col' ? e.clientX - startX : e.clientY - startY;
    const cellSize = axis === 'col' ? 280 : 200;
    const spanDelta = Math.round(delta / cellSize);
    const newSpan = Math.max(1, Math.min(3, startSpan + spanDelta));
    userLayout = userLayout.map((item) => {
      if (item.id === id) {
        return axis === 'col' ? { ...item, colSpan: newSpan } : { ...item, rowSpan: newSpan };
      }
      return item;
    });
  }

  function handleResizeEnd() {
    resizing = null;
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
  }

  // Preset management
  async function loadPresets() {
    loadingPresets = true;
    try {
      const { fetchLayoutPresets } = await import('../lib/api');
      presets = await fetchLayoutPresets();
    } catch (e) {
      console.error("Failed to load presets", e);
    } finally {
      loadingPresets = false;
    }
  }

  async function saveAsPreset() {
    if (!presetName.trim()) { toast.error(m.home_name_required()); return; }
    try {
      const { createLayoutPreset } = await import('../lib/api');
      const visible = userLayout.filter(i => i.visible);
      const preset = await createLayoutPreset({ name: presetName.trim(), description: presetDescription.trim(), layout: visible });
      if (preset) {
        presets = [preset, ...presets];
        presetName = '';
        presetDescription = '';
        toast.success(m.home_preset_saved());
      }
    } catch (e) {
      toast.error(m.home_preset_save_error());
    }
  }

  async function applyPreset(presetId: string) {
    try {
      const { applyLayoutPreset } = await import('../lib/api');
      const layout = await applyLayoutPreset(presetId);
      if (layout) {
        const parsed = ensureRowSpan(layout as LayoutItem[]);
        const existingIds = new Set(parsed.map(item => item.id));
        const missingModules: LayoutItem[] = MODULE_CATALOG
          .filter(m => !existingIds.has(m.id))
          .map(m => ({ id: m.id, colSpan: 1, rowSpan: 1, visible: false }));
        userLayout = [...parsed, ...missingModules];
        showPresetsModal = false;
        toast.success(m.home_preset_applied());
      }
    } catch (e) {
      toast.error(m.home_preset_apply_error());
    }
  }

  async function removePreset(presetId: string) {
    try {
      const { deleteLayoutPreset } = await import('../lib/api');
      const ok = await deleteLayoutPreset(presetId);
      if (ok) presets = presets.filter(p => p.id !== presetId);
    } catch (e) {
      toast.error(m.home_delete_error());
    }
  }

  async function sharePreset(presetId: string) {
    try {
      const { shareLayoutPreset } = await import('../lib/api');
      const result = await shareLayoutPreset(presetId);
      if (result?.shareToken) {
        const url = `${window.location.origin}/?importPreset=${result.shareToken}`;
        await navigator.clipboard.writeText(url);
        toast.success(m.home_link_copied());
      }
    } catch (e) {
      toast.error(m.home_share_error());
    }
  }

  function exportPreset(preset: any) {
    const data = JSON.stringify({ name: preset.name, description: preset.description || '', layout: preset.layout }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `preset-${preset.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(m.home_preset_exported());
  }

  async function importPresetFromJson() {
    if (!presetImportJson.trim()) return;
    try {
      const parsed = JSON.parse(presetImportJson);
      if (!parsed.name || !parsed.layout) { toast.error(m.home_invalid_format()); return; }
      const { importLayoutPreset } = await import('../lib/api');
      const preset = await importLayoutPreset({ name: parsed.name, description: parsed.description || m.home_imported_label(), layout: parsed.layout });
      if (preset) {
        presets = [preset, ...presets];
        presetImportJson = '';
        toast.success(m.home_preset_imported());
      }
    } catch (e) {
      toast.error(m.home_json_import_error());
    }
  }

  function exportCurrentLayout() {
    const visible = userLayout.filter(i => i.visible);
    const data = JSON.stringify({ name: m.home_my_layout(), description: m.home_current_export(), layout: visible }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'layout-courant.json';
    a.click();
    URL.revokeObjectURL(url);
    toast.success(m.home_layout_exported());
  }

  // Staff notes logic
  let staffNotes = $state('');

  function loadStaffNotes() {
    const guildId = authStore.selectedGuildId || 'default';
    const savedNotes = localStorage.getItem(`staff_notes_${guildId}`);
    staffNotes = savedNotes || '';
  }

  function saveStaffNotes(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    staffNotes = target.value;
    const guildId = authStore.selectedGuildId || 'default';
    localStorage.setItem(`staff_notes_${guildId}`, staffNotes);
  }

  function formatRelativeDate(isoDate: string): string {
    const diff = Date.now() - new Date(isoDate).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return m.home_rel_now();
    if (minutes < 60) return m.home_rel_min({ n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return m.home_rel_hours({ n: hours });
    const days = Math.floor(hours / 24);
    if (days === 1) return m.home_rel_yesterday();
    if (days < 30) return m.home_rel_days({ n: days });
    return new Date(isoDate).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
  }

  // Clock & Weather logic
  let currentTime = $state('');
  let currentDate = $state('');

  function updateDateTime() {
    const now = new Date();
    currentTime = now.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    currentDate = now.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Widget "Serveur Staff" - état du lien de la paire
  const SYNC_MODE_LABELS: Record<string, string> = {
    MAIN_TO_STAFF: m.home_sync_main_to_staff(),
    STAFF_TO_MAIN: m.home_sync_staff_to_main(),
    BIDIRECTIONAL: m.home_sync_bidirectional(),
  };
  let staffServerLinks = $state<any[]>([]);
  let staffLinksGuildId: string | null = null;

  async function loadStaffServerLinks() {
    const guildId = authStore.selectedGuildId;
    if (!guildId || staffLinksGuildId === guildId) return;
    staffLinksGuildId = guildId;
    try {
      const data = await fetchStaffServerLinks();
      if (authStore.selectedGuildId === guildId) {
        staffServerLinks = Array.isArray(data) ? data : [];
      }
    } catch {
      staffLinksGuildId = null;
      staffServerLinks = [];
    }
  }

  $effect(() => {
    if (authStore.selectedGuildId) {
      loadLayout();
      loadStaffNotes();
      handleImportFromUrl();
    }
  });

  let changelogLoaded = false;

  async function loadChangelog() {
    if (changelogLoaded || changelogLoading) return;
    changelogLoading = true;
    try {
      changelogCommits = await fetchChangelog(10);
      changelogLoaded = true;
    } catch {
      changelogCommits = [];
    } finally {
      changelogLoading = false;
    }
  }

  async function handleImportFromUrl() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('importPreset');
    if (!token) return;
    try {
      const { fetchSharedLayoutPreset, importLayoutPreset } = await import('../lib/api');
      const shared = await fetchSharedLayoutPreset(token);
      if (shared?.layout) {
        const preset = await importLayoutPreset({ name: shared.name, description: shared.description || m.home_imported_via_link(), layout: shared.layout as any[] });
        if (preset) {
          const parsed = ensureRowSpan(shared.layout as LayoutItem[]);
          const existingIds = new Set(parsed.map(item => item.id));
          const missingModules: LayoutItem[] = MODULE_CATALOG
            .filter(m => !existingIds.has(m.id))
            .map(m => ({ id: m.id, colSpan: 1, rowSpan: 1, visible: false }));
          userLayout = [...parsed, ...missingModules];
          toast.success(m.home_preset_imported_applied({ name: shared.name }));
        }
      }
    } catch (e) {
      console.warn("Failed to import preset from URL", e);
    }
    window.history.replaceState({}, '', window.location.pathname);
  }

  let timerInterval: any;
  $effect(() => {
    updateDateTime();
    timerInterval = setInterval(updateDateTime, 1000);
    return () => {
      clearInterval(timerInterval);
    };
  });

  function getSpanStyle(colSpan: number, rowSpan: number): string {
    const parts: string[] = [];
    if (colSpan === 2) parts.push('grid-column: span 2');
    else if (colSpan === 3) parts.push('grid-column: span 3');
    if (rowSpan >= 2) parts.push(`grid-row: span ${rowSpan}`);
    return parts.join('; ');
  }

  function displayColSpan(item: LayoutItem): number {
    return $isMobile ? 1 : item.colSpan;
  }

  function displayRowSpan(item: LayoutItem): number {
    return $isMobile ? 1 : (item.rowSpan || 1);
  }

  function getColSpanClass(colSpan: number): string {
    if (colSpan === 2) return "md:col-span-2";
    if (colSpan === 3) return "md:col-span-2 lg:col-span-3";
    return "col-span-1";
  }

  function getRowSpanClass(rowSpan: number): string {
    if (rowSpan === 2) return "row-span-2";
    if (rowSpan === 3) return "row-span-3";
    return "";
  }

  const COMPACT_MODULES = new Set(['actions', 'liveStats', 'clockWeather']);

  function getModuleMinHeight(id: string): string {
    if (COMPACT_MODULES.has(id)) return 'min-h-[80px]';
    return 'min-h-[180px]';
  }

  function getListCount(baseCount: number, colSpan: number, rowSpan: number): number {
    let count = baseCount;
    if (rowSpan >= 3) count += 6;
    else if (rowSpan >= 2) count += 3;
    if (colSpan >= 2) count += 2;
    return count;
  }

  let analyticsData = $state<any>(null);
  let analyticsLoading = $state(false);
  let analyticsGuildId: string | null = null;

  async function loadAnalytics(force = false) {
    const guildId = authStore.selectedGuildId;
    if (!guildId || analyticsLoading || (!force && analyticsGuildId === guildId)) return;
    analyticsLoading = true;
    try {
      analyticsData = await fetchAnalytics({ period: 7 });
      if (authStore.selectedGuildId === guildId) analyticsGuildId = guildId;
    } catch {
      analyticsData = null;
    } finally {
      analyticsLoading = false;
    }
  }

  const WIDGET_SECTIONS: Record<string, HomeWidgetSection> = {
    leveling: 'leveling',
    invites: 'invites',
    economy: 'economy',
    tickets: 'tickets',
    events: 'events',
    polls: 'polls',
    serverInfo: 'serverInfo',
    quickGuide: 'quickGuide',
    botHosting: 'hosting',
  };

  let homeWidgets = $state<HomeWidgetsData | null>(null);
  let homeWidgetsLoading = $state(false);
  let homeWidgetsKey: string | null = null;
  let homeWidgetsGuildId: string | null = null;

  function sectionsFor(visibleIds: Set<string>): HomeWidgetSection[] {
    return Object.entries(WIDGET_SECTIONS)
      .filter(([id]) => visibleIds.has(id))
      .map(([, section]) => section);
  }

  async function loadHomeWidgets(sections: HomeWidgetSection[], force = false) {
    const guildId = authStore.selectedGuildId;
    if (!guildId || sections.length === 0) return;

    if (homeWidgetsGuildId !== guildId) {
      homeWidgets = null;
      homeWidgetsGuildId = guildId;
    }

    const key = `${guildId}:${[...sections].sort().join(',')}`;
    if (homeWidgetsLoading || (!force && homeWidgetsKey === key)) return;

    homeWidgetsLoading = true;
    try {
      const data = await fetchHomeWidgets(sections);
      if (authStore.selectedGuildId !== guildId) return;
      homeWidgets = data;
      homeWidgetsKey = key;
    } catch {
      homeWidgets = null;
      homeWidgetsKey = null;
    } finally {
      homeWidgetsLoading = false;
    }
  }

  function formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    if (days >= 1) return m.home_uptime_days({ n: days });
    const hours = Math.floor(seconds / 3600);
    if (hours >= 1) return m.home_uptime_hours({ n: hours });
    return m.home_uptime_minutes({ n: Math.max(1, Math.floor(seconds / 60)) });
  }

  function formatMemory(megabytes: number): string {
    if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
    return `${megabytes} MB`;
  }

  function formatEventDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    const visibleIds = new Set(visibleLayout.map((item) => item.id));
    if (!guildId || visibleIds.size === 0) return;

    // L'état léger de la page d'accueil doit garder la priorité sur ces
    // widgets secondaires. Les déclencher pendant le premier rendu mettait
    // immédiatement 5 à 8 requêtes en concurrence avec la requête critique.
    const loadSecondaryWidgets = () => {
      if (authStore.selectedGuildId !== guildId) return;
      if (['liveStats', 'analytics', 'channels', 'moderation', 'members'].some((id) => visibleIds.has(id))) {
        void loadAnalytics();
      }
      if (visibleIds.has('staff')) void staffStore.fetchAll();
      if (visibleIds.has('news')) void loadChangelog();
      if (visibleIds.has('staffServer')) void loadStaffServerLinks();
      void loadHomeWidgets(sectionsFor(visibleIds));
    };

    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(loadSecondaryWidgets, { timeout: 1_500 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(loadSecondaryWidgets, 250);
    return () => globalThis.clearTimeout(timeoutId);
  });

  const activeModulesCount = $derived(dashboardStore.state.modules.filter(m => m.status === 'active').length);
  const errorModulesCount = $derived(dashboardStore.state.modules.filter(m => m.status === 'error').length);
  const errorModules = $derived(dashboardStore.state.modules.filter(m => m.status === 'error'));

  const pendingAbsences = $derived(staffStore.pendingAbsences);

  const dynamicGreeting = $derived.by(() => {
    const name = authStore.user?.username || m.home_manager();
    const hour = new Date().getHours();
    if (hour >= 18) return m.home_greeting_evening({ name });
    if (hour >= 12) return m.home_greeting_afternoon({ name });
    return m.home_greeting_morning({ name });
  });

  // Alimentes par le bloc « A traiter » : son compteur nourrit le sous-titre,
  // et le bouton Actualiser de la page le recharge avec le reste.
  let todoCount = $state(0);
  let todoRefreshKey = $state(0);

  /** « 1 sujet » ou « 4 sujets » : paraglide n'a pas de pluriel, on choisit la cle. */
  const plural = (n: number, one: () => string, other: (p: { n: number }) => string) =>
    n === 1 ? one() : other({ n });

  const dynamicSubtitle = $derived.by(() => {
    const guildName = dashboardStore.state.guildName || m.home_your_server();
    const parts: string[] = [];
    if (errorModulesCount > 0) parts.push(plural(errorModulesCount, m.home_modules_error_one, m.home_modules_error_count));
    if (todoCount > 0) parts.push(plural(todoCount, m.home_tasks_one, m.home_tasks_count));
    const unread = notificationsStore.unreadCount;
    if (unread > 0) parts.push(plural(unread, m.home_notifications_one, m.home_notifications_count));
    if (parts.length === 0) return m.home_all_good({ guild: guildName });
    // « 4 sujets a traiter et 2 notifications non lues » se lit ; les points
    // medians d'avant faisaient une liste de compteurs.
    let joined = parts.join(', ');
    try {
      joined = new Intl.ListFormat(dateLocale(), { type: 'conjunction' }).format(parts);
    } catch {
      // Navigateur sans ListFormat : la virgule suffit.
    }
    return m.home_subtitle_issues({ parts: joined, guild: guildName });
  });

  // Chart data from analytics
  let selectedStat = $state('messages');

  $effect(() => {
    if (authStore.selectedGuildId && authStore.user?.id) {
      const saved = localStorage.getItem(`fav_stat_${authStore.selectedGuildId}_${authStore.user.id}`);
      if (saved) selectedStat = saved;
    }
  });

  const handleStatChange = (stat: string) => {
    selectedStat = stat;
    if (authStore.selectedGuildId && authStore.user?.id) {
      localStorage.setItem(`fav_stat_${authStore.selectedGuildId}_${authStore.user.id}`, stat);
    }
  };

  const statConfig = $derived.by(() => {
    const trend = analyticsData?.dailyTrend || [];
    switch (selectedStat) {
      case 'voice':
        return { title: m.home_stat_voice_title(), subtitle: m.home_stat_voice_sub(), color: 'var(--color-secondary)', values: trend.map(d => d.voiceMinutes || 0), unit: ' min' };
      case 'joins':
        return { title: m.home_stat_joins_title(), subtitle: m.home_stat_joins_sub(), color: 'var(--color-primary)', values: trend.map(d => d.membersJoined || 0), unit: '' };
      case 'leaves':
        return { title: m.home_stat_leaves_title(), subtitle: m.home_stat_leaves_sub(), color: 'var(--color-error)', values: trend.map(d => d.membersLeft || 0), unit: '' };
      case 'sanctions':
        return { title: m.nav_sanctions(), subtitle: m.home_stat_sanctions_sub(), color: 'var(--color-warning)', values: trend.map(d => d.sanctions || 0), unit: '' };
      default:
        return { title: 'Messages', subtitle: m.home_stat_messages_sub(), color: 'var(--color-tertiary)', values: trend.map(d => d.messages || 0), unit: '' };
    }
  });

  const activityData = $derived(
    (analyticsData?.dailyTrend || []).map((d, i) => ({
      name: formatDateLabel(d.dateKey),
      value: statConfig.values[i] || 0
    }))
  );

  function formatDateLabel(dateKey: string): string {
    try {
      const d = new Date(dateKey + 'T12:00:00Z');
      return d.toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric' });
    } catch {
      return `J-${dateKey}`;
    }
  }

  const statTotal = $derived(statConfig.values.reduce((a, b) => a + b, 0));

  // Live stats from analytics
  const liveStats = $derived(analyticsData?.live || null);
  const totals = $derived(analyticsData?.totals || null);

  // Top channels
  const topChannels = $derived((analyticsData?.topChannels || []).slice(0, 5));

  // Top members
  const topMembers = $derived((analyticsData?.topMessageMembers || []).slice(0, 5));

  // Moderation
  const moderation = $derived(analyticsData?.moderation || null);

  const handleMarkAsRead = async (id: string) => {
    await notificationsStore.markAsRead(id);
  };

  const handleRefresh = () => {
    todoRefreshKey += 1;
    dashboardStore.refresh();
    notificationsStore.fetchNotifications(true);

    const visibleIds = new Set(visibleLayout.map((item) => item.id));
    if (visibleIds.has('staff')) staffStore.fetchAll(true);
    if (['liveStats', 'analytics', 'channels', 'moderation', 'members'].some((id) => visibleIds.has(id))) {
      loadAnalytics(true);
    }
    void loadHomeWidgets(sectionsFor(visibleIds), true);
  };

  function formatNumber(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toString();
  }

  function relativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return m.home_rel_now_lower();
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return m.home_short_days({ n: days });
  }
</script>

<div class="space-y-5 {isEditing ? 'pb-28' : 'pb-10'}">

  <header>
    <div class="flex items-center justify-between gap-3">
      <h1 class="min-w-0 text-2xl font-semibold font-headline text-on-surface">{isEditing ? m.home_edit_title() : dynamicGreeting}</h1>
      {#if !isEditing}
        <div class="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" icon="sliders" onclick={startEditing} data-tour="home-customize">
            {m.home_customize()}
          </Button>
          <RefreshButton onClick={handleRefresh} ariaLabel={m.home_refresh_aria()} />
        </div>
      {/if}
    </div>
    <p class="text-sm text-on-surface-variant mt-1">{isEditing ? m.home_edit_hint() : dynamicSubtitle}</p>
  </header>

  {#if dashboardStore.state.error === 'api_unreachable'}
    <Callout variant="warning" title={m.home_api_restarting()}>
      {m.home_api_reconnect()}
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => dashboardStore.refresh()}>{m.home_retry()}</Button>
      {/snippet}
    </Callout>
  {/if}

  {#if errorModulesCount > 0}
    <Callout
      variant="danger"
      title={errorModulesCount === 1 ? m.home_modules_failing_one() : m.home_modules_failing({ n: errorModulesCount })}
    >
      {errorModules.map((mod) => mod.name).join(', ')}
      {#snippet actions()}
        <Button size="sm" variant="secondary" href="/modules">{m.home_see_modules()}</Button>
      {/snippet}
    </Callout>
  {/if}

  <HomeTodo refreshKey={todoRefreshKey} bind:count={todoCount} />

  {#if visibleLayout.length === 0 && !isEditing}
    <div class="section-card p-6 flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-on-surface-variant">{m.home_grid_empty()}</p>
      <Button size="sm" variant="secondary" icon="add" onclick={() => { startEditing(); showAddModuleModal = true; }}>{m.home_add_module()}</Button>
    </div>
  {/if}

  <!-- Bento Grid -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" role="list">
    {#each visibleLayout as item, index (item.id)}
      <div
        role="listitem"
        draggable={isEditing && !$isMobile}
        ondragstart={(e) => handleDragStart(e, index)}
        ondragend={handleDragEnd}
        ondragover={(e) => handleDragOver(e, index)}
        ondragleave={handleDragLeave}
        ondrop={(e) => handleDrop(e, index)}
        class="home-bento-item section-card p-5 flex flex-col relative group transition-all duration-200 {getColSpanClass(displayColSpan(item))} {getRowSpanClass(displayRowSpan(item))} {getModuleMinHeight(item.id)} {isEditing ? 'border-dashed border-primary/50 hover:shadow-lg hover:border-primary bg-surface-container-lowest/80' : ''} {isEditing && dragOverIndex === index ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface scale-[1.02]' : ''}"
        style={isEditing ? `cursor: grab; ${getSpanStyle(displayColSpan(item), displayRowSpan(item))}` : getSpanStyle(displayColSpan(item), displayRowSpan(item))}
      >
        {#if isEditing}
          <!-- Grab handle indicator -->
          <div class="absolute top-1.5 left-1/2 -translate-x-1/2 z-10 opacity-40 group-hover:opacity-80 transition-opacity pointer-events-none">
            <div class="flex gap-0.5">
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
            </div>
            <div class="flex gap-0.5 mt-0.5">
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
              <div class="w-1 h-1 rounded-full bg-on-surface-variant"></div>
            </div>
          </div>

          <!-- Edit toolbar -->
          <div class="absolute top-2.5 right-2.5 z-10 flex items-center gap-1 bg-surface-container/90 px-1.5 py-1 rounded-md shadow-sm border border-outline-variant/60">
            <button
              onclick={() => moveModule(item.id, -1)}
              disabled={index === 0}
              title={m.home_move_up()}
              aria-label={m.home_move_up()}
              class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            >
              <Papicon icon="arrow-up" size={12} />
            </button>
            <button
              onclick={() => moveModule(item.id, 1)}
              disabled={index === visibleLayout.length - 1}
              title={m.home_move_down()}
              aria-label={m.home_move_down()}
              class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            >
              <Papicon icon="arrow-down" size={12} />
            </button>
            {#if !$isMobile}
              <button
                onclick={() => toggleSize(item.id)}
                title={m.home_width_cols({ n: item.colSpan })}
                aria-label={m.home_width_cols({ n: item.colSpan })}
                class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors text-2xs font-bold px-1.5 cursor-pointer"
              >
                {item.colSpan}c
              </button>
              <button
                onclick={() => toggleRowSize(item.id)}
                title={m.home_height_rows({ n: item.rowSpan || 1 })}
                aria-label={m.home_height_rows({ n: item.rowSpan || 1 })}
                class="p-1 rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors text-2xs font-bold px-1.5 cursor-pointer"
              >
                {item.rowSpan || 1}r
              </button>
            {/if}
            <button
              onclick={() => hideModule(item.id)}
              title={m.home_hide_module()}
              aria-label={m.home_hide_module()}
              class="p-1 rounded text-error hover:bg-error/10 transition-colors cursor-pointer"
            >
              <Papicon icon="trash" size={12} />
            </button>
          </div>

          {#if !$isMobile}
            <!-- Desktop-only precision resize handles -->
            <div
              role="button"
              tabindex="-1"
              aria-label={m.home_resize_width()}
              onmousedown={(e) => handleResizeStart(e, item.id, 'col')}
              class="absolute top-0 right-0 w-2 h-full cursor-col-resize z-20 group/resize hover:bg-primary/20 transition-colors rounded-r-lg"
              title={m.home_resize_width()}
            >
              <div class="absolute top-1/2 right-0.5 -translate-y-1/2 w-0.5 h-8 bg-primary/40 rounded-full opacity-0 group-hover/resize:opacity-100 transition-opacity"></div>
            </div>

            <div
              role="button"
              tabindex="-1"
              aria-label={m.home_resize_height()}
              onmousedown={(e) => handleResizeStart(e, item.id, 'row')}
              class="absolute bottom-0 left-0 w-full h-2 cursor-row-resize z-20 group/resize hover:bg-primary/20 transition-colors rounded-b-lg"
              title={m.home_resize_height()}
            >
              <div class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary/40 rounded-full opacity-0 group-hover/resize:opacity-100 transition-opacity"></div>
            </div>
          {/if}
        {/if}

        {#if item.id === 'liveStats'}
          <!-- Une seule surface : quatre chiffres cote a cote, sans carte par
               chiffre ni pastille d'icone. Les colonnes suivent la largeur du
               bloc, pas celle de l'ecran, pour tenir aussi en bloc etroit. -->
          {@const stats = [
            {
              label: m.home_members_label(),
              value: liveStats ? formatNumber(liveStats.humansCount) : '-',
              note: liveStats ? (liveStats.botsCount === 1 ? m.home_bots_one() : m.home_bots_count({ n: liveStats.botsCount })) : '',
              tone: '',
            },
            {
              label: m.home_connected_label(),
              value: liveStats ? formatNumber(liveStats.onlineMembers + liveStats.idleMembers + liveStats.dndMembers) : '-',
              note: liveStats ? m.home_online_available({ n: liveStats.onlineMembers }) : '',
              tone: '',
            },
            {
              label: m.home_in_voice(),
              value: liveStats ? String(liveStats.voiceConnected) : '-',
              note: m.home_right_now(),
              tone: '',
            },
            {
              label: m.home_this_week(),
              value: totals ? `${totals.netGrowth > 0 ? '+' : ''}${totals.netGrowth}` : '-',
              note: totals ? m.home_joins_leaves_note({ joins: totals.joins, leaves: totals.leaves }) : '',
              tone: totals && totals.netGrowth < 0 ? 'text-error' : '',
            },
          ]}
          <div class="@container h-full flex items-center">
            <dl class="w-full grid grid-cols-2 @xl:grid-cols-4 gap-x-6 gap-y-4">
              {#each stats as stat (stat.label)}
                <div class="min-w-0 @xl:border-l @xl:border-outline-variant @xl:pl-5 @xl:first:border-l-0 @xl:first:pl-0">
                  <dt class="text-xs text-on-surface-variant truncate">{stat.label}</dt>
                  <dd class="mt-0.5">
                    {#if analyticsLoading && !liveStats}
                      <span class="block h-7 w-14 animate-pulse bg-surface-container-high rounded"></span>
                    {:else}
                      <span class="block text-2xl font-semibold tracking-tight tabular-nums text-on-surface {stat.tone}">{stat.value}</span>
                    {/if}
                    {#if stat.note}
                      <span class="block text-xs text-on-surface-variant truncate">{stat.note}</span>
                    {/if}
                  </dd>
                </div>
              {/each}
            </dl>
          </div>
        {:else if item.id === 'analytics'}
          {#if dashboardStore.state.featureAccess.analytics?.canView}
            <div class="flex flex-col h-full justify-between">
              <div class="flex items-start justify-between gap-3 mb-3 shrink-0">
                <div class="min-w-0">
                  <label for="home-stat-{item.id}" class="sr-only">{m.home_chart_pick()}</label>
                  <select
                    id="home-stat-{item.id}"
                    value={selectedStat}
                    onchange={(e) => handleStatChange(e.currentTarget.value)}
                    class="-ml-1.5 pl-1.5 pr-1 py-0.5 rounded-md bg-transparent text-sm font-medium text-on-surface hover:bg-surface-container focus:bg-surface-container outline-none cursor-pointer"
                  >
                    <option value="messages">Messages</option>
                    <option value="voice">{m.home_opt_voice()}</option>
                    <option value="joins">{m.home_stat_joins_title()}</option>
                    <option value="leaves">{m.home_stat_leaves_title()}</option>
                    <option value="sanctions">{m.nav_sanctions()}</option>
                  </select>
                  <p class="text-xs text-on-surface-variant">{statConfig.subtitle}</p>
                </div>
                <div class="text-right shrink-0">
                  {#if analyticsLoading}
                    <div class="h-7 w-16 animate-pulse bg-surface-container-high rounded"></div>
                  {:else}
                    <span class="text-xl font-semibold tabular-nums text-on-surface">{formatNumber(statTotal)}{statConfig.unit}</span>
                    <p class="text-xs text-on-surface-variant">{m.home_last_7_days()}</p>
                  {/if}
                </div>
              </div>
              <div class="w-full grow" style="min-height: {displayRowSpan(item) >= 3 ? 320 : displayRowSpan(item) >= 2 ? 220 : 128}px">
                {#if activityData.length > 0}
                  {#await import('../lib/components/LineChart.svelte')}
                    <div
                      class="w-full rounded-lg bg-surface-container animate-pulse"
                      style:height={`${displayRowSpan(item) >= 3 ? 320 : displayRowSpan(item) >= 2 ? 220 : 128}px`}
                      aria-hidden="true"
                    ></div>
                  {:then module}
                    {@const LineChart = module.default}
                    <LineChart
                      data={activityData}
                      height={displayRowSpan(item) >= 3 ? 320 : displayRowSpan(item) >= 2 ? 220 : 128}
                      labelKey="name"
                      valueKey="value"
                      color={statConfig.color}
                    />
                  {/await}
                {:else}
                  <div class="h-full flex items-center justify-center text-on-surface-variant text-xs">
                    {analyticsLoading ? m.common_loading() : m.home_no_data()}
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        {:else if item.id === 'botLanguage' || item.id === 'timezone'}
          <!-- Reglages du serveur, pas des chiffres : le meme bloc vit dans
               Reglages du serveur > Apercu. Le widget reste pour qui l'avait. -->
          <div class="h-full -my-2">
            <ServerLocaleSettings only={item.id === 'botLanguage' ? 'language' : 'timezone'} stacked bare />
          </div>
        {:else if item.id === 'system'}
          <!-- L'ancien anneau affichait une sante fixee a 100 % par l'API, et
               « Interactions » additionnait des compteurs sans rapport. Ne
               reste que ce qui est vrai : combien de modules tournent, et
               lesquels sont en erreur. -->
          <div class="flex flex-col gap-3 h-full">
            <div class="flex items-center justify-between gap-2 shrink-0">
              <h3 class="text-sm font-medium text-on-surface">{m.home_mod_system_title()}</h3>
              <a href="/modules" class="text-2xs text-primary hover:underline">{m.home_manage()}</a>
            </div>
            <div class="grow flex flex-col justify-center gap-2">
              <p>
                <span class="text-2xl font-semibold tabular-nums text-on-surface">{activeModulesCount}</span>
                <span class="text-sm text-on-surface-variant">{activeModulesCount === 1 ? m.home_modules_active_one() : m.home_modules_active_other()}</span>
              </p>
              {#if errorModules.length > 0}
                <div>
                  <p class="text-xs font-medium text-error">
                    {errorModules.length === 1 ? m.home_modules_failing_one() : m.home_modules_failing({ n: errorModules.length })}
                  </p>
                  <ul class="mt-1 space-y-0.5">
                    {#each errorModules.slice(0, displayRowSpan(item) >= 2 ? 8 : 4) as mod (mod.name)}
                      <li class="text-xs text-on-surface truncate">{mod.name}</li>
                    {/each}
                  </ul>
                </div>
              {:else}
                <p class="text-xs text-on-surface-variant">{m.home_modules_none_failing()}</p>
              {/if}
            </div>
          </div>
        {:else if item.id === 'channels'}
          {@const channelCount = getListCount(5, displayColSpan(item), displayRowSpan(item))}
          {@const channelsCols = displayColSpan(item) >= 2 ? 2 : 1}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_active_channels()}</h3>
              </div>
              <span class="text-2xs text-on-surface-variant">{m.home_last_7_days()}</span>
            </div>
            <div class="grow flex flex-col justify-center {channelsCols > 1 ? 'grid grid-cols-2 gap-x-4 gap-y-2 items-start' : 'space-y-2'}">
              {#if analyticsLoading}
                {#each Array(channelCount) as _}
                  <div class="h-7 animate-pulse bg-surface-container-high rounded"></div>
                {/each}
              {:else if topChannels.length > 0}
                {#each (analyticsData?.topChannels || []).slice(0, channelCount) as channel, i}
                  {@const maxMsgs = topChannels[0]?.messagesCount || 1}
                  <div class="flex items-center gap-2.5">
                    <span class="text-2xs text-on-surface-variant w-4 text-right shrink-0">{i + 1}</span>
                    <div class="grow min-w-0">
                      <div class="flex items-center justify-between gap-2 mb-0.5">
                        <span class="text-xs text-on-surface truncate"># {channel.channelName}</span>
                        <span class="text-2xs text-on-surface-variant shrink-0">{formatNumber(channel.messagesCount)}</span>
                      </div>
                      <div class="h-1 w-full bg-surface-container-high rounded-full overflow-hidden">
                        <div class="bg-tertiary/60 h-full rounded-full" style="width: {(channel.messagesCount / maxMsgs) * 100}%"></div>
                      </div>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant {channelsCols > 1 ? 'col-span-2' : ''}">{m.home_no_data()}</div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'moderation'}
          {@const modStats = moderation ? [
            { label: m.home_mod_warns(), value: moderation.totals.warns },
            { label: m.home_mod_timeouts(), value: moderation.totals.timeouts },
            { label: m.home_mod_kicks(), value: moderation.totals.kicks },
            { label: m.home_mod_bans(), value: moderation.totals.bans },
          ] : []}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between gap-2 mb-3 shrink-0">
              <h3 class="text-sm font-medium text-on-surface">{m.home_mod_moderation_title()}</h3>
              <a href="/analytics" class="text-2xs text-primary hover:underline">{m.home_details()}</a>
            </div>
            <div class="space-y-3 grow flex flex-col justify-center">
              {#if analyticsLoading && !moderation}
                {#each Array(2) as _}
                  <div class="h-10 animate-pulse bg-surface-container-high rounded"></div>
                {/each}
              {:else if moderation}
                <dl class="grid {displayColSpan(item) >= 2 ? 'grid-cols-4' : 'grid-cols-2'} gap-x-4 gap-y-3">
                  {#each modStats as stat (stat.label)}
                    <div class="min-w-0">
                      <dd class="text-lg font-semibold tabular-nums text-on-surface">{stat.value}</dd>
                      <dt class="text-xs text-on-surface-variant truncate">{stat.label}</dt>
                    </div>
                  {/each}
                </dl>
                <p class="text-xs text-on-surface-variant">
                  {#if moderation.activeSanctions > 0}
                    <span class="text-warning">{moderation.activeSanctions === 1 ? m.home_active_sanctions_one() : m.home_active_sanctions({ n: moderation.activeSanctions })}</span>
                  {:else}
                    {m.home_mod_week_note()}
                  {/if}
                </p>
                {#if displayRowSpan(item) >= 2 && moderation.recentSanctions?.length > 0}
                  <div class="border-t border-outline-variant pt-2 space-y-1.5">
                    <span class="text-xs text-on-surface-variant">{m.home_recent_sanctions()}</span>
                    {#each moderation.recentSanctions.slice(0, displayRowSpan(item) >= 3 ? 6 : 3) as sanction}
                      <div class="flex items-center justify-between text-xs">
                        <span class="text-on-surface truncate">{sanction.targetName || m.home_member()}</span>
                        <span class="text-2xs text-on-surface-variant shrink-0">{sanction.type}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant">{m.home_no_data()}</div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'members'}
          {@const memberCount = getListCount(5, displayColSpan(item), displayRowSpan(item))}
          {@const membersCols = displayColSpan(item) >= 2 ? 2 : 1}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_top_members()}</h3>
              </div>
              <span class="text-2xs text-on-surface-variant">{m.home_last_7_days()}</span>
            </div>
            <div class="grow flex flex-col justify-center {membersCols > 1 ? 'grid grid-cols-2 gap-x-4 gap-y-2 items-start' : 'space-y-2'}">
              {#if analyticsLoading}
                {#each Array(memberCount) as _}
                  <div class="h-7 animate-pulse bg-surface-container-high rounded"></div>
                {/each}
              {:else if topMembers.length > 0}
                {#each (analyticsData?.topMessageMembers || []).slice(0, memberCount) as member, i}
                  <div class="flex items-center gap-2.5">
                    <span class="text-2xs font-medium {i === 0 ? 'text-warning' : i === 1 ? 'text-on-surface-variant' : i === 2 ? 'text-orange-400' : 'text-on-surface-variant'} w-4 text-right shrink-0">{i + 1}</span>
                    {#if member.avatarUrl}
                      <img src={member.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />
                    {:else}
                      <div class="w-6 h-6 rounded-full bg-surface-container-high shrink-0 flex items-center justify-center">
                        <Papicon icon="user" size={12} class="text-on-surface-variant" />
                      </div>
                    {/if}
                    <div class="grow min-w-0 flex items-center justify-between gap-2">
                      <span class="text-xs text-on-surface truncate">{member.name}</span>
                      <span class="text-2xs text-on-surface-variant shrink-0">{formatNumber(member.messageCount)} msg</span>
                    </div>
                  </div>
                {/each}
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant {membersCols > 1 ? 'col-span-2' : ''}">{m.home_no_data()}</div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'notifications'}
          {@const notifCount = getListCount(5, displayColSpan(item), displayRowSpan(item))}
          {@const notifCols = displayColSpan(item) >= 2 ? 2 : 1}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <div>
                  <h3 class="text-sm font-medium text-on-surface">Notifications</h3>
                  <span class="text-2xs text-on-surface-variant">{notificationsStore.unreadCount === 1 ? m.home_notifications_one() : m.home_notifications_count({ n: notificationsStore.unreadCount })}</span>
                </div>
              </div>
              <a href="/inbox" class="w-6 h-6 rounded-md bg-surface-container flex items-center justify-center hover:bg-surface-container-high transition-colors text-on-surface-variant">
                <Papicon icon="arrow-up-right" size={12} />
              </a>
            </div>
            <div class="grow flex flex-col justify-center {notifCols > 1 ? 'grid grid-cols-2 gap-1.5 items-start' : 'space-y-1.5'}">
              {#if notificationsStore.items.filter(n => !n.isRead).length > 0}
                {#each notificationsStore.items.filter(n => !n.isRead).slice(0, notifCount) as notif}
                  <div class="px-2.5 py-2 rounded-lg border border-outline-variant bg-surface-container-low flex items-center justify-between gap-2 hover:border-primary/30 transition-colors">
                    <div class="flex items-center gap-2 min-w-0">
                      <div class="w-1.5 h-1.5 rounded-full {notif.type === 'ERROR' ? 'bg-error' : notif.type === 'WARNING' ? 'bg-warning' : 'bg-primary'} shrink-0"></div>
                      <div class="min-w-0">
                        <p class="text-xs font-medium leading-tight truncate">{notif.title}</p>
                        <p class="text-2xs text-on-surface-variant mt-0.5 line-clamp-1">{notif.message}</p>
                      </div>
                    </div>
                    <button
                      onclick={() => handleMarkAsRead(notif.id)}
                      class="w-5 h-5 rounded bg-success/10 text-success hover:bg-success/20 transition-colors flex items-center justify-center shrink-0 cursor-pointer"
                    >
                      <Papicon icon="check" size={10} />
                    </button>
                  </div>
                {/each}
              {:else}
                <div class="flex flex-col items-center justify-center py-6 text-center text-on-surface-variant {notifCols > 1 ? 'col-span-2' : ''}">
                  <Papicon icon="check-circle" size={18} class="mb-1 text-success/50" />
                  <p class="text-2xs">{m.home_all_up_to_date()}</p>
                </div>
              {/if}
            </div>
          </div>
        {:else if item.id === 'staff'}
          {@const staffAbsCount = displayRowSpan(item) >= 2 ? 3 : 1}
          {@const staffMeetCount = displayRowSpan(item) >= 2 ? 3 : 1}
          <!-- Deux listes courtes separees par un filet : les petites cartes
               bordees d'avant faisaient une carte dans la carte, et les
               pastilles « 2 abs. » / « 1 reu. » demandaient a etre dechiffrees. -->
          <div class="flex flex-col h-full">
            <div class="flex items-center justify-between gap-2 mb-3 shrink-0">
              <h3 class="text-sm font-medium text-on-surface">{m.home_staff_title()}</h3>
              <a href="/staff-management" class="text-2xs text-primary hover:underline">{m.home_manage_team()}</a>
            </div>
            <div class="grid {displayColSpan(item) >= 2 ? 'grid-cols-2 gap-6' : 'grid-cols-1 gap-3'}">
              <section>
                <h4 class="text-xs text-on-surface-variant">
                  {pendingAbsences.length === 0 ? m.home_absences_none() : pendingAbsences.length === 1 ? m.home_absences_one() : m.home_absences_count({ n: pendingAbsences.length })}
                </h4>
                {#each pendingAbsences.slice(0, staffAbsCount) as absence}
                  <a href="/planning" class="block mt-1 rounded-md -mx-1.5 px-1.5 py-1 hover:bg-surface-container">
                    <span class="block text-sm font-medium text-on-surface truncate">{absence.staffDisplayName || m.home_staff_member()}</span>
                    {#if absence.reason}
                      <span class="block text-xs text-on-surface-variant truncate">{absence.reason}</span>
                    {/if}
                  </a>
                {/each}
              </section>
              <section class="{displayColSpan(item) >= 2 ? '' : 'pt-3 border-t border-outline-variant'}">
                <h4 class="text-xs text-on-surface-variant">
                  {staffStore.upcomingMeetings.length === 0 ? m.home_meetings_none() : m.home_next_meeting()}
                </h4>
                {#each staffStore.upcomingMeetings.slice(0, staffMeetCount) as meeting}
                  <a href="/planning" class="block mt-1 rounded-md -mx-1.5 px-1.5 py-1 hover:bg-surface-container">
                    <span class="block text-sm font-medium text-on-surface truncate">{meeting.title}</span>
                    <span class="block text-xs text-on-surface-variant">
                      {m.home_date_at_time({ date: new Date(meeting.scheduledAt).toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'short' }), time: new Date(meeting.scheduledAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) })}
                    </span>
                  </a>
                {/each}
              </section>
            </div>
          </div>
        {:else if item.id === 'audit'}
          <!-- La largeur sert a lire chaque ligne en entier, pas a en montrer
               plus : seule la hauteur allonge la liste. -->
          {@const auditCount = getListCount(5, 1, displayRowSpan(item))}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_recent_activity()}</h3>
              </div>
              <a href="/activity" class="text-2xs text-primary hover:underline">{m.home_see_all()}</a>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              {#each dashboardStore.state.auditTrail.slice(0, auditCount) as entry}
                <div class="flex gap-2 items-start">
                  <div class="w-6 h-6 rounded bg-surface-container flex items-center justify-center shrink-0 mt-0.5">
                    <Papicon icon={entry.source === 'discord' ? 'message-circle' : entry.user === 'Automatique' ? 'cpu' : 'user'} size={11} class="text-on-surface-variant" />
                  </div>
                  <div class="grow min-w-0">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-2xs text-primary truncate">{entry.module}</span>
                      <span class="text-2xs text-on-surface-variant shrink-0">{entry.dateIso ? relativeTime(entry.dateIso) : ''}</span>
                    </div>
                    <p class="text-xs text-on-surface truncate">
                      {entry.action}{#if displayColSpan(item) >= 2 && entry.user}<span class="text-on-surface-variant">{' · '}{m.home_by_user({ user: entry.user })}</span>{/if}
                    </p>
                  </div>
                </div>
              {:else}
                <div class="flex items-center justify-center h-full text-xs text-on-surface-variant">{m.home_no_activity()}</div>
              {/each}
            </div>
          </div>
        {:else if item.id === 'actions'}
          <div class="flex flex-col h-full justify-center">
            <div class="flex flex-wrap gap-2 items-center">
              <span class="text-2xs text-on-surface-variant mr-1">{m.home_shortcuts()}</span>
              <button onclick={() => router.goto('/planning')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="calendar-plus" size={12} class="text-primary" /> {m.home_absence()}
              </button>
              <button onclick={() => router.goto('/planning')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="video" size={12} class="text-secondary" /> {m.home_meeting()}
              </button>
              <button onclick={() => router.goto('/modules')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="plus-circle" size={12} class="text-tertiary" /> {m.nav_modules()}
              </button>
              <button onclick={() => router.goto('/analytics')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="bar-chart-2" size={12} class="text-warning" /> {m.home_shortcut_stats()}
              </button>
              <button onclick={() => router.goto('/staff-management')} class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-container border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer">
                <Papicon icon="users" size={12} class="text-success" /> Staff
              </button>
            </div>
          </div>
        {:else if item.id === 'notes'}
          <div class="flex flex-col h-full min-h-[160px]">
            <div class="flex items-center gap-2.5 mb-2 shrink-0">
              <h3 class="text-sm font-medium text-on-surface">{m.home_team_notes()}</h3>
            </div>
            <textarea
              value={staffNotes}
              oninput={saveStaffNotes}
              placeholder={m.home_notes_placeholder()}
              class="w-full grow p-2.5 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none resize-none focus:border-primary/50 text-on-surface min-h-[100px]"
            ></textarea>
          </div>
        {:else if item.id === 'serverInfo'}
          {@const serverInfo = homeWidgets?.serverInfo}
          {@const memberCount = serverInfo?.memberCount ?? (liveStats ? liveStats.humansCount + liveStats.botsCount : null)}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_serverinfo_title()}</h3>
              </div>
            </div>
            <div class="space-y-2 text-xs grow flex flex-col justify-center">
              <div class="flex justify-between py-1 border-b border-outline-variant/30">
                <span class="text-on-surface-variant">{m.home_name_label()}</span>
                <span class="font-medium text-on-surface truncate max-w-[150px]">{serverInfo?.name || dashboardStore.state.guildName || '-'}</span>
              </div>
              <div class="flex justify-between py-1 border-b border-outline-variant/30">
                <span class="text-on-surface-variant">{m.home_members_label()}</span>
                <span class="font-medium text-on-surface">{memberCount === null ? '-' : formatNumber(memberCount)}</span>
              </div>
              <div class="flex justify-between py-1 border-b border-outline-variant/30">
                <span class="text-on-surface-variant">Boosts</span>
                {#if serverInfo?.boostLevel == null}
                  <span class="font-medium text-on-surface">-</span>
                {:else}
                  <span class="font-medium text-purple-400 flex items-center gap-1">
                    <Papicon icon="star" size={10} /> {m.home_boost_level({ n: serverInfo.boostLevel })} · {serverInfo.boostCount}
                  </span>
                {/if}
              </div>
              <div class="flex justify-between py-1">
                <span class="text-on-surface-variant">{m.home_owner()}</span>
                <span class="font-semibold text-on-surface truncate max-w-[150px]">{serverInfo?.ownerTag || '-'}</span>
              </div>
            </div>
          </div>
        {:else if item.id === 'botHosting'}
          {@const hosting = homeWidgets?.hosting}
          {@const memoryPercent = hosting && hosting.memoryTotalMb > 0 ? Math.min(100, Math.round((hosting.memoryUsedMb / hosting.memoryTotalMb) * 100)) : 0}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_bothosting_title()}</h3>
              </div>
              {#if hosting}
                <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-2xs bg-success/20 text-success font-medium">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> {m.home_online_label()}
                </span>
              {/if}
            </div>
            <div class="space-y-3 grow flex flex-col justify-center">
              <div>
                <div class="flex justify-between text-2xs text-on-surface-variant mb-1">
                  <span>{m.home_cpu()}</span>
                  <span class="font-medium text-on-surface">{hosting?.cpuPercent == null ? '-' : `${hosting.cpuPercent}%`}</span>
                </div>
                <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                  <div class="bg-emerald-500 h-full rounded-full transition-all duration-500" style="width: {hosting?.cpuPercent ?? 0}%"></div>
                </div>
              </div>
              <div>
                <div class="flex justify-between text-2xs text-on-surface-variant mb-1">
                  <span>{m.home_ram()}</span>
                  <span class="font-medium text-on-surface">{hosting ? `${formatMemory(hosting.memoryUsedMb)} / ${formatMemory(hosting.memoryTotalMb)}` : '-'}</span>
                </div>
                <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                  <div class="bg-primary h-full rounded-full transition-all duration-500" style="width: {memoryPercent}%"></div>
                </div>
              </div>
              <div class="flex justify-between text-xs pt-1">
                <span class="text-on-surface-variant">{m.home_api_latency()}</span>
                <span class="font-medium {!hosting ? 'text-on-surface' : hosting.latencyMs < 200 ? 'text-success' : hosting.latencyMs < 500 ? 'text-warning' : 'text-error'}">
                  {hosting ? `${hosting.latencyMs} ms` : '-'}
                </span>
              </div>
              <div class="flex justify-between text-xs">
                <span class="text-on-surface-variant">{m.home_uptime()}</span>
                <span class="font-medium text-on-surface">{hosting ? formatDuration(hosting.uptimeSeconds) : '-'}</span>
              </div>
            </div>
          </div>
        {:else if item.id === 'news'}
          {@const maxNewsItems = displayRowSpan(item) >= 2 ? 6 : 3}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_kotbo_news()}</h3>
              </div>
            </div>
            <div class="space-y-2 grow text-xs flex flex-col overflow-y-auto" style="scrollbar-width: thin;">
              {#if changelogLoading}
                <div class="flex items-center justify-center grow">
                  <span class="text-on-surface-variant text-2xs">{m.common_loading()}</span>
                </div>
              {:else if changelogCommits.length === 0}
                <div class="flex items-center justify-center grow">
                  <span class="text-on-surface-variant text-2xs">{m.home_no_updates()}</span>
                </div>
              {:else}
                {#each changelogCommits.slice(0, maxNewsItems) as commit}
                  {@const typeColors: Record<string, string> = { feat: 'text-success', fix: 'text-warning', refactor: 'text-blue-400', perf: 'text-cyan-400', test: 'text-violet-400' }}
                  {@const typeBgColors: Record<string, string> = { feat: 'bg-success/15', fix: 'bg-warning/15', refactor: 'bg-blue-500/15', perf: 'bg-cyan-500/15', test: 'bg-violet-500/15' }}
                  {@const typeLabels: Record<string, string> = { feat: m.home_type_feat(), fix: m.home_type_fix(), refactor: m.home_type_refactor(), perf: 'Perf', test: 'Test' }}
                  {@const typeColor = typeColors[commit.type] || 'text-purple-400'}
                  {@const typeBg = typeBgColors[commit.type] || 'bg-purple-500/15'}
                  {@const typeLabel = typeLabels[commit.type] || commit.type}
                  {@const relDate = formatRelativeDate(commit.date)}
                  <div class="p-2 rounded-lg bg-surface-container/60 hover:bg-surface-container transition-colors">
                    <div class="flex items-center justify-between mb-0.5">
                      <span class="inline-flex items-center px-1.5 py-px rounded-full text-2xs font-medium {typeBg} {typeColor}">
                        {typeLabel}{commit.scope ? ` (${commit.scope})` : ''}
                      </span>
                      <span class="text-2xs text-on-surface-variant">{relDate}</span>
                    </div>
                    <p class="font-medium text-on-surface text-2xs leading-snug">{commit.title}</p>
                    {#if commit.description}
                      <p class="text-2xs text-on-surface-variant mt-0.5 leading-tight line-clamp-2">{commit.description}</p>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if item.id === 'quickGuide'}
          {@const guide = homeWidgets?.quickGuide}
          {@const guideSteps = [
            { label: m.home_guide_invite(), done: guide?.botInvited ?? false, href: '/modules' },
            { label: m.home_guide_logs(), done: guide?.logsConfigured ?? false, href: '/logs' },
            { label: m.home_guide_tickets(), done: guide?.ticketsConfigured ?? false, href: '/tickets' },
            { label: m.home_guide_roles(), done: guide?.staffRolesConfigured ?? false, href: '/staff-management/roles' },
          ]}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center gap-2.5 mb-3 shrink-0">
              <h3 class="text-sm font-medium text-on-surface">{m.home_quick_guide()}</h3>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              {#each guideSteps as step}
                <button
                  onclick={() => router.goto(step.href)}
                  disabled={!guide}
                  class="flex items-center gap-2 text-xs text-on-surface text-left disabled:cursor-default {guide ? 'cursor-pointer hover:text-primary' : ''}"
                >
                  <span class="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 {step.done ? 'bg-primary border-primary text-white' : 'border-outline-variant'}">
                    {#if step.done}
                      <Papicon icon="check" size={10} />
                    {/if}
                  </span>
                  <span class={step.done ? 'line-through text-on-surface-variant' : ''}>{step.label}</span>
                </button>
              {/each}
            </div>
          </div>
        {:else if item.id === 'clockWeather'}
          <div class="flex flex-col h-full justify-between min-h-[130px]">
            <div class="flex items-center gap-2.5 mb-2 shrink-0">
              <h3 class="text-sm font-medium text-on-surface">{m.home_mod_clockweather_title()}</h3>
            </div>
            <div class="flex flex-col justify-center grow">
              <p class="text-2xl font-bold text-on-surface tracking-tight">{currentTime}</p>
              <p class="text-2xs text-on-surface-variant capitalize">{currentDate}</p>
            </div>
          </div>
        {:else if item.id === 'economy'}
          {@const economy = homeWidgets?.economy}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_economy_title()}</h3>
              </div>
              <button onclick={() => router.goto('/economy')} class="text-2xs text-primary hover:underline cursor-pointer">{m.home_manage()}</button>
            </div>
            <div class="space-y-2.5 grow flex flex-col justify-center">
              <div class="grid grid-cols-2 gap-2">
                <div class="px-3 py-2 rounded-lg bg-warning/5 border border-warning/10">
                  <p class="text-lg font-semibold text-on-surface">{economy ? formatNumber(economy.totalBalance) : '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_in_circulation()}</p>
                </div>
                <div class="px-3 py-2 rounded-lg bg-success/5 border border-success/10">
                  <p class="text-lg font-semibold text-on-surface">{economy ? formatNumber(economy.activePlayers) : '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_active_7d()}</p>
                </div>
              </div>
              <p class="text-2xs text-on-surface-variant text-center">
                {#if !economy}
                  {m.home_economy_hint()}
                {:else if !economy.enabled}
                  {m.home_economy_disabled()}
                {:else}
                  {m.home_economy_players({ n: economy.players })}
                {/if}
              </p>
            </div>
          </div>
        {:else if item.id === 'leveling'}
          {@const leveling = homeWidgets?.leveling}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_leveling_title()}</h3>
              </div>
              <button onclick={() => router.goto('/leveling')} class="text-2xs text-primary hover:underline cursor-pointer">{m.home_leaderboard()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              <div class="grid grid-cols-2 gap-2">
                <div class="px-3 py-2 rounded-lg bg-indigo-500/5 border border-indigo-500/10">
                  <p class="text-lg font-semibold text-on-surface">{leveling?.averageLevel ?? '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_avg_level()}</p>
                </div>
                <div class="px-3 py-2 rounded-lg bg-purple-500/5 border border-purple-500/10">
                  <p class="text-lg font-semibold text-on-surface">{leveling ? formatNumber(leveling.activeMembers) : '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_active_7d()}</p>
                </div>
              </div>
              <p class="text-2xs text-on-surface-variant text-center">
                {#if !leveling}
                  {m.home_leveling_hint()}
                {:else if !leveling.enabled}
                  {m.home_leveling_disabled()}
                {:else}
                  {m.home_leveling_ranked({ n: leveling.rankedMembers })}
                {/if}
              </p>
            </div>
          </div>
        {:else if item.id === 'tickets'}
          {@const tickets = homeWidgets?.tickets}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">Tickets</h3>
              </div>
              <button onclick={() => router.goto('/tickets')} class="text-2xs text-primary hover:underline cursor-pointer">{m.home_see_everything()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              <div class="grid grid-cols-3 gap-2">
                <div class="px-2 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10 text-center">
                  <p class="text-lg font-semibold text-on-surface">{tickets ? formatNumber(tickets.open) : '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_open_tickets()}</p>
                </div>
                <div class="px-2 py-2 rounded-lg bg-warning/5 border border-warning/10 text-center">
                  <p class="text-lg font-semibold text-on-surface">{tickets ? formatNumber(tickets.claimed) : '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_in_progress()}</p>
                </div>
                <div class="px-2 py-2 rounded-lg bg-success/5 border border-success/10 text-center">
                  <p class="text-lg font-semibold text-on-surface">{tickets ? formatNumber(tickets.closedRecently) : '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_closed_7d()}</p>
                </div>
              </div>
            </div>
          </div>
        {:else if item.id === 'invites'}
          {@const invites = homeWidgets?.invites}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_invites_title()}</h3>
              </div>
              <button onclick={() => router.goto('/invitations')} class="text-2xs text-primary hover:underline cursor-pointer">{m.home_details()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col justify-center">
              <div class="grid grid-cols-2 gap-2">
                <div class="px-3 py-2 rounded-lg bg-teal-500/5 border border-teal-500/10">
                  <p class="text-lg font-semibold text-on-surface">{invites ? formatNumber(invites.activeCodes) : '-'}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_active_invites()}</p>
                </div>
                <div class="px-3 py-2 rounded-lg bg-success/5 border border-success/10">
                  <p class="text-lg font-semibold text-on-surface">{invites?.retentionPercent == null ? '-' : `${invites.retentionPercent}%`}</p>
                  <p class="text-2xs text-on-surface-variant">{m.home_retention()}</p>
                </div>
              </div>
              <p class="text-2xs text-on-surface-variant text-center">
                {#if invites}
                  {m.home_invites_joined({ n: invites.joinedRecently })}
                {:else}
                  {m.home_invites_hint()}
                {/if}
              </p>
            </div>
          </div>
        {:else if item.id === 'events'}
          {@const upcomingEvents = homeWidgets?.events?.upcoming ?? []}
          {@const maxEvents = displayRowSpan(item) >= 2 ? 5 : 3}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_events_title()}</h3>
              </div>
              <button onclick={() => router.goto('/events')} class="text-2xs text-primary hover:underline cursor-pointer">{m.home_see_everything()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col {upcomingEvents.length > 0 ? '' : 'justify-center'}">
              {#if upcomingEvents.length === 0}
                <div class="flex flex-col items-center justify-center py-4 text-center text-on-surface-variant">
                  <Papicon icon="calendar" size={18} class="mb-1 text-error/50" />
                  <p class="text-2xs">{m.home_no_upcoming_events()}</p>
                  <p class="text-2xs mt-0.5">{m.home_create_event_hint()}</p>
                </div>
              {:else}
                {#each upcomingEvents.slice(0, maxEvents) as evt (evt.id)}
                  <button
                    onclick={() => router.goto('/events')}
                    class="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-error/5 border border-error/10 hover:border-error/30 transition-colors text-left cursor-pointer"
                  >
                    <div class="min-w-0">
                      <p class="text-xs font-medium text-on-surface truncate">{evt.title}</p>
                      <p class="text-2xs text-on-surface-variant">
                        {evt.startsAt ? formatEventDate(evt.startsAt) : evt.type}
                      </p>
                    </div>
                    <span class="text-2xs font-medium uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 {evt.status === 'ONGOING' ? 'bg-success/10 text-success' : 'bg-blue-500/10 text-blue-400'}">
                      {evt.status === 'ONGOING' ? m.ev_status_ongoing() : m.ev_status_published()}
                    </span>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {:else if item.id === 'polls'}
          {@const openPolls = homeWidgets?.polls?.open ?? []}
          {@const maxPolls = displayRowSpan(item) >= 2 ? 5 : 3}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_polls_title()}</h3>
              </div>
              <button onclick={() => router.goto('/staff-management/polls')} class="text-2xs text-primary hover:underline cursor-pointer">{m.home_see_everything()}</button>
            </div>
            <div class="space-y-2 grow flex flex-col {openPolls.length > 0 ? '' : 'justify-center'}">
              {#if openPolls.length === 0}
                <div class="flex flex-col items-center justify-center py-4 text-center text-on-surface-variant">
                  <Papicon icon="bar-chart" size={18} class="mb-1 text-violet-500/50" />
                  <p class="text-2xs">{m.home_no_active_polls()}</p>
                  <p class="text-2xs mt-0.5">{m.home_polls_hint()}</p>
                </div>
              {:else}
                {#each openPolls.slice(0, maxPolls) as poll (poll.id)}
                  <div class="px-2.5 py-2 rounded-lg bg-violet-500/5 border border-violet-500/10">
                    <p class="text-xs font-medium text-on-surface truncate">{poll.title}</p>
                    <p class="text-2xs text-on-surface-variant">
                      {m.home_poll_votes({ n: poll.voteCount })}{poll.closesAt ? ` · ${m.home_poll_closes({ date: formatEventDate(poll.closesAt) })}` : ''}
                    </p>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {:else if item.id === 'staffServer'}
          <div class="flex flex-col h-full justify-between">
            <div class="flex items-center justify-between mb-3 shrink-0">
              <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-medium text-on-surface">{m.home_mod_staffserver_title()}</h3>
              </div>
              <button onclick={() => router.goto('/staff-server')} class="text-2xs text-primary hover:underline cursor-pointer">{m.home_manage()}</button>
            </div>
            {#if staffServerLinks.length > 0}
              {@const link = staffServerLinks[0]}
              <div class="space-y-2 grow flex flex-col justify-center">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full {link.enabled ? 'bg-emerald-400' : 'bg-red-400'}"></span>
                  <p class="text-sm font-medium text-on-surface truncate">{link.otherGuildName}</p>
                  <span class="text-xs font-medium px-1 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">
                    {link.isMain ? 'Staff' : m.home_main_label()}
                  </span>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/10">
                    <p class="text-xs font-semibold text-on-surface">{SYNC_MODE_LABELS[link.syncMode] ?? link.syncMode}</p>
                    <p class="text-2xs text-on-surface-variant">{m.home_sync_mode()}</p>
                  </div>
                  <div class="px-3 py-2 rounded-lg bg-success/5 border border-success/10">
                    <p class="text-lg font-semibold text-on-surface">{link.roleMappings?.length ?? 0}</p>
                    <p class="text-2xs text-on-surface-variant">{m.home_mapped_roles()}</p>
                  </div>
                </div>
                <p class="text-2xs text-on-surface-variant text-center">
                  {link.enabled ? m.home_link_active() : m.home_link_disabled()}
                </p>
              </div>
            {:else}
              <div class="space-y-2 grow flex flex-col justify-center">
                <div class="flex flex-col items-center justify-center py-4 text-center text-on-surface-variant">
                  <Papicon icon="shield" size={18} class="mb-1 text-blue-500/50" />
                  <p class="text-2xs">{m.home_no_staff_server()}</p>
                  <p class="text-2xs mt-0.5">{m.home_link_staff_hint()}</p>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Barre d'edition : visible seulement pendant la personnalisation, et
       collee au bas de l'ecran pour qu'Enregistrer reste a portee pendant
       qu'on parcourt la grille. Hors edition, l'entree est le bouton
       « Personnaliser » de l'en-tete : l'ancien rond flottant recouvrait les
       blocs. Centree sur ordinateur : en bas a droite, les toasts (« Bloc
       ajoute ») la recouvraient. Le positionnement mobile vit dans app.css
       (.home-floating-actions). -->
  {#if isEditing}
    <div
      class="home-floating-actions fixed bottom-6 right-6 md:right-auto md:left-1/2 md:-translate-x-1/2 z-40 flex items-center gap-1.5 p-1.5 rounded-xl bg-surface-container-high border border-outline-variant shadow-lg"
      role="toolbar"
      aria-label={m.home_edit_title()}
    >
      {#if $isMobile}
        <!-- Sur telephone, la barre doit tenir sur une ligne au-dessus des onglets. -->
        <Button size="sm" variant="secondary" icon="add" aria-label={m.home_add_module()} onclick={() => (showAddModuleModal = true)} />
      {:else}
        <Button size="sm" variant="secondary" icon="add" onclick={() => (showAddModuleModal = true)}>{m.home_add_module()}</Button>
      {/if}
      <Menu items={editMenu} label={m.home_edit_more()} />
      <Button size="sm" variant="ghost" onclick={cancelEditing}>{m.common_cancel()}</Button>
      <Button size="sm" variant="primary" onclick={saveLayout}>{m.common_save()}</Button>
    </div>
  {/if}

  <!-- Add Module Modal -->
  {#if showAddModuleModal}
    <div class="modal-backdrop" onclick={() => showAddModuleModal = false} role="button" tabindex="-1" onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) showAddModuleModal = false; }}>
      <div class="modal-panel modal-panel-lg" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
        <div class="flex items-center justify-between border-b border-outline-variant pb-3 mb-4">
          <h2 class="text-base font-semibold text-on-surface flex items-center gap-2">
            <Papicon icon="plus-circle" size={18} class="text-primary" /> {m.home_module_library()}
          </h2>
          <button
            onclick={() => showAddModuleModal = false}
            class="p-1 rounded-full text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer"
          >
            <Papicon icon="close" size={16} />
          </button>
        </div>

        <p class="text-xs text-on-surface-variant mb-4">
          {m.home_library_hint()}
        </p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
          {#each availableCatalog as mod}
            {@const isVisible = userLayout.find(item => item.id === mod.id)?.visible}
            <div class="p-4 rounded-xl border border-outline-variant bg-surface-container-lowest hover:border-primary/40 transition-all flex flex-col justify-between gap-3 {isVisible ? 'opacity-65' : ''}">
              <div>
                <div class="flex items-center gap-2.5 mb-1.5">
                  <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                    <Papicon icon={mod.icon} size={16} />
                  </div>
                  <h4 class="font-medium text-xs text-on-surface">{mod.title}</h4>
                </div>
                <p class="text-2xs text-on-surface-variant leading-normal">{mod.desc}</p>
              </div>
              
              <div class="flex justify-end pt-1">
                {#if isVisible}
                  <span class="inline-flex items-center gap-1 text-2xs text-success font-medium bg-success/10 px-2 py-1 rounded">
                    <Papicon icon="check" size={10} /> {m.home_already_visible()}
                  </span>
                {:else}
                  <button
                    onclick={() => { addModule(mod.id); showAddModuleModal = false; }}
                    class="px-2.5 py-1 bg-primary text-white text-2xs font-medium rounded hover:bg-primary-container hover:text-on-primary-container transition-colors cursor-pointer"
                  >
                    {m.common_add()}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <!-- Reset Confirmation Modal -->
  {#if showResetConfirm}
    <div class="modal-backdrop" onclick={() => showResetConfirm = false} role="button" tabindex="-1" onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) showResetConfirm = false; }}>
      <div class="modal-panel max-w-sm" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
        <h3 class="font-semibold text-base text-on-surface mb-2">{m.home_reset_layout_q()}</h3>
        <p class="text-sm text-on-surface-variant leading-normal mb-5">
          {m.home_reset_layout_warn()}
        </p>
        <div class="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onclick={() => (showResetConfirm = false)}>{m.common_cancel()}</Button>
          <Button size="sm" variant="danger" onclick={resetLayout}>{m.home_edit_reset()}</Button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Presets Modal -->
  {#if showPresetsModal}
    <div class="modal-backdrop" onclick={() => showPresetsModal = false} role="button" tabindex="-1" onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) showPresetsModal = false; }}>
      <div class="modal-panel modal-panel-lg" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
        <div class="flex items-center justify-between border-b border-outline-variant pb-3 mb-4">
          <h2 class="text-base font-semibold text-on-surface flex items-center gap-2">
            <Papicon icon="layers" size={18} class="text-primary" /> {m.home_layout_presets()}
          </h2>
          <button
            onclick={() => showPresetsModal = false}
            class="p-1 rounded-full text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer"
          >
            <Papicon icon="close" size={16} />
          </button>
        </div>

        <!-- Save current layout as preset -->
        <div class="p-4 rounded-xl border border-outline-variant bg-surface-container-lowest mb-4">
          <h3 class="text-xs font-medium text-on-surface mb-3 flex items-center gap-2">
            <Papicon icon="save" size={14} class="text-primary" /> {m.home_save_current_layout()}
          </h3>
          <div class="flex gap-2">
            <input
              type="text"
              bind:value={presetName}
              placeholder={m.home_preset_name_ph()}
              class="grow px-3 py-2 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none focus:border-primary/50 text-on-surface"
            />
            <input
              type="text"
              bind:value={presetDescription}
              placeholder={m.home_preset_desc_ph()}
              class="grow px-3 py-2 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none focus:border-primary/50 text-on-surface"
            />
            <button
              onclick={saveAsPreset}
              class="px-4 py-2 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary/90 transition-colors cursor-pointer shrink-0"
            >
              {m.common_save()}
            </button>
          </div>
        </div>

        <!-- Import section -->
        <div class="p-4 rounded-xl border border-outline-variant bg-surface-container-lowest mb-4">
          <h3 class="text-xs font-medium text-on-surface mb-3 flex items-center gap-2">
            <Papicon icon="upload" size={14} class="text-secondary" /> {m.home_import_preset_json()}
          </h3>
          <div class="flex gap-2">
            <textarea
              bind:value={presetImportJson}
              placeholder={m.home_paste_json_ph() + ' {"name": "...", "layout": [...]}'}
              class="grow px-3 py-2 text-xs bg-surface-container border border-outline-variant rounded-lg outline-none focus:border-primary/50 text-on-surface min-h-[60px] resize-none"
            ></textarea>
            <button
              onclick={importPresetFromJson}
              class="px-4 py-2 bg-secondary text-white text-xs font-medium rounded-lg hover:bg-secondary/90 transition-colors cursor-pointer shrink-0 self-end"
            >
              {m.common_import()}
            </button>
          </div>
        </div>

        <!-- Saved presets list -->
        <h3 class="text-xs font-medium text-on-surface mb-3 flex items-center gap-2">
          <Papicon icon="list" size={14} class="text-on-surface-variant" /> {m.home_my_presets()}
        </h3>
        <div class="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
          {#if loadingPresets}
            {#each Array(3) as _}
              <div class="h-16 animate-pulse bg-surface-container-high rounded-xl"></div>
            {/each}
          {:else if presets.length > 0}
            {#each presets as preset}
              <div class="p-3 rounded-xl border border-outline-variant bg-surface-container-lowest hover:border-primary/30 transition-colors flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <h4 class="text-xs font-medium text-on-surface truncate">{preset.name}</h4>
                  {#if preset.description}
                    <p class="text-2xs text-on-surface-variant truncate mt-0.5">{preset.description}</p>
                  {/if}
                  <p class="text-2xs text-on-surface-variant/60 mt-0.5">
                    {Array.isArray(preset.layout) ? preset.layout.length : '?'} modules · {new Date(preset.createdAt).toLocaleDateString(dateLocale())}
                  </p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button
                    onclick={() => applyPreset(preset.id)}
                    title={m.us_apply()}
                    class="p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                  >
                    <Papicon icon="check" size={12} />
                  </button>
                  <button
                    onclick={() => sharePreset(preset.id)}
                    title={m.home_share_link()}
                    class="p-1.5 rounded-md bg-surface-container text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer"
                  >
                    <Papicon icon="share-2" size={12} />
                  </button>
                  <button
                    onclick={() => exportPreset(preset)}
                    title={m.home_export_json()}
                    class="p-1.5 rounded-md bg-surface-container text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer"
                  >
                    <Papicon icon="download" size={12} />
                  </button>
                  <button
                    onclick={() => removePreset(preset.id)}
                    title={m.common_delete()}
                    class="p-1.5 rounded-md text-error hover:bg-error/10 transition-colors cursor-pointer"
                  >
                    <Papicon icon="trash" size={12} />
                  </button>
                </div>
              </div>
            {/each}
          {:else}
            <div class="flex flex-col items-center justify-center py-8 text-on-surface-variant">
              <Papicon icon="layers" size={24} class="mb-2" />
              <p class="text-xs">{m.home_no_presets()}</p>
              <p class="text-2xs mt-0.5">{m.home_no_presets_hint()}</p>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
