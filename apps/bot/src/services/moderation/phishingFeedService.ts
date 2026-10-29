/**
 * phishingFeedService.ts - Flux open-source de domaines de phishing et
 * détection d'usurpation visuelle (homoglyphes, punycode, typosquatting).
 *
 * Combine trois sources éprouvées de l'écosystème Discord :
 *  - Discord-Anti-Scam (scam-links)
 *  - nikolaischunk/discord-phishing-links (domain-list + suspicious-list)
 *  - Analyse squelettique (IDN/punycode, homoglyphes cyrilliques/grecs,
 *    confusions visuelles `rn`→`m`, `vv`→`w`, `cl`→`d`, `1/l`→`i`, `0`→`o`
 *    et distance de Damerau-Levenshtein sur les marques ciblées).
 */

import { domainToASCII, domainToUnicode } from 'node:url';
import type { RaidProtectionConfig } from '@prisma/client';
import { fetchExternal } from '../../utils/http.js';
import { logger } from '../../utils/logger.js';
import {
  extractDomains,
  isBenignDomain,
  LEGIT_DOMAINS,
  looksLikeFakeGiveaway,
  looksLikeRecruitmentScam,
  registrableDomain,
} from './scamHeuristics.js';
import { findKnownScamDomain, findKnownScamText } from './scamDatasetService.js';

const CONFIRMED_FEEDS = [
  'https://raw.githubusercontent.com/Discord-Anti-Scam/scam-links/main/list.json',
  'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json',
] as const;

const SUSPICIOUS_FEEDS = [
  'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/suspicious-list.json',
] as const;

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

let confirmedDomains = new Set<string>();
let suspiciousDomains = new Set<string>();
let lastRefreshedAt = 0;
let lastAttemptAt = 0;
let refreshPromise: Promise<void> | null = null;

/** Homoglyphes cyrilliques, grecs et IPA fréquemment utilisés dans les IDN de phishing. */
const HOMOGLYPH_MAP: Record<string, string> = {
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p',
  ѕ: 's', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ɡ: 'g',
  ѵ: 'v', ѡ: 'w', ӏ: 'l', ԛ: 'q', ԝ: 'w', ᴢ: 'z',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't',
  υ: 'u', χ: 'x', ω: 'w',
  ʟ: 'l', ɪ: 'i', ɑ: 'a', ɩ: 'i', ᴜ: 'u',
};

/** Marques ciblées par les campagnes de phishing Discord/gaming/crypto. */
const PROTECTED_BRANDS = [
  'discord',
  'discordapp',
  'discordgift',
  'steamcommunity',
  'steampowered',
  'steam',
  'roblox',
  'epicgames',
  'metamask',
] as const;

/** Mots-appâts qui, accolés à une marque (ou son sosie), trahissent un domaine de phishing. */
const BRAND_LURE_TOKENS = /(?:nitro|gifts?|airdrop|claim|free|drop|giveaway|promo|reward|wallet|trade|skins?|boost|verify|login|auth|steam|partner)/i;

/** Domaines officiels supplémentaires des marques protégées. */
const EXTRA_OFFICIAL_DOMAINS = new Set([
  'discord.media',
  'discord.new',
  'discord.co',
  'discordstatus.com',
  'dis.gd',
  'roblox.com',
  'epicgames.com',
  'metamask.io',
]);

export type PhishingFeedMatch =
  | {
      matched: true;
      source: 'github_feed' | 'suspicious_feed' | 'lookalike';
      domain: string;
      matchedEntry?: string;
      targetBrand?: string;
      detail?: string;
    }
  | { matched: false };

function normalizeFeedEntry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.+$/, '');
  if (!host.includes('.') || host.length > 253) return null;
  const ascii = domainToASCII(host);
  if (!ascii || !/^[a-z0-9.-]+$/.test(ascii)) return null;
  if (LEGIT_DOMAINS.has(ascii) || EXTRA_OFFICIAL_DOMAINS.has(ascii) || isBenignDomain(ascii)) return null;
  return ascii;
}

function parseFeedPayload(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeFeedEntry).filter((d): d is string => d !== null);
  }
  if (payload && typeof payload === 'object' && Array.isArray((payload as { domains?: unknown }).domains)) {
    return ((payload as { domains: unknown[] }).domains).map(normalizeFeedEntry).filter((d): d is string => d !== null);
  }
  return [];
}

async function fetchFeedList(url: string): Promise<string[]> {
  try {
    const res = await fetchExternal(url, {}, 10_000);
    if (!res.ok) return [];
    const data = await res.json();
    return parseFeedPayload(data);
  } catch {
    return [];
  }
}

/**
 * Télécharge et met en cache les listes open-source GitHub de domaines de phishing.
 * Tolérant aux pannes réseau : si les dépôts sont injoignables, l'ancien cache est conservé.
 */
