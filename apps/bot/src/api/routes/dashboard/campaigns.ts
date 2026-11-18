/** Routes dashboard des campagnes marketing. */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { CampaignStatus, CampaignStepStatus, Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { pushAudit, getGuildName } from '../../shared.js';
import { canManageGuild } from '../../../utils/guildAdmin.js';
import { getCampaignReport, resolveAudience } from '../../../services/features/campaignService.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
/** Etapes d'une campagne, telles que le formulaire les envoie. */
type StepInput = {
  offsetMinutes?: unknown;
  delivery?: unknown;
  channelId?: unknown;
  content?: unknown;
  embed?: unknown;
};

function positiveOrNull(value: unknown): number | null {
  const parsed = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 50)
    : [];
}

/** Une campagne ne diffuse que sur des serveurs que l'appelant administre : sinon, publier chez n'importe qui. */
async function allTargetsManaged(client: Client, guildId: string, userId: string, value: unknown): Promise<boolean> {
  for (const target of ids(value)) {
    if (target !== guildId && !(await canManageGuild(client, target, userId))) return false;
  }
  return true;
}

function sanitizeEmbed(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!value || typeof value !== 'object') return Prisma.JsonNull;
  const raw = value as Record<string, unknown>;

  const embed: Record<string, string> = {};
  if (typeof raw.title === 'string' && raw.title.trim()) embed.title = raw.title.trim().slice(0, 256);
  if (typeof raw.description === 'string' && raw.description.trim()) embed.description = raw.description.trim().slice(0, 4096);
  if (typeof raw.imageUrl === 'string' && /^https:\/\//.test(raw.imageUrl)) embed.imageUrl = raw.imageUrl.slice(0, 500);
  if (typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)) embed.color = raw.color;

  return Object.keys(embed).length > 0 ? embed : Prisma.JsonNull;
}

/**
 * Valide les etapes. Une etape sans texte n'a rien a poster, et une etape en
 * salon sans salon n'a nulle part ou le poster : les deux sont refusees ici
 * plutot qu'a l'heure dite, ou l'echec passerait inapercu.
 */
function parseSteps(value: unknown): { steps: Prisma.CampaignStepCreateManyCampaignInput[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'Une campagne a besoin d\'au moins une étape.' };
  }

  const steps: Prisma.CampaignStepCreateManyCampaignInput[] = [];
  for (const [index, raw] of value.entries()) {
    const item = (raw ?? {}) as StepInput;
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, 2000) : '';
    const delivery = item.delivery === 'DM' ? 'DM' : 'CHANNEL';
    const channelId = typeof item.channelId === 'string' && item.channelId.trim() ? item.channelId.trim() : null;

    if (!content) return { error: `L'étape ${index + 1} n'a pas de texte.` };
    if (delivery === 'CHANNEL' && !channelId) return { error: `L'étape ${index + 1} n'a pas de salon de destination.` };

    const offset = Number(item.offsetMinutes);
    steps.push({
      position: index,
      // Un decalage negatif est legitime : c'est le teaser avant la date pivot.
      offsetMinutes: Number.isFinite(offset) ? Math.trunc(offset) : 0,
      delivery,
      channelId,
      content,
      embed: sanitizeEmbed(item.embed),
    });
  }

  return { steps };
}

