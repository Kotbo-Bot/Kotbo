/**
 * Formulaires publics (recrutement, formulaires personnalisés) et page d'appel
 * de bannissement : lecture sans session, soumission limitée par IP.
 */
import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { handleFormTrigger } from '../../../../services/features/autoResponseService.js';
import { submitCustomForm } from '../../../../services/features/customFormService.js';
import { sanitizeCustomCss, sanitizeFormTheme } from '../../../../utils/formCustomization.js';
import { authOf, fail, ipOf, readBody, send } from './kit.js';

const reply = (c: Context, status: number, data: unknown) => send(c, data, status);

const publicFormLimiter = new Map<string, number[]>();
const PUBLIC_FORM_WINDOW_MS = 60_000;
const PUBLIC_FORM_MAX = 5;
const PUBLIC_FORM_MAX_IPS = 10_000;
let publicFormChecks = 0;

/** `null` si la soumission passe ; sinon le 429 à renvoyer. */
function formLimit(c: Context): Response | null {
  const ip = ipOf(c);
  const now = Date.now();
  publicFormChecks++;
  if (publicFormChecks % 256 === 0 || publicFormLimiter.size >= PUBLIC_FORM_MAX_IPS) {
    for (const [key, values] of publicFormLimiter) {
      if (!values.some((timestamp) => now - timestamp < PUBLIC_FORM_WINDOW_MS)) {
        publicFormLimiter.delete(key);
      }
    }
    while (publicFormLimiter.size >= PUBLIC_FORM_MAX_IPS) {
      const oldest = publicFormLimiter.keys().next().value as string | undefined;
      if (!oldest) break;
      publicFormLimiter.delete(oldest);
    }
  }
  const timestamps = publicFormLimiter.get(ip) ?? [];
  const valid = timestamps.filter((t) => now - t < PUBLIC_FORM_WINDOW_MS);
  if (valid.length >= PUBLIC_FORM_MAX) {
    return reply(c, 429, { error: 'Trop de soumissions. Réessayez dans une minute.' });
  }
  valid.push(now);
  publicFormLimiter.delete(ip);
  publicFormLimiter.set(ip, valid);
  return null;
}

