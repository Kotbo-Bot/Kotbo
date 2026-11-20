/**
 * scamDatasetService.ts - Jeu de données d'arnaques alimenté par le honeypot.
 *
 * Un message piégé par le honeypot est, par construction, un message de compte
 * piraté ou de bot de spam : on en tire des domaines et des textes qui servent
 * ensuite à bloquer la même campagne ailleurs.
 *
 * Portée : une observation reste d'abord locale au serveur. Elle devient
 * globale (guildId null) quand elle a été vue sur GLOBAL_PROMOTION_GUILDS
 * serveurs distincts. Sans ce seuil, un honeypot mal placé (un salon que les
 * membres utilisent vraiment) ferait bloquer un domaine légitime pour tous.
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import visionSeed from '../../data/visionSeed.json';
import { compareFingerprints, parseFingerprint } from './imageForensics.js';
import {
  MIN_FINGERPRINT_LENGTH,
  fingerprintText,
  normalizeScamText,
  scoreScamText,
  suspiciousDomainsOf,
} from './scamHeuristics.js';

/** Nombre de serveurs distincts à partir duquel une observation devient globale. */
export const GLOBAL_PROMOTION_GUILDS = 3;

export type ScamSource = 'HONEYPOT' | 'MANUAL' | 'OCR';

const MIN_OCR_DOMAIN_LABEL = 4;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

// ── Caches de correspondance ────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
type CachedSet = { values: Set<string>; expiresAt: number };

const domainCache = new Map<string, CachedSet>();
const textCache = new Map<string, CachedSet>();

const GLOBAL_KEY = '__global__';

function invalidateCaches(guildId: string | null): void {
  domainCache.delete(guildId ?? GLOBAL_KEY);
  textCache.delete(guildId ?? GLOBAL_KEY);
}

/** Vide les caches de correspondance (tests). */
export function clearScamDatasetCaches(): void {
  domainCache.clear();
  textCache.clear();
}

async function loadDomains(guildId: string | null): Promise<Set<string>> {
  const key = guildId ?? GLOBAL_KEY;
  const cached = domainCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.values;

  const rows = await prisma.scamDomain.findMany({ where: { guildId }, select: { domain: true } });
  const values = new Set(rows.map((r) => r.domain));
  domainCache.set(key, { values, expiresAt: Date.now() + CACHE_TTL_MS });
  return values;
}

async function loadFingerprints(guildId: string | null): Promise<Set<string>> {
  const key = guildId ?? GLOBAL_KEY;
  const cached = textCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.values;

  const rows = await prisma.scamTextSample.findMany({ where: { guildId }, select: { fingerprint: true } });
  const values = new Set(rows.map((r) => r.fingerprint));
  textCache.set(key, { values, expiresAt: Date.now() + CACHE_TTL_MS });
  return values;
}

// ── Correspondance ──────────────────────────────────────────────────────────

