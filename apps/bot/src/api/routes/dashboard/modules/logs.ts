/** Routes dashboard du module `logs`. */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { EmbedBuilder, type Client, type Guild } from 'discord.js';
import { LOG_EVENT_TYPES, getLogEventDefinition, isLogEventType, type LogEventType } from '@kotbo/shared';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { cache } from '../../../../utils/cache.js';
import { resolveEventLogChannel } from '../../../../utils/logDispatch.js';
import { getGuildName, pushAudit, resolveFeatureAccessMap } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

type ModuleChannels = Partial<Record<LogEventType, string | null>>;

/**
 * Salons que les modules ont déjà réglés de leur côté.
 *
 * Ils restent prioritaires sur le choix fait dans la page Journaux (voir
 * `routeLogEvent`) : sans cette réponse, la page afficherait un salon de
 * destination où rien n'arrive jamais.
 */
async function readModuleChannels(guildId: string): Promise<ModuleChannels> {
  const [guild, spam, raid, tag, aegis, automod] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId }, select: { verificationLogChannelId: true } }),
    prisma.spamDetectionConfig.findUnique({ where: { guildId }, select: { alertChannelId: true } }),
    prisma.raidProtectionConfig.findUnique({ where: { guildId }, select: { scamFilterAlertChannelId: true, captchaLogChannelId: true } }),
    prisma.tagAutomodConfig.findUnique({ where: { guildId }, select: { alertChannelId: true } }),
    prisma.aegisConfig.findUnique({ where: { guildId }, select: { reviewChannelId: true } }),
    prisma.autoModConfig.findUnique({ where: { guildId }, select: { adminLockNotifyChannelId: true } }),
  ]);
  return {
    automod_spam: spam?.alertChannelId ?? null,
    vision_blocked: raid?.scamFilterAlertChannelId ?? null,
    security_captcha: raid?.captchaLogChannelId ?? null,
    automod_tag: tag?.alertChannelId ?? null,
    aegis_alert: aegis?.reviewChannelId ?? null,
    security_admin_lock: automod?.adminLockNotifyChannelId ?? null,
    alt_detection: guild?.verificationLogChannelId ?? null,
    alt_validation: guild?.verificationLogChannelId ?? null,
    verification_warn_threshold: guild?.verificationLogChannelId ?? null,
  };
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Le salon dédié doit être un salon textuel de CE serveur. Sans ce contrôle,
 * l'identifiant venu du dashboard pouvait désigner le salon d'un autre serveur
 * où le bot écrit, et y déverser les journaux de celui-ci.
 */
function isGuildTextChannel(guild: Guild | null, channelId: string): boolean {
  if (!guild) return false;
  const channel = guild.channels.cache.get(channelId);
  return !!channel && channel.isTextBased() && !channel.isThread();
}

