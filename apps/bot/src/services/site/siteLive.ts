/**
 * Temps réel du site communautaire : signaux poussés par WebSocket.
 *
 * Un signal dit seulement « ceci a changé » (un bloc de module, les
 * commentaires d'une page, le verrou de l'agent, les tickets d'un membre) ;
 * le navigateur recharge alors le morceau concerné par les routes HTTP
 * habituelles, avec leurs contrôles d'accès. Rien de privé ne transite par le
 * socket : un abonnement indiscret n'apprendrait qu'un horodatage.
 *
 * Sujets : `site:<siteId>:<canal>`, canaux `agent`, `module:<clé>`,
 * `comments:<pageId>`, `forum:<catégorie|sujet|index>`, `user:<userId>` (réservé au membre lui-même).
 *
 * Seul le shard qui porte l'API a les sockets ; ailleurs, le signal traverse
 * les shards comme les événements du dashboard. Les rafales sont regroupées :
 * un même sujet ne part qu'une fois par délai.
 */

import { isSiteModuleKey, type SiteModuleKey } from '@kotbo/shared';
import { getClient } from '../../utils/client.js';
import { logger } from '../../utils/logger.js';
import { getSiteByGuild } from './siteService.js';

export type SiteLiveChannel = 'agent' | `module:${string}` | `comments:${string}` | `user:${string}` | `forum:${string}`;

type Publisher = (topic: string, message: string) => void;

declare global {
  // Émetteur du shard qui porte l'API, atteint par les autres via `broadcastEval`.
  // `var` obligatoire : seul il rattache la déclaration à `globalThis`.
  // eslint-disable-next-line no-var
  var KOTBO_SITE_LIVE_PUBLISHER: Publisher | undefined;
}

/** Délai de regroupement par canal : un fil de salon bavard ne doit pas noyer les visiteurs. */
const DEBOUNCE_MS: Record<string, number> = { channelFeed: 10_000, voice: 3_000 };
const DEFAULT_DEBOUNCE_MS = 1_500;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function siteLiveTopic(siteId: string, channel: string): string {
  return `site:${siteId}:${channel}`;
}

/** Branché par le serveur de l'API au démarrage. */
export function setSiteLivePublisher(publisher: Publisher): void {
  globalThis.KOTBO_SITE_LIVE_PUBLISHER = publisher;
}

/** Canal accepté à l'abonnement, pour ce visiteur (`user:` = lui seul). */
export function isAllowedLiveChannel(channel: unknown, userId: string | null): channel is SiteLiveChannel {
  if (typeof channel !== 'string' || channel.length > 64) return false;
  if (channel === 'agent') return true;
  if (channel.startsWith('module:')) return isSiteModuleKey(channel.slice(7));
  if (channel.startsWith('comments:')) return /^[a-z0-9]{20,32}$/.test(channel.slice(9));
  // Forum : liste des catégories (`index`), une catégorie ou un sujet.
  if (channel.startsWith('forum:')) return channel === 'forum:index' || /^[a-z0-9]{20,32}$/.test(channel.slice(6));
  if (channel.startsWith('user:')) return Boolean(userId) && channel.slice(5) === userId;
  return false;
}

function deliver(topic: string, message: string): void {
  const local = globalThis.KOTBO_SITE_LIVE_PUBLISHER;
  if (local) {
    local(topic, message);
    return;
  }
  let client;
  try {
    client = getClient();
  } catch {
    return;
  }
  if (!client.shard) return;
  client.shard
    .broadcastEval(
      (_shardClient, payload) => {
        const publisher = (globalThis as unknown as Record<string, unknown>).KOTBO_SITE_LIVE_PUBLISHER;
        if (typeof publisher === 'function') (publisher as (t: string, m: string) => void)(payload.topic, payload.message);
      },
      { context: { topic, message } },
    )
    .catch((err: unknown) => logger.debug('Site', 'Signal temps réel non relayé :', err));
}

/** Signale un changement sur un site ; regroupé avec les signaux identiques proches. */
export function publishSiteSignal(siteId: string, channel: SiteLiveChannel): void {
  const topic = siteLiveTopic(siteId, channel);
  if (pending.has(topic)) return;
  const moduleKey = channel.startsWith('module:') ? channel.slice(7) : '';
  const delay = DEBOUNCE_MS[moduleKey] ?? DEFAULT_DEBOUNCE_MS;
  const timer = setTimeout(() => {
    pending.delete(topic);
    deliver(topic, JSON.stringify({ type: 'site_signal', channel, at: Date.now() }));
  }, delay);
  timer.unref?.();
  pending.set(topic, timer);
}

/** Même chose depuis un serveur Discord : rien s'il n'a pas de site en ligne. */
export function publishGuildSignal(guildId: string, channel: SiteLiveChannel): void {
  getSiteByGuild(guildId)
    .then((site) => {
      if (site && site.published && !site.suspendedAt) publishSiteSignal(site.id, channel);
    })
    .catch(() => {});
}

export function moduleChannel(key: SiteModuleKey): SiteLiveChannel {
  return `module:${key}`;
}
