/**
 * Construit le catalogue d'amorce de Kotbo Vision (src/data/visionSeed.json) à
 * partir de dossiers d'images d'arnaque : collection publique, captures
 * remontées par les serveurs. Seules les empreintes sont gardées, jamais les
 * images. Relançable : les entrées déjà présentes sont conservées.
 *
 *   bun run scripts/build-vision-seed.ts <étiquette>=<dossier> [<étiquette>=<dossier>…]
 *   bun run scripts/build-vision-seed.ts scam-images=../../../Scam-Images/images
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeImage, compareFingerprints, parseFingerprint, serializeFingerprint } from '../src/services/moderation/imageForensics.js';

type SeedEntry = { h: string; f: string; s: string };

const SEED_PATH = join(import.meta.dir, '../src/data/visionSeed.json');
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    // La collection publique embarque une image de test de son API : pas une arnaque.
    if (/^test image/i.test(name)) return [];
    return statSync(path).isDirectory() ? walk(path) : IMAGE.test(name) ? [path] : [];
  });
}

const seed: SeedEntry[] = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
const known = new Set(seed.map((e) => e.h));
const report = { ajoutées: 0, déjà: 0, illisibles: 0, unies: 0 };

for (const arg of process.argv.slice(2)) {
  const [label, dir] = arg.split('=');
  if (!label || !dir) throw new Error(`Argument attendu : <étiquette>=<dossier>, reçu « ${arg} »`);
  for (const path of walk(dir)) {
    const buffer = readFileSync(path);
    const sha = createHash('sha256').update(buffer).digest('hex');
    if (known.has(sha)) {
      report.déjà++;
      continue;
    }
    const analysis = await analyzeImage(buffer);
    if (!analysis) {
      report.illisibles++;
      continue;
    }
    // Une image quasi unie bloquerait n'importe quel fond de couleur.
    if (analysis.fingerprint.flat) {
      report.unies++;
      continue;
    }
    known.add(sha);
    seed.push({ h: sha, f: serializeFingerprint(analysis.fingerprint), s: label });
    report.ajoutées++;
  }
}

seed.sort((a, b) => a.s.localeCompare(b.s) || a.h.localeCompare(b.h));
writeFileSync(SEED_PATH, `[\n${seed.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`);

// Combien d'entrées sont la rediffusion d'une autre : mesure de ce que le
// catalogue couvre en campagnes distinctes.
const fps = seed.map((e) => parseFingerprint(e.f)!);
let campaigns = 0;
const seen: number[] = [];
for (let i = 0; i < fps.length; i++) {
  if (!seen.some((j) => compareFingerprints(fps[i], fps[j]).verdict === 'CERTAIN')) campaigns++;
  seen.push(i);
}
console.log(report, `→ ${seed.length} empreintes, ${campaigns} visuels distincts`);
