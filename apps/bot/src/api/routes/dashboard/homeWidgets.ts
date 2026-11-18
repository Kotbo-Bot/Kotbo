import os from 'node:os';
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import { logger } from '../../../utils/logger.js';
import { homeWidgetFeatureKey, isHomeWidgetAdminOnly } from '@kotbo/contracts';
import { type DashboardAccess, type FeatureAccessMap } from '../../shared.js';
import { getCachedFeatureAccess } from './featureGate.js';

import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';
const CACHE_TTL_SECONDS = 30;
const WINDOW_DAYS = 7;
const MAX_LIST_ITEMS = 5;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Un pourcentage CPU n'existe qu'entre deux relevés : on garde le précédent en
 * mémoire et on ne recalcule qu'au-delà d'une fenêtre assez large pour que le
 * ratio ne soit pas dominé par le bruit d'échantillonnage.
 */
const CPU_WINDOW_MS = 2_000;
let cpuSample: { at: number; usage: NodeJS.CpuUsage } | null = null;
let cpuPercent: number | null = null;

function readCpuPercent(): number | null {
  const now = Date.now();
  const usage = process.cpuUsage();
  const elapsedMs = cpuSample ? now - cpuSample.at : 0;

  if (cpuSample && elapsedMs >= CPU_WINDOW_MS) {
    const busyMs = (usage.user - cpuSample.usage.user + usage.system - cpuSample.usage.system) / 1000;
    const cores = Math.max(1, os.cpus().length);
    cpuPercent = Math.max(0, Math.min(100, Math.round((busyMs / (elapsedMs * cores)) * 100)));
  }

  if (!cpuSample || elapsedMs >= CPU_WINDOW_MS) {
    cpuSample = { at: now, usage };
  }

  return cpuPercent;
}

const SECTIONS = [
  'leveling',
  'invites',
  'economy',
  'tickets',
  'events',
  'polls',
  'serverInfo',
  'quickGuide',
  'hosting',
] as const;

type Section = (typeof SECTIONS)[number];

function parseSections(raw: string | null): Section[] {
  if (raw === null) return [...SECTIONS];
  const requested = new Set(raw.split(',').map((part) => part.trim()));
  return SECTIONS.filter((section) => requested.has(section));
}

/**
 * Une section refusee est retiree de la reponse, pas transformee en 403 : la
 * page d'accueil demande ses blocs en un seul appel, et refuser l'ensemble
 * priverait le lecteur des blocs auxquels il a droit.
 */
function allowedSections(
  sections: Section[],
  access: DashboardAccess,
  featureAccess: FeatureAccessMap,
): Section[] {
  return sections.filter((section) => {
    if (isHomeWidgetAdminOnly(section)) return access.canManageSettings;
    const featureKey = homeWidgetFeatureKey(section);
    if (!featureKey) return true;
    if (access.canManageSettings) return true;
    return featureAccess[featureKey]?.canView !== false;
  });
}

