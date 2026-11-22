import { Hono } from 'hono';
import crypto from 'node:crypto';
import { Client, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isGuildActivated } from '../../utils/activation.js';
import {
  checkRateLimit,
  rankCardPreviewRateLimiter,
  resolveAdminAccess,
  resolveDashboardAccess,
  hasDashboardAdminPermission,
  getDiscordClientId,
  type DashboardAccessLevel,
} from '../shared.js';
import { getCurrentInstance, isWhiteLabelInstance } from '../../utils/instanceContext.js';
import prisma from '../../utils/db.js';
import { fetchExternal } from '../../utils/http.js';
import { normalizeRankCardCustomization, type LevelCurve } from '@kotbo/shared';
import { readRankCardCustomization, saveRankCardCustomization } from '../../services/progression/rankCardService.js';
import { evaluateAchievements } from '../../services/progression/achievementService.js';
import { getGuildLevelCurve, getLevelFromXp, renderRankCard } from '../../services/progression/levelingService.js';
import { ensureMemberProfiles } from '../../services/progression/memberProfileSync.js';
import { dashboardAuth, fail, readBody, send } from '../hono/dashboard/kit.js';
// Repli de l'aperçu quand aucune progression réelle n'est disponible : la
// personnalisation est globale, la progression dépend du serveur.
const PREVIEW_LEVEL = 12;
const PREVIEW_XP = 16_800;
const PREVIEW_RANK = 7;

/**
 * Progression du membre dans le serveur sélectionné, pour que l'aperçu montre
 * la carte telle qu'elle sortira de `/rank`.
 *
 * Contrairement à `getMemberRankData`, on ne charge pas tout le classement de
 * la guilde : deux requêtes indexées suffisent, et l'aperçu est rendu à chaque
 * pause de frappe. L'absence de ligne vaut absence de progression, donc repli
 * sur les valeurs d'exemple - c'est aussi ce qui empêche de sonder un serveur
 * où le membre n'a jamais écrit.
 *
 * À XP égal, compter les membres strictement devant donne le même rang à tous
 * les ex æquo, là où `getMemberRankData` les départage par l'ordre que rend la
 * base. L'aperçu peut donc afficher un rang inférieur d'un cran à celui de
 * `/rank` sur une égalité : le classement de `/rank` n'étant lui-même pas
 * déterministe dans ce cas, mieux vaut ici une valeur stable.
 */
