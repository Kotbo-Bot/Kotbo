import type { Client } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { fetchExternal } from '../../utils/http.js';
import { isWhiteLabelInstance } from '../../utils/instanceContext.js';

export type BotListProvider = 'botillon' | 'topgg' | 'discordium';

export interface BotListStatsSnapshot {
  botId: string;
  serverCount: number;
  shardCount?: number;
}

export interface BotListPushRequest {
  provider: BotListProvider;
  url: string;
  method: 'POST' | 'PATCH';
  headers: Record<string, string>;
  body: Record<string, number>;
}

export interface BotListSyncResult {
  provider: BotListProvider;
  ok: boolean;
  status?: number;
  error?: string;
}

interface TopggVersionMode {
  useV0: boolean;
}

function resolveTopggVersion(env: Record<string, string | undefined>): TopggVersionMode {
  return {
    useV0: env.TOPGG_API_VERSION?.trim().toLowerCase() === 'v0',
  };
}

/**
 * Construit les requêtes HTTP à envoyer pour chaque annuaire configuré.
 * Fonction pure pour permettre les tests unitaires sans client Discord.
 */
export function buildBotListRequests(
  stats: BotListStatsSnapshot,
  env: Record<string, string | undefined> = process.env,
): BotListPushRequest[] {
  const requests: BotListPushRequest[] = [];

  const botillonToken = env.BOTILLON_API_TOKEN?.trim();
  if (botillonToken) {
    const body: Record<string, number> = { serverCount: stats.serverCount };
    if (stats.shardCount !== undefined) body.shardCount = stats.shardCount;

    requests.push({
      provider: 'botillon',
      url: 'https://botillon.fr/api/v1/me/runtime/stats',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botillonToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'BotillonSDK/javascript/1.0',
        'X-Botillon-SDK': 'javascript/1.0',
      },
      body,
    });
  }

  const topggToken = env.TOPGG_API_TOKEN?.trim();
  if (topggToken) {
    const body: Record<string, number> = { server_count: stats.serverCount };
    if (stats.shardCount !== undefined) body.shard_count = stats.shardCount;

    const { useV0 } = resolveTopggVersion(env);
    requests.push(
      useV0
        ? {
            provider: 'topgg',
            url: `https://top.gg/api/bots/${stats.botId}/stats`,
            method: 'POST',
            headers: {
              Authorization: topggToken,
              'Content-Type': 'application/json',
            },
            body,
          }
        : {
            provider: 'topgg',
            url: 'https://top.gg/api/v1/projects/@me/metrics',
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${topggToken}`,
              'Content-Type': 'application/json',
            },
            body,
          },
    );
  }

  const discordiumToken = env.DISCORDIUM_API_TOKEN?.trim();
  if (discordiumToken) {
    const body: Record<string, number> = { serverCount: stats.serverCount };
    if (stats.shardCount !== undefined) body.shardCount = stats.shardCount;

    requests.push({
      provider: 'discordium',
      url: `https://api.discordium.org/api/v1/bots/${stats.botId}/stats`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${discordiumToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  }

  return requests;
}

/**
 * Agrège le nombre total de serveurs et de shards depuis le shard 0.
 * Retourne null sur les instances marque blanche ou sur les autres shards.
 */
export async function collectBotListStats(client: Client): Promise<BotListStatsSnapshot | null> {
  // Une instance marque blanche ne doit jamais publier ses chiffres sur les fiches publiques de Kotbo.
  if (isWhiteLabelInstance()) return null;

  if (client.shard && !client.shard.ids.includes(0)) return null;

  const botId = client.user?.id;
  if (!botId) return null;

  let serverCount = client.guilds.cache.size;
  let shardCount: number | undefined;

  if (client.shard) {
    const shardGuilds = (await client.shard.fetchClientValues('guilds.cache.size')) as number[];
    serverCount = shardGuilds.reduce((sum, count) => sum + count, 0);
    shardCount = client.shard.count;
  }

  return { botId, serverCount, shardCount };
}

/**
 * Envoie les statistiques du bot aux annuaires configurés (Botillon, Top.gg, Discordium).
 * Échoue silencieusement par fournisseur pour qu'une panne tierce n'interrompe pas le bot.
 */
export async function syncBotListStats(
  client: Client,
  env: Record<string, string | undefined> = process.env,
): Promise<BotListSyncResult[]> {
  if (
    !env.BOTILLON_API_TOKEN?.trim() &&
    !env.TOPGG_API_TOKEN?.trim() &&
    !env.DISCORDIUM_API_TOKEN?.trim()
  ) {
    return [];
  }

  const stats = await collectBotListStats(client);
  if (!stats) return [];

  const requests = buildBotListRequests(stats, env);
  if (requests.length === 0) return [];

  const settled = await Promise.allSettled(
    requests.map(async (req): Promise<BotListSyncResult> => {
      try {
        const res = await fetchExternal(req.url, {
          method: req.method,
          headers: req.headers,
          body: JSON.stringify(req.body),
        });

        if (res.ok) {
          logger.debug('BotLists', `Stats publiées sur ${req.provider} (${stats.serverCount} serveurs).`);
          return { provider: req.provider, ok: true, status: res.status };
        }

        const detail = (await res.text().catch(() => '')).slice(0, 200);
        logger.warn(
          'BotLists',
          `Échec publication ${req.provider} (${res.status} ${res.statusText})${detail ? ` : ${detail}` : ''}`,
        );
        return { provider: req.provider, ok: false, status: res.status, error: detail || res.statusText };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('BotLists', `Erreur réseau ${req.provider} : ${message}`);
        return { provider: req.provider, ok: false, error: message };
      }
    }),
  );

  return settled.map((entry, idx) =>
    entry.status === 'fulfilled'
      ? entry.value
      : { provider: requests[idx].provider, ok: false, error: String(entry.reason) },
  );
}
