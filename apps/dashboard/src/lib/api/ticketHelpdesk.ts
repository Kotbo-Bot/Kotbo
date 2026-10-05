/** Centre de support : vues, propriétés, attribution, staff et performance. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type InboxView = 'open' | 'unassigned' | 'mine' | 'waiting_staff' | 'breached' | 'pending' | 'closed' | 'all';
export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type SlaStatus = 'met' | 'breached' | 'running' | 'at_risk';

export interface SlaClock {
  status: SlaStatus;
  dueAt: string;
  completedAt: string | null;
}

export interface TicketSla {
  firstResponse: SlaClock | null;
  resolution: SlaClock | null;
  worst: 'breached' | 'at_risk' | 'ok' | null;
}

/** Ligne de la boîte de réception, telle que la renvoie `GET /tickets`. */
export interface InboxTicket {
  id: string;
  userId: string;
  username: string;
  reason: string;
  status: string;
  claimedById: string | null;
  claimedByName: string | null;
  transcriptId: string | null;
  createdAt: string;
  ticketTypeLabel: string | null;
  priority: TicketPriority;
  tags: string[];
  firstResponseAt: string | null;
  closedAt: string | null;
  lastMemberMessageAt: string | null;
  lastStaffMessageAt: string | null;
  userAvatar: string | null;
  claimedByAvatar: string | null;
  waitingOn: 'staff' | 'member' | null;
  sla: TicketSla;
  /** Dernière émotion marquée du demandeur (Kotbo × AegisAI), absente sans le module. */
  moodLabel?: string | null;
  moodScore?: number | null;
  peakToxicity?: number | null;
}

export interface TicketAgent {
  id: string;
  name: string;
  avatar: string;
  openTickets: number;
}

export interface DurationStats {
  count: number;
  median: number | null;
  p90: number | null;
}

export interface TicketDailySeries {
  created: number[];
  closed: number[];
  firstResponse: (number | null)[];
  resolution: (number | null)[];
  satisfaction: (number | null)[];
}

export interface TicketStats {
  window: { days: number; from: string; to: string };
  daily: { dates: string[]; current: TicketDailySeries; previous: TicketDailySeries };
  previous: { created: number; closed: number; firstResponseMedian: number | null; resolutionMedian: number | null; satisfaction: number | null };
  timezone: string;
  volume: { created: number; closed: number; byDay: Array<{ date: string; created: number; closed: number }> };
  firstResponse: DurationStats;
  resolution: DurationStats;
  sla: { configured: boolean; firstResponseMinutes: number | null; resolutionHours: number | null; firstResponseMet: number | null; resolutionMet: number | null };
  satisfaction: { average: number | null; count: number; distribution: number[] };
  backlog: { active: number; unassigned: number; waitingStaff: number; breached: number; oldestActiveAt: string | null };
  agents: Array<{
    userId: string;
    name: string;
    handled: number;
    closed: number;
    firstResponse: DurationStats;
    resolution: DurationStats;
    rating: number | null;
    ratings: number;
    openNow: number;
  }>;
  byType: Array<{ label: string; count: number; resolution: DurationStats }>;
  byTag: Array<{ tag: string; count: number }>;
}

export function fetchTicketAgents(guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ agents: TicketAgent[] }>('/tickets/agents', { guildId, errorContext: 'API Error (Ticket agents):' });
}

export function updateTicketProperties(ticketId: string, patch: { priority?: TicketPriority; tags?: string[] }, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ ticket: { id: string; priority: TicketPriority; tags: string[] } }>(`/tickets/${ticketId}/properties`, {
    method: 'PATCH',
    payload: patch,
    guildId,
    errorContext: 'API Error (Ticket properties):',
  });
}

export function assignTicket(ticketId: string, userId: string | null, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ ticket: { id: string; status: string; claimedById: string | null; claimedByName: string | null } }>(`/tickets/${ticketId}/assign`, {
    method: 'POST',
    payload: { userId },
    guildId,
    errorContext: 'API Error (Assign ticket):',
  });
}

export function fetchTicketStats(days: number, guildId = authStore.selectedGuildId) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return dashboardRequest<TicketStats>(`/tickets/stats?days=${days}&tz=${encodeURIComponent(tz)}`, { guildId, errorContext: 'API Error (Ticket stats):' });
}
