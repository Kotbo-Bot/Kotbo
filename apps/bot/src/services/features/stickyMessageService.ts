/**
 * Sticky bot : maintient un message en dernière position d'un salon.
 *
 * Principe : on compte les messages postés dans le salon depuis le dernier
 * envoi du sticky. Au-delà du seuil configuré, l'ancien envoi est supprimé et
 * le message est republié - il redevient donc le dernier message visible.
 *
 * Le compteur vit en mémoire (un write DB par message serait ruineux) ; seul
 * `lastMessageId` est persisté, pour pouvoir nettoyer l'ancien sticky après un
 * redémarrage du bot.
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  WebhookClient,
  type APIEmbed,
  type Client,
  type GuildTextBasedChannel,
  type MessageCreateOptions,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';
import type { StickyMessage } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { resolvePlaceholders } from '../../utils/placeholders.js';
import { openSecret, sealSecret } from '../../utils/secretBox.js';

/** TTL du cache de configuration. Invalidé explicitement par le dashboard. */
const CONFIG_TTL_SECONDS = 300;

/** Compteur de messages depuis le dernier envoi, par salon. */
const pendingCounts = new Map<string, number>();
/** Salons dont un renvoi est en cours : évite les doublons sur les rafales. */
const reposting = new Set<string>();
/**
 * Envoi sticky en place, par salon, pour que l'autothread ne lui ouvre pas de
 * fil : le sticky remonte à chaque seuil, chaque renvoi laisserait sinon un fil
 * vide derrière lui.
 *
 * Indexé par salon et non par message : un salon n'a qu'un sticky à la fois, et
 * un ensemble d'identifiants grossissait à chaque renvoi sans jamais se vider.
 */
const stickyMessageByChannel = new Map<string, string>();

function trackStickyMessage(channelId: string, messageId: string | null): void {
  if (messageId) stickyMessageByChannel.set(channelId, messageId);
  else stickyMessageByChannel.delete(channelId);
}

/**
 * Ce message est-il le sticky actuellement affiché dans son salon ?
 *
 * La carte mémoire n'est celle que du processus qui a posté. En mode distribué
 * l'autothread peut tourner ailleurs, d'où le repli sur la configuration
 * persistée, qui porte `lastMessageId`. Ce repli a du retard le temps que
 * l'écriture et l'invalidation du cache se propagent : c'est la même course que
 * celle déjà admise entre l'envoi et l'événement `message:new`.
 */
