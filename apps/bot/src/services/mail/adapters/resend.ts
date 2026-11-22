import crypto from 'node:crypto';
import { verifyTimingSafeEqual } from '../crypto.js';
import {
  formatFromHeader,
  generateRfc5322MessageId,
  parseAddressHeader,
  type InboundWebhookContext,
  type InboundWebhookResult,
  type MailAttachmentMeta,
  type MailCredentials,
  type MailProviderAdapter,
  type ResendCredentials,
  type SendEmailInput,
  type SendEmailResult,
  type VerifyCredentialsResult,
} from '../types.js';

const RESEND_API_BASE = 'https://api.resend.com';

function assertResendCredentials(credentials: MailCredentials): ResendCredentials {
  if (credentials.provider !== 'RESEND') {
    throw new Error(`Fournisseur incompatible pour ResendAdapter : ${credentials.provider}`);
  }
  return credentials;
}

function verifySvixSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
  signingSecret: string,
): boolean {
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretPart = signingSecret.startsWith('whsec_') ? signingSecret.slice(6) : signingSecret;
  const key = Buffer.from(secretPart, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');

  return svixSignature
    .split(' ')
    .map((entry) => entry.split(',')[1])
    .filter((sig): sig is string => Boolean(sig))
    .some((sig) => verifyTimingSafeEqual(sig, expected));
}

export class ResendAdapter implements MailProviderAdapter {
  readonly provider = 'RESEND' as const;

  async verifyCredentials(credentials: MailCredentials): Promise<VerifyCredentialsResult> {
    const creds = assertResendCredentials(credentials);
    try {
      const res = await fetch(`${RESEND_API_BASE}/domains`, {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          error: `Resend API (${res.status}) : ${text || res.statusText}`,
        };
      }
      const data = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      return {
        ok: true,
        details: { domainsCount: Array.isArray(data.data) ? data.data.length : 0 },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Échec de connexion à Resend.',
      };
    }
  }

  async sendEmail(credentials: MailCredentials, input: SendEmailInput): Promise<SendEmailResult> {
    const creds = assertResendCredentials(credentials);
    const messageId = input.messageId || generateRfc5322MessageId(input.fromEmail);

    const headers: Record<string, string> = { 'Message-ID': messageId };
    if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo;
    if (input.references?.length) headers.References = input.references.join(' ');

    const res = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: formatFromHeader(input.fromEmail, input.displayName),
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: input.subject,
        ...(input.text ? { text: input.text } : {}),
        ...(input.html ? { html: input.html } : {}),
        headers,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Erreur Resend (${res.status}) : ${errText || res.statusText}`);
    }

    const body = (await res.json()) as { id?: string };
    return {
      providerMessageId: body.id ?? messageId,
      messageId,
    };
  }

  async parseInboundWebhook(ctx: InboundWebhookContext): Promise<InboundWebhookResult> {
    const creds = assertResendCredentials(ctx.credentials);
    const providedSecret = ctx.headers['x-kotbo-webhook-secret'] || ctx.querySecret || '';
    const secretOk = Boolean(providedSecret && verifyTimingSafeEqual(providedSecret, ctx.webhookSecret));
    const svixOk = Boolean(
      creds.webhookSigningSecret && verifySvixSignature(ctx.rawBody, ctx.headers, creds.webhookSigningSecret),
    );

    if (!secretOk && !svixOk) {
      throw new Error('Signature ou secret de webhook Resend invalide.');
    }

    const event = JSON.parse(ctx.rawBody) as { type?: string; created_at?: string; data?: Record<string, unknown> };
    if (event.type && event.type !== 'email.received') {
      return { kind: 'ignored', reason: `Événement Resend ignoré : ${event.type}` };
    }

    const data = (event.data ?? event) as Record<string, unknown>;
    const headers = (data.headers ?? {}) as Record<string, string | undefined>;
    const headerGet = (key: string): string | undefined => {
      const found = Object.entries(headers).find(([k]) => k.toLowerCase() === key.toLowerCase());
      return found?.[1];
    };

    const parsedFrom = parseAddressHeader(String(data.from ?? 'unknown@unknown'));
    const toList = Array.isArray(data.to) ? data.to : data.to ? [data.to] : [];
    const ccList = Array.isArray(data.cc) ? data.cc : data.cc ? [data.cc] : [];
    const rawRefs = headerGet('references') ?? (typeof data.references === 'string' ? data.references : '');

    const attachmentsRaw = Array.isArray(data.attachments) ? data.attachments : [];
    const attachments: MailAttachmentMeta[] = attachmentsRaw.map((att) => {
      const item = att as Record<string, unknown>;
      return {
        filename: String(item.filename ?? 'piece-jointe'),
        contentType: String(item.content_type ?? item.contentType ?? 'application/octet-stream'),
        size: Number(item.size ?? 0),
      };
    });

    const created = typeof event.created_at === 'string' ? new Date(event.created_at) : new Date();

    return {
      kind: 'message',
      email: {
        messageId: headerGet('message-id') ?? (typeof data.message_id === 'string' ? data.message_id : null),
        inReplyTo: headerGet('in-reply-to') ?? (typeof data.in_reply_to === 'string' ? data.in_reply_to : null),
        references: rawRefs.split(/\s+/).filter(Boolean),
        fromEmail: parsedFrom.email,
        fromName: parsedFrom.name,
        toEmails: toList.map((entry) => parseAddressHeader(String(entry)).email).filter(Boolean),
        ccEmails: ccList.map((entry) => parseAddressHeader(String(entry)).email).filter(Boolean),
        subject: typeof data.subject === 'string' ? data.subject : '(Sans objet)',
        textBody: typeof data.text === 'string' ? data.text : null,
        htmlBody: typeof data.html === 'string' ? data.html : null,
        attachments,
        providerMessageId: typeof data.email_id === 'string' ? data.email_id : null,
        receivedAt: Number.isNaN(created.getTime()) ? new Date() : created,
      },
    };
  }
}
