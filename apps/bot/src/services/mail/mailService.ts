import type { MailAccountStatus, MailProvider, MailThreadStatus, Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { getMailAdapter } from './adapters/index.js';
import {
  generateMailWebhookSecret,
  openMailCredentials,
  openMailSecret,
  sealMailCredentials,
  sealMailSecret,
} from './crypto.js';
import {
  generateRfc5322MessageId,
  type InboundWebhookResult,
  type MailCredentials,
  type ParsedInboundEmail,
  type VerifyCredentialsResult,
} from './types.js';

const ACCOUNT_PUBLIC_SELECT = {
  id: true,
  guildId: true,
  provider: true,
  fromEmail: true,
  displayName: true,
  status: true,
  lastError: true,
  verifiedAt: true,
  enabled: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateMailAccountInput {
  guildId: string;
  provider: MailProvider;
  fromEmail: string;
  displayName?: string | null;
  credentials: MailCredentials;
  createdById: string;
}

export interface SendMailInputDto {
  guildId: string;
  accountId: string;
  threadId?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
}

function makeSnippet(text: string | null | undefined, html: string | null | undefined): string | null {
  const source = text?.trim() || html?.replace(/<[^>]+>/g, ' ').trim() || '';
  if (!source) return null;
  return source.replace(/\s+/g, ' ').slice(0, 180);
}

function normalizeSubject(subject: string): string {
  return subject.replace(/^(re|fwd|fw|tr)\s*:\s*/gi, '').trim() || '(Sans objet)';
}

function mergeParticipants(existing: string[], additions: string[]): string[] {
  const set = new Set(existing.map((e) => e.toLowerCase()));
  for (const addr of additions) {
    const clean = addr.trim().toLowerCase();
    if (clean) set.add(clean);
  }
  return [...set];
}

export async function listMailAccounts(guildId: string) {
  return prisma.mailAccount.findMany({
    where: { guildId },
    orderBy: { createdAt: 'asc' },
    select: ACCOUNT_PUBLIC_SELECT,
  });
}

export async function createMailAccount(input: CreateMailAccountInput) {
  const webhookSecret = generateMailWebhookSecret();
  return prisma.mailAccount.create({
    data: {
      guildId: input.guildId,
      provider: input.provider,
      fromEmail: input.fromEmail.trim().toLowerCase(),
      displayName: input.displayName?.trim() || null,
      encryptedCredentials: sealMailCredentials(input.credentials),
      webhookSecret: sealMailSecret(webhookSecret),
      status: 'PENDING',
      createdById: input.createdById,
    },
    select: ACCOUNT_PUBLIC_SELECT,
  });
}

export async function updateMailAccount(
  id: string,
  guildId: string,
  patch: {
    fromEmail?: string;
    displayName?: string | null;
    enabled?: boolean;
    credentials?: MailCredentials;
  },
) {
  const existing = await prisma.mailAccount.findFirst({ where: { id, guildId } });
  if (!existing) return null;

  const data: Prisma.MailAccountUpdateInput = {};
  if (patch.fromEmail !== undefined) data.fromEmail = patch.fromEmail.trim().toLowerCase();
  if (patch.displayName !== undefined) data.displayName = patch.displayName?.trim() || null;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.credentials !== undefined) {
    data.encryptedCredentials = sealMailCredentials(patch.credentials);
    data.status = 'PENDING';
    data.lastError = null;
  }

  return prisma.mailAccount.update({
    where: { id: existing.id },
    data,
    select: ACCOUNT_PUBLIC_SELECT,
  });
}

export async function deleteMailAccount(id: string, guildId: string): Promise<boolean> {
  const existing = await prisma.mailAccount.findFirst({ where: { id, guildId }, select: { id: true } });
  if (!existing) return false;
  await prisma.mailAccount.delete({ where: { id: existing.id } });
  return true;
}

export async function revealMailWebhookSecret(id: string, guildId: string): Promise<string | null> {
  const account = await prisma.mailAccount.findFirst({
    where: { id, guildId },
    select: { webhookSecret: true },
  });
  if (!account) return null;
  return openMailSecret(account.webhookSecret);
}

export async function rotateMailWebhookSecret(id: string, guildId: string): Promise<string | null> {
  const existing = await prisma.mailAccount.findFirst({ where: { id, guildId }, select: { id: true } });
  if (!existing) return null;
  const nextSecret = generateMailWebhookSecret();
  await prisma.mailAccount.update({
    where: { id: existing.id },
    data: { webhookSecret: sealMailSecret(nextSecret) },
  });
  return nextSecret;
}

export async function verifyMailAccount(
  id: string,
  guildId: string,
): Promise<{ account: NonNullable<Awaited<ReturnType<typeof updateMailAccount>>>; result: VerifyCredentialsResult } | null> {
  const account = await prisma.mailAccount.findFirst({ where: { id, guildId } });
  if (!account) return null;

  const credentials = openMailCredentials<MailCredentials>(account.encryptedCredentials);
  if (!credentials) {
    const updated = await prisma.mailAccount.update({
      where: { id: account.id },
      data: { status: 'ERROR', lastError: 'Impossible de déchiffrer les identifiants.' },
      select: ACCOUNT_PUBLIC_SELECT,
    });
    return { account: updated, result: { ok: false, error: 'Impossible de déchiffrer les identifiants.' } };
  }

  const adapter = getMailAdapter(account.provider);
  const result = await adapter.verifyCredentials(credentials, account.fromEmail);

  const status: MailAccountStatus = result.ok ? 'VERIFIED' : 'ERROR';
  const updated = await prisma.mailAccount.update({
    where: { id: account.id },
    data: {
      status,
      lastError: result.ok ? null : result.error ?? 'Vérification échouée',
      verifiedAt: result.ok ? new Date() : account.verifiedAt,
    },
    select: ACCOUNT_PUBLIC_SELECT,
  });

  return { account: updated, result };
}

export async function listMailThreads(
  guildId: string,
  filters: { accountId?: string; status?: MailThreadStatus; search?: string } = {},
) {
  return prisma.mailThread.findMany({
    where: {
      guildId,
      ...(filters.accountId ? { accountId: filters.accountId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.search
        ? {
            OR: [
              { subject: { contains: filters.search, mode: 'insensitive' } },
              { lastMessageSnippet: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { lastMessageAt: 'desc' },
    take: 50,
    include: {
      account: { select: { id: true, fromEmail: true, displayName: true, provider: true } },
    },
  });
}

export async function getMailThreadWithMessages(threadId: string, guildId: string) {
  return prisma.mailThread.findFirst({
    where: { id: threadId, guildId },
    include: {
      account: { select: { id: true, fromEmail: true, displayName: true, provider: true } },
      messages: { orderBy: { receivedAt: 'asc' } },
    },
  });
}

export async function updateMailThreadStatus(threadId: string, guildId: string, status: MailThreadStatus) {
  const existing = await prisma.mailThread.findFirst({ where: { id: threadId, guildId }, select: { id: true } });
  if (!existing) return null;
  return prisma.mailThread.update({
    where: { id: existing.id },
    data: { status },
  });
}

export async function sendMail(input: SendMailInputDto) {
  const account = await prisma.mailAccount.findFirst({
    where: { id: input.accountId, guildId: input.guildId },
  });
  if (!account) throw new Error('Compte mail introuvable.');
  if (!account.enabled) throw new Error('Ce compte mail est désactivé.');

  const credentials = openMailCredentials<MailCredentials>(account.encryptedCredentials);
  if (!credentials) throw new Error('Identifiants mail illisibles.');

  const thread = input.threadId
    ? await prisma.mailThread.findFirst({
        where: { id: input.threadId, guildId: input.guildId, accountId: account.id },
        include: { messages: { orderBy: { receivedAt: 'asc' }, select: { messageId: true } } },
      })
    : null;

  const existingMessageIds = (thread?.messages ?? [])
    .map((m) => m.messageId)
    .filter((id): id is string => Boolean(id));
  const inReplyTo = existingMessageIds.at(-1);
  const references = existingMessageIds.slice(-10);

  const messageId = generateRfc5322MessageId(account.fromEmail);
  const adapter = getMailAdapter(account.provider);
  const sent = await adapter.sendEmail(credentials, {
    fromEmail: account.fromEmail,
    displayName: account.displayName,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    messageId,
    inReplyTo,
    references,
  });

  const now = new Date();
  const snippet = makeSnippet(input.text, input.html);

  if (!thread) {
    const createdThread = await prisma.mailThread.create({
      data: {
        accountId: account.id,
        guildId: account.guildId,
        subject: input.subject.trim() || '(Sans objet)',
        status: 'OPEN',
        participants: mergeParticipants([account.fromEmail], [...input.to, ...(input.cc ?? [])]),
        lastMessageAt: now,
        lastMessageSnippet: snippet,
        messageCount: 1,
        messages: {
          create: {
            accountId: account.id,
            messageId: sent.messageId,
            inReplyTo: inReplyTo ?? null,
            references,
            direction: 'OUTBOUND',
            fromEmail: account.fromEmail,
            fromName: account.displayName,
            toEmails: input.to,
            ccEmails: input.cc ?? [],
            subject: input.subject.trim() || '(Sans objet)',
            textBody: input.text ?? null,
            htmlBody: input.html ?? null,
            providerMessageId: sent.providerMessageId,
            receivedAt: now,
          },
        },
      },
      include: { messages: true },
    });
    return { thread: createdThread, message: createdThread.messages[0] };
  }

  const [message, updatedThread] = await prisma.$transaction([
    prisma.mailMessage.create({
      data: {
        threadId: thread.id,
        accountId: account.id,
        messageId: sent.messageId,
        inReplyTo: inReplyTo ?? null,
        references,
        direction: 'OUTBOUND',
        fromEmail: account.fromEmail,
        fromName: account.displayName,
        toEmails: input.to,
        ccEmails: input.cc ?? [],
        subject: input.subject.trim() || thread.subject,
        textBody: input.text ?? null,
        htmlBody: input.html ?? null,
        providerMessageId: sent.providerMessageId,
        receivedAt: now,
      },
    }),
    prisma.mailThread.update({
      where: { id: thread.id },
      data: {
        status: 'OPEN',
        participants: mergeParticipants(thread.participants, [...input.to, ...(input.cc ?? [])]),
        lastMessageAt: now,
        lastMessageSnippet: snippet ?? thread.lastMessageSnippet,
        messageCount: { increment: 1 },
      },
    }),
  ]);

  return { thread: updatedThread, message };
}

async function resolveInboundThread(accountId: string, guildId: string, email: ParsedInboundEmail) {
  const lookupIds = [email.inReplyTo, ...email.references].filter((v): v is string => Boolean(v));
  if (lookupIds.length > 0) {
    const matched = await prisma.mailMessage.findFirst({
      where: { accountId, messageId: { in: lookupIds } },
      select: { threadId: true },
      orderBy: { receivedAt: 'desc' },
    });
    if (matched) {
      return prisma.mailThread.findUnique({ where: { id: matched.threadId } });
    }
  }

  const normalized = normalizeSubject(email.subject);
  return prisma.mailThread.findFirst({
    where: {
      accountId,
      guildId,
      subject: normalized,
      participants: { has: email.fromEmail.toLowerCase() },
    },
    orderBy: { lastMessageAt: 'desc' },
  });
}

export async function processInboundMailWebhook(
  accountId: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  querySecret?: string,
): Promise<{ status: 'stored' | 'duplicate' | 'subscription_confirmation' | 'ignored'; result: InboundWebhookResult }> {
  const account = await prisma.mailAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.enabled) {
    throw new Error('Compte mail introuvable ou désactivé.');
  }

  const credentials = openMailCredentials<MailCredentials>(account.encryptedCredentials);
  const webhookSecret = openMailSecret(account.webhookSecret);
  if (!credentials || !webhookSecret) {
    throw new Error('Configuration chiffrée du compte mail illisible.');
  }

  const adapter = getMailAdapter(account.provider);
  const parsed = await adapter.parseInboundWebhook({
    rawBody,
    headers,
    querySecret,
    webhookSecret,
    credentials,
  });

  if (parsed.kind === 'subscription_confirmation') {
    return { status: 'subscription_confirmation', result: parsed };
  }
  if (parsed.kind === 'ignored') {
    return { status: 'ignored', result: parsed };
  }

  const email = parsed.email;

  if (email.messageId) {
    const existing = await prisma.mailMessage.findFirst({
      where: { accountId: account.id, messageId: email.messageId },
      select: { id: true },
    });
    if (existing) {
      return { status: 'duplicate', result: parsed };
    }
  }

  const thread = await resolveInboundThread(account.id, account.guildId, email);
  const snippet = makeSnippet(email.textBody, email.htmlBody);
  const participants = mergeParticipants(thread?.participants ?? [], [
    email.fromEmail,
    ...email.toEmails,
    ...email.ccEmails,
  ]);

  if (!thread) {
    await prisma.mailThread.create({
      data: {
        accountId: account.id,
        guildId: account.guildId,
        subject: normalizeSubject(email.subject),
        status: 'OPEN',
        participants,
        lastMessageAt: email.receivedAt,
        lastMessageSnippet: snippet,
        messageCount: 1,
        messages: {
          create: {
            accountId: account.id,
            messageId: email.messageId,
            inReplyTo: email.inReplyTo,
            references: email.references,
            direction: 'INBOUND',
            fromEmail: email.fromEmail,
            fromName: email.fromName,
            toEmails: email.toEmails,
            ccEmails: email.ccEmails,
            subject: email.subject,
            textBody: email.textBody,
            htmlBody: email.htmlBody,
            attachments: email.attachments as unknown as Prisma.InputJsonValue,
            providerMessageId: email.providerMessageId,
            receivedAt: email.receivedAt,
          },
        },
      },
    });
  } else {
    await prisma.$transaction([
      prisma.mailMessage.create({
        data: {
          threadId: thread.id,
          accountId: account.id,
          messageId: email.messageId,
          inReplyTo: email.inReplyTo,
          references: email.references,
          direction: 'INBOUND',
          fromEmail: email.fromEmail,
          fromName: email.fromName,
          toEmails: email.toEmails,
          ccEmails: email.ccEmails,
          subject: email.subject,
          textBody: email.textBody,
          htmlBody: email.htmlBody,
          attachments: email.attachments as unknown as Prisma.InputJsonValue,
          providerMessageId: email.providerMessageId,
          receivedAt: email.receivedAt,
        },
      }),
      prisma.mailThread.update({
        where: { id: thread.id },
        data: {
          status: 'OPEN',
          participants,
          lastMessageAt: email.receivedAt,
          lastMessageSnippet: snippet ?? thread.lastMessageSnippet,
          messageCount: { increment: 1 },
        },
      }),
    ]);
  }

  return { status: 'stored', result: parsed };
}
