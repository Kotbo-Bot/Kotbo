/**
 * Outils MCP - macros de ticket (lecture READ_TICKETS, ecriture WRITE_TICKETS).
 *
 * La validation et l'envoi passent par les memes fonctions que le dashboard et
 * le selecteur Discord : une macro creee ou lancee par un agent se comporte
 * exactement comme une macro creee ou lancee a la main.
 */
import type { TicketMacro } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../../utils/db.js';
import { parseMacroInput, suggestMacros } from '../../../services/features/ticketMacroService.js';
import { ticketGuildChannelId } from '../../../services/features/ticketGuildChannel.js';
import { postMacroInTicket } from '../../../services/features/ticketService.js';
import { type McpToolContext, err, ok, toolError } from '../toolkit.js';

/** Champs d'une macro exposes en snake_case, comme le reste des outils MCP. */
const macroFields = {
  category: z.string().max(60).optional().describe('Regroupement libre affiché dans le sélecteur Discord'),
  emoji: z.string().max(16).optional().describe('Emoji affiché devant la macro'),
  enabled: z.boolean().optional().describe('Macro utilisable (défaut : true)'),
  position: z.number().int().min(0).optional().describe("Ordre d'affichage à usage égal, plus petit = plus haut"),
  ticket_type_ids: z.array(z.string()).max(50).optional().describe('Types de ticket concernés (vide = tous)'),
  allowed_role_ids: z.array(z.string()).max(50).optional().describe('Rôles staff autorisés à l’utiliser (vide = tout le staff)'),
  keywords: z.array(z.string()).max(50).optional().describe('Mots-clés qui font suggérer la macro au staff selon la demande du membre'),
  auto_send_on_open: z.boolean().optional().describe("Poster automatiquement le texte à l'ouverture du ticket (sans les actions)"),
  set_ticket_type_id: z.string().optional().describe('Action : requalifier le ticket vers ce type. Chaîne vide = aucune'),
  add_role_id: z.string().optional().describe("Action : donner ce rôle à l'auteur du ticket. Chaîne vide = aucune"),
  remove_role_id: z.string().optional().describe("Action : retirer ce rôle à l'auteur du ticket. Chaîne vide = aucune"),
  request_satisfaction: z.boolean().optional().describe("Action : envoyer l'enquête de satisfaction"),
  close_ticket: z.boolean().optional().describe('Action : fermer le ticket (appliquée en dernier)'),
};

const CONTENT_HELP =
  'Texte envoyé (2000 caractères max). Variables : {user}, {username}, {staff}, {ticket_id}, {ticket_channel}, {ticket_link}, {ticket_type}, {ticket_reason}, {server}.';

type MacroFieldArgs = {
  name?: string;
  content?: string;
  category?: string;
  emoji?: string;
  enabled?: boolean;
  position?: number;
  ticket_type_ids?: string[];
  allowed_role_ids?: string[];
  keywords?: string[];
  auto_send_on_open?: boolean;
  set_ticket_type_id?: string;
  add_role_id?: string;
  remove_role_id?: string;
  request_satisfaction?: boolean;
  close_ticket?: boolean;
};

