/**
 * La Tour de clan : accès base, ouverture et clôture hebdomadaires.
 *
 * Les clans sont ceux du serveur (rôles Discord), quel que soit le mode d'équipe du RPG :
 * les guildes RPG n'y ont aucune part, et leurs raids ou leur XP n'en sont pas touchés.
 * Les ascensions elles-mêmes passent par le moteur de la Tour (voir `rpgTowerService.ts`,
 * mode CLAN) ; ce module ne connaît que la semaine, les conquêtes et les points.
 */

import { escapeMarkdown, type Client } from 'discord.js';
import { Prisma, type RpgClanTowerEvent } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import { resolveGuildTimezone } from '../../../utils/timezone.js';
import * as m from '../../../lib/paraglide/messages.js';
import { CLAN_WIDE_USER_ID } from '../../community/clanPointsFeedPolicy.js';
import { planNextRaidWindow } from './rpgRaidPolicy.js';
import { newTowerSeed } from './rpgTowerPolicy.js';
import { normalizeTowerFloors, readTowerFloorsCached, type TowerLayout } from './rpgTowerMap.js';
import {
  CLAN_TOWER_DEFAULTS,
  clanTowerAwards,
  clanTowerBonus,
  clanTowerMilestonesValid,
  normalizeClanTowerSettings,
  rankClanTower,
  type ClanTowerAward,
  type ClanTowerSettings,
  type ClanTowerStanding,
} from './rpgClanTowerPolicy.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

export type ClanTowerConfigView = ClanTowerSettings & { floors: TowerLayout[] };

export class ClanTowerError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ClanTowerError';
  }
}

export async function getClanTowerConfig(guildId: string): Promise<ClanTowerConfigView> {
  // Sans les étages : ils ne sont relus que s'ils ont changé depuis la dernière lecture.
  const row = await prisma.rpgClanTowerConfig.findUnique({ where: { guildId }, omit: { layouts: true } });
  if (!row) return { ...CLAN_TOWER_DEFAULTS, floors: [] };
  const floors = await readTowerFloorsCached(`clan:${guildId}`, row.floorsUpdatedAt, async () =>
    (await prisma.rpgClanTowerConfig.findUnique({ where: { guildId }, select: { layouts: true } }))?.layouts ?? []);
  return { ...normalizeClanTowerSettings(row as unknown as Record<string, unknown>), floors };
}

export async function saveClanTowerSettings(guildId: string, input: Record<string, unknown>): Promise<ClanTowerConfigView> {
  // Ramenés en silence à l'ancienne valeur, des paliers mal ordonnés feraient croire à un réglage enregistré.
  if (input.milestones !== undefined && !(Array.isArray(input.milestones) && clanTowerMilestonesValid(input.milestones))) {
    throw new ClanTowerError('Les trois paliers collectifs doivent être croissants : chacun au-dessus du précédent.', 400);
  }
  const data = normalizeClanTowerSettings(input, await getClanTowerConfig(guildId));
  await prisma.rpgClanTowerConfig.upsert({ where: { guildId }, update: data, create: { guildId, ...data } });
  return getClanTowerConfig(guildId);
}

/**
 * Enregistre les étages de la Tour de clan, au même format que ceux de la Tour. Aucun étage :
 * elle génère les siens. Une ascension en cours garde la carte de son étage.
 */
export async function saveClanTowerFloors(guildId: string, input: { floors?: unknown }): Promise<ClanTowerConfigView> {
  const normalized = normalizeTowerFloors(Array.isArray(input.floors) ? input.floors : []);
  if (!normalized.ok) throw new ClanTowerError(normalized.error, 400);
  const data = { layouts: normalized.value as unknown as Prisma.InputJsonValue, floorsUpdatedAt: new Date() };
  await prisma.rpgClanTowerConfig.upsert({ where: { guildId }, update: data, create: { guildId, ...data } });
  return getClanTowerConfig(guildId);
}

