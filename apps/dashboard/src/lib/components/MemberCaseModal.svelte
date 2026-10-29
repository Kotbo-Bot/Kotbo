<script lang="ts">
  import { Tabs, Button, Callout, SectionCard, EmptyState, Field } from './ui';
  import { memberAvatarSrc } from '../discordMedia';
  import MemberContentPanel from './analytics/MemberContentPanel.svelte';
  import MetricTabs from './analytics/MetricTabs.svelte';
  import TimeSeriesChart from './analytics/TimeSeriesChart.svelte';
  import { fmtMinutes, fmtNumber, shortDate, SERIES } from './analytics/analyticsFormat';
  import { relativeDelta } from './analytics/analyticsFilters.svelte';
  import type { MemberCaseResponse } from '@kotbo/contracts';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { canModerateFeature, canViewFeature } from '../permissions.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { toast } from '../stores/toast.svelte';
  import { confirmDialog } from '../stores/confirmDialog.svelte';
  import Papicon from './Papicon.svelte';
  import { inviteDetailsModal } from '../stores/inviteDetailsModal.svelte';
  import { channelDetailsModal } from '../stores/channelDetailsModal.svelte';
  import { fetchMemberCase, fetchMemberDetailedAnalytics, updateSanctionReport, linkMemberAccount, unlinkMemberAccount, updateMemberNote, runMemberCaseAction, searchMessages, formatMessageSearchTotal, fetchMessageLogChannels } from '../api';
  import { toDateTimeLocal, typeLabel as formatTypeLabel } from '../sanctions/formatters';
  import { buildReportRuleOptions, getRuleIdsFromBrokenRules, getRulesFromBrokenRules, buildBrokenRulesPayload } from '../sanctions/reportRules';
  import SelectedRuleChips from './sanctions/SelectedRuleChips.svelte';
  import EvidenceInputList from './sanctions/EvidenceInputList.svelte';
  import ReportRuleSelector from './sanctions/ReportRuleSelector.svelte';
  import { normalizeEvidenceLinks, sanitizeEvidenceLinks } from '../sanctions/evidenceLinks';
  import InteractionTree from './charts/InteractionTree.svelte';
  import Modal from './Modal.svelte';
  import { m, dateLocale } from '../i18n';
  import LogDetails from './logs/LogDetails.svelte';

  import { errorMessage } from '@kotbo/shared';
  type MemberCaseTab = 'extra' | 'resume' | 'identite' | 'activite' | 'messages' | 'logs' | 'sanctions' | 'invites' | 'connexions' | 'analytics' | 'contenu' | 'candidatures' | 'linked_accounts' | 'notes';

  type MemberAnalyticsResponse = {
    totalMessages: number;
    totalVoiceMinutes: number;
    activeDays: number;
    period: number;
    dailyTrend: Array<{ dateKey: string; messages: number; voiceMinutes: number }>;
  };

  let {
    open = $bindable(false),
    userName = '',
    userId = null as string | null,
    caseData = null as MemberCaseResponse | null,
    loading = false,
    error = '',
    actionReason = $bindable(''),
    actionDuration = $bindable('30m'),
    actionBusy = false,
    actionFeedback = '',
    actionIsError = false,
    onClose = () => {},
    onSelectUser = (_userId: string) => {},
    initialTab = 'resume' as MemberCaseTab,
    showProfileLink = true,
    extraTab = null,
  } = $props<{
    open?: boolean;
    userName?: string;
    userId?: string | null;
    caseData?: MemberCaseResponse | null;
    loading?: boolean;
    error?: string;
    actionReason?: string;
    actionDuration?: string;
    actionBusy?: boolean;
    actionFeedback?: string;
    actionIsError?: boolean;
    onClose?: (e: MouseEvent) => void;
    onAction?: (action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') => void;
    onSelectUser?: (userId: string) => void;
    /** Onglet affiché à l'ouverture : la fiche complète ouvre directement les actions. */
    initialTab?: MemberCaseTab;
    /** Lien vers la fiche complète, masqué quand le dossier s'ouvre depuis elle. */
    showProfileLink?: boolean;
    /**
     * Onglet propre a la page qui ouvre le dossier, place en tete : la gestion
     * du staff y montre grade, discipline et parcours. `initialTab: 'extra'`
     * l'ouvre directement.
     */
    extraTab?: { label: string; icon: string; content: import('svelte').Snippet } | null;
  }>();

  let activeTab = $state<MemberCaseTab>('resume');
  let analyticsData = $state<MemberAnalyticsResponse | null>(null);
  /** Les 30 jours d'avant, jour par jour : la courbe les montre en pointilles, comme Analytics. */
  let previousTrend = $state<Array<{ dateKey: string; messages: number; voiceMinutes: number }>>([]);
  let analyticsLoading = $state(false);
  let trendMetric = $state<'messages' | 'voice'>('messages');

  // --- NOUVEAUX ÉTATS POUR L'ONGLET MESSAGES ---
  let messageQuery = $state('');
  let messageChannelId = $state('');
  let messageIncludeDeleted = $state(true);
  const messageLimit = $state(20);
  let messageOffset = $state(0);
  let messageFrom = $state('');
  let messageTo = $state('');

  let messagesList = $state<any[]>([]);
  let messagesTotalCount = $state(0);
  let messagesTotalCapped = $state(false);
  let messagesHasMore = $state(false);
  let messagesLoading = $state(false);
  let messagesChannels = $state<any[]>([]);

  // --- FILTRES DE L'ONGLET LOGS ---
  // Les logs arrivent deja entiers dans caseData (le serveur en plafonne le
  // nombre), le filtrage est donc local et instantane : pas d'aller-retour.
  let logQuery = $state('');
  let logModule = $state('');
  let logSource = $state('');
  let logFrom = $state('');
  let logTo = $state('');
  let logOrder = $state<'desc' | 'asc'>('desc');

  const logModules = $derived(
    [...new Set((caseData?.logs ?? []).map((log: any) => log.module).filter(Boolean))].sort(
      (a: any, b: any) => String(a).localeCompare(String(b), 'fr'),
    ),
  );
  const logSources = $derived(
    [...new Set((caseData?.logs ?? []).map((log: any) => log.source).filter(Boolean))].sort(
      (a: any, b: any) => String(a).localeCompare(String(b), 'fr'),
    ),
  );

  const filteredLogs = $derived.by(() => {
    const query = logQuery.trim().toLowerCase();
    // Bornes inclusives : `to` couvre la journee entiere.
    const from = logFrom ? new Date(`${logFrom}T00:00:00`).getTime() : null;
    const to = logTo ? new Date(`${logTo}T23:59:59.999`).getTime() : null;

    const matching = (caseData?.logs ?? []).filter((log: any) => {
      if (logModule && log.module !== logModule) return false;
      if (logSource && log.source !== logSource) return false;
      if (from !== null || to !== null) {
        const at = new Date(log.dateIso).getTime();
        if (Number.isNaN(at)) return false;
        if (from !== null && at < from) return false;
        if (to !== null && at > to) return false;
      }
      if (!query) return true;
      return [log.action, log.module, log.source, log.details]
        .some((field) => String(field ?? '').toLowerCase().includes(query));
    });

    return matching.toSorted(
      (a: any, b: any) => {
        const delta = new Date(a.dateIso).getTime() - new Date(b.dateIso).getTime();
        return logOrder === 'asc' ? delta : -delta;
      },
    );
  });

  // --- CALCUL DES STATISTIQUES RICHES DÉRIVÉES ---
  const moderationRiskScore = $derived.by(() => {
    let score = 0;
    if (!caseData) return 0;
    if (caseData.isSuspectedDC || caseData.profile?.isSuspectedDC) score += 30;
    const activeSanctions = caseData.sanctions?.filter(s => s.status === 'ACTIVE') || [];
    const pastSanctions = caseData.sanctions?.filter(s => s.status !== 'ACTIVE') || [];
    score += activeSanctions.length * 25;
    score += pastSanctions.length * 10;
    if (caseData.linkedAccounts && caseData.linkedAccounts.length > 0) {
      score += caseData.linkedAccounts.length * 15;
    }
    return Math.min(100, score);
  });

  const memberSeniority = $derived.by(() => {
    if (!caseData?.profile?.guildJoinedAt) return m.mcm_seniority_newcomer();
    const joined = new Date(caseData.profile.guildJoinedAt).getTime();
    const ageDays = (Date.now() - joined) / (1000 * 60 * 60 * 24);
    if (ageDays > 365) return m.mcm_seniority_veteran();
    if (ageDays > 180) return m.mcm_seniority_old();
    if (ageDays > 30) return m.mcm_seniority_regular();
    if (ageDays > 7) return m.mcm_seniority_recent();
    return m.mcm_seniority_newcomer();
  });

  /** Tuiles d'Analytics : messages et vocal sur 30 jours, avec l'ecart a la periode d'avant. */
  const memberMetrics = $derived.by(() => {
    if (!analyticsData) return [];
    const cur = analyticsData.dailyTrend;
    const prev = previousTrend;
    const sum = (rows: typeof cur, key: 'messages' | 'voiceMinutes') => rows.reduce((total, d) => total + d[key], 0);
    return [
      {
        id: 'messages',
        label: m.mcm_messages(),
        color: SERIES[0]!,
        format: fmtNumber,
        value: fmtNumber(sum(cur, 'messages')),
        delta: relativeDelta(sum(cur, 'messages'), sum(prev, 'messages')),
        spark: cur.map((d) => d.messages),
        daily: cur.map((d) => d.messages),
        prevDaily: prev.map((d) => d.messages),
      },
      {
        id: 'voice',
        label: m.mcm_voice(),
        color: SERIES[2]!,
        format: fmtMinutes,
        value: fmtMinutes(sum(cur, 'voiceMinutes')),
        delta: relativeDelta(sum(cur, 'voiceMinutes'), sum(prev, 'voiceMinutes')),
        spark: cur.map((d) => d.voiceMinutes),
        daily: cur.map((d) => d.voiceMinutes),
        prevDaily: prev.map((d) => d.voiceMinutes),
      },
    ];
  });
  const selectedMetric = $derived(memberMetrics.find((metric) => metric.id === trendMetric) ?? memberMetrics[0]);
  const trendLabels = $derived(analyticsData?.dailyTrend.map((d) => shortDate(d.dateKey)) ?? []);
  const hasTrend = $derived(!!analyticsData && analyticsData.dailyTrend.some((d) => d.messages > 0 || d.voiceMinutes > 0));

  const topChannels = $derived.by(() => {
    if (!caseData?.messagesByChannel) return [];
    return [...caseData.messagesByChannel]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  });

  // --- FONCTIONS DE CHARGEMENT ET D'ACTION ---
  async function loadMemberMessages() {
    if (!userId) return;
    messagesLoading = true;
    try {
      const data = await searchMessages({
        authorId: userId,
        q: messageQuery.trim() || undefined,
        channelId: messageChannelId || undefined,
        includeDeleted: messageIncludeDeleted,
        from: messageFrom || undefined,
        to: messageTo || undefined,
        limit: messageLimit,
        offset: messageOffset,
        order: 'desc'
      });
      messagesList = data.messages || [];
      messagesTotalCount = data.total || 0;
      messagesTotalCapped = data.totalCapped;
      messagesHasMore = data.hasMore;
    } catch (e) {
      console.error('Failed to load member messages:', e);
    } finally {
      messagesLoading = false;
    }
  }

  async function loadMemberMessageChannels() {
    if (!userId) return;
    try {
      messagesChannels = await fetchMessageLogChannels(undefined, userId);
    } catch (e) {
      console.error('Failed to load member message channels:', e);
    }
  }

  function parseDurationToMs(durationStr: string): number {
    const match = durationStr.match(/^(\d+)([smhd])$/i);
    if (!match) return 30 * 60 * 1000;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return value * 60 * 1000;
    }
  }

  /**
   * Droit de consulter un dossier membre.
   *
   * Douze pages ouvrent ce dossier - giveaways, journaux, sanctions, reunions,
   * tickets... - et chacune verifiait le droit pour son propre compte, ou pas
   * du tout. Le test vit ici : la fenetre ne s'ouvre pas, quel que soit le
   * chemin emprunte, et l'API refuse de toute facon la fiche.
   */
  const canViewMembers = $derived(canViewFeature('members'));

  /**
   * Le dossier montrait ses boutons de sanction, sa note et son formulaire de
   * liaison a quiconque pouvait l'ouvrir : un role a qui le centre de gestion
   * n'accorde que la lecture de « Membres » les voyait tous, et n'apprenait le
   * refus qu'en cliquant.
   */
  const canModerateMembers = $derived(canModerateFeature('members'));

  /** L'edition d'un rapport appartient a « Sanctions », pas a « Membres ». */
  const canModerateSanctions = $derived(canModerateFeature('sanctions'));

  async function executeModerationAction(action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') {
    if (!userId || !canModerateMembers) return;
    
    const reasonText = actionReason.trim() || m.mcm_default_reason();
    let confirmTitle = '';
    let confirmDesc = '';
    let confirmLabel = '';
    let variant: 'danger' | 'warning' = 'warning';
    
    if (action === 'WARN') {
      confirmTitle = m.mcm_confirm_warn_title({ name: userName });
      confirmDesc = m.mcm_confirm_warn_desc({ reason: reasonText });
      confirmLabel = m.mcm_action_warn();
    } else if (action === 'TIMEOUT') {
      confirmTitle = m.mcm_confirm_timeout_title({ name: userName });
      confirmDesc = m.mcm_confirm_timeout_desc({ duration: actionDuration, reason: reasonText });
      confirmLabel = m.mcm_action_exclude();
    } else if (action === 'KICK') {
      confirmTitle = m.mcm_confirm_kick_title({ name: userName });
      confirmDesc = m.mcm_confirm_kick_desc({ reason: reasonText });
      confirmLabel = m.mcm_action_kick();
      variant = 'danger';
    } else if (action === 'BAN') {
      confirmTitle = m.mcm_confirm_ban_title({ name: userName });
      confirmDesc = m.mcm_confirm_ban_desc({ reason: reasonText });
      confirmLabel = m.mcm_action_ban();
      variant = 'danger';
    }
    
    const confirmed = await confirmDialog.ask({
      title: confirmTitle,
      description: confirmDesc,
      confirmLabel,
      variant
    });
    
    if (!confirmed) return;
    
    actionBusy = true;
    actionFeedback = '';
    actionIsError = false;
    
    try {
      const payload: { reason: string; durationMs?: number | null } = {
        reason: reasonText
      };
      
      if (action === 'TIMEOUT') {
        payload.durationMs = parseDurationToMs(actionDuration);
      }
      
      const res = await runMemberCaseAction(userId, action, payload);
      if (res?.ok) {
        toast.success(m.mcm_action_done({ action }));
        actionReason = '';
        // Recharger le dossier membre
        const updatedCase = await fetchMemberCase(userId);
        if (updatedCase) {
          caseData = updatedCase;
        }
      } else {
        throw new Error(res?.error || m.mcm_action_error());
      }
    } catch (err) {
      actionIsError = true;
      actionFeedback = errorMessage(err) || m.mcm_action_error_generic();
      toast.error(actionFeedback);
    } finally {
      actionBusy = false;
    }
  }
  let viewingReportSanctionId = $state<string | null>(null);
  let isEditingReport = $state(false);
  let updateReportBusy = $state(false);
  let editReportData = $state({
    incidentAt: '',
    sanctionDurationLabel: '',
    selectedRuleIds: [] as string[],
    detailedReason: '',
    evidenceLinks: [] as string[],
    additionalNotes: ''
  });

  let requestVerificationBusy = $state(false);

  // Historique des vérifications : un modérateur doit voir d'un coup d'oeil
  // qu'un collègue en a déjà demandé une, et depuis quand (issue #216).
  const verifications = $derived(caseData?.verifications ?? null);
  const verificationEntries = $derived(verifications?.entries ?? []);
  const verificationCount = $derived(verifications?.total ?? 0);
  const verificationPending = $derived(verifications?.hasPending ?? false);
  const verificationCooldownUntil = $derived(
    verifications?.cooldownUntil ? new Date(verifications.cooldownUntil) : null
  );
  // Recalculé à chaque rendu du modal : suffisant ici, le staff rouvre la fiche
  // plutôt que de fixer le bouton en attendant la fin du délai.
  const verificationBlocked = $derived(
    verificationPending
    || (verificationCooldownUntil !== null && verificationCooldownUntil.getTime() > Date.now())
  );

  function formatVerificationDate(value: string | null | undefined): string {
    if (!value) return m.mcm_verif_never();
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return m.mcm_verif_never();
    return date.toLocaleString(dateLocale(), {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  const VERIFICATION_STATUS_STYLES: Record<string, string> = {
    VERIFIED: 'badge-success',
    PENDING: 'badge-warning',
    FLAGGED: 'badge-danger',
    EXPIRED: 'badge-neutral',
  };

  function verificationStatusLabel(status: string): string {
    switch (status) {
      case 'VERIFIED': return m.mcm_verif_status_verified();
      case 'PENDING': return m.mcm_verif_status_pending();
      case 'FLAGGED': return m.mcm_verif_status_flagged();
      default: return m.mcm_verif_status_expired();
    }
  }

  async function handleRequestVerification() {
    if (!userId || !canModerateMembers) return;
    if (verificationBlocked) {
      toast.error(verificationPending ? m.mcm_verif_already_pending() : m.mcm_verif_cooldown());
      return;
    }
    if (!(await confirmDialog.ask({ title: m.mcm_verif_title(), description: m.mcm_verif_desc(), confirmLabel: m.mcm_verif_confirm(), variant: 'warning' }))) return;
    requestVerificationBusy = true;
    try {
      const res = await runMemberCaseAction(userId, 'REQUEST_VERIFICATION', {
        reason: m.mcm_verif_reason()
      });
      toast.success(m.mcm_verif_sent());
      const updatedCase = await fetchMemberCase(userId);
      if (updatedCase) caseData = updatedCase;
    } catch (err) {
      toast.error(errorMessage(err) || m.mcm_error_request());
    } finally {
      requestVerificationBusy = false;
    }
  }

  let targetAccountId = $state('');
  let linkReason = $state('');
  let linkBusy = $state(false);
  let linkFeedback = $state('');
  let linkIsError = $state(false);

  async function handleLinkAccount() {
    if (!canModerateMembers) return;
    if (!targetAccountId.trim()) {
      linkIsError = true;
      linkFeedback = m.mcm_error_id_required();
      return;
    }

    linkBusy = true;
    linkFeedback = '';
    linkIsError = false;

    try {
      const success = await linkMemberAccount(userId!, targetAccountId, linkReason);
      if (success) {
        linkIsError = false;
        linkFeedback = m.mcm_link_success();
        targetAccountId = '';
        linkReason = '';
        if (userId) {
          const updatedCase = await fetchMemberCase(userId);
          if (updatedCase) {
            caseData = updatedCase;
          }
        }
      } else {
        linkIsError = true;
        linkFeedback = m.mcm_link_error();
      }
    } catch (e) {
      linkIsError = true;
      linkFeedback = errorMessage(e) || m.mcm_error_unexpected_long();
    } finally {
      linkBusy = false;
    }
  }

  /**
   * Suggestions « ce compte est déjà lié à X sur d'autres serveurs ».
   * Les liens déjà reproduits ici restent affichés (en confirmation), mais ne
   * proposent plus de bouton d'action.
   */
  const crossServerLinks = $derived(caseData?.crossServerLinks ?? null);
  const crossServerLinkSuggestions = $derived(crossServerLinks?.suggestions ?? []);
  const pendingCrossServerLinks = $derived(crossServerLinkSuggestions.filter((s) => !s.alreadyLinkedHere));

  let applyingSuggestionId = $state<string | null>(null);

  /** Reproduit ici un lien déjà posé ailleurs, en traçant sa provenance dans la raison. */
  async function handleApplySuggestedLink(suggestion: { userId: string; serverCount: number; guilds: { guildName: string }[] }) {
    if (applyingSuggestionId || !canModerateMembers) return;
    applyingSuggestionId = suggestion.userId;

    const servers = suggestion.guilds.map((g) => g.guildName).join(', ');
    try {
      const success = await linkMemberAccount(
        userId!,
        suggestion.userId,
        m.mcm_xlink_apply_reason({ count: suggestion.serverCount, servers }),
      );
      if (success) {
        toast.success(m.mcm_link_success());
        if (userId) {
          const updatedCase = await fetchMemberCase(userId);
          if (updatedCase) caseData = updatedCase;
        }
      } else {
        toast.error(m.mcm_link_error());
      }
    } catch (e) {
      toast.error(errorMessage(e) || m.mcm_error_unexpected_long());
    } finally {
      applyingSuggestionId = null;
    }
  }

  let unlinkingAccountId = $state<string | null>(null);

  async function handleUnlinkAccount(targetId: string) {
    if (!(await confirmDialog.ask({ title: m.mcm_unlink_title(), confirmLabel: m.mcm_unlink_confirm(), variant: 'warning' }))) return;
    unlinkingAccountId = targetId;

    try {
      const success = await unlinkMemberAccount(userId!, targetId);
      if (success) {
        if (userId) {
          const updatedCase = await fetchMemberCase(userId);
          if (updatedCase) {
            caseData = updatedCase;
          }
        }
      } else {
        toast.error(m.mcm_error_unlink());
      }
    } catch (e) {
      toast.error(errorMessage(e) || m.mcm_error_unexpected());
    } finally {
      unlinkingAccountId = null;
    }
  }

  let moderatorNote = $state('');
  let noteBusy = $state(false);
  let noteFeedback = $state('');

  $effect(() => {
    if (caseData?.profile?.moderatorNote !== undefined) {
      moderatorNote = caseData?.profile?.moderatorNote ?? '';
    }
  });

  async function handleSaveNote() {
    if (!userId || !canModerateMembers) return;
    noteBusy = true;
    noteFeedback = '';
    try {
      const result = await updateMemberNote(userId, moderatorNote);
      if (result?.ok) {
        noteFeedback = m.mcm_note_saved();
        if (caseData?.profile) {
          caseData.profile.moderatorNote = moderatorNote;
        }
      } else {
        noteFeedback = m.mcm_error_save();
      }
    } catch (e) {
      noteFeedback = m.mcm_error_save();
    } finally {
      noteBusy = false;
    }
  }

  function startEditingReport(report: any) {
    if (!canModerateSanctions) return;
    editReportData = {
      incidentAt: toDateTimeLocal(report.incidentAt),
      sanctionDurationLabel: report.sanctionDurationLabel || '',
      selectedRuleIds: getRuleIdsFromBrokenRules(report.brokenRules),
      detailedReason: report.detailedReason,
      evidenceLinks: normalizeEvidenceLinks(report.evidenceLinks, true),
      additionalNotes: report.additionalNotes || ''
    };
    isEditingReport = true;
  }

  async function handleUpdateReport() {
    if (!viewingReportSanctionId || !selectedReport || !canModerateSanctions) return;
    updateReportBusy = true;

    try {
      const success = await updateSanctionReport(selectedReport.id, {
        incidentAt: new Date(editReportData.incidentAt).toISOString(),
        sanctionDurationLabel: editReportData.sanctionDurationLabel.trim(),
        brokenRules: buildBrokenRulesPayload(editReportData.selectedRuleIds, reportRuleOptions),
        detailedReason: editReportData.detailedReason,
        evidenceLinks: sanitizeEvidenceLinks(editReportData.evidenceLinks),
        additionalNotes: editReportData.additionalNotes.trim() || null
      });

      if (success) {
        // We rely on broadcastDashboardStateChange to refresh the data
        // But for immediate feedback, we can close the edit mode
        isEditingReport = false;
        // Optionally, update the local caseData if we want to be fast
        if (caseData?.sanctionReports) {
          const idx = caseData.sanctionReports.findIndex(r => r.id === selectedReport.id);
          if (idx !== -1) {
            caseData.sanctionReports[idx] = {
              ...caseData.sanctionReports[idx],
              incidentAt: new Date(editReportData.incidentAt).toISOString(),
              sanctionDurationLabel: editReportData.sanctionDurationLabel.trim(),
              brokenRules: buildBrokenRulesPayload(editReportData.selectedRuleIds, reportRuleOptions),
              detailedReason: editReportData.detailedReason,
              evidenceLinks: sanitizeEvidenceLinks(editReportData.evidenceLinks),
              additionalNotes: editReportData.additionalNotes.trim() || null
            };
          }
        }
      }
    } catch (e) {
      console.error('Failed to update sanction report:', e);
    } finally {
      updateReportBusy = false;
    }
  }


  const sanctions = $derived(
    caseData?.sanctions
      ? [...caseData.sanctions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      : []
  );

  const crossServer = $derived(caseData?.crossServerSanctions ?? null);
  const crossServerBreakdown = $derived(
    crossServer
      ? Object.entries(crossServer.breakdown).filter(([, count]) => (count as number) > 0)
      : []
  );

  // Icône Papicon + classes de couleur (statiques pour Tailwind) par type de sanction.
  function getSanctionTypeStyle(type: string): { icon: string; tile: string; dot: string } {
    switch (type.toUpperCase()) {
      case 'WARN': return { icon: 'alert-triangle', tile: 'bg-warning/10 text-warning', dot: 'bg-warning' };
      case 'TIMEOUT': return { icon: 'clock', tile: 'bg-primary/10 text-primary', dot: 'bg-primary' };
      case 'KICK': return { icon: 'log-out', tile: 'bg-warning/10 text-warning', dot: 'bg-warning' };
      case 'TEMP_BAN': return { icon: 'ban', tile: 'bg-error/10 text-error', dot: 'bg-error' };
      case 'BAN': return { icon: 'gavel', tile: 'bg-error/10 text-error', dot: 'bg-error' };
      case 'SOFTBAN': return { icon: 'eraser', tile: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-on-surface-variant' };
      case 'JAIL': return { icon: 'lock', tile: 'bg-warning/10 text-warning', dot: 'bg-warning' };
      default: return { icon: 'shield', tile: 'bg-surface-container-high text-on-surface-variant', dot: 'bg-on-surface-variant' };
    }
  }

  const reportRuleOptions = $derived(buildReportRuleOptions(dashboardStore.state.regulationRules || []));
  const selectedSanctionForReport = $derived(sanctions.find(s => s.id === viewingReportSanctionId) || null);
  const selectedReport = $derived(
    viewingReportSanctionId 
      ? [...(dashboardStore.state.sanctionReports || []), ...(caseData?.sanctionReports || [])].find(r => r.sanctionId === viewingReportSanctionId) || null
      : null
  );
  const selectedReportRules = $derived(
    selectedReport ? getRulesFromBrokenRules(selectedReport.brokenRules, reportRuleOptions) : []
  );
  const editDraftRules = $derived(
    editReportData.selectedRuleIds
      .map(id => reportRuleOptions.find(r => r.id === id))
      .filter((r): r is any => !!r)
  );

  const tabs: { id: MemberCaseTab; label: string; icon: string; count?: () => number }[] = $derived([
    ...(extraTab ? [{ id: 'extra' as const, label: extraTab.label, icon: extraTab.icon }] : []),
    { id: 'resume', label: m.mcm_tab_summary(), icon: 'layout' },
    { id: 'identite', label: m.mcm_tab_identity(), icon: 'user' },
    { id: 'activite', label: m.mcm_tab_activity(), icon: 'trending-up' },
    { id: 'analytics', label: m.mcm_tab_analytics(), icon: 'bar-chart-2' },
    { id: 'contenu', label: m.anx_member_content_tab(), icon: 'message-square' },
    { id: 'messages', label: m.mcm_tab_messages(), icon: 'message-square', count: () => caseData?.recentMessageCount ?? 0 },
    { id: 'logs', label: m.mcm_tab_logs(), icon: 'history', count: () => caseData?.recentLogCount ?? 0 },
    { id: 'sanctions', label: m.mcm_tab_sanctions(), icon: 'hammer', count: () => sanctions.length },
    { id: 'candidatures', label: m.mcm_tab_candidates(), icon: 'user-check', count: () => caseData?.candidatures?.length ?? 0 },
    { id: 'invites', label: m.mcm_tab_invites(), icon: 'mail', count: () => caseData?.createdInvites?.length ?? 0 },
    { id: 'connexions', label: m.mcm_tab_connections(), icon: 'link' },
    { id: 'linked_accounts', label: m.mcm_tab_linked(), icon: 'link-2', count: () => (caseData?.linkedAccounts?.length ?? 0) + pendingCrossServerLinks.length },
    { id: 'notes', label: m.mcm_tab_notes(), icon: 'edit-3' },
  ]);

  const displayName = $derived(caseData?.profile?.displayName || caseData?.profile?.globalName || userName);
  const activeSanctionCount = $derived(sanctions.filter((s) => s.status === 'ACTIVE').length);
  const riskTone = $derived(moderationRiskScore < 30 ? 'success' : moderationRiskScore < 70 ? 'warning' : 'error');
  const visibleTabs = $derived(tabs.map((tab) => {
    const count = tab.count && caseData ? tab.count() : 0;
    return { id: tab.id, label: tab.label, icon: tab.icon, badge: count > 0 ? count : undefined };
  }));

  function formatDateTime(value: string | null | undefined) {
    if (!value) return 'Inconnu';
    return new Date(value).toLocaleString(dateLocale());
  }

  function formatDateShort(value: string | null | undefined) {
    if (!value) return '-';
    return new Date(value).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
  }


  function formatDurationFromSeconds(seconds: number | null | undefined) {
    if (!seconds || seconds <= 0) return '0s';
    const totalSeconds = Math.floor(seconds);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts: string[] = [];
    if (days) parts.push(`${days}j`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (parts.length === 0) parts.push(`${totalSeconds}s`);
    return parts.join(' ');
  }

  function formatRelative(value: string | null | undefined) {
    if (!value) return m.mcm_never();
    const date = new Date(value);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return m.mcm_just_now();
    if (minutes < 60) return m.mcm_ago_minutes({ n: minutes });
    if (hours < 24) return m.mcm_ago_hours({ n: hours });
    if (days < 7) return m.mcm_ago_days({ n: days });
    return date.toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short' });
  }

  function getDurationSince(value: string | null | undefined) {
    if (!value) return m.mcm_unknown();
    const start = new Date(value);
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    
    if (months < 0) {
      years--;
      months += 12;
    }

    const parts: string[] = [];
    if (years > 0) parts.push(years > 1 ? m.mcm_years_other({ n: years }) : m.mcm_years_one({ n: years }));
    if (months > 0) parts.push(m.mcm_months({ n: months }));

    if (parts.length === 0) {
       const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
       if (days <= 0) return m.mcm_today();
       return days > 1 ? m.mcm_days_other({ n: days }) : m.mcm_days_one({ n: days });
    }
    
    return parts.join(', ');
  }


  function getPresenceColor(status: string | null | undefined) {
    const s = status?.toLowerCase();
    if (s === 'online') return 'bg-success';
    if (s === 'idle') return 'bg-warning';
    if (s === 'dnd' || s === 'left') return 'bg-error';
    return 'bg-on-surface-variant/50';
  }

  function getPresenceLabel(status: string | null | undefined) {
    if (!status) return m.mcm_presence_offline();
    const s = status.toLowerCase();
    if (s === 'left') return m.mcm_presence_left();
    if (s === 'online') return m.mcm_presence_online();
    if (s === 'idle') return m.mcm_presence_idle();
    if (s === 'dnd') return m.mcm_presence_dnd();
    return m.mcm_presence_offline();
  }

  /**
   * Les mentions des journaux ne portent que des identifiants : on nomme celles
   * des contacts deja connus du dossier, les autres restent `@utilisateur`.
   */
  const logUserNames = $derived(Object.fromEntries(
    (caseData?.interactionGraph?.nodes ?? []).map((node: { id: string; label: string }) => [node.id, node.label]),
  ));

  function getConnectionIcon(type: string) {
    const t = type.toLowerCase();
    if (t === 'youtube') return 'video';
    if (t === 'twitch') return 'tv';
    if (t === 'twitter' || t === 'x') return 'twitter';
    if (t === 'spotify') return 'music';
    if (t === 'github') return 'github';
    if (t === 'steam') return 'gamepad';
    if (t === 'reddit') return 'message-square';
    if (t === 'instagram') return 'instagram';
    if (t === 'facebook') return 'facebook';
    if (t === 'tiktok') return 'play';
    if (t === 'playstation' || t === 'xbox' || t === 'battlenet' || t === 'epicgames' || t === 'riotgames') return 'gamepad';
    return 'link';
  }


  function getSanctionStatusLabel(status: string) {
    const s = status.toUpperCase();
    if (s === 'ACTIVE') return m.mcm_status_active();
    if (s === 'RESOLVED') return m.mcm_status_resolved();
    if (s === 'EXPIRED') return m.mcm_status_expired();
    return status;
  }

  async function loadMemberAnalytics() {
    if (!userId || !authStore.selectedGuildId) return;
    analyticsLoading = true;
    try {
      // 60 jours d'un coup, coupes en deux fenetres de 30 : la periode et celle
      // d'avant. L'API ne renvoie que les jours actifs, on remet les jours vides.
      const raw = await fetchMemberDetailedAnalytics(userId, 60) as MemberAnalyticsResponse | null;
      const byDay = new Map((raw?.dailyTrend ?? []).map((d) => [d.dateKey, d]));
      const lastDays = (offset: number) => Array.from({ length: 30 }, (_, i) => {
        const day = new Date();
        day.setDate(day.getDate() - offset - (29 - i));
        const dateKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        const hit = byDay.get(dateKey);
        return { dateKey, messages: hit?.messages ?? 0, voiceMinutes: hit?.voiceMinutes ?? 0 };
      });
      const current = lastDays(0);
      previousTrend = lastDays(30);
      analyticsData = raw ? {
        ...raw,
        period: 30,
        dailyTrend: current,
        totalMessages: current.reduce((sum, d) => sum + d.messages, 0),
        totalVoiceMinutes: current.reduce((sum, d) => sum + d.voiceMinutes, 0),
        activeDays: current.filter((d) => d.messages > 0 || d.voiceMinutes > 0).length,
      } : null;
    } catch (e) {
      console.error('Failed to load member analytics:', e);
    } finally {
      analyticsLoading = false;
    }
  }

  $effect(() => {
    if (open) {
      activeTab = initialTab;
      messageQuery = '';
      messageChannelId = '';
      messageIncludeDeleted = true;
      messageOffset = 0;
      messageFrom = '';
      messageTo = '';
      messagesList = [];
      messagesTotalCount = 0;
      messagesTotalCapped = false;
      messagesHasMore = false;
      void loadMemberAnalytics();
    }
  });

  $effect(() => {
    if (open && activeTab === 'messages' && userId) {
      void loadMemberMessageChannels();
    }
  });

  $effect(() => {
    if (open && activeTab === 'messages' && userId) {
      // dependances reactives pour forcer la mise a jour
      const _q = messageQuery;
      const _c = messageChannelId;
      const _d = messageIncludeDeleted;
      const _f = messageFrom;
      const _t = messageTo;
      const _o = messageOffset;
      const _l = messageLimit;
      void loadMemberMessages();
    }
  });
</script>

<!-- Vide qui est une bonne nouvelle ou un simple constat : pas de bouton a inventer. -->
{#snippet quietEmpty(icon: string, title: string, description = '')}
  <div class="section-card flex flex-col items-center gap-1.5 px-6 py-12 text-center">
    <span class="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-surface-container text-on-surface-variant"><Papicon {icon} size={20} /></span>
    <p class="text-sm font-medium text-on-surface">{title}</p>
    {#if description}<p class="max-w-sm text-sm text-on-surface-variant">{description}</p>{/if}
  </div>
{/snippet}

{#snippet facts(rows: Array<{ label: string; value: string; tone?: string }>)}
  <dl class="mc-facts">
    {#each rows as row (row.label)}
      <div>
        <dt>{row.label}</dt>
        <dd class={row.tone ?? ''}>{row.value}</dd>
      </div>
    {/each}
  </dl>
{/snippet}

{#snippet inviter(compact = false)}
  {#if caseData?.invite?.inviterTag}
    {@const tag = caseData.invite.inviterTag}
    {#if caseData.invite.inviterId}
      <button
        type="button"
        class="mc-person"
        onclick={() => caseData?.invite?.inviterId && onSelectUser(caseData.invite.inviterId)}
        title={m.mcm_open_inviter()}
      >
        <img src={memberAvatarSrc(caseData.invite.inviterAvatarUrl, tag, caseData.invite.inviterId)} alt="" class="{compact ? 'h-5 w-5' : 'h-6 w-6'} rounded-full object-cover" />
        <span class="truncate">@{tag}</span>
      </button>
    {:else}
      <span class="mc-person mc-person--static">
        <img src={memberAvatarSrc(caseData.invite.inviterAvatarUrl, tag, null)} alt="" class="{compact ? 'h-5 w-5' : 'h-6 w-6'} rounded-full object-cover" />
        <span class="truncate">@{tag}</span>
      </span>
    {/if}
  {:else}
    <span class="text-sm text-on-surface-variant">{m.mcm_unknown_origin()}</span>
  {/if}
{/snippet}

{#snippet inviteCode()}
  {#if caseData?.invite?.code}
    <button type="button" class="mc-code" onclick={() => inviteDetailsModal.show(caseData.invite.code)} title={m.mcm_open_invites_view()}>
      {caseData.invite.code}
    </button>
  {:else}
    <span class="text-sm text-on-surface-variant">-</span>
  {/if}
{/snippet}

{#snippet roleChip(role: { name: string; color?: string | null })}
  <span class="mc-role">
    <span class="h-2 w-2 shrink-0 rounded-full" style="background: {role.color && role.color !== '#000000' ? role.color : 'var(--outline-variant)'}"></span>
    {role.name}
  </span>
{/snippet}

{#snippet toolbarSelect(value: string, onchange: (v: string) => void, options: Array<{ value: string; label: string }>, label: string)}
  <select class="input mc-select" aria-label={label} {value} onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)}>
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
{/snippet}

<Modal
  flush
  open={open && canViewMembers}
  onClose={onClose}
  size="screen"
  showCloseButton={false}
>
  <div class="mc" role="presentation" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <!-- ── Identite ───────────────────────────────────────── -->
    <header class="mc-header">
      {#if caseData?.profile?.bannerUrl}
        <div class="mc-banner" style="background-image: url('{caseData.profile.bannerUrl}')" aria-hidden="true"></div>
      {/if}
      <div class="mc-identity">
        <div class="relative shrink-0">
          <img
            src={memberAvatarSrc(caseData?.profile?.avatarUrl, displayName, userId)}
            alt={m.mcm_avatar_alt()}
            class="h-14 w-14 rounded-xl object-cover bg-surface-container"
          />
          <span
            class="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface-container-lowest {getPresenceColor(caseData?.profile?.presenceStatus)}"
            title={getPresenceLabel(caseData?.profile?.presenceStatus)}
          ></span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id="modal-title" class="truncate text-xl font-semibold tracking-tight text-on-surface">{displayName}</h2>
            {#if caseData?.profile?.staffGrade}
              <span class="badge badge-info"><Papicon icon="star" size={11} />{caseData.profile.staffGrade}</span>
            {/if}
            {#if caseData?.profile?.isTutor}
              <span class="badge badge-info"><Papicon icon="user-check" size={11} />{m.mcm_tutor_badge()}</span>
            {/if}
            {#if caseData?.profile?.isBot}
              <span class="badge badge-neutral">Bot</span>
            {/if}
            {#if verificationPending}
              <span class="badge badge-warning"><Papicon icon="clock" size={11} />{m.mcm_verif_badge_pending()}</span>
            {:else if verifications?.lastVerifiedAt}
              <span class="badge badge-success"><Papicon icon="check-circle" size={11} />{m.mcm_verif_badge_done()}</span>
            {/if}
          </div>
          <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-on-surface-variant">
            <span>@{caseData?.profile?.username || userName}</span>
            <span aria-hidden="true">·</span>
            <span class="inline-flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full {getPresenceColor(caseData?.profile?.presenceStatus)}"></span>
              {getPresenceLabel(caseData?.profile?.presenceStatus)}
            </span>
            {#if caseData?.profile?.pronouns}
              <span aria-hidden="true">·</span>
              <span>{caseData.profile.pronouns}</span>
            {/if}
          </p>
        </div>
        <div class="mc-header-actions">
          {#if userId && canModerateMembers}
            <Button
              size="sm"
              icon="shield-alert"
              loading={requestVerificationBusy}
              disabled={verificationBlocked}
              disabledReason={verificationPending ? m.mcm_verif_already_pending() : m.mcm_verif_cooldown()}
              title={verifications?.lastRequestedAt ? m.mcm_verif_requested_on({ date: formatVerificationDate(verifications.lastRequestedAt) }) : undefined}
              onclick={handleRequestVerification}
            >{requestVerificationBusy ? m.mcm_sending() : m.mcm_request_verification()}</Button>
          {/if}
          {#if showProfileLink && userId}
            <Button size="sm" variant="ghost" icon="maximize-2" href={`/members/${userId}`}>{m.mcm_open_profile()}</Button>
          {/if}
          <Button size="sm" variant="ghost" icon="x" aria-label={m.mcm_close_case()} onclick={onClose} />
        </div>
      </div>
    </header>

    <!-- ── Onglets ────────────────────────────────────────── -->
    <div class="mc-tabs">
      <Tabs label={m.nav_members()} class="max-w-full" tabs={visibleTabs} active={activeTab} onchange={(id) => (activeTab = id as typeof activeTab)} />
    </div>

    <!-- ── Contenu ────────────────────────────────────────── -->
    <div class="mc-body">
      {#if !userId}
        {@render quietEmpty('user-x', m.mcm_user_not_found(), m.mcm_user_not_found_desc())}
      {:else if loading}
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]" aria-busy="true">
          <div class="space-y-4">
            <div class="section-card h-28 animate-pulse"></div>
            <div class="grid gap-4 md:grid-cols-2">
              <div class="section-card h-48 animate-pulse"></div>
              <div class="section-card h-48 animate-pulse"></div>
            </div>
          </div>
          <div class="section-card h-80 animate-pulse"></div>
        </div>
      {:else if error}
        <Callout variant="danger" title={m.mcm_load_error()}>{error}</Callout>
      {:else if !caseData}
        {@render quietEmpty('user-x', m.mcm_no_data(), m.mcm_no_data_desc())}
      {:else}
        <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div class="min-w-0 space-y-4">
            {#if caseData?.isSuspectedDC}
              <Callout variant="danger" icon="alert-octagon" title={m.mcm_dc_title()}>{m.mcm_dc_desc()}</Callout>
            {/if}

            {#if activeTab === 'extra' && extraTab}
              {@render extraTab.content()}

            {:else if activeTab === 'resume'}
              <!-- Chiffres -->
              <section class="section-card p-5" aria-label={m.mcm_tab_summary()}>
                <dl class="mc-kpis">
                  <div>
                    <dt><Papicon icon="calendar" size={13} />{m.mcm_server_presence()}</dt>
                    <dd>{getDurationSince(caseData?.profile?.guildJoinedAt)}</dd>
                    <span>{m.mcm_joined_on({ date: formatDateShort(caseData?.profile?.guildJoinedAt) })}</span>
                  </div>
                  <div>
                    <dt><Papicon icon="user" size={13} />{m.mcm_account_age()}</dt>
                    <dd>{getDurationSince(caseData?.profile?.accountCreatedAt)}</dd>
                    <span>{m.mcm_created_on({ date: formatDateShort(caseData?.profile?.accountCreatedAt) })}</span>
                  </div>
                  <div>
                    <dt><Papicon icon="message-square" size={13} />{m.mcm_messages()}</dt>
                    <dd class="tabular-nums">{caseData?.profile?.messageCount?.toLocaleString(dateLocale()) ?? 0}</dd>
                    <span>{m.mcm_voice()} : {formatDurationFromSeconds(caseData?.profile?.voiceTimeSeconds)}</span>
                  </div>
                  <div>
                    <dt><Papicon icon="hammer" size={13} />{m.mcm_sanctions()}</dt>
                    <dd class="tabular-nums {activeSanctionCount ? 'text-error' : ''}">{sanctions.length}</dd>
                    <span class={activeSanctionCount ? 'text-error' : ''}>{m.mcm_active_sanctions({ count: activeSanctionCount })}</span>
                  </div>
                </dl>
              </section>

              <!-- Activite -->
              <SectionCard title={m.mcm_activity_trend()} description={m.mcx_trend_desc()}>
                {#snippet actions()}
                  <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => (activeTab = 'analytics')}>{m.mcm_tab_analytics()}</Button>
                {/snippet}
                {#if analyticsLoading && !analyticsData}
                  <div class="space-y-3" aria-busy="true">
                    <div class="h-[5.25rem] animate-pulse rounded-xl bg-surface-container"></div>
                    <div class="h-[180px] animate-pulse rounded-lg bg-surface-container"></div>
                  </div>
                {:else if hasTrend && selectedMetric}
                  <div class="space-y-3">
                    <MetricTabs metrics={memberMetrics} active={selectedMetric.id} onchange={(id) => (trendMetric = id as 'messages' | 'voice')} compare label={m.mcm_activity_trend()} />
                    <TimeSeriesChart
                      labels={trendLabels}
                      mode="line"
                      main={{ label: selectedMetric.label, color: selectedMetric.color, values: selectedMetric.daily }}
                      previous={{ label: m.anx_trend_previous(), values: selectedMetric.prevDaily }}
                      format={selectedMetric.format}
                      height={190}
                    />
                  </div>
                {:else}
                  <p class="py-6 text-center text-sm text-on-surface-variant">{m.mcm_stats_unavailable()} {m.mcm_low_activity()}</p>
                {/if}
              </SectionCard>

              <div class="grid gap-4 md:grid-cols-2">
                <SectionCard title={m.mcx_arrival()}>
                  <dl class="mc-facts">
                    <div><dt>{m.mcm_invited_by()}</dt><dd>{@render inviter(true)}</dd></div>
                    <div><dt>{m.mcm_invite_code()}</dt><dd>{@render inviteCode()}</dd></div>
                    <div><dt>{m.mcm_last_pass()}</dt><dd>{formatRelative(caseData?.profile?.lastSeenAt)}</dd></div>
                  </dl>
                </SectionCard>

                <SectionCard title={m.mcm_roles_count({ count: caseData?.roles.length })}>
                  {#if caseData?.roles.length}
                    <div class="flex flex-wrap gap-1.5">
                      {#each caseData.roles.slice(0, 12) as role, ri (ri)}
                        {@render roleChip(role)}
                      {/each}
                      {#if caseData.roles.length > 12}
                        <button type="button" class="mc-role text-primary" onclick={() => (activeTab = 'identite')}>+{caseData.roles.length - 12}</button>
                      {/if}
                    </div>
                  {:else}
                    <p class="text-sm text-on-surface-variant">{m.mcm_no_role()}</p>
                  {/if}
                  {#if caseData?.effectivePermissions?.length}
                    <p class="mt-4 text-xs text-on-surface-variant">{m.mcm_key_permissions()}</p>
                    <p class="mt-1 text-sm text-on-surface">{caseData.effectivePermissions.slice(0, 4).join(' · ')}</p>
                  {/if}
                </SectionCard>
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <SectionCard title={m.mcm_last_messages()} flush>
                  {#snippet actions()}
                    <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => (activeTab = 'messages')}>{m.mcm_tab_messages()}</Button>
                  {/snippet}
                  {@const recent = caseData?.messagesByChannel.slice(0, 3).flatMap((c) => c.recentMessages.slice(0, 1)) ?? []}
                  {#if recent.length}
                    <ul class="divide-y divide-outline-variant">
                      {#each recent as msg, i (i)}
                        <li class="px-5 py-3">
                          <div class="flex items-center justify-between gap-2 text-xs text-on-surface-variant">
                            <span class="font-medium text-primary">#{msg.channelName}</span>
                            <span>{formatRelative(msg.dateIso)}</span>
                          </div>
                          <p class="mt-1 line-clamp-2 text-sm text-on-surface">{msg.content || m.mcm_empty_content()}</p>
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="px-5 py-6 text-sm text-on-surface-variant">{m.mcm_no_recent_message()}</p>
                  {/if}
                </SectionCard>

                <SectionCard title={m.mcm_last_logs()} flush>
                  {#snippet actions()}
                    <Button size="sm" variant="ghost" iconRight="arrow-right" onclick={() => (activeTab = 'logs')}>{m.mcm_see_all_logs()}</Button>
                  {/snippet}
                  {#if caseData?.logs.length}
                    <ul class="divide-y divide-outline-variant">
                      {#each caseData.logs.slice(0, 4) as log, i (i)}
                        <li class="px-5 py-3">
                          <p class="text-sm text-on-surface">{log.action}</p>
                          <p class="text-xs text-on-surface-variant">{log.module} · {formatRelative(log.dateIso)}</p>
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="px-5 py-6 text-sm text-on-surface-variant">{m.mcm_no_log()}</p>
                  {/if}
                </SectionCard>
              </div>

              <SectionCard title={m.mcm_discord_profile()}>
                <div class="grid gap-6 {caseData?.profile?.bannerUrl || caseData?.profile?.accentColor ? 'md:grid-cols-[minmax(0,1fr)_16rem]' : 'max-w-xl'}">
                  {@render facts([
                    { label: m.mcm_username(), value: `@${caseData?.profile?.username ?? m.mcm_unknown()}` },
                    { label: m.mcm_global_name(), value: caseData?.profile?.globalName ?? m.mcm_unknown() },
                    { label: m.mcm_server_display(), value: caseData?.profile?.displayName ?? m.mcm_unknown() },
                    { label: m.mcm_language(), value: caseData?.profile?.locale ?? m.mcm_unknown_f() },
                    { label: m.mcm_pronouns(), value: caseData?.profile?.pronouns ?? m.mcm_not_specified_plural() },
                  ])}
                  {#if caseData?.profile?.bannerUrl || caseData?.profile?.accentColor}
                    <div class="space-y-3">
                      {#if caseData?.profile?.bannerUrl}
                        <img src={caseData.profile.bannerUrl} alt={m.mcm_banner_alt()} class="h-20 w-full rounded-lg object-cover" />
                      {/if}
                      {#if caseData?.profile?.accentColor}
                        {@const hex = caseData.profile.accentColor.toString(16).padStart(6, '0')}
                        <p class="flex items-center gap-2 text-xs text-on-surface-variant">
                          <span class="h-4 w-4 rounded" style="background: #{hex}"></span>
                          {m.mcm_accent_color({ hex })}
                        </p>
                      {/if}
                    </div>
                  {/if}
                </div>
              </SectionCard>

            {:else if activeTab === 'identite'}
              <div class="grid gap-4 md:grid-cols-2">
                <SectionCard title={m.mcm_full_profile()}>
                  {@render facts([
                    { label: m.mcm_discord_id(), value: caseData?.profile?.userId ?? userId ?? '' },
                    { label: m.mcm_username(), value: `@${caseData?.profile?.username ?? m.mcm_unknown()}` },
                    { label: m.mcm_global_name_cap(), value: caseData?.profile?.globalName ?? m.mcm_unknown() },
                    { label: m.mcm_server_nickname(), value: caseData?.profile?.displayName ?? m.mcm_unknown() },
                    { label: m.mcm_pronouns(), value: caseData?.profile?.pronouns ?? m.mcm_not_specified_plural() },
                    { label: m.mcm_language_locale(), value: caseData?.profile?.locale ?? m.mcm_unknown_f() },
                  ])}
                </SectionCard>

                <SectionCard title={m.mcm_key_dates()}>
                  {@render facts([
                    { label: m.mcm_account_creation(), value: formatDateTime(caseData?.profile?.accountCreatedAt) },
                    { label: m.mcm_server_join(), value: formatDateTime(caseData?.profile?.guildJoinedAt) },
                    ...(caseData?.profile?.guildLeftAt ? [{ label: m.mcm_last_leave(), value: formatDateTime(caseData.profile.guildLeftAt), tone: 'text-error' }] : []),
                    { label: m.mcm_first_seen(), value: formatDateTime(caseData?.profile?.firstSeenAt) },
                    { label: m.mcm_last_seen(), value: formatDateTime(caseData?.profile?.lastSeenAt) },
                  ])}
                </SectionCard>

                <!-- Verifications : trace partagee entre moderateurs pour ne pas
                     redemander ce qu'un collegue a deja lance. -->
                <SectionCard title={m.mcm_verif_history_title()} description={m.mcm_verif_history_count({ count: verificationCount })}>
                  {#if verificationEntries.length === 0}
                    <p class="text-sm text-on-surface-variant">{m.mcm_verif_history_empty()}</p>
                  {:else}
                    {@render facts([
                      { label: m.mcm_verif_last_request(), value: formatVerificationDate(verifications?.lastRequestedAt) },
                      { label: m.mcm_verif_last_verified(), value: formatVerificationDate(verifications?.lastVerifiedAt) },
                    ])}
                    <ul class="mt-4 space-y-2">
                      {#each verificationEntries as entry (entry.id)}
                        <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-container px-3 py-2.5">
                          <div class="min-w-0">
                            <p class="text-sm text-on-surface">{m.mcm_verif_requested_on({ date: formatVerificationDate(entry.requestedAt) })}</p>
                            {#if entry.verifiedAt}
                              <p class="text-xs text-on-surface-variant">{m.mcm_verif_verified_on({ date: formatVerificationDate(entry.verifiedAt) })}</p>
                            {/if}
                          </div>
                          <span class="badge {VERIFICATION_STATUS_STYLES[entry.status] ?? VERIFICATION_STATUS_STYLES.EXPIRED}">{verificationStatusLabel(entry.status)}</span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </SectionCard>

                {#if caseData?.profile?.staffGrade}
                  <SectionCard title={m.mcm_staff_status()}>
                    {@render facts([
                      { label: m.mcm_current_grade(), value: caseData.profile.staffGrade },
                      { label: m.mcm_tutor_status(), value: caseData.profile.isTutor ? m.mcm_tutor_yes() : m.mcm_tutor_no() },
                    ])}
                  </SectionCard>
                {/if}

                <div class="md:col-span-2">
                  <SectionCard title={m.mcm_roles_count({ count: caseData?.roles.length })}>
                    {#if caseData?.roles.length}
                      <div class="flex flex-wrap gap-1.5">
                        {#each caseData.roles as role, ri (ri)}
                          {@render roleChip(role)}
                        {/each}
                      </div>
                    {:else}
                      <p class="text-sm text-on-surface-variant">{m.mcm_no_role()}</p>
                    {/if}
                  </SectionCard>
                </div>
              </div>

            {:else if activeTab === 'activite'}
              <section class="section-card p-5">
                <dl class="mc-kpis mc-kpis--3">
                  <div>
                    <dt><Papicon icon="message-square" size={13} />{m.mcm_messages()}</dt>
                    <dd class="tabular-nums">{(caseData?.profile?.messageCount ?? 0).toLocaleString(dateLocale())}</dd>
                  </div>
                  <div>
                    <dt><Papicon icon="mic" size={13} />{m.mcm_voice_time()}</dt>
                    <dd>{formatDurationFromSeconds(caseData?.profile?.voiceTimeSeconds)}</dd>
                  </div>
                  <div>
                    <dt><Papicon icon="eye" size={13} />{m.mcm_last_activity()}</dt>
                    <dd>{formatDateShort(caseData?.profile?.lastSeenAt)}</dd>
                  </div>
                </dl>
              </section>
              <SectionCard title={m.mcm_by_channel()}>
                {#if caseData?.messagesByChannel?.length}
                  {@const max = Math.max(...caseData.messagesByChannel.map((c) => c.count), 1)}
                  <ul class="space-y-3">
                    {#each caseData.messagesByChannel as channel, ci (ci)}
                      <li>
                        <button type="button" class="mc-bar-row" onclick={() => channelDetailsModal.show(channel.channelId, channel.channelName)} title={m.mcm_open_channel_details()}>
                          <span class="flex items-center justify-between gap-3 text-sm">
                            <span class="truncate text-on-surface">#{channel.channelName}</span>
                            <span class="shrink-0 tabular-nums text-on-surface-variant">{channel.count.toLocaleString(dateLocale())}</span>
                          </span>
                          <span class="mc-bar"><span style="width: {(channel.count / max) * 100}%"></span></span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="text-sm text-on-surface-variant">{m.mcm_no_recent_message()}</p>
                {/if}
              </SectionCard>

            {:else if activeTab === 'analytics'}
              {#if analyticsLoading}
                <div class="grid gap-4 lg:grid-cols-2">
                  <div class="section-card h-64 animate-pulse"></div>
                  <div class="section-card h-64 animate-pulse"></div>
                </div>
              {:else if hasTrend}
                <div class="grid gap-4 lg:grid-cols-2">
                  {#each memberMetrics as metric (metric.id)}
                    <SectionCard title={metric.id === 'messages' ? m.mcm_message_volume() : m.mcm_voice_activity()} description={metric.id === 'messages' ? m.mcm_last_30_days() : m.mcm_minutes_per_day()}>
                      {#snippet actions()}
                        <span class="text-right">
                          <span class="block text-lg font-semibold tabular-nums text-on-surface">{metric.value}</span>
                          {#if metric.delta !== null && metric.delta !== undefined}
                            <span class="block text-xs {metric.delta >= 0 ? 'text-success' : 'text-error'}">{metric.delta >= 0 ? '+' : ''}{Math.round(metric.delta)} %</span>
                          {/if}
                        </span>
                      {/snippet}
                      <TimeSeriesChart
                        labels={trendLabels}
                        mode="line"
                        main={{ label: metric.label, color: metric.color, values: metric.daily }}
                        previous={{ label: m.anx_trend_previous(), values: metric.prevDaily }}
                        format={metric.format}
                        height={200}
                      />
                    </SectionCard>
                  {/each}
                </div>
              {:else}
                {@render quietEmpty('bar-chart-2', m.mcm_no_analytics(), m.mcm_no_analytics_desc())}
              {/if}

            {:else if activeTab === 'contenu' && userId}
              <MemberContentPanel {userId} />

            {:else if activeTab === 'messages'}
              <div class="mc-toolbar">
                <div class="mc-search relative">
                  <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant"><Papicon icon="search" size={15} /></span>
                  <input type="search" class="input" style="padding-left: 2.25rem;" placeholder={m.mcm_search_messages()} aria-label={m.mcm_search_messages()} bind:value={messageQuery} oninput={() => { messageOffset = 0; }} />
                </div>
                {@render toolbarSelect(messageChannelId, (v) => { messageChannelId = v; messageOffset = 0; }, [
                  { value: '', label: m.mcm_all_channels() },
                  ...messagesChannels.map((c) => ({ value: c.channelId, label: `#${c.channelName} (${c.count})` })),
                ], m.mcm_all_channels())}
                <label class="mc-date">
                  <span>{m.mcm_date_from()}</span>
                  <input type="date" class="input" bind:value={messageFrom} onchange={() => { messageOffset = 0; }} />
                </label>
                <label class="mc-date">
                  <span>{m.mcm_date_to()}</span>
                  <input type="date" class="input" bind:value={messageTo} onchange={() => { messageOffset = 0; }} />
                </label>
                <label class="inline-flex cursor-pointer select-none items-center gap-2 text-sm text-on-surface-variant">
                  <input type="checkbox" class="h-4 w-4 accent-[var(--primary-color)]" bind:checked={messageIncludeDeleted} onchange={() => { messageOffset = 0; }} />
                  {m.mcm_show_deleted()}
                </label>
              </div>

              {#if messagesLoading}
                <div class="section-card divide-y divide-outline-variant overflow-hidden" aria-busy="true">
                  {#each Array(4) as _}
                    <div class="space-y-2 px-5 py-4">
                      <div class="h-3 w-1/4 animate-pulse rounded bg-surface-container-high"></div>
                      <div class="h-3 w-5/6 animate-pulse rounded bg-surface-container-high"></div>
                    </div>
                  {/each}
                </div>
              {:else if messagesList.length === 0}
                <div class="section-card">
                  <EmptyState icon="message-square" title={m.mcm_no_message_found()} description={m.mcm_no_message_found_desc()} actionLabel={m.mcx_clear_filters()} actionIcon="rotate-ccw" onAction={() => { messageQuery = ''; messageChannelId = ''; messageFrom = ''; messageTo = ''; messageIncludeDeleted = true; messageOffset = 0; }} />
                </div>
              {:else}
                <ul class="section-card divide-y divide-outline-variant overflow-hidden">
                  {#each messagesList as msg (msg.id)}
                    <li class="px-5 py-4 {msg.deletedAt ? 'bg-error/5' : ''}">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                          <span class="font-medium text-primary">#{msg.channelName}</span>
                          <span>{formatDateTime(msg.createdAt)}</span>
                          {#if msg.editedAt}
                            <span class="badge badge-warning" title={m.mcm_edited_on({ date: formatDateTime(msg.editedAt) })}>{m.mcm_edited()}</span>
                          {/if}
                          {#if msg.deletedAt}
                            <span class="badge badge-danger" title={m.mcm_deleted_on({ date: formatDateTime(msg.deletedAt) })}>{m.mcm_deleted()}</span>
                          {/if}
                        </div>
                        {#if !msg.deletedAt}
                          <Button size="sm" variant="ghost" icon="arrow-up-right" aria-label={m.mcx_open_in_discord()} title={m.mcx_open_in_discord()} href="https://discord.com/channels/{authStore.selectedGuildId}/{msg.channelId}/{msg.messageId}" target="_blank" />
                        {/if}
                      </div>
                      <p class="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-on-surface">
                        {msg.content || (msg.hasAttachment ? m.mcm_empty_with_attachments() : m.mcm_empty_content())}
                      </p>
                      {#if Array.isArray(msg.attachments) && msg.attachments.length > 0}
                        <div class="mt-3 flex flex-wrap gap-2">
                          {#each msg.attachments as att, ai (ai)}
                            {#if att.contentType?.startsWith('image/')}
                              <a href={att.url} target="_blank" rel="noopener noreferrer" class="block max-h-40 max-w-60 overflow-hidden rounded-lg border border-outline-variant">
                                <img src={att.url} alt={att.name} class="h-full w-full object-cover" />
                              </a>
                            {:else}
                              <a href={att.url} target="_blank" rel="noopener noreferrer" class="mc-role text-primary">
                                <Papicon icon="file" size={13} /><span class="max-w-40 truncate" title={att.name}>{att.name}</span>
                              </a>
                            {/if}
                          {/each}
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
                {#if messageOffset > 0 || messagesHasMore}
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-xs text-on-surface-variant">
                      {m.mcm_pagination_range({ from: messageOffset + 1, to: messageOffset + messagesList.length, total: formatMessageSearchTotal({ total: messagesTotalCount, totalCapped: messagesTotalCapped }) })}
                    </span>
                    <div class="flex items-center gap-1">
                      <Button size="sm" icon="chevron-left" aria-label={m.mcx_previous()} disabled={messageOffset === 0} onclick={() => { messageOffset = Math.max(0, messageOffset - messageLimit); }} />
                      <Button size="sm" icon="chevron-right" aria-label={m.mcx_next()} disabled={!messagesHasMore} onclick={() => { messageOffset = messageOffset + messageLimit; }} />
                    </div>
                  </div>
                {/if}
              {/if}

            {:else if activeTab === 'logs'}
              <!-- Meme barre que l'onglet Messages, appliquee ici cote client :
                   les logs sont deja tous charges. -->
              <div class="mc-toolbar">
                <div class="mc-search relative">
                  <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant"><Papicon icon="search" size={15} /></span>
                  <input type="search" class="input" style="padding-left: 2.25rem;" placeholder={m.mcm_search_logs()} aria-label={m.mcm_search_logs()} bind:value={logQuery} />
                </div>
                {@render toolbarSelect(logModule, (v) => (logModule = v), [{ value: '', label: m.mcm_all_modules() }, ...logModules.map((x: any) => ({ value: String(x), label: String(x) }))], m.mcm_all_modules())}
                {@render toolbarSelect(logSource, (v) => (logSource = v), [{ value: '', label: m.mcm_all_sources() }, ...logSources.map((x: any) => ({ value: String(x), label: String(x) }))], m.mcm_all_sources())}
                <label class="mc-date"><span>{m.mcm_date_from()}</span><input type="date" class="input" bind:value={logFrom} /></label>
                <label class="mc-date"><span>{m.mcm_date_to()}</span><input type="date" class="input" bind:value={logTo} /></label>
                {@render toolbarSelect(logOrder, (v) => (logOrder = v as 'asc' | 'desc'), [{ value: 'desc', label: m.mcm_sort_newest() }, { value: 'asc', label: m.mcm_sort_oldest() }], m.mcm_sort_newest())}
              </div>
              <p class="text-xs text-on-surface-variant">{m.mcm_logs_shown({ shown: filteredLogs.length, total: caseData?.logs?.length ?? 0 })}</p>

              {#if filteredLogs.length === 0}
                <div>
                  {#if (caseData?.logs?.length ?? 0) === 0}
                    {@render quietEmpty('history', m.mcm_no_log())}
                  {:else}
                    <div class="section-card"><EmptyState icon="search" title={m.mcm_no_log_match()} actionLabel={m.mcx_clear_filters()} actionIcon="rotate-ccw" onAction={() => { logQuery = ''; logModule = ''; logSource = ''; logFrom = ''; logTo = ''; }} /></div>
                  {/if}
                </div>
              {:else}
                <ol class="section-card mc-timeline">
                  {#each filteredLogs as log, i (i)}
                    <li class="mc-event">
                      <span class="mc-event__dot" aria-hidden="true"></span>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                          <p class="text-sm font-medium text-on-surface">{log.action}</p>
                          <time class="text-xs tabular-nums text-on-surface-variant" datetime={log.dateIso}>{formatDateTime(log.dateIso)}</time>
                        </div>
                        <p class="text-xs text-on-surface-variant">{log.module} · {log.source}</p>
                        {#if log.details}
                          <div class="mt-2 rounded-lg bg-surface-container px-3 py-2.5">
                            <LogDetails details={log.details} channelId={log.channelId} userNames={logUserNames} showChannel />
                          </div>
                        {/if}
                      </div>
                    </li>
                  {/each}
                </ol>
              {/if}

            {:else if activeTab === 'sanctions'}
              {#if crossServer?.enabled && crossServer.total > 0}
                <SectionCard
                  icon="globe"
                  title={m.mcm_cross_server_record()}
                  description="{crossServer.total > 1 ? m.mcm_cross_server_count_other({ count: crossServer.total }) : m.mcm_cross_server_count_one({ count: crossServer.total })} {crossServer.serverCount > 1 ? m.mcm_cross_server_on_other({ count: crossServer.serverCount }) : m.mcm_cross_server_on_one({ count: crossServer.serverCount })}"
                  flush
                >
                  {#snippet actions()}
                    <div class="hidden flex-wrap justify-end gap-1.5 md:flex">
                      {#each crossServerBreakdown as [type, count] (type)}
                        <span class="badge badge-neutral"><span class="h-1.5 w-1.5 rounded-full {getSanctionTypeStyle(type).dot}"></span>{formatTypeLabel(type)} {count}</span>
                      {/each}
                    </div>
                  {/snippet}
                  <ul class="divide-y divide-outline-variant">
                    {#each crossServer.recent as entry, i (i)}
                      {@const style = getSanctionTypeStyle(entry.type)}
                      <li class="flex items-center gap-3 px-5 py-3">
                        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg {style.tile}"><Papicon icon={style.icon} size={15} /></span>
                        <div class="min-w-0 flex-1">
                          <p class="text-sm text-on-surface">
                            <span class="font-medium">{formatTypeLabel(entry.type)}</span>
                            {#if entry.durationSeconds}<span class="text-on-surface-variant"> · {formatDurationFromSeconds(entry.durationSeconds)}</span>{/if}
                          </p>
                          {#if entry.reason?.trim()}<p class="truncate text-xs text-on-surface-variant" title={entry.reason}>{entry.reason}</p>{/if}
                          <p class="truncate text-xs text-on-surface-variant" title={entry.guildName}>{entry.guildName}</p>
                        </div>
                        <span class="badge {entry.status === 'ACTIVE' ? 'badge-danger' : 'badge-success'}">{getSanctionStatusLabel(entry.status)}</span>
                        <span class="hidden w-20 shrink-0 text-right text-xs text-on-surface-variant sm:block">{formatRelative(entry.createdAt)}</span>
                      </li>
                    {/each}
                  </ul>
                  <div class="flex items-center justify-between gap-3 border-t border-outline-variant px-5 py-2.5 text-xs text-on-surface-variant">
                    <span class="inline-flex items-center gap-1.5"><Papicon icon="lock" size={12} />{m.mcm_same_instance()}</span>
                    {#if crossServer.total > crossServer.recent.length}
                      <span>{crossServer.total - crossServer.recent.length > 1 ? m.mcm_cross_server_more_other({ count: crossServer.total - crossServer.recent.length }) : m.mcm_cross_server_more_one({ count: crossServer.total - crossServer.recent.length })}</span>
                    {/if}
                  </div>
                </SectionCard>
              {/if}

              {#if sanctions.length === 0}
                {@render quietEmpty('check-circle', m.mcm_clean_record())}
              {:else}
                <div class="section-card overflow-hidden">
                  <div class="overflow-x-auto">
                    <table class="mc-table">
                      <thead>
                        <tr>
                          <th scope="col">{m.mcm_col_date()}</th>
                          <th scope="col">{m.mcm_col_action()}</th>
                          <th scope="col">{m.mcm_col_status()}</th>
                          <th scope="col">{m.mcm_col_reason()}</th>
                          <th scope="col"><span class="sr-only">{m.mcm_col_report()}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each sanctions as sanction (sanction.id)}
                          {@const style = getSanctionTypeStyle(sanction.type)}
                          {@const hasReport = [...(dashboardStore.state.sanctionReports || []), ...(caseData?.sanctionReports || [])].some((r) => r.sanctionId === sanction.id)}
                          <tr>
                            <td class="whitespace-nowrap text-on-surface-variant">{formatDateShort(sanction.createdAt)}</td>
                            <td>
                              <span class="inline-flex items-center gap-2">
                                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg {style.tile}"><Papicon icon={style.icon} size={13} /></span>
                                <span>
                                  <span class="block font-medium text-on-surface">{formatTypeLabel(sanction.type)}</span>
                                  <span class="block text-xs text-on-surface-variant">{m.mcm_by_moderator({ moderator: sanction.moderatorTag })}</span>
                                </span>
                              </span>
                            </td>
                            <td><span class="badge {sanction.status === 'ACTIVE' ? 'badge-danger' : 'badge-success'}">{getSanctionStatusLabel(sanction.status)}</span></td>
                            <td class="max-w-xs"><span class="line-clamp-2 text-on-surface-variant" title={sanction.reason}>{sanction.reason}</span></td>
                            <td class="whitespace-nowrap text-right">
                              {#if hasReport}
                                <Button size="sm" icon="file-text" onclick={() => (viewingReportSanctionId = sanction.id)}>{m.mcx_report()}</Button>
                              {:else}
                                <span class="text-xs text-on-surface-variant">{m.mcm_no_report()}</span>
                              {/if}
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                </div>
              {/if}

            {:else if activeTab === 'invites'}
              {@const created = caseData?.createdInvites ?? []}
              <div class="grid gap-4 md:grid-cols-2">
                <SectionCard title={m.mcm_invite_source()}>
                  <dl class="mc-facts">
                    <div><dt>{m.mcm_code_used()}</dt><dd>{@render inviteCode()}</dd></div>
                    <div><dt>{m.mcm_creator()}</dt><dd>{@render inviter(true)}</dd></div>
                    <div><dt>{m.mcm_use_date()}</dt><dd>{formatDateTime(caseData?.invite?.joinedAt ?? caseData?.profile?.guildJoinedAt)}</dd></div>
                  </dl>
                </SectionCard>
                <SectionCard title={m.mcm_server_moves()}>
                  {@render facts([
                    { label: m.mcm_last_join(), value: formatDateTime(caseData?.profile?.guildJoinedAt) },
                    { label: m.mcm_last_leave_row(), value: formatDateTime(caseData?.profile?.guildLeftAt) },
                    { label: m.mcm_first_observation(), value: formatDateTime(caseData?.profile?.firstSeenAt) },
                  ])}
                </SectionCard>
              </div>
              <SectionCard
                title={m.mcm_created_invites()}
                description={created.length ? m.mcm_created_invites_desc({ count: created.reduce((n, i) => n + i.joined, 0), left: created.reduce((n, i) => n + i.left, 0) }) : ''}
                flush={created.length > 0}
              >
                {#if created.length}
                  <div class="overflow-x-auto">
                    <table class="w-full min-w-[640px] text-sm">
                      <thead>
                        <tr class="text-left text-xs font-medium text-on-surface-variant border-b border-outline-variant/10">
                          <th class="px-4 py-3">{m.iv_col_code()}</th>
                          <th class="px-4 py-3">{m.iv_col_source()}</th>
                          <th class="px-4 py-3">{m.iv_col_status()}</th>
                          <th class="px-4 py-3 text-right">{m.iv_col_joins()}</th>
                          <th class="px-4 py-3 text-right">{m.mcm_col_left()}</th>
                          <th class="px-4 py-3 text-right">{m.iv_col_uses()}</th>
                          <th class="px-4 py-3">{m.iv_col_creation()}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each created as inv (inv.code)}
                          {@const expired = !!inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()}
                          <tr class="border-b border-outline-variant/5 last:border-0">
                            <td class="px-4 py-3">
                              <button type="button" class="mc-code" onclick={() => inviteDetailsModal.show(inv.code)} title={m.mcm_open_invites_view()}>{inv.code}</button>
                            </td>
                            <td class="px-4 py-3 text-on-surface-variant">{inv.sourceLabel || '-'}</td>
                            <td class="px-4 py-3 text-on-surface-variant">
                              {inv.isDeleted ? m.iv_status_deleted() : inv.isSuspended ? m.iv_status_suspended() : expired ? m.iv_status_expired() : m.iv_status_active()}
                            </td>
                            <td class="px-4 py-3 text-right font-semibold text-success">{inv.joined}</td>
                            <td class="px-4 py-3 text-right text-on-surface-variant">{inv.left}</td>
                            <td class="px-4 py-3 text-right text-on-surface-variant">{inv.uses}</td>
                            <td class="px-4 py-3 text-on-surface-variant">{formatDateShort(inv.createdAt)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else}
                  <p class="text-sm text-on-surface-variant">{m.mcm_no_created_invite()}</p>
                {/if}
              </SectionCard>

            {:else if activeTab === 'connexions'}
              <SectionCard title={m.mcm_interaction_graph()} description={m.mcm_top_contacts({ count: (caseData?.interactionGraph?.nodes?.length ?? 1) - 1 })} flush>
                <div class="h-[480px] w-full">
                  <InteractionTree nodes={caseData?.interactionGraph?.nodes || []} edges={caseData?.interactionGraph?.edges || []} onSelectNode={onSelectUser} />
                </div>
              </SectionCard>
              {#if caseData?.connections.length}
                <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {#each caseData.connections as connection, i (i)}
                    <div class="section-card flex items-center gap-3 p-4">
                      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant"><Papicon icon={getConnectionIcon(connection.type)} size={16} /></span>
                      <span class="min-w-0">
                        <span class="block truncate text-sm font-medium text-on-surface">{connection.name}</span>
                        <span class="block text-xs text-on-surface-variant">{connection.type}</span>
                      </span>
                    </div>
                  {/each}
                </div>
              {:else if (caseData?.interactionGraph?.nodes || []).length === 0}
                {@render quietEmpty('link-2', m.mcm_no_external_link())}
              {/if}

            {:else if activeTab === 'candidatures'}
              {#each (caseData?.candidatures || []) as cand, i (i)}
                <SectionCard title={formatDateShort(cand.createdAt)}>
                  {#snippet actions()}
                    <span class="badge {cand.status === 'APPROVED' ? 'badge-success' : 'badge-danger'}">{cand.status}</span>
                  {/snippet}
                  {#if cand.oralResult}
                    {@render facts([{ label: m.mcm_oral_result(), value: cand.oralResult }])}
                  {/if}
                  {#if cand.notes}
                    <p class="mt-3 rounded-lg bg-surface-container px-4 py-3 text-sm leading-relaxed text-on-surface-variant">{cand.notes}</p>
                  {/if}
                </SectionCard>
              {:else}
                <div class="section-card"><EmptyState icon="user-check" title={m.mcm_no_candidature()} actionLabel={m.mcx_see_recruitment()} actionIcon="arrow-right" actionHref="/recruitment" /></div>
              {/each}

            {:else if activeTab === 'linked_accounts'}
              {#if crossServerLinks?.enabled && crossServerLinkSuggestions.length > 0}
                <SectionCard
                  icon="globe"
                  title={m.mcm_xlink_title()}
                  description="{crossServerLinkSuggestions.length > 1 ? m.mcm_xlink_count_other({ count: crossServerLinkSuggestions.length }) : m.mcm_xlink_count_one({ count: crossServerLinkSuggestions.length })} {crossServerLinks.serverCount > 1 ? m.mcm_xlink_on_other({ count: crossServerLinks.serverCount }) : m.mcm_xlink_on_one({ count: crossServerLinks.serverCount })}"
                  flush
                >
                  <ul class="divide-y divide-outline-variant">
                    {#each crossServerLinkSuggestions as suggestion (suggestion.userId)}
                      <li class="flex flex-wrap items-center gap-3 px-5 py-3.5">
                        <img src={memberAvatarSrc(suggestion.avatarUrl, suggestion.userTag, suggestion.userId)} alt="" class="h-9 w-9 shrink-0 rounded-full object-cover" />
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="truncate text-sm font-medium text-on-surface">{suggestion.userTag ?? m.mcm_xlink_unknown_user({ id: suggestion.userId })}</span>
                            <span class="badge badge-neutral">{suggestion.serverCount > 1 ? m.mcm_xlink_servers_other({ count: suggestion.serverCount }) : m.mcm_xlink_servers_one({ count: suggestion.serverCount })}</span>
                            {#if !suggestion.presentOnGuild}<span class="badge badge-neutral">{m.mcm_xlink_absent()}</span>{/if}
                          </div>
                          <div class="mt-1 flex flex-wrap items-center gap-1.5">
                            {#each suggestion.guilds as guild, gi (gi)}
                              <span class="badge {guild.status === 'VALIDATED' ? 'badge-success' : 'badge-warning'}" title={guild.reason ?? ''}>
                                <span class="max-w-[14rem] truncate">{guild.guildName}</span>
                                <span class="opacity-70">· {guild.type === 'MANUAL' ? m.mcm_xlink_manual() : m.mcm_xlink_automatic()}</span>
                              </span>
                            {/each}
                          </div>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                          <span class="badge badge-neutral" title={m.mcm_xlink_score_hint()}>{m.mcm_xlink_score({ score: suggestion.score })}</span>
                          {#if suggestion.alreadyLinkedHere}
                            <span class="badge badge-success"><Papicon icon="check" size={11} />{m.mcm_xlink_already_linked()}</span>
                          {:else if canModerateMembers}
                            <Button size="sm" variant="primary" loading={applyingSuggestionId === suggestion.userId} disabled={applyingSuggestionId !== null && applyingSuggestionId !== suggestion.userId} onclick={() => handleApplySuggestedLink(suggestion)}>{m.mcm_xlink_apply()}</Button>
                          {/if}
                        </div>
                      </li>
                    {/each}
                  </ul>
                  <div class="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant px-5 py-2.5 text-xs text-on-surface-variant">
                    <span class="inline-flex items-center gap-1.5"><Papicon icon="lock" size={12} />{m.mcm_same_instance()}</span>
                    <span>{m.mcm_xlink_footer_hint()}</span>
                  </div>
                </SectionCard>
              {/if}

              {#if canModerateMembers}
                <SectionCard icon="link-2" title={m.mcm_link_account_manually()}>
                  <div class="grid gap-4 md:grid-cols-2">
                    <Field label={m.mcm_target_account_id()} required>
                      {#snippet children(id)}
                        <input {id} class="input" placeholder="123456789012345678" bind:value={targetAccountId} />
                      {/snippet}
                    </Field>
                    <Field label={m.mcm_link_reason_label()}>
                      {#snippet children(id)}
                        <input {id} class="input" placeholder={m.mcm_link_reason_placeholder()} bind:value={linkReason} />
                      {/snippet}
                    </Field>
                  </div>
                  {#if linkFeedback}
                    <p class="mt-3 text-sm {linkIsError ? 'text-error' : 'text-success'}">{linkFeedback}</p>
                  {/if}
                  <div class="mt-4 flex justify-end">
                    <Button variant="primary" icon="link-2" loading={linkBusy} disabled={!targetAccountId} disabledReason={m.mcm_error_id_required()} onclick={handleLinkAccount}>{m.mcm_link_accounts()}</Button>
                  </div>
                </SectionCard>
              {/if}

              {#if (caseData?.linkedAccounts || []).length > 0}
                <div class="grid gap-3 md:grid-cols-2">
                  {#each caseData?.linkedAccounts || [] as link, li (li)}
                    <div class="section-card flex items-center gap-3 p-4">
                      <img src={memberAvatarSrc(link.avatarUrl, link.userTag, link.userId)} alt="" class="h-10 w-10 shrink-0 rounded-full object-cover" />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <span class="truncate text-sm font-medium text-on-surface">{link.userTag}</span>
                          <span class="badge {link.status === 'VALIDATED' ? 'badge-success' : 'badge-warning'}">{link.status}</span>
                        </div>
                        <p class="text-xs text-on-surface-variant">{link.type} · {link.userId}</p>
                      </div>
                      {#if dashboardStore.state.access.level === 'admin' && canModerateMembers}
                        <Button size="sm" variant="ghost" icon="trash-2" aria-label={m.mcm_unlink_account()} title={m.mcm_unlink_account()} loading={unlinkingAccountId === link.userId} onclick={() => handleUnlinkAccount(link.userId)} />
                      {/if}
                    </div>
                  {/each}
                </div>
              {:else}
                {@render quietEmpty('user-plus', m.mcm_no_linked_account())}
              {/if}

            {:else if activeTab === 'notes'}
              <SectionCard title={m.mcm_mod_notes()} description={m.mcm_mod_notes_desc()}>
                <label for="moderator-note-textarea" class="sr-only">{m.mcm_mod_notes_sr()}</label>
                <textarea
                  id="moderator-note-textarea"
                  class="input min-h-[260px] resize-y"
                  bind:value={moderatorNote}
                  readonly={!canModerateMembers}
                  placeholder={m.mcm_add_note_placeholder()}
                ></textarea>
                <div class="mt-4 flex items-center justify-between gap-3">
                  <span class="text-sm {noteFeedback === m.mcm_note_saved() ? 'text-success' : 'text-error'}" aria-live="polite">{noteFeedback}</span>
                  {#if canModerateMembers}
                    <Button variant="primary" icon="save" loading={noteBusy} onclick={handleSaveNote}>{noteBusy ? m.mcm_saving() : m.mcm_save()}</Button>
                  {/if}
                </div>
              </SectionCard>
            {/if}
          </div>

          <!-- ── Colonne de moderation ───────────────────────── -->
          <aside class="space-y-4 lg:sticky lg:top-20">
            <section class="section-card p-5" aria-labelledby="mc-risk">
              <div class="flex items-baseline justify-between gap-2">
                <h3 id="mc-risk" class="text-sm font-semibold text-on-surface">{m.mcm_risk_score()}</h3>
                <span class="text-xs text-on-surface-variant">{memberSeniority}</span>
              </div>
              <div class="mt-3 flex items-baseline gap-2">
                <span class="text-2xl font-semibold tabular-nums tracking-tight {riskTone === 'success' ? 'text-success' : riskTone === 'warning' ? 'text-warning' : 'text-error'}">{moderationRiskScore}</span>
                <span class="text-sm text-on-surface-variant">/100</span>
                <span class="ml-auto badge {riskTone === 'success' ? 'badge-success' : riskTone === 'warning' ? 'badge-warning' : 'badge-danger'}">
                  {moderationRiskScore < 30 ? m.mcm_risk_low() : moderationRiskScore < 70 ? m.mcm_risk_high() : m.mcm_risk_critical()}
                </span>
              </div>
              <div class="mc-meter mt-2" aria-hidden="true"><span class={riskTone === 'success' ? 'bg-success' : riskTone === 'warning' ? 'bg-warning' : 'bg-error'} style="width: {moderationRiskScore}%"></span></div>
              <p class="mt-2 text-xs leading-relaxed text-on-surface-variant">{m.mcm_risk_desc()}</p>
            </section>

            {#if topChannels.length > 0}
              <section class="section-card p-5" aria-labelledby="mc-channels">
                <h3 id="mc-channels" class="text-sm font-semibold text-on-surface">{m.mcm_top_channels()}</h3>
                <ul class="mt-3 space-y-3">
                  {#each topChannels as chan, ci (ci)}
                    {@const pct = Math.round((chan.count / (caseData?.profile?.messageCount || 1)) * 100)}
                    <li>
                      <button type="button" class="mc-bar-row" onclick={() => channelDetailsModal.show(chan.channelId, chan.channelName)} title={m.mcm_open_channel_details()}>
                        <span class="flex items-center justify-between gap-2 text-sm">
                          <span class="truncate text-on-surface">#{chan.channelName}</span>
                          <span class="shrink-0 tabular-nums text-xs text-on-surface-variant">{chan.count} · {pct} %</span>
                        </span>
                        <span class="mc-bar"><span style="width: {pct}%"></span></span>
                      </button>
                    </li>
                  {/each}
                </ul>
              </section>
            {/if}

            {#if canModerateMembers}
              <section class="section-card p-5" aria-labelledby="mc-actions">
                <h3 id="mc-actions" class="text-sm font-semibold text-on-surface">{m.mcm_mod_actions()}</h3>
                <div class="mt-3 space-y-3">
                  <Field label={m.mcm_sanction_reason()} id="mod-reason">
                    {#snippet children(id)}
                      <textarea {id} class="input resize-none" rows="3" placeholder={m.mcm_reason_placeholder()} bind:value={actionReason}></textarea>
                    {/snippet}
                  </Field>
                  <Field label={m.mcm_duration_timeout()}>
                    {#snippet children(id)}
                      <select {id} class="input" bind:value={actionDuration}>
                        <option value="30m">{m.mcm_duration_30m()}</option>
                        <option value="1h">{m.mcm_duration_1h()}</option>
                        <option value="1d">{m.mcm_duration_1d()}</option>
                        <option value="7d">{m.mcm_duration_7d()}</option>
                        <option value="28d">{m.mcm_duration_28d()}</option>
                      </select>
                    {/snippet}
                  </Field>
                  <div class="space-y-2 pt-1">
                    <Button fullWidth icon="alert-triangle" disabled={actionBusy} onclick={() => executeModerationAction('WARN')}>{m.mcm_action_warn()}</Button>
                    <Button fullWidth icon="clock" disabled={actionBusy} onclick={() => executeModerationAction('TIMEOUT')}>{m.mcm_action_timeout()}</Button>
                    <div class="grid grid-cols-2 gap-2">
                      <Button variant="danger" icon="log-out" disabled={actionBusy} onclick={() => executeModerationAction('KICK')}>{m.mcm_action_kick()}</Button>
                      <Button variant="danger" icon="gavel" disabled={actionBusy} onclick={() => executeModerationAction('BAN')}>{m.mcm_action_ban()}</Button>
                    </div>
                  </div>
                  {#if actionFeedback}
                    <p class="flex items-center gap-2 text-sm {actionIsError ? 'text-error' : 'text-success'}">
                      <Papicon icon={actionIsError ? 'alert-circle' : 'check-circle'} size={14} />{actionFeedback}
                    </p>
                  {/if}
                </div>
              </section>
            {/if}
          </aside>
        </div>
      {/if}
    </div>
  </div>
</Modal>

<!-- Rapport de sanction : une fenetre du dashboard, au-dessus du dossier. -->
<Modal
  aboveCase
  open={!!(viewingReportSanctionId && selectedSanctionForReport)}
  onClose={() => { viewingReportSanctionId = null; isEditingReport = false; }}
  size="lg"
  title={selectedSanctionForReport ? formatTypeLabel(selectedSanctionForReport.type) : m.mcm_sanction_report()}
  subtitle={selectedSanctionForReport ? m.mcm_applied_on({ date: formatDateTime(selectedSanctionForReport.createdAt), moderator: selectedSanctionForReport.moderatorTag }) : ''}
>
  <div class="space-y-5">
    {#if selectedReport}
      {#if isEditingReport}
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label={m.mcm_incident_date()}>
            {#snippet children(id)}<input {id} type="datetime-local" class="input" bind:value={editReportData.incidentAt} />{/snippet}
          </Field>
          <Field label={m.mcm_applied_duration()}>
            {#snippet children(id)}<input {id} type="text" class="input" placeholder={m.mcm_duration_placeholder()} bind:value={editReportData.sanctionDurationLabel} />{/snippet}
          </Field>
        </div>
        <div class="field">
          <span class="field-label">{m.mcm_broken_rules()}</span>
          <ReportRuleSelector
            id="member-case-report-rules"
            options={reportRuleOptions}
            selectedIds={editReportData.selectedRuleIds}
            onToggle={(id, checked) => {
              editReportData.selectedRuleIds = checked
                ? [...new Set([...editReportData.selectedRuleIds, id])]
                : editReportData.selectedRuleIds.filter((v) => v !== id);
            }}
          />
          <SelectedRuleChips selectedRules={editDraftRules} />
        </div>
        <Field label={m.mcm_detailed_reason()}>
          {#snippet children(id)}<textarea {id} class="input resize-none" rows="4" placeholder={m.mcm_detailed_reason_placeholder()} bind:value={editReportData.detailedReason}></textarea>{/snippet}
        </Field>
        <div class="field">
          <span class="field-label">{m.mcm_evidence()}</span>
          <EvidenceInputList bind:links={editReportData.evidenceLinks} sanctionId={viewingReportSanctionId} />
        </div>
        <Field label={m.mcm_extra_notes()}>
          {#snippet children(id)}<textarea {id} class="input resize-none" rows="2" placeholder={m.mcm_extra_notes_placeholder()} bind:value={editReportData.additionalNotes}></textarea>{/snippet}
        </Field>
      {:else}
        {@render facts([
          { label: m.mcm_incident(), value: formatDateTime(selectedReport.incidentAt) },
          { label: m.mcm_duration(), value: selectedReport.sanctionDurationLabel || '-' },
        ])}
        <div>
          <p class="field-label">{m.mcm_broken_rules()}</p>
          <SelectedRuleChips selectedRules={selectedReportRules} />
        </div>
        <div>
          <p class="field-label">{m.mcm_detailed_reason()}</p>
          <p class="rounded-lg bg-surface-container px-4 py-3 text-sm leading-relaxed text-on-surface">{selectedReport.detailedReason}</p>
        </div>
        {#if selectedReport.evidenceLinks?.length}
          <div>
            <p class="field-label">{m.mcm_evidence()}</p>
            <div class="flex flex-wrap gap-2">
              {#each selectedReport.evidenceLinks as link, li (li)}
                <Button size="sm" icon="external-link" href={link} target="_blank">{m.mcm_evidence_link()} {li + 1}</Button>
              {/each}
            </div>
          </div>
        {/if}
        {#if selectedReport.additionalNotes}
          <div>
            <p class="field-label">{m.mcm_extra_notes()}</p>
            <p class="text-sm leading-relaxed text-on-surface-variant">{selectedReport.additionalNotes}</p>
          </div>
        {/if}
        <p class="text-xs text-on-surface-variant">{m.mcm_report_by({ author: selectedReport.createdByTag || selectedReport.createdByUserId })}</p>
      {/if}
    {:else}
      <EmptyState icon="alert-triangle" title={m.mcm_report_missing()} description={m.mcm_report_missing_desc()} actionLabel={m.mcx_open_sanctions()} actionIcon="arrow-right" actionHref="/security/sanctions" />
    {/if}
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      {#if selectedReport && isEditingReport}
        <Button variant="ghost" onclick={() => (isEditingReport = false)}>{m.common_cancel()}</Button>
        <Button variant="primary" loading={updateReportBusy} onclick={handleUpdateReport}>{m.common_save()}</Button>
      {:else}
        {#if selectedReport && canModerateSanctions && (selectedReport.createdByUserId === authStore.user?.id || authStore.isAdmin)}
          <Button icon="edit-3" onclick={() => startEditingReport(selectedReport)}>{m.mcm_edit_report()}</Button>
        {/if}
        <Button variant="secondary" onclick={() => (viewingReportSanctionId = null)}>{m.mcm_close_details()}</Button>
      {/if}
    </div>
  {/snippet}
</Modal>

<style>
  .mc {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    background: var(--surface);
  }

  .mc-header {
    position: relative;
    background: var(--surface-container-lowest);
    border-bottom: 1px solid var(--outline-variant);
  }
  .mc-banner {
    height: 5.5rem;
    background-size: cover;
    background-position: center;
  }
  .mc-identity {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    padding: 1.25rem 1.5rem;
  }
  .mc-header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }

  .mc-tabs {
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 0.75rem 1.5rem;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--outline-variant);
  }

  .mc-body {
    padding: 1.25rem 1.5rem 1.5rem;
  }

  @media (max-width: 640px) {
    .mc-identity, .mc-tabs, .mc-body {
      padding-left: 1rem;
      padding-right: 1rem;
    }
    .mc-header-actions {
      margin-left: 0;
      width: 100%;
    }
  }

  /* Chiffres alignes, separes par un filet : le meme bandeau que l'accueil. */
  .mc-kpis {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem 1.5rem;
  }
  @media (min-width: 900px) {
    .mc-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .mc-kpis--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .mc-kpis > div + div {
      border-left: 1px solid var(--outline-variant);
      padding-left: 1.25rem;
    }
  }
  .mc-kpis dt {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--on-surface-variant);
  }
  .mc-kpis dd {
    margin-top: 0.125rem;
    font-size: 1.375rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--on-surface);
  }
  .mc-kpis span {
    display: block;
    font-size: 0.75rem;
    color: var(--on-surface-variant);
  }

  .mc-facts {
    display: flex;
    flex-direction: column;
  }
  .mc-facts > div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-top: 1px solid color-mix(in srgb, var(--outline-variant) 60%, transparent);
  }
  .mc-facts > div:first-child {
    border-top: none;
    padding-top: 0;
  }
  .mc-facts dt {
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
  }
  .mc-facts dd {
    min-width: 0;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--on-surface);
    text-align: right;
    overflow-wrap: anywhere;
  }

  .mc-person {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 100%;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--primary-color);
  }
  .mc-person:hover:not(.mc-person--static) { text-decoration: underline; }
  .mc-person--static { color: var(--on-surface); }

  .mc-code {
    padding: 0.125rem 0.5rem;
    border-radius: 0.375rem;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.8125rem;
    color: var(--primary-color);
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
  }
  .mc-code:hover { background: color-mix(in srgb, var(--primary-color) 16%, transparent); }

  .mc-role {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1875rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--outline-variant);
    font-size: 0.75rem;
    color: var(--on-surface);
    background: var(--surface-container-lowest);
  }

  .mc-bar-row {
    display: block;
    width: 100%;
    text-align: left;
  }
  .mc-bar-row:hover .truncate { color: var(--primary-color); }
  .mc-bar {
    display: block;
    height: 0.375rem;
    margin-top: 0.375rem;
    border-radius: 9999px;
    background: var(--surface-container-high);
    overflow: hidden;
  }
  .mc-bar > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--series-1);
  }

  .mc-meter {
    height: 0.375rem;
    border-radius: 9999px;
    background: var(--surface-container-high);
    overflow: hidden;
  }
  .mc-meter > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    transition: width 0.4s ease;
  }

  .mc-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .mc-toolbar .mc-select { width: auto; max-width: 14rem; }
  .mc-search { flex: 1 1 16rem; min-width: 0; }
  .mc-date {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
  }
  .mc-date .input { width: auto; }

  .mc-timeline {
    padding: 1rem 1.25rem;
  }
  .mc-event {
    position: relative;
    display: flex;
    gap: 0.875rem;
    padding-bottom: 1rem;
  }
  .mc-event:last-child { padding-bottom: 0; }
  .mc-event:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 14px;
    bottom: 0;
    width: 1px;
    background: var(--outline-variant);
  }
  .mc-event__dot {
    flex-shrink: 0;
    width: 9px;
    height: 9px;
    margin-top: 6px;
    border-radius: 9999px;
    background: var(--primary-color);
  }

  .mc-table {
    width: 100%;
    min-width: 640px;
    border-collapse: collapse;
    text-align: left;
    font-size: 0.875rem;
  }
  .mc-table th {
    padding: 0.625rem 1rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--on-surface-variant);
    background: var(--surface-container);
    border-bottom: 1px solid var(--outline-variant);
  }
  .mc-table td {
    padding: 0.625rem 1rem;
    vertical-align: middle;
    border-bottom: 1px solid var(--outline-variant);
  }
  .mc-table tbody tr:last-child td { border-bottom: none; }
  .mc-table tbody tr:hover { background: var(--surface-hover); }
</style>
