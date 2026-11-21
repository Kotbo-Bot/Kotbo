/**
 * Rôles de palier : création automatique, attribution en masse, et remise à
 * niveau des paliers après un changement d'échelle.
 *
 * Associer vingt rôles un par un dans le dashboard était le vrai coût d'entrée
 * du module : les rôles n'existent pas encore, il faut les créer à la main dans
 * Discord, puis les rattacher un par un. Le bot sait faire les deux, et
 * l'attribution rétroactive - que le module ne faisait qu'au prochain gain de
 * RP, donc jamais pour un membre inactif - devient une action explicite.
 */

import { Client, PermissionFlagsBits, type Guild as DiscordGuild } from 'discord.js';
import { rankedTierIndex, type RankedLadder } from '@kotbo/shared';
import prisma, { prismaRead } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { getGuildLadder, getRankedConfigSafe, getTierRoles, removeTierRole, setTierRole } from './rankedConfigService.js';

const LOG_TAG = 'RankedTierRoles';

/** Plafond Discord : 250 rôles par serveur, bots et intégrations compris. */
const DISCORD_ROLE_LIMIT = 250;

/** Rythme de l'attribution en masse, calé sur celui du rangement de niveaux. */
const SYNC_PAUSE_MS = 1_100;

/** Au-delà, une passe oubliée n'a plus de rapport avec l'état de la guilde. */
const SYNC_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Création des rôles
// ---------------------------------------------------------------------------

export type TierRoleProvisionResult = {
  created: number;
  /** Paliers déjà associés à un rôle vivant : rien à faire. */
  kept: number;
  failed: number;
  error?: string;
};

/**
 * Range les rôles de palier du plus haut vers le plus bas dans la liste Discord.
 *
 * Créer l'échelle en partant du sommet suffit à l'empiler correctement, mais
 * pas une seconde passe : un palier ajouté après coup serait déposé tout en
 * bas, sous des paliers qu'il domine. Seuls les emplacements déjà occupés par
 * les rôles de palier sont permutés, le reste de la liste ne bouge pas.
 */
async function orderTierRoles(
  discordGuild: DiscordGuild,
  ladder: RankedLadder,
  roleOf: Map<string, string>,
): Promise<void> {
  // Insérer un rôle décale tous ceux du dessus : sans relecture, les positions
  // du cache dateraient d'avant les créations et deux rôles viseraient la même.
  await discordGuild.roles.fetch().catch(() => null);

  // Dans l'ordre de l'échelle : le palier le plus bas en premier.
  const roles = ladder
    .map((tier) => roleOf.get(tier.key))
    .map((roleId) => (roleId ? discordGuild.roles.cache.get(roleId) ?? null : null))
    .filter((role): role is NonNullable<typeof role> => role !== null);
  if (roles.length < 2) return;

  const slots = roles.map((role) => role.position).sort((a, b) => a - b);

  await discordGuild.roles.setPositions(
    roles.map((role, index) => ({ role, position: slots[index] })),
  ).catch((err) => {
    // Cosmétique : un rôle de palier hissé au-dessus du bot met la passe en
    // échec, sans remettre en cause les rôles eux-mêmes.
    logger.warn(LOG_TAG, `Ordre des rôles de palier non appliqué sur ${discordGuild.id}:`, err);
    return null;
  });
}

/**
 * Crée les rôles manquants de l'échelle et les associe à leur palier.
 *
 * Un palier déjà associé à un rôle qui existe encore n'est pas touché : la
 * fonction est rejouable après un ajout de paliers sans dupliquer l'existant.
 * Les rôles sont créés du haut vers le bas de l'échelle : Discord dépose chaque
 * rôle neuf juste au-dessus de `@everyone`, donc le dernier créé - le palier le
 * plus bas - finit en bas de la pile, et l'apex se retrouve au sommet.
 */