export async function isStickyMessage(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<boolean> {
  if (stickyMessageByChannel.get(channelId) === messageId) return true;

  const stickies = await getGuildStickies(guildId);
  return stickies.some((sticky) => sticky.channelId === channelId && sticky.lastMessageId === messageId);
}

function cacheKey(guildId: string): string {
  return `guild:${guildId}:sticky`;
}

/** Configurations sticky d'une guilde, indexées par salon. */
async function getGuildStickies(guildId: string): Promise<StickyMessage[]> {
  const cached = await cache.get<StickyMessage[]>(cacheKey(guildId));
  if (cached) return cached;

  const rows = await prisma.stickyMessage.findMany({ where: { guildId } }).catch((err) => {
    logger.error('Sticky', `Lecture des sticky de ${guildId} impossible`, err);
    return null;
  });
  if (!rows) return [];

  await cache.set(cacheKey(guildId), rows, CONFIG_TTL_SECONDS);
  return rows;
}

/** À appeler après toute écriture depuis le dashboard ou une commande. */
export async function invalidateStickyCache(guildId: string): Promise<void> {
  await cache.delete(cacheKey(guildId));
}

/** Remet à zéro le compteur mémoire d'un salon (suppression, renvoi manuel). */
export function resetStickyCounter(channelId: string): void {
  pendingCounts.delete(channelId);
}

// ── Payload JSON Discord ────────────────────────────────────────────────────

/** Taille maximale du JSON saisi : de quoi écrire dix embeds complets. */
export const STICKY_JSON_MAX_LENGTH = 65536;

/** Drapeau « composants v2 » : seul drapeau de message qu'on laisse passer. */
const IS_COMPONENTS_V2 = 1 << 15;

export type StickyJsonPayload = {
  content?: string;
  embeds?: APIEmbed[];
  components?: unknown[];
  flags?: number;
};

/**
 * Lit le JSON saisi dans le dashboard et n'en garde que ce qu'un message peut
 * porter : texte, embeds, composants. Les mentions sont coupées à l'envoi,
 * quel que soit le JSON. Retourne une erreur lisible sinon.
 */
export function parseStickyJsonPayload(raw: string): { ok: true; payload: StickyJsonPayload } | { ok: false; error: string } {
  if (raw.length > STICKY_JSON_MAX_LENGTH) return { ok: false, error: 'JSON trop long (65 536 caractères au maximum).' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'JSON invalide : vérifie les guillemets et les virgules.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Le JSON doit être un objet, par exemple { "content": "…" }.' };
  }
  const input = parsed as Record<string, unknown>;
  const payload: StickyJsonPayload = {};

  if (input.content !== undefined) {
    if (typeof input.content !== 'string') return { ok: false, error: '« content » doit être du texte.' };
    if (input.content.length > 2000) return { ok: false, error: '« content » dépasse 2 000 caractères.' };
    payload.content = input.content;
  }
  if (input.embeds !== undefined) {
    if (!Array.isArray(input.embeds) || input.embeds.some((e) => !e || typeof e !== 'object')) {
      return { ok: false, error: '« embeds » doit être une liste d’objets.' };
    }
    if (input.embeds.length > 10) return { ok: false, error: 'Dix embeds au maximum.' };
    payload.embeds = input.embeds as APIEmbed[];
  }
  if (input.components !== undefined) {
    if (!Array.isArray(input.components)) return { ok: false, error: '« components » doit être une liste.' };
    if (input.components.length > 40) return { ok: false, error: 'Trop de composants (40 au maximum).' };
    payload.components = input.components;
  }
  if (input.flags !== undefined) {
    if (input.flags !== IS_COMPONENTS_V2) return { ok: false, error: 'Seul le drapeau 32768 (composants v2) est accepté.' };
    payload.flags = IS_COMPONENTS_V2;
  }
  if (!payload.content && !payload.embeds?.length && !payload.components?.length) {
    return { ok: false, error: 'Le JSON ne contient rien à publier (content, embeds ou components).' };
  }
  return { ok: true, payload };
}

function buildPayload(sticky: StickyMessage, channel: GuildTextBasedChannel): MessageCreateOptions {
  const resolve = (text: string) => resolvePlaceholders(text, { guild: channel.guild });
  const allowedMentions = { parse: [] as never[] };

  if (sticky.jsonEnabled && sticky.jsonPayload) {
    const parsed = parseStickyJsonPayload(sticky.jsonPayload);
    if (parsed.ok) {
      const { payload } = parsed;
      return {
        content: payload.content ? resolve(payload.content) : undefined,
        embeds: payload.embeds?.map((embed) => ({
          ...embed,
          title: embed.title ? resolve(embed.title).slice(0, 256) : embed.title,
          description: embed.description ? resolve(embed.description).slice(0, 4096) : embed.description,
        })),
        components: payload.components as MessageCreateOptions['components'],
        flags: payload.flags as MessageCreateOptions['flags'],
        allowedMentions,
      };
    }
    logger.warn('Sticky', `JSON du sticky de ${sticky.channelId} illisible, repli sur le texte.`);
  }

  const content = resolve(sticky.content ?? '');
  if (!sticky.embedEnabled) {
    return { content, allowedMentions };
  }

  const embed = new EmbedBuilder().setDescription(content || '​');
  if (sticky.embedTitle) {
    embed.setTitle(resolve(sticky.embedTitle).slice(0, 256));
  }
  if (/^#[0-9a-fA-F]{6}$/.test(sticky.embedColor)) {
    embed.setColor(Number.parseInt(sticky.embedColor.slice(1), 16));
  }
  return { embeds: [embed], allowedMentions };
}

