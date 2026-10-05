import { IncomingMessage, ServerResponse } from 'node:http';
import { Client, ActivityType, PresenceStatusData } from 'discord.js';
import type { CustomBotConfig } from '@prisma/client';
import { normalizePlanKey } from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import { logger } from '../../../utils/logger.js';
import { fetchExternal } from '../../../utils/http.js';
import { SecretBoxUnavailableError, openSecret, sealSecret } from '../../../utils/secretBox.js';
import { jsonFailure } from '../../shared/failure.js';
import {
  json,
  readJsonBody,
  resolveDashboardAccess,
  pushAudit,
  type AuthClaims,
} from '../../shared.js';

const _STATUS_MAP: Record<string, PresenceStatusData> = {
  ONLINE: 'online',
  IDLE: 'idle',
  DND: 'dnd',
  INVISIBLE: 'invisible',
};

const _ACTIVITY_MAP: Record<string, ActivityType> = {
  PLAYING: ActivityType.Playing,
  STREAMING: ActivityType.Streaming,
  LISTENING: ActivityType.Listening,
  WATCHING: ActivityType.Watching,
  COMPETING: ActivityType.Competing,
};

/** Préfixe des secrets masqués renvoyés au dashboard. */
const MASK = '••••';

const MAX_SECRET_LENGTH = 200;
const MAX_TEXT_LENGTH = 2048;

/**
 * Secret affiché au dashboard : ses derniers caractères, jamais la valeur.
 * Un secret illisible (clé de chiffrement changée) s'affiche masqué sans fin :
 * le dashboard le signale via `secretsUnreadable`.
 */
function maskSecret(stored: string | null, visible: number): { masked: string | null; unreadable: boolean } {
  if (!stored) return { masked: null, unreadable: false };
  let plain: string | null;
  try {
    plain = openSecret(stored);
  } catch {
    plain = null;
  }
  return plain === null
    ? { masked: MASK, unreadable: true }
    : { masked: MASK + plain.slice(-visible), unreadable: false };
}

function serializeConfig(config: CustomBotConfig) {
  const token = maskSecret(config.botToken, 6);
  const secret = maskSecret(config.botClientSecret, 4);
  return {
    ...config,
    botToken: token.masked,
    botClientSecret: secret.masked,
    secretsUnreadable: token.unreadable || secret.unreadable,
  };
}

/**
 * Le Custom Bot est un service sur mesure : seul un serveur à l'offre CUSTOM,
 * posée depuis l'administration, y a accès. Le verrou « WIP » du dashboard ne
 * protège que l'affichage, la route doit se garder elle-même.
 */
async function hasCustomPlan(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { plan: true } });
  return normalizePlanKey(guild?.plan) === 'CUSTOM';
}

