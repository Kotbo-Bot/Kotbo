<!--
  Configuration du système de tickets : mode, salons, panneau, accueil,
  types et formulaires, validation, archivage, inactivité, objectifs de
  service, quotas, satisfaction. Onglet autonome de la page Tickets : il lit
  sa configuration complète, l'enregistre, et prévient la page pour qu'elle
  relise la liste.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { m } from '../../i18n';
  import { channelDisplayName } from '../../channelUtils';
  import { guide } from '../../stores/guide.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { isMissingReference } from '../../discordReferences';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import { useUnsavedChanges } from '../../useUnsavedChanges.svelte';
  import { fetchStaffServerChannels, dashboardFetch } from '../../api';
  import { errorMessage } from '@kotbo/shared';
  import Papicon from '../Papicon.svelte';
  import FormInput from '../FormInput.svelte';
  import FormTextarea from '../FormTextarea.svelte';
  import FormSelect from '../FormSelect.svelte';
  import MultiSelect from '../MultiSelect.svelte';
  import FormColorPicker from '../FormColorPicker.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import Callout from '../ui/Callout.svelte';

  const {
    refreshToken = 0,
    onsaved,
  }: {
    /** Incrémenté par la page (bouton Actualiser) pour relire la configuration. */
    refreshToken?: number;
    /** Appelé après un enregistrement : la liste de la page en dépend. */
    onsaved?: () => void;
  } = $props();

  // Configuration Bindings
  let ticketCategoryId = $state('');
  let ticketLogChannelId = $state('');
  let ticketStaffRoleId = $state('');
  let ticketChannelId = $state('');
  let ticketEmbedTitle = $state('');
  let ticketEmbedDesc = $state('');
  let ticketEmbedButtonText = $state('');
  let ticketEmbedColor = $state('');
  let ticketEmbedType = $state<'BUTTONS' | 'DROPDOWN'>('BUTTONS');
  let ticketMode = $state<'CHANNEL' | 'DM' | 'THREAD'>('CHANNEL');
  let ticketDmRelayChannelId = $state('');
  let ticketAllowOverclaim = $state(true);
  let ticketOverclaimPermission = $state('ANY');
  let ticketAutoClaimOnReply = $state(false);
  let ticketInactivityEnabled = $state(false);
  let ticketInactivityHours = $state(24);
  let ticketInactivityMessage = $state('');
  let ticketSatisfactionCommentEnabled = $state(true);
  let ticketSatisfactionCommentQuestion = $state('');
  let ticketSatisfactionCommentTimeout = $state(120);
  let ticketSatisfactionLogChannelId = $state('');
  let ticketSatisfactionLogAnonymous = $state(false);
  let ticketLockUntilClaim = $state(false);
  let ticketApprovalEnabled = $state(false);
  let ticketApprovalChannelId = $state('');
  let ticketArchiveCategoryId = $state('');
  let ticketArchiveKeepOpenerView = $state(false);
  let ticketHistoryPanelEnabled = $state(true);
  let ticketSelfReopenEnabled = $state(true);
  let ticketSelfDeleteEnabled = $state(false);
  // ── Quotas tickets : chaque interrupteur commande, la valeur est un seuil.
  let ticketQuotaOpenEnabled = $state(false);
  let ticketQuotaOpenMax = $state(1);
  let ticketQuotaCooldownEnabled = $state(false);
  let ticketQuotaCooldownMinutes = $state(30);
  let ticketQuotaPeriodEnabled = $state(false);
  let ticketQuotaPeriodMax = $state(5);
  let ticketQuotaPeriodHours = $state(24);
  let ticketQuotaStaffLoadMode = $state('OFF');
  let ticketQuotaStaffLoadMax = $state(5);
  let ticketQuotaStaffLoadBypassRoleIds = $state([] as string[]);
  let ticketQuotaReopenEnabled = $state(false);
  let ticketQuotaReopenMax = $state(3);
  // Objectifs de service, en minutes et en heures ; vide = pas d'objectif.
  let ticketSlaFirstResponseMinutes = $state<number | null>(null);
  let ticketSlaResolutionHours = $state<number | null>(null);
  // Avertissement d'enregistrement montré avant la création d'un ticket.
  let ticketRecordingNoticeEnabled = $state(true);
  let ticketRecordingNoticeSeconds = $state(10);
  let ticketRecordingNoticeText = $state('');
  let ticketEmbedThumbnail = $state('');
  let ticketEmbedImage = $state('');
  let ticketEmbedFooter = $state('');
  let ticketEmbedAuthorName = $state('');
  let ticketEmbedAuthorIcon = $state('');
  let ticketWelcomeTitle = $state('');
  let ticketWelcomeDesc = $state('');
  let ticketWelcomeColor = $state('');
  let ticketWelcomeThumbnail = $state('');
  let ticketWelcomeImage = $state('');
  let ticketWelcomeFooter = $state('');
  let ticketTypes = $state<Array<{
    id: string;
    label: string;
    description: string;
    emoji: string;
    categoryId: string;
    staffRoleId: string;
    buttonStyle: 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';
    mode: '' | 'CHANNEL' | 'DM' | 'THREAD';
    anonymous: boolean;
    staffServerRelay: boolean;
    staffServerChannel: boolean;
    staffServerCategoryId: string;
    /** Tri-etat : '' herite du serveur, 'YES'/'NO' tranchent pour ce type. */
    lockUntilClaim: '' | 'YES' | 'NO';
    requireApproval: '' | 'YES' | 'NO';
    formEnabled: boolean;
    formCustomFields: Array<{
      id: string;
      label: string;
      placeholder: string;
      style: 'SHORT' | 'PARAGRAPH' | 'SELECT' | 'RADIO' | 'FILE';
      required: boolean;
      choices?: string[];
      choicesString?: string;
    }>;
  }>>([]);

  // Config sections accordion
  let expandedConfigSection = $state<string | null>('mode');
  let expandedTicketTypeIndex = $state<number | null>(null);

  function toggleConfigSection(section: string) {
    expandedConfigSection = expandedConfigSection === section ? null : section;
  }

  // « Me guider » depuis l'accueil vise un reglage range dans une section
  // repliee : on la deplie pour que le champ soit visible sous la mise en
  // evidence.
  const GUIDED_SECTIONS: Record<string, string> = {
    'tickets-channels': 'channels',
    'tickets-quotas': 'quotas',
  };
  $effect(() => {
    const section = guide.target ? GUIDED_SECTIONS[guide.target] : undefined;
    if (section) untrack(() => (expandedConfigSection = section));
  });

  let savedSettingsConfig = $state<any>(null);

  const currentSettings = $derived({
    ticketCategoryId,
    ticketLogChannelId,
    ticketStaffRoleId,
    ticketChannelId,
    ticketEmbedTitle,
    ticketEmbedDesc,
    ticketEmbedButtonText,
    ticketEmbedColor,
    ticketEmbedType,
    ticketMode,
    ticketDmRelayChannelId,
    ticketAllowOverclaim,
    ticketOverclaimPermission,
    ticketAutoClaimOnReply,
    ticketInactivityEnabled,
    ticketInactivityHours,
    ticketInactivityMessage,
    ticketSatisfactionCommentEnabled,
    ticketSatisfactionCommentQuestion,
    ticketSatisfactionCommentTimeout,
    ticketSatisfactionLogChannelId,
    ticketSatisfactionLogAnonymous,
    ticketLockUntilClaim,
    ticketApprovalEnabled,
    ticketApprovalChannelId,
    ticketArchiveCategoryId,
    ticketArchiveKeepOpenerView,
    ticketHistoryPanelEnabled,
    ticketSelfReopenEnabled,
    ticketSelfDeleteEnabled,
    ticketQuotaOpenEnabled,
    ticketQuotaOpenMax,
    ticketQuotaCooldownEnabled,
    ticketQuotaCooldownMinutes,
    ticketQuotaPeriodEnabled,
    ticketQuotaPeriodMax,
    ticketQuotaPeriodHours,
    ticketQuotaStaffLoadMode,
    ticketQuotaStaffLoadMax,
    ticketQuotaStaffLoadBypassRoleIds,
    ticketQuotaReopenEnabled,
    ticketQuotaReopenMax,
    ticketSlaFirstResponseMinutes,
    ticketSlaResolutionHours,
    ticketRecordingNoticeEnabled,
    ticketRecordingNoticeSeconds,
    ticketRecordingNoticeText,
    ticketTypes,
    ticketEmbedThumbnail,
    ticketEmbedImage,
    ticketEmbedFooter,
    ticketEmbedAuthorName,
    ticketEmbedAuthorIcon,
    ticketWelcomeTitle,
    ticketWelcomeDesc,
    ticketWelcomeColor,
    ticketWelcomeThumbnail,
    ticketWelcomeImage,
    ticketWelcomeFooter
  });

  useUnsavedChanges({
    id: 'tickets',
    label: m.e1_tickets_config_label(),
    getConfig: () => currentSettings,
    getSaved: () => savedSettingsConfig,
    onSave: () => saveSettings(),
    onReset: () => restoreSettingsConfig(),
    canEdit: () => savedSettingsConfig !== null
  });

  function restoreSettingsConfig() {
    if (!savedSettingsConfig) return;
    ticketCategoryId = savedSettingsConfig.ticketCategoryId;
    ticketLogChannelId = savedSettingsConfig.ticketLogChannelId;
    ticketStaffRoleId = savedSettingsConfig.ticketStaffRoleId;
    ticketChannelId = savedSettingsConfig.ticketChannelId;
    ticketEmbedTitle = savedSettingsConfig.ticketEmbedTitle;
    ticketEmbedDesc = savedSettingsConfig.ticketEmbedDesc;
    ticketEmbedButtonText = savedSettingsConfig.ticketEmbedButtonText;
    ticketEmbedColor = savedSettingsConfig.ticketEmbedColor;
    ticketEmbedType = savedSettingsConfig.ticketEmbedType;
    ticketMode = savedSettingsConfig.ticketMode;
    ticketDmRelayChannelId = savedSettingsConfig.ticketDmRelayChannelId;
    ticketAllowOverclaim = savedSettingsConfig.ticketAllowOverclaim;
    ticketOverclaimPermission = savedSettingsConfig.ticketOverclaimPermission;
    ticketAutoClaimOnReply = savedSettingsConfig.ticketAutoClaimOnReply;
    ticketInactivityEnabled = savedSettingsConfig.ticketInactivityEnabled;
    ticketInactivityHours = savedSettingsConfig.ticketInactivityHours;
    ticketInactivityMessage = savedSettingsConfig.ticketInactivityMessage;
    ticketSatisfactionCommentEnabled = savedSettingsConfig.ticketSatisfactionCommentEnabled;
    ticketSatisfactionCommentQuestion = savedSettingsConfig.ticketSatisfactionCommentQuestion;
    ticketSatisfactionCommentTimeout = savedSettingsConfig.ticketSatisfactionCommentTimeout;
    ticketSatisfactionLogChannelId = savedSettingsConfig.ticketSatisfactionLogChannelId;
    ticketSatisfactionLogAnonymous = savedSettingsConfig.ticketSatisfactionLogAnonymous;
    ticketLockUntilClaim = savedSettingsConfig.ticketLockUntilClaim;
    ticketApprovalEnabled = savedSettingsConfig.ticketApprovalEnabled;
    ticketApprovalChannelId = savedSettingsConfig.ticketApprovalChannelId;
    ticketArchiveCategoryId = savedSettingsConfig.ticketArchiveCategoryId;
    ticketArchiveKeepOpenerView = savedSettingsConfig.ticketArchiveKeepOpenerView;
    ticketHistoryPanelEnabled = savedSettingsConfig.ticketHistoryPanelEnabled;
    ticketSelfReopenEnabled = savedSettingsConfig.ticketSelfReopenEnabled;
    ticketSelfDeleteEnabled = savedSettingsConfig.ticketSelfDeleteEnabled;
    ticketQuotaOpenEnabled = savedSettingsConfig.ticketQuotaOpenEnabled;
    ticketQuotaOpenMax = savedSettingsConfig.ticketQuotaOpenMax;
    ticketQuotaCooldownEnabled = savedSettingsConfig.ticketQuotaCooldownEnabled;
    ticketQuotaCooldownMinutes = savedSettingsConfig.ticketQuotaCooldownMinutes;
    ticketQuotaPeriodEnabled = savedSettingsConfig.ticketQuotaPeriodEnabled;
    ticketQuotaPeriodMax = savedSettingsConfig.ticketQuotaPeriodMax;
    ticketQuotaPeriodHours = savedSettingsConfig.ticketQuotaPeriodHours;
    ticketQuotaStaffLoadMode = savedSettingsConfig.ticketQuotaStaffLoadMode;
    ticketQuotaStaffLoadMax = savedSettingsConfig.ticketQuotaStaffLoadMax;
    ticketQuotaStaffLoadBypassRoleIds = savedSettingsConfig.ticketQuotaStaffLoadBypassRoleIds;
    ticketQuotaReopenEnabled = savedSettingsConfig.ticketQuotaReopenEnabled;
    ticketQuotaReopenMax = savedSettingsConfig.ticketQuotaReopenMax;
    ticketTypes = JSON.parse(JSON.stringify(savedSettingsConfig.ticketTypes));
    ticketEmbedThumbnail = savedSettingsConfig.ticketEmbedThumbnail;
    ticketEmbedImage = savedSettingsConfig.ticketEmbedImage;
    ticketEmbedFooter = savedSettingsConfig.ticketEmbedFooter;
    ticketEmbedAuthorName = savedSettingsConfig.ticketEmbedAuthorName;
    ticketEmbedAuthorIcon = savedSettingsConfig.ticketEmbedAuthorIcon;
    ticketWelcomeTitle = savedSettingsConfig.ticketWelcomeTitle;
    ticketWelcomeDesc = savedSettingsConfig.ticketWelcomeDesc;
    ticketWelcomeColor = savedSettingsConfig.ticketWelcomeColor;
    ticketWelcomeThumbnail = savedSettingsConfig.ticketWelcomeThumbnail;
    ticketWelcomeImage = savedSettingsConfig.ticketWelcomeImage;
    ticketWelcomeFooter = savedSettingsConfig.ticketWelcomeFooter;
    ticketSlaFirstResponseMinutes = savedSettingsConfig.ticketSlaFirstResponseMinutes ?? null;
    ticketSlaResolutionHours = savedSettingsConfig.ticketSlaResolutionHours ?? null;
    ticketRecordingNoticeEnabled = savedSettingsConfig.ticketRecordingNoticeEnabled;
    ticketRecordingNoticeSeconds = savedSettingsConfig.ticketRecordingNoticeSeconds;
    ticketRecordingNoticeText = savedSettingsConfig.ticketRecordingNoticeText;
  }

  // Derived values from Dashboard Store
  const discordChannels = $derived(dashboardStore.state.discordChannels || []);
  const discordCategories = $derived(dashboardStore.state.discordCategories || []);
  const discordRoles = $derived(dashboardStore.state.discordRoles || []);

  /**
   * Les seuls reglages qui empechent un ticket d'exister. Tout le reste de la
   * page en affine le comportement : les melanger ferait passer pour egales
   * une categorie manquante et une couleur d'embed non choisie.
   */
  const configBlockers = $derived(
    [
      { key: 'category', label: 'la catégorie', ok: !!ticketCategoryId },
      { key: 'staffRole', label: 'le rôle du staff', ok: !!ticketStaffRoleId },
      { key: 'panelChannel', label: 'le salon du panneau', ok: !!ticketChannelId },
    ].filter((item) => !item.ok)
  );

  const STAFF_LOAD_MODES = [
    { value: 'OFF', label: 'Désactivé' },
    { value: 'WARN', label: 'Avertir' },
    { value: 'BLOCK', label: 'Bloquer' },
  ] as const;

  /** Badge de l'accordeon : combien de quotas imposent effectivement une limite. */
  const activeQuotaCount = $derived(
    [
      ticketQuotaOpenEnabled,
      ticketQuotaCooldownEnabled,
      ticketQuotaPeriodEnabled,
      ticketQuotaStaffLoadMode !== 'OFF',
      ticketQuotaReopenEnabled,
    ].filter(Boolean).length
  );

  const saveAction = createAsyncActionState();
  const sendEmbedAction = createAsyncActionState();
  const setupAction = createAsyncActionState();

  /**
   * Les réglages « verrouillage » et « validation » d'un type de ticket sont
   * tri-états côté bot (`true` / `false` / `null` = suivre le serveur). Un
   * `<select>` ne manipulant que des chaînes, la conversion se fait ici, dans
   * les deux sens, plutôt que d'éparpiller des ternaires dans le balisage.
   */
  function inheritedToSelect(value: unknown): '' | 'YES' | 'NO' {
    if (value === true) return 'YES';
    if (value === false) return 'NO';
    return '';
  }

  function selectToInherited(value: '' | 'YES' | 'NO'): boolean | null {
    if (value === 'YES') return true;
    if (value === 'NO') return false;
    return null;
  }

  /** Choix d'une question : le texte saisi reste la source de vérité. */
  function parseChoices(raw: string | undefined): string[] {
    return (raw ?? '')
      .split(',')
      .map((choice) => choice.trim())
      .filter(Boolean);
  }

  /**
   * Types de tickets prêts pour l'API : tri-états reconvertis en booléens et
   * questions nettoyées. `choicesString` n'existe que pour l'édition, on ne
   * l'envoie pas ; les choix sont recalculés depuis lui au moment de sauver
   * pour qu'un collage ou une correction ne soit jamais perdu.
   */
  function serializeTicketTypes() {
    return ticketTypes.map((type) => ({
      ...type,
      lockUntilClaim: selectToInherited(type.lockUntilClaim),
      requireApproval: selectToInherited(type.requireApproval),
      formCustomFields: (type.formCustomFields || []).map((field) => ({
        id: field.id,
        label: (field.label || '').trim(),
        placeholder: (field.placeholder || '').trim(),
        style: field.style,
        required: field.required !== false,
        choices: field.style === 'SELECT' || field.style === 'RADIO' ? parseChoices(field.choicesString) : [],
      })),
    }));
  }

  /** Une question sans intitulé est refusée par Discord : on bloque avant l'envoi. */
  function findInvalidQuestion(): { typeLabel: string; index: number } | null {
    for (const type of ticketTypes) {
      if (!type.formEnabled) continue;
      const fields = type.formCustomFields || [];
      for (let index = 0; index < fields.length; index++) {
        if (!(fields[index].label || '').trim()) {
          return { typeLabel: type.label || '', index: index + 1 };
        }
      }
    }
    return null;
  }

  function createTicketTypeDraft(index = 0, legacy?: any) {
    return {
      id: legacy?.ticketTypeId || crypto.randomUUID(),
      label: legacy?.ticketEmbedButtonText || m.e1_tickets_default_ticket_label({ index: index + 1 }),
      description: legacy?.ticketEmbedDesc || '',
      emoji: '📩',
      categoryId: legacy?.ticketCategoryId || ticketCategoryId || '',
      staffRoleId: legacy?.ticketStaffRoleId || ticketStaffRoleId || '',
      buttonStyle: 'PRIMARY' as const,
      mode: '' as '' | 'CHANNEL' | 'DM' | 'THREAD',
      anonymous: false,
      staffServerRelay: false,
      staffServerChannel: false,
      staffServerCategoryId: '',
      lockUntilClaim: '' as '' | 'YES' | 'NO',
      requireApproval: '' as '' | 'YES' | 'NO',
      formEnabled: true,
      formCustomFields: [] as Array<{
        id: string;
        label: string;
        placeholder: string;
        style: 'SHORT' | 'PARAGRAPH' | 'SELECT' | 'RADIO' | 'FILE';
        required: boolean;
        choices?: string[];
        choicesString?: string;
      }>
    };
  }

  function normalizeTicketTypes(config: any): Array<{
    id: string;
    label: string;
    description: string;
    emoji: string;
    categoryId: string;
    staffRoleId: string;
    buttonStyle: 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';
    mode: '' | 'CHANNEL' | 'DM' | 'THREAD';
    anonymous: boolean;
    staffServerRelay: boolean;
    staffServerChannel: boolean;
    staffServerCategoryId: string;
    /** Tri-etat : '' herite du serveur, 'YES'/'NO' tranchent pour ce type. */
    lockUntilClaim: '' | 'YES' | 'NO';
    requireApproval: '' | 'YES' | 'NO';
    formEnabled: boolean;
    formCustomFields: Array<{
      id: string;
      label: string;
      placeholder: string;
      style: 'SHORT' | 'PARAGRAPH' | 'SELECT' | 'RADIO' | 'FILE';
      required: boolean;
      choices?: string[];
      choicesString?: string;
    }>;
  }> {
    if (Array.isArray(config?.ticketTypes) && config.ticketTypes.length > 0) {
      return config.ticketTypes
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any, index: number) => ({
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : m.e1_tickets_default_ticket_label({ index: index + 1 }),
          description: typeof item.description === 'string' ? item.description.trim().slice(0, 200) : '',
          emoji: typeof item.emoji === 'string' && item.emoji.trim() ? item.emoji.trim().slice(0, 16) : '📩',
          categoryId: typeof item.categoryId === 'string' ? item.categoryId : '',
          staffRoleId: typeof item.staffRoleId === 'string' ? item.staffRoleId : '',
          buttonStyle: item.buttonStyle === 'SECONDARY' || item.buttonStyle === 'SUCCESS' || item.buttonStyle === 'DANGER'
            ? item.buttonStyle
            : 'PRIMARY',
          mode: item.mode === 'CHANNEL' || item.mode === 'DM' || item.mode === 'THREAD' ? item.mode : '',
          anonymous: item.anonymous === true,
          staffServerRelay: item.staffServerRelay === true,
          staffServerChannel: item.staffServerChannel === true,
          staffServerCategoryId: typeof item.staffServerCategoryId === 'string' ? item.staffServerCategoryId : '',
          lockUntilClaim: inheritedToSelect(item.lockUntilClaim),
          requireApproval: inheritedToSelect(item.requireApproval),
          formEnabled: item.formEnabled !== undefined ? item.formEnabled : true,
          formCustomFields: Array.isArray(item.formCustomFields)
            ? item.formCustomFields.map((f: any, fieldIndex: number) => ({
                // Un identifiant vide ferait doublon dans le modal Discord,
                // qui refuse alors le formulaire entier.
                id: typeof f.id === 'string' && f.id.trim() ? f.id.trim() : `field_${index + 1}_${fieldIndex + 1}`,
                label: f.label || '',
                placeholder: f.placeholder || '',
                style: f.style || 'SHORT',
                required: f.required !== false,
                choices: Array.isArray(f.choices) ? f.choices : [],
                choicesString: Array.isArray(f.choices) ? f.choices.join(', ') : '',
              }))
            : [],
        }));
    }

      return [createTicketTypeDraft(0, config)];
  }

  function addCustomField(typeIndex: number) {
    const ticketType = ticketTypes[typeIndex];
    if (!ticketType.formCustomFields) {
      ticketType.formCustomFields = [];
    }
    if (ticketType.formCustomFields.length >= 5) {
      toast.error(m.e1_tickets_err_max_fields());
      return;
    }
    const newId = 'field_' + Math.random().toString(36).substring(2, 10);
    ticketType.formCustomFields = [...ticketType.formCustomFields, {
      id: newId,
      label: m.e1_tickets_default_question_label({ index: ticketType.formCustomFields.length + 1 }),
      placeholder: '',
      style: 'SHORT',
      required: true,
      // Ces deux champs doivent exister des la creation : `bind:value` sur une
      // valeur `undefined` fait planter la page des qu'on choisit un type a choix.
      choices: [],
      choicesString: ''
    }];
  }

  function removeCustomField(typeIndex: number, fieldId: string) {
    const ticketType = ticketTypes[typeIndex];
    ticketType.formCustomFields = ticketType.formCustomFields.filter(f => f.id !== fieldId);
  }

  function addTicketType() {
    ticketTypes = [...ticketTypes, createTicketTypeDraft(ticketTypes.length)];
    expandedTicketTypeIndex = ticketTypes.length - 1; // Expands the newly created ticket type
  }

  function removeTicketType(index: number) {
    ticketTypes = ticketTypes.filter((_, currentIndex) => currentIndex !== index);
    if (expandedTicketTypeIndex === index) {
      expandedTicketTypeIndex = null;
    } else if (expandedTicketTypeIndex !== null && expandedTicketTypeIndex > index) {
      expandedTicketTypeIndex--;
    }
    if (ticketTypes.length === 0) {
      ticketTypes = [createTicketTypeDraft(0)];
      expandedTicketTypeIndex = 0;
    }
  }

  function moveTicketType(index: number, direction: 'UP' | 'DOWN') {
    if (direction === 'UP' && index > 0) {
      const temp = ticketTypes[index];
      ticketTypes[index] = ticketTypes[index - 1];
      ticketTypes[index - 1] = temp;
      ticketTypes = [...ticketTypes];
      if (expandedTicketTypeIndex === index) {
        expandedTicketTypeIndex = index - 1;
      } else if (expandedTicketTypeIndex === index - 1) {
        expandedTicketTypeIndex = index;
      }
    } else if (direction === 'DOWN' && index < ticketTypes.length - 1) {
      const temp = ticketTypes[index];
      ticketTypes[index] = ticketTypes[index + 1];
      ticketTypes[index + 1] = temp;
      ticketTypes = [...ticketTypes];
      if (expandedTicketTypeIndex === index) {
        expandedTicketTypeIndex = index + 1;
      } else if (expandedTicketTypeIndex === index + 1) {
        expandedTicketTypeIndex = index;
      }
    }
  }

  /** Reporte la configuration lue dans les champs, puis la garde comme référence. */
  function applyConfig(config: any) {
    // Populate config bindings
    ticketCategoryId = config.ticketCategoryId || '';
    ticketLogChannelId = config.ticketLogChannelId || '';
    ticketStaffRoleId = config.ticketStaffRoleId || '';
    ticketChannelId = config.ticketChannelId || '';
    // Laisses vides quand ils le sont : le bot compose alors le texte par
    // defaut dans la langue du serveur. Les remplir ici reviendrait a figer
    // en base la langue du dashboard de celui qui enregistre. Le champ
    // montre le defaut en filigrane.
    ticketEmbedTitle = config.ticketEmbedTitle || '';
    ticketEmbedDesc = config.ticketEmbedDesc || '';
    ticketEmbedButtonText = config.ticketEmbedButtonText || '';
    ticketEmbedColor = config.ticketEmbedColor || '#5865F2';
    ticketEmbedType = config.ticketEmbedType === 'DROPDOWN' ? 'DROPDOWN' : 'BUTTONS';
    ticketMode = config.ticketMode || 'CHANNEL';
    ticketDmRelayChannelId = config.ticketDmRelayChannelId || '';
    ticketAllowOverclaim = config.ticketAllowOverclaim !== undefined ? config.ticketAllowOverclaim : true;
    ticketOverclaimPermission = config.ticketOverclaimPermission || 'ANY';
    ticketAutoClaimOnReply = config.ticketAutoClaimOnReply === true;
    ticketInactivityEnabled = config.ticketInactivityEnabled !== undefined ? config.ticketInactivityEnabled : false;
    ticketInactivityHours = config.ticketInactivityHours !== undefined ? config.ticketInactivityHours : 24;
    ticketInactivityMessage = config.ticketInactivityMessage || '';
    ticketSatisfactionCommentEnabled = config.ticketSatisfactionCommentEnabled !== undefined ? config.ticketSatisfactionCommentEnabled : true;
    // Laisse vide : le bot pose alors sa question par defaut, comme pour les embeds.
    ticketSatisfactionCommentQuestion = config.ticketSatisfactionCommentQuestion || '';
    ticketSatisfactionCommentTimeout = config.ticketSatisfactionCommentTimeout !== undefined ? config.ticketSatisfactionCommentTimeout : 120;
    ticketSatisfactionLogChannelId = config.ticketSatisfactionLogChannelId || '';
    ticketSatisfactionLogAnonymous = config.ticketSatisfactionLogAnonymous === true;
    ticketLockUntilClaim = config.ticketLockUntilClaim === true;
    ticketApprovalEnabled = config.ticketApprovalEnabled === true;
    ticketApprovalChannelId = config.ticketApprovalChannelId || '';
    ticketArchiveCategoryId = config.ticketArchiveCategoryId || '';
    ticketArchiveKeepOpenerView = config.ticketArchiveKeepOpenerView === true;
    // Actifs par defaut cote serveur : `!== false` pour qu'une config lue
    // avant migration ne les affiche pas eteints.
    ticketHistoryPanelEnabled = config.ticketHistoryPanelEnabled !== false;
    ticketSelfReopenEnabled = config.ticketSelfReopenEnabled !== false;
    ticketSelfDeleteEnabled = config.ticketSelfDeleteEnabled === true;
    ticketQuotaOpenEnabled = config.ticketQuotaOpenEnabled === true;
    ticketQuotaOpenMax = config.ticketQuotaOpenMax ?? 1;
    ticketQuotaCooldownEnabled = config.ticketQuotaCooldownEnabled === true;
    ticketQuotaCooldownMinutes = config.ticketQuotaCooldownMinutes ?? 30;
    ticketQuotaPeriodEnabled = config.ticketQuotaPeriodEnabled === true;
    ticketQuotaPeriodMax = config.ticketQuotaPeriodMax ?? 5;
    ticketQuotaPeriodHours = config.ticketQuotaPeriodHours ?? 24;
    ticketQuotaStaffLoadMode = config.ticketQuotaStaffLoadMode || 'OFF';
    ticketQuotaStaffLoadMax = config.ticketQuotaStaffLoadMax ?? 5;
    ticketQuotaStaffLoadBypassRoleIds = config.ticketQuotaStaffLoadBypassRoleIds || [];
    ticketQuotaReopenEnabled = config.ticketQuotaReopenEnabled === true;
    ticketQuotaReopenMax = config.ticketQuotaReopenMax ?? 3;
    ticketSlaFirstResponseMinutes = config.ticketSlaFirstResponseMinutes ?? null;
    ticketSlaResolutionHours = config.ticketSlaResolutionHours ?? null;
    // Actif par défaut côté serveur : `!== false`, comme l'historique.
    ticketRecordingNoticeEnabled = config.ticketRecordingNoticeEnabled !== false;
    ticketRecordingNoticeSeconds = config.ticketRecordingNoticeSeconds ?? 10;
    // Vide : le bot affiche son texte par défaut.
    ticketRecordingNoticeText = config.ticketRecordingNoticeText || '';
    ticketTypes = normalizeTicketTypes(config);
    ticketEmbedThumbnail = config.ticketEmbedThumbnail || '';
    ticketEmbedImage = config.ticketEmbedImage || '';
    ticketEmbedFooter = config.ticketEmbedFooter || '';
    ticketEmbedAuthorName = config.ticketEmbedAuthorName || '';
    ticketEmbedAuthorIcon = config.ticketEmbedAuthorIcon || '';
    ticketWelcomeTitle = config.ticketWelcomeTitle || '';
    ticketWelcomeDesc = config.ticketWelcomeDesc || '';
    ticketWelcomeColor = config.ticketWelcomeColor || '#5865F2';
    ticketWelcomeThumbnail = config.ticketWelcomeThumbnail || '';
    ticketWelcomeImage = config.ticketWelcomeImage || '';
    ticketWelcomeFooter = config.ticketWelcomeFooter || '';
    savedSettingsConfig = {
      ticketCategoryId,
      ticketLogChannelId,
      ticketStaffRoleId,
      ticketChannelId,
      ticketEmbedTitle,
      ticketEmbedDesc,
      ticketEmbedButtonText,
      ticketEmbedColor,
      ticketEmbedType,
      ticketMode,
      ticketDmRelayChannelId,
      ticketAllowOverclaim,
      ticketOverclaimPermission,
      ticketAutoClaimOnReply,
      ticketInactivityEnabled,
      ticketInactivityHours,
      ticketInactivityMessage,
      ticketSatisfactionCommentEnabled,
      ticketSatisfactionCommentQuestion,
      ticketSatisfactionCommentTimeout,
      ticketSatisfactionLogChannelId,
      ticketSatisfactionLogAnonymous,
      ticketLockUntilClaim,
      ticketApprovalEnabled,
      ticketApprovalChannelId,
      ticketArchiveCategoryId,
      ticketArchiveKeepOpenerView,
      ticketHistoryPanelEnabled,
      ticketSelfReopenEnabled,
      ticketSelfDeleteEnabled,
      ticketQuotaOpenEnabled,
      ticketQuotaOpenMax,
      ticketQuotaCooldownEnabled,
      ticketQuotaCooldownMinutes,
      ticketQuotaPeriodEnabled,
      ticketQuotaPeriodMax,
      ticketQuotaPeriodHours,
      ticketQuotaStaffLoadMode,
      ticketQuotaStaffLoadMax,
      ticketQuotaStaffLoadBypassRoleIds,
      ticketQuotaReopenEnabled,
      ticketQuotaReopenMax,
      ticketSlaFirstResponseMinutes,
      ticketSlaResolutionHours,
      ticketRecordingNoticeEnabled,
      ticketRecordingNoticeSeconds,
      ticketRecordingNoticeText,
      ticketTypes: JSON.parse(JSON.stringify(ticketTypes)),
      ticketEmbedThumbnail,
      ticketEmbedImage,
      ticketEmbedFooter,
      ticketEmbedAuthorName,
      ticketEmbedAuthorIcon,
      ticketWelcomeTitle,
      ticketWelcomeDesc,
      ticketWelcomeColor,
      ticketWelcomeThumbnail,
      ticketWelcomeImage,
      ticketWelcomeFooter
    };
  }

  let loadError = $state('');

  /**
   * Configuration complète depuis sa route dédiée. La liste des tickets n'en
   * renvoie qu'une partie : lire les quotas, l'archivage ou l'historique depuis
   * elle affichait leurs valeurs par défaut, et un enregistrement les écrasait.
   */
  async function loadConfig() {
    loadError = '';
    try {
      const res = await dashboardFetch(`/tickets/config`);
      if (!res.ok) throw new Error(m.e1_tickets_err_load_system());
      applyConfig(await res.json());
    } catch (err) {
      loadError = errorMessage(err) || m.e1_tickets_err_load_system();
    }
  }

  // Save Settings Config
  async function saveSettings(): Promise<boolean> {
    const invalidQuestion = findInvalidQuestion();
    if (invalidQuestion) {
      toast.error(m.e1_tickets_err_empty_question({ index: invalidQuestion.index, type: invalidQuestion.typeLabel }));
      return false;
    }
    let success = false;
    await saveAction.run(async () => {
      const res = await dashboardFetch(`/tickets/config`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ticketCategoryId,
          ticketLogChannelId,
          ticketStaffRoleId,
          ticketChannelId,
          ticketEmbedTitle,
          ticketEmbedDesc,
          ticketEmbedButtonText,
          ticketEmbedColor,
          ticketEmbedType,
          ticketMode,
          ticketDmRelayChannelId,
          ticketLockUntilClaim,
          ticketApprovalEnabled,
          ticketApprovalChannelId,
          ticketArchiveCategoryId,
          ticketArchiveKeepOpenerView,
          ticketHistoryPanelEnabled,
          ticketSelfReopenEnabled,
          ticketSelfDeleteEnabled,
          ticketQuotaOpenEnabled,
          ticketQuotaOpenMax,
          ticketQuotaCooldownEnabled,
          ticketQuotaCooldownMinutes,
          ticketQuotaPeriodEnabled,
          ticketQuotaPeriodMax,
          ticketQuotaPeriodHours,
          ticketQuotaStaffLoadMode,
          ticketQuotaStaffLoadMax,
          ticketQuotaStaffLoadBypassRoleIds,
          ticketQuotaReopenEnabled,
          ticketQuotaReopenMax,
          ticketSlaFirstResponseMinutes: ticketSlaFirstResponseMinutes || null,
          ticketSlaResolutionHours: ticketSlaResolutionHours || null,
          ticketRecordingNoticeEnabled,
          ticketRecordingNoticeSeconds,
          ticketRecordingNoticeText: ticketRecordingNoticeText.trim() || null,
          ticketTypes: serializeTicketTypes(),
          ticketAllowOverclaim,
          ticketOverclaimPermission,
          ticketAutoClaimOnReply,
          ticketInactivityEnabled,
          ticketInactivityHours,
          ticketInactivityMessage,
          ticketSatisfactionCommentEnabled,
          ticketSatisfactionCommentQuestion,
          ticketSatisfactionCommentTimeout,
          ticketSatisfactionLogChannelId,
          ticketSatisfactionLogAnonymous,
          ticketEmbedThumbnail,
          ticketEmbedImage,
          ticketEmbedFooter,
          ticketEmbedAuthorName,
          ticketEmbedAuthorIcon,
          ticketWelcomeTitle,
          ticketWelcomeDesc,
          ticketWelcomeColor,
          ticketWelcomeThumbnail,
          ticketWelcomeImage,
          ticketWelcomeFooter
        })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_save());
      await dashboardStore.refresh();
      await loadConfig();
      onsaved?.();
      success = true;
      return true;
    }, { successMessage: m.e1_tickets_config_saved() });
    return success;
  }

  async function runTicketSetup() {
    if (!(await confirmDialog.ask({
      title: m.e1_tickets_confirm_setup_title(),
      description: m.e1_tickets_confirm_setup_desc(),
      confirmLabel: m.e1_tickets_confirm_setup_btn()
    }))) return;

    // `run` range l'erreur dans son etat au lieu de la relancer, et cette page
    // n'affiche aucun InlineFeedback : sans ce relais, un refus de permission
    // ou un delai d'attente ne se verrait nulle part.
    const ok = await setupAction.run(async () => {
      const res = await dashboardFetch(`/tickets/config/setup`, {
        method: 'POST'
        });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || m.e1_tickets_err_setup());

      const created = (payload?.items ?? []).filter((item: any) => item.created).map((item: any) => `#${item.name}`);
      toast.success(created.length > 0
        ? m.e1_tickets_setup_created({ names: created.join(', ') })
        : m.e1_tickets_setup_nothing());

      await dashboardStore.refresh();
      await loadConfig();
      onsaved?.();
      return true;
    });

    if (!ok) toast.error(setupAction.state.error || m.e1_tickets_err_setup());
  }

  // Send Panel to Discord
  async function sendEmbedPanel() {
    if (!(await confirmDialog.ask({ title: m.e1_tickets_confirm_panel_title(), description: m.e1_tickets_confirm_panel_desc(), confirmLabel: m.e1_tickets_confirm_panel_btn() }))) return;
    await sendEmbedAction.run(async () => {
      const res = await dashboardFetch(`/tickets/config/send-embed`, {
        method: 'POST'
        });
      if (!res.ok) throw new Error(m.e1_tickets_err_send_panel());
      return true;
    }, { successMessage: m.e1_tickets_panel_sent() });
  }

  // Serveur staff lié - pour l'option "ticket interne"
  let staffServerInfo = $state<{ staffGuildId: string | null; staffGuildName: string | null; categories: any[] }>({
    staffGuildId: null, staffGuildName: null, categories: [],
  });

  async function loadStaffServerInfo() {
    try {
      const data = await fetchStaffServerChannels();
      if (data?.staffGuildId) {
        staffServerInfo = {
          staffGuildId: data.staffGuildId,
          staffGuildName: data.staffGuildName ?? data.staffGuildId,
          categories: data.categories ?? [],
        };
      }
    } catch {
      // pas de lien staff
    }
  }

  $effect(() => {
    void refreshToken;
    untrack(() => void loadConfig());
  });

  onMount(() => {
    void loadStaffServerInfo();
  });
