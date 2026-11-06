/** Export d'un SVG autonome : ni variable CSS ni image externe, un canevas ne les lit pas. */

function safeName(filename: string, fallback: string): string {
  return filename.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || fallback;
}

function saveBlob(blob: Blob, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function downloadSvg(source: string, filename: string, fallback: string) {
  saveBlob(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }), `${safeName(filename, fallback)}.svg`);
}

/** PNG en 2× pour rester net une fois partagé, réduit si l'image dépasse ce qu'un canevas accepte. */
export async function downloadSvgAsPng(source: string, width: number, height: number, filename: string, fallback: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('svg'));
      image.src = url;
    });
    const scale = Math.min(2, 16000 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('png');
    saveBlob(blob, `${safeName(filename, fallback)}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
