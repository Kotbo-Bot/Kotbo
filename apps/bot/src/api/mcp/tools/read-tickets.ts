/** Outils MCP - read tickets (permission READ_TICKETS). */
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, ok } from '../toolkit.js';

export function registerReadTicketsTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_TICKETS')) {
    server.registerTool(
      'get_tickets',
      {
        description: 'Liste les tickets de support du serveur.',
        inputSchema: {
          status: z.enum(['PENDING', 'QUEUED', 'OPEN', 'CLAIMED', 'CLOSED', 'REJECTED']).optional(),
          limit: z.number().int().min(1).max(50).default(20),
          offset: z.number().int().min(0).default(0),
        },
        _meta: toolMeta,
      },
      guard('READ_TICKETS', async ({ status, limit, offset }) => {
        const [tickets, total] = await Promise.all([
          prisma.ticket.findMany({
            where: {
              guildId,
              ...(status ? { status } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          prisma.ticket.count({
            where: {
              guildId,
              ...(status ? { status } : {}),
            },
          }),
        ]);

        return ok({
          total,
          tickets: tickets.map((t) => ({
            id: t.id,
            userId: t.userId,
            status: t.status,
            reason: t.reason,
            description: t.description,
            claimedById: t.claimedById,
            createdAt: t.createdAt.toISOString(),
            closedAt: t.closedAt?.toISOString() ?? null,
          })),
        });
      })
    );
  }
}
