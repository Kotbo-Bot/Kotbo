<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  import { m } from '../lib/i18n';
  import { MemberCaseState } from '../lib/memberCase.svelte';
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
  import { dashboardFetch } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';

  import { errorMessage } from '@kotbo/shared';
  import TicketInboxList from '../lib/components/tickets/TicketInboxList.svelte';
  import TicketProperties from '../lib/components/tickets/TicketProperties.svelte';
  import DoingListPin from '../lib/components/doingLists/DoingListPin.svelte';
  import TicketPerformance from '../lib/components/tickets/TicketPerformance.svelte';
  import TicketBlacklist from '../lib/components/tickets/TicketBlacklist.svelte';
  import TicketTranscripts from '../lib/components/tickets/TicketTranscripts.svelte';
  import TicketSatisfactionTab from '../lib/components/tickets/TicketSatisfactionTab.svelte';
  import TicketMacros from '../lib/components/tickets/TicketMacros.svelte';
  import TicketSettings from '../lib/components/tickets/TicketSettings.svelte';
  import TicketMemberPanel from '../lib/components/tickets/TicketMemberPanel.svelte';
  import type { InboxTicket, InboxView } from '../lib/api';
  import { resolveUserAvatarSrc } from '../lib/discordMedia';
  import { MessageList } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../lib/components/discord/DiscordScope.svelte';
  import { conversationOf, conversationViews, EMPTY_CONVERSATION, type DiscordApiMessage, type DiscordConversation } from '../lib/discordConversation';
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
  /** Messages du ticket au format de l'API Discord, rendus par @arcscord/discord-ui. */
  let conversation = $state<DiscordConversation>(EMPTY_CONVERSATION);
  const messages = $derived(conversation.messages);
  const chatMessages = $derived(conversationViews(conversation));
  
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

  // Propriétés et renommage restent repliés par défaut : dépliés en permanence,
  // ils mangeaient plus de la moitié de la hauteur de la conversation.
  const DETAILS_OPEN_KEY = 'kotbo.tickets.detailsOpen';
  let detailsOpen = $state((() => {
    try { return localStorage.getItem(DETAILS_OPEN_KEY) === '1'; } catch { return false; }
  })());
  function toggleDetails() {
    detailsOpen = !detailsOpen;
    try { localStorage.setItem(DETAILS_OPEN_KEY, detailsOpen ? '1' : '0'); } catch { /* stockage indisponible */ }
  }

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
      error = errorMessage(err) || m.common_error_occurred();
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
      conversation = conversationOf(data);
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
      conversation = conversationOf(data);
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
    // Identifiant numérique : la lib en dérive l'avatar par défaut.
    const authorId = authStore.user?.id ?? '0';
    const authorName = authStore.user?.username || 'Staff';
    const tempMsg = {
      id: `temp-${Date.now()}`,
      channel_id: selectedTicketId,
      type: 0,
      author: { id: authorId, username: authorName, global_name: authorName, discriminator: '0', avatar: null },
      content: textToSend,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
    } as DiscordApiMessage;
    conversation = {
      ...conversation,
      messages: [...conversation.messages, tempMsg],
      authors: {
        ...conversation.authors,
        [authorId]: conversation.authors[authorId]
          ?? { displayName: authorName, avatarUrl: resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar) ?? '', bot: false, verified: false },
      },
    };
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
      conversation = EMPTY_CONVERSATION;
      await loadTicketsAndConfig();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  // Fiche propre à la page : une sanction lancée depuis un ticket propose sa raison par défaut.
  const memberCase = new MemberCaseState();

  function openMemberCase(userId: string, userName: string) {
    void memberCase.show(userId, userName, m.e1_tickets_member_action_default_reason());
  }

  function getStatusLabel(status: string) {
    switch (status) {
      case 'PENDING': return m.e1_tickets_status_pending();
      case 'QUEUED': return m.e1_tickets_status_queued();
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
      // Même teinte que l'attente de validation : le ticket n'a pas encore de salon.
      case 'QUEUED': return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
      case 'OPEN': return 'bg-success/10 text-on-success-container border-success/20';
      case 'CLAIMED': return 'bg-warning/10 text-on-warning-container border-warning/20';
      case 'CLOSED': return 'bg-error/10 text-on-error-container border-error/20';
      case 'ARCHIVED': return 'bg-slate-500/10 text-on-surface-variant border-slate-500/20';
      case 'REJECTED': return 'bg-error/10 text-on-error-container border-error/20';
      // Orange et non rouge : ce n'est pas une decision du staff, c'est un accident.
      case 'ORPHANED': return 'bg-orange-500/10 text-orange-400 border-orange-500/20';
      default: return 'bg-outline-variant/10 text-on-surface-variant border-outline-variant/20';
    }
  }

  // Pastille affichée dans l'en-tête quand le panneau Détails est replié.
  const PRIORITY_CHIP = {
    LOW: { label: () => m.th_priority_low(), tone: 'bg-outline-variant/10 text-on-surface-variant border-outline-variant/20' },
    HIGH: { label: () => m.th_priority_high(), tone: 'bg-warning/10 text-on-warning-container border-warning/20' },
    URGENT: { label: () => m.th_priority_urgent(), tone: 'bg-error/10 text-on-error-container border-error/20' },
  };

  onMount(async () => {
    await loadTicketsAndConfig();
    // Lien profond depuis une liste de suivi : /tickets?ticket=<id>.
    const linkedTicketId = new URLSearchParams(window.location.search).get('ticket');
    if (linkedTicketId) selectTicket(linkedTicketId);

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
    <!-- La roue crantee qui menait a « Configuration » faisait doublon avec
         l'onglet du meme nom, juste en dessous : elle est retiree. -->
    <RefreshButton onClick={handleRefresh} loading={loading} label={m.e1_tickets_refresh()} />
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
    <!-- Les colonnes latérales ont une largeur bornée : en douzièmes, elles
         grandissaient avec l'écran et la conversation restait étroite. -->
    <div class="grid grid-cols-1 lg:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)] xl:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)_minmax(16rem,19rem)] gap-4 h-auto lg:h-[calc(100dvh-13rem)] lg:min-h-144">

      <!-- Left Panel: Tickets Browser -->
      <div data-tour="tickets-list" class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-4 flex flex-col overflow-hidden {showMobileChat && selectedTicketId ? 'hidden lg:flex' : 'flex'} h-[50vh] lg:h-full">
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
          onview={(view) => { selectedTicketId = null; selectedTicketDetail = null; conversation = EMPTY_CONVERSATION; changeInbox({ view }); }}
          onsearch={(query) => changeInbox({ query })}
          onsort={(sort) => changeInbox({ sort })}
          onselect={(id) => { selectTicket(id); showMobileChat = true; }}
          onloadmore={() => loadTicketsAndConfig(false)}
        />
      </div>

      <!-- Right Panel: Live Chat & Actions -->
      <div data-tour="tickets-chat" class="min-w-0 bg-surface-container-low/40 border border-outline-variant/10 rounded-xl flex flex-col overflow-hidden {!showMobileChat && selectedTicketId ? 'hidden lg:flex' : !selectedTicketId ? 'hidden lg:flex' : 'flex'} h-[75vh] lg:h-full">
        {#if !selectedTicketId}
          <div class="flex-1 flex flex-col items-center justify-center text-on-surface-variant/30 py-20">
            <div class="w-16 h-16 rounded-xl bg-surface-container flex items-center justify-center mb-4 shadow-inner">
              <Papicon icon="message-square" size={32} />
            </div>
            <h3 class="text-lg font-semibold text-on-surface/40">{m.e1_tickets_no_selection_title()}</h3>
            <p class="text-xs opacity-60 mt-1">{m.e1_tickets_no_selection_desc()}</p>
          </div>
        {:else}
          <!-- Chat Header : bornée en hauteur et défilante, pour que la
               conversation garde toujours la plus grande part du panneau. -->
          <div class="shrink-0 max-h-[55%] overflow-y-auto px-3 py-3 lg:px-4 border-b border-outline-variant/10 bg-surface-container/20">
            <div class="flex items-center gap-3">
              <!-- Mobile back button -->
              <button onclick={() => showMobileChat = false} class="lg:hidden p-2 -ml-1 rounded-lg hover:bg-surface-container transition-colors">
                <Papicon icon="arrow-left" size={18} />
              </button>
              {#if selectedTicketDetail?.userAvatar}
                <img src={selectedTicketDetail.userAvatar} alt={selectedTicketDetail.username} class="w-9 h-9 rounded-xl object-cover shadow-inner shrink-0" />
              {:else}
                <div class="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-semibold text-base shadow-inner shrink-0">
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
                  <!-- Panneau replié : la priorité hors normale et les
                       étiquettes restent lisibles sans le déplier. -->
                  {#if !detailsOpen}
                    {#if selectedTicketDetail?.priority && selectedTicketDetail.priority !== 'NORMAL'}
                      <span class="px-2 py-0.5 rounded-full text-xs font-semibold border {PRIORITY_CHIP[selectedTicketDetail.priority as keyof typeof PRIORITY_CHIP]?.tone ?? ''}">
                        {PRIORITY_CHIP[selectedTicketDetail.priority as keyof typeof PRIORITY_CHIP]?.label()}
                      </span>
                    {/if}
                    {#each (selectedTicketDetail?.tags ?? []).slice(0, 3) as tag (tag)}
                      <span class="px-2 py-0.5 rounded-full text-xs bg-surface-container text-on-surface-variant">#{tag}</span>
                    {/each}
                    {#if (selectedTicketDetail?.tags?.length ?? 0) > 3}
                      <span class="text-xs text-on-surface-variant">+{selectedTicketDetail.tags.length - 3}</span>
                    {/if}
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
              {#if selectedTicketDetail}
                <button
                  type="button"
                  onclick={toggleDetails}
                  aria-expanded={detailsOpen}
                  aria-controls="ticket-details-panel"
                  class="px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shrink-0 border transition-colors {detailsOpen ? 'bg-primary/10 text-primary border-primary/20' : 'text-on-surface-variant border-outline-variant/20 hover:bg-surface-container'}"
                >
                  <Papicon icon="sliders" size={12} />
                  <span class="hidden sm:inline">{m.e1_tickets_details_toggle()}</span>
                  <Papicon icon={detailsOpen ? 'chevron-up' : 'chevron-down'} size={12} />
                </button>
              {/if}
            </div>

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
              {#if memberCase.canOpen}
                <button
                  onclick={() => openMemberCase(selectedTicketDetail.userId, selectedTicketDetail.username)}
                  class="px-3 py-1.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg text-xs font-semibold hover:bg-indigo-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="shield" size={12} /> {m.e1_tickets_btn_case()}
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'OPEN' || selectedTicketDetail?.status === 'CLAIMED'}
                {#if selectedTicketDetail.status === 'OPEN'}
                  <button onclick={claimTicket}
                    class="px-3 py-1.5 bg-warning/10 text-on-warning-container border border-warning/20 rounded-lg text-xs font-semibold hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="user-check" size={12} /> {m.e1_tickets_btn_claim()}
                  </button>
                {/if}
                <button onclick={() => showCloseModal = true}
                  class="px-3 py-1.5 bg-error/10 text-on-error-container border border-error/20 rounded-lg text-xs font-semibold hover:bg-rose-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="x-circle" size={12} /> {m.e1_tickets_btn_close()}
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLAIMED' && selectedTicketDetail.claimedById !== authStore.user?.id && (config.ticketAllowOverclaim ?? true) && config.ticketOverclaimPermission !== 'NONE'}
                <button onclick={claimTicket}
                  class="px-3 py-1.5 bg-warning/10 text-on-warning-container border border-warning/20 rounded-lg text-xs font-semibold hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="user-check" size={12} /> {m.e1_tickets_btn_overclaim()}
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLOSED' || selectedTicketDetail?.status === 'ARCHIVED'}
                {#if selectedTicketDetail.channelId}
                  <button onclick={reopenTicket}
                    class="px-3 py-1.5 bg-success/10 text-on-success-container border border-success/20 rounded-lg text-xs font-semibold hover:bg-emerald-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
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
                      class="px-3 py-1.5 bg-warning/10 text-on-warning-container border border-warning/20 rounded-lg text-xs font-semibold hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
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
                    class="px-3 py-1.5 rounded-lg text-xs font-semibold active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0 {deletionLock ? 'bg-surface-container text-on-surface-variant/30 border border-outline-variant/10 cursor-not-allowed' : 'bg-rose-600 text-white border border-transparent hover:bg-rose-500'}"
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
                    class="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-all {restoresLeft > 0 ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500 hover:text-white cursor-pointer' : 'bg-surface-container text-on-surface-variant/30 border border-outline-variant/10 cursor-not-allowed'}"
                  >
                    <Papicon icon="refresh-ccw" size={12} /> {m.e1_tickets_btn_restore({ left: restoresLeft })}
                  </button>
                {/if}
              {/if}

              {#if selectedTicketId}
                <DoingListPin module="tickets" sourceId={selectedTicketId} />
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

            {#if detailsOpen && selectedTicketDetail}
              <div id="ticket-details-panel">
                <TicketProperties
                  ticket={{ ...(selectedInboxRow ?? {}), ...selectedTicketDetail, sla: selectedInboxRow?.sla ?? null }}
                  {knownTags}
                  onchange={patchSelectedTicket}
                />

                {#if selectedTicketDetail.channelId && selectedTicketDetail.mode !== 'DM'}
                  <div class="mt-3 flex gap-2 items-center">
                    <FormInput ariaLabel={m.e1_tickets_rename_ph()} type="text" bind:value={ticketRenameName} placeholder={m.e1_tickets_rename_ph()} className="flex-1" />
                    <button onclick={renameTicket} disabled={renameAction.state.loading} use:explainDisabled={(!ticketRenameName.trim()) ? m.common_reason_fill_field() : ''}
                      class="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-xs font-semibold hover:bg-primary hover:text-white transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="edit" size={12} />
                      {renameAction.state.loading ? '...' : m.e1_tickets_rename_btn()}
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Chat Messages Container -->
          <div
            bind:this={chatScrollContainer}
            class="flex-1 overflow-y-auto bg-[#313338] scrollbar-hide"
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
              <DiscordScope class="ticket-chat" entities={conversation.entities}>
                <MessageList messages={chatMessages} />
              </DiscordScope>
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
                use:explainDisabled={(!chatInput.trim()) ? m.common_reason_fill_field() : ''}
                class="w-11 h-11 rounded-lg bg-primary text-white flex items-center justify-center active:scale-[0.98] transition-transform disabled:opacity-50 shrink-0"
              >
                <Papicon icon="send" size={18} />
              </button>
            </div>
          {:else}
            <div class="p-3 lg:p-4 border-t border-outline-variant/10 bg-error/10 text-on-error-container flex items-center justify-center text-xs font-medium gap-2">
              <Papicon icon="lock" size={14} /> {m.e1_tickets_closed_banner()}
            </div>
          {/if}
        {/if}
      </div>

      <!-- Profil de l'auteur, comme le panneau de profil de Discord. Sur les
           écrans plus étroits, le même dossier reste accessible par le bouton
           « Dossier » de l'en-tête. -->
      {#if selectedTicketDetail?.userId}
        <aside class="hidden xl:flex flex-col bg-surface-container-low/40 border border-outline-variant/10 rounded-xl overflow-hidden h-full" aria-label={m.tmp_label()}>
          <TicketMemberPanel
            userId={selectedTicketDetail.userId}
            fallbackName={selectedTicketDetail.username}
            onopencase={(id, name) => openMemberCase(id, name)}
          />
        </aside>
      {:else}
        <div class="hidden xl:block"></div>
      {/if}
    </div>
  {:else if activeTab === 'performance'}
    <TicketPerformance />
  {:else if activeTab === 'config'}
    <TicketSettings {refreshToken} onsaved={() => loadTicketsAndConfig()} />
  {:else if activeTab === 'transcripts'}
    <TicketTranscripts {refreshToken} />
  {:else if activeTab === 'satisfaction'}
    <TicketSatisfactionTab {refreshToken} onopenmember={memberCase.canOpen ? openMemberCase : undefined} />
  {:else if activeTab === 'macros'}
    <TicketMacros {refreshToken} ticketTypes={(Array.isArray(config.ticketTypes) ? config.ticketTypes : []).map((type: { id: string; label: string }) => ({ id: type.id, label: type.label }))} />
  {:else if activeTab === 'blacklist'}
    <TicketBlacklist {refreshToken} />
  {/if}
</ModulePage>

<!-- ============================================== -->
<!-- MODALS -->
<!-- ============================================== -->

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

      <label class="block text-xs font-semibold text-on-surface-variant mb-2" for="ticket-lock-duration">
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
{#if memberCase.open}
  {#await import('../lib/components/MemberCaseModal.svelte') then module}
    {@const MemberCaseModal = module.default}
    <MemberCaseModal
      open={memberCase.open}
      userId={memberCase.userId}
      userName={memberCase.userName}
      caseData={memberCase.caseData}
      loading={memberCase.loading}
      error={memberCase.error}
      actionReason={memberCase.actionReason}
      onClose={() => memberCase.close()}
      onSelectUser={(userId) => memberCase.showFromGraph(userId)}
    />
  {/await}
{/if}

<style>
  /* La conversation occupe tout le panneau ; les messages ont leur propre marge. */
  :global(.arcscord-discord-ui.ticket-chat) {
    min-height: 100%;
    padding: 1rem 0;
  }
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }


</style>
