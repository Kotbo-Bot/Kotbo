/**
 * Pages publiques communautaires d'un serveur : classements (niveaux, prestige),
 * giveaways, tournois, quiz et accès signé aux transcriptions.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Client } from 'discord.js';
import { normalizeLevelCurve } from '@kotbo/shared';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { cache } from '../../../../utils/cache.js';
import { publicGiveawaysRateLimiter, publicLevelingRateLimiter, publicTournamentsRateLimiter } from '../../../limiters.js';
import { isBrowserPageRequest, SCRAPE_REFUSED } from '../../../shared/scrapeGuard.js';
import { getTournament } from '../../../../services/features/tournament/tournamentService.js';
import { getPublicQuizState, recordQuizAnswer } from '../../../../services/features/eventService.js';
import { isModuleEnabled } from '../../../../services/core/moduleGate.js';
import { getMemberIdentities, resolveMemberAvatarUrl } from '../../../../services/moderation/memberIdentityService.js';
import { getGuildLadder } from '../../../../services/progression/ranked/rankedConfigService.js';
import { getRankedLeaderboard } from '../../../../services/progression/ranked/rankedLeaderboardService.js';
import { resolveDashboardAccess } from '../../../shared.js';
import { SNOWFLAKE, authOf, fail, headersOf, readBody, send, underLimit } from './kit.js';

/**
 * Giveaways terminés encore listés sur la page publique. Les concours en cours
 * sont tous envoyés : en masquer un priverait quelqu'un de sa seule chance d'y participer.
 */
const PUBLIC_GIVEAWAYS_ENDED_LIMIT = 30;
/** Court : compte à rebours et compteur bougent en permanence, mais une page très vue ne relit pas la base à chaque visiteur. */
const PUBLIC_GIVEAWAYS_CACHE_TTL_S = 15;

const SLUG = /^[a-zA-Z0-9_-]{1,64}$/;
const TOO_MANY = { error: 'Trop de requêtes. Veuillez réessayer plus tard.' };

/** Colonnes d'un giveaway nécessaires à sa restitution publique. */
interface PublicGiveawayRow {
  id: string;
  channelId: string;
  messageId: string | null;
  prize: string;
  description: string | null;
  winnerCount: number;
  endsAt: Date;
  ended: boolean;
  participants: string[];
  winners: string[];
  pendingWinners: string[];
  needValidation: boolean;
  validationStatus: string;
  rpgXp: number;
  rpgCoins: number;
  rpgItemId: string | null;
  createdById: string | null;
  createdAt: Date;
}

