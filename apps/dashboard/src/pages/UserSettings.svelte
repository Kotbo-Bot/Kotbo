<script lang="ts">
  import NotificationPreferencesGrid from '../lib/components/NotificationPreferencesGrid.svelte';
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { Tabs, Button, SectionCard, SettingsRow } from '../lib/components/ui';
  import ProfileWidgetPanel from '../lib/components/ProfileWidgetPanel.svelte';
  import { userPrefs } from '../lib/stores/userPreferences.svelte';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import { listSupportedTimezones } from '@kotbo/contracts';
  import { themeStore, THEME_PRESETS, ACCENT_COLORS, type ThemeId, type CustomThemeColors, type AccentColorId } from '../lib/stores/theme.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import { m } from '../lib/i18n';
  import { desktopPermission, requestDesktopPermission, sendTestNotification } from '../lib/notificationAlerts';
  import { playNotificationSound, type NotificationTone } from '../lib/notificationSounds';

  import type { DateFormat, Language, SidebarBehavior } from '../lib/stores/userPreferences.svelte';

  const SETTINGS_BASE = '/userSettings';
  const settingsTabs = ['preferences', 'widget'] as const;
  let activeTab = $state<string>('preferences');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl(SETTINGS_BASE, settingsTabs, 'preferences');
  });

  const tabs = $derived([
    { id: 'preferences', label: m.us_tab_preferences(), icon: 'Gears' },
    { id: 'widget', label: m.us_tab_widget(), icon: 'Layout' },
  ]);

  let savedFeedback = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let importInput = $state<HTMLInputElement | null>(null);

  function showSavedFeedback() {
    savedFeedback = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      savedFeedback = false;
    }, 2000);
  }

  const customColors = $state<CustomThemeColors>({ ...themeStore.customColors });
  let showCustomEditor = $state(false);

  function handleToggle<K extends keyof typeof userPrefs.prefs>(key: K, value: (typeof userPrefs.prefs)[K]) {
    userPrefs.set(key, value);
    if (key === 'theme') {
      themeStore.themeId = value as ThemeId;
      showCustomEditor = value === 'custom';
    }
    showSavedFeedback();
  }

  function applyCustomTheme() {
    themeStore.setCustomColors(customColors);
    themeStore.themeId = 'custom';
    userPrefs.set('theme', 'custom');
    showSavedFeedback();
  }

  function exportPreferences() {
    const payload = JSON.stringify(userPrefs.prefs, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kotbo-user-preferences.json';
    link.click();
    URL.revokeObjectURL(url);
    toast.success(m.us_export_started());
  }

  function openImportDialog() {
    importInput?.click();
  }

  async function handleImportFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    try {
      const raw = await file.text();
      const imported = JSON.parse(raw) as Partial<typeof userPrefs.prefs>;
      const allowedKeys = Object.keys(userPrefs.prefs) as Array<keyof typeof userPrefs.prefs>;

      for (const key of allowedKeys) {
        if (key in imported) {
          userPrefs.set(key, imported[key] as never);
        }
      }

      toast.success(m.us_import_success());
      showSavedFeedback();
    } catch {
      toast.error(m.us_import_invalid());
    } finally {
      input.value = '';
    }
  }

  async function testNotifications() {
    const permission = await sendTestNotification();
    permissionState = permission;
    if (permission === 'unsupported') {
      toast.warning(m.us_notif_unavailable());
    } else if (permission !== 'granted') {
      toast.error(m.us_notif_denied());
    } else {
      toast.success(m.us_notif_preview_sent());
    }
  }

  let permissionState = $state(desktopPermission());

  /**
   * Activer les notifications bureau sans la permission du navigateur
   * laisserait un interrupteur allumé qui ne fait rien : on la demande au
   * moment du clic, seul moment où le navigateur accepte d'afficher la demande.
   */
  async function handleNotificationToggle(key: 'soundNotifications' | 'desktopNotifications', value: boolean) {
    if (key === 'desktopNotifications' && value) {
      const permission = await requestDesktopPermission();
      permissionState = permission;
      if (permission === 'unsupported') {
        toast.warning(m.us_notif_unavailable());
        return;
      }
      if (permission !== 'granted') {
        toast.error(m.us_notif_denied());
        return;
      }
    }
    handleToggle(key, value);
    // Retour immédiat : sans lui, activer le son ne produit rien d'audible.
    if (key === 'soundNotifications' && value) playNotificationSound('INFO', { force: true });
  }

  const soundPreviews = $derived<{ tone: NotificationTone; label: string }[]>([
    { tone: 'INFO', label: m.us_sound_type_info() },
    { tone: 'SUCCESS', label: m.us_sound_type_success() },
    { tone: 'WARNING', label: m.us_sound_type_warning() },
    { tone: 'ERROR', label: m.us_sound_type_error() },
  ]);

  const accentColors: { id: AccentColorId; label: string; hex: string }[] = [
    { id: 'violet', get label() { return m.us_color_violet(); }, hex: ACCENT_COLORS.violet.hex },
    { id: 'blue',   get label() { return m.us_color_blue(); },   hex: ACCENT_COLORS.blue.hex },
    { id: 'green',  get label() { return m.us_color_green(); },  hex: ACCENT_COLORS.green.hex },
    { id: 'rose',   get label() { return m.us_color_rose(); },   hex: ACCENT_COLORS.rose.hex },
    { id: 'orange', get label() { return m.us_color_orange(); }, hex: ACCENT_COLORS.orange.hex },
    { id: 'cyan',   get label() { return m.us_color_cyan(); },   hex: ACCENT_COLORS.cyan.hex },
  ];

  const languages: { id: Language; label: string; code: string }[] = [
    { id: 'fr', get label() { return m.settings_language_fr(); }, code: 'FR' },
    { id: 'en', get label() { return m.settings_language_en(); }, code: 'EN' },
  ];

  const dateFormats: { id: DateFormat; label: string; example: string }[] = [
    { id: 'relative', get label() { return m.us_datefmt_relative(); }, get example() { return m.us_datefmt_relative_ex(); } },
    { id: 'absolute', get label() { return m.us_datefmt_absolute(); }, get example() { return m.us_datefmt_absolute_ex(); } },
    { id: 'both',     get label() { return m.us_datefmt_both(); },     get example() { return m.us_datefmt_both_ex(); } },
  ];

  /**
   * Fuseau de lecture des statistiques. `auto` suit le navigateur, ce qui est
   * déjà correct pour la plupart des lecteurs ; le choix explicite sert à qui
   * pilote un serveur depuis un autre fuseau que celui où il vit.
   */
  const timezoneChoice = $derived(userPrefs.prefs.timezone ?? 'auto');
  const timezoneZones = $derived(listSupportedTimezones(timezoneStore.displayTimezone));

  function handleTimezone(value: string) {
    userPrefs.set('timezone', value === 'auto' ? 'auto' : value);
    showSavedFeedback();
  }

  const sidebarBehaviors: { id: SidebarBehavior; label: string; desc: string }[] = [
    { id: 'auto',          get label() { return m.us_sidebar_auto(); },   get desc() { return m.us_sidebar_auto_desc(); } },
    { id: 'always-open',   get label() { return m.us_sidebar_open(); },   get desc() { return m.us_sidebar_open_desc(); } },
    { id: 'always-closed', get label() { return m.us_sidebar_closed(); }, get desc() { return m.us_sidebar_closed_desc(); } },
  ];
