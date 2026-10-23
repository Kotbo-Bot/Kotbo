/**
 * scamHeuristics.ts - Briques pures de détection d'arnaques (aucune base, aucun réseau).
 *
 * Les campagnes de faux giveaway (« MrBeast offre 3 500 $ à tous ceux qui
 * s'inscrivent sur notre casino, code promo TAKE ») n'ont ni lien Nitro ni
 * domaine ressemblant à Discord : un filtre par motifs de domaine ne les voit
 * pas. Ce qui les trahit, c'est la combinaison : un appât (giveaway, bonus), un
 * code promo, un décor crypto/casino, une célébrité, de l'urgence. Aucun de ces
 * signaux n'est suspect seul ; c'est leur cumul que l'on score.
 *
 * Ce module sert trois usages :
 *  - bloquer un message (score + lien),
 *  - décider ce que le honeypot enregistre,
 *  - analyser le texte lu dans une image (OCR).
 */

import { createHash } from 'node:crypto';

// ── Domaines ────────────────────────────────────────────────────────────────

// Domaines légitimes qui ne doivent jamais être bloqués.
export const LEGIT_DOMAINS = new Set([
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.gift',
  'steamcommunity.com', 'steampowered.com', 'store.steampowered.com',
]);

/**
 * Domaines qu'on ne doit jamais enregistrer ni bloquer, même s'ils apparaissent
 * dans un message piégé : un bot de spam colle indifféremment un lien YouTube et
 * un lien de phishing, et apprendre « youtube.com » ruinerait la base.
 * Les raccourcisseurs y figurent : bloquer bit.ly bloquerait des millions de
 * liens légitimes, il faudrait raisonner au niveau de l'URL complète.
 */
const BENIGN_DOMAINS = new Set([
  ...LEGIT_DOMAINS,
  'google.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'facebook.com',
  'instagram.com', 'tiktok.com', 'twitch.tv', 'reddit.com', 'github.com', 'gitlab.com',
  'wikipedia.org', 'tenor.com', 'giphy.com', 'imgur.com', 'spotify.com', 'amazon.com',
  'paypal.com', 'microsoft.com', 'apple.com', 'telegram.org', 't.me', 'whatsapp.com',
  'bit.ly', 'tinyurl.com', 't.co', 'cutt.ly', 'is.gd', 'rb.gy', 'shorturl.at', 'goo.gl',
  'linktr.ee', 'carrd.co', 'notion.so', 'docs.google.com', 'drive.google.com',
]);

/**
 * Hébergeurs mutualisés : le domaine enregistrable est celui de la plateforme,
 * pas celui de l'arnaqueur. On garde l'hôte complet (`promo.vercel.app`) au lieu
 * de remonter à `vercel.app`, qui serait bloqué pour tout le monde.
 */
const SHARED_HOSTING_SUFFIXES = [
  'vercel.app', 'pages.dev', 'workers.dev', 'netlify.app', 'github.io', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'weebly.com', 'wixsite.com',
  'glitch.me', 'replit.app', 'repl.co', 'ngrok.io', 'ngrok-free.app', 'onrender.com',
  'framer.website', 'webflow.io', 'my.canva.site',
];

// Suffixes publics à deux niveaux les plus courants (liste volontairement courte).
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'com.br', 'com.au', 'co.jp', 'co.in', 'com.tr', 'com.mx', 'co.za',
]);

// TLD retenus pour reconnaître un nom de domaine sans schéma (« sedowin.com »).
// Liste fermée : accepter n'importe quel suffixe prendrait « fichier.js » ou
// « Mr.Beast » pour des domaines.
const BARE_DOMAIN_TLDS = [
  'com', 'net', 'org', 'io', 'xyz', 'top', 'site', 'online', 'club', 'vip', 'win', 'bet',
  'casino', 'gg', 'app', 'dev', 'co', 'info', 'biz', 'live', 'fun', 'cc', 'me', 'tv', 'ru',
  'gift', 'cash', 'money', 'games', 'game', 'pro', 'shop', 'store', 'link', 'click', 'cloud',
  'icu', 'cfd', 'sbs', 'life', 'world', 'one', 'ws', 'to', 'ly', 'fr', 'de', 'uk', 'us', 'ca',
  'eu', 'in', 'tk', 'ml', 'ga', 'cf', 'gq', 'rest', 'bond', 'monster',
].join('|');

