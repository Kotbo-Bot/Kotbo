<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
  import { fade } from 'svelte/transition';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmojiText from '../lib/components/EmojiText.svelte';
  import DropAnnouncementPreview from '../lib/components/DropAnnouncementPreview.svelte';
  import DropClaimRulesPanel from '../lib/components/DropClaimRulesPanel.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SimpleModeToggle from '../lib/components/SimpleModeToggle.svelte';
  import SimpleModeNotice from '../lib/components/SimpleModeNotice.svelte';
  import { createSimpleModePreference, nearestStep } from '../lib/simpleMode.svelte';
  import { ACTIVITY_DEFAULT_STEP, ACTIVITY_PRESETS, JACKPOT_PRESETS } from '../lib/dropPresets';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Field from '../lib/components/ui/Field.svelte';
  import Tabs, { type TabItem } from '../lib/components/ui/Tabs.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import { dropCountdown } from '../lib/dropCountdown';
  import { m, dateLocale } from '../lib/i18n';
  import {
    fetchDiscordChannels,
    fetchDropsData,
    fetchRpgItems,
    fetchEconomyConfig,
    updateDropGlobalSettings,
    updateModuleStatus,
    updateDropTypeSettings,
    type DropAnnouncementLabels,
    type DropConfigEntry,
    type DropHistoryEntry,
  } from '../lib/api';
  import {
    DEFAULT_DROP_GLOBAL_SETTINGS,
    DROP_ACTIVITY_DISABLED,
    DROP_ACTIVITY_MESSAGES_RANGE,
    DROP_ACTIVITY_WINDOW_MINUTES_RANGE,
    DROP_DELETE_AFTER_DISABLED,
    DROP_INTERVAL_MINUTES_RANGE,
    DROP_ITEM_POOL_MAX,
    DROP_ITEM_WEIGHT_RANGE,
    DROP_ITEM_WEIGHT_TOTAL,
    DROP_JACKPOT_CHANCE_CHOICES,
    DROP_JACKPOT_MULTIPLIER_CHOICES,
    DROP_LIFETIME_MINUTES_RANGE,
    DROP_RACE_WINNERS_RANGE,
    DROP_TYPES,
    DROP_TYPE_MODULE,
    DROP_WINDOW_MINUTES_RANGE,
    defaultDropTypeSettings,
    dropAmountRange,
    dropItemsTotalWeight,
    dropTypeBlocker,
    enabledDropModes,
    estimateWeeklyDrops,
    normalizeDropClaimRules,
    shouldAdviseActivityWait,
    type DropGlobalSettings,
    type DropOutcomes,
    type DropType,
    type DropTypeBlocker,
  } from '@kotbo/shared';

  const actionState = createAsyncActionState();
  let loading = $state(false);

  /**
   * Délais proposés pour la suppression du message d'un drop terminé.
   *
   * Une liste plutôt qu'un champ libre : la valeur range le salon, elle ne règle
   * pas l'équilibrage, et la minute près n'y change rien.
   */
  const deleteAfterChoices = $derived([
    { value: DROP_DELETE_AFTER_DISABLED, label: m.drop_delete_after_never() },
    { value: 5, label: m.drop_delete_after_minutes({ count: 5 }) },
    { value: 30, label: m.drop_delete_after_minutes({ count: 30 }) },
    { value: 60, label: m.drop_delete_after_hours({ count: 1 }) },
    { value: 360, label: m.drop_delete_after_hours({ count: 6 }) },
    { value: 1440, label: m.drop_delete_after_hours({ count: 24 }) },
  ]);

  /** Catalogue du serveur, pour choisir ce qui peut tomber. Lu une fois au chargement. */
  let availableItems = $state<Array<{ id: string; name: string; emoji: string }>>([]);
  let rpgEnabled = $state(false);

  /**
   * Ajoute ou retire un objet de la liste, sans dépasser le plafond.
   *
   * Le tableau est remplacé et non modifié en place : Svelte ne verrait pas un `push`
   * sur un tableau imbriqué dans l'état, et la ligne resterait sur son ancien état.
   *
   * Un objet ajouté prend ce qu'il reste pour atteindre cent, ou le minimum quand la
   * liste est déjà pleine : l'administrateur corrige un chiffre plutôt que d'en saisir un
   * de zéro à chaque ajout.
   */
  function toggleDropItem(itemId: string) {
    const current = configs.RPG_ITEM.items;
    if (current.some((entry) => entry.itemId === itemId)) {
      configs.RPG_ITEM.items = current.filter((entry) => entry.itemId !== itemId);
      return;
    }
    if (current.length >= DROP_ITEM_POOL_MAX) return;

    const left = DROP_ITEM_WEIGHT_TOTAL - dropItemsTotalWeight(current);
    const weight = Math.min(
      DROP_ITEM_WEIGHT_RANGE.max,
      Math.max(DROP_ITEM_WEIGHT_RANGE.min, left),
    );
    configs.RPG_ITEM.items = [...current, { itemId, weight }];
  }

  function setDropItemWeight(itemId: string, weight: number) {
    configs.RPG_ITEM.items = configs.RPG_ITEM.items.map((entry) =>
      entry.itemId === itemId ? { ...entry, weight } : entry);
  }

  /** Répartit cent points à parts égales, le reste allant aux premiers de la liste. */
  function balanceDropItems() {
    const items = configs.RPG_ITEM.items;
    if (items.length === 0) return;

    const share = Math.floor(DROP_ITEM_WEIGHT_TOTAL / items.length);
    let left = DROP_ITEM_WEIGHT_TOTAL - share * items.length;
    configs.RPG_ITEM.items = items.map((entry) => {
      const bonus = left > 0 ? 1 : 0;
      left -= bonus;
      return { ...entry, weight: Math.max(DROP_ITEM_WEIGHT_RANGE.min, share + bonus) };
    });
  }

  const itemNameById = $derived(new Map(availableItems.map((item) => [item.id, item])));

  let activeTab = $state<'global' | DropType>('global');
  // L'onglet actif retombe sur un type concret : le gabarit d'un onglet de
  // ressource ne doit jamais être instancié avec l'onglet global.
  const activeType = $derived<DropType>(activeTab === 'global' ? 'XP' : activeTab);

  // Un drop d'objet se règle en exemplaires, les autres en points : les champs de montant
  // suivent la fourchette du type affiché plutôt qu'une borne unique au million.
  const amountRange = $derived(dropAmountRange(activeType));

  /** Les trois façons de ramasser, telles qu'elles se règlent sur un type. */
  type DropModeKey = 'first' | 'race' | 'window';

  /** Fourchette de montants commune aux trois modes. */
  const AMOUNT_BOUNDS = [
    { key: 'minAmount', suffix: 'min', label: () => m.drop_mode_min_label() },
    { key: 'maxAmount', suffix: 'max', label: () => m.drop_mode_max_label() },
  ] as const;

  /** Copie avec ses règles : partagées, l'état courant et l'état enregistré bougeraient ensemble. */
  function cloneGlobalSettings(settings: DropGlobalSettings): DropGlobalSettings {
    return { ...settings, dropClaimRules: { ...settings.dropClaimRules } };
  }

  let globalSettings = $state<DropGlobalSettings>(cloneGlobalSettings(DEFAULT_DROP_GLOBAL_SETTINGS));
  let savedGlobalSettings = $state<DropGlobalSettings>(cloneGlobalSettings(DEFAULT_DROP_GLOBAL_SETTINGS));

  function blankConfig(type: DropType): DropConfigEntry {
    return { type, nextDropAt: null, ...defaultDropTypeSettings(type) };
  }

  let configs = $state<Record<DropType, DropConfigEntry>>({
    XP: blankConfig('XP'),
    RPG_XP: blankConfig('RPG_XP'),
    CLAN_POINTS: blankConfig('CLAN_POINTS'),
    COINS: blankConfig('COINS'),
    RPG_ITEM: blankConfig('RPG_ITEM'),
  });
  let savedConfigs = $state<Record<DropType, DropConfigEntry>>({
    XP: blankConfig('XP'),
    RPG_XP: blankConfig('RPG_XP'),
    CLAN_POINTS: blankConfig('CLAN_POINTS'),
    COINS: blankConfig('COINS'),
    RPG_ITEM: blankConfig('RPG_ITEM'),
  });

  const dropItemsTotal = $derived(dropItemsTotalWeight(configs.RPG_ITEM.items));
  const dropItemsBalanced = $derived(
    configs.RPG_ITEM.items.length === 0 || dropItemsTotal === DROP_ITEM_WEIGHT_TOTAL,
  );

  let recentDrops = $state<DropHistoryEntry[]>([]);
  let weeklyOutcomes = $state<Partial<Record<DropType, DropOutcomes>>>({});
  let abandonedClaims = $state(0);
  /** Gabarits de l'annonce, dans la langue du serveur. `null` tant que la route n'a pas répondu. */
  let announcement = $state<DropAnnouncementLabels | null>(null);
  let availableChannels = $state<any[]>([]);

  const availableRoles = $derived(dashboardStore.state.discordRoles || []);
  /** Module absent de la liste = actif, même lecture que ModulePage. */
  function moduleEntry(key: string) {
    return ((dashboardStore.state.modules as any[]) ?? []).find((mod) => mod.id === key);
  }

  function isModuleActive(key: string): boolean {
    const entry = moduleEntry(key);
    return !entry || entry.status === 'active';
  }

  function moduleName(key: string): string {
    return moduleEntry(key)?.name ?? key;
  }

  /**
   * État d'un type tel que le cycle le verra : « Actif » sur un type qui ne
   * publiera jamais rien (pas de salon, module éteint...) laisserait croire que
   * les drops tournent.
   */
  function typeStatus(type: DropType): 'on' | 'off' | 'blocked' {
    if (!configs[type].enabled || !globalSettings.dropsEnabled) return 'off';
    return typeBlocker(type) ? 'blocked' : 'on';
  }

  function typeBlocker(type: DropType): DropTypeBlocker | null {
    return dropTypeBlocker(type, configs[type], {
      defaultChannelId: globalSettings.dropChannelId,
      resourceModuleActive: isModuleActive(DROP_TYPE_MODULE[type]),
      rpgEnabled,
    });
  }

  /** Les mêmes textes que les avertissements de l'onglet du type. */
  function blockerMessage(type: DropType, blocker: DropTypeBlocker): string {
    if (blocker === 'MODULE_OFF') {
      return type === 'CLAN_POINTS'
        ? m.drop_clans_disabled_warning()
        : m.drop_module_disabled_warning({ module: moduleName(DROP_TYPE_MODULE[type]) });
    }
    if (blocker === 'NO_CHANNEL') return m.drop_no_channel_warning();
    if (blocker === 'NO_MODE') return m.drop_no_mode_warning();
    if (blocker === 'RPG_OFF') return m.drop_item_pool_rpg_off();
    return m.drop_item_pool_empty();
  }

  /**
   * Seul zéro éteint l'attente d'activité. Un champ vidé pendant la saisie vaut `null` :
   * le traiter comme éteint ferait disparaître le champ sous le curseur.
   */
  function activityOn(type: DropType): boolean {
    return configs[type].activity.minMessages !== DROP_ACTIVITY_DISABLED;
  }

  const ACTIVITY_LABELS = [
    m.drop_activity_step_1, m.drop_activity_step_2, m.drop_activity_step_3,
    m.drop_activity_step_4, m.drop_activity_step_5,
  ];
  const activityMode = createSimpleModePreference('kotbo_drops_activity_mode');

  function activityFitsSimpleMode(type: DropType): boolean {
    // Éteinte, ses valeurs ne s'affichent pas : elles n'ont pas à coller.
    if (!activityOn(type)) return true;
    const { minMessages, windowMinutes } = configs[type].activity;
    return ACTIVITY_PRESETS.some((preset) =>
      preset.minMessages === minMessages && preset.windowMinutes === windowMinutes);
  }

  function activityStep(type: DropType): number {
    return nearestStep(
      ACTIVITY_PRESETS.map((preset) => preset.minMessages),
      configs[type].activity.minMessages || ACTIVITY_PRESETS[ACTIVITY_DEFAULT_STEP - 1].minMessages,
    );
  }

  function applyActivityStep(type: DropType, step: number) {
    const preset = ACTIVITY_PRESETS[Math.min(ACTIVITY_PRESETS.length, Math.max(1, step)) - 1];
    configs[type].activity = { ...preset };
  }

  const JACKPOT_LABELS = [m.drop_jackpot_step_1, m.drop_jackpot_step_2, m.drop_jackpot_step_3];
  const jackpotMode = createSimpleModePreference('kotbo_drops_jackpot_mode');

  function jackpotFitsSimpleMode(): boolean {
    if (!globalSettings.dropJackpotEnabled) return true;
    return JACKPOT_PRESETS.some((preset) =>
      preset.chance === globalSettings.dropJackpotChance && preset.multiplier === globalSettings.dropJackpotMultiplier);
  }

  const jackpotStep = $derived(nearestStep(
    JACKPOT_PRESETS.map((preset) => preset.chance),
    globalSettings.dropJackpotChance,
  ));

  function applyJackpotStep(step: number) {
    const preset = JACKPOT_PRESETS[Math.min(JACKPOT_PRESETS.length, Math.max(1, step)) - 1];
    globalSettings.dropJackpotChance = preset.chance;
    globalSettings.dropJackpotMultiplier = preset.multiplier;
  }

  /**
   * Bilan qui justifie le conseil d'attente d'activité, ou `null`. Lu sur le formulaire et
   * non sur l'enregistré : allumer l'option fait disparaître le conseil aussitôt.
   */
  function unclaimedAdvice(type: DropType): DropOutcomes | null {
    const outcomes = weeklyOutcomes[type];
    if (!outcomes || typeStatus(type) !== 'on') return null;
    return shouldAdviseActivityWait(outcomes, configs[type].activity) ? outcomes : null;
  }

  /** Allume l'attente au cran par défaut et ouvre l'onglet : il ne reste qu'à enregistrer. */
  function followUnclaimedAdvice(type: DropType) {
    applyActivityStep(type, ACTIVITY_DEFAULT_STEP);
    activeTab = type;
  }

  /** Pièce la plus probable de la liste, pour l'aperçu d'un drop d'objet. */
  function likeliestItemLabel(): string | null {
    const [top] = [...configs.RPG_ITEM.items].sort((a, b) => b.weight - a.weight);
    const item = top ? itemNameById.get(top.itemId) : null;
    return item ? `${item.emoji} ${item.name}` : null;
  }

  const mentionRoleName = $derived(
    availableRoles.find((role: { id: string; name: string }) => role.id === globalSettings.dropMentionRoleId)?.name ?? null,
  );

  function formatEstimate(value: number): string {
    return Math.round(value).toLocaleString(dateLocale());
  }

  /** Historique replié sur les plus récents : la liste complète double la hauteur de l'onglet. */
  const HISTORY_PREVIEW = 5;
  let historyExpanded = $state(false);

  /**
   * Heure courante du panneau d'état, avancée toutes les 30 secondes : le compte à
   * rebours du prochain drop ne reste pas figé tant que la page est ouverte.
   */
  let now = $state(new Date());
  const nowTicker = setInterval(() => now = new Date(), 30 * 1000);

  /** Panneau d'état ouvert sur mobile, où il ne tient pas à côté du formulaire. */
  let statusOpen = $state(false);

  /** Une échéance passée attend le prochain passage du cycle ou l'écart minimal. */
  function nextDropLabel(type: DropType): string {
    const next = configs[type].nextDropAt;
    if (typeStatus(type) !== 'on') return '-';
    // Type tout juste allumé : le cycle lui fixe une échéance au passage suivant.
    if (!next) return m.drop_next_unplanned();
    if (new Date(next) > now) return dropCountdown(new Date(next), now, dateLocale());
    // Échéance passée : avec l'attente d'activité, c'est le salon calme qui retient le drop.
    return activityOn(type) ? m.drop_next_waiting_activity() : m.drop_next_soon();
  }

  const STATUS_PILL: Record<'on' | 'off' | 'blocked', string> = {
    on: 'bg-success/10 text-success border border-success/20',
    off: 'bg-surface-container-high/60 text-on-surface-variant',
    blocked: 'bg-warning/10 text-warning border border-warning/20',
  };

  const STATUS_LABEL: Record<'on' | 'off' | 'blocked', () => string> = {
    on: () => m.drop_state_on(),
    off: () => m.drop_state_off(),
    blocked: () => m.drop_state_blocked(),
  };


  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.drops?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const TYPE_LABELS: Record<DropType, () => string> = {
    XP: () => m.drop_tab_xp(),
    RPG_XP: () => m.drop_tab_rpg_xp(),
    CLAN_POINTS: () => m.drop_tab_clan_points(),
    COINS: () => m.drop_tab_coins(),
    RPG_ITEM: () => m.drop_tab_rpg_item(),
  };

  const TYPE_DESCRIPTIONS: Record<DropType, () => string> = {
    XP: () => m.drop_type_desc_xp(),
    RPG_XP: () => m.drop_type_desc_rpg_xp(),
    CLAN_POINTS: () => m.drop_type_desc_clan_points(),
    COINS: () => m.drop_type_desc_coins(),
    RPG_ITEM: () => m.drop_type_desc_rpg_item(),
  };

  const TYPE_ICONS: Record<DropType, string> = {
    XP: 'Star',
    RPG_XP: 'Sparkles',
    CLAN_POINTS: 'Shield',
    COINS: 'Coins',
    RPG_ITEM: 'Package',
  };

  // Un type bloqué le dit dans son onglet, en toutes lettres. « Actif » n'y figure
  // pas : le panneau d'état le donne déjà, et cinq badges élargiraient la barre.
  const tabItems = $derived<TabItem[]>([
    { id: 'global', label: m.drop_tab_global(), icon: 'Gears' },
    ...DROP_TYPES.map((type) => {
      const status = typeStatus(type);
      return {
        id: type,
        label: TYPE_LABELS[type](),
        icon: TYPE_ICONS[type],
        badge: status === 'blocked' ? STATUS_LABEL[status]() : undefined,
      };
    }),
  ]);

  const MODE_LABELS: Record<string, () => string> = {
    FIRST: () => m.drop_mode_first_title(),
    RACE: () => m.drop_mode_race_title(),
    WINDOW: () => m.drop_mode_window_title(),
  };

  function channelName(channelId: string | null): string {
    if (!channelId) return m.drop_option_default_channel();
    const channel = availableChannels.find((c) => c.id === channelId);
    return channel ? `#${channel.name}` : channelId;
  }

  /** Fréquence exprimée en drops par jour : plus parlant qu'un intervalle en minutes. */
  function dropsPerDay(intervalMinutes: number): string {
    const perDay = (24 * 60) / Math.max(DROP_INTERVAL_MINUTES_RANGE.min, intervalMinutes);
    return perDay >= 10 ? String(Math.round(perDay)) : perDay.toFixed(1);
  }

  function modeSummary(config: DropConfigEntry): string {
    const modes = enabledDropModes(config);
    if (modes.length === 0) return m.drop_no_mode_short();
    return modes.map((mode) => MODE_LABELS[mode]()).join(', ');
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' });
  }

  function cloneConfig(config: DropConfigEntry): DropConfigEntry {
    return {
      ...config,
      // Copié et non partagé : l'instantané « enregistré » sert à détecter les
      // modifications, un tableau commun aux deux ne montrerait jamais d'écart.
      items: (config.items ?? []).map((entry) => ({ ...entry })),
      activity: { ...config.activity },
      first: { ...config.first },
      race: { ...config.race },
      window: { ...config.window },
    };
  }

  async function refreshData(silent = false) {
    if (!silent) loading = true;
    try {
      const res = await fetchDropsData();
      if (res) {
        const loadedGlobal: DropGlobalSettings = {
          dropsEnabled: res.dropsEnabled,
          dropChannelId: res.dropChannelId,
          dropMentionRoleId: res.dropMentionRoleId,
          dropMentionJackpotOnly: res.dropMentionJackpotOnly,
          dropLifetimeMinutes: res.dropLifetimeMinutes,
          dropDeleteAfterMinutes: res.dropDeleteAfterMinutes ?? DROP_DELETE_AFTER_DISABLED,
          dropJackpotEnabled: res.dropJackpotEnabled,
          dropJackpotChance: res.dropJackpotChance,
          dropJackpotMultiplier: res.dropJackpotMultiplier,
          dropClaimRules: normalizeDropClaimRules(res.dropClaimRules),
        };
        globalSettings = cloneGlobalSettings(loadedGlobal);
        savedGlobalSettings = cloneGlobalSettings(loadedGlobal);
        dropsLoaded = true;

        for (const type of DROP_TYPES) {
          const loaded = res.configs.find((config) => config.type === type) ?? blankConfig(type);
          configs[type] = cloneConfig(loaded);
          savedConfigs[type] = cloneConfig(loaded);
        }

        recentDrops = res.recentDrops ?? [];
        weeklyOutcomes = res.weeklyOutcomes ?? {};
        abandonedClaims = res.abandonedClaims ?? 0;
        announcement = res.announcement ?? null;

        // Au premier chargement seulement : une mise à jour en direct ne doit pas
        // basculer le mode sous les yeux de qui est en train de régler.
        if (!silent) {
          activityMode.resolve(DROP_TYPES.every(activityFitsSimpleMode));
          jackpotMode.resolve(jackpotFitsSimpleMode());
        }
      }

      // Le catalogue et l'état du RPG viennent de l'onglet Économie : sans eux, la liste
      // des objets qui peuvent tomber n'aurait rien à proposer.
      const [items, economy] = await Promise.all([fetchRpgItems(), fetchEconomyConfig()]);
      if (items?.items) {
        availableItems = items.items.map((item: any) => ({ id: item.id, name: item.name, emoji: item.emoji }));
      }
      if (economy?.config) {
        rpgEnabled = Boolean(economy.config.enabled && economy.config.rpgEnabled);
      }
    } catch (err) {
      console.error(err);
    } finally {
      if (!silent) loading = false;
    }
  }

  // Chaque type a sa propre route : seuls ceux réellement modifiés sont
  // renvoyés, une page qui republie les quatre écraserait un réglage changé
  // entre-temps depuis un autre onglet.
  async function handleSaveSettings(): Promise<boolean> {
    if (!canManageSettings) return false;

    // Un total qui ne fait pas cent se lit mal : « 1 % » n'a de sens que rapporté à un
    // ensemble qui en fait cent. Le tirage, lui, resterait proportionnel quoi qu'il arrive.
    if (!dropItemsBalanced) {
      toast.error(m.drop_item_total_error({ total: dropItemsTotal }));
      return false;
    }

    let success = false;

    await actionState.run(async () => {
      if (JSON.stringify(globalSettings) !== JSON.stringify(savedGlobalSettings)) {
        // `dropsEnabled` reste hors de l'envoi : c'est la colonne du module, que
        // seul le menu de ModulePage bascule. La renvoyer telle que chargee au
        // montage pouvait rallumer ou eteindre le module dans son dos.
        const { dropsEnabled: _moduleState, ...editable } = globalSettings;
        const res = await updateDropGlobalSettings({
          ...editable,
          dropChannelId: globalSettings.dropChannelId || null,
          dropMentionRoleId: globalSettings.dropMentionRoleId || null,
          // Champs vidés et « Aucun » relus comme règles éteintes.
          dropClaimRules: normalizeDropClaimRules(globalSettings.dropClaimRules),
        });
        if (!res) throw new Error(m.drop_save_error());
        globalSettings = cloneGlobalSettings(res);
        savedGlobalSettings = cloneGlobalSettings(res);
      }

      for (const type of DROP_TYPES) {
        if (JSON.stringify(configs[type]) === JSON.stringify(savedConfigs[type])) continue;
        const res = await updateDropTypeSettings(type, {
          enabled: configs[type].enabled,
          channelId: configs[type].channelId || null,
          intervalMinutes: configs[type].intervalMinutes,
          activity: { ...configs[type].activity },
          items: configs[type].items.map((entry) => ({ ...entry })),
          first: { ...configs[type].first },
          race: { ...configs[type].race },
          window: { ...configs[type].window },
        });
        if (!res) throw new Error(m.drop_save_error());
        configs[type] = cloneConfig(res);
        savedConfigs[type] = cloneConfig(res);
      }

      success = true;
      return true;
    }, { successMessage: m.drop_save_success() });

    return success;
  }

  $effect(() => {
    const dirty = JSON.stringify(globalSettings) !== JSON.stringify(savedGlobalSettings)
      || DROP_TYPES.some((type) => JSON.stringify(configs[type]) !== JSON.stringify(savedConfigs[type]));

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'drops',
          label: m.drop_unsaved_label(),
          onSave: () => handleSaveSettings(),
          onReset: () => {
            globalSettings = cloneGlobalSettings(savedGlobalSettings);
            for (const type of DROP_TYPES) {
              configs[type] = cloneConfig(savedConfigs[type]);
            }
          },
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('drops');
      });
    }
  });

  let unsubscribeRealtime: (() => void) | null = null;

  onMount(async () => {
    unsubscribeRealtime = subscribeRealtime({
      reasons: ['drops_updated'],
      onUpdate: () => {
        void refreshData(true);
      },
    });
    await dashboardStore.refresh();
    await refreshData();
    const channelsData = await fetchDiscordChannels().catch(() => null);
    if (channelsData) {
      availableChannels = channelsData.textChannels || [];
    }
  });

  onDestroy(() => {
    clearInterval(nowTicker);
    unsubscribeRealtime?.();
    unsavedChanges.release('drops');
  });

  // `dropsEnabled` est la colonne du module : la bascule du menu de ModulePage
  // l'ecrit avec la ligne du module. Un serveur ou les deux divergent (ligne
  // ecrite avant que la colonne ne suive) aurait un module « actif » qui ne
  // fait rien tomber, sans aucun interrupteur pour le rattraper : l'encadre le
  // dit, et la bascule de module repare.
  let dropsLoaded = $state(false);
  const dropsModuleActive = $derived(moduleEntry('drops')?.status === 'active');

  async function resumeDrops() {
    await actionState.run(async () => {
      const ok = await updateModuleStatus('drops', 'active');
      if (!ok) throw new Error(m.drop_save_error());
      globalSettings.dropsEnabled = true;
      savedGlobalSettings.dropsEnabled = true;
      return true;
    });
  }
