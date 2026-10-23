import type { Client, Guild, GuildMember } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { pushAudit, broadcastDashboardStateChange } from '../../api/shared.js';
import {
  clanTasks,
  busyTaskError,
  migrateContributions,
  CLAN_TASK_PROGRESS_INTERVAL_MS,
} from './clanService.js';
import {
  averageClanSize,
  measureActivity,
  planRebalance,
  type ActivityBasis,
  type RebalanceCandidate,
  type RebalanceExclusion,
  type RebalanceMode,
  type SeasonWindow,
} from './clanRebalancePolicy.js';
import { UserFacingError } from '../../utils/userFacingError.js';

export interface RebalanceRequest {
  targetClanIds: string[];
  /** Absent : l'effectif moyen de tous les clans. */
  targetSize?: number | null;
  /** Points au-delà desquels un membre ne part jamais. Absent : aucune protection. */
  protectAbove?: number | null;
  /** Membres retirés à la main de l'aperçu. */
  excludedKeys?: string[];
  mode?: RebalanceMode;
  /** Graine du tirage : la même graine redonne la même liste, d'un aperçu à l'autre. */
  seed?: number;
}

export interface RebalanceMemberView {
  key: string;
  userIds: string[];
  displayName: string;
  avatarUrl: string | null;
  clanId: string;
  basis: ActivityBasis;
  points: number;
  presenceDays: number;
  rate: number;
}

export interface RebalancePreview {
  currentSeason: number;
  /** Saison dont les points jugent les membres ; `null` pendant la toute première saison. */
  referenceSeason: number | null;
  defaultTargetSize: number;
  targetSize: number;
  mode: RebalanceMode;
  clans: Array<{ id: string; name: string; before: number; after: number; isTarget: boolean }>;
  moves: Array<RebalanceMemberView & { toClanId: string }>;
  /** Membres retirés à la main, pour pouvoir les réintégrer depuis l'aperçu. */
  excludedMembers: RebalanceMemberView[];
  exclusionCounts: Partial<Record<RebalanceExclusion, number>>;
}

interface Snapshot {
  guild: Guild;
  currentSeason: number;
  referenceSeason: number | null;
  clans: Array<{ id: string; name: string; roleId: string; count: number }>;
  candidates: RebalanceCandidate[];
  views: Map<string, RebalanceMemberView>;
}

/**
 * Fait passer un compte d'un clan à l'autre, sans jamais le laisser à deux clans ni sans clan.
 *
 * Même règle que la synchro des doubles comptes : pas d'ajout sans retrait réussi. Si
 * l'ajout échoue après le retrait, l'ancien rôle est reposé - un membre sans clan ne gagne
 * plus rien et disparaît des effectifs sans que personne ne le remarque.
 */
async function switchClanRole(
  member: GuildMember,
  from: { name: string; roleId: string },
  to: { name: string; roleId: string },
  reason: string,
): Promise<boolean> {
  const removed = await member.roles.remove(from.roleId, reason).then(() => true).catch((err: unknown) => {
    logger.warn('ClanService', `Retrait du clan "${from.name}" impossible pour ${member.user.tag} :`, err);
    return false;
  });
  if (!removed) return false;

  const added = await member.roles.add(to.roleId, reason).then(() => true).catch((err: unknown) => {
    logger.warn('ClanService', `Ajout du clan "${to.name}" impossible pour ${member.user.tag} :`, err);
    return false;
  });
  if (added) return true;

  await member.roles.add(from.roleId, `${reason} (retour au clan d'origine)`).catch((err: unknown) => {
    logger.error('ClanService', `${member.user.tag} laissé sans clan : impossible de lui rendre "${from.name}".`, err);
  });
  return false;
}

const MODE_AUDIT_LABELS: Record<RebalanceMode, string> = {
  least_active: 'les moins actifs d\'abord',
  most_active: 'les plus actifs d\'abord',
  random: 'tirés au sort',
};

/**
 * Durée pendant laquelle le cache des membres fait foi après un chargement complet.
 *
 * L'aperçu se recalcule à chaque membre gardé et à chaque nouveau tirage. Recharger tout le
 * serveur à chaque clic enchaînerait les demandes de membres à la passerelle, que Discord
 * limite par connexion. Le bot reçoit les arrivées, départs et changements de rôles en
 * direct et ne purge pas ce cache : juste après un chargement complet, il est à jour.
 */
const MEMBER_CACHE_TRUST_MS = 5 * 60_000;
const lastFullFetch = new Map<string, number>();