export async function provisionTierRoles(
  guildId: string,
  client: Client,
  options: { reason?: string } = {},
): Promise<TierRoleProvisionResult> {
  const discordGuild = client.guilds.cache.get(guildId)
    || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return { created: 0, kept: 0, failed: 0, error: 'guild_unavailable' };

  const me = discordGuild.members.me ?? await discordGuild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { created: 0, kept: 0, failed: 0, error: 'missing_manage_roles' };
  }

  // Le cache des rôles peut être froid au démarrage : sans cette lecture, un
  // palier déjà associé passerait pour orphelin et son rôle serait recréé.
  await discordGuild.roles.fetch().catch(() => null);

  const ladder = await getGuildLadder(guildId);
  const mappings = await getTierRoles(guildId);
  const roleOf = new Map(mappings.map((mapping) => [mapping.tierKey, mapping.roleId]));

  const missing = ladder.filter((tier) => {
    const roleId = roleOf.get(tier.key);
    return !roleId || !discordGuild.roles.cache.has(roleId);
  });
  const kept = ladder.length - missing.length;

  if (missing.length === 0) return { created: 0, kept, failed: 0 };

  // Le plafond est atteint pendant la création, pas après : refuser d'emblée
  // évite de laisser la guilde avec la moitié de son échelle en place.
  if (discordGuild.roles.cache.size + missing.length > DISCORD_ROLE_LIMIT) {
    return { created: 0, kept, failed: missing.length, error: 'role_limit' };
  }

  let created = 0;
  let failed = 0;

  // Parcours à l'envers : `missing` suit l'échelle (le plus bas d'abord), et
  // c'est le sommet qui doit être posé en premier.
  for (let index = missing.length - 1; index >= 0; index--) {
    const tier = missing[index];
    const role = await discordGuild.roles.create({
      name: tier.name,
      color: tier.color as `#${string}`,
      // Aucune permission et pas de mention : un rôle de palier est un badge,
      // pas un droit. Le laisser mentionnable ouvrirait un ping de masse.
      permissions: [],
      mentionable: false,
      hoist: false,
      reason: options.reason ?? 'Rôles de palier du classement de prestige',
    }).catch((err) => {
      logger.warn(LOG_TAG, `Création du rôle « ${tier.name} » impossible sur ${guildId}:`, err);
      return null;
    });

    if (!role) {
      failed++;
      continue;
    }

    await setTierRole(guildId, tier.key, role.id);
    roleOf.set(tier.key, role.id);
    created++;
  }

  // Une création partielle laisse quand même la pile à ranger : les paliers
  // déjà en place n'ont aucune raison d'attendre la passe suivante.
  if (created > 0) await orderTierRoles(discordGuild, ladder, roleOf);

  logger.info(LOG_TAG, `Rôles de palier sur ${guildId} : ${created} créés, ${kept} conservés, ${failed} en échec.`);
  return { created, kept, failed };
}

export type TierRoleDeletionResult = {
  /** Rôles réellement supprimés de Discord. */
  deleted: number;
  /** Associations retirées sans suppression : le rôle avait déjà disparu. */
  cleared: number;
  /** Rôles laissés en place : hors de portée du bot, ou refus de l'API. */
  failed: number;
  error?: string;
};

/**
 * Supprime de Discord les rôles de palier et leurs associations.
 *
 * Le pendant de `provisionTierRoles` : sans lui, une échelle refondue laisse
 * derrière elle une vingtaine de rôles à supprimer un par un dans Discord. Seuls
 * les rôles associés à un palier sont touchés - un rôle que l'admin a rattaché
 * lui-même en fait partie, d'où la confirmation côté dashboard.
 */
export async function deleteTierRoles(
  guildId: string,
  client: Client,
  options: { reason?: string } = {},
): Promise<TierRoleDeletionResult> {
  const discordGuild = client.guilds.cache.get(guildId)
    || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return { deleted: 0, cleared: 0, failed: 0, error: 'guild_unavailable' };

  const me = discordGuild.members.me ?? await discordGuild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { deleted: 0, cleared: 0, failed: 0, error: 'missing_manage_roles' };
  }

  // Même raison qu'à la création : sur un cache froid, un rôle bien vivant
  // passerait pour disparu et son association serait retirée sans rien supprimer.
  await discordGuild.roles.fetch().catch(() => null);

  const mappings = await getTierRoles(guildId);
  if (mappings.length === 0) return { deleted: 0, cleared: 0, failed: 0, error: 'no_tier_roles' };

  let deleted = 0;
  let cleared = 0;
  let failed = 0;

  for (const mapping of mappings) {
    const role = discordGuild.roles.cache.get(mapping.roleId);

    if (!role) {
      await removeTierRole(guildId, mapping.tierKey);
      cleared++;
      continue;
    }

    // Un rôle d'intégration ne se supprime pas, et un rôle au-dessus du bot lui
    // est hors de portée : les écarter vaut mieux qu'empiler des refus d'API.
    if (role.managed || role.id === discordGuild.roles.everyone.id
      || me.roles.highest.comparePositionTo(role) <= 0) {
      failed++;
      continue;
    }

    const removed = await role.delete(options.reason ?? 'Rôles de palier du classement de prestige')
      .then(() => true)
      .catch((err) => {
        logger.warn(LOG_TAG, `Suppression du rôle « ${role.name} » impossible sur ${guildId}:`, err);
        return false;
      });

    if (!removed) {
      failed++;
      continue;
    }

    // L'association ne part qu'après la suppression : un rôle encore debout doit
    // rester rattaché à son palier, sinon il devient introuvable.
    await removeTierRole(guildId, mapping.tierKey);
    deleted++;
  }

  logger.info(LOG_TAG, `Rôles de palier sur ${guildId} : ${deleted} supprimés, ${cleared} associations orphelines retirées, ${failed} en échec.`);
  return { deleted, cleared, failed };
}

