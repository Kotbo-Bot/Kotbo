import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Client, PermissionFlagsBits } from 'discord.js';
import type { CustomBotConfig } from '@prisma/client';
import { comparePlans, normalizePlanKey } from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import { logger } from '../../../utils/logger.js';
import { fetchExternal } from '../../../utils/http.js';
import { SecretBoxUnavailableError, openSecret, sealSecret } from '../../../utils/secretBox.js';
import { getDefaultInstance } from '../../../utils/instanceResolver.js';
import { refreshGuildOwnership } from '../../../utils/guildOwnership.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { cloudflareSaasEnabled, removeCloudflareHostname } from '../../../services/system/cloudflareHostnames.js';
import {
  checkCustomDomainDns,
  customDomainForHost,
  customDomainTarget,
  normalizeCustomDomain,
  refreshCustomDomains,
  verificationRecord,
} from '../../../services/system/customDomain.js';
import {
  applyKotboGuildIdentity,
  applyOwnBotProfile,
  parseDataImage,
  presenceFrom,
} from '../../../services/system/customBotProfile.js';
import {
  botIsMember,
  findCustomInstance,
  leaveGuild,
  provisionCustomInstance,
} from '../../../services/system/customBotInstance.js';
import { pushAudit, type AuthClaims } from '../../shared.js';

/** Préfixe des secrets masqués renvoyés au dashboard. */
const MASK = '••••';

const MAX_SECRET_LENGTH = 200;
const MAX_TEXT_LENGTH = 2048;
// Une image importée depuis le PC arrive en data URI : 8 Mo d'image, un tiers de plus en base64.
const MAX_IMAGE_FIELD_LENGTH = 11_200_000;

const PROFILE_FIELDS = ['botName', 'botAvatarUrl', 'botBannerUrl', 'botBio'] as const;
const PRESENCE_FIELDS = ['botStatus', 'activityType', 'activityText', 'activityUrl'] as const;
const INVITE_PERMISSIONS = PermissionFlagsBits.Administrator.toString();

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
  const host = config.customDashboardUrl;
  return {
    ...config,
    botToken: token.masked,
    botClientSecret: secret.masked,
    secretsUnreadable: token.unreadable || secret.unreadable,
    domain: {
      /** Null : l'instance ne propose pas les domaines perso. */
      target: customDomainTarget(),
      verification: host ? verificationRecord(host, config.guildId) : null,
      redirectUri: host ? `https://${host}/api/auth/discord/callback` : null,
      /** Servi en ce moment (vérifié, OAuth renseigné, offre active). */
      active: host ? customDomainForHost(host)?.guildId === config.guildId : false,
    },
  };
}

function plainToken(config: CustomBotConfig | null): string | null {
  if (!config?.botToken) return null;
  try { return openSecret(config.botToken); } catch { return null; }
}

/**
 * Où en est la bascule vers le bot du serveur. Les présences se lisent sur
 * l'API Discord : le processus qui répond n'a pas forcément ce serveur en cache.
 */
async function ownBotState(guildId: string, config: CustomBotConfig) {
  const [instance, guild] = await Promise.all([
    findCustomInstance(guildId),
    prisma.guild.findUnique({ where: { id: guildId }, select: { instanceId: true } }),
  ]);
  const [botInGuild, kotboInGuild] = await Promise.all([
    botIsMember(plainToken(config), guildId),
    botIsMember(getDefaultInstance().discordToken, guildId),
  ]);
  return {
    instanceId: instance?.id ?? null,
    /** Le serveur est servi par son bot, Kotbo l'ignore. */
    switched: Boolean(instance && guild?.instanceId === instance.id),
    botInGuild,
    kotboInGuild,
    invitePermissions: INVITE_PERMISSIONS,
    kotboClientId: getDefaultInstance().discordClientId,
  };
}

/**
 * Pousse le profil vers Discord : sur le bot du serveur s'il est activé, sinon
 * sur Kotbo, pour ce serveur seulement. Renvoie les champs refusés.
 */