// ── Identité par webhook ────────────────────────────────────────────────────

/**
 * Webhook du salon par lequel le sticky publie. Repris s'il existe encore,
 * recréé sinon ; le jeton est stocké scellé. Null si le bot n'a pas la
 * permission Gérer les webhooks : le sticky repasse alors par le bot.
 */
async function ensureStickyWebhook(
  channel: TextChannel | NewsChannel,
  sticky: StickyMessage,
): Promise<WebhookClient | null> {
  const me = channel.guild.members.me;
  if (!me?.permissionsIn(channel).has(PermissionFlagsBits.ManageWebhooks)) return null;

  if (sticky.webhookId && sticky.webhookToken) {
    const token = openSecret(sticky.webhookToken);
    const hooks = await channel.fetchWebhooks().catch(() => null);
    if (token && hooks?.has(sticky.webhookId)) return new WebhookClient({ id: sticky.webhookId, token });
  }

  const hook = await channel.createWebhook({ name: 'Kotbo · sticky', reason: 'Message sticky sous identité personnalisée' }).catch(() => null);
  if (!hook?.token) return null;
  await prisma.stickyMessage.update({
    where: { id: sticky.id },
    data: { webhookId: hook.id, webhookToken: sealSecret(hook.token) },
  }).catch(() => null);
  sticky.webhookId = hook.id;
  return new WebhookClient({ id: hook.id, token: hook.token });
}

function resolveChannel(client: Client, channelId: string): GuildTextBasedChannel | null {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return null;
  return channel as GuildTextBasedChannel;
}

/**
 * Retire l'envoi précédent. Un message du webhook se supprime par le webhook
 * (le bot n'a pas forcément Gérer les messages) ; un message du bot, par le
 * bot - cas d'un sticky qui vient de changer d'identité.
 */
async function deletePreviousSticky(
  channel: GuildTextBasedChannel,
  sticky: StickyMessage,
  webhook: WebhookClient | null,
): Promise<void> {
  if (!sticky.lastMessageId) return;
  const previous = await channel.messages.fetch(sticky.lastMessageId).catch(() => null);
  if (!previous) return;
  if (webhook && previous.webhookId === webhook.id) {
    await webhook.deleteMessage(previous.id).catch(() => null);
    return;
  }
  await previous.delete().catch(() => null);
}

/**
 * Republie le sticky d'un salon : suppression de l'ancien envoi puis nouvel
 * envoi. Retourne l'id du nouveau message, ou null si l'envoi a échoué.
 */