const SCHEME_URL = /\bhttps?:\/\/([^\s/?#<>()[\]"'`]+)/gi;
const BARE_DOMAIN = new RegExp(
  `(?<![@\\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${BARE_DOMAIN_TLDS}))(?![a-z0-9-])`,
  'gi'
);

/** Caractères invisibles ou de largeur nulle, utilisés pour casser les filtres. */
const INVISIBLE_CHARS = new RegExp('[\\u200B-\\u200F\\u2060\\u2066-\\u2069\\uFEFF\\u00AD]', 'g');

/** Aplatit les variantes d'écriture : plein-chasse, invisibles, liens « défanged ». */
export function foldText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\bhxxps?:\/\//gi, (m) => m.replace(/hxxp/i, 'http'));
}

function cleanHost(raw: string): string | null {
  let host = raw.toLowerCase().replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  host = host.replace(/^www\./, '');
  if (!host.includes('.') || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

/** Domaines (sans `www.`) présents dans un texte, avec ou sans schéma. */
export function extractDomains(text: string): string[] {
  const folded = foldText(text);
  const found = new Set<string>();

  for (const match of folded.matchAll(SCHEME_URL)) {
    const host = cleanHost(match[1]);
    if (host) found.add(host);
  }
  for (const match of folded.matchAll(BARE_DOMAIN)) {
    const host = cleanHost(match[1]);
    if (host) found.add(host);
  }
  return [...found];
}

function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function isBenignDomain(host: string): boolean {
  for (const benign of BENIGN_DOMAINS) {
    if (matchesSuffix(host, benign)) return true;
  }
  return false;
}

/**
 * Forme sous laquelle un hôte est enregistré : `go.sedowin.com` → `sedowin.com`
 * (le sous-domaine est jetable), mais `promo.vercel.app` reste tel quel.
 */
export function registrableDomain(host: string): string {
  for (const suffix of SHARED_HOSTING_SUFFIXES) {
    if (host.endsWith(`.${suffix}`)) {
      const labels = host.slice(0, -suffix.length - 1).split('.');
      return `${labels[labels.length - 1]}.${suffix}`;
    }
  }
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** Domaines d'un texte qui méritent d'être enregistrés comme suspects. */
export function suspiciousDomainsOf(text: string): string[] {
  const out = new Set<string>();
  for (const host of extractDomains(text)) {
    if (isBenignDomain(host)) continue;
    out.add(registrableDomain(host));
  }
  return [...out];
}

// ── Score textuel ───────────────────────────────────────────────────────────

/**
 * Deux familles d'arnaque, deux jeux d'indices : le faux giveaway (on donne de
 * l'argent, viens le chercher sur ce site) et le faux recrutement (on t'apprend
 * à gagner de l'argent, écris-moi en privé). Chaque détecteur ne compte que les
 * indices de sa famille ; le jeu de données les conserve tous.
 */
type ScamFamily = 'giveaway' | 'recruitment';
type Signal = { id: string; family: ScamFamily; weight: number; pattern: RegExp };

const SIGNALS: Signal[] = [
  {
    id: 'giveaway',
    family: 'giveaway',
    weight: 3,
    pattern: /giving\s+away|give\s?away|free\s+(?:money|bonus|crypto)|claim\s+(?:your|the)\s+(?:reward|bonus|prize)|\bbonus\b|\breward\b|gratuit|cadeau|offert|je\s+(?:offre|donne)/i,
  },
  {
    id: 'promo_code',
    family: 'giveaway',
    weight: 3,
    pattern: /promo(?:tion(?:al)?)?\s*[- ]?code|bonus\s+code|(?:enter|use|apply)\s+(?:the\s+)?(?:special\s+)?(?:promo\s+)?code|code\s+promo|code\s+bonus/i,
  },
  {
    id: 'crypto_casino',
    family: 'giveaway',
    weight: 2,
    pattern: /casino|crypto(?:currency)?|\busdt\b|\busdc\b|\bbtc\b|bitcoin|\beth\b|ethereum|airdrop|withdraw|wallet|retrait|portefeuille|jackpot|slots?\b/i,
  },
  {
    id: 'celebrity',
    family: 'giveaway',
    weight: 2,
    pattern: /mr\.?\s?beast|jimmy\s+donaldson|elon\s+musk|pewdiepie|kai\s+cenat|ishowspeed|\bxqc\b|\bdrake\b|\bninja\b|\bsqueezie\b|\binoxtag\b|\bmichou\b|\bamixem\b/i,
  },
  {
    id: 'everyone',
    family: 'giveaway',
    weight: 2,
    pattern: /(?:to|for)\s+everyone\s+who|everyone\s+who\s+(?:register|sign)|à\s+tous\s+ceux\s+qui|first\s+\d+\s+(?:people|users|members)|les\s+\d+\s+premiers/i,
  },
  {
    id: 'urgency',
    family: 'giveaway',
    weight: 1,
    pattern: /will\s+be\s+deleted|hurry|limited\s+(?:time|offer)|only\s+today|fastest|don'?t\s+miss|expire|dépêche|offre\s+limitée|temps\s+limité|ne\s+(?:rate|ratez)\s+pas/i,
  },
  {
    id: 'big_amount',
    family: 'giveaway',
    weight: 1,
    pattern: /[$€£]\s?\d{1,3}(?:[,. ]\d{3})+|[$€£]\s?\d{3,}|\d{3,}\s?(?:\$|€|usd|usdt|eur)\b/i,
  },

  // ── Faux recrutement / « revenu facile » ─────────────────────────────────
  // « J'ai des infos pour les personnes sans emploi, il suffit d'un ordinateur,
  // envoyez-moi un MP en précisant votre nationalité. » Aucun lien : le piège
  // se referme en privé (avance de frais, blanchiment, mule financière).
  {
    id: 'income_promise',
    family: 'recruitment',
    weight: 3,
    pattern: /revenus?\s+(?:compl[ée]mentaires?|convenables?|suppl[ée]mentaires?|passifs?|r[ée]guliers?|stables?)|g[ée]n[ée]rer\s+(?:un\s+)?(?:revenu|de\s+l'argent)|gagner\s+(?:de\s+l'argent|\d+|plus\s+d'argent|sa\s+vie)|earn(?:ing)?\s+(?:[$€£]|\d|money|cash|extra|from\s+home)|make\s+(?:[$€£]\d|\d+\s?k|money|extra\s+(?:money|cash))|(?:passive|extra|side|additional)\s+income|financial\s+freedom|libert[ée]\s+financi[èe]re|argent\s+facile|easy\s+money/i,
  },
  {
    id: 'job_targeting',
    family: 'recruitment',
    weight: 2,
    pattern: /sans\s+emploi|au\s+ch[ôo]mage|ch[ôo]meurs?|en\s+recherche\s+d'emploi|recherche\s+d'emploi|unemployed|jobless|out\s+of\s+work|looking\s+for\s+(?:a\s+)?(?:job|work)|besoin\s+d'argent|need\s+(?:extra\s+)?money/i,
  },
  {
    id: 'low_barrier',
    family: 'recruitment',
    weight: 2,
    pattern: /(?:il\s+)?(?:vous|te)\s+suffit\s+d'un|(?:only|just)\s+need\s+(?:a\s+)?(?:laptop|phone|computer|pc|smartphone)|no\s+experience|sans\s+exp[ée]rience|aucune\s+exp[ée]rience|(?:quelques|\d+)\s+(?:minutes|heures?)\s+par\s+jour|(?:few|\d+)\s+(?:minutes|hours?)\s+(?:a|per)\s+day|(?:work|working)\s+from\s+home|depuis\s+chez\s+(?:vous|toi|soi)|[àa]\s+domicile/i,
  },
  {
    id: 'coaching',
    family: 'recruitment',
    weight: 1,
    pattern: /accompagnement|je\s+(?:vous|t')\s?accompagne|mentor(?:ing|at)?|coaching|formation\s+(?:offerte|gratuite)|i\s+(?:will|can)\s+(?:teach|guide|show|help)\s+(?:you|\d+\s+people)|i'?ll\s+(?:teach|guide|show|help)/i,
  },
  {
    id: 'dm_lure',
    family: 'recruitment',
    weight: 3,
    pattern: /messages?\s+priv[ée]s?|\b(?:en|par|un)\s+mp\b|\bdm\s+me\b|(?:send|shoot|drop)\s+(?:me\s+)?(?:a\s+)?(?:dm|direct\s+message|private\s+message|pm)\b|direct\s+message|message\s+me|inbox\s+me|friend\s+request|(?:contact|reach)\s+me|me\s+contacter|[ée]cri(?:vez|s)[- ]moi|contactez[- ]moi|contacte[- ]moi/i,
  },
  {
    id: 'qualifier',
    family: 'recruitment',
    weight: 2,
    pattern: /nationalit[ée]|nationality|(?:pr[ée]cis(?:ant|ez|e)|indiqu(?:ant|ez|e)|tell\s+me|mention(?:ing)?|with)\s+(?:votre|ton|ta|vos|your)\s+(?:pays|country|[âa]ge|age|ville|city)/i,
  },
  {
    id: 'off_platform',
    family: 'recruitment',
    weight: 2,
    pattern: /telegram|whats\s?app|\bsignal\b\s+(?:app|me)|wickr|\bt\.me\//i,
  },
  {
    id: 'profit_share',
    family: 'recruitment',
    weight: 2,
    pattern: /\d+\s?%\s+(?:of\s+(?:your|the)|de\s+(?:vos|tes|ton|votre))\s+(?:profits?|gains?|b[ée]n[ée]fices?|earnings)|\d+\s?%\s+commission|reimburse\s+me|rembourse[zr]?[- ]moi|ask(?:ing)?\s+me\s+\(?how\)?|demande[zr]?[- ]moi\s+comment/i,
  },
  {
    id: 'big_promise',
    family: 'recruitment',
    weight: 1,
    pattern: /[$€£]\s?\d+\s?k\b|\d+\s?k\s?[$€£]|within\s+(?:a|one|\d+)\s+(?:week|days?|hours?)|in\s+\d+\s+(?:days?|hours?)|en\s+(?:une|1|\d+)\s+(?:semaines?|jours?|heures?)/i,
  },
];

/** Cumul minimal pour considérer un texte comme un faux giveaway. */
const MIN_SCORE = 8;
const MIN_DISTINCT_SIGNALS = 4;

/** Cumul minimal pour un faux recrutement. */
const MIN_RECRUITMENT_SCORE = 8;

export type ScamTextScore = {
  score: number;
  signals: string[];
};

function scoreFamily(text: string, family?: ScamFamily): ScamTextScore {
  const folded = foldText(text);
  const signals: string[] = [];
  let score = 0;
  for (const signal of SIGNALS) {
    if (family && signal.family !== family) continue;
    if (signal.pattern.test(folded)) {
      signals.push(signal.id);
      score += signal.weight;
    }
  }
  return { score, signals };
}

/** Tous les indices, toutes familles confondues (jeu de données, tri des textes). */
export function scoreScamText(text: string): ScamTextScore {
  return scoreFamily(text);
}

/**
 * Faux giveaway ? Il faut un appât (giveaway ou code promo), un décor
 * (crypto/casino ou célébrité) et un cumul suffisant. Le simple mot « bonus »
 * dans une annonce de serveur ne passe pas : il manque le reste.
 */
export function looksLikeFakeGiveaway(text: string): (ScamTextScore & { matched: boolean }) {
  const result = scoreFamily(text, 'giveaway');
  const has = (id: string) => result.signals.includes(id);
  const matched =
    result.score >= MIN_SCORE &&
    result.signals.length >= MIN_DISTINCT_SIGNALS &&
    (has('giveaway') || has('promo_code')) &&
    (has('crypto_casino') || has('celebrity'));
  return { ...result, matched };
}

/**
 * Faux recrutement ? Il faut une promesse de revenu, un appel à passer en
 * privé (MP ou Telegram/WhatsApp) et au moins un trait propre à l'arnaque :
 * cible sans emploi, « il suffit d'un ordinateur », nationalité demandée,
 * partage des gains. Une offre d'emploi réelle (« dev payé 50 €/h, MP-moi »)
 * n'a que les deux premiers et ne passe pas ; un recrutement de modérateurs
 * (« MP en précisant ton âge ») n'a pas de promesse de revenu.
 */
export function looksLikeRecruitmentScam(text: string): (ScamTextScore & { matched: boolean }) {
  const result = scoreFamily(text, 'recruitment');
  const has = (id: string) => result.signals.includes(id);
  const matched =
    result.score >= MIN_RECRUITMENT_SCORE &&
    has('income_promise') &&
    (has('dm_lure') || has('off_platform')) &&
    (has('job_targeting') || has('low_barrier') || has('qualifier') || has('profit_share'));
  return { ...result, matched };
}

// ── Empreinte de texte ──────────────────────────────────────────────────────

/** En dessous, un texte est trop générique pour servir d'empreinte (« hello »). */
export const MIN_FINGERPRINT_LENGTH = 40;
const MAX_SAMPLE_LENGTH = 600;

/**
 * Texte réduit à ce qui ne varie pas d'une diffusion à l'autre : les montants,
 * les liens, les mentions et la casse changent, la prose reste.
 */
export function normalizeScamText(text: string): string {
  return foldText(text)
    .toLowerCase()
    .replace(/<@[!&]?\d+>|<#\d+>|<a?:\w+:\d+>/g, ' ')
    .replace(/@(?:everyone|here)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' <url> ')
    .replace(BARE_DOMAIN, ' <url> ')
    .replace(/\d+(?:[.,]\d+)*/g, '#')
    .replace(/[^\p{L}\p{N}#<> ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SAMPLE_LENGTH);
}

/**
 * Texte lu par OCR, compacté pour le stockage : on garde les domaines et les
 * montants (c'est ce qui rend l'exemple exploitable), on ne retire que le bruit
 * de mise en page.
 */
export function compactOcrText(text: string, maxLength = 1000): string {
  return foldText(text).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function fingerprintText(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}