export async function refreshPhishingFeeds(): Promise<{ confirmed: number; suspicious: number }> {
  if (refreshPromise) {
    await refreshPromise;
    return { confirmed: confirmedDomains.size, suspicious: suspiciousDomains.size };
  }

  lastAttemptAt = Date.now();
  refreshPromise = (async () => {
    try {
      const [confirmedLists, suspiciousLists] = await Promise.all([
        Promise.all(CONFIRMED_FEEDS.map(fetchFeedList)),
        Promise.all(SUSPICIOUS_FEEDS.map(fetchFeedList)),
      ]);

      const nextConfirmed = new Set<string>();
      for (const list of confirmedLists) {
        for (const domain of list) nextConfirmed.add(domain);
      }

      const nextSuspicious = new Set<string>();
      for (const list of suspiciousLists) {
        for (const domain of list) {
          if (!nextConfirmed.has(domain)) nextSuspicious.add(domain);
        }
      }

      if (nextConfirmed.size > 0) {
        confirmedDomains = nextConfirmed;
        suspiciousDomains = nextSuspicious;
        lastRefreshedAt = Date.now();
        logger.info(
          'PhishingFeed',
          `Flux GitHub synchronisés : ${confirmedDomains.size} domaines confirmés, ${suspiciousDomains.size} suspects`
        );
      }
    } catch (err) {
      logger.warn('PhishingFeed', `Synchronisation des flux GitHub impossible: ${String(err)}`);
    } finally {
      refreshPromise = null;
    }
  })();

  await refreshPromise;
  return { confirmed: confirmedDomains.size, suspicious: suspiciousDomains.size };
}

/** Déclenche un rafraîchissement en tâche de fond si le cache est froid ou périmé. */
export function ensurePhishingFeedsWarm(): void {
  if (process.env.BUN_TEST_RUNNING) return;
  const now = Date.now();
  if (now - lastAttemptAt < REFRESH_INTERVAL_MS && lastRefreshedAt > 0) return;
  if (now - lastAttemptAt < 60_000) return;
  void refreshPhishingFeeds();
}

/** Alimente le cache directement pour les tests unitaires déterministes. */
export function seedPhishingFeedsForTests(confirmed: string[], suspicious: string[] = []): void {
  confirmedDomains = new Set(confirmed.map(normalizeFeedEntry).filter((d): d is string => d !== null));
  suspiciousDomains = new Set(suspicious.map(normalizeFeedEntry).filter((d): d is string => d !== null));
  lastRefreshedAt = Date.now();
}

export function getPhishingFeedStats(): { confirmed: number; suspicious: number; lastRefreshedAt: number } {
  return {
    confirmed: confirmedDomains.size,
    suspicious: suspiciousDomains.size,
    lastRefreshedAt,
  };
}

