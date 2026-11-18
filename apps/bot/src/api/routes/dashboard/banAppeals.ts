import { AppealItemOutcome, type BanAppealStatus } from '@prisma/client';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { resolveMemberFeatureAccess } from '../../shared.js';
import { setDashboardModuleStatus } from '../../../services/core/moduleActivationService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import {
  APPEALABLE_SANCTION_TYPES,
  applyItemOutcome,
  decideAppeal,
  findConflictingItems,
  ensureDefaultAppealForm,
  getAppealConfig,
  getAppealDetail,
  getAppeals,
  getModeratorAppealStats,
  requestAppealInfo,
  upsertAppealConfig,
  type AppealDecision,
} from '../../../services/moderation/banAppealService.js';

interface AppealConfigBody {
  enabled?: boolean;
  formId?: string | null;
  staffChannelId?: string | null;
  inviteChannelId?: string | null;
  cooldownDays?: number;
  welcomeText?: string | null;
  acceptMessage?: string | null;
  denyMessage?: string | null;
  notifyOnBanDM?: boolean;
  createDefaultForm?: boolean;
  appealVerification?: boolean;
  appealSaveIp?: boolean;
  appealSaveDevice?: boolean;
  appealVerificationLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  appealableTypes?: string[];
  maxSanctionsPerAppeal?: number;
  appealWindowDays?: number | null;
  cooldownByType?: Record<string, unknown> | null;
  formIdByType?: Record<string, unknown> | null;
  notifyOnSanctionDM?: boolean;
  excludeIssuingModerator?: boolean;
  notifyIssuingModerator?: boolean;
}

const VALID_OUTCOMES = new Set<string>(Object.values(AppealItemOutcome));

/**
 * Normalise les réglages « contestation étendue » venus du dashboard : rien de
 * ce qui vient du navigateur n'entre en base sans être borné et filtré.
 */
function sanitizeAppealScopeSettings(body: AppealConfigBody) {
  const out: Record<string, unknown> = {};

  if (body.appealableTypes !== undefined) {
    const requested = Array.isArray(body.appealableTypes) ? body.appealableTypes : [];
    out.appealableTypes = APPEALABLE_SANCTION_TYPES.filter(type => requested.includes(type));
  }

  if (body.maxSanctionsPerAppeal !== undefined) {
    out.maxSanctionsPerAppeal = Math.max(1, Math.min(10, Math.round(Number(body.maxSanctionsPerAppeal) || 1)));
  }

  if (body.appealWindowDays !== undefined) {
    const parsed = Number(body.appealWindowDays);
    out.appealWindowDays = body.appealWindowDays === null || !Number.isFinite(parsed) || parsed <= 0
      ? null
      : Math.min(3650, Math.round(parsed));
  }

  if (body.cooldownByType !== undefined) {
    if (body.cooldownByType === null) {
      out.cooldownByType = null;
    } else {
      const map: Record<string, number> = {};
      for (const type of APPEALABLE_SANCTION_TYPES) {
        const raw = Number((body.cooldownByType as Record<string, unknown>)[type]);
        if (Number.isFinite(raw) && raw >= 0) map[type] = Math.min(365, Math.round(raw));
      }
      out.cooldownByType = Object.keys(map).length > 0 ? map : null;
    }
  }

  if (body.formIdByType !== undefined) {
    if (body.formIdByType === null) {
      out.formIdByType = null;
    } else {
      const map: Record<string, string> = {};
      for (const type of APPEALABLE_SANCTION_TYPES) {
        const raw = (body.formIdByType as Record<string, unknown>)[type];
        if (typeof raw === 'string' && raw.trim()) map[type] = raw.trim();
      }
      out.formIdByType = Object.keys(map).length > 0 ? map : null;
    }
  }

  for (const key of ['notifyOnSanctionDM', 'excludeIssuingModerator', 'notifyIssuingModerator'] as const) {
    if (body[key] !== undefined) out[key] = !!body[key];
  }

  return out;
}

/**
 * Routes de gestion des appels de bannissement.
 * Base: /api/dashboard/guilds/:guildId/appeals
 */
