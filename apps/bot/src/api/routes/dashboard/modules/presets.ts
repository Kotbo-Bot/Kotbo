/** Routes dashboard du module `presets`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { cache } from '../../../../utils/cache.js';
import { logger } from '../../../../utils/logger.js';
import { type DashboardPresetKey, getGuildName, pushAudit, resolveFeatureAccessMap } from '../../../shared.js';
import { Prisma } from '@prisma/client';
import { PermissionFlagsBits } from 'discord.js';
import { PRESET_LABELS, buildCommandRestrictionsForPreset, buildModuleUpdatesForPreset } from './_shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

export function createPresetsRouter(client: Client) {
  const router = new Hono();

  router.post('/api/dashboard/guilds/:guildId/presets', ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
  try {
    const body = await readBody<{ presetKey?: string }>(c);
    const presetKey = (body?.presetKey ?? '').trim() as DashboardPresetKey;

    if (!presetKey || !Object.keys(PRESET_LABELS).includes(presetKey)) {
      return send(c, { error: 'Preset invalide.' }, 400);
    }

    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) {
      return send(c, { error: 'Serveur introuvable.' }, 404);
    }

    const member = await discordGuild.members.fetch(user.userId).catch(() => null);
    const roleIds = member
      ? member.roles.cache
          .map((role) => role?.id)
          .filter((roleId): roleId is string => !!roleId)
      : [];
    const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

    if (!access.canManageSettings && !(featureAccess.modules?.canConfigure && featureAccess.commands?.canConfigure)) {
      return send(c, { error: 'Accès refusé. Permissions insuffisantes.' }, 403);
    }

    const guildConfig = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { moderatorRoleId: true },
    });

    const adminRoleIds = discordGuild.roles.cache
      .filter((role) => !!role && role.permissions.has(PermissionFlagsBits.Administrator))
      .map((role) => role.id);
    const modRoleIds = discordGuild.roles.cache
      .filter((role) => !!role && (role.permissions.has(PermissionFlagsBits.ModerateMembers)
        || role.permissions.has(PermissionFlagsBits.ManageMessages)
        || role.permissions.has(PermissionFlagsBits.KickMembers)
        || role.permissions.has(PermissionFlagsBits.BanMembers)))
      .map((role) => role.id);

    const moduleUpdates = buildModuleUpdatesForPreset(presetKey);
    const commandRestrictions = buildCommandRestrictionsForPreset(presetKey, {
      moderatorRoleId: guildConfig?.moderatorRoleId ?? null,
      adminRoleIds,
      fallbackUserId: user.userId,
      modRoleIds,
    });

    const { applyPresetToFeatureAccess } = await import('../../../../services/core/dashboardManagementService.js');
    await applyPresetToFeatureAccess(guildId, presetKey, { adminRoleIds, modRoleIds });

    await prisma.$transaction([
      prisma.guild.update({ where: { id: guildId }, data: moduleUpdates }),
      prisma.dashboardSettings.update({ where: { guildId }, data: { commandRestrictions: commandRestrictions as unknown as Prisma.InputJsonValue } }),
    ]);

    // Les acces et les etats de modules vivent tous deux sous le prefixe
    // `guild:`. Un preset reecrit les deux d'un coup : sans purge, il
    // s'appliquait a retardement, jusqu'a une minute apres le clic.
    await cache.invalidateGuild(guildId);

    await pushAudit(guildId, {
      user: auditUserOf(c),
      action: 'Application preset',
      context: getGuildName(client, guildId),
      module: 'Dashboard',
      eventType: 'Manuel',
      details: `Preset appliqué : ${PRESET_LABELS[presetKey]}.`,
      channelId: null,
    });

    return send(c, { ok: true });
  } catch (err) {
    logger.error('PresetsAPI', 'Error applying preset:', err);
    return fail(c, err, "Erreur lors de l'application du preset", 'PresetsAPI');
  }
  });

  return router;
}
