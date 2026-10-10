import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, pushAudit, getGuildName, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import { getAegisClient, AegisRequestError, AegisUnavailableError } from '../../../services/moderation/aegis/aegisClient.js';
import { AegisConfigError, invalidateAegisConfig, sanitizeAegisPatch } from '../../../services/moderation/aegis/aegisConfig.js';
import { getAegisQueueStats } from '../../../services/moderation/aegis/aegisQueue.js';
import { prepareText } from '../../../services/moderation/aegis/aegisText.js';
import { scanText } from '../../../services/moderation/aegis/aegisProcessor.js';
import { decideToxicity } from '../../../services/moderation/aegis/aegisSignals.js';
import { confirmDetection, dismissDetection, unslowDetection } from '../../../services/moderation/aegis/aegisActions.js';

const SEGMENT = 'aegis';
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
export async function handleAegisRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== SEGMENT) return false;
  const method = req.method;
  const audit = (action: string, details: string) => pushAudit(guildId, {
    user: user.username ?? `User${user.userId}`,
    action,
    context: getGuildName(client, guildId),
    module: 'AutoMod',
    eventType: 'Settings',
    details,
    channelId: null,
  }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));

  try {
    // GET /aegis
    if (parts.length === 5 && method === 'GET') {
      const [config, pendingCount, queue] = await Promise.all([
        prisma.aegisConfig.findUnique({ where: { guildId } }),
        prisma.aegisDetection.count({ where: { guildId, status: 'PENDING' } }),
        getAegisQueueStats(),
      ]);
      json(res, 200, {
        config: config ?? defaultConfig(guildId),
        saved: Boolean(config),
        pendingCount,
        status: { api: getAegisClient().status(), queue },
        canEdit: access.canManageSettings,
        canReview: canReview(access),
      });
      return true;
    }

    // PATCH /aegis
    if (parts.length === 5 && method === 'PATCH') {
      if (!access.canManageSettings) {
        json(res, 403, { error: 'Réglage réservé aux administrateurs du dashboard.' });
        return true;
      }
      const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
      const existing = await prisma.aegisConfig.findUnique({ where: { guildId } });
      const current = existing ?? defaultConfig(guildId);
      const patch: Record<string, unknown> = sanitizeAegisPatch(body, current);

      if (body.trainingConsent !== undefined) {
        if (typeof body.trainingConsent !== 'boolean') {
          json(res, 400, { error: "Réponds par oui ou par non au partage pour l'entraînement." });
          return true;
        }
        patch.trainingConsent = body.trainingConsent;
        patch.trainingConsentById = user.userId;
        patch.trainingConsentAt = new Date();
      }

      // La question du partage se pose avant la première mise en route.
      const consent = patch.trainingConsent ?? current.trainingConsent;
      if (patch.enabled === true && consent === null) {
        json(res, 409, { error: "Indique d'abord si les messages peuvent servir à entraîner le modèle d'AegisAI.", needsConsent: true });
        return true;
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

      json(res, 200, { config, saved: true });
      return true;
    }

    // POST /aegis/test  { text }
    if (parts.length === 6 && parts[5] === 'test' && method === 'POST') {
      if (!canReview(access)) {
        json(res, 403, { error: 'Essai réservé au staff de modération.' });
        return true;
      }
      const body = await readJsonBody<{ text?: unknown }>(req);
      const raw = typeof body?.text === 'string' ? body.text.slice(0, 2000) : '';
      const text = prepareText(raw);
      if (!text) {
        json(res, 400, { error: 'Rien à analyser : écris au moins un mot.' });
        return true;
      }
      const api = getAegisClient();
      if (!api.configured) {
        json(res, 503, { error: "AegisAI n'est pas configuré sur ce bot." });
        return true;
      }
      const config = (await prisma.aegisConfig.findUnique({ where: { guildId } })) ?? defaultConfig(guildId);
      // Même règle que les messages : partagé pour l'entraînement seulement si
      // le serveur l'a accepté (Vie privée).
      const save = config.trainingConsent === true;
      const scan = await scanText(text, save, config.autoThreshold);
      json(res, 200, {
        text,
        toxicity: scan.toxicity,
        emotion: scan.emotion,
        decision: decideToxicity(scan.toxicity, config, false),
        saved: save,
      });
      return true;
    }

    // GET /aegis/detections
    if (parts.length === 6 && parts[5] === 'detections' && method === 'GET') {
      const status = url.searchParams.get('status');
      const kind = url.searchParams.get('kind');
      const before = url.searchParams.get('before');
      const where: Record<string, unknown> = { guildId };
      if (status && (DETECTION_STATUSES as readonly string[]).includes(status)) where.status = status;
      if (kind && (DETECTION_KINDS as readonly string[]).includes(kind)) where.kind = kind;
      if (before && !Number.isNaN(Date.parse(before))) where.createdAt = { lt: new Date(before) };

      const rows = await prisma.aegisDetection.findMany({ where, orderBy: { createdAt: 'desc' }, take: 31 });
      const guild = client.guilds.cache.get(guildId);
      const nameOf = (id: string | null) => (id ? guild?.members.cache.get(id)?.displayName ?? null : null);
      const showExcerpts = canReview(access);
      json(res, 200, {
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
      return true;
    }

    // POST /aegis/detections/:id/(confirm|dismiss|unslow)
    if (parts.length === 8 && parts[5] === 'detections' && method === 'POST' && ['confirm', 'dismiss', 'unslow'].includes(parts[7]!)) {
      if (!canReview(access)) {
        json(res, 403, { error: 'Décision réservée au staff de modération.' });
        return true;
      }
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        json(res, 404, { error: 'Serveur introuvable pour le bot.' });
        return true;
      }
      const actor = { id: user.userId, tag: user.username ?? user.userId };
      const detectionId = parts[6]!;
      const result = parts[7] === 'confirm'
        ? await confirmDetection(client, guild, detectionId, actor)
        : parts[7] === 'dismiss'
          ? await dismissDetection(guild, detectionId, actor)
          : await unslowDetection(guild, detectionId, actor);
      if (!result.ok) {
        json(res, 409, { error: result.error });
        return true;
      }
      await audit('Kotbo × AegisAI', `Détection ${detectionId} : ${parts[7] === 'confirm' ? 'confirmée' : parts[7] === 'dismiss' ? 'faux positif' : 'mode lent levé'}.`);
      json(res, 200, { detection: result.detection });
      return true;
    }
  } catch (err) {
    if (err instanceof AegisConfigError) {
      json(res, 400, { error: err.message });
      return true;
    }
    if (err instanceof AegisUnavailableError || err instanceof AegisRequestError) {
      json(res, 503, { error: `AegisAI ne répond pas pour l'instant (${err.message}).` });
      return true;
    }
    logger.error(LOG, `Erreur sur ${method} ${parts.join('/')} :`, err);
    jsonFailure(res, err, 'Erreur sur Kotbo × AegisAI', LOG);
    return true;
  }

  return false;
}