/** La Tour de clan ne s'ouvre que sur un serveur dont les clans sont actifs. */
export async function clansEnabled(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { clansEnabled: true } });
  return guild?.clansEnabled === true;
}

/** Événement en cours : ouvert, et pas encore arrivé à son terme. */
export async function getOpenClanTowerEvent(guildId: string, now: Date = new Date()): Promise<RpgClanTowerEvent | null> {
  return prisma.rpgClanTowerEvent.findFirst({
    where: { guildId, status: 'OPEN', startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: 'desc' },
  });
}

/** Clan du joueur, lu sur ses rôles Discord comme partout dans le module Clans. */
export async function resolveMemberClan(client: Client, guildId: string, userId: string): Promise<{ id: string; name: string } | null> {
  const clans = await prisma.clan.findMany({ where: { guildId }, select: { id: true, name: true, roleId: true } });
  if (clans.length === 0) return null;
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const member = guild ? guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null) : null;
  if (!member) return null;
  const clan = clans.find((entry) => member.roles.cache.has(entry.roleId));
  return clan ? { id: clan.id, name: clan.name } : null;
}

/**
 * Étages franchis par un membre : chacun revient à son clan s'il ne l'avait pas encore. Un
 * étage franchi après la clôture ne compte plus.
 */
export async function recordClanTowerConquests(
  eventId: string,
  clanId: string,
  userId: string,
  floors: { from: number; to: number },
): Promise<number> {
  const event = await prisma.rpgClanTowerEvent.findUnique({ where: { id: eventId }, select: { status: true, endsAt: true } });
  if (!event || event.status !== 'OPEN' || event.endsAt.getTime() <= Date.now()) return 0;
  const data = [];
  for (let floor = floors.from + 1; floor <= floors.to; floor++) data.push({ eventId, clanId, floor, userId });
  if (data.length === 0) return 0;
  const created = await prisma.rpgClanTowerConquest.createMany({ data, skipDuplicates: true });
  return created.count;
}

/**
 * Étages gravis au total par les membres de chaque clan pendant l'événement, tentatives en
 * cours comprises : c'est ce qui fait franchir les paliers collectifs. Une partie à l'étage
 * `floor` en a gravi `floor - 1`.
 */
export async function getClanTowerTotals(eventId: string): Promise<Map<string, number>> {
  const rows = await prisma.rpgTowerRun.groupBy({
    by: ['clanId'],
    where: { clanEventId: eventId, clanId: { not: null } },
    _sum: { floor: true },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.clanId!, Math.max(0, (row._sum.floor ?? 0) - row._count._all)]));
}

/** Salles conquises par le clan sur un étage, pour cette carte-là. */
export async function loadClanTowerRooms(eventId: string, clanId: string, floor: number, layoutKey: string): Promise<string[]> {
  const rows = await prisma.rpgClanTowerRoom.findMany({ where: { eventId, clanId, floor, layoutKey }, select: { roomId: true } });
  return rows.map((row) => row.roomId);
}

/** Salles qu'un membre vient de vaincre : elles le restent pour tout son clan. */
export async function recordClanTowerRooms(
  eventId: string,
  clanId: string,
  userId: string,
  floor: number,
  layoutKey: string,
  roomIds: readonly string[],
): Promise<void> {
  if (roomIds.length === 0) return;
  const event = await prisma.rpgClanTowerEvent.findUnique({ where: { id: eventId }, select: { status: true, endsAt: true } });
  if (!event || event.status !== 'OPEN' || event.endsAt.getTime() <= Date.now()) return;
  await prisma.rpgClanTowerRoom.createMany({
    data: roomIds.map((roomId) => ({ eventId, clanId, floor, layoutKey, roomId, userId })),
    skipDuplicates: true,
  });
}