export async function handleCustomBotRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims
): Promise<boolean> {
  const method = req.method;

  if (parts[4] !== 'custom-bot') {
    return false;
  }

  const guildId = parts[3];

  const access = await resolveDashboardAccess(client, guildId, user.userId);
  if (!access.canManageSettings) {
    json(res, 403, { error: 'Accès refusé - droits administrateur requis' });
    return true;
  }

  // Arrêter reste permis sans l'offre : un serveur repassé sur une autre offre
  // doit pouvoir couper un bot lancé du temps où il y avait droit.
  const isStop = parts.length === 6 && parts[5] === 'stop' && method === 'POST';
  const allowed = await hasCustomPlan(guildId);

  if (!allowed && !(parts.length === 5 && method === 'GET') && !isStop) {
    json(res, 403, {
      error: 'Le Custom Bot est réservé à l\'offre sur mesure. Contactez l\'équipe Kotbo pour l\'activer.',
      code: 'plan_required',
    });
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/custom-bot
  if (parts.length === 5 && method === 'GET') {
    try {
      // Sans l'offre, rien n'est créé : la page, verrouillée, s'ouvrait sinon en
      // écrivant une ligne vide pour chaque serveur qui la visitait.
      if (!allowed) {
        const running = await prisma.customBotConfig.findUnique({ where: { guildId }, select: { isRunning: true } });
        json(res, 200, { allowed: false, config: null, isRunning: running?.isRunning ?? false });
        return true;
      }

      const config = await upsertRetryingRace(() => prisma.customBotConfig.upsert({
        where: { guildId },
        update: {},
        create: { guildId },
      }));

      json(res, 200, { allowed: true, config: serializeConfig(config) });
    } catch (err) {
      logger.error('CustomBot', 'GET config error:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération de la config', 'CustomBot');
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/custom-bot
  if (parts.length === 5 && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      if (!body) { json(res, 400, { error: 'Body JSON requis' }); return true; }

      const allowedFields = [
        'enabled', 'botToken', 'botClientId', 'botClientSecret',
        'botName', 'botAvatarUrl', 'botBannerUrl', 'botBio',
        'botStatus', 'activityType', 'activityText', 'activityUrl',
        'customDashboardUrl',
      ] as const;

      const secretFields = new Set<string>(['botToken', 'botClientSecret']);
      const updateData: Record<string, unknown> = {};
      for (const field of allowedFields) {
        const value = body[field];
        if (value === undefined) continue;

        if (field === 'enabled') {
          updateData[field] = Boolean(value);
          continue;
        }

        if (value !== null && typeof value !== 'string') {
          json(res, 400, { error: `Champ ${field} invalide` });
          return true;
        }
        const text = typeof value === 'string' ? value.trim() : '';

        // Colonnes obligatoires : une valeur vide ne les efface pas, elle est
        // ignorée (Prisma refuserait `null` et l'enregistrement tomberait en 500).
        if ((field === 'botStatus' || field === 'activityType') && !text) continue;

        if (secretFields.has(field)) {
          // Le dashboard reçoit les secrets masqués : les lui renvoyer tels quels
          // écrasait le vrai secret par sa version masquée.
          if (text.startsWith(MASK)) continue;
          if (!text) {
            updateData[field] = null;
            continue;
          }
          if (text.length > MAX_SECRET_LENGTH) {
            json(res, 400, { error: `Champ ${field} trop long` });
            return true;
          }
          updateData[field] = sealSecret(text);
          continue;
        }

        if (text.length > MAX_TEXT_LENGTH) {
          json(res, 400, { error: `Champ ${field} trop long` });
          return true;
        }
        updateData[field] = field === 'botBio' ? text.slice(0, 190) || null : text || null;
      }

      // Validate enums
      if (
        updateData.botStatus != null
        && (typeof updateData.botStatus !== 'string'
          || !['ONLINE', 'IDLE', 'DND', 'INVISIBLE'].includes(updateData.botStatus))
      ) {
        json(res, 400, { error: 'Statut invalide' });
        return true;
      }
      if (
        updateData.activityType != null
        && (typeof updateData.activityType !== 'string'
          || !['NONE', 'PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'COMPETING'].includes(updateData.activityType))
      ) {
        json(res, 400, { error: 'Type d\'activité invalide' });
        return true;
      }

      const config = await prisma.customBotConfig.upsert({
        where: { guildId },
        update: updateData,
        create: { guildId, ...updateData },
      });

      pushAudit(guildId, {
        user: user.username || user.userId,
        action: 'Mise à jour Custom Bot',
        context: 'Custom Bot',
        module: 'Custom Bot',
        eventType: 'Configuration',
        details: 'Mise à jour de la configuration du bot personnalisé.',
        channelId: null,
      });

      json(res, 200, { allowed: true, config: serializeConfig(config) });
    } catch (err) {
      if (err instanceof SecretBoxUnavailableError) {
        logger.error('CustomBot', err.message);
        json(res, 503, { error: 'Le stockage sécurisé des secrets n\'est pas configuré sur ce serveur Kotbo.' });
        return true;
      }
      logger.error('CustomBot', 'PATCH config error:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour', 'CustomBot');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/custom-bot/validate - Test token validity
  if (parts.length === 6 && parts[5] === 'validate' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const token = typeof body?.botToken === 'string' ? body.botToken.trim() : '';

      if (!token || token.length > MAX_SECRET_LENGTH) {
        json(res, 400, { error: 'Token requis' });
        return true;
      }

      const response = await fetchExternal('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });

      if (!response.ok) {
        json(res, 200, { valid: false, error: 'Token invalide ou expiré' });
        return true;
      }

      const botUser = await response.json() as { id: string; username: string; avatar: string | null; discriminator: string };
      json(res, 200, {
        valid: true,
        bot: {
          id: botUser.id,
          username: botUser.username,
          avatar: botUser.avatar
            ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
            : null,
        },
      });
    } catch (err) {
      logger.error('CustomBot', 'Token validation error:', err);
      json(res, 200, { valid: false, error: 'Erreur de validation' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/custom-bot/start - Request bot start
  if (parts.length === 6 && parts[5] === 'start' && method === 'POST') {
    try {
      const config = await prisma.customBotConfig.findUnique({ where: { guildId } });
      if (!config?.botToken || !config.enabled) {
        json(res, 400, { error: 'Le bot personnalisé n\'est pas configuré ou est désactivé.' });
        return true;
      }

      const botToken = openSecret(config.botToken);
      if (!botToken) {
        json(res, 400, { error: 'Le token enregistré est illisible : ressaisissez-le puis relancez.' });
        return true;
      }

      // Hors gestionnaire de shards, personne ne recevrait la demande : le bot
      // était pourtant marqué en ligne.
      if (!client.shard) {
        json(res, 503, { error: 'Démarrage impossible : le bot ne tourne pas sous le gestionnaire de shards.' });
        return true;
      }

      // Signal the launcher to start this custom bot via IPC
      await client.shard.send({
        type: 'custom-bot-start',
        guildId,
        config: {
          botToken,
          botStatus: config.botStatus,
          activityType: config.activityType,
          activityText: config.activityText,
          activityUrl: config.activityUrl,
          botName: config.botName,
        },
      });

      await prisma.customBotConfig.update({
        where: { guildId },
        data: { isRunning: true, lastStartedAt: new Date(), lastError: null },
      });

      pushAudit(guildId, {
        user: user.username || user.userId,
        action: 'Démarrage Custom Bot',
        context: 'Custom Bot',
        module: 'Custom Bot',
        eventType: 'Système',
        details: 'Démarrage du bot personnalisé demandé.',
        channelId: null,
      });
      json(res, 200, { ok: true, message: 'Démarrage en cours...' });
    } catch (err) {
      if (err instanceof SecretBoxUnavailableError) {
        logger.error('CustomBot', err.message);
        json(res, 503, { error: 'Le stockage sécurisé des secrets n\'est pas configuré sur ce serveur Kotbo.' });
        return true;
      }
      logger.error('CustomBot', 'Start error:', err);
      jsonFailure(res, err, 'Erreur lors du démarrage', 'CustomBot');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/custom-bot/stop - Request bot stop
  if (parts.length === 6 && parts[5] === 'stop' && method === 'POST') {
    try {
      if (client.shard) {
        client.shard.send({ type: 'custom-bot-stop', guildId });
      }

      await prisma.customBotConfig.updateMany({
        where: { guildId },
        data: { isRunning: false },
      });

      pushAudit(guildId, {
        user: user.username || user.userId,
        action: 'Arrêt Custom Bot',
        context: 'Custom Bot',
        module: 'Custom Bot',
        eventType: 'Système',
        details: 'Arrêt du bot personnalisé demandé.',
        channelId: null,
      });
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('CustomBot', 'Stop error:', err);
      jsonFailure(res, err, 'Erreur lors de l\'arrêt', 'CustomBot');
    }
    return true;
  }

  return false;
}