</script>

<!-- État des drops : ce que le cycle fera de chaque type, là où on le règle. Rendu
     dans la colonne de droite sur grand écran, dans une fenêtre sur mobile. -->
{#snippet statusPanel()}
  {#if loading}
    <Skeleton height="160px" />
  {:else}
  {#if !globalSettings.dropsEnabled}
    <p class="text-xs text-warning">{m.drop_paused_title()}</p>
  {/if}
  <ul class="space-y-1">
    {#each DROP_TYPES as type (type)}
      {@const status = typeStatus(type)}
      {@const blocker = status === 'blocked' ? typeBlocker(type) : null}
      {@const advice = unclaimedAdvice(type)}
      <li>
        <button
          type="button"
          onclick={() => { activeTab = type; statusOpen = false; }}
          class="w-full text-left rounded-lg px-2.5 py-2 transition-colors cursor-pointer hover:bg-surface-container-high/40 {activeTab === type ? 'bg-primary/5' : ''}"
        >
          <span class="flex items-center justify-between gap-2">
            <span class="text-sm font-semibold inline-flex items-center gap-2 min-w-0">
              <Papicon icon={TYPE_ICONS[type]} size={14} /> <span class="truncate">{TYPE_LABELS[type]()}</span>
            </span>
            <span class="text-2xs font-semibold px-2 py-0.5 rounded-full shrink-0 {STATUS_PILL[status]}">{STATUS_LABEL[status]()}</span>
          </span>
          {#if blocker}
            <span class="block text-2xs text-warning mt-1">{blockerMessage(type, blocker)}</span>
          {:else if status === 'on'}
            <span class="block text-2xs text-on-surface-variant mt-1">
              {m.drop_status_next({ when: nextDropLabel(type) })} · {channelName(configs[type].channelId)} · {modeSummary(configs[type])}
            </span>
          {/if}
        </button>
        {#if advice}
          <div class="px-2.5 pb-1">
            <p class="text-2xs text-on-surface-variant">{m.drop_advice_unclaimed({ unclaimed: advice.unclaimed, closed: advice.closed })}</p>
            {#if canManageSettings}
              <button
                type="button"
                onclick={() => { followUnclaimedAdvice(type); statusOpen = false; }}
                class="mt-1 text-2xs font-semibold text-primary hover:underline inline-flex items-center gap-1"
              >
                <Papicon icon="ChevronRight" size={12} /> {m.drop_advice_unclaimed_action()}
              </button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {/if}
{/snippet}

<!-- Les trois modes partagent leur carte et leur fourchette de montants ; la course
     ajoute le nombre de gagnants, la fenetre sa duree, en tete de grille. -->
{#snippet modeCard(type: DropType, mode: DropModeKey, title: string, desc: string, cols: string, extra?: Snippet<[DropType]>)}
  <div class="bg-surface-container-high/20 border border-outline-variant/10 rounded-lg p-5 space-y-4">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h4 class="text-sm font-bold">{title}</h4>
        <p class="text-2xs text-on-surface-variant mt-0.5">{desc}</p>
      </div>
      <ToggleSwitch checked={configs[type][mode].enabled} onToggle={(v) => configs[type][mode].enabled = v} disabled={!canManageSettings} />
    </div>

    <div class="grid {cols} gap-4 transition-opacity {configs[type][mode].enabled ? '' : 'opacity-50'}">
      {@render extra?.(type)}
      {#each AMOUNT_BOUNDS as bound (bound.key)}
        <Field id="drop-{mode}-{bound.suffix}-{type}" label={bound.label()}>
          {#snippet children(id, describedBy)}
            <input
              {id} aria-describedby={describedBy}
              type="number"
              bind:value={configs[type][mode][bound.key]}
              min={amountRange.min}
              max={amountRange.max}
              class="input"
              disabled={!canManageSettings || !configs[type][mode].enabled}
            />
          {/snippet}
        </Field>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet raceWinnersField(type: DropType)}
  <Field id="drop-race-winners-{type}" label={m.drop_race_winners_label()}>
    {#snippet children(id, describedBy)}
      <input
        {id} aria-describedby={describedBy}
        type="number"
        bind:value={configs[type].race.winnerCount}
        min={DROP_RACE_WINNERS_RANGE.min}
        max={DROP_RACE_WINNERS_RANGE.max}
        class="input"
        disabled={!canManageSettings || !configs[type].race.enabled}
      />
    {/snippet}
  </Field>
{/snippet}

{#snippet windowDurationField(type: DropType)}
  <Field id="drop-window-duration-{type}" label={m.drop_window_duration_label()} hint={m.drop_min_open_hint()}>
    {#snippet children(id, describedBy)}
      <input
        {id} aria-describedby={describedBy}
        type="number"
        bind:value={configs[type].window.durationMinutes}
        min={DROP_WINDOW_MINUTES_RANGE.min}
        max={DROP_WINDOW_MINUTES_RANGE.max}
        class="input"
        disabled={!canManageSettings || !configs[type].window.enabled}
      />
    {/snippet}
  </Field>
{/snippet}

<ModulePage
  title={m.drop_page_title()}
  description={m.drop_page_desc()}
  icon="ArrowDownBox"
  featureKey="drops"
>
  <InlineFeedback state={actionState} />

  {#if abandonedClaims > 0}
    <Callout variant="warning" title={m.drop_abandoned_claims_title({ count: abandonedClaims })}>
      {m.drop_abandoned_claims_desc()}
    </Callout>
  {/if}

  {#if dropsLoaded && dropsModuleActive && !globalSettings.dropsEnabled}
    <Callout variant="warning" title={m.drop_paused_title()}>
      {m.drop_paused_desc()}
      {#snippet actions()}
        {#if canManageSettings}
          <Button variant="primary" size="sm" icon="power" loading={actionState.state.loading} onclick={resumeDrops}>
            {m.drop_paused_action()}
          </Button>
        {/if}
      {/snippet}
    </Callout>
  {/if}

  <div class="mb-4 lg:hidden">
    <Button size="sm" icon="List" onclick={() => statusOpen = true}>{m.drop_status_title()}</Button>
  </div>
  <Modal bind:open={statusOpen} onClose={() => statusOpen = false} title={m.drop_status_title()}>
    {@render statusPanel()}
  </Modal>

  <!-- Sur grand écran, l'état des drops reste à côté du formulaire, quel que soit l'onglet. -->
  <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start lg:gap-6">
    <div class="min-w-0">
      <Tabs label={m.drop_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => activeTab = id as typeof activeTab} class="mb-6" />

      {#if loading}
        <div class="space-y-6">
          <Skeleton height="80px" />
          <Skeleton height="300px" />
        </div>
        <div class="flex justify-center mt-4">
          <LoadingHint context="config" />
        </div>
      {:else if activeTab === 'global'}
        <div class="space-y-6" transition:fade={{ duration: 150 }}>
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <div class="flex items-start justify-between gap-4 border-b border-outline-variant/15 pb-3">
              <div>
                <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Gears" size={18} /> {m.drop_global_heading()}</h3>
                <p class="text-xs text-on-surface-variant mt-1">{m.drop_global_desc()}</p>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field id="drop-default-channel" label={m.drop_default_channel_label()} hint={m.drop_default_channel_desc()}>
                {#snippet children(id)}
                  <SearchableSelect
                    {id}
                    bind:value={globalSettings.dropChannelId}
                    options={[{ id: '', name: m.drop_option_none() }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
                    placeholder={m.drop_select_channel_placeholder()}
                    disabled={!canManageSettings}
                  />
                {/snippet}
              </Field>

              <div class="space-y-1.5">
                <Field id="drop-mention-role" label={m.drop_mention_role_label()} hint={m.drop_mention_role_desc()}>
                  {#snippet children(id)}
                    <SearchableSelect
                      {id}
                      bind:value={globalSettings.dropMentionRoleId}
                      options={[{ id: '', name: m.drop_option_none() }, ...availableRoles.map((r: { id: string; name: string }) => ({ id: r.id, name: `@${r.name}` }))]}
                      placeholder={m.drop_select_role_placeholder()}
                      disabled={!canManageSettings}
                    />
                  {/snippet}
                </Field>
                {#if globalSettings.dropMentionRoleId}
                  <label class="flex items-center gap-2 pt-1 text-xs text-on-surface cursor-pointer">
                    <input
                      type="checkbox"
                      bind:checked={globalSettings.dropMentionJackpotOnly}
                      disabled={!canManageSettings}
                      class="accent-primary"
                    />
                    {m.drop_mention_jackpot_only_label()}
                  </label>
                  {#if globalSettings.dropMentionJackpotOnly && !globalSettings.dropJackpotEnabled}
                    <p class="text-2xs text-warning">{m.drop_mention_jackpot_only_off_hint()}</p>
                  {/if}
                {/if}
              </div>

              <div class="space-y-1.5">
                <Field id="drop-lifetime" label={m.drop_lifetime_label()} hint={m.drop_lifetime_desc()}>
                  {#snippet children(id, describedBy)}
                    <input
                      {id} aria-describedby={describedBy}
                      type="number"
                      bind:value={globalSettings.dropLifetimeMinutes}
                      min={DROP_LIFETIME_MINUTES_RANGE.min}
                      max={DROP_LIFETIME_MINUTES_RANGE.max}
                      class="input"
                      disabled={!canManageSettings}
                    />
                  {/snippet}
                </Field>
                <p class="text-2xs text-on-surface-variant">{m.drop_min_open_hint()}</p>
              </div>

              <Field id="drop-delete-after" label={m.drop_delete_after_label()} hint={m.drop_delete_after_desc()}>
                {#snippet children(id, describedBy)}
                  <select
                    {id} aria-describedby={describedBy}
                    bind:value={globalSettings.dropDeleteAfterMinutes}
                    class="input"
                    disabled={!canManageSettings}
                  >
                    {#each deleteAfterChoices as choice (choice.value)}
                      <option value={choice.value}>{choice.label}</option>
                    {/each}
                  </select>
                {/snippet}
              </Field>
            </div>

            <div class="border border-outline-variant/15 rounded-xl p-4 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h4 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Sparkles" size={15} /> {m.drop_jackpot_title()}</h4>
                  <p class="text-xs text-on-surface-variant mt-0.5">{m.drop_jackpot_desc()}</p>
                </div>
                <ToggleSwitch checked={globalSettings.dropJackpotEnabled} onToggle={(v) => globalSettings.dropJackpotEnabled = v} disabled={!canManageSettings} />
              </div>

              {#if globalSettings.dropJackpotEnabled}
                <div class="flex justify-end">
                  <SimpleModeToggle simple={jackpotMode.simple} onchange={(v) => jackpotMode.set(v)} />
                </div>
                {#if jackpotMode.simple}
                  <div class="space-y-2">
                    <div class="flex items-baseline justify-between gap-3">
                      <label for="drop-jackpot-step" class="field-label !mb-0">{m.drop_jackpot_step_label()}</label>
                      <span class="text-xs font-semibold text-primary">{JACKPOT_LABELS[jackpotStep - 1]()}</span>
                    </div>
                    <input
                      id="drop-jackpot-step"
                      type="range"
                      min="1"
                      max={JACKPOT_PRESETS.length}
                      step="1"
                      value={jackpotStep}
                      aria-valuetext={JACKPOT_LABELS[jackpotStep - 1]()}
                      oninput={(e) => applyJackpotStep(Number(e.currentTarget.value))}
                      class="w-full accent-primary"
                      disabled={!canManageSettings}
                    />
                    <p class="text-2xs text-primary font-semibold">
                      {m.drop_jackpot_step_value({ chance: globalSettings.dropJackpotChance, multiplier: globalSettings.dropJackpotMultiplier })}
                    </p>
                    {#if !jackpotFitsSimpleMode()}
                      <SimpleModeNotice message={m.drop_jackpot_off_grid()} />
                    {/if}
                  </div>
                {:else}
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field id="drop-jackpot-chance" label={m.drop_jackpot_chance_label()}>
                      {#snippet children(id, describedBy)}
                        <select {id} aria-describedby={describedBy} bind:value={globalSettings.dropJackpotChance} class="input" disabled={!canManageSettings}>
                          {#each DROP_JACKPOT_CHANCE_CHOICES as count (count)}
                            <option value={count}>{m.drop_jackpot_chance_option({ count })}</option>
                          {/each}
                        </select>
                      {/snippet}
                    </Field>
                    <Field id="drop-jackpot-multiplier" label={m.drop_jackpot_multiplier_label()}>
                      {#snippet children(id, describedBy)}
                        <select {id} aria-describedby={describedBy} bind:value={globalSettings.dropJackpotMultiplier} class="input" disabled={!canManageSettings}>
                          {#each DROP_JACKPOT_MULTIPLIER_CHOICES as count (count)}
                            <option value={count}>{m.drop_jackpot_multiplier_option({ count })}</option>
                          {/each}
                        </select>
                      {/snippet}
                    </Field>
                  </div>
                {/if}
                <p class="text-2xs text-on-surface-variant">{m.drop_jackpot_items_hint()}</p>
              {/if}
            </div>

            <DropClaimRulesPanel bind:rules={globalSettings.dropClaimRules} roles={availableRoles} disabled={!canManageSettings} />
          </section>


          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Clock" size={18} /> {m.drop_history_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.drop_history_desc()}</p>
            </div>

            {#if recentDrops.length === 0}
              <p class="py-8 text-center text-xs text-on-surface-variant italic">{m.drop_history_empty()}</p>
            {:else}
              <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                  <thead>
                    <tr class="text-xs font-semibold text-on-surface-variant">
                      <th class="py-2 pr-4">{m.drop_history_col_date()}</th>
                      <th class="py-2 pr-4">{m.drop_history_col_type()}</th>
                      <th class="py-2 pr-4">{m.drop_history_col_mode()}</th>
                      <th class="py-2 pr-4">{m.drop_history_col_amount()}</th>
                      <th class="py-2">{m.drop_history_col_claims()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each historyExpanded ? recentDrops : recentDrops.slice(0, HISTORY_PREVIEW) as drop (drop.id)}
                      <tr class="text-sm border-t border-outline-variant/10">
                        <td class="py-2.5 pr-4 text-on-surface-variant/80 whitespace-nowrap">{formatDate(drop.createdAt)}</td>
                        <td class="py-2.5 pr-4 font-semibold">{TYPE_LABELS[drop.type]?.() ?? drop.type}</td>
                        <td class="py-2.5 pr-4 text-on-surface-variant/80">{MODE_LABELS[drop.mode]?.() ?? drop.mode}</td>
                        <td class="py-2.5 pr-4 font-bold">
                          {#if drop.jackpot}
                            <span class="text-2xs font-bold px-2 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20 mr-1">{m.drop_history_jackpot()}</span>
                          {/if}
                          {drop.amount.toLocaleString(dateLocale())}
                          {#if drop.item}<span class="font-normal"> <EmojiText value={drop.item.emoji} /> {drop.item.name}</span>{/if}
                        </td>
                        <td class="py-2.5 text-on-surface-variant/80">
                          {drop.maxClaims > 0
                            ? `${drop.claimCount} / ${drop.maxClaims}`
                            : m.drop_history_unlimited({ count: drop.claimCount })}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              {#if recentDrops.length > HISTORY_PREVIEW}
                <div class="flex justify-center">
                  <button
                    type="button"
                    onclick={() => historyExpanded = !historyExpanded}
                    aria-expanded={historyExpanded}
                    class="text-2xs font-medium px-3 py-1.5 rounded-lg border border-outline-variant/20 hover:border-outline-variant/40 transition-all inline-flex items-center gap-1.5"
                  >
                    <Papicon icon={historyExpanded ? 'ChevronUp' : 'ChevronDown'} size={13} />
                    {historyExpanded ? m.drop_history_show_less() : m.drop_history_show_all({ count: recentDrops.length })}
                  </button>
                </div>
              {/if}
            {/if}
          </section>
        </div>
      {:else}
        {@const type = activeType}
        <div class="space-y-6" transition:fade={{ duration: 150 }}>
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
            <div class="flex items-start justify-between gap-4 border-b border-outline-variant/15 pb-3">
              <div>
                <h3 class="text-lg font-semibold flex items-center gap-2">
                  <Papicon icon={TYPE_ICONS[type]} size={18} /> {TYPE_LABELS[type]()}
                </h3>
                <p class="text-xs text-on-surface-variant mt-1">{TYPE_DESCRIPTIONS[type]()}</p>
              </div>
              <ToggleSwitch checked={configs[type].enabled} onToggle={(v) => configs[type].enabled = v} disabled={!canManageSettings} />
            </div>

            <p class="text-xs text-on-surface-variant">{m.drop_type_enable_desc()}</p>

            {#if !configs[type].channelId && !globalSettings.dropChannelId}
              <Callout variant="warning">
                {m.drop_no_channel_warning()}
              </Callout>
            {/if}

            <!-- Le cycle saute un type dont le module de la ressource est eteint, et
                 le clic le refuse : la page le dit avant l'enregistrement. -->
            {#if !isModuleActive(DROP_TYPE_MODULE[type])}
              <Callout variant="warning">
                {type === 'CLAN_POINTS'
                  ? m.drop_clans_disabled_warning()
                  : m.drop_module_disabled_warning({ module: moduleName(DROP_TYPE_MODULE[type]) })}
              </Callout>
            {/if}

            <!-- Le drop d'objet ne publie rien tant que le serveur n'a pas dit ce qu'il
                 accepte de voir tomber : le catalogue entier tire au hasard mettrait une
                 arme legendaire dans un salon par accident. -->
            {#if type === 'RPG_ITEM'}
              <div class="space-y-2 border border-outline-variant/15 rounded-xl p-4">
                <div>
                  <h4 class="text-sm font-semibold">{m.drop_item_pool_title()}</h4>
                  <p class="text-xs text-on-surface-variant mt-0.5">{m.drop_item_pool_desc()}</p>
                </div>

                {#if !rpgEnabled}
                  <Callout variant="warning">
                    {m.drop_item_pool_rpg_off()}
                  </Callout>
                {/if}

                <div class="flex flex-wrap gap-2">
                  {#each availableItems as item (item.id)}
                    {@const picked = configs[type].items.some((entry) => entry.itemId === item.id)}
                    <button
                      type="button"
                      onclick={() => toggleDropItem(item.id)}
                      disabled={(!picked && configs[type].items.length >= DROP_ITEM_POOL_MAX)}
                      use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
                      aria-pressed={picked}
                      class="px-3 py-1.5 rounded-lg border text-2xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed {picked
                        ? 'bg-primary/10 border-primary/40 text-primary'
                        : 'bg-surface-container-high/30 border-outline-variant/15 text-on-surface-variant/80 hover:border-outline-variant/40'}"
                    >
                      <EmojiText value={item.emoji} /> {item.name}
                    </button>
                  {/each}
                </div>

                {#if configs[type].items.length > 0}
                  <div class="space-y-1.5 pt-1">
                    {#each configs[type].items as entry (entry.itemId)}
                      <div class="flex items-center gap-3">
                        <span class="text-2xs flex-1 min-w-0 truncate">
                          {itemNameById.get(entry.itemId)?.emoji ?? ''}
                          {itemNameById.get(entry.itemId)?.name ?? m.drop_item_unknown()}
                        </span>
                        <input
                          type="number"
                          min={DROP_ITEM_WEIGHT_RANGE.min}
                          max={DROP_ITEM_WEIGHT_RANGE.max}
                          value={entry.weight}
                          oninput={(e) => setDropItemWeight(entry.itemId, Number((e.currentTarget as HTMLInputElement).value))}
                          disabled={!canManageSettings}
                          class="w-20 bg-surface-container-high/40 border border-outline-variant/15 rounded-lg px-3 py-1.5 text-2xs text-right focus:outline-none disabled:opacity-50"
                        />
                        <span class="text-2xs text-on-surface-variant w-4">%</span>
                      </div>
                    {/each}

                    <div class="flex items-center justify-between gap-3 pt-1">
                      <p class="text-2xs font-semibold {dropItemsBalanced ? 'text-success' : 'text-warning'}">
                        {m.drop_item_total({ total: dropItemsTotal })}
                      </p>
                      <button
                        type="button"
                        onclick={balanceDropItems}
                        use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
                        class="text-2xs font-medium px-3 py-1.5 rounded-lg border border-outline-variant/20 hover:border-outline-variant/40 transition-all disabled:opacity-40"
                      >
                        {m.drop_item_balance()}
                      </button>
                    </div>
                  </div>
                {/if}

                <p class="text-2xs text-on-surface-variant">
                  {configs[type].items.length === 0
                    ? m.drop_item_pool_empty()
                    : m.drop_item_pool_full({ max: DROP_ITEM_POOL_MAX })}
                </p>
                <p class="text-2xs text-on-surface-variant">{m.drop_item_quantity_hint()}</p>
              </div>
            {/if}

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field id="drop-channel-{type}" label={m.drop_channel_label()} hint={m.drop_channel_desc()}>
                {#snippet children(id)}
                  <SearchableSelect
                    {id}
                    bind:value={configs[type].channelId}
                    options={[{ id: '', name: m.drop_option_default_channel() }, ...availableChannels.map(c => ({ id: c.id, name: `#${c.name}` }))]}
                    placeholder={m.drop_select_channel_placeholder()}
                    disabled={!canManageSettings}
                  />
                {/snippet}
              </Field>

              <div class="space-y-1.5">
                <Field id="drop-interval-{type}" label={m.drop_interval_label()}>
                  {#snippet children(id, describedBy)}
                    <input
                      {id} aria-describedby={describedBy}
                      type="number"
                      bind:value={configs[type].intervalMinutes}
                      min={DROP_INTERVAL_MINUTES_RANGE.min}
                      max={DROP_INTERVAL_MINUTES_RANGE.max}
                      class="input"
                      disabled={!canManageSettings}
                    />
                  {/snippet}
                </Field>
                <p class="text-2xs text-primary font-semibold mt-1">{m.drop_interval_hint({ count: dropsPerDay(configs[type].intervalMinutes) })}</p>
                <p class="text-2xs text-on-surface-variant">{m.drop_interval_desc()}</p>
                <p class="text-2xs text-on-surface-variant">{m.drop_min_gap_hint()}</p>
              </div>
            </div>

            <!-- Replie par defaut : le titre resume le reglage, on n'ouvre que pour le changer. -->
            <details class="group border border-outline-variant/15 rounded-xl">
              <summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span class="text-sm font-semibold flex items-center gap-2">
                  <span class="transition-transform group-open:rotate-90"><Papicon icon="ChevronRight" size={14} /></span>
                  {m.drop_activity_title()}
                </span>
                <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {activityOn(type) ? 'bg-success/10 text-success border border-success/20' : 'bg-surface-container-high/60 text-on-surface-variant'}">
                  {activityOn(type)
                    ? m.drop_activity_summary({ messages: configs[type].activity.minMessages, minutes: configs[type].activity.windowMinutes })
                    : m.drop_activity_off()}
                </span>
              </summary>

              <div class="px-4 pb-4 space-y-4">
                <div class="flex items-center justify-between gap-4">
                  <p class="text-xs font-semibold">{m.drop_activity_toggle()}</p>
                  <ToggleSwitch
                    checked={activityOn(type)}
                    onToggle={(v) => {
                      if (v) applyActivityStep(type, ACTIVITY_DEFAULT_STEP);
                      else configs[type].activity.minMessages = DROP_ACTIVITY_DISABLED;
                    }}
                    disabled={!canManageSettings}
                  />
                </div>

                {#if activityOn(type)}
                  {@const step = activityStep(type)}
                  <div class="flex justify-end">
                    <SimpleModeToggle simple={activityMode.simple} onchange={(v) => activityMode.set(v)} />
                  </div>
                  {#if activityMode.simple}
                    <div class="space-y-2">
                      <div class="flex items-baseline justify-between gap-3">
                        <label for="drop-activity-step-{type}" class="field-label !mb-0">{m.drop_activity_step_label()}</label>
                        <span class="text-xs font-semibold text-primary">{ACTIVITY_LABELS[step - 1]()}</span>
                      </div>
                      <input
                        id="drop-activity-step-{type}"
                        type="range"
                        min="1"
                        max={ACTIVITY_PRESETS.length}
                        step="1"
                        value={step}
                        aria-valuetext={ACTIVITY_LABELS[step - 1]()}
                        oninput={(e) => applyActivityStep(type, Number(e.currentTarget.value))}
                        class="w-full accent-primary"
                        disabled={!canManageSettings}
                      />
                      <p class="text-2xs text-primary font-semibold">
                        {m.drop_activity_step_value({ messages: configs[type].activity.minMessages, minutes: configs[type].activity.windowMinutes })}
                      </p>
                      {#if !activityFitsSimpleMode(type)}
                        <SimpleModeNotice message={m.drop_activity_off_grid()} />
                      {/if}
                    </div>
                  {:else}
                    <div class="grid grid-cols-2 gap-4">
                      <Field id="drop-activity-messages-{type}" label={m.drop_activity_messages_label()}>
                        {#snippet children(id, describedBy)}
                          <input
                            {id} aria-describedby={describedBy}
                            type="number"
                            bind:value={configs[type].activity.minMessages}
                            min={DROP_ACTIVITY_MESSAGES_RANGE.min}
                            max={DROP_ACTIVITY_MESSAGES_RANGE.max}
                            class="input"
                            disabled={!canManageSettings}
                          />
                        {/snippet}
                      </Field>
                      <Field id="drop-activity-window-{type}" label={m.drop_activity_window_label()}>
                        {#snippet children(id, describedBy)}
                          <input
                            {id} aria-describedby={describedBy}
                            type="number"
                            bind:value={configs[type].activity.windowMinutes}
                            min={DROP_ACTIVITY_WINDOW_MINUTES_RANGE.min}
                            max={DROP_ACTIVITY_WINDOW_MINUTES_RANGE.max}
                            class="input"
                            disabled={!canManageSettings}
                          />
                        {/snippet}
                      </Field>
                    </div>
                  {/if}
                {/if}
                <p class="text-2xs text-on-surface-variant">{m.drop_activity_desc()}</p>
              </div>
            </details>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Tasks" size={18} /> {m.drop_modes_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.drop_modes_desc()}</p>
            </div>

            {#if enabledDropModes(configs[type]).length === 0}
              <Callout variant="warning">
                {m.drop_no_mode_warning()}
              </Callout>
            {/if}

            {@render modeCard(type, 'first', m.drop_mode_first_title(), m.drop_mode_first_desc(), 'grid-cols-2')}
            {@render modeCard(type, 'race', m.drop_mode_race_title(), m.drop_mode_race_desc(), 'grid-cols-1 sm:grid-cols-3', raceWinnersField)}
            {@render modeCard(type, 'window', m.drop_mode_window_title(), m.drop_mode_window_desc(), 'grid-cols-1 sm:grid-cols-3', windowDurationField)}
          </section>

          {#if announcement}
            {@const estimate = estimateWeeklyDrops(type, configs[type], globalSettings)}
            <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
              <div class="border-b border-outline-variant/15 pb-3">
                <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Eye" size={18} /> {m.drop_preview_heading()}</h3>
                <p class="text-xs text-on-surface-variant mt-1">{m.drop_preview_desc()}</p>
              </div>

              <DropAnnouncementPreview
                labels={announcement}
                {type}
                settings={configs[type]}
                jackpot={globalSettings}
                modeLabels={MODE_LABELS}
                itemLabel={type === 'RPG_ITEM' ? likeliestItemLabel() : null}
                {mentionRoleName}
              />

              {#if estimate}
                <div class="space-y-1 border-t border-outline-variant/10 pt-4">
                  {#if estimate.distributed > 0}
                    <p class="text-sm font-semibold">
                      {m.drop_estimate_distributed({ drops: formatEstimate(estimate.drops), total: formatEstimate(estimate.distributed), resource: TYPE_LABELS[type]() })}
                    </p>
                  {/if}
                  <!-- Un champ vidé pendant la saisie donne NaN : la ligne attend un vrai nombre. -->
                  {#if estimate.window && Number.isFinite(estimate.window.perParticipant)}
                    <p class="text-sm font-semibold">
                      {m.drop_estimate_window({ amount: formatEstimate(estimate.window.perParticipant), resource: TYPE_LABELS[type](), drops: formatEstimate(estimate.window.drops) })}
                    </p>
                  {/if}
                  <p class="text-2xs text-on-surface-variant">{m.drop_estimate_hint()}</p>
                </div>
              {/if}
            </section>
          {/if}
        </div>
      {/if}
    </div>

    <aside class="hidden lg:block sticky top-4" aria-label={m.drop_status_title()}>
      <section class="bg-surface-container-low/40 border border-outline-variant/30 p-4 rounded-xl space-y-3">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="List" size={15} /> {m.drop_status_title()}</h3>
        {@render statusPanel()}
      </section>
    </aside>
  </div>
</ModulePage>
