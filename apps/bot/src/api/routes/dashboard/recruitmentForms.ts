import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import {
  createRecruitmentForm,
  getRecruitmentForms,
  getRecruitmentForm,
  updateRecruitmentForm,
  deleteRecruitmentForm,
  regenerateFormAPIKey,
  generateGoogleAppsScript,
  generateDefaultRecruitmentForm,
  generateSimpleRecruitmentForm,
  type FormStructure,
} from '../../../services/staff/recruitmentFormService.js';

/**
 * Handles recruitment form management endpoints
 */
export function createRecruitmentFormsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/recruitment/forms`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const forms = await getRecruitmentForms(guildId);
      return send(c, { forms });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error getting forms:', err);
      return fail(c, err, 'Erreur lors de la récupération des formulaires', 'RecruitmentFormAPI');
    }
  });

  router.post(`${base}/recruitment/forms`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        name: string;
        description?: string;
        structure?: FormStructure;
        template?: 'default' | 'simple' | 'custom' | 'google';
      }>(c);

      if (!body?.name) {
        return send(c, { error: 'Le nom du formulaire est requis' }, 400);
      }

      // Use template or custom structure
      let structure = body.structure;
      if (body.template === 'default') {
        structure = generateDefaultRecruitmentForm();
        structure.type = 'default';
      } else if (body.template === 'simple') {
        structure = generateSimpleRecruitmentForm();
        structure.type = 'simple';
      } else if (body.template === 'google') {
        if (structure) structure.type = 'google';
      } else if (body.template === 'custom') {
        if (structure) structure.type = 'custom';
      }

      if (!structure) {
        return send(c, { error: 'La structure du formulaire est requise' }, 400);
      }

      // Get staff member for createdByUserId (FK constraint on APIKey)
      let staffMember = await prisma.staffMember.findUnique({
        where: { guildId_userId: { guildId, userId: user.userId } },
      });

      // Fallback: any staff member in the guild (required for FK constraint)
      if (!staffMember) {
        staffMember = await prisma.staffMember.findFirst({
          where: { guildId },
        });
      }

      if (!staffMember) {
        return send(c, { error: 'Aucun membre staff trouvé pour ce serveur. Ajoutez au moins un membre staff avant de créer un formulaire.' }, 403);
      }

      const createdById = staffMember.id;

      const result = await createRecruitmentForm(
        guildId,
        createdById,
        body.name,
        body.description,
        structure
      );

      return send(c, {
        form: result.form,
        apiKey: result.apiKey,
        displayKey: result.displayKey,
      }, 201);
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error creating form:', err);
      return fail(c, err, 'Erreur lors de la création du formulaire', 'RecruitmentFormAPI');
    }
  });

  // Déclarée avant `/:formId`, qui la captait dans l'ancien routeur.
  router.get(`${base}/recruitment/forms/templates`, ...gate, async (c) => {
    try {
      const templates = {
        default: generateDefaultRecruitmentForm(),
        simple: generateSimpleRecruitmentForm(),
      };
      return send(c, { templates });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error getting templates:', err);
      return fail(c, err, 'Erreur lors de la récupération des templates', 'RecruitmentFormAPI');
    }
  });

  router.get(`${base}/recruitment/forms/:formId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      const form = await getRecruitmentForm(formId, guildId);
      if (!form) {
        return send(c, { error: 'Formulaire introuvable' }, 404);
      }
      return send(c, { form });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error getting form:', err);
      return fail(c, err, 'Erreur lors de la récupération du formulaire', 'RecruitmentFormAPI');
    }
  });

  router.patch(`${base}/recruitment/forms/:formId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      const body = await readBody<{
        name?: string;
        description?: string;
        structure?: FormStructure;
        isActive?: boolean;
      }>(c);

      await updateRecruitmentForm(formId, guildId, body || {});
      return send(c, { ok: true });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error updating form:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du formulaire', 'RecruitmentFormAPI');
    }
  });

  router.delete(`${base}/recruitment/forms/:formId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      await deleteRecruitmentForm(formId, guildId);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error deleting form:', err);
      return fail(c, err, 'Erreur lors de la suppression du formulaire', 'RecruitmentFormAPI');
    }
  });

  router.post(`${base}/recruitment/forms/:formId/regenerate-key`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const formId = c.req.param('formId');
    try {
      // Resolve staff member ID (FK constraint requires a valid StaffMember.id)
      let staffMember = await prisma.staffMember.findUnique({
        where: { guildId_userId: { guildId, userId: user.userId } },
      });

      // Fallback: any staff member in the guild
      if (!staffMember) {
        staffMember = await prisma.staffMember.findFirst({
          where: { guildId },
        });
      }

      if (!staffMember) {
        return send(c, { error: 'Aucun membre staff trouvé pour ce serveur.' }, 403);
      }

      logger.info('RecruitmentFormAPI', `Regenerating key for form ${formId} with staffMember ${staffMember.id}`);
      const result = await regenerateFormAPIKey(formId, guildId, staffMember.id);
      return send(c, { apiKey: result.apiKey, displayKey: result.displayKey });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error regenerating API key:', err);
      return fail(c, err, 'Erreur lors de la régénération de la clé API', 'RecruitmentFormAPI');
    }
  });

  router.get(`${base}/recruitment/forms/:formId/script`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      const form = await getRecruitmentForm(formId, guildId);
      if (!form) {
        return send(c, { error: 'Formulaire introuvable' }, 404);
      }

      const url = new URL(c.req.url);
      const webhookUrl = `${url.protocol}//${url.host}/api/dashboard/guilds/${guildId}/recruitment/candidatures`;
      const apiKey = form.apiKey?.displayKey || 'YOUR_API_KEY';
      const script = generateGoogleAppsScript(webhookUrl, apiKey, form.name, guildId);

      return send(c, { script });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error generating script:', err);
      return fail(c, err, 'Erreur lors de la génération du script', 'RecruitmentFormAPI');
    }
  });

  router.get(`${base}/recruitment/forms/:formId/responses`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const formId = c.req.param('formId');
    try {
      const limit = Math.min(Math.max(Number((c.req.query('limit') ?? null)) || 100, 1), 250);
      const offset = Math.max(Number((c.req.query('offset') ?? null)) || 0, 0);
      const form = await prisma.recruitmentForm.findFirst({
        where: { id: formId, guildId },
        select: { id: true },
      });
      if (!form) {
        return send(c, { error: 'Formulaire introuvable' }, 404);
      }

      const [responses, total] = await Promise.all([
        prisma.recruitmentCandidature.findMany({
          where: { formId, guildId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            discordId: true,
            username: true,
            email: true,
            status: true,
            data: true,
            notes: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.recruitmentCandidature.count({ where: { formId, guildId } }),
      ]);

      return send(c, { responses, total, limit, offset });
    } catch (err) {
      logger.error('RecruitmentFormAPI', 'Error fetching form responses:', err);
      return fail(c, err, 'Erreur lors de la récupération des réponses', 'RecruitmentFormAPI');
    }
  });

  return router;
}

