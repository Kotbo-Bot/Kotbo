/**
 * Base de detection des tags de serveur et registre des serveurs Discord.
 *
 * Centralise :
 *  1. La lecture normalisee de `user.primaryGuild` (tag, badge, serveur source) ;
 *  2. La detection fiable des changements de tag (pose, retrait, changement) ;
 *  3. La resolution et la persistance des metadonnees des serveurs (serveurs tiers
 *     vus via tags/emojis/stickers et serveurs visites par Kotbo, conserves
 *     jusqu'a 3 ans apres son depart).
 */

import type { Client, Guild, GuildMember, PartialUser, User } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export const SERVER_DATA_RETENTION_DAYS = 365 * 3;
const EXTERNAL_GUILD_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_FETCH_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 25_000;

export type ExtractedServerTag = {
  guildId: string;
  tag: string;
  badge: string | null;
  badgeUrl: string | null;
};

export type ResolvedExternalGuild = {
  guildId: string;
  name: string | null;
  iconUrl: string | null;
  description: string | null;
  memberCount: number | null;
  onlineCount: number | null;
  tag: string | null;
  badge: string | null;
  badgeUrl: string | null;
  botPresent: boolean;
  source: string;
};

type CachedTagState = {
  guildId: string | null;
  tag: string | null;
  badge: string | null;
};

const tagStateCache = new Map<string, CachedTagState>();
const guildNameCache = new Map<string, string>();
const failedRemoteFetchAt = new Map<string, number>();

export function guildTagBadgeUrl(
  guildId: string | null | undefined,
  badge: string | null | undefined,
): string | null {
  if (!guildId || !badge) return null;
  return `https://cdn.discordapp.com/clan-badges/${guildId}/${badge}.png`;
}

