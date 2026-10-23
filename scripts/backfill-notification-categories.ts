/**
 * backfill-notification-categories.ts
 *
 * Range dans leur famille les notifications écrites avant le champ `category`
 * (toutes tombées en `system`), d'après la page vers laquelle elles mènent :
 * c'est le classement qu'appliquait l'ancienne boîte du dashboard.
 *
 * Idempotent : ne touche que les lignes `system.generic` encore en `system`.
 *
 * Usage :
 *   bun run scripts/backfill-notification-categories.ts --dry-run
 *   bun run scripts/backfill-notification-categories.ts
 */
import prisma from '../apps/bot/src/utils/db.js';

const BY_LINK: [string, string[]][] = [
  ['planning', ['/planning', '/absences', '/meetings', '/tasks', '/calls']],
  ['recruitment', ['/recruitment', '/tutoring']],
  ['moderation', ['/security/sanctions', '/sanctions', '/appeals']],
  ['security', ['/security', '/admin-lock', '/members']],
  ['tickets', ['/tickets', '/transcripts']],
  ['partnerships', ['/partner']],
  ['community', ['/dailyalgo']],
  ['staff', ['/procedures', '/staff-management', '/evaluations', '/profile', '/news', '/polls']],
];

const dryRun = process.argv.includes('--dry-run');

async function main() {
  let total = 0;
  for (const [category, prefixes] of BY_LINK) {
    const where = {
      kind: 'system.generic',
      category: 'system',
      OR: prefixes.map((prefix) => ({ link: { startsWith: prefix } })),
    };
    const count = dryRun
      ? await prisma.notification.count({ where })
      : (await prisma.notification.updateMany({ where, data: { category } })).count;
    total += count;
    console.log(`${category.padEnd(13)} ${count}`);
  }
  console.log(`${dryRun ? 'À reclasser' : 'Reclassées'} : ${total}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
