/**
 * Analyse des tags de serveur portes par les membres et fiche detaillee d'un serveur.
 */

import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { ensureServerTagSchemaPatches } from '../../utils/schemaPatches.js';
import {
  extractPrimaryGuildTag,
  guildIconUrl,
  guildTagBadgeUrl,
  resolveExternalGuild,
} from '../core/serverTagService.js';

export interface ServerTagServerSummary {
  guildId: string;
  name: string | null;
  iconUrl: string | null;
  tag: string | null;
  badgeUrl: string | null;
  count: number;
  share: number;
  isOwnGuild: boolean;
  botPresent: boolean;
}

export interface ServerTagMemberItem {
  userId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  tag: string;
  badgeUrl: string | null;
  serverId: string;
  serverName: string | null;
  isOwnGuild: boolean;
  updatedAt: string | null;
}

export interface ServerTagsAnalyticsResult {
  totalMembers: number;
  taggedMembers: number;
  ownGuildTagged: number;
  externalTagged: number;
  untaggedMembers: number;
  serverCount: number;
  ownGuild: {
    guildId: string;
    name: string;
    iconUrl: string | null;
    tag: string | null;
    badgeUrl: string | null;
    count: number;
  };
  servers: ServerTagServerSummary[];
  members: ServerTagMemberItem[];
}

export interface ServerDetailsAsset {
  id: string;
  kind: 'emoji' | 'sticker';
  name: string | null;
  animated: boolean;
  imageUrl: string;
  uses: number;
}

export interface ServerDetailsResult {
  server: {
    guildId: string;
    name: string | null;
    iconUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
    memberCount: number | null;
    onlineCount: number | null;
    tag: string | null;
    badgeUrl: string | null;
    isOwnGuild: boolean;
    botPresent: boolean;
    source: string;
  };
  tagHolders: {
    count: number;
    members: Array<{
      userId: string;
      name: string;
      username: string | null;
      avatarUrl: string | null;
      tag: string;
      badgeUrl: string | null;
      updatedAt: string | null;
    }>;
  };
  assets: {
    emojis: ServerDetailsAsset[];
    stickers: ServerDetailsAsset[];
    totalUses: number;
  };
}

/**
 * Calcule la repartition des tags de serveur sur la guilde.
 * Complete les profils en base avec les membres en cache Discord si besoin.
 */
