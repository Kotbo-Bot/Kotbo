/**
 * visionService.ts - Kotbo Vision, le filtre d'images d'arnaque.
 *
 * Chaque image postée (pièce jointe, embed, message transféré, sticker) est
 * comparée par empreinte (imageForensics) à trois registres :
 *  - le catalogue global, fait d'images confirmées sur plusieurs serveurs ;
 *  - le catalogue du serveur, alimenté par son honeypot et ses confirmations ;
 *  - les listes personnalisées, où le staff range ses propres images interdites.
 *
 * Correspondance certaine : message supprimé, auteur sanctionné, et la
 * variante rejoint le registre (une image recadrée une fois le sera encore).
 * Correspondance incertaine : message supprimé par précaution, sans sanction,
 * et signalé dans un salon de vérification où le staff tranche. Sans salon de
 * vérification, rien ne se passe : on ne supprime pas sur un doute que
 * personne ne pourra lever.
 */

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  StickerFormatType,
  type Client,
  type Guild,
  type Message,
  type TextBasedChannel,
  type User,
} from 'discord.js';
import { createHash } from 'node:crypto';
import type { RaidProtectionConfig, VisionList } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import { fetchExternal } from '../../utils/http.js';
import { getCachedGuild } from '../../utils/cache.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import { getRaidProtectionConfig } from './raidProtectionService.js';
import {
  analyzeImage,
  compareFingerprints,
  compareWindows,
  compareWithLegacy,
  computeWindowHashes,
  parseFingerprint,
  parseLegacyHash,
  serializeFingerprint,
  windowShapesFor,
  type FingerprintComparison,
  type ImageAnalysis,
  type ParsedFingerprint,
} from './imageForensics.js';
import { applyAutoSanction, autoSanctionLabel, normalizeAutoSanction, type AutoSanction } from './autoSanction.js';
import { readImageText } from './ocrService.js';
import { compactOcrText } from './scamHeuristics.js';
import { promoteImageIfWidespread, recordScamSignals } from './scamDatasetService.js';
import { detectInImageText, reasonForScamDetection } from './phishingFeedService.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 8;
/** Variantes apprises au plus par entrée : au-delà, la dérive n'apporte plus rien. */
const MAX_VARIANTS_PER_ENTRY = 25;
/** Listes personnalisées par serveur. */
export const MAX_LISTS_PER_GUILD = 10;
/** Images ajoutées au plus en un envoi. */
export const MAX_IMAGES_PER_UPLOAD = 25;

// ── Collecte des images d'un message ────────────────────────────────────────

type ImageSource = { url: string; name: string; origin: 'attachment' | 'embed' | 'forward' | 'sticker' };

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|avif)(\?|$)/i;

function attachmentImages(attachments: Message['attachments'], origin: ImageSource['origin']): ImageSource[] {
  return [...attachments.values()]
    .filter((a) => a.contentType?.startsWith('image/') || IMAGE_EXTENSION.test(a.name))
    .map((a) => ({ url: a.url, name: a.name, origin }));
}

function embedImages(embeds: Message['embeds'], origin: ImageSource['origin']): ImageSource[] {
  const out: ImageSource[] = [];
  for (const embed of embeds) {
    // Le proxy Discord sert l'image même quand le site d'origine la retire.
    const image = embed.image?.proxyURL ?? embed.image?.url;
    if (image) out.push({ url: image, name: 'embed-image', origin });
    const thumb = embed.thumbnail?.proxyURL ?? embed.thumbnail?.url;
    if (thumb && thumb !== image) out.push({ url: thumb, name: 'embed-thumbnail', origin });
  }
  return out;
}

/**
 * Toutes les images d'un message, y compris celles d'un message transféré :
 * transférer un message d'un autre serveur est devenu le moyen le plus simple
 * de rediffuser une arnaque sans la reposter.
 */
export function collectImageSources(message: Message): ImageSource[] {
  const sources: ImageSource[] = [
    ...attachmentImages(message.attachments, 'attachment'),
    ...embedImages(message.embeds, 'embed'),
  ];
  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    sources.push(...attachmentImages(snapshot.attachments, 'forward'), ...embedImages(snapshot.embeds, 'forward'));
  }
  for (const sticker of message.stickers.values()) {
    if (sticker.format === StickerFormatType.Lottie) continue;
    sources.push({ url: sticker.url, name: `sticker-${sticker.name}`, origin: 'sticker' });
  }
  const seen = new Set<string>();
  return sources.filter((s) => !seen.has(s.url) && seen.add(s.url)).slice(0, MAX_IMAGES_PER_MESSAGE);
}

