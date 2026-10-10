/**
 * Rattrapage du jeu de données d'arnaques à partir de l'historique du honeypot.
 *
 * Le bot le lance seul une fois au démarrage (marqueur SCAM_DATASET_BACKFILL_V1).
 * Ce script sert à le simuler ou à le relancer à la main ; il est idempotent.
 *
 * Usage (depuis apps/bot) :
 *   bun run scripts/backfill-scam-dataset.ts --dry-run
 *   bun run scripts/backfill-scam-dataset.ts [--guild <id>] [--images]
 *
 *   --dry-run  ne rien écrire, afficher ce qui serait enregistré
 *   --guild    limiter à un serveur
 *   --images   retélécharger et lire par OCR les images encore disponibles
 */

import { backfillScamDatasetFromHoneypots } from '../src/services/moderation/scamBackfillService.js';
import { shutdownOcr } from '../src/services/moderation/ocrService.js';

const args = process.argv.slice(2);
const guildIndex = args.indexOf('--guild');

const report = await backfillScamDatasetFromHoneypots({
  dryRun: args.includes('--dry-run'),
  guildId: guildIndex >= 0 ? args[guildIndex + 1] : undefined,
  withImages: args.includes('--images'),
});

console.log(JSON.stringify(report, null, 2));
await shutdownOcr();
process.exit(0);
