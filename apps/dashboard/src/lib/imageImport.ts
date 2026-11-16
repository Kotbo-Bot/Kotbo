/**
 * Image importée depuis l'ordinateur, prête à envoyer en data URI.
 *
 * Hors GIF (dont l'animation serait perdue), l'image est redimensionnée et
 * réencodée en WebP dans le navigateur : un avatar pris au téléphone pèse
 * plusieurs Mo pour 512 pixels utiles, et l'API refuse au-delà de 8 Mo.
 */
export const IMAGE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export type ImageImportError = 'unsupported' | 'too_large' | 'unreadable';

/** Dimensions ramenées dans un carré de `max` pixels, proportions gardées. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function importImageFile(file: File, maxDimension: number): Promise<{ dataUrl: string } | { error: ImageImportError }> {
  if (!ACCEPTED.includes(file.type)) return { error: 'unsupported' };
  if (file.type === 'image/gif') {
    return file.size > IMAGE_IMPORT_MAX_BYTES ? { error: 'too_large' } : { dataUrl: await readAsDataUrl(file) };
  }
  try {
    const bitmap = await createImageBitmap(file);
    const size = fitWithin(bitmap.width, bitmap.height, maxDimension);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob) return { error: 'unreadable' };
    if (blob.size > IMAGE_IMPORT_MAX_BYTES) return { error: 'too_large' };
    return { dataUrl: await readAsDataUrl(blob) };
  } catch {
    return { error: 'unreadable' };
  }
}
