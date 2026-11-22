import { GetAccountSendingEnabledCommand, GetSendQuotaCommand, SendRawEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { verifyTimingSafeEqual } from '../crypto.js';
import {
  formatFromHeader,
  generateRfc5322MessageId,
  parseAddressHeader,
  type AwsSesCredentials,
  type InboundWebhookContext,
  type InboundWebhookResult,
  type MailAttachmentMeta,
  type MailCredentials,
  type MailProviderAdapter,
  type SendEmailInput,
  type SendEmailResult,
  type VerifyCredentialsResult,
} from '../types.js';

function assertAwsCredentials(credentials: MailCredentials): AwsSesCredentials {
  if (credentials.provider !== 'AWS_SES') {
    throw new Error(`Fournisseur incompatible pour AwsSesAdapter : ${credentials.provider}`);
  }
  return credentials;
}

function createSesClient(creds: AwsSesCredentials): SESClient {
  return new SESClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });
}

function buildRawMimeMessage(input: SendEmailInput, messageId: string): string {
  const boundary = `kotbo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const sanitizeHeader = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

  const headers: string[] = [
    `From: ${formatFromHeader(input.fromEmail, input.displayName)}`,
    `To: ${input.to.map(sanitizeHeader).join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.map(sanitizeHeader).join(', ')}`] : []),
    `Subject: ${sanitizeHeader(input.subject)}`,
    `Message-ID: ${sanitizeHeader(messageId)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${sanitizeHeader(input.inReplyTo)}`] : []),
    ...(input.references?.length ? [`References: ${input.references.map(sanitizeHeader).join(' ')}`] : []),
    'MIME-Version: 1.0',
  ];

  const text = input.text ?? '';
  const html = input.html;

  if (html && text) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }

  if (html) {
    headers.push('Content-Type: text/html; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: 8bit');
    return [...headers, '', html, ''].join('\r\n');
  }

  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: 8bit');
  return [...headers, '', text, ''].join('\r\n');
}

function normalizeHeaderList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((v) => (typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []));
  }
  if (typeof raw === 'string') {
    return raw.split(/\s+/).filter(Boolean);
  }
  return [];
}

export class AwsSesAdapter implements MailProviderAdapter {
  readonly provider = 'AWS_SES' as const;

  async verifyCredentials(credentials: MailCredentials): Promise<VerifyCredentialsResult> {
    const creds = assertAwsCredentials(credentials);
    const client = createSesClient(creds);
    try {
      const [sending, quota] = await Promise.all([
        client.send(new GetAccountSendingEnabledCommand({})),
        client.send(new GetSendQuotaCommand({})),
      ]);
      return {
        ok: true,
        details: {
          sendingEnabled: sending.Enabled ?? true,
          max24HourSend: quota.Max24HourSend ?? null,
          sentLast24Hours: quota.SentLast24Hours ?? null,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Échec de vérification AWS SES.',
      };
    } finally {
      client.destroy();
    }
  }

  async sendEmail(credentials: MailCredentials, input: SendEmailInput): Promise<SendEmailResult> {
    const creds = assertAwsCredentials(credentials);
    const client = createSesClient(creds);
    const messageId = input.messageId || generateRfc5322MessageId(input.fromEmail);
    const rawMime = buildRawMimeMessage(input, messageId);

    try {
      const response = await client.send(
        new SendRawEmailCommand({
          RawMessage: { Data: Buffer.from(rawMime, 'utf8') },
        }),
      );
      return {
        providerMessageId: response.MessageId ?? messageId,
        messageId,
      };
    } finally {
      client.destroy();
    }
  }

  async parseInboundWebhook(ctx: InboundWebhookContext): Promise<InboundWebhookResult> {
    const providedSecret = ctx.headers['x-kotbo-webhook-secret'] || ctx.querySecret || '';
    if (!providedSecret || !verifyTimingSafeEqual(providedSecret, ctx.webhookSecret)) {
      throw new Error('Signature ou secret de webhook AWS SNS invalide.');
    }

    const envelope = JSON.parse(ctx.rawBody) as Record<string, unknown>;
    const snsType = typeof envelope.Type === 'string' ? envelope.Type : '';

    if (snsType === 'SubscriptionConfirmation' && typeof envelope.SubscribeURL === 'string') {
      return { kind: 'subscription_confirmation', subscribeUrl: envelope.SubscribeURL };
    }

    const payload =
      snsType === 'Notification' && typeof envelope.Message === 'string'
        ? (JSON.parse(envelope.Message) as Record<string, unknown>)
        : envelope;

    const mail = (payload.mail ?? payload) as Record<string, unknown>;
    const commonHeaders = (mail.commonHeaders ?? {}) as Record<string, unknown>;
    const headersList = Array.isArray(mail.headers) ? (mail.headers as Array<{ name?: string; value?: string }>) : [];
    const headerValue = (name: string): string | undefined =>
      headersList.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

    const rawFrom =
      (Array.isArray(commonHeaders.from) ? commonHeaders.from[0] : commonHeaders.from) ??
      (typeof mail.source === 'string' ? mail.source : '');
    const parsedFrom = parseAddressHeader(String(rawFrom || 'unknown@unknown'));

    const toRaw = Array.isArray(commonHeaders.to) ? commonHeaders.to : Array.isArray(mail.destination) ? mail.destination : [];
    const ccRaw = Array.isArray(commonHeaders.cc) ? commonHeaders.cc : [];

    const attachmentsRaw = Array.isArray(payload.attachments) ? payload.attachments : [];
    const attachments: MailAttachmentMeta[] = attachmentsRaw.map((att) => {
      const item = att as Record<string, unknown>;
      return {
        filename: String(item.filename ?? item.name ?? 'piece-jointe'),
        contentType: String(item.contentType ?? item.mimeType ?? 'application/octet-stream'),
        size: Number(item.size ?? 0),
      };
    });

    const timestamp = typeof mail.timestamp === 'string' ? new Date(mail.timestamp) : new Date();

    return {
      kind: 'message',
      email: {
        messageId: (typeof commonHeaders.messageId === 'string' ? commonHeaders.messageId : headerValue('message-id')) ?? null,
        inReplyTo: headerValue('in-reply-to') ?? (typeof payload.inReplyTo === 'string' ? payload.inReplyTo : null),
        references: normalizeHeaderList(headerValue('references') ?? payload.references),
        fromEmail: parsedFrom.email,
        fromName: parsedFrom.name,
        toEmails: toRaw.map((entry) => parseAddressHeader(String(entry)).email).filter(Boolean),
        ccEmails: ccRaw.map((entry) => parseAddressHeader(String(entry)).email).filter(Boolean),
        subject: typeof commonHeaders.subject === 'string' ? commonHeaders.subject : '(Sans objet)',
        textBody: typeof payload.text === 'string' ? payload.text : typeof payload.content === 'string' ? payload.content : null,
        htmlBody: typeof payload.html === 'string' ? payload.html : null,
        attachments,
        providerMessageId: typeof mail.messageId === 'string' ? mail.messageId : null,
        receivedAt: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
      },
    };
  }
}
