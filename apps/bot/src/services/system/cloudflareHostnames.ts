/**
 * Cloudflare for SaaS (« noms d'hôte personnalisés ») pour les domaines perso.
 *
 * Actif seulement si CLOUDFLARE_API_TOKEN et CLOUDFLARE_ZONE_ID sont définis :
 * le domaine du serveur reste derrière le proxy Cloudflare, qui émet lui-même
 * son certificat. Sinon, Kotbo retombe sur le CNAME direct + Let's Encrypt.
 */
import { fetchExternal } from '../../utils/http.js';

const API = 'https://api.cloudflare.com/client/v4';

interface CfHostname {
  id: string;
  hostname: string;
  status?: string;
  ssl?: { status?: string };
}

export function cloudflareSaasEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID);
}

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchExternal(`${API}/zones/${process.env.CLOUDFLARE_ZONE_ID}/custom_hostnames${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: Array<{ message: string }> } | null;
  if (!res.ok || !body?.success) {
    throw new Error(`Cloudflare ${res.status} : ${body?.errors?.map((e) => e.message).join(', ') || 'réponse invalide'}`);
  }
  return body.result as T;
}

export function isHostnameActive(entry: Pick<CfHostname, 'status' | 'ssl'> | undefined): boolean {
  return entry?.status === 'active' && entry.ssl?.status === 'active';
}

/** Crée le nom d'hôte chez Cloudflare s'il n'existe pas, et dit s'il est actif (CNAME vu, certificat émis). */
export async function ensureCloudflareHostname(host: string): Promise<boolean> {
  const found = await cf<CfHostname[]>(`?hostname=${encodeURIComponent(host)}`);
  if (found[0]) return isHostnameActive(found[0]);
  const created = await cf<CfHostname>('', {
    method: 'POST',
    body: JSON.stringify({ hostname: host, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } }),
  });
  return isHostnameActive(created);
}

/** Retire le nom d'hôte quand le serveur change de domaine. Sans effet s'il n'existe pas. */
export async function removeCloudflareHostname(host: string): Promise<void> {
  const found = await cf<CfHostname[]>(`?hostname=${encodeURIComponent(host)}`);
  if (found[0]) await cf<unknown>(`/${found[0].id}`, { method: 'DELETE' });
}