export function createBanAppealsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Décider d'un appel = modération de contenu au minimum, et le droit
  // « Appels de bannissement » du centre de gestion quand le serveur en a pose
  // un : sans ce second test, la section restait ouverte a tout moderateur
  // Discord meme apres avoir ete retiree a son role.
  const appealsAccess = createMiddleware(async (c, next) => {
    const access = c.var.effectiveAccess;
    const featureAccess = await resolveMemberFeatureAccess(client, c.req.param('guildId')!, access, c.var.dashboardUser.userId);
    const canHandleAppeals = access.canManageSettings
      || featureAccess.ban_appeals?.canModerate === true
      || (access.canModerateContent && featureAccess.ban_appeals?.canModerate !== false);
    if (!canHandleAppeals) {
      return send(c, { error: 'Accès modérateur requis pour gérer les appels de bannissement' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), appealsAccess] as const;



  router.get(`${base}/appeals`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const status = c.req.query('status') as BanAppealStatus | undefined;
      const appeals = await getAppeals(guildId, status);
      return send(c, { appeals });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error listing appeals:', err);
      return fail(c, err, 'Erreur lors de la récupération des appels', 'BanAppealsAPI');
    }
  });

  router.get(`${base}/appeals/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const config = await getAppealConfig(guildId);
      return send(c, { config });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error getting appeal config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration', 'BanAppealsAPI');
    }
  });

  router.put(`${base}/appeals/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    if (!access.canManageSettings) {
      return send(c, { error: 'Accès administrateur requis pour configurer les appels' }, 403);
    }
    try {
      const body = await readBody<AppealConfigBody>(c);
      if (!body) {
        return send(c, { error: 'Le corps de la requête est vide' }, 400);
      }

      const { createDefaultForm, ...data } = body;

      if (data.cooldownDays !== undefined) {
        data.cooldownDays = Math.max(0, Math.min(365, Math.round(Number(data.cooldownDays) || 0)));
      }

      // Vérifie que le formulaire lié appartient bien à la guilde
      if (data.formId) {
        const form = await prisma.customForm.findFirst({ where: { id: data.formId, guildId }, select: { id: true } });
        if (!form) {
          return send(c, { error: 'Formulaire introuvable sur ce serveur' }, 400);
        }
      }

      const scopeSettings = sanitizeAppealScopeSettings(data);

      // Même contrôle pour les formulaires par type : un id de formulaire
      // appartenant à un autre serveur exposerait ses questions ici.
      const perTypeForms = scopeSettings.formIdByType as Record<string, string> | null | undefined;
      if (perTypeForms) {
        const ids = [...new Set(Object.values(perTypeForms))];
        const found = await prisma.customForm.findMany({ where: { id: { in: ids }, guildId }, select: { id: true } });
        if (found.length !== ids.length) {
          return send(c, { error: 'Un des formulaires par type est introuvable sur ce serveur' }, 400);
        }
      }

      // L'interrupteur de la page est celui du module : le laisser écrire la
      // seule table laisserait la ligne du registre dire l'inverse, et c'est
      // elle que lit la garde. La bascule écrit les deux.
      const {
        enabled,
        appealableTypes: _rawTypes,
        maxSanctionsPerAppeal: _rawMax,
        appealWindowDays: _rawWindow,
        cooldownByType: _rawCooldowns,
        formIdByType: _rawForms,
        notifyOnSanctionDM: _rawSanctionDM,
        excludeIssuingModerator: _rawExclude,
        notifyIssuingModerator: _rawNotifyMod,
        ...settings
      } = data;
      await upsertAppealConfig(guildId, { ...settings, ...scopeSettings });

      if (enabled !== undefined) {
        const current = await getAppealConfig(guildId);
        if (current?.enabled !== enabled) {
          await setDashboardModuleStatus(guildId, 'ban_appeals', enabled);
        }
      }

      if (createDefaultForm) {
        await ensureDefaultAppealForm(guildId);
      }

      const config = await getAppealConfig(guildId);
      return send(c, { config });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error updating appeal config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'BanAppealsAPI');
    }
  });

  router.get(`${base}/appeals/blacklist`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const entries = await prisma.banAppealBlacklist.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });
      return send(c, { entries });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error listing appeal blacklist:', err);
      return fail(c, err, 'Erreur lors de la récupération de la blacklist', 'BanAppealsAPI');
    }
  });

  router.delete(`${base}/appeals/blacklist/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    try {
      await prisma.banAppealBlacklist.deleteMany({ where: { guildId, userId: userId } });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error removing appeal blacklist entry:', err);
      return fail(c, err, 'Erreur lors de la suppression de la blacklist', 'BanAppealsAPI');
    }
  });

  router.get(`${base}/appeals/moderator-stats`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const stats = await getModeratorAppealStats(guildId);
      return send(c, { stats });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error computing moderator appeal stats:', err);
      return fail(c, err, 'Erreur lors du calcul des statistiques', 'BanAppealsAPI');
    }
  });

  // Verdict d'UNE sanction contestée, appliqué immédiatement (archivage,
  // suppression ou verrou), sans clore l'appel : le staff peut trancher
  // sanction par sanction puis prononcer la décision globale.
  router.post(`${base}/appeals/:appealId/items/:itemId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const appealId = c.req.param('appealId');
    const itemId = c.req.param('itemId');
    try {
      const body = await readBody<{ outcome: string; note?: string }>(c);
      if (!body?.outcome || !VALID_OUTCOMES.has(body.outcome)) {
        return send(c, { error: 'Verdict invalide' }, 400);
      }
      if (body.outcome === AppealItemOutcome.DELETED && access.level !== 'admin') {
        return send(c, { error: 'Seuls les administrateurs peuvent supprimer définitivement une sanction.' }, 403);
      }

      const item = await prisma.banAppealSanction.findFirst({
        where: { id: itemId, guildId, appealId },
        select: { id: true },
      });
      if (!item) {
        return send(c, { error: 'Sanction contestée introuvable' }, 404);
      }

      // Même garde que sur l'embed Discord : on ne juge pas sa propre sanction.
      const config = await getAppealConfig(guildId);
      const conflicts = await findConflictingItems(appealId, user.userId, config);
      if (conflicts.some(conflict => conflict.id === item.id)) {
        return send(c, { error: "Tu as prononcé cette sanction : un autre membre du staff doit la trancher." }, 403);
      }

      const result = await applyItemOutcome(client, {
        guildId,
        itemId: itemId,
        outcome: body.outcome as AppealItemOutcome,
        actor: { userId: user.userId, tag: user.username },
        note: body.note,
      });

      if (!result.ok) {
        return send(c, { error: result.error }, 409);
      }
      return send(c, { item: result.item });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error applying appeal item outcome:', err);
      return fail(c, err, 'Erreur lors de l\'application du verdict', 'BanAppealsAPI');
    }
  });

  router.get(`${base}/appeals/:appealId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const appealId = c.req.param('appealId');
    try {
      const detail = await getAppealDetail(appealId, guildId);
      if (!detail) {
        return send(c, { error: 'Appel introuvable' }, 404);
      }
      return send(c, detail);
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error getting appeal detail:', err);
      return fail(c, err, 'Erreur lors de la récupération de l\'appel', 'BanAppealsAPI');
    }
  });

  router.post(`${base}/appeals/:appealId/decide`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const appealId = c.req.param('appealId');
    try {
      const body = await readBody<{
        decision: AppealDecision;
        reason?: string;
        outcomes?: Record<string, string>;
      }>(c);
      if (!body?.decision || !['ACCEPTED', 'DENIED', 'DENIED_PERMANENT'].includes(body.decision)) {
        return send(c, { error: 'Décision invalide' }, 400);
      }
      if (body.decision !== 'ACCEPTED' && !body.reason?.trim()) {
        return send(c, { error: 'Une raison est requise pour un refus' }, 400);
      }

      // Verdicts par sanction : on n'accepte que des valeurs connues, et la
      // suppression définitive reste réservée aux administrateurs.
      const outcomes: Record<string, AppealItemOutcome> = {};
      for (const [itemId, value] of Object.entries(body.outcomes ?? {})) {
        if (!VALID_OUTCOMES.has(value)) {
          return send(c, { error: `Verdict invalide pour la sanction ${itemId}` }, 400);
        }
        if (value === AppealItemOutcome.DELETED && access.level !== 'admin') {
          return send(c, { error: 'Seuls les administrateurs peuvent supprimer définitivement une sanction.' }, 403);
        }
        outcomes[itemId] = value as AppealItemOutcome;
      }

      const result = await decideAppeal(client, {
        appealId,
        guildId,
        decision: body.decision,
        staffUserId: user.userId,
        staffTag: user.username,
        reason: body.reason?.trim() || undefined,
        outcomes,
      });

      if (!result.ok) {
        return send(c, { error: result.error }, 409);
      }
      return send(c, { appeal: result.appeal });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error deciding appeal:', err);
      return fail(c, err, 'Erreur lors de la décision', 'BanAppealsAPI');
    }
  });

  router.post(`${base}/appeals/:appealId/request-info`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const appealId = c.req.param('appealId');
    try {
      const body = await readBody<{ question: string }>(c);
      if (!body?.question?.trim()) {
        return send(c, { error: 'La question est requise' }, 400);
      }

      const result = await requestAppealInfo(client, {
        appealId,
        guildId,
        question: body.question.trim().slice(0, 1000),
        staffUserId: user.userId,
        staffTag: user.username,
      });

      if (!result.ok) {
        return send(c, { error: result.error }, 409);
      }
      return send(c, { appeal: result.appeal });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error requesting appeal info:', err);
      return fail(c, err, 'Erreur lors de la demande d\'informations', 'BanAppealsAPI');
    }
  });

  return router;
}

