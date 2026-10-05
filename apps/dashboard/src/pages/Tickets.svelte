<script lang="ts">
  import { m } from '../lib/i18n';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Button, Callout, Modal, Tabs } from '../lib/components/ui';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import {
    fetchMemberCase,
    runMemberCaseAction,
    dashboardFetch } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';

  import { errorMessage } from '@kotbo/shared';
  import TicketInboxList from '../lib/components/tickets/TicketInboxList.svelte';
  import TicketProperties from '../lib/components/tickets/TicketProperties.svelte';
  import TicketPerformance from '../lib/components/tickets/TicketPerformance.svelte';
  import TicketBlacklist from '../lib/components/tickets/TicketBlacklist.svelte';
  import TicketTranscripts from '../lib/components/tickets/TicketTranscripts.svelte';
  import TicketSatisfactionTab from '../lib/components/tickets/TicketSatisfactionTab.svelte';
  import TicketMacros from '../lib/components/tickets/TicketMacros.svelte';
  import TicketSettings from '../lib/components/tickets/TicketSettings.svelte';
  import TicketMemberPanel from '../lib/components/tickets/TicketMemberPanel.svelte';
  import type { InboxTicket, InboxView } from '../lib/api';
  import { resolveUserAvatarSrc } from '../lib/discordMedia';
  // Navigation & Tabs
  const ticketsTabs = ['tickets', 'performance', 'transcripts', 'satisfaction', 'macros', 'blacklist', 'config'] as const;
  const DEFAULT_TICKETS_TAB = 'tickets';
  let activeTab = $state<'tickets' | 'performance' | 'transcripts' | 'satisfaction' | 'macros' | 'blacklist' | 'config'>(DEFAULT_TICKETS_TAB);

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/tickets', ticketsTabs, DEFAULT_TICKETS_TAB) as typeof activeTab;
  });

  const TICKETS_PAGE_SIZE = 75;
  let ticketsOffset = $state(0);
  let ticketsHasMore = $state(false);
  let loadingMoreTickets = $state(false);

  // Centre de support : la file affichée est une vue (non attribués, mes
  // tickets, en attente du staff...), plus un simple filtre de statut.
  let inboxView = $state<InboxView>('open');
  let inboxQuery = $state('');
  let inboxSort = $state<'newest' | 'oldest'>('newest');
  let viewCounts = $state<Partial<Record<InboxView, number>>>({});

  function inboxParams(params: URLSearchParams) {
    params.set('view', inboxView);
    params.set('sort', inboxSort);
    if (inboxQuery) params.set('q', inboxQuery);
  }

  function changeInbox(patch: { view?: InboxView; query?: string; sort?: 'newest' | 'oldest' }) {
    if (patch.view !== undefined) inboxView = patch.view;
    if (patch.query !== undefined) inboxQuery = patch.query;
    if (patch.sort !== undefined) inboxSort = patch.sort;
    void loadTicketsAndConfig(true);
  }
  
  // Data State
  let tickets = $state<any[]>([]);
  let config = $state<any>({});
  let selectedTicketId = $state<string | null>(null);
  let selectedTicketDetail = $state<any>(null);
  let messages = $state<any[]>([]);
  
  // Loading & Error State
  let loading = $state(true);
  let loadingDetail = $state(false);
  let error = $state('');
  
  // Forms & Actions State
  let chatInput = $state('');
  let closeReason = $state('');
  let ticketRenameName = $state('');
  let showCloseModal = $state(false);
  let showDeleteConfirmModal = $state(false);
  let chatScrollContainer = $state<HTMLDivElement | null>(null);
  let unsubscribeRealtime: (() => void) | null = null;
  
  let showMobileChat = $state(false);

  // Member Case Modal Integration
  let caseModalOpen = $state(false);
  let selectedCaseUser = $state<{ name: string; id: string | null } | null>(null);
  let selectedCaseData = $state<any>(null);
  let selectedCaseLoading = $state(false);
  let selectedCaseError = $state('');
  let memberActionReason = $state(m.e1_tickets_member_action_default_reason());
  let memberActionDuration = $state('30m');
  let memberActionBusy = $state(false);
  let memberActionFeedback = $state('');
  let memberActionIsError = $state(false);

  async function changeTab(tab: typeof activeTab) {
    if (unsavedChanges.isDirty && unsavedChanges.ownerId === 'tickets') {
      const confirmLeave = await confirmDialog.ask({
        title: m.e1_tickets_unsaved_title(),
        description: m.e1_tickets_unsaved_desc(),
        confirmLabel: m.e1_tickets_unsaved_confirm(),
        variant: 'warning',
      });
      if (!confirmLeave) return;
      unsavedChanges.clear();
    }
    gotoTab('/tickets', tab, DEFAULT_TICKETS_TAB);
  }

  const renameAction = createAsyncActionState();

  // Fetch all tickets and config
  async function loadTicketsAndConfig(reset = true) {
    if (!authStore.selectedGuildId) return;
    if (reset) {
      loading = true;
      ticketsOffset = 0;
    } else {
      loadingMoreTickets = true;
    }
    error = '';
    try {
      const params = new URLSearchParams({
        limit: String(TICKETS_PAGE_SIZE),
        offset: String(reset ? 0 : ticketsOffset),
      });
      inboxParams(params);

      const res = await dashboardFetch(`/tickets?${params}`);
      if (!res.ok) throw new Error(m.e1_tickets_err_load_system());
      const data = await res.json();
      const incomingTickets = data.tickets || [];
      tickets = reset ? incomingTickets : [...tickets, ...incomingTickets];
      ticketsHasMore = data.pagination?.hasMore === true;
      ticketsOffset = data.pagination?.nextOffset ?? ticketsOffset;
      if (data.views) viewCounts = data.views;
      config = data.config || {};
      
    } catch (err) {
      error = errorMessage(err) || 'Une erreur est survenue';
    } finally {
      loading = false;
      loadingMoreTickets = false;
    }
  }

  async function refreshTicketsOnly() {
    if (!authStore.selectedGuildId || !authStore.token) return;
    try {
      const params = new URLSearchParams({
        limit: String(Math.max(TICKETS_PAGE_SIZE, tickets.length || TICKETS_PAGE_SIZE)),
        offset: '0',
      });
      inboxParams(params);

      const res = await dashboardFetch(`/tickets?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      tickets = data.tickets || [];
      if (data.views) viewCounts = data.views;
      ticketsHasMore = data.pagination?.hasMore === true;
      ticketsOffset = data.pagination?.nextOffset ?? tickets.length;

      if (selectedTicketId) {
        const found = tickets.find((t) => t.id === selectedTicketId);
        if (found && selectedTicketDetail) {
          selectedTicketDetail = { ...selectedTicketDetail, ...found };
        }
      }
    } catch {
      // Échec silencieux pour un rafraîchissement d'arrière-plan
    }
  }

  /** Relecture des onglets devenus composants : ils écoutent ce compteur. */
  let refreshToken = $state(0);

  async function handleRefresh() {
    if (activeTab === 'transcripts') {
      refreshToken += 1;
    } else if (activeTab === 'satisfaction') {
      refreshToken += 1;
    } else if (activeTab === 'blacklist') {
      refreshToken += 1;
    } else if (activeTab === 'macros') {
      refreshToken += 1;
    } else {
      if (activeTab === 'config') refreshToken += 1;
      await loadTicketsAndConfig();
    }
  }

  // Fetch details & messages for selected ticket
  const selectedInboxRow = $derived(tickets.find((t) => t.id === selectedTicketId) as InboxTicket | undefined);
  const knownTags = $derived([...new Set(tickets.flatMap((t) => (t as InboxTicket).tags ?? []))].sort());

  /** Reporte une modification de propriétés sur la liste et le détail. */
  function patchSelectedTicket(patch: Record<string, unknown>) {
    tickets = tickets.map((t) => (t.id === selectedTicketId ? { ...t, ...patch } : t));
    if (selectedTicketDetail) selectedTicketDetail = { ...selectedTicketDetail, ...patch };
    void refreshTicketsOnly();
  }

  async function loadTicketDetail(ticketId: string, autoScroll = true) {
    if (!authStore.selectedGuildId) return;
    loadingDetail = true;
    try {
      const res = await dashboardFetch(`/tickets/${ticketId}`);
      if (!res.ok) throw new Error(m.e1_tickets_err_load_detail());
      const data = await res.json();
      selectedTicketDetail = data.ticket;
      messages = data.messages || [];
      ticketRenameName = data.ticket?.channelName || '';

      if (autoScroll) {
        setTimeout(scrollToBottom, 50);
      }
    } catch (err) {
      console.error(err);
    } finally {
      loadingDetail = false;
    }
  }

  // L'evenement temps reel ne porte que l'identifiant du ticket : on relit ses
  // messages par l'API. Seuls les messages sont remplaces, pour ne pas ecraser
  // un renommage en cours de saisie, et une reponse arrivee apres une plus
  // recente est ignoree.
  let messagesRefreshSeq = 0;
  async function refreshTicketMessages(ticketId: string) {
    const seq = ++messagesRefreshSeq;
    try {
      const res = await dashboardFetch(`/tickets/${ticketId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== messagesRefreshSeq || selectedTicketId !== ticketId) return;
      messages = data.messages || [];
      setTimeout(scrollToBottom, 50);
    } catch {
      // Le prochain message ou un rafraichissement manuel rattrapera
    }
  }

  function selectTicket(ticketId: string) {
    selectedTicketId = ticketId;
    void loadTicketDetail(ticketId, true);
  }

  // Scroll chat window to bottom
  function scrollToBottom() {
    if (chatScrollContainer) {
      chatScrollContainer.scrollTop = chatScrollContainer.scrollHeight;
    }
  }

  // Send message from Svelte Panel to Discord
  async function sendMessage() {
    if (!chatInput.trim() || !selectedTicketId || !authStore.selectedGuildId) return;
    const textToSend = chatInput;
    chatInput = '';
    
    // Add locally immediately with a temp ID for high responsiveness
    const tempMsg = {
      id: `temp-${Date.now()}`,
      content: textToSend,
      authorName: authStore.user?.username || 'Staff',
      authorAvatar: resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar),
      isStaff: true,
      createdAt: new Date().toISOString()
    };
    messages = [...messages, tempMsg];
    setTimeout(scrollToBottom, 30);

    try {
      const res = await dashboardFetch(`/tickets/${selectedTicketId}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: textToSend })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_send_message());
      // Reload actual messages
      await loadTicketDetail(selectedTicketId, false);
    } catch (err) {
      toast.error(errorMessage(err) || m.e1_tickets_err_generic());
    }
  }

  // Claim Ticket
  async function claimTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await dashboardFetch(`/tickets/${selectedTicketId}/claim`, {
        method: 'POST'
        });
      if (!res.ok) throw new Error(m.e1_tickets_err_claim());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  // Close Ticket
  async function closeTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await dashboardFetch(`/tickets/${selectedTicketId}/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: closeReason })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_close());
      showCloseModal = false;
      closeReason = '';
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  // Rename Ticket
  async function renameTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId || !ticketRenameName.trim()) return;
    const ticketId = selectedTicketId;
    await renameAction.run(async () => {
      const res = await dashboardFetch(`/tickets/${ticketId}/rename`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: ticketRenameName.trim() })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_rename());
      const data = await res.json().catch(() => null);
      if (data?.channelName) {
        ticketRenameName = data.channelName;
      }
      await loadTicketDetail(ticketId, false);
      await loadTicketsAndConfig();
      return true;
    }, { successMessage: m.e1_tickets_renamed_toast() });
  }

  // Reopen Ticket
  async function reopenTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await dashboardFetch(`/tickets/${selectedTicketId}/reopen`, {
        method: 'POST'
        });
      if (!res.ok) throw new Error(m.e1_tickets_err_reopen());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  // Restore Ticket
  let showRestoreModal = $state(false);
  let restoring = $state(false);

  async function restoreTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    restoring = true;
    try {
      const res = await dashboardFetch(`/tickets/${selectedTicketId}/restore`, {
        method: 'POST'
        });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || m.e1_tickets_err_restore());
      }
      showRestoreModal = false;
      toast.success(m.e1_tickets_restored_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      restoring = false;
    }
  }

  // ─── Archivage et verrou anti-suppression ──────────────────────────────────

  /**
   * Le verrou peut porter une échéance : un ticket dont la date est passée n'est
   * plus protégé, même si le drapeau est resté à vrai en base. On le recalcule
   * ici plutôt que de se fier au seul booléen, comme le fait le bot.
   */
  const deletionLock = $derived.by(() => {
    const t = selectedTicketDetail;
    if (!t?.deletionLocked) return null;
    const until = t.deletionLockedUntil ? new Date(t.deletionLockedUntil) : null;
    if (until && until.getTime() <= Date.now()) return null;
    return { until, reason: t.deletionLockReason ?? null, byName: t.deletionLockedByName ?? null };
  });

  let showLockModal = $state(false);
  let lockDuration = $state<'7d' | '30d' | '90d' | 'permanent'>('30d');
  let lockReason = $state('');
  let lockBusy = $state(false);

  const LOCK_DURATION_MS: Record<string, number | null> = {
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    permanent: null,
  };

  async function postTicketAction(action: string, body?: unknown): Promise<any> {
    const res = await dashboardFetch(`/tickets/${selectedTicketId}/${action}`, {
        method: 'POST',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || m.e1_tickets_action_failed());
    return data;
  }

  // ─── Demandes en attente de validation ──────────────────────────────────────
  // Mêmes gestes que les boutons « Valider » et « Refuser » de la carte posée
  // dans le salon de validation sur Discord.
  let reviewBusy = $state(false);
  let showRejectModal = $state(false);
  let rejectReason = $state('');

  async function approvePendingTicket() {
    if (!selectedTicketId) return;
    reviewBusy = true;
    try {
      await postTicketAction('approve');
      toast.success(m.tr_approved());
      await refreshTicketsOnly();
      await loadTicketDetail(selectedTicketId);
    } catch (err) {
      toast.error(errorMessage(err) || m.e1_tickets_action_failed());
    } finally {
      reviewBusy = false;
    }
  }

  async function rejectPendingTicket() {
    if (!selectedTicketId) return;
    reviewBusy = true;
    try {
      await postTicketAction('reject', { reason: rejectReason.trim() || null });
      toast.success(m.tr_rejected());
      showRejectModal = false;
      rejectReason = '';
      await refreshTicketsOnly();
      await loadTicketDetail(selectedTicketId);
    } catch (err) {
      toast.error(errorMessage(err) || m.e1_tickets_action_failed());
    } finally {
      reviewBusy = false;
    }
  }

  async function archiveTicket(unarchive = false) {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      await postTicketAction(unarchive ? 'unarchive' : 'archive');
      toast.success(unarchive ? m.e1_tickets_unarchived_toast() : m.e1_tickets_archived_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err) || m.e1_tickets_err_archive());
    }
  }

  async function lockTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    lockBusy = true;
    try {
      await postTicketAction('lock', {
        durationMs: LOCK_DURATION_MS[lockDuration],
        reason: lockReason.trim() || null,
      });
      showLockModal = false;
      lockReason = '';
      toast.success(m.e1_tickets_locked_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err) || m.e1_tickets_err_lock());
    } finally {
      lockBusy = false;
    }
  }

  async function unlockTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      await postTicketAction('unlock');
      toast.success(m.e1_tickets_unlocked_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err) || m.e1_tickets_err_lock());
    }
  }

  // Delete Ticket
  async function deleteTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await dashboardFetch(`/tickets/${selectedTicketId}/delete`, {
        method: 'POST'
        });
      if (!res.ok) throw new Error(m.e1_tickets_err_delete());
      showDeleteConfirmModal = false;
      selectedTicketId = null;
      selectedTicketDetail = null;
      messages = [];
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  // Member Case Logic

  /**
   * Le dossier membre appartient a la section Membres : la fenetre ne s'ouvre
   * pas pour un role a qui le centre de gestion l'a fermee, quelle que soit la
   * page qui la demande.
   */
  const canOpenMemberCase = $derived(canViewFeature('members'));

  async function loadMemberCaseDetails(userId: string) {
    if (!canOpenMemberCase) return;
    selectedCaseLoading = true;
    selectedCaseError = '';
    try {
      selectedCaseData = await fetchMemberCase(userId);
    } catch (err) {
      selectedCaseError = errorMessage(err) || m.e1_tickets_err_load_case();
      selectedCaseData = null;
    } finally {
      selectedCaseLoading = false;
    }
  }

  function openMemberCase(userId: string, userName: string) {
    if (!canOpenMemberCase) return;
    selectedCaseUser = { name: userName, id: userId };
    selectedCaseData = null;
    selectedCaseError = '';
    memberActionReason = m.e1_tickets_member_action_default_reason();
    memberActionDuration = '30m';
    memberActionFeedback = '';
    memberActionIsError = false;
    caseModalOpen = true;
    if (userId) {
      void loadMemberCaseDetails(userId);
    }
  }

  function closeCaseModal() {
    caseModalOpen = false;
    selectedCaseUser = null;
    selectedCaseData = null;
    selectedCaseError = '';
  }

  async function executeMemberAction(action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') {
    if (!selectedCaseUser?.id) return;
    memberActionBusy = true;
    memberActionFeedback = '';
    memberActionIsError = false;
    try {
      const durationMs = action === 'TIMEOUT' ? 30 * 60 * 1000 : null;
      await runMemberCaseAction(selectedCaseUser.id, action, {
        reason: memberActionReason.trim() || m.e1_tickets_action_reason_short(),
        durationMs: durationMs ?? undefined
      });
      memberActionFeedback = m.e1_tickets_action_success();
      await loadMemberCaseDetails(selectedCaseUser.id);
    } catch (err) {
      memberActionIsError = true;
      memberActionFeedback = errorMessage(err) || m.e1_tickets_action_failed();
    } finally {
      memberActionBusy = false;
    }
  }

  function getStatusLabel(status: string) {
    switch (status) {
      case 'PENDING': return m.e1_tickets_status_pending();
      case 'OPEN': return m.e1_tickets_status_open();
      case 'CLAIMED': return m.e1_tickets_status_claimed();
      case 'CLOSED': return m.e1_tickets_status_closed();
      case 'ARCHIVED': return m.e1_tickets_status_archived();
      case 'REJECTED': return m.e1_tickets_status_rejected();
      case 'ORPHANED': return m.e1_tickets_status_orphaned();
      default: return status;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'PENDING': return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
      case 'OPEN': return 'bg-success/10 text-success border-success/20';
      case 'CLAIMED': return 'bg-warning/10 text-warning border-warning/20';
      case 'CLOSED': return 'bg-error/10 text-error border-error/20';
      case 'ARCHIVED': return 'bg-slate-500/10 text-on-surface-variant border-slate-500/20';
      case 'REJECTED': return 'bg-error/10 text-error border-error/20';
      // Orange et non rouge : ce n'est pas une decision du staff, c'est un accident.
      case 'ORPHANED': return 'bg-orange-500/10 text-orange-400 border-orange-500/20';
      default: return 'bg-outline-variant/10 text-on-surface-variant border-outline-variant/20';
    }
  }

  onMount(async () => {
    await loadTicketsAndConfig();

    unsubscribeRealtime = subscribeRealtime({
      reasons: ['tickets_updated'],
      types: ['new_ticket_message'],
      onUpdate: (event) => {
        if (!event) {
          void refreshTicketsOnly();
          return;
        }

        if (event.type === 'new_ticket_message' && selectedTicketId && event.ticketId === selectedTicketId) {
          void refreshTicketMessages(selectedTicketId);
          return;
        }

        if (event.reason === 'tickets_updated') {
          void refreshTicketsOnly();
        }
      },
    });
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
  });
