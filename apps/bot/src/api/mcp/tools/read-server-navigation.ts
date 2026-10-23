/** Outils MCP - read server navigation (permission READ_STATS). */
import prisma from '../../../utils/db.js';
import { ChannelType } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, toolError } from '../toolkit.js';

export function registerReadServerNavigationTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_STATS')) {
    server.registerTool(
      'list_channels',
      {
        description:
          'Liste les salons du serveur (nom, type, ID). Pratique pour retrouver un salon par son nom plutôt que par ID.',
        inputSchema: {
          query: z.string().optional().describe('Filtre optionnel sur le nom du salon'),
          type: z.enum(['text', 'forum', 'voice', 'category', 'all']).default('all').describe('Type de salon à lister'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ query, type }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const kindOf = (c: { type: ChannelType; isTextBased: () => boolean; isVoiceBased: () => boolean }) =>
          c.type === ChannelType.GuildCategory
            ? 'category'
            : c.type === ChannelType.GuildForum
              ? 'forum'
              : c.isVoiceBased()
                ? 'voice'
                : c.isTextBased()
                  ? 'text'
                  : 'other';

        let channels = [...guild.channels.cache.values()];
        if (query) {
          const q = query.toLowerCase();
          channels = channels.filter((c) => c.name.toLowerCase().includes(q));
        }
        if (type !== 'all') channels = channels.filter((c) => kindOf(c) === type);

        return ok(
          channels
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => ({
              id: c.id,
              name: c.name,
              type: kindOf(c),
              parentId: c.parentId,
              ...(c.type === ChannelType.GuildForum
                ? { availableTags: c.availableTags.map((tag) => ({ id: tag.id, name: tag.name, moderated: tag.moderated, emoji: tag.emoji })) }
                : {}),
            }))
        );
      })
    );

    server.registerTool(
      'get_widget_subscriptions',
      {
        description: 'Liste les abonnements au widget Discord de profil staff pour ce serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        try {
          const subscriptions = await prisma.widgetSubscription.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok({ subscriptions, activeCount: subscriptions.filter((s) => s.enabled).length });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'list_roles',
      {
        description: 'Liste les rôles du serveur (nom, ID, couleur, position, mentionnable).',
        inputSchema: { query: z.string().optional().describe('Filtre optionnel sur le nom du rôle') },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ query }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        let roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
        if (query) {
          const q = query.toLowerCase();
          roles = roles.filter((r) => r.name.toLowerCase().includes(q));
        }

        return ok(
          roles
            .sort((a, b) => b.position - a.position)
            .map((r) => ({
              id: r.id,
              name: r.name,
              color: r.hexColor,
              position: r.position,
              mentionable: r.mentionable,
              memberCount: r.members.size,
            }))
        );
      })
    );

    server.registerTool(
      'get_server_info',
      {
        description: 'Informations générales du serveur Discord (nom, membres, salons, rôles, boosts).',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        return ok({
          id: guild.id,
          name: guild.name,
          description: guild.description,
          memberCount: guild.memberCount,
          channelCount: guild.channels.cache.size,
          roleCount: guild.roles.cache.size,
          ownerId: guild.ownerId,
          boostTier: guild.premiumTier,
          boostCount: guild.premiumSubscriptionCount ?? 0,
          iconUrl: guild.iconURL(),
          createdAt: guild.createdAt.toISOString(),
        });
      })
    );
  }
}
