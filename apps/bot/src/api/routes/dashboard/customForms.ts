import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { Prisma } from '@prisma/client';
import { logger } from '../../../utils/logger.js';
import {
  countRecruitmentForms,
  createCustomForm,
  getCustomForms,
  getCustomForm,
  deleteCustomForm,
  getCustomFormSubmissions,
  type CustomFormStructure,
} from '../../../services/features/customFormService.js';
import { sanitizeCustomCss, sanitizeFormTheme } from '../../../utils/formCustomization.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { refreshRecruitmentPanels, syncRecruitmentFormAvailability } from '../../../services/staff/recruitmentPanelService.js';

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { assertFreeQuota } from '../../../services/system/freeQuota.js';
interface CustomFormCreateBody {
  name: string;
  description?: string;
  structure?: CustomFormStructure;
  isRecruitment?: boolean;
  requiresDiscordAuth?: boolean;
  theme?: unknown;
  customCss?: string | null;
  hierarchyId?: string | null;
}

interface CustomFormUpdateBody {
  name?: string;
  description?: string;
  structure?: CustomFormStructure;
  isActive?: boolean;
  isRecruitment?: boolean;
  requiresDiscordAuth?: boolean;
  theme?: unknown;
  customCss?: string | null;
  hierarchyId?: string | null;
  maxPendingCandidatures?: number | null;
  maxAcceptedCandidatures?: number | null;
  acceptedCapMode?: string;
}

/** Plafond de fermeture automatique : vide ou 0 = aucun, sinon un entier de 1 à 10 000. */
function parseCap(value: unknown): number | null | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 0) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 'invalid';
}

/**
 * Handles custom form management endpoints
 */
