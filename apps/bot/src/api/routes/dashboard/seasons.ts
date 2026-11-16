import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { rankedTierByKey } from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  getSeasonsDashboardData,
  createSeason,
  updateSeason,
  deleteSeason,
  startSeason,
  endSeason,
  getSeasonLeaderboard,
  parseSeasonInput,
  retrySeasonRewards,
  type SeasonInputError,
} from '../../../services/progression/seasonService.js';
import { isModuleEnabled } from '../../../services/core/moduleGate.js';
import { getBotRoleAccess } from '../../../utils/botRoleAccess.js';
import { getRankedSeasonStandings } from '../../../services/progression/ranked/rankedSeasonService.js';
import { getRankedLeaderboard } from '../../../services/progression/ranked/rankedLeaderboardService.js';
import { getGuildLadder } from '../../../services/progression/ranked/rankedConfigService.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { seasonAnnouncementLabels } from '../../../services/progression/seasonAnnouncements.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';

import { jsonFailure } from '../../shared/failure.js';
/** Le classement archivé ne stocke que des identifiants : il faut les nommer. */
async function withSeasonIdentities<T extends { userId: string }>(
  client: Client,
  guildId: string,
  rows: T[],
): Promise<Array<T & { displayName: string | null; avatarUrl: string | null }>> {
  const identities = await getMemberIdentities(client, guildId, rows.map((row) => row.userId))
    .catch(() => new Map());
  return rows.map((row) => ({
    ...row,
    displayName: identities.get(row.userId)?.displayName ?? null,
    avatarUrl: identities.get(row.userId)?.avatarUrl || null,
  }));
}

/**
 * Refus de validation : un `code` que le dashboard traduit (`messageForApiCode`),
 * le texte français ne servant que de repli à un dashboard plus ancien.
 */
const INPUT_ERRORS: Record<SeasonInputError, { code: string; message: string }> = {
  BAD_NAME: { code: 'sea_bad_name', message: 'Le nom est requis et ne doit pas dépasser 80 caractères' },
  BAD_DATE: { code: 'sea_bad_date', message: 'Date invalide' },
  END_BEFORE_START: { code: 'sea_end_before_start', message: 'La fin doit venir après le début' },
  END_IN_PAST: { code: 'sea_end_in_past', message: 'La date de fin est déjà passée' },
  BAD_DURATION: { code: 'sea_bad_duration', message: 'Une saison dure entre 1 et 366 jours' },
  NOT_ARRAY: { code: 'sea_bad_reward_rank', message: 'Récompenses invalides' },
  TOO_MANY: { code: 'sea_too_many_rewards', message: 'Trop de récompenses' },
  BAD_RANK: { code: 'sea_bad_reward_rank', message: 'Rang de récompense invalide' },
  BAD_ROLE: { code: 'sea_bad_reward_role', message: 'Rôle de récompense invalide' },
  BAD_COINS: { code: 'sea_bad_reward_coins', message: 'Montant de pièces invalide' },
  EMPTY_REWARD: { code: 'sea_empty_reward', message: 'Chaque récompense donne un rôle, des pièces ou les deux' },
  DUPLICATE_RANK: { code: 'sea_duplicate_rank', message: 'Deux récompenses pour le même rang' },
  TIERS_NOT_ARRAY: { code: 'sea_bad_tier_xp', message: 'Paliers invalides' },
  TOO_MANY_TIERS: { code: 'sea_too_many_tiers', message: 'Trop de paliers' },
  BAD_TIER_XP: { code: 'sea_bad_tier_xp', message: 'Seuil de palier invalide' },
  BAD_TIER_ROLE: { code: 'sea_bad_reward_role', message: 'Rôle de palier invalide' },
  BAD_TIER_COINS: { code: 'sea_bad_reward_coins', message: 'Montant de pièces de palier invalide' },
  EMPTY_TIER: { code: 'sea_empty_reward', message: 'Chaque palier donne un rôle, des pièces ou les deux' },
  DUPLICATE_TIER: { code: 'sea_duplicate_tier', message: 'Deux paliers au même seuil' },
  BAD_TOP_ROLE: { code: 'sea_bad_top_role', message: 'Rôle du premier invalide' },
  BAD_ANNOUNCE_CHANNEL: { code: 'sea_bad_announce_channel', message: 'Salon d\'annonce invalide' },
};

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: message, code });
}

function refuseInput(res: ServerResponse, error: SeasonInputError): void {
  refuse(res, 400, INPUT_ERRORS[error].code, INPUT_ERRORS[error].message);
}

