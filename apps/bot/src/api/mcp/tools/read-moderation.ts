/** Outils MCP - read moderation (permission READ_MODERATION). */
import { getAppealConfig, getAppealDetail } from '../../../services/moderation/banAppealService.js';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, toolError } from '../toolkit.js';

export function registerReadModerationTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_MODERATION')) {
    server.registerTool(
      'get_automod_config',
      {
        description: "Récupère la configuration complète de l'AutoMod du serveur.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async () => {
        const config = await prisma.autoModConfig.findUnique({ where: { guildId } });
        if (!config) return err("Aucune configuration AutoMod trouvée.");

        return ok({
          discordAutoModEnabled: config.discordAutoModEnabled,
          spamEnabled: config.spamEnabled,
          linksEnabled: config.linksEnabled,
          capsEnabled: config.capsEnabled,
          emojisEnabled: config.emojisEnabled,
          mentionsEnabled: config.mentionsEnabled,
          ghostPingEnabled: config.ghostPingEnabled,
          antiEveryoneEnabled: config.antiEveryoneEnabled,
          customWordsEnabled: config.customWordsEnabled,
          profanityEnabled: config.profanityEnabled,
          inviteFilterEnabled: config.inviteFilterEnabled,
          antiBotEnabled: config.antiBotEnabled,
          bypassRoles: config.bypassRoles,
          bypassChannels: config.bypassChannels,
        });
      })
    );

    server.registerTool(
      'get_banned_words',
      {
        description: 'Liste les mots bannis configurés sur le serveur.',
        inputSchema: {
          category: z.string().optional().describe('Filtre par catégorie'),
          enabled_only: z.boolean().default(true),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ category, enabled_only }) => {
        const words = await prisma.bannedWord.findMany({
          where: {
            guildId,
            ...(category ? { category } : {}),
            ...(enabled_only ? { enabled: true } : {}),
          },
          orderBy: { category: 'asc' },
        });

        return ok(
          words.map((w) => ({
            id: w.id,
            word: w.word,
            category: w.category,
            enabled: w.enabled,
          }))
        );
      })
    );

    server.registerTool(
      'get_auto_responses',
      {
        description: 'Liste les réponses automatiques configurées sur le serveur.',
        inputSchema: {
          enabled_only: z.boolean().default(true),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ enabled_only }) => {
        const responses = await prisma.autoResponse.findMany({
          where: { guildId, ...(enabled_only ? { enabled: true } : {}) },
          orderBy: { createdAt: 'desc' },
        });

        return ok(
          responses.map((r) => ({
            id: r.id,
            triggerType: r.triggerType,
            trigger: r.trigger,
            response: r.response,
            matchType: r.matchType,
            enabled: r.enabled,
            deleteTrigger: r.deleteTrigger,
            allowedChannelIds: r.allowedChannelIds,
            bannedChannelIds: r.bannedChannelIds,
            allowedRoleIds: r.allowedRoleIds,
            bannedRoleIds: r.bannedRoleIds,
            reactions: r.reactions,
            actions: r.actions,
            closeTicket: r.closeTicket,
            rejectForm: r.rejectForm,
            formId: r.formId,
            formQuestionLabel: r.formQuestionLabel,
            ticketTypeId: r.ticketTypeId,
            ticketQuestionLabel: r.ticketQuestionLabel,
          }))
        );
      })
    );

    server.registerTool(
      'get_code_police_rules',
      {
        description: 'Liste les règles CodePolice (détection de code brut dans les messages).',
        inputSchema: {
          enabled_only: z.boolean().default(true),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ enabled_only }) => {
        const rules = await prisma.codePoliceRule.findMany({
          where: { guildId, ...(enabled_only ? { enabled: true } : {}) },
          orderBy: { category: 'asc' },
        });

        return ok(
          rules.map((r) => ({
            id: r.id,
            key: r.key,
            category: r.category,
            matchType: r.matchType,
            language: r.language,
            label: r.label,
            severity: r.severity,
            enabled: r.enabled,
          }))
        );
      })
    );

    server.registerTool(
      'get_ban_appeals',
      {
        description: 'Liste les demandes d\'appel de bannissement (Ban Appeals) reçues sur le serveur. Requiert READ_MODERATION.',
        inputSchema: {
          status: z.enum(['PENDING', 'NEEDS_INFO', 'ACCEPTED', 'DENIED', 'DENIED_PERMANENT']).optional().describe('Filtre par statut de la demande'),
          limit: z.number().int().min(1).max(200).default(50),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ status, limit }) => {
        try {
          const appeals = await prisma.banAppeal.findMany({
            where: { guildId, ...(status ? { status } : {}) },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return ok(appeals);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_ban_appeal',
      {
        description: 'Récupère les détails d\'un appel de bannissement spécifique avec son historique et ses sanctions liées. Requiert READ_MODERATION.',
        inputSchema: {
          appeal_id: z.string().describe('ID unique de la demande d\'appel'),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ appeal_id }) => {
        try {
          const detail = await getAppealDetail(appeal_id, guildId);
          if (!detail) return err('Appel introuvable');
          return ok(detail);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_ban_appeal_config',
      {
        description: 'Récupère la configuration actuelle des appels de bannissement sur le serveur. Requiert READ_MODERATION.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async () => {
        try {
          const config = await getAppealConfig(guildId);
          return ok(config);
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
