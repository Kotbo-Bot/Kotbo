/**
 * Garde-fous des webhooks sortants : quelles URL on accepte d'appeler, et
 * comment le destinataire vérifie que l'appel vient bien de Kotbo.
 *
 * L'URL est fournie par un administrateur de serveur, pas par nous : sans
 * contrôle, elle ferait de Kotbo un relais vers son propre réseau interne
 * (base de données, Redis, métadonnées du VPS). On refuse donc tout ce qui
 * n'est pas du HTTPS public, à l'enregistrement puis à chaque envoi, l'adresse
 * derrière un nom de domaine pouvant changer entre les deux.
 */
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

const MAX_URL_LENGTH = 2048;

/** Plages réservées, privées ou de lien local, en IPv4. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254) // lien local, métadonnées cloud
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224; // multidiffusion et réservé
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4 encapsulée (::ffff:10.0.0.1) : on juge l'adresse IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return lower.startsWith('fc') || lower.startsWith('fd') // adresses locales uniques
    || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') // lien local
    || lower.startsWith('ff'); // multidiffusion
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/**
 * Contrôle de forme, sans réseau : ce que le dashboard peut refuser tout de
 * suite. Renvoie l'URL normalisée.
 */
export function assertWebhookUrlShape(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new WebhookUrlError("L'URL est requise.");
  const value = raw.trim();
  if (value.length > MAX_URL_LENGTH) throw new WebhookUrlError("L'URL est trop longue.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookUrlError("Cette URL n'est pas valide.");
  }

  if (url.protocol !== 'https:') throw new WebhookUrlError("L'URL doit commencer par https://.");
  if (url.username || url.password) throw new WebhookUrlError("L'URL ne doit pas contenir d'identifiants.");
  if (url.port && url.port !== '443') throw new WebhookUrlError('Seul le port 443 est accepté.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new WebhookUrlError('Cette adresse pointe vers un réseau interne.');
  }
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new WebhookUrlError('Cette adresse pointe vers un réseau interne.');
  }

  // Un webhook Discord attend son propre format de message : nos envois y
  // seraient refusés en boucle. Les notifications Discord ont leurs modules.
  if (/(^|\.)discord(app)?\.com$/.test(host) && url.pathname.startsWith('/api/webhooks')) {
    throw new WebhookUrlError("Les webhooks Discord n'acceptent pas ce format : utilise plutôt les journaux ou les déclencheurs.");
  }

  return url.toString();
}

/**
 * Contrôle complet avant un appel : la forme, puis chaque adresse derrière le
 * nom de domaine.
 */
export async function assertWebhookUrlReachable(raw: string, resolve: typeof lookup = lookup): Promise<string> {
  const normalized = assertWebhookUrlShape(raw);
  const host = new URL(normalized).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return normalized;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(host, { all: true, verbatim: true });
  } catch {
    throw new WebhookUrlError(`Le domaine ${host} est introuvable.`);
  }
  if (addresses.length === 0) throw new WebhookUrlError(`Le domaine ${host} est introuvable.`);
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new WebhookUrlError('Ce domaine pointe vers un réseau interne.');
  }
  return normalized;
}

/** Secret de signature, préfixé comme ceux de Stripe pour être reconnaissable. */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

/**
 * Signature de l'en-tête `Kotbo-Signature`, au format de Stripe :
 * `t=<horodatage>,v1=<HMAC-SHA256 hexadécimal de "<horodatage>.<corps>">`.
 *
 * L'horodatage signé permet au destinataire de refuser un envoi rejoué
 * longtemps après coup ; le format `v1=` laisse la place à un second schéma
 * pendant une future rotation d'algorithme.
 */
export function signWebhookPayload(secret: string, body: string, timestampSeconds: number): string {
  const digest = crypto.createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

/**
 * Vérification côté destinataire, exposée pour les tests et la documentation :
 * c'est exactement ce que doit faire une intégration.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const fields = new Map<string, string[]>();
  for (const part of header.split(',')) {
    const [key, value] = part.split('=');
    if (!key || !value) continue;
    fields.set(key.trim(), [...(fields.get(key.trim()) ?? []), value.trim()]);
  }
  const timestamp = Number(fields.get('t')?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  return (fields.get('v1') ?? []).some((candidate) => {
    const received = Buffer.from(candidate, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}
