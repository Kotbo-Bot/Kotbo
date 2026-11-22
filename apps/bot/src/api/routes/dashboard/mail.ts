import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { MailCryptoUnavailableError } from '../../../services/mail/crypto.js';
import {
  createMailAccount,
  deleteMailAccount,
  getMailThreadWithMessages,
  listMailAccounts,
  listMailThreads,
  revealMailWebhookSecret,
  rotateMailWebhookSecret,
  sendMail,
  updateMailAccount,
  updateMailThreadStatus,
  verifyMailAccount,
} from '../../../services/mail/mailService.js';

const LOG = 'MailAPI';

const awsCredentialsSchema = z.object({
  provider: z.literal('AWS_SES'),
  region: z.string().trim().min(2).max(64),
  accessKeyId: z.string().trim().min(4).max(128),
  secretAccessKey: z.string().trim().min(4).max(256),
});

const resendCredentialsSchema = z.object({
  provider: z.literal('RESEND'),
  apiKey: z.string().trim().min(4).max(256),
  webhookSigningSecret: z.string().trim().max(256).optional(),
});

const smtpCredentialsSchema = z.object({
  provider: z.literal('SMTP_IMAP'),
  smtpHost: z.string().trim().min(2).max(255),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().min(1).max(255),
  smtpPass: z.string().min(1).max(256),
  imapHost: z.string().trim().max(255).optional(),
  imapPort: z.coerce.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
});

const credentialsSchema = z.discriminatedUnion('provider', [
  awsCredentialsSchema,
  resendCredentialsSchema,
  smtpCredentialsSchema,
]);

const createAccountSchema = z.object({
  provider: z.enum(['AWS_SES', 'RESEND', 'SMTP_IMAP']),
  fromEmail: z.string().trim().email().max(255),
  displayName: z.string().trim().max(120).nullable().optional(),
  credentials: credentialsSchema,
});

const updateAccountSchema = z.object({
  fromEmail: z.string().trim().email().max(255).optional(),
  displayName: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
  credentials: credentialsSchema.optional(),
});

const sendMailSchema = z.object({
  accountId: z.string().trim().min(1),
  threadId: z.string().trim().min(1).optional(),
  to: z.array(z.string().trim().email()).min(1).max(50),
  cc: z.array(z.string().trim().email()).max(50).optional(),
  subject: z.string().trim().min(1).max(300),
  text: z.string().max(200_000).optional(),
  html: z.string().max(500_000).optional(),
});

const threadStatusSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED', 'ARCHIVED']),
});

