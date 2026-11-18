import { Hono } from 'hono';
import type { Client } from 'discord.js';
/** Routes dashboard du module `settings`. */
import { applyRegulationLock } from '../../../../services/staff/regulationService.js';
import { cache } from '../../../../utils/cache.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { extractDiscordSnowflake, getGuildName, getOrCreateRuntime, pushAudit } from '../../../shared.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
export function createSettingsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.on(['PATCH', 'PUT'], `${base}/settings`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        discordChannel?: string;
        logChannelId?: string | null;
        logIgnoredChannelIds?: unknown;
        moderatorRoleId?: string | null;
        sanctionAlertChannelId?: string | null;
        regulationChannelId?: string | null;
        propagateSanctions?: boolean;
        crossServerSanctionsEnabled?: boolean;
        messageTemplate?: string;
        sidebarFavorites?: unknown;
        configChannelId?: string | null;
        publicChannelId?: string | null;
        newsChannelId?: string | null;
        digestChannelId?: string | null;
        meetingAnnouncementChannelId?: string | null;
        meetingVoiceChannelId?: string | null;
        baseStaffRoleId?: string | null;
        testStaffRoleId?: string | null;
        translationEnabled?: boolean;
        codePoliceEnabled?: boolean;
        analyticsEnabled?: boolean;
        githubReleasesEnabled?: boolean;
        digestEnabled?: boolean;
        youtubeEnabled?: boolean;
        autoThreadEnabled?: boolean;
        twitchEnabled?: boolean;
        socialNetworksEnabled?: boolean;
        regulationVerificationEnabled?: boolean;
        regulationRoleId?: string | null;
        regulationLockEnabled?: boolean;
        sanctionReportEnabled?: boolean;
        sanctionReportSkipBots?: boolean;
      }>(c);

      if (!body) {
        return send(c, { error: 'Payload settings invalide' }, 400);
      }

      const oldGuild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          regulationVerificationEnabled: true,
          regulationRoleId: true,
          regulationLockEnabled: true,
          regulationChannelId: true,
        },
      });

      const data: Record<string, unknown> = {};
      let applyLockChanged = false;
      if (Object.prototype.hasOwnProperty.call(body, 'discordChannel')) {
        data.statusCheckChannelId = extractDiscordSnowflake(body.discordChannel);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'logChannelId')) {
        data.logChannelId = extractDiscordSnowflake(body.logChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'logIgnoredChannelIds')) {
        if (!Array.isArray(body.logIgnoredChannelIds)) {
          return send(c, { error: 'logIgnoredChannelIds doit être un tableau de salons.' }, 400);
        }
        const ids = body.logIgnoredChannelIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => extractDiscordSnowflake(id))
          .filter((id): id is string => !!id);
        data.logIgnoredChannelIds = [...new Set(ids)];
      }
      if (Object.prototype.hasOwnProperty.call(body, 'moderatorRoleId')) {
        data.moderatorRoleId = extractDiscordSnowflake(body.moderatorRoleId);
      }
      // Le salon ou tombent sanctions, signalements et alertes de raid. La
      // colonne existait et la liste de prise en main la reclamait deja ; aucune
      // route ne l'ecrivait, ce qui laissait une case impossible a cocher.
      if (Object.prototype.hasOwnProperty.call(body, 'sanctionAlertChannelId')) {
        data.sanctionAlertChannelId = extractDiscordSnowflake(body.sanctionAlertChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationChannelId')) {
        data.regulationChannelId = extractDiscordSnowflake(body.regulationChannelId);
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationVerificationEnabled')) {
        data.regulationVerificationEnabled = !!body.regulationVerificationEnabled;
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationRoleId')) {
        data.regulationRoleId = extractDiscordSnowflake(body.regulationRoleId);
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationLockEnabled')) {
        data.regulationLockEnabled = !!body.regulationLockEnabled;
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'propagateSanctions')) {
        data.propagateSanctions = !!body.propagateSanctions;
        data.sanctionSyncEnabled = !!body.propagateSanctions;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'crossServerSanctionsEnabled')) {
        data.crossServerSanctionsEnabled = !!body.crossServerSanctionsEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sanctionReportEnabled')) {
        data.sanctionReportEnabled = !!body.sanctionReportEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sanctionReportSkipBots')) {
        data.sanctionReportSkipBots = !!body.sanctionReportSkipBots;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'analyticsEnabled')) {
        data.analyticsEnabled = !!body.analyticsEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'configChannelId')) {
        data.configChannelId = extractDiscordSnowflake(body.configChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'publicChannelId')) {
        data.publicChannelId = extractDiscordSnowflake(body.publicChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'newsChannelId')) {
        data.newsChannelId = extractDiscordSnowflake(body.newsChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'digestChannelId')) {
        data.digestChannelId = extractDiscordSnowflake(body.digestChannelId);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'meetingAnnouncementChannelId')) {
        data.meetingAnnouncementChannelId = extractDiscordSnowflake(body.meetingAnnouncementChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'meetingVoiceChannelId')) {
        data.meetingVoiceChannelId = extractDiscordSnowflake(body.meetingVoiceChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'baseStaffRoleId')) {
        data.baseStaffRoleId = extractDiscordSnowflake(body.baseStaffRoleId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'testStaffRoleId')) {
        data.testStaffRoleId = extractDiscordSnowflake(body.testStaffRoleId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'translationEnabled')) {
        data.translationEnabled = !!body.translationEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'codePoliceEnabled')) {
        data.codePoliceEnabled = !!body.codePoliceEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'githubReleasesEnabled')) {
        data.githubReleasesEnabled = !!body.githubReleasesEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'digestEnabled')) {
        data.digestEnabled = !!body.digestEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
        data.autoThreadEnabled = !!body.autoThreadEnabled;
      }

      if (Object.keys(data).length > 0) {
        await prisma.guild.update({ where: { id: guildId }, data });
        // La ligne du serveur est servie depuis `getCachedGuild` par le bot
        // comme par le controle d'acces du dashboard : sans purge, un reglage
        // enregistre ici restait sans effet jusqu'a l'expiration du cache.
        await cache.invalidateGuild(guildId);
      }

      if (applyLockChanged) {
        const finalGuild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            regulationVerificationEnabled: true,
            regulationRoleId: true,
            regulationLockEnabled: true,
            regulationChannelId: true,
          },
        });
        if (finalGuild) {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (discordGuild) {
            let verifiedRoleId = finalGuild.regulationRoleId;
            if (finalGuild.regulationVerificationEnabled && !verifiedRoleId) {
              let role = discordGuild.roles.cache.find((r) => r.name === 'Vérifié') ?? null;
              if (!role) {
                try {
                  role = await discordGuild.roles.create({
                    name: 'Vérifié',
                    reason: 'Créé automatiquement pour le règlement du serveur.',
                  });
                } catch (err) {
                  logger.error('SettingsAPI', `Impossible de créer le rôle 'Vérifié' :`, err);
                }
              }
              if (role) {
                verifiedRoleId = role.id;
                await prisma.guild.update({
                  where: { id: guildId },
                  data: { regulationRoleId: role.id },
                });
              }
            }

            const oldLocked = !!(oldGuild?.regulationVerificationEnabled && oldGuild?.regulationLockEnabled);
            const newLocked = !!(finalGuild.regulationVerificationEnabled && finalGuild.regulationLockEnabled);
            const lockStateChanged = oldLocked !== newLocked;
            const roleChanged = oldGuild?.regulationRoleId !== finalGuild.regulationRoleId;
            const channelChanged = oldGuild?.regulationChannelId !== finalGuild.regulationChannelId;

            if (verifiedRoleId && finalGuild.regulationChannelId && (lockStateChanged || roleChanged || channelChanged)) {
              // Run in background to prevent API timeout / rate limit blocks
              applyRegulationLock(
                discordGuild,
                verifiedRoleId,
                finalGuild.regulationChannelId,
                newLocked
              ).catch((err) => {
                logger.error('SettingsAPI', `Error in applyRegulationLock background task:`, err);
              });
            }
          }
        }
      }

      // Les valeurs viennent de l'accumulateur `data`, alimente champ par champ
      // depuis le corps de requete : on les normalise ici plutot qu'a chacun des
      // ~20 appels.
      const syncFeature = async (featureKey: string, featureName: string, rawEnabled?: unknown, rawChannelId?: unknown, rawSecondaryChannelId?: unknown) => {
        const enabled = typeof rawEnabled === 'boolean' ? rawEnabled : undefined;
        const channelId = rawChannelId === undefined ? undefined : (typeof rawChannelId === 'string' ? rawChannelId : null);
        const secondaryChannelId = rawSecondaryChannelId === undefined ? undefined : (typeof rawSecondaryChannelId === 'string' ? rawSecondaryChannelId : null);

        const updateData: Record<string, unknown> = {};
        if (enabled !== undefined) updateData.enabled = enabled;
        if (channelId !== undefined) updateData.channelId = channelId;
        if (secondaryChannelId !== undefined) updateData.secondaryChannelId = secondaryChannelId;

        if (Object.keys(updateData).length > 0) {
          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey } },
            create: {
              guildId,
              featureKey,
              featureName,
              enabled: enabled ?? true,
              channelId: channelId ?? null,
              secondaryChannelId: secondaryChannelId ?? null,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
            },
            update: updateData,
          });
        }
      };

      await syncFeature('digest', 'Digest', data.digestEnabled, data.digestChannelId, undefined);
      await syncFeature('translation', 'Translation', data.translationEnabled, undefined, undefined);
      await syncFeature('codepolice', 'Code Police', data.codePoliceEnabled, undefined, undefined);
      await syncFeature('logs', 'Logs Discord', undefined, data.logChannelId, undefined);
      await syncFeature('regulation', 'Règlement', undefined, data.regulationChannelId, undefined);
      await syncFeature('meetings', 'Réunions', undefined, data.meetingAnnouncementChannelId, data.meetingVoiceChannelId);
      await syncFeature('settings', 'Paramètres', undefined, data.configChannelId, undefined);
      await syncFeature('dashboard', "Vue d'ensemble", undefined, data.publicChannelId, undefined);
      await syncFeature('news', 'Actualités & RSS', undefined, data.newsChannelId, undefined);
      await syncFeature('auto_thread', 'Auto-Thread', data.autoThreadEnabled, undefined, undefined);
      
      if (body.youtubeEnabled !== undefined) {
        await syncFeature('youtube', 'YouTube', body.youtubeEnabled, undefined, undefined);
      }

      if (body.twitchEnabled !== undefined) {
        await syncFeature('twitch', 'Twitch', body.twitchEnabled, undefined, undefined);
      }

      if (body.socialNetworksEnabled !== undefined) {
        await syncFeature('social_networks', 'Réseaux Sociaux', body.socialNetworksEnabled, undefined, undefined);
      }

      const _runtime = await getOrCreateRuntime(guildId);
      const dashboardSettingsPatch: { messageTemplate?: string; sidebarFavorites?: string[] } = {};
      if (typeof body.messageTemplate === 'string') {
        dashboardSettingsPatch.messageTemplate = body.messageTemplate;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'sidebarFavorites')) {
        if (!Array.isArray(body.sidebarFavorites)) {
          return send(c, { error: 'sidebarFavorites doit être un tableau de chemins.' }, 400);
        }

        dashboardSettingsPatch.sidebarFavorites = body.sidebarFavorites
          .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'))
          .map((entry) => entry.trim())
          .filter((entry, index, arr) => entry.length > 0 && arr.indexOf(entry) === index)
          .slice(0, 80);
      }

      if (Object.keys(dashboardSettingsPatch).length > 0) {
        await prisma.dashboardSettings.update({
          where: { guildId },
          data: dashboardSettingsPatch
        });
      }

      // Les favoris de la barre laterale sont une preference d'interface, resynchronisee
      // a chaque changement de serveur : ils ne meritent pas une ligne d'audit.
      const onlySidebarFavorites = Object.keys(body).every((key) => key === 'sidebarFavorites');
      if (!onlySidebarFavorites) {
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Sauvegarde paramètres globaux',
          context: getGuildName(client, guildId),
          module: 'Dashboard',
          eventType: 'Manuel',
          details: 'Paramètres globaux mis à jour.',
          channelId: null
        });
      }

      return send(c, { ok: true });
    } catch (err) {
      logger.error('SettingsAPI', 'Error updating settings:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des paramètres', 'SettingsAPI');
    }
  });

  return router;
}

