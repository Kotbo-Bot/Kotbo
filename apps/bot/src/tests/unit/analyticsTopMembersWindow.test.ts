/**
 * analyticsTopMembersWindow.test.ts
 *
 * Reproduit et verrouille le correctif du bug remonte par Toji : sur les
 * statistiques a fenetre glissante, le top messages/vocal des MEMBRES lisait
 * `memberProfile.messageCount` / `voiceTimeSeconds`, des compteurs A VIE,
 * jamais fenetres — alors que le top des SALONS, lui, etait bien fenetre via
 * `channelDailyStat`. Un membre pouvait donc ressortir avec plus de messages
 * sur 7 jours que le salon le plus actif n'en contenait sur la meme periode.
 *
 * Le correctif fenetre les deux classements via `memberDailyStat`, en
 * joignant `memberProfile` APRES coup (memberDailyStat n'a pas `isBot`).
 */

import { describe, expect, mock, test, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

// ── Fixtures configurables par test ────────────────────────────────────────
type ChannelDailyRow = { channelId: string; dateKey: string; messagesCount?: number; voiceMinutes?: number };
type MemberDailyRow = { userId: string; dateKey: string; messagesCount?: number; voiceMinutes?: number };
type ProfileRow = {
  userId: string;
  isBot?: boolean;
  messageCount?: number; // cumul a vie (ancien chemin bugue)
  voiceTimeSeconds?: number; // cumul a vie (ancien chemin bugue)
  voiceSessionCount?: number;
  displayName?: string | null;
  username?: string | null;
  globalName?: string | null;
  avatarUrl?: string | null;
  lastMessageAt?: Date | null;
};

let channelRows: ChannelDailyRow[] = [];
let memberRows: MemberDailyRow[] = [];
let profiles: ProfileRow[] = [];

beforeEach(() => {
  channelRows = [];
  memberRows = [];
  profiles = [];
});

/** Simule un `groupBy` Prisma : filtre par fenetre de dateKey (+ un eventuel filtre `{gt}` additionnel), somme, trie desc, applique `take`. */
function makeDailyGroupBySim(getRows: () => Array<Record<string, unknown>>, idField: string) {
  return mock(async (args: any) => {
    const dk = args?.where?.dateKey ?? {};
    let filtered = getRows().filter((r: any) =>
      (!dk.gte || r.dateKey >= dk.gte) && (!dk.lte || r.dateKey <= dk.lte));

    for (const key of Object.keys(args?.where ?? {})) {
      if (key === 'guildId' || key === 'dateKey') continue;
      const cond = args.where[key];
      if (cond && typeof cond === 'object' && 'gt' in cond) {
        filtered = filtered.filter((r: any) => (r[key] ?? 0) > cond.gt);
      }
      if (cond && typeof cond === 'object' && 'notIn' in cond) {
        const excluded = new Set(cond.notIn as unknown[]);
        filtered = filtered.filter((r: any) => !excluded.has(r[key]));
      }
    }

    const sumKey = Object.keys(args._sum)[0];
    const sums = new Map<string, number>();
    for (const r of filtered as any[]) {
      sums.set(r[idField], (sums.get(r[idField]) ?? 0) + (r[sumKey] ?? 0));
    }
    let result = [...sums.entries()].map(([id, sum]) => ({ [idField]: id, _sum: { [sumKey]: sum } }));
    result.sort((a: any, b: any) => b._sum[sumKey] - a._sum[sumKey]);
    if (args?.take) result = result.slice(0, args.take);
    return result;
  });
}

/** Simule `memberProfile.findMany` pour les differents chemins possibles : la
 * liste des bots du serveur (`isBot: true`, lue en amont pour le plafond), le
 * batch (`userId: {in: [...]}`, post-correctif) et l'ancien classement direct
 * sur le cumul a vie (`messageCount`/`voiceTimeSeconds` `{gt: ...}`, pre-correctif). */
const memberProfileFindMany = mock(async (args: any) => {
  if (args?.where?.isBot === true && !args?.where?.userId) {
    return profiles.filter(p => p.isBot).map(p => ({ userId: p.userId }));
  }

  const ids: string[] | undefined = args?.where?.userId?.in;
  if (ids) {
    return profiles
      .filter(p => ids.includes(p.userId))
      .map(p => ({
        userId: p.userId,
        isBot: p.isBot ?? false,
        displayName: p.displayName ?? null,
        username: p.username ?? null,
        globalName: p.globalName ?? null,
        avatarUrl: p.avatarUrl ?? null,
        lastMessageAt: p.lastMessageAt ?? null,
        voiceSessionCount: p.voiceSessionCount ?? 0,
      }));
  }

  if (args?.where?.messageCount?.gt !== undefined) {
    return profiles
      .filter(p => !p.isBot && (p.messageCount ?? 0) > args.where.messageCount.gt)
      .sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0))
      .slice(0, args?.take ?? profiles.length)
      .map(p => ({
        userId: p.userId,
        displayName: p.displayName ?? null,
        username: p.username ?? null,
        globalName: p.globalName ?? null,
        avatarUrl: p.avatarUrl ?? null,
        messageCount: p.messageCount ?? 0,
        lastMessageAt: p.lastMessageAt ?? null,
      }));
  }

  if (args?.where?.voiceTimeSeconds?.gt !== undefined) {
    return profiles
      .filter(p => !p.isBot && (p.voiceTimeSeconds ?? 0) > args.where.voiceTimeSeconds.gt)
      .sort((a, b) => (b.voiceTimeSeconds ?? 0) - (a.voiceTimeSeconds ?? 0))
      .slice(0, args?.take ?? profiles.length)
      .map(p => ({
        userId: p.userId,
        displayName: p.displayName ?? null,
        username: p.username ?? null,
        globalName: p.globalName ?? null,
        avatarUrl: p.avatarUrl ?? null,
        voiceTimeSeconds: p.voiceTimeSeconds ?? 0,
        voiceSessionCount: p.voiceSessionCount ?? 0,
      }));
  }

  return [];
});