/** `a.b.sedowin.com` → ['a.b.sedowin.com', 'b.sedowin.com', 'sedowin.com']. */
function hostAndParents(host: string): string[] {
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Premier domaine connu (serveur + global) parmi ceux d'un texte, ou null. */
export async function findKnownScamDomain(guildId: string, text: string): Promise<string | null> {
  const hosts = suspiciousDomainsOf(text);
  if (hosts.length === 0) return null;

  const [local, global] = await Promise.all([loadDomains(guildId), loadDomains(null)]);
  for (const host of hosts) {
    for (const candidate of hostAndParents(host)) {
      if (local.has(candidate) || global.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Ce texte est-il un copier-coller d'une arnaque connue (serveur + global) ? */
export async function findKnownScamText(guildId: string, text: string): Promise<boolean> {
  const normalized = normalizeScamText(text);
  if (normalized.length < MIN_FINGERPRINT_LENGTH) return false;

  const fingerprint = fingerprintText(normalized);
  const [local, global] = await Promise.all([loadFingerprints(guildId), loadFingerprints(null)]);
  return local.has(fingerprint) || global.has(fingerprint);
}

// ── Promotion en global ─────────────────────────────────────────────────────

async function promoteDomainIfWidespread(domain: string): Promise<void> {
  const guilds = await prisma.scamDomain.findMany({
    where: { domain, guildId: { not: null } },
    select: { guildId: true },
    distinct: ['guildId'],
  });
  if (guilds.length < GLOBAL_PROMOTION_GUILDS) return;

  const existing = await prisma.scamDomain.findFirst({ where: { domain, guildId: null }, select: { id: true } });
  if (existing) return;

  try {
    await prisma.scamDomain.create({ data: { guildId: null, domain, source: 'PROMOTED' } });
    invalidateCaches(null);
    logger.info('ScamDataset', `Domaine promu en global: ${domain} (${guilds.length} serveurs)`);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

async function promoteTextIfWidespread(fingerprint: string, sample: string, signals: string[], domains: string[]): Promise<void> {
  const guilds = await prisma.scamTextSample.findMany({
    where: { fingerprint, guildId: { not: null } },
    select: { guildId: true },
    distinct: ['guildId'],
  });
  if (guilds.length < GLOBAL_PROMOTION_GUILDS) return;

  const existing = await prisma.scamTextSample.findFirst({ where: { fingerprint, guildId: null }, select: { id: true } });
  if (existing) return;

  try {
    await prisma.scamTextSample.create({
      data: { guildId: null, fingerprint, sample, signals, domains, source: 'PROMOTED' },
    });
    invalidateCaches(null);
    logger.info('ScamDataset', `Texte promu en global: ${fingerprint.slice(0, 12)} (${guilds.length} serveurs)`);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/** dHash à 16 chiffres hexadécimaux, seul format que la comparaison SQL accepte. */
const DHASH = /^[0-9a-f]{16}$/;
/** Écart de dHash en deçà duquel une ligne mérite la comparaison complète. */
const NEAR_DHASH_BITS = 10;

/**
 * Serveurs qui connaissent cette image : à l'octet près, ou quasi identique.
 * Une campagne ne reposte jamais deux fois le même fichier (nom de domaine
 * changé, recompression) : compter les seuls SHA-256 égaux ne promouvait rien.
 * Le dHash trie en base, l'empreinte complète confirme ; les listes
 * personnalisées et les images écartées par le staff ne comptent pas.
 */
async function guildsKnowingImage(hash: string, phash: string | null, fingerprint: string | null): Promise<number> {
  const exact = await prisma.scamImageHash.findMany({
    where: { hash, guildId: { not: null } },
    select: { guildId: true },
    distinct: ['guildId'],
  });
  const guilds = new Set(exact.map((r) => r.guildId));

  const fp = parseFingerprint(fingerprint);
  if (!fp || !phash || !DHASH.test(phash)) return guilds.size;
  try {
    const near = await prisma.$queryRaw<{ guildId: string; fingerprint: string }[]>`
      SELECT "guildId", "fingerprint" FROM "scam_image_hashes"
      WHERE "guildId" IS NOT NULL AND "status" = 'BLOCKED' AND "listId" IS NULL
        AND "fingerprint" IS NOT NULL AND "phash" ~ '^[0-9a-f]{16}$'
        AND bit_count(('x' || "phash")::bit(64) # ('x' || ${phash})::bit(64)) <= ${NEAR_DHASH_BITS}
      LIMIT 500`;
    for (const row of near) {
      const known = parseFingerprint(row.fingerprint);
      if (known && compareFingerprints(fp, known).verdict === 'CERTAIN') guilds.add(row.guildId);
    }
  } catch (err) {
    // bit_count demande PostgreSQL 14 : en dessous, seule l'égalité exacte compte.
    logger.debug('ScamDataset', `Recherche d'images voisines impossible: ${String(err)}`);
  }
  return guilds.size;
}

/** Même principe pour une image : vue sur plusieurs serveurs, elle devient globale. */
export async function promoteImageIfWidespread(
  hash: string,
  phash: string | null,
  filename: string | null,
  fingerprint: string | null = null,
  thumb: string | null = null
): Promise<void> {
  const guildCount = await guildsKnowingImage(hash, phash, fingerprint);
  if (guildCount < GLOBAL_PROMOTION_GUILDS) return;

  const existing = await prisma.scamImageHash.findFirst({ where: { hash, guildId: null }, select: { id: true } });
  if (existing) return;

  try {
    await prisma.scamImageHash.create({ data: { guildId: null, hash, phash, fingerprint, thumb, filename, source: 'HONEYPOT' } });
    logger.info('ScamDataset', `Image promue en global: ${hash.slice(0, 12)} (${guildCount} serveurs)`);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

// ── Catalogue d'amorce ──────────────────────────────────────────────────────

type SeedEntry = { h: string; f: string; s: string };

/**
 * Verse dans le catalogue global les empreintes livrées avec le bot (collection
 * publique d'images d'arnaque et captures remontées par les serveurs, cf.
 * scripts/build-vision-seed.ts) : un serveur est protégé dès l'installation,
 * sans attendre que trois honeypots aient vu passer la campagne.
 *
 * Rejouable à chaque démarrage : seules les empreintes absentes sont ajoutées.
 * Pour retirer une entrée d'amorce, la passer en ALLOWED plutôt que la
 * supprimer, sinon elle reviendrait au démarrage suivant.
 */
export async function seedVisionCatalog(entries: SeedEntry[] = visionSeed): Promise<number> {
  const rows = await prisma.scamImageHash.findMany({ where: { guildId: null }, select: { hash: true } });
  const known = new Set(rows.map((r) => r.hash));
  const missing = entries.filter((e) => !known.has(e.h));
  if (missing.length === 0) return 0;
  await prisma.scamImageHash.createMany({
    data: missing.map((e) => ({ guildId: null, hash: e.h, fingerprint: e.f, filename: e.s, source: 'SEED' })),
  });
  logger.info('ScamDataset', `Catalogue d'amorce : ${missing.length} empreinte(s) d'image ajoutée(s)`);
  return missing.length;
}

let seedScheduled = false;

/** Programme l'amorce peu après le démarrage, une fois pour toute l'instance. */
export function scheduleVisionSeed(shardIds: readonly number[] | undefined): void {
  if (seedScheduled) return;
  seedScheduled = true;
  if (shardIds && !shardIds.includes(0)) return;
  setTimeout(() => {
    void seedVisionCatalog().catch((err) => logger.error('ScamDataset', "Catalogue d'amorce non chargé :", err));
  }, 30_000).unref?.();
}

// ── Enregistrement ──────────────────────────────────────────────────────────

async function recordDomain(guildId: string, domain: string, source: ScamSource, countRepeat: boolean): Promise<void> {
  const existing = await prisma.scamDomain.findFirst({ where: { guildId, domain }, select: { id: true } });
  if (existing) {
    if (!countRepeat) return;
    await prisma.scamDomain.update({
      where: { id: existing.id },
      data: { hits: { increment: 1 }, lastSeenAt: new Date() },
    });
    return;
  }
  try {
    await prisma.scamDomain.create({ data: { guildId, domain, source } });
  } catch (err) {
    // Deux messages simultanés du même spammeur : l'autre a gagné la course.
    if (!isUniqueViolation(err)) throw err;
  }
  invalidateCaches(guildId);
}

async function recordText(
  guildId: string,
  fingerprint: string,
  sample: string,
  signals: string[],
  domains: string[],
  source: ScamSource,
  countRepeat: boolean
): Promise<void> {
  const existing = await prisma.scamTextSample.findFirst({ where: { guildId, fingerprint }, select: { id: true } });
  if (existing) {
    if (!countRepeat) return;
    await prisma.scamTextSample.update({
      where: { id: existing.id },
      data: { hits: { increment: 1 }, lastSeenAt: new Date() },
    });
    return;
  }
  try {
    await prisma.scamTextSample.create({ data: { guildId, fingerprint, sample, signals, domains, source } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  invalidateCaches(guildId);
}

export type RecordedSignals = { domains: string[]; textRecorded: boolean };

/**
 * Enregistre les domaines et le texte d'un message piégé.
 *
 * Le texte n'est conservé que s'il ressemble à une arnaque (au moins deux
 * signaux, ou un domaine suspect) et dépasse une longueur minimale : les
 * bots de spam envoient aussi des « hello » qu'il serait désastreux d'apprendre.
 * Les mentions et les montants sont retirés avant stockage.
 */
export async function recordScamSignals(
  guildId: string,
  text: string,
  source: ScamSource = 'HONEYPOT',
  options: {
    /**
     * false = une observation déjà connue n'est pas recomptée. Le rattrapage
     * historique s'en sert pour pouvoir être relancé sans gonfler les compteurs.
     */
    countRepeat?: boolean;
  } = {}
): Promise<RecordedSignals> {
  const countRepeat = options.countRepeat ?? true;
  const result: RecordedSignals = { domains: [], textRecorded: false };
  if (!text.trim()) return result;

  // L'OCR produit du bruit (« w.to », « m.in ») qui ressemble à un domaine : on
  // exige un nom d'au moins quatre caractères pour ne pas polluer la base.
  const domains = suspiciousDomainsOf(text).filter(
    (domain) => source !== 'OCR' || (domain.split('.')[0]?.length ?? 0) >= MIN_OCR_DOMAIN_LABEL
  );
  for (const domain of domains) {
    try {
      await recordDomain(guildId, domain, source, countRepeat);
      await promoteDomainIfWidespread(domain);
      result.domains.push(domain);
    } catch (err) {
      logger.error('ScamDataset', `Enregistrement du domaine ${domain} impossible (${guildId})`, err);
    }
  }

  const normalized = normalizeScamText(text);
  const { signals } = scoreScamText(text);
  if (normalized.length >= MIN_FINGERPRINT_LENGTH && (signals.length >= 2 || domains.length > 0)) {
    const fingerprint = fingerprintText(normalized);
    try {
      await recordText(guildId, fingerprint, normalized, signals, domains, source, countRepeat);
      await promoteTextIfWidespread(fingerprint, normalized, signals, domains);
      result.textRecorded = true;
    } catch (err) {
      logger.error('ScamDataset', `Enregistrement du texte impossible (${guildId})`, err);
    }
  }

  return result;
}
