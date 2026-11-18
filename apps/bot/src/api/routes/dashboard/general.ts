import { Hono } from 'hono';
import { Prisma } from '@prisma/client';
import {
  Client,
  ChannelType,
  DiscordAPIError,
  GuildPremiumTier,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import pLimit from 'p-limit';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { isGuildActivated, activateGuild } from '../../../utils/activation.js';
import { isOnboardingBacktrack, normalizeHomeTodoPrefs } from '@kotbo/contracts';
import {
  trackAcquisitionStep,
  trackDashboardOpen,
} from '../../../services/analytics/acquisitionService.js';
import { translate } from '../../../services/integrations/translationService.js';
import { cache } from '../../../utils/cache.js';
import { getGuildLanguageState, normalizeLocale } from '../../../utils/i18n.js';
import { DEFAULT_TIMEZONE, isValidTimezone, listSupportedTimezones, normalizeTimezone } from '@kotbo/contracts';
import { rerenderPersistentPanels } from '../../../services/core/panelRerenderService.js';
import { dashboardAuth, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import {
  canFinishOnboardingWithoutPayment,
  isOnboardingFeatureEnabled,
  markOnboardingComplete,
} from '../../../services/core/onboardingGate.js';
import { getGuildName, resolveAdminAccess, resolveDashboardAccess, getGuildState } from '../../shared.js';

/**
 * Limites du dépôt d'emoji, imposées par Discord et non par nous : 256 Ko et
 * des formats d'image que le CDN sait servir. Les rappeler ici évite un
 * aller-retour réseau pour un fichier qui sera refusé de toute façon.
 */
const GUILD_EMOJI_MAX_BYTES = 256 * 1024;
const GUILD_EMOJI_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Fuseau de lecture choisi par un utilisateur, ou `null` pour « suivre le
 * navigateur ».
 *
 * `normalizeTimezone` ne convient pas ici : il replie sur Europe/Paris, ce qui
 * transformerait une valeur invalide en choix explicite et figerait le lecteur
 * dans un fuseau qu'il n'a pas demande.
 */
function normalizeStoredTimezone(value: unknown): string | null {
  return isValidTimezone(value) ? value : null;
}

/**
 * Ecran courant du parcours, tel que le dashboard l'enregistre.
 *
 * L'etat du parcours est un JSON libre, borne en taille mais non valide champ
 * par champ : c'est le dashboard qui se le relit a lui-meme. On n'en extrait
 * donc que ce dont le tunnel a besoin, et on se mefie du reste.
 */
function readWizardStep(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const step = (state as { step?: unknown }).step;
  return typeof step === 'string' && step.trim() ? step.trim().slice(0, 64) : null;
}

/** Le visiteur est-il revenu sur ses pas ? Delegue a l'ordre des ecrans. */
function wentBackward(from: string | null, to: string | null): boolean {
  return isOnboardingBacktrack(from, to);
}


export function createGeneralRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Hors serveur : la session suffit, chaque route vérifie elle-même ce qu'elle touche.
  const gate = [dashboardAuth] as const;



  router.post(`/api/dashboard/translate`, ...gate, async (c) => {
    try {
      const body = await readBody<{ text: string; targetLang?: string }>(c);
      if (!body?.text) {
        return send(c, { error: 'Texte à traduire requis' }, 400);
      }
      const translatedText = await translate(body.text, body.targetLang || 'fr');
      return send(c, { translatedText });
    } catch (err) {
      logger.error('GeneralAPI', 'Error translating text:', err);
      return fail(c, err, 'Erreur lors de la traduction', 'GeneralAPI');
    }
  });

  // GET|PATCH /api/dashboard/guilds/:guildId/timezone
  //
  // Le bot tourne en UTC : sans ce reglage, une reunion saisie a 21h etait
  // enregistree a 23h heure de Paris et annoncee a 19h dans les notifications.
  router.on(['GET', 'PATCH'], `${base}/timezone`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const user = c.var.dashboardUser;
    try {
      const access = await resolveDashboardAccess(client, guildId, user.userId);
      if (!access.canViewDashboard) return send(c, { error: 'Accès refusé' }, 403);

      if (c.req.method === 'PATCH') {
        if (!access.canManageSettings) return send(c, { error: 'Accès refusé' }, 403);

        const body = await readBody<{ timezone?: string | null }>(c);
        const requested = body?.timezone;

        // Pas de repli sur le defaut : une requete malformee remettrait
        // silencieusement le serveur sur Europe/Paris.
        if (!isValidTimezone(requested)) {
          return send(c, { error: 'Fuseau horaire invalide : utilisez un identifiant IANA (ex. Europe/Paris)' }, 400);
        }

        await prisma.guild.upsert({
          where: { id: guildId },
          update: { timezone: requested },
          create: { id: guildId, timezone: requested },
        });
        await cache.invalidateGuild(guildId);

        return send(c, {
          timezone: requested,
          default: DEFAULT_TIMEZONE,
          available: listSupportedTimezones(requested),
        });
      }

      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { timezone: true },
      });

      const current = normalizeTimezone(guild?.timezone);
      return send(c, {
        timezone: current,
        default: DEFAULT_TIMEZONE,
        available: listSupportedTimezones(current),
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error handling timezone for guild ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de la gestion du fuseau horaire', 'GeneralAPI');
    }
  });

  // GET|PATCH /api/dashboard/guilds/:guildId/language
  //
  // Expose la carte « Langue du bot » de l'accueil. `language: null` cote base
  // signifie « detection automatique » : la cascade retombe alors sur la langue
  // declaree du serveur Discord, puis sur l'anglais.
  router.on(['GET', 'PATCH'], `${base}/language`, ...gate, async (c) => {
    const method = c.req.method;
    const user = c.var.dashboardUser;
    const guildId = c.req.param('guildId')!;
    try {
      const access = await resolveDashboardAccess(client, guildId, user.userId);
      if (!access.canViewDashboard) {
        return send(c, { error: 'Accès refusé' }, 403);
      }

      const discordGuild = client.guilds.cache.get(guildId) ?? null;
      const detected = normalizeLocale(discordGuild?.preferredLocale ?? null);

      if (method === 'PATCH') {
        if (!access.canManageSettings) {
          return send(c, { error: 'Accès refusé' }, 403);
        }

        const body = await readBody<{ mode?: 'auto' | 'manual'; language?: string | null }>(c);
        const wantsAuto = body?.mode === 'auto' || body?.language === null;
        const requested = wantsAuto ? null : normalizeLocale(body?.language);

        if (!wantsAuto && !requested) {
          return send(c, { error: "Langue invalide : utilisez 'fr', 'en', ou mode 'auto'" }, 400);
        }

        const before = await getGuildLanguageState(guildId, discordGuild?.preferredLocale ?? null);

        await prisma.guild.upsert({
          where: { id: guildId },
          update: { language: requested },
          create: { id: guildId, language: requested },
        });
        await cache.invalidateGuild(guildId);

        const after = await getGuildLanguageState(guildId, discordGuild?.preferredLocale ?? null);

        // Ecrire la langue ne reecrit pas les messages deja publies : sans ce
        // re-rendu, les panneaux persistants restent dans l'ancienne langue et le
        // reglage passe pour inoperant. C'est ce que fait `/languages rerender`,
        // qui reste utile apres une modification de gabarit.
        const rerender = after.locale === before.locale
          ? null
          : await rerenderPersistentPanels(client, guildId);

        return send(c, {
          mode: after.mode,
          locale: after.locale,
          detected,
          available: ['fr', 'en'],
          rerender: rerender && {
            updated: rerender.updated,
            skipped: rerender.skipped,
            failed: rerender.failed,
          },
        });
      }

      const state = await getGuildLanguageState(guildId, discordGuild?.preferredLocale ?? null);
      return send(c, {
        mode: state.mode,
        locale: state.locale,
        detected,
        available: ['fr', 'en'],
        rerender: null,
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error handling language for guild ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de la gestion de la langue', 'GeneralAPI');
    }
  });

  router.get(`/api/dashboard/guilds`, ...gate, async (c) => {
    const user = c.var.dashboardUser;
    try {
      const guilds = await prisma.guild.findMany({
        orderBy: { updatedAt: 'desc' },
        select: { id: true, updatedAt: true }
      });

      const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
      const visibleGuilds = guilds
        .map((guild) => ({ guild, activated: isGuildActivated(guild.id) }))
        .filter(({ activated }) => activated || isGlobalAdmin);

      // Cette route est le chemin critique de l'ecran de connexion : elle
      // s'executait en serie alors que `resolveDashboardAccess` fait un
      // `members.fetch()` Discord par serveur. Sur un compte present dans
      // plusieurs dizaines de serveurs, les allers-retours s'additionnaient.
      //
      // La concurrence est bornee pour ne pas envoyer d'un coup autant de
      // requetes que de serveurs a l'API Discord.
      const limit = pLimit(10);
      const resolved = await Promise.all(
        visibleGuilds.map(({ guild, activated }) =>
          limit(async () => {
            const access = await resolveDashboardAccess(client, guild.id, user.userId);
            if (!access.canViewDashboard) return null;

            return {
              id: guild.id,
              name: getGuildName(client, guild.id),
              updatedAt: guild.updatedAt.toISOString(),
              accessLevel: (access.level === 'admin' ? 'admin' : 'moderator') as 'admin' | 'moderator',
              activated,
            };
          })
        )
      );

      // `Promise.all` preserve l'ordre : le tri par `updatedAt` desc est conserve.
      return send(c, { guilds: resolved.filter((entry) => entry !== null) });
    } catch (err) {
      logger.error('GeneralAPI', 'Error listing guilds:', err);
      return fail(c, err, 'Erreur lors de la récupération des serveurs', 'GeneralAPI');
    }
  });

  router.get(`/api/dashboard/presets/shared/:shareToken`, ...gate, async (c) => {
    const shareToken = c.req.param('shareToken');
    try {
      const preset = await prisma.dashboardLayoutPreset.findUnique({
        where: { shareToken },
        select: { id: true, name: true, description: true, creatorId: true, guildId: true, layout: true, isPublic: true, shareToken: true, createdAt: true, updatedAt: true }
      });
      if (!preset || !preset.isPublic) {
        return send(c, { error: 'Preset partagé introuvable.' }, 404);
      }
      return send(c, { preset });
    } catch (err) {
      logger.error('GeneralAPI', `Error fetching shared preset ${shareToken}:`, err);
      return fail(c, err, 'Erreur lors de la récupération du preset partagé.', 'GeneralAPI');
    }
  });

  return router;
}


export function createGuildGeneralRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);



  router.on(['GET'], [`${base}`, `${base}/state`], ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    try {
      const state = await getGuildState(client, guildId, access, user.userId, {
        overview: (c.req.query('scope') ?? null) === 'overview',
      });
      if (!state) {
        return send(c, { error: 'Guilde introuvable' }, 404);
      }
      return send(c, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('GeneralAPI', `Error getting guild state for ${guildId}:`, err);
      const hint = /column|sidebarFavorites|commandRestrictions|channelId/i.test(message)
        ? 'Exécutez les migrations Prisma : bun run db:migrate:deploy'
        : undefined;
      return send(c, {
        error: "Erreur interne de chargement de l'état de la guilde",
        ...(hint ? { hint } : {}),
      }, 500);
    }
  });

  //
  // La sortie du tunnel qui ne passe pas par un paiement : le serveur repart
  // sur l'offre gratuite, ou sur l'acces qu'il a deja (offre posee a la main,
  // abonnement, code de partenariat). Le paiement, lui, clot le parcours par
  // `syncSubscription`. Ouvrir cette sortie n'ouvre rien d'autre : `moduleGate`
  // continue de fermer les modules hors offre.
  //
  // L'ecriture est deja reservee aux administrateurs du dashboard par la garde
  // commune (`handleDashboardRoutes`) : personne d'autre ne peut l'appeler.
  router.post(`${base}/onboarding/complete`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          onboardingCompletedAt: true,
          plan: true,
          stripeSubscriptionId: true,
          accessType: true,
          activationCode: true,
        },
      });

      if (!guild) {
        return send(c, { error: 'Guilde introuvable' }, 404);
      }

      // Deja clos, ou instance qui ne presente pas de parcours : rejouer
      // l'appel ne doit pas devenir une erreur, la page peut le refaire apres
      // un retour de paiement ou un simple rafraichissement.
      if (!guild.onboardingCompletedAt && isOnboardingFeatureEnabled()) {
        await markOnboardingComplete(
          guildId,
          canFinishOnboardingWithoutPayment(guild) ? 'dernier écran, rien à payer' : 'dernier écran, offre gratuite',
        );
      }

      return send(c, { ok: true });
    } catch (err) {
      logger.error('GeneralAPI', `Error completing onboarding for ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de la clôture du parcours de configuration.', 'GeneralAPI');
    }
  });

  router.get(`${base}/onboarding/state`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { onboardingState: true },
      });
      if (!guild) {
        return send(c, { error: 'Guilde introuvable' }, 404);
      }
      // Le parcours vient de se charger : quelqu'un est reellement venu se
      // servir du bot, la ou beaucoup de serveurs le posent puis l'oublient.
      trackDashboardOpen(guildId);
      return send(c, { state: guild.onboardingState ?? null });
    } catch (err) {
      logger.error('GeneralAPI', `Error reading onboarding state for ${guildId}:`, err);
      return fail(c, err, "Erreur lors de la lecture du parcours de configuration.", 'GeneralAPI');
    }
  });

  router.put(`${base}/onboarding/state`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ state?: unknown }>(c);
      const state = body?.state;

      // `null` efface : c'est ce que fait « recommencer le parcours ».
      if (state === null) {
        await prisma.guild.update({ where: { id: guildId }, data: { onboardingState: Prisma.DbNull } });
        return send(c, { ok: true });
      }

      if (typeof state !== 'object' || Array.isArray(state)) {
        return send(c, { error: "L'état du parcours doit être un objet." }, 400);
      }

      // 16 Ko : le parcours n'y met qu'une poignee de reponses et de clefs
      // d'etapes. Au-dela, ce n'est plus un parcours qu'on enregistre.
      const serialized = JSON.stringify(state);
      if (serialized.length > 16_384) {
        return send(c, { error: "L'état du parcours est trop volumineux." }, 413);
      }

      // L'etape franchie se deduit de la difference : le parcours envoie son
      // etat complet, jamais « je viens de passer tel ecran ». Comparer avant
      // d'ecrire est donc le seul moment ou l'on peut savoir si le visiteur a
      // avance ou recule - et un retour en arriere ne dit pas la meme chose
      // qu'un abandon : il signale un ecran mal compris.
      const previous = await prisma.guild
        .findUnique({ where: { id: guildId }, select: { onboardingState: true } })
        .catch(() => null);
      const previousStep = readWizardStep(previous?.onboardingState);
      const nextStep = readWizardStep(state);

      await prisma.guild.update({
        where: { id: guildId },
        data: { onboardingState: state as Prisma.InputJsonValue },
      });

      if (nextStep && nextStep !== previousStep) {
        if (!previousStep) {
          trackAcquisitionStep({ step: 'onboarding_started', guildId, metadata: { step: nextStep } });
        }
        trackAcquisitionStep({
          step: wentBackward(previousStep, nextStep) ? 'onboarding_back' : 'onboarding_step',
          guildId,
          metadata: { step: nextStep, from: previousStep },
        });
      }

      return send(c, { ok: true });
    } catch (err) {
      logger.error('GeneralAPI', `Error writing onboarding state for ${guildId}:`, err);
      return fail(c, err, "Erreur lors de l'enregistrement du parcours de configuration.", 'GeneralAPI');
    }
  });

  // GET|POST /api/dashboard/guilds/:guildId/emojis
  //
  // Les sélecteurs d'emoji du dashboard (monnaie, objets, quêtes...) ne
  // proposaient que de l'Unicode : un serveur qui a sa propre pièce ne pouvait
  // pas l'utiliser comme symbole de sa monnaie. Cette route expose le jeu
  // d'emojis de la guilde, et laisse en déposer un nouveau sans passer par
  // Discord - l'image est envoyée au serveur et l'emoji y est créé.
  router.on(['GET', 'POST'], `${base}/emojis`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    let emojiGuild = client.guilds.cache.get(guildId) ?? null;
    if (!emojiGuild) {
      emojiGuild = await client.guilds.fetch(guildId).catch(() => null) as Guild | null;
    }
    if (!emojiGuild) return send(c, { error: 'Serveur Discord introuvable' }, 404);
    const guild = emojiGuild;

    // Le nombre d'emplacements suit le niveau de boost, et vaut autant pour les
    // emojis fixes que pour les animés : sans ce chiffre, le dashboard ne peut
    // pas dire pourquoi un dépôt est refusé.
    const slotsForTier = (tier: GuildPremiumTier): number => {
      switch (tier) {
        case GuildPremiumTier.Tier1: return 100;
        case GuildPremiumTier.Tier2: return 150;
        case GuildPremiumTier.Tier3: return 250;
        default: return 50;
      }
    };

    const respondWithEmojis = async (status: number, extra: Record<string, unknown> = {}) => {
      if (guild.emojis.cache.size === 0) {
        await guild.emojis.fetch().catch(() => null);
      }
      const emojis = Array.from(guild.emojis.cache.values())
        .map((emoji) => ({
          id: emoji.id,
          name: emoji.name ?? emoji.id,
          animated: emoji.animated === true,
          available: emoji.available !== false,
          url: emoji.imageURL({ size: 64 }),
          // La forme que Discord attend dans un message ou une réaction.
          mention: `<${emoji.animated ? 'a' : ''}:${emoji.name ?? '_'}:${emoji.id}>`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

      return send(c, {
        emojis,
        slots: {
          total: slotsForTier(guild.premiumTier),
          staticUsed: emojis.filter((e) => !e.animated).length,
          animatedUsed: emojis.filter((e) => e.animated).length,
        },
        canUpload: access.canManageSettings
          && guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions) === true,
        ...extra,
      }, status);
    };

    if (c.req.method === 'GET') {
      try {
        return await respondWithEmojis(200);
      } catch (err) {
        logger.error('GeneralAPI', `Error listing emojis for ${guildId}:`, err);
        return fail(c, err, 'Erreur lors de la récupération des emojis du serveur', 'GeneralAPI');
      }
    }

    // Créer un emoji modifie le serveur Discord, pas seulement un réglage :
    // c'est une écriture réservée aux administrateurs du dashboard.
    if (!access.canManageSettings) return send(c, { error: 'Accès refusé' }, 403);

    try {
      const body = await readBody<{ name?: string; mimeType?: string; data?: string }>(c);
      const rawName = (body?.name ?? '').trim();
      const mimeType = (body?.mimeType ?? '').trim().toLowerCase();
      const data = body?.data ?? '';

      if (!rawName || !mimeType || !data) return send(c, { error: 'name, mimeType et data sont requis.' }, 400);

      // Discord n'accepte que lettres, chiffres et tirets bas, entre 2 et 32
      // caractères. Corriger silencieusement serait pire : l'utilisateur
      // chercherait ensuite un emoji qui ne porte pas le nom qu'il a saisi.
      if (!/^\w{2,32}$/.test(rawName)) {
        return send(c, { error: "Nom d'emoji invalide : 2 à 32 caractères, lettres, chiffres et tirets bas uniquement." }, 400);
      }

      if (!GUILD_EMOJI_MIME_TYPES.includes(mimeType)) {
        return send(c, { error: 'Format non supporté. Utilisez PNG, JPEG, GIF ou WEBP.' }, 400);
      }

      const buffer = Buffer.from(data, 'base64');
      if (buffer.length === 0) return send(c, { error: 'Image vide ou illisible.' }, 400);
      if (buffer.length > GUILD_EMOJI_MAX_BYTES) {
        return send(c, { error: `Image trop lourde : ${Math.round(GUILD_EMOJI_MAX_BYTES / 1024)} Ko maximum.` }, 413);
      }

      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
        return send(c, { error: "Le bot n'a pas la permission « Gérer les expressions » sur ce serveur." }, 403);
      }

      const created = await guild.emojis.create({
        attachment: buffer,
        name: rawName,
        reason: `Emoji ajouté depuis le dashboard par ${user.userId}`,
      });

      return await respondWithEmojis(201, {
        created: {
          id: created.id,
          name: created.name ?? rawName,
          animated: created.animated === true,
          url: created.imageURL({ size: 64 }),
          mention: `<${created.animated ? 'a' : ''}:${created.name ?? rawName}:${created.id}>`,
        },
      });
    } catch (err) {
      // Emplacements saturés, image refusée par Discord : le message de l'API
      // est plus utile que « erreur interne », c'est lui qui dit quoi faire.
      const apiMessage = err instanceof DiscordAPIError ? err.message : null;
      logger.error('GeneralAPI', `Error creating emoji for ${guildId}:`, err);
      return send(c, { error: apiMessage ?? "Erreur lors de la création de l'emoji" }, apiMessage ? 400 : 500);
    }
  });

  router.get(`${base}/channels`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      let discordGuild = client.guilds.cache.get(guildId) ?? null;
      if (!discordGuild) {
        discordGuild = await client.guilds.fetch(guildId).catch(() => null) as Guild | null;
      }
      if (!discordGuild) {
        return send(c, { error: 'Serveur Discord introuvable' }, 404);
      }
      if (discordGuild.channels.cache.size === 0) {
        await discordGuild.channels.fetch().catch(() => null);
      }
      const allCh = Array.from(discordGuild.channels.cache.values()) as GuildBasedChannel[];
      const textChannelTypes = new Set([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildVoice,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ]);
      const channelTypeLabel = (type: ChannelType) => {
        switch (type) {
          case ChannelType.GuildAnnouncement: return 'announcement';
          case ChannelType.GuildVoice: return 'voice';
          case ChannelType.GuildForum: return 'forum';
          case ChannelType.GuildMedia: return 'media';
          case ChannelType.PublicThread:
          case ChannelType.PrivateThread:
          case ChannelType.AnnouncementThread:
            return 'thread';
          default: return 'text';
        }
      };
      const textChannels = allCh
        .filter((ch) => textChannelTypes.has(ch.type))
        .map((ch) => ({ id: ch.id, name: ch.name, mention: `<#${ch.id}>`, position: 'rawPosition' in ch ? ch.rawPosition : 0, type: channelTypeLabel(ch.type) }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention, type }) => ({ id, name, mention, type }));
      const voiceChannels = allCh
        .filter((ch) => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)
        .map((ch) => ({ id: ch.id, name: ch.name, mention: `<#${ch.id}>`, position: ch.rawPosition ?? 0 }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention }) => ({ id, name, mention }));
      const categories = allCh
        .filter((ch) => ch.type === ChannelType.GuildCategory)
        .map((ch) => ({ id: ch.id, name: ch.name, mention: `<#${ch.id}>`, position: ch.rawPosition ?? 0 }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention }) => ({ id, name, mention }));

      return send(c, { textChannels, voiceChannels, categories });
    } catch (err) {
      logger.error('GeneralAPI', `Error getting guild channels for ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de la récupération des salons Discord', 'GeneralAPI');
    }
  });

  router.post(`${base}/activate`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    try {
      const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
      const canActivate = isGlobalAdmin || access.level === 'admin';
      if (!canActivate) {
        return send(c, { error: 'Seuls les administrateurs du serveur ou les administrateurs globaux peuvent activer ce serveur.' }, 403);
      }

      const body = await readBody<{ code?: string }>(c);
      const rawCode = body?.code?.trim() || '';
      if (!rawCode) {
        return send(c, { error: "Le code d'activation est requis." }, 400);
      }

      const codeRow = await prisma.activationCode.findUnique({
        where: { code: rawCode.toUpperCase() }
      });

      if (!codeRow) {
        return send(c, { error: "Code d'activation introuvable." }, 404);
      }

      if (!codeRow.isActive || codeRow.usedAt) {
        return send(c, { error: "Ce code d'activation a déjà été utilisé ou est désactivé." }, 400);
      }

      await activateGuild(guildId, rawCode);
      return send(c, { ok: true, message: 'Le serveur a été activé avec succès.' });
    } catch (err) {
      logger.error('GeneralAPI', `Error activating guild ${guildId}:`, err);
      return fail(c, err, "Erreur lors de l'activation du serveur.", 'GeneralAPI');
    }
  });

  router.get(`${base}/user-settings`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const settings = await prisma.dashboardUserSettings.findUnique({
        where: {
          guildId_userId: {
            guildId,
            userId: user.userId
          }
        }
      });
      
      if (!settings) {
        return send(c, {
          bentoLayout: null,
          themeId: 'dark',
          customTheme: null,
          accentColor: 'violet',
          sidebarBehavior: 'auto',
          compactMode: false,
          // Nul = suivre le fuseau du navigateur, ce que le dashboard resout
          // lui-meme : le serveur n'a pas a deviner d'ou on le consulte.
          timezone: null,
          homeTodoPrefs: normalizeHomeTodoPrefs(null)
        });
      }
      
      return send(c, {
        bentoLayout: settings.bentoLayout,
        themeId: settings.themeId,
        customTheme: settings.customTheme,
        accentColor: settings.accentColor,
        sidebarBehavior: settings.sidebarBehavior,
        compactMode: settings.compactMode,
        timezone: settings.timezone,
        homeTodoPrefs: normalizeHomeTodoPrefs(settings.homeTodoPrefs)
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error fetching user-settings for ${guildId} / ${user.userId}:`, err);
      return fail(c, err, 'Erreur lors de la récupération des préférences.', 'GeneralAPI');
    }
  });

  router.put(`${base}/user-settings`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<any>(c);
      // JSON libre cote base : on n'ecrit que la forme reconnue, jamais le
      // corps tel qu'il arrive.
      const homeTodoPrefs = body?.homeTodoPrefs !== undefined
        ? normalizeHomeTodoPrefs(body.homeTodoPrefs) as unknown as Prisma.InputJsonValue
        : undefined;
      const settings = await prisma.dashboardUserSettings.upsert({
        where: {
          guildId_userId: {
            guildId,
            userId: user.userId
          }
        },
        create: {
          guildId,
          userId: user.userId,
          bentoLayout: body?.bentoLayout ?? null,
          themeId: body?.themeId ?? 'dark',
          customTheme: body?.customTheme ?? null,
          accentColor: body?.accentColor ?? 'violet',
          sidebarBehavior: body?.sidebarBehavior ?? 'auto',
          compactMode: body?.compactMode ?? false,
          timezone: normalizeStoredTimezone(body?.timezone),
          homeTodoPrefs
        },
        update: {
          bentoLayout: body?.bentoLayout !== undefined ? body.bentoLayout : undefined,
          themeId: body?.themeId !== undefined ? body.themeId : undefined,
          customTheme: body?.customTheme !== undefined ? body.customTheme : undefined,
          accentColor: body?.accentColor !== undefined ? body.accentColor : undefined,
          sidebarBehavior: body?.sidebarBehavior !== undefined ? body.sidebarBehavior : undefined,
          compactMode: body?.compactMode !== undefined ? body.compactMode : undefined,
          timezone: body?.timezone !== undefined ? normalizeStoredTimezone(body.timezone) : undefined,
          homeTodoPrefs
        }
      });
      
      return send(c, {
        ok: true,
        settings: {
          bentoLayout: settings.bentoLayout,
          themeId: settings.themeId,
          customTheme: settings.customTheme,
          accentColor: settings.accentColor,
          sidebarBehavior: settings.sidebarBehavior,
          compactMode: settings.compactMode,
          timezone: settings.timezone,
          homeTodoPrefs: normalizeHomeTodoPrefs(settings.homeTodoPrefs)
        }
      });
    } catch (err) {
      logger.error('GeneralAPI', `Error updating user-settings for ${guildId} / ${user.userId}:`, err);
      return fail(c, err, 'Erreur lors de la mise à jour des préférences.', 'GeneralAPI');
    }
  });

  router.get(`${base}/layout-presets`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const presets = await prisma.dashboardLayoutPreset.findMany({
        where: { guildId, creatorId: user.userId },
        orderBy: { updatedAt: 'desc' }
      });
      return send(c, { presets });
    } catch (err) {
      logger.error('GeneralAPI', `Error fetching presets for ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de la récupération des presets.', 'GeneralAPI');
    }
  });

  router.post(`${base}/layout-presets`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{ name: string; description?: string; layout: any[]; isPublic?: boolean }>(c);
      if (!body?.name || !body?.layout) {
        return send(c, { error: 'Nom et layout requis.' }, 400);
      }
      const preset = await prisma.dashboardLayoutPreset.create({
        data: {
          guildId,
          creatorId: user.userId,
          name: body.name,
          description: body.description || '',
          layout: body.layout,
          isPublic: body.isPublic ?? false
        }
      });
      return send(c, { preset }, 201);
    } catch (err) {
      logger.error('GeneralAPI', `Error creating preset for ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de la création du preset.', 'GeneralAPI');
    }
  });

  router.post(`${base}/layout-presets/import`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{ name: string; description?: string; layout: any[] }>(c);
      if (!body?.name || !body?.layout) {
        return send(c, { error: 'Nom et layout requis.' }, 400);
      }
      const preset = await prisma.dashboardLayoutPreset.create({
        data: {
          guildId,
          creatorId: user.userId,
          name: body.name,
          description: body.description || 'Importé',
          layout: body.layout,
          isPublic: false
        }
      });
      return send(c, { preset }, 201);
    } catch (err) {
      logger.error('GeneralAPI', `Error importing preset for ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de l\'import du preset.', 'GeneralAPI');
    }
  });

  router.delete(`${base}/layout-presets/:presetId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const presetId = c.req.param('presetId');
    try {
      const existing = await prisma.dashboardLayoutPreset.findFirst({
        where: { id: presetId, guildId, creatorId: user.userId }
      });
      if (!existing) {
        return send(c, { error: 'Preset introuvable ou accès refusé.' }, 404);
      }
      await prisma.dashboardLayoutPreset.delete({ where: { id: presetId } });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('GeneralAPI', `Error deleting preset ${presetId}:`, err);
      return fail(c, err, 'Erreur lors de la suppression du preset.', 'GeneralAPI');
    }
  });

  router.post(`${base}/layout-presets/:presetId/share`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const presetId = c.req.param('presetId');
    try {
      const existing = await prisma.dashboardLayoutPreset.findFirst({
        where: { id: presetId, guildId, creatorId: user.userId }
      });
      if (!existing) {
        return send(c, { error: 'Preset introuvable ou accès refusé.' }, 404);
      }
      // Generate a unique share token
      const shareToken = existing.shareToken ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      const updated = await prisma.dashboardLayoutPreset.update({
        where: { id: presetId },
        data: { shareToken, isPublic: true }
      });
      return send(c, { shareToken: updated.shareToken, shareUrl: `/?importPreset=${updated.shareToken}` });
    } catch (err) {
      logger.error('GeneralAPI', `Error sharing preset ${presetId}:`, err);
      return fail(c, err, 'Erreur lors du partage du preset.', 'GeneralAPI');
    }
  });

  router.post(`${base}/layout-presets/:presetId/apply`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const presetId = c.req.param('presetId');
    try {
      // User can apply their own presets or public ones
      const preset = await prisma.dashboardLayoutPreset.findFirst({
        where: { id: presetId, guildId, OR: [{ creatorId: user.userId }, { isPublic: true }] }
      });
      if (!preset) {
        return send(c, { error: 'Preset introuvable ou accès refusé.' }, 404);
      }
      // Apply by updating user settings
      await prisma.dashboardUserSettings.upsert({
        where: { guildId_userId: { guildId, userId: user.userId } },
        create: { guildId, userId: user.userId, bentoLayout: preset.layout as Prisma.InputJsonValue },
        update: { bentoLayout: preset.layout as Prisma.InputJsonValue }
      });
      return send(c, { ok: true, layout: preset.layout });
    } catch (err) {
      logger.error('GeneralAPI', `Error applying preset ${presetId}:`, err);
      return fail(c, err, 'Erreur lors de l\'application du preset.', 'GeneralAPI');
    }
  });

  return router;
}

