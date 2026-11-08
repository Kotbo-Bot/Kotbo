import { type Message, type TextChannel, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createHash } from 'node:crypto';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS, truncate } from '../../utils/embeds.js';
import { fetchExternal } from '../../utils/http.js';
import { getRaidProtectionConfig } from './raidProtectionService.js';
import { registerWarnSanction, registerTimeoutSanction, registerBanSanction } from './sanctionService.js';
import { analyzeImage, hammingDistance, PHASH_MATCH_THRESHOLD, serializeFingerprint } from './imageForensics.js';
import { invalidateVisionCache } from './visionService.js';
import { compactOcrText } from './scamHeuristics.js';
import { promoteImageIfWidespread, recordScamSignals } from './scamDatasetService.js';
import {
  detectInImageText,
  detectKnownScam,
  detectScam,
  reasonForScamDetection,
  type ScamDetection,
} from './phishingFeedService.js';
import { readImageText } from './ocrService.js';
import type { RaidProtectionConfig } from '@prisma/client';

export { detectScam, type ScamDetection };

// ── Base d'images d'arnaques (hash exact + empreinte perceptuelle) ───────────

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 5;

type FetchedImage = {
  name: string;
  sha256: string;
  phash: string | null;
  /** Empreinte Kotbo Vision v2 sérialisée. */
  fingerprint: string | null;
  thumb: string | null;
  qr: boolean;
  /** Texte lu dans l'image ; null si l'OCR n'a pas été demandé ou a échoué. */
  ocrText: string | null;
};

/**
 * Télécharge une image et en calcule les empreintes.
 *
 * Le SHA-256 attrape le repost à l'identique ; l'empreinte perceptuelle
 * attrape la même image recompressée ou légèrement recadrée, ce qui est le
 * mode de rediffusion réel des captures d'arnaque. Le texte lu par OCR couvre
 * le reste : la capture photographiée, que ni l'un ni l'autre ne reconnaît.
 */
async function fetchAndAnalyze(url: string, name: string, withOcr: boolean, withThumb = false): Promise<FetchedImage | null> {
  try {
    const res = await fetchExternal(url, {}, 5_000);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;

    const buffer = Buffer.from(buf);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const analysis = await analyzeImage(buffer, { thumb: withThumb });
    const ocrText = withOcr ? await readImageText(buffer) : null;

    return {
      name,
      sha256,
      phash: analysis?.phash ?? null,
      fingerprint: analysis ? serializeFingerprint(analysis.fingerprint) : null,
      thumb: analysis?.thumb ?? null,
      qr: analysis?.qr.detected ?? false,
      ocrText,
    };
  } catch {
    return null;
  }
}

function imageAttachmentsOf(message: Message): { url: string; name: string }[] {
  return [...message.attachments.values()]
    .filter((a) => a.contentType?.startsWith('image/'))
    .slice(0, MAX_IMAGES_PER_MESSAGE)
    .map((a) => ({ url: a.url, name: a.name }));
}

async function analyzeAttachments(message: Message, withOcr = false, withThumb = false): Promise<FetchedImage[]> {
  const results: FetchedImage[] = [];
  for (const attachment of imageAttachmentsOf(message)) {
    const analyzed = await fetchAndAnalyze(attachment.url, attachment.name, withOcr, withThumb);
    if (analyzed) results.push(analyzed);
  }
  return results;
}

type ImageSource = 'HONEYPOT' | 'MANUAL' | 'QR' | 'OCR';

/**
 * Enregistre une image analysée, ses empreintes et le texte qu'on y a lu.
 * Retourne false si l'image ne porte aucun indice d'arnaque.
 */
