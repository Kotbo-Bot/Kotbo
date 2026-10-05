import { type Message, type TextChannel, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createHash } from 'node:crypto';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS, truncate } from '../../utils/embeds.js';
import { fetchExternal } from '../../utils/http.js';
import { getRaidProtectionConfig } from './raidProtectionService.js';
import { registerWarnSanction, registerTimeoutSanction, registerBanSanction } from './sanctionService.js';
import { analyzeImage, hammingDistance, PHASH_MATCH_THRESHOLD } from './imageForensics.js';
import { LEGIT_DOMAINS, compactOcrText, extractDomains, looksLikeFakeGiveaway, looksLikeRecruitmentScam } from './scamHeuristics.js';
import { findKnownScamDomain, findKnownScamText, promoteImageIfWidespread, recordScamSignals } from './scamDatasetService.js';
import { readImageText } from './ocrService.js';
import type { RaidProtectionConfig } from '@prisma/client';

// ── Heuristiques de détection d'arnaques (faux Nitro, phishing Steam/Discord…) ─

// Patterns de domaines typiques des campagnes de scam
const SCAM_DOMAIN_PATTERNS: RegExp[] = [
  /d[il1]sc[o0]rd[a-z0-9-]*\.(?!com|gg)[a-z]{2,}/i,        // discörd lookalikes hors TLD officiels
  /discord[a-z0-9-]*(nitro|gift|airdrop|app|steam)[a-z0-9-]*\./i,
  /(nitro|gift)[a-z0-9-]*discord[a-z0-9-]*\./i,
  /ste[a4]m[a-z0-9-]*c[o0]mmun[il1]ty(?!\.com)[a-z0-9-]*\./i, // steamcommunity lookalikes
  /steamc?ommunlty\./i,
  /free[-_]?nitro/i,
  /nitro[-_]?(free|gen|drop)/i,
  /(airdrop|giveaway)[-_]?(nitro|crypto|eth|btc)/i,
];

// Combinaisons texte suspectes (mention massive + appât)
const SCAM_TEXT_PATTERNS: RegExp[] = [
  /@everyone[\s\S]{0,120}(free|gratuit)[\s\S]{0,40}(nitro|steam|skin|robux)/i,
  /(free|gratuit)\s+(discord\s+)?nitro[\s\S]{0,80}https?:\/\//i,
  /(steam\s+gift|cs2?\s*skins?|trade\s*offer)[\s\S]{0,80}https?:\/\/(?!(?:[a-z0-9-]+\.)?steam(?:community|powered)\.com)/i,
];

const URL_REGEX = /https?:\/\/([a-z0-9.-]+)/gi;

export type ScamDetection = { matched: true; domain?: string; pattern: string } | { matched: false };

export function detectScam(content: string, config: RaidProtectionConfig): ScamDetection {
  const whitelist = new Set(config.scamFilterWhitelist.map((d) => d.toLowerCase()));
  const customBlocked = config.scamFilterCustomDomains.map((d) => d.toLowerCase());

  // 1. Analyse des domaines présents dans le message
  for (const match of content.matchAll(URL_REGEX)) {
    const domain = match[1].toLowerCase();
    if (whitelist.has(domain) || LEGIT_DOMAINS.has(domain)) continue;

    if (customBlocked.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))) {
      return { matched: true, domain, pattern: 'custom_domain' };
    }
    for (const pattern of SCAM_DOMAIN_PATTERNS) {
      if (pattern.test(domain)) return { matched: true, domain, pattern: pattern.source };
    }
  }

  // 2. Analyse des combinaisons de texte
  for (const pattern of SCAM_TEXT_PATTERNS) {
    if (pattern.test(content)) return { matched: true, pattern: pattern.source };
  }

  // 3. Faux giveaway crypto/casino (célébrité + bonus + code promo…). Un domaine
  // que le serveur a explicitement autorisé désarme ce contrôle : le staff qui
  // annonce un vrai partenariat ne doit pas être bloqué par un cumul de mots.
  const mentionsWhitelisted = extractDomains(content).some((d) => whitelist.has(d));
  if (!mentionsWhitelisted) {
    const giveaway = looksLikeFakeGiveaway(content);
    if (giveaway.matched) {
      return { matched: true, pattern: `fake_giveaway:${giveaway.signals.join('+')}` };
    }
    // Faux recrutement (« revenu complémentaire, il suffit d'un ordinateur,
    // MP avec ta nationalité ») : aucun lien, le piège se referme en privé.
    const recruitment = looksLikeRecruitmentScam(content);
    if (recruitment.matched) {
      return { matched: true, pattern: `recruitment_scam:${recruitment.signals.join('+')}` };
    }
  }

  return { matched: false };
}

