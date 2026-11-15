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
  type SeasonInputError,
} from '../../../services/progression/seasonService.js';
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

/** Messages des refus de validation, lus tels quels par le dashboard. */
const INPUT_ERRORS: Record<SeasonInputError, string> = {
  BAD_NAME: 'Le nom est requis et ne doit pas dépasser 80 caractères',
  BAD_DATE: 'Date invalide',
  END_BEFORE_START: 'La fin doit venir après le début',
  END_IN_PAST: 'La date de fin est déjà passée',
  BAD_DURATION: 'Une saison dure entre 1 et 366 jours',
  NOT_ARRAY: 'Récompenses invalides',
  TOO_MANY: 'Trop de récompenses',
  BAD_RANK: 'Rang de récompense invalide',
  BAD_ROLE: 'Rôle de récompense invalide',
  BAD_COINS: 'Montant de pièces invalide',
  EMPTY_REWARD: 'Chaque récompense donne un rôle, des pièces ou les deux',
  DUPLICATE_RANK: 'Deux récompenses pour le même rang',
  BAD_TOP_ROLE: 'Rôle du premier invalide',
  BAD_ANNOUNCE_CHANNEL: 'Salon d\'annonce invalide',
};

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
    json(res, 403, { error: 'Permissions insuffisantes' });
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/seasons
  if (parts.length === 5 && method === 'GET') {
    try {
      const data = await getSeasonsDashboardData(guildId);
      // Le classement d'XP ne montre qu'une moitié de la saison : le RP a le
      // sien, remis à zéro à la clôture, et la page l'ignorait complètement.
      const rankedLeaderboard = await getRankedLeaderboard(guildId, 20).catch(() => []);

      const locale = await resolveGuildLocale(guildId, client.guilds.cache.get(guildId)?.preferredLocale);
      json(res, 200, {
        ...data,
        // Gabarits de l'annonce dans la langue du serveur, pour l'aperçu.
        announcement: seasonAnnouncementLabels(locale),
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
        json(res, 400, { error: INPUT_ERRORS[parsed.error] });
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
      else if (result === 'not_found') json(res, 404, { error: 'Saison introuvable ou déjà terminée' });
      else json(res, 400, { error: INPUT_ERRORS[result] });
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
      json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Seule une saison à venir peut être supprimée' });
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
      else if (result === 'another_active') json(res, 409, { error: 'Une saison est déjà en cours : termine-la avant d\'en ouvrir une autre' });
      else json(res, 404, { error: 'Saison introuvable ou déjà ouverte' });
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
      json(res, success ? 200 : 400, success ? { ok: true } : { error: 'Impossible de terminer la saison' });
    } catch (err) {
      logger.error('SeasonsAPI', 'Error ending season:', err);
      jsonFailure(res, err, 'Erreur lors de la fin de saison', 'SeasonsAPI');
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/seasons/:seasonId/leaderboard
  if (parts.length === 7 && parts[6] === 'leaderboard' && method === 'GET') {
    try {
      const leaderboard = await getSeasonLeaderboard(guildId, parts[5]);
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