export function createLogsRouter(client: Client) {
  const router = new Hono();
  const path = '/api/dashboard/guilds/:guildId/logs/event-configs';

  const logsAccess = createMiddleware(async (c, next) => {
    const guildId = c.req.param('guildId')!;
    const userId = c.var.dashboardUser.userId;
    const access = c.var.effectiveAccess;
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
    const roleIds = member
      ? member.roles.cache
        .map((role) => role?.id)
        .filter((roleId): roleId is string => !!roleId)
      : [];
    const featureAccess = await resolveFeatureAccessMap(client, guildId, access, userId, roleIds);

    const isGetMethod = c.req.method === 'GET';
    if (!isGetMethod && !access.canManageSettings && !featureAccess.logs?.canConfigure) {
      return send(c, { error: 'Accès refusé. Seuls les administrateurs peuvent modifier les logs.' }, 403);
    }
    if (isGetMethod && !access.canViewDashboard) {
      return send(c, { error: "Accès refusé. Vous n'avez pas accès au dashboard." }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), logsAccess] as const;

  router.get(path, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const existingConfigs = await prisma.guildLogEventConfig.findMany({ where: { guildId } });
      const existing = new Set(existingConfigs.map((cfg) => cfg.eventType));
      const missingTypes = LOG_EVENT_TYPES.filter((t) => !existing.has(t));

      // Un type absent de la base est publié (voir `logEventConfig.ts`) : la
      // ligne créée ici ne change donc rien au comportement, elle le rend
      // seulement visible et réglable.
      if (missingTypes.length > 0) {
        await prisma.guildLogEventConfig.createMany({
          data: missingTypes.map((eventType) => ({ guildId, eventType, enabled: true, channelId: null })),
          skipDuplicates: true,
        });
      }

      const [allConfigs, moduleChannels] = await Promise.all([
        prisma.guildLogEventConfig.findMany({
          where: { guildId, eventType: { in: [...LOG_EVENT_TYPES] } },
          select: { eventType: true, enabled: true, channelId: true },
          orderBy: { eventType: 'asc' },
        }),
        readModuleChannels(guildId),
      ]);
      return send(c, { configs: allConfigs, moduleChannels });
    } catch (err) {
      logger.error('LogsConfigAPI', 'Error fetching logs event configs:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration des événements', 'LogsConfigAPI');
    }
  });

  router.put(path, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ configs?: unknown }>(c);
      if (!body?.configs || !Array.isArray(body.configs)) {
        return send(c, { error: 'Format invalide. Liste de configurations attendue.' }, 400);
      }

      const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      const previous = await prisma.guildLogEventConfig.findMany({
        where: { guildId },
        select: { eventType: true, enabled: true, channelId: true },
      });
      const before = new Map(previous.map((cfg) => [cfg.eventType, cfg]));
      const seen = new Set<string>();
      const configs: Array<{ eventType: LogEventType; enabled: boolean; channelId: string | null }> = [];

      for (const raw of body.configs as Array<Record<string, unknown>>) {
        const eventType = raw?.eventType;
        if (!isLogEventType(eventType)) {
          return send(c, { error: `Type de journal inconnu : ${String(eventType)}.` }, 400);
        }
        if (seen.has(eventType)) {
          return send(c, { error: `Type de journal en double : ${eventType}.` }, 400);
        }
        seen.add(eventType);
        if (typeof raw.enabled !== 'boolean') {
          return send(c, { error: `« enabled » doit être un booléen (${eventType}).` }, 400);
        }
        const channelId = raw.channelId === null || raw.channelId === undefined || raw.channelId === ''
          ? null
          : String(raw.channelId);
        // Seul un salon qui change est contrôlé : un salon déjà enregistré puis
        // supprimé de Discord ne doit pas bloquer l'enregistrement des autres
        // types, renvoyés tels quels par la page.
        if (channelId !== null && channelId !== (before.get(eventType)?.channelId ?? null)) {
          if (!SNOWFLAKE.test(channelId)) {
            return send(c, { error: `Salon invalide pour ${eventType}.` }, 400);
          }
          if (!isGuildTextChannel(discordGuild, channelId)) {
            return send(c, { error: `Le salon choisi pour ${eventType} n'est pas un salon textuel de ce serveur.` }, 400);
          }
        }
        configs.push({ eventType, enabled: raw.enabled, channelId });
      }

      const changed = configs.filter((cfg) => {
        const old = before.get(cfg.eventType);
        return !old || old.enabled !== cfg.enabled || (old.channelId ?? null) !== cfg.channelId;
      });

      if (changed.length === 0) return send(c, { ok: true, changed: 0 });

      await prisma.$transaction(
        changed.map((cfg) => prisma.guildLogEventConfig.upsert({
          where: { guildId_eventType: { guildId, eventType: cfg.eventType } },
          update: { enabled: cfg.enabled, channelId: cfg.channelId },
          create: { guildId, eventType: cfg.eventType, enabled: cfg.enabled, channelId: cfg.channelId },
        })),
      );

      // Sans ca, le bot applique l ancienne configuration jusqu a expiration
      // du cache : soixante secondes de comportement garanti faux apres
      // chaque sauvegarde. Efface aussi les entrees d absence de ligne.
      await cache.invalidateGuild(guildId);

      // Les alertes AutoMod natives sont postées par Discord, dans le salon
      // inscrit sur chaque règle : il faut réécrire les règles pour que le
      // nouveau réglage s'applique. En arrière-plan, comme ailleurs : la
      // synchronisation réclame « Gérer le serveur » et ne doit pas faire
      // échouer l'enregistrement.
      if (changed.some((cfg) => getLogEventDefinition(cfg.eventType)?.native)) {
        void import('../../../../services/moderation/autoModService.js')
          .then(async ({ getOrCreateAutoModConfig, invalidateAutoModCache, syncDiscordAutoModRules, syncDiscordAutoModProfileRule }) => {
            invalidateAutoModCache(guildId);
            await syncDiscordAutoModRules(client, guildId, await getOrCreateAutoModConfig(guildId));
            await syncDiscordAutoModProfileRule(client, guildId);
          })
          .catch((err) => logger.warn('LogsConfigAPI', `Resynchronisation AutoMod native impossible sur ${guildId} :`, err));
      }

      const disabled = changed.filter((cfg) => !cfg.enabled).map((cfg) => cfg.eventType);
      const enabled = changed.filter((cfg) => cfg.enabled && !before.get(cfg.eventType)?.enabled).map((cfg) => cfg.eventType);
      const rerouted = changed.filter((cfg) => cfg.enabled && (before.get(cfg.eventType)?.channelId ?? null) !== cfg.channelId).map((cfg) => cfg.eventType);
      const details = [
        enabled.length ? `Activés : ${enabled.join(', ')}` : null,
        disabled.length ? `Coupés : ${disabled.join(', ')}` : null,
        rerouted.length ? `Salon modifié : ${rerouted.join(', ')}` : null,
      ].filter(Boolean).join(' | ');

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Mise à jour configuration logs granulaires',
        context: getGuildName(client, guildId),
        module: 'Logs',
        eventType: 'Manuel',
        details: details || 'Configuration par événement mise à jour.',
        channelId: null,
      });

      return send(c, { ok: true, changed: changed.length });
    } catch (err) {
      logger.error('LogsConfigAPI', 'Error updating logs event configs:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration des événements', 'LogsConfigAPI');
    }
  });

  /**
   * Envoie un message d'essai là où partirait un vrai journal de ce type.
   *
   * Passe par le même routage que le bot (`resolveEventLogChannel`) : un essai
   * réussi prouve le salon ET la permission d'y écrire, ce qu'aucun aperçu côté
   * dashboard ne peut garantir. Teste la configuration enregistrée.
   */
  router.post(`${path}/:eventType/test`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const eventType = c.req.param('eventType');
    if (!isLogEventType(eventType)) {
      return send(c, { error: 'Type de journal inconnu.' }, 400);
    }
    try {
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return send(c, { error: 'Serveur introuvable.' }, 404);

      const moduleChannelId = (await readModuleChannels(guildId))[eventType] ?? null;
      const channel = await resolveEventLogChannel(guild, eventType, 'LogsTest', { moduleChannelId });
      if (!channel) {
        return send(c, { error: "Aucun salon utilisable : le type est coupé, ou aucun salon n'est configuré.", reason: 'no_channel' }, 409);
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🧪 Message de test')
        .setDescription(`Les journaux \`${eventType}\` arriveront dans ce salon.`)
        .setFooter({ text: `Test demandé par ${auditUserOf(c)} depuis le dashboard` })
        .setTimestamp();

      const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
      if (!sent) {
        return send(c, { error: "Kotbo n'a pas pu écrire dans ce salon : vérifie ses permissions (voir le salon, envoyer des messages, intégrer des liens).", reason: 'send_failed', channelId: channel.id }, 409);
      }
      return send(c, { ok: true, channelId: channel.id });
    } catch (err) {
      logger.error('LogsConfigAPI', 'Error sending test log:', err);
      return fail(c, err, "Erreur lors de l'envoi du message de test", 'LogsConfigAPI');
    }
  });

  return router;
}
