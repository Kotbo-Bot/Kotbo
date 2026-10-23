/** Outils MCP - read stats 2 (permission READ_STATS). */
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, ok, toolError } from '../toolkit.js';

export function registerReadStats2Tools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_STATS')) {
    // 3. search_audit_logs
    server.registerTool(
      'search_audit_logs',
      {
        description: 'Fouille les logs d\'audit du dashboard pour identifier les actions passées.',
        inputSchema: {
          query: z.string().optional().describe('Terme de recherche optionnel'),
          limit: z.number().int().min(1).max(100).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ query, limit }) => {
        try {
          const logs = await prisma.dashboardAuditLog.findMany({
            where: {
              guildId,
              ...(query ? {
                OR: [
                  { action: { contains: query, mode: 'insensitive' } },
                  { details: { contains: query, mode: 'insensitive' } },
                  { user: { contains: query, mode: 'insensitive' } },
                  { module: { contains: query, mode: 'insensitive' } },
                ]
              } : {})
            },
            orderBy: { dateIso: 'desc' },
            take: limit,
          });

          return ok(logs.map(l => ({
            id: l.id,
            user: l.user,
            action: l.action,
            module: l.module,
            details: l.details,
            timestamp: l.dateIso.toISOString(),
          })));
        } catch (e) {
          return toolError(e, 'Erreur de recherche');
        }
      })
    );
  }
}