function percent(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function buildLeveling(guildId: string, since: Date) {
  const [config, aggregate, activeMembers] = await Promise.all([
    prisma.levelConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
    prisma.memberLevel.aggregate({
      where: { guildId },
      _avg: { level: true },
      _max: { level: true },
      _count: { _all: true },
    }),
    prisma.memberLevel.count({ where: { guildId, lastXpGain: { gte: since } } }),
  ]);

  const averageLevel = aggregate._avg.level;
  return {
    enabled: config?.enabled ?? false,
    rankedMembers: aggregate._count._all,
    averageLevel: averageLevel === null ? null : Math.round(averageLevel * 10) / 10,
    topLevel: aggregate._max.level ?? null,
    activeMembers: activeMembers,
  };
}

async function buildInvites(guildId: string, since: Date) {
  const [activeCodes, totalJoined, totalLeft, joined] = await Promise.all([
    prisma.guildInvite.count({ where: { guildId, isDeleted: false } }),
    prisma.memberInvite.count({ where: { guildId } }),
    prisma.memberInvite.count({ where: { guildId, leftAt: { not: null } } }),
    prisma.memberInvite.count({ where: { guildId, joinedAt: { gte: since } } }),
  ]);

  return {
    activeCodes,
    totalJoined,
    totalLeft,
    joinedRecently: joined,
    retentionPercent: percent(totalJoined - totalLeft, totalJoined),
  };
}

async function buildEconomy(guildId: string, since: Date) {
  const [config, aggregate, activePlayers] = await Promise.all([
    prisma.economyConfig.findUnique({
      where: { guildId },
      select: { enabled: true, currencyName: true, currencyEmoji: true },
    }),
    prisma.rpgProfile.aggregate({
      where: { guildId },
      _sum: { balance: true },
      _count: { _all: true },
    }),
    prisma.rpgProfile.count({ where: { guildId, updatedAt: { gte: since } } }),
  ]);

  return {
    enabled: config?.enabled ?? false,
    currencyName: config?.currencyName ?? null,
    currencyEmoji: config?.currencyEmoji ?? null,
    totalBalance: aggregate._sum.balance ?? 0,
    players: aggregate._count._all,
    activePlayers,
  };
}

async function buildTickets(guildId: string, since: Date) {
  const [open, claimed, closedRecently] = await Promise.all([
    prisma.ticket.count({ where: { guildId, status: 'OPEN' } }),
    prisma.ticket.count({ where: { guildId, status: 'CLAIMED' } }),
    prisma.ticket.count({ where: { guildId, status: 'CLOSED', closedAt: { gte: since } } }),
  ]);

  return { open, claimed, closedRecently };
}

async function buildEvents(guildId: string) {
  const rows = await prisma.event.findMany({
    where: { guildId, status: { in: ['PUBLISHED', 'ONGOING'] } },
    orderBy: { createdAt: 'desc' },
    take: MAX_LIST_ITEMS * 2,
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      triggerType: true,
      triggerValue: true,
    },
  });

  const upcoming = rows
    .map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      status: row.status,
      startsAt: row.triggerType === 'SCHEDULED' ? toIsoDate(row.triggerValue) : null,
    }))
    // Les événements datés passent devant, du plus proche au plus lointain ; les
    // autres (déclenchement par palier de membres) ferment la liste.
    .sort((a, b) => {
      if (a.startsAt && b.startsAt) return a.startsAt.localeCompare(b.startsAt);
      if (a.startsAt) return -1;
      if (b.startsAt) return 1;
      return 0;
    })
    .slice(0, MAX_LIST_ITEMS);

  return { total: rows.length, upcoming };
}

async function buildPolls(guildId: string) {
  const [openCount, rows] = await Promise.all([
    prisma.staffPoll.count({ where: { guildId, status: 'OPEN' } }),
    prisma.staffPoll.findMany({
      where: { guildId, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: MAX_LIST_ITEMS,
      select: {
        id: true,
        title: true,
        closesAt: true,
        _count: { select: { votes: true } },
      },
    }),
  ]);

  return {
    openCount,
    open: rows.map((row) => ({
      id: row.id,
      title: row.title,
      closesAt: row.closesAt ? row.closesAt.toISOString() : null,
      voteCount: row._count.votes,
    })),
  };
}

async function buildServerInfo(client: Client, guildId: string) {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    return {
      name: null,
      memberCount: null,
      boostLevel: null,
      boostCount: null,
      ownerTag: null,
      createdAt: null,
    };
  }

  const owner = guild.members.cache.get(guild.ownerId) ?? (await guild.fetchOwner().catch(() => null));

  return {
    name: guild.name,
    memberCount: guild.memberCount,
    // `premiumTier` est une enum numérique dont la valeur est le palier lui-même.
    boostLevel: Number(guild.premiumTier),
    boostCount: guild.premiumSubscriptionCount ?? 0,
    ownerTag: owner?.user?.tag ?? owner?.displayName ?? null,
    createdAt: guild.createdAt ? guild.createdAt.toISOString() : null,
  };
}

