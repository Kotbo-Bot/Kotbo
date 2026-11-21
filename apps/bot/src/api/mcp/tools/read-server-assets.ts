/** Outils MCP - read server assets (permission READ_STATS). */
import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, SNOWFLAKE, err, ok, resolveChannel, toolError } from '../toolkit.js';

export function registerReadServerAssetsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, toolMeta } = ctx;

  // ── READ_STATS - Permissions, invitations, emojis, stickers, webhooks, réglages ──
  if (shouldRegister('READ_STATS')) {

    server.registerTool(
      'get_role_permissions',
      {
        description: 'Retourne la liste des permissions globales d\'un rôle. Requiert READ_STATS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ role }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const roleId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = roleId
          ? guild.roles.cache.get(roleId)
          : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

        if (!discordRole) return err(`Rôle « ${role} » introuvable`);

        const permNames = Object.entries(PermissionFlagsBits)
          .filter(([, bit]) => discordRole.permissions.has(bit))
          .map(([name]) => name);

        return ok({
          roleId: discordRole.id,
          name: discordRole.name,
          bitfield: discordRole.permissions.bitfield.toString(),
          permissions: permNames,
        });
      })
    );

    server.registerTool(
      'get_invites',
      {
        description: 'Liste les invitations actives du serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const invites = await guild.invites.fetch();
          return ok(
            invites.map((inv) => ({
              code: inv.code,
              url: inv.url,
              channelId: inv.channel?.id ?? null,
              channelName: inv.channel?.name ?? null,
              inviterId: inv.inviter?.id ?? null,
              inviterTag: inv.inviter?.tag ?? null,
              uses: inv.uses,
              maxUses: inv.maxUses,
              maxAge: inv.maxAge,
              temporary: inv.temporary,
              createdAt: inv.createdAt?.toISOString() ?? null,
              expiresAt: inv.expiresAt?.toISOString() ?? null,
            }))
          );
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_emojis',
      {
        description: 'Liste les emojis personnalisés du serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const emojis = await guild.emojis.fetch();
        return ok(
          emojis.map((e) => ({
            id: e.id,
            name: e.name,
            animated: e.animated,
            url: e.url,
            creatorId: e.author?.id ?? null,
          }))
        );
      })
    );

    server.registerTool(
      'get_stickers',
      {
        description: 'Liste les stickers personnalisés du serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const stickers = await guild.stickers.fetch();
        return ok(
          stickers.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            tags: s.tags,
            format: s.format,
            url: s.url,
          }))
        );
      })
    );

    server.registerTool(
      'get_webhooks',
      {
        description: 'Liste les webhooks du serveur ou d\'un salon spécifique. Requiert READ_STATS.',
        inputSchema: {
          channel: z.string().optional().describe('Nom, mention <#id> ou ID du salon (optionnel - si omis, liste tous les webhooks du serveur)'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ channel }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          let webhooks;
          if (channel) {
            const resolved = resolveChannel(guildId, client, channel);
            if (!resolved.ok) return resolved.response;
            webhooks = await resolved.channel.fetchWebhooks();
          } else {
            webhooks = await guild.fetchWebhooks();
          }

          return ok(
            webhooks.map((w) => ({
              id: w.id,
              name: w.name,
              channelId: w.channelId,
              creatorId: w.owner?.id ?? null,
              creatorTag: w.owner && 'tag' in w.owner ? w.owner.tag : (w.owner?.username ?? null),
              url: w.url,
              avatar: w.avatarURL(),
            }))
          );
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_guild_settings',
      {
        description: 'Retourne les réglages globaux du serveur Discord (icône, bannière, vérification, AFK, vanity URL, etc.). Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        return ok({
          name: guild.name,
          icon: guild.iconURL({ size: 512 }),
          banner: guild.bannerURL({ size: 512 }),
          splash: guild.splashURL({ size: 512 }),
          verificationLevel: guild.verificationLevel,
          defaultMessageNotifications: guild.defaultMessageNotifications,
          explicitContentFilter: guild.explicitContentFilter,
          afkChannelId: guild.afkChannelId,
          afkChannelName: guild.afkChannel?.name ?? null,
          afkTimeout: guild.afkTimeout,
          systemChannelId: guild.systemChannelId,
          systemChannelName: guild.systemChannel?.name ?? null,
          rulesChannelId: guild.rulesChannelId,
          rulesChannelName: guild.rulesChannel?.name ?? null,
          vanityURLCode: guild.vanityURLCode,
          preferredLocale: guild.preferredLocale,
          premiumTier: guild.premiumTier,
          premiumSubscriptionCount: guild.premiumSubscriptionCount,
          description: guild.description,
          features: guild.features,
        });
      })
    );
  }
}