const mockDb: any = {
  guildDailyStat: { findMany: mock(async () => []) },
  guildHourlyStat: { findMany: mock(async () => []) },
  channelDailyStat: { groupBy: makeDailyGroupBySim(() => channelRows, 'channelId') },
  memberDailyStat: { groupBy: makeDailyGroupBySim(() => memberRows, 'userId') },
  memberProfile: { findMany: memberProfileFindMany, count: mock(async () => 0) },
  sanction: { findMany: mock(async () => []), count: mock(async () => 0) },
  sanctionReport: { findMany: mock(async () => []) },
  staffActivity: { findMany: mock(async () => []) },
  staffAbsence: { count: mock(async () => 0) },
  staffMember: { count: mock(async () => 0), findMany: mock(async () => []) },
  staffMeeting: { findMany: mock(async () => []) },
  recruitmentCandidature: { groupBy: mock(async () => []) },
  memberInvite: { groupBy: mock(async () => []), findMany: mock(async () => []) },
  dashboardCommandUsage: { findMany: mock(async () => []) },
  guild: { findUnique: mock(async () => null) },
  // La repartition par role est agregee par Postgres (unnest + GROUP BY) :
  // elle ne passe par aucun modele Prisma, ces tests ne la couvrent pas.
  $queryRaw: mock(async () => []),
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

// Importe APRES les mock.module (meme convention que dashboardApi.test.ts).
import { DASHBOARD_ACCESS_ADMIN } from '../../api/shared.js';
import { dashboardCall, mockDashboardGate } from '../helpers/honoDashboard.js';

mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: 'viewer', username: 'viewer' });
const { createAnalyticsRouter } = await import('../../api/routes/dashboard/analytics.js');

const mockClient = { guilds: { cache: { get: () => undefined } } } as unknown as Client;

/** Appelle la route "GET /analytics" complete. */
async function runAnalytics(guildId: string, query = 'period=7&tz=UTC'): Promise<any> {
  const { status, body } = await dashboardCall(createAnalyticsRouter(mockClient), 'GET', `/api/dashboard/guilds/${guildId}/analytics?${query}`);
  expect(status).toBe(200);
  return body;
}

/** `dateKey` au meme format que la route (annee-mois-jour en heure locale). */
function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Fenetre [startKey, endKey] identique a celle calculee par la route pour `period=7`. */
function sevenDayWindow(): { startKey: string; endKey: string; windowDays: string[] } {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 7);
  const windowDays: string[] = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    windowDays.push(dateKeyOf(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return { startKey: dateKeyOf(startDate), endKey: dateKeyOf(endDate), windowDays };
}

/** Bien avant la fenetre de 7 jours : sert a fabriquer un cumul a vie sans polluer la fenetre. */
function longAgoKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 120);
  return dateKeyOf(d);
}

