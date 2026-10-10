<script lang="ts">
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs } from '../lib/components/ui';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import TempVoicePolicyEditor from '../lib/components/TempVoicePolicyEditor.svelte';
  import AutoThreadPanel from '../lib/components/channels/AutoThreadPanel.svelte';
  import { ToggleSwitch } from '../lib/components/ui';
  import type { TempVoicePolicy } from '@kotbo/shared';
  import type { TempVoiceGenerator, TempVoiceGeneratorPayload } from '../lib/api/moderation';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { fetchChannelsManagementConfig, updateChannelsManagementConfig, rescanChannelsManagementStats, fetchTempVoiceChannels, updateTempVoiceChannel, fetchStickyMessages, saveStickyMessage, deleteStickyMessage, repostStickyMessage, fetchChannelsByChannel, toggleChannelFeature, renameDiscordChannel, deleteDiscordChannel } from '../lib/api';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import { m } from '../lib/i18n';

  import { errorMessage } from '@kotbo/shared';
  /**
   * Politique par défaut côté page.
   *
   * Elle reprend à l'identique celle du bot (`tempVoiceService`) : tant qu'un
   * serveur n'a rien réglé, la page doit montrer ce que le bot appliquera
   * vraiment, et non des champs vides.
   */
  function defaultTempVoicePolicy(): TempVoicePolicy {
    return {
      userLimit: 0,
      lockOnCreate: false,
      autoAllowRoleIds: [],
      textChat: 'inherit',
      ownerPowers: ['mute', 'deafen', 'move'],
    };
  }

  /**
   * Même plafond que le bot : au-delà, la normalisation tronque la liste, et
   * les générateurs en trop disparaissent à l'enregistrement sans un mot.
   */
  const MAX_ADDITIONAL_GENERATORS = 25;

  /** Complète une entrée venue de l'API pour que l'éditeur ait toujours ses clés. */
  function withPolicyDefaults(generator: TempVoiceGeneratorPayload): TempVoiceGenerator {
    return { ...defaultTempVoicePolicy(), ...generator };
  }

  /**
   * Demandes d'accès à un salon verrouillé ou réservé, et permissions du
   * staff sur les salons temporaires qui ne sont pas les siens.
   *
   * Formes calquées sur `packages/database/prisma/temp-voice-access.prisma`
   * (modèles `TempVoiceAccessRequestConfig` et `TempVoiceModPermissionsConfig`) :
   * mêmes noms de champs, mêmes valeurs par défaut. Servies par
   * `GET`/`PATCH /channels-management` côté bot sous ces deux clés
   * (`tempVoiceAccessRequest`, `tempVoiceModPermissions`).
   */
  type TempVoiceAccessResponders = 'OWNER' | 'OWNER_AND_STAFF';
  type TempVoiceAccessNotifyVia = 'VOICE' | 'DM' | 'CHANNEL';
  type TempVoiceReservationOverflow = 'ASK' | 'NOTHING' | 'MOVE' | 'DISCONNECT';
  /**
   * Réglages de présentation du panneau, configurables par serveur : cinq
   * champs ajoutés au même titre que les permissions modérateur ci-dessous,
   * dans le même objet `tempVoiceModPermissions`.
   */
  type TempVoicePanelMode = 'CLASSIC' | 'FLAT';
  type TempVoiceStateLayout = 'GRID3' | 'GRID2' | 'TABLE' | 'CARDS';
  type TempVoiceStateColors = 'NEUTRAL' | 'DARK' | 'LIGHT';
  type TempVoicePanelComponents = 'V1' | 'V2';
  type TempVoiceReservationFallback = 'MEMBERS' | 'ANY_ROLE' | 'FORBIDDEN';

  interface TempVoiceAccessRequestConfig {
    enabled: boolean;
    responders: TempVoiceAccessResponders;
    notifyVia: TempVoiceAccessNotifyVia;
    notifyChannelId: string | null;
    requestExpiresMinutes: number;
    denyCooldownMinutes: number;
  }

  interface TempVoiceModPermissionsConfig {
    canRename: boolean;
    canChangeLimit: boolean;
    canLock: boolean;
    canChangeWriteMode: boolean;
    canKickOrBan: boolean;
    canReserve: boolean;
    canTransfer: boolean;
    /** Pas une permission modérateur : un choix de présentation. Défaut `false`. */
    panelCompactMode: boolean;
    /** Rôles proposés dans le menu « Réserver le salon ». Vide = tous les rôles du serveur. */
    reservableRoleIds: string[];
    /** Sort des personnes déjà présentes sans le rôle au moment de la réservation. */
    reservationOverflow: TempVoiceReservationOverflow;
    /** Salon vers lequel déplacer quand la décision est `MOVE`. */
    reservationFallbackChannelId: string | null;
    /** Portes séparées (CLASSIC) ou tout sur un écran (FLAT). Défaut `CLASSIC`. */
    panelMode: TempVoicePanelMode;
    /** Mise en page des six valeurs d'état. Seule GRID3 en V1 est native. Défaut `GRID3`. */
    stateLayout: TempVoiceStateLayout;
    /** Palette de l'image d'état ; sans effet pour GRID3 en V1. Défaut `NEUTRAL`. */
    stateColors: TempVoiceStateColors;
    /** Embed classique (V1) ou Components V2 (V2, rendu actuel). Défaut `V2`. */
    panelComponents: TempVoicePanelComponents;
    /**
     * Bouton « Réserver » pour qui n'a aucun rôle réservable. Défaut `ANY_ROLE`.
     * Nommé `reservationFallbackMode` (pas `reservationFallback`) pour matcher
     * la colonne Prisma `TempVoiceModPermissionsConfig.reservationFallbackMode` :
     * un nom différent ferait voyager le réglage jusqu'au bot sans jamais être
     * reconnu par `normalizeTempVoiceModPermissionsInput`.
     */
    reservationFallbackMode: TempVoiceReservationFallback;
    /**
     * Interrupteur de secours de la personnalisation par générateur. Défaut
     * `false` : au déploiement, aucun serveur existant ne change de
     * comportement. Le couper IGNORE les surcharges des générateurs
     * additionnels, il ne les EFFACE PAS : elles restent dans
     * `tempVoiceGenerators` et reviennent telles quelles au rallumage.
     */
    perGeneratorPresentation: boolean;
  }

  /** `@default` du modèle Prisma `TempVoiceAccessRequestConfig`. */
  function defaultTempVoiceAccessRequestConfig(): TempVoiceAccessRequestConfig {
    return {
      enabled: false,
      responders: 'OWNER_AND_STAFF',
      notifyVia: 'VOICE',
      notifyChannelId: null,
      requestExpiresMinutes: 10,
      denyCooldownMinutes: 10,
    };
  }

  /** `@default` du modèle Prisma `TempVoiceModPermissionsConfig`. */
  function defaultTempVoiceModPermissions(): TempVoiceModPermissionsConfig {
    return {
      canRename: true,
      canChangeLimit: true,
      canLock: true,
      canChangeWriteMode: true,
      canKickOrBan: true,
      canReserve: true,
      canTransfer: true,
      // Pas une permission : le comportement livré est l'éphémère multiple,
      // donc `false` - une ligne absente en base doit afficher l'interrupteur
      // éteint, pas aligné sur les sept permissions ci-dessus.
      panelCompactMode: false,
      reservableRoleIds: [],
      reservationOverflow: 'ASK',
      reservationFallbackChannelId: null,
      panelMode: 'CLASSIC',
      stateLayout: 'GRID3',
      stateColors: 'NEUTRAL',
      panelComponents: 'V2',
      reservationFallbackMode: 'ANY_ROLE',
      perGeneratorPresentation: false,
    };
  }

  /** Même plafond que côté bot : au-delà, un menu Discord ne pourrait pas les afficher. */
  const MAX_RESERVABLE_ROLES = 25;

  const NOTIFY_MODES: Array<{ key: TempVoiceAccessNotifyVia; label: () => string; hint: () => string }> = [
    { key: 'VOICE', label: () => m.cm_ar_notify_voice_channel(), hint: () => m.cm_ar_notify_voice_channel_hint() },
    { key: 'DM', label: () => m.cm_ar_notify_dm(), hint: () => m.cm_ar_notify_dm_hint() },
    { key: 'CHANNEL', label: () => m.cm_ar_notify_dedicated(), hint: () => m.cm_ar_notify_dedicated_hint() },
  ];

  /**
   * Les sept permissions modérateur, toutes booléennes. Resserré depuis
   * `keyof TempVoiceModPermissionsConfig` : ce type couvre aussi
   * `reservableRoleIds`/`reservationOverflow`/`reservationFallbackChannelId`
   * depuis leur ajout, et écrire par une clé union dont les valeurs ne sont
   * pas toutes des booléens fait échouer `svelte-check`.
   */
  type TempVoiceModPermissionsBooleanKey =
    | 'canRename'
    | 'canChangeLimit'
    | 'canLock'
    | 'canChangeWriteMode'
    | 'canKickOrBan'
    | 'canReserve'
    | 'canTransfer';

  const ADMIN_PERMISSION_ROWS: Array<{ key: TempVoiceModPermissionsBooleanKey; label: () => string }> = [
    { key: 'canRename', label: () => m.cm_ar_admin_rename() },
    { key: 'canChangeLimit', label: () => m.cm_ar_admin_limit() },
    { key: 'canLock', label: () => m.cm_ar_admin_lock() },
    { key: 'canChangeWriteMode', label: () => m.cm_ar_admin_text_chat_mode() },
    { key: 'canKickOrBan', label: () => m.cm_ar_admin_kick_ban() },
    { key: 'canReserve', label: () => m.cm_ar_admin_reserve() },
    { key: 'canTransfer', label: () => m.cm_ar_admin_transfer() },
  ];

  const RESERVATION_OVERFLOW_MODES: Array<{ key: TempVoiceReservationOverflow; label: () => string }> = [
    { key: 'ASK', label: () => m.cm_ar_reservation_overflow_ask() },
    { key: 'NOTHING', label: () => m.cm_ar_reservation_overflow_nothing() },
    { key: 'MOVE', label: () => m.cm_ar_reservation_overflow_move() },
    { key: 'DISCONNECT', label: () => m.cm_ar_reservation_overflow_disconnect() },
  ];

  /**
   * Les quatre axes de présentation du panneau, en cartes-radio avec une aide
   * PAR OPTION : même forme que `NOTIFY_MODES` ci-dessus, et que la maquette de
   * référence (`blocMode`/`blocFormat`/`blocCouleurs`) : le choix et ce qu'il
   * coûte se lisent ensemble, au lieu d'un `<select>` surmontant une aide
   * partagée qui ne décrivait que l'option déjà sélectionnée.
   */
  const PANEL_COMPONENTS_MODES: Array<{ key: TempVoicePanelComponents; label: () => string; hints: Array<() => string> }> = [
    { key: 'V2', label: () => m.cm_tv_panel_components_v2(), hints: [] },
    {
      key: 'V1',
      label: () => m.cm_tv_panel_components_v1(),
      // Les deux limites de V1, dites AVANT le clic : Discord ne retire jamais
      // le drapeau Components V2 d'un message qui le porte déjà (les panneaux
      // en place restent en V2), et les sous-panneaux éphémères restent en V2
      // de toute façon.
      hints: [
        () => m.cm_tv_panel_components_v1_limit_channels(),
        () => m.cm_tv_panel_components_v1_limit_ephemeral(),
      ],
    },
  ];

  const PANEL_MODES: Array<{ key: TempVoicePanelMode; label: () => string; hint: () => string }> = [
    { key: 'CLASSIC', label: () => m.cm_tv_panel_mode_classic(), hint: () => m.cm_tv_panel_mode_classic_hint() },
    { key: 'FLAT', label: () => m.cm_tv_panel_mode_flat(), hint: () => m.cm_tv_panel_mode_flat_hint() },
  ];

  const STATE_LAYOUT_MODES: Array<{ key: TempVoiceStateLayout; label: () => string; hint: () => string }> = [
    { key: 'GRID3', label: () => m.cm_tv_panel_state_layout_grid3(), hint: () => m.cm_tv_panel_state_layout_grid3_hint() },
    { key: 'GRID2', label: () => m.cm_tv_panel_state_layout_grid2(), hint: () => m.cm_tv_panel_state_layout_grid2_hint() },
    { key: 'TABLE', label: () => m.cm_tv_panel_state_layout_table(), hint: () => m.cm_tv_panel_state_layout_table_hint() },
    { key: 'CARDS', label: () => m.cm_tv_panel_state_layout_cards(), hint: () => m.cm_tv_panel_state_layout_cards_hint() },
  ];

  const STATE_COLORS_MODES: Array<{ key: TempVoiceStateColors; label: () => string; hint: () => string }> = [
    { key: 'NEUTRAL', label: () => m.cm_tv_panel_state_colors_neutral(), hint: () => m.cm_tv_panel_state_colors_neutral_hint() },
    { key: 'DARK', label: () => m.cm_tv_panel_state_colors_dark(), hint: () => m.cm_tv_panel_state_colors_dark_hint() },
    { key: 'LIGHT', label: () => m.cm_tv_panel_state_colors_light(), hint: () => m.cm_tv_panel_state_colors_light_hint() },
  ];

  /** Même liste que les trois `<option>` du réglage serveur (plus bas dans le
   *  template) : extraite en tableau pour être réutilisée par le sélecteur de
   *  surcharge par générateur, qui a aussi besoin d'en tirer un libellé. */
  const RESERVATION_FALLBACK_MODES: Array<{ key: TempVoiceReservationFallback; label: () => string }> = [
    { key: 'ANY_ROLE', label: () => m.cm_tv_panel_reservation_fallback_any_role() },
    { key: 'MEMBERS', label: () => m.cm_tv_panel_reservation_fallback_members() },
    { key: 'FORBIDDEN', label: () => m.cm_tv_panel_reservation_fallback_forbidden() },
  ];

  /** Libellé d'une valeur dans une des listes ci-dessus, pour l'option
   *  « Hérite du serveur (X) » du sélecteur de surcharge : la clé brute en
   *  repli, jamais une chaîne vide, si la liste ne la reconnaît pas. */
  function labelFor<T extends string>(key: T, options: Array<{ key: T; label: () => string }>): string {
    return options.find((o) => o.key === key)?.label() ?? key;
  }

  /** Nombre de champs que CE générateur surcharge : sert à la pastille de la
   *  liste (`m.cm_tv_panel_per_gen_badge_overrides`) sans ouvrir sa carte. */
  function generatorOverrideCount(generator: TempVoiceGenerator): number {
    const keys = ['panelMode', 'stateLayout', 'stateColors', 'panelComponents', 'reservationFallbackMode'] as const;
    return keys.filter((key) => generator[key] != null).length;
  }

  /**
   * La règle RÉELLE du bot : `etatRenduNativement`
   * (apps/bot/src/events/tempVoice.ts:960). Discord range les six valeurs
   * lui-même, en champs « inline » d'embed, si la disposition est GRID3 ET que
   * les composants sont V1 OU que la teinte est restée celle livrée (NEUTRAL,
   * second terme de `PRESENTATION_PAR_DEFAUT`). Tout le reste part en PNG rendu
   * côté bot.
   *
   * La page annonçait `stateLayout === 'GRID3' && panelComponents === 'V1'` :
   * dans la configuration PAR DÉFAUT (V2 + GRID3 + NEUTRAL) elle affichait donc
   * « rendu en image (PNG) » alors que le bot rend nativement : l'aide disait
   * le contraire du produit. Une seule combinaison sur 24 diffère entre les
   * deux conditions, et c'est justement celle de tous les serveurs en service.
   */
  function stateRenderedNatively(
    stateLayout: TempVoiceStateLayout,
    stateColors: TempVoiceStateColors,
    panelComponents: TempVoicePanelComponents,
  ): boolean {
    return stateLayout === 'GRID3' && (panelComponents === 'V1' || stateColors === 'NEUTRAL');
  }

  // Config State
  let config = $state({
    autoThreadEnabled: false,
    autoThreadChannels: [] as string[],
    statsEnabled: false,
    statsConfig: {
      categoryId: '',
      memberEnabled: false,
      memberChannelId: '',
      memberTemplate: '👤 Members: {count}',
      botEnabled: false,
      botChannelId: '',
      botTemplate: '🤖 Bots: {count}',
      roleEnabled: false,
      roleChannelId: '',
      roleTemplate: '👑 Staff: {count}',
      roleTargetId: '',
      channelEnabled: false,
      channelChannelId: '',
      channelTemplate: '💬 Channels: {count}',
      categoryEnabled: false,
      categoryChannelId: '',
      categoryTemplate: '📁 Categories: {count}',
      activityEnabled: false,
      activityChannelId: '',
      activityTemplate: '📈 Active 24h: {count}',
      customStats: [] as any[],
    },
    tempVoiceEnabled: false,
    tempVoiceChannelId: '',
    tempVoiceCategoryId: '',
    tempVoiceNameTemplate: '🔊 {user}\'s channel',
    tempVoiceRequiredRoleId: '',
    tempVoiceDefaults: defaultTempVoicePolicy(),
    tempVoiceGenerators: [] as TempVoiceGenerator[],
    tempVoiceAccessRequest: defaultTempVoiceAccessRequestConfig(),
    tempVoiceModPermissions: defaultTempVoiceModPermissions(),
    honeypotEnabled: false,
    honeypotChannelId: '',
    honeypotSanction: 'TIMEOUT',
    honeypotReinvite: false,
  });

  // Snapshot of last-saved state
  let savedConfig = $state(JSON.parse(JSON.stringify({
    autoThreadEnabled: false,
    autoThreadChannels: [] as string[],
    statsEnabled: false,
    statsConfig: {
      categoryId: '',
      memberEnabled: false,
      memberChannelId: '',
      memberTemplate: '👤 Members: {count}',
      botEnabled: false,
      botChannelId: '',
      botTemplate: '🤖 Bots: {count}',
      roleEnabled: false,
      roleChannelId: '',
      roleTemplate: '👑 Staff: {count}',
      roleTargetId: '',
      channelEnabled: false,
      channelChannelId: '',
      channelTemplate: '💬 Channels: {count}',
      categoryEnabled: false,
      categoryChannelId: '',
      categoryTemplate: '📁 Categories: {count}',
      activityEnabled: false,
      activityChannelId: '',
      activityTemplate: '📈 Active 24h: {count}',
      customStats: [] as any[],
    },
    tempVoiceEnabled: false,
    tempVoiceChannelId: '',
    tempVoiceCategoryId: '',
    tempVoiceNameTemplate: '🔊 {user}\'s channel',
    tempVoiceRequiredRoleId: '',
    tempVoiceDefaults: defaultTempVoicePolicy(),
    tempVoiceGenerators: [] as TempVoiceGenerator[],
    tempVoiceAccessRequest: defaultTempVoiceAccessRequestConfig(),
    tempVoiceModPermissions: defaultTempVoiceModPermissions(),
    honeypotEnabled: false,
    honeypotChannelId: '',
    honeypotSanction: 'TIMEOUT',
    honeypotReinvite: false,
  })));

  /**
   * La teinte ne peut JAMAIS rien changer QUE pour GRID3 en V1 : là, Discord
   * range les six valeurs dans les champs d'un embed, sans image, quelle que
   * soit la teinte choisie (`dispositionNative`, tempVoiceService.ts:1985).
   *
   * C'est cette condition-là qui grise le champ, et NON `stateRenderedNatively`
   * : avec le défaut V2 + GRID3 + NEUTRAL le rendu est bien natif, mais passer
   * la teinte à DARK ou LIGHT le fait justement basculer en image. Griser sur
   * « rendu natif » enfermerait le serveur sur NEUTRAL sans aucun moyen d'en
   * sortir : le réglage deviendrait inatteignable depuis la page.
   */
  const stateColorsInert = $derived(
    config.tempVoiceModPermissions.stateLayout === 'GRID3'
      && config.tempVoiceModPermissions.panelComponents === 'V1',
  );

  /**
   * La combinaison réglée EN CE MOMENT part-elle en image ? Une seule
   * constante, lue par l'aide du groupe « mise en page » : c'est ce que le bot
   * fera, pas une paraphrase de la règle recopiée dans le balisage.
   */
  const stateNative = $derived(stateRenderedNatively(
    config.tempVoiceModPermissions.stateLayout,
    config.tempVoiceModPermissions.stateColors,
    config.tempVoiceModPermissions.panelComponents,
  ));

  $effect(() => {
    const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
    if (dirty) {
      untrack(() => {
        unsavedChanges.register({
          id: 'channels-management',
          label: m.cm_page_label(),
          onSave: () => handleSave(),
          onReset: () => {
            config = JSON.parse(JSON.stringify(savedConfig));
          }
        });
      });
    } else {
      untrack(() => {
        unsavedChanges.release('channels-management');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('channels-management');
  });

  let loading = $state(true);
  let loadError = $state('');
  // « Par salon » d'abord : c'est la question qu'on se pose en arrivant
  // (« qu'est-ce qui touche ce salon ? »), la ou les onglets par fonctionnalite
  // repondent a l'inverse (« quels salons ont cette fonctionnalite ? »).
  const channelTabs = ['by-channel', 'auto-thread', 'sticky', 'stats', 'temp-voice', 'access-requests', 'honeypot'] as const;
  let activeTab = $state<'by-channel' | 'auto-thread' | 'sticky' | 'stats' | 'temp-voice' | 'access-requests' | 'honeypot'>('by-channel');
  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/channels-management', channelTabs, 'by-channel') as typeof activeTab;
  });

  // ── Vue « Par salon » ──────────────────────────────────────────────────────
  type ChannelRow = {
    id: string;
    name: string;
    type: string;
    categoryId: string | null;
    categoryName: string | null;
    manageable: boolean;
    features: string[];
  };

  let byChannel = $state<ChannelRow[]>([]);
  let featureLabels = $state<Record<string, string>>({});
  let byChannelLoading = $state(false);
  let byChannelQuery = $state('');
  let expandedChannelId = $state<string | null>(null);
  /** Identifiant du salon en cours de bascule : evite les clics concurrents. */
  let featureBusy = $state<string | null>(null);

  /**
   * `sticky` et `tempVoiceGenerator` sont affiches mais pas cochables : ils
   * demandent un contenu (le texte colle, le gabarit de nom) qu'une case ne
   * peut pas saisir. Ils restent geres dans leur onglet.
   */
  const togglableFeatures = $derived(Object.keys(featureLabels));

  const featureLabel = (key: string) =>
    featureLabels[key]
      // `sticky` et `tempVoiceGenerator` sont ajoutés par la route dans
      // `channel.features` mais ABSENTS de son dictionnaire `features` : ce
      // repli est donc le seul libellé qu'ils auront jamais.
      ?? (key === 'sticky' ? m.cm_bc_feature_sticky() : key === 'tempVoiceGenerator' ? m.cm_bc_feature_generator() : key);

  /**
   * Ce que ce salon porte en plus des cases à cocher : le message collé et le
   * générateur vocal demandent un contenu (le texte, le gabarit de nom) qu'une
   * case ne peut pas saisir, et se règlent dans leur onglet.
   */
  function alsoCarriedItems(ch: ChannelRow): string {
    const items: string[] = [];
    if (ch.features.includes('sticky')) items.push(m.cm_bc_also_sticky());
    if (ch.features.includes('tempVoiceGenerator')) items.push(m.cm_bc_also_generator());
    return items.join(', ');
  }

  const visibleByChannel = $derived(
    byChannelQuery.trim()
      ? byChannel.filter((ch) => {
          const q = byChannelQuery.trim().toLowerCase();
          return ch.name.toLowerCase().includes(q) || (ch.categoryName ?? '').toLowerCase().includes(q);
        })
      : byChannel
  );

  async function loadByChannel() {
    byChannelLoading = true;
    try {
      const data = await fetchChannelsByChannel();
      byChannel = data?.channels ?? [];
      featureLabels = data?.features ?? {};
    } catch {
      toast.error(m.cm_bc_load_failed());
    } finally {
      byChannelLoading = false;
    }
  }

  async function setChannelFeature(ch: ChannelRow, feature: string, enabled: boolean) {
    if (featureBusy) return;
    featureBusy = ch.id;
    try {
      await toggleChannelFeature(ch.id, feature, enabled);
      // Rechargement complet plutot que mise a jour locale : activer une
      // fonctionnalite unique la retire d'un autre salon, que l'etat local
      // n'aurait aucun moyen de deviner.
      await loadByChannel();
    } catch (err) {
      toast.error(errorMessage(err) || m.cm_bc_toggle_failed());
    } finally {
      featureBusy = null;
    }
  }

  async function renameChannel(ch: ChannelRow) {
    const name = window.prompt(m.cm_bc_rename_prompt({ name: ch.name }), ch.name);
    if (!name || name.trim() === ch.name) return;

    try {
      await renameDiscordChannel(ch.id, name.trim());
      toast.success(m.cm_channel_renamed());
      await loadByChannel();
    } catch (err) {
      toast.error(errorMessage(err) || m.cm_rename_failed());
    }
  }

  async function removeChannel(ch: ChannelRow) {
    const confirmed = await confirmDialog.ask({
      title: m.cm_bc_delete_confirm_title({ name: ch.name }),
      description: m.cm_bc_delete_confirm_desc(),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await deleteDiscordChannel(ch.id);
      toast.success(m.cm_bc_deleted());
      expandedChannelId = null;
      await loadByChannel();
    } catch (err) {
      toast.error(errorMessage(err) || m.cm_bc_delete_failed());
    }
  }

  $effect(() => {
    if (activeTab === 'by-channel') void loadByChannel();
  });

  const saveAction = createAsyncActionState();
  const rescanAction = createAsyncActionState();

  async function handleRescanStats(force: boolean) {
    await rescanAction.run(async () => {
      const res = await rescanChannelsManagementStats({ force });
      if (!res || !res.ok) throw new Error(res?.error || m.cm_scan_launch_error());
      return true;
    }, { successMessage: m.cm_scan_launched() });
  }

  const availableChannels = $derived((dashboardStore.state.discordChannels || []) as any[]);
  const availableVoiceChannels = $derived((dashboardStore.state.discordVoiceChannels || []) as any[]);
  const availableCategories = $derived((dashboardStore.state.discordCategories || []) as any[]);
  const availableRoles = $derived((dashboardStore.state.discordRoles || []) as any[]);

  // Les fils ne sont pas configurables ici : le bot les ecarte a l'execution,
  // qu'il s'agisse des fils automatiques ou du sticky. Les proposer ne faisait
  // que promettre un réglage sans effet.
  const selectableChannels = $derived(availableChannels.filter(c => c.type !== 'thread'));

  // @everyone porte l'identifiant du serveur : l'autoriser d'office rouvrirait
  // le salon à tout le monde, et le bot l'écarte. Le proposer ne ferait que
  // promettre un réglage que la sauvegarde supprime sans le dire.
  const autoAllowableRoles = $derived(
    availableRoles.filter(role => role.id !== authStore.selectedGuildId)
  );

  /**
   * Rôles proposés dans le menu « Réserver le salon ». Même style que
   * l'éditeur de politique (TempVoicePolicyEditor) pour `autoAllowRoleIds` :
   * des puces retirables plus un sélecteur pour ajouter, réutilisant
   * `availableRoles`/`autoAllowableRoles` déjà chargés pour cette page.
   */
  const selectableReservableRoles = $derived(
    autoAllowableRoles.filter((role) => !config.tempVoiceModPermissions.reservableRoleIds.includes(role.id))
  );

  function reservableRoleName(roleId: string) {
    return availableRoles.find((role) => role.id === roleId)?.name ?? roleId;
  }

  let reservableRoleToAdd = $state('');

  function addReservableRole(roleId: string | null) {
    if (!roleId) return;
    if (config.tempVoiceModPermissions.reservableRoleIds.includes(roleId)) return;
    if (config.tempVoiceModPermissions.reservableRoleIds.length >= MAX_RESERVABLE_ROLES) return;
    config.tempVoiceModPermissions.reservableRoleIds = [...config.tempVoiceModPermissions.reservableRoleIds, roleId];
    // Le champ se vide : sans cela, le rôle choisi reste affiché alors qu'il
    // figure déjà dans la liste de puces juste en dessous.
    reservableRoleToAdd = '';
  }

  function removeReservableRole(roleId: string) {
    config.tempVoiceModPermissions.reservableRoleIds = config.tempVoiceModPermissions.reservableRoleIds.filter(
      (id) => id !== roleId
    );
  }

  /**
   * Salons où l'auto-thread peut ouvrir un fil : textuels et d'annonces. Un
   * forum ouvre déjà un fil par publication, un vocal n'en porte pas.
   */
  const autoThreadChannelOptions = $derived(
    availableChannels
      .filter(c => !['thread', 'voice', 'stage', 'forum', 'media', 'category'].includes(c.type))
      .map(c => ({ id: c.id, name: channelDisplayName(c) }))
  );

  const roleOptions = $derived(autoAllowableRoles.map(role => ({ id: role.id, name: role.name })));

  /**
   * Choix d'un selecteur, en gardant la valeur deja enregistree meme si elle ne
   * fait plus partie des choix proposes. Sans ca, un sticky configure sur un
   * fil avant ce filtrage s'affichait sur un selecteur vide, et on ne pouvait
   * plus voir ni changer ce qui etait en place.
   */
  function channelOptions(selectedId: string | null | undefined) {
    const options = selectableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }));
    if (!selectedId || options.some(o => o.id === selectedId)) return options;

    const current = availableChannels.find(c => c.id === selectedId);
    return current ? [...options, { id: current.id, name: channelDisplayName(current) }] : options;
  }

  let activeTempChannels = $state([] as any[]);
  let loadingTempChannels = $state(false);

  async function loadActiveTempChannels() {
    if (!config.tempVoiceEnabled) return;
    loadingTempChannels = true;
    try {
      const res = await fetchTempVoiceChannels();
      if (Array.isArray(res)) {
        activeTempChannels = res;
      }
    } catch (err) {
      console.error('Error fetching temp voice channels:', err);
    } finally {
      loadingTempChannels = false;
    }
  }

  $effect(() => {
    if (activeTab === 'temp-voice') {
      loadActiveTempChannels();
    }
  });

  // ── Sticky bot ────────────────────────────────────────────────────────────
  type StickyDraft = {
    id: string | null;
    channelId: string;
    enabled: boolean;
    content: string;
    embedEnabled: boolean;
    embedTitle: string;
    embedColor: string;
    messageThreshold: number;
    cooldownSeconds: number;
    jsonEnabled: boolean;
    jsonPayload: string;
    webhookEnabled: boolean;
    webhookName: string;
    webhookAvatarUrl: string;
  };

  /** Exemple affiché sous l'interrupteur JSON, à recopier puis adapter. */
  const STICKY_JSON_EXAMPLE = JSON.stringify({
    content: '',
    embeds: [{ title: '📌 À lire avant de poster', description: 'Consulte le **règlement** du serveur.', color: 5793266 }],
  }, null, 2);

  let stickies = $state([] as StickyDraft[]);
  let loadingStickies = $state(false);
  let stickyBusy = $state(null as string | null);
  let stickiesLoaded = $state(false);

  function toStickyDraft(raw: any): StickyDraft {
    return {
      id: raw.id ?? null,
      channelId: raw.channelId ?? '',
      enabled: raw.enabled ?? true,
      content: raw.content ?? '',
      embedEnabled: raw.embedEnabled ?? false,
      embedTitle: raw.embedTitle ?? '',
      embedColor: raw.embedColor ?? '#5865F2',
      messageThreshold: raw.messageThreshold ?? 5,
      cooldownSeconds: raw.cooldownSeconds ?? 10,
      jsonEnabled: raw.jsonEnabled ?? false,
      jsonPayload: raw.jsonPayload ?? '',
      webhookEnabled: raw.webhookEnabled ?? false,
      webhookName: raw.webhookName ?? '',
      webhookAvatarUrl: raw.webhookAvatarUrl ?? '',
    };
  }

  async function loadStickies() {
    loadingStickies = true;
    try {
      const res = await fetchStickyMessages();
      if (res && Array.isArray(res.stickies)) {
        stickies = res.stickies.map(toStickyDraft);
      }
      stickiesLoaded = true;
    } catch (err) {
      console.error('Error fetching sticky messages:', err);
    } finally {
      loadingStickies = false;
    }
  }

  $effect(() => {
    if (activeTab === 'sticky' && !stickiesLoaded) {
      loadStickies();
    }
  });

  function addSticky() {
    stickies = [
      ...stickies,
      {
        id: null,
        channelId: '',
        enabled: true,
        content: '',
        embedEnabled: false,
        embedTitle: '',
        embedColor: '#5865F2',
        messageThreshold: 5,
        cooldownSeconds: 10,
        jsonEnabled: false,
        jsonPayload: '',
        webhookEnabled: false,
        webhookName: '',
        webhookAvatarUrl: '',
      },
    ];
  }

  async function handleSaveSticky(index: number) {
    const sticky = stickies[index];
    if (!sticky.channelId) {
      toast.error(m.cm_sticky_channel_required());
      return;
    }
    if (sticky.jsonEnabled) {
      if (!sticky.jsonPayload.trim()) {
        toast.error(m.cm_sticky_json_required());
        return;
      }
      try {
        JSON.parse(sticky.jsonPayload);
      } catch {
        toast.error(m.cm_sticky_json_invalid());
        return;
      }
    } else if (!sticky.content.trim()) {
      toast.error(m.cm_sticky_content_required());
      return;
    }
    if (sticky.webhookEnabled && /discord|clyde/i.test(sticky.webhookName)) {
      toast.error(m.cm_sticky_webhook_name_invalid());
      return;
    }

    stickyBusy = sticky.channelId;
    try {
      const res = await saveStickyMessage({
        channelId: sticky.channelId,
        enabled: sticky.enabled,
        content: sticky.content,
        embedEnabled: sticky.embedEnabled,
        embedTitle: sticky.embedTitle || null,
        embedColor: sticky.embedColor,
        messageThreshold: sticky.messageThreshold,
        cooldownSeconds: sticky.cooldownSeconds,
        jsonEnabled: sticky.jsonEnabled,
        jsonPayload: sticky.jsonPayload || null,
        webhookEnabled: sticky.webhookEnabled,
        webhookName: sticky.webhookName || null,
        webhookAvatarUrl: sticky.webhookAvatarUrl || null,
      });
      if (!res || !res.ok) throw new Error(res?.error || m.cm_sticky_save_failed());
      stickies[index] = toStickyDraft(res.sticky);
      toast.success(m.cm_sticky_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.cm_sticky_save_failed());
    } finally {
      stickyBusy = null;
    }
  }

  async function handleDeleteSticky(index: number) {
    const sticky = stickies[index];
    // Brouillon jamais enregistré : rien à supprimer côté serveur.
    if (!sticky.id) {
      stickies = stickies.filter((_, i) => i !== index);
      return;
    }
    if (!(await confirmDialog.ask({
      title: m.cm_sticky_confirm_delete_title(),
      description: m.cm_sticky_confirm_delete_desc(),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    }))) return;

    stickyBusy = sticky.channelId;
    try {
      const res = await deleteStickyMessage(sticky.channelId);
      if (!res || !res.ok) throw new Error(res?.error || m.cm_sticky_delete_failed());
      stickies = stickies.filter((_, i) => i !== index);
      toast.success(m.cm_sticky_deleted());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.cm_sticky_delete_failed());
    } finally {
      stickyBusy = null;
    }
  }

  async function handleRepostSticky(index: number) {
    const sticky = stickies[index];
    if (!sticky.id) return;
    stickyBusy = sticky.channelId;
    try {
      const res = await repostStickyMessage(sticky.channelId);
      if (!res || !res.ok) throw new Error(res?.error || m.cm_sticky_repost_failed());
      toast.success(m.cm_sticky_reposted());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.cm_sticky_repost_failed());
    } finally {
      stickyBusy = null;
    }
  }

  let editingChannel = $state(null as string | null);
  let newChannelName = $state('');
  let actionInProgress = $state(false);

  async function handleRenameChannel(channelId: string) {
    if (!newChannelName.trim()) return;
    actionInProgress = true;
    try {
      const res = await updateTempVoiceChannel(channelId, { name: newChannelName.trim() });
      if (res && res.ok) {
        toast.success(m.cm_channel_renamed());
        await loadActiveTempChannels();
        editingChannel = null;
      }
    } catch (err) {
      toast.error(m.cm_rename_failed());
    } finally {
      actionInProgress = false;
    }
  }

  async function handleReserveChannel(channelId: string, roleId: string | null) {
    actionInProgress = true;
    try {
      const res = await updateTempVoiceChannel(channelId, { roleId });
      if (res && res.ok) {
        toast.success(roleId ? m.cm_channel_reserved() : m.cm_reservation_cancelled());
        await loadActiveTempChannels();
      }
    } catch (err) {
      toast.error(m.cm_reservation_update_failed());
    } finally {
      actionInProgress = false;
    }
  }

  async function handleDeleteChannel(channelId: string) {
    if (!(await confirmDialog.ask({ title: m.cm_confirm_close_temp_title(), description: m.cm_confirm_close_temp_desc(), confirmLabel: m.cm_close_channel(), variant: 'danger' }))) return;
    actionInProgress = true;
    try {
      const res = await updateTempVoiceChannel(channelId, { action: 'DELETE' });
      if (res && res.ok) {
        toast.success(m.cm_temp_channel_closed());
        await loadActiveTempChannels();
      }
    } catch (err) {
      toast.error(m.cm_close_failed());
    } finally {
      actionInProgress = false;
    }
  }

  onMount(async () => {
    try {
      await dashboardStore.refresh();
      const res = await fetchChannelsManagementConfig();
      if (res) {
        config.autoThreadEnabled = res.autoThreadEnabled ?? false;
        config.autoThreadChannels = res.autoThreadChannels ?? [];
        config.statsEnabled = res.statsEnabled ?? false;
        if (res.statsConfig) {
          config.statsConfig = {
            ...config.statsConfig,
            ...(res.statsConfig as any)
          };
          const sc = res.statsConfig as any;
          config.statsConfig.memberEnabled = sc.memberEnabled ?? !!sc.memberChannelId;
          config.statsConfig.botEnabled = sc.botEnabled ?? !!sc.botChannelId;
          config.statsConfig.roleEnabled = sc.roleEnabled ?? !!sc.roleChannelId;
          config.statsConfig.channelEnabled = sc.channelEnabled ?? !!sc.channelChannelId;
          config.statsConfig.categoryEnabled = sc.categoryEnabled ?? !!sc.categoryChannelId;
          config.statsConfig.activityEnabled = sc.activityEnabled ?? !!sc.activityChannelId;
          config.statsConfig.categoryId = sc.categoryId ?? '';
          config.statsConfig.customStats = sc.customStats || [];
        }
        config.tempVoiceEnabled = res.tempVoiceEnabled ?? false;
        config.tempVoiceChannelId = res.tempVoiceChannelId ?? '';
        config.tempVoiceCategoryId = res.tempVoiceCategoryId ?? '';
        config.tempVoiceNameTemplate = res.tempVoiceNameTemplate || '🔊 {user}\'s channel';
        config.tempVoiceRequiredRoleId = res.tempVoiceRequiredRoleId ?? '';
        config.tempVoiceDefaults = { ...defaultTempVoicePolicy(), ...(res.tempVoiceDefaults ?? {}) };
        config.tempVoiceGenerators = Array.isArray(res.tempVoiceGenerators)
          ? res.tempVoiceGenerators.map(withPolicyDefaults)
          : [];
        config.tempVoiceAccessRequest = { ...defaultTempVoiceAccessRequestConfig(), ...(res.tempVoiceAccessRequest ?? {}) };
        config.tempVoiceModPermissions = { ...defaultTempVoiceModPermissions(), ...(res.tempVoiceModPermissions ?? {}) };
        config.honeypotEnabled = res.honeypotEnabled ?? false;
        config.honeypotChannelId = res.honeypotChannelId ?? '';
        config.honeypotSanction = res.honeypotSanction ?? 'TIMEOUT';
        config.honeypotReinvite = res.honeypotReinvite ?? false;
        savedConfig = JSON.parse(JSON.stringify(config));
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : m.cm_config_load_failed();
    } finally {
      loading = false;
    }
  });

  // Keep toggle state in sync with module header in ModulePage.
  // L'interrupteur du module ecrit deja son etat cote serveur : le repercuter
  // sur la seule copie locale ferait apparaitre une modification a enregistrer,
  // et l'enregistrement serait refuse par la garde des modules.
  $effect(() => {
    const activeModule = (dashboardStore.state.modules as any[]).find(m => m.id === 'auto_thread');
    const enabled = activeModule?.status === 'active';
    untrack(() => {
      config.autoThreadEnabled = enabled;
      savedConfig.autoThreadEnabled = enabled;
    });
  });

  async function handleSave(): Promise<boolean> {
    let success = false;
    await saveAction.run(async () => {
      // Validate statistics role target only if role channel or auto-creation is requested
      if (config.statsConfig.roleEnabled && !config.statsConfig.roleTargetId) {
        toast.error(m.cm_role_target_required());
        throw new Error(m.cm_role_target_missing());
      }

      const res = await updateChannelsManagementConfig({
        autoThreadEnabled: config.autoThreadEnabled,
        statsEnabled: config.statsEnabled,
        statsConfig: config.statsConfig,
        tempVoiceEnabled: config.tempVoiceEnabled,
        tempVoiceChannelId: config.tempVoiceChannelId || null,
        tempVoiceCategoryId: config.tempVoiceCategoryId || null,
        tempVoiceNameTemplate: config.tempVoiceNameTemplate,
        tempVoiceRequiredRoleId: config.tempVoiceRequiredRoleId || null,
        tempVoiceDefaults: config.tempVoiceDefaults,
        tempVoiceGenerators: config.tempVoiceGenerators || [],
        tempVoiceAccessRequest: {
          ...config.tempVoiceAccessRequest,
          notifyChannelId: config.tempVoiceAccessRequest.notifyChannelId || null,
        },
        tempVoiceModPermissions: config.tempVoiceModPermissions,
        honeypotEnabled: config.honeypotEnabled,
        honeypotChannelId: config.honeypotChannelId || null,
        honeypotSanction: config.honeypotSanction,
        honeypotReinvite: config.honeypotReinvite,
      });

      // `res.error` d'abord : la route nomme le champ qu'elle refuse
      // (`panelSettingError` : « Palette de l'état (stateColors): "X" is not a
      // valid value. Nothing was saved. »). « API save error » seul ne disait
      // pas lequel des vingt-et-un champs du corps avait été rejeté.
      if (!res || !res.ok) throw new Error(res?.error || m.cm_save_api_error());

      // Update local state with resolved (auto-created) values from backend
      if (res.resolved) {
        if (res.resolved.tempVoiceChannelId) config.tempVoiceChannelId = res.resolved.tempVoiceChannelId;
        if (res.resolved.tempVoiceCategoryId) config.tempVoiceCategoryId = res.resolved.tempVoiceCategoryId;
        if (Array.isArray(res.resolved.tempVoiceGenerators)) {
          config.tempVoiceGenerators = res.resolved.tempVoiceGenerators.map(withPolicyDefaults);
        }
        if (res.resolved.honeypotChannelId) config.honeypotChannelId = res.resolved.honeypotChannelId;
        if (res.resolved.honeypotSanction) config.honeypotSanction = res.resolved.honeypotSanction;
        if (res.resolved.honeypotReinvite !== undefined) config.honeypotReinvite = res.resolved.honeypotReinvite;
        if (res.resolved.statsConfig) {
          config.statsConfig = {
            ...config.statsConfig,
            ...res.resolved.statsConfig
          };
        }
      }
      
      await dashboardStore.refresh();
      savedConfig = JSON.parse(JSON.stringify(config));
      success = true;
      return true;
    }, { successMessage: m.cm_config_saved() });
    return success;
  }

</script>

<ModulePage
  title={m.cm_page_label()}
  description={m.cm_page_description()}
  icon="hash"
  featureKey="auto_thread"
>

  <InlineFeedback message={saveAction.state.message} error={saveAction.state.error} />

  {#if loading}
    <div class="flex flex-col gap-6 animate-pulse">
      <div class="h-12 w-48 bg-surface-container-low/60 rounded-xl"></div>
      <div class="h-64 rounded-xl bg-surface-container-low/60"></div>
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else if loadError}
    <div class="flex items-center gap-2 rounded-xl bg-error/10 border border-error/20 p-6 text-error text-sm font-semibold">
      <Papicon icon="alert-triangle" size={16} />
      <span>{loadError}</span>
    </div>
  {:else}
    <Tabs
      label={m.cm_page_label()}
      class="mb-8"
      tabs={pageTabItems('/channels-management')}
      active={activeTab}
      onchange={(id) => gotoTab('/channels-management', id, 'by-channel')}
    />

    <!-- Active Content Tab -->
    <div class="grid grid-cols-1 gap-8">
      {#if activeTab === 'by-channel'}
        <!-- VUE PAR SALON -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-5 lg:p-6 rounded-xl space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold text-on-surface">{m.cm_bc_title()}</h3>
              <p class="text-body-sm text-on-surface-variant mt-0.5">{m.cm_bc_desc()}</p>
            </div>
            <input
              type="text"
              bind:value={byChannelQuery}
              placeholder={m.cm_bc_filter_placeholder()}
              class="w-full sm:w-56 bg-surface-container-high text-sm px-4 py-2 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none"
            />
          </div>

          {#if byChannelLoading}
            <div class="flex justify-center py-8"><LoadingHint context="config" /></div>
          {:else if visibleByChannel.length === 0}
            <p class="text-body-sm text-on-surface-variant/70 py-8 text-center">{m.cm_no_channel_matches_search()}</p>
          {:else}
            <div class="space-y-1.5">
              {#each visibleByChannel as ch (ch.id)}
                <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
                  <button
                    type="button"
                    class="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/3 transition-colors text-left"
                    onclick={() => (expandedChannelId = expandedChannelId === ch.id ? null : ch.id)}
                  >
                    <div class="flex items-center gap-2.5 min-w-0">
                      <Papicon icon={ch.type === 'voice' ? 'volume-2' : ch.type === 'forum' ? 'message-square' : 'hash'} size={15} class="text-on-surface-variant/60 shrink-0" />
                      <div class="min-w-0">
                        <p class="text-body-sm font-medium text-on-surface truncate">{ch.name}</p>
                        {#if ch.categoryName}
                          <p class="text-2xs text-on-surface-variant/60 truncate">{ch.categoryName}</p>
                        {/if}
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      {#each ch.features.slice(0, 3) as key}
                        <span class="text-2xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">{featureLabel(key)}</span>
                      {/each}
                      {#if ch.features.length > 3}
                        <span class="text-2xs text-on-surface-variant/60">+{ch.features.length - 3}</span>
                      {/if}
                      <Papicon icon={expandedChannelId === ch.id ? 'chevron-up' : 'chevron-down'} size={15} class="text-on-surface-variant/40" />
                    </div>
                  </button>

                  {#if expandedChannelId === ch.id}
                    <div class="px-4 pb-4 pt-1 border-t border-outline-variant/10 space-y-3">
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                        {#each togglableFeatures as key (key)}
                          <label class="flex items-center gap-2.5 cursor-pointer py-1.5">
                            <input
                              type="checkbox"
                              checked={ch.features.includes(key)}
                              disabled={featureBusy !== null}
                              onchange={(e) => setChannelFeature(ch, key, e.currentTarget.checked)}
                              class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30"
                            />
                            <span class="text-xs text-on-surface">{featureLabel(key)}</span>
                          </label>
                        {/each}
                      </div>

                      <!-- Le sticky et les générateurs vocaux ont leur propre
                           contenu à saisir : on renvoie vers leur onglet plutôt
                           que d'en faire une case à cocher trompeuse. -->
                      {#if ch.features.includes('sticky') || ch.features.includes('tempVoiceGenerator')}
                        <p class="text-2xs text-on-surface-variant/70">
                          {m.cm_bc_also_carries({ items: alsoCarriedItems(ch) })}
                        </p>
                      {/if}

                      <div class="flex flex-wrap gap-2 pt-1 border-t border-outline-variant/10">
                        <button
                          type="button"
                          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                          bg-surface-container text-on-surface border border-outline-variant/40
                          hover:border-outline-variant disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          disabled={!ch.manageable}
                          title={ch.manageable ? '' : m.cm_bc_cannot_edit()}
                          onclick={() => renameChannel(ch)}
                        >
                          <Papicon icon="pencil" size={13} />
                          {m.cm_rename_title()}
                        </button>
                        <button
                          type="button"
                          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                          bg-error/10 text-error border border-error/30 hover:bg-error/20
                          disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          disabled={!ch.manageable}
                          title={ch.manageable ? '' : m.cm_bc_cannot_delete()}
                          onclick={() => removeChannel(ch)}
                        >
                          <Papicon icon="trash" size={13} />
                          {m.common_delete()}
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeTab === 'auto-thread'}
        <!-- AUTO-THREAD TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-5 sm:p-8 rounded-xl">
          <AutoThreadPanel channels={autoThreadChannelOptions} roles={roleOptions} />
        </section>

      {:else if activeTab === 'sticky'}
        <!-- STICKY BOT TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/10 pb-4">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="notes" size={20} class="text-primary" />
                {m.cm_sticky_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_sticky_desc()}</p>
            </div>

            <button
              type="button"
              onclick={loadStickies}
              disabled={loadingStickies}
              class="px-3.5 py-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all flex items-center gap-2 shrink-0"
            >
              <Papicon icon="refresh" size={14} class={loadingStickies ? 'animate-spin' : ''} />
              {m.common_refresh()}
            </button>
          </div>

          <div class="flex items-start gap-2 p-3 rounded-lg bg-surface-container-high/20 border border-outline-variant/10">
            <span class="text-primary mt-0.5 shrink-0"><Papicon icon="Info" size={14} /></span>
            <p class="text-2xs text-on-surface-variant/70 font-medium leading-relaxed">
              {m.cm_sticky_info()}
            </p>
          </div>

          {#if loadingStickies && stickies.length === 0}
            <div class="flex items-center justify-center py-12">
              <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
            </div>
          {:else}
            <div class="space-y-4">
              {#each stickies as sticky, index (sticky.id ?? `draft-${index}`)}
                <div class="rounded-xl border border-outline-variant/10 bg-surface-container/20 p-5 space-y-4">
                  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div class="flex-1 space-y-1.5">
                      <label for="sticky-channel-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_channel_label()}</label>
                      <SearchableSelect
                        id="sticky-channel-{index}"
                        options={channelOptions(sticky.channelId)}
                        bind:value={sticky.channelId}
                        placeholder={m.cm_select_channel_placeholder()}
                        disabled={!!sticky.id}
                      />
                      {#if sticky.id}
                        <p class="text-2xs text-on-surface-variant/40">{m.cm_sticky_channel_locked_hint()}</p>
                      {/if}
                    </div>

                    <div class="flex items-center gap-3 sm:pt-6">
                      <span class="text-xs font-semibold text-on-surface-variant/60">{m.cm_sticky_enabled_label()}</span>
                      <input
                        type="checkbox"
                        aria-label={m.cm_sticky_enabled_label()}
                        bind:checked={sticky.enabled}
                        class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                      />
                    </div>
                  </div>

                  <div class="flex items-center justify-between gap-4 p-4 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl">
                    <div class="space-y-0.5">
                      <p class="text-xs font-bold text-on-surface/80">{m.cm_sticky_webhook_label()}</p>
                      <p class="text-2xs text-on-surface-variant/60">{m.cm_sticky_webhook_desc()}</p>
                    </div>
                    <ToggleSwitch checked={sticky.webhookEnabled} onToggle={(v) => (sticky.webhookEnabled = v)} ariaLabel={m.cm_sticky_webhook_label()} />
                  </div>

                  {#if sticky.webhookEnabled}
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div class="space-y-1.5">
                        <label for="sticky-webhook-name-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_webhook_name_label()}</label>
                        <input
                          id="sticky-webhook-name-{index}"
                          type="text"
                          maxlength="80"
                          bind:value={sticky.webhookName}
                          placeholder={m.cm_sticky_webhook_name_placeholder()}
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                        />
                      </div>
                      <div class="space-y-1.5">
                        <label for="sticky-webhook-avatar-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_webhook_avatar_label()}</label>
                        <input
                          id="sticky-webhook-avatar-{index}"
                          type="url"
                          maxlength="512"
                          bind:value={sticky.webhookAvatarUrl}
                          placeholder="https://"
                          aria-describedby="sticky-webhook-avatar-hint-{index}"
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                        />
                        <p id="sticky-webhook-avatar-hint-{index}" class="text-2xs text-on-surface-variant/40">{m.cm_sticky_webhook_avatar_hint()}</p>
                      </div>
                    </div>
                  {/if}

                  <div class="flex items-center justify-between gap-4 p-4 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl">
                    <div class="space-y-0.5">
                      <p class="text-xs font-bold text-on-surface/80">{m.cm_sticky_json_label()}</p>
                      <p class="text-2xs text-on-surface-variant/60">{m.cm_sticky_json_desc()}</p>
                    </div>
                    <ToggleSwitch checked={sticky.jsonEnabled} onToggle={(v) => (sticky.jsonEnabled = v)} ariaLabel={m.cm_sticky_json_label()} />
                  </div>

                  {#if sticky.jsonEnabled}
                    <div class="space-y-1.5">
                      <p class="text-2xs text-on-surface-variant/60">{m.cm_sticky_json_example()}</p>
                      <pre class="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-dashed border-outline-variant/20 p-3 text-xs text-on-surface-variant">{STICKY_JSON_EXAMPLE}</pre>
                      <label for="sticky-json-{index}" class="sr-only">{m.cm_sticky_json_label()}</label>
                      <textarea
                        id="sticky-json-{index}"
                        bind:value={sticky.jsonPayload}
                        rows="10"
                        maxlength="65536"
                        spellcheck="false"
                        placeholder={STICKY_JSON_EXAMPLE}
                        aria-describedby="sticky-json-hint-{index}"
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 font-mono text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/30 transition-all resize-y"
                      ></textarea>
                      <p id="sticky-json-hint-{index}" class="text-2xs text-on-surface-variant/40">{m.cm_sticky_json_hint()} {m.cm_sticky_placeholders_hint()}</p>
                    </div>
                  {:else}
                    <div class="space-y-1.5">
                      <label for="sticky-content-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_content_label()}</label>
                      <textarea
                        id="sticky-content-{index}"
                        bind:value={sticky.content}
                        rows="4"
                        maxlength="2000"
                        placeholder={m.cm_sticky_content_placeholder()}
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface outline-none focus:ring-1 focus:ring-primary/30 transition-all resize-y"
                      ></textarea>
                      <p class="text-2xs text-on-surface-variant/40">{m.cm_sticky_placeholders_hint()}</p>
                    </div>
                  {/if}

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                      <label for="sticky-threshold-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_threshold_label()}</label>
                      <input
                        id="sticky-threshold-{index}"
                        type="number"
                        min="1"
                        max="200"
                        bind:value={sticky.messageThreshold}
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                      />
                      <p class="text-2xs text-on-surface-variant/40">{m.cm_sticky_threshold_hint()}</p>
                    </div>

                    <div class="space-y-1.5">
                      <label for="sticky-cooldown-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_cooldown_label()}</label>
                      <input
                        id="sticky-cooldown-{index}"
                        type="number"
                        min="0"
                        max="3600"
                        bind:value={sticky.cooldownSeconds}
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                      />
                      <p class="text-2xs text-on-surface-variant/40">{m.cm_sticky_cooldown_hint()}</p>
                    </div>
                  </div>

                  {#if !sticky.jsonEnabled}
                  <div class="flex items-center justify-between p-4 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl">
                    <div class="space-y-0.5">
                      <label for="sticky-embed-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_embed_label()}</label>
                      <p class="text-2xs text-on-surface-variant/60">{m.cm_sticky_embed_desc()}</p>
                    </div>
                    <input
                      id="sticky-embed-{index}"
                      type="checkbox"
                      bind:checked={sticky.embedEnabled}
                      class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                    />
                  </div>

                  {#if sticky.embedEnabled}
                    <div class="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 animate-in fade-in duration-300">
                      <div class="space-y-1.5">
                        <label for="sticky-embed-title-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_embed_title_label()}</label>
                        <input
                          id="sticky-embed-title-{index}"
                          type="text"
                          maxlength="256"
                          bind:value={sticky.embedTitle}
                          placeholder={m.cm_sticky_embed_title_placeholder()}
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                        />
                      </div>
                      <div class="space-y-1.5">
                        <label for="sticky-embed-color-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_sticky_embed_color_label()}</label>
                        <input
                          id="sticky-embed-color-{index}"
                          type="color"
                          bind:value={sticky.embedColor}
                          class="h-[42px] w-20 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-1 cursor-pointer"
                        />
                      </div>
                    </div>
                  {/if}
                  {/if}

                  <div class="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-outline-variant/10">
                    {#if sticky.id}
                      <button
                        type="button"
                        onclick={() => handleRepostSticky(index)}
                        disabled={stickyBusy === sticky.channelId}
                        class="px-3.5 py-2 bg-surface-container-high/40 hover:bg-surface-container-high/80 border border-outline-variant/10 text-xs font-bold rounded-lg transition-all inline-flex items-center gap-2 disabled:opacity-50"
                      >
                        <Papicon icon="refresh" size={13} />
                        {m.cm_sticky_repost()}
                      </button>
                    {/if}
                    <button
                      type="button"
                      onclick={() => handleDeleteSticky(index)}
                      disabled={stickyBusy === sticky.channelId}
                      class="px-3.5 py-2 bg-error/10 text-error border border-error/20 rounded-lg text-xs font-bold hover:bg-rose-500 hover:text-white transition-all inline-flex items-center gap-2 disabled:opacity-50"
                    >
                      <Papicon icon="trash-2" size={13} />
                      {m.common_delete()}
                    </button>
                    <button
                      type="button"
                      onclick={() => handleSaveSticky(index)}
                      disabled={stickyBusy === sticky.channelId}
                      class="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      {m.common_save()}
                    </button>
                  </div>
                </div>
              {/each}

              <button
                type="button"
                onclick={addSticky}
                class="w-full py-4 border border-dashed border-outline-variant/20 hover:border-primary/40 text-on-surface-variant/60 hover:text-primary transition-all rounded-xl text-xs font-semibold flex items-center justify-center gap-2"
              >
                <Papicon icon="plus" size={16} />
                {m.cm_sticky_add()}
              </button>
            </div>
          {/if}
        </section>

      {:else if activeTab === 'stats'}
        <!-- STATS CHANNELS TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <InlineFeedback message={rescanAction.state.message} error={rescanAction.state.error} />

          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="bar-chart" size={20} class="text-primary" />
                {m.cm_stats_channels_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_stats_channels_desc()}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <input 
                type="checkbox" 
                bind:checked={config.statsEnabled} 
                class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
              />
            </div>
          </div>

          {#if config.statsEnabled}
            <!-- Category Selection for Stats -->
            <div class="space-y-1.5 max-w-xl pb-4 border-b border-outline-variant/10">
              <label for="stats-category-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_stats_category_label()}</label>
              <div class="flex gap-2">
                <div class="flex-1">
                  <SearchableSelect 
                    id="stats-category-select"
                    options={availableCategories.map(c => ({ id: c.id, name: `📁 ${c.name}` }))} 
                    bind:value={config.statsConfig.categoryId} 
                    placeholder={m.cm_create_category_auto_placeholder()}
                  />
                </div>
                <button
                  type="button"
                  onclick={async () => {
                    config.statsConfig.categoryId = '';
                    await handleSave();
                  }}
                  disabled={saveAction.state.loading || loading}
                  class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {m.cm_create_category()}
                </button>
              </div>
            </div>

            <!-- Historical Scraping Trigger -->
            <div class="p-6 bg-primary/5 border border-primary/20 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div class="space-y-1">
                <h4 class="text-sm font-semibold flex items-center gap-2 text-primary">
                  <Papicon icon="history" size={16} />
                  {m.cm_rebuild_historical_stats_title()}
                </h4>
                <p class="text-xs text-on-surface-variant/60">
                  {m.cm_rebuild_historical_stats_desc()}
                </p>
              </div>
              <div class="flex gap-2 w-full md:w-auto">
                <button
                  type="button"
                  onclick={async () => {
                    await handleRescanStats(false);
                  }}
                  disabled={rescanAction.state.loading || loading}
                  class="px-5 py-3 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed flex-1 md:flex-none"
                >
                  {m.cm_launch_scan()}
                </button>
                <button
                  type="button"
                  onclick={async () => {
                    if (await confirmDialog.ask({ title: m.cm_confirm_recompute_title(), description: m.cm_confirm_recompute_desc(), confirmLabel: m.cm_recompute(), variant: 'warning' })) {
                      await handleRescanStats(true);
                    }
                  }}
                  disabled={rescanAction.state.loading || loading}
                  class="px-5 py-3 bg-error/10 hover:bg-error/20 text-error border border-error/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed flex-1 md:flex-none"
                >
                  {m.cm_force_rescan()}
                </button>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
              <!-- Member Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-member-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_member_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.memberEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.memberEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-member-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.memberChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.memberChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.memberTemplate} 
                    placeholder={m.cm_template_members_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Bot Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-bot-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_bot_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.botEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.botEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-bot-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.botChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.botChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.botTemplate} 
                    placeholder={m.cm_template_bots_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Role Member Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-role-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_role_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.roleEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.roleEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-role-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.roleChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.roleChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <SearchableSelect 
                    options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                    bind:value={config.statsConfig.roleTargetId} 
                    placeholder={m.cm_select_target_role_placeholder()}
                  />
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.roleTemplate} 
                    placeholder={m.cm_template_staff_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Channels Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-channel-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_channel_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.channelEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.channelEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-channel-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.channelChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.channelChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.channelTemplate} 
                    placeholder={m.cm_template_channels_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Categories Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-category-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_category_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.categoryEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.categoryEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-category-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.categoryChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.categoryChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.categoryTemplate} 
                    placeholder={m.cm_template_categories_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>

              <!-- Activity Count -->
              <div class="space-y-3 p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                <div class="flex items-center justify-between">
                  <label for="stats-activity-channel" class="text-xs font-bold text-on-surface/80 block">{m.cm_activity_counter_label()}</label>
                  <input 
                    type="checkbox" 
                    bind:checked={config.statsConfig.activityEnabled} 
                    class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                  />
                </div>
                {#if config.statsConfig.activityEnabled}
                  <div class="flex gap-2">
                    <div class="flex-1">
                      <SearchableSelect 
                        id="stats-activity-channel"
                        options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                        bind:value={config.statsConfig.activityChannelId} 
                        placeholder={m.cm_create_channel_auto_placeholder()}
                      />
                    </div>
                    <button
                      type="button"
                      onclick={async () => {
                        config.statsConfig.activityChannelId = '';
                        await handleSave();
                      }}
                      disabled={saveAction.state.loading || loading}
                      class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {m.cm_create_channel()}
                    </button>
                  </div>
                  <input 
                    type="text" 
                    bind:value={config.statsConfig.activityTemplate} 
                    placeholder={m.cm_template_activity_placeholder()} 
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                  />
                {/if}
              </div>
            </div>

            <!-- Custom stats channels -->
            <div class="border-t border-outline-variant/10 pt-6 mt-6 space-y-4">
              <div>
                <h4 class="text-sm font-semibold flex items-center gap-2">
                  <Papicon icon="plus-circle" size={16} class="text-primary" />
                  {m.cm_custom_stats_title()}
                </h4>
                <p class="text-xs text-on-surface-variant/60">{m.cm_custom_stats_desc()}</p>
              </div>

              {#if !config.statsConfig.customStats}
                {config.statsConfig.customStats = []}
              {/if}

              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                {#each config.statsConfig.customStats as custom, index}
                  <div class="p-5 bg-surface-container-high/10 border border-outline-variant/5 rounded-xl space-y-4 transition-all">
                    <div class="flex items-center justify-between border-b border-outline-variant/10 pb-3 mb-2">
                      <span class="text-xs font-semibold text-primary">{m.cm_counter_n({ n: index + 1 })}</span>
                      <button
                        type="button"
                        onclick={() => {
                          config.statsConfig.customStats = config.statsConfig.customStats.filter((_, i) => i !== index);
                        }}
                        class="text-on-surface-variant/60 hover:text-error transition-all flex items-center gap-1.5 text-xs font-bold"
                        title={m.cm_delete_counter_title()}
                      >
                        <Papicon icon="trash-2" size={14} />
                        {m.common_delete()}
                      </button>
                    </div>

                    <div class="space-y-4">
                      <!-- Enabled checkbox & Type -->
                      <div class="space-y-1.5">
                        <div class="flex items-center justify-between">
                          <label for="custom-type-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_stat_type_label()}</label>
                          <label class="flex items-center gap-2 text-xs font-bold text-on-surface/80 cursor-pointer">
                            {m.cm_enable_verb()}
                            <input 
                              type="checkbox" 
                              bind:checked={custom.enabled} 
                              class="w-8 h-5 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-3 before:transition-all"
                            />
                          </label>
                        </div>
                        <select
                          id="custom-type-{index}"
                          bind:value={custom.type}
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                        >
                          <option value="members">{m.cm_opt_members_total()}</option>
                          <option value="bots">{m.cm_opt_bots_total()}</option>
                          <option value="online">{m.cm_opt_members_online()}</option>
                          <option value="voice">{m.cm_opt_members_voice()}</option>
                          <option value="role">{m.cm_opt_specific_role()}</option>
                          <option value="channels">{m.cm_opt_channels_total()}</option>
                          <option value="categories">{m.cm_opt_categories_total()}</option>
                          <option value="activity">{m.cm_opt_activity_24h()}</option>
                          <option value="boosts">{m.cm_opt_server_boosts()}</option>
                          <option value="goal">{m.cm_opt_member_goal()}</option>
                        </select>
                      </div>

                      <!-- Channel Selection -->
                      <div class="space-y-1.5">
                        <label for="custom-channel-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_voice_channel_label()}</label>
                        {#if custom.enabled}
                          <div class="flex gap-2">
                            <div class="flex-1">
                              <SearchableSelect 
                                id="custom-channel-{index}"
                                options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                                bind:value={custom.channelId} 
                                placeholder={m.cm_create_channel_auto_placeholder()}
                              />
                            </div>
                            <button
                              type="button"
                              onclick={async () => {
                                custom.channelId = '';
                                await handleSave();
                              }}
                              disabled={saveAction.state.loading || loading}
                              class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {m.cm_create_short()}
                            </button>
                          </div>
                        {:else}
                          <div class="text-xs text-on-surface-variant/40 bg-surface-container-high/20 border border-outline-variant/10 rounded-lg px-4 py-2.5">
                            {m.cm_counter_disabled()}
                          </div>
                        {/if}
                      </div>

                      <!-- Conditional field: Role ID -->
                      {#if custom.type === 'role'}
                        <div class="space-y-1.5">
                          <label for="custom-role-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_target_role_label()}</label>
                          <SearchableSelect 
                            id="custom-role-select-{index}"
                            options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                            bind:value={custom.roleTargetId} 
                            placeholder={m.cm_select_target_role_placeholder()}
                          />
                        </div>
                      {/if}

                      <!-- Conditional field: Member Goal -->
                      {#if custom.type === 'goal'}
                        <div class="space-y-1.5">
                          <label for="custom-goal-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_goal_target_label()}</label>
                          <input 
                            id="custom-goal-{index}"
                            type="number"
                            bind:value={custom.goalTarget}
                            placeholder={m.cm_goal_example_placeholder()}
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                          />
                        </div>
                      {/if}

                      <!-- Template -->
                      <div class="space-y-1.5">
                        <label for="custom-template-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_name_template_label()}</label>
                        <input 
                          id="custom-template-{index}"
                          type="text" 
                          bind:value={custom.template} 
                          placeholder={custom.type === 'goal' ? m.cm_template_goal_placeholder() : m.cm_template_name_placeholder()} 
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                        />
                        <p class="text-2xs text-on-surface-variant/40 mt-1">
                          {m.cm_count_placeholder_hint({ code: '{count}' })}
                          {#if custom.type === 'goal'}
                            {m.cm_goal_placeholder_hint({ code: '{goal}' })}
                          {/if}
                        </p>
                      </div>
                    </div>
                  </div>
                {/each}

                <button
                  type="button"
                  onclick={() => {
                    config.statsConfig.customStats = [
                      ...(config.statsConfig.customStats || []),
                      {
                        enabled: true,
                        type: 'members',
                        channelId: '',
                        template: '👤 Members: {count}',
                        roleTargetId: '',
                        goalTarget: 1000
                      }
                    ];
                  }}
                  class="col-span-1 md:col-span-2 py-4 border border-dashed border-outline-variant/20 hover:border-primary/40 text-on-surface-variant/60 hover:text-primary transition-all rounded-xl text-xs font-semibold flex items-center justify-center gap-2"
                >
                  <Papicon icon="plus" size={16} />
                  {m.cm_add_custom_counter()}
                </button>
              </div>
            </div>
            <p class="text-2xs text-on-surface-variant/40 mt-4 block">{m.cm_stats_refresh_hint()}</p>
          {/if}
        </section>

      {:else if activeTab === 'temp-voice'}
        <!-- DYNAMIC VOCAL CREATORS TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="volume-2" size={20} class="text-primary" />
                {m.cm_temp_voice_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_temp_voice_desc()}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <input 
                type="checkbox" 
                bind:checked={config.tempVoiceEnabled} 
                class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
              />
            </div>
          </div>

          {#if config.tempVoiceEnabled}
            <div class="space-y-4 pt-4 border-t border-outline-variant/10 max-w-xl">
              <!-- Generator Voice Channel Selection -->
              <div class="space-y-1.5">
                <label for="temp-voice-channel-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_generator_voice_channel_label()}</label>
                <div class="flex gap-2">
                  <div class="flex-1">
                    <SearchableSelect 
                      id="temp-voice-channel-select"
                      options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                      bind:value={config.tempVoiceChannelId} 
                      placeholder={m.cm_create_channel_auto_placeholder()}
                    />
                  </div>
                  <button
                    type="button"
                    onclick={async () => {
                      config.tempVoiceChannelId = '';
                      await handleSave();
                    }}
                    disabled={saveAction.state.loading || loading}
                    class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {m.cm_create_channel()}
                  </button>
                </div>
              </div>

              <!-- Target Category Selection -->
              <div class="space-y-1.5">
                <label for="temp-voice-category-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_creation_category_label()}</label>
                <div class="flex gap-2">
                  <div class="flex-1">
                    <SearchableSelect 
                      id="temp-voice-category-select"
                      options={availableCategories.map(c => ({ id: c.id, name: `📁 ${c.name}` }))} 
                      bind:value={config.tempVoiceCategoryId} 
                      placeholder={m.cm_create_category_auto_placeholder()}
                    />
                  </div>
                  <button
                    type="button"
                    onclick={async () => {
                      config.tempVoiceCategoryId = '';
                      await handleSave();
                    }}
                    disabled={saveAction.state.loading || loading}
                    class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {m.cm_create_category()}
                  </button>
                </div>
              </div>

              <!-- Name Template -->
              <div class="space-y-1.5">
                <label for="temp-voice-name-template-input" class="text-xs font-bold text-on-surface/80 block">{m.cm_name_template_channel_label()}</label>
                <input 
                  id="temp-voice-name-template-input"
                  type="text" 
                  bind:value={config.tempVoiceNameTemplate} 
                  placeholder={m.cm_template_user_placeholder()} 
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30 transition-all"
                />
                <p class="text-2xs text-on-surface-variant/40 mt-1">{m.cm_user_placeholder_hint({ code: '{user}' })}</p>
              </div>

              <!-- Role Restriction Selection -->
              <div class="space-y-1.5">
                <label for="temp-voice-role-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_required_role_label()}</label>
                <SearchableSelect 
                  id="temp-voice-role-select"
                  options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                  bind:value={config.tempVoiceRequiredRoleId} 
                  placeholder={m.cm_no_role_required_open_placeholder()}
                />
                <p class="text-2xs text-on-surface-variant/40">{m.cm_required_role_scope_hint()}</p>
              </div>

              <!-- Permissions appliquées aux salons créés -->
              <TempVoicePolicyEditor
                bind:policy={config.tempVoiceDefaults}
                availableRoles={autoAllowableRoles}
                idPrefix="temp-voice-main"
              />

              {#if !config.tempVoiceGenerators}
                {config.tempVoiceGenerators = []}
              {/if}

              <!-- Secondary Voice Generators List -->
              <div class="border-t border-outline-variant/10 pt-6 mt-6 space-y-4">
                <div>
                  <h4 class="text-sm font-semibold flex items-center gap-2 text-primary">
                    <Papicon icon="plus-circle" size={16} />
                    {m.cm_additional_generators_title()}
                  </h4>
                  <p class="text-xs text-on-surface-variant/60">{m.cm_additional_generators_desc()}</p>
                </div>

                <!-- Un sélecteur de surcharge de présentation, réutilisé cinq
                     fois par carte de générateur : la valeur en cours
                     (`current`, absente/`null` = hérite), la valeur du serveur
                     (`serverValue`, pour l'option « Hérite ») et la liste des
                     valeurs possibles. `onSelect('')` retire la clé au lieu de
                     la poser à `undefined` : `lireSurchargesPresentation`
                     (tempVoiceService.ts) distingue absente (hérite) de
                     posée-mais-fausse. -->
                {#snippet presentationOverrideSelect(
                  id: string,
                  labelText: string,
                  current: string | null | undefined,
                  serverValue: string,
                  options: Array<{ key: string; label: () => string }>,
                  onSelect: (value: string) => void,
                )}
                  <div class="space-y-1">
                    <label for={id} class="text-2xs font-bold text-on-surface-variant/60 block">{labelText}</label>
                    <select
                      {id}
                      value={current ?? ''}
                      onchange={(e) => onSelect((e.currentTarget as HTMLSelectElement).value)}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-2xs outline-none focus:ring-1 focus:ring-primary/30"
                    >
                      <option value="">{m.cm_tv_panel_per_gen_inherit({ value: labelFor(serverValue, options) })}</option>
                      {#each options as opt (opt.key)}
                        <option value={opt.key}>{opt.label()}</option>
                      {/each}
                    </select>
                  </div>
                {/snippet}

                <div class="grid grid-cols-1 gap-6">
                  {#each config.tempVoiceGenerators as generator, index}
                    <div class="p-5 bg-surface-container-high/10 border border-outline-variant/5 rounded-xl space-y-4 transition-all">
                      <div class="flex items-center justify-between border-b border-outline-variant/10 pb-3 mb-2">
                        <span class="flex items-center gap-2">
                          <span class="text-xs font-semibold text-primary">{m.cm_generator_n({ n: index + 2 })}</span>
                          {#if config.tempVoiceModPermissions.perGeneratorPresentation}
                            {#if generatorOverrideCount(generator) > 0}
                              <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                {m.cm_tv_panel_per_gen_badge_overrides({ count: generatorOverrideCount(generator) })}
                              </span>
                            {:else}
                              <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-surface-container-high/40 text-on-surface-variant/60">
                                {m.cm_tv_panel_per_gen_badge_inherits()}
                              </span>
                            {/if}
                          {/if}
                        </span>
                        <button
                          type="button"
                          onclick={() => {
                            config.tempVoiceGenerators = config.tempVoiceGenerators.filter((_, i) => i !== index);
                          }}
                          class="text-on-surface-variant/60 hover:text-error transition-all flex items-center gap-1.5 text-xs font-bold"
                          title={m.cm_delete_generator_title()}
                        >
                          <Papicon icon="trash-2" size={14} />
                          {m.common_delete()}
                        </button>
                      </div>

                      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <!-- Generator Voice Channel Selection -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-channel-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_generator_voice_channel_label()}</label>
                          <div class="flex gap-2">
                            <div class="flex-1">
                              <SearchableSelect 
                                id="temp-voice-channel-select-{index}"
                                options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))} 
                                bind:value={generator.channelId} 
                                placeholder={m.cm_create_auto_placeholder()}
                              />
                            </div>
                            <button
                              type="button"
                              onclick={async () => {
                                generator.channelId = '';
                                await handleSave();
                              }}
                              disabled={saveAction.state.loading || loading}
                              class="px-3 py-2.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all"
                            >
                              {m.cm_create_short()}
                            </button>
                          </div>
                        </div>

                        <!-- Target Category Selection -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-category-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_creation_category_label()}</label>
                          <div class="flex gap-2">
                            <div class="flex-1">
                              <SearchableSelect 
                                id="temp-voice-category-select-{index}"
                                options={availableCategories.map(c => ({ id: c.id, name: `📁 ${c.name}` }))} 
                                bind:value={generator.categoryId} 
                                placeholder={m.cm_create_auto_placeholder()}
                              />
                            </div>
                            <button
                              type="button"
                              onclick={async () => {
                                generator.categoryId = '';
                                await handleSave();
                              }}
                              disabled={saveAction.state.loading || loading}
                              class="px-3 py-2.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all"
                            >
                              {m.cm_create_short()}
                            </button>
                          </div>
                        </div>

                        <!-- Name Template -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-name-template-input-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_name_template_channel_label()}</label>
                          <input 
                            id="temp-voice-name-template-input-{index}"
                            type="text" 
                            bind:value={generator.nameTemplate} 
                            placeholder={m.cm_template_user_placeholder()} 
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                          />
                        </div>

                        <!-- Required Role Selector -->
                        <div class="space-y-1.5">
                          <label for="temp-voice-role-select-{index}" class="text-xs font-bold text-on-surface/80 block">{m.cm_required_role_short_label()}</label>
                          <SearchableSelect 
                            id="temp-voice-role-select-{index}"
                            options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                            bind:value={generator.requiredRoleId} 
                            placeholder={m.cm_no_role_public_placeholder()}
                          />
                        </div>
                      </div>

                      <!-- Chaque generateur a ses propres permissions : un salon
                           « Staff » et un salon « Public » n'accordent pas la
                           meme chose a leur proprietaire. -->
                      <TempVoicePolicyEditor
                        bind:policy={config.tempVoiceGenerators[index]}
                        availableRoles={autoAllowableRoles}
                        idPrefix="temp-voice-gen-{index}"
                      />

                      <!-- Surcharge de présentation : seulement si
                           l'interrupteur du bloc "Panel presentation"
                           ci-dessous est coché. Interrupteur coupé, cette carte
                           est identique à ce qu'elle affichait avant cette
                           fonctionnalité. -->
                      {#if config.tempVoiceModPermissions.perGeneratorPresentation}
                        <div class="border-t border-outline-variant/10 pt-4 mt-2 space-y-3">
                          <div>
                            <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_panel_per_gen_override_title()}</span>
                            <p class="text-2xs text-on-surface-variant/40">{m.cm_tv_panel_per_gen_override_desc()}</p>
                          </div>
                          <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                            {@render presentationOverrideSelect(
                              `gen-${index}-panel-mode`,
                              m.cm_tv_panel_mode_label(),
                              generator.panelMode,
                              config.tempVoiceModPermissions.panelMode,
                              PANEL_MODES,
                              (v) => { if (v) generator.panelMode = v as TempVoicePanelMode; else delete generator.panelMode; },
                            )}
                            {@render presentationOverrideSelect(
                              `gen-${index}-panel-components`,
                              m.cm_tv_panel_components_label(),
                              generator.panelComponents,
                              config.tempVoiceModPermissions.panelComponents,
                              PANEL_COMPONENTS_MODES,
                              (v) => { if (v) generator.panelComponents = v as TempVoicePanelComponents; else delete generator.panelComponents; },
                            )}
                            {@render presentationOverrideSelect(
                              `gen-${index}-state-layout`,
                              m.cm_tv_panel_state_layout_label(),
                              generator.stateLayout,
                              config.tempVoiceModPermissions.stateLayout,
                              STATE_LAYOUT_MODES,
                              (v) => { if (v) generator.stateLayout = v as TempVoiceStateLayout; else delete generator.stateLayout; },
                            )}
                            {@render presentationOverrideSelect(
                              `gen-${index}-state-colors`,
                              m.cm_tv_panel_state_colors_label(),
                              generator.stateColors,
                              config.tempVoiceModPermissions.stateColors,
                              STATE_COLORS_MODES,
                              (v) => { if (v) generator.stateColors = v as TempVoiceStateColors; else delete generator.stateColors; },
                            )}
                            {@render presentationOverrideSelect(
                              `gen-${index}-reservation-fallback`,
                              m.cm_tv_panel_reservation_fallback_label(),
                              generator.reservationFallbackMode,
                              config.tempVoiceModPermissions.reservationFallbackMode,
                              RESERVATION_FALLBACK_MODES,
                              (v) => { if (v) generator.reservationFallbackMode = v as TempVoiceReservationFallback; else delete generator.reservationFallbackMode; },
                            )}
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/each}

                  {#if (config.tempVoiceGenerators?.length ?? 0) < MAX_ADDITIONAL_GENERATORS}
                    <button
                      type="button"
                      onclick={() => {
                        config.tempVoiceGenerators = [
                          ...(config.tempVoiceGenerators || []),
                          {
                            channelId: '',
                            categoryId: '',
                            nameTemplate: '🔊 {user}\'s channel',
                            requiredRoleId: '',
                            ...defaultTempVoicePolicy()
                          }
                        ];
                      }}
                      class="py-4 border border-dashed border-outline-variant/20 hover:border-primary/40 text-on-surface-variant/60 hover:text-primary transition-all rounded-xl text-xs font-semibold flex items-center justify-center gap-2"
                    >
                      <Papicon icon="plus" size={16} />
                      {m.cm_add_extra_generator()}
                    </button>
                  {/if}
                </div>
              </div>

              <!-- Description of Chat Control Embed -->
              <div class="p-5 bg-primary/5 border border-primary/20 rounded-xl mt-4">
                <h4 class="text-xs font-semibold text-primary mb-2">{m.cm_management_embed_title()}</h4>
                <p class="text-xs text-on-surface-variant/80 leading-relaxed">
                  {m.cm_management_embed_intro()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_lock()}</strong> {m.cm_embed_bullet_lock_desc()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_rename()}</strong> {m.cm_embed_bullet_rename_desc()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_limit()}</strong> {m.cm_embed_bullet_limit_desc()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_kick()}</strong> {m.cm_embed_bullet_kick_desc()}
                  <br/><strong class="text-on-surface font-semibold">• {m.cm_embed_bullet_chat()}</strong> {m.cm_embed_bullet_chat_desc()}
                </p>
              </div>
            </div>
          {/if}
        </section>

        {#if config.tempVoiceEnabled}
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 mt-6">
            <div class="flex items-center justify-between border-b border-outline-variant/10 pb-4">
              <div>
                <h3 class="text-xl font-semibold flex items-center gap-3">
                  <Papicon icon="volume-2" size={20} class="text-primary" />
                  {m.cm_active_temp_channels_title()}
                </h3>
                <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_active_temp_channels_desc()}</p>
              </div>
              
              <button
                type="button"
                onclick={loadActiveTempChannels}
                disabled={loadingTempChannels}
                class="px-3.5 py-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all flex items-center gap-2"
              >
                <Papicon icon="refresh" size={14} class={loadingTempChannels ? "animate-spin" : ""} />
                {m.common_refresh()}
              </button>
            </div>

            {#if loadingTempChannels}
              <div class="flex items-center justify-center py-12">
                <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
              </div>
            {:else if activeTempChannels.length === 0}
              <div class="flex flex-col items-center justify-center py-12 text-on-surface-variant/30">
                <Papicon icon="volume-x" size={32} class="opacity-50 mb-2" />
                <p class="text-xs font-bold">{m.cm_no_active_temp_channel()}</p>
              </div>
            {:else}
              <!-- Desktop Table -->
              <div class="hidden md:block overflow-x-auto w-full">
                <table class="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr class="border-b border-outline-variant/15 text-xs font-medium text-on-surface-variant/70">
                      <th class="py-3 px-4">{m.cm_col_channel_name()}</th>
                      <th class="py-3 px-4">{m.cm_col_creator()}</th>
                      <th class="py-3 px-4 text-center">{m.cm_col_members()}</th>
                      <th class="py-3 px-4">{m.cm_col_reservation()}</th>
                      <th class="py-3 px-4 text-right">{m.cm_col_actions()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each activeTempChannels as chan}
                      <tr class="border-b border-outline-variant/10 hover:bg-white/5 transition-colors">
                        <td class="py-3 px-4">
                          {#if editingChannel === chan.id}
                            <div class="flex items-center gap-2">
                              <input 
                                type="text" 
                                bind:value={newChannelName}
                                class="bg-surface-container-high/40 border border-outline-variant/20 rounded-md px-2.5 py-1 text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary/50"
                              />
                              <button
                                type="button"
                                onclick={() => handleRenameChannel(chan.id)}
                                disabled={actionInProgress}
                                class="px-2 py-1 bg-primary text-white text-2xs font-semibold rounded-md active:scale-[0.98] transition-transform"
                              >
                                {m.cm_validate()}
                              </button>
                              <button
                                type="button"
                                onclick={() => editingChannel = null}
                                class="px-2 py-1 bg-surface-container text-on-surface text-2xs font-semibold rounded-md border border-outline-variant/20"
                              >
                                {m.common_cancel()}
                              </button>
                            </div>
                          {:else}
                            <div class="flex items-center gap-2">
                              <span class="font-mono text-sm font-bold text-on-surface">🔊 {chan.name}</span>
                              <button
                                type="button"
                                onclick={() => {
                                  editingChannel = chan.id;
                                  newChannelName = chan.name;
                                }}
                                class="text-on-surface-variant/40 hover:text-primary transition-colors"
                                title={m.cm_rename_title()}
                              >
                                <Papicon icon="edit" size={13} />
                              </button>
                            </div>
                          {/if}
                        </td>
                        <td class="py-3 px-4">
                          <div class="flex items-center gap-2">
                            {#if chan.creatorAvatar}
                              <img src={chan.creatorAvatar} alt={chan.creatorName} class="w-6 h-6 rounded-full border border-outline-variant/10" />
                            {:else}
                              <div class="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">
                                {chan.creatorName.slice(0, 1).toUpperCase()}
                              </div>
                            {/if}
                            <span class="text-xs text-on-surface-variant font-medium">{chan.creatorName}</span>
                          </div>
                        </td>
                        <td class="py-3 px-4 text-center">
                          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-primary/10 text-primary border border-primary/20">
                            <Papicon icon="user" size={11} />
                            {chan.membersCount}
                          </span>
                        </td>
                        <td class="py-3 px-4">
                          <div class="max-w-[200px]">
                            <SearchableSelect 
                              options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                              value={chan.roleId || ''} 
                              on:change={(e) => handleReserveChannel(chan.id, e.detail.value || null)}
                              placeholder={m.cm_public_no_role_placeholder()}
                            />
                          </div>
                        </td>
                        <td class="py-3 px-4 text-right">
                          <button
                            type="button"
                            onclick={() => handleDeleteChannel(chan.id)}
                            disabled={actionInProgress}
                            class="px-2.5 py-1.5 bg-error/10 text-error border border-error/20 rounded-lg text-xs font-semibold hover:bg-rose-500 hover:text-white transition-all inline-flex items-center gap-1"
                          >
                            <Papicon icon="trash-2" size={12} />
                            {m.common_close()}
                          </button>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <!-- Mobile Cards -->
              <div class="md:hidden space-y-3">
                {#each activeTempChannels as chan}
                  <div class="rounded-xl border border-outline-variant/10 bg-surface-container/20 p-4 space-y-3">
                    <div class="flex items-center justify-between">
                      {#if editingChannel === chan.id}
                        <div class="flex items-center gap-2">
                          <input 
                            type="text" 
                            bind:value={newChannelName}
                            class="bg-surface-container-high/40 border border-outline-variant/20 rounded-md px-2.5 py-1 text-xs text-on-surface outline-none"
                          />
                          <button
                            type="button"
                            onclick={() => handleRenameChannel(chan.id)}
                            disabled={actionInProgress}
                            class="px-2 py-1 bg-primary text-white text-2xs font-semibold rounded-md"
                          >
                            OK
                          </button>
                        </div>
                      {:else}
                        <span class="font-mono text-sm font-bold text-on-surface truncate">🔊 {chan.name}</span>
                        <button
                          type="button"
                          onclick={() => {
                            editingChannel = chan.id;
                            newChannelName = chan.name;
                          }}
                          class="text-on-surface-variant/40 hover:text-primary transition-colors"
                        >
                          <Papicon icon="edit" size={13} />
                        </button>
                      {/if}
                    </div>

                    <div class="flex items-center justify-between text-xs border-t border-b border-outline-variant/5 py-2">
                      <div class="flex items-center gap-1.5">
                        {#if chan.creatorAvatar}
                          <img src={chan.creatorAvatar} alt={chan.creatorName} class="w-5 h-5 rounded-full" />
                        {/if}
                        <span class="text-on-surface-variant">{chan.creatorName}</span>
                      </div>
                      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-primary/10 text-primary border border-primary/20">
                        <Papicon icon="user" size={10} />
                        {chan.membersCount} {m.cm_members_connected_suffix()}
                      </span>
                    </div>

                    <div class="space-y-1">
                      <span class="text-2xs font-bold text-on-surface-variant/60 block">{m.cm_reservation_label()}</span>
                      <SearchableSelect 
                        options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} 
                        value={chan.roleId || ''} 
                        on:change={(e) => handleReserveChannel(chan.id, e.detail.value || null)}
                        placeholder={m.cm_public_no_role_placeholder()}
                      />
                    </div>

                    <div class="flex justify-end pt-1">
                      <button
                        type="button"
                        onclick={() => handleDeleteChannel(chan.id)}
                        disabled={actionInProgress}
                        class="px-2.5 py-1.5 bg-error/10 text-error border border-error/20 rounded-lg text-xs font-semibold hover:bg-rose-500 hover:text-white transition-all inline-flex items-center gap-1"
                      >
                        <Papicon icon="trash-2" size={12} />
                        {m.cm_close_channel_full()}
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>

          <!-- Présentation du panneau : mode, mise en page de l'état, palette et
               composants (V1/V2) : configurable par serveur, comme le reste de
               tempVoiceModPermissions envoyé en entier à la sauvegarde. Reste
               dans le même {#if config.tempVoiceEnabled} que la section
               voisine : les salons temporaires désactivés, l'onglet ne garde
               que l'interrupteur, pas un bloc de réglages orphelin. -->
          <section class="bg-surface-container-low/30 border border-outline-variant/10 p-5 lg:p-6 rounded-xl space-y-4 mt-6">
            <div>
              <h3 class="text-sm font-semibold text-on-surface">{m.cm_tv_panel_title()}</h3>
              <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.cm_tv_panel_desc()}</p>
            </div>

            <!-- Interrupteur de secours : coupé (défaut), les 5 réglages
                 ci-dessous valent pour TOUS les générateurs et les surcharges
                 des additionnels ne sont même pas lues côté bot
                 (`presentationPourGenerateur`, tempVoiceService.ts) : l'écran
                 reste identique à celui d'avant cette fonctionnalité. Le
                 couper n'efface rien : les surcharges restent dans
                 `tempVoiceGenerators` et reviennent telles quelles au
                 rallumage. -->
            <div class="flex items-center justify-between gap-4 p-4 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl max-w-3xl">
              <div class="space-y-0.5">
                <label for="per-generator-presentation-toggle" class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_panel_per_gen_toggle_label()}</label>
                <p class="text-2xs text-on-surface-variant/60">{m.cm_tv_panel_per_gen_toggle_hint()}</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <input
                  id="per-generator-presentation-toggle"
                  type="checkbox"
                  bind:checked={config.tempVoiceModPermissions.perGeneratorPresentation}
                  class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                />
              </div>
            </div>

            <!-- Cartes-radio, une par option, comme la maquette et comme
                 « Prévenir par » dans l'onglet voisin : le choix et ce qu'il
                 coûte se lisent ensemble, sans ouvrir un menu déroulant. -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl items-start">
              <div class="space-y-2">
                <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_panel_components_label()}</span>
                <div class="space-y-2">
                  {#each PANEL_COMPONENTS_MODES as mode (mode.key)}
                    <label
                      for="tv-panel-components-{mode.key}"
                      class="flex flex-col gap-1 border rounded-lg px-4 py-3 cursor-pointer transition-all {config.tempVoiceModPermissions.panelComponents === mode.key
                        ? 'bg-primary/10 border-primary/40'
                        : 'bg-surface-container-high/20 border-outline-variant/10 hover:border-primary/20'}"
                    >
                      <span class="flex items-center gap-2 text-xs font-bold text-on-surface">
                        <input
                          id="tv-panel-components-{mode.key}"
                          type="radio"
                          value={mode.key}
                          bind:group={config.tempVoiceModPermissions.panelComponents}
                          class="accent-primary w-3.5 h-3.5"
                        />
                        {mode.label()}
                      </span>
                      {#each mode.hints as hint}
                        <span class="text-2xs text-on-surface-variant/60 leading-relaxed">{hint()}</span>
                      {/each}
                    </label>
                  {/each}
                </div>
                <p class="text-2xs text-on-surface-variant/40">{m.cm_tv_panel_components_hint()}</p>
              </div>

              <div class="space-y-2">
                <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_panel_mode_label()}</span>
                <div class="space-y-2">
                  {#each PANEL_MODES as mode (mode.key)}
                    <label
                      for="tv-panel-mode-{mode.key}"
                      class="flex flex-col gap-1 border rounded-lg px-4 py-3 cursor-pointer transition-all {config.tempVoiceModPermissions.panelMode === mode.key
                        ? 'bg-primary/10 border-primary/40'
                        : 'bg-surface-container-high/20 border-outline-variant/10 hover:border-primary/20'}"
                    >
                      <span class="flex items-center gap-2 text-xs font-bold text-on-surface">
                        <input
                          id="tv-panel-mode-{mode.key}"
                          type="radio"
                          value={mode.key}
                          bind:group={config.tempVoiceModPermissions.panelMode}
                          class="accent-primary w-3.5 h-3.5"
                        />
                        {mode.label()}
                      </span>
                      <span class="text-2xs text-on-surface-variant/60 leading-relaxed">{mode.hint()}</span>
                    </label>
                  {/each}
                </div>
              </div>

              <div class="space-y-2">
                <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_panel_state_layout_label()}</span>
                <div class="space-y-2">
                  {#each STATE_LAYOUT_MODES as mode (mode.key)}
                    <label
                      for="tv-state-layout-{mode.key}"
                      class="flex flex-col gap-1 border rounded-lg px-4 py-3 cursor-pointer transition-all {config.tempVoiceModPermissions.stateLayout === mode.key
                        ? 'bg-primary/10 border-primary/40'
                        : 'bg-surface-container-high/20 border-outline-variant/10 hover:border-primary/20'}"
                    >
                      <span class="flex items-center gap-2 text-xs font-bold text-on-surface">
                        <input
                          id="tv-state-layout-{mode.key}"
                          type="radio"
                          value={mode.key}
                          bind:group={config.tempVoiceModPermissions.stateLayout}
                          class="accent-primary w-3.5 h-3.5"
                        />
                        {mode.label()}
                      </span>
                      <span class="text-2xs text-on-surface-variant/60 leading-relaxed">{mode.hint()}</span>
                    </label>
                  {/each}
                </div>
                <!-- Ce que le bot fera de la combinaison réglée EN CE MOMENT
                     (disposition + teinte + composants), et non une paraphrase
                     de la règle : `stateNative` est la seule source, alignée sur
                     `etatRenduNativement` côté bot. -->
                <p class="text-2xs text-on-surface-variant/40">
                  {stateNative
                    ? m.cm_tv_panel_state_layout_native_hint()
                    : m.cm_tv_panel_state_layout_image_hint()}
                </p>
              </div>

              <div class="space-y-2">
                <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_panel_state_colors_label()}</span>
                <div class="space-y-2">
                  {#each STATE_COLORS_MODES as mode (mode.key)}
                    <label
                      for="tv-state-colors-{mode.key}"
                      class="flex flex-col gap-1 border rounded-lg px-4 py-3 transition-all {stateColorsInert
                        ? 'opacity-40 cursor-not-allowed bg-surface-container-high/20 border-outline-variant/10'
                        : config.tempVoiceModPermissions.stateColors === mode.key
                          ? 'bg-primary/10 border-primary/40 cursor-pointer'
                          : 'bg-surface-container-high/20 border-outline-variant/10 hover:border-primary/20 cursor-pointer'}"
                    >
                      <span class="flex items-center gap-2 text-xs font-bold text-on-surface">
                        <input
                          id="tv-state-colors-{mode.key}"
                          type="radio"
                          value={mode.key}
                          disabled={stateColorsInert}
                          bind:group={config.tempVoiceModPermissions.stateColors}
                          class="accent-primary w-3.5 h-3.5 disabled:cursor-not-allowed"
                        />
                        {mode.label()}
                      </span>
                      <span class="text-2xs text-on-surface-variant/60 leading-relaxed">{mode.hint()}</span>
                    </label>
                  {/each}
                </div>
                <p class="text-2xs text-on-surface-variant/40">
                  {stateColorsInert
                    ? m.cm_tv_panel_state_colors_hint_disabled()
                    : m.cm_tv_panel_state_colors_hint()}
                </p>
              </div>
            </div>
          </section>
        {/if}

      {:else if activeTab === 'access-requests'}
        <!-- ACCESS REQUESTS TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="lock" size={20} class="text-primary" />
                {m.cm_ar_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_ar_desc()}</p>
            </div>

            <div class="flex items-center gap-2">
              <input
                type="checkbox"
                bind:checked={config.tempVoiceAccessRequest.enabled}
                class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
              />
            </div>
          </div>

          {#if config.tempVoiceAccessRequest.enabled}
            <div class="space-y-6 pt-4 border-t border-outline-variant/10 max-w-xl">
              <!-- Qui peut répondre -->
              <div class="space-y-1.5">
                <label for="ar-responders-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_ar_responders_label()}</label>
                <select
                  id="ar-responders-select"
                  bind:value={config.tempVoiceAccessRequest.responders}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                >
                  <option value="OWNER">{m.cm_ar_responders_owner()}</option>
                  <option value="OWNER_AND_STAFF">{m.cm_ar_responders_owner_staff()}</option>
                </select>
              </div>

              <!-- Prévenir par : trois options avec description, même forme que
                   le chat textuel du salon dans TempVoicePolicyEditor. -->
              <div class="space-y-2">
                <span class="text-xs font-bold text-on-surface/80 block">{m.cm_ar_notify_label()}</span>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {#each NOTIFY_MODES as mode (mode.key)}
                    <label
                      for="ar-notify-{mode.key}"
                      class="flex flex-col gap-1 border rounded-lg px-4 py-3 cursor-pointer transition-all {config.tempVoiceAccessRequest.notifyVia === mode.key
                        ? 'bg-primary/10 border-primary/40'
                        : 'bg-surface-container-high/20 border-outline-variant/10 hover:border-primary/20'}"
                    >
                      <span class="flex items-center gap-2 text-xs font-bold text-on-surface">
                        <input
                          id="ar-notify-{mode.key}"
                          type="radio"
                          value={mode.key}
                          bind:group={config.tempVoiceAccessRequest.notifyVia}
                          class="accent-primary w-3.5 h-3.5"
                        />
                        {mode.label()}
                      </span>
                      <span class="text-2xs text-on-surface-variant/60 leading-relaxed">{mode.hint()}</span>
                    </label>
                  {/each}
                </div>
                <p class="text-2xs text-on-surface-variant/40">{m.cm_ar_notify_fallback_hint()}</p>
              </div>

              {#if config.tempVoiceAccessRequest.notifyVia === 'CHANNEL'}
                <div class="space-y-1.5">
                  <label for="ar-dedicated-channel-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_ar_dedicated_channel_label()}</label>
                  <SearchableSelect
                    id="ar-dedicated-channel-select"
                    options={channelOptions(config.tempVoiceAccessRequest.notifyChannelId)}
                    value={config.tempVoiceAccessRequest.notifyChannelId ?? ''}
                    on:change={(e) => { config.tempVoiceAccessRequest.notifyChannelId = (e.detail?.value as string | undefined) || null; }}
                    placeholder={m.cm_select_channel_placeholder()}
                  />
                </div>
              {/if}

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label for="ar-expiry-input" class="text-xs font-bold text-on-surface/80 block">{m.cm_ar_expiry_label()}</label>
                  <input
                    id="ar-expiry-input"
                    type="number"
                    min="1"
                    max="1440"
                    bind:value={config.tempVoiceAccessRequest.requestExpiresMinutes}
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                  />
                  <p class="text-2xs text-on-surface-variant/40">{m.cm_ar_expiry_hint()}</p>
                </div>

                <div class="space-y-1.5">
                  <label for="ar-cooldown-input" class="text-xs font-bold text-on-surface/80 block">{m.cm_ar_cooldown_label()}</label>
                  <input
                    id="ar-cooldown-input"
                    type="number"
                    min="0"
                    max="1440"
                    bind:value={config.tempVoiceAccessRequest.denyCooldownMinutes}
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                  />
                  <p class="text-2xs text-on-surface-variant/40">{m.cm_ar_cooldown_hint()}</p>
                </div>
              </div>
            </div>
          {/if}
        </section>

        <!-- RÉGLAGES ADMIN : ce que le staff a le droit de faire sur TOUS les
             salons temporaires, action par action. Se branche sur les rôles
             déjà reconnus comme staff (isStaff), réglés dans Gestion du staff -
             pas un troisième système de rôles. -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 mt-6">
          <div>
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="shield" size={20} class="text-primary" />
              {m.cm_ar_admin_title()}
            </h3>
            <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_ar_admin_desc()}</p>
          </div>

          <div class="grid grid-cols-1 gap-3 max-w-xl">
            {#each ADMIN_PERMISSION_ROWS as row (row.key)}
              <div class="flex items-center justify-between gap-4 p-4 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl">
                <span class="text-xs font-bold text-on-surface/80">{row.label()}</span>
                <select
                  value={config.tempVoiceModPermissions[row.key] ? 'true' : 'false'}
                  onchange={(e) => {
                    config.tempVoiceModPermissions[row.key] = (e.currentTarget as HTMLSelectElement).value === 'true';
                  }}
                  class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                >
                  <option value="true">{m.cm_ar_admin_opt_staff()}</option>
                  <option value="false">{m.cm_ar_admin_opt_admin_only()}</option>
                </select>
              </div>
            {/each}
          </div>

          <p class="text-2xs text-on-surface-variant/40">{m.cm_ar_admin_footer()}</p>

          <!-- Panneau compact : pas une permission modérateur mais un choix de
               présentation des sous-panneaux éphémères. Séparé des sept lignes
               ci-dessus par ce séparateur, pas mélangé dans ADMIN_PERMISSION_ROWS. -->
          <div class="border-t border-outline-variant/10 pt-6 mt-2 max-w-xl">
            <div class="flex items-center justify-between gap-4 p-4 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl">
              <div class="space-y-0.5">
                <label for="panel-compact-mode-toggle" class="text-xs font-bold text-on-surface/80 block">{m.cm_ar_admin_panel_compact_title()}</label>
                <p class="text-2xs text-on-surface-variant/60">{m.cm_ar_admin_panel_compact_desc()}</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <input
                  id="panel-compact-mode-toggle"
                  type="checkbox"
                  bind:checked={config.tempVoiceModPermissions.panelCompactMode}
                  class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                />
              </div>
            </div>
          </div>

          <!-- Réservation : rôles proposés dans le menu « Réserver le salon »,
               et sort des personnes déjà présentes sans le rôle au moment où
               il est réservé. -->
          <div class="border-t border-outline-variant/10 pt-6 mt-2 space-y-4">
            <div>
              <h4 class="text-sm font-semibold flex items-center gap-2 text-primary">
                <Papicon icon="lock" size={16} />
                {m.cm_ar_reservation_title()}
              </h4>
              <p class="text-xs text-on-surface-variant/60">{m.cm_ar_reservation_desc()}</p>
            </div>

            <div class="space-y-2 max-w-xl">
              <label for="reservation-roles-select" class="text-xs font-bold text-on-surface/80 block">
                {m.cm_ar_reservation_roles_label()}
              </label>
              <p class="text-2xs text-on-surface-variant/40">{m.cm_ar_reservation_roles_hint()}</p>

              {#if config.tempVoiceModPermissions.reservableRoleIds.length > 0}
                <div class="flex flex-wrap gap-2">
                  {#each config.tempVoiceModPermissions.reservableRoleIds as roleId (roleId)}
                    <span class="inline-flex items-center gap-1.5 bg-primary/10 border border-primary/20 text-primary text-2xs font-semibold rounded-full pl-3 pr-1.5 py-1">
                      @{reservableRoleName(roleId)}
                      <button
                        type="button"
                        onclick={() => removeReservableRole(roleId)}
                        class="hover:bg-primary/20 rounded-full p-0.5 transition-all"
                        aria-label={m.cm_ar_reservation_roles_remove({ role: reservableRoleName(roleId) })}
                      >
                        <Papicon icon="x" size={12} />
                      </button>
                    </span>
                  {/each}
                </div>
              {/if}

              {#if config.tempVoiceModPermissions.reservableRoleIds.length >= MAX_RESERVABLE_ROLES}
                <p class="text-2xs text-on-surface-variant/60">{m.cm_ar_reservation_roles_full({ max: MAX_RESERVABLE_ROLES })}</p>
              {:else}
                <SearchableSelect
                  id="reservation-roles-select"
                  options={selectableReservableRoles.map((role) => ({ id: role.id, name: `@${role.name}` }))}
                  bind:value={reservableRoleToAdd}
                  placeholder={m.cm_ar_reservation_roles_placeholder()}
                  on:change={(event) => addReservableRole((event.detail?.value as string | undefined) ?? reservableRoleToAdd)}
                />
              {/if}
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-xl">
              <div class="space-y-1.5">
                <label for="reservation-overflow-select" class="text-xs font-bold text-on-surface/80 block">
                  {m.cm_ar_reservation_overflow_label()}
                </label>
                <select
                  id="reservation-overflow-select"
                  value={config.tempVoiceModPermissions.reservationOverflow}
                  onchange={(e) => {
                    config.tempVoiceModPermissions.reservationOverflow = (e.currentTarget as HTMLSelectElement).value as TempVoiceReservationOverflow;
                  }}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {#each RESERVATION_OVERFLOW_MODES as mode (mode.key)}
                    <option value={mode.key}>{mode.label()}</option>
                  {/each}
                </select>
              </div>

              {#if config.tempVoiceModPermissions.reservationOverflow === 'MOVE'}
                <div class="space-y-1.5">
                  <label for="reservation-fallback-channel-select" class="text-xs font-bold text-on-surface/80 block">
                    {m.cm_ar_reservation_fallback_label()}
                  </label>
                  <SearchableSelect
                    id="reservation-fallback-channel-select"
                    options={availableVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` }))}
                    value={config.tempVoiceModPermissions.reservationFallbackChannelId ?? ''}
                    on:change={(e) => { config.tempVoiceModPermissions.reservationFallbackChannelId = (e.detail?.value as string | undefined) || null; }}
                    placeholder={m.cm_select_channel_placeholder()}
                  />
                  <p class="text-2xs text-on-surface-variant/40">{m.cm_ar_reservation_fallback_hint()}</p>
                </div>
              {/if}
            </div>

            <!-- Troisième réglage de la MÊME mécanique : quel bouton
                 « Réserver » voit quelqu'un qui n'a aucun des rôles réservables
                 listés juste au-dessus. Il vivait dans « Créer son salon »
                 (Présentation du panneau) : on réglait les rôles ici et leur
                 repli deux onglets plus loin, sans que rien ne relie les deux. -->
            <div class="space-y-1.5 max-w-xl">
              <label for="tv-reservation-fallback-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_panel_reservation_fallback_label()}</label>
              <select
                id="tv-reservation-fallback-select"
                bind:value={config.tempVoiceModPermissions.reservationFallbackMode}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
              >
                <option value="ANY_ROLE">{m.cm_tv_panel_reservation_fallback_any_role()}</option>
                <option value="MEMBERS">{m.cm_tv_panel_reservation_fallback_members()}</option>
                <option value="FORBIDDEN">{m.cm_tv_panel_reservation_fallback_forbidden()}</option>
              </select>
              <p class="text-2xs text-on-surface-variant/40">{m.cm_tv_panel_reservation_fallback_hint()}</p>
            </div>
          </div>
        </section>

      {:else if activeTab === 'honeypot'}
        <!-- HONEYPOT TRAP TAB -->
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xl font-semibold flex items-center gap-3">
                <Papicon icon="shield" size={20} class="text-primary" />
                {m.cm_honeypot_title()}
              </h3>
              <p class="text-xs text-on-surface-variant/60 mt-1">{m.cm_honeypot_desc()}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <input 
                type="checkbox" 
                bind:checked={config.honeypotEnabled} 
                class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
              />
            </div>
          </div>

          {#if config.honeypotEnabled}
            <div class="space-y-6 pt-4 border-t border-outline-variant/10 max-w-xl">
              <!-- Honeypot Channel Selection -->
              <div class="space-y-1.5">
                <label for="honeypot-channel-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_honeypot_channel_label()}</label>
                <div class="flex gap-2">
                  <div class="grow">
                    <SearchableSelect
                      id="honeypot-channel-select"
                      options={channelOptions(config.honeypotChannelId)}
                      bind:value={config.honeypotChannelId}
                      placeholder={m.cm_select_channel_placeholder()}
                    />
                  </div>
                  <button
                    type="button"
                    onclick={async () => {
                      try {
                        const res = await updateChannelsManagementConfig({
                          honeypotEnabled: true,
                          honeypotChannelId: null,
                          createHoneypotChannel: true,
                        });
                        if (res?.resolved?.honeypotChannelId) {
                          config.honeypotChannelId = res.resolved.honeypotChannelId;
                          // SEULS les deux champs que cette requête a réellement
                          // écrits passent dans l'instantané. Un
                          // `savedConfig = structuredClone(config)` marquait
                          // TOUTE la page comme enregistrée : les cinq réglages
                          // du panneau, les permissions, le sticky… tout ce qui
                          // attendait « Enregistrer » disparaissait au prochain
                          // rechargement, sans un mot.
                          savedConfig.honeypotChannelId = config.honeypotChannelId;
                          savedConfig.honeypotEnabled = true;
                          toast.success(m.cm_honeypot_created());
                        }
                      } catch (err) {
                        // Sans ce catch, un refus de la route (400/403) partait
                        // en rejet non traité : le clic ne faisait rien et rien
                        // ne le disait.
                        toast.error(errorMessage(err) || m.cm_save_api_error());
                      }
                    }}
                    disabled={saveAction.state.loading || loading}
                    class="px-4 py-3 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-bold rounded-lg transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {m.cm_create_automatically()}
                  </button>
                </div>
              </div>

              <!-- Honeypot Sanction Selection -->
              <div class="space-y-1.5">
                <label for="honeypot-sanction-select" class="text-xs font-bold text-on-surface/80 block">{m.cm_sanction_to_apply_label()}</label>
                <select
                  id="honeypot-sanction-select"
                  bind:value={config.honeypotSanction}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-xs outline-none focus:ring-1 focus:ring-primary/30"
                >
                  <option value="TIMEOUT">{m.cm_opt_timeout_default()}</option>
                  <option value="BAN">{m.cm_opt_ban_perm()}</option>
                  <option value="SOFTBAN">{m.cm_opt_softban()}</option>
                  <option value="KICK">{m.cm_opt_kick_simple()}</option>
                  <option value="WARN">{m.cm_opt_warn_simple()}</option>
                </select>
                <p class="text-2xs text-on-surface-variant/40 mt-1">{m.cm_sanction_select_hint()}</p>
              </div>

              {#if config.honeypotSanction === 'KICK' || config.honeypotSanction === 'SOFTBAN'}
                <!-- Honeypot Auto Reinvite toggle -->
                <div class="flex items-center justify-between p-5 bg-surface-container-high/20 border border-outline-variant/5 rounded-xl transition-all">
                  <div class="space-y-0.5">
                    <label for="honeypot-reinvite-toggle" class="text-xs font-bold text-on-surface/80 block">{m.cm_auto_reinvite_label()}</label>
                    <p class="text-2xs text-on-surface-variant/60">{m.cm_auto_reinvite_desc()}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <input 
                      id="honeypot-reinvite-toggle"
                      type="checkbox" 
                      bind:checked={config.honeypotReinvite} 
                      class="w-10 h-6 bg-surface-container-high rounded-full relative appearance-none cursor-pointer transition-all border border-outline-variant/20 checked:bg-primary before:content-[''] before:absolute before:h-4 before:w-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 checked:before:translate-x-4 before:transition-all"
                    />
                  </div>
                </div>
              {/if}

              <!-- Alert Warning Card -->
              <div class="p-5 bg-error/10 border border-error/20 text-error rounded-xl space-y-3">
                <h4 class="text-body-sm font-medium flex items-center gap-2">
                  <Papicon icon="alert-triangle" size={16} />
                  {m.cm_security_warning_title()}
                </h4>
                <p class="text-xs leading-relaxed opacity-90">
                  {m.cm_security_warning_body1()}
                  <br/><br/>
                  {m.cm_security_warning_body2({ strong: m.cm_security_warning_strong() })}
                </p>
              </div>
            </div>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</ModulePage>

