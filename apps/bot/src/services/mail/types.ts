export type MailProviderType = 'AWS_SES' | 'RESEND' | 'SMTP_IMAP';

export interface AwsSesCredentials {
  provider: 'AWS_SES';
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ResendCredentials {
  provider: 'RESEND';
  apiKey: string;
  webhookSigningSecret?: string;
}

export interface SmtpImapCredentials {
  provider: 'SMTP_IMAP';
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
}

export type MailCredentials = AwsSesCredentials | ResendCredentials | SmtpImapCredentials;

export interface VerifyCredentialsResult {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface SendEmailInput {
  fromEmail: string;
  displayName?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SendEmailResult {
  providerMessageId: string;
  messageId: string;
}

export interface MailAttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

export interface ParsedInboundEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  attachments: MailAttachmentMeta[];
  providerMessageId: string | null;
  receivedAt: Date;
}

export interface InboundWebhookContext {
  rawBody: string;
  headers: Record<string, string | undefined>;
  querySecret?: string;
  webhookSecret: string;
  credentials: MailCredentials;
}

export type InboundWebhookResult =
  | { kind: 'message'; email: ParsedInboundEmail }
  | { kind: 'subscription_confirmation'; subscribeUrl: string }
  | { kind: 'ignored'; reason: string };

export interface MailProviderAdapter {
  readonly provider: MailProviderType;
  verifyCredentials(credentials: MailCredentials, fromEmail: string): Promise<VerifyCredentialsResult>;
  sendEmail(credentials: MailCredentials, input: SendEmailInput): Promise<SendEmailResult>;
  parseInboundWebhook(ctx: InboundWebhookContext): Promise<InboundWebhookResult>;
}

/**
 * Extrait adresse et nom d'affichage depuis un en-tête RFC 5322 du type
 * `"Alice Dupont" <alice@exemple.fr>` ou `alice@exemple.fr`.
 */
export function parseAddressHeader(raw: string): { email: string; name: string | null } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(?:"?([^"<]*)"?\s*)?<([^>\s]+@[^>\s]+)>$/);
  if (match) {
    const name = match[1]?.trim() || null;
    return { email: match[2].trim().toLowerCase(), name };
  }
  return { email: trimmed.toLowerCase(), name: null };
}

export function formatFromHeader(email: string, displayName?: string | null): string {
  if (!displayName?.trim()) return email;
  const safeName = displayName.replace(/["\r\n]/g, '').trim();
  return safeName ? `"${safeName}" <${email}>` : email;
}

export function generateRfc5322MessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1]?.trim() || 'kotbo.fr';
  const rand = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  return `<${rand}@${domain}>`;
}
