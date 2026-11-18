import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { pushAudit, getGuildName, type DashboardAccess } from '../../shared.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { getAegisClient, AegisRequestError, AegisUnavailableError } from '../../../services/moderation/aegis/aegisClient.js';
import { AegisConfigError, invalidateAegisConfig, sanitizeAegisPatch } from '../../../services/moderation/aegis/aegisConfig.js';
import { getAegisQueueStats } from '../../../services/moderation/aegis/aegisQueue.js';
import { prepareText } from '../../../services/moderation/aegis/aegisText.js';
import { scanText } from '../../../services/moderation/aegis/aegisProcessor.js';
import { decideToxicity } from '../../../services/moderation/aegis/aegisSignals.js';
import { confirmDetection, dismissDetection, unslowDetection } from '../../../services/moderation/aegis/aegisActions.js';

const LOG = 'AegisAPI';

const DETECTION_STATUSES = ['PENDING', 'AUTO', 'CONFIRMED', 'DISMISSED'] as const;
const DETECTION_KINDS = ['TOXIC', 'HARASSMENT', 'CONFLICT', 'DISTRESS'] as const;

/** Valeurs par défaut du schéma, renvoyées tant que le serveur n'a rien enregistré. */
function defaultConfig(guildId: string) {
  return {
    guildId,
    enabled: false,
    trainingConsent: null,
    trainingConsentById: null,
    trainingConsentAt: null,
    reviewThreshold: 80,
    autoThreshold: 95,
    autoAction: 'DELETE_AND_WARN',
    warnWeight: 2,
    timeoutMinutes: 10,
    notifyMember: true,
    reviewChannelId: null,
    exemptChannelIds: [] as string[],
    exemptRoleIds: [] as string[],
    analyzeMessages: true,
    analyzeThreads: true,
    analyzeVoiceChats: true,
    analyzeExempt: true,
    analyzeEdits: true,
    analyzeNicknames: false,
    analyzeTickets: true,
    ticketPriorityBoost: false,
    conflictEnabled: false,
    conflictWindowSec: 120,
    conflictMessageThreshold: 4,
    conflictSlowmodeSec: 10,
    conflictDurationMin: 10,
    harassmentEnabled: false,
    harassmentWindowMin: 30,
    harassmentThreshold: 3,
    harassmentAction: 'ALERT',
    harassmentLongDays: 30,
    harassmentLongThreshold: 5,
    distressEnabled: false,
    distressThreshold: 95,
    distressChannelId: null,
    distressCooldownHours: 24,
  };
}

function canReview(access: DashboardAccess): boolean {
  return access.level === 'admin' || access.level === 'moderator';
}

/**
 * Kotbo × AegisAI.
 *
 *   GET    /aegis                              réglages, état de l'API et de la file
 *   PATCH  /aegis                              réglages (consentement d'entraînement compris)
 *   POST   /aegis/test                         noter une phrase (partagée si le serveur l'a accepté)
 *   GET    /aegis/detections                   détections (filtres status, kind, before)
 *   POST   /aegis/detections/:id/confirm       confirmer (sanction pour un message toxique)
 *   POST   /aegis/detections/:id/dismiss       faux positif (défait l'action automatique)
 *   POST   /aegis/detections/:id/unslow        lever le mode lent d'une escalade
 */