export async function handleSeasonRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  const method = req.method;
  if (parts[4] !== 'seasons') return false;

  if (method !== 'GET' && !access.canManageSettings) {
    refuse(res, 403, 'sea_forbidden', 'Permissions insuffisantes');
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/seasons
  if (parts.length === 5 && method === 'GET') {
    try {
      const discordGuild = client.guilds.cache.get(guildId) ?? null;
      const data = await getSeasonsDashboardData(guildId, discordGuild);
      // Le classement d'XP ne montre qu'une moitié de la saison : le RP a le
      // sien, remis à zéro à la clôture. Prestige éteint, d'anciens RP
      // s'afficheraient comme s'ils comptaient encore.
      const rankedLeaderboard = await isModuleEnabled(guildId, 'prestige')
        ? await getRankedLeaderboard(guildId, 20).catch(() => [])
        : [];

      const locale = await resolveGuildLocale(guildId, client.guilds.cache.get(guildId)?.preferredLocale);
      json(res, 200, {
        ...data,
        // Gabarits de l'annonce dans la langue du serveur, pour l'aperçu.
        announcement: seasonAnnouncementLabels(locale),
        // Ce que le bot peut attribuer : la page prévient avant la clôture
        // qu'un rôle de récompense lui sera refusé.
        botRoleAccess: discordGuild ? await getBotRoleAccess(discordGuild) : null,
        // Les pseudos manquaient aux deux classements : `MemberLevel` comme
        // `RankedMember` ne stockent que des identifiants.
        activeLeaderboard: await withSeasonIdentities(client, guildId, data.activeLeaderboard),
        activeRankedLeaderboard: await withSeasonIdentities(client, guildId, rankedLeaderboard),
      });
    } catch (err) {
      logger.error('SeasonsAPI', 'Error fetching seasons:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des saisons', 'SeasonsAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/seasons
  if (parts.length === 5 && method === 'POST') {
    try {
      const parsed = parseSeasonInput((await readJsonBody(req)) ?? {});
      if ('error' in parsed) {
        refuseInput(res, parsed.error);
        return true;
      }
      json(res, 201, await createSeason(guildId, parsed.input, client));
    } catch (err) {
      logger.error('SeasonsAPI', 'Error creating season:', err);
      jsonFailure(res, err, 'Erreur lors de la création', 'SeasonsAPI');
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/seasons/:seasonId
  if (parts.length === 6 && method === 'PATCH') {
    try {
      const result = await updateSeason(guildId, parts[5], (await readJsonBody(req)) ?? {}, client);
      if (result === 'updated') json(res, 200, { ok: true });
      else if (result === 'not_found') refuse(res, 404, 'sea_not_editable', 'Saison introuvable ou déjà terminée');
      else refuseInput(res, result);
    } catch (err) {
      logger.error('SeasonsAPI', 'Error updating season:', err);
      jsonFailure(res, err, 'Erreur lors de la modification', 'SeasonsAPI');
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/seasons/:seasonId
  if (parts.length === 6 && method === 'DELETE') {
    try {
      const deleted = await deleteSeason(guildId, parts[5]);
      if (deleted) json(res, 200, { ok: true });
      else refuse(res, 404, 'sea_not_deletable', 'Seule une saison à venir peut être supprimée');
    } catch (err) {
      logger.error('SeasonsAPI', 'Error deleting season:', err);
      jsonFailure(res, err, 'Erreur lors de la suppression', 'SeasonsAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/seasons/:seasonId/start
  if (parts.length === 7 && parts[6] === 'start' && method === 'POST') {
    try {
      const result = await startSeason(guildId, parts[5], client);
      if (result === 'started') json(res, 200, { ok: true });
      else if (result === 'another_active') refuse(res, 409, 'sea_another_active', 'Une saison est déjà en cours : termine-la avant d\'en ouvrir une autre');
      else refuse(res, 404, 'sea_not_startable', 'Saison introuvable ou déjà ouverte');
    } catch (err) {
      logger.error('SeasonsAPI', 'Error starting season:', err);
      jsonFailure(res, err, 'Erreur lors du démarrage', 'SeasonsAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/seasons/:seasonId/end
  if (parts.length === 7 && parts[6] === 'end' && method === 'POST') {
    try {
      const success = await endSeason(client, guildId, parts[5]);
      if (success) json(res, 200, { ok: true });
      else refuse(res, 400, 'sea_end_failed', 'Impossible de terminer la saison');
    } catch (err) {
      logger.error('SeasonsAPI', 'Error ending season:', err);
      jsonFailure(res, err, 'Erreur lors de la fin de saison', 'SeasonsAPI');
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/seasons/:seasonId/rewards/retry
  if (parts.length === 8 && parts[6] === 'rewards' && parts[7] === 'retry' && method === 'POST') {
    try {
      const result = await retrySeasonRewards(client, guildId, parts[5]);
      if (result === 'not_found') refuse(res, 404, 'sea_rewards_not_found', 'Saison introuvable ou pas encore terminée');
      else if (result === 'busy') refuse(res, 409, 'sea_rewards_busy', 'Les récompenses de cette saison sont déjà en cours de reprise');
      else json(res, 200, { ok: true, ...result });
    } catch (err) {
      logger.error('SeasonsAPI', 'Error retrying season rewards:', err);
      jsonFailure(res, err, 'Erreur lors de la reprise des récompenses', 'SeasonsAPI');
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/seasons/:seasonId/leaderboard
  if (parts.length === 7 && parts[6] === 'leaderboard' && method === 'GET') {
    try {
      const leaderboard = await getSeasonLeaderboard(guildId, parts[5], 20, client.guilds.cache.get(guildId) ?? null);
      // Le RP est archivé par la clôture (`RankedSeasonEntry`) mais n'était
      // jamais renvoyé : la page des saisons ne montrait que le classement
      // d'XP, comme si le prestige n'avait pas eu de saison.
      const rankedStandings = await getRankedSeasonStandings(guildId, parts[5])
        .catch(() => [] as Awaited<ReturnType<typeof getRankedSeasonStandings>>);
      const ladder = await getGuildLadder(guildId).catch(() => null);

      json(res, 200, {
        leaderboard: await withSeasonIdentities(client, guildId, leaderboard),
        rankedStandings: await withSeasonIdentities(client, guildId, rankedStandings.map((entry) => ({
          ...entry,
          tier: ladder ? rankedTierByKey(entry.tierKey, ladder) : null,
        }))),
      });
    } catch (err) {
      logger.error('SeasonsAPI', 'Error fetching leaderboard:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération du classement', 'SeasonsAPI');
    }
    return true;
  }

  return false;
}