async function fetchAllMembers(guild: Guild) {
  const fetchedAt = lastFullFetch.get(guild.id);
  if (fetchedAt && Date.now() - fetchedAt < MEMBER_CACHE_TRUST_MS) return guild.members.cache;

  const members = await guild.members.fetch().catch(() => null);
  if (members) lastFullFetch.set(guild.id, Date.now());
  return members;
}

/** Délai entre deux appels Discord, le même que pour la distribution. */
const ROLE_CHANGE_DELAY_MS = 450;

export class RebalanceInputError extends UserFacingError {}

/**
 * Regroupe les comptes liés, comme `getAllLinkedUserIds` mais pour tout le serveur d'un
 * coup : une requête par membre prendrait des minutes sur un gros serveur.
 */
async function loadAccountGroups(guildId: string): Promise<Map<string, string>> {
  const links = await prisma.linkedAccount.findMany({
    where: { guildId, status: 'VALIDATED' },
    select: { user1Id: true, user2Id: true },
  });

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const link of links) {
    const a = find(link.user1Id);
    const b = find(link.user2Id);
    if (a !== b) parent.set(a, b);
  }

  // La clé canonique est le plus petit identifiant du groupe : c'est sous elle que
  // `awardClanPointsToMembers` range les points, il faut la retrouver à l'identique.
  const members = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    members.set(root, [...(members.get(root) ?? []), id]);
  }
  const canonical = new Map<string, string>();
  for (const ids of members.values()) {
    const key = [...ids].sort()[0];
    for (const id of ids) canonical.set(id, key);
  }
  return canonical;
}

async function sumPointsByUser(guildId: string, season: number): Promise<Map<string, number>> {
  const rows = await prisma.clanMemberContribution.groupBy({
    by: ['userId'],
    where: { guildId, season },
    _sum: { xp: true },
  });
  return new Map(rows.map((row) => [row.userId, row._sum.xp ?? 0]));
}

