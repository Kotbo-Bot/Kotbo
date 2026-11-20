import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { resolveMemberFeatureAccess } from '../../shared.js';
import { getMarketplaceDashboardData } from '../../../services/economy/marketplaceService.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

export function createMarketplaceRouter(client: Client) {
  const router = new Hono();

  router.get('/api/dashboard/guilds/:guildId/marketplace', ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');

    // La marketplace est une page de la section Economie du dashboard : elle suit
    // le meme droit, sinon interdire "economy" laisserait ses donnees accessibles.
    const featureAccess = await resolveMemberFeatureAccess(client, guildId, c.var.effectiveAccess, c.var.dashboardUser.userId);
    if (!featureAccess.economy?.canView) {
      return send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès à la marketplace.' }, 403);
    }

    try {
      const data = await getMarketplaceDashboardData(guildId);

      // Pseudo et avatar des vendeurs, acheteurs et enchérisseurs : la page n'affichait que
      // leurs identifiants Discord, illisibles pour qui gère le marché.
      const userIds = [
        ...data.activeListings.flatMap((listing) => [listing.sellerId, listing.bidderId]),
        ...data.recentTransactions.flatMap((tx) => [tx.sellerId, tx.buyerId]),
      ].filter((id): id is string => Boolean(id));
      const identities = await getMemberIdentities(client, guildId, userIds).catch(() => new Map());
      const members = Object.fromEntries(
        [...identities].map(([id, identity]) => [id, { displayName: identity.displayName, avatarUrl: identity.avatarUrl }]),
      );

      return send(c, { ...data, members });
    } catch (err) {
      logger.error('MarketplaceAPI', 'Error fetching marketplace data:', err);
      return fail(c, err, 'Erreur lors de la récupération des données', 'MarketplaceAPI');
    }
  });

  return router;
}
