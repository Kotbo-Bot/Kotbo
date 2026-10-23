/** Outils MCP - write members (permission WRITE_MEMBERS). */
import { guardAdminGrant, roleGrantsAdministrator } from '../../../services/moderation/adminLockService.js';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, SNOWFLAKE, err, ok, resolveMember, publicErrorMessage } from '../toolkit.js';
import { memberProfileIdentity } from '../../../services/moderation/memberIdentityService.js';

export function registerWriteMembersTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'set_member_note',
      {
        description: "Définit ou met à jour la note de modération sur le profil d'un membre. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          note: z.string().max(1000).describe('Note de modération (vide pour effacer)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, note, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        // Profil encore absent : on lui pose son identité Discord plutôt que de
        // créer une ligne anonyme, illisible dans la liste des membres.
        const noteGuild = client.guilds.cache.get(guildId);
        const noteMember = noteGuild
          ? noteGuild.members.cache.get(resolved.userId) ?? await noteGuild.members.fetch(resolved.userId).catch(() => null)
          : null;

        await prisma.memberProfile.upsert({
          where: { guildId_userId: { guildId, userId: resolved.userId } },
          update: { moderatorNote: note || null },
          create: {
            guildId,
            userId: resolved.userId,
            ...(noteMember ? memberProfileIdentity(noteMember) : {}),
            moderatorNote: note || null,
            lastSeenAt: new Date(),
          },
        });

        await audit(key_name, 'Note modérateur MCP', `Membre: ${resolved.label} (${resolved.userId})`, note.slice(0, 200) || '(note effacée)');

        return ok({ ok: true, userId: resolved.userId, note: note || null });
      })
    );

    server.registerTool(
      'add_role',
      {
        description: "Ajoute un rôle Discord à un membre. Requiert la permission WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          role: z.string().describe('Nom ou ID du rôle à ajouter'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, role, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const target = await guild.members.fetch(resolved.userId).catch(() => null);
        if (!target) return err('Membre introuvable sur le serveur Discord');

        const roleId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = roleId
          ? guild.roles.cache.get(roleId)
          : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

        if (!discordRole) return err(`Rôle « ${role} » introuvable`);

        if (target.roles.cache.has(discordRole.id)) {
          return err(`${resolved.label} a déjà le rôle ${discordRole.name}`);
        }

        if (roleGrantsAdministrator(discordRole.permissions.bitfield)) {
          const guardResult = await guardAdminGrant({
            client,
            guild,
            actorId: null,
            requestedVia: 'MCP',
            type: 'MEMBER_ROLE_GRANT',
            permissionBits: discordRole.permissions.bitfield,
            targetRoleId: discordRole.id,
            targetRoleName: discordRole.name,
            targetMemberId: resolved.userId,
            requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
          });
          if (guardResult.blocked) {
            await audit(key_name, 'Ajout rôle MCP - bloqué (Admin Lock)', `Membre: ${resolved.label}`, `Rôle: ${discordRole.name} - demande ${guardResult.requestId}`);
            return ok({
              ok: true,
              pendingApproval: true,
              requestId: guardResult.requestId,
              message: "Ce rôle donne ADMINISTRATOR : une demande d'approbation a été envoyée au propriétaire du serveur / rôles sécurité.",
            });
          }
        }

        await target.roles.add(discordRole).catch((e) => {
          throw new Error(`Impossible d'ajouter le rôle : ${publicErrorMessage(e)}`);
        });

        await audit(key_name, 'Ajout rôle MCP', `Membre: ${resolved.label}`, `Rôle: ${discordRole.name}`);

        return ok({ ok: true, userId: resolved.userId, roleName: discordRole.name, roleId: discordRole.id });
      })
    );

    server.registerTool(
      'remove_role',
      {
        description: "Retire un rôle Discord d'un membre. Requiert la permission WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          role: z.string().describe('Nom ou ID du rôle à retirer'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, role, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const target = await guild.members.fetch(resolved.userId).catch(() => null);
        if (!target) return err('Membre introuvable sur le serveur Discord');

        const roleId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = roleId
          ? guild.roles.cache.get(roleId)
          : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

        if (!discordRole) return err(`Rôle « ${role} » introuvable`);

        if (!target.roles.cache.has(discordRole.id)) {
          return err(`${resolved.label} n'a pas le rôle ${discordRole.name}`);
        }

        await target.roles.remove(discordRole).catch((e) => {
          throw new Error(`Impossible de retirer le rôle : ${publicErrorMessage(e)}`);
        });

        await audit(key_name, 'Retrait rôle MCP', `Membre: ${resolved.label}`, `Rôle: ${discordRole.name}`);

        return ok({ ok: true, userId: resolved.userId, roleName: discordRole.name, roleId: discordRole.id });
      })
    );

    server.registerTool(
      'get_member_level',
      {
        description: "Récupère le niveau et l'XP d'un membre dans le système de leveling.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const level = await prisma.memberLevel.findUnique({
          where: { guildId_userId: { guildId, userId: resolved.userId } },
        });

        if (!level) return err('Aucune donnée de niveau pour ce membre.');

        const rewards = await prisma.levelRoleReward.findMany({
          where: { guildId, level: { lte: level.level } },
          orderBy: { level: 'asc' },
        });

        return ok({
          userId: resolved.userId,
          name: resolved.label,
          level: level.level,
          xp: level.xp,
          lastXpGain: level.lastXpGain?.toISOString() ?? null,
          unlockedRewards: rewards.map((r) => ({ level: r.level, roleId: r.roleId })),
        });
      })
    );

    server.registerTool(
      'get_invite_stats',
      {
        description: "Statistiques d'invitations d'un membre (nombre d'invités, codes utilisés).",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const [invites, invited] = await Promise.all([
          prisma.guildInvite.findMany({
            where: { guildId, inviterId: resolved.userId },
            select: { code: true, uses: true, createdAt: true },
          }),
          prisma.memberInvite.findMany({
            where: { guildId, inviterId: resolved.userId },
            select: { userId: true, joinedAt: true, leftAt: true },
          }),
        ]);

        const active = invited.filter((i) => !i.leftAt).length;
        const left = invited.filter((i) => i.leftAt).length;

        return ok({
          userId: resolved.userId,
          name: resolved.label,
          totalInvited: invited.length,
          activeInvited: active,
          leftInvited: left,
          inviteCodes: invites.map((i) => ({
            code: i.code,
            usedCount: i.uses,
            createdAt: i.createdAt.toISOString(),
          })),
        });
      })
    );
  }
}
