/**
 * emojiBanService.ts - Emojis, stickers et serveurs d'origine interdits.
 *
 * Chaque règle porte sa propre sanction (voir autoSanction). Quatre types :
 *   EMOJI         emoji personnalisé, par id
 *   UNICODE       emoji natif (sans sélecteur de variation ni teinte de peau)
 *   STICKER       sticker, par id
 *   SOURCE_GUILD  tous les emojis et stickers venant d'un serveur
 *
 * Limite connue : le serveur d'origine d'un emoji n'est retrouvé que si Kotbo
 * est lui-même sur ce serveur (cache d'emojis du client). Les stickers sont
 * résolus par l'API, donc sans cette limite.
 * Les réactions ne sont pas analysées, seulement le contenu des messages.
 */

import { GuildFeature, type Client, type Guild, type Message } from 'discord.js';
import type { EmojiBanRule, Prisma } from '@prisma/client';
import { kotboEventBus } from '@kotbo/core';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { AUTO_SANCTIONS, MAX_AUTO_SANCTION_DURATION_MIN, applyAutoSanction, autoSanctionLabel, normalizeAutoSanction, type AutoSanction } from './autoSanction.js';
import { resolveEventLogChannel } from '../../utils/logDispatch.js';

export const EMOJI_BAN_KINDS = ['EMOJI', 'UNICODE', 'STICKER', 'SOURCE_GUILD'] as const;
export type EmojiBanKind = (typeof EMOJI_BAN_KINDS)[number];

export const MAX_EMOJI_BAN_RULES = 200;
const CACHE_TTL_MS = 60_000;

// ── Règles (cache court, invalidé à chaque écriture) ─────────────────────────

const rulesCache = new Map<string, { at: number; rules: EmojiBanRule[] }>();

export function invalidateEmojiBans(guildId: string): void {
  rulesCache.delete(guildId);
}

export async function loadEmojiBans(guildId: string): Promise<EmojiBanRule[]> {
  const hit = rulesCache.get(guildId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rules;
  const rules = await prisma.emojiBanRule.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } });
  rulesCache.set(guildId, { at: Date.now(), rules });
  return rules;
}

export type EmojiBanInput = {
  kind: EmojiBanKind;
  key: string;
  name?: string | null;
  iconUrl?: string | null;
  action?: unknown;
  durationMin?: number | null;
  createdBy?: string | null;
};

