import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  decideShopOrder,
  deleteShopOffer,
  deleteShopPromoCode,
  getShopSettings,
  listShopOffers,
  listShopOrders,
  listShopPromoCodes,
  reorderShopOffers,
  saveShopOffer,
  saveShopPromoCode,
  saveShopSettings,
  ShopError,
} from '../../../services/shop/shopService.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveDashboardAccess, resolveMemberFeatureAccess } from '../../shared.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { recordAdminAudit } from '../../../services/system/adminAuditService.js';

// ============================================================================
// BOUTIQUE DU SERVEUR (`/boutique` sur Discord)
//
// Offres, codes promo, commandes à valider et réglages, depuis la page
// Économie du dashboard. Droits : gérer le serveur, ou « configurer » la
// section Économie. Les écritures d'un admin global Kotbo sont journalisées.
// ============================================================================

const SNOWFLAKE = /^\d{17,20}$/;
const CUID = /^[a-z0-9]{20,32}$/;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function fail(c: Context, err: unknown) {
  if (err instanceof ShopError) return c.json({ error: err.code, detail: null }, err.status as 400);
  logger.error('ShopAdmin', 'Erreur non gérée :', err);
  return c.json({ error: 'internal' }, 500);
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createShopAdminRouter(client: Client): OpenAPIHono {
  const app = new OpenAPIHono();

  app.use('/api/shop-admin/:guildId', requireAuth);
  app.use('/api/shop-admin/:guildId/*', requireAuth);
  const gate = async (c: Context, next: () => Promise<void>) => {
    const guildId = c.req.param('guildId') ?? '';
    if (!SNOWFLAKE.test(guildId)) return c.json({ error: 'invalid_guild' }, 400);
    const userId = c.var.auth.userId;
    const access = await resolveDashboardAccess(client, guildId, userId);
    if (!access.canViewDashboard) return c.json({ error: 'forbidden' }, 403);
    const features = access.canManageSettings ? {} : await resolveMemberFeatureAccess(client, guildId, access, userId);
    if (!access.canManageSettings && !features.economy?.canConfigure) return c.json({ error: 'forbidden' }, 403);
    if (access.viaGlobalAdmin && !READ_METHODS.has(c.req.method)) {
      void recordAdminAudit({
        actorId: userId,
        actorName: c.var.auth.username ?? null,
        action: 'dashboard.global_admin_write',
        targetType: 'guild',
        targetId: guildId,
        summary: `${c.req.method} ${c.req.path} sur ${client.guilds.cache.get(guildId)?.name ?? guildId}`,
        metadata: { method: c.req.method, route: c.req.path },
      });
    }
    await next();
  };
  app.use('/api/shop-admin/:guildId', gate);
  app.use('/api/shop-admin/:guildId/*', gate);

  app.get('/api/shop-admin/:guildId', async (c) => {
    const guildId = c.req.param('guildId');
    const guild = client.guilds.cache.get(guildId);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [settings, offers, codes, pending, recent, sales, items, economy] = await Promise.all([
      getShopSettings(guildId),
      listShopOffers(guildId, { includeDisabled: true }),
      listShopPromoCodes(guildId),
      listShopOrders(guildId, { status: 'PENDING', limit: 100 }),
      listShopOrders(guildId, { limit: 50 }),
      prisma.shopOrder.groupBy({ by: ['offerId'], where: { guildId, status: 'COMPLETED', createdAt: { gte: since } }, _count: { _all: true }, _sum: { price: true } }),
      prisma.rpgItem.findMany({ where: { OR: [{ guildId }, { guildId: null }] }, select: { id: true, name: true, emoji: true, type: true }, orderBy: { name: 'asc' }, take: 500 }),
      prisma.economyConfig.findUnique({ where: { guildId }, select: { currencyName: true, currencyEmoji: true } }),
    ]);
    const salesBy = new Map(sales.map((s) => [s.offerId, { count: s._count._all, revenue: s._sum.price ?? 0 }]));
    const people = [...new Set([...pending, ...recent].flatMap((o) => [o.buyerId, o.recipientId]))];
    const identities = await getMemberIdentities(client, guildId, people);
    const withNames = (order: (typeof recent)[number]) => ({
      ...order,
      buyerName: identities.get(order.buyerId)?.displayName ?? order.buyerId,
      recipientName: identities.get(order.recipientId)?.displayName ?? order.recipientId,
    });
    const roles = guild
      ? [...guild.roles.cache.values()]
          .filter((r) => r.id !== guild.id && !r.managed)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, assignable: r.editable }))
      : [];
    const me = guild?.members.me ?? null;
    const channels = guild
      ? [...guild.channels.cache.values()]
          .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
          .filter((ch) => Boolean(me && ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)))
          .sort((a, b) => ('rawPosition' in a && 'rawPosition' in b ? a.rawPosition - b.rawPosition : 0))
          .map((ch) => ({ id: ch.id, name: ch.name }))
      : [];
    return c.json({
      settings,
      channels,
      currency: { name: economy?.currencyName ?? 'KotboCoins', emoji: economy?.currencyEmoji ?? '' },
      offers: offers.map((offer) => ({ ...offer, sales30d: salesBy.get(offer.id) ?? { count: 0, revenue: 0 } })),
      codes,
      pending: pending.map(withNames),
      recent: recent.map(withNames),
      items,
      roles,
    });
  });

  app.put('/api/shop-admin/:guildId/settings', async (c) => {
    try {
      return c.json({ settings: await saveShopSettings(c.req.param('guildId'), await body(c)) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/shop-admin/:guildId/offers', async (c) => {
    try {
      const offer = await saveShopOffer(client, c.req.param('guildId'), null, await body(c));
      return c.json({ id: offer.id }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/shop-admin/:guildId/offers/reorder', async (c) => {
    await reorderShopOffers(c.req.param('guildId'), (await body(c)).ids);
    return c.json({ ok: true });
  });

  app.patch('/api/shop-admin/:guildId/offers/:offerId', async (c) => {
    const offerId = c.req.param('offerId');
    if (!CUID.test(offerId)) return c.json({ error: 'offer_missing' }, 404);
    try {
      await saveShopOffer(client, c.req.param('guildId'), offerId, await body(c));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/shop-admin/:guildId/offers/:offerId', async (c) => {
    const result = await deleteShopOffer(c.req.param('guildId'), c.req.param('offerId'));
    return c.json({ ok: true, result });
  });

  app.post('/api/shop-admin/:guildId/codes', async (c) => {
    try {
      const code = await saveShopPromoCode(c.req.param('guildId'), null, await body(c));
      return c.json({ id: code.id }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.patch('/api/shop-admin/:guildId/codes/:codeId', async (c) => {
    const codeId = c.req.param('codeId');
    if (!CUID.test(codeId)) return c.json({ error: 'invalid_code' }, 404);
    try {
      await saveShopPromoCode(c.req.param('guildId'), codeId, await body(c));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/shop-admin/:guildId/codes/:codeId', async (c) => {
    await deleteShopPromoCode(c.req.param('guildId'), c.req.param('codeId'));
    return c.json({ ok: true });
  });

  app.post('/api/shop-admin/:guildId/orders/:orderId/decide', async (c) => {
    const orderId = c.req.param('orderId');
    if (!CUID.test(orderId)) return c.json({ error: 'order_missing' }, 404);
    const input = await body(c);
    try {
      const order = await decideShopOrder(client, c.req.param('guildId'), orderId, c.var.auth.userId, input.approve === true, input.reason);
      return c.json({ ok: true, status: order.status });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