export function guildIconUrl(
  guildId: string | null | undefined,
  icon: string | null | undefined,
): string | null {
  if (!guildId || !icon) return null;
  if (icon.startsWith('http://') || icon.startsWith('https://')) return icon;
  const ext = icon.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.${ext}?size=128`;
}

type PrimaryGuildLike = {
  identityGuildId?: string | null;
  identityEnabled?: boolean | null;
  tag?: string | null;
  badge?: string | null;
};

export function extractPrimaryGuildTag(
  user: { primaryGuild?: PrimaryGuildLike | null } | null | undefined,
): ExtractedServerTag | null {
  const pg = user?.primaryGuild;
  if (!pg || pg.identityEnabled !== true || !pg.identityGuildId || !pg.tag) {
    return null;
  }
  return {
    guildId: pg.identityGuildId,
    tag: pg.tag,
    badge: pg.badge ?? null,
    badgeUrl: guildTagBadgeUrl(pg.identityGuildId, pg.badge),
  };
}

function setTagCache(key: string, state: CachedTagState): void {
  if (tagStateCache.size >= MAX_CACHE_ENTRIES) {
    tagStateCache.clear();
  }
  tagStateCache.set(key, state);
}

function sameTagState(a: CachedTagState, b: CachedTagState): boolean {
  return a.guildId === b.guildId && a.tag === b.tag && a.badge === b.badge;
}

/**
 * Enregistre ou met a jour la fiche d'un serveur ou Kotbo est present ou vient de partir.
 * Les donnees sont conservees jusqu'a 3 ans apres le depart du bot.
 */
export async function recordBotGuildSnapshot(guild: Guild, botPresent: boolean): Promise<void> {
  if (!guild?.id || !guild.name) return;
  guildNameCache.set(guild.id, guild.name);
  const now = new Date();
  await prisma.discordExternalGuild.upsert({
    where: { guildId: guild.id },
    create: {
      guildId: guild.id,
      name: guild.name,
      icon: guild.icon ?? null,
      description: guild.description ?? null,
      memberCount: guild.memberCount ?? null,
      onlineCount: guild.approximatePresenceCount ?? null,
      source: 'bot',
      botPresent,
      botLeftAt: botPresent ? null : now,
      lastSeenAt: now,
      resolvedAt: now,
    },
    update: {
      name: guild.name,
      icon: guild.icon ?? null,
      description: guild.description ?? undefined,
      memberCount: guild.memberCount ?? undefined,
      onlineCount: guild.approximatePresenceCount ?? undefined,
      botPresent,
      botLeftAt: botPresent ? null : now,
      lastSeenAt: now,
      resolvedAt: now,
    },
  }).catch((err) => {
    logger.debug('ServerTag', `Echec sauvegarde fiche serveur ${guild.id}: ${String(err)}`);
  });
}

/**
 * Resout les noms d'un lot de serveurs (cache Discord -> base persistee -> assets).
 * Evite d'afficher "Serveur <id>" lorsque le bot a quitte un serveur.
 */
export async function getKnownGuildNames(
  client: Client,
  guildIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const missing: string[] = [];

  for (const id of guildIds) {
    if (!id) continue;
    const live = client.guilds?.cache?.get(id);
    if (live?.name) {
      guildNameCache.set(id, live.name);
      result.set(id, live.name);
      continue;
    }
    const mem = guildNameCache.get(id);
    if (mem) {
      result.set(id, mem);
      continue;
    }
    missing.push(id);
  }

  if (missing.length === 0) return result;

  const uniqueMissing = [...new Set(missing)];
  const rows = await prisma.discordExternalGuild.findMany({
    where: { guildId: { in: uniqueMissing } },
    select: { guildId: true, name: true },
  }).catch(() => []);

  for (const row of rows) {
    if (row.name) {
      guildNameCache.set(row.guildId, row.name);
      result.set(row.guildId, row.name);
    }
  }

  const stillMissing = uniqueMissing.filter((id) => !result.has(id));
  if (stillMissing.length > 0) {
    const assetRows = await prisma.discordAssetSource.findMany({
      where: { sourceGuildId: { in: stillMissing }, sourceGuildName: { not: null } },
      select: { sourceGuildId: true, sourceGuildName: true },
      distinct: ['sourceGuildId'],
    }).catch(() => []);

    for (const row of assetRows) {
      if (row.sourceGuildId && row.sourceGuildName) {
        guildNameCache.set(row.sourceGuildId, row.sourceGuildName);
        result.set(row.sourceGuildId, row.sourceGuildName);
      }
    }
  }

  return result;
}

/**
 * Resout et met en cache les informations d'un serveur Discord (present ou externe).
 */
export async function resolveExternalGuild(
  client: Client,
  targetGuildId: string,
  hint?: { tag?: string | null; badge?: string | null },
): Promise<ResolvedExternalGuild> {
  const live = client.guilds?.cache?.get(targetGuildId);
  if (live) {
    guildNameCache.set(live.id, live.name);
    const now = new Date();
    const saved = await prisma.discordExternalGuild.upsert({
      where: { guildId: live.id },
      create: {
        guildId: live.id,
        name: live.name,
        icon: live.icon ?? null,
        description: live.description ?? null,
        memberCount: live.memberCount ?? null,
        onlineCount: live.approximatePresenceCount ?? null,
        tag: hint?.tag ?? null,
        badge: hint?.badge ?? null,
        source: 'cache',
        botPresent: true,
        botLeftAt: null,
        lastSeenAt: now,
        resolvedAt: now,
      },
      update: {
        name: live.name,
        icon: live.icon ?? null,
        description: live.description ?? undefined,
        memberCount: live.memberCount ?? undefined,
        onlineCount: live.approximatePresenceCount ?? undefined,
        ...(hint?.tag ? { tag: hint.tag } : {}),
        ...(hint?.badge ? { badge: hint.badge } : {}),
        source: 'cache',
        botPresent: true,
        botLeftAt: null,
        lastSeenAt: now,
        resolvedAt: now,
      },
    }).catch(() => null);

    return {
      guildId: live.id,
      name: live.name,
      iconUrl: guildIconUrl(live.id, live.icon),
      description: live.description ?? null,
      memberCount: live.memberCount ?? null,
      onlineCount: live.approximatePresenceCount ?? null,
      tag: saved?.tag ?? hint?.tag ?? null,
      badge: saved?.badge ?? hint?.badge ?? null,
      badgeUrl: guildTagBadgeUrl(live.id, saved?.badge ?? hint?.badge),
      botPresent: true,
      source: 'cache',
    };
  }

  const existing = await prisma.discordExternalGuild.findUnique({
    where: { guildId: targetGuildId },
  }).catch(() => null);

  if (existing && Date.now() - existing.resolvedAt.getTime() < EXTERNAL_GUILD_TTL_MS) {
    if ((hint?.tag && hint.tag !== existing.tag) || (hint?.badge && hint.badge !== existing.badge)) {
      await prisma.discordExternalGuild.update({
        where: { guildId: targetGuildId },
        data: {
          ...(hint?.tag ? { tag: hint.tag } : {}),
          ...(hint?.badge ? { badge: hint.badge } : {}),
          lastSeenAt: new Date(),
        },
      }).catch(() => null);
    }
    return {
      guildId: targetGuildId,
      name: existing.name,
      iconUrl: guildIconUrl(targetGuildId, existing.icon),
      description: existing.description,
      memberCount: existing.memberCount,
      onlineCount: existing.onlineCount,
      tag: hint?.tag ?? existing.tag,
      badge: hint?.badge ?? existing.badge,
      badgeUrl: guildTagBadgeUrl(targetGuildId, hint?.badge ?? existing.badge),
      botPresent: existing.botPresent,
      source: existing.source,
    };
  }

  // Fallback 1 : source deja resolue via les emojis/stickers
  const assetSource = await prisma.discordAssetSource.findFirst({
    where: { sourceGuildId: targetGuildId, sourceGuildName: { not: null } },
    select: { sourceGuildName: true, sourceGuildIcon: true },
  }).catch(() => null);

  let name: string | null = assetSource?.sourceGuildName ?? existing?.name ?? null;
  let icon: string | null = assetSource?.sourceGuildIcon ?? existing?.icon ?? null;
  let description: string | null = existing?.description ?? null;
  let memberCount: number | null = existing?.memberCount ?? null;
  let onlineCount: number | null = existing?.onlineCount ?? null;
  let source = assetSource?.sourceGuildName ? 'asset' : existing?.source ?? 'tag';

  // Fallback 2 : preview publique Discord (ou widget JSON) avec circuit-breaker
  const lastFailed = failedRemoteFetchAt.get(targetGuildId) ?? 0;
  if (Date.now() - lastFailed > NEGATIVE_FETCH_TTL_MS) {
    let remoteResolved = false;
    try {
      const preview = await client.fetchGuildPreview(targetGuildId);
      name = preview.name;
      icon = preview.icon ?? icon;
      description = preview.description ?? description;
      memberCount = preview.approximateMemberCount ?? memberCount;
      onlineCount = preview.approximatePresenceCount ?? onlineCount;
      source = 'preview';
      remoteResolved = true;
    } catch {
      // Serveur non decouvrable : tenter le widget public s'il est active
      try {
        const res = await fetch(`https://discord.com/api/v10/guilds/${targetGuildId}/widget.json`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const widget = (await res.json()) as { name?: string; presence_count?: number };
          if (widget.name) {
            name = widget.name;
            onlineCount = typeof widget.presence_count === 'number' ? widget.presence_count : onlineCount;
            source = 'widget';
            remoteResolved = true;
          }
        }
      } catch {
        // Ignore : serveur prive
      }
    }
    if (!remoteResolved) {
      failedRemoteFetchAt.set(targetGuildId, Date.now());
    }
  }

  if (name) {
    guildNameCache.set(targetGuildId, name);
    const now = new Date();
    await prisma.discordExternalGuild.upsert({
      where: { guildId: targetGuildId },
      create: {
        guildId: targetGuildId,
        name,
        icon,
        description,
        memberCount,
        onlineCount,
        tag: hint?.tag ?? null,
        badge: hint?.badge ?? null,
        source,
        botPresent: false,
        lastSeenAt: now,
        resolvedAt: now,
      },
      update: {
        name,
        icon,
        description,
        memberCount,
        onlineCount,
        ...(hint?.tag ? { tag: hint.tag } : {}),
        ...(hint?.badge ? { badge: hint.badge } : {}),
        source,
        lastSeenAt: now,
        resolvedAt: now,
      },
    }).catch(() => null);
  }

  const finalTag = hint?.tag ?? existing?.tag ?? null;
  const finalBadge = hint?.badge ?? existing?.badge ?? null;

  return {
    guildId: targetGuildId,
    name,
    iconUrl: guildIconUrl(targetGuildId, icon),
    description,
    memberCount,
    onlineCount,
    tag: finalTag,
    badge: finalBadge,
    badgeUrl: guildTagBadgeUrl(targetGuildId, finalBadge),
    botPresent: false,
    source,
  };
}