</script>

{#if loadError}
  <Callout variant="danger" class="mb-4">{loadError}</Callout>
{/if}

{#await Promise.all([
  import('../SearchableSelect.svelte'),
  import('../EmojiPicker.svelte')
]) then configComponents}
{@const SearchableSelect = configComponents[0].default}
{@const EmojiPicker = configComponents[1].default}
<!-- Configuration Panel - redesigned sections -->
<div class="max-w-4xl mx-auto space-y-4">

  <!-- Header actions -->
  <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2">
    <div>
      <h3 class="text-lg font-semibold text-on-surface">{m.e1_tickets_config_title()}</h3>
      <p class="text-on-surface-variant text-xs mt-0.5">{m.e1_tickets_config_desc()}</p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button
        onclick={runTicketSetup}
        disabled={setupAction.state.loading}
        class="px-4 py-2.5 bg-surface-container-high text-on-surface rounded-xl text-xs font-semibold active:scale-[0.98] transition-transform disabled:opacity-50 flex items-center gap-2 shrink-0"
      >
        <Papicon icon="sparkles" size={13} />
        {setupAction.state.loading ? m.e1_tickets_setup_running() : m.e1_tickets_setup()}
      </button>
      <button
        onclick={sendEmbedPanel}
        disabled={sendEmbedAction.state.loading || !ticketChannelId}
        class="px-4 py-2.5 bg-primary text-white rounded-xl text-xs font-semibold active:scale-[0.98] transition-transform disabled:opacity-50 flex items-center gap-2 shrink-0"
      >
        <Papicon icon="send" size={13} />
        {sendEmbedAction.state.loading ? m.e1_tickets_sending() : m.e1_tickets_send_embed()}
      </button>
    </div>
  </div>

  <!-- ─── Préparation ────────────────────────────────────────────────
       Les trois réglages sans lesquels un membre ne peut pas ouvrir de
       ticket, séparés de la trentaine d'options d'affinage qui suivent.
       Ils étaient noyés dans le premier accordéon, replié par défaut. -->
  {#if configBlockers.length > 0}
    <div class="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3.5">
      <div class="flex items-start gap-3">
        <Papicon icon="alert-triangle" size={16} class="text-warning mt-0.5 shrink-0" />
        <div class="min-w-0">
          <p class="text-body-sm font-semibold text-on-surface">
            Les tickets ne sont pas encore opérationnels
          </p>
          <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">
            Il manque {configBlockers.length === 1 ? 'un réglage' : `${configBlockers.length} réglages`} :
            {configBlockers.map((b) => b.label).join(', ')}.
            Un membre qui clique sur le panneau n'obtiendra rien tant qu'ils ne sont pas remplis.
          </p>
          <button
            type="button"
            class="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
            bg-warning/15 text-warning border border-warning/30 hover:bg-warning/25 transition-colors"
            onclick={() => (expandedConfigSection = 'channels')}
          >
            <Papicon icon="arrow-right" size={13} />
            Compléter
          </button>
        </div>
      </div>
    </div>
  {:else}
    <div class="rounded-xl border border-success/25 bg-success/5 px-4 py-3 flex items-center gap-3">
      <Papicon icon="check-circle" size={16} class="text-success shrink-0" />
      <p class="text-xs text-on-surface">
        Les tickets sont opérationnels. Le reste de cette page en affine le comportement.
      </p>
    </div>
  {/if}

  <!-- ─── Section 1: Salons & Rôles ──────────────────────────────────── -->
  <div data-guide="tickets-channels" class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('channels')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-success/10 text-success flex items-center justify-center shrink-0">
          <Papicon icon="hash" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_channels_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_channels_desc()}</p>
        </div>
      </div>
      <Papicon icon={expandedConfigSection === 'channels' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
    </button>
    {#if expandedConfigSection === 'channels'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_category()}</span>
            <SearchableSelect bind:value={ticketCategoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
            {#if isMissingReference(ticketCategoryId, discordCategories)}
              <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
            {/if}
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_panel_channel()}</span>
            <SearchableSelect bind:value={ticketChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
            {#if isMissingReference(ticketChannelId, discordChannels)}
              <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
            {/if}
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_log_channel()}</span>
            <SearchableSelect bind:value={ticketLogChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
            {#if isMissingReference(ticketLogChannelId, discordChannels)}
              <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
            {/if}
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_staff_role()}</span>
            <SearchableSelect bind:value={ticketStaffRoleId} options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
            {#if isMissingReference(ticketStaffRoleId, discordRoles)}
              <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
            {/if}
          </label>
          <label class="block col-span-1 md:col-span-2">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_dm_relay()}</span>
            <SearchableSelect bind:value={ticketDmRelayChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_channel_ph()} className="w-full" />
            {#if isMissingReference(ticketDmRelayChannelId, discordChannels)}
              <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
            {/if}
          </label>
        </div>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketAllowOverclaim} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">{m.e1_tickets_overclaim_label()}</span>
              <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_overclaim_desc()}</p>
            </div>
          </label>
          {#if ticketAllowOverclaim}
            <label class="block ml-7">
              <span class="text-xs font-bold text-on-surface-variant/80 mb-2 block">{m.e1_tickets_overclaim_who()}</span>
              <FormSelect bind:value={ticketOverclaimPermission} className="w-full">
                <option value="ANY">{m.e1_tickets_overclaim_any()}</option>
                <option value="SUPERIOR_OR_EQUAL">{m.e1_tickets_overclaim_superior()}</option>
              </FormSelect>
            </label>
          {/if}
          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketAutoClaimOnReply} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">{m.e1_tickets_autoclaim_label()}</span>
              <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_autoclaim_desc()}</p>
            </div>
          </label>
        </div>
      </div>
    {/if}
  </div>

  <!-- ─── Section 3: Personnalisation Embed ──────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('embed')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center shrink-0">
          <Papicon icon="palette" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_embed_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_embed_desc()}</p>
        </div>
      </div>
      <Papicon icon={expandedConfigSection === 'embed' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
    </button>
    {#if expandedConfigSection === 'embed'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_title()}</span>
            <FormInput type="text" bind:value={ticketEmbedTitle} placeholder={m.e1_tickets_embed_title_ph()} className="w-full" />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_button_text()}</span>
            <FormInput type="text" bind:value={ticketEmbedButtonText} placeholder={m.e1_tickets_embed_button_ph()} className="w-full" />
          </label>
        </div>
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_description()}</span>
          <FormTextarea bind:value={ticketEmbedDesc} placeholder={m.e1_tickets_embed_desc_ph()} className="w-full h-20" />
          <p class="text-2xs text-on-surface-variant/50 mt-1.5">{m.e1_tickets_default_hint()}</p>
        </label>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_thumbnail()}</span>
            <FormInput type="text" bind:value={ticketEmbedThumbnail} placeholder="https://..." className="w-full" />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_image()}</span>
            <FormInput type="text" bind:value={ticketEmbedImage} placeholder="https://..." className="w-full" />
          </label>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_author_name()}</span>
            <FormInput type="text" bind:value={ticketEmbedAuthorName} placeholder={m.e1_tickets_embed_author_ph()} className="w-full" />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_author_icon()}</span>
            <FormInput type="text" bind:value={ticketEmbedAuthorIcon} placeholder="https://..." className="w-full" />
          </label>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_color()}</span>
            <FormColorPicker bind:value={ticketEmbedColor} />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_footer()}</span>
            <FormInput type="text" bind:value={ticketEmbedFooter} placeholder={m.e1_tickets_embed_footer_ph()} className="w-full" />
          </label>
        </div>

        <div class="border-t border-outline-variant/10 pt-4">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-3 block">{m.e1_tickets_interaction_type()}</span>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {#each [
              { value: 'BUTTONS', label: m.e1_tickets_interaction_buttons(), icon: 'mouse-pointer', desc: m.e1_tickets_interaction_buttons_desc() },
              { value: 'DROPDOWN', label: m.e1_tickets_interaction_dropdown(), icon: 'list', desc: m.e1_tickets_interaction_dropdown_desc() }
            ] as typeOption}
              <button
                onclick={() => ticketEmbedType = typeOption.value as any}
                class="p-4 rounded-xl border-2 text-left transition-all {ticketEmbedType === typeOption.value ? 'border-primary bg-primary/5' : 'border-outline-variant/10 hover:border-outline-variant/30 bg-surface-container/20'}"
              >
                <div class="flex items-center gap-2.5 mb-2">
                  <div class="w-8 h-8 rounded-lg flex items-center justify-center {ticketEmbedType === typeOption.value ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant/50'}">
                    <Papicon icon={typeOption.icon} size={16} />
                  </div>
                  <span class="text-sm font-semibold {ticketEmbedType === typeOption.value ? 'text-primary' : 'text-on-surface'}">{typeOption.label}</span>
                </div>
                <p class="text-2xs text-on-surface-variant/60 leading-relaxed">{typeOption.desc}</p>
              </button>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- ─── Section: Message d'accueil dans le ticket ──────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('welcome')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center shrink-0">
          <Papicon icon="message-square" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_welcome_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_welcome_desc()}</p>
        </div>
      </div>
      <Papicon icon={expandedConfigSection === 'welcome' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
    </button>
    {#if expandedConfigSection === 'welcome'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block col-span-1 md:col-span-2">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_welcome_title_label()}</span>
            <FormInput type="text" bind:value={ticketWelcomeTitle} placeholder={m.e1_tickets_welcome_title_ph({ type_label: '{type_label}' })} className="w-full" />
          </label>
        </div>
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_welcome_desc_label()}</span>
          <FormTextarea bind:value={ticketWelcomeDesc} placeholder={m.e1_tickets_welcome_desc_ph({ user: '{user}', staff_mention: '{staff_mention}' })} className="w-full h-32" />
          <p class="text-2xs text-on-surface-variant/50 mt-1.5">{m.e1_tickets_default_hint()}</p>
        </label>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_thumbnail()}</span>
            <FormInput type="text" bind:value={ticketWelcomeThumbnail} placeholder="https://..." className="w-full" />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_image()}</span>
            <FormInput type="text" bind:value={ticketWelcomeImage} placeholder="https://..." className="w-full" />
          </label>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_embed_color()}</span>
            <FormColorPicker bind:value={ticketWelcomeColor} />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_footer()}</span>
            <FormInput type="text" bind:value={ticketWelcomeFooter} placeholder={m.e1_tickets_welcome_footer_ph({ ticket_id: '{ticket_id}' })} className="w-full" />
          </label>
        </div>
      </div>
    {/if}
  </div>

  <!-- ─── Section : Validation & verrouillage ────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('gatekeeping')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
          <Papicon icon="shield" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_gatekeeping_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_gatekeeping_desc()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if ticketLockUntilClaim || ticketApprovalEnabled}
          <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-success/10 text-success border border-success/20">{m.e1_tickets_active_badge()}</span>
        {/if}
        <Papicon icon={expandedConfigSection === 'gatekeeping' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
      </div>
    </button>
    {#if expandedConfigSection === 'gatekeeping'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
          <input type="checkbox" bind:checked={ticketLockUntilClaim} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
          <div>
            <span class="text-xs font-bold text-on-surface">{m.e1_tickets_lock_until_claim()}</span>
            <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_lock_until_claim_desc()}</p>
          </div>
        </label>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketApprovalEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">{m.e1_tickets_approval_enable()}</span>
              <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_approval_enable_desc()}</p>
            </div>
          </label>
          {#if ticketApprovalEnabled}
            <label class="block ml-7">
              <span class="text-xs font-bold text-on-surface-variant/80 mb-2 block">{m.e1_tickets_approval_channel()}</span>
              <SearchableSelect bind:value={ticketApprovalChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_approval_channel_ph()} className="w-full" />
              {#if isMissingReference(ticketApprovalChannelId, discordChannels)}
                <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
              {/if}
              <p class="text-2xs text-on-surface-variant/50 mt-1.5">{m.e1_tickets_approval_channel_hint()}</p>
            </label>
          {/if}
        </div>

        <p class="text-2xs text-on-surface-variant/50 border-t border-outline-variant/10 pt-3">{m.e1_tickets_gatekeeping_override_hint()}</p>
      </div>
    {/if}
  </div>

  <!-- ─── Section : Archivage & historique côté membre ───────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('archive')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-slate-500/10 text-on-surface-variant flex items-center justify-center shrink-0">
          <Papicon icon="archive" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_cfg_archive_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_cfg_archive_desc()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if ticketArchiveCategoryId || ticketHistoryPanelEnabled}
          <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-success/10 text-success border border-success/20">{m.e1_tickets_active_badge()}</span>
        {/if}
        <Papicon icon={expandedConfigSection === 'archive' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
      </div>
    </button>
    {#if expandedConfigSection === 'archive'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <label class="block">
          <span class="text-xs font-bold text-on-surface-variant/80 mb-2 block">{m.e1_tickets_cfg_archive_category()}</span>
          <SearchableSelect bind:value={ticketArchiveCategoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
          {#if isMissingReference(ticketArchiveCategoryId, discordCategories)}
            <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
          {/if}
          <p class="text-2xs text-on-surface-variant/50 mt-1.5">{m.e1_tickets_cfg_archive_category_hint()}</p>
        </label>

        <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
          <input type="checkbox" bind:checked={ticketArchiveKeepOpenerView} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
          <div>
            <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_archive_keep_view()}</span>
            <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_cfg_archive_keep_view_desc()}</p>
          </div>
        </label>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <div>
            <p class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_history_title()}</p>
            <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_cfg_history_desc()}</p>
          </div>

          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketHistoryPanelEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_history_panel()}</span>
              <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_cfg_history_panel_desc()}</p>
            </div>
          </label>

          {#if ticketHistoryPanelEnabled}
            <div class="ml-7 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketSelfReopenEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_self_reopen()}</span>
                  <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_cfg_self_reopen_desc()}</p>
                </div>
              </label>
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketSelfDeleteEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_self_delete()}</span>
                  <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_cfg_self_delete_desc()}</p>
                </div>
              </label>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- ─── Section 4: Inactivité ──────────────────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('inactivity')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-warning/10 text-warning flex items-center justify-center shrink-0">
          <Papicon icon="clock" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_inactivity_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_inactivity_desc()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if ticketInactivityEnabled}
          <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-success/10 text-success border border-success/20">{m.e1_tickets_active_badge()}</span>
        {/if}
        <Papicon icon={expandedConfigSection === 'inactivity' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
      </div>
    </button>
    {#if expandedConfigSection === 'inactivity'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
          <input type="checkbox" bind:checked={ticketInactivityEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
          <div>
            <span class="text-xs font-bold text-on-surface">{m.e1_tickets_enable_reminders()}</span>
            <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_reminders_desc()}</p>
          </div>
        </label>
        {#if ticketInactivityEnabled}
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label class="block">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_delay_hours()}</span>
              <input type="number" bind:value={ticketInactivityHours} min={1} max={168} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_inactivity_message_label()}</span>
              <FormTextarea bind:value={ticketInactivityMessage} placeholder={m.e1_tickets_inactivity_ph({ user: '{user}' })} className="w-full h-20" />
            </label>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- ─── Avertissement d'enregistrement ──────────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('recording')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Papicon icon="info" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.tn_section_title()}</p>
          <p class="text-2xs text-on-surface-variant mt-0.5">{m.tn_section_desc()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if ticketRecordingNoticeEnabled}
          <span class="px-2 py-0.5 rounded-full text-2xs font-semibold bg-success/10 text-success border border-success/20">{m.e1_tickets_active_badge()}</span>
        {/if}
        <Papicon icon={expandedConfigSection === 'recording' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
      </div>
    </button>
    {#if expandedConfigSection === 'recording'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
          <input type="checkbox" bind:checked={ticketRecordingNoticeEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
          <div>
            <span class="text-xs font-semibold text-on-surface">{m.tn_enable()}</span>
            <p class="text-2xs text-on-surface-variant">{m.tn_enable_desc()}</p>
          </div>
        </label>
        {#if ticketRecordingNoticeEnabled}
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label class="block">
              <span class="text-xs font-semibold text-on-surface-variant ml-1 mb-2 block">{m.tn_seconds()}</span>
              <input type="number" min="5" max="30" bind:value={ticketRecordingNoticeSeconds} class="input" />
              <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">{m.tn_seconds_hint()}</span>
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-semibold text-on-surface-variant ml-1 mb-2 block">{m.tn_text()}</span>
              <FormTextarea bind:value={ticketRecordingNoticeText} placeholder={m.tn_text_ph()} className="w-full h-28" />
              <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">{m.tn_text_hint()}</span>
            </label>
          </div>
          <!-- Aperçu : ce que voit le membre, lui seul, avant la création. -->
          <div class="tn-preview" aria-label={m.tn_preview()}>
            <p class="tn-preview__only"><Papicon icon="eye" size={12} /> {m.tn_only_you()}</p>
            <div class="tn-preview__embed">
              <p class="font-semibold text-on-surface text-body-sm">ℹ️ {m.tn_preview_title()}</p>
              <p class="text-body-sm text-on-surface-variant whitespace-pre-line mt-1">{ticketRecordingNoticeText.trim() || m.tn_default_text()}</p>
              <p class="text-body-sm text-on-surface-variant mt-2">⏳ {m.tn_preview_countdown({ seconds: Math.min(30, Math.max(5, Number(ticketRecordingNoticeSeconds) || 10)) })}</p>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- ─── Objectifs de service ───────────────────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('sla')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Papicon icon="timer" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.th_sla_section_title()}</p>
          <p class="text-2xs text-on-surface-variant mt-0.5">{m.th_sla_section_desc()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if ticketSlaFirstResponseMinutes || ticketSlaResolutionHours}
          <span class="px-2 py-0.5 rounded-full text-2xs font-semibold bg-success/10 text-success border border-success/20">{m.e1_tickets_active_badge()}</span>
        {/if}
        <Papicon icon={expandedConfigSection === 'sla' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
      </div>
    </button>
    {#if expandedConfigSection === 'sla'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant ml-1 mb-2 block">{m.th_sla_first_label()}</span>
            <input type="number" min="1" max="10080" placeholder={m.th_sla_none_placeholder()} bind:value={ticketSlaFirstResponseMinutes} class="input" />
            <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">{m.th_sla_first_hint()}</span>
          </label>
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant ml-1 mb-2 block">{m.th_sla_resolution_label()}</span>
            <input type="number" min="1" max="720" placeholder={m.th_sla_none_placeholder()} bind:value={ticketSlaResolutionHours} class="input" />
            <span class="text-2xs text-on-surface-variant ml-1 mt-1 block">{m.th_sla_resolution_hint()}</span>
          </label>
        </div>
      </div>
    {/if}
  </div>

  <!-- ─── Quotas ─────────────────────────────────────────────────────── -->
  <div data-guide="tickets-quotas" class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('quotas')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
          <Papicon icon="gauge" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">Quotas</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">Limites d'ouverture côté membre, plafond de charge côté staff</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if activeQuotaCount > 0}
          <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-success/10 text-success border border-success/20">
            {activeQuotaCount} actif{activeQuotaCount > 1 ? 's' : ''}
          </span>
        {/if}
        <Papicon icon={expandedConfigSection === 'quotas' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
      </div>
    </button>
    {#if expandedConfigSection === 'quotas'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <p class="text-2xs text-on-surface-variant/70 leading-relaxed">
          Chaque quota s'active indépendamment. Décoché, il n'impose aucune limite.
          Un type de ticket peut ajuster le seuil depuis l'onglet Types.
        </p>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketQuotaOpenEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">Tickets ouverts simultanément</span>
              <p class="text-2xs text-on-surface-variant/60">Nombre de tickets qu'un membre peut avoir en cours en même temps.</p>
            </div>
          </label>
          {#if ticketQuotaOpenEnabled}
            <label class="block ml-7 max-w-[220px]">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Maximum par membre</span>
              <input type="number" bind:value={ticketQuotaOpenMax} min={1} max={50} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
            </label>
          {/if}
        </div>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketQuotaCooldownEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">Délai entre deux ouvertures</span>
              <p class="text-2xs text-on-surface-variant/60">Empêche d'enchaîner les tickets sans laisser le temps de répondre.</p>
            </div>
          </label>
          {#if ticketQuotaCooldownEnabled}
            <label class="block ml-7 max-w-[220px]">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Délai (minutes)</span>
              <input type="number" bind:value={ticketQuotaCooldownMinutes} min={1} max={10080} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
            </label>
          {/if}
        </div>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketQuotaPeriodEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">Quota sur une période</span>
              <p class="text-2xs text-on-surface-variant/60">Plafonne le nombre d'ouvertures sur une fenêtre glissante.</p>
            </div>
          </label>
          {#if ticketQuotaPeriodEnabled}
            <div class="ml-7 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[460px]">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Tickets maximum</span>
                <input type="number" bind:value={ticketQuotaPeriodMax} min={1} max={500} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Sur (heures)</span>
                <input type="number" bind:value={ticketQuotaPeriodHours} min={1} max={720} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
              </label>
            </div>
          {/if}
        </div>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <div>
            <p class="text-xs font-bold text-on-surface">Charge maximale par modérateur</p>
            <p class="text-2xs text-on-surface-variant/60 mt-0.5">
              Tickets pris en charge et encore ouverts. Au-delà, le staff est averti ou refusé.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            {#each STAFF_LOAD_MODES as opt (opt.value)}
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg text-2xs font-semibold border transition-colors
                {ticketQuotaStaffLoadMode === opt.value
                  ? 'bg-primary/15 border-primary/40 text-primary'
                  : 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant hover:text-on-surface'}"
                onclick={() => (ticketQuotaStaffLoadMode = opt.value)}
              >
                {opt.label}
              </button>
            {/each}
          </div>
          {#if ticketQuotaStaffLoadMode !== 'OFF'}
            <div class="space-y-3">
              <label class="block max-w-[220px]">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Tickets par modérateur</span>
                <input type="number" bind:value={ticketQuotaStaffLoadMax} min={1} max={200} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
              </label>
              <div>
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-1 block">Rôles qui passent outre</span>
                <p class="text-2xs text-on-surface-variant/60 ml-1 mb-2">
                  Sans eux, un serveur dont tout le staff est plein ne peut plus prendre aucun ticket.
                </p>
                <MultiSelect
                  bind:values={ticketQuotaStaffLoadBypassRoleIds}
                  options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
                  placeholder="Aucun rôle"
                />
              </div>
            </div>
          {/if}
        </div>

        <div class="border-t border-outline-variant/10 pt-4 space-y-3">
          <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
            <input type="checkbox" bind:checked={ticketQuotaReopenEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
            <div>
              <span class="text-xs font-bold text-on-surface">Limiter les réouvertures</span>
              <p class="text-2xs text-on-surface-variant/60">
                Nombre de fois qu'un même ticket peut être rouvert. Les délais entre deux réouvertures
                (24 h, puis 7 jours) s'appliquent quoi qu'il arrive.
              </p>
            </div>
          </label>
          {#if ticketQuotaReopenEnabled}
            <label class="block ml-7 max-w-[220px]">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Réouvertures maximum</span>
              <input type="number" bind:value={ticketQuotaReopenMax} min={1} max={50} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
            </label>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- ─── Section 5: Sondage de satisfaction ─────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('satisfaction')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-success/10 text-success flex items-center justify-center shrink-0">
          <Papicon icon="smile" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_satisfaction_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_satisfaction_desc()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if ticketSatisfactionCommentEnabled || ticketSatisfactionLogChannelId}
          <span class="px-2 py-0.5 rounded-full text-2xs font-semibold uppercase bg-success/10 text-success border border-success/20">{m.e1_tickets_active_badge()}</span>
        {/if}
        <Papicon icon={expandedConfigSection === 'satisfaction' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
      </div>
    </button>
    {#if expandedConfigSection === 'satisfaction'}
      <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
        <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
          <input type="checkbox" bind:checked={ticketSatisfactionCommentEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
          <div>
            <span class="text-xs font-bold text-on-surface">{m.e1_tickets_sat_comment_enable()}</span>
            <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_sat_comment_enable_desc()}</p>
          </div>
        </label>
        {#if ticketSatisfactionCommentEnabled}
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label class="block sm:col-span-2">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_sat_comment_question_label()}</span>
              <FormInput type="text" bind:value={ticketSatisfactionCommentQuestion} placeholder={m.e1_tickets_sat_comment_question_ph()} className="w-full" />
            </label>
            <label class="block">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_sat_comment_timeout_label()}</span>
              <input type="number" bind:value={ticketSatisfactionCommentTimeout} min={30} max={900} step={10} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
            </label>
          </div>
          <p class="text-2xs text-on-surface-variant/50 ml-1">{m.e1_tickets_sat_comment_hint()}</p>
        {/if}

        <div class="pt-2 border-t border-outline-variant/10 space-y-4">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_sat_log_label()}</span>
            <SearchableSelect bind:value={ticketSatisfactionLogChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
            {#if isMissingReference(ticketSatisfactionLogChannelId, discordChannels)}
              <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
            {/if}
            <p class="text-2xs text-on-surface-variant/50 ml-1 mt-1.5">{m.e1_tickets_sat_log_desc()}</p>
          </label>
          {#if ticketSatisfactionLogChannelId}
            <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
              <input type="checkbox" bind:checked={ticketSatisfactionLogAnonymous} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
              <div>
                <span class="text-xs font-bold text-on-surface">{m.e1_tickets_sat_log_anonymous()}</span>
                <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_sat_log_anonymous_desc()}</p>
              </div>
            </label>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- ─── Section 2: Types de tickets ────────────────────────────────── -->
  <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
    <button onclick={() => toggleConfigSection('types')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg bg-error/10 text-error flex items-center justify-center shrink-0">
          <Papicon icon="layers" size={18} />
        </div>
        <div>
          <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_types_title()}</p>
          <p class="text-2xs text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_types_desc({ count: ticketTypes.length })}</p>
        </div>
      </div>
      <Papicon icon={expandedConfigSection === 'types' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
    </button>
    {#if expandedConfigSection === 'types'}
      <div class="px-4 lg:px-5 pb-5 border-t border-outline-variant/10 pt-4 space-y-4">
        <div class="flex justify-end">
          <button onclick={addTicketType}
            class="px-3 py-2 bg-primary text-white rounded-lg text-xs font-semibold active:scale-[0.98] transition-transform flex items-center gap-1.5"
          >
            <Papicon icon="plus" size={13} /> {m.e1_tickets_add_type()}
          </button>
        </div>

        <div class="space-y-3">
          {#each ticketTypes as ticketType, index}
            {@const isExpanded = expandedTicketTypeIndex === index}
            <div class="rounded-xl border transition-all {isExpanded ? 'border-primary/40 bg-surface-container/35 shadow-sm' : 'border-outline-variant/10 bg-surface-container/15 hover:border-outline-variant/20'}">
              
              <!-- Accordion Header -->
              <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between p-3.5 gap-3">
                <button
                  onclick={() => expandedTicketTypeIndex = isExpanded ? null : index}
                  class="flex-1 flex flex-wrap items-center gap-2.5 text-left outline-none"
                >
                  <span class="text-lg shrink-0">{ticketType.emoji || '📩'}</span>
                  <div class="min-w-0 flex-1">
                    <span class="text-sm font-semibold text-on-surface block truncate">{ticketType.label || `Type #${index + 1}`}</span>
                    
                    <!-- Badges summary of configuration -->
                    <div class="flex flex-wrap items-center gap-1.5 mt-1">
                      <!-- Mode badge -->
                      {#if ticketType.mode === 'CHANNEL'}
                        <span class="px-1.5 py-0.5 rounded text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/15">{m.e1_tickets_badge_channel()}</span>
                      {:else if ticketType.mode === 'DM'}
                        <span class="px-1.5 py-0.5 rounded text-xs font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/15">{m.e1_tickets_badge_dm()}</span>
                      {:else if ticketType.mode === 'THREAD'}
                        <span class="px-1.5 py-0.5 rounded text-xs font-semibold bg-warning/10 text-warning border border-warning/15">{m.e1_tickets_badge_thread()}</span>
                      {:else}
                        <span class="px-1.5 py-0.5 rounded text-xs font-semibold bg-surface-container-high text-on-surface-variant/60 border border-outline-variant/10">{m.e1_tickets_badge_global_mode()}</span>
                      {/if}

                      <!-- Staff Role Badge -->
                      {#if ticketType.staffRoleId}
                        {@const role = discordRoles.find(r => r.id === ticketType.staffRoleId)}
                        <span class="px-1.5 py-0.5 rounded text-2xs font-semibold tracking-wider bg-success/10 text-success border border-success/15">Staff: @{role?.name || m.e1_tickets_unknown_role()}</span>
                      {:else}
                        <span class="px-1.5 py-0.5 rounded text-2xs font-semibold tracking-wider bg-surface-container-high text-on-surface-variant/40 border border-outline-variant/10">{m.e1_tickets_badge_inherited_staff()}</span>
                      {/if}

                      <!-- Form Enabled Badge -->
                      {#if ticketType.formEnabled}
                        <span class="px-1.5 py-0.5 rounded text-2xs font-semibold tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/15">{m.e1_tickets_badge_form_with_questions({ count: (ticketType.formCustomFields || []).length })}</span>
                      {:else}
                        <span class="px-1.5 py-0.5 rounded text-2xs font-semibold tracking-wider bg-surface-container-high text-on-surface-variant/40 border border-outline-variant/10">{m.e1_tickets_badge_direct_creation()}</span>
                      {/if}
                    </div>
                  </div>
                </button>

                <!-- Reorder & Delete actions in header -->
                <div class="flex items-center gap-1.5 self-end sm:self-center shrink-0">
                  <!-- Reordering buttons -->
                  <button
                    onclick={() => moveTicketType(index, 'UP')}
                    disabled={index === 0}
                    class="p-1.5 rounded-lg border border-outline-variant/10 text-on-surface-variant hover:bg-white/5 disabled:opacity-30 transition-colors"
                    title={m.e1_tickets_move_up()}
                  >
                    <Papicon icon="arrow-up" size={13} />
                  </button>
                  <button
                    onclick={() => moveTicketType(index, 'DOWN')}
                    disabled={index === ticketTypes.length - 1}
                    class="p-1.5 rounded-lg border border-outline-variant/10 text-on-surface-variant hover:bg-white/5 disabled:opacity-30 transition-colors"
                    title={m.e1_tickets_move_down()}
                  >
                    <Papicon icon="arrow-down" size={13} />
                  </button>

                  <div class="w-px h-5 bg-outline-variant/10 mx-1"></div>

                  <!-- Edit expansion toggle button -->
                  <button
                    onclick={() => expandedTicketTypeIndex = isExpanded ? null : index}
                    class="px-2.5 py-1.5 rounded-lg border text-2xs font-semibold uppercase tracking-wider transition-colors {isExpanded ? 'bg-primary text-white border-primary' : 'bg-surface-container text-on-surface hover:bg-white/5 border-outline-variant/10'}"
                  >
                    {isExpanded ? m.e1_tickets_type_collapse() : m.e1_tickets_type_edit()}
                  </button>

                  <!-- Delete button -->
                  <button
                    onclick={() => removeTicketType(index)}
                    class="p-1.5 rounded-lg bg-error/10 text-error hover:bg-rose-500 hover:text-white border border-error/15 transition-all"
                    title={m.e1_tickets_type_delete()}
                  >
                    <Papicon icon="trash-2" size={13} />
                  </button>
                </div>
              </div>

              <!-- Accordion Content -->
              {#if isExpanded}
                <div class="px-4 pb-4 pt-3 border-t border-outline-variant/10 bg-surface-container-low/10 space-y-4 animate-fade-in">
                  
                  <!-- Button label, emoji, style select -->
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label class="block">
                      <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_label()}</span>
                      <FormInput type="text" bind:value={ticketType.label} placeholder={m.e1_tickets_type_label_ph()} className="w-full" />
                    </label>
                    <div class="grid grid-cols-2 gap-3">
                      <label class="block">
                        <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_emoji()}</span>
                        <div class="flex gap-1.5">
                          <FormInput type="text" bind:value={ticketType.emoji} placeholder="📩" className="w-full" />
                          <EmojiPicker bind:value={ticketType.emoji} />
                        </div>
                      </label>
                      <label class="block">
                        <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_style()}</span>
                        <FormSelect bind:value={ticketType.buttonStyle} className="w-full">
                          <option value="PRIMARY">{m.e1_tickets_style_primary()}</option>
                          <option value="SECONDARY">{m.e1_tickets_style_secondary()}</option>
                          <option value="SUCCESS">{m.e1_tickets_style_success()}</option>
                          <option value="DANGER">{m.e1_tickets_style_danger()}</option>
                        </FormSelect>
                      </label>
                    </div>
                  </div>

                  <label class="block">
                    <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_desc()}</span>
                    <FormTextarea bind:value={ticketType.description} placeholder={m.e1_tickets_type_desc_ph()} className="w-full h-16" />
                  </label>

                  <!-- Salons & Rôles targets -->
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label class="block">
                      <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_mode()}</span>
                      <FormSelect bind:value={ticketType.mode} className="w-full">
                        <option value="">{m.e1_tickets_mode_default()}</option>
                        <option value="CHANNEL">{m.e1_tickets_mode_channel_opt()}</option>
                        <option value="DM">{m.e1_tickets_mode_dm_opt()}</option>
                        <option value="THREAD">{m.e1_tickets_mode_thread_opt()}</option>
                      </FormSelect>
                    </label>
                    <label class="block">
                      <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_category()}</span>
                      <SearchableSelect bind:value={ticketType.categoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_inherited_ph()} className="w-full" />
                      {#if isMissingReference(ticketType.categoryId, discordCategories)}
                        <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
                      {/if}
                    </label>
                    <label class="block">
                      <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_staff_role()}</span>
                      <SearchableSelect bind:value={ticketType.staffRoleId} options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.e1_tickets_inherited_ph()} className="w-full" />
                      {#if isMissingReference(ticketType.staffRoleId, discordRoles)}
                        <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
                      {/if}
                    </label>
                  </div>

                  <!-- Surcharges validation / verrouillage propres au type -->
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label class="block">
                      <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_lock_until_claim()}</span>
                      <FormSelect bind:value={ticketType.lockUntilClaim} className="w-full">
                        <option value="">{m.e1_tickets_type_inherit({ value: ticketLockUntilClaim ? m.e1_tickets_type_enabled() : m.e1_tickets_type_disabled() })}</option>
                        <option value="YES">{m.e1_tickets_type_enabled()}</option>
                        <option value="NO">{m.e1_tickets_type_disabled()}</option>
                      </FormSelect>
                    </label>
                    <label class="block">
                      <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_require_approval()}</span>
                      <FormSelect bind:value={ticketType.requireApproval} className="w-full">
                        <option value="">{m.e1_tickets_type_inherit({ value: ticketApprovalEnabled ? m.e1_tickets_type_enabled() : m.e1_tickets_type_disabled() })}</option>
                        <option value="YES">{m.e1_tickets_type_enabled()}</option>
                        <option value="NO">{m.e1_tickets_type_disabled()}</option>
                      </FormSelect>
                    </label>
                  </div>

                  <!-- Toggle Options -->
                  {#if ticketType.mode === 'DM' || (ticketType.mode === '' && ticketMode === 'DM')}
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                      <div class="flex items-center gap-2.5 p-1">
                        <ToggleSwitch checked={ticketType.anonymous} onToggle={(v) => { ticketType.anonymous = v; }} size="sm" />
                        <div>
                          <span class="text-xs font-semibold text-on-surface">{m.e1_tickets_staff_anonymity()}</span>
                          <p class="text-2xs text-on-surface-variant/50 leading-none mt-0.5">{m.e1_tickets_staff_anonymity_desc()}</p>
                        </div>
                      </div>
                      <div class="flex items-center gap-2.5 p-1">
                        <ToggleSwitch checked={ticketType.staffServerRelay} onToggle={(v) => { ticketType.staffServerRelay = v; }} size="sm" />
                        <div>
                          <span class="text-xs font-semibold text-on-surface">{m.e1_tickets_thread_on_staff_server()}</span>
                          <p class="text-2xs text-on-surface-variant/50 leading-none mt-0.5">{m.e1_tickets_thread_on_staff_server_desc()}</p>
                        </div>
                      </div>
                    </div>
                  {/if}

                  <!-- Ticket interne sur le serveur staff (mode CHANNEL uniquement) -->
                  {#if staffServerInfo.staffGuildId && (ticketType.mode === 'CHANNEL' || (ticketType.mode === '' && ticketMode === 'CHANNEL'))}
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                      <div class="flex items-center gap-2.5 p-1">
                        <ToggleSwitch checked={ticketType.staffServerChannel} onToggle={(v) => { ticketType.staffServerChannel = v; }} size="sm" />
                        <div>
                          <span class="text-xs font-semibold text-on-surface">{m.e1_tickets_channel_on_staff_server()}</span>
                          <p class="text-2xs text-on-surface-variant/50 leading-none mt-0.5">{m.e1_tickets_channel_on_staff_server_desc({ name: staffServerInfo.staffGuildName ?? "" })}</p>
                        </div>
                      </div>
                      {#if ticketType.staffServerChannel}
                        <label class="block">
                          <span class="text-2xs font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_staff_server_category()}</span>
                          <SearchableSelect bind:value={ticketType.staffServerCategoryId} options={staffServerInfo.categories.map((c: any) => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_select_category_ph()} className="w-full" />
                          {#if isMissingReference(ticketType.staffServerCategoryId, staffServerInfo.categories)}
                            <p class="text-2xs text-warning mt-1.5">{m.e1_tickets_missing_ref()}</p>
                          {/if}
                        </label>
                      {/if}
                    </div>
                  {/if}

                  <!-- Modal Form Configurator -->
                  <div class="pt-4 border-t border-outline-variant/10 mt-3">
                    <label class="flex items-center gap-3 cursor-pointer p-1 rounded-xl transition-colors">
                      <input type="checkbox" bind:checked={ticketType.formEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                      <div>
                        <span class="text-xs font-bold text-on-surface">{m.e1_tickets_enable_form()}</span>
                        <p class="text-2xs text-on-surface-variant/60">{m.e1_tickets_enable_form_desc()}</p>
                      </div>
                    </label>

                    {#if ticketType.formEnabled}
                      <div class="space-y-4 pt-4 pl-7">
                        <div class="flex items-center justify-between">
                          <span class="text-xs font-bold text-on-surface-variant/80">{m.e1_tickets_custom_questions()}</span>
                          <button
                            onclick={() => addCustomField(index)}
                            disabled={(ticketType.formCustomFields || []).length >= 5}
                            class="px-2 py-1 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1"
                          >
                            <Papicon icon="plus" size={11} /> {m.e1_tickets_add_question()}
                          </button>
                        </div>

                        {#if !(ticketType.formCustomFields || []).length}
                          <div class="p-4 rounded-xl border border-dashed border-outline-variant/20 bg-surface-container/10 text-center">
                            <p class="text-xs text-on-surface-variant/60">{m.e1_tickets_no_question()}</p>
                            <p class="text-2xs text-on-surface-variant/40 mt-1">{m.e1_tickets_no_question_hint()}</p>
                          </div>
                        {:else}
                          <div class="space-y-3">
                            {#each ticketType.formCustomFields as field, fieldIndex}
                              <div class="p-3 rounded-lg border border-outline-variant/10 bg-surface-container/10 space-y-3 relative group">
                                <div class="flex items-center justify-between">
                                  <span class="text-2xs font-bold text-primary">{m.e1_tickets_question_number({ index: fieldIndex + 1 })}</span>
                                  <button
                                    onclick={() => removeCustomField(index, field.id)}
                                    class="text-error hover:text-error p-1 rounded-lg hover:bg-error/10 transition-colors"
                                  >
                                    <Papicon icon="trash-2" size={13} />
                                  </button>
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  <label class="block">
                                    <span class="text-2xs font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_field_question()}</span>
                                    <FormInput type="text" bind:value={field.label} placeholder={m.e1_tickets_field_question_ph()} className="w-full" />
                                  </label>
                                  <label class="block">
                                    <span class="text-2xs font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_field_hint()}</span>
                                    <FormInput type="text" bind:value={field.placeholder} placeholder={m.e1_tickets_field_hint_ph()} className="w-full" />
                                  </label>
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  <label class="block">
                                    <span class="text-2xs font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_answer_type()}</span>
                                    <FormSelect bind:value={field.style} className="w-full">
                                      <option value="SHORT">{m.e1_tickets_answer_short()}</option>
                                      <option value="PARAGRAPH">{m.e1_tickets_answer_paragraph()}</option>
                                      <option value="SELECT">{m.e1_tickets_answer_select()}</option>
                                      <option value="RADIO">{m.e1_tickets_answer_radio()}</option>
                                      <option value="FILE">{m.e1_tickets_answer_file()}</option>
                                    </FormSelect>
                                  </label>
                                  <label class="flex items-center gap-2 cursor-pointer pt-5">
                                    <input type="checkbox" bind:checked={field.required} class="w-3.5 h-3.5 rounded text-primary focus:ring-primary border-outline-variant/30" />
                                    <span class="text-2xs font-bold text-on-surface">{m.e1_tickets_field_required()}</span>
                                  </label>
                                </div>

                                {#if field.style === 'SELECT' || field.style === 'RADIO'}
                                  <div class="pt-1">
                                    <label class="block">
                                      <span class="text-2xs font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_field_choices()}</span>
                                      <FormInput
                                        type="text"
                                        bind:value={field.choicesString}
                                        placeholder={m.e1_tickets_field_choices_ph()}
                                        className="w-full"
                                      />
                                    </label>
                                    {#if field.style === 'RADIO'}
                                      <p class="text-2xs text-on-surface-variant/40 mt-1">{m.e1_tickets_field_choices_radio_hint()}</p>
                                    {/if}
                                  </div>
                                {/if}

                                {#if field.style === 'SELECT' || field.style === 'RADIO' || field.style === 'FILE'}
                                  <p class="text-2xs text-primary/70 leading-snug">{m.e1_tickets_field_interactive_hint()}</p>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        {/if}
                      </div>
                    {/if}
                  </div>

                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

</div>
{/await}

<style>
  .tn-preview {
    padding: 0.75rem 0.9rem;
    border-radius: 0.75rem;
    background: var(--surface-container-lowest);
    border: 1px solid var(--outline-variant);
  }
  .tn-preview__only {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.5rem;
    font-size: 0.6875rem;
    color: var(--on-surface-variant);
  }
  /* Le bandeau bleu à gauche reprend celui d'un embed Discord. */
  .tn-preview__embed {
    padding: 0.6rem 0.8rem;
    border-left: 4px solid #5865f2;
    border-radius: 0.25rem;
    background: var(--surface-container);
  }
</style>
