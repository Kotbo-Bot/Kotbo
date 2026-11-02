/**
 * Banque d'images libre de l'éditeur du site, via Openverse (WordPress) :
 * seulement les licences CC0 et domaine public, qui n'exigent ni crédit ni
 * mention, pour que l'image puisse servir de fond sans légende.
 *
 * Le dashboard ne transmet qu'un identifiant : l'adresse de l'image est relue
 * chez Openverse, puis chaque saut de redirection est contrôlé avant le
 * téléchargement (jamais de requête vers un réseau interne).
 */

import { assertWebhookUrlReachable } from '../integrations/outgoingWebhookSecurity.js';
import { SiteAdminError } from './siteAdminService.js';
import { SITE_UPLOAD_MAX_BYTES, storeSiteAsset, type StoredAsset } from './siteUploads.js';

const OPENVERSE = 'https://api.openverse.org/v1/images/';
const FREE_LICENSES = ['cc0', 'pdm'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Kotbo site editor (+https://kotbo.fr)' };

export interface StockImage {
  id: string;
  title: string;
  thumb: string;
  creator: string | null;
  width: number | null;
  height: number | null;
}

interface OpenverseImage {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  thumbnail?: unknown;
  creator?: unknown;
  license?: unknown;
  width?: unknown;
  height?: unknown;
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const size = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

async function openverse(url: URL): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw new SiteAdminError('stock_unavailable', 502);
  return res.json();
}

export async function searchStockImages(query: string, page = 1): Promise<StockImage[]> {
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  const url = new URL(OPENVERSE);
  url.searchParams.set('q', q);
  url.searchParams.set('license', FREE_LICENSES.join(','));
  url.searchParams.set('mature', 'false');
  url.searchParams.set('page_size', '24');
  url.searchParams.set('page', String(Math.min(10, Math.max(1, Math.floor(page)))));
  const data = (await openverse(url)) as { results?: OpenverseImage[] };
  return (data.results ?? [])
    .filter((r) => typeof r.id === 'string' && ID.test(r.id) && text(r.thumbnail).startsWith('https://'))
    .map((r) => ({ id: r.id as string, title: text(r.title), thumb: text(r.thumbnail, 500), creator: text(r.creator, 120) || null, width: size(r.width), height: size(r.height) }));
}

/** Télécharge en suivant au plus trois redirections, chacune contrôlée. */
async function download(raw: string): Promise<Uint8Array> {
  let target = raw;
  for (let hop = 0; hop < 4; hop += 1) {
    const safe = await assertWebhookUrlReachable(target).catch(() => {
      throw new SiteAdminError('stock_unavailable', 502);
    });
    const res = await fetch(safe, { redirect: 'manual', headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      target = new URL(res.headers.get('location')!, safe).toString();
      continue;
    }
    if (!res.ok) throw new SiteAdminError('stock_unavailable', 502);
    if (Number(res.headers.get('content-length') ?? 0) > SITE_UPLOAD_MAX_BYTES) throw new SiteAdminError('too_large', 413);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > SITE_UPLOAD_MAX_BYTES) throw new SiteAdminError('too_large', 413);
    return bytes;
  }
  throw new SiteAdminError('stock_unavailable', 502);
}

export async function importStockImage(site: { id: string; guildId: string }, id: string, userId: string): Promise<StoredAsset> {
  if (!ID.test(id)) throw new SiteAdminError('invalid_field', 400);
  const detail = (await openverse(new URL(`${OPENVERSE}${id}/`))) as OpenverseImage;
  if (!FREE_LICENSES.includes(text(detail.license)) || !text(detail.url, 2000).startsWith('https://')) throw new SiteAdminError('stock_unavailable', 422);
  const bytes = await download(text(detail.url, 2000));
  const stored = await storeSiteAsset(site, { bytes, fileName: `banque-${id.slice(0, 8)}`, uploadedById: userId });
  if (!stored.ok) throw new SiteAdminError(stored.error, stored.error === 'quota' ? 409 : 400);
  return stored.asset;
}
