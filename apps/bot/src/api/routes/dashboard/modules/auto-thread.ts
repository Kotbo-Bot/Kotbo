/** Routes dashboard du module `auto-thread`. */
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ChannelType, type Client } from 'discord.js';
import { Prisma, type AutoThreadConfig } from '@prisma/client';
import { normalizeAutoThreadConfig, type AutoThreadConfigError } from '@kotbo/shared';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import {
  invalidateAutoThreadConfigs,
  reconcileAutoThreadChannels,
} from '../../../../services/features/autoThreadService.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

/** Plafonds : au-delà, l'ordre d'évaluation devient illisible. */
const MAX_CONFIGS_PER_CHANNEL = 10;
const MAX_CONFIGS_PER_GUILD = 100;

const CONFIG_ERRORS: Record<AutoThreadConfigError, string> = {
  name_required: 'Donne un nom à la configuration.',
  conditions_too_large: 'Trop de conditions (20 au maximum).',
  conditions_too_deep: 'Trop de groupes imbriqués (3 niveaux au maximum).',
  condition_value_required: 'Une condition attend une valeur (texte, nombre, rôle ou membre).',
  regex_invalid: 'Une expression régulière est invalide.',
  regex_unsafe: 'Une expression régulière imbrique des répétitions (ex. (a+)+) : elle ralentirait le bot.',
  naming_rules_too_many: 'Cinq règles de nommage au maximum.',
  naming_rule_value_required: 'Une règle de nommage est vide.',
};

function isThreadableChannel(client: Client, guildId: string, channelId: string): boolean {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  return !!channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
}

