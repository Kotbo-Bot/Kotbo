/** Remontees d erreurs et feedback. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, authorizedFetch } from './client';

export async function reportDashboardError(errorData: {
  error: string;
  stack?: string;
  url: string;
  userAgent: string;
  guildId?: string | null;
}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (authStore.token) {
    headers.Authorization = `Bearer ${authStore.token}`;
  }

  const response = await fetch(`${API_BASE_URL}/api/report-error`, {
    method: 'POST',
    headers,
    body: JSON.stringify(errorData)
  });

  if (!response.ok) {
    throw new Error(`Server error: ${response.status}`);
  }

  return response.json();
}

export async function reportFeedback(feedbackData: {
  type: 'retour' | 'bloquage' | 'suggestion' | 'autre';
  message: string;
  url: string;
  guildId?: string | null;
}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (authStore.token) {
    headers.Authorization = `Bearer ${authStore.token}`;
  }

  const response = await fetch(`${API_BASE_URL}/api/report-feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify(feedbackData)
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${response.status}`);
  }

  return response.json();
}

export type FeedbackStatus = 'NEW' | 'ACKNOWLEDGED' | 'PLANNED' | 'DONE' | 'DECLINED';
export const FEEDBACK_STATUS_ORDER: FeedbackStatus[] = ['NEW', 'ACKNOWLEDGED', 'PLANNED', 'DONE', 'DECLINED'];

export interface FeedbackSummary {
  id: string;
  type: 'retour' | 'bloquage' | 'suggestion' | 'autre';
  message: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

export interface AdminFeedbackSummary extends FeedbackSummary {
  userId: string;
  username: string;
  url: string;
  guildId: string | null;
}

export interface FeedbackMessageEntry {
  id: string;
  authorId: string;
  authorName: string;
  fromStaff: boolean;
  content: string;
  createdAt: string;
}

export interface FeedbackDetail extends Omit<AdminFeedbackSummary, '_count'> {
  messages: FeedbackMessageEntry[];
}

type FetchInit = Parameters<typeof authorizedFetch>[1];

async function feedbackJson<T>(path: string, init?: FetchInit): Promise<T> {
  const response = await authorizedFetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${response.status}`);
  }
  return response.json();
}

const post = (body: unknown): FetchInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const fetchMyFeedbacks = () => feedbackJson<{ feedbacks: FeedbackSummary[] }>('/api/feedback/mine');
export const fetchFeedback = (id: string) => feedbackJson<{ feedback: FeedbackDetail }>(`/api/feedback/${id}`);
export const replyToFeedback = (id: string, content: string) =>
  feedbackJson<{ message: FeedbackMessageEntry }>(`/api/feedback/${id}/messages`, post({ content }));

export const fetchAdminFeedbacks = (filters: { status?: string; type?: string } = {}) => {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  return feedbackJson<{ feedbacks: AdminFeedbackSummary[] }>(`/api/admin/feedback?${params.toString()}`);
};
export const setFeedbackStatus = (id: string, status: FeedbackStatus, message?: string) =>
  feedbackJson<{ feedback: AdminFeedbackSummary }>(`/api/admin/feedback/${id}/status`, post({ status, message }));
