import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  MailCryptoUnavailableError,
  openMailCredentials,
  openMailSecret,
  sealMailCredentials,
  sealMailSecret,
  verifyTimingSafeEqual,
} from '../../services/mail/crypto.js';
import { AwsSesAdapter } from '../../services/mail/adapters/awsSes.js';
import { ResendAdapter } from '../../services/mail/adapters/resend.js';
import { SmtpAdapter } from '../../services/mail/adapters/smtp.js';

describe('Mail crypto (AES-256-GCM)', () => {
  const prevMailKey = process.env.MAIL_ENCRYPTION_KEY;
  const prevCustomKey = process.env.CUSTOM_BOT_ENCRYPTION_KEY;
  const prevJwt = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.MAIL_ENCRYPTION_KEY = 'test-mail-encryption-key-32bytes!';
  });

  afterEach(() => {
    if (prevMailKey === undefined) delete process.env.MAIL_ENCRYPTION_KEY;
    else process.env.MAIL_ENCRYPTION_KEY = prevMailKey;
    if (prevCustomKey === undefined) delete process.env.CUSTOM_BOT_ENCRYPTION_KEY;
    else process.env.CUSTOM_BOT_ENCRYPTION_KEY = prevCustomKey;
    if (prevJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwt;
  });

  it('chiffre et déchiffre un secret et des identifiants JSON', () => {
    const sealed = sealMailSecret('mwh_secret_123');
    expect(sealed.startsWith('mail:v1:')).toBe(true);
    expect(openMailSecret(sealed)).toBe('mwh_secret_123');

    const creds = { provider: 'RESEND' as const, apiKey: 're_live_abc' };
    const sealedCreds = sealMailCredentials(creds);
    expect(sealedCreds).not.toContain('re_live_abc');
    expect(openMailCredentials<typeof creds>(sealedCreds)).toEqual(creds);
  });

  it('retourne null si la charge utile chiffrée est altérée', () => {
    const sealed = sealMailSecret('secret');
    const tampered = `${sealed.slice(0, -2)}xx`;
    expect(openMailSecret(tampered)).toBeNull();
  });

  it('lève MailCryptoUnavailableError sans clé configurée', () => {
    delete process.env.MAIL_ENCRYPTION_KEY;
    delete process.env.CUSTOM_BOT_ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;
    expect(() => sealMailSecret('secret')).toThrow(MailCryptoUnavailableError);
  });

  it('compare deux chaînes en temps constant', () => {
    expect(verifyTimingSafeEqual('abc', 'abc')).toBe(true);
    expect(verifyTimingSafeEqual('abc', 'abd')).toBe(false);
    expect(verifyTimingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Mail provider inbound webhook parsers', () => {
  it('AwsSesAdapter parse une confirmation SNS et une notification entrante', async () => {
    const adapter = new AwsSesAdapter();
    const webhookSecret = 'mwh_aws_secret';
    const credentials = {
      provider: 'AWS_SES' as const,
      region: 'eu-west-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret',
    };

    const confirm = await adapter.parseInboundWebhook({
      rawBody: JSON.stringify({
        Type: 'SubscriptionConfirmation',
        SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription',
      }),
      headers: { 'x-kotbo-webhook-secret': webhookSecret },
      webhookSecret,
      credentials,
    });
    expect(confirm).toEqual({
      kind: 'subscription_confirmation',
      subscribeUrl: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription',
    });

    const notif = await adapter.parseInboundWebhook({
      rawBody: JSON.stringify({
        Type: 'Notification',
        Message: JSON.stringify({
          mail: {
            messageId: 'ses-123',
            timestamp: '2026-11-22T12:00:00.000Z',
            commonHeaders: {
              from: ['"Alice" <alice@exemple.fr>'],
              to: ['support@kotbo.fr'],
              subject: 'Re: Question facturation',
              messageId: '<msg-2@exemple.fr>',
            },
            headers: [
              { name: 'In-Reply-To', value: '<msg-1@kotbo.fr>' },
              { name: 'References', value: '<msg-0@kotbo.fr> <msg-1@kotbo.fr>' },
            ],
          },
          text: 'Bonjour, voici ma réponse.',
        }),
      }),
      headers: {},
      querySecret: webhookSecret,
      webhookSecret,
      credentials,
    });

    expect(notif.kind).toBe('message');
    if (notif.kind === 'message') {
      expect(notif.email.fromEmail).toBe('alice@exemple.fr');
      expect(notif.email.fromName).toBe('Alice');
      expect(notif.email.inReplyTo).toBe('<msg-1@kotbo.fr>');
      expect(notif.email.references).toEqual(['<msg-0@kotbo.fr>', '<msg-1@kotbo.fr>']);
      expect(notif.email.textBody).toBe('Bonjour, voici ma réponse.');
    }
  });

  it('ResendAdapter vérifie la signature Svix et parse email.received', async () => {
    const adapter = new ResendAdapter();
    const rawSigningKey = Buffer.from('super-svix-signing-key').toString('base64');
    const signingSecret = `whsec_${rawSigningKey}`;
    const rawBody = JSON.stringify({
      type: 'email.received',
      created_at: '2026-11-22T12:00:00.000Z',
      data: {
        email_id: 're_email_1',
        from: 'Bob <bob@exemple.fr>',
        to: ['contact@kotbo.fr'],
        subject: 'Demande de partenariat',
        text: 'Salut Kotbo !',
        headers: { 'Message-ID': '<bob-1@exemple.fr>' },
      },
    });
    const svixId = 'msg_123';
    const svixTimestamp = '1700000000';
    const sig = crypto
      .createHmac('sha256', Buffer.from(rawSigningKey, 'base64'))
      .update(`${svixId}.${svixTimestamp}.${rawBody}`, 'utf8')
      .digest('base64');

    const res = await adapter.parseInboundWebhook({
      rawBody,
      headers: {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${sig}`,
      },
      webhookSecret: 'mwh_fallback',
      credentials: { provider: 'RESEND', apiKey: 're_123', webhookSigningSecret: signingSecret },
    });

    expect(res.kind).toBe('message');
    if (res.kind === 'message') {
      expect(res.email.fromEmail).toBe('bob@exemple.fr');
      expect(res.email.messageId).toBe('<bob-1@exemple.fr>');
      expect(res.email.providerMessageId).toBe('re_email_1');
    }
  });

  it('SmtpAdapter rejette un secret invalide', async () => {
    const adapter = new SmtpAdapter();
    await expect(
      adapter.parseInboundWebhook({
        rawBody: '{}',
        headers: { 'x-kotbo-webhook-secret': 'wrong' },
        webhookSecret: 'expected',
        credentials: {
          provider: 'SMTP_IMAP',
          smtpHost: 'smtp.exemple.fr',
          smtpPort: 587,
          smtpSecure: false,
          smtpUser: 'user',
          smtpPass: 'pass',
        },
      }),
    ).rejects.toThrow();
  });
});