async function storeScamImage(
  guildId: string,
  image: FetchedImage,
  source: ImageSource,
  addedBy: string | null,
  countRepeat: boolean
): Promise<boolean> {
  try {
    // Domaines et texte lus dans la capture rejoignent le jeu de données.
    const signals = image.ocrText ? await recordScamSignals(guildId, image.ocrText, 'OCR', { countRepeat }) : null;
    // Le salon piège reçoit aussi des mèmes et des GIF : sans QR ni texte
    // d'arnaque, l'image ne prouve rien et bloquerait tous ceux qui la repostent.
    if (source !== 'MANUAL' && !image.qr && !signals?.textRecorded && !signals?.domains.length) return false;

    const ocrText = image.ocrText ? compactOcrText(image.ocrText) : null;
    await prisma.scamImageHash.upsert({
      where: { guildId_hash: { guildId, hash: image.sha256 } },
      create: {
        guildId,
        hash: image.sha256,
        phash: image.phash,
        fingerprint: image.fingerprint,
        thumb: image.thumb,
        filename: image.name,
        source,
        addedBy,
        ocrText,
      },
      // Une entrée créée avant l'ajout du perceptuel, de l'OCR ou de
      // l'empreinte v2 peut être complétée.
      update: {
        ...(image.phash ? { phash: image.phash } : {}),
        ...(image.fingerprint ? { fingerprint: image.fingerprint } : {}),
        ...(image.thumb ? { thumb: image.thumb } : {}),
        ...(ocrText ? { ocrText } : {}),
      },
    });
    await promoteImageIfWidespread(image.sha256, image.phash, image.name, image.fingerprint, image.thumb);
    return true;
  } catch (err) {
    logger.error('ScamFilter', `Enregistrement du hash d'image impossible (${guildId})`, err);
    return false;
  }
}

/**
 * Enregistre les empreintes des images d'un message dans la base d'arnaques.
 * Appelé par le honeypot quand un compte piégé poste une image.
 */
export async function recordScamImagesFromMessage(
  message: Message,
  source: ImageSource = 'HONEYPOT'
): Promise<number> {
  if (!message.guild) return 0;
  let recorded = 0;

  // Le honeypot est rare et ses images sont par définition suspectes : on lit
  // toujours leur texte, sans le garde-fou de coût des contrôles en continu.
  for (const image of await analyzeAttachments(message, true, true)) {
    if (await storeScamImage(message.guild.id, image, source, message.author.id, true)) recorded++;
  }

  if (recorded > 0) {
    invalidatePhashCache(message.guild.id);
    invalidateVisionCache(message.guild.id);
    logger.info('ScamFilter', `${recorded} empreinte(s) d'image scam enregistrée(s) pour ${message.guild.id} (source: ${source})`);
  }
  return recorded;
}

/**
 * Variante par URL, pour le rattrapage des transcripts honeypot. Retourne false
 * si l'image n'est plus téléchargeable (lien CDN expiré, message supprimé).
 */
export async function recordScamImageFromUrl(guildId: string, url: string, name: string): Promise<boolean> {
  const image = await fetchAndAnalyze(url, name, true, true);
  if (!image) return false;
  const stored = await storeScamImage(guildId, image, 'HONEYPOT', null, false);
  if (stored) {
    invalidatePhashCache(guildId);
    invalidateVisionCache(guildId);
  }
  return stored;
}

// Les empreintes perceptuelles ne se comparent pas en SQL : la distance de
// Hamming se calcule en mémoire. La base par serveur reste petite (quelques
// milliers d'entrées au plus), on la garde en cache court.
const PHASH_CACHE_TTL_MS = 5 * 60 * 1000;
const PHASH_LIMIT = 5000;
const phashCache = new Map<string, { rows: { phash: string; filename: string | null; hash: string }[]; expiresAt: number }>();

function invalidatePhashCache(guildId: string): void {
  phashCache.delete(guildId);
}