export function createCampaignsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const adminAccess = createMiddleware(async (c, next) => {
    if (!c.var.access.canManageSettings) return send(c, { error: 'Accès refusé' }, 403);
    await next();
  });
  const gate = [...guildRoute(client), adminAccess] as const;


  router.get(`${base}/campaigns`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const campaigns = await prisma.campaign.findMany({
        where: { guildId },
        include: { steps: { orderBy: { position: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      return send(c, { campaigns });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur GET:', err);
      return fail(c, err, 'Erreur lors de la récupération des campagnes', 'CampaignsAPI');
    }
  });

  //
  // Compte l'audience avant l'enregistrement : un ciblage qui ne retient
  // personne, ou tout le serveur, se voit mieux avant l'envoi qu'apres.
  router.post(`${base}/campaigns/audience-preview`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        return send(c, { error: 'Serveur Discord introuvable' }, 404);
      }

      const body = (await readBody<Record<string, unknown>>(c)) ?? {};
      const audience = await resolveAudience(guild, {
        audienceRoleIds: ids(body.audienceRoleIds),
        audienceExcludeRoleIds: ids(body.audienceExcludeRoleIds),
        audienceMinLevel: positiveOrNull(body.audienceMinLevel),
        audienceMinTenureDays: positiveOrNull(body.audienceMinTenureDays),
        audienceInactiveDays: positiveOrNull(body.audienceInactiveDays),
      });

      return send(c, {
        count: audience.length,
        sample: audience.slice(0, 8).map((member) => ({ id: member.id, name: member.user.username })),
      });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur audience-preview:', err);
      return fail(c, err, 'Erreur lors du calcul de l\'audience', 'CampaignsAPI');
    }
  });

  router.post(`${base}/campaigns`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const body = (await readBody<Record<string, unknown>>(c)) ?? {};
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
      if (!name) {
        return send(c, { error: 'Le nom de la campagne est obligatoire.' }, 400);
      }

      const parsed = parseSteps(body.steps);
      if ('error' in parsed) {
        return send(c, { error: parsed.error }, 400);
      }

      if (!(await allTargetsManaged(client, guildId, user.userId, body.targetGuildIds))) {
        return send(c, { error: 'Vous devez être admin de chacun des serveurs ciblés.' }, 403);
      }

      const campaign = await prisma.campaign.create({
        data: {
          guildId,
          name,
          description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) : null,
          startAt: typeof body.startAt === 'string' && body.startAt ? new Date(body.startAt) : null,
          audienceRoleIds: ids(body.audienceRoleIds),
          audienceExcludeRoleIds: ids(body.audienceExcludeRoleIds),
          audienceMinLevel: positiveOrNull(body.audienceMinLevel),
          audienceMinTenureDays: positiveOrNull(body.audienceMinTenureDays),
          audienceInactiveDays: positiveOrNull(body.audienceInactiveDays),
          targetGuildIds: ids(body.targetGuildIds),
          inviteCode: typeof body.inviteCode === 'string' && body.inviteCode.trim()
            ? body.inviteCode.trim().slice(0, 30)
            : null,
          createdByUserId: user.userId,
          steps: { createMany: { data: parsed.steps } },
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: 'Création de campagne',
        context: getGuildName(client, guildId),
        module: 'Campagnes',
        eventType: 'Settings',
        details: `${name} · ${parsed.steps.length} étape(s)`,
      });

      return send(c, { campaign }, 201);
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur POST:', err);
      return fail(c, err, 'Erreur lors de la création de la campagne', 'CampaignsAPI');
    }
  });

  router.patch(`${base}/campaigns/:campaignId`, ...gate, async (c) => {
    const campaignId = c.req.param('campaignId');
    const guildId = c.req.param('guildId');
    try {
      const existing = await prisma.campaign.findFirst({ where: { id: campaignId, guildId } });
      if (!existing) {
        return send(c, { error: 'Campagne introuvable' }, 404);
      }

      const body = (await readBody<Record<string, unknown>>(c)) ?? {};

      // Modifier les etapes d'une campagne deja partie reecrirait l'histoire :
      // les etapes envoyees portent leurs mesures, qu'un remplacement effacerait.
      const wantsSteps = body.steps !== undefined;
      if (wantsSteps && existing.status !== CampaignStatus.DRAFT) {
        return send(c, { error: 'Les étapes ne se modifient qu\'en brouillon. Dupliquez la campagne pour la rejouer.' }, 409);
      }

      const parsed = wantsSteps ? parseSteps(body.steps) : null;
      if (parsed && 'error' in parsed) {
        return send(c, { error: parsed.error }, 400);
      }

      if (body.targetGuildIds !== undefined && !(await allTargetsManaged(client, guildId, user.userId, body.targetGuildIds))) {
        return send(c, { error: 'Vous devez être admin de chacun des serveurs ciblés.' }, 403);
      }

      const campaign = await prisma.$transaction(async (tx) => {
        if (parsed && 'steps' in parsed) {
          await tx.campaignStep.deleteMany({ where: { campaignId } });
          await tx.campaignStep.createMany({
            data: parsed.steps.map((step) => ({ ...step, campaignId })),
          });
        }

        return tx.campaign.update({
          where: { id: campaignId },
          data: {
            name: typeof body.name === 'string' ? body.name.trim().slice(0, 120) : undefined,
            description: body.description !== undefined
              ? (typeof body.description === 'string' ? body.description.trim().slice(0, 500) : null)
              : undefined,
            startAt: body.startAt !== undefined
              ? (typeof body.startAt === 'string' && body.startAt ? new Date(body.startAt) : null)
              : undefined,
            audienceRoleIds: body.audienceRoleIds !== undefined ? ids(body.audienceRoleIds) : undefined,
            audienceExcludeRoleIds: body.audienceExcludeRoleIds !== undefined ? ids(body.audienceExcludeRoleIds) : undefined,
            audienceMinLevel: body.audienceMinLevel !== undefined ? positiveOrNull(body.audienceMinLevel) : undefined,
            audienceMinTenureDays: body.audienceMinTenureDays !== undefined ? positiveOrNull(body.audienceMinTenureDays) : undefined,
            audienceInactiveDays: body.audienceInactiveDays !== undefined ? positiveOrNull(body.audienceInactiveDays) : undefined,
            targetGuildIds: body.targetGuildIds !== undefined ? ids(body.targetGuildIds) : undefined,
            inviteCode: body.inviteCode !== undefined
              ? (typeof body.inviteCode === 'string' && body.inviteCode.trim() ? body.inviteCode.trim().slice(0, 30) : null)
              : undefined,
          },
          include: { steps: { orderBy: { position: 'asc' } } },
        });
      });

      return send(c, { campaign });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur PATCH:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la campagne', 'CampaignsAPI');
    }
  });

  router.delete(`${base}/campaigns/:campaignId`, ...gate, async (c) => {
    const campaignId = c.req.param('campaignId');
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const { count } = await prisma.campaign.deleteMany({ where: { id: campaignId, guildId } });
      if (count === 0) {
        return send(c, { error: 'Campagne introuvable' }, 404);
      }

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: 'Suppression de campagne',
        context: getGuildName(client, guildId),
        module: 'Campagnes',
        eventType: 'Settings',
        details: campaignId,
      });

      return send(c, { success: true });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur DELETE:', err);
      return fail(c, err, 'Erreur lors de la suppression de la campagne', 'CampaignsAPI');
    }
  });

  router.post(`${base}/campaigns/:campaignId/status`, ...gate, async (c) => {
    const campaignId = c.req.param('campaignId');
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const existing = await prisma.campaign.findFirst({ where: { id: campaignId, guildId } });
      if (!existing) {
        return send(c, { error: 'Campagne introuvable' }, 404);
      }

      const body = await readBody<{ status?: unknown }>(c);
      const wanted = body?.status;

      // Seules trois transitions sont pilotees a la main : lancer, annuler,
      // remettre en brouillon. Le passage a RUNNING puis COMPLETED appartient
      // au cycle, qui seul sait ou en sont les etapes.
      if (wanted !== 'SCHEDULED' && wanted !== 'CANCELLED' && wanted !== 'DRAFT') {
        return send(c, { error: 'Transition non autorisée' }, 400);
      }

      if (wanted === 'SCHEDULED' && !existing.startAt) {
        return send(c, { error: 'Donnez une date de départ avant de lancer la campagne.' }, 400);
      }

      const campaign = await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: wanted as CampaignStatus,
          // Repasser en brouillon remet les etapes non parties a zero : sans
          // cela, une campagne relancee sauterait tout ce qui etait deja du.
          ...(wanted === 'DRAFT'
            ? { steps: { updateMany: { where: { status: CampaignStepStatus.FAILED }, data: { status: CampaignStepStatus.PENDING, lastError: null } } } }
            : {}),
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: `Campagne : ${wanted}`,
        context: getGuildName(client, guildId),
        module: 'Campagnes',
        eventType: 'Settings',
        details: existing.name,
      });

      return send(c, { campaign });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur POST status:', err);
      return fail(c, err, 'Erreur lors du changement de statut', 'CampaignsAPI');
    }
  });

  router.get(`${base}/campaigns/:campaignId/report`, ...gate, async (c) => {
    const campaignId = c.req.param('campaignId');
    const guildId = c.req.param('guildId');
    try {
      const exists = await prisma.campaign.findFirst({ where: { id: campaignId, guildId }, select: { id: true } });
      if (!exists) {
        return send(c, { error: 'Campagne introuvable' }, 404);
      }
      return send(c, { report: await getCampaignReport(campaignId) });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur GET report:', err);
      return fail(c, err, 'Erreur lors du calcul des indicateurs', 'CampaignsAPI');
    }
  });

  return router;
}

