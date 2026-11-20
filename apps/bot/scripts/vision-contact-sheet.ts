/**
 * Planches-contact d'un dossier d'images, pour relire à l'œil ce qui va entrer
 * dans le catalogue d'amorce avant de lancer build-vision-seed.ts.
 *
 *   bun run scripts/vision-contact-sheet.ts <dossier> <dossier de sortie>
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const [dir, out] = process.argv.slice(2);
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : IMAGE.test(n) ? [join(d, n)] : []));

const COLS = 8;
const ROWS = 5;
const CELL = 200;
const files = walk(dir).sort();
mkdirSync(out, { recursive: true });

for (let page = 0; page * COLS * ROWS < files.length; page++) {
  const canvas = createCanvas(COLS * CELL, ROWS * (CELL + 16));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '11px sans-serif';
  const slice = files.slice(page * COLS * ROWS, (page + 1) * COLS * ROWS);
  for (const [i, file] of slice.entries()) {
    const x = (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * (CELL + 16);
    const image = await loadImage(file).catch(() => null);
    if (image) {
      const scale = Math.min((CELL - 4) / image.width, (CELL - 4) / image.height);
      ctx.drawImage(image, x + 2, y + 2, image.width * scale, image.height * scale);
    }
    ctx.fillStyle = image ? '#fff' : '#f55';
    ctx.fillText(`${page * COLS * ROWS + i} ${relative(dir, file).slice(-30)}`, x + 2, y + CELL + 11);
  }
  writeFileSync(join(out, `planche-${String(page).padStart(2, '0')}.jpg`), await canvas.encode('jpeg', 80));
}
console.log(`${files.length} images, ${Math.ceil(files.length / (COLS * ROWS))} planches dans ${out}`);