async function loadKnownPhashes(guildId: string) {
  const cached = phashCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const rows = await prisma.scamImageHash.findMany({
    where: { phash: { not: null }, OR: [{ guildId }, { guildId: null }] },
    select: { hash: true, phash: true, filename: true },
    take: PHASH_LIMIT,
  });

  const usable = rows.filter((r): r is { hash: string; phash: string; filename: string | null } => r.phash !== null);
  phashCache.set(guildId, { rows: usable, expiresAt: Date.now() + PHASH_CACHE_TTL_MS });
  return usable;
}

export type ScamImageMatch = {
  hash: string;
  filename: string | null;
  /** EXACT = octets identiques, PERCEPTUAL = même image recompressée/recadrée. */
  kind: 'EXACT' | 'PERCEPTUAL';
  distance?: number;
};

/**
 * Compare des images déjà analysées aux empreintes connues (serveur + globales).
 * Les images sont passées en paramètre pour n'être téléchargées qu'une fois par
 * message, quel que soit le nombre de contrôles qui s'y intéressent.
 */
export async function matchKnownScamImages(
  guildId: string,
  images: FetchedImage[]
): Promise<ScamImageMatch | null> {
  if (images.length === 0) return null;

  // 1. Correspondance exacte : la moins chère, on la tente d'abord.
  const exact = await prisma.scamImageHash.findFirst({
    where: {
      hash: { in: images.map((i) => i.sha256) },
      OR: [{ guildId }, { guildId: null }],
    },
    select: { hash: true, filename: true },
  });
  if (exact) return { ...exact, kind: 'EXACT' };

  // 2. Correspondance perceptuelle.
  const known = await loadKnownPhashes(guildId);
  if (known.length === 0) return null;

  for (const image of images) {
    if (!image.phash) continue;
    for (const row of known) {
      const distance = hammingDistance(image.phash, row.phash);
      if (distance <= PHASH_MATCH_THRESHOLD) {
        return { hash: row.hash, filename: row.filename, kind: 'PERCEPTUAL', distance };
      }
    }
  }

  return null;
}

/** Variante autonome, pour les appelants qui n'ont pas déjà analysé le message. */
export async function findKnownScamImage(message: Message): Promise<ScamImageMatch | null> {
  if (!message.guild || message.attachments.size === 0) return null;
  return matchKnownScamImages(message.guild.id, await analyzeAttachments(message));
}

async function isSuspiciousQrSender(
  message: Message,
  config: RaidProtectionConfig,
  images: FetchedImage[]
): Promise<boolean> {
  if (!config.scamQrFilterEnabled) return false;
  if (!images.some((i) => i.qr)) return false;
  return isNewcomer(message, config);
}

async function isNewcomer(message: Message, config: RaidProtectionConfig): Promise<boolean> {
  const profile = await prisma.memberProfile
    .findUnique({
      where: { guildId_userId: { guildId: message.guild!.id, userId: message.author.id } },
      select: { messageCount: true },
    })
    .catch(() => null);

  return (profile?.messageCount ?? 0) <= config.scamQrTrustedMessages;
}

/**
 * Rassemble le texte d'un message, de ses embeds et des éventuels messages
 * transférés (`messageSnapshots`) pour que le transfert d'une arnaque ne
 * contourne pas le filtre textuel.
 */
function collectMessageText(message: Message): string {
  const parts: string[] = [];
  if (message.content) parts.push(message.content);
  for (const embed of message.embeds) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    if (embed.url) parts.push(embed.url);
  }
  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    if (snapshot.content) parts.push(snapshot.content);
    for (const embed of snapshot.embeds) {
      if (embed.title) parts.push(embed.title);
      if (embed.description) parts.push(embed.description);
      if (embed.url) parts.push(embed.url);
    }
  }
  return parts.join('\n').trim();
}