// ---------------------------------------------------------------------------
// Paliers des membres après un changement d'échelle
// ---------------------------------------------------------------------------

/**
 * Réaligne la colonne `tierKey` sur la nouvelle échelle.
 *
 * Le RP ne bouge pas : seul le palier qu'il occupe change. Sans ce passage, un
 * membre inactif garderait une clé de palier absente de l'échelle, et son profil
 * afficherait un palier qui n'existe plus.
 */
export async function resyncRankedTiers(guildId: string, ladder: RankedLadder): Promise<number> {
  let changed = 0;

  for (let index = 0; index < ladder.length; index++) {
    const tier = ladder[index];
    const next = ladder[index + 1];
    const result = await prisma.rankedMember.updateMany({
      where: {
        guildId,
        // Le premier palier ramasse aussi un RP négatif, qu'aucun chemin ne
        // produit aujourd'hui mais qu'un ajustement manuel pourrait poser.
        rp: {
          ...(index === 0 ? {} : { gte: tier.minRp }),
          ...(next ? { lt: next.minRp } : {}),
        },
        tierKey: { not: tier.key },
      },
      data: { tierKey: tier.key },
    });
    changed += result.count;
  }

  return changed;
}

export type LadderImpact = {
  total: number;
  /** Membres qui changeraient de palier avec l'échelle proposée. */
  changed: number;
  /** Nombre de membres par palier, dans l'ordre de l'échelle. */
  distribution: number[];
};

/**
 * Répartition des membres sur une échelle proposée, avant enregistrement.
 *
 * Compté par la base, palier par palier, sur l'index `(guildId, rp)` : le
 * dashboard n'a aucune raison de rapatrier une ligne par membre pour dessiner
 * un histogramme.
 */
export async function computeLadderImpact(guildId: string, ladder: RankedLadder): Promise<LadderImpact> {
  const total = await prismaRead.rankedMember.count({ where: { guildId } });

  const perTier = await Promise.all(ladder.map(async (tier, index) => {
    const next = ladder[index + 1];
    const range = {
      ...(index === 0 ? {} : { gte: tier.minRp }),
      ...(next ? { lt: next.minRp } : {}),
    };
    const [count, moved] = await Promise.all([
      prismaRead.rankedMember.count({ where: { guildId, rp: range } }),
      prismaRead.rankedMember.count({ where: { guildId, rp: range, tierKey: { not: tier.key } } }),
    ]);
    return { count, moved };
  }));

  return {
    total,
    changed: perTier.reduce((sum, tier) => sum + tier.moved, 0),
    distribution: perTier.map((tier) => tier.count),
  };
}

// ---------------------------------------------------------------------------
// Attribution en masse
// ---------------------------------------------------------------------------

type TierRoleSyncJob = {
  members: Array<{ userId: string; rp: number }>;
  startedAt: number;
  done: number;
  updated: number;
  running: boolean;
  stopping: boolean;
};

const syncJobs = new Map<string, TierRoleSyncJob>();

export function getTierRoleSyncStatus(guildId: string) {
  const job = syncJobs.get(guildId);
  if (!job) return { pending: 0, done: 0, updated: 0, running: false };
  if (!job.running && Date.now() - job.startedAt > SYNC_TTL_MS) {
    syncJobs.delete(guildId);
    return { pending: 0, done: 0, updated: 0, running: false };
  }
  return { pending: job.members.length, done: job.done, updated: job.updated, running: job.running };
}

