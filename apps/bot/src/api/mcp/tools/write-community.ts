/** Outils MCP - write community (permission WRITE_COMMUNITY). */
import { archiveChannel, createSplitChannel, resolveHealthAlert, upsertChannelHealthConfig } from '../../../services/analytics/channelHealthService.js';
import { createSeason, deleteSeason, endSeason, parseSeasonInput, retrySeasonRewards, startSeason, updateSeason } from '../../../services/progression/seasonService.js';
import { resolveSuggestion } from '../../../services/features/suggestionService.js';
import { adjustRep } from '../../../services/community/reputationActions.js';
import { REPUTATION_ADJUSTMENT, SUGGESTION_RESPONSE_MAX } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveChannel, resolveMember, toolError } from '../toolkit.js';

type SeasonRewardArg = { rank: number; role_id?: string; coins?: number; rotate?: boolean };
type SeasonTierArg = { min_xp: number; role_id?: string; coins?: number; rotate?: boolean };

export function registerWriteCommunityTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta, ownerId } = ctx;

  if (shouldRegister('WRITE_COMMUNITY')) {
    server.registerTool(
      'adjust_reputation',
      {
        description:
          "Donne (montant positif) ou retire (montant négatif) des points de réputation à un membre, comme un ajustement du staff depuis le dashboard : les rôles de palier suivent le nouveau total, sans annonce, et aucun gain d'XP ni de pièces n'est versé. Le total ne descend jamais sous zéro. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          amount: z.number().int().min(REPUTATION_ADJUSTMENT.min).max(REPUTATION_ADJUSTMENT.max)
            .describe('Points à donner (positif) ou à retirer (négatif), jamais 0'),
          reason: z.string().max(200).optional().describe('Motif, visible dans l\'historique de la réputation'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ member, amount, reason, key_name }) => {
        if (amount === 0) return err('Le nombre de points ne peut pas être 0.');
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          // L'historique nomme l'auteur de l'ajustement : le compte de la clé, sinon le bot.
          const staffId = ownerId ?? client.user?.id;
          if (!staffId) return err('Bot non prêt : réessaie dans un instant.');

          const result = await adjustRep(client, {
            guildId,
            staffId,
            userId: resolved.userId,
            amount,
            reason: reason?.trim() || null,
          });
          if (!result.success) {
            return err(`${resolved.label} n'a que ${result.total} point(s) : impossible de descendre sous zéro.`);
          }

          await audit(key_name, 'Ajustement de réputation MCP', resolved.label, `${amount > 0 ? `+${amount}` : amount} point(s) (${result.before} → ${result.after})${reason?.trim() ? `, motif : ${reason.trim()}` : ''}`);
          return ok({ ok: true, userId: resolved.userId, before: result.before, after: result.after });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'respond_suggestion',
      {
        description:
          "Répond à une suggestion communautaire et met à jour son statut. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          suggestion_id: z.string().describe('ID de la suggestion (issu de get_suggestions)'),
          status: z.enum(['APPROVED', 'IN_PROGRESS', 'REJECTED', 'IMPLEMENTED']).describe('Nouveau statut ; IN_PROGRESS = acceptée et en cours de réalisation'),
          response: z.string().min(1).max(SUGGESTION_RESPONSE_MAX).describe('Texte de réponse, publié sous la suggestion'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ suggestion_id, status, response, key_name }) => {
        // Même chemin que le dashboard : statut, message public et événement,
        // au lieu d'un second message posté sous la suggestion restée « en attente ».
        const result = await resolveSuggestion(guildId, suggestion_id, status, response, 'mcp_agent', client);
        if (!result) return err('Suggestion introuvable');
        const { suggestion } = result;

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
        description: 'Crée une saison de leveling : un classement de l\'XP gagnée entre le début et la fin, sans remise à zéro. Un début passé l\'ouvre aussitôt si aucune autre saison n\'est en cours. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          name: z.string().describe('Nom de la saison'),
          start_date: z.string().describe('Date de début (ISO 8601)'),
          end_date: z.string().describe('Date de fin (ISO 8601)'),
          top_role_id: z.string().optional().describe('Rôle attribué au #1 du classement, repris au #1 de la saison précédente'),
          rewards: z.array(z.object({
            rank: z.number().int().min(1).max(100),
            role_id: z.string().optional(),
            coins: z.number().int().min(0).optional(),
            rotate: z.boolean().optional().describe('Rôle repris à la clôture de la saison suivante, sauf à qui le regagne'),
          })).max(10).optional().describe('Récompenses par rang, données à la clôture'),
          tiers: z.array(z.object({
            min_xp: z.number().int().min(1),
            role_id: z.string().optional(),
            coins: z.number().int().min(0).optional(),
            rotate: z.boolean().optional(),
          })).max(5).optional().describe('Paliers d\'XP : chaque membre qui gagne au moins min_xp pendant la saison reçoit la récompense'),
          announce_channel_id: z.string().optional().describe('Salon où annoncer l\'ouverture et la clôture'),
          auto_renew: z.boolean().optional().describe('À la clôture, ouvrir une saison de même durée et mêmes réglages, sauf si une autre est déjà prévue'),
          remind_before_end: z.boolean().optional().describe('Rappel dans le salon d\'annonce pendant les dernières 24 h'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, start_date, end_date, top_role_id, rewards, tiers, announce_channel_id, auto_renew, remind_before_end, key_name }) => {
        try {
          const parsed = parseSeasonInput({
            name,
            startDate: start_date,
            endDate: end_date,
            topRoleId: top_role_id,
            announceChannelId: announce_channel_id,
            rewards: rewards?.map((reward: SeasonRewardArg) => ({ rank: reward.rank, roleId: reward.role_id, coins: reward.coins, rotate: reward.rotate })),
            tiers: tiers?.map((tier: SeasonTierArg) => ({ minXp: tier.min_xp, roleId: tier.role_id, coins: tier.coins, rotate: tier.rotate })),
            autoRenew: auto_renew,
            remindBeforeEnd: remind_before_end,
          });
          if ('error' in parsed) return err(`Saison invalide : ${parsed.error}`);
          const season = await createSeason(guildId, parsed.input, client);
          await audit(key_name, 'Création saison MCP', name, `ID: ${season.id}`);
          return ok({ ok: true, season });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_season',
      {
        description: 'Modifie une saison à venir ou en cours ; un champ omis garde sa valeur, une chaîne vide retire le rôle du premier ou le salon d\'annonce. La date de début d\'une saison en cours ne change pas. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison à modifier'),
          name: z.string().optional(),
          start_date: z.string().optional().describe('Date de début (ISO 8601), saison à venir seulement'),
          end_date: z.string().optional().describe('Date de fin (ISO 8601)'),
          top_role_id: z.string().optional(),
          rewards: z.array(z.object({
            rank: z.number().int().min(1).max(100),
            role_id: z.string().optional(),
            coins: z.number().int().min(0).optional(),
            rotate: z.boolean().optional().describe('Rôle repris à la clôture de la saison suivante, sauf à qui le regagne'),
          })).max(10).optional().describe('Récompenses par rang, données à la clôture'),
          tiers: z.array(z.object({
            min_xp: z.number().int().min(1),
            role_id: z.string().optional(),
            coins: z.number().int().min(0).optional(),
            rotate: z.boolean().optional(),
          })).max(5).optional().describe('Paliers d\'XP : chaque membre qui gagne au moins min_xp pendant la saison reçoit la récompense'),
          announce_channel_id: z.string().optional(),
          auto_renew: z.boolean().optional(),
          remind_before_end: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, name, start_date, end_date, top_role_id, rewards, tiers, announce_channel_id, auto_renew, remind_before_end, key_name }) => {
        try {
          const patch: Record<string, unknown> = {};
          if (name !== undefined) patch.name = name;
          if (start_date !== undefined) patch.startDate = start_date;
          if (end_date !== undefined) patch.endDate = end_date;
          if (top_role_id !== undefined) patch.topRoleId = top_role_id;
          if (announce_channel_id !== undefined) patch.announceChannelId = announce_channel_id;
          if (rewards !== undefined) patch.rewards = rewards.map((reward: SeasonRewardArg) => ({ rank: reward.rank, roleId: reward.role_id, coins: reward.coins, rotate: reward.rotate }));
          if (tiers !== undefined) patch.tiers = tiers.map((tier: SeasonTierArg) => ({ minXp: tier.min_xp, roleId: tier.role_id, coins: tier.coins, rotate: tier.rotate }));
          if (auto_renew !== undefined) patch.autoRenew = auto_renew;
          if (remind_before_end !== undefined) patch.remindBeforeEnd = remind_before_end;

          const result = await updateSeason(guildId, season_id, patch, client);
          if (result === 'not_found') return err('Saison introuvable ou déjà terminée');
          if (result !== 'updated') return err(`Saison invalide : ${result}`);
          await audit(key_name, 'Modification saison MCP', season_id, Object.keys(patch).join(', '));
          return ok({ ok: true, seasonId: season_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_season',
      {
        description: 'Supprime une saison à venir. Une saison en cours ou terminée ne se supprime pas. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, key_name }) => {
        try {
          if (!(await deleteSeason(guildId, season_id))) return err('Seule une saison à venir peut être supprimée');
          await audit(key_name, 'Suppression saison MCP', season_id, '');
          return ok({ ok: true, seasonId: season_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'start_season',
      {
        description: 'Démarre une saison de leveling à venir. Refusé si une autre saison est en cours. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison à démarrer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, key_name }) => {
        try {
          const result = await startSeason(guildId, season_id, client);
          if (result === 'another_active') return err('Une saison est déjà en cours : termine-la avant d\'en ouvrir une autre');
          if (result !== 'started') return err('Saison introuvable ou déjà ouverte');
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
      'retry_season_rewards',
      {
        description: 'Redonne les récompenses d\'une saison terminée qui n\'ont pas été remises (rôle refusé, membre parti, Économie éteinte). Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison terminée'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, key_name }) => {
        try {
          const result = await retrySeasonRewards(client, guildId, season_id);
          if (result === 'not_found') return err('Saison introuvable ou pas encore terminée');
          if (result === 'busy') return err('Les récompenses de cette saison sont déjà en cours de reprise');
          await audit(key_name, 'Reprise récompenses saison MCP', season_id, `${result.retried} repris, ${result.remaining} restant(s)`);
          return ok({ ok: true, seasonId: season_id, ...result });
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
