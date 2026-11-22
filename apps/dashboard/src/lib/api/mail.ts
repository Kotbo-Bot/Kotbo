/** Intégration mail BYOP : comptes connectés, fils de discussion, envoi et webhooks entrants. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, dashboardRequest } from './client';

export type MailProvider = 'AWS_SES' | 'RESEND' | 'SMTP_IMAP';
export type MailAccountStatus = 'PENDING' | 'VERIFIED' | 'ERROR';
export type MailThreadStatus = 'OPEN' | 'CLOSED' | 'ARCHIVED';
export type MailDirection = 'INBOUND' | 'OUTBOUND';

export type MailCredentialsPayload =
  | { provider: 'AWS_SES'; region: string; accessKeyId: string; secretAccessKey: string }
  | { provider: 'RESEND'; apiKey: string; webhookSigningSecret?: string }
  | {
      provider: 'SMTP_IMAP';
      smtpHost: string;
      smtpPort: number;
      smtpSecure: boolean;
      smtpUser: string;
      smtpPass: string;
      imapHost?: string;
      imapPort?: number;
      imapSecure?: boolean;
    };

export interface MailAccount {
  id: string;
  guildId: string;
  provider: MailProvider;
  fromEmail: string;
  displayName: string | null;
  status: MailAccountStatus;
  lastError: string | null;
  verifiedAt: string | null;
  enabled: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailThread {
  id: string;
  accountId: string;
  guildId: string;
  subject: string;
  status: MailThreadStatus;
  participants: string[];
  lastMessageAt: string;
  lastMessageSnippet: string | null;
  messageCount: number;
  account?: {
    id: string;
    fromEmail: string;
    displayName: string | null;
    provider: MailProvider;
  };
}

export interface MailAttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  accountId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  direction: MailDirection;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  attachments: MailAttachmentMeta[] | null;
  providerMessageId: string | null;
  receivedAt: string;
}

export interface MailThreadDetail extends MailThread {
  messages: MailMessage[];
}

export interface VerifyMailResult {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

const base = '/mail';

export function buildInboundWebhookUrl(accountId: string, secret?: string | null): string {
  const origin = API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : '');
  const url = `${origin.replace(/\/$/, '')}/webhooks/inbound-email/${accountId}`;
  return secret ? `${url}?secret=${encodeURIComponent(secret)}` : url;
}

export function fetchMailAccounts(guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ accounts: MailAccount[] }>(`${base}/accounts`, {
    guildId,
    errorContext: 'API Error (Mail accounts):',
  });
}

export function createMailAccount(
  input: {
    provider: MailProvider;
    fromEmail: string;
    displayName?: string | null;
    credentials: MailCredentialsPayload;
  },
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest<{ account: MailAccount; webhookSecret: string | null }>(`${base}/accounts`, {
    method: 'POST',
    payload: input,
    guildId,
    errorContext: 'API Error (Create mail account):',
  });
}

export function updateMailAccount(
  accountId: string,
  patch: {
    fromEmail?: string;
    displayName?: string | null;
    enabled?: boolean;
    credentials?: MailCredentialsPayload;
  },
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest<{ account: MailAccount }>(`${base}/accounts/${accountId}`, {
    method: 'PATCH',
    payload: patch,
    guildId,
    errorContext: 'API Error (Update mail account):',
  });
}

export function deleteMailAccount(accountId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ ok: boolean }>(`${base}/accounts/${accountId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete mail account):',
  });
}

export function verifyMailAccount(accountId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ account: MailAccount; result: VerifyMailResult }>(`${base}/accounts/${accountId}/verify`, {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Verify mail account):',
  });
}

export function revealMailWebhookSecret(accountId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ secret: string }>(`${base}/accounts/${accountId}/webhook-secret`, {
    guildId,
    errorContext: 'API Error (Mail webhook secret):',
  });
}

export function rotateMailWebhookSecret(accountId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ secret: string }>(`${base}/accounts/${accountId}/rotate-secret`, {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Rotate mail webhook secret):',
  });
}

export function fetchMailThreads(
  filters: { accountId?: string; status?: MailThreadStatus | ''; search?: string } = {},
  guildId = authStore.selectedGuildId,
) {
  const params = new URLSearchParams();
  if (filters.accountId) params.set('accountId', filters.accountId);
  if (filters.status) params.set('status', filters.status);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  const q = params.toString();
  return dashboardRequest<{ threads: MailThread[] }>(`${base}/threads${q ? `?${q}` : ''}`, {
    guildId,
    errorContext: 'API Error (Mail threads):',
  });
}

export function fetchMailThread(threadId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ thread: MailThreadDetail }>(`${base}/threads/${threadId}`, {
    guildId,
    errorContext: 'API Error (Mail thread):',
  });
}

export function updateMailThreadStatus(
  threadId: string,
  status: MailThreadStatus,
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest<{ thread: MailThread }>(`${base}/threads/${threadId}`, {
    method: 'PATCH',
    payload: { status },
    guildId,
    errorContext: 'API Error (Update mail thread):',
  });
}

export function sendMail(
  input: {
    accountId: string;
    threadId?: string;
    to: string[];
    cc?: string[];
    subject: string;
    text?: string;
    html?: string;
  },
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest<{ thread: MailThread; message: MailMessage }>(`${base}/send`, {
    method: 'POST',
    payload: input,
    guildId,
    errorContext: 'API Error (Send mail):',
  });
}
