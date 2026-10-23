/**
 * Republication d'un message censuré sous l'identité de son auteur.
 *
 * Quand une règle AutoMod est réglée sur « Censurer », le message d'origine
 * est bloqué ou supprimé, puis renvoyé par un webhook avec le nom et l'avatar
 * du membre : seuls les passages interdits sont masqués, la conversation garde
 * le reste du message.
 */

import {
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type MediaChannel,
  type NewsChannel,
  type StageChannel,
  type TextChannel,
  type VoiceChannel,
  type Webhook,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { censorContent, type CensorRange } from './censorship.js';

const TAG = 'CensorService';
const WEBHOOK_NAME = 'Kotbo · censure';

/**
 * Discord émet une exécution par règle native déclenchée : un message qui
 * enfreint deux règles arrive deux fois. On attend ce délai pour réunir les
 * plages de toutes les règles avant de republier une seule fois.
 */
const GATHER_WINDOW_MS = 800;

type WebhookHost = TextChannel | NewsChannel | ForumChannel | MediaChannel | VoiceChannel | StageChannel;

export interface CensoredMessage {
  guild: Guild;
  channelId: string;
  userId: string;
  content: string;
  ranges: CensorRange[];
  /** Pièces jointes à recopier, quand le message d'origine existe encore. */
  files?: string[];
}

// Les webhooks vivent sur le salon parent : la clé est l'identifiant du parent.
const webhookCache = new Map<string, Webhook>();
const pending = new Map<string, CensoredMessage>();

function isWebhookHost(channel: GuildBasedChannel | null | undefined): channel is WebhookHost {
  return !!channel && 'fetchWebhooks' in channel && 'createWebhook' in channel;
}

/**
 * Discord refuse un nom de webhook contenant « discord » ou « clyde ».
 */
function webhookUsername(name: string): string {
  const cleaned = name.replace(/discord|clyde/gi, '').replace(/`{3}/g, '').trim().slice(0, 80);
  return cleaned || 'Membre';
}

async function getOrCreateCensorWebhook(host: WebhookHost): Promise<Webhook | null> {
  const cached = webhookCache.get(host.id);
  if (cached) return cached;

  try {
    const webhooks = await host.fetchWebhooks();
    const existing = webhooks.find(
      (w) => w.owner?.id === host.client.user?.id && w.name === WEBHOOK_NAME,
    );
    const webhook = existing?.token ? existing : await host.createWebhook({
      name: WEBHOOK_NAME,
      reason: "Republication des messages censurés par l'AutoMod",
    });

    webhookCache.set(host.id, webhook);
    return webhook;
  } catch (err) {
    logger.warn(TAG, `Impossible de créer le webhook de censure pour ${host.id} :`, err);
    return null;
  }
}

/**
 * Republie le message censuré. Renvoie `false` si rien n'a pu être envoyé
 * (salon sans webhook possible, permission manquante, membre parti…).
 */
export async function repostCensored(message: CensoredMessage): Promise<boolean> {
  const { guild } = message;
  const channel = guild.channels.cache.get(message.channelId)
    ?? await guild.channels.fetch(message.channelId).catch(() => null);
  if (!channel) return false;

  const thread = channel.isThread() ? channel : null;
  const host = thread ? thread.parent : channel;
  if (!isWebhookHost(host)) return false;

  const me = guild.members.me;
  if (!me || !host.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
    logger.warn(TAG, `Permission « Gérer les webhooks » absente sur ${host.id} (${guild.id}) : message censuré non republié.`);
    return false;
  }

  const member = await guild.members.fetch(message.userId).catch(() => null);
  const base = {
    content: censorContent(message.content, message.ranges),
    username: webhookUsername(member?.displayName ?? ''),
    avatarURL: member?.displayAvatarURL(),
    threadId: thread?.id,
    // Les mentions de membres restent actives, comme dans le message d'origine.
    // Rôles et @everyone ne sont jamais relayés.
    allowedMentions: { parse: ['users' as const] },
  };

  // Une pièce jointe trop lourde ou expirée ne doit pas faire perdre le texte.
  const attempts = message.files?.length ? [{ ...base, files: message.files }, base] : [base];

  for (const payload of attempts) {
    try {
      await sendThroughWebhook(host, payload);
      return true;
    } catch (err) {
      logger.warn(TAG, `Échec de la republication censurée dans ${message.channelId} :`, err);
    }
  }
  return false;
}

async function sendThroughWebhook(host: WebhookHost, payload: Parameters<Webhook['send']>[0]): Promise<void> {
  const webhook = await getOrCreateCensorWebhook(host);
  if (!webhook) throw new Error('Webhook de censure indisponible');

  try {
    await webhook.send(payload);
  } catch (err) {
    if (!(err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownWebhook)) throw err;
    // Webhook supprimé à la main entre deux censures : on en recrée un.
    webhookCache.delete(host.id);
    const fresh = await getOrCreateCensorWebhook(host);
    if (!fresh) throw err;
    await fresh.send(payload);
  }
}

/**
 * Programme la republication d'un message bloqué par une règle native, en
 * réunissant les plages des autres règles déclenchées par le même message.
 */
export function queueCensoredRepost(message: CensoredMessage): void {
  const key = `${message.guild.id}:${message.channelId}:${message.userId}:${message.content}`;
  const existing = pending.get(key);
  if (existing) {
    existing.ranges.push(...message.ranges);
    return;
  }

  const entry: CensoredMessage = { ...message, ranges: [...message.ranges] };
  pending.set(key, entry);
  setTimeout(() => {
    pending.delete(key);
    void repostCensored(entry).catch((err) => {
      logger.warn(TAG, 'Republication censurée impossible :', err);
    });
  }, GATHER_WINDOW_MS);
}
