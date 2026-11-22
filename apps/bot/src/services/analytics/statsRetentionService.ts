/**
 * Purge des agrégats analytics les plus fins, au-delà de la plage affichable.
 *
 * Le tableau de bord remonte à 365 jours et compare à la période précédente
 * (soit 730 jours) : 800 jours laissent une marge, tout ce qui est plus ancien
 * ne sert plus. Sans purge, ces tables (par membre, par salon, par jour) grossissent
 * indéfiniment.
 *
 * Volontairement absentes : `GuildDailyStat`, `ChannelDailyStat` et
 * `MemberDailyStat`, dont certains écrans (classement, profil) peuvent cumuler
 * l'historique complet. Les purger relève d'un choix produit.
 */
import prisma from '../../utils/db.js';
import { shiftDateKey } from './dateKeys.js';

export const STATS_RETENTION_DAYS = 800;

/** Lignes supprimées par requête : borne le verrou et le volume de WAL. */
const BATCH_SIZE = 20_000;
/** Garde-fou : une exécution ne traite pas plus de 100 lots par table. */
const MAX_BATCHES_PER_TABLE = 100;

/** Liste blanche : ces noms sont interpolés dans le SQL, jamais issus d'une entrée. */
const PRUNED_TABLES = [
  'guild_hourly_stats',
  'member_interaction_daily_stats',
  'channel_response_daily_stats',
  'content_item_daily_stats',
  'message_content_daily_stats',
  'command_usage_daily_stats',
  'reaction_role_daily_stats',
  'module_usage_stats',
  'module_performance_stats',
] as const;

/** Supprime par lots les lignes antérieures à la rétention. Renvoie le total supprimé. */
export async function pruneOldStats(retentionDays = STATS_RETENTION_DAYS): Promise<number> {
  const cutoffKey = shiftDateKey(-retentionDays);
  let total = 0;
  for (const table of PRUNED_TABLES) {
    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch++) {
      const deleted = await prisma.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE ctid IN (SELECT ctid FROM "${table}" WHERE "dateKey" < $1 LIMIT ${BATCH_SIZE})`,
        cutoffKey,
      );
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
  }
  return total;
}
