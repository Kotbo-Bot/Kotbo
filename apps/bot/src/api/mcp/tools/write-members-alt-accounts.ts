/** Outils MCP - write members alt accounts (permission WRITE_MEMBERS). */
import { getAllLinkedUserIds, linkAccounts, unlinkAccounts } from '../../../services/moderation/altAccountService.js';
import prisma from '../../../utils/db.js';
import { LinkedAccountStatus, LinkedAccountType } from '@prisma/client';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember, toolError } from '../toolkit.js';

export function registerWriteMembersAltAccountsTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, audit, toolMeta } = ctx;

  // ── WRITE_MEMBERS - Double-compte (Alt account linking) ──────────────────
  if (shouldRegister('WRITE_MEMBERS')) {
    // link_accounts - Lier deux comptes comme doubles comptes
    server.registerTool(
      'link_accounts',
      {
        description: "Lie deux membres Discord en tant que doubles comptes (main / alt). Requiert WRITE_MEMBERS.",
        inputSchema: {
          member1: z.string().describe('Nom, surnom, @mention ou ID Discord du premier compte'),
          member2: z.string().describe('Nom, surnom, @mention ou ID Discord du deuxième compte'),
          reason: z.string().optional().describe('Raison de la liaison (recommandé)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member1, member2, reason, key_name }) => {
        const r1 = await resolveMember(guildId, member1);
        if (!r1.ok) return r1.response;
        const r2 = await resolveMember(guildId, member2);
        if (!r2.ok) return r2.response;

        if (r1.userId === r2.userId) {
          return err('Impossible de lier un compte à lui-même.');
        }

        try {
          // Vérifier que les deux membres existent bien en base
          const [p1, p2] = await Promise.all([
            prisma.memberProfile.findFirst({ where: { guildId, userId: r1.userId }, select: { userId: true } }),
            prisma.memberProfile.findFirst({ where: { guildId, userId: r2.userId }, select: { userId: true } }),
          ]);

          if (!p1) return err(`Membre introuvable en base : ${r1.label} (${r1.userId}). Le membre n'a peut-être jamais rejoint le serveur.`);
          if (!p2) return err(`Membre introuvable en base : ${r2.label} (${r2.userId}). Le membre n'a peut-être jamais rejoint le serveur.`);

          const link = await linkAccounts({
            guildId,
            user1Id: r1.userId,
            user2Id: r2.userId,
            type: LinkedAccountType.MANUAL,
            status: LinkedAccountStatus.VALIDATED,
            reason: reason || `Liaison manuelle via MCP par ${key_name ?? 'agent'}`,
            linkedByUserId: 'mcp_agent',
            metadata: { linkedBy: key_name ?? 'mcp_agent', at: new Date().toISOString() },
          });

          if (!link) {
            return err(`La liaison n'a pas pu être créée (IDs identiques après normalisation ? ${r1.userId} / ${r2.userId})`);
          }

          await audit(key_name, 'Liaison comptes MCP', `${r1.label} ↔ ${r2.label}`, `IDs: ${r1.userId} / ${r2.userId}`);
          return ok({ ok: true, linkId: link.id, user1Id: r1.userId, user1Label: r1.label, user2Id: r2.userId, user2Label: r2.label });
        } catch (e) {
          return toolError(e, 'Erreur lors de la liaison');
        }
      })
    );

    // get_linked_accounts - Lister les comptes liés à un membre
    server.registerTool(
      'get_linked_accounts',
      {
        description: "Liste tous les comptes liés (doubles comptes) d'un membre. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          const linkedIds = await getAllLinkedUserIds(guildId, resolved.userId);
          const others = linkedIds.filter(id => id !== resolved.userId);

          if (others.length === 0) {
            return ok({ userId: resolved.userId, label: resolved.label, linkedAccounts: [] });
          }

          // Enrichir avec les profils
          const profiles = await prisma.memberProfile.findMany({
            where: { guildId, userId: { in: others } },
            select: { userId: true, username: true, displayName: true },
          });
          const profileMap = new Map(profiles.map(p => [p.userId, p]));

          return ok({
            userId: resolved.userId,
            label: resolved.label,
            linkedAccounts: others.map(id => ({
              userId: id,
              username: profileMap.get(id)?.username ?? null,
              displayName: profileMap.get(id)?.displayName ?? null,
            })),
          });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    // unlink_accounts - Supprimer le lien entre deux comptes
    server.registerTool(
      'unlink_accounts',
      {
        description: "Supprime le lien entre deux comptes doubles. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member1: z.string().describe('Nom, surnom, @mention ou ID Discord du premier compte'),
          member2: z.string().describe('Nom, surnom, @mention ou ID Discord du deuxième compte'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member1, member2, key_name }) => {
        const r1 = await resolveMember(guildId, member1);
        if (!r1.ok) return r1.response;
        const r2 = await resolveMember(guildId, member2);
        if (!r2.ok) return r2.response;

        try {
          const result = await unlinkAccounts(guildId, r1.userId, r2.userId);

          if (result.count === 0) {
            return err(`Aucun lien trouvé entre ${r1.label} et ${r2.label}.`);
          }

          await audit(key_name, 'Suppression liaison MCP', `${r1.label} ↔ ${r2.label}`, `IDs: ${r1.userId} / ${r2.userId}`);
          return ok({ ok: true, removed: result.count, user1: r1.userId, user2: r2.userId });
        } catch (e) {
          return toolError(e, 'Erreur lors de la suppression du lien');
        }
      })
    );
  }
}