async function buildQuickGuide(client: Client, guildId: string) {
  const [settings, staffRoles] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { logChannelId: true, ticketChannelId: true, ticketCategoryId: true },
    }),
    prisma.staffRole.count({ where: { guildId, enabled: true } }),
  ]);

  return {
    botInvited: client.guilds.cache.has(guildId),
    logsConfigured: Boolean(settings?.logChannelId),
    ticketsConfigured: Boolean(settings?.ticketChannelId || settings?.ticketCategoryId),
    staffRolesConfigured: staffRoles > 0,
  };
}

function buildHosting(client: Client) {
  const memory = process.memoryUsage();
  return {
    cpuPercent: readCpuPercent(),
    memoryUsedMb: Math.round(memory.rss / BYTES_PER_MB),
    memoryTotalMb: Math.round(os.totalmem() / BYTES_PER_MB),
    latencyMs: Math.max(0, Math.round(client.ws.ping || 0)),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function createHomeWidgetsRouter(client: Client) {
  const router = new Hono();

  router.get('/api/dashboard/guilds/:guildId/home-widgets', ...guildRoute(client, { invalidateCache: false }), async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const featureAccess = await getCachedFeatureAccess(client, guildId, access, c.var.dashboardUser.userId);
    const sections = allowedSections(parseSections(c.req.query('sections') ?? null), access, featureAccess);

    try {
      // L'état d'hébergement est une lecture process, pas une requête : le mettre
      // en cache n'apporterait rien et le rendrait faux jusqu'à 30 s.
      const hosting = sections.includes('hosting') ? buildHosting(client) : undefined;

      const persisted = sections.filter((section) => section !== 'hosting');
      let payload: Record<string, unknown> = {};

      if (persisted.length > 0) {
        const cacheKey = `guild:${guildId}:home-widgets:${persisted.join(',')}`;
        const cached = await cache.get<Record<string, unknown>>(cacheKey);
        if (cached) {
          payload = cached;
        } else {
          const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
          const builders: Array<[Section, Promise<unknown>]> = [];

          for (const section of persisted) {
            switch (section) {
              case 'leveling': builders.push([section, buildLeveling(guildId, since)]); break;
              case 'invites': builders.push([section, buildInvites(guildId, since)]); break;
              case 'economy': builders.push([section, buildEconomy(guildId, since)]); break;
              case 'tickets': builders.push([section, buildTickets(guildId, since)]); break;
              case 'events': builders.push([section, buildEvents(guildId)]); break;
              case 'polls': builders.push([section, buildPolls(guildId)]); break;
              case 'serverInfo': builders.push([section, buildServerInfo(client, guildId)]); break;
              case 'quickGuide': builders.push([section, buildQuickGuide(client, guildId)]); break;
            }
          }

          // Une section qui échoue ne doit pas vider toute la page d'accueil : les
          // autres widgets restent alimentés et celui-ci retombe sur son état vide.
          const results = await Promise.allSettled(builders.map(([, promise]) => promise));
          builders.forEach(([section], index) => {
            const result = results[index];
            if (result.status === 'fulfilled') {
              payload[section] = result.value;
            } else {
              logger.error('HomeWidgetsAPI', `Section ${section} failed:`, result.reason);
            }
          });

          await cache.set(cacheKey, payload, CACHE_TTL_SECONDS);
        }
      }

      return send(c, {
        ...payload,
        ...(hosting ? { hosting } : {}),
        windowDays: WINDOW_DAYS,
      });
    } catch (err) {
      logger.error('HomeWidgetsAPI', 'Error building home widgets data:', err);
      return fail(c, err, 'Erreur lors de la récupération des widgets', 'HomeWidgetsAPI');
    }
  });

  return router;
}
