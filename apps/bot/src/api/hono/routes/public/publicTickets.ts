/**
 * Support & Tickets hors Discord :
 * - Formulaire web public (GET info, POST création)
 * - Suivi public par jeton (GET track, POST reply)
 * - E-mail entrant (POST inbound-email avec secret)
 */
import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { rateLimit } from '../../middleware/rateLimit.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;

// Routes sans authentification : une limite par IP évite le remplissage de la base.
const createLimiter = new Map<string, number[]>();
const replyLimiter = new Map<string, number[]>();
const trackLimiter = new Map<string, number[]>();
const inboundLimiter = new Map<string, number[]>();

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function generateTrackingToken(): string {
  return `tkt_${crypto.randomBytes(18).toString('hex')}`;
}

export function createPublicTicketsRouter(client: Client) {
  const router = new Hono();

  // Info publique du formulaire support d'un serveur
  router.get('/api/public/tickets/:guildId/info', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE_RE.test(guildId)) {
      return c.json({ error: 'Serveur invalide' }, 400);
    }

    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        id: true,
        ticketWebFormEnabled: true,
        ticketTypes: true,
        ticketEmbedTitle: true,
        ticketEmbedDesc: true,
      },
    });
    if (!guild) {
      return c.json({ error: 'Serveur introuvable' }, 404);
    }

    const discordGuild = client.guilds.cache.get(guildId);
    const types = Array.isArray(guild.ticketTypes)
      ? (guild.ticketTypes as Array<{ id?: string; label?: string; name?: string; description?: string; emoji?: string }>).map((t) => ({
          id: t.id ?? '',
          name: t.label ?? t.name ?? 'Support',
          description: t.description ?? '',
          emoji: t.emoji ?? '',
        }))
      : [];

    return c.json({
      guildId: guild.id,
      guildName: discordGuild?.name ?? 'Serveur Discord',
      iconUrl: discordGuild?.iconURL({ size: 128, extension: 'png' }) ?? null,
      enabled: guild.ticketWebFormEnabled,
      title: guild.ticketEmbedTitle || 'Ouvrir un ticket',
      description: guild.ticketEmbedDesc || '',
      ticketTypes: types,
    });
  });

  // Création d'un ticket depuis le formulaire web public
  router.post('/api/public/tickets/:guildId', rateLimit(createLimiter, 5, 10 * 60 * 1000), async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE_RE.test(guildId)) {
      return c.json({ error: 'Serveur invalide' }, 400);
    }

    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { id: true, ticketWebFormEnabled: true, ticketTypes: true },
    });
    if (!guild || !guild.ticketWebFormEnabled) {
      return c.json({ error: 'Le formulaire web de tickets est désactivé sur ce serveur.' }, 403);
    }

    const body = await c.req.json().catch(() => null) as {
      name?: string;
      email?: string;
      discordId?: string;
      subject?: string;
      description?: string;
      ticketTypeId?: string;
    } | null;

    const name = body?.name?.trim().slice(0, 80) ?? '';
    const email = body?.email?.trim().slice(0, 160) ?? '';
    const subject = body?.subject?.trim().slice(0, 200) ?? '';
    const description = body?.description?.trim().slice(0, 4000) ?? '';
    const discordId = body?.discordId && SNOWFLAKE_RE.test(body.discordId.trim()) ? body.discordId.trim() : null;

    if (!name || !subject || !description) {
      return c.json({ error: 'Nom, objet et description sont obligatoires.' }, 400);
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: 'Adresse e-mail invalide.' }, 400);
    }

    const types = Array.isArray(guild.ticketTypes)
      ? (guild.ticketTypes as Array<{ id?: string; label?: string; name?: string }>)
      : [];
    const matchedType = body?.ticketTypeId ? types.find((t) => t.id === body.ticketTypeId) : null;

    const trackingToken = generateTrackingToken();
    const now = new Date();
    const ticket = await prisma.ticket.create({
      data: {
        guildId,
        mode: 'WEB',
        source: 'WEB',
        // L'ID Discord saisi n'est pas vérifié : il ne peut pas désigner le propriétaire du ticket.
        userId: email ? `web:${email.toLowerCase()}` : `web:${trackingToken.slice(0, 14)}`,
        username: name,
        requesterEmail: email || null,
        webAccessToken: trackingToken,
        ticketTypeId: matchedType?.id ?? null,
        ticketTypeLabel: matchedType?.label ?? matchedType?.name ?? null,
        reason: subject,
        description: discordId ? `${description}

ID Discord déclaré (non vérifié) : ${discordId}` : description,
        status: 'OPEN',
        lastMemberMessageAt: now,
        webMessages: {
          create: {
            authorId: null,
            authorName: name,
            authorEmail: email || null,
            isStaff: false,
            source: 'WEB',
            content: description,
          },
        },
      },
    });

    return c.json({ ok: true, ticketId: ticket.id, trackingToken }, 201);
  });

  // Consultation publique d'un ticket via son jeton de suivi
  router.get('/api/public/tickets/track/:token', rateLimit(trackLimiter, 60, 5 * 60 * 1000), async (c) => {
    const token = c.req.param('token');
    if (!token || token.length < 12) {
      return c.json({ error: 'Jeton invalide' }, 400);
    }

    const ticket = await prisma.ticket.findUnique({
      where: { webAccessToken: token },
      include: {
        webMessages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) {
      return c.json({ error: 'Ticket introuvable' }, 404);
    }

    const discordGuild = client.guilds.cache.get(ticket.guildId);
    return c.json({
      ticket: {
        id: ticket.id,
        guildId: ticket.guildId,
        guildName: discordGuild?.name ?? 'Serveur Discord',
        username: ticket.username,
        reason: ticket.reason,
        description: ticket.description,
        status: ticket.status,
        source: ticket.source,
        createdAt: ticket.createdAt.toISOString(),
        closedAt: ticket.closedAt?.toISOString() ?? null,
        messages: ticket.webMessages.map((m) => ({
          id: m.id,
          authorName: m.authorName,
          isStaff: m.isStaff,
          source: m.source,
          content: m.content,
          createdAt: m.createdAt.toISOString(),
        })),
      },
    });
  });

  // Réponse publique sur un ticket via jeton de suivi
  router.post('/api/public/tickets/track/:token/reply', rateLimit(replyLimiter, 20, 10 * 60 * 1000), async (c) => {
    const token = c.req.param('token');
    const body = await c.req.json().catch(() => null) as { content?: string } | null;
    const content = body?.content?.trim().slice(0, 4000) ?? '';
    if (!content) {
      return c.json({ error: 'Le message ne peut pas être vide.' }, 400);
    }

    const ticket = await prisma.ticket.findUnique({
      where: { webAccessToken: token },
    });
    if (!ticket) {
      return c.json({ error: 'Ticket introuvable' }, 404);
    }

    const now = new Date();
    const msg = await prisma.ticketWebMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: ticket.userId.startsWith('web:') ? null : ticket.userId,
        authorName: ticket.username,
        authorEmail: ticket.requesterEmail,
        isStaff: false,
        source: 'WEB',
        content,
      },
    });

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        lastMemberMessageAt: now,
        ...(ticket.status === 'CLOSED' ? { status: 'OPEN', closedAt: null } : {}),
      },
    });

    return c.json({
      ok: true,
      message: {
        id: msg.id,
        authorName: msg.authorName,
        isStaff: false,
        source: msg.source,
        content: msg.content,
        createdAt: msg.createdAt.toISOString(),
      },
    }, 201);
  });

  // Webhook e-mail entrant (Mailgun / Resend / Postmark / relais SMTP HTTP)
  router.post('/api/public/tickets/:guildId/inbound-email', rateLimit(inboundLimiter, 120, 5 * 60 * 1000), async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE_RE.test(guildId)) {
      return c.json({ error: 'Serveur invalide' }, 400);
    }

    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        id: true,
        ticketInboundEmailEnabled: true,
        ticketInboundEmailSecret: true,
      },
    });
    if (!guild || !guild.ticketInboundEmailEnabled) {
      return c.json({ error: 'Support e-mail entrant désactivé.' }, 403);
    }

    const providedSecret = c.req.header('x-inbound-secret') ?? c.req.query('secret') ?? '';
    // Sans secret configuré, l'endpoint reste fermé : il ne doit jamais être ouvert à tous.
    if (!guild.ticketInboundEmailSecret || !safeEqual(providedSecret, guild.ticketInboundEmailSecret)) {
      return c.json({ error: 'Secret invalide.' }, 401);
    }

    const body = await c.req.json().catch(() => null) as {
      from?: string;
      fromName?: string;
      subject?: string;
      text?: string;
      bodyPlain?: string;
    } | null;

    const rawFrom = (body?.from ?? '').trim();
    const emailMatch = rawFrom.match(/<([^>]+)>/);
    const fromEmail = (emailMatch?.[1] ?? rawFrom).toLowerCase().slice(0, 160);
    const fromName = (body?.fromName ?? (emailMatch ? rawFrom.replace(/<[^>]+>/, '').trim() : '') ?? fromEmail).slice(0, 80) || fromEmail;
    const subject = (body?.subject ?? 'Demande par e-mail').trim().slice(0, 200);
    const content = (body?.text ?? body?.bodyPlain ?? '').trim().slice(0, 4000);

    if (!fromEmail || !content) {
      return c.json({ error: 'Expéditeur et contenu requis.' }, 400);
    }

    const idMatch = subject.match(/\[#([a-z0-9]{10,32})\]/i);
    const existing = idMatch
      ? await prisma.ticket.findFirst({ where: { id: idMatch[1], guildId } })
      : await prisma.ticket.findFirst({
          where: { guildId, requesterEmail: fromEmail, status: { in: ['OPEN', 'ARCHIVED'] } },
          orderBy: { createdAt: 'desc' },
        });

    const now = new Date();
    if (existing) {
      await prisma.ticketWebMessage.create({
        data: {
          ticketId: existing.id,
          authorName: fromName,
          authorEmail: fromEmail,
          isStaff: false,
          source: 'EMAIL',
          content,
        },
      });
      await prisma.ticket.update({
        where: { id: existing.id },
        data: {
          lastMemberMessageAt: now,
          ...(existing.status === 'CLOSED' ? { status: 'OPEN', closedAt: null } : {}),
        },
      });
      logger.info('TicketsInbound', `Appended email reply to ticket ${existing.id} for guild ${guildId}`);
      return c.json({ ok: true, ticketId: existing.id, appended: true });
    }

    const trackingToken = generateTrackingToken();
    const created = await prisma.ticket.create({
      data: {
        guildId,
        mode: 'EMAIL',
        source: 'EMAIL',
        userId: `email:${fromEmail}`,
        username: fromName,
        requesterEmail: fromEmail,
        webAccessToken: trackingToken,
        reason: subject,
        description: content,
        status: 'OPEN',
        lastMemberMessageAt: now,
        webMessages: {
          create: {
            authorName: fromName,
            authorEmail: fromEmail,
            isStaff: false,
            source: 'EMAIL',
            content,
          },
        },
      },
    });

    logger.info('TicketsInbound', `Created email ticket ${created.id} for guild ${guildId}`);
    return c.json({ ok: true, ticketId: created.id, trackingToken, appended: false }, 201);
  });

  return router;
}