async function firstEventAt(guildId: string, season: number): Promise<Date | null> {
  const first = await prisma.clanContributionEvent.findFirst({
    where: { guildId, season },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  return first?.createdAt ?? null;
}

/**
 * Bornes des saisons en cours et de référence.
 *
 * Aucune table ne garde les dates d'une saison close : on les retrouve dans le journal
 * des gains, dont la première ligne marque l'ouverture. La date planifiée de la saison en
 * cours l'emporte quand elle est plus ancienne, et une date future (saison programmée mais
 * pas encore ouverte) ne peut pas repousser le début au-delà de maintenant.
 */
async function resolveSeasonWindows(
  guildId: string,
  currentSeason: number,
  plannedStart: Date | null,
  now: Date,
): Promise<{ current: SeasonWindow; previous: SeasonWindow | null }> {
  const currentFirst = await firstEventAt(guildId, currentSeason);
  const currentStart = new Date(Math.min(
    now.getTime(),
    plannedStart?.getTime() ?? Infinity,
    currentFirst?.getTime() ?? Infinity,
  ));
  const current = { start: currentStart, end: now };

  if (currentSeason <= 1) return { current, previous: null };

  const previousFirst = await firstEventAt(guildId, currentSeason - 1);
  if (!previousFirst || previousFirst.getTime() >= currentStart.getTime()) return { current, previous: null };
  return { current, previous: { start: previousFirst, end: currentStart } };
}

async function buildSnapshot(guildId: string, client: Client, request: RebalanceRequest): Promise<Snapshot> {
  const settings = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { currentClanSeason: true, clanSeasonStartsAt: true },
  });
  if (!settings) throw new RebalanceInputError('Serveur introuvable.');

  const dbClans = await prisma.clan.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } });
  if (dbClans.length < 2) throw new RebalanceInputError('Il faut au moins deux clans pour rééquilibrer.');

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error('Serveur introuvable sur Discord.');

  const allMembers = await fetchAllMembers(guild);
  if (!allMembers) throw new Error('Impossible de récupérer la liste des membres Discord.');

  // Un clan dont le rôle a disparu ne peut ni donner ni recevoir : cf. runDistribution.
  const clans = dbClans
    .filter((clan) => guild.roles.cache.has(clan.roleId))
    .map((clan) => ({ id: clan.id, name: clan.name, roleId: clan.roleId, leaderRoleId: clan.leaderRoleId, count: 0 }));

  const now = new Date();
  const currentSeason = settings.currentClanSeason;
  const windows = await resolveSeasonWindows(guildId, currentSeason, settings.clanSeasonStartsAt, now);
  const referenceSeason = windows.previous ? currentSeason - 1 : null;

  const [canonical, currentPoints, previousPoints, inOpenBets] = await Promise.all([
    loadAccountGroups(guildId),
    sumPointsByUser(guildId, currentSeason),
    referenceSeason ? sumPointsByUser(guildId, referenceSeason) : Promise.resolve(new Map<string, number>()),
    import('./clanBetService.js').then(({ getUserIdsInOpenBets }) => getUserIdsInOpenBets(guildId)),
  ]);

  const groups = new Map<string, { members: GuildMember[]; clanIds: Set<string>; multiClan: boolean; leader: boolean }>();
  for (const member of allMembers.values()) {
    if (member.user.bot) continue;
    const held = clans.filter((clan) => member.roles.cache.has(clan.roleId));
    if (held.length === 0) continue;
    for (const clan of held) clan.count++;

    const key = canonical.get(member.id) ?? member.id;
    const group = groups.get(key) ?? { members: [], clanIds: new Set<string>(), multiClan: false, leader: false };
    group.members.push(member);
    for (const clan of held) group.clanIds.add(clan.id);
    if (held.length > 1) group.multiClan = true;
    if (held.some((clan) => clan.leaderRoleId && member.roles.cache.has(clan.leaderRoleId))) group.leader = true;
    groups.set(key, group);
  }

  const excludedKeys = new Set(request.excludedKeys ?? []);
  const protectAbove = typeof request.protectAbove === 'number' && request.protectAbove >= 0 ? request.protectAbove : null;
  const candidates: RebalanceCandidate[] = [];
  const views = new Map<string, RebalanceMemberView>();

  for (const [key, group] of groups) {
    // Les points d'un groupe sont rangés sous sa clé canonique, mais une ligne antérieure
    // au lien peut encore porter l'identifiant d'un des comptes : on additionne tout.
    const ids = [...new Set([key, ...group.members.map((member) => member.id)])];
    const sum = (points: Map<string, number>) => ids.reduce((total, id) => total + (points.get(id) ?? 0), 0);

    // Le compte arrivé le premier fait foi : un double créé plus tard ne rend pas le
    // membre nouveau.
    const joinedTimes = group.members.map((member) => member.joinedAt?.getTime()).filter((time): time is number => time !== undefined);
    const joinedAt = joinedTimes.length > 0 ? new Date(Math.min(...joinedTimes)) : null;

    const activity = measureActivity({
      joinedAt,
      previous: windows.previous ? { ...windows.previous, points: sum(previousPoints) } : null,
      current: { ...windows.current, points: sum(currentPoints) },
    });

    const exclusion: RebalanceExclusion | null = group.multiClan ? 'multi_clan'
      : group.clanIds.size > 1 ? 'split_accounts'
      : group.leader ? 'leader'
      : ids.some((id) => inOpenBets.has(id)) ? 'open_bet'
      : excludedKeys.has(key) ? 'excluded'
      : protectAbove !== null && activity.points > protectAbove ? 'protected'
      : null;

    const clanId = [...group.clanIds][0];
    const main = group.members.find((member) => member.id === key) ?? group.members[0];
    candidates.push({ key, userIds: group.members.map((member) => member.id), clanId, activity, exclusion });
    views.set(key, {
      key,
      userIds: group.members.map((member) => member.id),
      displayName: main.displayName,
      avatarUrl: main.displayAvatarURL({ size: 64 }),
      clanId,
      basis: activity.basis,
      points: activity.points,
      presenceDays: Math.floor(activity.presenceDays),
      rate: Math.round(activity.rate * 100) / 100,
    });
  }

  return {
    guild,
    currentSeason,
    referenceSeason,
    clans: clans.map(({ id, name, roleId, count }) => ({ id, name, roleId, count })),
    candidates,
    views,
  };
}

function validateTargets(snapshot: Snapshot, targetClanIds: string[]): string[] {
  const known = new Set(snapshot.clans.map((clan) => clan.id));
  const targets = [...new Set(targetClanIds)].filter((id) => known.has(id));
  if (targets.length === 0) throw new RebalanceInputError('Choisissez au moins un clan à remplir.');
  if (targets.length >= snapshot.clans.length) {
    throw new RebalanceInputError('Au moins un clan doit rester donneur : sinon personne ne peut être déplacé.');
  }
  return targets;
}