export async function getServerTagAnalytics(
  client: Client,
  guildId: string,
  options?: { includeBots?: boolean },
): Promise<ServerTagsAnalyticsResult> {
  await ensureServerTagSchemaPatches();
  const includeBots = options?.includeBots === true;
  const guild = client.guilds.cache.get(guildId);

  let profiles: Array<{
    userId: string;
    displayName: string | null;
    globalName: string | null;
    username: string | null;
    avatarUrl: string | null;
    isBot: boolean;
    primaryGuildId: string | null;
    primaryGuildTag: string | null;
    primaryGuildBadge: string | null;
    primaryGuildUpdatedAt: Date | null;
  }> = [];

  try {
    profiles = await prisma.memberProfile.findMany({
      where: {
        guildId,
        guildLeftAt: null,
        ...(includeBots ? {} : { isBot: false }),
      },
      select: {
        userId: true,
        displayName: true,
        globalName: true,
        username: true,
        avatarUrl: true,
        isBot: true,
        primaryGuildId: true,
        primaryGuildTag: true,
        primaryGuildBadge: true,
        primaryGuildUpdatedAt: true,
      },
    });
  } catch {
    // Repli si les colonnes primaryGuild* n'existent pas encore en base
    const baseProfiles = await prisma.memberProfile.findMany({
      where: {
        guildId,
        guildLeftAt: null,
        ...(includeBots ? {} : { isBot: false }),
      },
      select: {
        userId: true,
        displayName: true,
        globalName: true,
        username: true,
        avatarUrl: true,
        isBot: true,
      },
    }).catch(() => []);
    profiles = baseProfiles.map((p) => ({
      ...p,
      primaryGuildId: null,
      primaryGuildTag: null,
      primaryGuildBadge: null,
      primaryGuildUpdatedAt: null,
    }));
  }

  // Rafraichit a la volee depuis le cache Discord pour les membres en ligne sans tag en base
  const merged = new Map<
    string,
    {
      userId: string;
      name: string;
      username: string | null;
      avatarUrl: string | null;
      tagGuildId: string | null;
      tag: string | null;
      badge: string | null;
      updatedAt: Date | null;
    }
  >();

  for (const p of profiles) {
    merged.set(p.userId, {
      userId: p.userId,
      name: p.displayName ?? p.globalName ?? p.username ?? `Utilisateur ${p.userId}`,
      username: p.username,
      avatarUrl: p.avatarUrl,
      tagGuildId: p.primaryGuildId,
      tag: p.primaryGuildTag,
      badge: p.primaryGuildBadge,
      updatedAt: p.primaryGuildUpdatedAt,
    });
  }

  if (guild) {
    for (const m of guild.members.cache.values()) {
      if (!includeBots && m.user.bot) continue;
      const liveTag = extractPrimaryGuildTag(m.user);
      const prev = merged.get(m.id);
      if (liveTag) {
        merged.set(m.id, {
          userId: m.id,
          name: m.displayName ?? m.user.globalName ?? m.user.username,
          username: m.user.username,
          avatarUrl: prev?.avatarUrl ?? m.displayAvatarURL({ size: 128 }),
          tagGuildId: liveTag.guildId,
          tag: liveTag.tag,
          badge: liveTag.badge,
          updatedAt: prev?.updatedAt ?? new Date(),
        });
      } else if (!prev) {
        merged.set(m.id, {
          userId: m.id,
          name: m.displayName ?? m.user.globalName ?? m.user.username,
          username: m.user.username,
          avatarUrl: m.displayAvatarURL({ size: 128 }),
          tagGuildId: null,
          tag: null,
          badge: null,
          updatedAt: null,
        });
      }
    }
  }

  const allEntries = [...merged.values()];
  const totalMembers = allEntries.length;
  const taggedEntries = allEntries.filter((e) => e.tagGuildId && e.tag);

  // Regroupement par serveur du tag
  const byServer = new Map<
    string,
    { guildId: string; tag: string | null; badge: string | null; count: number }
  >();

  for (const entry of taggedEntries) {
    const gId = entry.tagGuildId!;
    const existing = byServer.get(gId);
    if (existing) {
      existing.count += 1;
      if (!existing.tag && entry.tag) existing.tag = entry.tag;
      if (!existing.badge && entry.badge) existing.badge = entry.badge;
    } else {
      byServer.set(gId, {
        guildId: gId,
        tag: entry.tag,
        badge: entry.badge,
        count: 1,
      });
    }
  }

  // Resolution des noms/icones pour les serveurs les plus representes (plafonne a 40 pour eviter tout burst API)
  const sortedServers = [...byServer.values()].sort((a, b) => b.count - a.count);
  const topServerIds = sortedServers.slice(0, 40);
  const resolvedMap = new Map<string, Awaited<ReturnType<typeof resolveExternalGuild>>>();

  // D'abord lecture groupee en base pour tous les serveurs
  const dbGuilds = await prisma.discordExternalGuild.findMany({
    where: { guildId: { in: sortedServers.map((s) => s.guildId) } },
  }).catch(() => []);
  const dbGuildMap = new Map(dbGuilds.map((g) => [g.guildId, g]));

  await Promise.all(
    topServerIds.map(async (srv) => {
      const existing = dbGuildMap.get(srv.guildId);
      if (existing && Date.now() - existing.resolvedAt.getTime() < 6 * 60 * 60 * 1000) {
        resolvedMap.set(srv.guildId, {
          guildId: srv.guildId,
          name: existing.name,
          iconUrl: guildIconUrl(srv.guildId, existing.icon),
          bannerUrl: null,
          description: existing.description,
          memberCount: existing.memberCount,
          onlineCount: existing.onlineCount,
          tag: srv.tag ?? existing.tag,
          badge: srv.badge ?? existing.badge,
          badgeUrl: guildTagBadgeUrl(srv.guildId, srv.badge ?? existing.badge),
          botPresent: existing.botPresent || client.guilds.cache.has(srv.guildId),
          source: existing.source,
        });
        return;
      }
      const res = await resolveExternalGuild(client, srv.guildId, {
        tag: srv.tag,
        badge: srv.badge,
      });
      resolvedMap.set(srv.guildId, res);
    }),
  );

  const taggedMembers = taggedEntries.length;
  const ownGuildTagged = taggedEntries.filter((e) => e.tagGuildId === guildId).length;
  const externalTagged = taggedMembers - ownGuildTagged;
  const untaggedMembers = Math.max(0, totalMembers - taggedMembers);

  const servers: ServerTagServerSummary[] = sortedServers.map((srv) => {
    const resolved = resolvedMap.get(srv.guildId);
    const dbRow = dbGuildMap.get(srv.guildId);
    const isOwn = srv.guildId === guildId;
    const liveGuild = client.guilds.cache.get(srv.guildId);
    return {
      guildId: srv.guildId,
      name: liveGuild?.name ?? resolved?.name ?? dbRow?.name ?? null,
      iconUrl: liveGuild
        ? guildIconUrl(liveGuild.id, liveGuild.icon)
        : resolved?.iconUrl ?? guildIconUrl(srv.guildId, dbRow?.icon),
      tag: srv.tag ?? resolved?.tag ?? dbRow?.tag ?? null,
      badgeUrl: guildTagBadgeUrl(srv.guildId, srv.badge ?? resolved?.badge ?? dbRow?.badge),
      count: srv.count,
      share: taggedMembers > 0 ? Math.round((srv.count / taggedMembers) * 1000) / 10 : 0,
      isOwnGuild: isOwn,
      botPresent: isOwn || Boolean(liveGuild) || Boolean(resolved?.botPresent) || Boolean(dbRow?.botPresent),
    };
  });

  const serverNameById = new Map(servers.map((s) => [s.guildId, s.name]));

  const members: ServerTagMemberItem[] = taggedEntries
    .map((e) => ({
      userId: e.userId,
      name: e.name,
      username: e.username,
      avatarUrl: e.avatarUrl,
      tag: e.tag!,
      badgeUrl: guildTagBadgeUrl(e.tagGuildId, e.badge),
      serverId: e.tagGuildId!,
      serverName: serverNameById.get(e.tagGuildId!) ?? null,
      isOwnGuild: e.tagGuildId === guildId,
      updatedAt: e.updatedAt ? e.updatedAt.toISOString() : null,
    }))
    .sort((a, b) => {
      if (a.isOwnGuild !== b.isOwnGuild) return a.isOwnGuild ? -1 : 1;
      return a.name.localeCompare(b.name, 'fr');
    })
    .slice(0, 250);

  const ownSummary = servers.find((s) => s.isOwnGuild);

  return {
    totalMembers,
    taggedMembers,
    ownGuildTagged,
    externalTagged,
    untaggedMembers,
    serverCount: servers.length,
    ownGuild: {
      guildId,
      name: guild?.name ?? ownSummary?.name ?? 'Ce serveur',
      iconUrl: guild ? guildIconUrl(guild.id, guild.icon) : ownSummary?.iconUrl ?? null,
      tag: ownSummary?.tag ?? null,
      badgeUrl: ownSummary?.badgeUrl ?? null,
      count: ownGuildTagged,
    },
    servers,
    members,
  };
}