/** Traite un message : détection + action configurée. Retourne true si un scam a été traité. */
export async function handleScamMessage(message: Message): Promise<boolean> {
  if (!message.guild || !message.member || message.author.bot) return false;
  const fullText = collectMessageText(message);
  if (!fullText && message.attachments.size === 0) return false;

  const config = await getRaidProtectionConfig(message.guild.id);
  if (!config?.scamFilterEnabled) return false;

  // Le staff et les admins sont exemptés
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  let detection: ScamDetection = fullText ? detectScam(fullText, config) : { matched: false };
  if (!detection.matched && fullText) {
    detection = await detectKnownScam(message.guild.id, fullText, config).catch((err) => {
      logger.error('ScamFilter', `Contrôle du jeu de données impossible (${message.guild!.id})`, err);
      return { matched: false } as ScamDetection;
    });
  }
  let reason = reasonForScamDetection(detection);

  // Repli d'analyse d'image uniquement lorsque Kotbo Vision est désactivé :
  // quand Vision est actif (par défaut), `handleVision` a déjà inspecté en une
  // seule passe les empreintes visuelles, le QR et l'OCR de toutes les images.
  const needsImageAnalysis =
    !detection.matched &&
    !config.visionEnabled &&
    message.attachments.size > 0 &&
    (config.scamQrFilterEnabled || config.scamOcrEnabled);

  if (needsImageAnalysis) {
    const withOcr = config.scamOcrEnabled && (await isNewcomer(message, config));
    const images = await analyzeAttachments(message, withOcr, true);

    if (!detection.matched && (await isSuspiciousQrSender(message, config, images))) {
      const qrImg = images.find((i) => i.qr);
      if (qrImg) await storeScamImage(message.guild.id, qrImg, 'QR', message.author.id, true);
      detection = { matched: true, pattern: 'qr_code_from_newcomer' };
      reason = 'Code QR posté par un compte sans historique (phishing par QR de connexion)';
    }

    if (!detection.matched && withOcr) {
      for (const image of images) {
        if (!image.ocrText) continue;
        const found = await detectInImageText(message.guild.id, image.ocrText, config).catch(() => null);
        if (found?.matched) {
          await storeScamImage(message.guild.id, image, 'OCR', message.author.id, true);
          detection = { ...found, pattern: `image_text:${found.pattern}` };
          reason = `${reasonForScamDetection(found)} - lu dans une image`;
          break;
        }
      }
    }
  }

  if (!detection.matched) return false;

  const guildId = message.guild.id;
  logger.warn('ScamFilter', `Scam détecté sur ${guildId} par ${message.author.id}: ${detection.pattern}`);

  await message.delete().catch(() => null);

  const target = { id: message.author.id, tag: message.author.tag };
  const moderator = { id: message.client.user.id, tag: message.client.user.tag };

  try {
    switch (config.scamFilterAction) {
      case 'DELETE_AND_WARN':
        await registerWarnSanction({ guildId, target, moderator, reason, client: message.client });
        break;
      case 'DELETE_AND_TIMEOUT':
        await registerTimeoutSanction({
          guildId, target, moderator, reason,
          durationMs: config.scamFilterTimeoutMin * 60 * 1000,
          member: message.member,
          client: message.client,
        });
        break;
      case 'DELETE_AND_BAN':
        await registerBanSanction({ guildId, target, moderator, reason, client: message.client });
        break;
      // 'DELETE' : suppression seule
    }
  } catch (err) {
    logger.error('ScamFilter', `Sanction impossible pour ${message.author.id}`, err);
  }

  // Alerte staff
  const alertChannelId = config.scamFilterAlertChannelId;
  if (alertChannelId) {
    const channel = await message.guild.channels.fetch(alertChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.danger)
        .setTitle('🎣 Arnaque bloquée')
        .addFields(
          { name: 'Membre', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
          { name: 'Salon', value: `<#${message.channelId}>`, inline: true },
          { name: 'Action', value: config.scamFilterAction, inline: true },
          { name: 'Message', value: truncate(fullText || '[Image]', 1000), inline: false },
        )
        .setTimestamp();
      await (channel as TextChannel).send({ embeds: [embed] }).catch(() => null);
    }
  }

  return true;
}
