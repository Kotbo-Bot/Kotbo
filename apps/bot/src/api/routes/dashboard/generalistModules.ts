import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Client, EmbedBuilder, PermissionFlagsBits, type ColorResolvable } from 'discord.js';
import prisma, { prismaRead } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { defaultLevelUpMessage, getOrCreateLevelConfig, updateMemberLevelRoles, getXpForLevel, getLevelFromXp, getGuildLevelCurve, invalidateLevelConfigCache, levelCurveFromConfig, resyncGuildLevels, countCurveImpact, invalidateLevelRewardsCache, getRoleResyncStatus, startRoleResync, stopRoleResync } from '../../../services/progression/levelingService.js';
import { clampXp, normalizeLevelCurve } from '@kotbo/shared';
import { externalLevelsJob, forgetExternalLevels, isLevelImportSource, type ExternalLevel } from '../../../services/progression/levelImportSources.js';
import { extractLeaderboardWithLlm, type LlmImportInput } from '../../../services/progression/levelImportLlm.js';
import { getGuildPlan } from '../../../services/system/planService.js';
import { levelImportLlmRateLimiter } from '../../limiters.js';
import { getOrCreateWelcomeConfig } from '../../../services/features/welcomeGoodbyeService.js';
import { getMemberIdentities, resolveMemberAvatarUrl, resolveSearchedUserIds } from '../../../services/moderation/memberIdentityService.js';
import {
  getOrCreateWelcomeThreadConfig,
  clampStepDelay,
  MAX_THREAD_STEPS,
  MIN_INACTIVITY_DELETE_HOURS,
  MAX_INACTIVITY_DELETE_HOURS,
} from '../../../services/features/welcomeThreadService.js';
import { getOrCreateAutoModConfig, invalidateAutoModCache, syncDiscordAutoModRules } from '../../../services/moderation/autoModService.js';
import {
  createGiveaway,
  deleteGiveaway,
  listGiveawayRpgItems,
  endGiveaway,
  refreshActiveGiveaways,
  rerollGiveaway,
} from '../../../services/features/giveawayService.js';
import {
  canManageGiveaways,
  getGiveawayConfig,
  normalizeGiveawayConfigPatch,
  normalizeThreshold,
  updateGiveawayConfig,
} from '../../../services/features/giveawayConfigService.js';
import {
  createGiveawayConfigPreset,
  deleteGiveawayConfigPreset,
  listGiveawayConfigPresets,
  updateGiveawayConfigPreset,
} from '../../../services/features/giveawayConfigPresetService.js';
import {
  defaultAppearance,
  generatedLabels,
  normalizeAppearancePatch,
  RESETTABLE_TEXT_KEYS,
} from '../../../services/features/giveawayAppearance.js';
import {
  createGiveawayTemplate,
  deleteGiveawayTemplate,
  listGiveawayTemplates,
  updateGiveawayTemplate,
  type GiveawayTemplateInput,
} from '../../../services/features/giveawayTemplateService.js';
import { roleGrantRefusal } from '../../shared/roleGrantGuard.js';
import { createReactionRoleMenu, deleteReactionRoleMenu, updateReactionRoleMenu, getBotRoleAccess, menuMessageStatus, roleMemberCounts, normalizeEmbedColor, normalizeMenuDescription, normalizeMenuMode, MAX_REACTION_ROLE_BUTTONS, type ReactionRoleOption } from '../../../services/features/reactionRoleService.js';
import { hasNewRoles, materializeNewRoles, previewReactionRolePreset, type ReactionRoleOptionInput } from '../../../services/features/reactionRolePresets.js';
import { REACTION_ROLE_PRESET_KEYS, type ReactionRolePresetKey } from '@kotbo/contracts';
import { invalidateAutoResponseCacheAcrossShards } from '../../../services/features/autoResponseService.js';
import { normalizeAnswer } from '../../../services/features/funService.js';
import { normalizeConfessionCooldown } from '../../../services/features/confessionPolicy.js';
import { checkRateLimit, getGuildName, pushAudit, resolveMemberFeatureAccess } from '../../shared.js';
import { acquireProvisionLock, ensureTextChannel, missingProvisionPermissions, provisionCooldown, provisionCooldownMessage, releaseProvisionLock, startProvisionCooldown } from '../../../services/core/channelProvisioningService.js';
import { fetchAllMembers } from '../../../utils/discord.js';
import { resolveEmojiShortcodes } from '../../../utils/emojis.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { cache } from '../../../utils/cache.js';
import { publicErrorMessage } from '../../../utils/publicError.js';
import { regexProblem } from '../../../utils/safeRegex.js';
const LEADERBOARD_PAGE_SIZE = 25;
/** Plafond des profils retenus par une recherche, avant pagination. */
const LEADERBOARD_SEARCH_LIMIT = 500;

/**
 * Complète des lignes de classement avec de quoi les afficher : le profil connu
 * en base, et le membre Discord quand il est en cache, qui a toujours raison sur
 * le profil (pseudo serveur, avatar à jour).
 */
async function withMemberIdentity(
  guildId: string,
  client: Client,
  rows: Array<{ userId: string }>,
) {
  const profiles = await prisma.memberProfile.findMany({
    where: { guildId, userId: { in: rows.map((row) => row.userId) } },
  });
  const profileMap = new Map(profiles.map((profile) => [profile.userId, profile]));
  const discordGuild = client.guilds.cache.get(guildId);

  return rows.map((row) => {
    const profile = profileMap.get(row.userId);
    const discordMember = discordGuild?.members.cache.get(row.userId);

    return {
      ...row,
      username: discordMember?.user?.username || profile?.username || null,
      displayName: discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${row.userId}`,
      avatarUrl: resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null,
    };
  });
}

const MAX_EMOJI_RIDDLES = 200;
const MAX_EMOJI_RIDDLE_ANSWERS = 10;

function parseEmojiRiddleInput(
  body: unknown,
): { emojis: string; answers: string[] } | { error: string } {
  const input = (body ?? {}) as { emojis?: unknown; answers?: unknown };
  const emojis = typeof input.emojis === 'string' ? input.emojis.trim() : '';
  if (!emojis) return { error: 'Les emojis du rébus sont requis' };
  if (emojis.length > 100) return { error: 'Rébus trop long (100 caractères maximum)' };

  if (!Array.isArray(input.answers)) return { error: 'Au moins une réponse est requise' };
  const answers: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.answers) {
    if (typeof raw !== 'string') continue;
    const answer = raw.trim();
    // Une réponse faite uniquement de ponctuation serait vide une fois
    // normalisée, et ne pourrait jamais être trouvée.
    const key = normalizeAnswer(answer);
    if (!key || seen.has(key)) continue;
    if (answer.length > 100) return { error: 'Réponse trop longue (100 caractères maximum)' };
    seen.add(key);
    answers.push(answer);
  }
  if (answers.length === 0) return { error: 'Au moins une réponse est requise' };
  if (answers.length > MAX_EMOJI_RIDDLE_ANSWERS) {
    return { error: `${MAX_EMOJI_RIDDLE_ANSWERS} réponses maximum par rébus` };
  }
  return { emojis, answers };
}

/** Blacklist de progression, renvoyée avec la config du leveling. */
const BLACKLIST_SELECT = {
  progressionBlacklistUserIds: true,
  progressionBlacklistRoleIds: true,
  progressionBlacklistChannelIds: true,
} as const;

/**
 * Crée, juste avant la publication d'un menu de rôles, les rôles qu'un modèle
 * a proposés et que le staff a gardés. Rend un refus quand la création est
 * impossible : le menu n'est alors pas publié.
 */
type RolesRefusal = { refused: { status: 400 | 404 | 409; error: string } };

async function withNewRolesCreated(
  client: Client,
  guildId: string,
  options: ReactionRoleOptionInput[],
  auditUser: string,
): Promise<ReactionRoleOption[] | RolesRefusal> {
  if (!hasNewRoles(options)) return options;

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) {
    return { refused: { status: 404, ...{ error: 'Serveur Discord introuvable.' } } };
  }

  // Deux envois rapides créeraient chacun le même jeu de rôles.
  const lockKey = `reaction-role-new-roles:${guildId}`;
  if (!acquireProvisionLock(lockKey)) {
    return { refused: { status: 409, ...{ error: 'Une création de rôles est déjà en cours sur ce serveur.' } } };
  }

  try {
    const missing = await missingProvisionPermissions(discordGuild, [PermissionFlagsBits.ManageRoles]);
    if (missing.length > 0) {
      return { refused: { status: 400, ...{ error: `Le bot n'a pas les permissions nécessaires pour créer les rôles : ${missing.join(', ')}.` } } };
    }

    const created = await materializeNewRoles(discordGuild, options);
    if (created.createdRoles > 0) {
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Création de rôles (menu de rôles)',
        context: getGuildName(client, guildId),
        module: 'ReactionRoles',
        eventType: 'Manuel',
        details: `${created.createdRoles} rôle(s) créé(s) à la publication du menu`,
        channelId: null,
      });
    }
    return created.options;
  } finally {
    releaseProvisionLock(lockKey);
  }
}

