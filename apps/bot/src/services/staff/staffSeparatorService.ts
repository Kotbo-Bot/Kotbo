import { Client, PermissionFlagsBits } from 'discord.js';
import { staffSeparatorName, isStaffSeparatorStyle } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { UserFacingError } from '../../utils/userFacingError.js';

const LOG_TAG = 'StaffSeparators';

export type StaffSeparatorResult = {
  hierarchyId: string;
  name: string;
  status: 'created' | 'updated' | 'moved' | 'ok' | 'skipped' | 'failed';
  reason?: string;
};

/**
 * Pose, pour chaque hiérarchie qui en a un, le rôle séparateur juste au-dessus de son grade le plus haut.
 * Rôle auto (separatorStyle) : créé s'il manque, renommé s'il a dérivé. Rôle existant : jamais renommé.
 * Rejouable : ne touche à Discord que si le nom ou la position diffèrent.
 */
export async function applyStaffSeparators(client: Client, guildId: string): Promise<StaffSeparatorResult[]> {
  const hierarchies = await prisma.staffHierarchy.findMany({
    where: { guildId, enabled: true, OR: [{ separatorStyle: { not: null } }, { separatorRoleId: { not: null } }] },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true, name: true, discordRoleId: true, separatorRoleId: true, separatorStyle: true,
      roles: { where: { enabled: true, discordRoleId: { not: null } }, select: { discordRoleId: true } },
    },
  });

  if (hierarchies.length === 0) return [];

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return [];
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new UserFacingError('Hiérarchie : le bot doit avoir la permission « Gérer les rôles ».');
  }

  const results: StaffSeparatorResult[] = [];
  for (const h of hierarchies) {
    const base = { hierarchyId: h.id, name: h.name };
    try {
      // Cache relu à chaque tour : créer ou déplacer un rôle décale tous les autres.
      await guild.roles.fetch();
      const style = isStaffSeparatorStyle(h.separatorStyle) ? h.separatorStyle : null;
      const wantedName = style ? staffSeparatorName(style, h.name) : null;
      let role = h.separatorRoleId ? guild.roles.cache.get(h.separatorRoleId) ?? null : null;
      let status: StaffSeparatorResult['status'] = 'ok';

      if (!role && style && wantedName) {
        role = await guild.roles.create({ name: wantedName, permissions: [], hoist: false, mentionable: false, reason: 'Séparateur de hiérarchie staff' });
        await prisma.staffHierarchy.update({ where: { id: h.id }, data: { separatorRoleId: role.id } });
        status = 'created';
      } else if (!role) {
        // Rôle existant supprimé côté Discord : on oublie la référence plutôt que de la garder cassée.
        await prisma.staffHierarchy.update({ where: { id: h.id }, data: { separatorRoleId: null } });
        results.push({ ...base, status: 'skipped', reason: 'role_missing' });
        continue;
      } else if (wantedName && role.name !== wantedName) {
        await role.setName(wantedName, 'Séparateur de hiérarchie staff');
        status = 'updated';
      }

      const ids = new Set([h.discordRoleId, ...h.roles.map((r) => r.discordRoleId)].filter((id): id is string => !!id && id !== role!.id));
      const tops = [...ids].map((id) => guild.roles.cache.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      if (tops.length === 0) { results.push({ ...base, status: status === 'ok' ? 'skipped' : status, reason: status === 'ok' ? 'no_grade_role' : undefined }); continue; }

      const target = Math.max(...tops.map((r) => r.position)) + 1;
      if (role.position !== target) {
        await role.setPosition(target, { reason: 'Séparateur de hiérarchie staff' });
        status = status === 'ok' ? 'moved' : status;
      }
      results.push({ ...base, status });
    } catch (err) {
      logger.warn(LOG_TAG, `Séparateur de « ${h.name} » non appliqué sur ${guildId}:`, err);
      // Cause la plus courante : un grade de la hiérarchie est au-dessus du rôle du bot.
      results.push({ ...base, status: 'failed', reason: 'discord_error' });
    }
  }
  return results;
}