export async function getClanTowerStandings(eventId: string): Promise<ClanTowerStanding[]> {
  const conquests = await prisma.rpgClanTowerConquest.findMany({
    where: { eventId },
    select: { clanId: true, floor: true, userId: true, conqueredAt: true },
  });
  return rankClanTower(conquests);
}

/** Classement en cours, avec le nom de chaque clan, pour `/tour`. */
export async function listClanTowerStandings(guildId: string, eventId: string): Promise<(ClanTowerStanding & { name: string })[]> {
  const [standings, clans] = await Promise.all([
    getClanTowerStandings(eventId),
    prisma.clan.findMany({ where: { guildId }, select: { id: true, name: true } }),
  ]);
  const names = new Map(clans.map((clan) => [clan.id, clan.name]));
  return standings.filter((standing) => names.has(standing.clanId)).map((standing) => ({ ...standing, name: names.get(standing.clanId)! }));
}

// ─────────────────────────────────────────────────────────────
// Cycle hebdomadaire
// ─────────────────────────────────────────────────────────────

/**
 * Ouvre l'événement de la semaine à son heure, l'annonce, et clôt celui qui arrive à son terme.
 * La fenêtre en cours se déduit des réglages, comme celle du raid : rien n'est planifié en
 * base, et l'unicité (serveur, ouverture) empêche deux processus d'ouvrir la même semaine.
 */
export async function runClanTowerCycle(client: Client): Promise<void> {
  const configs = await prisma.rpgClanTowerConfig.findMany({ where: { enabled: true }, select: { guildId: true } });
  for (const { guildId } of configs) {
    try {
      await closeDueEvents(guildId);
      await openDueEvent(client, guildId);
    } catch (err) {
      logger.error('RpgClanTower', `Cycle en échec pour ${guildId} :`, err);
    }
  }
  // Un serveur qui a coupé la Tour de clan en pleine semaine voit quand même son bilan tomber.
  const orphans = await prisma.rpgClanTowerEvent.findMany({
    where: { status: 'OPEN', endsAt: { lte: new Date() }, guildId: { notIn: configs.map((config) => config.guildId) } },
    select: { guildId: true },
    distinct: ['guildId'],
  });
  for (const { guildId } of orphans) {
    await closeDueEvents(guildId).catch((err) => logger.error('RpgClanTower', `Clôture en échec pour ${guildId} :`, err));
  }
}

async function openDueEvent(client: Client, guildId: string): Promise<void> {
  // On y entre par `/tour` : sans la Tour, l'événement serait annoncé sans pouvoir s'y rendre.
  const [settings, economy, tower, clans] = await Promise.all([
    getClanTowerConfig(guildId),
    prisma.economyConfig.findUnique({ where: { guildId }, select: { enabled: true, rpgEnabled: true } }),
    prisma.rpgTowerConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
    clansEnabled(guildId),
  ]);
  if (!settings.enabled || !clans || !economy?.enabled || !economy.rpgEnabled || !tower?.enabled) return;

  const now = new Date();
  const timezone = await resolveGuildTimezone(guildId);
  // Prochaine ouverture après « maintenant moins la durée » : si elle est déjà passée, on est
  // dans la fenêtre de la semaine.
  const window = planNextRaidWindow(new Date(now.getTime() - settings.durationHours * 3_600_000), {
    weekday: settings.weekday,
    hour: settings.hour,
    durationHours: settings.durationHours,
  }, timezone);
  if (window.opensAt.getTime() > now.getTime() || window.closesAt.getTime() <= now.getTime()) return;

  // Le cycle repasse toute la semaine : l'événement existe déjà presque toujours. Un `create`
  // levait alors une violation d'unicité, rattrapée mais écrite par Prisma dans les logs à
  // chaque passage. `skipDuplicates` s'en tient au conflit, et l'unicité départage toujours
  // deux processus qui ouvriraient la même semaine.
  const created = await prisma.rpgClanTowerEvent.createMany({
    data: { guildId, startsAt: window.opensAt, endsAt: window.closesAt, seed: newTowerSeed() },
    skipDuplicates: true,
  });
  if (created.count === 0) return;
  const event = await prisma.rpgClanTowerEvent.findUnique({ where: { guildId_startsAt: { guildId, startsAt: window.opensAt } } });
  if (!event) return;
  logger.info('RpgClanTower', `Tour de clan ouverte sur ${guildId} jusqu'au ${event.endsAt.toISOString()}.`);
  await announceOpening(client, guildId, settings, event).catch((err) => {
    logger.warn('RpgClanTower', `Ouverture non annoncée sur ${guildId} :`, err);
  });
}