function hostAndParents(host: string): string[] {
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/**
 * Ramène un label de domaine à son squelette visuel :
 *  - punycode décodé en Unicode (`xn--...` → caractères réels)
 *  - homoglyphes cyrilliques/grecs repliés vers le latin
 *  - digrammes trompeurs (`rn` → `m`, `vv` → `w`, `cl` → `d`)
 *  - chiffres/lettres ambigus (`0` → `o`, `1` → `i`, `l` → `i`, `3` → `e`, `4` → `a`, `5` → `s`)
 */
export function visualSkeleton(label: string): string {
  const unicode = domainToUnicode(label.toLowerCase())
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const folded = [...unicode].map((ch) => HOMOGLYPH_MAP[ch] ?? ch).join('');

  return folded
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
    .replace(/0/g, 'o')
    .replace(/[1l]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's');
}

function brandSkeleton(brand: string): string {
  return visualSkeleton(brand);
}

const BRAND_SKELETONS = PROTECTED_BRANDS.map((brand) => ({
  brand,
  skeleton: brandSkeleton(brand),
}));

/** Distance de Damerau-Levenshtein (insertion, suppression, substitution, transposition adjacente). */
function damerauLevenshtein(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > 2) return 99;

  const dp: number[][] = Array.from({ length: lenA + 1 }, () => new Array<number>(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[lenA][lenB];
}

function isOfficialDomain(host: string): boolean {
  for (const official of [...LEGIT_DOMAINS, ...EXTRA_OFFICIAL_DOMAINS]) {
    if (host === official || host.endsWith(`.${official}`)) return true;
  }
  return isBenignDomain(host);
}

/**
 * Détecte si un nom de domaine imite visuellement une marque protégée
 * (homoglyphes IDN/punycode, leet-speak `dlscord`/`stearncommunity`, typosquatting,
 * ou sous-domaine usurpateur `discordapp.com.evil.xyz`).
 */
export function detectLookalikeDomain(rawHost: string): { targetBrand: string; detail: string } | null {
  const asciiHost = domainToASCII(rawHost.trim().toLowerCase().replace(/^www\./, '').replace(/\.+$/, ''));
  if (!asciiHost || !asciiHost.includes('.')) return null;
  if (isOfficialDomain(asciiHost)) return null;

  // Usurpation par préfixe de sous-domaine d'un domaine officiel (ex. `discordapp.com.evil.xyz`).
  for (const official of LEGIT_DOMAINS) {
    if (asciiHost.startsWith(`${official}.`) || asciiHost.includes(`.${official}.`)) {
      const brand = official.split('.')[0] ?? 'discord';
      return { targetBrand: brand, detail: 'subdomain_spoof' };
    }
  }

  const reg = registrableDomain(asciiHost);
  const regLabel = reg.split('.')[0] ?? '';
  if (regLabel.length < 4) return null;

  const isPunycode = regLabel.startsWith('xn--') || rawHost !== asciiHost;
  const unicodeLabel = domainToUnicode(regLabel);
  const compactLabel = unicodeLabel.replace(/-/g, '');
  const skelCompact = visualSkeleton(compactLabel);

  for (const { brand, skeleton } of BRAND_SKELETONS) {
    // 1. Correspondance exacte du squelette visuel sur un domaine non officiel
    //    (ex. `dіscord.com`, `dlscord.com`, `stearncommunity.com`, `discord.xyz`).
    if (skelCompact === skeleton) {
      return {
        targetBrand: brand,
        detail: isPunycode ? 'idn_homoglyph' : 'visual_skeleton',
      };
    }

    // 2. Typosquatting à distance 1 (ex. `discorcl.com`, `dicsord.com`, `steamcomunity.com`).
    if (brand.length >= 7 && (damerauLevenshtein(compactLabel, brand) === 1 || damerauLevenshtein(skelCompact, skeleton) === 1)) {
      return {
        targetBrand: brand,
        detail: 'typosquatting',
      };
    }

    // 3. Combo-squatting : marque (ou son squelette/typo) + mot-appât (ex. `dlscord-nitro.com`, `stearn-gift.org`).
    if (BRAND_LURE_TOKENS.test(regLabel) || BRAND_LURE_TOKENS.test(skelCompact)) {
      const tokens = regLabel.split('-').filter(Boolean);
      const hasBrandToken = tokens.some((t) => {
        const ts = visualSkeleton(t);
        return ts === skeleton || (brand.length >= 7 && damerauLevenshtein(ts, skeleton) <= 1);
      });
      if (hasBrandToken || skelCompact.includes(skeleton)) {
        return {
          targetBrand: brand,
          detail: 'combo_squatting',
        };
      }
    }
  }

  return null;
}

/**
 * Vérifie un domaine contre :
 *  1. Les flux GitHub confirmés (Discord-Anti-Scam + nikolaischunk domain-list)
 *  2. Les flux GitHub suspects (nikolaischunk suspicious-list)
 *  3. Le détecteur d'homoglyphes / punycode / typosquatting
 */
export function checkDomainAgainstFeeds(rawHost: string): PhishingFeedMatch {
  ensurePhishingFeedsWarm();

  const asciiHost = domainToASCII(rawHost.trim().toLowerCase().replace(/^www\./, '').replace(/\.+$/, ''));
  if (!asciiHost || !asciiHost.includes('.')) return { matched: false };
  if (isOfficialDomain(asciiHost)) return { matched: false };

  for (const candidate of hostAndParents(asciiHost)) {
    if (confirmedDomains.has(candidate)) {
      return { matched: true, source: 'github_feed', domain: asciiHost, matchedEntry: candidate };
    }
  }

  for (const candidate of hostAndParents(asciiHost)) {
    if (suspiciousDomains.has(candidate)) {
      return { matched: true, source: 'suspicious_feed', domain: asciiHost, matchedEntry: candidate };
    }
  }

  const lookalike = detectLookalikeDomain(rawHost);
  if (lookalike) {
    return {
      matched: true,
      source: 'lookalike',
      domain: asciiHost,
      targetBrand: lookalike.targetBrand,
      detail: lookalike.detail,
    };
  }

  return { matched: false };
}

// ── Détection unifiée texte + domaines + flux GitHub + jeu de données ─────────

const SCAM_DOMAIN_PATTERNS: RegExp[] = [
  /d[il1]sc[o0]rd[a-z0-9-]*\.(?!com|gg)[a-z]{2,}/i,
  /discord[a-z0-9-]*(nitro|gift|airdrop|app|steam)[a-z0-9-]*\./i,
  /(nitro|gift)[a-z0-9-]*discord[a-z0-9-]*\./i,
  /ste[a4]m[a-z0-9-]*c[o0]mmun[il1]ty(?!\.com)[a-z0-9-]*\./i,
  /steamc?ommunlty\./i,
  /free[-_]?nitro/i,
  /nitro[-_]?(free|gen|drop)/i,
  /(airdrop|giveaway)[-_]?(nitro|crypto|eth|btc)/i,
];

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

  const isTrusted = (domain: string): boolean => {
    const labels = domain.split('.');
    return labels.some((_, i) => {
      const parent = labels.slice(i).join('.');
      return whitelist.has(parent) || LEGIT_DOMAINS.has(parent);
    });
  };

  // Collecte tous les domaines : liens HTTP(S) classiques, IDN/punycode et domaines nus.
  const candidateDomains = new Set<string>();
  for (const match of content.matchAll(URL_REGEX)) {
    candidateDomains.add(match[1].toLowerCase());
  }
  for (const domain of extractDomains(content)) {
    candidateDomains.add(domain.toLowerCase());
  }

  // 1. Analyse des domaines (liste serveur, regex, flux GitHub et homoglyphes/typosquatting)
  for (const domain of candidateDomains) {
    if (isTrusted(domain)) continue;

    if (customBlocked.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))) {
      return { matched: true, domain, pattern: 'custom_domain' };
    }
    const feedMatch = checkDomainAgainstFeeds(domain);
    if (feedMatch.matched && (feedMatch.source === 'github_feed' || feedMatch.source === 'suspicious_feed')) {
      return {
        matched: true,
        domain: feedMatch.domain,
        pattern: feedMatch.source === 'github_feed' ? 'github_phishing_feed' : 'github_suspicious_feed',
      };
    }
    for (const pattern of SCAM_DOMAIN_PATTERNS) {
      if (pattern.test(domain)) return { matched: true, domain, pattern: pattern.source };
    }
    if (feedMatch.matched && feedMatch.source === 'lookalike') {
      return {
        matched: true,
        domain: feedMatch.domain,
        pattern: `lookalike:${feedMatch.targetBrand ?? 'brand'}:${feedMatch.detail ?? 'visual'}`,
      };
    }
  }

  // 2. Analyse des combinaisons de texte
  for (const pattern of SCAM_TEXT_PATTERNS) {
    if (pattern.test(content)) return { matched: true, pattern: pattern.source };
  }

  // 3. Faux giveaway crypto/casino et faux recrutement
  const mentionsWhitelisted = [...candidateDomains].some((d) => isTrusted(d) && whitelist.has(d));
  if (!mentionsWhitelisted) {
    const giveaway = looksLikeFakeGiveaway(content);
    if (giveaway.matched) {
      return { matched: true, pattern: `fake_giveaway:${giveaway.signals.join('+')}` };
    }
    const recruitment = looksLikeRecruitmentScam(content);
    if (recruitment.matched) {
      return { matched: true, pattern: `recruitment_scam:${recruitment.signals.join('+')}` };
    }
  }

  return { matched: false };
}

