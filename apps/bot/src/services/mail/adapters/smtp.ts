import nodemailer from 'nodemailer';
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
  type SendEmailInput,
  type SendEmailResult,
  type SmtpImapCredentials,
  type VerifyCredentialsResult,
} from '../types.js';

function assertSmtpCredentials(credentials: MailCredentials): SmtpImapCredentials {
  if (credentials.provider !== 'SMTP_IMAP') {
    throw new Error(`Fournisseur incompatible pour SmtpAdapter : ${credentials.provider}`);
  }
  return credentials;
}

function createTransporter(creds: SmtpImapCredentials) {
  return nodemailer.createTransport({
    host: creds.smtpHost,
    port: creds.smtpPort,
    secure: creds.smtpSecure,
    auth: {
      user: creds.smtpUser,
      pass: creds.smtpPass,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
}

export class SmtpAdapter implements MailProviderAdapter {
  readonly provider = 'SMTP_IMAP' as const;

  async verifyCredentials(credentials: MailCredentials): Promise<VerifyCredentialsResult> {
    const creds = assertSmtpCredentials(credentials);
    const transporter = createTransporter(creds);
    try {
      await transporter.verify();
      return {
        ok: true,
        details: { host: creds.smtpHost, port: creds.smtpPort, secure: creds.smtpSecure },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Échec de connexion au serveur SMTP.',
      };
    } finally {
      transporter.close();
    }
  }

  async sendEmail(credentials: MailCredentials, input: SendEmailInput): Promise<SendEmailResult> {
    const creds = assertSmtpCredentials(credentials);
    const transporter = createTransporter(creds);
    const messageId = input.messageId || generateRfc5322MessageId(input.fromEmail);

    try {
      const info = await transporter.sendMail({
        from: formatFromHeader(input.fromEmail, input.displayName),
        to: input.to.join(', '),
        ...(input.cc?.length ? { cc: input.cc.join(', ') } : {}),
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId,
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        ...(input.references?.length ? { references: input.references } : {}),
      });

      return {
        providerMessageId: info.messageId || messageId,
        messageId,
      };
    } finally {
      transporter.close();
    }
  }

  async parseInboundWebhook(ctx: InboundWebhookContext): Promise<InboundWebhookResult> {
    const providedSecret = ctx.headers['x-kotbo-webhook-secret'] || ctx.querySecret || '';
    if (!providedSecret || !verifyTimingSafeEqual(providedSecret, ctx.webhookSecret)) {
      throw new Error('Secret de webhook SMTP/IMAP invalide.');
    }

    const payload = JSON.parse(ctx.rawBody) as Record<string, unknown>;
    const parsedFrom = parseAddressHeader(String(payload.from ?? payload.fromEmail ?? 'unknown@unknown'));
    const toList = Array.isArray(payload.to) ? payload.to : payload.to ? [payload.to] : [];
    const ccList = Array.isArray(payload.cc) ? payload.cc : payload.cc ? [payload.cc] : [];
    const refs = Array.isArray(payload.references)
      ? payload.references.map(String)
      : typeof payload.references === 'string'
        ? payload.references.split(/\s+/).filter(Boolean)
        : [];

    const attachmentsRaw = Array.isArray(payload.attachments) ? payload.attachments : [];
    const attachments: MailAttachmentMeta[] = attachmentsRaw.map((att) => {
      const item = att as Record<string, unknown>;
      return {
        filename: String(item.filename ?? 'piece-jointe'),
        contentType: String(item.contentType ?? 'application/octet-stream'),
        size: Number(item.size ?? 0),
      };
    });

    const receivedAt = typeof payload.receivedAt === 'string' ? new Date(payload.receivedAt) : new Date();

    return {
      kind: 'message',
      email: {
        messageId: typeof payload.messageId === 'string' ? payload.messageId : null,
        inReplyTo: typeof payload.inReplyTo === 'string' ? payload.inReplyTo : null,
        references: refs,
        fromEmail: parsedFrom.email,
        fromName: parsedFrom.name,
        toEmails: toList.map((entry) => parseAddressHeader(String(entry)).email).filter(Boolean),
        ccEmails: ccList.map((entry) => parseAddressHeader(String(entry)).email).filter(Boolean),
        subject: typeof payload.subject === 'string' ? payload.subject : '(Sans objet)',
        textBody: typeof payload.text === 'string' ? payload.text : typeof payload.textBody === 'string' ? payload.textBody : null,
        htmlBody: typeof payload.html === 'string' ? payload.html : typeof payload.htmlBody === 'string' ? payload.htmlBody : null,
        attachments,
        providerMessageId: typeof payload.providerMessageId === 'string' ? payload.providerMessageId : null,
        receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      },
    };
  }
}