export function createAegisRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  const helpers = (c: Context) => {
    const guildId = c.req.param('guildId')!;
    const user = c.var.dashboardUser;
    return {
      audit: (action: string, details: string) => pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action,
        context: getGuildName(client, guildId),
        module: 'AutoMod',
        eventType: 'Settings',
        details,
        channelId: null,
      }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err)),
    };
  };

  router.onError((err, c) => {
    if (err instanceof AegisConfigError) return send(c, { error: err.message }, 400);
    if (err instanceof AegisUnavailableError || err instanceof AegisRequestError) {
      // Le détail (clé absente, route en échec) concerne l'hébergeur, pas
      // l'administrateur du serveur : il reste dans les journaux.
      logger.warn(LOG, `AegisAI indisponible sur ${c.req.method} ${c.req.path} : ${err.message}`);
      return send(c, {
        error: err instanceof AegisUnavailableError && err.reason === 'not_configured'
          ? "AegisAI n'est pas configuré sur cette instance de Kotbo."
          : "AegisAI ne répond pas pour l'instant. Réessayez dans quelques instants.",
      }, 503);
    }
    logger.error(LOG, `Erreur sur ${c.req.method} ${c.req.path} :`, err);
    return fail(c, err, 'Erreur sur Kotbo × AegisAI', LOG);
  });



  router.get(`${base}/aegis`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const [config, pendingCount, queue] = await Promise.all([
      prisma.aegisConfig.findUnique({ where: { guildId } }),
      prisma.aegisDetection.count({ where: { guildId, status: 'PENDING' } }),
      getAegisQueueStats(),
    ]);
    return send(c, {
      config: config ?? defaultConfig(guildId),
      saved: Boolean(config),
      pendingCount,
      status: { api: getAegisClient().status(), queue },
      canEdit: access.canManageSettings,
      canReview: canReview(access),
    });
  });

  router.patch(`${base}/aegis`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const { audit } = helpers(c);
    if (!access.canManageSettings) {
      return send(c, { error: 'Réglage réservé aux administrateurs du dashboard.' }, 403);
    }
    const body = (await readBody<Record<string, unknown>>(c)) ?? {};
    const existing = await prisma.aegisConfig.findUnique({ where: { guildId } });
    const current = existing ?? defaultConfig(guildId);
    const patch: Record<string, unknown> = sanitizeAegisPatch(body, current);
    if (body.trainingConsent !== undefined) {
      if (typeof body.trainingConsent !== 'boolean') {
        return send(c, { error: "Réponds par oui ou par non au partage pour l'entraînement." }, 400);
      }
      patch.trainingConsent = body.trainingConsent;
      patch.trainingConsentById = user.userId;
      patch.trainingConsentAt = new Date();
    }

    // La question du partage se pose avant la première mise en route.
    const consent = patch.trainingConsent ?? current.trainingConsent;
    if (patch.enabled === true && consent === null) {
      return send(c, { error: "Indique d'abord si les messages peuvent servir à entraîner le modèle d'AegisAI.", needsConsent: true }, 409);
    }

    const config = await prisma.aegisConfig.upsert({
      where: { guildId },
      create: { guildId, ...patch } as Prisma.AegisConfigUncheckedCreateInput,
      update: patch as Prisma.AegisConfigUncheckedUpdateInput,
    });
    await invalidateAegisConfig(guildId);

    const changes: string[] = [];
    if (patch.enabled !== undefined) changes.push(patch.enabled ? 'module activé' : 'module désactivé');
    if (patch.trainingConsent !== undefined) changes.push(`partage pour l'entraînement : ${patch.trainingConsent ? 'oui' : 'non'}`);
    const others = Object.keys(patch).filter((k) => !['enabled', 'trainingConsent', 'trainingConsentById', 'trainingConsentAt'].includes(k));
    if (others.length) changes.push(`réglages : ${others.join(', ')}`);
    if (changes.length) await audit('Kotbo × AegisAI', changes.join(' ; '));

    return send(c, { config, saved: true });
  });

  router.post(`${base}/aegis/test`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    if (!canReview(access)) {
      return send(c, { error: 'Essai réservé au staff de modération.' }, 403);
    }
    const body = await readBody<{ text?: unknown }>(c);
    const raw = typeof body?.text === 'string' ? body.text.slice(0, 2000) : '';
    const text = prepareText(raw);
    if (!text) {
      return send(c, { error: 'Rien à analyser : écris au moins un mot.' }, 400);
    }
    const api = getAegisClient();
    if (!api.configured) {
      return send(c, { error: "AegisAI n'est pas configuré sur ce bot." }, 503);
    }
    const config = (await prisma.aegisConfig.findUnique({ where: { guildId } })) ?? defaultConfig(guildId);
    // Même règle que les messages : partagé pour l'entraînement seulement si
    // le serveur l'a accepté (Vie privée).
    const save = config.trainingConsent === true;
    const scan = await scanText(text, save, config.autoThreshold);
    return send(c, {
      text,
      toxicity: scan.toxicity,
      emotion: scan.emotion,
      decision: decideToxicity(scan.toxicity, config, false),
      saved: save,
    });
  });

  router.get(`${base}/aegis/detections`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const status = (c.req.query('status') ?? null);
    const kind = (c.req.query('kind') ?? null);
    const before = (c.req.query('before') ?? null);
    const where: Record<string, unknown> = { guildId };
    if (status && (DETECTION_STATUSES as readonly string[]).includes(status)) where.status = status;
    if (kind && (DETECTION_KINDS as readonly string[]).includes(kind)) where.kind = kind;
    if (before && !Number.isNaN(Date.parse(before))) where.createdAt = { lt: new Date(before) };

    const rows = await prisma.aegisDetection.findMany({ where, orderBy: { createdAt: 'desc' }, take: 31 });
    const guild = client.guilds.cache.get(guildId);
    const nameOf = (id: string | null) => (id ? guild?.members.cache.get(id)?.displayName ?? null : null);
    const showExcerpts = canReview(access);
    return send(c, {
      detections: rows.slice(0, 30).map((d) => ({
        ...d,
        excerpt: showExcerpts ? d.excerpt : null,
        authorName: nameOf(d.authorId),
        authorAvatar: guild?.members.cache.get(d.authorId)?.displayAvatarURL({ size: 64 }) ?? null,
        targetName: nameOf(d.targetUserId),
        channelName: d.channelId ? guild?.channels.cache.get(d.channelId)?.name ?? null : null,
      })),
      hasMore: rows.length > 30,
    });
  });

  router.post(`${base}/aegis/detections/:detectionId/:verdict{confirm|dismiss|unslow}`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const detectionId = c.req.param('detectionId');
    const verdict = c.req.param('verdict');
    const { audit } = helpers(c);
      if (!canReview(access)) {
        return send(c, { error: 'Décision réservée au staff de modération.' }, 403);
      }
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return send(c, { error: 'Serveur introuvable pour le bot.' }, 404);
      }
      const actor = { id: user.userId, tag: user.username ?? user.userId };

      const result = verdict === 'confirm'
        ? await confirmDetection(client, guild, detectionId, actor)
        : verdict === 'dismiss'
          ? await dismissDetection(guild, detectionId, actor)
          : await unslowDetection(guild, detectionId, actor);
      if (!result.ok) {
        return send(c, { error: result.error }, 409);
      }
      await audit('Kotbo × AegisAI', `Détection ${detectionId} : ${verdict === 'confirm' ? 'confirmée' : verdict === 'dismiss' ? 'faux positif' : 'mode lent levé'}.`);
      return send(c, { detection: result.detection });
  });

  return router;
}