export async function previewRebalance(guildId: string, client: Client, request: RebalanceRequest): Promise<RebalancePreview> {
  const snapshot = await buildSnapshot(guildId, client, request);
  const targets = validateTargets(snapshot, request.targetClanIds);

  const defaultTargetSize = averageClanSize(snapshot.clans);
  const targetSize = typeof request.targetSize === 'number' && request.targetSize > 0
    ? Math.floor(request.targetSize)
    : defaultTargetSize;

  const mode = request.mode ?? 'least_active';
  const plan = planRebalance(snapshot.clans, snapshot.candidates, {
    targetClanIds: targets,
    targetSize,
    mode,
    seed: request.seed ?? 0,
  });

  const exclusionCounts: Partial<Record<RebalanceExclusion, number>> = {};
  for (const candidate of snapshot.candidates) {
    if (candidate.exclusion && !targets.includes(candidate.clanId)) {
      exclusionCounts[candidate.exclusion] = (exclusionCounts[candidate.exclusion] ?? 0) + 1;
    }
  }

  return {
    currentSeason: snapshot.currentSeason,
    referenceSeason: snapshot.referenceSeason,
    defaultTargetSize,
    targetSize,
    mode,
    clans: snapshot.clans.map((clan) => ({
      id: clan.id,
      name: clan.name,
      before: clan.count,
      after: plan.counts[clan.id] ?? clan.count,
      isTarget: targets.includes(clan.id),
    })),
    moves: plan.moves.map((move) => ({ ...snapshot.views.get(move.key)!, toClanId: move.toClanId })),
    excludedMembers: snapshot.candidates
      .filter((candidate) => candidate.exclusion === 'excluded')
      .map((candidate) => snapshot.views.get(candidate.key)!),
    exclusionCounts,
  };
}

/**
 * Applique les transferts validés dans l'aperçu.
 *
 * On ne recalcule pas le plan : entre l'aperçu et le clic, des arrivées remplissent déjà
 * les nouveaux clans, et un plan recalculé ne serait plus celui que l'administrateur a
 * relu. Chaque transfert est en revanche revérifié sur l'état du moment - un membre parti,
 * passé chef ou engagé dans un pari entre-temps reste où il est.
 */