async function applyProfile(config: CustomBotConfig): Promise<string[]> {
  const profile = { botName: config.botName, botAvatarUrl: config.botAvatarUrl, botBannerUrl: config.botBannerUrl, botBio: config.botBio };
  const token = plainToken(config);
  if (config.enabled && token) return applyOwnBotProfile(token, profile);
  return applyKotboGuildIdentity(getDefaultInstance().discordToken, config.guildId, profile);
}

function sendIpc(client: Client, message: Record<string, unknown>): boolean {
  if (!client.shard) return false;
  void client.shard.send(message).catch((err: unknown) => logger.warn('CustomBot', 'Message au launcher non envoyé :', err));
  return true;
}

/**
 * L'identité du bot est réservée aux offres payantes (PLUS et au-delà). Le
 * dashboard ne verrouille que l'affichage, la route doit se garder elle-même.
 */
async function hasCustomPlan(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { plan: true } });
  return comparePlans(normalizePlanKey(guild?.plan), 'PLUS') >= 0;
}

function audit(guildId: string, user: AuthClaims, action: string, details: string, eventType = 'Configuration') {
  pushAudit(guildId, {
    user: user.username || user.userId,
    action,
    context: 'Custom Bot',
    module: 'Custom Bot',
    eventType,
    details,
    channelId: null,
  });
}