export function createGeneralistModulesRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  // Masquer la section dans la navigation ne suffit pas : sans ce controle,
  // l'URL et l'API continuent de servir ces modules a un staff a qui le role
  // interdit la page. La cle de module vaut aussi cle de fonctionnalite ici.
  const funAccess = createMiddleware(async (c, next) => {
    const featureAccess = await resolveMemberFeatureAccess(client, c.req.param('guildId')!, c.var.effectiveAccess, c.var.dashboardUser.userId);
    if (!featureAccess.fun?.canView) {
      return send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès à cette section.' }, 403);
    }
    await next();
  });
  const funGate = [...gate, funAccess] as const;

  // Les écritures sont ouvertes aux rôles gestionnaires déclarés dans
  // l'onglet Configuration : la garde serveur les laisse passer, c'est ici
  // qu'on tranche. Le réglage de ces rôles (`/config`) reste réservé aux
  // administrateurs du dashboard.
  const giveawayManagers = createMiddleware(async (c, next) => {
    const isConfig = /\/giveaways\/config(\/|$)/.test(c.req.path);
    if (c.req.method !== 'GET' && !isConfig && !c.var.effectiveAccess.canManageSettings) {
      const guildId = c.req.param('guildId')!;
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const member = discordGuild ? await discordGuild.members.fetch(c.var.dashboardUser.userId).catch(() => null) : null;
      if (!(await canManageGiveaways(member, guildId))) {
        return send(c, { error: 'Gestion des giveaways non autorisée.' }, 403);
      }
    }
    await next();
  });
  const giveawayGate = [...gate, giveawayManagers] as const;

  // GET|POST /api/dashboard/guilds/:guildId/leveling/role-resync (Rangement des rôles)
  router.get(`${base}/leveling/role-resync`, ...gate, (c) => send(c, getRoleResyncStatus(c.req.param('guildId'))));
  router.post(`${base}/leveling/role-resync`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readBody<{ stop?: boolean }>(c);
    if (body?.stop) {
      const stopped = stopRoleResync(guildId);
      return send(c, { stopped, ...getRoleResyncStatus(guildId) });
    }

    const started = startRoleResync(guildId, client);
    if (started.started) {
      const user = c.var.dashboardUser;
      await pushAudit(guildId, {
        user: `${user.username ?? 'Utilisateur'} (${user.userId})`,
        action: 'Rangement des rôles de niveau',
        context: getGuildName(client, guildId),
        module: 'Leveling',
        eventType: 'Manuel',
        details: `${started.pending} membres à revoir`,
        channelId: null,
      });
    }
    return send(c, { ...started, ...getRoleResyncStatus(guildId) });
  });

  // /api/dashboard/guilds/:guildId/fun/emoji-riddles[/:id]
  router.on(['GET', 'POST', 'PATCH', 'DELETE'], [`${base}/fun/emoji-riddles`, `${base}/fun/emoji-riddles/:riddleId`], ...funGate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const riddleId = c.req.param('riddleId');
    const method = c.req.method;
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const { DEFAULT_EMOJI_RIDDLES } = await import('../../../services/features/funService.js');

      if (!riddleId && method === 'GET') {
        const riddles = await prisma.funEmojiRiddle.findMany({
          where: { guildId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, emojis: true, answers: true },
        });
        return send(c, { riddles, defaults: DEFAULT_EMOJI_RIDDLES });
      }

      if ((!riddleId && method === 'POST') || (riddleId && method === 'PATCH')) {
        const parsed = parseEmojiRiddleInput(await readBody(c));
        if ('error' in parsed) return send(c, { error: parsed.error }, 400);

        const existing = riddleId
          ? await prisma.funEmojiRiddle.findFirst({ where: { id: riddleId, guildId } })
          : null;
        if (riddleId && !existing) return send(c, { error: 'Rébus introuvable' }, 404);

        // L'enchaînement des rébus identifie le rébus en cours par ses emojis :
        // deux rébus identiques s'y confondraient.
        const duplicate = await prisma.funEmojiRiddle.findFirst({
          where: { guildId, emojis: parsed.emojis, ...(riddleId ? { NOT: { id: riddleId } } : {}) },
          select: { id: true },
        });
        if (duplicate) return send(c, { error: 'Un rébus avec ces emojis existe déjà' }, 409);

        if (!riddleId) {
          const count = await prisma.funEmojiRiddle.count({ where: { guildId } });
          if (count >= MAX_EMOJI_RIDDLES) return send(c, { error: `Limite de ${MAX_EMOJI_RIDDLES} rébus atteinte` }, 400);
        }

        const riddle = riddleId
          ? await prisma.funEmojiRiddle.update({
              where: { id: riddleId },
              data: { emojis: parsed.emojis, answers: parsed.answers },
              select: { id: true, emojis: true, answers: true },
            })
          : await prisma.funEmojiRiddle.create({
              data: { guildId, emojis: parsed.emojis, answers: parsed.answers },
              select: { id: true, emojis: true, answers: true },
            });

        // Corriger les réponses du rébus en cours doit valoir tout de suite,
        // pas seulement au prochain tirage. Les emojis ne sont pas repris : le
        // salon a déjà reçu l'ancien indice. Les réponses font partie du
        // filtre : un rébus fourni peut porter les mêmes emojis, et ses
        // réponses ne doivent pas être écrasées.
        if (existing) {
          await prisma.funGameState.updateMany({
            where: {
              guildId,
              emojiRiddleEmojis: existing.emojis,
              emojiRiddleAnswer: JSON.stringify(existing.answers),
            },
            data: { emojiRiddleAnswer: JSON.stringify(parsed.answers) },
          });
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: riddleId ? 'Modification Rébus Emoji' : 'Ajout Rébus Emoji',
          context: getGuildName(client, guildId),
          module: 'Fun',
          eventType: 'Manuel',
          details: `Rébus ${parsed.emojis} (${parsed.answers.length} réponse(s) acceptée(s)).`,
          channelId: null
        });

        return send(c, { riddle }, riddleId ? 200 : 201);
      }

      if (riddleId && method === 'DELETE') {
        const deleted = await prisma.funEmojiRiddle.deleteMany({ where: { id: riddleId, guildId } });
        if (deleted.count === 0) return send(c, { error: 'Rébus introuvable' }, 404);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression Rébus Emoji',
          context: getGuildName(client, guildId),
          module: 'Fun',
          eventType: 'Manuel',
          details: 'Un rébus emoji a été supprimé depuis le dashboard.',
          channelId: null
        });

        return send(c, { ok: true });
      }
      return send(c, { error: 'Route introuvable' }, 404);
    } catch (err) {
      logger.error('FunAPI', 'Error handling emoji riddles:', err);
      return fail(c, err, 'Erreur lors de la gestion des rébus emoji', 'FunAPI');
    }
  });



  router.get(`${base}/leveling`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const config = await getOrCreateLevelConfig(guildId);
      const rewards = await prisma.levelRoleReward.findMany({
        where: { guildId },
        orderBy: { level: 'asc' },
      });
      // Les compteurs du classement sortent de la base, qui les tient déjà :
      // les recalculer membre par membre dans le navigateur revenait à
      // reparcourir toute la guilde à chaque affichage.
      const totals = await prismaRead.memberLevel.aggregate({
        where: { guildId },
        _count: { _all: true },
        _sum: { xp: true },
        _avg: { level: true },
        _max: { level: true },
      });
      const stats = {
        memberCount: totals._count._all,
        totalXp: totals._sum.xp ?? 0,
        avgLevel: Math.round(totals._avg.level ?? 0),
        maxLevel: totals._max.level ?? 0,
      };

      // Blacklist commune aux modules de progression : rangée sur le serveur,
      // éditée depuis cette page qui porte déjà les exclusions du leveling.
      const blacklist = await prisma.guild.findUnique({ where: { id: guildId }, select: BLACKLIST_SELECT });

      const identities = await getMemberIdentities(client, guildId, blacklist?.progressionBlacklistUserIds ?? []);
      const blacklistNames = Object.fromEntries(
        [...identities].map(([id, who]) => [id, who.displayName || who.username]),
      );

      return send(c, { config: { ...config, ...blacklist }, rewards, stats, blacklistNames });
    } catch (err) {
      logger.error('LevelingAPI', 'Error fetching leveling data:', err);
      return fail(c, err, 'Erreur lors de la récupération du leveling', 'LevelingAPI');
    }
  });

  router.get(`${base}/leveling/leaderboard`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const search = (c.req.query('search') ?? '').trim();
      const page = Math.max(1, Math.floor(Number((c.req.query('page') ?? null)) || 1));

      // La recherche part sur les profils, seul endroit où les pseudos sont
      // stockés : `MemberLevel` ne connaît que des identifiants. Le plafond
      // borne la liste d'identifiants remise à la requête suivante.
      const matchedUserIds = search
        ? await resolveSearchedUserIds(guildId, search, LEADERBOARD_SEARCH_LIMIT)
        : null;

      const where = matchedUserIds ? { guildId, userId: { in: matchedUserIds } } : { guildId };
      const total = await prismaRead.memberLevel.count({ where });
      const pageCount = Math.max(1, Math.ceil(total / LEADERBOARD_PAGE_SIZE));
      const currentPage = Math.min(page, pageCount);
      const skip = (currentPage - 1) * LEADERBOARD_PAGE_SIZE;

      // `userId` départage les ex aequo : sans second critère, deux pages
      // successives peuvent renvoyer deux fois la même ligne et en omettre
      // une autre, l'ordre entre lignes de même XP n'étant pas garanti.
      const pageRows = await prismaRead.memberLevel.findMany({
        where,
        orderBy: [{ xp: 'desc' }, { userId: 'asc' }],
        skip,
        take: LEADERBOARD_PAGE_SIZE,
      });

      // Filet contre les lignes en double d'un même membre : la page les
      // affiche par identifiant et deux lignes identiques la feraient tomber
      // entière. La plus fournie gagne, comme au recalcul des niveaux.
      const rowByUser = new Map<string, (typeof pageRows)[number]>();
      for (const row of pageRows) {
        const kept = rowByUser.get(row.userId);
        if (!kept || row.xp > kept.xp) rowByUser.set(row.userId, row);
      }
      const rows = [...rowByUser.values()];

      // Hors recherche, le rang est la position dans le tri : la base l'a déjà
      // donné. Filtré, il faut le compter, mais seulement pour les lignes
      // affichées.
      const ranks = matchedUserIds
        ? await Promise.all(rows.map((row) => prismaRead.memberLevel
            .count({ where: { guildId, xp: { gt: row.xp } } })
            .then((higher) => higher + 1)))
        : rows.map((_, index) => skip + index + 1);

      const members = await withMemberIdentity(guildId, client, rows);

      return send(c, {
        rows: members.map((member, index) => ({ ...member, rank: ranks[index] })),
        total,
        page: currentPage,
        pageCount,
        pageSize: LEADERBOARD_PAGE_SIZE,
        searchLimited: matchedUserIds !== null && matchedUserIds.length >= LEADERBOARD_SEARCH_LIMIT,
      });
    } catch (err) {
      logger.error('LevelingAPI', 'Error fetching leaderboard page:', err);
      return fail(c, err, 'Erreur lors de la récupération du classement', 'LevelingAPI');
    }
  });

  router.get(`${base}/leveling/curve-impact`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const curve = normalizeLevelCurve({
        baseXp: Number((c.req.query('baseXp') ?? null)),
        linearXp: Number((c.req.query('linearXp') ?? null)),
        exponent: Number((c.req.query('exponent') ?? null)),
        maxLevel: Number((c.req.query('maxLevel') ?? null)),
      });
      return send(c, await countCurveImpact(guildId, curve));
    } catch (err) {
      logger.error('LevelingAPI', 'Error counting curve impact:', err);
      return fail(c, err, "Erreur lors du calcul de l'effet de la courbe", 'LevelingAPI');
    }
  });

  router.post(`${base}/leveling/level-up-channel`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions insuffisantes.' }, 403);
    }

    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) {
      return send(c, { error: 'Serveur Discord introuvable.' }, 404);
    }

    const lockKey = `leveling-channel:${guildId}`;
    if (!acquireProvisionLock(lockKey)) {
      return send(c, { error: 'Une création de salon est déjà en cours sur ce serveur.' }, 409);
    }

    try {
      const cooldown = await provisionCooldown(lockKey);
      if (cooldown) {
        return send(c, { error: provisionCooldownMessage(cooldown, 'Le salon a déjà été créé') }, 429);
      }

      const missing = await missingProvisionPermissions(discordGuild, [PermissionFlagsBits.ManageChannels]);
      if (missing.length > 0) {
        return send(c, { error: `Le bot n'a pas les permissions nécessaires : ${missing.join(', ')}.` }, 400);
      }

      // Nom dans la langue du serveur : le salon est lu par ses membres, pas
      // par l'admin qui clique depuis le dashboard.
      const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);

      // `levelUpChannelId` porte aussi des valeurs qui ne sont pas des salons
      // (vide pour le salon d'origine, `DM` pour le message privé) : seul un
      // identifiant de salon vivant est repris, le reste part sur une création.
      const config = await getOrCreateLevelConfig(guildId);
      const existingId = config.levelUpChannelId && config.levelUpChannelId !== 'DM'
        ? config.levelUpChannelId
        : null;

      // Le refus d'ecriture vaut aussi pour le bot : sans surcharge a son nom,
      // il ne pourrait pas annoncer les niveaux dans le salon qu'il vient de
      // creer, sauf a etre administrateur du serveur.
      const botId = discordGuild.members.me?.id;

      const { channel, entry } = await ensureTextChannel(discordGuild, {
        key: 'levelUpChannel',
        existingId,
        name: m.setup_channel_leveling({}, { locale }),
        permissionOverwrites: [
          {
            id: discordGuild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages],
          },
          ...(botId
            ? [{
                id: botId,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.EmbedLinks,
                ]
              }]
            : []),
        ],
        reason: m.setup_reason_leveling({ user: auditUser }, { locale }),
      });

      // Ecrit tout de suite : un salon cree que la page n'enregistrerait pas
      // resterait sur le serveur sans que rien n'y renvoie.
      // Le message est depose en meme temps quand l'admin n'en a pas ecrit :
      // la mise en route doit laisser un texte visible et modifiable, pas un
      // champ vide dont on ne devine pas ce qu'il produira. Sans creation,
      // rien n'est ecrit et la page recoit la valeur inchangee.
      const levelUpMessage = entry.created
        ? (config.levelUpMessage?.trim() || defaultLevelUpMessage(locale))
        : config.levelUpMessage;

      if (entry.created) {
        await prisma.levelConfig.update({
          where: { guildId },
          data: { levelUpChannelId: channel.id, levelUpMessage },
        });
        invalidateLevelConfigCache(guildId);
        await startProvisionCooldown(lockKey, user.username ?? 'Utilisateur');

        await pushAudit(guildId, {
          user: auditUser,
          action: "Création du salon d'annonce des niveaux",
          context: getGuildName(client, guildId),
          module: 'Leveling',
          eventType: 'Manuel',
          details: `Salon créé : #${channel.name}`,
          channelId: channel.id,
        });
      }

      return send(c, { channelId: channel.id, name: channel.name, created: entry.created, levelUpMessage });
    } catch (err) {
      logger.error('LevelingAPI', 'Error creating level-up channel:', err);
      return fail(c, err, "Erreur lors de la création du salon d'annonce", 'LevelingAPI');
    } finally {
      releaseProvisionLock(lockKey);
    }
  });

  router.patch(`${base}/leveling`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        enabled?: boolean;
        xpMin?: number;
        xpMax?: number;
        cooldownSeconds?: number;
        vocalXpPerMin?: number;
        levelUpChannelId?: string | null;
        levelUpMessage?: string;
        stackRewards?: boolean;
        ignoredChannels?: string[];
        ignoredRoles?: string[];
        progressionBlacklistUserIds?: unknown;
        progressionBlacklistRoleIds?: unknown;
        progressionBlacklistChannelIds?: unknown;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        xpMultipliers?: any;
        lengthBonusEnabled?: boolean;
        lengthBonusThreshold?: number;
        lengthBonusMaxMultiplier?: number;
        curveBaseXp?: number;
        curveLinearXp?: number;
        curveExponent?: number;
        maxLevel?: number;
        voiceRequireUnmuted?: boolean;
        voiceRequireUndeafened?: boolean;
        voiceIgnoreAfkChannel?: boolean;
        voiceMinMembers?: number;
        dailyXpCap?: number;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
      }

      const previousConfig = await getOrCreateLevelConfig(guildId).catch(() => null);

      // Les valeurs absentes du corps reprennent le défaut de la courbe, mais
      // ne sont réinjectées dans l'`update` que si le client les a envoyées :
      // un PATCH partiel ne doit pas réinitialiser la courbe de la guilde.
      const curve = normalizeLevelCurve({
        baseXp: body.curveBaseXp,
        linearXp: body.curveLinearXp,
        exponent: body.curveExponent,
        maxLevel: body.maxLevel,
      });

      const config = await prisma.levelConfig.update({
        where: { guildId },
        data: {
          enabled: body.enabled,
          xpMin: body.xpMin,
          xpMax: body.xpMax,
          cooldownSeconds: body.cooldownSeconds,
          vocalXpPerMin: body.vocalXpPerMin,
          levelUpChannelId: body.levelUpChannelId,
          levelUpMessage: body.levelUpMessage,
          stackRewards: body.stackRewards,
          ignoredChannels: body.ignoredChannels,
          ignoredRoles: body.ignoredRoles,
          xpMultipliers: body.xpMultipliers,
          lengthBonusEnabled: body.lengthBonusEnabled,
          lengthBonusThreshold: body.lengthBonusThreshold !== undefined
            ? Math.max(1, Math.floor(body.lengthBonusThreshold))
            : undefined,
          lengthBonusMaxMultiplier: body.lengthBonusMaxMultiplier !== undefined
            ? Math.min(10, Math.max(1, body.lengthBonusMaxMultiplier))
            : undefined,
          // `!= null` et non `!== undefined` : un champ numérique vidé dans le
          // dashboard arrive à null, et le borner reviendrait à écrire la
          // valeur minimale au lieu de laisser le réglage en place.
          curveBaseXp: body.curveBaseXp != null ? curve.baseXp : undefined,
          curveLinearXp: body.curveLinearXp != null ? curve.linearXp : undefined,
          curveExponent: body.curveExponent != null ? curve.exponent : undefined,
          maxLevel: body.maxLevel != null ? curve.maxLevel : undefined,
          voiceRequireUnmuted: body.voiceRequireUnmuted,
          voiceRequireUndeafened: body.voiceRequireUndeafened,
          voiceIgnoreAfkChannel: body.voiceIgnoreAfkChannel,
          voiceMinMembers: body.voiceMinMembers != null
            ? Math.min(25, Math.max(1, Math.floor(body.voiceMinMembers)))
            : undefined,
          dailyXpCap: body.dailyXpCap != null
            ? Math.min(1_000_000, Math.max(0, Math.floor(body.dailyXpCap)))
            : undefined,
        },
      });

      await invalidateLevelConfigCache(guildId);

      // Seuls des identifiants Discord passent : la liste est lue à chaque gain d'XP.
      const snowflakes = (value: unknown): string[] | undefined => Array.isArray(value)
        ? [...new Set(value.filter((id): id is string => typeof id === 'string' && /^\d{15,25}$/.test(id)))].slice(0, 500)
        : undefined;
      const blacklistUpdate = {
        progressionBlacklistUserIds: snowflakes(body.progressionBlacklistUserIds),
        progressionBlacklistRoleIds: snowflakes(body.progressionBlacklistRoleIds),
        progressionBlacklistChannelIds: snowflakes(body.progressionBlacklistChannelIds),
      };
      const blacklist = Object.values(blacklistUpdate).some((list) => list !== undefined)
        ? await prisma.guild.update({ where: { id: guildId }, data: blacklistUpdate, select: BLACKLIST_SELECT })
        : await prisma.guild.findUnique({ where: { id: guildId }, select: BLACKLIST_SELECT });
      await cache.delete(`guild:${guildId}:config`);

      // Un changement de courbe redistribue les niveaux : la colonne `level`
      // est réalignée tout de suite, sinon les membres inactifs la gardent
      // périmée jusqu'à leur prochain gain d'XP.
      const curveChanged = !previousConfig
        || previousConfig.curveBaseXp !== config.curveBaseXp
        || previousConfig.curveLinearXp !== config.curveLinearXp
        || previousConfig.curveExponent !== config.curveExponent
        || previousConfig.maxLevel !== config.maxLevel;

      // `null` distingue l'échec du réalignement de l'absence de réalignement :
      // le dashboard annonce un chiffre avant l'enregistrement, il ne doit pas
      // confirmer « 0 niveau réaligné » quand la requête a en fait échoué.
      let resynced: number | null = 0;
      if (curveChanged) {
        // `client` : le réalignement enchaîne sur une passe de rôles, sans
        // laquelle les récompenses resteraient sur l'ancienne courbe.
        resynced = await resyncGuildLevels(guildId, levelCurveFromConfig(config), { client })
          .catch((err) => {
            logger.error('LevelingAPI', `Réalignement des niveaux échoué pour ${guildId}:`, err);
            return null;
          });
        if (resynced && resynced > 0) {
          logger.info('LevelingAPI', `Courbe modifiée sur ${guildId} : ${resynced} niveaux réalignés.`);
        }
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour Leveling',
        context: getGuildName(client, guildId),
        module: 'Leveling',
        eventType: 'Manuel',
        details: `Configuration modifiée. Actif: ${config.enabled}`,
        channelId: null
      });

      return send(c, { config: { ...config, ...blacklist }, resynced, roleResync: getRoleResyncStatus(guildId) });
    } catch (err) {
      logger.error('LevelingAPI', 'Error updating leveling config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du leveling', 'LevelingAPI');
    }
  });

  router.post(`${base}/leveling/rewards`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ level: number; roleId: string }>(c);
      if (!body || !body.level || !body.roleId) {
        return send(c, { error: 'Niveau et rôle requis' }, 400);
      }

      const reward = await prisma.levelRoleReward.create({
        data: {
          guildId,
          level: body.level,
          roleId: body.roleId,
        },
      });

      await invalidateLevelRewardsCache(guildId);
      return send(c, { reward });
    } catch (err) {
      logger.error('LevelingAPI', 'Error creating reward:', err);
      return fail(c, err, 'Erreur lors de la création de la récompense', 'LevelingAPI');
    }
  });

  router.delete(`${base}/leveling/rewards/:rewardId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const rewardId = c.req.param('rewardId');
    try {
      const removed = await prisma.levelRoleReward.deleteMany({
        where: { id: rewardId, guildId },
      });
      if (removed.count === 0) {
        return send(c, { error: 'Récompense introuvable' }, 404);
      }
      await invalidateLevelRewardsCache(guildId);
      return send(c, { success: true });
    } catch (err) {
      logger.error('LevelingAPI', 'Error deleting reward:', err);
      return fail(c, err, 'Erreur lors de la suppression de la récompense', 'LevelingAPI');
    }
  });

  // Lecture par IA de captures ou de texte d'un classement tiers. Ne fait que
  // rendre des lignes : l'admin les relit avant l'analyse et l'import.
  router.post(`${base}/leveling/import/extract`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      if ((await getGuildPlan(guildId)) === 'FREE') {
        return send(c, { error: 'plan_required', message: "La lecture par IA fait partie de l'offre Plus." }, 402);
      }
      // Chaque lecture coûte un appel au modèle : 20 par heure et par serveur.
      if (!checkRateLimit(levelImportLlmRateLimiter, guildId, 20, 60 * 60_000)) {
        return send(c, { error: 'Trop de lectures par IA pour ce serveur, réessaie dans une heure.' }, 429);
      }
      const body = await readBody<LlmImportInput>(c);
      const rows = await extractLeaderboardWithLlm(body ?? {});
      return send(c, { rows });
    } catch (err) {
      logger.error('LevelingAPI', 'Error during LLM leaderboard extraction:', err);
      return fail(c, err, "Impossible de lire ce classement avec l'IA", 'LevelingAPI');
    }
  });

  router.post(`${base}/leveling/import`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      // Avec `source`, le classement est lu chez l'autre bot ; le corps ne
      // porte au plus que la clef d'API (`{ apiKey }`) de la source.
      const sourceParam = (c.req.query('source') ?? null);
      if (sourceParam !== null && !isLevelImportSource(sourceParam)) {
        return send(c, { error: "Source d'import inconnue." }, 400);
      }
      const rawBody = await readBody<unknown>(c);
      let external: ExternalLevel[] | null = null;
      if (sourceParam) {
        const apiKey = (rawBody as { apiKey?: unknown } | null)?.apiKey;
        const job = externalLevelsJob(sourceParam, guildId, typeof apiKey === 'string' ? apiKey.trim() : undefined);
        if (job.error) throw job.error;
        if (!job.entries) {
          // Lecture en cours : le dashboard rappelle jusqu'à ce qu'elle aboutisse.
          return send(c, { pending: true, fetched: job.fetched }, 202);
        }
        external = job.entries;
      }

      const body = external ? [] : rawBody;
      if (!body || !Array.isArray(body)) {
        return send(c, { error: "Le corps de la requête doit être un tableau d'utilisateurs." }, 400);
      }

      // L'import écrase l'XP des membres reconnus : en mode analyse, tout est
      // calculé et rapporté à l'identique mais rien n'est écrit, pour qu'un
      // pseudo non reconnu se découvre avant l'écrasement et non après.
      const dryRun = (c.req.query('dry_run') ?? null) === '1';

      const validItems: Array<{
        userId?: string;
        username?: string;
        displayName?: string;
        level?: number;
        xp?: number;
        progress?: number;
      }> = external?.map((e) => ({ userId: e.userId, level: e.level, progress: e.progress, xp: e.xp })) ?? [];

      const failedMembers: Array<{
        username?: string;
        display_name?: string;
        reason: string;
      }> = [];

      for (const item of body) {
        if (!item || typeof item !== 'object') {
          failedMembers.push({ reason: "Format invalide (doit être un objet)" });
          continue;
        }

        const rawItem = item as Record<string, unknown>;
        const username = rawItem.username;
        const displayName = rawItem.display_name || rawItem.displayName;
        // Identifiant Discord facultatif (mention lue par l'IA, export tiers) :
        // plus sûr que le pseudo quand il est là.
        const rawUserId = rawItem.user_id ?? rawItem.userId;
        const userId = typeof rawUserId === 'string' && /^\d{17,20}$/.test(rawUserId) ? rawUserId : undefined;
        const level = typeof rawItem.level === 'number' ? rawItem.level : (typeof rawItem.level === 'string' ? parseInt(rawItem.level as string, 10) : NaN);
        const xp = typeof rawItem.xp === 'number' ? rawItem.xp : (typeof rawItem.xp === 'string' ? parseInt(rawItem.xp as string, 10) : NaN);

        if (!username && !displayName && !userId) {
          failedMembers.push({ reason: "Nom d'utilisateur ou pseudo manquant" });
          continue;
        }

        if (isNaN(level) && isNaN(xp)) {
          failedMembers.push({
            username: username ? String(username) : undefined,
            display_name: displayName ? String(displayName) : undefined,
            reason: "Niveau ou XP invalide/manquant"
          });
          continue;
        }

        validItems.push({
          userId,
          username: username ? String(username) : undefined,
          displayName: displayName ? String(displayName) : undefined,
          level: isNaN(level) ? undefined : level,
          xp: isNaN(xp) ? undefined : xp
        });
      }

      // Seuls les champs d'identite servent a construire la table de
      // correspondance ci-dessous : charger la ligne entiere faisait
      // transiter des dizaines de colonnes par membre pour en lire cinq.
      const dbProfiles = await prisma.memberProfile.findMany({
        where: { guildId },
        select: {
          userId: true,
          username: true,
          displayName: true,
          globalName: true,
          userTag: true,
        },
      });

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const discordMembers = discordGuild ? await fetchAllMembers(discordGuild).catch(() => new Map()) : new Map();

      const identityMap = new Map<string, string>();

      const normalize = (str: string) => {
        return str.toLowerCase().replace(/^@/, '').trim();
      };

      for (const p of dbProfiles) {
        if (p.userId) {
          if (p.username) identityMap.set(normalize(p.username), p.userId);
          if (p.displayName) identityMap.set(normalize(p.displayName), p.userId);
          if (p.globalName) identityMap.set(normalize(p.globalName), p.userId);
          if (p.userTag) identityMap.set(normalize(p.userTag), p.userId);
        }
      }

      if (discordMembers.size > 0) {
        for (const [id, member] of discordMembers) {
          identityMap.set(normalize(member.user.username), id);
          if (member.nickname) identityMap.set(normalize(member.nickname), id);
          identityMap.set(normalize(member.displayName), id);
          identityMap.set(normalize(member.user.tag), id);
        }
      }

      const importedSuccessfully: Array<{ userId: string; level: number; xp: number }> = [];
      const importCurve = await getGuildLevelCurve(guildId);
      // Un classement tiers garde les anciens membres : seuls ceux encore là
      // sont repris, et comptés à part plutôt que listés un par un en échec.
      let leftCount = 0;

      for (const item of validItems) {
        let userId: string | undefined;

        if (item.userId) {
          if (discordMembers.size > 0 && !discordMembers.has(item.userId)) {
            leftCount++;
            continue;
          }
          userId = item.userId;
        }
        if (!userId && item.username) {
          userId = identityMap.get(normalize(item.username));
        }
        if (!userId && item.displayName) {
          userId = identityMap.get(normalize(item.displayName));
        }

        if (!userId) {
          failedMembers.push({
            username: item.username,
            display_name: item.displayName,
            reason: "Membre introuvable sur le serveur Discord"
          });
          continue;
        }

        let xp = item.xp;
        let level = item.level;

        // Si seul le niveau est fourni, on déduit l'XP de ce niveau sur la
        // courbe du serveur, plus l'avancement dans le palier s'il est connu.
        if (xp === undefined && level !== undefined) {
          const floor = getXpForLevel(Math.max(0, level) - 1, importCurve);
          const next = getXpForLevel(Math.max(0, level), importCurve);
          xp = floor + Math.floor((item.progress ?? 0) * Math.max(0, next - floor - 1));
        }

        // L'XP est la source de vérité : on la ramène dans les bornes stockables
        // et on recalcule toujours le niveau, pour ne jamais stocker de couple
        // incohérent (ex. niveau importé d'un autre bot avec une autre courbe).
        // Sans le plafond, une ligne aberrante du fichier importé fait échouer
        // tout l'import sur un débordement de la colonne.
        if (xp !== undefined) {
          xp = clampXp(xp);
          level = getLevelFromXp(xp, importCurve);
        }

        if (xp === undefined || level === undefined) {
          failedMembers.push({
            username: item.username,
            display_name: item.displayName,
            reason: "Valeur de niveau/XP invalide"
          });
          continue;
        }

        importedSuccessfully.push({ userId, level, xp });
      }

      // Ce que l'import va remplacer, mesuré avant d'écrire : sans ça, un
      // classement importé depuis un autre bot écrase des niveaux plus hauts
      // et personne ne s'en aperçoit.
      // Par paquets : un fichier d'import peut couvrir toute la guilde, et un
      // `IN` de plusieurs dizaines de milliers d'identifiants dépasse ce que
      // Postgres accepte de paramètres liés.
      const currentByUser = new Map<string, { xp: number; level: number }>();
      for (let start = 0; start < importedSuccessfully.length; start += 1000) {
        const userIds = importedSuccessfully.slice(start, start + 1000).map((record) => record.userId);
        const rows = await prisma.memberLevel.findMany({
          where: { guildId, userId: { in: userIds } },
          select: { userId: true, xp: true, level: true },
        });
        for (const row of rows) currentByUser.set(row.userId, { xp: row.xp, level: row.level });
      }

      let createdCount = 0;
      let levelChangeCount = 0;
      let xpLoweredCount = 0;
      for (const record of importedSuccessfully) {
        const existing = currentByUser.get(record.userId);
        if (!existing) {
          createdCount++;
          continue;
        }
        if (existing.level !== record.level) levelChangeCount++;
        if (record.xp < existing.xp) xpLoweredCount++;
      }

      const report = {
        success: true,
        dryRun,
        importedCount: importedSuccessfully.length,
        failedCount: failedMembers.length,
        failedMembers,
        leftCount,
        createdCount,
        levelChangeCount,
        xpLoweredCount,
      };

      if (dryRun) {
        return send(c, report);
      }

      for (const record of importedSuccessfully) {
        await prisma.memberLevel.upsert({
          where: { guildId_userId: { guildId, userId: record.userId } },
          update: {
            xp: record.xp,
            level: record.level,
            lastXpGain: new Date()
          },
          create: {
            guildId,
            userId: record.userId,
            xp: record.xp,
            level: record.level,
            lastXpGain: new Date()
          }
        });
      }

      if (sourceParam) forgetExternalLevels(sourceParam, guildId);

      if (importedSuccessfully.length > 0) {
        (async () => {
          for (const record of importedSuccessfully) {
            await updateMemberLevelRoles(guildId, record.userId, record.level, client).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        })().catch(err => {
          logger.error('LevelingAPI', 'Error updating roles in background:', err);
        });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Import de classement',
        context: getGuildName(client, guildId),
        module: 'Leveling',
        eventType: 'Manuel',
        details: `Importation réussie de ${importedSuccessfully.length} membres (échec: ${failedMembers.length})${sourceParam ? ` depuis ${sourceParam}` : ''}`,
        channelId: null
      });

      return send(c, report);
    } catch (err) {
      logger.error('LevelingAPI', 'Error during leveling import:', err);
      return fail(c, err, "Erreur lors de l'importation des données", 'LevelingAPI');
    }
  });

  router.get(`${base}/giveaways/config`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      // Les textes d'usine accompagnent la configuration : la page doit
      // pouvoir y revenir, et ils dependent de la langue du serveur, que
      // seul le bot connait.
      const [config, locale] = await Promise.all([
        getGiveawayConfig(guildId),
        resolveGuildLocale(guildId),
      ]);
      return send(c, { config, defaults: defaultAppearance(locale), labels: generatedLabels(locale) });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error fetching giveaway config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration', 'GiveawaysAPI');
    }
  });

  router.put(`${base}/giveaways/config`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<Record<string, unknown>>(c);

      if (!body || typeof body !== 'object') {
        return send(c, { error: 'Corps de requête invalide' }, 400);
      }

      // Seules les clefs reçues sont écrites : un appel qui ne porte que les
      // rôles gestionnaires ne doit pas remettre l'apparence à zéro au
      // passage. Une valeur refusée par la validation compte comme absente.
      const patch = normalizeGiveawayConfigPatch(body);

      // Un gabarit vidé, ou ramené à son texte d'usine, n'est plus un choix :
      // on efface la colonne pour que le concours suive la langue du serveur.
      const locale = await resolveGuildLocale(guildId);
      const defaults = defaultAppearance(locale);
      const resetToDefault = RESETTABLE_TEXT_KEYS.filter((key) => {
        if (!(key in body)) return false;
        const raw = body[key];
        if (typeof raw !== 'string') return false;
        const trimmed = raw.trim();
        return trimmed === '' || trimmed === defaults[key];
      });
      for (const key of resetToDefault) delete patch[key];

      const config = await updateGiveawayConfig(guildId, patch, resetToDefault);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Configuration des giveaways',
        context: getGuildName(client, guildId),
        module: 'Giveaways',
        eventType: 'Manuel',
        details: `Gestionnaires : ${config.managerRoleIds.length} rôle(s), participation : ${config.requiredRoleIds.length} rôle(s) requis, ${config.blockedRoleIds.length} rôle(s) exclu(s)`,
        channelId: null,
      });

      // Les concours deja publies portent l'ancienne apparence : sans cette
      // reecriture, un reglage ne se verrait qu'au prochain clic d'un
      // participant, et passerait pour sans effet. Lancee sans attendre : un
      // serveur qui a dix concours ouverts ferait patienter la page pour un
      // travail qui n'a pas besoin d'etre fini quand elle repond.
      void refreshActiveGiveaways(client, guildId).catch((err) => {
        logger.error('GiveawaysAPI', 'Error refreshing giveaway announcements:', err);
      });

      return send(c, { config, defaults: defaultAppearance(locale), labels: generatedLabels(locale) });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error updating giveaway config:', err);
      return fail(c, err, 'Erreur lors de l\'enregistrement de la configuration', 'GiveawaysAPI');
    }
  });

  router.get(`${base}/giveaways/config/presets`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      return send(c, { presets: await listGiveawayConfigPresets(guildId) });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error fetching giveaway config presets:', err);
      return fail(c, err, 'Erreur lors de la récupération des sauvegardes', 'GiveawaysAPI');
    }
  });

  router.post(`${base}/giveaways/config/presets`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{ name?: unknown; settings?: unknown }>(c);
      if (!body || typeof body !== 'object') {
        return send(c, { error: 'Corps de requête invalide' }, 400);
      }

      // Sans réglages fournis, on met de côté ceux du serveur : la page
      // enregistre ce qu'elle affiche, mais un appel plus court reste juste.
      const settings = body.settings && typeof body.settings === 'object'
        ? body.settings as Record<string, unknown>
        : await getGiveawayConfig(guildId) as unknown as Record<string, unknown>;

      const preset = await createGiveawayConfigPreset(guildId, body.name as string, settings);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde de configuration giveaway créée',
        context: getGuildName(client, guildId),
        module: 'Giveaways',
        eventType: 'Manuel',
        details: `Sauvegarde « ${preset.name} »`,
        channelId: null,
      });

      return send(c, { preset });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error creating giveaway config preset:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de l\'enregistrement de la sauvegarde') }, 400);
    }
  });

  router.put(`${base}/giveaways/config/presets/:presetId`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const presetId = c.req.param('presetId');
    try {
      const body = await readBody<{ name?: unknown; settings?: unknown }>(c);
      if (!body || typeof body !== 'object') {
        return send(c, { error: 'Corps de requête invalide' }, 400);
      }

      // `settings` absent renomme sans toucher aux réglages figés : la liste
      // corrige un nom sans avoir à réappliquer la sauvegarde d'abord.
      const preset = await updateGiveawayConfigPreset(
        guildId,
        presetId,
        body.name as string,
        body.settings && typeof body.settings === 'object'
          ? body.settings as Record<string, unknown>
          : undefined,
      );

      return send(c, { preset });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error updating giveaway config preset:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la modification de la sauvegarde') }, 400);
    }
  });

  router.delete(`${base}/giveaways/config/presets/:presetId`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const presetId = c.req.param('presetId');
    try {
      if (!(await deleteGiveawayConfigPreset(guildId, presetId))) {
        return send(c, { error: 'Sauvegarde introuvable sur ce serveur' }, 404);
      }
      return send(c, { success: true });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error deleting giveaway config preset:', err);
      return fail(c, err, 'Erreur lors de la suppression de la sauvegarde', 'GiveawaysAPI');
    }
  });

  //
  // La section Economie expose deja la meme liste, mais derriere son propre
  // droit : un role qui pilote les concours sans toucher au RPG ne pourrait
  // pas choisir l'objet mis en jeu. On ne renvoie ici que ce que le selecteur
  // affiche.
  router.get(`${base}/giveaways/items`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      return send(c, { items: await listGiveawayRpgItems(guildId) });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error fetching RPG items:', err);
      return fail(c, err, 'Erreur lors de la récupération des objets RPG', 'GiveawaysAPI');
    }
  });

  router.get(`${base}/giveaways/templates`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      return send(c, { templates: await listGiveawayTemplates(guildId) });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error fetching giveaway templates:', err);
      return fail(c, err, 'Erreur lors de la récupération des modèles', 'GiveawaysAPI');
    }
  });

  router.post(`${base}/giveaways/templates`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<GiveawayTemplateInput>(c);
      if (!body || typeof body !== 'object') {
        return send(c, { error: 'Corps de requête invalide' }, 400);
      }

      const template = await createGiveawayTemplate(guildId, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modèle de giveaway créé',
        context: getGuildName(client, guildId),
        module: 'Giveaways',
        eventType: 'Manuel',
        details: `Modèle « ${template.name} » : ${template.prize}`,
        channelId: null,
      });

      return send(c, { template });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error creating giveaway template:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la création du modèle') }, 400);
    }
  });

  router.put(`${base}/giveaways/templates/:templateId`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    const templateId = c.req.param('templateId');
    try {
      const body = await readBody<GiveawayTemplateInput>(c);
      if (!body || typeof body !== 'object') {
        return send(c, { error: 'Corps de requête invalide' }, 400);
      }

      const template = await updateGiveawayTemplate(guildId, templateId, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modèle de giveaway modifié',
        context: getGuildName(client, guildId),
        module: 'Giveaways',
        eventType: 'Manuel',
        details: `Modèle « ${template.name} » : ${template.prize}`,
        channelId: null,
      });

      return send(c, { template });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error updating giveaway template:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la modification du modèle') }, 400);
    }
  });

  router.delete(`${base}/giveaways/templates/:templateId`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const templateId = c.req.param('templateId');
    try {
      if (!(await deleteGiveawayTemplate(guildId, templateId))) {
        return send(c, { error: 'Modèle introuvable sur ce serveur' }, 404);
      }
      return send(c, { success: true });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error deleting giveaway template:', err);
      return fail(c, err, 'Erreur lors de la suppression du modèle', 'GiveawaysAPI');
    }
  });

  router.get(`${base}/giveaways`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const giveaways = await prisma.giveaway.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });

      // Gagnants et auteur sont stockés en identifiants Discord : sans les
      // résoudre, la page n'affiche qu'une suite de nombres impossible à
      // rattacher à quelqu'un.
      const userIds = [...new Set(giveaways.flatMap((giveaway) => [
        ...giveaway.winners,
        ...giveaway.pendingWinners,
        ...(giveaway.createdById ? [giveaway.createdById] : []),
      ]))];
      const identities = await withMemberIdentity(guildId, client, userIds.map((userId) => ({ userId })));
      const identityById = new Map(identities.map((entry) => [entry.userId, entry]));
      const profileOf = (userId: string) =>
        identityById.get(userId)
        ?? { userId, username: null, displayName: `Utilisateur ${userId}`, avatarUrl: null };

      // Les rôles gestionnaires de l'onglet Configuration ouvrent les actions
      // sans droit d'administration du dashboard. La page doit le savoir pour
      // afficher les boutons : sinon l'autorisation accordée reste invisible,
      // alors que l'API l'accepterait.
      let canManage = c.var.effectiveAccess.canManageSettings;
      if (!canManage) {
        const discordGuild = client.guilds.cache.get(guildId)
          || await client.guilds.fetch(guildId).catch(() => null);
        const member = discordGuild
          ? await discordGuild.members.fetch(user.userId).catch(() => null)
          : null;
        canManage = await canManageGiveaways(member, guildId);
      }

      return send(c, {
        canManage,
        giveaways: giveaways.map((giveaway) => ({
          ...giveaway,
          creatorProfile: giveaway.createdById ? profileOf(giveaway.createdById) : null,
          winnerProfiles: giveaway.winners.map(profileOf),
          pendingWinnerProfiles: giveaway.pendingWinners.map(profileOf),
        })),
      });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error fetching giveaways:', err);
      return fail(c, err, 'Erreur lors de la récupération des giveaways', 'GiveawaysAPI');
    }
  });

  router.post(`${base}/giveaways`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        prize?: string;
        winnerCount?: number;
        durationMinutes?: number;
        description?: string;
        channelId?: string;
        styleOverrides?: unknown;
        ignoreBonuses?: boolean;
        rpgXp?: number;
        rpgCoins?: number;
        rpgItemId?: string;
        needValidation?: boolean;
      }>(c);

      if (!body || typeof body !== 'object') {
        return send(c, { error: 'Corps de requête invalide' }, 400);
      }

      // La page porte tous les champs d'un concours, récompenses et apparence
      // comprises, et les envoie tels quels : rien n'est plus complété ici à
      // partir d'un modèle.
      const { prize, winnerCount, durationMinutes, channelId } = body;

      if (!prize || typeof channelId !== 'string' || typeof winnerCount !== 'number' || typeof durationMinutes !== 'number') {
        return send(c, { error: 'Champs obligatoires manquants' }, 400);
      }
      if (!/^\d{17,20}$/.test(channelId)) {
        return send(c, { error: 'Salon Discord invalide' }, 400);
      }

      const styleOverrides = normalizeAppearancePatch(body.styleOverrides);

      const giveaway = await createGiveaway(
        client,
        guildId,
        channelId,
        prize,
        winnerCount,
        durationMinutes,
        typeof body.description === 'string' ? body.description : undefined,
        typeof body.rpgXp === 'number' ? normalizeThreshold(body.rpgXp, 1_000_000) : 0,
        typeof body.rpgCoins === 'number' ? normalizeThreshold(body.rpgCoins, 1_000_000) : 0,
        typeof body.rpgItemId === 'string' ? body.rpgItemId.trim().slice(0, 100) || null : null,
        body.needValidation === true,
        user.userId,
        styleOverrides,
        body.ignoreBonuses === true
      );

      // Même forme que le GET : la page insère le concours en tête de liste
      // sans recharger, il doit donc porter les mêmes champs.
      const [creatorProfile] = await withMemberIdentity(guildId, client, [{ userId: user.userId }]);
      return send(c, {
        giveaway: { ...giveaway, creatorProfile, winnerProfiles: [], pendingWinnerProfiles: [] },
      });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error creating giveaway:', err);
      // 400 pour tout ce que `createGiveaway` rejette : ses refus sont des
      // saisies à corriger, traduites dans la langue du serveur, et la page
      // les affiche telles quelles. Le test portait sur « serveur staff »,
      // qu'un serveur anglophone ne voyait jamais passer, et son lot d'objet
      // introuvable ou de salon muet remontait en erreur serveur.
      return send(c, {
        error: publicErrorMessage(err, 'Erreur lors de la création du giveaway'),
      }, err instanceof Error ? 400 : 500);
    }
  });

  router.post(`${base}/giveaways/:giveawayId/end`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const giveawayId = c.req.param('giveawayId');
    try {
      const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId } });
      if (!giveaway) {
        return send(c, { error: 'Giveaway introuvable sur ce serveur' }, 404);
      }
      if (giveaway.ended) {
        return send(c, { error: 'Ce giveaway est déjà terminé' }, 409);
      }
      await endGiveaway(client, giveawayId, guildId);
      return send(c, { success: true });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error ending giveaway:', err);
      return fail(c, err, 'Erreur lors de la clôture du giveaway', 'GiveawaysAPI');
    }
  });

  router.post(`${base}/giveaways/:giveawayId/reroll`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const giveawayId = c.req.param('giveawayId');
    try {
      const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId } });
      if (!giveaway) {
        return send(c, { error: 'Giveaway introuvable sur ce serveur' }, 404);
      }
      if (!giveaway.ended) {
        return send(c, { error: 'Le giveaway doit être terminé avant un reroll' }, 409);
      }
      if (!(await rerollGiveaway(client, giveawayId, guildId))) {
        return send(c, { error: 'Aucun participant à tirer pour ce giveaway' }, 409);
      }
      return send(c, { success: true });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error rerolling giveaway:', err);
      return fail(c, err, 'Erreur lors du reroll', 'GiveawaysAPI');
    }
  });

  router.delete(`${base}/giveaways/:giveawayId`, ...giveawayGate, async (c) => {
    const guildId = c.req.param('guildId');
    const giveawayId = c.req.param('giveawayId');
    try {
      if (!(await deleteGiveaway(client, giveawayId, guildId))) {
        return send(c, { error: 'Giveaway introuvable sur ce serveur' }, 404);
      }
      return send(c, { success: true });
    } catch (err) {
      logger.error('GiveawaysAPI', 'Error deleting giveaway:', err);
      return fail(c, err, 'Erreur lors de la suppression', 'GiveawaysAPI');
    }
  });

  // Passe tous les membres en revue : sans ça, activer l'auto-rôle ne produit
  // rien tant qu'un membre ne modifie pas son tag ou son statut.
  router.post(`${base}/announcement/autorole-rescan`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const { rescanGuildAutoRoles } = await import('../../../services/features/serverTagRoleService.js');
      const result = await rescanGuildAutoRoles(client, guildId);
      if (!result) {
        return send(c, { error: 'Aucun auto-rôle d\'identité actif sur ce serveur.' }, 400);
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Rescan des auto-rôles d\'identité',
        context: getGuildName(client, guildId),
        module: 'Announcement',
        eventType: 'Manuel',
        details: `${result.scanned} membre(s) analysé(s), ${result.changed} mise(s) à jour de rôle.`,
        channelId: null,
      });

      return send(c, { ok: true, ...result });
    } catch (err) {
      logger.error('WelcomeGoodbyeAPI', 'Error rescanning auto roles:', err);
      return fail(c, err, 'Erreur lors du rescan des auto-rôles', 'WelcomeGoodbyeAPI');
    }
  });

  router.get(`${base}/announcement`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const config = await getOrCreateWelcomeConfig(guildId);
      return send(c, { config });
    } catch (err) {
      logger.error('WelcomeGoodbyeAPI', 'Error fetching welcome config:', err);
      return fail(c, err, 'Erreur config accueil', 'WelcomeGoodbyeAPI');
    }
  });

  router.patch(`${base}/announcement`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        welcomeEnabled?: boolean;
        welcomeChannelId?: string | null;
        welcomeMessage?: string;
        welcomeImageEnabled?: boolean;
        welcomeImageUrl?: string | null;
        leaveEnabled?: boolean;
        leaveChannelId?: string | null;
        leaveMessage?: string;
        boostEnabled?: boolean;
        boostChannelId?: string | null;
        boostMessage?: string;
        boostImageEnabled?: boolean;
        boostImageUrl?: string | null;
        joinRoleId?: string | null;
        tagAutoRoleEnabled?: boolean;
        tagAutoRoleId?: string | null;
        statusScanEnabled?: boolean;
        statusScanKeyword?: string;
        statusScanRoleId?: string | null;
        statusScanScope?: string;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
      }

      const statusScanScope = ['STATUS', 'ACTIVITY', 'BOTH'].includes(body.statusScanScope ?? '')
        ? body.statusScanScope
        : undefined;

      const config = await prisma.welcomeConfig.update({
        where: { guildId },
        data: {
          welcomeEnabled: body.welcomeEnabled,
          welcomeChannelId: body.welcomeChannelId,
          welcomeMessage: body.welcomeMessage,
          welcomeImageEnabled: body.welcomeImageEnabled,
          welcomeImageUrl: body.welcomeImageUrl,
          leaveEnabled: body.leaveEnabled,
          leaveChannelId: body.leaveChannelId,
          leaveMessage: body.leaveMessage,
          boostEnabled: body.boostEnabled,
          boostChannelId: body.boostChannelId,
          boostMessage: body.boostMessage,
          boostImageEnabled: body.boostImageEnabled,
          boostImageUrl: body.boostImageUrl,
          joinRoleId: body.joinRoleId,
          tagAutoRoleEnabled: body.tagAutoRoleEnabled,
          tagAutoRoleId: body.tagAutoRoleId,
          statusScanEnabled: body.statusScanEnabled,
          statusScanKeyword: body.statusScanKeyword?.slice(0, 100),
          statusScanRoleId: body.statusScanRoleId,
          statusScanScope,
        },
      });

      // Les listeners d'auto-rôle lisent une config mise en cache 5 min : sans
      // invalidation, la sauvegarde resterait sans effet visible.
      const { invalidateAutoRoleCache } = await import('../../../services/features/serverTagRoleService.js');
      await invalidateAutoRoleCache(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour Annonces/Auto-Rôle',
        context: getGuildName(client, guildId),
        module: 'Announcement',
        eventType: 'Manuel',
        details: `Modifications appliquées. Accueil: ${config.welcomeEnabled}, Départ: ${config.leaveEnabled}, Boost: ${config.boostEnabled}, Tag Auto-Role: ${config.tagAutoRoleEnabled}`,
        channelId: null
      });

      return send(c, { config });
    } catch (err) {
      logger.error('WelcomeGoodbyeAPI', 'Error updating welcome config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la config', 'WelcomeGoodbyeAPI');
    }
  });

  router.get(`${base}/welcome-thread`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const config = await getOrCreateWelcomeThreadConfig(guildId);
      return send(c, { config });
    } catch (err) {
      logger.error('WelcomeThreadAPI', 'Error fetching welcome thread config:', err);
      return fail(c, err, "Erreur config thread d'accueil", 'WelcomeThreadAPI');
    }
  });

  router.patch(`${base}/welcome-thread`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        enabled?: boolean;
        channelId?: string | null;
        threadNameTemplate?: string;
        threadMode?: string;
        autoArchiveMinutes?: number;
        typingEnabled?: boolean;
        inactivityDeleteEnabled?: boolean;
        inactivityDeleteHours?: number;
        webhookName?: string;
        webhookAvatarUrl?: string | null;
        menuEnabled?: boolean;
        menuStyle?: string;
        menuPlaceholder?: string;
        embedTitle?: string;
        embedDescription?: string;
        embedColor?: string;
        embedImageUrl?: string | null;
        embedThumbnailUrl?: string | null;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
      }

      if (body.threadMode !== undefined && body.threadMode !== 'public' && body.threadMode !== 'private') {
        return send(c, { error: "threadMode doit être 'public' ou 'private'" }, 400);
      }
      if (body.menuStyle !== undefined && body.menuStyle !== 'buttons' && body.menuStyle !== 'select') {
        return send(c, { error: "menuStyle doit être 'buttons' ou 'select'" }, 400);
      }
      if (body.autoArchiveMinutes !== undefined && ![60, 1440, 4320, 10080].includes(body.autoArchiveMinutes)) {
        return send(c, { error: 'autoArchiveMinutes doit être 60, 1440, 4320 ou 10080' }, 400);
      }
      if (body.inactivityDeleteHours !== undefined && (
        !Number.isInteger(body.inactivityDeleteHours)
        || body.inactivityDeleteHours < MIN_INACTIVITY_DELETE_HOURS
        || body.inactivityDeleteHours > MAX_INACTIVITY_DELETE_HOURS
      )) {
        return send(c, { error: `inactivityDeleteHours doit être un entier entre ${MIN_INACTIVITY_DELETE_HOURS} et ${MAX_INACTIVITY_DELETE_HOURS}` }, 400);
      }

      await getOrCreateWelcomeThreadConfig(guildId);
      const config = await prisma.welcomeThreadConfig.update({
        where: { guildId },
        data: {
          enabled: body.enabled,
          channelId: body.channelId,
          threadNameTemplate: body.threadNameTemplate,
          threadMode: body.threadMode,
          autoArchiveMinutes: body.autoArchiveMinutes,
          typingEnabled: body.typingEnabled,
          inactivityDeleteEnabled: body.inactivityDeleteEnabled,
          inactivityDeleteHours: body.inactivityDeleteHours,
          webhookName: body.webhookName,
          webhookAvatarUrl: body.webhookAvatarUrl,
          menuEnabled: body.menuEnabled,
          menuStyle: body.menuStyle,
          menuPlaceholder: body.menuPlaceholder,
          embedTitle: body.embedTitle,
          embedDescription: body.embedDescription,
          embedColor: body.embedColor,
          embedImageUrl: body.embedImageUrl,
          embedThumbnailUrl: body.embedThumbnailUrl,
        },
        include: { steps: { orderBy: { order: 'asc' } }, pages: { orderBy: { order: 'asc' } } },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: "Mise à jour Thread d'accueil",
        context: getGuildName(client, guildId),
        module: 'WelcomeThread',
        eventType: 'Manuel',
        details: `Config mise à jour. Activé: ${config.enabled}, Salon: ${config.channelId ?? 'aucun'}, Menu: ${config.menuStyle}`,
        channelId: config.channelId,
      });

      return send(c, { config });
    } catch (err) {
      logger.error('WelcomeThreadAPI', 'Error updating welcome thread config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la config', 'WelcomeThreadAPI');
    }
  });

  router.put(`${base}/welcome-thread/steps`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        steps: Array<{ content: string; name?: string | null; avatarUrl?: string | null; delayMs?: number }>;
      }>(c);

      if (!body || !Array.isArray(body.steps)) {
        return send(c, { error: 'Corps de requête invalide (steps attendu)' }, 400);
      }
      if (body.steps.length > MAX_THREAD_STEPS) {
        return send(c, { error: `Maximum ${MAX_THREAD_STEPS} messages dans la séquence` }, 400);
      }
      if (body.steps.some((s) => !s.content?.trim())) {
        return send(c, { error: 'Chaque message doit avoir un contenu' }, 400);
      }

      await getOrCreateWelcomeThreadConfig(guildId);
      await prisma.$transaction([
        prisma.welcomeThreadStep.deleteMany({ where: { guildId } }),
        prisma.welcomeThreadStep.createMany({
          data: body.steps.map((step, index) => ({
            guildId,
            order: index,
            content: step.content.trim().slice(0, 2000),
            name: step.name?.trim() || null,
            avatarUrl: step.avatarUrl?.trim() || null,
            delayMs: clampStepDelay(step.delayMs ?? 3000),
          })),
        }),
      ]);

      const config = await getOrCreateWelcomeThreadConfig(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: "Mise à jour séquence Thread d'accueil",
        context: getGuildName(client, guildId),
        module: 'WelcomeThread',
        eventType: 'Manuel',
        details: `Séquence remplacée : ${config.steps.length} message(s)`,
        channelId: config.channelId,
      });

      return send(c, { config });
    } catch (err) {
      logger.error('WelcomeThreadAPI', 'Error updating welcome thread steps:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la séquence', 'WelcomeThreadAPI');
    }
  });

  router.put(`${base}/welcome-thread/pages`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        pages: Array<{
          label: string;
          emoji?: string | null;
          summary?: string | null;
          actionType?: string;
          roleId?: string | null;
          roleAction?: string;
          roleGroup?: string | null;
          linkUrl?: string | null;
          embedTitle?: string;
          embedDescription?: string;
          embedColor?: string;
          embedImageUrl?: string | null;
          embedThumbnailUrl?: string | null;
        }>;
      }>(c);

      if (!body || !Array.isArray(body.pages)) {
        return send(c, { error: 'Corps de requête invalide (pages attendu)' }, 400);
      }
      if (body.pages.length > 25) {
        return send(c, { error: 'Maximum 25 pages de présentation' }, 400);
      }

      const VALID_ACTION_TYPES = new Set(['EMBED', 'ROLE', 'LINK']);
      const VALID_ROLE_ACTIONS = new Set(['ADD', 'REMOVE', 'TOGGLE', 'EXCLUSIVE']);
      const exclusiveGroups = new Map<string, { label: string; roleIds: Set<string> }>();
      const exclusiveRoleGroups = new Map<string, string>();

      for (const page of body.pages) {
        if (!page.label?.trim()) {
          return send(c, { error: 'Chaque page doit avoir un label' }, 400);
        }
        const actionType = page.actionType && VALID_ACTION_TYPES.has(page.actionType) ? page.actionType : 'EMBED';
        if (actionType === 'EMBED' && (!page.embedTitle?.trim() || !page.embedDescription?.trim())) {
          return send(c, { error: 'Les pages de type Embed doivent avoir un titre et une description' }, 400);
        }
        if (actionType === 'ROLE' && !page.roleId) {
          return send(c, { error: 'Les pages de type Rôle doivent avoir un rôle sélectionné' }, 400);
        }
        if (actionType === 'ROLE' && page.roleAction === 'EXCLUSIVE') {
          const groupLabel = page.roleGroup?.trim().replace(/\s+/g, ' ') || '';
          if (!groupLabel) {
            return send(c, { error: 'Les rôles exclusifs doivent appartenir à un groupe' }, 400);
          }
          if (groupLabel.length > 64) {
            return send(c, { error: 'Le nom du groupe exclusif est limité à 64 caractères' }, 400);
          }

          const groupKey = groupLabel.toLocaleLowerCase('fr-FR');
          const existingRoleGroup = exclusiveRoleGroups.get(page.roleId!);
          if (existingRoleGroup && existingRoleGroup !== groupKey) {
            return send(c, { error: 'Un même rôle ne peut pas appartenir à plusieurs groupes exclusifs' }, 400);
          }
          exclusiveRoleGroups.set(page.roleId!, groupKey);

          const group = exclusiveGroups.get(groupKey) ?? { label: groupLabel, roleIds: new Set<string>() };
          group.roleIds.add(page.roleId!);
          exclusiveGroups.set(groupKey, group);
        }
        if (actionType === 'LINK' && !page.linkUrl?.trim()) {
          return send(c, { error: 'Les pages de type Lien doivent avoir un salon ou une URL' }, 400);
        }
      }

      for (const group of exclusiveGroups.values()) {
        if (group.roleIds.size < 2) {
          return send(c, { error: `Le groupe exclusif « ${group.label} » doit contenir au moins deux rôles différents` }, 400);
        }
      }

      await getOrCreateWelcomeThreadConfig(guildId);
      await prisma.$transaction([
        prisma.welcomeMenuPage.deleteMany({ where: { guildId } }),
        prisma.welcomeMenuPage.createMany({
          data: body.pages.map((page, index) => {
            const actionType = page.actionType && VALID_ACTION_TYPES.has(page.actionType) ? page.actionType : 'EMBED';
            const roleAction = page.roleAction && VALID_ROLE_ACTIONS.has(page.roleAction) ? page.roleAction : 'ADD';
            const roleGroupKey = page.roleGroup?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR') || '';
            return {
              guildId,
              order: index,
              label: page.label.trim().slice(0, 80),
              emoji: page.emoji?.trim() || null,
              summary: page.summary?.trim().slice(0, 100) || null,
              actionType,
              roleId: actionType === 'ROLE' ? page.roleId : null,
              roleAction,
              roleGroup: actionType === 'ROLE' && roleAction === 'EXCLUSIVE'
                ? (exclusiveGroups.get(roleGroupKey)?.label ?? null)
                : null,
              linkUrl: actionType === 'LINK' ? (page.linkUrl?.trim() || null) : null,
              embedTitle: page.embedTitle?.trim().slice(0, 256) || null,
              embedDescription: page.embedDescription?.trim().slice(0, 4096) || null,
              embedColor: page.embedColor?.trim() || '#5865F2',
              embedImageUrl: page.embedImageUrl?.trim() || null,
              embedThumbnailUrl: page.embedThumbnailUrl?.trim() || null,
            };
          }),
        }),
      ]);

      const config = await getOrCreateWelcomeThreadConfig(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: "Mise à jour pages Thread d'accueil",
        context: getGuildName(client, guildId),
        module: 'WelcomeThread',
        eventType: 'Manuel',
        details: `Pages remplacées : ${config.pages.length} page(s)`,
        channelId: config.channelId,
      });

      return send(c, { config });
    } catch (err) {
      logger.error('WelcomeThreadAPI', 'Error updating welcome menu pages:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des pages', 'WelcomeThreadAPI');
    }
  });

  router.get(`${base}/reaction-roles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const menus = await prisma.reactionRoleMenu.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });
      // Le dashboard en déduit les rôles que le bot ne pourra pas donner,
      // avant qu'un membre ne clique dessus.
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const botRoleAccess = discordGuild ? await getBotRoleAccess(discordGuild) : null;
      // Membres par rôle et message encore en place : le staff voit ce qui
      // sert, et un menu dont le message a été supprimé sur Discord.
      const roleIds = menus.flatMap((menu) => (Array.isArray(menu.options) ? menu.options as ReactionRoleOption[] : []).map((option) => option.roleId));
      const memberCounts = discordGuild ? roleMemberCounts(discordGuild, roleIds) : {};
      const messageStatuses = discordGuild
        ? Object.fromEntries(await Promise.all(menus.map(async (menu) => [menu.id, await menuMessageStatus(discordGuild, menu)] as const)))
        : {};
      return send(c, { menus, botRoleAccess, memberCounts, messageStatuses });
    } catch (err) {
      logger.error('ReactionRolesAPI', 'Error fetching menus:', err);
      return fail(c, err, 'Erreur lors de la récupération des menus', 'ReactionRolesAPI');
    }
  });

  router.post(`${base}/reaction-roles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        title: string;
        channelId: string;
        buttonMode?: string;
        description?: string | null;
        showCounts?: boolean;
        embedColor?: string | null;
        options: ReactionRoleOptionInput[];
      }>(c);

      if (!body || !body.title || !body.channelId || !Array.isArray(body.options) || body.options.length === 0) {
        return send(c, { error: 'Champs obligatoires manquants ou vides' }, 400);
      }

      if (body.options.length > MAX_REACTION_ROLE_BUTTONS) {
        return send(c, { error: `Un panneau ne peut pas dépasser ${MAX_REACTION_ROLE_BUTTONS} boutons` }, 400);
      }

      // Le bot donnera ces rôles : ils ne doivent pas dépasser ceux de qui configure.
      const grantRefusal = await roleGrantRefusal(client, guildId, user.userId, body.options.map((option) => option.roleId));
      if (grantRefusal) return send(c, { error: grantRefusal }, 403);

      const options = await withNewRolesCreated(client, guildId, body.options, auditUser);
      if ('refused' in options) return send(c, { error: options.refused.error }, options.refused.status);

      const menu = await createReactionRoleMenu(client, guildId, {
        channelId: body.channelId,
        title: body.title,
        options,
        buttonMode: normalizeMenuMode(body.buttonMode),
        description: normalizeMenuDescription(body.description),
        showCounts: body.showCounts === true,
        embedColor: normalizeEmbedColor(body.embedColor),
      });

      return send(c, { menu });
    } catch (err) {
      logger.error('ReactionRolesAPI', 'Error creating menu:', err);
      return fail(c, err, 'Erreur lors de la création du menu de rôles', 'ReactionRolesAPI');
    }
  });

  // Remplit le formulaire avec les rôles du modèle, sans rien créer : ceux qui
  // manquent ne le seront qu'à la publication du menu.
  router.get(`${base}/reaction-roles/presets/:key`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const key = c.req.param('key') as ReactionRolePresetKey;
    if (!REACTION_ROLE_PRESET_KEYS.includes(key)) {
      return send(c, { error: 'Modèle de menu inconnu' }, 404);
    }

    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) {
      return send(c, { error: 'Serveur Discord introuvable.' }, 404);
    }

    // Noms dans la langue du serveur : les rôles sont lus par ses membres.
    const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
    return send(c, { preset: previewReactionRolePreset(discordGuild, key, locale) });
  });

  // Republie le message d'un menu supprimé sur Discord, à l'identique.
  router.post(`${base}/reaction-roles/:menuId/republish`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const menuId = c.req.param('menuId');
    try {
      // Un changement vide remet seulement le message en place.
      const menu = await updateReactionRoleMenu(client, guildId, menuId, {});
      if (!menu) {
        return send(c, { error: 'Menu de rôles introuvable' }, 404);
      }
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const messageStatus = discordGuild ? await menuMessageStatus(discordGuild, menu) : 'unknown';
      return send(c, { menu, messageStatus });
    } catch (err) {
      logger.error('ReactionRolesAPI', 'Error republishing menu:', err);
      return fail(c, err, 'Erreur lors de la republication du menu', 'ReactionRolesAPI');
    }
  });

  router.patch(`${base}/reaction-roles/:menuId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    const menuId = c.req.param('menuId');
    try {
      const body = await readBody<{
        title?: string;
        channelId?: string;
        buttonMode?: string;
        description?: string | null;
        showCounts?: boolean;
        embedColor?: string | null;
        options?: ReactionRoleOptionInput[];
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de requête invalide' }, 400);
      }

      if ((body.title !== undefined && !body.title)
        || (body.channelId !== undefined && !body.channelId)
        || (body.options !== undefined && (!Array.isArray(body.options) || body.options.length === 0))) {
        return send(c, { error: 'Champs obligatoires manquants ou vides' }, 400);
      }

      if (body.options !== undefined && body.options.length > MAX_REACTION_ROLE_BUTTONS) {
        return send(c, { error: `Un panneau ne peut pas dépasser ${MAX_REACTION_ROLE_BUTTONS} boutons` }, 400);
      }

      if (body.options !== undefined) {
        const grantRefusal = await roleGrantRefusal(client, guildId, user.userId, body.options.map((option) => option.roleId));
        if (grantRefusal) return send(c, { error: grantRefusal }, 403);
      }

      const options = body.options === undefined
        ? undefined
        : await withNewRolesCreated(client, guildId, body.options, auditUser);
      if (options && 'refused' in options) return send(c, { error: options.refused.error }, options.refused.status);

      const menu = await updateReactionRoleMenu(client, guildId, menuId, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.channelId !== undefined ? { channelId: body.channelId } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(body.buttonMode !== undefined ? { buttonMode: normalizeMenuMode(body.buttonMode) } : {}),
        ...(body.description !== undefined ? { description: normalizeMenuDescription(body.description) } : {}),
        ...(typeof body.showCounts === 'boolean' ? { showCounts: body.showCounts } : {}),
        ...(body.embedColor !== undefined ? { embedColor: normalizeEmbedColor(body.embedColor) } : {}),
      });

      if (!menu) {
        return send(c, { error: 'Menu de rôles introuvable' }, 404);
      }

      return send(c, { menu });
    } catch (err) {
      logger.error('ReactionRolesAPI', 'Error updating menu:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du menu de rôles', 'ReactionRolesAPI');
    }
  });

  router.delete(`${base}/reaction-roles/:menuId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const menuId = c.req.param('menuId');
    try {
      const deleted = await deleteReactionRoleMenu(client, guildId, menuId);
      if (!deleted) {
        return send(c, { error: 'Menu de rôles introuvable' }, 404);
      }
      return send(c, { success: true });
    } catch (err) {
      logger.error('ReactionRolesAPI', 'Error deleting menu:', err);
      return fail(c, err, 'Erreur de suppression du menu', 'ReactionRolesAPI');
    }
  });

  router.get(`${base}/triggers`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const list = await prisma.autoResponse.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });
      return send(c, { list });
    } catch (err) {
      logger.error('AutoResponsesAPI', 'Error fetching triggers:', err);
      return fail(c, err, 'Erreur lors de la récupération des triggers', 'AutoResponsesAPI');
    }
  });

  router.post(`${base}/triggers`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{
        trigger: string;
        response: string | null;
        matchType?: string;
        enabled?: boolean;
        roleIdToAdd?: string | null;
        roleIdToRemove?: string | null;
        deleteTrigger?: boolean;
        closeTicket?: boolean;
        rejectForm?: boolean;
        allowedRoleIds?: string[];
        bannedRoleIds?: string[];
        allowedChannelIds?: string[];
        bannedChannelIds?: string[];
        triggerType?: string;
        formId?: string | null;
        formQuestionLabel?: string | null;
        ticketTypeId?: string | null;
        ticketQuestionLabel?: string | null;
        reactions?: string[];
        actions?: any;
        responseDestination?: string;
        responseChannelId?: string | null;
        relayToStaffServer?: boolean;
      }>(c);

      if (!body || !body.trigger) {
        return send(c, { error: 'Déclencheur requis' }, 400);
      }

      if (body.matchType === 'REGEX') {
        const problem = regexProblem(body.trigger);
        if (problem) {
          return send(c, { error: problem }, 400);
        }
      }

      if (!body.response && !body.roleIdToAdd && !body.roleIdToRemove && !body.deleteTrigger && !body.closeTicket && !body.rejectForm && (!body.reactions || body.reactions.length === 0) && !body.actions) {
        return send(c, { error: 'Au moins une action doit être configurée (réponse, ajout/retrait de rôle, suppression du message, fermeture de ticket, rejet de formulaire, réaction ou action avancée)' }, 400);
      }

      const triggerGrantRefusal = await roleGrantRefusal(client, guildId, c.var.dashboardUser.userId, [body.roleIdToAdd]);
      if (triggerGrantRefusal) return send(c, { error: triggerGrantRefusal }, 403);

      const autoResponse = await prisma.autoResponse.create({
        data: {
          guildId,
          trigger: body.trigger,
          response: body.response,
          matchType: body.matchType || 'CONTAINS',
          enabled: body.enabled ?? true,
          roleIdToAdd: body.roleIdToAdd || null,
          roleIdToRemove: body.roleIdToRemove || null,
          deleteTrigger: body.deleteTrigger ?? false,
          closeTicket: body.closeTicket ?? false,
          rejectForm: body.rejectForm ?? false,
          allowedRoleIds: body.allowedRoleIds ?? [],
          bannedRoleIds: body.bannedRoleIds ?? [],
          allowedChannelIds: body.allowedChannelIds ?? [],
          bannedChannelIds: body.bannedChannelIds ?? [],
          triggerType: body.triggerType || 'MESSAGE',
          formId: body.formId || null,
          formQuestionLabel: body.formQuestionLabel || null,
          ticketTypeId: body.ticketTypeId || null,
          ticketQuestionLabel: body.ticketQuestionLabel || null,
          reactions: body.reactions ?? [],
          actions: body.actions ?? null,
          responseDestination: body.responseDestination || 'DM',
          responseChannelId: body.responseChannelId || null,
          relayToStaffServer: body.relayToStaffServer ?? false,
        },
      });

      await invalidateAutoResponseCacheAcrossShards(client, guildId);
      return send(c, { autoResponse });
    } catch (err) {
      logger.error('AutoResponsesAPI', 'Error creating trigger:', err);
      return fail(c, err, 'Erreur lors de la création du déclencheur', 'AutoResponsesAPI');
    }
  });

  router.patch(`${base}/triggers/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    try {
      const body = await readBody<{
        trigger?: string;
        response?: string | null;
        matchType?: string;
        enabled?: boolean;
        roleIdToAdd?: string | null;
        roleIdToRemove?: string | null;
        deleteTrigger?: boolean;
        closeTicket?: boolean;
        rejectForm?: boolean;
        allowedRoleIds?: string[];
        bannedRoleIds?: string[];
        allowedChannelIds?: string[];
        bannedChannelIds?: string[];
        triggerType?: string;
        formId?: string | null;
        formQuestionLabel?: string | null;
        ticketTypeId?: string | null;
        ticketQuestionLabel?: string | null;
        reactions?: string[];
        actions?: any;
        responseDestination?: string;
        responseChannelId?: string | null;
        relayToStaffServer?: boolean;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
      }

      // Filtré par serveur : un déclencheur d'un autre serveur, rôle à donner compris, se
      // modifiait sinon en connaissant son identifiant.
      const existing = await prisma.autoResponse.findFirst({
        where: { id, guildId },
      });

      if (!existing) {
        return send(c, { error: 'Déclencheur introuvable' }, 404);
      }

      const effectiveMatchType = body.matchType !== undefined ? body.matchType : existing.matchType;
      if (effectiveMatchType === 'REGEX' && (body.trigger !== undefined || body.matchType !== undefined)) {
        const problem = regexProblem(body.trigger !== undefined ? body.trigger : existing.trigger);
        if (problem) {
          return send(c, { error: problem }, 400);
        }
      }

      const combinedTrigger = body.trigger !== undefined ? body.trigger : existing.trigger;
      const combinedResponse = body.response !== undefined ? body.response : existing.response;
      const combinedRoleIdToAdd = body.roleIdToAdd !== undefined ? body.roleIdToAdd : existing.roleIdToAdd;
      const combinedRoleIdToRemove = body.roleIdToRemove !== undefined ? body.roleIdToRemove : existing.roleIdToRemove;
      const combinedDeleteTrigger = body.deleteTrigger !== undefined ? body.deleteTrigger : existing.deleteTrigger;
      const combinedCloseTicket = body.closeTicket !== undefined ? body.closeTicket : (existing as { closeTicket?: boolean }).closeTicket;
      const combinedRejectForm = body.rejectForm !== undefined ? body.rejectForm : (existing as { rejectForm?: boolean }).rejectForm;
      const combinedReactions = body.reactions !== undefined ? body.reactions : existing.reactions;
      const combinedActions = body.actions !== undefined ? body.actions : existing.actions;

      if (!combinedTrigger) {
        return send(c, { error: 'Déclencheur requis' }, 400);
      }

      if (!combinedResponse && !combinedRoleIdToAdd && !combinedRoleIdToRemove && !combinedDeleteTrigger && !combinedCloseTicket && !combinedRejectForm && (!combinedReactions || combinedReactions.length === 0) && !combinedActions) {
        return send(c, { error: 'Au moins une action doit être configurée (réponse, ajout/retrait de rôle, suppression du message, fermeture de ticket, rejet de formulaire, réaction ou action avancée)' }, 400);
      }

      if (body.roleIdToAdd) {
        const triggerGrantRefusal = await roleGrantRefusal(client, guildId, c.var.dashboardUser.userId, [body.roleIdToAdd]);
        if (triggerGrantRefusal) return send(c, { error: triggerGrantRefusal }, 403);
      }

      const autoResponse = await prisma.autoResponse.update({
        where: { id },
        data: {
          trigger: body.trigger,
          response: body.response,
          matchType: body.matchType,
          enabled: body.enabled,
          roleIdToAdd: body.roleIdToAdd,
          roleIdToRemove: body.roleIdToRemove,
          deleteTrigger: body.deleteTrigger,
          closeTicket: body.closeTicket,
          rejectForm: body.rejectForm,
          allowedRoleIds: body.allowedRoleIds,
          bannedRoleIds: body.bannedRoleIds,
          allowedChannelIds: body.allowedChannelIds,
          bannedChannelIds: body.bannedChannelIds,
          triggerType: body.triggerType,
          formId: body.formId,
          formQuestionLabel: body.formQuestionLabel,
          ticketTypeId: body.ticketTypeId,
          ticketQuestionLabel: body.ticketQuestionLabel,
          reactions: body.reactions,
          actions: body.actions,
          responseDestination: body.responseDestination,
          responseChannelId: body.responseChannelId,
          relayToStaffServer: body.relayToStaffServer,
        },
      });

      await invalidateAutoResponseCacheAcrossShards(client, guildId);
      return send(c, { autoResponse });
    } catch (err) {
      logger.error('AutoResponsesAPI', 'Error updating trigger:', err);
      return fail(c, err, 'Erreur lors de la modification', 'AutoResponsesAPI');
    }
  });

  router.delete(`${base}/triggers/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    try {
      const removed = await prisma.autoResponse.deleteMany({
        where: { id, guildId },
      });
      if (removed.count === 0) {
        return send(c, { error: 'Déclencheur introuvable' }, 404);
      }
      await invalidateAutoResponseCacheAcrossShards(client, guildId);
      return send(c, { success: true });
    } catch (err) {
      logger.error('AutoResponsesAPI', 'Error deleting trigger:', err);
      return fail(c, err, 'Erreur lors de la suppression', 'AutoResponsesAPI');
    }
  });

  router.get(`${base}/triggers/emojis`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        return send(c, { emojis: [] });
      }
      const emojis = await guild.emojis.fetch();
      return send(c, {
        emojis: emojis.map((e) => ({ id: e.id, name: e.name, animated: e.animated, url: e.url })),
      });
    } catch (err) {
      logger.error('AutoResponsesAPI', 'Error fetching guild emojis:', err);
      return fail(c, err, 'Erreur lors de la récupération des emojis du serveur', 'AutoResponsesAPI');
    }
  });

  router.get(`${base}/automod`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const config = await getOrCreateAutoModConfig(guildId);
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const isOwner = guild ? guild.ownerId === user.userId : false;
      return send(c, { config, isOwner });
    } catch (err) {
      logger.error('AutoModAPI', 'Error fetching config:', err);
      return fail(c, err, 'Erreur de récupération config AutoMod', 'AutoModAPI');
    }
  });

  router.patch(`${base}/automod`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        discordAutoModEnabled?: boolean;
        spamEnabled?: boolean;
        spamLimit?: number;
        spamIntervalSeconds?: number;
        spamAction?: string;
        spamGroupSlowmodeEnabled?: boolean;
        spamGroupSlowmodeSeconds?: number;
        spamGroupSlowmodeMinutes?: number;
        preventiveSlowmodeEnabled?: boolean;
        preventiveSlowmodeMsgThreshold?: number;
        preventiveSlowmodeMinUsers?: number;
        preventiveSlowmodeWindowSec?: number;
        preventiveSlowmodeSeconds?: number;
        preventiveSlowmodeMinutes?: number;
        linksEnabled?: boolean;
        linksAction?: string;
        linksWhitelist?: string[];
        capsEnabled?: boolean;
        capsThresholdPercent?: number;
        capsMinLength?: number;
        emojisEnabled?: boolean;
        emojisLimit?: number;
        mentionsEnabled?: boolean;
        mentionsLimit?: number;
        ghostPingEnabled?: boolean;
        ghostPingAction?: string;
        antiEveryoneEnabled?: boolean;
        antiEveryoneAction?: string;
        customWordsEnabled?: boolean;
        customWordsAction?: string;
        customWords?: string[];
        customWordsAllowList?: string[];
        customWordsTimeoutSec?: number;
        profanityEnabled?: boolean;
        profanityPresetProfanity?: boolean;
        profanityPresetSexual?: boolean;
        profanityPresetSlurs?: boolean;
        profanityAction?: string;
        profanityAllowList?: string[];
        profanityTimeoutSec?: number;
        inviteFilterEnabled?: boolean;
        inviteFilterAction?: string;
        inviteFilterAllowedGuilds?: string[];
        inviteFilterTimeoutSec?: number;
        antiBotEnabled?: boolean;
        antiBotAction?: string;
        antiBotBypassUsers?: string[];
        antiBotRoleIds?: string[];
        bypassRoles?: string[];
        bypassChannels?: string[];
        adminLockEnabled?: boolean;
        adminLockAction?: string;
        adminLockSecurityRoleIds?: string[];
        adminLockNotifyChannelId?: string | null;
        burstSuspendEnabled?: boolean;
        burstSuspendFastLimit?: number;
        burstSuspendFastWindowSec?: number;
        burstSuspendSlowLimit?: number;
        burstSuspendSlowWindowSec?: number;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
      }

      // Seul le propriétaire du serveur peut modifier les paramètres anti-bot et admin-lock
      const antiBotFieldsProvided = body.antiBotEnabled !== undefined || body.antiBotAction !== undefined || body.antiBotBypassUsers !== undefined;
      const adminLockFieldsProvided =
        body.adminLockEnabled !== undefined ||
        body.adminLockAction !== undefined ||
        body.adminLockSecurityRoleIds !== undefined ||
        body.adminLockNotifyChannelId !== undefined ||
        body.burstSuspendEnabled !== undefined ||
        body.burstSuspendFastLimit !== undefined ||
        body.burstSuspendFastWindowSec !== undefined ||
        body.burstSuspendSlowLimit !== undefined ||
        body.burstSuspendSlowWindowSec !== undefined;

      if (antiBotFieldsProvided) {
        const existingConfig = await prisma.autoModConfig.findUnique({
          where: { guildId },
          select: { antiBotEnabled: true, antiBotAction: true, antiBotBypassUsers: true },
        });
        const antiBotChanged =
          (body.antiBotEnabled !== undefined && body.antiBotEnabled !== (existingConfig?.antiBotEnabled ?? false)) ||
          (body.antiBotAction !== undefined && body.antiBotAction !== (existingConfig?.antiBotAction ?? 'KICK')) ||
          (body.antiBotBypassUsers !== undefined &&
            JSON.stringify([...body.antiBotBypassUsers].sort()) !== JSON.stringify([...(existingConfig?.antiBotBypassUsers ?? [])].sort()));

        if (antiBotChanged) {
          const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (!guild || guild.ownerId !== user.userId) {
            return send(c, { error: 'Seul le propriétaire du serveur peut modifier les paramètres du mode sécurisé (Anti-Bot).' }, 403);
          }
        }
      }

      if (adminLockFieldsProvided) {
        // La page Filtres renvoie toute la config : on ne bloque que si une valeur change vraiment.
        const existing = await prisma.autoModConfig.findUnique({
          where: { guildId },
          select: {
            adminLockEnabled: true, adminLockAction: true, adminLockSecurityRoleIds: true, adminLockNotifyChannelId: true,
            burstSuspendEnabled: true, burstSuspendFastLimit: true, burstSuspendFastWindowSec: true,
            burstSuspendSlowLimit: true, burstSuspendSlowWindowSec: true,
          },
        });
        const current = {
          adminLockEnabled: existing?.adminLockEnabled ?? false,
          adminLockAction: existing?.adminLockAction ?? 'BLOCK',
          adminLockNotifyChannelId: existing?.adminLockNotifyChannelId ?? null,
          burstSuspendEnabled: existing?.burstSuspendEnabled ?? false,
          burstSuspendFastLimit: existing?.burstSuspendFastLimit ?? 5,
          burstSuspendFastWindowSec: existing?.burstSuspendFastWindowSec ?? 1,
          burstSuspendSlowLimit: existing?.burstSuspendSlowLimit ?? 10,
          burstSuspendSlowWindowSec: existing?.burstSuspendSlowWindowSec ?? 60,
        };
        const adminLockChanged =
          (Object.keys(current) as (keyof typeof current)[]).some(
            (k) => body[k] !== undefined && (body[k] ?? null) !== current[k],
          ) ||
          (body.adminLockSecurityRoleIds !== undefined &&
            JSON.stringify([...body.adminLockSecurityRoleIds].sort()) !== JSON.stringify([...(existing?.adminLockSecurityRoleIds ?? [])].sort()));
        if (adminLockChanged) {
          const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (!guild || guild.ownerId !== user.userId) {
            return send(c, { error: "Seul le propriétaire du serveur peut modifier les paramètres d'Admin Permission Lock." }, 403);
          }
        }
      }

      const clampInt = (v: unknown, min: number, max: number) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;

      const configData = {
        discordAutoModEnabled: true,
        spamEnabled: body.spamEnabled,
        spamLimit: body.spamLimit,
        spamIntervalSeconds: body.spamIntervalSeconds,
        spamAction: body.spamAction,
        spamGroupSlowmodeEnabled: typeof body.spamGroupSlowmodeEnabled === 'boolean' ? body.spamGroupSlowmodeEnabled : undefined,
        // Plafond Discord du mode lent : 6 h.
        spamGroupSlowmodeSeconds: clampInt(body.spamGroupSlowmodeSeconds, 1, 21_600),
        spamGroupSlowmodeMinutes: clampInt(body.spamGroupSlowmodeMinutes, 1, 1_440),
        preventiveSlowmodeEnabled: typeof body.preventiveSlowmodeEnabled === 'boolean' ? body.preventiveSlowmodeEnabled : undefined,
        preventiveSlowmodeMsgThreshold: clampInt(body.preventiveSlowmodeMsgThreshold, 3, 200),
        preventiveSlowmodeMinUsers: clampInt(body.preventiveSlowmodeMinUsers, 2, 50),
        preventiveSlowmodeWindowSec: clampInt(body.preventiveSlowmodeWindowSec, 2, 120),
        preventiveSlowmodeSeconds: clampInt(body.preventiveSlowmodeSeconds, 1, 21_600),
        preventiveSlowmodeMinutes: clampInt(body.preventiveSlowmodeMinutes, 1, 1_440),
        linksEnabled: body.linksEnabled,
        linksAction: body.linksAction,
        linksWhitelist: body.linksWhitelist,
        capsEnabled: body.capsEnabled,
        capsThresholdPercent: body.capsThresholdPercent,
        capsMinLength: body.capsMinLength,
        emojisEnabled: body.emojisEnabled,
        emojisLimit: body.emojisLimit,
        mentionsEnabled: body.mentionsEnabled,
        mentionsLimit: body.mentionsLimit,
        ghostPingEnabled: body.ghostPingEnabled,
        ghostPingAction: body.ghostPingAction,
        antiEveryoneEnabled: body.antiEveryoneEnabled,
        antiEveryoneAction: body.antiEveryoneAction,
        customWordsEnabled: body.customWordsEnabled,
        customWordsAction: body.customWordsAction,
        customWords: body.customWords,
        customWordsAllowList: body.customWordsAllowList,
        customWordsTimeoutSec: body.customWordsTimeoutSec,
        profanityEnabled: body.profanityEnabled,
        profanityPresetProfanity: body.profanityPresetProfanity,
        profanityPresetSexual: body.profanityPresetSexual,
        profanityPresetSlurs: body.profanityPresetSlurs,
        profanityAction: body.profanityAction,
        profanityAllowList: body.profanityAllowList,
        profanityTimeoutSec: body.profanityTimeoutSec,
        inviteFilterEnabled: body.inviteFilterEnabled,
        inviteFilterAction: body.inviteFilterAction,
        inviteFilterAllowedGuilds: body.inviteFilterAllowedGuilds,
        inviteFilterTimeoutSec: body.inviteFilterTimeoutSec,
        antiBotEnabled: body.antiBotEnabled,
        antiBotAction: body.antiBotAction,
        antiBotBypassUsers: body.antiBotBypassUsers,
        antiBotRoleIds: body.antiBotRoleIds,
        bypassRoles: body.bypassRoles,
        bypassChannels: body.bypassChannels,
        adminLockEnabled: body.adminLockEnabled,
        adminLockAction: body.adminLockAction,
        adminLockSecurityRoleIds: body.adminLockSecurityRoleIds,
        adminLockNotifyChannelId: body.adminLockNotifyChannelId,
        burstSuspendEnabled: body.burstSuspendEnabled,
        burstSuspendFastLimit: body.burstSuspendFastLimit,
        burstSuspendFastWindowSec: body.burstSuspendFastWindowSec,
        burstSuspendSlowLimit: body.burstSuspendSlowLimit,
        burstSuspendSlowWindowSec: body.burstSuspendSlowWindowSec,
      };

      const config = await prisma.autoModConfig.upsert({
        where: { guildId },
        update: configData,
        create: {
          guildId,
          ...configData,
          spamEnabled: body.spamEnabled ?? false,
          spamLimit: body.spamLimit ?? 5,
          spamIntervalSeconds: body.spamIntervalSeconds ?? 5,
          spamAction: body.spamAction ?? 'TIMEOUT',
          linksEnabled: body.linksEnabled ?? false,
          linksAction: body.linksAction ?? 'DELETE_AND_WARN',
          linksWhitelist: body.linksWhitelist ?? [],
          capsEnabled: body.capsEnabled ?? false,
          capsThresholdPercent: body.capsThresholdPercent ?? 80,
          capsMinLength: body.capsMinLength ?? 10,
          emojisEnabled: body.emojisEnabled ?? false,
          emojisLimit: body.emojisLimit ?? 10,
          mentionsEnabled: body.mentionsEnabled ?? false,
          mentionsLimit: body.mentionsLimit ?? 5,
          ghostPingEnabled: body.ghostPingEnabled ?? false,
          ghostPingAction: body.ghostPingAction ?? 'ALERT',
          antiEveryoneEnabled: body.antiEveryoneEnabled ?? false,
          antiEveryoneAction: body.antiEveryoneAction ?? 'DELETE_AND_WARN',
          customWordsEnabled: body.customWordsEnabled ?? false,
          customWordsAction: body.customWordsAction ?? 'BLOCK',
          customWords: body.customWords ?? [],
          customWordsAllowList: body.customWordsAllowList ?? [],
          customWordsTimeoutSec: body.customWordsTimeoutSec ?? 60,
          profanityEnabled: body.profanityEnabled ?? false,
          profanityPresetProfanity: body.profanityPresetProfanity ?? true,
          profanityPresetSexual: body.profanityPresetSexual ?? true,
          profanityPresetSlurs: body.profanityPresetSlurs ?? true,
          profanityAction: body.profanityAction ?? 'BLOCK',
          profanityAllowList: body.profanityAllowList ?? [],
          profanityTimeoutSec: body.profanityTimeoutSec ?? 60,
          inviteFilterEnabled: body.inviteFilterEnabled ?? false,
          inviteFilterAction: body.inviteFilterAction ?? 'BLOCK',
          inviteFilterAllowedGuilds: body.inviteFilterAllowedGuilds ?? [],
          inviteFilterTimeoutSec: body.inviteFilterTimeoutSec ?? 60,
          antiBotEnabled: body.antiBotEnabled ?? false,
          antiBotAction: body.antiBotAction ?? 'KICK',
          antiBotBypassUsers: body.antiBotBypassUsers ?? [],
          antiBotRoleIds: body.antiBotRoleIds ?? [],
          bypassRoles: body.bypassRoles ?? [],
          bypassChannels: body.bypassChannels ?? [],
          adminLockEnabled: body.adminLockEnabled ?? false,
          adminLockAction: body.adminLockAction ?? 'BLOCK',
          adminLockSecurityRoleIds: body.adminLockSecurityRoleIds ?? [],
          adminLockNotifyChannelId: body.adminLockNotifyChannelId ?? null,
          burstSuspendEnabled: body.burstSuspendEnabled ?? false,
          burstSuspendFastLimit: body.burstSuspendFastLimit ?? 5,
          burstSuspendFastWindowSec: body.burstSuspendFastWindowSec ?? 1,
          burstSuspendSlowLimit: body.burstSuspendSlowLimit ?? 10,
          burstSuspendSlowWindowSec: body.burstSuspendSlowWindowSec ?? 60,
        },
      });

      invalidateAutoModCache(guildId);

      // Synchroniser les règles natives Discord AutoMod
      let syncWarning: string | null = null;
      try {
        await syncDiscordAutoModRules(client, guildId, config);
      } catch (syncErr) {
        logger.error('AutoModAPI', `Erreur lors de la synchronisation Discord AutoMod pour ${guildId}:`, syncErr);
        syncWarning = 'Configuration sauvegardée mais la synchronisation des règles Discord AutoMod a échoué. Vérifiez que le bot a la permission « Gérer le serveur ».';
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour AutoMod',
        context: getGuildName(client, guildId),
        module: 'AutoMod',
        eventType: 'Manuel',
        details: `Verrous de sécurité mis à jour. Anti-spam: ${config.spamEnabled}, Anti-liens: ${config.linksEnabled}, Synchro native: ${config.discordAutoModEnabled}`,
        channelId: null
      });

      return send(c, { config, ...(syncWarning ? { syncWarning } : {}) });
    } catch (err) {
      logger.error('AutoModAPI', 'Error updating config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour AutoMod', 'AutoModAPI');
    }
  });

  router.post(`${base}/embed-builder`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        channelId: string;
        messageId?: string | null;
        content?: string | null;
        embed?: {
          title?: string;
          description?: string;
          color?: string;
          thumbnailUrl?: string | null;
          imageUrl?: string | null;
          url?: string | null;
          authorName?: string | null;
          authorIconUrl?: string | null;
          authorUrl?: string | null;
          footerText?: string | null;
          footerIconUrl?: string | null;
          timestamp?: boolean | string | null;
          fields?: Array<{ name: string; value: string; inline?: boolean }>;
        };
      }>(c);

      if (!body || !body.channelId || (!body.embed && !body.content)) {
        return send(c, { error: "Salon et données d'envoi requis (content ou embed)" }, 400);
      }

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }

      const channel = discordGuild.channels.cache.get(body.channelId);
      if (!channel?.isTextBased()) {
        return send(c, { error: 'Salon introuvable ou invalide' }, 404);
      }

      // Résoudre les shortcodes emoji (:ktb_xxx: → <:ktb_xxx:ID>)
      if (body.content) body.content = resolveEmojiShortcodes(body.content);
      if (body.embed) {
        if (body.embed.title) body.embed.title = resolveEmojiShortcodes(body.embed.title);
        if (body.embed.description) body.embed.description = resolveEmojiShortcodes(body.embed.description);
        if (body.embed.authorName) body.embed.authorName = resolveEmojiShortcodes(body.embed.authorName);
        if (body.embed.footerText) body.embed.footerText = resolveEmojiShortcodes(body.embed.footerText);
        if (body.embed.fields) {
          for (const f of body.embed.fields) {
            f.name = resolveEmojiShortcodes(f.name);
            f.value = resolveEmojiShortcodes(f.value);
          }
        }
      }

      // Construire l'embed Discord si fourni
      const embed = new EmbedBuilder();
      let hasEmbedData = false;

      if (body.embed) {
        if (body.embed.title) { embed.setTitle(body.embed.title); hasEmbedData = true; }
        if (body.embed.description) { embed.setDescription(body.embed.description); hasEmbedData = true; }
        if (body.embed.color) { embed.setColor(body.embed.color as ColorResolvable); hasEmbedData = true; }
        if (body.embed.thumbnailUrl) { embed.setThumbnail(body.embed.thumbnailUrl); hasEmbedData = true; }
        if (body.embed.imageUrl) { embed.setImage(body.embed.imageUrl); hasEmbedData = true; }
        if (body.embed.url) { embed.setURL(body.embed.url); hasEmbedData = true; }
        if (body.embed.timestamp) {
          embed.setTimestamp(body.embed.timestamp === true ? new Date() : new Date(body.embed.timestamp));
          hasEmbedData = true;
        }

        if (body.embed.authorName) {
          embed.setAuthor({
            name: body.embed.authorName,
            iconURL: body.embed.authorIconUrl || undefined,
            url: body.embed.authorUrl || undefined
          });
          hasEmbedData = true;
        }

        if (body.embed.footerText) {
          embed.setFooter({
            text: body.embed.footerText,
            iconURL: body.embed.footerIconUrl || undefined
          });
          hasEmbedData = true;
        }

        if (body.embed.fields && body.embed.fields.length > 0) {
          embed.addFields(body.embed.fields.map(f => ({
            name: f.name || '-',
            value: f.value || '-',
            inline: !!f.inline
          })));
          hasEmbedData = true;
        }
      }

      if (!body.content && !hasEmbedData) {
        return send(c, { error: "Vous devez fournir du texte de message ou au moins un champ d'embed." }, 400);
      }

      // Hors du cache des membres, `permissionsFor(id)` rend null : on récupère l'auteur.
      const author = await discordGuild.members.fetch(user.userId).catch(() => null);
      const messageOptions = {
        content: body.content || undefined,
        embeds: hasEmbedData ? [embed] : undefined,
        // Comme /say : le bot écrit à la place de l'auteur, il ne notifie donc
        // @everyone et les rôles que si l'auteur en a lui-même le droit ici.
        allowedMentions: author && channel.permissionsFor(author).has(PermissionFlagsBits.MentionEveryone)
          ? undefined
          : { parse: ['users' as const] },
      };

      let messageSent;
      if (body.messageId) {
        // Tenter de modifier un message existant
        const msg = await channel.messages.fetch(body.messageId).catch(() => null);
        if (msg) {
          messageSent = await msg.edit(messageOptions).catch(() => null);
        }
      }

      if (!messageSent) {
        // Envoyer un nouveau message
        messageSent = await channel.send(messageOptions).catch(() => null);
      }

      if (!messageSent) {
        return send(c, { error: "Le bot n'a pas pu envoyer ou modifier le message (vérifiez ses permissions)." }, 500);
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: body.messageId ? 'Mise à jour embed' : 'Envoi embed personnalisé',
        context: getGuildName(client, guildId),
        module: 'EmbedBuilder',
        eventType: 'Manuel',
        details: `Embed envoyé dans le salon <#${body.channelId}> (Message: ${messageSent.id}).`,
        channelId: body.channelId
      });

      return send(c, { ok: true, messageId: messageSent.id });
    } catch (err) {
      logger.error('EmbedBuilderAPI', 'Error building/sending embed:', err);
      return fail(c, err, "Erreur lors du traitement de l'embed", 'EmbedBuilderAPI');
    }
  });

  router.get(`${base}/fun`, ...funGate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          funEnabled: true,
          funCountingChannelId: true,
          funOneWordStoryChannelId: true,
          funGuessNumberChannelId: true,
          funWordChainChannelId: true,
          funEmojiRiddleChannelId: true,
          funNeverSayChannelId: true,
          funEmojiOnlyChannelId: true,
          funImageOfDayChannelId: true,
          funConfessionChannelId: true,
          funConfessionLogChannelId: true,
          funConfessionCooldownSeconds: true,
          funPunitiveMode: true,
          funEmojiRiddleUseDefaults: true,
        }
      });

      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }

      const { getOrCreateFunGameState } = await import('../../../services/features/funService.js');
      const gameState = await getOrCreateFunGameState(guildId);

      return send(c, {
        config: guild,
        gameState: {
          countingCurrent: gameState.countingCurrent,
          countingLastUserId: gameState.countingLastUserId,
          oneWordStoryLastUserId: gameState.oneWordStoryLastUserId,
          guessNumberTarget: gameState.guessNumberTarget,
          wordChainLastWord: gameState.wordChainLastWord,
          wordChainLastUserId: gameState.wordChainLastUserId,
          emojiRiddleEmojis: gameState.emojiRiddleEmojis,
        }
      });
    } catch (err) {
      logger.error('FunAPI', 'Error fetching fun config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration fun', 'FunAPI');
    }
  });

  router.patch(`${base}/fun`, ...funGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const body = await readBody<{
        funCountingChannelId?: string | null;
        funOneWordStoryChannelId?: string | null;
        funGuessNumberChannelId?: string | null;
        funWordChainChannelId?: string | null;
        funEmojiRiddleChannelId?: string | null;
        funNeverSayChannelId?: string | null;
        funEmojiOnlyChannelId?: string | null;
        funImageOfDayChannelId?: string | null;
        funConfessionChannelId?: string | null;
        funConfessionLogChannelId?: string | null;
        funConfessionCooldownSeconds?: number;
        funPunitiveMode?: boolean;
        funEmojiRiddleUseDefaults?: boolean;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de requête manquant' }, 400);
      }

      const confessionCooldown = body.funConfessionCooldownSeconds === undefined
        ? undefined
        : normalizeConfessionCooldown(body.funConfessionCooldownSeconds);
      if (confessionCooldown === null) {
        return send(c, { error: 'Le délai entre deux confessions doit être un nombre de secondes' }, 400);
      }

      const previousFun = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { funEmojiRiddleChannelId: true },
      });

      const updatedGuild = await prisma.guild.update({
        where: { id: guildId },
        data: {
          // funEnabled n'est pas ecrit ici : c'est l'interrupteur générique de
          // la page Modules (setDashboardModuleStatus) qui en est propriétaire.
          // L'écrire depuis ce formulaire avec la valeur chargée au montage
          // écrasait le module qu'on venait d'activer avec cet interrupteur,
          // sans jamais passer par lui - le bot lisait donc `funEnabled: false`
          // alors que la page affichait le module comme actif.
          funCountingChannelId: body.funCountingChannelId,
          funOneWordStoryChannelId: body.funOneWordStoryChannelId,
          funGuessNumberChannelId: body.funGuessNumberChannelId,
          funWordChainChannelId: body.funWordChainChannelId,
          funEmojiRiddleChannelId: body.funEmojiRiddleChannelId,
          funNeverSayChannelId: body.funNeverSayChannelId,
          funEmojiOnlyChannelId: body.funEmojiOnlyChannelId,
          funImageOfDayChannelId: body.funImageOfDayChannelId,
          funConfessionChannelId: body.funConfessionChannelId,
          funConfessionLogChannelId: body.funConfessionLogChannelId,
          funConfessionCooldownSeconds: confessionCooldown,
          funPunitiveMode: body.funPunitiveMode,
          funEmojiRiddleUseDefaults: typeof body.funEmojiRiddleUseDefaults === 'boolean'
            ? body.funEmojiRiddleUseDefaults
            : undefined,
        },
      });

      // Initialize targets/riddles the first time their channel is set.
      const { getOrCreateFunGameState, resetEmojiRiddle, announceEmojiRiddle } = await import('../../../services/features/funService.js');
      const gameState = await getOrCreateFunGameState(guildId);
      if (body.funGuessNumberChannelId && gameState.guessNumberTarget === 0) {
        const newTarget = Math.floor(Math.random() * 1000) + 1;
        await prisma.funGameState.update({
          where: { guildId },
          data: { guessNumberTarget: newTarget }
        });
      }
      const riddleChannelId = updatedGuild.funEmojiRiddleChannelId;
      if (riddleChannelId) {
        let clue = gameState.emojiRiddleEmojis;
        if (!clue) clue = (await resetEmojiRiddle(guildId)).emojiRiddleEmojis;
        if (clue && (clue !== gameState.emojiRiddleEmojis || riddleChannelId !== previousFun?.funEmojiRiddleChannelId)) {
          await announceEmojiRiddle(client, riddleChannelId, clue);
        }
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour Salons Fun',
        context: getGuildName(client, guildId),
        module: 'Fun',
        eventType: 'Manuel',
        details: `Configuration des salons fun modifiée. Actif: ${updatedGuild.funEnabled}`,
        channelId: null
      });

      const latestState = await prisma.funGameState.findUnique({ where: { guildId } });

      return send(c, {
        config: {
          funEnabled: updatedGuild.funEnabled,
          funCountingChannelId: updatedGuild.funCountingChannelId,
          funOneWordStoryChannelId: updatedGuild.funOneWordStoryChannelId,
          funGuessNumberChannelId: updatedGuild.funGuessNumberChannelId,
          funWordChainChannelId: updatedGuild.funWordChainChannelId,
          funEmojiRiddleChannelId: updatedGuild.funEmojiRiddleChannelId,
          funNeverSayChannelId: updatedGuild.funNeverSayChannelId,
          funEmojiOnlyChannelId: updatedGuild.funEmojiOnlyChannelId,
          funImageOfDayChannelId: updatedGuild.funImageOfDayChannelId,
          funConfessionChannelId: updatedGuild.funConfessionChannelId,
          funConfessionLogChannelId: updatedGuild.funConfessionLogChannelId,
          funConfessionCooldownSeconds: updatedGuild.funConfessionCooldownSeconds,
          funPunitiveMode: updatedGuild.funPunitiveMode,
          funEmojiRiddleUseDefaults: updatedGuild.funEmojiRiddleUseDefaults,
        },
        gameState: {
          countingCurrent: latestState?.countingCurrent ?? 0,
          countingLastUserId: latestState?.countingLastUserId ?? null,
          oneWordStoryLastUserId: latestState?.oneWordStoryLastUserId ?? null,
          guessNumberTarget: latestState?.guessNumberTarget ?? 0,
          wordChainLastWord: latestState?.wordChainLastWord ?? null,
          wordChainLastUserId: latestState?.wordChainLastUserId ?? null,
          emojiRiddleEmojis: latestState?.emojiRiddleEmojis ?? null,
        }
      });
    } catch (err) {
      logger.error('FunAPI', 'Error updating fun config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration fun', 'FunAPI');
    }
  });

  // L'auteur n'est jamais renvoyé : seule la commande /confession reveler le montre.
  router.get(`${base}/fun/confessions`, ...funGate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const confessions = await prisma.confession.findMany({
        where: { guildId },
        orderBy: { number: 'desc' },
        take: 50,
        select: { number: true, content: true, createdAt: true, revealedAt: true, deletedAt: true },
      });
      return send(c, { confessions });
    } catch (err) {
      logger.error('FunAPI', 'Error fetching confessions:', err);
      return fail(c, err, 'Erreur lors de la récupération des confessions', 'FunAPI');
    }
  });

  router.post(`${base}/fun/counting/reset`, ...funGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const { resetCounting } = await import('../../../services/features/funService.js');
      const state = await resetCounting(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Réinitialisation Comptage',
        context: getGuildName(client, guildId),
        module: 'Fun',
        eventType: 'Manuel',
        details: `Le comptage a été réinitialisé à 0 depuis le dashboard.`,
        channelId: null
      });

      return send(c, {
        success: true,
        gameState: {
          countingCurrent: state.countingCurrent,
          countingLastUserId: state.countingLastUserId,
          oneWordStoryLastUserId: state.oneWordStoryLastUserId,
          guessNumberTarget: state.guessNumberTarget,
          wordChainLastWord: state.wordChainLastWord,
          wordChainLastUserId: state.wordChainLastUserId,
          emojiRiddleEmojis: state.emojiRiddleEmojis,
        }
      });
    } catch (err) {
      logger.error('FunAPI', 'Error resetting counting:', err);
      return fail(c, err, 'Erreur lors de la réinitialisation du comptage', 'FunAPI');
    }
  });

  router.post(`${base}/fun/guess-number/reset`, ...funGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const { resetGuessNumber } = await import('../../../services/features/funService.js');
      const state = await resetGuessNumber(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Réinitialisation Nombre Mystère',
        context: getGuildName(client, guildId),
        module: 'Fun',
        eventType: 'Manuel',
        details: `Un nouveau nombre mystère a été généré depuis le dashboard.`,
        channelId: null
      });

      return send(c, {
        success: true,
        gameState: {
          countingCurrent: state.countingCurrent,
          countingLastUserId: state.countingLastUserId,
          oneWordStoryLastUserId: state.oneWordStoryLastUserId,
          guessNumberTarget: state.guessNumberTarget,
          wordChainLastWord: state.wordChainLastWord,
          wordChainLastUserId: state.wordChainLastUserId,
          emojiRiddleEmojis: state.emojiRiddleEmojis,
        }
      });
    } catch (err) {
      logger.error('FunAPI', 'Error resetting guess target:', err);
      return fail(c, err, 'Erreur lors du changement du nombre mystère', 'FunAPI');
    }
  });

  router.post(`${base}/fun/word-chain/reset`, ...funGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const { resetWordChain } = await import('../../../services/features/funService.js');
      const state = await resetWordChain(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Réinitialisation Chaîne de mots',
        context: getGuildName(client, guildId),
        module: 'Fun',
        eventType: 'Manuel',
        details: `La chaîne de mots a été réinitialisée depuis le dashboard.`,
        channelId: null
      });

      return send(c, {
        success: true,
        gameState: {
          countingCurrent: state.countingCurrent,
          countingLastUserId: state.countingLastUserId,
          oneWordStoryLastUserId: state.oneWordStoryLastUserId,
          guessNumberTarget: state.guessNumberTarget,
          wordChainLastWord: state.wordChainLastWord,
          wordChainLastUserId: state.wordChainLastUserId,
          emojiRiddleEmojis: state.emojiRiddleEmojis,
        }
      });
    } catch (err) {
      logger.error('FunAPI', 'Error resetting word chain:', err);
      return fail(c, err, 'Erreur lors de la réinitialisation de la chaîne de mots', 'FunAPI');
    }
  });

  router.post(`${base}/fun/emoji-riddle/reset`, ...funGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = `${user.username ?? 'Utilisateur'} (${user.userId})`;
    try {
      const { resetEmojiRiddle, announceEmojiRiddle } = await import('../../../services/features/funService.js');
      const state = await resetEmojiRiddle(guildId);
      const funGuild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { funEmojiRiddleChannelId: true },
      });
      if (funGuild?.funEmojiRiddleChannelId && state.emojiRiddleEmojis) {
        await announceEmojiRiddle(client, funGuild.funEmojiRiddleChannelId, state.emojiRiddleEmojis);
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Nouveau Rébus Emoji',
        context: getGuildName(client, guildId),
        module: 'Fun',
        eventType: 'Manuel',
        details: `Un nouveau rébus emoji a été généré depuis le dashboard.`,
        channelId: null
      });

      return send(c, {
        success: true,
        gameState: {
          countingCurrent: state.countingCurrent,
          countingLastUserId: state.countingLastUserId,
          oneWordStoryLastUserId: state.oneWordStoryLastUserId,
          guessNumberTarget: state.guessNumberTarget,
          wordChainLastWord: state.wordChainLastWord,
          wordChainLastUserId: state.wordChainLastUserId,
          emojiRiddleEmojis: state.emojiRiddleEmojis,
        }
      });
    } catch (err) {
      logger.error('FunAPI', 'Error resetting emoji riddle:', err);
      return fail(c, err, 'Erreur lors de la génération du rébus emoji', 'FunAPI');
    }
  });

  return router;
}