export type AnalyzedImage = {
  source: ImageSource;
  buffer: Buffer;
  sha256: string;
  analysis: ImageAnalysis;
};

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetchExternal(url, {}, 5_000);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return Buffer.from(buf);
  } catch {
    return null;
  }
}

export async function analyzeBuffer(buffer: Buffer, source: ImageSource, withThumb = false): Promise<AnalyzedImage | null> {
  const analysis = await analyzeImage(buffer, { thumb: withThumb });
  if (!analysis) return null;
  return { source, buffer, sha256: createHash('sha256').update(buffer).digest('hex'), analysis };
}

async function analyzeSources(sources: ImageSource[]): Promise<AnalyzedImage[]> {
  const results = await Promise.all(
    sources.map(async (source) => {
      const buffer = await downloadImage(source.url);
      return buffer ? analyzeBuffer(buffer, source) : null;
    })
  );
  return results.filter((r): r is AnalyzedImage => r !== null);
}

// ── Catalogue ───────────────────────────────────────────────────────────────

type CatalogEntry = {
  id: string;
  guildId: string | null;
  listId: string | null;
  status: 'BLOCKED' | 'ALLOWED';
  hash: string;
  filename: string | null;
  fp: ParsedFingerprint | null;
  legacy: ReturnType<typeof parseLegacyHash>;
};