export function createCustomBotRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const customBotAccess = createMiddleware(async (c, next) => {
    if (!c.var.access.canManageSettings) {
      return send(c, { error: 'Accès refusé - droits administrateur requis' }, 403);
    }
    // Arrêter et revenir à Kotbo restent permis sans l'offre : un serveur repassé
    // sur une autre offre doit pouvoir couper un bot lancé du temps où il y avait droit.
    const method = c.req.method;
    const isStop = method === 'POST' && /\/custom-bot\/(stop|revert)$/.test(c.req.path);
    const isRead = method === 'GET' && c.req.path.endsWith('/custom-bot');
    if (!isRead && !isStop && !(await hasCustomPlan(c.req.param('guildId')!))) {
      return send(c, {
        error: 'L\'identité du bot est réservée à l\'offre Plus (ou sur mesure).',
        code: 'plan_required',
      }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client, { invalidateCache: false }), customBotAccess] as const;


  router.get(`${base}/custom-bot`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      // Sans l'offre, rien n'est créé : la page, verrouillée, s'ouvrait sinon en
      // écrivant une ligne vide pour chaque serveur qui la visitait.
      const allowed = await hasCustomPlan(guildId);
      if (!allowed) {
        const running = await prisma.customBotConfig.findUnique({ where: { guildId }, select: { isRunning: true } });
        return send(c, { allowed: false, config: null, isRunning: running?.isRunning ?? false });
      }

      const config = await upsertRetryingRace(() => prisma.customBotConfig.upsert({
        where: { guildId },
        update: {},
        create: { guildId },
      }));

      return send(c, { allowed: true, config: serializeConfig(config), ownBot: await ownBotState(guildId, config) });
    } catch (err) {
      logger.error('CustomBot', 'GET config error:', err);
      return fail(c, err, 'Erreur lors de la récupération de la config', 'CustomBot');
    }
  });

  router.patch(`${base}/custom-bot`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody(c);
      if (!body) { return send(c, { error: 'Body JSON requis' }, 400); }

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
          return send(c, { error: `Champ ${field} invalide` }, 400);
        }
        const text = typeof value === 'string' ? value.trim() : '';

        // Colonnes obligatoires : une valeur vide ne les efface pas, elle est
        // ignorée (Prisma refuserait `null` et l'enregistrement tomberait en 500).
        if ((field === 'botStatus' || field === 'activityType') && !text) continue;

        if (field === 'customDashboardUrl') {
          if (!text) {
            updateData[field] = null;
            continue;
          }
          const host = normalizeCustomDomain(text);
          if (!host) {
            return send(c, { error: 'Domaine invalide : saisis un nom de domaine comme panel.monserveur.fr.' }, 400);
          }
          updateData[field] = host;
          continue;
        }

        // Avatar et bannière : un lien https, ou une image importée depuis le PC.
        if (field === 'botAvatarUrl' || field === 'botBannerUrl') {
          if (!text) {
            updateData[field] = null;
            continue;
          }
          const isData = text.startsWith('data:');
          if (isData ? text.length > MAX_IMAGE_FIELD_LENGTH || !parseDataImage(text) : !/^https:\/\//i.test(text) || text.length > MAX_TEXT_LENGTH) {
            return send(c, { error: 'Image invalide : un lien https ou un fichier PNG, JPEG, GIF ou WebP de 8 Mo maximum.' }, 400);
          }
          updateData[field] = text;
          continue;
        }

        if (secretFields.has(field)) {
          // Le dashboard reçoit les secrets masqués : les lui renvoyer tels quels
          // écrasait le vrai secret par sa version masquée.
          if (text.startsWith(MASK)) continue;
          if (!text) {
            updateData[field] = null;
            continue;
          }
          if (text.length > MAX_SECRET_LENGTH) {
            return send(c, { error: `Champ ${field} trop long` }, 400);
          }
          updateData[field] = sealSecret(text);
          continue;
        }

        if (text.length > MAX_TEXT_LENGTH) {
          return send(c, { error: `Champ ${field} trop long` }, 400);
        }
        updateData[field] = field === 'botBio' ? text.slice(0, 190) || null : text || null;
      }

      // Validate enums
      if (
        updateData.botStatus != null
        && (typeof updateData.botStatus !== 'string'
          || !['ONLINE', 'IDLE', 'DND', 'INVISIBLE'].includes(updateData.botStatus))
      ) {
        return send(c, { error: 'Statut invalide' }, 400);
      }
      if (
        updateData.activityType != null
        && (typeof updateData.activityType !== 'string'
          || !['NONE', 'PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'COMPETING'].includes(updateData.activityType))
      ) {
        return send(c, { error: 'Type d\'activité invalide' }, 400);
      }

      const before = await prisma.customBotConfig.findUnique({ where: { guildId } });

      // Un serveur servi par son bot ne peut pas le désactiver d'ici : il faut
      // d'abord revenir à Kotbo, sinon plus aucun bot ne le servirait.
      if (updateData.enabled === false) {
        const instance = await findCustomInstance(guildId);
        const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { instanceId: true } });
        if (instance && guild?.instanceId === instance.id) {
          return send(c, { error: 'Ton bot sert ce serveur : reviens d\'abord à Kotbo avant de le désactiver.' }, 409);
        }
      }

      // Un domaine changé doit être revérifié : le TXT prouve la propriété d'un hôte précis.
      if ('customDashboardUrl' in updateData && before?.customDashboardUrl !== updateData.customDashboardUrl) {
        updateData.customDomainVerifiedAt = null;
      }

      let config: CustomBotConfig;
      try {
        config = await prisma.customBotConfig.upsert({
          where: { guildId },
          update: updateData,
          create: { guildId, ...updateData },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          return send(c, { error: 'Ce domaine est déjà utilisé par un autre serveur.' }, 409);
        }
        throw err;
      }
      await refreshCustomDomains();

      // L'ancien domaine ne doit plus rester déclaré chez Cloudflare (quota facturé au nom d'hôte).
      if (before?.customDashboardUrl && before.customDashboardUrl !== config.customDashboardUrl && cloudflareSaasEnabled()) {
        await removeCloudflareHostname(before.customDashboardUrl).catch((err) => logger.warn('CustomBot', `[${guildId}] Nom d'hôte Cloudflare non retiré :`, err));
      }

      // Désactiver le bot du serveur arrête son instance, même si la base le disait déjà désactivé.
      if (updateData.enabled === false) {
        const instance = await findCustomInstance(guildId);
        if (instance) {
          await prisma.whiteLabelInstance.update({ where: { id: instance.id }, data: { enabled: false } });
          sendIpc(client, { type: 'custom-instance-stop', instanceId: instance.id });
          config = await prisma.customBotConfig.update({ where: { guildId }, data: { isRunning: false } });
        }
      }

      const changed = (keys: readonly string[]) => keys.some((key) => key in updateData && (before as Record<string, unknown> | null)?.[key] !== updateData[key]);
      const profileErrors = changed([...PROFILE_FIELDS, 'enabled', 'botToken']) ? await applyProfile(config) : [];
      if (profileErrors.length > 0) logger.warn('CustomBot', `[${guildId}] Profil partiellement appliqué : ${profileErrors.join(' | ')}`);

      // Le statut se change à chaud, sans relancer l'instance.
      if (changed(PRESENCE_FIELDS) && config.isRunning) {
        const instance = await findCustomInstance(guildId);
        if (instance) sendIpc(client, { type: 'custom-instance-presence', instanceId: instance.id, presence: presenceFrom(config) });
      }

      audit(guildId, user, 'Mise à jour Custom Bot', 'Mise à jour de la configuration du bot personnalisé.');
      return send(c, { allowed: true, config: serializeConfig(config), profileErrors });
    } catch (err) {
      if (err instanceof SecretBoxUnavailableError) {
        logger.error('CustomBot', err.message);
        return send(c, { error: 'Le stockage sécurisé des secrets n\'est pas configuré sur ce serveur Kotbo.' }, 503);
      }
      logger.error('CustomBot', 'PATCH config error:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'CustomBot');
    }
  });

  router.post(`${base}/custom-bot/domain/verify`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const current = await prisma.customBotConfig.findUnique({ where: { guildId } });
      if (!current?.customDashboardUrl) {
        return send(c, { error: "Enregistre d'abord un domaine." }, 400);
      }
      if (!customDomainTarget()) {
        return send(c, { error: 'Les domaines perso ne sont pas encore ouverts sur cette instance Kotbo.' }, 503);
      }
      const checks = await checkCustomDomainDns(current.customDashboardUrl, guildId);
      const verified = checks.txt && checks.pointing;
      const config = await prisma.customBotConfig.update({
        where: { guildId },
        data: { customDomainVerifiedAt: verified ? (current.customDomainVerifiedAt ?? new Date()) : null },
      });
      await refreshCustomDomains();
      if (verified && !current.customDomainVerifiedAt) {
        audit(guildId, user, 'Domaine perso vérifié', `Domaine ${current.customDashboardUrl} vérifié.`);
      }
      return send(c, { checks, verified, config: serializeConfig(config) });
    } catch (err) {
      logger.error('CustomBot', 'Domain verify error:', err);
      return fail(c, err, 'Erreur lors de la vérification du domaine', 'CustomBot');
    }
  });

  router.post(`${base}/custom-bot/validate`, ...gate, async (c) => {
    try {
      const body = await readBody(c);
      const token = typeof body?.botToken === 'string' ? body.botToken.trim() : '';

      if (!token || token.length > MAX_SECRET_LENGTH) {
        return send(c, { error: 'Token requis' }, 400);
      }

      const response = await fetchExternal('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });

      if (!response.ok) {
        return send(c, { valid: false, error: 'Token invalide ou expiré' });
      }

      const botUser = await response.json() as { id: string; username: string; avatar: string | null; discriminator: string };
      return send(c, {
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
      return send(c, { valid: false, error: 'Erreur de validation' });
    }
  });

  router.post(`${base}/custom-bot/start`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const config = await prisma.customBotConfig.findUnique({ where: { guildId } });
      if (!config?.botToken || !config.enabled) {
        return send(c, { error: 'Active d\'abord ton bot et connecte-le avec son token.' }, 400);
      }
      if (!plainToken(config)) {
        return send(c, { error: 'Le token enregistré est illisible : ressaisis-le puis relance.' }, 400);
      }
      // Hors gestionnaire de shards, personne ne recevrait la demande : le bot
      // était pourtant marqué en ligne.
      if (!client.shard) {
        return send(c, { error: 'Démarrage impossible : le bot ne tourne pas sous le gestionnaire de shards.' }, 503);
      }

      const instance = await provisionCustomInstance(guildId, user.userId);
      sendIpc(client, { type: 'custom-instance-start', instanceId: instance.id });
      // `isRunning` est posé par le launcher une fois l'instance connectée.
      await prisma.customBotConfig.update({ where: { guildId }, data: { lastError: null } });

      audit(guildId, user, 'Démarrage Custom Bot', 'Démarrage du bot personnalisé demandé.', 'Système');
      return send(c, { ok: true, message: 'Démarrage en cours...' });
    } catch (err) {
      if (err instanceof SecretBoxUnavailableError) {
        logger.error('CustomBot', err.message);
        return send(c, { error: 'Le stockage sécurisé des secrets n\'est pas configuré sur ce serveur Kotbo.' }, 503);
      }
      logger.error('CustomBot', 'Start error:', err);
      return fail(c, err, 'Erreur lors du démarrage', 'CustomBot');
    }
  });

  router.post(`${base}/custom-bot/stop`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const instance = await findCustomInstance(guildId);
      const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { instanceId: true } });
      if (instance && guild?.instanceId === instance.id) {
        return send(c, { error: 'Ton bot sert ce serveur : reviens d\'abord à Kotbo avant de l\'arrêter.' }, 409);
      }
      if (instance) {
        await prisma.whiteLabelInstance.update({ where: { id: instance.id }, data: { enabled: false } });
        sendIpc(client, { type: 'custom-instance-stop', instanceId: instance.id });
      }
      await prisma.customBotConfig.updateMany({ where: { guildId }, data: { isRunning: false } });

      audit(guildId, user, 'Arrêt Custom Bot', 'Arrêt du bot personnalisé demandé.', 'Système');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('CustomBot', 'Stop error:', err);
      return fail(c, err, 'Erreur lors de l\'arrêt', 'CustomBot');
    }
  });

  router.post(`${base}/custom-bot/switch`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const config = await prisma.customBotConfig.findUnique({ where: { guildId } });
      const instance = await findCustomInstance(guildId);
      if (!config?.enabled || !config.isRunning || !instance) {
        return send(c, { error: 'Démarre d\'abord ton bot.' }, 400);
      }
      if (!(await botIsMember(plainToken(config), guildId))) {
        return send(c, { error: 'Ton bot n\'est pas encore sur le serveur : invite-le d\'abord.' }, 400);
      }
      // Le domaine est optionnel : sans lui, le serveur n'a plus de dashboard après la bascule (dashboardUrl null).
      const servedHost = config.customDashboardUrl && customDomainForHost(config.customDashboardUrl)?.guildId === guildId
        ? config.customDashboardUrl
        : null;

      await prisma.guild.update({ where: { id: guildId }, data: { instanceId: instance.id } });
      await Promise.all([refreshGuildOwnership(), refreshCustomDomains()]);
      await leaveGuild(getDefaultInstance().discordToken, guildId);

      audit(guildId, user, 'Bascule vers le bot perso', 'Le bot du serveur prend le relais, Kotbo a quitté le serveur.', 'Système');
      return send(c, { ok: true, dashboardUrl: servedHost ? `https://${servedHost}` : null });
    } catch (err) {
      logger.error('CustomBot', 'Switch error:', err);
      return fail(c, err, 'Erreur lors de la bascule', 'CustomBot');
    }
  });

  router.post(`${base}/custom-bot/revert`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      await prisma.guild.updateMany({ where: { id: guildId }, data: { instanceId: null } });
      const instance = await findCustomInstance(guildId);
      if (instance) {
        await prisma.whiteLabelInstance.update({ where: { id: instance.id }, data: { enabled: false } });
        sendIpc(client, { type: 'custom-instance-stop', instanceId: instance.id });
      }
      await prisma.customBotConfig.update({ where: { guildId }, data: { enabled: false, isRunning: false } });
      await Promise.all([refreshGuildOwnership(), refreshCustomDomains()]);

      audit(guildId, user, 'Retour à Kotbo', 'Kotbo reprend le serveur, le bot perso est arrêté.', 'Système');
      return send(c, { ok: true });
    } catch (err) {
      logger.error('CustomBot', 'Revert error:', err);
      return fail(c, err, 'Erreur lors du retour à Kotbo', 'CustomBot');
    }
  });

  return router;
}