/**
 * Construit la fiche detaillee d'un serveur (externe ou courant) dans le contexte
 * du serveur actif : identite, membres portant son tag ici, emojis/stickers utilises.
 */
export async function getServerDetails(
  client: Client,
  currentGuildId: string,
  targetGuildId: string,
): Promise<ServerDetailsResult> {
  await ensureServerTagSchemaPatches();
  const [resolved, holders, assetRows] = await Promise.all([
    resolveExternalGuild(client, targetGuildId),
    prisma.memberProfile.findMany({
      where: {
        guildId: currentGuildId,
        primaryGuildId: targetGuildId,
        guildLeftAt: null,
        isBot: false,
      },
      select: {
        userId: true,
        displayName: true,
        globalName: true,
        username: true,
        avatarUrl: true,
        primaryGuildTag: true,
        primaryGuildBadge: true,
        primaryGuildUpdatedAt: true,
      },
      orderBy: { messageCount: 'desc' },
      take: 100,
    }).catch(() => []),
    prisma.discordAssetSource.findMany({
      where: { sourceGuildId: targetGuildId },
      select: { id: true, kind: true, name: true, animated: true },
      take: 120,
    }).catch(() => []),
  ]);

  const liveGuild = client.guilds.cache.get(targetGuildId);
  const bannerUrl = liveGuild?.bannerURL({ size: 1024 })
    ?? liveGuild?.discoverySplashURL({ size: 1024 })
    ?? liveGuild?.splashURL({ size: 1024 })
    ?? resolved.bannerUrl
    ?? null;

  // Comptage d'usage des emojis/stickers sur les 30 derniers jours sur le serveur actif
  const assetIds = assetRows.map((a) => a.id);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const usageRows = assetIds.length > 0
    ? await prisma.contentItemDailyStat.groupBy({
      by: ['key'],
      where: {
        guildId: currentGuildId,
        dateKey: { gte: thirtyDaysAgo },
        key: { in: assetIds },
      },
      _sum: { count: true },
    }).catch(() => [])
    : [];
  const usageMap = new Map(usageRows.map((r) => [r.key, r._sum?.count ?? 0]));

  const emojis: ServerDetailsAsset[] = [];
  const stickers: ServerDetailsAsset[] = [];

  for (const a of assetRows) {
    const uses = usageMap.get(a.id) ?? 0;
    if (a.kind === 'sticker') {
      stickers.push({
        id: a.id,
        kind: 'sticker',
        name: a.name,
        animated: a.animated,
        imageUrl: `https://media.discordapp.net/stickers/${a.id}.png?size=128`,
        uses,
      });
    } else {
      const ext = a.animated ? 'gif' : 'png';
      emojis.push({
        id: a.id,
        kind: 'emoji',
        name: a.name,
        animated: a.animated,
        imageUrl: `https://cdn.discordapp.com/emojis/${a.id}.${ext}?size=64`,
        uses,
      });
    }
  }

  emojis.sort((a, b) => b.uses - a.uses);
  stickers.sort((a, b) => b.uses - a.uses);
  const totalUses = [...emojis, ...stickers].reduce((sum, item) => sum + item.uses, 0);

  // Complete avec le cache Discord du serveur actif (ex: membres pas encore resynchronises en base)
  const mergedHolders = new Map<
    string,
    {
      userId: string;
      name: string;
      username: string | null;
      avatarUrl: string | null;
      tag: string | null;
      badge: string | null;
      updatedAt: Date | null;
    }
  >();

  for (const h of holders) {
    mergedHolders.set(h.userId, {
      userId: h.userId,
      name: h.displayName ?? h.globalName ?? h.username ?? `Utilisateur ${h.userId}`,
      username: h.username,
      avatarUrl: h.avatarUrl,
      tag: h.primaryGuildTag,
      badge: h.primaryGuildBadge,
      updatedAt: h.primaryGuildUpdatedAt,
    });
  }

  const currentGuild = client.guilds.cache.get(currentGuildId);
  if (currentGuild) {
    for (const m of currentGuild.members.cache.values()) {
      if (m.user.bot) continue;
      const liveTag = extractPrimaryGuildTag(m.user);
      if (liveTag?.guildId === targetGuildId) {
        const prev = mergedHolders.get(m.id);
        mergedHolders.set(m.id, {
          userId: m.id,
          name: m.displayName ?? m.user.globalName ?? m.user.username,
          username: m.user.username,
          avatarUrl: prev?.avatarUrl ?? m.displayAvatarURL({ size: 128 }),
          tag: liveTag.tag,
          badge: liveTag.badge,
          updatedAt: prev?.updatedAt ?? null,
        });
      } else if (liveTag !== null && mergedHolders.has(m.id)) {
        // Le membre a change de tag depuis la derniere synchro en base
        mergedHolders.delete(m.id);
      }
    }
  }

  const resolvedHolders = [...mergedHolders.values()].slice(0, 100);
  const firstHolder = resolvedHolders[0];
  const inferredTag = resolved.tag ?? firstHolder?.tag ?? null;
  const inferredBadgeUrl = resolved.badgeUrl ?? guildTagBadgeUrl(targetGuildId, firstHolder?.badge);

  return {
    server: {
      guildId: targetGuildId,
      name: resolved.name,
      iconUrl: resolved.iconUrl,
      bannerUrl,
      description: resolved.description,
      memberCount: resolved.memberCount,
      onlineCount: resolved.onlineCount,
      tag: inferredTag,
      badgeUrl: inferredBadgeUrl,
      isOwnGuild: targetGuildId === currentGuildId,
      botPresent: resolved.botPresent,
      source: resolved.source,
    },
    tagHolders: {
      count: mergedHolders.size,
      members: resolvedHolders.map((h) => ({
        userId: h.userId,
        name: h.name,
        username: h.username,
        avatarUrl: h.avatarUrl,
        tag: h.tag ?? inferredTag ?? '',
        badgeUrl: guildTagBadgeUrl(targetGuildId, h.badge) ?? inferredBadgeUrl,
        updatedAt: h.updatedAt ? h.updatedAt.toISOString() : null,
      })),
    },
    assets: {
      emojis: emojis.slice(0, 60),
      stickers: stickers.slice(0, 40),
      totalUses,
    },
  };
}