async function announceOpening(client: Client, guildId: string, settings: ClanTowerConfigView, event: RpgClanTowerEvent): Promise<void> {
  if (!settings.announceChannelId) return;
  const channel = await client.channels.fetch(settings.announceChannelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== guildId) return;
  const locale = await resolveGuildLocale(guildId);
  const end = `<t:${Math.floor(event.endsAt.getTime() / 1000)}:F>`;
  await channel.send({
    content: [
      `## ${m.clan_tower_announce_title({ name: settings.name }, { locale })}`,
      m.clan_tower_announce_body({ end, points: settings.pointsPerFloor }, { locale }),
    ].join('\n'),
    allowedMentions: { parse: [] },
  });
  await prisma.rpgClanTowerEvent.update({ where: { id: event.id }, data: { announcedAt: new Date() } });
}

async function closeDueEvents(guildId: string): Promise<void> {
  const due = await prisma.rpgClanTowerEvent.findMany({ where: { guildId, status: 'OPEN', endsAt: { lte: new Date() } } });
  for (const event of due) await closeClanTowerEvent(event);
}

export type ClanTowerResults = {
  awards: (ClanTowerAward & { name: string })[];
};

/**
 * Clôt un événement : classement, points versés et bilan publié dans le flux des points de
 * clan, en un seul message. La clôture est prise sous condition de statut : deux processus
 * ne versent pas deux fois. Les ascensions encore ouvertes se terminent d'elles-mêmes, sans
 * plus rien conquérir.
 */
