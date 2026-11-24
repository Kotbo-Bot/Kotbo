/**
 * refresh-feature-page.ts
 *
 * Remplace le texte d'une page fonctionnalité déjà en base par celui de
 * `featurePageRichSeeds.ts`. L'import de la console ne touche jamais une page
 * existante : ce script sert quand le texte de la seed a été retravaillé (SEO)
 * et qu'il faut le pousser. L'adresse, la clé et l'état de publication restent.
 * Passe par `updateFeaturePage` : le cache se vide et le site se reconstruit.
 *
 * Écrase le texte édité dans la console : à lancer en connaissance de cause.
 *
 * Usage :
 *   bun run scripts/refresh-feature-page.ts double_accounts           (simulation)
 *   bun run scripts/refresh-feature-page.ts double_accounts --apply
 */
import prisma from '../apps/bot/src/utils/db.js';
import { updateFeaturePage } from '../apps/bot/src/services/system/featurePageService.js';
import { RICH_FEATURE_PAGE_SEEDS } from '../apps/bot/src/services/system/featurePageRichSeeds.js';

const key = process.argv[2];
const apply = process.argv.includes('--apply');

const seed = RICH_FEATURE_PAGE_SEEDS.find((s) => s.key === key);
if (!seed) {
  console.error(`Aucune seed pour « ${key ?? ''} ». Clés : ${RICH_FEATURE_PAGE_SEEDS.map((s) => s.key).join(', ')}`);
  process.exit(1);
}

const row = await prisma.featurePage.findUnique({ where: { key: seed.key } });
if (!row) {
  console.error(`La page « ${key} » n'existe pas en base : utilise « Importer les modules » dans la console.`);
  process.exit(1);
}

const before = row.content as { en?: { title?: string }; fr?: { title?: string } };
console.log(`FR : ${before.fr?.title}\n  → ${seed.content.fr.title}`);
console.log(`EN : ${before.en?.title}\n  → ${seed.content.en.title}`);

if (!apply) {
  console.log('\nSimulation : rien n’a été écrit. Ajoute --apply pour appliquer.');
} else {
  await updateFeaturePage(row.id, { content: seed.content }, 'script:refresh-feature-page');
  console.log('\nTexte mis à jour ; le site se reconstruit dans la minute.');
}
await prisma.$disconnect();