function toRow(value: ReturnType<typeof normalizeAutoThreadConfig> & { ok: true }) {
  const { conditions, namingRules, ...rest } = value.value;
  return {
    ...rest,
    conditions: conditions ? (conditions as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    namingRules: namingRules as unknown as Prisma.InputJsonValue,
  };
}

async function listConfigs(guildId: string) {
  return prisma.autoThreadConfig.findMany({
    where: { guildId },
    orderBy: [{ channelId: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
  });
}

export function createAutoThreadRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  const helpers = (c: Context) => {
    const guildId = c.req.param('guildId')!;
    return {
      audit: (action: string, details: string, channelId: string | null) => pushAudit(guildId, {
        user: auditUserOf(c),
        action,
        context: getGuildName(client, guildId),
        module: 'Auto-Thread',
        eventType: 'Manuel',
        details,
        channelId,
      }),
    };
  };

  /** La configuration visée, limitée au serveur ouvert. */
  const ownedConfig = createMiddleware<{ Variables: { existing: AutoThreadConfig } }>(async (c, next) => {
    const existing = await prisma.autoThreadConfig.findFirst({ where: { id: c.req.param('id'), guildId: c.req.param('guildId') } });
    if (!existing) return send(c, { error: 'Configuration introuvable' }, 404);
    c.set('existing', existing);
    await next();
  });
  const ownedGate = [...gate, ownedConfig] as const;



  router.get(`${base}/auto-thread/configs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      return send(c, { configs: await listConfigs(guildId) });
    } catch (err) {
      return fail(c, err, 'Erreur lors du chargement des configurations', 'AutoThreadAPI');
    }
  });

  router.post(`${base}/auto-thread/configs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { audit } = helpers(c);
    try {
      const body = await readBody<Record<string, unknown>>(c);
      const channelId = typeof body?.channelId === 'string' ? body.channelId : '';
      if (!isThreadableChannel(client, guildId, channelId)) {
        return send(c, { error: 'Choisis un salon textuel ou d’annonces de ce serveur.' }, 400);
      }
      const normalized = normalizeAutoThreadConfig(body);
      if (!normalized.ok) {
        return send(c, { error: CONFIG_ERRORS[normalized.error], code: normalized.error }, 400);
      }

      const [inGuild, inChannel] = await Promise.all([
        prisma.autoThreadConfig.count({ where: { guildId } }),
        prisma.autoThreadConfig.aggregate({ where: { guildId, channelId }, _count: true, _max: { position: true } }),
      ]);
      if (inGuild >= MAX_CONFIGS_PER_GUILD || inChannel._count >= MAX_CONFIGS_PER_CHANNEL) {
        return send(c, { error: `Limite atteinte : ${MAX_CONFIGS_PER_CHANNEL} configurations par salon, ${MAX_CONFIGS_PER_GUILD} par serveur.` }, 400);
      }

      const config = await prisma.autoThreadConfig.create({
        data: { guildId, channelId, position: (inChannel._max.position ?? -1) + 1, ...toRow(normalized) },
      });
      await invalidateAutoThreadConfigs(guildId);
      await audit('Création d’une configuration Auto-Thread', `« ${config.name} » sur le salon ${channelId}.`, channelId);
      return send(c, { ok: true, config });
    } catch (err) {
      logger.error('AutoThreadAPI', 'POST config error:', err);
      return fail(c, err, 'Erreur lors de la création de la configuration', 'AutoThreadAPI');
    }
  });

  router.post(`${base}/auto-thread/configs/reorder`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { audit } = helpers(c);
    try {
      const body = await readBody<{ channelId?: string; ids?: unknown }>(c);
      const channelId = body?.channelId ?? '';
      const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
      const current = await prisma.autoThreadConfig.findMany({ where: { guildId, channelId }, select: { id: true } });
      const known = new Set(current.map((c) => c.id));
      // L'ordre envoyé doit couvrir exactement le salon : un ordre partiel
      // laisserait deux configurations à la même place.
      if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
        return send(c, { error: 'Ordre incomplet : recharge la page et réessaie.' }, 400);
      }
      await prisma.$transaction(ids.map((id, position) =>
        prisma.autoThreadConfig.update({ where: { id }, data: { position } }),
      ));
      await invalidateAutoThreadConfigs(guildId);
      await audit('Ordre des configurations Auto-Thread', `Nouvel ordre d’évaluation sur le salon ${channelId}.`, channelId);
      return send(c, { ok: true, configs: await listConfigs(guildId) });
    } catch (err) {
      return fail(c, err, 'Erreur lors du changement d’ordre', 'AutoThreadAPI');
    }
  });

  router.put(`${base}/auto-thread/configs/:id`, ...ownedGate, async (c) => {
    const existing = c.var.existing;
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const { audit } = helpers(c);
    try {
      const body = await readBody<Record<string, unknown>>(c);
      const channelId = typeof body?.channelId === 'string' ? body.channelId : existing.channelId;
      if (channelId !== existing.channelId && !isThreadableChannel(client, guildId, channelId)) {
        return send(c, { error: 'Choisis un salon textuel ou d’annonces de ce serveur.' }, 400);
      }
      const normalized = normalizeAutoThreadConfig(body);
      if (!normalized.ok) {
        return send(c, { error: CONFIG_ERRORS[normalized.error], code: normalized.error }, 400);
      }

      let position = existing.position;
      if (channelId !== existing.channelId) {
        // Changer de salon place la configuration en fin d'ordre du nouveau.
        const last = await prisma.autoThreadConfig.aggregate({ where: { guildId, channelId }, _count: true, _max: { position: true } });
        if (last._count >= MAX_CONFIGS_PER_CHANNEL) {
          return send(c, { error: `Ce salon a déjà ${MAX_CONFIGS_PER_CHANNEL} configurations.` }, 400);
        }
        position = (last._max.position ?? -1) + 1;
      }

      const config = await prisma.autoThreadConfig.update({
        where: { id: existing.id },
        data: { ...toRow(normalized), channelId, position },
      });
      await invalidateAutoThreadConfigs(guildId);
      await audit('Modification d’une configuration Auto-Thread', `« ${config.name} » (${config.enabled ? 'active' : 'désactivée'}).`, channelId);
      return send(c, { ok: true, config });
    } catch (err) {
      logger.error('AutoThreadAPI', 'PUT config error:', err);
      return fail(c, err, 'Erreur lors de l’enregistrement de la configuration', 'AutoThreadAPI');
    }
  });

  router.post(`${base}/auto-thread/configs/:id/duplicate`, ...ownedGate, async (c) => {
    const existing = c.var.existing;
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const { audit } = helpers(c);
    try {
      const inChannel = await prisma.autoThreadConfig.aggregate({
        where: { guildId, channelId: existing.channelId },
        _count: true,
        _max: { position: true },
      });
      if (inChannel._count >= MAX_CONFIGS_PER_CHANNEL) {
        return send(c, { error: `Ce salon a déjà ${MAX_CONFIGS_PER_CHANNEL} configurations.` }, 400);
      }
      const { id: _id, createdAt: _c, updatedAt: _u, threadCount: _t, ...copy } = existing;
      const config = await prisma.autoThreadConfig.create({
        data: {
          ...copy,
          name: `${existing.name} (copie)`.slice(0, 80),
          // Une copie active doublerait l'effet de l'original à la position
          // suivante : elle naît éteinte, à régler avant d'être allumée.
          enabled: false,
          position: (inChannel._max.position ?? -1) + 1,
          conditions: existing.conditions === null ? Prisma.DbNull : (existing.conditions as Prisma.InputJsonValue),
          namingRules: existing.namingRules === null ? Prisma.DbNull : (existing.namingRules as Prisma.InputJsonValue),
        },
      });
      await invalidateAutoThreadConfigs(guildId);
      await audit('Duplication d’une configuration Auto-Thread', `« ${existing.name} » copiée.`, existing.channelId);
      return send(c, { ok: true, config });
    } catch (err) {
      return fail(c, err, 'Erreur lors de la duplication', 'AutoThreadAPI');
    }
  });

  router.delete(`${base}/auto-thread/configs/:id`, ...ownedGate, async (c) => {
    const existing = c.var.existing;
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const { audit } = helpers(c);
    try {
      await prisma.autoThreadConfig.delete({ where: { id: existing.id } });
      await invalidateAutoThreadConfigs(guildId);
      await audit('Suppression d’une configuration Auto-Thread', `« ${existing.name} » supprimée.`, existing.channelId);
      return send(c, { ok: true });
    } catch (err) {
      return fail(c, err, 'Erreur lors de la suppression', 'AutoThreadAPI');
    }
  });

  router.get(`${base}/auto-thread`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { autoThreadEnabled: true, autoThreadChannels: true, autoThreadBotsEnabled: true },
      });
      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }
      return send(c, { enabled: guild.autoThreadEnabled, channels: guild.autoThreadChannels, botsEnabled: guild.autoThreadBotsEnabled });
    } catch (err) {
      logger.error('AutoThreadAPI', 'GET auto-thread error:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration', 'AutoThreadAPI');
    }
  });

  router.patch(`${base}/auto-thread`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { audit } = helpers(c);
    try {
      const body = await readBody<{ enabled?: boolean; channels?: string[] }>(c);
      if (!body) {
        return send(c, { error: 'Payload settings invalide' }, 400);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        await prisma.guild.update({ where: { id: guildId }, data: { autoThreadEnabled: !!body.enabled } });
        await prisma.dashboardFeatureConfig.upsert({
          where: { guildId_featureKey: { guildId, featureKey: 'auto_thread' } },
          create: {
            guildId,
            featureKey: 'auto_thread',
            featureName: 'Auto-Thread',
            enabled: !!body.enabled,
            loggingEnabled: true,
            userActivityTracking: true,
            notifyViaDiscordChannel: true,
          },
          update: { enabled: !!body.enabled },
        });
      }

      if (Array.isArray(body.channels)) {
        const channelIds = body.channels.filter((id): id is string => typeof id === 'string');
        await reconcileAutoThreadChannels(guildId, channelIds, (id) => isThreadableChannel(client, guildId, id));
      }

      await audit('Sauvegarde configuration Auto-Thread', `Configuration Auto-Thread mise à jour (salons: ${body.channels?.length ?? 0}).`, null);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('AutoThreadAPI', 'PATCH auto-thread error:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'AutoThreadAPI');
    }
  });

  return router;
}