async function resolvePreviewProgression(
  userId: string,
  rawGuildId: unknown,
): Promise<{ level: number; xp: number; rank: number; curve: LevelCurve } | null> {
  if (typeof rawGuildId !== 'string' || !/^\d{17,20}$/.test(rawGuildId)) return null;

  try {
    const memberLevel = await prisma.memberLevel.findUnique({
      where: { guildId_userId: { guildId: rawGuildId, userId } },
      select: { xp: true },
    });
    if (!memberLevel) return null;

    const ahead = await prisma.memberLevel.count({
      where: { guildId: rawGuildId, xp: { gt: memberLevel.xp } },
    });

    const curve = await getGuildLevelCurve(rawGuildId);
    return { level: getLevelFromXp(memberLevel.xp, curve), xp: memberLevel.xp, rank: ahead + 1, curve };
  } catch (err) {
    logger.warn('API', `Progression d'aperçu illisible pour ${userId}:`, err);
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

/**
 * Permissions demandees quand on invite Kotbo sur un serveur.
 *
 * Administrateur couvre tous les besoins du bot et simplifie le lien
 * d'invitation : plus besoin de maintenir un bitfield par fonctionnalite.
 */
const BOT_INVITE_PERMISSIONS = PermissionFlagsBits.Administrator.toString();

export type DiscordOAuthGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
};

type CachedGuilds = {
  guilds: DiscordOAuthGuild[];
  fetchedAt: number;
};

const OAUTH_GUILDS_CACHE_TTL_MS = 60_000;
const OAUTH_GUILDS_STALE_TTL_MS = 10 * 60_000;
const oauthGuildsCache = new Map<string, CachedGuilds>();
const oauthGuildsInFlight = new Map<string, Promise<DiscordOAuthGuild[]>>();

export function clearOAuthGuildsCache(): void {
  oauthGuildsCache.clear();
  oauthGuildsInFlight.clear();
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function fetchOAuthGuildsFromDiscord(accessToken: string): Promise<DiscordOAuthGuild[]> {
  const guilds: DiscordOAuthGuild[] = [];
  let after: string | null = null;
  const MAX_RETRIES = 2;

  for (;;) {
    const params = new URLSearchParams({ limit: '200', with_counts: 'false' });
    if (after) params.set('after', after);
    const url = `https://discord.com/api/v10/users/@me/guilds?${params.toString()}`;

    let response: Response | null = null;
    let attempt = 0;

    while (attempt <= MAX_RETRIES) {
      attempt++;
      response = await fetchExternal(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 429) {
        let retryAfterMs = 1000;
        try {
          const body = (await response.json()) as { retry_after?: number };
          if (typeof body?.retry_after === 'number' && body.retry_after > 0) {
            retryAfterMs = Math.ceil(body.retry_after * 1000);
          }
        } catch {
          const header = response.headers.get('retry-after');
          if (header) {
            const parsed = parseFloat(header);
            if (!Number.isNaN(parsed) && parsed > 0) retryAfterMs = Math.ceil(parsed * 1000);
          }
        }
        const waitMs = Math.min(Math.max(retryAfterMs, 500), 3000);
        logger.warn(
          'DashboardAPI',
          `Discord OAuth guilds 429 rate limit, attente de ${waitMs}ms (tentative ${attempt}/${MAX_RETRIES + 1})`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      break;
    }

    if (!response || !response.ok) {
      throw new Error(`Discord guilds API: ${response?.status ?? 'unknown'}`);
    }

    const page = (await response.json()) as DiscordOAuthGuild[];
    guilds.push(...page);
    if (page.length < 200) return guilds;
    after = page[page.length - 1]?.id ?? null;
    if (!after) return guilds;
  }
}

export async function fetchOAuthGuilds(accessToken: string, forceFresh = false): Promise<DiscordOAuthGuild[]> {
  const tokenKey = hashToken(accessToken);
  const now = Date.now();
  const cached = oauthGuildsCache.get(tokenKey);

  if (!forceFresh && cached && now - cached.fetchedAt < OAUTH_GUILDS_CACHE_TTL_MS) {
    return cached.guilds;
  }

  const inFlight = oauthGuildsInFlight.get(tokenKey);
  if (inFlight) {
    return inFlight;
  }

  if (oauthGuildsCache.size > 500) {
    for (const [key, entry] of oauthGuildsCache.entries()) {
      if (now - entry.fetchedAt > OAUTH_GUILDS_STALE_TTL_MS) {
        oauthGuildsCache.delete(key);
      }
    }
  }

  const promise = (async () => {
    try {
      const freshGuilds = await fetchOAuthGuildsFromDiscord(accessToken);
      oauthGuildsCache.set(tokenKey, { guilds: freshGuilds, fetchedAt: Date.now() });
      return freshGuilds;
    } catch (err) {
      if (cached && Date.now() - cached.fetchedAt < OAUTH_GUILDS_STALE_TTL_MS) {
        logger.warn(
          'DashboardAPI',
          `Échec Discord OAuth (${String(err)}), utilisation du cache stale (${Math.round((Date.now() - cached.fetchedAt) / 1000)}s)`,
        );
        return cached.guilds;
      }
      throw err;
    }
  })();

  oauthGuildsInFlight.set(tokenKey, promise);
  try {
    return await promise;
  } finally {
    oauthGuildsInFlight.delete(tokenKey);
  }
}

/**
 * Les serveurs ou le bot se trouve reellement, tous fragments confondus.
 *
 * `client.guilds.cache` ne connait que les serveurs du fragment qui repond
 * a l'appel : des deux fragments, chacun declarait absents les serveurs de
 * l'autre. La liste proposait donc de reinviter un bot deja present, et le
 * tableau de bord d'un de ces serveurs s'ouvrait sur un bot qu'il croyait
 * parti.
 *
 * Sur une instance sans fragmentation, `client.shard` est nul et le cache
 * local fait foi - il est alors complet. Un fragment injoignable fait
 * retomber sur ce meme cache plutot que de vider la liste.
 */
async function resolvePresentGuildIds(client: Client): Promise<Set<string>> {
  const sharding = client.shard;
  if (!sharding) return new Set(client.guilds.cache.keys());

  try {
    const perShard = await sharding.broadcastEval((shardClient) => [...shardClient.guilds.cache.keys()]);
    return new Set(perShard.flat());
  } catch (err) {
    logger.warn('API', 'Presence du bot lue sur le seul fragment courant :', err);
    return new Set(client.guilds.cache.keys());
  }
}

/** Serveurs que la personne partage avec le bot, d'apres sa liste OAuth. */
export async function resolveMutualGuildIds(client: Client, discordToken: string): Promise<string[]> {
  const [oauthGuilds, presentGuildIds] = await Promise.all([
    fetchOAuthGuilds(discordToken),
    resolvePresentGuildIds(client),
  ]);
  return oauthGuilds.filter((guild) => presentGuildIds.has(guild.id)).map((guild) => guild.id);
}

/**
 * Ouvre les fiches manquantes des serveurs partages. Rien ne doit attendre ni
 * echouer a cause d'elle : l'appelant ne l'attend pas.
 */
export async function syncMutualMemberProfiles(
  client: Client,
  userId: string,
  discordToken: string | null | undefined,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!discordToken) return;
  try {
    const guildIds = await resolveMutualGuildIds(client, discordToken);
    await ensureMemberProfiles(client, userId, guildIds, options);
  } catch (err) {
    logger.warn('API', `Fiches de membre non synchronisees pour ${userId}:`, err);
  }
}

export function createUserRouter(client: Client) {
  const router = new Hono();

  // Toutes les routes /api/user/* requièrent une session active.
  router.use('/api/user/*', dashboardAuth);

  // GET /api/user/me
  router.get('/api/user/me', async (c) => {
    const user = c.var.dashboardUser;
    // Premier appel du dashboard après la connexion : c'est là que le compte
    // relié reçoit sa fiche sur chaque serveur partagé, qu'il y ait écrit ou non.
    void syncMutualMemberProfiles(client, user.userId, user.discordToken);
    const isBotAdmin = await resolveAdminAccess(client, user.userId);
    return send(c, { id: user.userId, username: user.username, avatar: user.avatar, isBotAdmin });
  });

  // GET /api/user/rank-card - la préférence et l'état des succès : le catalogue
  // des fonds, décors et succès vient de `@kotbo/shared`, que le dashboard
  // compile déjà.
  router.get('/api/user/rank-card', async (c) => {
    const user = c.var.dashboardUser;
    try {
      // Dans cet ordre : l'évaluation enregistre les succès tout juste atteints,
      // la lecture de la préférence doit les voir pour ne pas les retirer.
      const achievements = await evaluateAchievements(user.userId);
      const customization = await readRankCardCustomization(user.userId);
      return send(c, { customization, achievements });
    } catch (err) {
      logger.error('API', `Erreur de lecture de la carte de rang pour ${user.userId}:`, err);
      return fail(c, err, 'Une erreur interne est survenue', 'API');
    }
  });

  // PUT /api/user/rank-card
  router.put('/api/user/rank-card', async (c) => {
    const user = c.var.dashboardUser;
    try {
      const body = await readBody(c);
      const achievements = await evaluateAchievements(user.userId);
      const unlocked = new Set(achievements.unlocked.map((entry) => entry.id));
      const customization = await saveRankCardCustomization(user.userId, body, unlocked);
      return send(c, { customization });
    } catch (err) {
      logger.error('API', `Erreur de sauvegarde de la carte de rang pour ${user.userId}:`, err);
      return fail(c, err, 'Une erreur interne est survenue', 'API');
    }
  });

  // POST /api/user/rank-card/preview - rendu réel, pour éviter de réimplémenter
  // le dessin de la carte côté dashboard.
  router.post('/api/user/rank-card/preview', async (c) => {
    const user = c.var.dashboardUser;
    if (!checkRateLimit(rankCardPreviewRateLimiter, user.userId, 120, 60 * 1000)) {
      return send(c, { error: "Trop d'aperçus demandés. Patientez une minute avant de réessayer." }, 429);
    }

    try {
      const body = await readBody<{ guildId?: unknown; locale?: string }>(c);
      const achievements = await evaluateAchievements(user.userId);
      const customization = normalizeRankCardCustomization(body, new Set(achievements.unlocked.map((entry) => entry.id)));
      const progression = await resolvePreviewProgression(user.userId, body?.guildId);
      const buffer = await renderRankCard(
        {
          userId: user.userId,
          displayName: user.username ?? 'Membre',
          username: user.username ?? 'membre',
          discriminator: '0',
          avatarUrl: user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.userId}/${user.avatar}.png?size=256`
            : 'https://cdn.discordapp.com/embed/avatars/0.png',
          status: 'online',
        },
        progression?.level ?? PREVIEW_LEVEL,
        progression?.xp ?? PREVIEW_XP,
        progression?.rank ?? PREVIEW_RANK,
        body?.locale === 'en' ? 'en' : 'fr',
        customization,
        progression?.curve,
      );

      return c.body(new Uint8Array(buffer), 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Rank-Card-Preview': progression ? 'real' : 'sample',
      });
    } catch (err) {
      logger.error('API', `Erreur d'aperçu de la carte de rang pour ${user.userId}:`, err);
      return fail(c, err, 'Une erreur interne est survenue', 'API');
    }
  });

  // GET /api/user/servers
  //
  // La liste des serveurs *que la personne administre*, avec ou sans Kotbo -
  // `/api/user/guilds` ne rend que ceux où le bot est déjà là, et c'est
  // précisément l'inverse qu'il faut pour proposer de l'ajouter.
  router.get('/api/user/servers', async (c) => {
    const user = c.var.dashboardUser;
    try {
      if (!user.discordToken) {
        // Sans jeton OAuth, Discord ne nous dit rien des serveurs de la
        // personne : mieux vaut une liste vide qu'une liste fausse.
        return send(c, { guilds: [], clientId: getDiscordClientId(), invitePermissions: BOT_INVITE_PERMISSIONS, oauthUnavailable: true });
      }

      const refreshParam = c.req.query('refresh');
      const forceFresh = refreshParam === '1' || refreshParam === 'true';
      const oauthGuilds = await fetchOAuthGuilds(user.discordToken, forceFresh).catch((err) => {
        logger.warn('DashboardAPI', `Discord OAuth guild list unavailable: ${String(err)}`);
        return null;
      });

      if (!oauthGuilds) {
        return send(c, { guilds: [], clientId: getDiscordClientId(), invitePermissions: BOT_INVITE_PERMISSIONS, oauthUnavailable: true });
      }

      // Sur une instance marque blanche, un serveur qui n'est pas rattaché à
      // l'instance n'a rien à faire dans la liste : l'y montrer proposerait
      // d'inviter un bot qui refuserait ensuite de servir ce serveur.
      let instanceGuildIds: Set<string> | null = null;
      if (isWhiteLabelInstance()) {
        const instance = getCurrentInstance();
        const boundGuilds = await prisma.guild.findMany({
          where: { instanceId: instance.id },
          select: { id: true },
        });
        instanceGuildIds = new Set(boundGuilds.map((g) => g.id));
      }

      const presentGuildIds = await resolvePresentGuildIds(client);

      const manageable = oauthGuilds.filter((guild) => {
        let permissions = BigInt(0);
        try {
          permissions = guild.permissions ? BigInt(guild.permissions) : BigInt(0);
        } catch {
          permissions = BigInt(0);
        }
        return guild.owner || hasDashboardAdminPermission(permissions);
      });

      const payload = manageable
        .map((guild) => {
          const botPresent = presentGuildIds.has(guild.id);
          if (instanceGuildIds && !botPresent && !instanceGuildIds.has(guild.id)) return null;
          return {
            id: guild.id,
            name: guild.name,
            icon: guild.icon ?? null,
            owner: guild.owner ?? false,
            botPresent,
            // Le bot peut être sur le serveur sans que celui-ci soit activé :
            // l'écran doit distinguer « à inviter » de « à activer ».
            activated: botPresent ? isGuildActivated(guild.id) : false,
          };
        })
        .filter((guild): guild is NonNullable<typeof guild> => guild !== null)
        .sort((a, b) => Number(a.botPresent) - Number(b.botPresent) || a.name.localeCompare(b.name, 'fr'));

      return send(c, { guilds: payload, clientId: getDiscordClientId(), invitePermissions: BOT_INVITE_PERMISSIONS, oauthUnavailable: false });
    } catch (err) {
      logger.error('API', 'Unexpected error in /api/user/servers:', err);
      return fail(c, err, 'Une erreur interne est survenue', 'API');
    }
  });

  // GET /api/user/guilds
  router.get('/api/user/guilds', async (c) => {
    const user = c.var.dashboardUser;
    try {
      // For white-label instances, only show guilds bound to this instance
      let instanceGuildIds: Set<string> | null = null;
      if (isWhiteLabelInstance()) {
        const instance = getCurrentInstance();
        const boundGuilds = await prisma.guild.findMany({
          where: { instanceId: instance.id },
          select: { id: true },
        });
        instanceGuildIds = new Set(boundGuilds.map(g => g.id));
      }

      const refreshParam = c.req.query('refresh');
      const forceFresh = refreshParam === '1' || refreshParam === 'true';
      const [isGlobalAdmin, staffLinks, oauthGuilds] = await Promise.all([
        resolveAdminAccess(client, user.userId),
        prisma.staffServerLink.findMany({
          where: { enabled: true },
          select: { mainGuildId: true, staffGuildId: true },
        }),
        user.discordToken
          ? fetchOAuthGuilds(user.discordToken, forceFresh).catch((err) => {
              logger.warn('DashboardAPI', `Discord OAuth guild list unavailable: ${String(err)}`);
              return null;
            })
          : Promise.resolve(null),
      ]);

      const accessibleGuildsList: Array<{
        id: string;
        name: string;
        icon: string | null;
        owner: boolean;
        botPresent: boolean;
        accessLevel: Exclude<DashboardAccessLevel, 'none'>;
        isStaffServer: boolean;
        pairedGuildId: string | null;
        billingAccess: boolean;
      }> = [];

      const staffGuildToMain = new Map(staffLinks.map((l) => [l.staffGuildId, l.mainGuildId]));
      const mainGuildToStaff = new Map(staffLinks.map((l) => [l.mainGuildId, l.staffGuildId]));

      const oauthById = new Map((oauthGuilds ?? []).map((guild) => [guild.id, guild]));
      // Tous les fragments : `client.guilds.cache` ne connaît que celui qui sert l'API.
      const presentGuildIds = await resolvePresentGuildIds(client);
      const candidates = [...presentGuildIds].filter((guildId) => {
        if (instanceGuildIds && !instanceGuildIds.has(guildId)) return false;
        if (!isGuildActivated(guildId) && !isGlobalAdmin) return false;
        // Un administrateur global conserve la vue de toutes les guildes. Pour
        // les autres, l'intersection OAuth élimine immédiatement les serveurs
        // dont ils ne sont pas membres, sans un appel REST par guilde.
        return isGlobalAdmin || oauthGuilds === null || oauthById.has(guildId);
      });

      const resolved = await mapWithConcurrency(candidates, 8, async (guildId) => {
        const oauthGuild = oauthById.get(guildId);
        // Absent hors du fragment courant, où OAuth et resolveDashboardAccess suffisent.
        const localGuild = client.guilds.cache.get(guildId);
        let permissions = BigInt(0);
        try {
          permissions = oauthGuild?.permissions ? BigInt(oauthGuild.permissions) : BigInt(0);
        } catch {
          permissions = BigInt(0);
        }

        if (isGlobalAdmin || hasDashboardAdminPermission(permissions)) {
          return { guildId, accessLevel: 'admin' as const, owner: oauthGuild?.owner ?? localGuild?.ownerId === user.userId };
        }

        // Repli lorsque Discord OAuth est momentanément indisponible : la
        // concurrence est bornée, contrairement à l'ancienne waterfall.
        if (!oauthGuilds) {
          const member = await localGuild?.members.fetch(user.userId).catch(() => null);
          if (!member) return null;
          permissions = member.permissions.bitfield;
          if (hasDashboardAdminPermission(permissions)) {
            return { guildId, accessLevel: 'admin' as const, owner: localGuild?.ownerId === user.userId };
          }
        }

        try {
          const access = await resolveDashboardAccess(client, guildId, user.userId, permissions);
          if (!access.canViewDashboard) return null;
          return {
            guildId,
            accessLevel: access.level === 'admin' ? 'admin' as const : 'moderator' as const,
            owner: oauthGuild?.owner ?? localGuild?.ownerId === user.userId,
          };
        } catch (err) {
          logger.warn('DashboardAPI', `Failed to resolve access for guild ${guildId}:`, err);
          return null;
        }
      });

      // Droits de facturation, résolus en une requête pour toute la liste : la
      // page Facturation n'est pas une page comme les autres, elle affiche un
      // montant débité et une adresse. Elle est ouverte aux administrateurs, à
      // celui qui paie (`billingOwnerId`, même s'il a perdu ses droits Discord)
      // et au reste du staff seulement si le serveur l'a décidé.
      const resolvedIds = resolved.filter((entry) => entry !== null).map((entry) => entry!.guildId);
      const billingRows = resolvedIds.length
        ? await prisma.guild.findMany({
            where: { id: { in: resolvedIds } },
            select: { id: true, billingOwnerId: true, billingStaffAccess: true },
          })
        : [];
      const billingById = new Map(billingRows.map((row) => [row.id, row]));

      // Serveur d'un autre fragment absent de la liste OAuth (vue administrateur
      // global) : nom et icône lus par diffusion plutôt qu'un identifiant brut.
      const missingMetaIds = resolvedIds.filter((id) => !client.guilds.cache.has(id) && !oauthById.has(id));
      const shardMetaById = new Map<string, { name: string; icon: string | null }>();
      if (missingMetaIds.length && client.shard) {
        try {
          const perShard = await client.shard.broadcastEval(
            (shardClient, ids) => ids.flatMap((id) => {
              const guild = shardClient.guilds.cache.get(id);
              return guild ? [{ id, name: guild.name, icon: guild.icon }] : [];
            }),
            { context: missingMetaIds },
          );
          for (const { id, ...meta } of perShard.flat()) shardMetaById.set(id, meta);
        } catch (err) {
          logger.warn('DashboardAPI', 'Noms des serveurs multi-fragments indisponibles :', err);
        }
      }

      for (const entry of resolved) {
        if (!entry) continue;
        const { guildId, accessLevel, owner } = entry;
        const localGuild = client.guilds.cache.get(guildId);
        const oauthGuild = oauthById.get(guildId);
        const meta = shardMetaById.get(guildId);
        const billing = billingById.get(guildId);
        accessibleGuildsList.push({
          id: guildId,
          name: localGuild?.name ?? oauthGuild?.name ?? meta?.name ?? guildId,
          icon: localGuild?.icon ?? oauthGuild?.icon ?? meta?.icon ?? null,
          owner,
          botPresent: true,
          accessLevel,
          isStaffServer: staffGuildToMain.has(guildId),
          pairedGuildId: staffGuildToMain.get(guildId) ?? mainGuildToStaff.get(guildId) ?? null,
          billingAccess:
            accessLevel === 'admin' ||
            billing?.billingOwnerId === user.userId ||
            Boolean(billing?.billingStaffAccess),
        });
      }

      const payload = accessibleGuildsList.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'fr'));
      return send(c, { guilds: payload });
    } catch (err) {
      logger.error('API', 'Unexpected error in /api/user/guilds:', err);
      return fail(c, err, 'Une erreur interne est survenue', 'API');
    }
  });

  // Espace de suivi membre (/me) : liste des tickets du membre connecté
  router.get('/api/user/me/tickets', async (c) => {
    const user = c.var.dashboardUser;
    try {
      const tickets = await prisma.ticket.findMany({
        where: { userId: user.userId },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      });
      return send(c, {
        tickets: tickets.map((t) => {
          const g = client.guilds.cache.get(t.guildId);
          return {
            id: t.id,
            guildId: t.guildId,
            guildName: g?.name ?? t.guildId,
            guildIconUrl: g?.iconURL({ size: 64, extension: 'png' }) ?? null,
            reason: t.reason,
            description: t.description,
            status: t.status,
            source: t.source,
            ticketTypeLabel: t.ticketTypeLabel,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
            closedAt: t.closedAt?.toISOString() ?? null,
            lastStaffMessageAt: t.lastStaffMessageAt?.toISOString() ?? null,
            lastMemberMessageAt: t.lastMemberMessageAt?.toISOString() ?? null,
          };
        }),
      });
    } catch (err) {
      logger.error('API', 'Error fetching member tickets:', err);
      return fail(c, err, 'Impossible de charger vos tickets', 'API');
    }
  });

  router.get('/api/user/me/tickets/:ticketId', async (c) => {
    const user = c.var.dashboardUser;
    const ticketId = c.req.param('ticketId');
    try {
      const ticket = await prisma.ticket.findFirst({
        where: { id: ticketId, userId: user.userId },
        include: {
          webMessages: { orderBy: { createdAt: 'asc' } },
        },
      });
      if (!ticket) return send(c, { error: 'Ticket introuvable' }, 404);

      const g = client.guilds.cache.get(ticket.guildId);
      let messages = ticket.webMessages.map((m) => ({
        id: m.id,
        authorName: m.authorName,
        isStaff: m.isStaff,
        source: m.source,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      }));

      const conversationId = ticket.channelId ?? ticket.threadId;
      if (conversationId) {
        const ch = client.channels.cache.get(conversationId) ?? await client.channels.fetch(conversationId).catch(() => null);
        if (ch && ch.isTextBased()) {
          const fetched = await ch.messages.fetch({ limit: 40 }).catch(() => null);
          if (fetched) {
            const discordMsgs = [...fetched.values()]
              // Seuls les messages du membre : le salon contient aussi les échanges internes du staff.
              .filter((m) => m.author.id === user.userId && m.content?.trim())
              .map((m) => ({
                id: m.id,
                authorName: m.member?.displayName ?? m.author.displayName ?? m.author.username,
                isStaff: false,
                source: 'DISCORD',
                content: m.content,
                createdAt: m.createdAt.toISOString(),
              }));
            messages = [...discordMsgs, ...messages].sort(
              (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
            );
          }
        }
      }

      return send(c, {
        ticket: {
          id: ticket.id,
          guildId: ticket.guildId,
          guildName: g?.name ?? ticket.guildId,
          reason: ticket.reason,
          description: ticket.description,
          status: ticket.status,
          source: ticket.source,
          createdAt: ticket.createdAt.toISOString(),
          closedAt: ticket.closedAt?.toISOString() ?? null,
          messages,
        },
      });
    } catch (err) {
      logger.error('API', 'Error fetching member ticket detail:', err);
      return fail(c, err, 'Impossible de charger ce ticket', 'API');
    }
  });

  router.post('/api/user/me/tickets/:ticketId/reply', async (c) => {
    const user = c.var.dashboardUser;
    const ticketId = c.req.param('ticketId');
    try {
      const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, userId: user.userId } });
      if (!ticket) return send(c, { error: 'Ticket introuvable' }, 404);

      const body = await readBody<{ content?: string }>(c);
      const content = body?.content?.trim().slice(0, 1800) ?? '';
      if (!content) return send(c, { error: 'Message requis' }, 400);

      const now = new Date();
      const msg = await prisma.ticketWebMessage.create({
        data: {
          ticketId: ticket.id,
          authorId: user.userId,
          authorName: user.username ?? 'Membre',
          isStaff: false,
          source: 'WEB',
          content,
        },
      });

      const conversationId = ticket.channelId ?? ticket.threadId;
      if (conversationId) {
        const ch = client.channels.cache.get(conversationId) ?? await client.channels.fetch(conversationId).catch(() => null);
        if (ch && ch.isTextBased() && 'send' in ch) {
          await ch.send({
            content: `💬 **[${user.username ?? 'Membre'} via /me]** ${content}`.slice(0, 2000),
            allowedMentions: { parse: [] },
          }).catch(() => null);
        }
      }

      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { lastMemberMessageAt: now },
      });

      return send(c, {
        ok: true,
        message: {
          id: msg.id,
          authorName: msg.authorName,
          isStaff: false,
          source: 'WEB',
          content: msg.content,
          createdAt: msg.createdAt.toISOString(),
        },
      }, 201);
    } catch (err) {
      logger.error('API', 'Error replying to member ticket:', err);
      return fail(c, err, "Impossible d'envoyer la réponse", 'API');
    }
  });

  return router;
}
