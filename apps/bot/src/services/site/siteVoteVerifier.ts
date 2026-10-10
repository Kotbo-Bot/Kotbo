/**
 * Vérification d'un vote auprès d'un site de classement.
 *
 * Adresses et lecture des réponses reprises du plugin Vote d'Azuriom (MIT).
 * L'adresse IP du visiteur n'est transmise qu'au site de classement choisi par
 * le serveur, au moment où le membre demande la vérification, et n'est jamais
 * enregistrée.
 */

import type { SiteVoteProvider } from '@kotbo/shared';
import { logger } from '../../utils/logger.js';

const TIMEOUT_MS = 6_000;

interface CheckInput {
  /** Jeton d'API ou identifiant du serveur sur le site de classement. */
  key: string;
  ip: string | null;
  userId: string;
}

type Checker = (input: CheckInput) => Promise<boolean>;

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Kotbo-Vote/1.0', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

/** Valeur à un chemin pointé (`data.voted`), comparée sans tenir compte du type. */
function jsonEquals(body: unknown, path: string, expected: unknown): boolean {
  let value: unknown = body;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null) return false;
    value = (value as Record<string, unknown>)[part];
  }
  return String(value) === String(expected);
}

function byIp(build: (key: string, ip: string) => string, path: string, expected: unknown): Checker {
  return async ({ key, ip }) => {
    if (!ip) return false;
    return jsonEquals(await getJson(build(key, ip)), path, expected);
  };
}

const CHECKERS: Partial<Record<SiteVoteProvider, Checker>> = {
  discordtop: async ({ key, userId }) =>
    jsonEquals(await getJson(`https://api.discordtop.net/v7/check-vote?external_id=${enc(userId)}`, { Authorization: `Bearer ${key}` }), 'has_voted', true),
  topserveurs: byIp((key, ip) => `https://api.top-serveurs.net/v1/votes/check-ip?server_token=${enc(key)}&ip=${enc(ip)}`, 'code', 200),
  topgames: byIp((key, ip) => `https://api.top-games.net/v1/votes/check-ip?server_token=${enc(key)}&ip=${enc(ip)}`, 'code', 200),
  serveurprive: byIp((key, ip) => `https://serveur-prive.net/api/v1/servers/${enc(key)}/votes/${enc(ip)}`, 'success', true),
  serveursminecraft: byIp((key, ip) => `https://www.serveurs-minecraft.org/api/is_valid_vote.php?id=${enc(key)}&ip=${enc(ip)}&duration=5&format=json`, 'votes', '1'),
  listeserveurs: byIp((key, ip) => `https://www.liste-serveurs.fr/api/checkVote/${enc(key)}/${enc(ip)}`, 'success', true),
  serveurliste: byIp((key, ip) => `https://serveurliste.com/api/vote?ip_address=${enc(ip)}&api_token=${enc(key)}`, 'data.voted', true),
  // « canVote: false » : le site refuse un nouveau vote, donc celui-ci vient d'être fait.
  serveurminecraftvote: byIp((key, ip) => `https://serveur-minecraft-vote.fr/api/v1/servers/${enc(key)}/vote/${enc(ip)}`, 'canVote', false),
};

/** Le membre (ou son adresse IP) a-t-il voté ? `false` en cas d'erreur du site de classement. */
export async function verifyVote(provider: SiteVoteProvider, input: CheckInput): Promise<boolean> {
  const checker = CHECKERS[provider];
  if (!checker || !input.key) return false;
  try {
    return await checker(input);
  } catch (err) {
    logger.warn('SiteVote', `Vérification ${provider} impossible :`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Identifiant du serveur déduit du lien de vote, pour les sites qui l'y mettent. */
export function voteKeyFromUrl(provider: SiteVoteProvider, voteUrl: string): string | null {
  const patterns: Partial<Record<SiteVoteProvider, RegExp>> = {
    serveursminecraft: /serveurs-minecraft\.org\/vote\.php\?id=(\d+)/,
    listeserveurs: /liste-serveurs\.fr\/[\w-]+\.(\d+)/,
    serveurminecraftvote: /serveur-minecraft-vote\.fr\/serveurs?\/[\w-]*?\.?(\d+)/,
  };
  const match = patterns[provider]?.exec(voteUrl);
  return match ? match[1] : null;
}
