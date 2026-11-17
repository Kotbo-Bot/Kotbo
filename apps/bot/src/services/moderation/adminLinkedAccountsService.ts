import type { Client } from 'discord.js';
import { LinkedAccountStatus, LinkedAccountType } from '@prisma/client';
import prisma from '../../utils/db.js';

/**
 * Vue globale des doubles comptes pour la console admin.
 *
 * Les liens `LinkedAccount` sont posés serveur par serveur. Ici on les fusionne :
 * deux comptes liés sur n'importe quel serveur, et tous ceux qui leur sont reliés
 * de proche en proche, forment un groupe. Les liens REJECTED (faux positif écarté
 * par un staff) ne relient rien.
 */

// shortcut: on ne charge que les MAX_LINKS liens les plus récents, à relever si la table dépasse ce volume.
const MAX_LINKS = 20_000;
const MAX_NAME_MATCHES = 100;

export type LinkedGroupAccount = {
  userId: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  guildCount: number;
};

export type LinkedGroupLink = {
  guildId: string;
  guildName: string;
  user1Id: string;
  user2Id: string;
  type: LinkedAccountType;
  status: LinkedAccountStatus;
  reason: string | null;
  createdAt: string;
};

export type LinkedGroup = {
  id: string;
  accounts: LinkedGroupAccount[];
  links: LinkedGroupLink[];
  guildCount: number;
  validatedCount: number;
  manualCount: number;
  lastLinkedAt: string;
};

export type LinkedGroupsResult = {
  groups: LinkedGroup[];
  total: number;
  totalAccounts: number;
  truncated: boolean;
};

type Row = {
  guildId: string;
  user1Id: string;
  user2Id: string;
  type: LinkedAccountType;
  status: LinkedAccountStatus;
  reason: string | null;
  createdAt: Date;
};

/** Composantes connexes du graphe des liens (union-find). */
export function groupLinks(rows: Row[]): Row[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const row of rows) {
    if (!parent.has(row.user1Id)) parent.set(row.user1Id, row.user1Id);
    if (!parent.has(row.user2Id)) parent.set(row.user2Id, row.user2Id);
    parent.set(find(row.user1Id), find(row.user2Id));
  }
  const byRoot = new Map<string, Row[]>();
  for (const row of rows) {
    const root = find(row.user1Id);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(row);
    else byRoot.set(root, [row]);
  }
  return [...byRoot.values()];
}

export async function listLinkedGroups(
  client: Client,
  opts: { search?: string; status?: 'VALIDATED' | 'PENDING'; minAccounts?: number; offset?: number; limit?: number },
): Promise<LinkedGroupsResult> {
  const rows = await prisma.linkedAccount.findMany({
    where: {
      status: opts.status ?? { not: LinkedAccountStatus.REJECTED },
    },
    select: { guildId: true, user1Id: true, user2Id: true, type: true, status: true, reason: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_LINKS,
  });

  let groups = groupLinks(rows.filter((r) => r.user1Id !== r.user2Id));

  const search = opts.search?.trim();
  if (search) {
    const matches = new Set<string>();
    if (/^\d{15,25}$/.test(search)) matches.add(search);
    const profiles = await prisma.memberProfile.findMany({
      where: {
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          { displayName: { contains: search, mode: 'insensitive' } },
          { userTag: { contains: search, mode: 'insensitive' } },
        ],
      },
      select: { userId: true },
      take: MAX_NAME_MATCHES,
    });
    for (const p of profiles) matches.add(p.userId);
    groups = groups.filter((g) => g.some((r) => matches.has(r.user1Id) || matches.has(r.user2Id)));
  }

  const accountsOf = (g: Row[]) => new Set(g.flatMap((r) => [r.user1Id, r.user2Id]));
  const minAccounts = Math.max(2, opts.minAccounts ?? 2);
  groups = groups.filter((g) => accountsOf(g).size >= minAccounts);

  // Les plus gros groupes d'abord : ce sont les plus suspects.
  groups.sort((a, b) => accountsOf(b).size - accountsOf(a).size || b[0].createdAt.getTime() - a[0].createdAt.getTime());

  const totalAccounts = new Set(groups.flatMap((g) => [...accountsOf(g)])).size;
  const offset = Math.max(0, opts.offset ?? 0);
  const page = groups.slice(offset, offset + Math.min(Math.max(opts.limit ?? 30, 1), 100));

  const userIds = [...new Set(page.flatMap((g) => [...accountsOf(g)]))];
  const profiles = userIds.length === 0 ? [] : await prisma.memberProfile.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, username: true, displayName: true, avatarUrl: true },
    distinct: ['userId'],
  });
  const profileById = new Map(profiles.map((p) => [p.userId, p]));
  const guildName = (id: string) => client.guilds.cache.get(id)?.name ?? id;

  return {
    total: groups.length,
    totalAccounts,
    truncated: rows.length >= MAX_LINKS,
    groups: page.map((g) => {
      const ids = [...accountsOf(g)];
      const guildsByUser = new Map<string, Set<string>>();
      for (const r of g) {
        for (const id of [r.user1Id, r.user2Id]) {
          const set = guildsByUser.get(id) ?? new Set();
          set.add(r.guildId);
          guildsByUser.set(id, set);
        }
      }
      return {
        id: [...ids].sort()[0],
        accounts: ids.map((userId) => {
          const p = profileById.get(userId);
          return {
            userId,
            name: p?.displayName ?? p?.username ?? null,
            username: p?.username ?? null,
            avatarUrl: p?.avatarUrl ?? null,
            guildCount: guildsByUser.get(userId)?.size ?? 0,
          };
        }),
        links: g.map((r) => ({
          guildId: r.guildId,
          guildName: guildName(r.guildId),
          user1Id: r.user1Id,
          user2Id: r.user2Id,
          type: r.type,
          status: r.status,
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
        })),
        guildCount: new Set(g.map((r) => r.guildId)).size,
        validatedCount: g.filter((r) => r.status === LinkedAccountStatus.VALIDATED).length,
        manualCount: g.filter((r) => r.type === LinkedAccountType.MANUAL).length,
        lastLinkedAt: g[0].createdAt.toISOString(),
      };
    }),
  };
}
