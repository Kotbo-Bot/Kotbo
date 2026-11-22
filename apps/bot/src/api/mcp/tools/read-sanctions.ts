/** Outils MCP - read sanctions (permission READ_SANCTIONS). */
import prisma from '../../../utils/db.js';
import { EVIDENCE_CHANNEL_CONCURRENCY, fetchDeletedUserMessages, fetchUserMessagesInChannel, mergeDeletedIntoChannels, serializeEvidenceMessage } from '../../evidence.js';
import { type SanctionStatus, type SanctionType } from '@prisma/client';
import { ChannelType, PermissionFlagsBits, TextChannel } from 'discord.js';
import pLimit from 'p-limit';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember } from '../toolkit.js';

export function registerReadSanctionsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_SANCTIONS')) {
    server.registerTool(
      'get_sanctions',
      {
        description: 'Liste les sanctions du serveur avec filtres optionnels.',
        inputSchema: {
          member: z.string().optional().describe('Filtrer par membre : nom, surnom, @mention ou ID'),
          type: z.enum(['WARN', 'KICK', 'TIMEOUT', 'TEMP_BAN', 'BAN', 'SOFTBAN']).optional(),
          status: z.enum(['ACTIVE', 'RESOLVED', 'FAILED']).optional(),
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).default(0),
        },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ member, type, status, limit, offset }) => {
        let member_id: string | undefined;
        if (member) {
          const resolved = await resolveMember(guildId, member);
          if (!resolved.ok) return resolved.response;
          member_id = resolved.userId;
        }

        const [sanctions, total] = await Promise.all([
          prisma.sanction.findMany({
            where: {
              guildId,
              ...(member_id ? { targetUserId: member_id } : {}),
              ...(type ? { type: type as SanctionType } : {}),
              ...(status ? { status: status as SanctionStatus } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          prisma.sanction.count({
            where: {
              guildId,
              ...(member_id ? { targetUserId: member_id } : {}),
              ...(type ? { type: type as SanctionType } : {}),
              ...(status ? { status: status as SanctionStatus } : {}),
            },
          }),
        ]);

        return ok({
          total,
          sanctions: sanctions.map((s) => ({
            id: s.id,
            type: s.type,
            status: s.status,
            targetUserId: s.targetUserId,
            targetTag: s.targetTag,
            moderatorUserId: s.moderatorUserId,
            moderatorTag: s.moderatorTag,
            reason: s.reason,
            durationSeconds: s.durationSeconds,
            expiresAt: s.expiresAt?.toISOString(),
            createdAt: s.createdAt.toISOString(),
            resolvedAt: s.resolvedAt?.toISOString(),
          })),
        });
      })
    );

    server.registerTool(
      'get_sanction_history',
      {
        description: "Récupère l'historique complet des sanctions pour un membre spécifique.",
        inputSchema: { member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre') },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const member_id = resolved.userId;

        const [sanctions, reports] = await Promise.all([
          prisma.sanction.findMany({
            where: { guildId, targetUserId: member_id },
            orderBy: { createdAt: 'desc' },
          }),
          prisma.sanctionReport.findMany({
            where: { guildId, memberReference: member_id },
            orderBy: { createdAt: 'desc' },
          }),
        ]);

        const byType: Record<string, number> = {};
        for (const s of sanctions) {
          byType[s.type] = (byType[s.type] ?? 0) + 1;
        }

        return ok({
          memberId: member_id,
          summary: {
            total: sanctions.length,
            active: sanctions.filter((s) => s.status === 'ACTIVE').length,
            byType,
          },
          sanctions: sanctions.map((s) => ({
            id: s.id,
            type: s.type,
            status: s.status,
            reason: s.reason,
            moderatorTag: s.moderatorTag,
            durationSeconds: s.durationSeconds,
            createdAt: s.createdAt.toISOString(),
          })),
          reports: reports.map((r) => ({
            id: r.id,
            sanctionId: r.sanctionId,
            brokenRules: r.brokenRules,
            detailedReason: r.detailedReason,
            evidenceLinks: r.evidenceLinks,
            createdAt: r.createdAt.toISOString(),
          })),
        });
      })
    );

    server.registerTool(
      'get_sanction_reports',
      {
        description: 'Liste les rapports de sanction (preuves documentées) du serveur. Requiert READ_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().optional().describe('Filtrer par ID de sanction liée'),
          limit: z.number().int().min(1).max(100).default(50),
        },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ sanction_id, limit }) => {
        const reports = await prisma.sanctionReport.findMany({
          where: { guildId, ...(sanction_id ? { sanctionId: sanction_id } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        return ok(reports);
      })
    );

    server.registerTool(
      'get_sanction_discord_evidence',
      {
        description:
          'Recherche les messages Discord d\'un membre sanctionné dans tous les salons accessibles, pour constituer des preuves. Requiert READ_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction concernée'),
          limit: z.number().int().min(1).max(200).default(50).describe('Nombre max de messages à retourner'),
        },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ sanction_id, limit }) => {
        const sanction = await prisma.sanction.findFirst({ where: { id: sanction_id, guildId } });
        if (!sanction) return err('Sanction introuvable');

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const me = guild.members.me;
        const searchableChannels = [...guild.channels.cache.values()].filter((channel): channel is TextChannel => {
          if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return false;
          return Boolean(me && channel.permissionsFor(me).has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ]));
        });

        const concurrencyLimit = pLimit(EVIDENCE_CHANNEL_CONCURRENCY);
        let failedChannelCount = 0;
        const fetchedChannels = await Promise.all(
          searchableChannels.map((channel) => concurrencyLimit(async () => {
            try {
              const { messages, truncated } = await fetchUserMessagesInChannel(channel, sanction.targetUserId, limit);
              return { channelId: channel.id, channelName: channel.name, rawMessages: messages, truncated };
            } catch {
              failedChannelCount++;
              return null;
            }
          })),
        );

        const successfulChannels = fetchedChannels.filter((c): c is NonNullable<typeof c> => c !== null);
        const newestMessages = successfulChannels
          .flatMap((channel) => channel.rawMessages.map((message) => ({ channel, message })))
          .sort((a, b) => b.message.createdTimestamp - a.message.createdTimestamp)
          .slice(0, limit);

        const includedMessageIds = new Set(newestMessages.map(({ message }) => message.id));
        const liveChannels = successfulChannels
          .map((channel) => ({
            channelId: channel.channelId,
            channelName: channel.channelName,
            messages: channel.rawMessages
              .filter((message) => includedMessageIds.has(message.id))
              .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
              .map((message) => serializeEvidenceMessage(message, guild)) as Array<Record<string, unknown>>,
            truncated: channel.truncated,
          }))
          .filter((channel) => channel.messages.length > 0);

        const deleted = await fetchDeletedUserMessages(guildId, sanction.targetUserId, limit);
        const channels = mergeDeletedIntoChannels(liveChannels, deleted);

        return ok({
          sanctionId: sanction.id,
          targetTag: sanction.targetTag,
          targetUserId: sanction.targetUserId,
          channels,
          messageCount: newestMessages.length + deleted.length,
          searchedChannelCount: searchableChannels.length,
          failedChannelCount,
        });
      })
    );
  }
}