export function createMailRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/mail';

  const adminOnly = createMiddleware(async (c, next) => {
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Réservé aux administrateurs du dashboard.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), adminOnly] as const;

  const audit = (c: Context, action: string, details: string) => {
    const guildId = c.req.param('guildId')!;
    return pushAudit(guildId, {
      user: auditUserOf(c),
      action,
      context: getGuildName(client, guildId),
      module: 'Mail BYOP',
      eventType: 'Settings',
      details,
      channelId: null,
    }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));
  };

  router.onError((err, c) => {
    if (err instanceof MailCryptoUnavailableError) {
      return send(c, { error: 'Le chiffrement mail (MAIL_ENCRYPTION_KEY) n’est pas configuré sur cette instance.' }, 503);
    }
    logger.error(LOG, `Erreur sur ${c.req.method} ${c.req.path} :`, err);
    return fail(c, err, 'Erreur sur le module Mail', LOG);
  });

  // ── Comptes mail ──────────────────────────────────────────────────────────

  router.get(`${base}/accounts`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const accounts = await listMailAccounts(guildId);
    return send(c, { accounts });
  });

  router.post(`${base}/accounts`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const raw = await readBody(c);
    const parsed = createAccountSchema.safeParse(raw);
    if (!parsed.success) {
      return send(c, { error: 'Paramètres de compte mail invalides.', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.credentials.provider !== parsed.data.provider) {
      return send(c, { error: 'Le fournisseur des identifiants ne correspond pas au fournisseur choisi.' }, 400);
    }

    const account = await createMailAccount({
      guildId,
      provider: parsed.data.provider,
      fromEmail: parsed.data.fromEmail,
      displayName: parsed.data.displayName,
      credentials: parsed.data.credentials,
      createdById: c.var.dashboardUser.userId,
    });
    const webhookSecret = await revealMailWebhookSecret(account.id, guildId);
    void audit(c, 'MAIL_ACCOUNT_CREATE', `${account.provider} — ${account.fromEmail}`);
    return send(c, { account, webhookSecret }, 201);
  });

  router.patch(`${base}/accounts/:accountId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const accountId = c.req.param('accountId')!;
    const raw = await readBody(c);
    const parsed = updateAccountSchema.safeParse(raw);
    if (!parsed.success) {
      return send(c, { error: 'Paramètres de mise à jour invalides.', issues: parsed.error.issues }, 400);
    }

    const account = await updateMailAccount(accountId, guildId, parsed.data);
    if (!account) return send(c, { error: 'Compte mail introuvable.' }, 404);
    void audit(c, 'MAIL_ACCOUNT_UPDATE', `${account.fromEmail}`);
    return send(c, { account });
  });

  router.delete(`${base}/accounts/:accountId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const accountId = c.req.param('accountId')!;
    const ok = await deleteMailAccount(accountId, guildId);
    if (!ok) return send(c, { error: 'Compte mail introuvable.' }, 404);
    void audit(c, 'MAIL_ACCOUNT_DELETE', accountId);
    return send(c, { ok: true });
  });

  router.post(`${base}/accounts/:accountId/verify`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const accountId = c.req.param('accountId')!;
    const out = await verifyMailAccount(accountId, guildId);
    if (!out) return send(c, { error: 'Compte mail introuvable.' }, 404);
    return send(c, out);
  });

  router.get(`${base}/accounts/:accountId/webhook-secret`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const accountId = c.req.param('accountId')!;
    const secret = await revealMailWebhookSecret(accountId, guildId);
    if (!secret) return send(c, { error: 'Compte mail introuvable.' }, 404);
    return send(c, { secret });
  });

  router.post(`${base}/accounts/:accountId/rotate-secret`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const accountId = c.req.param('accountId')!;
    const secret = await rotateMailWebhookSecret(accountId, guildId);
    if (!secret) return send(c, { error: 'Compte mail introuvable.' }, 404);
    void audit(c, 'MAIL_WEBHOOK_ROTATE', accountId);
    return send(c, { secret });
  });

  // ── Fils & messages ───────────────────────────────────────────────────────

  router.get(`${base}/threads`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const accountId = c.req.query('accountId') || undefined;
    const rawStatus = c.req.query('status');
    const status =
      rawStatus === 'OPEN' || rawStatus === 'CLOSED' || rawStatus === 'ARCHIVED' ? rawStatus : undefined;
    const search = c.req.query('search')?.trim() || undefined;

    const threads = await listMailThreads(guildId, { accountId, status, search });
    return send(c, { threads });
  });

  router.get(`${base}/threads/:threadId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const threadId = c.req.param('threadId')!;
    const thread = await getMailThreadWithMessages(threadId, guildId);
    if (!thread) return send(c, { error: 'Fil introuvable.' }, 404);
    return send(c, { thread });
  });

  router.patch(`${base}/threads/:threadId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const threadId = c.req.param('threadId')!;
    const raw = await readBody(c);
    const parsed = threadStatusSchema.safeParse(raw);
    if (!parsed.success) {
      return send(c, { error: 'Statut invalide.' }, 400);
    }
    const thread = await updateMailThreadStatus(threadId, guildId, parsed.data.status);
    if (!thread) return send(c, { error: 'Fil introuvable.' }, 404);
    return send(c, { thread });
  });

  router.post(`${base}/send`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const raw = await readBody(c);
    const parsed = sendMailSchema.safeParse(raw);
    if (!parsed.success) {
      return send(c, { error: 'Données d’envoi invalides.', issues: parsed.error.issues }, 400);
    }
    if (!parsed.data.text?.trim() && !parsed.data.html?.trim()) {
      return send(c, { error: 'Le message doit contenir un corps texte ou HTML.' }, 400);
    }

    const result = await sendMail({
      guildId,
      accountId: parsed.data.accountId,
      threadId: parsed.data.threadId,
      to: parsed.data.to,
      cc: parsed.data.cc,
      subject: parsed.data.subject,
      text: parsed.data.text,
      html: parsed.data.html,
    });
    void audit(c, 'MAIL_SEND', `${parsed.data.to.join(', ')} — ${parsed.data.subject}`);
    return send(c, result, 201);
  });

  return router;
}