/**
 * Synchronise le tag de serveur d'un membre en base et publie `member:tag` s'il a change.
 */
export async function syncMemberServerTag(
  client: Client,
  member: GuildMember,
  options?: { emitChanges?: boolean },
): Promise<void> {
  if (!member?.guild?.id || !member.user || member.user.bot) return;

  const guildId = member.guild.id;
  const userId = member.id;
  const cacheKey = `${guildId}:${userId}`;
  const current = extractPrimaryGuildTag(member.user);
  const nextState: CachedTagState = {
    guildId: current?.guildId ?? null,
    tag: current?.tag ?? null,
    badge: current?.badge ?? null,
  };

  let previous = tagStateCache.get(cacheKey);
  if (previous === undefined) {
    const existing = await prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { primaryGuildId: true, primaryGuildTag: true, primaryGuildBadge: true },
    }).catch(() => null);

    if (existing) {
      previous = {
        guildId: existing.primaryGuildId ?? null,
        tag: existing.primaryGuildTag ?? null,
        badge: existing.primaryGuildBadge ?? null,
      };
      setTagCache(cacheKey, previous);
    }
  }

  if (previous && sameTagState(previous, nextState)) {
    return;
  }

  const now = new Date();
  setTagCache(cacheKey, nextState);

  await prisma.memberProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: {
      guildId,
      userId,
      userTag: member.user.tag,
      username: member.user.username,
      globalName: member.user.globalName ?? null,
      displayName: member.displayName,
      isBot: member.user.bot,
      primaryGuildId: nextState.guildId,
      primaryGuildTag: nextState.tag,
      primaryGuildBadge: nextState.badge,
      primaryGuildUpdatedAt: now,
    },
    update: {
      primaryGuildId: nextState.guildId,
      primaryGuildTag: nextState.tag,
      primaryGuildBadge: nextState.badge,
      primaryGuildUpdatedAt: now,
    },
  }).catch((err) => {
    logger.debug('ServerTag', `Echec maj tag membre ${userId} sur ${guildId}: ${String(err)}`);
  });

  if (nextState.guildId && nextState.tag) {
    void resolveExternalGuild(client, nextState.guildId, {
      tag: nextState.tag,
      badge: nextState.badge,
    });
  }

  const emit = options?.emitChanges !== false;
  // Si aucun etat precedent n'existait en base, on n'emet que si un tag est effectivement pose.
  const hadBaseline = previous !== undefined;
  const changedFromEmpty = !hadBaseline && nextState.tag !== null;
  if (emit && (hadBaseline || changedFromEmpty)) {
    kotboEventBus.publish('member:tag', {
      guildId,
      userId,
      userTag: member.user.tag,
      oldGuildId: previous?.guildId ?? null,
      oldTag: previous?.tag ?? null,
      oldBadge: previous?.badge ?? null,
      newGuildId: nextState.guildId,
      newTag: nextState.tag,
      newBadge: nextState.badge,
      isOwnGuild: nextState.guildId === guildId,
      timestamp: Date.now(),
    });
  }
}

