/** Outils MCP - read community (permission READ_COMMUNITY). */
import { getModuleActivationStats, getModulePerformanceStats, getModuleStatsSummary, getModuleUsageStats, KOTBO_MODULES } from '../../../services/analytics/moduleStatsService.js';
import { getSeasonLeaderboard, getSeasonsDashboardData } from '../../../services/progression/seasonService.js';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember, toolError } from '../toolkit.js';

export function registerReadCommunityTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_COMMUNITY')) {
    server.registerTool(
      'get_leaderboard',
      {
        description: 'Classement des membres par XP/niveau, nombre de messages ou temps vocal.',
        inputSchema: {
          by: z.enum(['xp', 'messages', 'voice']).default('xp').describe('Critère du classement'),
          limit: z.number().int().min(1).max(50).default(10),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ by, limit }) => {
        if (by === 'xp') {
          const rows = await prisma.memberLevel.findMany({
            where: { guildId },
            orderBy: { xp: 'desc' },
            take: limit,
          });
          const profiles = await prisma.memberProfile.findMany({
            where: { guildId, userId: { in: rows.map((r) => r.userId) } },
            select: { userId: true, username: true, displayName: true },
          });
          const nameOf = new Map(profiles.map((p) => [p.userId, p.displayName ?? p.username ?? p.userId]));
          return ok(
            rows.map((r, i) => ({
              rank: i + 1,
              userId: r.userId,
              name: nameOf.get(r.userId) ?? r.userId,
              level: r.level,
              xp: r.xp,
            }))
          );
        }

        const field = by === 'voice' ? 'voiceTimeSeconds' : 'messageCount';
        const rows = await prisma.memberProfile.findMany({
          where: { guildId },
          orderBy: { [field]: 'desc' },
          take: limit,
          select: { userId: true, username: true, displayName: true, messageCount: true, voiceTimeSeconds: true },
        });
        return ok(
          rows.map((r, i) => ({
            rank: i + 1,
            userId: r.userId,
            name: r.displayName ?? r.username ?? r.userId,
            messageCount: r.messageCount,
            voiceTimeSeconds: r.voiceTimeSeconds,
          }))
        );
      })
    );

    server.registerTool(
      'get_suggestions',
      {
        description: 'Liste les suggestions de la communauté avec filtre optionnel par statut.',
        inputSchema: {
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'IMPLEMENTED']).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ status, limit }) => {
        const suggestions = await prisma.suggestion.findMany({
          where: { guildId, ...(status ? { status } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        return ok(
          suggestions.map((s) => ({
            id: s.id,
            content: s.content,
            status: s.status,
            author: s.username,
            authorId: s.userId,
            upvotes: s.upvoters.length,
            downvotes: s.downvoters.length,
            response: s.responseText,
            createdAt: s.createdAt.toISOString(),
          }))
        );
      })
    );

    server.registerTool(
      'get_events',
      {
        description: 'Liste les événements du serveur.',
        inputSchema: {
          status: z.string().optional().describe('Filtre optionnel sur le statut (ex: DRAFT, SCHEDULED, ACTIVE, ENDED)'),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ status, limit }) => {
        const events = await prisma.event.findMany({
          where: { guildId, ...(status ? { status: status as never } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: { _count: { select: { participants: true } } },
        });
        return ok(
          events.map((e) => ({
            id: e.id,
            title: e.title,
            description: e.description,
            type: e.type,
            status: e.status,
            triggerType: e.triggerType,
            triggerValue: e.triggerValue,
            participants: e._count.participants,
            createdAt: e.createdAt.toISOString(),
          }))
        );
      })
    );

    server.registerTool(
      'get_giveaways',
      {
        description: 'Liste les giveaways du serveur.',
        inputSchema: {
          active_only: z.boolean().default(false).describe('Ne retourner que les giveaways en cours'),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ active_only, limit }) => {
        const giveaways = await prisma.giveaway.findMany({
          where: { guildId, ...(active_only ? { ended: false } : {}) },
          orderBy: { endsAt: 'desc' },
          take: limit,
        });

        // Une seule lecture pour toute la liste : l'objet RPG etait rendu par
        // son identifiant stocke, que rien ne permet de reconnaitre. Le filtre
        // de serveur ecarte l'objet d'un autre serveur, que la remise ne
        // trouverait pas davantage.
        const itemIds = [...new Set(giveaways.map((g) => g.rpgItemId).filter((id): id is string => !!id))];
        const items = itemIds.length > 0
          ? await prisma.rpgItem.findMany({
            where: { id: { in: itemIds }, OR: [{ guildId: null }, { guildId }] },
            select: { id: true, name: true },
          })
          : [];
        const itemNames = new Map(items.map((item) => [item.id, item.name]));

        return ok(
          giveaways.map((g) => ({
            id: g.id,
            prize: g.prize,
            description: g.description,
            channelId: g.channelId,
            winnerCount: g.winnerCount,
            ended: g.ended,
            endsAt: g.endsAt.toISOString(),
            participants: g.participants.length,
            winners: g.winners,
            /** Tires mais pas encore valides par le staff. */
            pendingWinners: g.pendingWinners,
            needValidation: g.needValidation,
            validationStatus: g.validationStatus,
            ignoreBonuses: g.ignoreBonuses,
            rewards: {
              xp: g.rpgXp,
              coins: g.rpgCoins,
              item: g.rpgItemId ? itemNames.get(g.rpgItemId) ?? null : null,
            },
          }))
        );
      })
    );

    server.registerTool(
      'get_reputation_leaderboard',
      {
        description: 'Classement des membres par points de réputation.',
        inputSchema: {
          limit: z.number().int().min(1).max(50).default(10),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ limit }) => {
        const votes = await prisma.reputationVote.groupBy({
          by: ['receiverId'],
          where: { guildId },
          _sum: { value: true },
          orderBy: { _sum: { value: 'desc' } },
          take: limit,
        });

        const userIds = votes.map((v) => v.receiverId);
        const profiles = await prisma.memberProfile.findMany({
          where: { guildId, userId: { in: userIds } },
          select: { userId: true, username: true, displayName: true },
        });
        const nameOf = new Map(profiles.map((p) => [p.userId, p.displayName ?? p.username ?? p.userId]));

        return ok(
          votes.map((v, i) => ({
            rank: i + 1,
            userId: v.receiverId,
            name: nameOf.get(v.receiverId) ?? v.receiverId,
            reputationPoints: v._sum.value ?? 0,
          }))
        );
      })
    );

    server.registerTool(
      'get_quest_definitions',
      {
        description: 'Liste les quêtes disponibles sur le serveur (quotidiennes, hebdomadaires, etc.).',
        inputSchema: {
          enabled_only: z.boolean().default(true).describe('Ne retourner que les quêtes actives'),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ enabled_only }) => {
        const quests = await prisma.questDefinition.findMany({
          where: { guildId, ...(enabled_only ? { enabled: true } : {}) },
          orderBy: { createdAt: 'desc' },
        });
        return ok(
          quests.map((q) => ({
            id: q.id,
            name: q.name,
            description: q.description,
            type: q.type,
            frequency: q.frequency,
            target: q.target,
            rewardCoins: q.rewardCoins,
            rewardXp: q.rewardXp,
            enabled: q.enabled,
          }))
        );
      })
    );

    server.registerTool(
      'get_member_quests',
      {
        description: "Récupère la progression des quêtes d'un membre spécifique.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const progress = await prisma.questProgress.findMany({
          where: { guildId, userId: resolved.userId },
          include: { quest: { select: { name: true, description: true, type: true, frequency: true, target: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        });

        return ok(
          progress.map((p) => ({
            questName: p.quest.name,
            questType: p.quest.type,
            frequency: p.quest.frequency,
            current: p.current,
            target: p.target,
            status: p.status,
            dateKey: p.dateKey,
            claimedAt: p.claimedAt?.toISOString() ?? null,
          }))
        );
      })
    );

    server.registerTool(
      'get_custom_forms',
      {
        description: 'Liste les formulaires personnalisés du serveur. Requiert READ_COMMUNITY.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        try {
          const forms = await prisma.customForm.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok(forms);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_custom_form',
      {
        description: 'Récupère les détails d\'un formulaire personnalisé par son ID. Requiert READ_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire'),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ form_id }) => {
        try {
          const form = await prisma.customForm.findFirst({
            where: { id: form_id, guildId },
          });
          if (!form) return err('Formulaire introuvable');
          return ok(form);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_custom_form_submissions',
      {
        description: 'Récupère les soumissions de réponses pour un formulaire personnalisé. Requiert READ_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire'),
          limit: z.number().int().min(1).max(100).default(50),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ form_id, limit }) => {
        try {
          const submissions = await prisma.customFormSubmission.findMany({
            where: { formId: form_id, guildId },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return ok(submissions);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_scheduled_tasks',
      {
        description: 'Liste les tâches planifiées automatiques (Cron). Requiert READ_COMMUNITY.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        try {
          const tasks = await prisma.scheduledTask.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok(tasks);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_seasons',
      {
        description: 'Récupère les saisons de leveling (actives, à venir, terminées) et le classement en cours. Requiert READ_COMMUNITY.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        try {
          const data = await getSeasonsDashboardData(guildId);
          return ok(data);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_season_leaderboard',
      {
        description: 'Récupère le classement d\'une saison de leveling spécifique. Requiert READ_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison'),
          limit: z.number().int().min(1).max(100).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ season_id, limit }) => {
        try {
          const leaderboard = await getSeasonLeaderboard(guildId, season_id, limit);
          return ok({ seasonId: season_id, leaderboard });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_module_activation_stats',
      {
        description: 'Récupère l’état d’activation des modules Kotbo.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        try {
          return ok(await getModuleActivationStats(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_module_usage_stats',
      {
        description: 'Récupère les statistiques d’utilisation des modules Kotbo.',
        inputSchema: {
          module_name: z.string().optional().describe('Nom du module Kotbo'),
          start_date: z.string().optional().describe('Date de début ISO'),
          end_date: z.string().optional().describe('Date de fin ISO'),
          period_days: z.number().int().min(1).max(365).optional().describe('Fenêtre temporelle en jours'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ module_name, start_date, end_date, period_days }) => {
        try {
          const data = await getModuleUsageStats({
            guildId,
            moduleName: module_name ? (KOTBO_MODULES.includes(module_name as never) ? (module_name as never) : undefined) : undefined,
            startDate: start_date,
            endDate: end_date,
            periodDays: period_days,
          });
          return ok(data);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_module_performance_stats',
      {
        description: 'Récupère les performances des modules Kotbo.',
        inputSchema: {
          module_name: z.string().optional().describe('Nom du module Kotbo'),
          start_date: z.string().optional().describe('Date de début ISO'),
          end_date: z.string().optional().describe('Date de fin ISO'),
          period_days: z.number().int().min(1).max(365).optional().describe('Fenêtre temporelle en jours'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ module_name, start_date, end_date, period_days }) => {
        try {
          const data = await getModulePerformanceStats({
            guildId,
            moduleName: module_name ? (KOTBO_MODULES.includes(module_name as never) ? (module_name as never) : undefined) : undefined,
            startDate: start_date,
            endDate: end_date,
            periodDays: period_days,
          });
          return ok(data);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_module_stats_summary',
      {
        description: 'Récupère un résumé global des statistiques modules.',
        inputSchema: {
          period_days: z.number().int().min(1).max(365).default(30),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ period_days }) => {
        try {
          return ok(await getModuleStatsSummary({ guildId, periodDays: period_days }));
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