export async function runRebalance(
  guildId: string,
  client: Client,
  initiatorName: string,
  request: RebalanceRequest & { moves: Array<{ key: string; fromClanId: string; toClanId: string }> },
): Promise<string> {
  if (clanTasks.has(guildId)) throw busyTaskError(guildId);
  clanTasks.set(guildId, { type: 'rebalance', processed: 0, total: 0 });

  let snapshot: Snapshot;
  let accepted: Array<{ candidate: RebalanceCandidate; from: { id: string; name: string; roleId: string }; to: { id: string; name: string; roleId: string } }>;
  let rejected: number;

  try {
    if (!Array.isArray(request.moves) || request.moves.length === 0) {
      throw new RebalanceInputError('Aucun transfert à appliquer : relancez l\'aperçu.');
    }

    // Les exclusions manuelles ne sont pas rejouées : les membres retirés de l'aperçu ne
    // figurent déjà plus dans la liste des transferts.
    snapshot = await buildSnapshot(guildId, client, { ...request, excludedKeys: [] });
    const targets = new Set(validateTargets(snapshot, request.targetClanIds));
    const clanById = new Map(snapshot.clans.map((clan) => [clan.id, clan]));
    const candidateByKey = new Map(snapshot.candidates.map((candidate) => [candidate.key, candidate]));

    accepted = [];
    const seen = new Set<string>();
    for (const move of request.moves) {
      const candidate = candidateByKey.get(move.key);
      const from = clanById.get(move.fromClanId);
      const to = clanById.get(move.toClanId);
      if (
        !candidate || !from || !to || seen.has(move.key)
        || candidate.clanId !== from.id
        || targets.has(from.id) || !targets.has(to.id)
        || candidate.exclusion !== null
      ) continue;
      seen.add(move.key);
      accepted.push({ candidate, from, to });
    }
    rejected = request.moves.length - accepted.length;

    if (accepted.length === 0) {
      throw new RebalanceInputError('Aucun des transferts prévus n\'est encore valable : relancez l\'aperçu.');
    }
  } catch (err) {
    clanTasks.delete(guildId);
    throw err;
  }

  const total = accepted.reduce((sum, entry) => sum + entry.candidate.userIds.length, 0);
  clanTasks.set(guildId, { type: 'rebalance', processed: 0, total });
  broadcastDashboardStateChange(guildId, 'clans_updated');

  const { guild, currentSeason, views } = snapshot;

  (async () => {
    logger.info('ClanService', `Rééquilibrage de ${accepted.length} membre(s) sur "${guild.name}" par ${initiatorName}`);

    let processed = 0;
    let moved = 0;
    const failed: string[] = [];
    let lastProgressAt = 0;

    for (const { candidate, from, to } of accepted) {
      if (clanTasks.get(guildId)?.type !== 'rebalance') break;

      // L'opération dure plusieurs minutes : un membre a pu rejoindre un pari depuis la
      // vérification du lancement. Sa mise a figé son clan, le déplacer maintenant
      // enverrait gain ou remboursement dans le clan qu'il vient de quitter.
      const { getUserIdsInOpenBets } = await import('./clanBetService.js');
      const inOpenBets = await getUserIdsInOpenBets(guildId).catch(() => null);
      if (!inOpenBets || [candidate.key, ...candidate.userIds].some((id) => inOpenBets.has(id))) {
        processed += candidate.userIds.length;
        clanTasks.set(guildId, { type: 'rebalance', processed, total });
        failed.push(candidate.key);
        continue;
      }

      const movedMembers: GuildMember[] = [];
      let complete = true;
      for (const userId of candidate.userIds) {
        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        if (member && await switchClanRole(member, from, to, 'Rééquilibrage des clans')) {
          movedMembers.push(member);
        } else {
          complete = false;
        }

        processed++;
        clanTasks.set(guildId, { type: 'rebalance', processed, total });
        const now = Date.now();
        if (now - lastProgressAt >= CLAN_TASK_PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          broadcastDashboardStateChange(guildId, 'clans_updated');
        }
        await new Promise((resolve) => setTimeout(resolve, ROLE_CHANGE_DELAY_MS));
      }

      // Un groupe de comptes liés ne doit jamais finir coupé en deux clans : ses points
      // sont sur une seule ligne, et la synchro des doubles comptes le réalignerait plus
      // tard sur le compte le plus actif, défaisant le transfert sans prévenir.
      if (!complete) {
        for (const member of movedMembers) {
          await switchClanRole(member, to, from, 'Rééquilibrage annulé : un compte lié n\'a pas pu suivre');
        }
        failed.push(candidate.key);
        continue;
      }
      moved++;

      // Seule la saison en cours suit le membre : les points de la saison close
      // appartiennent à l'historique du clan qu'il quitte.
      for (const userId of new Set([candidate.key, ...candidate.userIds])) {
        await migrateContributions(guildId, userId, from.id, to.id, currentSeason);
      }
    }

    logger.info('ClanService', `Rééquilibrage terminé sur "${guild.name}" : ${moved} membre(s) déplacé(s), ${failed.length} échec(s).`);

    await pushAudit(guildId, {
      user: initiatorName,
      action: 'Rééquilibrage des clans terminé',
      context: guild.name,
      module: 'Clans',
      eventType: 'Manuel',
      details: `${moved} membre(s) déplacé(s) vers les nouveaux clans, ${failed.length} échec(s).`
        + (failed.length > 0 ? ` Restés dans leur clan : ${failed.map((key) => views.get(key)?.displayName ?? key).join(', ')}.` : ''),
      channelId: null,
    }).catch(() => null);

    const { cache } = await import('../../utils/cache.js');
    await cache.delete(`guild:${guildId}:public-clans`).catch(() => null);

    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  })().catch((err) => {
    logger.error('ClanService', 'Erreur critique dans le thread de rééquilibrage :', err);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  });

  const destinations = [...new Set(accepted.map((entry) => entry.to.name))].join(', ');
  await pushAudit(guildId, {
    user: initiatorName,
    action: 'Lancement du rééquilibrage des clans',
    context: guild.name,
    module: 'Clans',
    eventType: 'Manuel',
    details: `${accepted.length} membre(s) vers ${destinations}, ${MODE_AUDIT_LABELS[request.mode ?? 'least_active']}`
      + (request.mode === 'random' ? '.' : `, jugés sur ${snapshot.referenceSeason ? `la saison ${snapshot.referenceSeason}` : 'la saison en cours'}.`)
      + (rejected > 0 ? ` ${rejected} transfert(s) écarté(s) car plus valables.` : ''),
    channelId: null,
  }).catch(() => null);

  return `Rééquilibrage lancé en arrière-plan pour ${accepted.length} membre(s).`
    + (rejected > 0 ? ` ${rejected} transfert(s) de l'aperçu ne sont plus valables et ont été écartés.` : '')
    + ' Vous pouvez suivre l\'avancement sur le Dashboard.';
}
