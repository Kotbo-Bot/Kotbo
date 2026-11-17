import type { Client, GuildMember } from 'discord.js';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { extractPrimaryGuildTag, guildTagBadgeUrl } from '../core/serverTagService.js';

/**
 * Complète l'identité des profils membres créés sans pseudo ni avatar.
 *
 * Plusieurs écritures créent un `MemberProfile` à partir du seul identifiant
 * (détection de doubles comptes, note de modération, adhésion à un clan) : ces
 * lignes s'affichaient en « Utilisateur inconnu » dans la liste des membres,
 * alors que la fiche détaillée, elle, interroge Discord et affichait le bon
 * compte. On récupère donc l'identité manquante côté Discord, puis on la
 * réécrit en base pour que la correction soit durable.
 */

export type MemberIdentity = {
  username: string;
  displayName: string;
  /** `null` quand le membre n'a aucune photo : voir resolveMemberAvatarUrl. */
  avatarUrl: string | null;
  /** Tag de serveur affiché à côté du pseudo, comme sur Discord. */
  serverTag: MemberServerTag | null;
  /** Début du boost en cours (ISO), pour le badge d'ancienneté. */
  boostingSince: string | null;
};

export type MemberServerTag = { guildId: string; tag: string; badgeUrl: string | null };

/** Tag lu sur le compte Discord en main, sinon le dernier connu en base. */
function serverTagOf(
  user: GuildMember['user'] | null | undefined,
  stored?: { primaryGuildId: string | null; primaryGuildTag: string | null; primaryGuildBadge: string | null } | null,
): MemberServerTag | null {
  const live = extractPrimaryGuildTag(user);
  if (live) return { guildId: live.guildId, tag: live.tag, badgeUrl: live.badgeUrl };
  if (!stored?.primaryGuildId || !stored.primaryGuildTag) return null;
  return {
    guildId: stored.primaryGuildId,
    tag: stored.primaryGuildTag,
    badgeUrl: guildTagBadgeUrl(stored.primaryGuildId, stored.primaryGuildBadge),
  };
}

/** Boost lu sur le membre en cache, sinon le dernier connu en base. */
function boostingSinceOf(member: GuildMember | undefined, stored: Date | null): string | null {
  if (member) return member.premiumSince?.toISOString() ?? null;
  return stored?.toISOString() ?? null;
}

/**
 * Photo de profil réellement choisie par le membre, ou `null`.
 *
 * Deux pièges que `displayAvatarURL()` cache :
 *  - il ignore l'avatar par serveur si l'on part de `member.user` alors que
 *    `member.avatarURL()` le connaît ;
 *  - sans aucun hash il renvoie `embed/avatars/N.png`, la même image pour tout
 *    le monde. Stockée en base ou renvoyée au dashboard, elle empile des
 *    vignettes identiques dans les classements (issue #211).
 *
 * On renvoie donc `null` quand il n'y a rien à afficher : le dashboard rend
 * alors un avatar à initiale, distinct pour chaque membre.
 */
export function resolveMemberAvatarUrl(
  member: GuildMember | null | undefined,
  size: 64 | 128 | 256 = 256,
): string | null {
  if (!member) return null;
  return member.avatarURL({ size }) ?? member.user.avatarURL({ size }) ?? null;
}

/** Même résolution à partir d'un utilisateur seul (pas de membre en main). */
export function resolveUserAvatarUrl(
  user: GuildMember['user'] | null | undefined,
  size: 64 | 128 | 256 = 256,
): string | null {
  return user?.avatarURL({ size }) ?? null;
}

/**
 * Identité à poser sur un `MemberProfile` créé alors qu'un membre Discord est
 * déjà en main : à utiliser dans la branche `create` d'un upsert pour ne plus
 * produire de profil anonyme.
 */
export function memberProfileIdentity(member: GuildMember) {
  return {
    userTag: member.user.tag,
    username: member.user.username,
    globalName: member.user.globalName ?? null,
    displayName: member.displayName ?? member.user.globalName ?? member.user.username,
    avatarUrl: resolveMemberAvatarUrl(member, 256),
    isBot: member.user.bot,
    accountCreatedAt: member.user.createdAt,
    guildJoinedAt: member.joinedAt ?? null,
  };
}

/** Une requête Discord lente ne doit pas retenir une réponse du dashboard. */
const DISCORD_LOOKUP_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DISCORD_LOOKUP_TIMEOUT_MS)),
  ]);
}

/**
 * Résout l'identité Discord des membres cités, en privilégiant le cache.
 *
 * La réécriture en base est volontairement restreinte aux lignes dont le pseudo
 * est absent : une identité déjà connue n'est jamais écrasée.
 */
/**
 * Identités affichables pour une liste d'identifiants.
 *
 * Le profil en base répond pour la plupart des membres sans solliciter Discord ;
 * seuls ceux qu'il ne nomme pas encore passent par la résolution Discord, qui
 * réécrit au passage le profil. Sans ça, les vues qui n'affichent qu'un
 * identifiant brut - le classement de réputation notamment - restent
 * illisibles.
 */
