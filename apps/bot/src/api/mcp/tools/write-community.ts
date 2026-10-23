/** Outils MCP - write community (permission WRITE_COMMUNITY). */
import { archiveChannel, createSplitChannel, resolveHealthAlert, upsertChannelHealthConfig } from '../../../services/analytics/channelHealthService.js';
import { createSeason, endSeason, startSeason } from '../../../services/progression/seasonService.js';
import { publishSuggestionResolved } from '../../../services/features/suggestionService.js';
import prisma from '../../../utils/db.js';
import { type NewsChannel, TextChannel } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveChannel, toolError } from '../toolkit.js';

export function registerWriteCommunityTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('WRITE_COMMUNITY')) {
    server.registerTool(
      'respond_suggestion',
      {
        description:
          "Répond à une suggestion communautaire et met à jour son statut. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          suggestion_id: z.string().describe('ID de la suggestion (issu de get_suggestions)'),
          status: z.enum(['APPROVED', 'REJECTED', 'IMPLEMENTED']).describe('Nouveau statut'),
          response: z.string().min(1).max(1000).describe('Texte de réponse'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ suggestion_id, status, response, key_name }) => {
        const suggestion = await prisma.suggestion.findFirst({ where: { id: suggestion_id, guildId } });
        if (!suggestion) return err('Suggestion introuvable');

        const updated = await prisma.suggestion.update({
          where: { id: suggestion.id },
          data: {
            status,
            responseText: response,
            respondedById: 'mcp_agent',
            respondedAt: new Date(),
          },
        });
        publishSuggestionResolved(updated);

        if (suggestion.channelId && suggestion.messageId) {
          const channel = client.guilds.cache.get(guildId)?.channels.cache.get(suggestion.channelId);
          if (channel?.isTextBased()) {
            const statusEmoji = status === 'APPROVED' ? '✅' : status === 'REJECTED' ? '❌' : '🚀';
            await (channel as TextChannel | NewsChannel)
              .send({ content: `${statusEmoji} **Réponse à la suggestion de ${suggestion.username} :**\n${response}` })
              .catch(() => null);
          }
        }

        await audit(key_name, 'Réponse suggestion MCP', `Suggestion: ${suggestion.id}`, `${status} - ${response.slice(0, 200)}`);

        return ok({ ok: true, suggestionId: suggestion.id, status });
      })
    );

    server.registerTool(
      'update_event_status',
      {
        description: "Met à jour le statut d'un événement du serveur. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          event_id: z.string().describe("ID de l'événement (issu de get_events)"),
          status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED']).describe('Nouveau statut'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ event_id, status, key_name }) => {
        const event = await prisma.event.findFirst({ where: { id: event_id, guildId } });
        if (!event) return err('Événement introuvable');

        await prisma.event.update({ where: { id: event.id }, data: { status } });

        await audit(key_name, 'Modification événement MCP', `Événement: ${event.title}`, `Statut: ${status}`);

        return ok({ ok: true, eventId: event.id, title: event.title, status });
      })
    );

    server.registerTool(
      'create_giveaway_message',
      {
        description:
          "Annonce un giveaway existant dans un salon Discord. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway (issu de get_giveaways)'),
          channel: z.string().describe('Nom du salon, mention <#id> ou ID'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, channel, key_name }) => {
        const giveaway = await prisma.giveaway.findFirst({ where: { id: giveaway_id, guildId } });
        if (!giveaway) return err('Giveaway introuvable');

        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const msg = await resolved.channel
          .send({
            content: `🎉 **GIVEAWAY** 🎉\n\n**${giveaway.prize}**${giveaway.description ? `\n${giveaway.description}` : ''}\n\n🏆 ${giveaway.winnerCount} gagnant(s)\n⏰ Fin : <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>\n\nParticipants : ${giveaway.participants.length}`,
          })
          .catch(() => null);

        if (!msg) return err("Impossible d'envoyer le message dans ce salon");

        await audit(key_name, 'Annonce giveaway MCP', `Giveaway: ${giveaway.prize}`, `Salon: #${resolved.channel.name}`);

        return ok({ ok: true, giveawayId: giveaway.id, messageId: msg.id, channelName: resolved.channel.name });
      })
    );

    server.registerTool(
      'create_season',
      {
        description: 'Crée une nouvelle saison de leveling. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          name: z.string().describe('Nom de la saison'),
          start_date: z.string().describe('Date de début (ISO 8601)'),
          end_date: z.string().describe('Date de fin (ISO 8601)'),
          top_role_id: z.string().optional().describe('Rôle attribué au #1 du classement'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, start_date, end_date, top_role_id, key_name }) => {
        try {
          const season = await createSeason(guildId, {
            name,
            startDate: new Date(start_date),
            endDate: new Date(end_date),
            topRoleId: top_role_id,
          });
          await audit(key_name, 'Création saison MCP', name, `ID: ${season.id}`);
          return ok({ ok: true, season });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'start_season',
      {
        description: 'Démarre une saison de leveling (met fin aux autres saisons actives). Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison à démarrer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, key_name }) => {
        try {
          const success = await startSeason(guildId, season_id);
          if (!success) return err('Impossible de démarrer la saison');
          await audit(key_name, 'Démarrage saison MCP', season_id, '');
          return ok({ ok: true, seasonId: season_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'end_season',
      {
        description: 'Termine une saison active, fige le classement et distribue les récompenses. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison à terminer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, key_name }) => {
        try {
          const success = await endSeason(client, guildId, season_id);
          if (!success) return err('Impossible de terminer la saison');
          await audit(key_name, 'Fin de saison MCP', season_id, '');
          return ok({ ok: true, seasonId: season_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_channel_health_config',
      {
        description: 'Met à jour la configuration du module Channel Health. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          enabled: z.boolean().optional(),
          alert_channel: z.string().nullable().optional().describe('Salon d\'alertes (nom, mention ou ID)'),
          split_mode: z.boolean().optional(),
          archive_mode: z.boolean().optional(),
          analysis_period_days: z.number().int().optional(),
          overload_msg_per_hour: z.number().optional(),
          underused_msg_per_day: z.number().optional(),
          dead_msg_per_week: z.number().optional(),
          weekly_digest_enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ enabled, alert_channel, split_mode, archive_mode, analysis_period_days, overload_msg_per_hour, underused_msg_per_day, dead_msg_per_week, weekly_digest_enabled, key_name }) => {
        try {
          const updatePayload: Record<string, unknown> = {};
          if (enabled !== undefined) updatePayload.enabled = enabled;
          if (split_mode !== undefined) updatePayload.splitMode = split_mode;
          if (archive_mode !== undefined) updatePayload.archiveMode = archive_mode;
          if (analysis_period_days !== undefined) updatePayload.analysisPeriodDays = analysis_period_days;
          if (overload_msg_per_hour !== undefined) updatePayload.overloadMsgPerHour = overload_msg_per_hour;
          if (underused_msg_per_day !== undefined) updatePayload.underusedMsgPerDay = underused_msg_per_day;
          if (dead_msg_per_week !== undefined) updatePayload.deadMsgPerWeek = dead_msg_per_week;
          if (weekly_digest_enabled !== undefined) updatePayload.weeklyDigestEnabled = weekly_digest_enabled;

          if (alert_channel !== undefined) {
            if (alert_channel === null) {
              updatePayload.alertChannelId = null;
            } else {
              const resolved = resolveChannel(guildId, client, alert_channel);
              if (!resolved.ok) return resolved.response;
              updatePayload.alertChannelId = resolved.channel.id;
            }
          }

          const config = await upsertChannelHealthConfig(guildId, updatePayload);
          await audit(key_name, 'Config Channel Health MCP', '', JSON.stringify(updatePayload));
          return ok(config);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'resolve_channel_health_alert',
      {
        description: 'Marque une alerte Channel Health comme appliquée ou ignorée. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          alert_id: z.string().describe('ID de l\'alerte'),
          action: z.enum(['APPLIED', 'DISMISSED']).describe('Action à enregistrer'),
          note: z.string().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ alert_id, action, note, key_name }) => {
        try {
          const success = await resolveHealthAlert(guildId, alert_id, action, 'mcp_agent', note);
          if (!success) return err('Alerte introuvable');
          await audit(key_name, 'Résolution alerte Channel Health MCP', alert_id, action);
          return ok({ ok: true, alertId: alert_id, action });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'split_overloaded_channel',
      {
        description: 'Crée un salon jumeau pour alléger un salon surchargé (Channel Health). Requiert WRITE_COMMUNITY.',
        inputSchema: {
          channel: z.string().describe('Salon surchargé (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ channel, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const newChannelId = await createSplitChannel(client, guildId, resolved.channel.id);
          if (!newChannelId) return err('Impossible de créer le salon jumeau');
          await audit(key_name, 'Split salon MCP', resolved.channel.name, `Nouveau salon: ${newChannelId}`);
          return ok({ ok: true, sourceChannelId: resolved.channel.id, newChannelId });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'archive_inactive_channel',
      {
        description: 'Archive un salon inactif via Channel Health. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          channel: z.string().describe('Salon à archiver (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ channel, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const success = await archiveChannel(client, guildId, resolved.channel.id);
          if (!success) return err('Impossible d\'archiver le salon');
          await audit(key_name, 'Archivage salon MCP', resolved.channel.name, resolved.channel.id);
          return ok({ ok: true, channelId: resolved.channel.id });
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