</script>

<div class="space-y-6 pb-12">

  <header class="flex flex-col md:flex-row md:items-end justify-between gap-x-6 gap-y-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight text-on-surface font-headline leading-tight">{m.us_title()}</h1>
      <p class="mt-1 max-w-prose text-sm text-on-surface-variant">
        {m.us_subtitle()}
        {#if authStore.user?.username}
          · <span class="font-medium text-on-surface">{authStore.user.username}</span>
        {/if}
      </p>
    </div>

    <!-- Les préférences s'enregistrent seules : une ligne discrète le dit,
         et confirme chaque enregistrement, sans prendre la place d'un bouton. -->
    {#if activeTab === 'preferences'}
      <p class="flex shrink-0 items-center gap-1.5 text-xs {savedFeedback ? 'text-success font-medium' : 'text-on-surface-variant'}" aria-live="polite">
        {#if savedFeedback}
          <Papicon icon="check" size={14} />
          {m.us_saved_auto()}
        {:else}
          {m.us_autosave()}
        {/if}
      </p>
    {/if}
  </header>

  <div class="flex flex-wrap items-center justify-between gap-3">
    <Tabs
      label={m.nav_user_settings()}
      {tabs}
      active={activeTab}
      onchange={(id) => gotoTab(SETTINGS_BASE, id, 'preferences')}
    />

    {#if activeTab === 'preferences'}
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" icon="upload" onclick={openImportDialog}>
          {m.common_import()}
        </Button>
        <Button variant="secondary" size="sm" icon="download" onclick={exportPreferences}>
          {m.common_export()}
        </Button>
        <Button variant="secondary" size="sm" icon="Bell" onclick={testNotifications}>
          {m.us_test_notifications()}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="Keyboard"
          onclick={() => window.dispatchEvent(new CustomEvent('open-keyboard-shortcuts'))}
        >
          {m.us_keyboard_shortcuts()}
        </Button>
      </div>
    {/if}
  </div>

  <input
    bind:this={importInput}
    type="file"
    accept="application/json"
    class="hidden"
    onchange={handleImportFile}
  />

{#if activeTab === 'widget'}
  <ProfileWidgetPanel />
{:else}

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

    <!-- ─── Colonne gauche : Apparence & Navigation ──────────── -->
    <div class="space-y-6 min-w-0">
      <SectionCard title={m.us_appearance()} icon="Palette">
        <div class="space-y-6">
          <!-- Thème -->
          <div class="space-y-2.5">
            <p class="text-xs font-semibold text-on-surface-variant">{m.us_theme()}</p>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {#each THEME_PRESETS as preset (preset.id)}
                {@const selected = themeStore.themeId === preset.id}
                <button
                  type="button"
                  aria-pressed={selected}
                  onclick={() => handleToggle('theme', preset.id)}
                  class="flex flex-col items-center gap-2 p-2.5 min-h-[44px] rounded-xl border transition-colors text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
                    {selected
                      ? 'border-primary bg-primary/10 text-on-surface'
                      : 'border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-outline hover:text-on-surface'}"
                >
                  <div class="w-full h-8 rounded-lg overflow-hidden flex border border-outline-variant">
                    <div class="flex-1" style="background:{preset.preview.bg}"></div>
                    <div class="flex-1" style="background:{preset.preview.surface}"></div>
                    <div class="w-2.5" style="background:{preset.preview.text}; opacity:0.35"></div>
                  </div>
                  <span class="truncate w-full text-center">{preset.label}</span>
                </button>
              {/each}

              <button
                type="button"
                aria-pressed={themeStore.themeId === 'custom'}
                onclick={() => { handleToggle('theme', 'custom'); showCustomEditor = true; }}
                class="flex flex-col items-center gap-2 p-2.5 min-h-[44px] rounded-xl border transition-colors text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
                  {themeStore.themeId === 'custom'
                    ? 'border-primary bg-primary/10 text-on-surface'
                    : 'border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-outline hover:text-on-surface'}"
              >
                <div class="w-full h-8 rounded-lg overflow-hidden flex items-center justify-center border border-dashed border-outline bg-surface-container">
                  <Papicon icon="Palette" size={16} />
                </div>
                <span>Custom</span>
              </button>
            </div>
          </div>

          <!-- Éditeur de thème personnalisé -->
          {#if themeStore.themeId === 'custom' || showCustomEditor}
            <div class="space-y-4 p-4 rounded-xl border border-primary/30 bg-surface-container-low">
              <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-semibold text-primary">{m.us_custom_theme()}</p>
                <button
                  type="button"
                  aria-label="Fermer"
                  onclick={() => showCustomEditor = false}
                  class="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-hover transition-colors focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <Papicon icon="x" size={14} />
                </button>
              </div>

              <div class="flex items-center gap-3 p-2.5 rounded-lg bg-surface-container-lowest border border-outline-variant">
                <span class="text-xs font-medium text-on-surface w-16 shrink-0">{m.us_mode()}</span>
                <div class="flex gap-2 flex-1">
                  <button
                    type="button"
                    aria-pressed={customColors.mode === 'dark'}
                    onclick={() => { customColors.mode = 'dark'; applyCustomTheme(); }}
                    class="flex-1 py-2 rounded-lg text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary
                      {customColors.mode === 'dark' ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'}"
                  >{m.us_dark()}</button>
                  <button
                    type="button"
                    aria-pressed={customColors.mode === 'light'}
                    onclick={() => { customColors.mode = 'light'; applyCustomTheme(); }}
                    class="flex-1 py-2 rounded-lg text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary
                      {customColors.mode === 'light' ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:text-on-surface'}"
                  >{m.us_light()}</button>
                </div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {#each [
                  { key: 'background', label: m.us_color_background() },
                  { key: 'surface', label: m.us_color_surface() },
                  { key: 'text', label: m.us_color_text() },
                  { key: 'surfaceContainer', label: m.us_color_panel() },
                ] as field (field.key)}
                  <label class="flex items-center gap-2.5 p-2.5 rounded-lg bg-surface-container-lowest border border-outline-variant cursor-pointer hover:border-outline transition-colors">
                    <input
                      type="color"
                      value={customColors[field.key as keyof CustomThemeColors] as string}
                      oninput={(e) => { customColors[field.key as keyof CustomThemeColors] = (e.currentTarget as HTMLInputElement).value as never; }}
                      class="w-7 h-7 rounded-md border border-outline-variant cursor-pointer shrink-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-none"
                    />
                    <span class="text-xs font-medium text-on-surface truncate">{field.label}</span>
                  </label>
                {/each}
              </div>
              <p class="text-2xs text-on-surface-variant">{m.us_accent_note()}</p>

              <!-- Aperçu -->
              <div class="rounded-lg overflow-hidden border border-outline-variant">
                <div class="flex h-14" style="background:{customColors.background}">
                  <div class="w-10 flex items-center justify-center" style="background:{customColors.surfaceContainer}">
                    <div class="w-4 h-4 rounded-sm bg-primary"></div>
                  </div>
                  <div class="flex-1 p-2.5 flex flex-col justify-center gap-1">
                    <div class="h-2 w-20 rounded-full" style="background:{customColors.text}; opacity:0.8"></div>
                    <div class="h-1.5 w-32 rounded-full" style="background:{customColors.text}; opacity:0.35"></div>
                  </div>
                  <div class="w-16 flex items-center justify-center">
                    <div class="h-5 w-12 rounded-md bg-primary"></div>
                  </div>
                </div>
              </div>

              <Button variant="primary" size="sm" fullWidth onclick={applyCustomTheme}>
                {m.us_apply()}
              </Button>
            </div>
          {/if}

          <!-- Couleur d'accentuation -->
          <div class="space-y-2.5">
            <p class="text-xs font-semibold text-on-surface-variant">{m.us_accent_color()}</p>
            <div class="flex flex-wrap gap-3">
              {#each accentColors as color (color.id)}
                {@const active = userPrefs.prefs.accentColor === color.id}
                <button
                  type="button"
                  aria-label={color.label}
                  aria-pressed={active}
                  title={color.label}
                  onclick={() => handleToggle('accentColor', color.id)}
                  class="relative w-11 h-11 rounded-xl transition-transform duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
                    {active ? 'ring-2 ring-offset-2 ring-offset-surface-container-lowest scale-105' : 'hover:scale-105'}"
                  style="background-color: {color.hex}; {active ? `--tw-ring-color: ${color.hex}` : ''}"
                >
                  {#if active}
                    <span class="absolute inset-0 flex items-center justify-center">
                      <Papicon icon="check" size={16} class="text-white" />
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>

          <!-- Interrupteurs d'interface -->
          <div class="divide-y divide-outline-variant border-t border-outline-variant -mx-5 -mb-5">
            <SettingsRow label={m.us_compact_mode()} description={m.us_compact_mode_desc()}>
              <ToggleSwitch
                checked={userPrefs.prefs.compactMode}
                onToggle={(v: boolean) => handleToggle('compactMode', v)}
              />
            </SettingsRow>
            <SettingsRow label={m.us_animations()} description={m.us_animations_desc()}>
              <ToggleSwitch
                checked={userPrefs.prefs.animationsEnabled}
                onToggle={(v: boolean) => handleToggle('animationsEnabled', v)}
              />
            </SettingsRow>
            <SettingsRow label={m.us_plan_crowns()} description={m.us_plan_crowns_desc()}>
              <ToggleSwitch
                checked={userPrefs.prefs.showPlanCrowns}
                onToggle={(v: boolean) => handleToggle('showPlanCrowns', v)}
              />
            </SettingsRow>
          </div>
        </div>
      </SectionCard>

      <!-- Navigation / Barre latérale -->
      <SectionCard title={m.us_navigation()} description={m.us_sidebar_behavior()} icon="Menu" flush>
        <div class="divide-y divide-outline-variant" role="radiogroup" aria-label={m.us_sidebar_behavior()}>
          {#each sidebarBehaviors as behavior (behavior.id)}
            {@const checked = userPrefs.prefs.sidebarBehavior === behavior.id}
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              onclick={() => handleToggle('sidebarBehavior', behavior.id)}
              class="w-full flex items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary
                {checked ? 'bg-surface-selection' : ''}"
            >
              <span
                class="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center
                  {checked ? 'border-primary' : 'border-outline'}"
              >
                {#if checked}
                  <span class="w-2 h-2 rounded-full bg-primary"></span>
                {/if}
              </span>
              <span class="min-w-0">
                <span class="block text-sm font-medium text-on-surface">{behavior.label}</span>
                <span class="block text-xs text-on-surface-variant mt-0.5">{behavior.desc}</span>
              </span>
            </button>
          {/each}
        </div>
      </SectionCard>
    </div>

    <!-- ─── Colonne droite : Langue & Notifications ─────────── -->
    <div class="space-y-6 min-w-0">
      <SectionCard title={m.us_language_region()} icon="Globe">
        <div class="space-y-6">
          <!-- Langue -->
          <div class="space-y-2.5">
            <p class="text-xs font-semibold text-on-surface-variant">{m.us_interface_language()}</p>
            <div class="grid grid-cols-2 gap-2.5">
              {#each languages as lang (lang.id)}
                {@const selected = userPrefs.prefs.language === lang.id}
                <button
                  type="button"
                  aria-pressed={selected}
                  onclick={() => handleToggle('language', lang.id)}
                  class="flex items-center gap-3 p-3.5 min-h-[44px] rounded-xl border transition-colors text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
                    {selected
                      ? 'border-primary bg-primary/10 text-on-surface'
                      : 'border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-outline hover:text-on-surface'}"
                >
                  <span class="px-2 py-0.5 rounded-md text-xs font-mono font-bold {selected ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant'}">
                    {lang.code}
                  </span>
                  <span class="truncate">{lang.label}</span>
                </button>
              {/each}
            </div>
          </div>

          <!-- Format des dates -->
          <div class="space-y-2.5">
            <p class="text-xs font-semibold text-on-surface-variant">{m.us_date_format()}</p>
            <div
              class="divide-y divide-outline-variant rounded-xl border border-outline-variant overflow-hidden bg-surface-container-low"
              role="radiogroup"
              aria-label={m.us_date_format()}
            >
              {#each dateFormats as fmt (fmt.id)}
                {@const checked = userPrefs.prefs.dateFormat === fmt.id}
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onclick={() => handleToggle('dateFormat', fmt.id)}
                  class="w-full flex items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary
                    {checked ? 'bg-surface-selection' : ''}"
                >
                  <span
                    class="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center
                      {checked ? 'border-primary' : 'border-outline'}"
                  >
                    {#if checked}
                      <span class="w-2 h-2 rounded-full bg-primary"></span>
                    {/if}
                  </span>
                  <span class="min-w-0">
                    <span class="block text-sm font-medium text-on-surface">{fmt.label}</span>
                    <span class="block text-xs text-on-surface-variant mt-0.5">{fmt.example}</span>
                  </span>
                </button>
              {/each}
            </div>
          </div>

          <!-- Fuseau horaire -->
          <div class="space-y-2">
            <label for="us-timezone-select" class="block text-xs font-semibold text-on-surface-variant">{m.us_timezone()}</label>
            <select
              id="us-timezone-select"
              value={timezoneChoice}
              onchange={(e) => handleTimezone((e.currentTarget as HTMLSelectElement).value)}
              class="w-full bg-surface-container-lowest border border-field-border rounded-lg px-3.5 py-2.5 text-sm text-on-surface focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 transition-colors"
            >
              <option value="auto">{m.us_timezone_auto({ zone: timezoneStore.browserTimezone })}</option>
              {#each timezoneZones as zone (zone)}
                <option value={zone}>{zone.replace(/_/g, ' ')}</option>
              {/each}
            </select>
            <p class="text-xs text-on-surface-variant">
              {m.us_timezone_desc({ zone: timezoneStore.displayTimezone })}
            </p>
          </div>
        </div>
      </SectionCard>

      <!-- Notifications & Confidentialité -->
      <SectionCard title={m.us_notif_privacy()} icon="Bell" flush>
        <div class="divide-y divide-outline-variant">
          <div class="px-4 py-3.5 space-y-3">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <p class="text-sm font-medium text-on-surface">{m.us_sound_notif()}</p>
                <p class="text-xs text-on-surface-variant mt-0.5">{m.us_sound_notif_desc()}</p>
              </div>
              <ToggleSwitch
                checked={userPrefs.prefs.soundNotifications}
                onToggle={(v: boolean) => handleNotificationToggle('soundNotifications', v)}
              />
            </div>
            {#if userPrefs.prefs.soundNotifications}
              <div class="flex flex-wrap items-center gap-1.5 pt-1">
                <span class="text-2xs text-on-surface-variant mr-1">{m.us_sound_preview()}</span>
                {#each soundPreviews as preview (preview.tone)}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="Play"
                    onclick={() => playNotificationSound(preview.tone, { force: true })}
                  >
                    {preview.label}
                  </Button>
                {/each}
              </div>
            {/if}
          </div>

          <div class="px-4 py-3.5 space-y-2">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <p class="text-sm font-medium text-on-surface">{m.us_desktop_notif()}</p>
                <p class="text-xs text-on-surface-variant mt-0.5">{m.us_desktop_notif_desc()}</p>
              </div>
              <ToggleSwitch
                checked={userPrefs.prefs.desktopNotifications && permissionState === 'granted'}
                onToggle={(v: boolean) => handleNotificationToggle('desktopNotifications', v)}
              />
            </div>
            {#if permissionState === 'denied'}
              <p class="text-xs text-warning">{m.us_notif_blocked_hint()}</p>
            {/if}
          </div>

          <NotificationPreferencesGrid />

          <SettingsRow label={m.us_online_status()} description={m.us_online_status_desc()}>
            <ToggleSwitch
              checked={userPrefs.prefs.showOnlineStatus}
              onToggle={(v: boolean) => handleToggle('showOnlineStatus', v)}
            />
          </SettingsRow>

          <div class="p-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5 bg-surface-container-low/50">
            <a
              href="https://kotbo.fr/terms"
              target="_blank"
              rel="noopener noreferrer"
              class="p-3 rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-outline transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            >
              <p class="text-sm font-medium text-on-surface">{m.us_privacy_policy()}</p>
              <p class="text-xs text-on-surface-variant mt-0.5">{m.us_privacy_policy_desc()}</p>
            </a>
            <a
              href="https://kotbo.fr/cookies"
              target="_blank"
              rel="noopener noreferrer"
              class="p-3 rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-outline transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            >
              <p class="text-sm font-medium text-on-surface">{m.us_cookies()}</p>
              <p class="text-xs text-on-surface-variant mt-0.5">{m.us_cookies_desc()}</p>
            </a>
            <a
              href="mailto:privacy@kotbo.fr?subject=Demande%20RGPD%20Kotbo"
              class="sm:col-span-2 p-3 rounded-lg border border-primary/25 bg-primary/8 hover:bg-primary/12 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            >
              <p class="text-sm font-medium text-primary">{m.us_gdpr_rights()}</p>
              <p class="text-xs text-on-surface-variant mt-0.5">{m.us_gdpr_rights_desc()}</p>
            </a>
          </div>
        </div>
      </SectionCard>
    </div>
  </div>

  <!-- ─── Zone de réinitialisation ────────────────────────── -->
  <SectionCard title={m.us_reset_zone()} description={m.us_reset_desc()} icon="AlertTriangle">
    {#snippet actions()}
      <Button
        variant="danger"
        size="sm"
        icon="refresh-cw"
        onclick={() => { userPrefs.reset(); themeStore.themeId = userPrefs.prefs.theme; showSavedFeedback(); toast.success(m.us_reset_done()); }}
      >
        {m.us_reset_button()}
      </Button>
    {/snippet}
  </SectionCard>
{/if}
</div>