/** Traduit les arguments MCP vers le corps attendu par `parseMacroInput`, sans les champs absents. */
function toMacroBody(args: MacroFieldArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: args.name,
    content: args.content,
    category: args.category,
    emoji: args.emoji,
    enabled: args.enabled,
    position: args.position,
    ticketTypeIds: args.ticket_type_ids,
    allowedRoleIds: args.allowed_role_ids,
    keywords: args.keywords,
    autoSendOnOpen: args.auto_send_on_open,
    setTicketTypeId: args.set_ticket_type_id,
    addRoleId: args.add_role_id,
    removeRoleId: args.remove_role_id,
    requestSatisfaction: args.request_satisfaction,
    closeTicket: args.close_ticket,
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

function serializeMacro(macro: TicketMacro) {
  return {
    id: macro.id,
    name: macro.name,
    category: macro.category,
    emoji: macro.emoji,
    content: macro.content,
    enabled: macro.enabled,
    position: macro.position,
    ticketTypeIds: macro.ticketTypeIds,
    allowedRoleIds: macro.allowedRoleIds,
    keywords: macro.keywords,
    autoSendOnOpen: macro.autoSendOnOpen,
    actions: {
      setTicketTypeId: macro.setTicketTypeId,
      addRoleId: macro.addRoleId,
      removeRoleId: macro.removeRoleId,
      requestSatisfaction: macro.requestSatisfaction,
      closeTicket: macro.closeTicket,
    },
    usageCount: macro.usageCount,
    lastUsedAt: macro.lastUsedAt?.toISOString() ?? null,
  };
}

export function registerTicketMacrosTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('READ_TICKETS')) {
    server.registerTool(
      'get_ticket_macros',
      {
        description:
          "Liste les macros de ticket (réponses pré-écrites avec actions attachées). Avec ticket_id : seulement celles applicables au type de ce ticket, et celles suggérées d'après la demande du membre. Requiert READ_TICKETS.",
        inputSchema: {
          ticket_id: z.string().optional().describe('ID du ticket (issu de get_tickets) pour filtrer et obtenir les suggestions'),
          include_disabled: z.boolean().default(false).describe('Inclure les macros désactivées'),
        },
        _meta: toolMeta,
      },
      guard('READ_TICKETS', async ({ ticket_id, include_disabled }) => {
        const macros = await prisma.ticketMacro.findMany({
          where: { guildId, ...(include_disabled ? {} : { enabled: true }) },
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
        });

        if (!ticket_id) {
          return ok({ total: macros.length, macros: macros.map(serializeMacro) });
        }

        const ticket = await prisma.ticket.findFirst({ where: { id: ticket_id, guildId } });
        if (!ticket) return err('Ticket introuvable');

        // Une liste de types vide vaut « tous », comme dans le selecteur Discord.
        const applicable = macros.filter(
          (m) => m.ticketTypeIds.length === 0 || (ticket.ticketTypeId !== null && m.ticketTypeIds.includes(ticket.ticketTypeId)),
        );
        const suggested = suggestMacros(applicable, `${ticket.reason ?? ''}\n${ticket.description ?? ''}`);

        return ok({
          total: applicable.length,
          suggestedIds: suggested.map((m) => m.id),
          macros: applicable.map(serializeMacro),
        });
      })
    );
  }

  if (shouldRegister('WRITE_TICKETS')) {
    server.registerTool(
      'create_ticket_macro',
      {
        description: 'Crée une macro de ticket : un texte pré-écrit que le staff insère en un clic, avec des actions optionnelles. Requiert WRITE_TICKETS.',
        inputSchema: {
          name: z.string().min(1).max(100).describe('Nom affiché dans le sélecteur Discord'),
          content: z.string().min(1).max(2000).describe(CONTENT_HELP),
          ...macroFields,
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ key_name, ...args }) => {
        const parsed = parseMacroInput(toMacroBody(args));
        if ('error' in parsed) return err(parsed.error);

        try {
          const macro = await prisma.ticketMacro.create({ data: { guildId, ...parsed.data } });
          await audit(key_name, 'Macro ticket créée (MCP)', macro.name, `ID: ${macro.id}`);
          return ok({ ok: true, macro: serializeMacro(macro) });
        } catch (e) {
          return toolError(e, 'Erreur lors de la création de la macro');
        }
      })
    );

    server.registerTool(
      'update_ticket_macro',
      {
        description: 'Modifie une macro de ticket. Seuls les champs fournis changent. Requiert WRITE_TICKETS.',
        inputSchema: {
          macro_id: z.string().describe('ID de la macro (issu de get_ticket_macros)'),
          name: z.string().min(1).max(100).optional(),
          content: z.string().min(1).max(2000).optional().describe(CONTENT_HELP),
          ...macroFields,
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ macro_id, key_name, ...args }) => {
        const existing = await prisma.ticketMacro.findFirst({ where: { id: macro_id, guildId } });
        if (!existing) return err('Macro introuvable');

        // La validation porte sur la macro complete : on fusionne l'existant et
        // les champs fournis pour passer exactement les bornes du dashboard.
        const parsed = parseMacroInput({ ...existing, ...toMacroBody(args) });
        if ('error' in parsed) return err(parsed.error);

        try {
          const macro = await prisma.ticketMacro.update({ where: { id: existing.id }, data: parsed.data });
          await audit(key_name, 'Macro ticket modifiée (MCP)', macro.name, `ID: ${macro.id}`);
          return ok({ ok: true, macro: serializeMacro(macro) });
        } catch (e) {
          return toolError(e, 'Erreur lors de la mise à jour de la macro');
        }
      })
    );

    server.registerTool(
      'delete_ticket_macro',
      {
        description: 'Supprime définitivement une macro de ticket. Requiert WRITE_TICKETS.',
        inputSchema: {
          macro_id: z.string().describe('ID de la macro (issu de get_ticket_macros)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ macro_id, key_name }) => {
        const existing = await prisma.ticketMacro.findFirst({ where: { id: macro_id, guildId } });
        if (!existing) return err('Macro introuvable');

        await prisma.ticketMacro.deleteMany({ where: { id: existing.id, guildId } });
        await audit(key_name, 'Macro ticket supprimée (MCP)', existing.name, `ID: ${existing.id}`);
        return ok({ ok: true, macroId: existing.id });
      })
    );

    server.registerTool(
      'send_ticket_macro',
      {
        description:
          "Poste une macro dans le salon d'un ticket ouvert puis applique ses actions (requalification, rôles, enquête de satisfaction, fermeture), comme si le staff l'avait choisie dans le sélecteur. Requiert WRITE_TICKETS.",
        inputSchema: {
          ticket_id: z.string().describe('ID du ticket (issu de get_tickets)'),
          macro_id: z.string().describe('ID de la macro (issu de get_ticket_macros)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ ticket_id, macro_id, key_name }) => {
        const ticket = await prisma.ticket.findFirst({ where: { id: ticket_id, guildId } });
        if (!ticket) return err('Ticket introuvable');
        if (ticket.status !== 'OPEN' && ticket.status !== 'CLAIMED') return err("Ce ticket n'est pas ouvert");

        const macro = await prisma.ticketMacro.findFirst({ where: { id: macro_id, guildId, enabled: true } });
        if (!macro) return err('Macro introuvable ou désactivée');

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const channelId = ticketGuildChannelId(ticket);
        if (!channelId) return err("Ce ticket n'a pas de salon sur ce serveur (mode MP ou ticket relayé)");

        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return err('Salon du ticket introuvable');

        const actorName = `MCP[${key_name ?? 'agent'}]`;

        try {
          const result = await postMacroInTicket({
            client,
            guild,
            macro,
            ticket,
            channel,
            actor: { id: client.user?.id ?? 'mcp_agent', username: actorName },
            staffTag: 'le staff',
          });

          await audit(
            key_name,
            'Macro ticket envoyée (MCP)',
            `Ticket: ${ticket.id}`,
            `${macro.name}${result.applied.length > 0 ? ` · ${result.applied.join(', ')}` : ''}`,
          );

          return ok({ ok: true, ticketId: ticket.id, macroId: macro.id, ...result });
        } catch (e) {
          return toolError(e, "Erreur lors de l'envoi de la macro");
        }
      })
    );
  }
}
