/** Outils MCP - write tickets (permission WRITE_TICKETS). */
import { closeTicket } from '../../../services/features/ticketService.js';
import prisma from '../../../utils/db.js';
import { type NewsChannel, TextChannel } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok } from '../toolkit.js';

export function registerWriteTicketsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('WRITE_TICKETS')) {
    server.registerTool(
      'reply_ticket',
      {
        description: "Envoie un message dans le salon d'un ticket en tant que bot. Requiert WRITE_TICKETS.",
        inputSchema: {
          ticket_id: z.string().describe('ID du ticket (issu de get_tickets)'),
          content: z.string().min(1).max(2000).describe('Contenu du message'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ ticket_id, content, key_name }) => {
        const ticket = await prisma.ticket.findFirst({ where: { id: ticket_id, guildId } });
        if (!ticket) return err('Ticket introuvable');
        if (!ticket.channelId) return err("Ce ticket n'a pas de salon associé");

        const channel = client.guilds.cache.get(guildId)?.channels.cache.get(ticket.channelId);
        if (!channel || !channel.isTextBased()) return err('Salon du ticket introuvable');

        const sent = await (channel as TextChannel | NewsChannel).send({ content }).catch(() => null);
        if (!sent) return err("Impossible d'envoyer le message dans le ticket");

        await audit(key_name, 'Réponse ticket MCP', `Ticket: ${ticket.id}`, content.slice(0, 200));

        return ok({ ok: true, ticketId: ticket.id, messageId: sent.id });
      })
    );

    server.registerTool(
      'close_ticket',
      {
        description:
          'Ferme un ticket : marque le ticket comme fermé en base et renomme son salon (préfixe « fermé- »). Requiert WRITE_TICKETS.',
        inputSchema: {
          ticket_id: z.string().describe('ID du ticket (issu de get_tickets)'),
          reason: z.string().max(512).optional().describe('Raison de la fermeture'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ ticket_id, reason, key_name }) => {
        const ticket = await prisma.ticket.findFirst({ where: { id: ticket_id, guildId } });
        if (!ticket) return err('Ticket introuvable');
        if (ticket.status === 'CLOSED') return err('Ce ticket est déjà fermé');

        const closerName = `MCP[${key_name ?? 'agent'}]`;

        // Envoyer un message de contexte dans le salon avant la fermeture
        if (ticket.channelId && reason) {
          const channel = client.guilds.cache.get(guildId)?.channels.cache.get(ticket.channelId);
          if (channel?.isTextBased()) {
            await (channel as TextChannel | NewsChannel)
              .send({ content: `🤖 Raison de fermeture (IA) : ${reason}` })
              .catch(() => null);
          }
        }

        // Utiliser la vraie fonction closeTicket qui gère tout :
        // - Update BDD (status CLOSED, closedBy, closedAt)
        // - Retrait des permissions de l'opener
        // - Envoi de l'embed de fermeture avec boutons Réouvrir/Supprimer
        // - Renommage du salon (ticket- → fermé-)
        // - Log dans le salon de logs
        // - Envoi du sondage de satisfaction
        await closeTicket(client, ticket.id, client.user?.id ?? 'mcp_agent', closerName);

        await audit(key_name, 'Fermeture ticket MCP', `Ticket: ${ticket.id}`, reason ?? '(sans raison)');

        return ok({ ok: true, ticketId: ticket.id, status: 'CLOSED' });
      })
    );
  }
}