/**
 * Contrôles qui interrogent le jeu de données (alimenté par le honeypot et l'OCR) :
 * domaine déjà vu dans une arnaque, texte copié-collé d'une arnaque connue.
 */
export async function detectKnownScam(
  guildId: string,
  content: string,
  config: RaidProtectionConfig
): Promise<ScamDetection> {
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

/** Contrôles appliqués au texte lu dans une image (OCR). */
export async function detectInImageText(
  guildId: string,
  text: string,
  config: RaidProtectionConfig
): Promise<ScamDetection> {
  const direct = detectScam(text, config);
  if (direct.matched) return direct;
  return detectKnownScam(guildId, text, config);
}

export function reasonForScamDetection(detection: ScamDetection): string {
  if (!detection.matched) return '';
  if (detection.pattern.startsWith('fake_giveaway')) {
    return "Faux giveaway crypto/casino détecté (cumul d'indices : appât, code promo, célébrité…)";
  }
  if (detection.pattern.startsWith('recruitment_scam')) {
    return 'Faux recrutement détecté (promesse de revenu facile et invitation à poursuivre en privé)';
  }
  if (detection.pattern === 'known_scam_text') {
    return "Texte d'arnaque connu détecté (copie d'une campagne repérée par un honeypot)";
  }
  if (detection.pattern === 'known_scam_domain') {
    return `Domaine d'arnaque connu détecté${detection.domain ? ` (${detection.domain})` : ''}`;
  }
  if (detection.pattern === 'github_phishing_feed' || detection.pattern === 'github_suspicious_feed') {
    return `Domaine de phishing répertorié dans les bases anti-scam (${detection.domain ?? 'inconnu'})`;
  }
  if (detection.pattern.startsWith('lookalike:')) {
    const brand = detection.pattern.split(':')[1] ?? 'marque';
    return `Domaine usurpant ${brand} détecté (${detection.domain ?? 'homoglyphe/typosquatting'})`;
  }
  return `Lien d'arnaque détecté${detection.domain ? ` (${detection.domain})` : ''}`;
}