/** Clé canonique d'un emoji natif : sans sélecteur de variation ni teinte de peau. */
export function normalizeUnicodeEmoji(value: string): string {
  return value.replace(/️/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Valide une entrée venue du dashboard ou du clic droit ; `null` si elle est inutilisable. */
export function sanitizeEmojiBan(input: EmojiBanInput): {
  kind: EmojiBanKind; key: string; name: string | null; iconUrl: string | null;
  action: AutoSanction; durationMin: number | null; createdBy: string | null;
} | null {
  if (!EMOJI_BAN_KINDS.includes(input.kind)) return null;
  const key = input.kind === 'UNICODE' ? normalizeUnicodeEmoji(String(input.key ?? '').trim()) : String(input.key ?? '').trim();
  if (!key || key.length > 64) return null;
  if (input.kind !== 'UNICODE' && !SNOWFLAKE.test(key)) return null;
  if (input.kind === 'UNICODE' && !isUnicodeEmoji(key)) return null;
  const action = normalizeAutoSanction(input.action, 'DELETE');
  const needsDuration = action === 'TIMEOUT' || action === 'BAN' || action === 'JAIL';
  const duration = needsDuration && typeof input.durationMin === 'number' && Number.isFinite(input.durationMin)
    ? Math.min(MAX_AUTO_SANCTION_DURATION_MIN, Math.max(1, Math.round(input.durationMin)))
    : null;
  const iconUrl = typeof input.iconUrl === 'string' && input.iconUrl.startsWith('https://cdn.discordapp.com/') ? input.iconUrl : null;
  return {
    kind: input.kind,
    key,
    name: typeof input.name === 'string' ? input.name.slice(0, 100) : null,
    iconUrl,
    action,
    durationMin: duration,
    createdBy: input.createdBy ?? null,
  };
}

/** Crée ou remplace la règle (un même élément n'a qu'une sanction). */
export async function upsertEmojiBan(guildId: string, input: EmojiBanInput): Promise<EmojiBanRule | { error: string }> {
  const data = sanitizeEmojiBan(input);
  if (!data) return { error: 'Élément invalide.' };
  const exists = await prisma.emojiBanRule.findUnique({ where: { guildId_kind_key: { guildId, kind: data.kind, key: data.key } }, select: { id: true } });
  if (!exists && (await prisma.emojiBanRule.count({ where: { guildId } })) >= MAX_EMOJI_BAN_RULES) {
    return { error: `${MAX_EMOJI_BAN_RULES} règles au plus par serveur.` };
  }
  const { kind, key, ...rest } = data;
  const rule = await prisma.emojiBanRule.upsert({
    where: { guildId_kind_key: { guildId, kind, key } },
    create: { guildId, kind, key, ...rest },
    update: { name: rest.name, iconUrl: rest.iconUrl, action: rest.action, durationMin: rest.durationMin },
  });
  invalidateEmojiBans(guildId);
  return rule;
}

export async function deleteEmojiBan(guildId: string, id: string): Promise<EmojiBanRule | null> {
  const rule = await prisma.emojiBanRule.findFirst({ where: { id, guildId } });
  if (!rule) return null;
  await prisma.emojiBanRule.delete({ where: { id } });
  invalidateEmojiBans(guildId);
  return rule;
}

// ── Extraction ───────────────────────────────────────────────────────────────

export type FoundCustomEmoji = { id: string; name: string; animated: boolean };

const CUSTOM_EMOJI = /<(a?):(\w+):(\d{17,20})>/g;
const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function isUnicodeEmoji(grapheme: string): boolean {
  return UNICODE_EMOJI.test(grapheme);
}

export function extractCustomEmojis(content: string): FoundCustomEmoji[] {
  const found = new Map<string, FoundCustomEmoji>();
  for (const m of content.matchAll(CUSTOM_EMOJI)) {
    if (!found.has(m[3]!)) found.set(m[3]!, { id: m[3]!, name: m[2]!, animated: m[1] === 'a' });
  }
  return [...found.values()];
}

/** Emojis natifs du texte, dédoublonnés, sous leur clé canonique. */
export function extractUnicodeEmojis(content: string): string[] {
  const text = content.replace(CUSTOM_EMOJI, ' ');
  const found = new Set<string>();
  for (const { segment } of segmenter.segment(text)) {
    if (isUnicodeEmoji(segment)) found.add(normalizeUnicodeEmoji(segment));
  }
  return [...found];
}

// Fiches que Kotbo tient de sa propre présence : comme Discord, un serveur privé ne se révèle pas à un autre.
const PRIVATE_SOURCES = new Set(['bot', 'cache']);

export function isPublicGuildRecord(client: Client, row: { guildId: string; source: string }): boolean {
  return !PRIVATE_SOURCES.has(row.source) || Boolean(client.guilds.cache.get(row.guildId)?.features.includes(GuildFeature.Discoverable));
}

/** La même règle en filtre de requête, pour l'appliquer avant toute limite de résultats. */
export function publicGuildRecordWhere(client: Client): Prisma.DiscordExternalGuildWhereInput {
  const discoverable = client.guilds.cache.filter((guild) => guild.features.includes(GuildFeature.Discoverable)).map((guild) => guild.id);
  return { OR: [{ source: { notIn: [...PRIVATE_SOURCES] } }, { guildId: { in: discoverable } }] };
}

export function customEmojiUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=64`;
}

// ── Serveur d'origine ────────────────────────────────────────────────────────

const stickerGuildCache = new Map<string, string | null>();

export function emojiSourceGuildId(client: Client, emojiId: string): string | null {
  return client.emojis.cache.get(emojiId)?.guild.id ?? null;
}

export async function stickerSourceGuildId(message: Message, stickerId: string): Promise<string | null> {
  if (stickerGuildCache.has(stickerId)) return stickerGuildCache.get(stickerId)!;
  const item = message.stickers.get(stickerId);
  const full = item ? await item.fetch().catch(() => null) : null;
  const guildId = full?.guildId ?? null;
  stickerGuildCache.set(stickerId, guildId);
  if (stickerGuildCache.size > 2000) stickerGuildCache.delete(stickerGuildCache.keys().next().value!);
  return guildId;
}

// ── Détection ────────────────────────────────────────────────────────────────

type Hit = { rule: EmojiBanRule; label: string };

async function findHits(message: Message, rules: EmojiBanRule[]): Promise<Hit[]> {
  const byKey = new Map(rules.map((r) => [`${r.kind}:${r.key}`, r]));
  const sources = rules.filter((r) => r.kind === 'SOURCE_GUILD');
  const hits: Hit[] = [];

  for (const emoji of extractCustomEmojis(message.content)) {
    const rule = byKey.get(`EMOJI:${emoji.id}`);
    if (rule) hits.push({ rule, label: `:${emoji.name}:` });
    const origin = sources.length ? emojiSourceGuildId(message.client, emoji.id) : null;
    const source = origin ? byKey.get(`SOURCE_GUILD:${origin}`) : undefined;
    if (source) hits.push({ rule: source, label: `:${emoji.name}: (${source.name ?? origin})` });
  }

  for (const char of extractUnicodeEmojis(message.content)) {
    const rule = byKey.get(`UNICODE:${char}`);
    if (rule) hits.push({ rule, label: char });
  }

  for (const sticker of message.stickers.values()) {
    const rule = byKey.get(`STICKER:${sticker.id}`);
    if (rule) hits.push({ rule, label: `sticker ${sticker.name}` });
    const origin = sources.length ? await stickerSourceGuildId(message, sticker.id) : null;
    const source = origin ? byKey.get(`SOURCE_GUILD:${origin}`) : undefined;
    if (source) hits.push({ rule: source, label: `sticker ${sticker.name} (${source.name ?? origin})` });
  }
  return hits;
}

/** La sanction la plus lourde l'emporte quand un message cumule plusieurs interdits. */
function strictest(hits: Hit[]): Hit {
  return hits.reduce((a, b) => (AUTO_SANCTIONS.indexOf(b.rule.action as AutoSanction) > AUTO_SANCTIONS.indexOf(a.rule.action as AutoSanction) ? b : a));
}

/**
 * Supprime le message et sanctionne selon la règle touchée.
 * @returns true si le message contenait un interdit (traitement à interrompre).
 */
export async function handleEmojiBan(message: Message, client: Client): Promise<boolean> {
  const guild = message.guild as Guild | null;
  if (!guild || !message.member) return false;

  const rules = await loadEmojiBans(guild.id);
  if (rules.length === 0) return false;
  if (!message.content && message.stickers.size === 0) return false;

  const hits = await findHits(message, rules);
  if (hits.length === 0) return false;

  const top = strictest(hits);
  const action = normalizeAutoSanction(top.rule.action, 'DELETE');
  const labels = [...new Set(hits.map((h) => h.label))].slice(0, 5).join(', ');
  const reason = `[AutoMod] Emoji ou sticker interdit : ${labels}`;

  await message.delete().catch((e) => logger.warn('EmojiBan', 'Impossible de supprimer le message :', e));

  kotboEventBus.publish('automod:triggered', {
    guildId: guild.id,
    userId: message.author.id,
    channelId: message.channelId,
    rule: 'Emoji ou sticker interdit',
    matchedContent: message.content ? message.content.slice(0, 1000) : null,
    action: action === 'DELETE' ? 'DELETE' : action === 'TIMEOUT' ? 'TIMEOUT' : 'WARN',
    timestamp: Date.now(),
  });

  const result = await applyAutoSanction({
    client,
    guild,
    user: message.author,
    member: message.member,
    action,
    durationMin: top.rule.durationMin,
    reason,
  });

  if (message.channel.isSendable()) {
    const notice = await message.channel
      .send({ content: `⚠️ <@${message.author.id}>, ce message contenait un emoji ou un sticker interdit ici.`, allowedMentions: { users: [message.author.id] } })
      .catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => null), 6000);
  }

  try {
    const channel = await resolveEventLogChannel(guild, 'automod_emoji', 'EmojiBan');
    await channel?.send({
      content: `🛡️ **Emoji ou sticker interdit** · <@${message.author.id}> dans <#${message.channelId}>\n` +
        `Interdit : ${labels}\nSanction : ${autoSanctionLabel(result.applied, top.rule.durationMin)}${result.done ? '' : ' (non appliquée)'}`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    logger.warn('EmojiBan', "Impossible d'envoyer le log :", err);
  }
  return true;
}
