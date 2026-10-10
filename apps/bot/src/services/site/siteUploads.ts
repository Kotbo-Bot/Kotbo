/**
 * Images téléversées pour les sites communautaires, rangées sur le disque.
 *
 * Le type est reconnu à la signature du fichier, jamais à son nom ni à
 * l'en-tête envoyé. Hors GIF (dont l'animation serait perdue), toute image est
 * décodée puis réencodée en WebP : les métadonnées (EXIF, position GPS d'une
 * photo prise au téléphone) disparaissent, un fichier polyglotte ne survit pas
 * au réencodage, et la taille est bornée. Le SVG est refusé : il peut porter
 * du script.
 *
 * Emplacement : `SITE_ASSETS_DIR`, par défaut `<racine>/data/site-assets`,
 * un volume Docker en production. Un fichier vit sous `<serveur>/<id>.<ext>`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import prisma from '../../utils/db.js';
import { SITE_ASSET_PATH_PREFIX } from '@kotbo/shared';

export const SITE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const SITE_ASSET_QUOTA_BYTES = 500 * 1024 * 1024;
const MAX_DIMENSION = 2400;
const WEBP_QUALITY = 86;

const DEFAULT_DIR = fileURLToPath(new URL('../../../../../data/site-assets/', import.meta.url));

export function siteAssetsDir(): string {
  return process.env.SITE_ASSETS_DIR?.trim() || DEFAULT_DIR;
}

type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

/** Type d'image d'après les premiers octets, ou nul. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  const brand = String.fromCharCode(b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11]);
  if (brand.startsWith('ftypavif') || brand.startsWith('ftypavis')) return 'avif';
  return null;
}

const MIME: Record<string, string> = { webp: 'image/webp', gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', avif: 'image/avif' };

export function mimeForExtension(ext: string): string | null {
  return MIME[ext] ?? null;
}

export type UploadError = 'too_large' | 'unsupported' | 'unreadable' | 'quota';

export interface StoredAsset {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
}

/** GIF : seules les dimensions de l'en-tête sont lues, le fichier reste tel quel. */
function gifSize(bytes: Uint8Array): { width: number; height: number } {
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

async function normalizeImage(bytes: Uint8Array, kind: ImageKind): Promise<{ body: Buffer; ext: string; width: number; height: number }> {
  if (kind === 'gif') {
    const size = gifSize(bytes);
    return { body: Buffer.from(bytes), ext: 'gif', ...size };
  }
  const image = await loadImage(Buffer.from(bytes));
  const scale = Math.min(1, MAX_DIMENSION / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  return { body: await canvas.encode('webp', WEBP_QUALITY), ext: 'webp', width, height };
}

export async function storeSiteAsset(
  site: { id: string; guildId: string },
  upload: { bytes: Uint8Array; fileName: string; uploadedById: string },
): Promise<{ ok: true; asset: StoredAsset } | { ok: false; error: UploadError }> {
  if (upload.bytes.byteLength > SITE_UPLOAD_MAX_BYTES) return { ok: false, error: 'too_large' };
  const kind = sniffImage(upload.bytes);
  if (!kind) return { ok: false, error: 'unsupported' };

  let normalized: Awaited<ReturnType<typeof normalizeImage>>;
  try {
    normalized = await normalizeImage(upload.bytes, kind);
  } catch {
    return { ok: false, error: 'unreadable' };
  }

  const sha256 = createHash('sha256').update(normalized.body).digest('hex');
  const existing = await prisma.siteAsset.findUnique({ where: { siteId_sha256: { siteId: site.id, sha256 } } });
  if (existing) return { ok: true, asset: toStoredAsset(existing) };

  const used = await prisma.siteAsset.aggregate({ where: { siteId: site.id }, _sum: { sizeBytes: true } });
  if ((used._sum.sizeBytes ?? 0) + normalized.body.byteLength > SITE_ASSET_QUOTA_BYTES) return { ok: false, error: 'quota' };

  const fileName = upload.fileName.replace(/[^\w.\- ]/g, '').slice(0, 120) || 'image';
  const created = await prisma.siteAsset.create({
    data: {
      siteId: site.id,
      guildId: site.guildId,
      fileName,
      storageKey: '',
      mimeType: MIME[normalized.ext] ?? 'application/octet-stream',
      sizeBytes: normalized.body.byteLength,
      width: normalized.width,
      height: normalized.height,
      sha256,
      uploadedById: upload.uploadedById,
    },
  });
  const storageKey = `${site.guildId}/${created.id}.${normalized.ext}`;
  try {
    const target = path.join(siteAssetsDir(), storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, normalized.body);
  } catch (err) {
    await prisma.siteAsset.delete({ where: { id: created.id } }).catch(() => null);
    throw err;
  }
  const asset = await prisma.siteAsset.update({ where: { id: created.id }, data: { storageKey } });
  return { ok: true, asset: toStoredAsset(asset) };
}

function toStoredAsset(asset: { id: string; storageKey: string; width: number | null; height: number | null; sizeBytes: number; mimeType: string; fileName: string }): StoredAsset {
  const ext = path.extname(asset.storageKey).slice(1) || 'webp';
  return {
    id: asset.id,
    url: `${SITE_ASSET_PATH_PREFIX}${asset.id}.${ext}`,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    mimeType: asset.mimeType,
    fileName: asset.fileName,
  };
}

export async function listSiteAssets(siteId: string): Promise<StoredAsset[]> {
  const assets = await prisma.siteAsset.findMany({ where: { siteId }, orderBy: { createdAt: 'desc' }, take: 500 });
  return assets.map(toStoredAsset);
}

/** Fichier d'une image publiée : contenu et type, ou nul. */
export async function readSiteAsset(id: string, ext: string): Promise<{ body: Buffer; mimeType: string } | null> {
  if (!/^[a-z0-9]{20,32}$/.test(id)) return null;
  const asset = await prisma.siteAsset.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
  if (!asset || !asset.storageKey || path.extname(asset.storageKey) !== `.${ext}`) return null;
  const root = path.resolve(siteAssetsDir());
  const target = path.resolve(root, asset.storageKey);
  // Défense en profondeur : la clé est générée par nous, mais rien ne sort du dossier.
  if (!target.startsWith(root + path.sep)) return null;
  try {
    return { body: await readFile(target), mimeType: asset.mimeType };
  } catch {
    return null;
  }
}

export async function deleteSiteAsset(siteId: string, id: string): Promise<boolean> {
  const asset = await prisma.siteAsset.findFirst({ where: { id, siteId }, select: { id: true, storageKey: true } });
  if (!asset) return false;
  await prisma.siteAsset.delete({ where: { id: asset.id } });
  if (asset.storageKey) await rm(path.join(siteAssetsDir(), asset.storageKey), { force: true }).catch(() => null);
  return true;
}