/**
 * Contrôles qui interrogent le jeu de données (alimenté par le honeypot) :
 * domaine déjà vu dans une arnaque, texte copié-collé d'une arnaque connue.
 */
async function detectKnownScam(guildId: string, content: string, config: RaidProtectionConfig): Promise<ScamDetection> {
  const whitelist = new Set(config.scamFilterWhitelist.map((d) => d.toLowerCase()));

  const domain = await findKnownScamDomain(guildId, content);
  if (domain && !whitelist.has(domain)) {
    return { matched: true, domain, pattern: 'known_scam_domain' };
  }

  if (await findKnownScamText(guildId, content)) {
    return { matched: true, pattern: 'known_scam_text' };
  }

  return { matched: false };
}

// ── Base d'images d'arnaques (hash exact + empreinte perceptuelle) ───────────

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 5;

type FetchedImage = {
  name: string;
  sha256: string;
  phash: string | null;
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
async function fetchAndAnalyze(url: string, name: string, withOcr: boolean): Promise<FetchedImage | null> {
  try {
    const res = await fetchExternal(url, {}, 5_000);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;

    const buffer = Buffer.from(buf);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const analysis = await analyzeImage(buffer);
    const ocrText = withOcr ? await readImageText(buffer) : null;

    return {
      name,
      sha256,
      phash: analysis?.phash ?? null,
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

async function analyzeAttachments(message: Message, withOcr = false): Promise<FetchedImage[]> {
  const results: FetchedImage[] = [];
  for (const attachment of imageAttachmentsOf(message)) {
    const analyzed = await fetchAndAnalyze(attachment.url, attachment.name, withOcr);
    if (analyzed) results.push(analyzed);
  }
  return results;
}

type ImageSource = 'HONEYPOT' | 'MANUAL' | 'QR';

/** Enregistre une image analysée, ses empreintes et le texte qu'on y a lu. */
async function storeScamImage(
  guildId: string,
  image: FetchedImage,
  source: ImageSource,
  addedBy: string | null,
  countRepeat: boolean
): Promise<boolean> {
  try {
    const ocrText = image.ocrText ? compactOcrText(image.ocrText) : null;
    await prisma.scamImageHash.upsert({
      where: { guildId_hash: { guildId, hash: image.sha256 } },
      create: {
        guildId,
        hash: image.sha256,
        phash: image.phash,
        filename: image.name,
        source,
        addedBy,
        ocrText,
      },
      // Une entrée créée avant l'ajout du perceptuel ou de l'OCR peut être complétée.
      update: {
        ...(image.phash ? { phash: image.phash } : {}),
        ...(ocrText ? { ocrText } : {}),
      },
    });
    await promoteImageIfWidespread(image.sha256, image.phash, image.name);
    // Domaines et texte lus dans la capture rejoignent le jeu de données.
    if (image.ocrText) await recordScamSignals(guildId, image.ocrText, 'OCR', { countRepeat });
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
  for (const image of await analyzeAttachments(message, true)) {
    if (await storeScamImage(message.guild.id, image, source, message.author.id, true)) recorded++;
  }

  if (recorded > 0) {
    invalidatePhashCache(message.guild.id);
    logger.info('ScamFilter', `${recorded} empreinte(s) d'image scam enregistrée(s) pour ${message.guild.id} (source: ${source})`);
  }
  return recorded;
}

/**
 * Variante par URL, pour le rattrapage des transcripts honeypot. Retourne false
 * si l'image n'est plus téléchargeable (lien CDN expiré, message supprimé).
 */
export async function recordScamImageFromUrl(guildId: string, url: string, name: string): Promise<boolean> {
  const image = await fetchAndAnalyze(url, name, true);
  if (!image) return false;
  const stored = await storeScamImage(guildId, image, 'HONEYPOT', null, false);
  if (stored) invalidatePhashCache(guildId);
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

/**
 * Un code QR posté par un membre sans historique est-il suspect ?
 *
 * Le phishing par QR de connexion Discord ne contient aucun lien : il échappe
 * intégralement aux filtres de domaine. Un membre installé qui partage un QR
 * (wifi, 2FA, jeu) n'est pas concerné - seul l'inconnu l'est.
 */
async function isSuspiciousQrSender(
  message: Message,
  config: RaidProtectionConfig,
  images: FetchedImage[]
): Promise<boolean> {
  if (!config.scamQrFilterEnabled) return false;
  if (!images.some((i) => i.qr)) return false;
  return isNewcomer(message, config);
}

/**
 * Le membre est-il sans historique sur ce serveur ? Seuil partagé par les
 * filtres QR et OCR : au-delà de `scamQrTrustedMessages` messages, un membre est
 * considéré comme installé.
 */
async function isNewcomer(message: Message, config: RaidProtectionConfig): Promise<boolean> {
  const profile = await prisma.memberProfile
    .findUnique({
      where: { guildId_userId: { guildId: message.guild!.id, userId: message.author.id } },
      select: { messageCount: true },
    })
    .catch(() => null);

  return (profile?.messageCount ?? 0) <= config.scamQrTrustedMessages;
}

function reasonFor(detection: ScamDetection): string {
  if (!detection.matched) return '';
  if (detection.pattern.startsWith('fake_giveaway')) return "Faux giveaway crypto/casino détecté (cumul d'indices : appât, code promo, célébrité…)";
  if (detection.pattern.startsWith('recruitment_scam')) return "Faux recrutement détecté (promesse de revenu facile et invitation à poursuivre en privé)";
  if (detection.pattern === 'known_scam_text') return "Texte d'arnaque connu détecté (copie d'une campagne repérée par un honeypot)";
  if (detection.pattern === 'known_scam_domain') return `Domaine d'arnaque connu détecté${detection.domain ? ` (${detection.domain})` : ''}`;
  return `Lien d'arnaque détecté${detection.domain ? ` (${detection.domain})` : ''}`;
}

/** Contrôles appliqués au texte lu dans une image (capture d'un faux giveaway, d'un faux site de retrait). */
async function detectInImageText(guildId: string, text: string, config: RaidProtectionConfig): Promise<ScamDetection> {
  const direct = detectScam(text, config);
  if (direct.matched) return direct;
  return detectKnownScam(guildId, text, config);
}

/** Traite un message : détection + action configurée. Retourne true si un scam a été traité. */
export async function handleScamMessage(message: Message): Promise<boolean> {
  if (!message.guild || !message.member || message.author.bot) return false;
  if (!message.content && message.attachments.size === 0) return false;

  const config = await getRaidProtectionConfig(message.guild.id);
  if (!config?.scamFilterEnabled) return false;

  // Le staff et les admins sont exemptés
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  let detection: ScamDetection = message.content ? detectScam(message.content, config) : { matched: false };
  if (!detection.matched && message.content) {
    detection = await detectKnownScam(message.guild.id, message.content, config).catch((err) => {
      logger.error('ScamFilter', `Contrôle du jeu de données impossible (${message.guild!.id})`, err);
      return { matched: false } as ScamDetection;
    });
  }
  let reason = reasonFor(detection);

  // Analyse d'image : une seule fois pour tous les contrôles qui en dépendent.
  const needsImageAnalysis =
    !detection.matched &&
    message.attachments.size > 0 &&
    (config.scamImageFilterEnabled || config.scamQrFilterEnabled || config.scamOcrEnabled);

  if (needsImageAnalysis) {
    // La lecture du texte est le contrôle le plus coûteux : réservée aux
    // membres sans historique, qui sont aussi ceux qui postent ces captures.
    const withOcr = config.scamOcrEnabled && (await isNewcomer(message, config));
    const images = await analyzeAttachments(message, withOcr);

    if (config.scamImageFilterEnabled) {
      const imageMatch = await matchKnownScamImages(message.guild.id, images);
      if (imageMatch) {
        const label = imageMatch.filename ?? imageMatch.hash.slice(0, 12);
        detection = {
          matched: true,
          pattern: `known_scam_image:${label}:${imageMatch.kind.toLowerCase()}`,
        };
        reason =
          imageMatch.kind === 'PERCEPTUAL'
            ? `Image d'arnaque connue détectée (variante recompressée, distance ${imageMatch.distance})`
            : "Image d'arnaque connue détectée";
      }
    }

    if (!detection.matched && (await isSuspiciousQrSender(message, config, images))) {
      detection = { matched: true, pattern: 'qr_code_from_newcomer' };
      reason = 'Code QR posté par un compte sans historique (phishing par QR de connexion)';
    }

    if (!detection.matched && withOcr) {
      for (const image of images) {
        if (!image.ocrText) continue;
        const found = await detectInImageText(message.guild.id, image.ocrText, config).catch(() => null);
        if (found?.matched) {
          detection = { ...found, pattern: `image_text:${found.pattern}` };
          reason = `${reasonFor(found)} - lu dans une image`;
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
          { name: 'Message', value: truncate(message.content, 1000), inline: false },
        )
        .setTimestamp();
      await (channel as TextChannel).send({ embeds: [embed] }).catch(() => null);
    }
  }

  return true;
}
