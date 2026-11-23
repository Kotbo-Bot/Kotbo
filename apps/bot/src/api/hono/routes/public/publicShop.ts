/**
 * Boutique web publique personnalisable (/boutique/:guildId)
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { getShopSettings, listShopOffers } from '../../../../services/shop/shopService.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;

export function createPublicShopRouter(client: Client) {
  const router = new Hono();

  router.get('/api/public/shop/:guildId', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE_RE.test(guildId)) {
      return c.json({ error: 'Serveur invalide' }, 400);
    }

    const [guild, settings, offers, economy] = await Promise.all([
      prisma.guild.findUnique({ where: { id: guildId }, select: { id: true } }),
      getShopSettings(guildId),
      listShopOffers(guildId),
      prisma.economyConfig.findUnique({ where: { guildId }, select: { currencyName: true, currencyEmoji: true } }),
    ]);

    if (!guild) {
      return c.json({ error: 'Serveur introuvable' }, 404);
    }

    const discordGuild = client.guilds.cache.get(guildId);
    return c.json({
      guildId: guild.id,
      guildName: discordGuild?.name ?? 'Serveur Discord',
      iconUrl: discordGuild?.iconURL({ size: 128, extension: 'png' }) ?? null,
      enabled: settings.enabled && settings.webShopEnabled,
      branding: {
        title: settings.webShopTitle || `Boutique — ${discordGuild?.name ?? 'Serveur Discord'}`,
        description: settings.webShopDescription || '',
        accentColor: settings.webShopAccentColor || '#818cf8',
        bannerUrl: settings.webShopBannerUrl || null,
        customCss: settings.webShopCustomCss || '',
      },
      currency: {
        name: economy?.currencyName ?? 'KotboCoins',
        emoji: economy?.currencyEmoji ?? '🪙',
      },
      offers: !(settings.enabled && settings.webShopEnabled) ? [] : offers.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        kind: o.kind,
        price: o.price,
        durationDays: o.durationDays,
        stock: o.stock,
      })),
    });
  });

  return router;
}
