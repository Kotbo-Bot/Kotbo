/**
 * Pages publiques RPG de clan et classement des clans (avec paris, dettes et
 * recherche d'un participant).
 */
import { Hono, type Context } from 'hono';
import type { Client, Guild } from 'discord.js';
import { buildBettorStandings, buildSeasonLaureates, firmDebtOf } from '@kotbo/shared';
import { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { cache } from '../../../../utils/cache.js';
import { publicClansRateLimiter, publicClanSearchRateLimiter } from '../../../limiters.js';
import { getRaidRecap, RAID_RECAP_PUBLIC_WINDOW_MS } from '../../../../services/features/rpg/rpgRaidService.js';
import { getEngagedBetCredit, getEngagedBetCreditTotal } from '../../../../services/community/clanBetService.js';
import { buildLinkedAccountFolder } from '../../../../services/moderation/altAccountService.js';
import { questWindowBounds, questWindowKey } from '../../../../services/features/rpg/rpgQuestPolicy.js';
import { resolveMemberAvatarUrl } from '../../../../services/moderation/memberIdentityService.js';
import { fail, send, underLimit } from './kit.js';

const reply = (c: Context, status: number, data: unknown) => send(c, data, status);

/** Gains attribués au clan entier, sans contributeur individuel. */
const CLAN_WIDE_USER_ID = 'system_manual_points';
/** Tête de classement envoyée au chargement de la page publique des clans. */
const PUBLIC_CLANS_TOP_LIMIT = 25;
const PUBLIC_CLANS_CACHE_TTL_S = 30;
/** Bornes de la recherche publique, pour qu'une requête très large reste bon marché. */
const SEARCH_MATCH_LIMIT = 200;
/** Paris renvoyes par une recherche : au-dela, il faut affiner. */
const SEARCH_BET_LIMIT = 50;
const SEARCH_PARTICIPANT_LIMIT = 40;
const SEARCH_POINTLESS_LIMIT = 10;

/**
 * Quêtes d'équipe adossées aux clans, et l'avancement de chacun sur la fenêtre en cours.
 *
 * Une seule lecture pour toutes les quêtes : leurs fenêtres diffèrent, mais la clé de
 * chacune se calcule sans la base, et un `in` vaut mieux qu'une requête par quête.
 */
async function loadPublicQuests(guildId: string) {
  const quests = await prisma.rpgQuest.findMany({
    where: { guildId, enabled: true, scope: 'TEAM', teamMode: 'CLAN' },
    orderBy: { name: 'asc' },
  });

  const questWindows = new Map(quests.map((quest) => [quest.id, questWindowKey(quest.windowHours)]));
  const questProgress = quests.length > 0
    ? await prisma.rpgQuestTeamProgress.findMany({
      where: {
        questId: { in: quests.map((quest) => quest.id) },
        windowKey: { in: [...new Set(questWindows.values())] },
      },
      select: { questId: true, teamKey: true, windowKey: true, current: true, completedAt: true },
    })
    : [];

  return { quests, questWindows, questProgress };
}

/** Combien de joueurs le classement solo montre. */
const PUBLIC_RPG_SOLO_LIMIT = 20;

/**
 * Vue solo : classement des joueurs et quêtes personnelles en cours.
 *
 * Elle existe pour elle-même et pas seulement en repli des clans : un serveur qui n'a pas
 * de clans a quand même un RPG, et une page qui n'afficherait alors qu'un boss de raid
 * n'aurait pas grand-chose à montrer.
 */
async function loadPublicSolo(guildId: string, discordGuild: Guild | null) {
  const [profiles, quests] = await Promise.all([
    prisma.rpgProfile.findMany({
      where: { guildId },
      orderBy: [{ level: 'desc' }, { xp: 'desc' }],
      take: PUBLIC_RPG_SOLO_LIMIT,
      select: {
        userId: true,
        level: true,
        xp: true,
        totalMonstersKilled: true,
        totalBossesKilled: true,
      },
    }),
    prisma.rpgQuest.findMany({
      where: { guildId, enabled: true, scope: 'MEMBER' },
      orderBy: { name: 'asc' },
    }),
  ]);

  const userIds = profiles.map((profile) => profile.userId);
  const [dbProfiles, tower] = await Promise.all([
    profiles.length > 0 ? prisma.memberProfile.findMany({ where: { guildId, userId: { in: userIds } } }) : [],
    prisma.rpgTowerConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
  ]);
  const profileMap = new Map(dbProfiles.map((profile) => [profile.userId, profile]));
  // Tour active : son meilleur étage de tous les temps s'ajoute à la ligne de chaque joueur.
  const towerEnabled = tower?.enabled === true;
  const towerFloors = towerEnabled && profiles.length > 0
    ? new Map((await prisma.rpgTowerProfile.findMany({
      where: { guildId, userId: { in: userIds } },
      select: { userId: true, bestFloorAllTime: true },
    })).map((entry) => [entry.userId, entry.bestFloorAllTime]))
    : null;

  // Le rang suit les ex aequo : deux joueurs au même niveau et à la même expérience
  // partagent leur place, comme dans le classement des clans.
  let rank = 0;
  let previous: string | null = null;

  const leaderboard = profiles.map((profile, index) => {
    const identity = profileMap.get(profile.userId);
    const member = discordGuild?.members.cache.get(profile.userId);
    const key = `${profile.level}:${profile.xp}`;
    if (key !== previous) rank = index + 1;
    previous = key;

    return {
      userId: profile.userId,
      rank,
      displayName: member?.displayName || identity?.displayName || identity?.globalName || `Aventurier ${profile.userId.slice(-4)}`,
      avatarUrl: resolveMemberAvatarUrl(member, 128) || identity?.avatarUrl || null,
      level: profile.level,
      xp: profile.xp,
      monstersKilled: profile.totalMonstersKilled,
      bossesKilled: profile.totalBossesKilled,
      // `null` quand la Tour est éteinte : la page n'affiche alors rien à son sujet.
      towerFloor: towerFloors ? towerFloors.get(profile.userId) ?? 0 : null,
    };
  });

  return {
    towerEnabled,
    leaderboard,
    quests: quests.map((quest) => ({
      id: quest.id,
      name: quest.name,
      description: quest.description,
      objective: quest.objective,
      target: quest.target,
      windowHours: quest.windowHours,
      windowEndsAt: questWindowBounds(quest.windowHours).endsAt,
    })),
  };
}

/** Raid ouvert, raid planifié, et l'état de chaque équipe engagée sur celui qui court. */
async function loadPublicRaid(guildId: string, discordGuild: Guild | null) {
  const [openRaid, scheduledRaid, recap] = await Promise.all([
    prisma.rpgRaid.findFirst({ where: { guildId, status: 'OPEN' }, orderBy: { opensAt: 'desc' } }),
    prisma.rpgRaid.findFirst({ where: { guildId, status: 'SCHEDULED' }, orderBy: { opensAt: 'asc' } }),
    // Le bilan du dernier raid tient une journée : c'est une nouvelle, et l'onglet qui le
    // porte disparaît avec lui plutôt que de rester à afficher la semaine d'avant.
    getRaidRecap(guildId, RAID_RECAP_PUBLIC_WINDOW_MS),
  ]);

  const raidTeams = openRaid
    ? await prisma.rpgRaidTeam.findMany({
      where: { raidId: openRaid.id },
      select: { teamKey: true, remainingHealth: true, totalHealth: true, defeatedAt: true },
    })
    : [];

  const raidRecap = recap && {
    bossName: recap.raid.bossName,
    bossEmoji: recap.raid.bossEmoji,
    bossLevel: recap.raid.bossLevel,
    resolvedAt: recap.raid.resolvedAt,
    teams: recap.teams.map((team) => ({
      teamName: team.teamName,
      totalHealth: team.totalHealth,
      remainingHealth: team.remainingHealth,
      defeated: team.defeatedAt !== null,
    })),
    strikers: recap.strikers.map((striker) => {
      const member = discordGuild?.members.cache.get(striker.userId);
      return {
        userId: striker.userId,
        damage: striker.damage,
        assaults: striker.assaults,
        // Même repli que le classement des aventuriers : un membre parti garde une
        // identité distincte, là où un libellé unique les confondrait tous.
        displayName: member?.displayName || `Aventurier ${striker.userId.slice(-4)}`,
        avatarUrl: resolveMemberAvatarUrl(member, 128) || null,
      };
    }),
  };

  return { openRaid, scheduledRaid, raidTeams, raidRecap };
}

export function createPublicRpgClansRouter(client: Client): Hono {
  const router = new Hono();

  // GET /api/public/guilds/:guildId/rpg
  //
  // Vue publique du RPG de clan : où en est chaque clan sur le boss de raid et sur les
  // quêtes d'équipe. Seules les quêtes adossées aux clans du serveur y figurent, celles
  // des guildes RPG ne concernant pas les clans dont la page parle.
  router.get('/api/public/guilds/:guildId/rpg', async (c) => {
    const guildId = c.req.param('guildId');
    if (!/^\d{17,19}$/.test(guildId)) {
      return reply(c, 400, { error: 'ID de guilde invalide' });

    }

    if (!underLimit(c, publicClansRateLimiter, 60, 60_000)) {
      return reply(c, 429, { error: 'Trop de requêtes. Veuillez réessayer plus tard.' });

    }

    // Cache court : la page affiche des barres qui bougent en pleine fenêtre de raid, et
    // une trentaine de secondes de retard s'y voit moins qu'une lecture par visiteur.
    const cacheKey = `guild:${guildId}:public-rpg`;
    const cachedPayload = await cache.get<unknown>(cacheKey);
    if (cachedPayload) {
      c.header('Cache-Control', `public, max-age=${PUBLIC_CLANS_CACHE_TTL_S}`);
      return reply(c, 200, cachedPayload);

    }

    try {
      const [guildConfig, economy] = await Promise.all([
        prisma.guild.findUnique({ where: { id: guildId }, select: { clansEnabled: true } }),
        prisma.economyConfig.findUnique({
          where: { guildId },
          select: { enabled: true, raidEnabled: true },
        }),
      ]);

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const header = {
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
      };

      if (!economy?.enabled) {
        return reply(c, 200, { ...header, enabled: false, clansEnabled: false, clans: [], quests: [], raid: null, solo: null });

      }

      const clansEnabled = guildConfig?.clansEnabled === true;
      const clans = clansEnabled
        ? await prisma.clan.findMany({ where: { guildId }, orderBy: { name: 'asc' } })
        : [];

      // Les deux blocs sont lus séparément et sans bloquer : le dashboard et le bot ne
      // partent pas ensemble, et une migration pas encore appliquée d'un côté ne doit pas
      // emporter toute la page - un raid reste affichable sans les quêtes, et l'inverse.
      const { quests, questWindows, questProgress } = clansEnabled
        ? await loadPublicQuests(guildId).catch((error: unknown) => {
          logger.warn('PublicAPI', `Quêtes de clan indisponibles pour ${guildId}: ${String(error)}`);
          return { quests: [], questWindows: new Map<string, string>(), questProgress: [] };
        })
        : { quests: [], questWindows: new Map<string, string>(), questProgress: [] };

      const solo = await loadPublicSolo(guildId, discordGuild).catch((error: unknown) => {
        logger.warn('PublicAPI', `Vue solo indisponible pour ${guildId}: ${String(error)}`);
        return { leaderboard: [], quests: [] };
      });

      const { openRaid, scheduledRaid, raidTeams, raidRecap } = economy.raidEnabled
        ? await loadPublicRaid(guildId, discordGuild).catch((error: unknown) => {
          logger.warn('PublicAPI', `Raid indisponible pour ${guildId}: ${String(error)}`);
          return { openRaid: null, scheduledRaid: null, raidTeams: [], raidRecap: null };
        })
        : { openRaid: null, scheduledRaid: null, raidTeams: [], raidRecap: null };

      const payload = {
        ...header,
        enabled: true,
        clansEnabled,
        solo,
        raid: openRaid
          ? {
            status: 'OPEN' as const,
            // Un raid livré en guildes RPG n'oppose pas les clans : la page doit pouvoir
            // s'abstenir d'afficher une barre de vie qu'aucun clan ne peut entamer.
            teamMode: openRaid.teamMode,
            bossName: openRaid.bossName,
            bossLevel: openRaid.bossLevel,
            opensAt: openRaid.opensAt,
            closesAt: openRaid.closesAt,
          }
          : scheduledRaid
            ? {
              status: 'SCHEDULED' as const,
              teamMode: scheduledRaid.teamMode,
              bossName: scheduledRaid.bossName,
              bossLevel: scheduledRaid.bossLevel,
              opensAt: scheduledRaid.opensAt,
              closesAt: scheduledRaid.closesAt,
            }
            : null,
        raidRecap,
        quests: quests.map((quest) => ({
          id: quest.id,
          name: quest.name,
          description: quest.description,
          objective: quest.objective,
          target: quest.target,
          windowHours: quest.windowHours,
          // La fin de fenêtre est la même pour tous : c'est elle qui porte le compte à
          // rebours de remise à zéro affiché en tête de chaque quête.
          windowEndsAt: questWindowBounds(quest.windowHours).endsAt,
        })),
        clans: clans.map((clan) => {
          const role = discordGuild?.roles.cache.get(clan.roleId);
          const raidTeam = raidTeams.find((team) => team.teamKey === clan.id) ?? null;

          return {
            id: clan.id,
            name: clan.name,
            roleColor: role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : null,
            memberCount: role?.members.size ?? 0,
            raid: raidTeam
              ? {
                remaining: Math.max(0, raidTeam.remainingHealth),
                total: raidTeam.totalHealth,
                defeated: raidTeam.defeatedAt !== null,
              }
              : null,
            quests: quests.map((quest) => {
              const progress = questProgress.find(
                (row) => row.questId === quest.id
                  && row.teamKey === clan.id
                  && row.windowKey === questWindows.get(quest.id),
              );
              return {
                questId: quest.id,
                current: progress?.current ?? 0,
                target: quest.target,
                completed: progress?.completedAt !== null && progress?.completedAt !== undefined,
              };
            }),
          };
        }),
      };

      await cache.set(cacheKey, payload, PUBLIC_CLANS_CACHE_TTL_S);
      c.header('Cache-Control', `public, max-age=${PUBLIC_CLANS_CACHE_TTL_S}`);
      return reply(c, 200, payload);
    } catch (error) {
      logger.error('PublicAPI', `RPG de clan indisponible pour ${guildId}:`, error);
      return fail(c, error, 'Erreur lors de la récupération du RPG de clan.', 'PublicAPI');
    }

  });

  // GET /api/public/guilds/:guildId/clans/search?q=...
  //
  // Recherche dédiée : le chargement de la page ne contient que la tête de
  // chaque classement et les 20 derniers gains. Ici on retrouve n'importe quel
  // participant, aussi bas soit-il, avec son rang réel et son historique de la
  // saison. Le rang ne demande pas de dérouler le classement : il se déduit du
  // nombre de contributions du même clan ayant plus de points.
  router.get('/api/public/guilds/:guildId/clans/search', async (c) => {
    const guildId = c.req.param('guildId');
    if (!/^\d{17,19}$/.test(guildId)) {
      return reply(c, 400, { error: 'ID de guilde invalide' });

    }

    if (!underLimit(c, publicClanSearchRateLimiter, 30, 60_000)) {
      return reply(c, 429, { error: 'Trop de recherches. Veuillez réessayer dans une minute.' });

    }

    const query = (c.req.query('q') || '').trim();
    const empty = { participants: [], scores: [], matchCounts: {}, bets: [], bettors: [], debts: [] };
    if (query.length < 2) {
      return reply(c, 200, empty);

    }

    try {
      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { clansEnabled: true, currentClanSeason: true, betsEnabled: true, betAllowDebt: true },
      });
      if (!guildConfig?.clansEnabled) {
        return reply(c, 200, empty);

      }

      const season = guildConfig.currentClanSeason;
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const normalized = query.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      const matches = (value: string | null | undefined) =>
        !!value && value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(normalized);

      const userIds = new Set<string>();
      if (/^\d{17,19}$/.test(query)) userIds.add(query);

      // Les pseudos affichés viennent surtout du cache Discord ; la table des
      // profils sert de repli pour les membres absents du cache.
      if (discordGuild) {
        for (const member of discordGuild.members.cache.values()) {
          if (userIds.size >= SEARCH_MATCH_LIMIT) break;
          if (matches(member.displayName) || matches(member.user?.username)) userIds.add(member.id);
        }
      }
      if (userIds.size < SEARCH_MATCH_LIMIT) {
        const profileMatches = await prisma.memberProfile.findMany({
          where: {
            guildId,
            OR: [
              { displayName: { contains: query, mode: Prisma.QueryMode.insensitive } },
              { globalName: { contains: query, mode: Prisma.QueryMode.insensitive } },
            ],
          },
          take: SEARCH_MATCH_LIMIT,
        });
        for (const p of profileMatches) userIds.add(p.userId);
      }

      const clans = await prisma.clan.findMany({ where: { guildId } });
      const clanById = new Map(clans.map((c) => [c.id, c]));
      const matchingClanIds = clans.filter((c) => matches(c.name)).map((c) => c.id);

      // Sans personne ni clan trouvé, il reste une piste quand les paris sont
      // ouverts : le sujet d'un pari, qui n'est ni un pseudo ni un nom de clan.
      if (userIds.size === 0 && matchingClanIds.length === 0 && !guildConfig.betsEnabled) {
        return reply(c, 200, empty);

      }

      const matchedUserIds = [...userIds].slice(0, SEARCH_MATCH_LIMIT);
      const clanColor = (clan: { roleId: string } | undefined) => {
        const role = clan ? discordGuild?.roles.cache.get(clan.roleId) : null;
        return role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : null;
      };

      // ─── Participants trouvés, avec leur rang ────────────────────────────────
      let participants: Array<Record<string, unknown>> = [];
      let matchCountByClanId = new Map<string, number>();

      if (matchedUserIds.length > 0) {
        const [rows, counts] = await Promise.all([
          prisma.clanMemberContribution.findMany({
            where: { guildId, season, userId: { in: matchedUserIds } },
            orderBy: { xp: 'desc' },
            take: SEARCH_PARTICIPANT_LIMIT,
          }),
          prisma.clanMemberContribution.groupBy({
            by: ['clanId'],
            where: { guildId, season, userId: { in: matchedUserIds } },
            _count: { _all: true },
          }),
        ]);

        matchCountByClanId = new Map(counts.map((c) => [c.clanId, c._count._all]));

        const ranked = await Promise.all(
          rows.map(async (row) => {
            // Le pseudo-membre des points de clan n'occupe pas de place au
            // classement : il ne doit pas décaler le rang affiché.
            const ahead = await prisma.clanMemberContribution.count({
              where: {
                guildId,
                season,
                clanId: row.clanId,
                xp: { gt: row.xp },
                userId: { not: CLAN_WIDE_USER_ID },
              },
            });
            return { row, rank: ahead + 1 };
          })
        );

        const rowProfiles = await prisma.memberProfile.findMany({
          where: { guildId, userId: { in: rows.map((r) => r.userId) } },
        });
        const rowProfileMap = new Map(rowProfiles.map((p) => [p.userId, p]));

        participants = ranked.map(({ row, rank }) => {
          const clan = clanById.get(row.clanId);
          const profile = rowProfileMap.get(row.userId);
          const discordMember = discordGuild?.members.cache.get(row.userId);

          return {
            userId: row.userId,
            clanId: row.clanId,
            clanName: clan?.name ?? null,
            clanColor: clanColor(clan),
            rank,
            xp: row.xp,
            displayName: discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${row.userId}`,
            avatarUrl: resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null,
          };
        });

        // Membre trouvé, dans un clan, mais sans le moindre point : il n'a pas de
        // rang. L'omettre laisserait croire que la recherche n'a rien donné.
        const scoredUserIds = new Set(rows.map((r) => r.userId));
        const pointless = matchedUserIds.filter((id) => !scoredUserIds.has(id) && id !== CLAN_WIDE_USER_ID);
        for (const userId of pointless.slice(0, SEARCH_POINTLESS_LIMIT)) {
          const discordMember = discordGuild?.members.cache.get(userId);
          const clan = discordMember ? clans.find((c) => discordMember.roles.cache.has(c.roleId)) : undefined;
          if (!clan) continue; // Sans clan, il n'a rien à faire dans un classement de clans.

          participants.push({
            userId,
            clanId: clan.id,
            clanName: clan.name,
            clanColor: clanColor(clan),
            rank: null,
            xp: 0,
            displayName: discordMember?.displayName || `Utilisateur ${userId}`,
            avatarUrl: resolveMemberAvatarUrl(discordMember, 128) ?? null,
          });
        }
      }

      // ─── Historique des gains des personnes trouvées ─────────────────────────
      const orConditions: Prisma.ClanContributionEventWhereInput[] = [];
      if (matchedUserIds.length > 0) orConditions.push({ userId: { in: matchedUserIds } });
      if (matchingClanIds.length > 0) {
        orConditions.push({ clanId: { in: matchingClanIds }, userId: CLAN_WIDE_USER_ID });
      }

      const events = await prisma.clanContributionEvent.findMany({
        where: { guildId, season, OR: orConditions },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      const eventProfiles = await prisma.memberProfile.findMany({
        where: { guildId, userId: { in: [...new Set(events.map((e) => e.userId))] } },
      });
      const profileMap = new Map(eventProfiles.map((p) => [p.userId, p]));

      const scores = events.map((e) => {
        const clan = clanById.get(e.clanId);
        const isClanGlobal = e.userId === CLAN_WIDE_USER_ID;

        let displayName: string;
        let avatarUrl: string | null = null;
        if (isClanGlobal) {
          displayName = clan?.name || 'Clan';
        } else {
          const profile = profileMap.get(e.userId);
          const discordMember = discordGuild?.members.cache.get(e.userId);
          displayName = discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${e.userId}`;
          avatarUrl = resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null;
        }

        return {
          id: e.id,
          amount: e.amount,
          credit: e.credit ?? 0,
          source: e.source,
          isClan: isClanGlobal,
          userId: isClanGlobal ? null : e.userId,
          displayName,
          avatarUrl,
          clanName: clan?.name || null,
          clanColor: clanColor(clan),
          createdAt: e.createdAt.toISOString(),
        };
      });

      // ─── Paris, palmarès et dettes des personnes trouvées ────────────────────
      //
      // Mêmes bornes que le reste de la recherche : la page ne reçoit au
      // chargement que les têtes de listes, c'est ici qu'on retrouve un pari
      // d'il y a trois semaines ou un endetté hors du top.
      let bets: Array<Record<string, unknown>> = [];
      let bettors: Array<Record<string, unknown>> = [];
      let debts: Array<Record<string, unknown>> = [];

      if (guildConfig.betsEnabled) {
        try {
          const betConditions: Prisma.ClanBetWhereInput[] = [
            { subject: { contains: query, mode: Prisma.QueryMode.insensitive } },
          ];
          if (matchedUserIds.length > 0) {
            betConditions.push({ participants: { some: { userId: { in: matchedUserIds } } } });
          }
          if (matchingClanIds.length > 0) {
            betConditions.push({ participants: { some: { clanId: { in: matchingClanIds } } } });
          }

          const betRows = await prisma.clanBet.findMany({
            where: { guildId, season, status: 'RESOLVED', OR: betConditions },
            orderBy: { resolvedAt: 'desc' },
            take: SEARCH_BET_LIMIT,
            include: { sides: { include: { participants: true } } },
          });

          const entriesOf = (bet: (typeof betRows)[number]) =>
            bet.sides.flatMap((side) =>
              side.participants
                .filter((entry) => entry.status === 'JOINED')
                .map((entry) => ({ ...entry, sideLabel: side.label, won: side.id === bet.winningSideId })),
            );

          // Les dettes sont lues avant les profils : un endetté qui n'a jamais
          // parié n'apparaît dans aucun pari, et son pseudo manquerait à l'appel
          // s'il n'était pas cherché en même temps que ceux des parieurs.
          const debtRows = guildConfig.betAllowDebt && matchedUserIds.length > 0
            ? await prisma.clanPointDebt.findMany({
                where: { guildId, amount: { gt: 0 }, userId: { in: matchedUserIds } },
                orderBy: { amount: 'desc' },
                take: SEARCH_MATCH_LIMIT,
              })
            : [];

          const betUserIds = [...new Set([
            ...betRows.flatMap((bet) => entriesOf(bet).map((entry) => entry.userId)),
            ...debtRows.map((row) => row.userId),
          ])];
          const betProfiles = betUserIds.length > 0
            ? await prisma.memberProfile.findMany({ where: { guildId, userId: { in: betUserIds } } })
            : [];
          const betProfileMap = new Map(betProfiles.map((p) => [p.userId, p]));

          const betNameOf = (userId: string) => {
            const profile = betProfileMap.get(userId);
            const discordMember = discordGuild?.members.cache.get(userId);
            return {
              displayName: discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${userId}`,
              avatarUrl: resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null,
            };
          };

          const renderEntry = (entry: ReturnType<typeof entriesOf>[number]) => ({
            userId: entry.userId,
            ...betNameOf(entry.userId),
            clanName: entry.clanId ? clanById.get(entry.clanId)?.name ?? null : null,
            netGain: entry.won ? entry.payout - (entry.escrow + entry.debt) : -(entry.escrow + entry.debt),
          });

          bets = betRows.map((bet) => {
            const entries = entriesOf(bet);
            const winningSide = bet.sides.find((side) => side.id === bet.winningSideId);
            return {
              id: bet.id,
              subject: bet.subject,
              stake: bet.stake,
              shape: bet.shape,
              access: bet.access,
              pot: entries.reduce((sum, entry) => sum + entry.escrow + entry.debt, 0),
              creditUsed: entries.reduce((sum, entry) => sum + entry.debt, 0),
              winningSideLabel: winningSide?.label ?? null,
              winners: entries.filter((entry) => entry.won).map(renderEntry),
              losers: entries.filter((entry) => !entry.won).map(renderEntry),
              resolvedAt: bet.resolvedAt?.toISOString() ?? bet.updatedAt.toISOString(),
            };
          });

          // Le bilan n'est calculé que pour les personnes trouvées : leurs paris
          // sont tous là, grâce au `OR` sur leur identifiant. Ceux de leurs
          // adversaires ne le sont pas, leur bilan serait donc faux.
          if (matchedUserIds.length > 0) {
            const rootOf = await buildLinkedAccountFolder(guildId);
            const matchedRoots = new Set(matchedUserIds.map(rootOf));
            const involved = betRows.filter((bet) =>
              entriesOf(bet).some((entry) => matchedUserIds.includes(entry.userId)),
            );

            bettors = buildBettorStandings(
              involved
                .filter((bet) => bet.winningSideId !== null)
                .map((bet) => ({
                  entries: entriesOf(bet).map((entry) => ({
                    userId: rootOf(entry.userId),
                    engaged: entry.escrow + entry.debt,
                    payout: entry.payout,
                    won: entry.won,
                  })),
                  resolvedAt: bet.resolvedAt ?? bet.updatedAt,
                })),
            )
              .filter((standing) => matchedRoots.has(standing.userId))
              // Podium et primes restent à vide : ce bilan ne porte que sur les
              // paris des personnes trouvées, il ne dit rien du classement de la
              // saison, donc rien de la marche qui reviendrait à chacune.
              .map((standing) => ({ ...standing, ...betNameOf(standing.userId), podiumRank: null, reward: 0 }));
          }

          const engagedBySearchedUser = await getEngagedBetCredit(guildId, debtRows.map((row) => row.userId));
          debts = debtRows.map((row) => {
            const discordMember = discordGuild?.members.cache.get(row.userId);
            const clan = discordMember ? clans.find((c) => discordMember.roles.cache.has(c.roleId)) : undefined;
            const engaged = Math.min(row.amount, engagedBySearchedUser.get(row.userId) ?? 0);
            return {
              userId: row.userId,
              ...betNameOf(row.userId),
              amount: row.amount,
              engaged,
              firm: firmDebtOf(row.amount, engaged),
              clanId: clan?.id ?? null,
              clanName: clan?.name ?? null,
              clanColor: clanColor(clan),
              since: row.createdAt.toISOString(),
            };
          });
        } catch (betErr: unknown) {
          const message = betErr instanceof Error ? betErr.message : String(betErr);
          logger.warn('PublicAPI', `Recherche de paris indisponible pour ${guildId} : ${message}`);
        }
      }

      return reply(c, 200, {
        participants,
        scores,
        matchCounts: Object.fromEntries(matchCountByClanId),
        bets,
        bettors,
        debts,
      });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.warn('PublicAPI', `Recherche de clans indisponible pour ${guildId} : ${errMessage}`);
      return reply(c, 200, empty);
    }

  });

  // GET /api/public/guilds/:guildId/clans
  router.get('/api/public/guilds/:guildId/clans', async (c) => {
    const guildId = c.req.param('guildId');
    if (!/^\d{17,19}$/.test(guildId)) {
      return reply(c, 400, { error: 'ID de guilde invalide' });

    }

    if (!underLimit(c, publicClansRateLimiter, 60, 60_000)) {
      return reply(c, 429, { error: 'Trop de requêtes. Veuillez réessayer plus tard.' });

    }

    // La réponse est identique pour tous les visiteurs : un cache court suffit
    // à ce qu'une page très consultée ne coûte qu'une lecture par intervalle.
    // Le préfixe `guild:<id>:` est celui qu'invalide toute écriture du dashboard,
    // donc une action d'admin est répercutée sans attendre l'expiration.
    const cacheKey = `guild:${guildId}:public-clans`;
    const cachedPayload = await cache.get<unknown>(cacheKey);
    if (cachedPayload) {
      c.header('Cache-Control', `public, max-age=${PUBLIC_CLANS_CACHE_TTL_S}`);
      return reply(c, 200, cachedPayload);

    }

    try {
      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          clansEnabled: true,
          currentClanSeason: true,
          clanSeasonStartsAt: true,
          clanSeasonEndsAt: true,
          betsEnabled: true,
          betAllowDebt: true,
          betSeasonRewardEnabled: true,
          betSeasonRewardRoleId: true,
          betRewardTop1: true,
          betRewardTop2: true,
          betRewardTop3: true,
        },
      });

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);

      if (!guildConfig?.clansEnabled) {
        return reply(c, 200, {
          enabled: false,
          guildName: discordGuild?.name || 'Kotbo Server',
          guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
          clans: [],
        });

      }

      const clans = await prisma.clan.findMany({
        where: { guildId },
        orderBy: { name: 'asc' },
      });

      // Charger toutes les contributions pour la saison en cours
      const contributions = await prisma.clanMemberContribution.findMany({
        where: {
          guildId,
          season: guildConfig.currentClanSeason,
        },
        orderBy: { xp: 'desc' },
      });

      // Charger les profils utilisateur impliqués pour récupérer noms et avatars
      const userIds = [...new Set(contributions.map((c) => c.userId))];
      const dbProfiles = await prisma.memberProfile.findMany({
        where: {
          guildId,
          userId: { in: userIds },
        },
      });
      const profileMap = new Map(dbProfiles.map((p) => [p.userId, p]));

      // Associer les contributions avec les données utilisateur
      const clansData = clans.map((clan) => {
        const role = discordGuild?.roles.cache.get(clan.roleId);
        const memberCount = role?.members.size ?? 0;

        const clanContributions = contributions.filter((c) => c.clanId === clan.id);
        const totalXp = clanContributions.reduce((sum, c) => sum + c.xp, 0);

        // Seule la tête du classement est envoyée : chercher quelqu'un de plus
        // bas passe par /clans/search, qui calcule son rang côté serveur. Servir
        // le classement entier ferait grossir la page avec le nombre de joueurs.
        //
        // Les points attribués au clan entier sont stockés sous un pseudo-membre :
        // ils comptent dans le total du clan mais ne sont pas un participant, et
        // les laisser ici décalerait le rang de tout le monde. Une ligne à zéro
        // (retrait manuel de tout son score) n'est pas non plus un participant.
        //
        // Les ex æquo partagent le même rang, comme dans /clans/search qui le
        // déduit d'un comptage : sans ça, quelqu'un se verrait 5e ici et 4e en
        // se cherchant.
        let rank = 0;
        let previousXp: number | null = null;

        const topParticipants = clanContributions
          .filter((c) => c.userId !== CLAN_WIDE_USER_ID && c.xp > 0)
          .slice(0, PUBLIC_CLANS_TOP_LIMIT)
          .map((c, i) => {
            const profile = profileMap.get(c.userId);
            const discordMember = discordGuild?.members.cache.get(c.userId);

            const displayName = discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${c.userId}`;
            const avatarUrl = resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null;

            if (c.xp !== previousXp) rank = i + 1;
            previousXp = c.xp;

            return {
              userId: c.userId,
              rank,
              xp: c.xp,
              displayName,
              avatarUrl,
            };
          });

        return {
          id: clan.id,
          name: clan.name,
          description: clan.description,
          roleId: clan.roleId,
          roleColor: role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : null,
          totalXp,
          memberCount,
          topParticipants,
        };
      });

      // ─── Flux « derniers scores » : gains de points les plus récents ──────────
      // Non-bloquant : un souci sur ce flux (ex. migration pas encore appliquée)
      // ne doit jamais empêcher l'affichage du classement principal.
      let recentScores: Array<Record<string, unknown>> = [];
      try {
        const recentEvents = await prisma.clanContributionEvent.findMany({
          where: { guildId, season: guildConfig.currentClanSeason },
          orderBy: { createdAt: 'desc' },
          take: 20,
        });

        const clanById = new Map(clans.map((c) => [c.id, c]));

        // Compléter la table des profils avec les auteurs des événements récents
        const eventUserIds = [...new Set(
          recentEvents
            .map((e) => e.userId)
            .filter((id) => id && id !== 'system_manual_points' && !profileMap.has(id))
        )];
        if (eventUserIds.length > 0) {
          const extraProfiles = await prisma.memberProfile.findMany({
            where: { guildId, userId: { in: eventUserIds } },
          });
          for (const p of extraProfiles) profileMap.set(p.userId, p);
        }

        recentScores = recentEvents.map((e) => {
          const clan = clanById.get(e.clanId);
          const role = clan ? discordGuild?.roles.cache.get(clan.roleId) : null;
          const isClanGlobal = e.userId === 'system_manual_points';

          let displayName: string;
          let avatarUrl: string | null = null;
          if (isClanGlobal) {
            // Gain attribué au clan entier : on affiche le nom du clan
            displayName = clan?.name || 'Clan';
          } else {
            const profile = profileMap.get(e.userId);
            const discordMember = discordGuild?.members.cache.get(e.userId);
            displayName = discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${e.userId}`;
            avatarUrl = resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null;
          }

          return {
            id: e.id,
            amount: e.amount,
            // Part de la mise payée à crédit : elle n'a bougé aucun score, mais
            // elle explique le remboursement qui apparaîtra plus haut dans le
            // flux, sans origine visible sans elle.
            credit: e.credit ?? 0,
            source: e.source, // 'XP' | 'ADMIN' | 'BOOST' | 'DAILY_ALGO' | 'BET' | 'DEBT' | 'DROP' | 'RPG_BOSS' | 'RPG_MOB' | 'RPG_ITEM' | 'RPG_FIRST_KILL' | 'RPG_FISHBOOK' | 'RPG_TOWER' | 'RPG_TOWER_CLAN'
            isClan: isClanGlobal,
            userId: isClanGlobal ? null : e.userId,
            displayName,
            avatarUrl,
            clanName: clan?.name || null,
            clanColor: role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : null,
            createdAt: e.createdAt.toISOString(),
          };
        });
      } catch (scoreErr: unknown) {
        const m = scoreErr instanceof Error ? scoreErr.message : String(scoreErr);
        logger.warn('PublicAPI', `Flux « derniers scores » indisponible pour ${guildId} (migration appliquée ?) : ${m}`);
        recentScores = [];
      }

      // ── Paris de la saison : historique public et palmarès ────────────────
      //
      // Absents tant que le module est éteint : les tables sont alors vides par
      // construction, et afficher des sections vides promettrait une
      // fonctionnalité que le serveur n'a pas ouverte.
      let recentBets: Array<Record<string, unknown>> = [];
      let bettors: Array<Record<string, unknown>> = [];
      let bettorRewards: Record<string, unknown> | null = null;
      if (guildConfig.betsEnabled) {
        try {
          // Le palmarès agrège toute la saison, l'historique n'en montre que la
          // tête. Le plafond protège d'un serveur qui aurait laissé filer des
          // dizaines de milliers de paris : au-delà, le classement reste juste
          // sur ce qu'il a lu, et personne ne remontera si loin.
          const seasonBets = await prisma.clanBet.findMany({
            where: { guildId, season: guildConfig.currentClanSeason, status: 'RESOLVED' },
            orderBy: { resolvedAt: 'desc' },
            take: 5_000,
            include: { sides: { include: { participants: true } } },
          });

          // L'argent d'un pari vit sur ses participants : le pari lui-même ne
          // porte plus que le sujet et le camp vainqueur.
          const entriesOf = (bet: (typeof seasonBets)[number]) =>
            bet.sides.flatMap((side) =>
              side.participants
                .filter((entry) => entry.status === 'JOINED')
                .map((entry) => ({ ...entry, sideLabel: side.label, won: side.id === bet.winningSideId })),
            );

          const betUserIds = [...new Set(
            seasonBets.flatMap((bet) => entriesOf(bet).map((entry) => entry.userId)).filter((id) => !profileMap.has(id)),
          )];
          if (betUserIds.length > 0) {
            const betProfiles = await prisma.memberProfile.findMany({
              where: { guildId, userId: { in: betUserIds } },
            });
            for (const profile of betProfiles) profileMap.set(profile.userId, profile);
          }

          const nameOf = (userId: string) => {
            const profile = profileMap.get(userId);
            const discordMember = discordGuild?.members.cache.get(userId);
            return {
              displayName: discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${userId}`,
              avatarUrl: resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null,
            };
          };

          const clanNameById = new Map(clans.map((clan) => [clan.id, clan.name]));

          const renderSide = (entry: ReturnType<typeof entriesOf>[number]) => ({
            userId: entry.userId,
            ...nameOf(entry.userId),
            clanName: entry.clanId ? clanNameById.get(entry.clanId) ?? null : null,
            // Le gain net, jamais le versement : le gagnant n'a fait que
            // récupérer sa propre mise en plus de celles qu'il a prises.
            netGain: entry.won ? entry.payout - (entry.escrow + entry.debt) : -(entry.escrow + entry.debt),
          });

          recentBets = seasonBets.slice(0, 20).map((bet) => {
            const entries = entriesOf(bet);
            const winningSide = bet.sides.find((side) => side.id === bet.winningSideId);
            return {
              id: bet.id,
              subject: bet.subject,
              stake: bet.stake,
              shape: bet.shape,
              access: bet.access,
              pot: entries.reduce((sum, entry) => sum + entry.escrow + entry.debt, 0),
              creditUsed: entries.reduce((sum, entry) => sum + entry.debt, 0),
              winningSideLabel: winningSide?.label ?? null,
              winners: entries.filter((entry) => entry.won).map(renderSide),
              losers: entries.filter((entry) => !entry.won).map(renderSide),
              resolvedAt: bet.resolvedAt?.toISOString() ?? bet.updatedAt.toISOString(),
            };
          });

          const rootOf = await buildLinkedAccountFolder(guildId);

          const standings = buildBettorStandings(
            seasonBets
              .filter((bet) => bet.winningSideId !== null)
              .map((bet) => ({
                entries: entriesOf(bet).map((entry) => ({
                  userId: rootOf(entry.userId),
                  engaged: entry.escrow + entry.debt,
                  payout: entry.payout,
                  won: entry.won,
                })),
                resolvedAt: bet.resolvedAt ?? bet.updatedAt,
              })),
          );

          // Le palmarès s'affichait toute la saison sans jamais dire ce qu'il y
          // avait au bout. La prime est calculée par la fonction qui la verse à
          // la clôture, ex aequo partagés compris : la page annonce donc ce que
          // la clôture ferait en l'état, pas un barème théorique.
          const laureates = guildConfig.betSeasonRewardEnabled
            ? buildSeasonLaureates(standings, guildConfig)
            : [];
          const laureateOf = new Map(laureates.map((laureate) => [laureate.userId, laureate]));

          bettors = standings.slice(0, 10).map((standing) => ({
            ...standing,
            ...nameOf(standing.userId),
            podiumRank: laureateOf.get(standing.userId)?.rank ?? null,
            reward: laureateOf.get(standing.userId)?.reward ?? 0,
          }));

          if (guildConfig.betSeasonRewardEnabled) {
            const rewardRole = guildConfig.betSeasonRewardRoleId
              ? discordGuild?.roles.cache.get(guildConfig.betSeasonRewardRoleId) ?? null
              : null;
            bettorRewards = {
              top1: guildConfig.betRewardTop1,
              top2: guildConfig.betRewardTop2,
              top3: guildConfig.betRewardTop3,
              roleName: rewardRole?.name ?? null,
              roleColor: rewardRole?.color ? `#${rewardRole.color.toString(16).padStart(6, '0')}` : null,
            };
          }
        } catch (betErr: unknown) {
          const message = betErr instanceof Error ? betErr.message : String(betErr);
          logger.warn('PublicAPI', `Paris de clan indisponibles pour ${guildId} (migration appliquée ?) : ${message}`);
          recentBets = [];
          bettors = [];
          bettorRewards = null;
        }
      }

      // Onglet « Dettes » : ouvert seulement si le serveur a réellement ouvert le
      // crédit. Ailleurs, la table est vide par construction et l'onglet
      // n'afficherait qu'une promesse de fonctionnalité.
      let debtsPayload: Record<string, unknown> | null = null;
      if (guildConfig.betsEnabled && guildConfig.betAllowDebt) {
        try {
          const debtRows = await prisma.clanPointDebt.findMany({
            where: { guildId, amount: { gt: 0 } },
            orderBy: { amount: 'desc' },
            take: 200,
          });

          if (debtRows.length > 0) {
            // La dette n'est pas rattachée à un clan : elle suit le membre, qui
            // peut en changer. Le clan affiché est donc celui qu'il porte
            // aujourd'hui, lu sur les rôles Discord.
            const clanByUserId = new Map<string, (typeof clans)[number]>();
            for (const clan of clans) {
              const role = discordGuild?.roles.cache.get(clan.roleId);
              for (const memberId of role?.members.keys() ?? []) clanByUserId.set(memberId, clan);
            }

            const debtorIds = debtRows.map((row) => row.userId).filter((id) => !profileMap.has(id));
            if (debtorIds.length > 0) {
              const debtorProfiles = await prisma.memberProfile.findMany({
                where: { guildId, userId: { in: debtorIds } },
              });
              for (const profile of debtorProfiles) profileMap.set(profile.userId, profile);
            }

            // Une dette se lit en deux morceaux : la part ferme, et le crédit
            // encore engagé dans des paris non tranchés, qui s'efface si le pari
            // est annulé ou si la saison se termine. Le classement porte sur le
            // ferme, seul montant qui ne peut plus disparaître tout seul.
            const engagedByUser = await getEngagedBetCredit(guildId, debtRows.map((row) => row.userId));

            const debtors = debtRows.map((row) => {
              const clan = clanByUserId.get(row.userId) ?? null;
              const role = clan ? discordGuild?.roles.cache.get(clan.roleId) : null;
              const profile = profileMap.get(row.userId);
              const discordMember = discordGuild?.members.cache.get(row.userId);
              const engaged = Math.min(row.amount, engagedByUser.get(row.userId) ?? 0);

              return {
                userId: row.userId,
                displayName: discordMember?.displayName || profile?.displayName || profile?.globalName || `Utilisateur ${row.userId}`,
                avatarUrl: resolveMemberAvatarUrl(discordMember, 128) || profile?.avatarUrl || null,
                amount: row.amount,
                engaged,
                firm: firmDebtOf(row.amount, engaged),
                clanId: clan?.id ?? null,
                clanName: clan?.name ?? null,
                clanColor: role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : null,
                since: row.createdAt.toISOString(),
              };
            }).sort((a, b) => b.firm - a.firm || b.amount - a.amount);

            const byClan = clans.map((clan) => {
              const members = debtors.filter((debtor) => debtor.clanId === clan.id);
              const role = discordGuild?.roles.cache.get(clan.roleId);
              return {
                id: clan.id,
                name: clan.name,
                roleColor: role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : null,
                totalDebt: members.reduce((sum, debtor) => sum + debtor.amount, 0),
                totalEngaged: members.reduce((sum, debtor) => sum + debtor.engaged, 0),
                debtorCount: members.length,
                debtors: members.slice(0, 10),
              };
            }).sort((a, b) => b.totalDebt - a.totalDebt);

            // Le total et l'effectif sont comptés par la base, pas sur les lignes
            // lues : celles-ci sont plafonnées à 200, et au-delà les tuiles
            // annonceraient une dette du serveur inférieure à la réalité sans
            // que rien ne le signale.
            const overall = await prisma.clanPointDebt.aggregate({
              where: { guildId, amount: { gt: 0 } },
              _sum: { amount: true },
              _count: { _all: true },
            });

            debtsPayload = {
              total: overall._sum.amount ?? 0,
              // Compté sur toute la table plutôt que sur les 200 lignes lues,
              // pour la même raison que le total.
              totalEngaged: Math.min(overall._sum.amount ?? 0, await getEngagedBetCreditTotal(guildId)),
              debtorCount: overall._count._all,
              // Membres sans clan : leur dette existe mais n'est rattachée à
              // aucune colonne, elle serait invisible sans cette liste.
              unaffiliated: debtors.filter((debtor) => !debtor.clanId).slice(0, 10),
              top: debtors.slice(0, 10),
              clans: byClan,
            };
          } else {
            debtsPayload = { total: 0, totalEngaged: 0, debtorCount: 0, unaffiliated: [], top: [], clans: [] };
          }
        } catch (debtErr: unknown) {
          const message = debtErr instanceof Error ? debtErr.message : String(debtErr);
          logger.warn('PublicAPI', `Dettes de clan indisponibles pour ${guildId} (migration appliquée ?) : ${message}`);
          debtsPayload = null;
        }
      }

      const payload = {
        enabled: true,
        betsEnabled: guildConfig.betsEnabled,
        recentBets,
        bettors,
        bettorRewards,
        debtsEnabled: debtsPayload !== null,
        debts: debtsPayload,
        currentClanSeason: guildConfig.currentClanSeason,
        clanSeasonStartsAt: guildConfig.clanSeasonStartsAt?.toISOString() ?? null,
        clanSeasonEndsAt: guildConfig.clanSeasonEndsAt?.toISOString() ?? null,
        guildName: discordGuild?.name || 'Kotbo Server',
        guildIcon: discordGuild?.iconURL({ size: 128 }) || null,
        clans: clansData,
        recentScores,
      };

      await cache.set(cacheKey, payload, PUBLIC_CLANS_CACHE_TTL_S);
      c.header('Cache-Control', `public, max-age=${PUBLIC_CLANS_CACHE_TTL_S}`);
      return reply(c, 200, payload);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error('PublicAPI', `Error fetching public clans for guild ${guildId}: ${errMessage}`);
      return reply(c, 500, { error: 'Erreur lors du chargement du classement de clans' });
    }

  });

  return router;
}