/** Interrompt la passe en cours : elle s'arrête au membre suivant. */
export function stopTierRoleSync(guildId: string): boolean {
  const job = syncJobs.get(guildId);
  if (!job?.running) return false;
  job.stopping = true;
  return true;
}

/**
 * Attribue à chaque membre classé le rôle de son palier.
 *
 * Détaché de la requête : sur un serveur peuplé, la passe prend des minutes au
 * rythme imposé par l'API Discord. Le dashboard suit l'avancement par
 * `getTierRoleSyncStatus`, comme pour le rangement des rôles de niveau.
 */
export async function startTierRoleSync(
  guildId: string,
  client: Client,
): Promise<{ started: boolean; pending: number; error?: string }> {
  const existing = syncJobs.get(guildId);
  if (existing?.running) return { started: false, pending: existing.members.length };

  const config = await getRankedConfigSafe(guildId);
  if (!config?.tierRolesEnabled) return { started: false, pending: 0, error: 'tier_roles_disabled' };

  const mappings = await getTierRoles(guildId);
  if (mappings.length === 0) return { started: false, pending: 0, error: 'no_tier_roles' };

  const discordGuild = client.guilds.cache.get(guildId)
    || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return { started: false, pending: 0, error: 'guild_unavailable' };

  const me = discordGuild.members.me ?? await discordGuild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { started: false, pending: 0, error: 'missing_manage_roles' };
  }

  const members = await prismaRead.rankedMember.findMany({
    where: { guildId },
    select: { userId: true, rp: true },
    orderBy: { rp: 'desc' },
  });
  if (members.length === 0) return { started: false, pending: 0, error: 'no_members' };

  const job: TierRoleSyncJob = {
    members,
    startedAt: Date.now(),
    done: 0,
    updated: 0,
    running: true,
    stopping: false,
  };
  syncJobs.set(guildId, job);

  void runTierRoleSync(guildId, discordGuild, job);
  return { started: true, pending: members.length };
}

async function runTierRoleSync(guildId: string, discordGuild: DiscordGuild, job: TierRoleSyncJob): Promise<void> {
  try {
    const [config, ladder, mappings] = await Promise.all([
      getRankedConfigSafe(guildId),
      getGuildLadder(guildId),
      getTierRoles(guildId),
    ]);
    const roleOf = new Map(mappings.map((mapping) => [mapping.tierKey, mapping.roleId]));
    const managed = mappings.map((mapping) => mapping.roleId);
    const exclusive = config?.tierRolesExclusive !== false;

    logger.info(LOG_TAG, `Attribution des rôles de palier sur ${guildId} : ${job.members.length} membres.`);

    for (let index = job.done; index < job.members.length; index++) {
      if (job.stopping) {
        logger.info(LOG_TAG, `Attribution interrompue sur ${guildId} après ${job.done} membres.`);
        break;
      }

      const entry = job.members[index];
      const member = await discordGuild.members.fetch(entry.userId).catch(() => null);
      let touched = false;

      if (member) {
        const tier = ladder[rankedTierIndex(entry.rp, ladder)];
        const targetRoleId = roleOf.get(tier.key) ?? null;
        const toAdd = targetRoleId && !member.roles.cache.has(targetRoleId) ? [targetRoleId] : [];
        const toRemove = exclusive
          ? managed.filter((roleId) => roleId !== targetRoleId && member.roles.cache.has(roleId))
          : [];

        if (toRemove.length > 0) await member.roles.remove(toRemove).catch(() => null);
        if (toAdd.length > 0) await member.roles.add(toAdd).catch(() => null);
        touched = toAdd.length > 0 || toRemove.length > 0;
        if (touched) job.updated++;
      }

      job.done++;
      // Un membre déjà en règle n'a coûté aucune écriture : la longue pause est
      // réservée à ceux dont les rôles ont bougé, sinon une guilde déjà à jour
      // mettrait des heures à se relire.
      await new Promise((resolve) => setTimeout(resolve, touched ? SYNC_PAUSE_MS : 60));
    }

    if (!job.stopping) {
      logger.info(LOG_TAG, `Attribution terminée sur ${guildId} : ${job.updated} membres modifiés.`);
    }
  } catch (err) {
    logger.error(LOG_TAG, `Attribution des rôles de palier interrompue sur ${guildId}:`, err);
  } finally {
    job.running = false;
    job.stopping = false;
    if (job.done >= job.members.length) syncJobs.delete(guildId);
  }
}