export function createPublicFormsRouter(client: Client): Hono {
  const router = new Hono();

  // GET /api/public/forms/:formId - Get form structure (no auth)
  router.get('/api/public/forms/:formId', async (c) => {
    const formId = c.req.param('formId');
    try {
      const form = await prisma.recruitmentForm.findFirst({
        where: { id: formId, isActive: true },
        select: {
          id: true,
          name: true,
          description: true,
          structure: true,
          guildId: true,
        },
      });

      if (form) {
        c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
        return reply(c, 200, {
          id: form.id,
          name: form.name,
          description: form.description,
          structure: form.structure,
          guildId: form.guildId,
          formType: 'recruitment',
          // Les formulaires de recrutement (legacy) exigent systématiquement une connexion Discord.
          requiresDiscordAuth: true,
        });

      }

      // Un identifiant public ne contient pas son type. Résoudre les deux
      // familles dans cet endpoint supprime un second aller-retour HTTP.
      const customForm = await prisma.customForm.findFirst({
        where: { id: formId, isActive: true },
        select: {
          id: true,
          name: true,
          description: true,
          structure: true,
          guildId: true,
          isRecruitment: true,
          requiresDiscordAuth: true,
          theme: true,
          customCss: true,
        },
      });

      if (!customForm) {
        return reply(c, 404, { error: 'Formulaire introuvable ou inactif' });

      }

      c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
      return reply(c, 200, {
        id: customForm.id,
        name: customForm.name,
        description: customForm.description,
        structure: customForm.structure,
        guildId: customForm.guildId,
        formType: 'custom',
        theme: sanitizeFormTheme(customForm.theme),
        customCss: sanitizeCustomCss(customForm.customCss),
        requiresDiscordAuth: Boolean(customForm.isRecruitment || customForm.requiresDiscordAuth),
      });
    } catch (err) {
      logger.error('PublicAPI', `Error fetching public form ${c.req.param('formId')}:`, err);
      return fail(c, err, 'Erreur lors du chargement du formulaire', 'PublicAPI');
    }

  });

  // POST /api/public/forms/:formId/submit - Submit a form response (no auth, rate limited)
  router.post('/api/public/forms/:formId/submit', async (c) => {
    const tooMany = formLimit(c);
    if (tooMany) return tooMany;
    const formId = c.req.param('formId');
    try {
      const form = await prisma.recruitmentForm.findFirst({
        where: { id: formId, isActive: true },
      });

      if (!form) {
        return reply(c, 404, { error: 'Formulaire introuvable ou inactif' });

      }

      // Les formulaires de recrutement exigent systématiquement une connexion Discord.
      const auth = await authOf(c);
      if (!auth) {
        return reply(c, 401, { error: 'Vous devez vous connecter avec Discord pour soumettre ce formulaire.' });

      }

      const body = await readBody<{
        data: Record<string, unknown>;
        discordId?: string;
        email?: string;
        username?: string;
      }>(c);

      if (!body?.data || typeof body.data !== 'object') {
        return reply(c, 400, { error: 'Les données de réponse sont requises' });

      }

      body.discordId = auth.userId;
      body.username = auth.username || body.username;

      const [candidature] = await prisma.$transaction([
        prisma.recruitmentCandidature.create({
          data: {
            guildId: form.guildId,
            formId: form.id,
            discordId: body.discordId || null,
            email: body.email || null,
            username: body.username || null,
            data: body.data as Prisma.JsonObject,
            status: 'PENDING',
          },
        }),
        prisma.recruitmentForm.update({
          where: { id: formId },
          data: { submissionsCount: { increment: 1 } },
        }),
      ]);

      // La sauvegarde est terminée : rendre la main immédiatement au navigateur.
      const response = reply(c, 201, { ok: true, id: candidature.id });

      queueMicrotask(() => {
        void (async () => {
          try {
            const guildConfig = await prisma.guild.findUnique({
              where: { id: form.guildId },
              select: { recruitmentLogChannelId: true },
            });
            if (guildConfig?.recruitmentLogChannelId) {
              const discordGuild = client.guilds.cache.get(form.guildId)
                || await client.guilds.fetch(form.guildId).catch(() => null);
              const channel = discordGuild?.channels.cache.get(guildConfig.recruitmentLogChannelId);
              if (channel?.isSendable()) {
                await channel.send({
                  embeds: [{
                    title: '📋 Nouvelle candidature reçue',
                    description: `Formulaire: **${form.name}**\n\nDiscord: ${body.discordId ? `<@${body.discordId}>` : 'Non renseigné'}\nEmail: ${body.email || 'Non renseigné'}`,
                    color: 0x6366f1,
                    timestamp: new Date().toISOString(),
                    footer: { text: `Candidature ID: ${candidature.id}` },
                  }],
                });
              }
            }
          } catch (notifErr) {
            logger.warn('PublicAPI', 'Could not send Discord notification for form submission:', notifErr);
          }

          if (body.discordId) {
            await handleFormTrigger(form.guildId, body.discordId, formId, body.data as Record<string, string>, client).catch((err) => {
              logger.error('PublicAPI', `Error executing form trigger for submission ${candidature.id}:`, err);
            });
          }
        })();
      });
      logger.success('PublicAPI', `Form submission for ${formId} from ${body.discordId || 'unknown'}`);
      return response;
    } catch (err) {
      logger.error('PublicAPI', `Error submitting form ${c.req.param('formId')}:`, err);
      return fail(c, err, 'Erreur lors de la soumission du formulaire', 'PublicAPI');
    }

  });

  // GET /api/public/custom-forms/:formId - Get custom form structure (no auth)
  router.get('/api/public/custom-forms/:formId', async (c) => {
    const formId = c.req.param('formId');
    try {
      const form = await prisma.customForm.findFirst({
        where: { id: formId, isActive: true },
        select: {
          id: true,
          name: true,
          description: true,
          structure: true,
          guildId: true,
          isRecruitment: true,
          requiresDiscordAuth: true,
          theme: true,
          customCss: true,
        },
      });

      if (!form) {
        return reply(c, 404, { error: 'Formulaire introuvable ou inactif' });

      }

      // Défense en profondeur : le CSS est déjà sanitizé à la sauvegarde,
      // on le repasse au sanitizer avant de le servir.
      c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
      return reply(c, 200, {
        id: form.id,
        name: form.name,
        description: form.description,
        structure: form.structure,
        guildId: form.guildId,
        theme: sanitizeFormTheme(form.theme),
        customCss: sanitizeCustomCss(form.customCss),
        // Un formulaire de recrutement exige systématiquement la connexion Discord.
        requiresDiscordAuth: Boolean(form.isRecruitment || form.requiresDiscordAuth),
      });
    } catch (err) {
      logger.error('PublicAPI', `Error fetching public custom form ${c.req.param('formId')}:`, err);
      return fail(c, err, 'Erreur lors du chargement du formulaire', 'PublicAPI');
    }

  });

  // POST /api/public/custom-forms/:formId/submit - Submit custom form response (no auth, rate limited)
  router.post('/api/public/custom-forms/:formId/submit', async (c) => {
    const tooMany = formLimit(c);
    if (tooMany) return tooMany;
    const formId = c.req.param('formId');
    try {
      const form = await prisma.customForm.findFirst({
        where: { id: formId, isActive: true },
      });

      if (!form) {
        return reply(c, 404, { error: 'Formulaire introuvable ou inactif' });

      }

      const authRequired = Boolean(form.isRecruitment || form.requiresDiscordAuth);
      const auth = await authOf(c);
      if (authRequired && !auth) {
        return reply(c, 401, { error: 'Vous devez vous connecter avec Discord pour soumettre ce formulaire.' });

      }

      const body = await readBody<{
        data: Record<string, string>;
        discordId?: string;
        email?: string;
        username?: string;
        userTag?: string;
      }>(c);

      if (!body?.data || typeof body.data !== 'object') {
        return reply(c, 400, { error: 'Les données de réponse sont requises' });

      }

      const submission = await submitCustomForm(
        formId,
        form.guildId,
        auth?.userId || body.discordId || '',
        auth?.username || body.username || undefined,
        body.userTag || undefined,
        body.data,
        client,
        Boolean(auth?.userId),
      );

      return reply(c, 201, { ok: true, id: submission.id });
    } catch (err) {
      logger.error('PublicAPI', `Error submitting custom form ${c.req.param('formId')}:`, err);
      return fail(c, err, 'Erreur lors de la soumission du formulaire', 'PublicAPI');
    }

  });

  // GET /api/public/appeal/:guildId - Config + formulaire + état du visiteur connecté
  router.get('/api/public/appeal/:guildId', async (c) => {
    const guildId = c.req.param('guildId');
    if (!/^\d{15,20}$/.test(guildId)) {
      return reply(c, 400, { error: 'Identifiant de serveur invalide' });

    }
    try {
      const {
        getAppealConfig,
        getAppealEligibility,
        resolveAppealableTypes,
      } = await import('../../../../services/moderation/banAppealService.js');
      const config = await getAppealConfig(guildId);
      if (!config?.enabled) {
        return reply(c, 404, { error: "Ce serveur n'accepte pas les demandes de débannissement" });

      }

      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        return reply(c, 404, { error: 'Serveur introuvable' });

      }

      // État du visiteur si connecté via Discord OAuth
      let viewer: Record<string, unknown> | null = null;
      const auth = await authOf(c);
      if (auth) {
        const eligibility = await getAppealEligibility(client, guildId, auth.userId);
        const latestAppeal = await prisma.banAppeal.findFirst({
          where: { guildId, userId: auth.userId },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, status: true, createdAt: true, decidedAt: true,
            decisionReason: true, infoRequest: true, infoResponse: true,
            messages: true,
          },
        });
        viewer = { userId: auth.userId, username: auth.username, eligibility, latestAppeal };
      }

      // Formulaires spécifiques par type : la page bascule sur le bon dès que le
      // membre coche une sanction, sinon le formulaire du module s'applique.
      const perTypeFormIds = new Map<string, string>();
      const rawPerType = config.formIdByType;
      if (rawPerType && typeof rawPerType === 'object' && !Array.isArray(rawPerType)) {
        for (const type of resolveAppealableTypes(config)) {
          const formId = (rawPerType as Record<string, unknown>)[type];
          if (typeof formId === 'string' && formId.trim()) perTypeFormIds.set(type, formId.trim());
        }
      }

      const perTypeForms = perTypeFormIds.size > 0
        ? await prisma.customForm.findMany({
            where: { guildId, id: { in: [...new Set(perTypeFormIds.values())] } },
            select: { id: true, structure: true, theme: true, customCss: true },
          })
        : [];
      const perTypeFormById = new Map(perTypeForms.map(form => [form.id, form]));

      const serializeForm = (form: { id: string; structure: unknown; theme: unknown; customCss: unknown } | null) =>
        form
          ? {
              id: form.id,
              structure: form.structure,
              theme: sanitizeFormTheme(form.theme as never),
              customCss: sanitizeCustomCss(form.customCss as never),
            }
          : null;

      const formsByType: Record<string, unknown> = {};
      for (const [type, formId] of perTypeFormIds) {
        const form = perTypeFormById.get(formId);
        if (form) formsByType[type] = serializeForm(form);
      }

      return reply(c, 200, {
        guildId,
        guildName: guild.name,
        guildIcon: guild.iconURL({ size: 256 }),
        welcomeText: config.welcomeText || null,
        cooldownDays: config.cooldownDays,
        appealableTypes: resolveAppealableTypes(config),
        maxSanctionsPerAppeal: config.maxSanctionsPerAppeal ?? 3,
        form: serializeForm(config.form),
        formsByType,
        viewer,
      });
    } catch (err) {
      logger.error('PublicAPI', `Error fetching appeal config for guild ${guildId}:`, err);
      return fail(c, err, 'Erreur lors du chargement de la page d\'appel', 'PublicAPI');
    }

  });

  // POST /api/public/appeal/:guildId/submit - Soumettre un appel (OAuth obligatoire, rate limited)
  router.post('/api/public/appeal/:guildId/submit', async (c) => {
    const tooMany = formLimit(c);
    if (tooMany) return tooMany;
    const guildId = c.req.param('guildId');
    if (!/^\d{15,20}$/.test(guildId)) {
      return reply(c, 400, { error: 'Identifiant de serveur invalide' });

    }
    try {
      const auth = await authOf(c);
      if (!auth) {
        return reply(c, 401, { error: 'Vous devez vous connecter avec Discord pour soumettre un appel.' });

      }

      const { getAppealConfig, submitAppeal } = await import('../../../../services/moderation/banAppealService.js');
      const config = await getAppealConfig(guildId);
      if (!config?.enabled) {
        return reply(c, 404, { error: "Ce serveur n'accepte pas les demandes de débannissement" });

      }

      const body = await readBody<{
        data: Record<string, unknown>;
        sanctionIds?: unknown;
        statements?: Record<string, unknown>;
      }>(c);
      if (!body?.data || typeof body.data !== 'object') {
        return reply(c, 400, { error: 'Les réponses du formulaire sont requises' });

      }

      // Ce que le visiteur envoie n'est qu'une demande : le service revérifie
      // que chaque id fait bien partie de ses propres sanctions contestables.
      const sanctionIds = Array.isArray(body.sanctionIds)
        ? (body.sanctionIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 25)
        : [];
      const statements: Record<string, string> = {};
      for (const [id, value] of Object.entries(body.statements ?? {})) {
        if (typeof value === 'string' && value.trim()) statements[id] = value.trim().slice(0, 1500);
      }

      const result = await submitAppeal(
        client,
        guildId,
        {
          id: auth.userId,
          tag: auth.username,
          avatar: auth.avatar ?? null,
        },
        body.data,
        { sanctionIds, statements }
      );

      if (!result.ok) {
        const messages: Record<string, string> = {
          not_banned: "Ce compte Discord n'est pas banni de ce serveur.",
          blacklisted: 'Tu ne peux plus soumettre de demande de débannissement pour ce serveur.',
          active_appeal: 'Tu as déjà une demande en cours de traitement.',
          cooldown: 'Ta dernière demande a été refusée récemment, tu dois attendre avant de réessayer.',
          nothing_to_appeal: "Tu n'as aucune sanction contestable sur ce serveur.",
          no_sanction_selected: 'Sélectionne au moins une sanction à contester.',
          invalid_sanction: "Une des sanctions sélectionnées n'est pas contestable.",
          too_many_sanctions: 'Tu as sélectionné trop de sanctions pour une seule demande.',
        };
        return reply(c, 403, { error: messages[result.blockedBy] || 'Soumission impossible', blockedBy: result.blockedBy });

      }

      return reply(c, 201, { ok: true, id: result.appeal.id });
    } catch (err) {
      logger.error('PublicAPI', `Error submitting appeal for guild ${guildId}:`, err);
      return fail(c, err, "Erreur lors de la soumission de l'appel", 'PublicAPI');
    }

  });

  // POST /api/public/appeal/:guildId/info-response - Répondre à une demande d'infos du staff
  router.post('/api/public/appeal/:guildId/info-response', async (c) => {
    const tooMany = formLimit(c);
    if (tooMany) return tooMany;
    const guildId = c.req.param('guildId');
    try {
      const auth = await authOf(c);
      if (!auth) {
        return reply(c, 401, { error: 'Vous devez vous connecter avec Discord.' });

      }

      const body = await readBody<{ response: string }>(c);
      if (!body?.response || typeof body.response !== 'string' || !body.response.trim()) {
        return reply(c, 400, { error: 'La réponse est requise' });

      }

      const { submitAppealInfoResponse } = await import('../../../../services/moderation/banAppealService.js');
      const result = await submitAppealInfoResponse(client, guildId, auth.userId, body.response.trim());
      if (!result.ok) {
        return reply(c, 404, { error: result.error });

      }
      return reply(c, 200, { ok: true });
    } catch (err) {
      logger.error('PublicAPI', `Error submitting appeal info response for guild ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de l\'envoi de la réponse', 'PublicAPI');
    }

  });

  return router;
}
