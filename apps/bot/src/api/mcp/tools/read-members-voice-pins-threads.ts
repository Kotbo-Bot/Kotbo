/** Outils MCP - read members voice pins threads (permission READ_MEMBERS). */
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveChannel, resolveMember, toolError } from '../toolkit.js';

export function registerReadMembersVoicePinsThreadsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, toolMeta } = ctx;

  // ── READ_MEMBERS - Vocal, messages épinglés, threads ──────────────────
  if (shouldRegister('READ_MEMBERS')) {

    server.registerTool(
      'get_voice_state',
      {
        description: 'Retourne l\'état vocal d\'un membre (salon, mute, deafen, stream, caméra). Requiert READ_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ member }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const rm = await resolveMember(guildId, member);
        if (!rm.ok) return rm.response;

        const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
        if (!guildMember) return err(`Membre « ${member} » introuvable sur le serveur`);

        const vs = guildMember.voice;
        if (!vs.channel) return ok({ connected: false, userId: rm.userId });

        return ok({
          connected: true,
          userId: rm.userId,
          channelId: vs.channel.id,
          channelName: vs.channel.name,
          serverMute: vs.serverMute,
          serverDeaf: vs.serverDeaf,
          selfMute: vs.selfMute,
          selfDeaf: vs.selfDeaf,
          streaming: vs.streaming,
          selfVideo: vs.selfVideo,
        });
      })
    );

    server.registerTool(
      'get_pinned_messages',
      {
        description: 'Liste les messages épinglés d\'un salon. Requiert READ_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ channel }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const pins = await resolved.channel.messages.fetchPinned();
          return ok(
            pins.map((m) => ({
              id: m.id,
              authorId: m.author.id,
              authorTag: m.author.tag,
              content: m.content.slice(0, 500),
              createdAt: m.createdAt.toISOString(),
              embeds: m.embeds.length,
              attachments: m.attachments.size,
            }))
          );
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_threads',
      {
        description: 'Liste les threads actifs et archivés d\'un salon. Requiert READ_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon parent'),
          include_archived: z.boolean().default(false).describe('Inclure les threads archivés'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ channel, include_archived }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const active = await resolved.channel.threads.fetchActive();
          const threads = [...active.threads.values()].map((t) => ({
            id: t.id,
            name: t.name,
            archived: t.archived,
            locked: t.locked,
            memberCount: t.memberCount,
            messageCount: t.messageCount,
            createdAt: t.createdAt?.toISOString() ?? null,
            autoArchiveDuration: t.autoArchiveDuration,
          }));

          if (include_archived) {
            const archived = await resolved.channel.threads.fetchArchived();
            for (const t of archived.threads.values()) {
              threads.push({
                id: t.id,
                name: t.name,
                archived: t.archived,
                locked: t.locked,
                memberCount: t.memberCount,
                messageCount: t.messageCount,
                createdAt: t.createdAt?.toISOString() ?? null,
                autoArchiveDuration: t.autoArchiveDuration,
              });
            }
          }

          return ok(threads);
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