describe('analytics.ts — top membres fenetre sur la periode (pas sur le cumul a vie)', () => {
  test('cas reproduit : 6600 messages a vie, 30 sur la fenetre -> doit ressortir a 30', async () => {
    // CASSE SI: messageCount: s._sum.messagesCount ?? 0  (remplace par un cumul a vie)
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-repro-messages';

    // 30 messages repartis sur 6 des 8 jours de la fenetre.
    for (let i = 0; i < 6; i++) {
      memberRows.push({ userId: 'U1', dateKey: windowDays[i], messagesCount: 5 });
    }
    // Un enorme historique HORS fenetre, qui porte le cumul a vie a 6600.
    memberRows.push({ userId: 'U1', dateKey: longAgoKey(), messagesCount: 6570 });

    profiles.push({ userId: 'U1', isBot: false, messageCount: 6600, displayName: 'Alice' });

    const data = await runAnalytics(guildId);
    const alice = data.topMessageMembers.find((m: any) => m.userId === 'U1');

    expect(alice).toBeDefined();
    expect(alice.messageCount).toBe(30);
  });

  test('defaut symetrique cote vocal : cumul a vie enorme, fenetre a 45 minutes -> doit ressortir a 45 min', async () => {
    // CASSE SI: voiceTimeSeconds: (s._sum.voiceMinutes ?? 0) * 60  (remplace par un cumul a vie)
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-repro-vocal';

    for (let i = 0; i < 3; i++) {
      memberRows.push({ userId: 'U1', dateKey: windowDays[i], voiceMinutes: 15 });
    }
    memberRows.push({ userId: 'U1', dateKey: longAgoKey(), voiceMinutes: 6660 }); // cumul a vie enorme hors fenetre

    profiles.push({ userId: 'U1', isBot: false, voiceTimeSeconds: (45 + 6660) * 60, displayName: 'Alice' });

    const data = await runAnalytics(guildId);
    const alice = data.topVoiceMembers.find((m: any) => m.userId === 'U1');

    expect(alice).toBeDefined();
    expect(alice.voiceTimeSeconds).toBe(45 * 60);
  });

  test('un bot ne doit jamais apparaitre dans le classement, meme s\'il a des lignes memberDailyStat', async () => {
    // CASSE SI: .filter(m => !m.isBot && m.messageCount > 0)  (retire le !m.isBot)
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-bot-exclu';

    memberRows.push({ userId: 'BOT1', dateKey: windowDays[0], messagesCount: 500 });
    memberRows.push({ userId: 'BOT1', dateKey: windowDays[1], voiceMinutes: 300 });
    memberRows.push({ userId: 'HUMAN1', dateKey: windowDays[0], messagesCount: 10, voiceMinutes: 5 });

    profiles.push({ userId: 'BOT1', isBot: true, messageCount: 500, voiceTimeSeconds: 300 * 60 });
    profiles.push({ userId: 'HUMAN1', isBot: false, messageCount: 10, voiceTimeSeconds: 5 * 60 });

    const data = await runAnalytics(guildId);

    expect(data.topMessageMembers.some((m: any) => m.userId === 'BOT1')).toBe(false);
    expect(data.topVoiceMembers.some((m: any) => m.userId === 'BOT1')).toBe(false);
    expect(data.topMessageMembers.some((m: any) => m.userId === 'HUMAN1')).toBe(true);
  });

  test('un membre sans ligne un jour de la fenetre reste classe correctement (pas de zero a tort, pas d\'oubli)', async () => {
    // CASSE SI: where: { guildId, dateKey: { gte: startDateKey, lte: endDateKey } }  (fenetre mal posee => somme fausse)
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-trou-historique';

    // Jour 0 : 5 messages. Jour 1 : AUCUNE ligne (trou). Jour 2 : 4 messages.
    memberRows.push({ userId: 'U2', dateKey: windowDays[0], messagesCount: 5 });
    memberRows.push({ userId: 'U2', dateKey: windowDays[2], messagesCount: 4 });

    // Cumul a vie volontairement tres different de 9 : si le code retombe sur
    // ce chemin (bug), l'assertion sur 9 echoue.
    profiles.push({ userId: 'U2', isBot: false, messageCount: 500, displayName: 'Bob' });

    const data = await runAnalytics(guildId);
    const bob = data.topMessageMembers.find((m: any) => m.userId === 'U2');

    expect(bob).toBeDefined();
    expect(bob.messageCount).toBe(9);
  });

  test('invariant SERVEUR A UN SEUL SALON : la somme des messages des membres sur la fenetre ne peut pas depasser celle du salon unique sur la MEME fenetre', async () => {
    // Portee VOLONTAIREMENT restreinte a un serveur qui n'a qu'un seul salon actif.
    // Avec un seul salon, ce salon n'est jamais tronque par le `take: 15` du top
    // salons (il y en a au plus 1 a montrer) : sa somme fenetree EST le total reel
    // de messages du serveur sur la fenetre, donc aucun membre (ni la somme des
    // membres affiches) ne peut la depasser.
    // Cet invariant est FAUX en general des qu'il y a plus de 15 salons actifs :
    // le top salons est alors tronque a 15 et sa somme peut etre INFERIEURE au
    // total reel, alors meme que le classement des membres est correct. Ne pas
    // generaliser ce test a plusieurs salons sans comparer au total reel plutot
    // qu'aux 15 salons affiches.
    // CASSE SI: prismaRead.memberProfile.findMany({ where: { guildId, isBot: false, messageCount: { gt: 0 } }, orderBy: { messageCount: 'desc' }, take: 100, ... })
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-invariant-messages';

    // Salon #general : 600 messages/jour sur les 8 jours de la fenetre = 4800.
    for (const dateKey of windowDays) {
      channelRows.push({ channelId: 'chan-general', dateKey, messagesCount: 600 });
    }

    // Deux membres actifs sur la fenetre (30 + 20 = 50), mais avec un ENORME
    // cumul a vie (6600 + 3000) : c'est exactement le motif signale par Toji.
    for (let i = 0; i < 6; i++) memberRows.push({ userId: 'U1', dateKey: windowDays[i], messagesCount: 5 });
    memberRows.push({ userId: 'U1', dateKey: longAgoKey(), messagesCount: 6570 });
    for (let i = 0; i < 2; i++) memberRows.push({ userId: 'U3', dateKey: windowDays[i], messagesCount: 10 });
    memberRows.push({ userId: 'U3', dateKey: longAgoKey(), messagesCount: 2980 });

    profiles.push({ userId: 'U1', isBot: false, messageCount: 6600, displayName: 'Alice' });
    profiles.push({ userId: 'U3', isBot: false, messageCount: 3000, displayName: 'Carla' });

    const data = await runAnalytics(guildId);

    const totalMembers = data.topMessageMembers.reduce((sum: number, m: any) => sum + m.messageCount, 0);
    const totalChannels = data.topChannels.reduce((sum: number, c: any) => sum + c.messagesCount, 0);

    expect(totalMembers).toBeLessThanOrEqual(totalChannels);
  });

  test('plafond cote base : 250 membres actifs sur la fenetre ne sont pas tous hydrates', async () => {
    // CASSE SI: le groupBy memberDailyStat repart sans `take` (regression laissee
    // par le passage a memberDailyStat.groupBy : l'ancien code plafonnait via
    // `memberProfile.findMany({ take: 100 })` cote Prisma direct, le nouveau
    // groupBy n'a plus aucune borne cote base). Sur un serveur charge, ca fait
    // remonter des dizaines de milliers de lignes et hydrater tous les profils
    // avant qu'un `.slice(0, 100)` en memoire n'en garde cent.
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-plafond-250';

    for (let i = 1; i <= 250; i++) {
      const userId = `U${i}`;
      memberRows.push({ userId, dateKey: windowDays[0], messagesCount: 251 - i }); // sommes desc distinctes
      profiles.push({ userId, isBot: false, displayName: `Membre ${i}` });
    }

    const groupByCallsBefore = mockDb.memberDailyStat.groupBy.mock.calls.length;
    const hydrationCallsBefore = mockDb.memberProfile.findMany.mock.calls.length;

    const data = await runAnalytics(guildId);

    // Le `take` reellement transmis a Prisma pour le classement messages doit
    // etre borne (c'est LE plafond disparu).
    const groupByCalls = mockDb.memberDailyStat.groupBy.mock.calls
      .slice(groupByCallsBefore)
      .filter((c: any) => Object.keys(c[0]?._sum ?? {})[0] === 'messagesCount');
    expect(groupByCalls.length).toBeGreaterThan(0);
    for (const call of groupByCalls) {
      expect(call[0].take).toBe(100);
    }

    // Consequence visible cote hydratation : jamais 250 identifiants envoyes
    // pour en afficher 100.
    const hydrationCalls = mockDb.memberProfile.findMany.mock.calls
      .slice(hydrationCallsBefore)
      .filter((c: any) => Array.isArray(c[0]?.where?.userId?.in));
    expect(hydrationCalls.length).toBeGreaterThan(0);
    for (const call of hydrationCalls) {
      expect(call[0].where.userId.in.length).toBeLessThanOrEqual(100);
    }

    expect(data.topMessageMembers.length).toBeLessThanOrEqual(100);
  });

  test('CAS REEL : un bot vocal SANS memberProfile ne doit pas etre compte comme humain', async () => {
    // CASSE SI: `isBot: p?.isBot ?? false` (un profil absent declare humain).
    //
    // Les deux tests d'exclusion ci-dessus donnent au bot un memberProfile
    // `isBot: true`. Aucun code du depot n'ecrit jamais cette ligne :
    // memberScraperService filtre `!m.user.bot` puis pose `isBot: false`, et
    // c'est le seul ecrivain de ce champ. `botUserIds` est donc toujours vide
    // en production, et le repli `?? false` fait passer le bot pour un humain.
    //
    // Le vecteur a ete ferme a la source depuis : le VoiceStateUpdate
    // d'advancedLogs.ts incrementait les minutes vocales sans regarder
    // `member.user.bot`, et ces ecritures ont ete retirees. Le bus, seule
    // source desormais, filtre au PUBLIEUR (`eventBusBridge.ts` sort des
    // `newState.member?.user.bot`), pas a l'abonne.
    //
    // Le test reste utile : les lignes ecrites avant ce nettoyage demeurent en
    // base, et un membre actif jamais scrape est lui aussi sans profil.
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-bot-vocal-sans-profil';

    // Le bot musical : 6 h de vocal sur la fenetre, AUCUN memberProfile.
    memberRows.push({ userId: 'BOTMUSIQUE', dateKey: windowDays[0], voiceMinutes: 360 });

    // Un humain scrape normalement, tres loin derriere.
    memberRows.push({ userId: 'HUMAIN', dateKey: windowDays[0], voiceMinutes: 12, messagesCount: 4 });
    profiles.push({ userId: 'HUMAIN', isBot: false, displayName: 'Humain' });

    const data = await runAnalytics(guildId);

    expect(data.topVoiceMembers.some((m: any) => m.userId === 'BOTMUSIQUE')).toBe(false);
    expect(data.topVoiceMembers.some((m: any) => m.userId === 'HUMAIN')).toBe(true);
  });

  test('un membre actif mais jamais scrape n\'est pas invente dans le classement', async () => {
    // CASSE SI: on garde les userId sans profil (on ne sait pas qui ils sont :
    // ni nom, ni avatar, ni statut bot). L'ancien code lisait memberProfile
    // directement, donc ne pouvait pas les faire apparaitre ; c'est ce
    // comportement qu'on conserve, plutot que d'afficher une ligne anonyme.
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-inconnu-non-invente';

    memberRows.push({ userId: 'INCONNU', dateKey: windowDays[0], messagesCount: 999 });
    memberRows.push({ userId: 'CONNU', dateKey: windowDays[0], messagesCount: 3 });
    profiles.push({ userId: 'CONNU', isBot: false, displayName: 'Connu' });

    const data = await runAnalytics(guildId);

    expect(data.topMessageMembers.some((m: any) => m.userId === 'INCONNU')).toBe(false);
    expect(data.topMessageMembers.some((m: any) => m.userId === 'CONNU')).toBe(true);
  });

  test('les bots restent exclus du classement sans faire descendre le top sous 100 membres reels quand il y en a assez', async () => {
    // CASSE SI: le `take: 100` est applique cote base AVANT d'exclure les bots
    // (par ex. un `take: 100` ajoute sans le `userId: { notIn: [...bots] }`) :
    // des bots a fort volume voleraient des places dans le top-100 remonte par
    // la base, et le filtre `!isBot` applique APRES coup ferait tomber le
    // classement final sous 100 membres reels alors que le serveur en a plus.
    const { windowDays } = sevenDayWindow();
    const guildId = 'g-bots-ne-mangent-pas-le-plafond';

    // 5 bots avec les PLUS GROS compteurs de la fenetre : s'ils sont pris dans
    // le top-100 cote base avant exclusion, ils volent 5 places a des membres
    // reels.
    for (let i = 1; i <= 5; i++) {
      const userId = `BOT${i}`;
      memberRows.push({ userId, dateKey: windowDays[0], messagesCount: 10000 + i });
      profiles.push({ userId, isBot: true, displayName: `Bot ${i}` });
    }

    // 120 membres reels actifs sur la fenetre (> 100, donc "assez").
    for (let i = 1; i <= 120; i++) {
      const userId = `REAL${i}`;
      memberRows.push({ userId, dateKey: windowDays[0], messagesCount: 100 + i });
      profiles.push({ userId, isBot: false, displayName: `Reel ${i}` });
    }

    const data = await runAnalytics(guildId);

    expect(data.topMessageMembers.some((m: any) => String(m.userId).startsWith('BOT'))).toBe(false);
    expect(data.topMessageMembers.length).toBe(100);
  });
});
