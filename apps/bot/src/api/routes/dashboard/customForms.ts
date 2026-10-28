import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { Prisma } from '@prisma/client';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
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

import { jsonFailure } from '../../shared/failure.js';
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
export async function handleCustomFormRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  _client: Client,
  _user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;

  if (parts[4] !== 'custom-forms') {
    return false;
  }

  // GET /api/dashboard/guilds/:guildId/custom-forms - List all forms
  if (parts.length === 5 && method === 'GET') {
    try {
      const forms = await getCustomForms(guildId, url.searchParams.get('includeStructure') === 'true');
      json(res, 200, { forms });
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error getting custom forms:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des formulaires', 'CustomFormsAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/custom-forms - Create new form
  if (parts.length === 5 && method === 'POST') {
    try {
      const body = await readJsonBody<CustomFormCreateBody>(req);

      if (!body?.name) {
        json(res, 400, { error: 'Le nom du formulaire est requis' });
        return true;
      }

      if (body.hierarchyId) {
        const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId } });
        if (!hierarchy) {
          json(res, 400, { error: 'Hiérarchie introuvable pour ce serveur' });
          return true;
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

      json(res, 201, { form });
    } catch (err) {
      logger.error('CustomFormsAPI', 'Error creating custom form:', err);
      jsonFailure(res, err, 'Erreur lors de la création du formulaire', 'CustomFormsAPI');
    }
    return true;
  }

  // Routes avec :formId
  if (parts[5]) {
    const formId = parts[5];

    // GET /api/dashboard/guilds/:guildId/custom-forms/:formId - Get specific form
    if (parts.length === 6 && method === 'GET') {
      try {
        const form = await getCustomForm(formId, guildId);
        if (!form) {
          json(res, 404, { error: 'Formulaire introuvable' });
          return true;
        }
        json(res, 200, { form });
      } catch (err) {
        logger.error('CustomFormsAPI', 'Error getting custom form:', err);
        jsonFailure(res, err, 'Erreur lors de la récupération du formulaire', 'CustomFormsAPI');
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/custom-forms/:formId - Update form
    if (parts.length === 6 && method === 'PATCH') {
      try {
        const body = await readJsonBody<CustomFormUpdateBody>(req);

        if (!body) {
          json(res, 400, { error: 'Le corps de la requête est vide' });
          return true;
        }

        if (body.hierarchyId) {
          const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: body.hierarchyId, guildId } });
          if (!hierarchy) {
            json(res, 400, { error: 'Hiérarchie introuvable pour ce serveur' });
            return true;
          }
        }

        const maxPending = parseCap(body.maxPendingCandidatures);
        const maxAccepted = parseCap(body.maxAcceptedCandidatures);
        if (maxPending === 'invalid' || maxAccepted === 'invalid') {
          json(res, 400, { error: 'Un plafond de candidatures doit être un entier entre 1 et 10 000.' });
          return true;
        }
        if (body.acceptedCapMode !== undefined && body.acceptedCapMode !== 'RESET' && body.acceptedCapMode !== 'TOTAL') {
          json(res, 400, { error: 'Mode de plafond inconnu.' });
          return true;
        }

        const current = await prisma.customForm.findFirst({
          where: { id: formId, guildId },
          select: { isActive: true, acceptedCapMode: true },
        });
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

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('CustomFormsAPI', 'Error updating custom form:', err);
        jsonFailure(res, err, 'Erreur lors de la mise à jour du formulaire', 'CustomFormsAPI');
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/custom-forms/:formId - Delete form
    if (parts.length === 6 && method === 'DELETE') {
      try {
        await deleteCustomForm(formId, guildId);
        await refreshRecruitmentPanels(guildId, formId).catch(() => null);
        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('CustomFormsAPI', 'Error deleting custom form:', err);
        jsonFailure(res, err, 'Erreur lors de la suppression du formulaire', 'CustomFormsAPI');
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/custom-forms/:formId/submissions - Get form submissions
    if (parts.length === 7 && parts[6] === 'submissions' && method === 'GET') {
      try {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 250);
        const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
        const [submissions, total] = await Promise.all([
          getCustomFormSubmissions(formId, guildId, limit, offset),
          prisma.customFormSubmission.count({ where: { formId, guildId } }),
        ]);
        // La soumission fige le pseudo au moment de l'envoi et ne stocke aucune
        // photo : on resout l'identite pour que la liste affiche un visage.
        const identities = await getMemberIdentities(
          _client,
          guildId,
          submissions.map((submission) => submission.userId).filter((id): id is string => !!id),
        );
        json(res, 200, {
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
        jsonFailure(res, err, 'Erreur lors de la récupération des soumissions', 'CustomFormsAPI');
      }
      return true;
    }
  }

  return false;
}