export async function repostSticky(
  client: Client,
  sticky: StickyMessage,
  options: { force?: boolean } = {},
): Promise<string | null> {
  const channel = resolveChannel(client, sticky.channelId);
  if (!channel) return null;

  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  if (!me) return null;
  const perms = me.permissionsIn(channel);
  if (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
    return null;
  }
  if ((sticky.embedEnabled || sticky.jsonEnabled) && !perms.has(PermissionFlagsBits.EmbedLinks)) return null;

  // Cooldown : protège des rate limits quand un salon s'emballe. Le compteur
  // n'est pas remis à zéro, le renvoi aura donc lieu au message suivant.
  // `lastPostedAt` revient en chaîne ISO quand la config sort du cache Redis :
  // on repasse systématiquement par le constructeur Date.
  if (!options.force && sticky.lastPostedAt) {
    const elapsed = Date.now() - new Date(sticky.lastPostedAt as unknown as string).getTime();
    if (elapsed < sticky.cooldownSeconds * 1000) return null;
  }

  if (reposting.has(sticky.channelId)) return null;
  reposting.add(sticky.channelId);

  try {
    const payload = buildPayload(sticky, channel);
    const webhook = sticky.webhookEnabled
      ? await ensureStickyWebhook(channel as TextChannel | NewsChannel, sticky)
      : null;

    await deletePreviousSticky(channel, sticky, webhook);

    const sent = webhook
      ? await webhook.send({
        ...payload,
        username: sticky.webhookName || channel.guild.members.me?.displayName || undefined,
        avatarURL: sticky.webhookAvatarUrl || undefined,
      } as Parameters<WebhookClient['send']>[0]).catch((err: unknown) => {
        logger.error('Sticky', `Envoi du sticky par webhook impossible dans ${sticky.channelId}`, err);
        return null;
      })
      : await channel.send(payload).catch((err: unknown) => {
        logger.error('Sticky', `Envoi du sticky impossible dans ${sticky.channelId}`, err);
        return null;
      });
    webhook?.destroy();
    if (!sent) return null;
    trackStickyMessage(sticky.channelId, sent.id);

    await prisma.stickyMessage.update({
      where: { id: sticky.id },
      data: { lastMessageId: sent.id, lastPostedAt: new Date() },
    }).catch(() => null);
    await invalidateStickyCache(sticky.guildId);

    pendingCounts.delete(sticky.channelId);
    return sent.id;
  } finally {
    reposting.delete(sticky.channelId);
  }
}

/**
 * Compte un message dans le salon et déclenche le renvoi au franchissement du
 * seuil. Appelé pour chaque message de guilde, hors messages du bot lui-même.
 */
export async function handleStickyMessage(
  client: Client,
  guildId: string,
  channelId: string,
  authorId: string,
): Promise<void> {
  // Ne jamais compter nos propres envois : le sticky se relancerait lui-même.
  if (authorId === client.user?.id) return;

  const stickies = await getGuildStickies(guildId);
  if (stickies.length === 0) return;

  const sticky = stickies.find((s) => s.channelId === channelId);
  if (!sticky || !sticky.enabled) return;
  if (!(sticky.jsonEnabled ? sticky.jsonPayload?.trim() : sticky.content.trim())) return;
  // Un message de webhook a pour auteur le webhook : sans ce garde-fou, chaque
  // renvoi du sticky compterait comme un message et le relancerait.
  if (sticky.webhookId && authorId === sticky.webhookId) return;

  const count = (pendingCounts.get(channelId) ?? 0) + 1;
  pendingCounts.set(channelId, count);
  if (count < Math.max(1, sticky.messageThreshold)) return;

  await repostSticky(client, sticky);
}

/** Client du webhook enregistré, sans appel à Discord. Null s'il n'y en a pas. */
function storedWebhook(sticky: StickyMessage): WebhookClient | null {
  if (!sticky.webhookId || !sticky.webhookToken) return null;
  const token = openSecret(sticky.webhookToken);
  return token ? new WebhookClient({ id: sticky.webhookId, token }) : null;
}

/**
 * Supprime le sticky encore affiché dans un salon (désactivation, suppression
 * de la configuration depuis le dashboard).
 */
export async function clearStickyMessage(client: Client, sticky: StickyMessage): Promise<void> {
  resetStickyCounter(sticky.channelId);
  trackStickyMessage(sticky.channelId, null);
  if (!sticky.lastMessageId) return;

  const channel = resolveChannel(client, sticky.channelId);
  if (!channel) return;

  const webhook = storedWebhook(sticky);
  await deletePreviousSticky(channel, sticky, webhook);
  webhook?.destroy();
}

/**
 * Supprime le webhook créé pour le sticky (suppression de la configuration ou
 * retour à l'identité du bot) : il ne servirait plus qu'à encombrer la liste
 * des intégrations du salon.
 */
export async function deleteStickyWebhook(sticky: StickyMessage): Promise<void> {
  const webhook = storedWebhook(sticky);
  if (!webhook) return;
  await webhook.delete('Sticky supprimé ou repassé sous l’identité du bot').catch(() => null);
  webhook.destroy();
}