</script>

<ModulePage 
  title={m.e1_tickets_page_title()}
  description={m.e1_tickets_page_desc()}

  icon="message-square"
  featureKey="tickets"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <RefreshButton onClick={handleRefresh} loading={loading} label={m.e1_tickets_refresh()} />
      <button 
      onclick={() => changeTab(activeTab === 'config' ? 'tickets' : 'config')}
        class="p-3 rounded-xl bg-surface-container-high hover:bg-primary/10 hover:text-primary transition-all text-on-surface-variant/70"
        title={m.e1_tickets_settings_tooltip()}
      >
        <Papicon icon="settings" size={20} />
      </button>
    </div>
  {/snippet}

  <Tabs
    label={m.e1_tickets_page_title()}
    class="mb-6"
    tabs={pageTabItems('/tickets')}
    active={activeTab}
    onchange={(id) => changeTab(id as typeof activeTab)}
  />

  {#if activeTab === 'tickets'}
    {#if error}
      <Callout variant="danger" class="mb-4">{error}</Callout>
    {/if}
    <!-- Tickets Main View - mobile: master/detail pattern -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 h-auto lg:h-[75vh]">

      <!-- Left Panel: Tickets Browser -->
      <div data-tour="tickets-list" class="lg:col-span-4 xl:col-span-3 bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-4 lg:p-6 flex flex-col overflow-hidden {showMobileChat && selectedTicketId ? 'hidden lg:flex' : 'flex'} h-[50vh] lg:h-full">
        <TicketInboxList
          tickets={tickets as InboxTicket[]}
          view={inboxView}
          counts={viewCounts}
          sort={inboxSort}
          {loading}
          loadingMore={loadingMoreTickets}
          hasMore={ticketsHasMore}
          selectedId={selectedTicketId}
          slaConfigured={!!(config.ticketSlaFirstResponseMinutes || config.ticketSlaResolutionHours)}
          statusLabel={getStatusLabel}
          onview={(view) => { selectedTicketId = null; selectedTicketDetail = null; messages = []; changeInbox({ view }); }}
          onsearch={(query) => changeInbox({ query })}
          onsort={(sort) => changeInbox({ sort })}
          onselect={(id) => { selectTicket(id); showMobileChat = true; }}
          onloadmore={() => loadTicketsAndConfig(false)}
        />
      </div>

      <!-- Right Panel: Live Chat & Actions -->
      <div data-tour="tickets-chat" class="lg:col-span-8 xl:col-span-6 bg-surface-container-low/40 border border-outline-variant/10 rounded-xl flex flex-col overflow-hidden {!showMobileChat && selectedTicketId ? 'hidden lg:flex' : !selectedTicketId ? 'hidden lg:flex' : 'flex'} h-[75vh] lg:h-full">
        {#if !selectedTicketId}
          <div class="flex-1 flex flex-col items-center justify-center text-on-surface-variant/30 py-20">
            <div class="w-16 h-16 rounded-xl bg-surface-container flex items-center justify-center mb-4 shadow-inner">
              <Papicon icon="message-square" size={32} />
            </div>
            <h3 class="text-lg font-semibold text-on-surface/40">{m.e1_tickets_no_selection_title()}</h3>
            <p class="text-xs opacity-60 mt-1">{m.e1_tickets_no_selection_desc()}</p>
          </div>
        {:else}
          <!-- Chat Header -->
          <div class="p-3 lg:p-5 border-b border-outline-variant/10 bg-surface-container/20">
            <div class="flex items-center gap-3">
              <!-- Mobile back button -->
              <button onclick={() => showMobileChat = false} class="lg:hidden p-2 -ml-1 rounded-lg hover:bg-surface-container transition-colors">
                <Papicon icon="arrow-left" size={18} />
              </button>
              {#if selectedTicketDetail?.userAvatar}
                <img src={selectedTicketDetail.userAvatar} alt={selectedTicketDetail.username} class="w-10 h-10 rounded-xl object-cover shadow-inner shrink-0" />
              {:else}
                <div class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-semibold text-base shadow-inner shrink-0">
                  {selectedTicketDetail?.username?.charAt(0).toUpperCase() || '?'}
                </div>
              {/if}
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h3 class="text-sm lg:text-base font-semibold text-on-surface truncate">@{selectedTicketDetail?.username || m.e1_tickets_user_fallback()}</h3>
                  <span class="px-2 py-0.5 rounded-full text-xs font-semibold border {getStatusColor(selectedTicketDetail?.status)}">
                    {getStatusLabel(selectedTicketDetail?.status)}
                  </span>
                  {#if selectedTicketDetail?.mode && selectedTicketDetail.mode !== 'CHANNEL'}
                    <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      {selectedTicketDetail.mode === 'DM' ? m.e1_tickets_mode_dm() : m.e1_tickets_mode_thread()}
                    </span>
                  {/if}
                </div>
                {#if selectedTicketDetail?.claimedByName}
                  <div class="flex items-center gap-1 text-2xs text-primary/80 font-bold">
                    {#if selectedTicketDetail.claimedByAvatar}
                      <img src={selectedTicketDetail.claimedByAvatar} alt={selectedTicketDetail.claimedByName} class="w-4 h-4 rounded-full object-cover" />
                    {/if}
                    {m.e1_tickets_assigned_to({ name: selectedTicketDetail.claimedByName })}
                  </div>
                {/if}
              </div>
            </div>

            {#if selectedTicketDetail}
              <TicketProperties
                ticket={{ ...(selectedInboxRow ?? {}), ...selectedTicketDetail, sla: selectedInboxRow?.sla ?? null }}
                {knownTags}
                onchange={patchSelectedTicket}
              />
            {/if}

            <!-- Demande en attente ou refusée : aucun salon n'existe, l'écran
                 doit dire pourquoi plutôt que rester vide. -->
            {#if selectedTicketDetail?.status === 'PENDING'}
              <div class="mt-3 flex items-start gap-2 p-3 rounded-xl bg-sky-500/5 border border-sky-500/20">
                <Papicon icon="clock" size={14} class="text-sky-400 shrink-0 mt-0.5" />
                <div class="flex-1 min-w-0">
                  <p class="text-2xs text-on-surface-variant">{m.e1_tickets_pending_notice()}</p>
                  <div class="flex flex-wrap gap-2 mt-2">
                    <Button size="sm" variant="primary" icon="check" loading={reviewBusy} onclick={approvePendingTicket}>{m.tr_approve()}</Button>
                    <Button size="sm" variant="danger" icon="x" disabled={reviewBusy} onclick={() => { rejectReason = ''; showRejectModal = true; }}>{m.tr_reject()}</Button>
                  </div>
                </div>
              </div>
            {:else if selectedTicketDetail?.status === 'REJECTED'}
              <div class="mt-3 flex items-start gap-2 p-3 rounded-xl bg-error/5 border border-error/20">
                <Papicon icon="x-circle" size={14} class="text-error shrink-0 mt-0.5" />
                <p class="text-2xs text-on-surface-variant">
                  {m.e1_tickets_rejected_notice({ name: selectedTicketDetail.reviewedByName || '-' })}
                  {#if selectedTicketDetail.rejectionReason}<br />{m.e1_tickets_rejected_reason({ reason: selectedTicketDetail.rejectionReason })}{/if}
                </p>
              </div>
            {/if}

            <!-- Actions : elles passent à la ligne. En défilement horizontal à barre
                 masquée, celles qui dépassaient de la colonne disparaissaient. -->
            <div class="flex flex-wrap items-center gap-2 mt-3">
              <button
                onclick={() => openMemberCase(selectedTicketDetail.userId, selectedTicketDetail.username)}
                class="px-3 py-1.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg text-xs font-semibold hover:bg-indigo-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
              >
                <Papicon icon="shield" size={12} /> {m.e1_tickets_btn_case()}
              </button>

              {#if selectedTicketDetail?.status === 'OPEN' || selectedTicketDetail?.status === 'CLAIMED'}
                {#if selectedTicketDetail.status === 'OPEN'}
                  <button onclick={claimTicket}
                    class="px-3 py-1.5 bg-warning/10 text-warning border border-warning/20 rounded-lg text-xs font-semibold hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="user-check" size={12} /> {m.e1_tickets_btn_claim()}
                  </button>
                {/if}
                <button onclick={() => showCloseModal = true}
                  class="px-3 py-1.5 bg-error/10 text-error border border-error/20 rounded-lg text-xs font-semibold hover:bg-rose-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="x-circle" size={12} /> {m.e1_tickets_btn_close()}
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLAIMED' && selectedTicketDetail.claimedById !== authStore.user?.id && (config.ticketAllowOverclaim ?? true) && config.ticketOverclaimPermission !== 'NONE'}
                <button onclick={claimTicket}
                  class="px-3 py-1.5 bg-warning/10 text-warning border border-warning/20 rounded-lg text-xs font-semibold hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="user-check" size={12} /> {m.e1_tickets_btn_overclaim()}
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLOSED' || selectedTicketDetail?.status === 'ARCHIVED'}
                {#if selectedTicketDetail.channelId}
                  <button onclick={reopenTicket}
                    class="px-3 py-1.5 bg-success/10 text-success border border-success/20 rounded-lg text-xs font-semibold hover:bg-emerald-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="refresh" size={12} /> {m.e1_tickets_btn_reopen()}
                  </button>

                  <!-- Archiver conserve tout : le salon passe en lecture seule
                       au lieu d'être détruit. C'est l'alternative à Supprimer,
                       posée juste avant lui pour se présenter d'abord. -->
                  {#if selectedTicketDetail.status === 'ARCHIVED'}
                    <button onclick={() => archiveTicket(true)}
                      class="px-3 py-1.5 bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-lg text-xs font-semibold hover:bg-sky-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="upload" size={12} /> {m.e1_tickets_btn_unarchive()}
                    </button>
                  {:else}
                    <button onclick={() => archiveTicket(false)}
                      class="px-3 py-1.5 bg-slate-500/10 text-on-surface-variant border border-slate-500/20 rounded-lg text-xs font-semibold hover:bg-slate-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="archive" size={12} /> {m.e1_tickets_btn_archive()}
                    </button>
                  {/if}

                  {#if deletionLock}
                    <button onclick={unlockTicket}
                      class="px-3 py-1.5 bg-warning/10 text-warning border border-warning/20 rounded-lg text-xs font-semibold hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="unlock" size={12} /> {m.e1_tickets_btn_unlock()}
                    </button>
                  {:else}
                    <button onclick={() => showLockModal = true}
                      class="px-3 py-1.5 bg-outline-variant/10 text-on-surface-variant border border-outline-variant/20 rounded-lg text-xs font-semibold hover:bg-on-surface-variant hover:text-surface transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="lock" size={12} /> {m.e1_tickets_btn_lock()}
                    </button>
                  {/if}

                  <!-- Sous verrou le bouton reste visible mais inerte : le
                       masquer laisserait croire que la suppression n'existe pas. -->
                  <button onclick={() => { if (!deletionLock) showDeleteConfirmModal = true; }}
                    disabled={!!deletionLock}
                    title={deletionLock ? m.e1_tickets_delete_locked_hint() : undefined}
                    class="px-3 py-1.5 rounded-lg text-2xs font-semibold uppercase tracking-wider active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0 {deletionLock ? 'bg-surface-container text-on-surface-variant/30 border border-outline-variant/10 cursor-not-allowed' : 'bg-rose-600 text-white'}"
                  >
                    <Papicon icon="delete" size={12} /> {m.e1_tickets_btn_delete()}
                  </button>
                {/if}
                {#if selectedTicketDetail?.transcriptId}
                  {@const restoresLeft = 3 - (selectedTicketDetail.restoreCount ?? 0)}
                  <button
                    onclick={() => { if (restoresLeft > 0) showRestoreModal = true; }}
                    disabled={restoresLeft <= 0}
                    title={restoresLeft <= 0 ? m.e1_tickets_restore_limit_tooltip() : m.e1_tickets_restore_left_tooltip({ count: restoresLeft })}
                    class="px-3 py-1.5 rounded-lg text-2xs font-semibold uppercase tracking-wider flex items-center gap-1.5 shrink-0 transition-all {restoresLeft > 0 ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500 hover:text-white cursor-pointer' : 'bg-surface-container text-on-surface-variant/30 border border-outline-variant/10 cursor-not-allowed'}"
                  >
                    <Papicon icon="refresh-ccw" size={12} /> {m.e1_tickets_btn_restore({ left: restoresLeft })}
                  </button>
                {/if}
              {/if}

              {#if selectedTicketDetail?.transcriptId}
                <a href="/transcripts/{selectedTicketDetail.transcriptId}" target="_blank"
                  class="px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg text-xs font-semibold hover:bg-blue-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="external-link" size={12} /> {m.e1_tickets_original_transcript()}
                </a>
              {/if}
            </div>

            {#if deletionLock}
              <div class="mt-3 flex items-start gap-2 p-3 rounded-lg bg-warning/5 border border-warning/20">
                <Papicon icon="lock" size={14} class="text-warning mt-0.5 shrink-0" />
                <div class="text-2xs text-warning/90 leading-relaxed">
                  <p class="font-semibold">
                    {m.e1_tickets_lock_banner()}
                    · {deletionLock.until ? m.e1_tickets_lock_until({ date: new Date(deletionLock.until).toLocaleDateString() }) : m.e1_tickets_lock_permanent()}
                    {#if deletionLock.byName}· {m.e1_tickets_lock_by({ name: deletionLock.byName })}{/if}
                  </p>
                  {#if deletionLock.reason}<p class="mt-0.5 opacity-80">{deletionLock.reason}</p>{/if}
                </div>
              </div>
            {/if}

            {#if selectedTicketDetail?.channelId && selectedTicketDetail?.mode !== 'DM'}
              <div class="mt-3 flex gap-2 items-center">
                <FormInput type="text" bind:value={ticketRenameName} placeholder={m.e1_tickets_rename_ph()} className="flex-1" />
                <button onclick={renameTicket} disabled={renameAction.state.loading || !ticketRenameName.trim()}
                  class="px-3 py-2.5 bg-primary text-white rounded-lg text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="edit" size={12} />
                  {renameAction.state.loading ? '...' : m.e1_tickets_rename_btn()}
                </button>
              </div>
            {/if}
          </div>

          <!-- Chat Messages Container -->
          <div
            bind:this={chatScrollContainer}
            class="flex-1 overflow-y-auto bg-[#313338] scrollbar-hide"
            class:p-4={!selectedTicketDetail?.transcriptId || messages.length > 0}
            class:lg:p-6={!selectedTicketDetail?.transcriptId || messages.length > 0}
            class:space-y-3={!selectedTicketDetail?.transcriptId || messages.length > 0}
          >
            {#if loadingDetail && messages.length === 0}
              <div class="flex items-center justify-center h-full">
                <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
              </div>
            {:else if messages.length === 0}
              <div class="flex flex-col items-center justify-center text-white/30 h-full">
                <Papicon icon="forum" size={28} class="opacity-50 mb-2" />
                <p class="text-xs">{m.e1_tickets_no_message()}</p>
              </div>
            {:else}
              {#each messages as msg (msg.id)}
                <div class="flex items-start gap-2.5 lg:gap-4 p-2 rounded-xl hover:bg-white/5 transition-colors group">
                  <div class="shrink-0">
                    {#if msg.authorAvatar}
                      <img src={msg.authorAvatar} alt="Avatar" class="h-8 w-8 lg:h-10 lg:w-10 rounded-full object-cover border border-white/10" />
                    {:else}
                      <div class="h-8 w-8 lg:h-10 lg:w-10 rounded-full bg-white/10 flex items-center justify-center text-xs lg:text-sm font-semibold text-white/80">
                        {msg.authorName?.slice(0, 1).toUpperCase()}
                      </div>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-1.5 flex-wrap">
                      <span class="text-xs lg:text-sm font-bold text-white">{msg.authorName || m.e1_tickets_anonymous()}</span>
                      {#if msg.isStaff}
                        <span class="bg-[#5865F2] text-white text-xs lg:text-2xs font-semibold px-1 py-0.5 rounded leading-none">{m.e1_tickets_staff_badge()}</span>
                      {/if}
                      <span class="text-2xs lg:text-2xs text-white/40">{new Date(msg.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    {#if msg.htmlContent}
                      <div class="text-xs lg:text-sm text-white/90 mt-1 whitespace-pre-wrap leading-relaxed select-text flex flex-wrap gap-x-1 items-center message-html-content">
                        {@html msg.htmlContent}
                      </div>
                    {:else if msg.content}
                      <p class="text-xs lg:text-sm text-white/90 mt-1 whitespace-pre-wrap leading-relaxed select-text">{msg.content}</p>
                    {/if}

                    {#if msg.mediaUrls && msg.mediaUrls.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.mediaUrls.filter((media: any) => {
                          if (msg.attachments?.some((att: any) => att.url === media.url)) return false;
                          const getFilename = (url: any) => { if (!url) return ''; const clean = url.split('?')[0]; const parts = clean.split('/'); return parts[parts.length - 1] || ''; };
                          const mediaFilename = getFilename(media.url);
                          if (msg.embeds?.some((embed: any) => {
                            const embedUrl = embed.url || ''; const embedImg = embed.image?.url || ''; const embedThumb = embed.thumbnail?.url || ''; const embedVid = embed.video?.url || '';
                            if (embedUrl === media.url || embedImg === media.url || embedThumb === media.url || embedVid === media.url) return true;
                            if (mediaFilename && (getFilename(embedUrl).includes(mediaFilename) || getFilename(embedImg).includes(mediaFilename) || getFilename(embedThumb).includes(mediaFilename) || getFilename(embedVid).includes(mediaFilename))) return true;
                            if (media.url.includes('giphy.com') && (embedUrl.includes('giphy.com') || embedImg.includes('giphy.com') || embedVid.includes('giphy.com') || embedThumb.includes('giphy.com'))) return true;
                            if (media.url.includes('tenor.com') && (embedUrl.includes('tenor.com') || embedImg.includes('tenor.com') || embedVid.includes('tenor.com') || embedThumb.includes('tenor.com'))) return true;
                            return false;
                          })) return false;
                          return true;
                        }) as media}
                          {#if media.type === 'image'}
                            <img src={media.url} alt="media-preview" class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60 object-contain bg-[#1e1f22]" />
                          {:else if media.type === 'video'}
                            <!-- svelte-ignore a11y_media_has_caption -->
                            <video src={media.url} controls class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60 bg-[#1e1f22]"></video>
                          {:else if media.type === 'audio'}
                            <audio src={media.url} controls class="max-w-[80%] lg:max-w-md"></audio>
                          {/if}
                        {/each}
                      </div>
                    {/if}

                    {#if msg.stickers && msg.stickers.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.stickers as sticker}
                          <div class="relative group max-w-[50%]">
                            <img src={sticker.url} alt={sticker.name} class="h-32 w-auto rounded-lg object-contain transition-transform" />
                          </div>
                        {/each}
                      </div>
                    {/if}

                    {#if msg.embeds && msg.embeds.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.embeds as embed}
                          <div class="bg-[#2b2d31] border-l-4 rounded-r-md p-2.5 max-w-full lg:max-w-lg" style="border-left-color: {embed.color || '#1e1f22'}">
                            {#if embed.title}
                              <div class="font-bold text-[#00a8fc] text-xs lg:text-sm mb-1">{embed.title}</div>
                            {/if}
                            {#if embed.htmlDescription}
                              <div class="text-xs lg:text-sm text-white/80 whitespace-pre-wrap leading-relaxed select-text message-html-content">{@html embed.htmlDescription}</div>
                            {:else if embed.description}
                              <div class="text-xs lg:text-sm text-white/80 whitespace-pre-wrap leading-relaxed select-text">{embed.description}</div>
                            {/if}
                            {#if embed.fields && embed.fields.length > 0}
                              <div class="mt-2 flex flex-wrap gap-2">
                                {#each embed.fields as field}
                                  <div class="flex-1 min-w-[45%]">
                                    <div class="text-2xs font-bold text-white/60 uppercase">{field.name}</div>
                                    {#if field.htmlValue}
                                      <div class="text-xs text-white/80 select-text message-html-content">{@html field.htmlValue}</div>
                                    {:else}
                                      <div class="text-xs text-white/80 select-text">{field.value}</div>
                                    {/if}
                                  </div>
                                {/each}
                              </div>
                            {/if}
                            {#if embed.image?.url}
                              <img src={embed.image.url} alt="embed-img" class="mt-2 max-w-full rounded-lg border border-white/10 max-h-60 object-contain bg-[#1e1f22]" />
                            {:else if embed.video?.url}
                              {#if embed.video.url.includes('giphy.com') || embed.video.url.includes('tenor.com') || embed.video.url.includes('gifv')}
                                <video src={embed.video.url} autoplay loop muted playsinline class="mt-2 max-w-full rounded-lg border border-white/10 max-h-60 bg-[#1e1f22]"></video>
                              {:else}
                                <!-- svelte-ignore a11y_media_has_caption -->
                                <video src={embed.video.url} controls class="mt-2 max-w-full rounded-lg border border-white/10 max-h-60 bg-[#1e1f22]"></video>
                              {/if}
                            {:else if embed.thumbnail?.url}
                              <img src={embed.thumbnail.url} alt="embed-thumbnail" class="mt-2 max-w-full rounded-lg border border-white/10 max-h-32 object-contain bg-[#1e1f22]" />
                            {/if}
                            {#if embed.images?.length}
                              <div class="mt-2 grid grid-cols-2 gap-1.5">
                                {#each embed.images as url (url)}
                                  <img src={url} alt="" class="w-full rounded-lg border border-white/10 max-h-40 object-cover bg-[#1e1f22]" />
                                {/each}
                              </div>
                            {/if}
                            {#if embed.buttons?.length}
                              {@render messageButtons(embed.buttons)}
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}

                    {#if msg.attachments && msg.attachments.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.attachments as att}
                          {#if att.contentType?.startsWith('image/')}
                            <img src={att.url} alt="discord-att" class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60 object-cover" />
                          {:else if att.contentType?.startsWith('video/')}
                            <!-- svelte-ignore a11y_media_has_caption -->
                            <video src={att.url} controls class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60"></video>
                          {:else if att.contentType?.startsWith('audio/')}
                            <audio src={att.url} controls class="max-w-[80%] lg:max-w-md"></audio>
                          {:else}
                            <a href={att.url} target="_blank" class="flex items-center gap-2 p-2.5 bg-white/5 border border-white/10 rounded-lg text-xs font-bold text-white hover:bg-white/10 transition-colors w-fit">
                              <Papicon icon="file" size={14} /> {m.e1_tickets_attachment()}
                            </a>
                          {/if}
                        {/each}
                      </div>
                    {/if}

                    {#if msg.buttons?.length}
                      {@render messageButtons(msg.buttons)}
                    {/if}

                    {#if msg.reactions?.length}
                      <div class="mt-1.5 flex flex-wrap gap-1">
                        {#each msg.reactions as reaction (reaction.imageUrl ?? reaction.emoji ?? reaction.name)}
                          <span class="chat-reaction" title={`:${reaction.name}:`}>
                            {#if reaction.imageUrl}
                              <img src={reaction.imageUrl} alt={`:${reaction.name}:`} class="w-4 h-4 object-contain" />
                            {:else}
                              <span class="text-sm leading-none">{reaction.emoji}</span>
                            {/if}
                            <span class="tabular-nums">{reaction.count}</span>
                          </span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <!-- Chat Input Bar -->
          {#if selectedTicketDetail?.status === 'OPEN' || selectedTicketDetail?.status === 'CLAIMED'}
            <div class="p-3 lg:p-4 border-t border-outline-variant/10 bg-surface-container/20 flex gap-2 lg:gap-3">
              <input
                type="text"
                bind:value={chatInput}
                onkeydown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder={m.e1_tickets_message_ph()}
                class="flex-1 bg-surface-container rounded-lg px-4 py-3 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm"
              />
              <button
                onclick={sendMessage}
                disabled={!chatInput.trim()}
                class="w-11 h-11 rounded-lg bg-primary text-white flex items-center justify-center active:scale-[0.98] transition-transform disabled:opacity-50 shrink-0"
              >
                <Papicon icon="send" size={18} />
              </button>
            </div>
          {:else}
            <div class="p-3 lg:p-4 border-t border-outline-variant/10 bg-error/10 text-error flex items-center justify-center text-xs font-medium gap-2">
              <Papicon icon="lock" size={14} /> {m.e1_tickets_closed_banner()}
            </div>
          {/if}
        {/if}
      </div>

      <!-- Profil de l'auteur, comme le panneau de profil de Discord. Sur les
           écrans plus étroits, le même dossier reste accessible par le bouton
           « Dossier » de l'en-tête. -->
      {#if selectedTicketDetail?.userId}
        <aside class="hidden xl:flex xl:col-span-3 flex-col bg-surface-container-low/40 border border-outline-variant/10 rounded-xl overflow-hidden h-full" aria-label={m.tmp_label()}>
          <TicketMemberPanel
            userId={selectedTicketDetail.userId}
            fallbackName={selectedTicketDetail.username}
            onopencase={(id, name) => openMemberCase(id, name)}
          />
        </aside>
      {:else}
        <div class="hidden xl:block xl:col-span-3"></div>
      {/if}
    </div>
  {:else if activeTab === 'performance'}
    <TicketPerformance />
  {:else if activeTab === 'config'}
    <TicketSettings {refreshToken} onsaved={() => loadTicketsAndConfig()} />
  {:else if activeTab === 'transcripts'}
    <TicketTranscripts {refreshToken} />
  {:else if activeTab === 'satisfaction'}
    <TicketSatisfactionTab {refreshToken} onopenmember={openMemberCase} />
  {:else if activeTab === 'macros'}
    <TicketMacros {refreshToken} ticketTypes={(Array.isArray(config.ticketTypes) ? config.ticketTypes : []).map((type: { id: string; label: string }) => ({ id: type.id, label: type.label }))} />
  {:else if activeTab === 'blacklist'}
    <TicketBlacklist {refreshToken} />
  {/if}
</ModulePage>

<!-- ============================================== -->
<!-- MODALS -->
<!-- ============================================== -->

{#snippet messageButtons(buttons: Array<{ label: string; emoji: string | null; url: string | null; style: number; disabled: boolean }>)}
  <!-- Les boutons d'un message Discord, en lecture seule : ils agissent dans
       Discord, pas depuis le dashboard. Les liens restent cliquables. -->
  <div class="mt-2 flex flex-wrap gap-1.5">
    {#each buttons as button, index (index)}
      {#if button.url}
        <a href={button.url} target="_blank" rel="noopener noreferrer" class="chat-button chat-button--link">
          {#if button.emoji?.startsWith('https://')}<img src={button.emoji} alt="" class="w-4 h-4" />{:else if button.emoji}<span>{button.emoji}</span>{/if}
          {button.label}
          <Papicon icon="external-link" size={11} />
        </a>
      {:else}
        <span class="chat-button chat-button--style-{button.style} {button.disabled ? 'opacity-50' : ''}">
          {#if button.emoji?.startsWith('https://')}<img src={button.emoji} alt="" class="w-4 h-4" />{:else if button.emoji}<span>{button.emoji}</span>{/if}
          {button.label}
        </span>
      {/if}
    {/each}
  </div>
{/snippet}

<!-- Refus d'une demande en attente -->
<Modal bind:open={showRejectModal} title={m.tr_reject_title()} subtitle={m.tr_reject_desc()} size="md" closeOnBackdropClick={!reviewBusy}>
  <label class="block">
    <span class="text-xs font-semibold text-on-surface-variant mb-2 block">{m.tr_reject_reason()}</span>
    <textarea class="input h-28" maxlength="500" bind:value={rejectReason} placeholder={m.tr_reject_reason_ph()}></textarea>
  </label>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (showRejectModal = false)}>{m.common_cancel()}</Button>
    <Button variant="danger" loading={reviewBusy} onclick={rejectPendingTicket}>{m.tr_reject_confirm()}</Button>
  {/snippet}
</Modal>

<!-- Ticket Close Modal -->
{#if showCloseModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-error">
        <Papicon icon="x-circle" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_close_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">{m.e1_tickets_close_modal_desc()}</p>
      
      <div>
        <label for="close-reason-input" class="field-label">{m.e1_tickets_close_reason_label()}</label>
        <textarea id="close-reason-input" bind:value={closeReason} class="w-full h-32 bg-surface-container rounded-lg p-4 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm" placeholder={m.e1_tickets_close_reason_ph()}></textarea>
      </div>
      
      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showCloseModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
        <button 
          onclick={closeTicket} 
          class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm"
        >
          {m.e1_tickets_close_confirm()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Ticket Delete Confirm Modal -->
{#if showDeleteConfirmModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-md shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-error">
        <Papicon icon="delete" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_delete_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">{m.e1_tickets_delete_modal_desc()}</p>
      
      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showDeleteConfirmModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
        <button 
          onclick={deleteTicket} 
          class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm"
        >
          {m.e1_tickets_delete_confirm()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Ticket Deletion Lock Modal -->
{#if showLockModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-md shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-warning">
        <Papicon icon="lock" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_lock_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">{m.e1_tickets_lock_modal_intro()}</p>

      <label class="block text-xs font-semibold text-on-surface-variant/70 mb-2" for="ticket-lock-duration">
        {m.e1_tickets_lock_duration()}
      </label>
      <div id="ticket-lock-duration" class="grid grid-cols-2 gap-2 mb-6">
        {#each [['7d', m.e1_tickets_lock_duration_7d()], ['30d', m.e1_tickets_lock_duration_30d()], ['90d', m.e1_tickets_lock_duration_90d()], ['permanent', m.e1_tickets_lock_duration_permanent()]] as [value, label]}
          <button
            type="button"
            onclick={() => lockDuration = value as typeof lockDuration}
            class="py-2.5 rounded-lg text-xs font-semibold transition-all border {lockDuration === value ? 'bg-amber-500 text-white border-warning' : 'bg-surface-container border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high'}"
          >
            {label}
          </button>
        {/each}
      </div>

      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_lock_reason()}</span>
        <FormTextarea bind:value={lockReason} placeholder={m.e1_tickets_lock_reason_ph()} rows={3} className="w-full" />
      </label>

      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showLockModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
        <button
          onclick={lockTicket}
          disabled={lockBusy}
          class="flex-1 py-4 rounded-xl font-bold bg-amber-500 text-white active:scale-[0.98] transition-transform shadow-sm disabled:opacity-50"
        >
          {lockBusy ? '…' : m.e1_tickets_lock_confirm()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Ticket Restore Modal -->
{#if showRestoreModal}
  {@const rc = selectedTicketDetail?.restoreCount ?? 0}
  {@const maxRestores = 3}
  {@const remaining = maxRestores - rc}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-purple-400">
        <Papicon icon="refresh-ccw" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_restore_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-4">{m.e1_tickets_restore_modal_intro()}</p>
      <ul class="text-sm text-on-surface-variant/80 mb-6 space-y-2 list-disc ml-5">
        <li>{m.e1_tickets_restore_step1_pre()}<strong>{m.e1_tickets_restore_step1_strong()}</strong>{m.e1_tickets_restore_step1_post()}</li>
        <li>{m.e1_tickets_restore_step2_pre()}<strong>{m.e1_tickets_restore_step2_strong()}</strong>{m.e1_tickets_restore_step2_post()}</li>
        <li>{m.e1_tickets_restore_step3_pre()}<strong>{m.e1_tickets_restore_step3_strong()}</strong></li>
      </ul>

      <div class="flex items-start gap-2 p-3 rounded-lg bg-purple-500/5 border border-purple-500/15 mb-4">
        <Papicon icon="info" size={14} class="text-purple-400 mt-0.5 shrink-0" />
        <div class="text-2xs text-purple-300/80 leading-relaxed">
          <p class="font-semibold mb-1">{m.e1_tickets_restore_limits_title({ remaining, max: maxRestores })}</p>
          <p>{m.e1_tickets_restore_limits_desc()}</p>
        </div>
      </div>

      <div class="flex items-start gap-2 p-3 rounded-lg bg-warning/5 border border-warning/15 mb-6">
        <Papicon icon="alert-triangle" size={14} class="text-warning mt-0.5 shrink-0" />
        <p class="text-2xs text-warning/80 leading-relaxed">{m.e1_tickets_restore_warning()}</p>
      </div>

      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showRestoreModal = false} disabled={restoring} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors disabled:opacity-50">{m.common_cancel()}</button>
        <button
          onclick={restoreTicket}
          disabled={restoring}
          class="flex-1 py-4 rounded-xl font-bold bg-purple-600 text-white active:scale-[0.98] transition-transform shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {#if restoring}
            <div class="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin"></div>
            {m.e1_tickets_restoring()}
          {:else}
            {m.e1_tickets_restore_confirm()}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Member Case Modal -->
{#if caseModalOpen}
  {#await import('../lib/components/MemberCaseModal.svelte') then module}
    {@const MemberCaseModal = module.default}
    <MemberCaseModal
      open={caseModalOpen}
      userId={selectedCaseUser?.id}
      userName={selectedCaseUser?.name || ''}
      caseData={selectedCaseData}
      loading={selectedCaseLoading}
      error={selectedCaseError}
      actionReason={memberActionReason}
      actionDuration={memberActionDuration}
      actionBusy={memberActionBusy}
      actionFeedback={memberActionFeedback}
      actionIsError={memberActionIsError}
      onClose={closeCaseModal}
      onAction={executeMemberAction}
    />
  {/await}
{/if}

<style>
  .chat-button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.75rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
    background: #4e5058;
    cursor: default;
  }
  .chat-button--style-1 { background: #5865f2; }
  .chat-button--style-3 { background: #248046; }
  .chat-button--style-4 { background: #da373c; }
  .chat-button--link { cursor: pointer; }
  .chat-button--link:hover { background: #6d6f78; }

  .chat-reaction {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.45rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.5rem;
    background: rgba(255, 255, 255, 0.06);
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.85);
  }
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }


</style>
