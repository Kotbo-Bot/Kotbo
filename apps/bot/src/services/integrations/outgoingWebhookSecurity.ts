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
import https from 'node:https';
import net from 'node:net';
import { UserFacingError } from '../../utils/userFacingError.js';

export class WebhookUrlError extends UserFacingError {
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

/** Les huit groupes de 16 bits d'une adresse IPv6 valide (`::` et IPv4 finale dépliés). */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (text.includes('::') ? missing < 0 : missing !== 0) return null;
  const groups = [...left, ...Array(text.includes('::') ? missing : 0).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: et ::1
  // IPv4 encapsulée, sous toutes ses écritures : on juge l'adresse IPv4 qu'elle contient.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIPv4(ipv4Of(g[6], g[7])); // ::ffff:0:0/96 et ::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(ipv4Of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(ipv4Of(g[1], g[2])); // 6to4
  const first = g[0];
  return (first & 0xfe00) === 0xfc00 // adresses locales uniques
    || (first & 0xffc0) === 0xfe80 // lien local
    || (first & 0xff00) === 0xff00; // multidiffusion
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

/**
 * Résolution utilisée par la connexion elle-même. Le contrôle fait avant
 * l'envoi (`assertWebhookUrlReachable`) ne suffit pas : un nom de domaine à TTL
 * nul peut répondre une adresse publique à ce contrôle puis une adresse interne
 * à la connexion (DNS rebinding). Ici, l'adresse vérifiée est celle à laquelle
 * on se connecte : une seule résolution, jugée puis utilisée.
 */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string } | number | null | undefined,
  callback: (err: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void,
  resolve: typeof lookup = lookup,
): void {
  const wantsAll = typeof options === 'object' && options !== null && options.all === true;
  resolve(hostname, { all: true, verbatim: true })
    .then((addresses) => {
      if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
        callback(new WebhookUrlError('Ce domaine pointe vers un réseau interne.'));
        return;
      }
      if (wantsAll) {
        callback(null, addresses.map(({ address, family }) => ({ address, family })));
        return;
      }
      callback(null, addresses[0].address, addresses[0].family);
    })
    .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err))));
}

const MAX_PINNED_RESPONSE_BYTES = 64 * 1024;

/**
 * POST HTTPS vers un webhook, avec résolution gardée, sans suivre de
 * redirection. Même signature que `fetchExternal`, pour rester injectable.
 */
export function pinnedWebhookFetch(input: string | URL | Request, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (target.protocol !== 'https:') return Promise.reject(new WebhookUrlError("L'URL doit commencer par https://."));

  return new Promise<Response>((resolveResponse, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const body = typeof init.body === 'string' ? init.body : '';
    headers['content-length'] = String(Buffer.byteLength(body));

    const req = https.request({
      protocol: 'https:',
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'POST',
      headers,
      lookup: guardedLookup as never,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_PINNED_RESPONSE_BYTES) chunks.push(chunk);
      });
      res.on('end', () => {
        // Un statut 204/304 interdit un corps dans `Response`.
        const status = res.statusCode ?? 0;
        const noBody = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
        resolveResponse(new Response(noBody ? null : Buffer.concat(chunks), { status: status >= 200 ? status : 502 }));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Pas de réponse.'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end(body);
  });
}