export function createCustomFormsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);



  router.get(`${base}/custom-forms`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const forms = await getCustomForms(guildId, (c.req.query('includeStructure') ?? null) === 'true');
      return send(c, { forms });
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error getting custom forms:', err);
      return fail(c, err, 'Erreur lors de la récupération des formulaires', 'CustomFormsAPI');
    }
  });

  router.post(`${base}/custom-forms`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<CustomFormCreateBody>(c);

      if (!body?.name) {
        return send(c, { error: 'Le nom du formulaire est requis' }, 400);
      }

      if (body.hierarchyId) {
        const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId } });
        if (!hierarchy) {
          return send(c, { error: 'Hiérarchie introuvable pour ce serveur' }, 400);
        }
      }

      const form = await createCustomForm(guildId, {
        name: body.name,
        description: body.description,
        structure: body.structure || { title: body.name, fields: [] },
        isRecruitment: body.isRecruitment,
        requiresDiscordAuth: body.requiresDiscordAuth,
        theme: sanitizeFormTheme(body.theme),
        customCss: sanitizeCustomCss(body.customCss),
        hierarchyId: body.hierarchyId ?? undefined,
      });

      return send(c, { form }, 201);
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error creating custom form:', err);
      return fail(c, err, 'Erreur lors de la création du formulaire', 'CustomFormsAPI');
    }
  });

  router.get(`${base}/custom-forms/:formId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      const form = await getCustomForm(formId, guildId);
      if (!form) {
        return send(c, { error: 'Formulaire introuvable' }, 404);
      }
      return send(c, { form });
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error getting custom form:', err);
      return fail(c, err, 'Erreur lors de la récupération du formulaire', 'CustomFormsAPI');
    }
  });

  router.patch(`${base}/custom-forms/:formId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      const body = await readBody<CustomFormUpdateBody>(c);

      if (!body) {
        return send(c, { error: 'Le corps de la requête est vide' }, 400);
      }

      if (body.hierarchyId) {
        const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId } });
        if (!hierarchy) {
          return send(c, { error: 'Hiérarchie introuvable pour ce serveur' }, 400);
        }
      }

      const maxPending = parseCap(body.maxPendingCandidatures);
      const maxAccepted = parseCap(body.maxAcceptedCandidatures);
      if (maxPending === 'invalid' || maxAccepted === 'invalid') {
        return send(c, { error: 'Un plafond de candidatures doit être un entier entre 1 et 10 000.' }, 400);
      }
      if (body.acceptedCapMode !== undefined && body.acceptedCapMode !== 'RESET' && body.acceptedCapMode !== 'TOTAL') {
        return send(c, { error: 'Mode de plafond inconnu.' }, 400);
      }

      const current = await prisma.customForm.findFirst({
        where: { id: formId, guildId },
        select: { isActive: true, acceptedCapMode: true, isRecruitment: true },
      });
      // Passer un formulaire en recrutement en crée un de plus pour le plafond gratuit.
      if (current && body.isRecruitment === true && !current.isRecruitment) {
        await assertFreeQuota(guildId, 'recruitmentForms', () => countRecruitmentForms(guildId));
      }
      // Ouvrir ou fermer a la main reprend la main sur le bot : la fermeture
      // automatique est oubliee, et en mode RESET une reouverture relance une
      // vague de recrutement avec un compteur d'acceptes a zero.
      const manualToggle = current !== null && body.isActive !== undefined && body.isActive !== current.isActive;
      const capMode = body.acceptedCapMode ?? current?.acceptedCapMode;

      // Clean database update
      await prisma.customForm.updateMany({
        where: { id: formId, guildId },
        data: {
          ...(manualToggle ? { autoClosedReason: null, ...(body.isActive && capMode === 'RESET' ? { acceptedCount: 0 } : {}) } : {}),
          maxPendingCandidatures: maxPending,
          maxAcceptedCandidatures: maxAccepted,
          acceptedCapMode: body.acceptedCapMode,
          name: body.name,
          description: body.description,
          structure: body.structure ? (body.structure as unknown as Prisma.InputJsonValue) : undefined,
          isActive: body.isActive !== undefined ? body.isActive : undefined,
          isRecruitment: body.isRecruitment !== undefined ? body.isRecruitment : undefined,
          requiresDiscordAuth: body.requiresDiscordAuth !== undefined ? body.requiresDiscordAuth : undefined,
          // Le thème et le CSS sont sanitizés côté serveur : null efface, undefined ignore
          theme: body.theme !== undefined
            ? ((sanitizeFormTheme(body.theme) ?? Prisma.JsonNull) as Prisma.InputJsonValue)
            : undefined,
          customCss: body.customCss !== undefined ? sanitizeCustomCss(body.customCss) : undefined,
          hierarchyId: body.hierarchyId !== undefined ? body.hierarchyId : undefined,
        },
      });

      // Un plafond baisse peut fermer le poste tout de suite ; une reouverture
      // manuelle, elle, n'est pas recalculee (sinon elle se refermerait aussitot).
      if (!manualToggle) await syncRecruitmentFormAvailability(formId);
      await refreshRecruitmentPanels(guildId, formId).catch(() => null);

      return send(c, { ok: true });
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error updating custom form:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du formulaire', 'CustomFormsAPI');
    }
  });

  router.delete(`${base}/custom-forms/:formId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      await deleteCustomForm(formId, guildId);
      await refreshRecruitmentPanels(guildId, formId).catch(() => null);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error deleting custom form:', err);
      return fail(c, err, 'Erreur lors de la suppression du formulaire', 'CustomFormsAPI');
    }
  });

  router.get(`${base}/custom-forms/:formId/submissions`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      const limit = Math.min(Math.max(Number((c.req.query('limit') ?? null)) || 100, 1), 250);
      const offset = Math.max(Number((c.req.query('offset') ?? null)) || 0, 0);
      const [submissions, total] = await Promise.all([
        getCustomFormSubmissions(formId, guildId, limit, offset),
        prisma.customFormSubmission.count({ where: { formId, guildId } }),
      ]);
      // La soumission fige le pseudo au moment de l'envoi et ne stocke aucune
      // photo : on resout l'identite pour que la liste affiche un visage.
      const identities = await getMemberIdentities(
        client,
        guildId,
        submissions.map((submission) => submission.userId).filter((id): id is string => !!id),
      );
      return send(c, {
        submissions: submissions.map((submission) => {
          const identity = submission.userId ? identities.get(submission.userId) : undefined;
          return {
            ...submission,
            username: identity?.displayName || submission.username,
            avatarUrl: identity?.avatarUrl || null,
          };
        }),
        total,
        limit,
        offset,
      });
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error getting custom form submissions:', err);
      return fail(c, err, 'Erreur lors de la récupération des soumissions', 'CustomFormsAPI');
    }
  });

  return router;
}