export async function getMemberIdentities(
  client: Client,
  guildId: string,
  userIds: string[],
): Promise<Map<string, MemberIdentity>> {
  const identities = new Map<string, MemberIdentity>();
  const unique = [...new Set(userIds)].filter((id): id is string => Boolean(id));
  if (unique.length === 0) return identities;

  const profiles = await prisma.memberProfile
    .findMany({
      where: { guildId, userId: { in: unique } },
      select: {
        userId: true, username: true, displayName: true, globalName: true, avatarUrl: true,
        primaryGuildId: true, primaryGuildTag: true, primaryGuildBadge: true, boostingSince: true,
      },
    })
    .catch(() => []);
  const cached = client.guilds.cache.get(guildId)?.members.cache;

  for (const profile of profiles) {
    const displayName = profile.displayName ?? profile.globalName ?? profile.username;
    // Un profil cree a partir du seul identifiant n'a pas de pseudo : on le
    // laisse a la resolution Discord plutot que d'afficher un vide.
    if (!displayName) continue;
    identities.set(profile.userId, {
      username: profile.username ?? displayName,
      displayName,
      avatarUrl: profile.avatarUrl,
      serverTag: serverTagOf(cached?.get(profile.userId)?.user, profile),
      boostingSince: boostingSinceOf(cached?.get(profile.userId), profile.boostingSince),
    });
  }

  const missing = unique.filter((id) => !identities.has(id));
  if (missing.length > 0) {
    const resolved = await resolveMissingMemberIdentities(client, guildId, missing).catch(() => new Map());
    for (const [userId, identity] of resolved) identities.set(userId, identity);
  }

  return identities;
}

/**
 * Identifiants des membres dont un pseudo ressemble à la recherche.
 *
 * Passe par `unaccent` (installée par migration) : les pseudos sont saisis à la
 * main, « jose » doit trouver « José ». Une base qui n'a pas l'extension - droits
 * insuffisants au déploiement - retombe sur une recherche sensible aux accents,
 * ce qui vaut toujours mieux que zéro résultat.
 *
 * Vit ici plutôt que dans une route : les classements qui ne stockent que des
 * identifiants (niveaux, RP) ont tous besoin de la même traduction pseudo →
 * identifiants avant d'interroger leur propre table.
 */
export async function findProfileIdsByName(
  guildId: string,
  search: string,
  limit: number,
): Promise<string[]> {
  // `%` et `_` saisis dans la barre de recherche sont des caractères de
  // `ILIKE` : sans échappement, chercher « % » listerait toute la guilde.
  const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  try {
    const rows = await prismaRead.$queryRaw<Array<{ userId: string }>>`
      SELECT "userId" FROM "member_profiles"
      WHERE "guildId" = ${guildId}
        AND (
          unaccent(coalesce("username", '')) ILIKE unaccent(${pattern})
          OR unaccent(coalesce("displayName", '')) ILIKE unaccent(${pattern})
          OR unaccent(coalesce("globalName", '')) ILIKE unaccent(${pattern})
          OR unaccent(coalesce("userTag", '')) ILIKE unaccent(${pattern})
        )
      LIMIT ${limit}
    `;
    return rows.map((row) => row.userId);
  } catch (err) {
    logger.warn('MemberIdentity', 'Recherche sans unaccent (extension absente ?) :', err);
    const like = { contains: search, mode: 'insensitive' as const };
    const profiles = await prismaRead.memberProfile.findMany({
      where: {
        guildId,
        OR: [{ username: like }, { displayName: like }, { globalName: like }, { userTag: like }],
      },
      select: { userId: true },
      take: limit,
    });
    return profiles.map((profile) => profile.userId);
  }
}

/**
 * Identifiants visés par une recherche de classement : les pseudos qui
 * ressemblent, plus la recherche elle-même quand c'est un identifiant Discord,
 * qui ne passe par aucun profil.
 */
export async function resolveSearchedUserIds(
  guildId: string,
  search: string,
  limit: number,
): Promise<string[]> {
  const ids = new Set(await findProfileIdsByName(guildId, search, limit));
  if (/^\d{5,}$/.test(search)) ids.add(search);
  return [...ids];
}

export async function resolveMissingMemberIdentities(
  client: Client,
  guildId: string,
  userIds: string[],
): Promise<Map<string, MemberIdentity>> {
  const identities = new Map<string, MemberIdentity>();
  if (userIds.length === 0) return identities;

  const guild = client.guilds.cache.get(guildId);

  if (guild) {
    const uncached = userIds.filter((userId) => !guild.members.cache.has(userId));
    if (uncached.length > 0) {
      // Une seule requête de chunk pour tous les membres manquants encore présents.
      await withTimeout(guild.members.fetch({ user: uncached.slice(0, 100) }));
    }

    for (const userId of userIds) {
      const member = guild.members.cache.get(userId);
      if (!member) continue;
      identities.set(userId, {
        username: member.user.username,
        displayName: member.displayName ?? member.user.globalName ?? member.user.username,
        avatarUrl: resolveMemberAvatarUrl(member, 256),
        serverTag: serverTagOf(member.user),
        boostingSince: member.premiumSince?.toISOString() ?? null,
      });
    }
  }

  // Membres partis du serveur : seule l'API utilisateur peut encore les nommer.
  const stillMissing = userIds.filter((userId) => !identities.has(userId));
  if (stillMissing.length > 0) {
    const fetched = await Promise.all(
      stillMissing.map((userId) => withTimeout(client.users.fetch(userId))),
    );
    for (const user of fetched) {
      if (!user) continue;
      identities.set(user.id, {
        username: user.username,
        displayName: user.globalName ?? user.username,
        avatarUrl: resolveUserAvatarUrl(user, 256),
        serverTag: serverTagOf(user),
        // Parti du serveur : il ne le booste plus.
        boostingSince: null,
      });
    }
  }

  if (identities.size > 0) {
    void persistMemberIdentities(guildId, identities);
  }

  return identities;
}

async function persistMemberIdentities(
  guildId: string,
  identities: Map<string, MemberIdentity>,
): Promise<void> {
  for (const [userId, identity] of identities) {
    await prisma.memberProfile
      .updateMany({
        where: { guildId, userId, username: null },
        data: {
          username: identity.username,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        },
      })
      .catch((error) => {
        logger.warn('MemberIdentity', `Impossible de compléter l'identité de ${userId} sur ${guildId}:`, error);
      });
  }
}