interface PublicIdentity {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Les quatre états que l'embed Discord distingue par sa couleur, repris tels
 * quels : la page et le message doivent raconter la même chose au même moment.
 */
function giveawayPublicStatus(giveaway: PublicGiveawayRow): 'ACTIVE' | 'PENDING_VALIDATION' | 'VALIDATED' | 'ENDED' {
  if (!giveaway.ended) return 'ACTIVE';
  if (giveaway.validationStatus === 'PENDING') return 'PENDING_VALIDATION';
  if (giveaway.needValidation) return 'VALIDATED';
  return 'ENDED';
}

/**
 * Pseudo et avatar affichables pour un lot d'identifiants Discord. Le membre en
 * cache prime sur le profil en base : il porte le pseudo de serveur et l'avatar à jour.
 */
async function resolvePublicIdentities(
  client: Client,
  guildId: string,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, PublicIdentity>> {
  const unique = [...new Set(userIds.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();

  const profiles = await prisma.memberProfile.findMany({ where: { guildId, userId: { in: unique } } });
  const profileMap = new Map(profiles.map((profile) => [profile.userId, profile]));
  const discordGuild = client.guilds.cache.get(guildId);

  return new Map(
    unique.map((userId) => {
      const profile = profileMap.get(userId);
      const member = discordGuild?.members.cache.get(userId);
      return [
        userId,
        {
          userId,
          displayName: member?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${userId}`,
          avatarUrl: resolveMemberAvatarUrl(member, 128) || profile?.avatarUrl || null,
        },
      ];
    }),
  );
}

/**
 * Noms des objets RPG mis en jeu, par identifiant, en une seule lecture. Le
 * filtre de serveur écarte l'objet d'un autre serveur.
 */
async function rpgItemNames(guildId: string, itemIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(itemIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();

  const items = await prisma.rpgItem
    .findMany({
      where: { id: { in: ids }, OR: [{ guildId: null }, { guildId }] },
      select: { id: true, name: true },
    })
    .catch(() => []);
  return new Map(items.map((item) => [item.id, item.name]));
}

/**
 * Restitution publique d'un giveaway. La liste des participants n'est jamais
 * exposée, seulement son total ; les gagnants tirés mais pas encore validés sont
 * déjà annoncés dans le salon, les taire ici désynchroniserait la page du message.
 */
function serializePublicGiveaway(
  giveaway: PublicGiveawayRow,
  guildId: string,
  identities: Map<string, PublicIdentity>,
  rpgItemName: string | null,
) {
  const status = giveawayPublicStatus(giveaway);
  const announced = status === 'PENDING_VALIDATION' ? giveaway.pendingWinners : giveaway.winners;

  return {
    id: giveaway.id,
    prize: giveaway.prize,
    description: giveaway.description,
    status,
    ended: giveaway.ended,
    needValidation: giveaway.needValidation,
    winnerCount: giveaway.winnerCount,
    participantCount: giveaway.participants.length,
    endsAt: giveaway.endsAt.toISOString(),
    createdAt: giveaway.createdAt.toISOString(),
    channelId: giveaway.channelId,
    messageUrl: giveaway.messageId
      ? `https://discord.com/channels/${guildId}/${giveaway.channelId}/${giveaway.messageId}`
      : null,
    creator: giveaway.createdById ? identities.get(giveaway.createdById) ?? null : null,
    winners: announced.map((userId) => identities.get(userId) ?? { userId, displayName: `Utilisateur ${userId}`, avatarUrl: null }),
    /** Les gagnants affichés attendent encore le feu vert d'un administrateur. */
    winnersPending: status === 'PENDING_VALIDATION',
    rewards: {
      xp: giveaway.rpgXp,
      coins: giveaway.rpgCoins,
      itemId: giveaway.rpgItemId,
      itemName: rpgItemName,
    },
  };
}

export function createPublicCommunityRouter(client: Client): Hono {
  const router = new Hono();

  const guildOf = async (guildId: string) =>
    client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);

  router.get('/api/public/guilds/:guildId/leveling', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE.test(guildId)) return send(c, { error: 'ID de guilde invalide' }, 400);
    if (!isBrowserPageRequest(headersOf(c))) return send(c, SCRAPE_REFUSED, 403);
    // La page charge le classement une fois : 30 lectures par minute n'arrêtent
    // qu'une boucle, pas un visiteur qui rafraîchit.
    if (!underLimit(c, publicLevelingRateLimiter, 30, 60_000)) {
      return send(c, { error: 'Trop de requêtes, réessaie dans une minute.' }, 429);
    }

    try {
      const config = await prisma.levelConfig.findUnique({ where: { guildId } });
      if (!config || !config.enabled) return send(c, { enabled: false, levels: [], guildName: 'Kotbo Server' });

      const levels = await prisma.memberLevel.findMany({ where: { guildId }, orderBy: { xp: 'desc' } });
      const dbProfiles = await prisma.memberProfile.findMany({
        where: { guildId, userId: { in: levels.map((l) => l.userId) } },
      });
      const profileMap = new Map(dbProfiles.map((p) => [p.userId, p]));
      const discordGuild = client.guilds.cache.get(guildId);

      const levelsWithUserData = levels.map((l) => {
        const profile = profileMap.get(l.userId);
        const discordMember = discordGuild?.members.cache.get(l.userId);
        return {
          userId: l.userId,
          xp: l.xp,
          level: l.level,
          username: discordMember?.user?.username || profile?.username || null,
          displayName: discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${l.userId}`,
          avatarUrl: resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null,
        };
      });

      return send(c, {
        enabled: true,
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
        // La courbe voyage avec le classement : la page publique en dérive les
        // paliers, elle afficherait sinon la progression d'une autre guilde.
        curve: normalizeLevelCurve({
          baseXp: config.curveBaseXp,
          linearXp: config.curveLinearXp,
          exponent: config.curveExponent,
          maxLevel: config.maxLevel,
        }),
        levels: levelsWithUserData,
      });
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error fetching public leveling for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur lors du chargement du classement de leveling' }, 500);
    }
  });

  router.get('/api/public/guilds/:guildId/ranked', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE.test(guildId)) return send(c, { error: 'ID de guilde invalide' }, 400);

    try {
      const config = await prisma.rankedConfig.findUnique({ where: { guildId } });
      // Un module éteint répond « désactivé » plutôt qu'une erreur : le lien a pu être partagé avant.
      if (!config?.enabled) return send(c, { enabled: false, entries: [], guildName: 'Kotbo Server' });

      const ladder = await getGuildLadder(guildId);
      const rows = await getRankedLeaderboard(guildId, 100);
      const identities = await getMemberIdentities(client, guildId, rows.map((row) => row.userId)).catch(() => new Map());
      const discordGuild = client.guilds.cache.get(guildId);

      return send(c, {
        enabled: true,
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
        // L'échelle voyage avec le classement, comme la courbe des niveaux.
        ladder,
        entries: rows.map((row) => ({
          ...row,
          displayName: identities.get(row.userId)?.displayName ?? null,
          avatarUrl: identities.get(row.userId)?.avatarUrl || null,
        })),
      });
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error fetching public ranked for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur lors du chargement du classement de prestige' }, 500);
    }
  });

  /** Réponse mise en cache d'une page de giveaway, avec son en-tête de cache public. */
  const cachedGiveawayReply = (c: Context, payload: unknown) => {
    c.header('Cache-Control', `public, max-age=${PUBLIC_GIVEAWAYS_CACHE_TTL_S}`);
    return send(c, payload);
  };

  router.get('/api/public/guilds/:guildId/giveaways', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE.test(guildId)) return send(c, { error: 'ID de guilde invalide' }, 400);
    if (!underLimit(c, publicGiveawaysRateLimiter, 90, 60_000)) return send(c, TOO_MANY, 429);

    const cacheKey = `guild:${guildId}:public-giveaways`;
    const cachedPayload = await cache.get<unknown>(cacheKey);
    if (cachedPayload) return cachedGiveawayReply(c, cachedPayload);

    try {
      const discordGuild = await guildOf(guildId);
      const guildIdentity = {
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
      };

      // Le module éteint ferme la page : laisser les concours visibles ferait
      // participer des gens à un tirage que le bot ne clôturera plus.
      if (!(await isModuleEnabled(guildId, 'giveaways'))) {
        return send(c, { enabled: false, ...guildIdentity, giveaways: [] });
      }

      const [active, ended] = await Promise.all([
        prisma.giveaway.findMany({ where: { guildId, ended: false }, orderBy: { endsAt: 'asc' } }),
        prisma.giveaway.findMany({
          where: { guildId, ended: true },
          orderBy: { endsAt: 'desc' },
          take: PUBLIC_GIVEAWAYS_ENDED_LIMIT,
        }),
      ]);

      const rows = [...active, ...ended] as PublicGiveawayRow[];
      const identities = await resolvePublicIdentities(client, guildId, [
        ...rows.map((row) => row.createdById),
        ...rows.flatMap((row) => (giveawayPublicStatus(row) === 'PENDING_VALIDATION' ? row.pendingWinners : row.winners)),
      ]);
      const itemNames = await rpgItemNames(guildId, rows.map((row) => row.rpgItemId));

      const payload = {
        enabled: true,
        ...guildIdentity,
        giveaways: rows.map((row) => serializePublicGiveaway(
          row,
          guildId,
          identities,
          row.rpgItemId ? itemNames.get(row.rpgItemId) ?? null : null,
        )),
      };

      await cache.set(cacheKey, payload, PUBLIC_GIVEAWAYS_CACHE_TTL_S);
      return cachedGiveawayReply(c, payload);
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error fetching public giveaways for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur lors du chargement des giveaways' }, 500);
    }
  });

  router.get('/api/public/guilds/:guildId/giveaways/:giveawayId', async (c) => {
    const guildId = c.req.param('guildId');
    const giveawayId = c.req.param('giveawayId');
    if (!SNOWFLAKE.test(guildId)) return send(c, { error: 'ID de guilde invalide' }, 400);
    if (!SLUG.test(giveawayId)) return send(c, { error: 'ID de giveaway invalide' }, 400);
    if (!underLimit(c, publicGiveawaysRateLimiter, 90, 60_000)) return send(c, TOO_MANY, 429);

    const cacheKey = `guild:${guildId}:public-giveaway:${giveawayId}`;
    const cachedPayload = await cache.get<unknown>(cacheKey);
    if (cachedPayload) return cachedGiveawayReply(c, cachedPayload);

    try {
      const discordGuild = await guildOf(guildId);
      const guildIdentity = {
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
      };

      if (!(await isModuleEnabled(guildId, 'giveaways'))) {
        return send(c, { enabled: false, ...guildIdentity, giveaway: null });
      }

      // Le filtre sur `guildId` empêche de lire, depuis l'adresse d'un serveur, le giveaway d'un autre.
      const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId } }) as PublicGiveawayRow | null;
      if (!giveaway) return send(c, { error: 'Giveaway introuvable sur ce serveur' }, 404);

      const status = giveawayPublicStatus(giveaway);
      const identities = await resolvePublicIdentities(client, guildId, [
        giveaway.createdById,
        ...(status === 'PENDING_VALIDATION' ? giveaway.pendingWinners : giveaway.winners),
      ]);
      const itemNames = await rpgItemNames(guildId, [giveaway.rpgItemId]);
      const channel = discordGuild?.channels.cache.get(giveaway.channelId);

      const payload = {
        enabled: true,
        ...guildIdentity,
        giveaway: {
          ...serializePublicGiveaway(
            giveaway,
            guildId,
            identities,
            giveaway.rpgItemId ? itemNames.get(giveaway.rpgItemId) ?? null : null,
          ),
          channelName: channel?.name ?? null,
        },
      };

      await cache.set(cacheKey, payload, PUBLIC_GIVEAWAYS_CACHE_TTL_S);
      return cachedGiveawayReply(c, payload);
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error fetching public giveaway ${giveawayId} for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur lors du chargement du giveaway' }, 500);
    }
  });

  router.get('/api/public/guilds/:guildId/tournaments/:eventId', async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    if (!SNOWFLAKE.test(guildId) || !SLUG.test(eventId)) return send(c, { error: 'Adresse de tournoi invalide' }, 400);
    if (!underLimit(c, publicTournamentsRateLimiter, 60, 60_000)) return send(c, TOO_MANY, 429);
    try {
      // Le filtre sur `guildId` empêche de lire, depuis l'adresse d'un serveur, le tournoi d'un autre.
      // Un brouillon reste privé tant que l'équipe ne l'a pas publié.
      const owned = await prisma.event.findFirst({
        where: { id: eventId, guildId, type: 'TOURNAMENT', status: { not: 'DRAFT' } },
        select: { id: true },
      });
      if (!owned || !(await isModuleEnabled(guildId, 'events'))) {
        return send(c, { error: 'Tournoi introuvable sur ce serveur' }, 404);
      }
      const discordGuild = await guildOf(guildId);
      const tournament = await getTournament(eventId, client);
      c.header('Cache-Control', 'public, max-age=5');
      return send(c, {
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
        ...tournament,
      });
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error fetching public tournament ${eventId} for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur lors du chargement du tournoi' }, 500);
    }
  });

  // Quiz : état (page joueurs et écran) en GET, réponse d'un membre connecté en POST.
  const quizGate = async (c: Context): Promise<{ guildId: string; eventId: string } | Response> => {
    const guildId = c.req.param('guildId') ?? '';
    const eventId = c.req.param('eventId') ?? '';
    if (!SNOWFLAKE.test(guildId) || !SLUG.test(eventId)) return send(c, { error: 'Adresse de quiz invalide' }, 400);
    // Plafond large : toute une salle derrière la même IP rafraîchit toutes les 3 s.
    if (!underLimit(c, publicTournamentsRateLimiter, 1200, 60_000)) return send(c, TOO_MANY, 429);
    return { guildId, eventId };
  };

  const quizOwned = (guildId: string, eventId: string) =>
    // Le filtre sur `guildId` empêche de lire ou de jouer, depuis l'adresse d'un serveur, le quiz d'un autre.
    prisma.event.findFirst({
      where: { id: eventId, guildId, type: 'QUIZ', status: { not: 'DRAFT' } },
      select: { id: true },
    });

  router.get('/api/public/guilds/:guildId/quizzes/:eventId', async (c) => {
    const gate = await quizGate(c);
    if (gate instanceof Response) return gate;
    const { guildId, eventId } = gate;
    try {
      if (!(await quizOwned(guildId, eventId)) || !(await isModuleEnabled(guildId, 'events'))) {
        return send(c, { error: 'Quiz introuvable sur ce serveur' }, 404);
      }
      const auth = await authOf(c);
      const discordGuild = await guildOf(guildId);
      const state = await getPublicQuizState(eventId, auth?.userId ?? null);
      // Propre à chaque joueur (sa réponse) et changeant d'une seconde à l'autre.
      c.header('Cache-Control', 'no-store');
      return send(c, {
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
        ...state,
      });
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error on public quiz ${eventId} for guild ${guildId}:`, err);
      return fail(c, err, 'Erreur lors du chargement du quiz', 'PublicAPI');
    }
  });

  router.post('/api/public/guilds/:guildId/quizzes/:eventId/answer', async (c) => {
    const gate = await quizGate(c);
    if (gate instanceof Response) return gate;
    const { guildId, eventId } = gate;
    try {
      if (!(await quizOwned(guildId, eventId)) || !(await isModuleEnabled(guildId, 'events'))) {
        return send(c, { error: 'Quiz introuvable sur ce serveur' }, 404);
      }
      const auth = await authOf(c);
      if (!auth) return send(c, { error: 'Connecte-toi avec Discord pour répondre.' }, 401);

      const body = await readBody<{ questionId?: unknown; optionIndex?: unknown }>(c);
      const questionId = typeof body?.questionId === 'string' ? body.questionId : '';
      const optionIndex = typeof body?.optionIndex === 'number' && Number.isInteger(body.optionIndex) ? body.optionIndex : -1;
      const question = questionId
        ? await prisma.eventQuizQuestion.findFirst({ where: { id: questionId, eventId } })
        : null;
      if (!question || question.status !== 'ONGOING') return send(c, { error: 'Cette question est terminée.' }, 409);

      const options = question.options as string[];
      if (optionIndex < 0 || optionIndex >= options.length) return send(c, { error: 'Réponse invalide.' }, 400);

      const guild = await guildOf(guildId);
      const member = guild ? await guild.members.fetch(auth.userId).catch(() => null) : null;
      if (!member) return send(c, { error: 'Seuls les membres du serveur peuvent répondre.' }, 403);

      await recordQuizAnswer(question, optionIndex, {
        guildId,
        userId: member.id,
        userTag: member.user.tag,
        username: member.user.username,
        displayName: member.displayName,
        avatarUrl: member.user.displayAvatarURL(),
      });
      return send(c, { ok: true, optionIndex });
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error on public quiz ${eventId} for guild ${guildId}:`, err);
      return fail(c, err, 'Erreur lors du chargement du quiz', 'PublicAPI');
    }
  });

  // Délivre un lien signé aux ayants droit (staff du serveur OU participant du
  // ticket associé), sans exiger d'accès au dashboard.
  router.get('/api/public/transcripts/:transcriptId/access', async (c) => {
    const transcriptId = c.req.param('transcriptId');
    if (!/^[a-zA-Z0-9_-]+$/.test(transcriptId)) return send(c, { error: 'ID de transcription invalide' }, 400);

    const auth = await authOf(c);
    if (!auth) return send(c, { error: 'Vous devez vous connecter avec Discord pour voir cette transcription.' }, 401);

    try {
      const transcript = await prisma.transcript.findUnique({
        where: { id: transcriptId },
        select: { id: true, guildId: true, format: true },
      });
      if (!transcript) return send(c, { error: 'Transcription introuvable' }, 404);

      // Le staff du serveur voit toutes les transcriptions.
      const access = await resolveDashboardAccess(client, transcript.guildId, auth.userId).catch(() => null);
      let authorized = !!access?.canViewDashboard;

      // Sinon, un participant du ticket associé (ouvreur / staff ayant claim / staff ayant fermé).
      if (!authorized) {
        const ticket = await prisma.ticket.findFirst({
          where: { transcriptId, guildId: transcript.guildId },
          select: { userId: true, claimedById: true, closedById: true },
        });
        authorized = !!ticket && (
          ticket.userId === auth.userId || ticket.claimedById === auth.userId || ticket.closedById === auth.userId
        );
      }
      if (!authorized) return send(c, { error: "Vous n'avez pas accès à cette transcription." }, 403);

      const { generateTranscriptSignature } = await import('@kotbo/core');
      const { expires, signature } = generateTranscriptSignature(transcriptId, 3600);
      // `format` : la page affiche le HTML historique en iframe, le JSON en rendu natif.
      return send(c, { format: transcript.format, signedUrl: `/api/public/transcripts/${transcriptId}?expires=${expires}&sig=${signature}` });
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error issuing transcript access for ${transcriptId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur interne du serveur' }, 500);
    }
  });

  return router;
}