type GuildCatalog = {
  entries: CatalogEntry[];
  /** Entrées soumises à la recherche par fenêtres (listes et serveur). */
  windowEntries: CatalogEntry[];
  windowShapes: number[];
  lists: Map<string, VisionList>;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const GLOBAL_LIMIT = 20_000;
const GUILD_LIMIT = 10_000;
const WINDOW_LIMIT = 400;

let globalCache: { entries: CatalogEntry[]; expiresAt: number } | null = null;
const guildCache = new Map<string, GuildCatalog & { expiresAt: number }>();

export function invalidateVisionCache(guildId?: string): void {
  if (guildId) guildCache.delete(guildId);
  else {
    guildCache.clear();
    globalCache = null;
  }
}

const ENTRY_SELECT = { id: true, guildId: true, listId: true, status: true, hash: true, filename: true, fingerprint: true, phash: true } as const;

function toEntry(row: { id: string; guildId: string | null; listId: string | null; status: string; hash: string; filename: string | null; fingerprint: string | null; phash: string | null }): CatalogEntry {
  return {
    id: row.id,
    guildId: row.guildId,
    listId: row.listId,
    status: row.status === 'ALLOWED' ? 'ALLOWED' : 'BLOCKED',
    hash: row.hash,
    filename: row.filename,
    fp: parseFingerprint(row.fingerprint),
    legacy: row.fingerprint ? null : parseLegacyHash(row.phash),
  };
}

async function loadGlobalEntries(): Promise<CatalogEntry[]> {
  if (globalCache && globalCache.expiresAt > Date.now()) return globalCache.entries;
  const rows = await prisma.scamImageHash.findMany({
    where: { guildId: null, status: 'BLOCKED', OR: [{ fingerprint: { not: null } }, { phash: { not: null } }] },
    select: ENTRY_SELECT,
    orderBy: [{ hits: 'desc' }, { createdAt: 'desc' }],
    take: GLOBAL_LIMIT,
  });
  const entries = rows.map(toEntry);
  globalCache = { entries, expiresAt: Date.now() + CACHE_TTL_MS };
  return entries;
}

async function loadGuildCatalog(guildId: string): Promise<GuildCatalog> {
  const cached = guildCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const [lists, rows] = await Promise.all([
    prisma.visionList.findMany({ where: { guildId } }),
    prisma.scamImageHash.findMany({
      where: { guildId, OR: [{ fingerprint: { not: null } }, { phash: { not: null } }] },
      select: ENTRY_SELECT,
      orderBy: [{ hits: 'desc' }, { createdAt: 'desc' }],
      take: GUILD_LIMIT,
    }),
  ]);
  const listMap = new Map(lists.map((l) => [l.id, l]));
  // Une liste désactivée garde ses images mais ne bloque plus rien.
  const entries = rows.map(toEntry).filter((e) => !e.listId || listMap.get(e.listId)?.enabled);
  // Les listes d'abord : ce sont les images que le staff a choisi de traquer.
  const windowEntries = entries
    .filter((e) => e.status === 'BLOCKED' && e.fp)
    .sort((a, b) => Number(Boolean(b.listId)) - Number(Boolean(a.listId)))
    .slice(0, WINDOW_LIMIT);
  const catalog: GuildCatalog = {
    entries,
    windowEntries,
    windowShapes: windowShapesFor(windowEntries.map((e) => e.fp!.rawAspect), 2),
    lists: listMap,
  };
  guildCache.set(guildId, { ...catalog, expiresAt: Date.now() + CACHE_TTL_MS });
  return catalog;
}

export type VisionMatch = {
  image: AnalyzedImage;
  entry: CatalogEntry;
  verdict: 'CERTAIN' | 'UNCERTAIN';
  comparison: FingerprintComparison;
  via: 'exact' | 'fingerprint' | 'window';
};

function compareEntry(image: AnalyzedImage, entry: CatalogEntry): FingerprintComparison | null {
  if (entry.fp) return compareFingerprints(image.analysis.fingerprint, entry.fp);
  if (entry.legacy) return compareWithLegacy(image.analysis.fingerprint, entry.legacy);
  return null;
}

/**
 * Meilleure correspondance d'une image. Une image écartée par le staff
 * (ALLOWED) qui lui correspond avec certitude l'emporte : elle a déjà été
 * jugée saine, on ne la resignale pas.
 */
async function matchImage(guildId: string, image: AnalyzedImage, catalog: GuildCatalog, globals: CatalogEntry[]): Promise<VisionMatch | null> {
  // 1. Égalité exacte des octets, en base (index sur hash).
  const exact = await prisma.scamImageHash.findMany({
    where: { hash: image.sha256, OR: [{ guildId }, { guildId: null }] },
    select: ENTRY_SELECT,
  });
  const exactEntries = exact.map(toEntry).filter((e) => !e.listId || catalog.lists.get(e.listId)?.enabled);
  if (exactEntries.some((e) => e.status === 'ALLOWED' && e.guildId === guildId)) return null;
  const exactBlocked = exactEntries.find((e) => e.status === 'BLOCKED');
  if (exactBlocked) {
    return { image, entry: exactBlocked, verdict: 'CERTAIN', comparison: { verdict: 'CERTAIN', distance: 0, similarity: 1 }, via: 'exact' };
  }

  // 2. Empreinte, contre le serveur puis le global.
  let best: VisionMatch | null = null;
  let allowedCertain = false;
  for (const entry of [...catalog.entries, ...globals]) {
    const comparison = compareEntry(image, entry);
    if (!comparison?.verdict) continue;
    if (entry.status === 'ALLOWED') {
      if (comparison.verdict === 'CERTAIN') allowedCertain = true;
      continue;
    }
    if (!best || comparison.distance < best.comparison.distance) {
      best = { image, entry, verdict: comparison.verdict, comparison, via: 'fingerprint' };
    }
  }
  if (allowedCertain) return null;
  if (best?.verdict === 'CERTAIN') return best;

  // 3. Fenêtres : l'image connue incrustée dans une capture. Réservé aux
  // listes et au serveur, le coût restant borné quel que soit le global.
  if (!best && catalog.windowEntries.length > 0) {
    const windows = computeWindowHashes(image.analysis.gray, catalog.windowShapes, 3);
    for (const entry of catalog.windowEntries) {
      const comparison = compareWindows(windows, entry.fp!);
      if (comparison.verdict && (!best || comparison.distance < best.comparison.distance)) {
        best = { image, entry, verdict: comparison.verdict, comparison, via: 'window' };
      }
    }
  }
  return best;
}

export async function findVisionMatch(guildId: string, images: AnalyzedImage[]): Promise<VisionMatch | null> {
  if (images.length === 0) return null;
  const [catalog, globals] = await Promise.all([loadGuildCatalog(guildId), loadGlobalEntries()]);
  let best: VisionMatch | null = null;
  for (const image of images) {
    const match = await matchImage(guildId, image, catalog, globals);
    if (!match) continue;
    if (match.verdict === 'CERTAIN') return match;
    if (!best || match.comparison.distance < best.comparison.distance) best = match;
  }
  return best;
}

// ── Traitement d'un message ─────────────────────────────────────────────────

function sanctionFor(config: RaidProtectionConfig, list: VisionList | undefined): { action: AutoSanction; durationMin: number | null } {
  if (list?.sanction) return { action: normalizeAutoSanction(list.sanction, 'TIMEOUT'), durationMin: list.durationMin };
  return { action: normalizeAutoSanction(config.visionSanction, 'TIMEOUT'), durationMin: config.visionDurationMin };
}

function reasonFor(match: VisionMatch, list: VisionList | undefined): string {
  const where = list ? `image de la liste « ${list.name} »` : match.entry.guildId ? 'image d\'arnaque déjà signalée sur ce serveur' : 'image d\'arnaque connue (catalogue global)';
  const how = match.via === 'exact' ? 'copie exacte' : match.via === 'window' ? 'retrouvée dans une capture' : `variante à ${Math.round(match.comparison.similarity * 100)} %`;
  return `Kotbo Vision : ${where}, ${how}`;
}

/** Mémorise une image comme variante d'une entrée, pour la reconnaître du premier coup. */
async function learnVariant(guildId: string, parent: CatalogEntry, image: AnalyzedImage): Promise<void> {
  const variants = await prisma.scamImageHash.count({ where: { parentId: parent.id } });
  if (variants >= MAX_VARIANTS_PER_ENTRY) return;
  const thumbed = image.analysis.thumb ? image : await analyzeBuffer(image.buffer, image.source, true);
  await prisma.scamImageHash
    .create({
      data: {
        // Une variante d'une image globale est rangée sur le serveur : c'est la
        // promotion (plusieurs serveurs) qui décide de ce qui devient global.
        guildId,
        listId: parent.guildId === guildId ? parent.listId : null,
        parentId: parent.id,
        hash: image.sha256,
        phash: image.analysis.phash,
        fingerprint: serializeFingerprint(image.analysis.fingerprint),
        thumb: thumbed?.analysis.thumb ?? null,
        filename: image.source.name,
        source: 'VARIANT',
      },
    })
    .catch(() => null); // Déjà connue (course entre deux messages identiques).
  if (!parent.listId) {
    await promoteImageIfWidespread(
      image.sha256,
      image.analysis.phash,
      image.source.name,
      serializeFingerprint(image.analysis.fingerprint),
      thumbed?.analysis.thumb ?? null
    ).catch(() => null);
  }
}

async function recordHit(entryId: string): Promise<void> {
  await prisma.scamImageHash.update({ where: { id: entryId }, data: { hits: { increment: 1 }, lastSeenAt: new Date() } }).catch(() => null);
}

function isExempt(message: Message): boolean {
  const permissions = message.member?.permissions;
  return Boolean(permissions?.has(PermissionFlagsBits.ManageMessages) || permissions?.has(PermissionFlagsBits.ManageGuild));
}

/**
 * Point d'entrée : analyse les images d'un message et applique Kotbo Vision.
 * Retourne true si le message a été supprimé.
 */
export type DeepImageDetection = {
  image: AnalyzedImage;
  via: 'qr' | 'ocr';
  reason: string;
};

/**
 * Auto-indexe dans le catalogue Kotbo Vision une image inédite piégée par QR ou OCR :
 * la prochaine fois que la campagne la rediffuse (même recadrée ou transférée),
 * elle sera bloquée dès l'étape d'empreinte visuelle en ~3 ms sans relancer l'OCR.
 */
async function autoIndexDetectedImage(
  guildId: string,
  addedBy: string,
  image: AnalyzedImage,
  source: 'QR' | 'OCR',
  ocrText: string | null
): Promise<void> {
  if (image.analysis.fingerprint.flat) return;
  const thumbed = image.analysis.thumb ? image : await analyzeBuffer(image.buffer, image.source, true);
  const fingerprint = serializeFingerprint(image.analysis.fingerprint);
  const thumb = thumbed?.analysis.thumb ?? null;
  const compactText = ocrText ? compactOcrText(ocrText) : null;

  await prisma.scamImageHash
    .upsert({
      where: { guildId_hash: { guildId, hash: image.sha256 } },
      create: {
        guildId,
        hash: image.sha256,
        phash: image.analysis.phash,
        fingerprint,
        thumb,
        filename: image.source.name.slice(0, 200),
        source,
        status: 'BLOCKED',
        addedBy,
        ocrText: compactText,
      },
      update: {
        phash: image.analysis.phash,
        fingerprint,
        ...(thumb ? { thumb } : {}),
        ...(compactText ? { ocrText: compactText } : {}),
      },
    })
    .catch(() => null);

  await promoteImageIfWidespread(image.sha256, image.analysis.phash, image.source.name, fingerprint, thumb).catch(
    () => null
  );
  invalidateVisionCache(guildId);
}

/**
 * Seconde passe Kotbo Vision sur des images dont l'empreinte visuelle est encore inconnue :
 * combine la détection de code QR (déjà calculée lors du décodage) et la lecture OCR
 * couplée aux heuristiques, aux flux GitHub de phishing et au jeu de données honeypot.
 */
export async function inspectUnmatchedImages(
  guildId: string,
  authorId: string,
  images: AnalyzedImage[],
  config: RaidProtectionConfig
): Promise<DeepImageDetection | null> {
  if (images.length === 0) return null;
  if (!config.scamQrFilterEnabled && !config.scamOcrEnabled) return null;

  const profile = await prisma.memberProfile
    .findUnique({
      where: { guildId_userId: { guildId, userId: authorId } },
      select: { messageCount: true },
    })
    .catch(() => null);

  if ((profile?.messageCount ?? 0) > config.scamQrTrustedMessages) return null;

  if (config.scamQrFilterEnabled) {
    const qrImage = images.find((img) => img.analysis.qr.detected);
    if (qrImage) {
      await autoIndexDetectedImage(guildId, authorId, qrImage, 'QR', null);
      return {
        image: qrImage,
        via: 'qr',
        reason: 'Kotbo Vision : code QR posté par un compte sans historique (phishing par QR de connexion, auto-indexé)',
      };
    }
  }

  if (config.scamOcrEnabled) {
    for (const image of images) {
      const ocrText = await readImageText(image.buffer);
      if (!ocrText) continue;
      const found = await detectInImageText(guildId, ocrText, config).catch(() => null);
      if (found?.matched) {
        await recordScamSignals(guildId, ocrText, 'OCR', { countRepeat: true }).catch(() => null);
        await autoIndexDetectedImage(guildId, authorId, image, 'OCR', ocrText);
        return {
          image,
          via: 'ocr',
          reason: `Kotbo Vision : ${reasonForScamDetection(found)} (lu par OCR et auto-indexé)`,
        };
      }
    }
  }

  return null;
}

async function handleDeepImageInspection(
  message: Message<true>,
  images: AnalyzedImage[],
  config: RaidProtectionConfig | null
): Promise<boolean> {
  if (!config || !message.member) return false;
  const detected = await inspectUnmatchedImages(message.guild.id, message.author.id, images, config);
  if (!detected) return false;

  await message.delete().catch(() => null);
  const { action, durationMin } = sanctionFor(config, undefined);
  const result = await applyAutoSanction({
    client: message.client,
    guild: message.guild,
    user: message.author,
    member: message.member,
    action,
    durationMin,
    reason: detected.reason,
    jailSource: 'VISION',
  });

  logger.warn(
    'Kotbo Vision',
    `${message.guild.id} : image inédite bloquée et auto-indexée de ${message.author.id} (${detected.via}) - ${result.applied}`
  );

  const sanctionLabel = result.done ? autoSanctionLabel(result.applied, durationMin) : 'Message supprimé seulement';
  if (config.visionNotifyMember && result.done && result.applied !== 'DELETE') {
    await notifyAuthor(message.author, message.guild, detected.reason, sanctionLabel);
  }
  await logDeepBlocked(message, detected, sanctionLabel, config);
  return true;
}

async function logDeepBlocked(
  message: Message<true>,
  detected: DeepImageDetection,
  sanction: string,
  config: RaidProtectionConfig
): Promise<void> {
  const channel = await logChannelFor(message.guild, config);
  if (!channel || !('send' in channel)) return;
  const file = new AttachmentBuilder(detected.image.buffer, { name: 'image.png' });
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('🔍 Kotbo Vision : image d\'arnaque auto-apprise')
    .addFields(
      { name: 'Membre', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
      { name: 'Salon', value: `<#${message.channelId}>`, inline: true },
      { name: 'Sanction', value: sanction, inline: true },
      { name: 'Détection', value: detected.via === 'qr' ? 'Code QR suspect' : 'Lecture OCR + heuristiques', inline: true },
      { name: 'Apprentissage', value: 'Empreinte indexée dans le catalogue', inline: true },
      { name: 'Motif', value: detected.reason, inline: false },
    )
    .setImage('attachment://image.png')
    .setTimestamp();
  await channel.send({ embeds: [embed], files: [file], allowedMentions: { parse: [] } }).catch(() => null);
}

export async function handleVision(message: Message): Promise<boolean> {
  if (!message.inGuild() || !message.member || message.author.bot) return false;
  if (message.attachments.size === 0 && message.embeds.length === 0 && message.stickers.size === 0 && !message.messageSnapshots?.size) return false;
  if (isExempt(message)) return false;

  const config = await getRaidProtectionConfig(message.guild.id);
  // Actif par défaut : un serveur sans configuration est protégé aussi.
  if (config && !config.visionEnabled) return false;

  const sources = collectImageSources(message);
  if (sources.length === 0) return false;
  const images = await analyzeSources(sources);
  const match = await findVisionMatch(message.guild.id, images);
  if (!match) return handleDeepImageInspection(message, images, config);

  const effectiveConfig = config ?? (await prisma.raidProtectionConfig.upsert({ where: { guildId: message.guild.id }, create: { guildId: message.guild.id }, update: {} }));
  const catalog = await loadGuildCatalog(message.guild.id);
  const list = match.entry.listId ? catalog.lists.get(match.entry.listId) : undefined;

  if (match.verdict === 'UNCERTAIN') return handleUncertain(message, match, list, effectiveConfig);

  await message.delete().catch(() => null);
  await recordHit(match.entry.id);
  if (match.via !== 'exact') await learnVariant(message.guild.id, match.entry, match.image);
  invalidateVisionCache(message.guild.id);

  const reason = reasonFor(match, list);
  const { action, durationMin } = sanctionFor(effectiveConfig, list);
  const result = await applyAutoSanction({
    client: message.client,
    guild: message.guild,
    user: message.author,
    member: message.member,
    action,
    durationMin,
    reason,
    jailSource: 'VISION',
  });

  logger.warn('Kotbo Vision', `${message.guild.id} : image bloquée de ${message.author.id} (${match.via}, ${match.comparison.distance.toFixed(1)}) - ${result.applied}`);

  if (effectiveConfig.visionNotifyMember && result.done && result.applied !== 'DELETE') {
    await notifyAuthor(message.author, message.guild, reason, autoSanctionLabel(result.applied, durationMin));
  }
  await logBlocked(message, match, list, reason, result.done ? autoSanctionLabel(result.applied, durationMin) : 'Message supprimé seulement', effectiveConfig);
  return true;
}

async function notifyAuthor(user: User, guild: Guild, reason: string, sanction: string): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('Image bloquée')
    .setDescription(
      [
        `Ton message sur **${guild.name}** a été supprimé : il contenait une image d'arnaque connue.`,
        `**Motif** : ${reason}`,
        `**Sanction** : ${sanction}`,
        '',
        "Si tu n'as rien envoyé, ton compte a probablement été piraté : change ton mot de passe, active la double authentification et déconnecte les sessions inconnues (Paramètres → Appareils).",
      ].join('\n')
    );
  await user.send({ embeds: [embed] }).catch(() => null);
}

async function logChannelFor(guild: Guild, config: RaidProtectionConfig): Promise<TextBasedChannel | null> {
  if (config.scamFilterAlertChannelId) {
    const channel = await guild.channels.fetch(config.scamFilterAlertChannelId).catch(() => null);
    if (channel?.isTextBased()) return channel;
  }
  const guildConfig = await getCachedGuild(guild.id);
  return resolveLogChannel(guild, guildConfig?.logChannelId, 'Kotbo Vision');
}

async function logBlocked(message: Message<true>, match: VisionMatch, list: VisionList | undefined, reason: string, sanction: string, config: RaidProtectionConfig): Promise<void> {
  const channel = await logChannelFor(message.guild, config);
  if (!channel || !('send' in channel)) return;
  const file = new AttachmentBuilder(match.image.buffer, { name: 'image.png' });
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('🔍 Kotbo Vision : image bloquée')
    .addFields(
      { name: 'Membre', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
      { name: 'Salon', value: `<#${message.channelId}>`, inline: true },
      { name: 'Sanction', value: sanction, inline: true },
      { name: 'Registre', value: list ? `Liste « ${list.name} »` : match.entry.guildId ? 'Catalogue du serveur' : 'Catalogue global', inline: true },
      { name: 'Correspondance', value: `${match.via === 'exact' ? 'Exacte' : match.via === 'window' ? 'Dans une capture' : 'Variante'} · ${Math.round(match.comparison.similarity * 100)} %`, inline: true },
      { name: 'Motif', value: reason, inline: false },
    )
    .setImage('attachment://image.png')
    .setTimestamp();
  await channel.send({ embeds: [embed], files: [file], allowedMentions: { parse: [] } }).catch(() => null);
}

// ── Correspondances incertaines : file de vérification ─────────────────────

async function handleUncertain(message: Message<true>, match: VisionMatch, list: VisionList | undefined, config: RaidProtectionConfig): Promise<boolean> {
  const reviewChannelId = list?.reviewChannelId ?? config.visionReviewChannelId;
  if (!reviewChannelId) return false;
  const channel = await message.guild.channels.fetch(reviewChannelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return false;

  await message.delete().catch(() => null);

  // La même image déjà en attente : on ne la signale pas deux fois.
  const pending = await prisma.visionReview.findFirst({
    where: { guildId: message.guild.id, sha256: match.image.sha256, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) return true;

  const withThumb = await analyzeBuffer(match.image.buffer, match.image.source, true);
  const review = await prisma.visionReview.create({
    data: {
      guildId: message.guild.id,
      listId: list?.id ?? null,
      matchId: match.entry.id,
      score: match.comparison.similarity,
      authorId: message.author.id,
      channelId: message.channelId,
      sha256: match.image.sha256,
      fingerprint: serializeFingerprint(match.image.analysis.fingerprint),
      thumb: withThumb?.analysis.thumb ?? null,
    },
  });

  const reference = await prisma.scamImageHash.findUnique({ where: { id: match.entry.id }, select: { thumb: true } });
  const files = [new AttachmentBuilder(match.image.buffer, { name: 'suspect.png' })];
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle(`Vérification requise : ${list ? `liste « ${list.name} »` : 'image d\'arnaque probable'}`)
    .setDescription(
      [
        `Image postée par <@${message.author.id}> dans <#${message.channelId}>, proche à **${Math.round(match.comparison.similarity * 100)} %** d'une image interdite${match.via === 'window' ? ' (retrouvée dans une capture)' : ''}.`,
        'Le message a été supprimé par précaution, sans sanction.',
        '',
        '**Confirmer** : l\'image rejoint le registre, l\'auteur est sanctionné.',
        '**Écarter** : l\'image est saine, elle ne sera plus signalée.',
      ].join('\n')
    )
    .setImage('attachment://suspect.png')
    .setFooter({ text: `Revue ${review.id}` })
    .setTimestamp();
  const referenceBuffer = reference?.thumb ? Buffer.from(reference.thumb.split(',')[1] ?? '', 'base64') : null;
  if (referenceBuffer?.length) {
    files.push(new AttachmentBuilder(referenceBuffer, { name: 'reference.jpg' }));
    embed.setThumbnail('attachment://reference.jpg');
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rprot:vision_confirm:${review.id}`).setLabel('Confirmer').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rprot:vision_dismiss:${review.id}`).setLabel('Écarter').setStyle(ButtonStyle.Secondary),
  );
  const posted = await channel.send({ embeds: [embed], files, components: [row], allowedMentions: { parse: [] } }).catch(() => null);
  if (posted) await prisma.visionReview.update({ where: { id: review.id }, data: { reviewMessageId: posted.id } });
  return true;
}

export type ReviewDecision = { ok: true; status: 'CONFIRMED' | 'DISMISSED'; sanction?: string } | { ok: false; reason: string };

/** Décision du staff sur une image incertaine. */
export async function decideVisionReview(client: Client, reviewId: string, decidedBy: string, confirm: boolean): Promise<ReviewDecision> {
  const review = await prisma.visionReview.findUnique({ where: { id: reviewId } });
  if (!review) return { ok: false, reason: 'Revue introuvable.' };
  if (review.status !== 'PENDING') return { ok: false, reason: 'Cette image a déjà été traitée.' };

  const claimed = await prisma.visionReview.updateMany({
    where: { id: reviewId, status: 'PENDING' },
    data: { status: confirm ? 'CONFIRMED' : 'DISMISSED', handledBy: decidedBy, handledAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, reason: 'Cette image a déjà été traitée.' };

  const parent = review.matchId ? await prisma.scamImageHash.findUnique({ where: { id: review.matchId }, select: { id: true, guildId: true, listId: true } }) : null;
  await prisma.scamImageHash.upsert({
    where: { guildId_hash: { guildId: review.guildId, hash: review.sha256 } },
    create: {
      guildId: review.guildId,
      listId: review.listId,
      parentId: parent?.id ?? null,
      hash: review.sha256,
      fingerprint: review.fingerprint,
      thumb: review.thumb,
      source: confirm ? 'REVIEW' : 'DISMISSED',
      status: confirm ? 'BLOCKED' : 'ALLOWED',
      addedBy: decidedBy,
    },
    update: { status: confirm ? 'BLOCKED' : 'ALLOWED', listId: review.listId },
  });
  invalidateVisionCache(review.guildId);

  if (!confirm) return { ok: true, status: 'DISMISSED' };
  if (!review.listId) {
    await promoteImageIfWidespread(review.sha256, null, null, review.fingerprint, review.thumb).catch(() => null);
  }

  // Sanction tardive : l'image est confirmée, son auteur est traité comme s'il
  // avait été attrapé du premier coup.
  const guild = client.guilds.cache.get(review.guildId);
  if (!guild) return { ok: true, status: 'CONFIRMED' };
  const config = await getRaidProtectionConfig(review.guildId);
  const list = review.listId ? await prisma.visionList.findUnique({ where: { id: review.listId } }) : null;
  const { action, durationMin } = config ? sanctionFor(config, list ?? undefined) : { action: 'TIMEOUT' as AutoSanction, durationMin: 1440 };
  const user = await client.users.fetch(review.authorId).catch(() => null);
  if (!user) return { ok: true, status: 'CONFIRMED' };
  const member = await guild.members.fetch(review.authorId).catch(() => null);
  const reason = `Kotbo Vision : ${list ? `image de la liste « ${list.name} »` : "image d'arnaque"}, confirmée par le staff`;
  const result = await applyAutoSanction({ client, guild, user, member, action, durationMin, reason, jailSource: 'VISION' });
  return { ok: true, status: 'CONFIRMED', sanction: result.done ? autoSanctionLabel(result.applied, durationMin) : undefined };
}

// ── Ajout d'images au catalogue (dashboard, menu contextuel) ────────────────

export type CatalogAddResult = { added: number; variants: number; duplicates: number; refused: number };

/**
 * Ajoute des images à une liste (ou au catalogue du serveur si listId est
 * null). Une image très proche d'une image déjà présente est rangée comme sa
 * variante ; une image illisible ou quasi unie est refusée, elle bloquerait
 * n'importe quel fond de couleur.
 */
export async function addImagesToCatalog(params: {
  guildId: string;
  listId: string | null;
  images: { buffer: Buffer; name: string }[];
  addedBy: string;
}): Promise<CatalogAddResult> {
  const result: CatalogAddResult = { added: 0, variants: 0, duplicates: 0, refused: 0 };
  const existing = await prisma.scamImageHash.findMany({
    where: { guildId: params.guildId, listId: params.listId, status: 'BLOCKED' },
    select: ENTRY_SELECT,
  });
  const known = existing.map(toEntry);

  for (const { buffer, name } of params.images.slice(0, MAX_IMAGES_PER_UPLOAD)) {
    const image = await analyzeBuffer(buffer, { url: '', name, origin: 'attachment' }, true);
    if (!image || image.analysis.fingerprint.flat) {
      result.refused++;
      continue;
    }
    if (known.some((k) => k.hash === image.sha256)) {
      result.duplicates++;
      continue;
    }
    const parent = known.find((k) => compareEntry(image, k)?.verdict === 'CERTAIN');
    try {
      const row = await prisma.scamImageHash.upsert({
        where: { guildId_hash: { guildId: params.guildId, hash: image.sha256 } },
        create: {
          guildId: params.guildId,
          listId: params.listId,
          parentId: parent?.id ?? null,
          hash: image.sha256,
          phash: image.analysis.phash,
          fingerprint: serializeFingerprint(image.analysis.fingerprint),
          thumb: image.analysis.thumb,
          filename: name.slice(0, 200),
          source: 'MANUAL',
          addedBy: params.addedBy,
        },
        // Déjà connue ailleurs sur le serveur (honeypot, autre liste) : elle
        // rejoint la liste choisie et redevient interdite.
        update: { listId: params.listId, status: 'BLOCKED' },
        select: ENTRY_SELECT,
      });
      known.push(toEntry(row));
      if (!params.listId) {
        await promoteImageIfWidespread(
          image.sha256,
          image.analysis.phash,
          name.slice(0, 200),
          serializeFingerprint(image.analysis.fingerprint),
          image.analysis.thumb
        ).catch(() => null);
      }
      if (parent) result.variants++;
      else result.added++;
    } catch (err) {
      logger.warn('Kotbo Vision', `Ajout impossible au catalogue (${params.guildId}): ${String(err)}`);
      result.refused++;
    }
  }
  invalidateVisionCache(params.guildId);
  return result;
}

/** Ajoute au catalogue les images d'un message (menu contextuel). */
export async function addMessageImagesToCatalog(message: Message, listId: string | null, addedBy: string): Promise<CatalogAddResult> {
  const sources = collectImageSources(message);
  const images: { buffer: Buffer; name: string }[] = [];
  for (const source of sources) {
    const buffer = await downloadImage(source.url);
    if (buffer) images.push({ buffer, name: source.name });
  }
  if (images.length === 0) return { added: 0, variants: 0, duplicates: 0, refused: sources.length };
  return addImagesToCatalog({ guildId: message.guildId!, listId, images, addedBy });
}