export async function closeClanTowerEvent(event: RpgClanTowerEvent): Promise<ClanTowerResults | null> {
  const taken = await prisma.rpgClanTowerEvent.updateMany({
    where: { id: event.id, status: 'OPEN' },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
  if (taken.count === 0) return null;

  const [settings, standings, clans, guild] = await Promise.all([
    getClanTowerConfig(event.guildId),
    getClanTowerStandings(event.id),
    prisma.clan.findMany({ where: { guildId: event.guildId }, select: { id: true, name: true } }),
    prisma.guild.findUnique({ where: { id: event.guildId }, select: { clansEnabled: true, currentClanSeason: true } }),
  ]);
  const names = new Map(clans.map((clan) => [clan.id, clan.name]));
  // Un clan supprimé pendant la semaine ne reçoit rien : ses points n'auraient plus de ligne.
  const awards = clanTowerAwards(standings.filter((standing) => names.has(standing.clanId)), settings)
    .map((award) => ({ ...award, name: names.get(award.clanId)! }));

  if (guild?.clansEnabled) {
    for (const award of awards) await payAward(event.guildId, guild.currentClanSeason, award);
  }

  const results: ClanTowerResults = { awards };
  await prisma.rpgClanTowerEvent.update({
    where: { id: event.id },
    data: { results: JSON.parse(JSON.stringify(results)) as Prisma.InputJsonValue },
  });
  logger.info('RpgClanTower', `Tour de clan close sur ${event.guildId} : ${awards.length} clan(s) classé(s).`);

  await postResults(event.guildId, settings, awards).catch((err) => {
    logger.warn('RpgClanTower', `Bilan non publié sur ${event.guildId} :`, err);
  });
  return results;
}

/**
 * Verse les points d'un clan : chaque conquérant pour ses étages, sur le clan où il les a
 * conquis, puis le podium au clan entier. Le flux Discord n'est pas nourri ligne à ligne :
 * le bilan le résume en un seul message.
 */
async function payAward(guildId: string, season: number, award: ClanTowerAward): Promise<void> {
  // Import à la demande, comme `rpgTeamRewards` : le service des clans tire l'API du dashboard,
  // dont la Tour n'a pas besoin pour jouer.
  const { creditClanContribution, logClanContribution } = await import('../../community/clanService.js');
  const credit = async (userId: string, amount: number) => {
    if (amount <= 0) return;
    try {
      const { granted } = await creditClanContribution({ guildId, clanId: award.clanId, userId, season, amount });
      await logClanContribution(guildId, award.clanId, userId, granted, 'RPG_TOWER_CLAN', season, undefined, undefined, false);
    } catch (err) {
      logger.error('RpgClanTower', `Points de la Tour de clan non versés à ${userId} (${award.clanId}) :`, err);
    }
  };
  for (const climber of award.climbers) await credit(climber.userId, climber.points);
  await credit(CLAN_WIDE_USER_ID, award.podium);
}

async function postResults(guildId: string, settings: ClanTowerConfigView, awards: ClanTowerResults['awards']): Promise<void> {
  const locale = await resolveGuildLocale(guildId);
  const lines = [`**${m.clan_tower_results_header({ name: escapeMarkdown(settings.name) }, { locale })}**`];
  if (awards.length === 0) {
    lines.push(m.clan_tower_results_empty({}, { locale }));
  } else {
    for (const award of awards) {
      const best = award.climbers[0];
      lines.push(m.clan_tower_results_line({
        rank: award.rank,
        clan: escapeMarkdown(award.name.length > 60 ? `${award.name.slice(0, 59)}…` : award.name),
        floors: award.floors,
        points: award.total.toLocaleString(locale),
        user: best ? `<@${best.userId}>` : '-',
        count: best?.floors ?? 0,
      }, { locale }));
    }
  }
  const { postClanPointsFeedMessage } = await import('../../community/clanPointsFeedService.js');
  await postClanPointsFeedMessage(guildId, lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────

export async function getClanTowerDashboard(guildId: string) {
  const [settings, clans, open, last] = await Promise.all([
    getClanTowerConfig(guildId),
    clansEnabled(guildId),
    prisma.rpgClanTowerEvent.findFirst({ where: { guildId, status: 'OPEN' }, orderBy: { startsAt: 'desc' } }),
    prisma.rpgClanTowerEvent.findFirst({ where: { guildId, status: 'CLOSED' }, orderBy: { startsAt: 'desc' } }),
  ]);
  const names = new Map((await prisma.clan.findMany({ where: { guildId }, select: { id: true, name: true } })).map((clan) => [clan.id, clan.name]));
  const [standings, totals] = open
    ? await Promise.all([getClanTowerStandings(open.id), getClanTowerTotals(open.id)])
    : [[], new Map<string, number>()];
  const timezone = await resolveGuildTimezone(guildId);
  const next = planNextRaidWindow(new Date(), { weekday: settings.weekday, hour: settings.hour, durationHours: settings.durationHours }, timezone);
  return {
    settings,
    clansEnabled: clans,
    current: open
      ? {
        startsAt: open.startsAt,
        endsAt: open.endsAt,
        standings: standings.map((standing) => ({
          clanId: standing.clanId,
          name: names.get(standing.clanId) ?? '',
          floors: standing.floors,
          rank: standing.rank,
          climbers: standing.climbers.slice(0, 3),
          totalFloors: totals.get(standing.clanId) ?? 0,
          milestones: clanTowerBonus(totals.get(standing.clanId) ?? 0, settings.milestones).reached,
        })),
      }
      : null,
    last: last ? { startsAt: last.startsAt, endsAt: last.endsAt, results: last.results } : null,
    nextOpensAt: open ? null : next.opensAt,
  };
}
