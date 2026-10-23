/** Outils MCP - write members 2 (permission WRITE_MEMBERS). */
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, ok, toolError } from '../toolkit.js';

export function registerWriteMembers2Tools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'get_overview_layout',
      {
        description: 'Récupère la disposition (layout Bento) de la page d\'accueil du dashboard pour un utilisateur donné. Retourne la liste des modules visibles avec leurs tailles.',
        inputSchema: {
          user_id: z.string().describe('ID Discord de l\'utilisateur dont on veut voir le layout'),
          key_name: z.string().optional().describe('Nom de la clé MCP pour audit'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ user_id }) => {
        try {
          const settings = await prisma.dashboardUserSettings.findUnique({
            where: { guildId_userId: { guildId, userId: user_id } },
          });

          if (!settings || !settings.bentoLayout) {
            return ok({
              userId: user_id,
              layout: null,
              message: 'Aucun layout personnalisé. L\'utilisateur utilise le layout par défaut.',
              defaultModules: ['liveStats', 'analytics', 'system', 'channels', 'moderation', 'members', 'notifications', 'staff', 'audit', 'actions'],
            });
          }

          return ok({
            userId: user_id,
            layout: settings.bentoLayout,
          });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_overview_layout',
      {
        description:
          'Modifie la disposition (layout Bento) de la page d\'accueil du dashboard pour un utilisateur. ' +
          'Chaque module est un objet { id, colSpan (1-3), rowSpan (1-3), visible (true/false) }. ' +
          'Modules disponibles : liveStats, analytics, system, channels, moderation, members, notifications, staff, audit, actions, notes, serverInfo, botHosting, news, quickGuide, clockWeather, economy, leveling, tickets, invites, events, polls.',
        inputSchema: {
          user_id: z.string().describe('ID Discord de l\'utilisateur cible'),
          layout: z.array(z.object({
            id: z.string().describe('Identifiant du module'),
            colSpan: z.number().int().min(1).max(3).default(1).describe('Nombre de colonnes (1-3)'),
            rowSpan: z.number().int().min(1).max(3).default(1).describe('Nombre de lignes (1-3)'),
            visible: z.boolean().default(true).describe('Module visible ou masqué'),
          })).describe('Liste ordonnée des modules avec leur configuration'),
          key_name: z.string().optional().describe('Nom de la clé MCP pour audit'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ user_id, layout, key_name }) => {
        try {
          const validModules = new Set([
            'liveStats', 'analytics', 'system', 'channels', 'moderation', 'members',
            'notifications', 'staff', 'audit', 'actions', 'notes', 'serverInfo',
            'botHosting', 'news', 'quickGuide', 'clockWeather', 'economy', 'leveling',
            'tickets', 'invites', 'events', 'polls',
          ]);

          const sanitized = layout
            .filter((m: any) => validModules.has(m.id))
            .map((m: any) => ({
              id: m.id,
              colSpan: Math.max(1, Math.min(3, m.colSpan ?? 1)),
              rowSpan: Math.max(1, Math.min(3, m.rowSpan ?? 1)),
              visible: m.visible !== false,
            }));

          await prisma.dashboardUserSettings.upsert({
            where: { guildId_userId: { guildId, userId: user_id } },
            create: { guildId, userId: user_id, bentoLayout: sanitized },
            update: { bentoLayout: sanitized },
          });

          await audit(key_name, 'Layout Overview MCP - Mise à jour', `Utilisateur: ${user_id}`, `${sanitized.length} module(s) configuré(s)`);

          return ok({
            ok: true,
            userId: user_id,
            modulesCount: sanitized.length,
            visibleCount: sanitized.filter((m: any) => m.visible).length,
          });
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}
