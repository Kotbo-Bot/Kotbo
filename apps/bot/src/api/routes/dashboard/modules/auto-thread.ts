/** Routes dashboard du module `auto-thread`. */
import { ChannelType, type Client } from 'discord.js';
import { Prisma } from '@prisma/client';
import { normalizeAutoThreadConfig, type AutoThreadConfigError } from '@kotbo/shared';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';
import {
  invalidateAutoThreadConfigs,
  reconcileAutoThreadChannels,
} from '../../../../services/features/autoThreadService.js';

import { jsonFailure } from '../../../shared/failure.js';

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

export async function handleAutoThreadRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, moduleKey } = ctx;
  if (moduleKey !== 'auto-thread') return false;

  const audit = (action: string, details: string, channelId: string | null) => pushAudit(guildId, {
    user: auditUser,
    action,
    context: getGuildName(client, guildId),
    module: 'Auto-Thread',
    eventType: 'Manuel',
    details,
    channelId,
  });

  // ── Configurations ─────────────────────────────────────────────────────────
  // GET /api/dashboard/guilds/:guildId/auto-thread/configs
  if (parts.length === 6 && parts[5] === 'configs' && method === 'GET') {
    try {
      json(res, 200, { configs: await listConfigs(guildId) });
    } catch (err) {
      jsonFailure(res, err, 'Erreur lors du chargement des configurations', 'AutoThreadAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/auto-thread/configs
  if (parts.length === 6 && parts[5] === 'configs' && method === 'POST') {
    try {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const channelId = typeof body?.channelId === 'string' ? body.channelId : '';
      if (!isThreadableChannel(client, guildId, channelId)) {
        json(res, 400, { error: 'Choisis un salon textuel ou d’annonces de ce serveur.' });
        return true;
      }
      const normalized = normalizeAutoThreadConfig(body);
      if (!normalized.ok) {
        json(res, 400, { error: CONFIG_ERRORS[normalized.error], code: normalized.error });
        return true;
      }

      const [inGuild, inChannel] = await Promise.all([
        prisma.autoThreadConfig.count({ where: { guildId } }),
        prisma.autoThreadConfig.aggregate({ where: { guildId, channelId }, _count: true, _max: { position: true } }),
      ]);
      if (inGuild >= MAX_CONFIGS_PER_GUILD || inChannel._count >= MAX_CONFIGS_PER_CHANNEL) {
        json(res, 400, { error: `Limite atteinte : ${MAX_CONFIGS_PER_CHANNEL} configurations par salon, ${MAX_CONFIGS_PER_GUILD} par serveur.` });
        return true;
      }

      const config = await prisma.autoThreadConfig.create({
        data: { guildId, channelId, position: (inChannel._max.position ?? -1) + 1, ...toRow(normalized) },
      });
      await invalidateAutoThreadConfigs(guildId);
      await audit('Création d’une configuration Auto-Thread', `« ${config.name} » sur le salon ${channelId}.`, channelId);
      json(res, 200, { ok: true, config });
    } catch (err) {
      logger.error('AutoThreadAPI', 'POST config error:', err);
      jsonFailure(res, err, 'Erreur lors de la création de la configuration', 'AutoThreadAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/auto-thread/configs/reorder { channelId, ids }
  if (parts.length === 7 && parts[5] === 'configs' && parts[6] === 'reorder' && method === 'POST') {
    try {
      const body = await readJsonBody<{ channelId?: string; ids?: unknown }>(req);
      const channelId = body?.channelId ?? '';
      const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
      const current = await prisma.autoThreadConfig.findMany({ where: { guildId, channelId }, select: { id: true } });
      const known = new Set(current.map((c) => c.id));
      // L'ordre envoyé doit couvrir exactement le salon : un ordre partiel
      // laisserait deux configurations à la même place.
      if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
        json(res, 400, { error: 'Ordre incomplet : recharge la page et réessaie.' });
        return true;
      }
      await prisma.$transaction(ids.map((id, position) =>
        prisma.autoThreadConfig.update({ where: { id }, data: { position } }),
      ));
      await invalidateAutoThreadConfigs(guildId);
      await audit('Ordre des configurations Auto-Thread', `Nouvel ordre d’évaluation sur le salon ${channelId}.`, channelId);
      json(res, 200, { ok: true, configs: await listConfigs(guildId) });
    } catch (err) {
      jsonFailure(res, err, 'Erreur lors du changement d’ordre', 'AutoThreadAPI');
    }
    return true;
  }

  const configId = parts.length >= 7 && parts[5] === 'configs' ? parts[6] : null;
  if (configId) {
    const existing = await prisma.autoThreadConfig.findFirst({ where: { id: configId, guildId } });
    if (!existing) {
      json(res, 404, { error: 'Configuration introuvable' });
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/auto-thread/configs/:id
    if (parts.length === 7 && method === 'PUT') {
      try {
        const body = await readJsonBody<Record<string, unknown>>(req);
        const channelId = typeof body?.channelId === 'string' ? body.channelId : existing.channelId;
        if (channelId !== existing.channelId && !isThreadableChannel(client, guildId, channelId)) {
          json(res, 400, { error: 'Choisis un salon textuel ou d’annonces de ce serveur.' });
          return true;
        }
        const normalized = normalizeAutoThreadConfig(body);
        if (!normalized.ok) {
          json(res, 400, { error: CONFIG_ERRORS[normalized.error], code: normalized.error });
          return true;
        }

        let position = existing.position;
        if (channelId !== existing.channelId) {
          // Changer de salon place la configuration en fin d'ordre du nouveau.
          const last = await prisma.autoThreadConfig.aggregate({ where: { guildId, channelId }, _count: true, _max: { position: true } });
          if (last._count >= MAX_CONFIGS_PER_CHANNEL) {
            json(res, 400, { error: `Ce salon a déjà ${MAX_CONFIGS_PER_CHANNEL} configurations.` });
            return true;
          }
          position = (last._max.position ?? -1) + 1;
        }

        const config = await prisma.autoThreadConfig.update({
          where: { id: existing.id },
          data: { ...toRow(normalized), channelId, position },
        });
        await invalidateAutoThreadConfigs(guildId);
        await audit('Modification d’une configuration Auto-Thread', `« ${config.name} » (${config.enabled ? 'active' : 'désactivée'}).`, channelId);
        json(res, 200, { ok: true, config });
      } catch (err) {
        logger.error('AutoThreadAPI', 'PUT config error:', err);
        jsonFailure(res, err, 'Erreur lors de l’enregistrement de la configuration', 'AutoThreadAPI');
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/auto-thread/configs/:id/duplicate
    if (parts.length === 8 && parts[7] === 'duplicate' && method === 'POST') {
      try {
        const inChannel = await prisma.autoThreadConfig.aggregate({
          where: { guildId, channelId: existing.channelId },
          _count: true,
          _max: { position: true },
        });
        if (inChannel._count >= MAX_CONFIGS_PER_CHANNEL) {
          json(res, 400, { error: `Ce salon a déjà ${MAX_CONFIGS_PER_CHANNEL} configurations.` });
          return true;
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
        json(res, 200, { ok: true, config });
      } catch (err) {
        jsonFailure(res, err, 'Erreur lors de la duplication', 'AutoThreadAPI');
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/auto-thread/configs/:id
    if (parts.length === 7 && method === 'DELETE') {
      try {
        await prisma.autoThreadConfig.delete({ where: { id: existing.id } });
        await invalidateAutoThreadConfigs(guildId);
        await audit('Suppression d’une configuration Auto-Thread', `« ${existing.name} » supprimée.`, existing.channelId);
        json(res, 200, { ok: true });
      } catch (err) {
        jsonFailure(res, err, 'Erreur lors de la suppression', 'AutoThreadAPI');
      }
      return true;
    }
  }

  // ── Ancien format : interrupteur du module et liste de salons ─────────────
  // GET/PATCH /api/dashboard/guilds/:guildId/auto-thread
  if (parts.length === 5) {
    if (method === 'GET') {
      try {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { autoThreadEnabled: true, autoThreadChannels: true, autoThreadBotsEnabled: true },
        });
        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        json(res, 200, { enabled: guild.autoThreadEnabled, channels: guild.autoThreadChannels, botsEnabled: guild.autoThreadBotsEnabled });
      } catch (err) {
        logger.error('AutoThreadAPI', 'GET auto-thread error:', err);
        jsonFailure(res, err, 'Erreur lors de la récupération de la configuration', 'AutoThreadAPI');
      }
      return true;
    }

    if (method === 'PATCH') {
      try {
        const body = await readJsonBody<{ enabled?: boolean; channels?: string[] }>(req);
        if (!body) {
          json(res, 400, { error: 'Payload settings invalide' });
          return true;
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
        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('AutoThreadAPI', 'PATCH auto-thread error:', err);
        jsonFailure(res, err, 'Erreur lors de la mise à jour', 'AutoThreadAPI');
      }
      return true;
    }
  }

  return false;
}