/**
 * Traite une mise a jour `Events.UserUpdate` pour tous les serveurs ou l'utilisateur est en cache.
 */
export async function handleUserTagUpdate(
  client: Client,
  _oldUser: User | PartialUser,
  newUser: User,
): Promise<void> {
  if (newUser.bot) return;
  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(newUser.id);
    if (!member) continue;
    await syncMemberServerTag(client, member, { emitChanges: true });
  }
}

/**
 * Purge les fiches de serveurs externes/quittes inactives depuis plus de 3 ans
 * et qui ne sont plus referencees par aucun membre actif.
 */
export async function cleanupExpiredExternalGuilds(): Promise<number> {
  const cutoff = new Date(Date.now() - SERVER_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const activeTagGuilds = await prisma.memberProfile.findMany({
    where: { primaryGuildId: { not: null }, guildLeftAt: null },
    select: { primaryGuildId: true },
    distinct: ['primaryGuildId'],
  }).catch(() => []);
  const keepIds = activeTagGuilds
    .map((r) => r.primaryGuildId)
    .filter((id): id is string => Boolean(id));

  const res = await prisma.discordExternalGuild.deleteMany({
    where: {
      botPresent: false,
      lastSeenAt: { lt: cutoff },
      ...(keepIds.length > 0 ? { guildId: { notIn: keepIds } } : {}),
    },
  }).catch(() => ({ count: 0 }));

  return res.count;
}

