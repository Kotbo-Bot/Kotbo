import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou de l'export RGPD, lu dans les sources (meme motif que les gardes
 * du dashboard) : tout modele Prisma qui range un membre comme sujet de la
 * donnee doit figurer dans les sources de `gdprExportService.ts`.
 *
 * Les champs suivis designent la personne concernee (auteur, gagnant, membre,
 * acheteur...). Les traces d'action d'un admin ou d'un staff (« cree par »,
 * « decide par ») ne sont pas suivies : leur export est une decision a part.
 *
 * QUAND IL TOMBE : ajouter le modele a `SOURCES`, avec une projection s'il
 * contient les identifiants d'autres membres.
 */
const SUBJECT_FIELDS = [
  'userId', 'memberId', 'authorId', 'winnerId', 'discordId', 'discordUserId', 'targetUserId',
  'participantId', 'voterId', 'senderId', 'receiverId', 'inviterId', 'ownerId', 'ownerUserId',
  'creatorId', 'buyerId', 'sellerId', 'giverId', 'reporterId', 'requesterId', 'applicantUserId',
  'staffUserId', 'claimedBy', 'purchasedById', 'redeemedById', 'challengerId', 'opponentId',
  'ghostClaimedBy', 'participants',
];

const schemaDir = join(import.meta.dir, '../../../../../packages/database/prisma');
const service = readFileSync(join(import.meta.dir, '../../services/system/gdprExportService.ts'), 'utf8');
const exported = new Set([...service.matchAll(/model: '(\w+)'/g)].map((match) => match[1]));

function modelsWithSubjectFields(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(schemaDir).filter((name) => name.endsWith('.prisma'))) {
    const schema = readFileSync(join(schemaDir, file), 'utf8');
    for (const [, name, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const hasSubject = SUBJECT_FIELDS.some((field) => new RegExp(`^\\s+${field}\\s+String`, 'm').test(body ?? ''));
      if (hasSubject && name) found.push(name.charAt(0).toLowerCase() + name.slice(1));
    }
  }
  return found;
}

describe('export RGPD', () => {
  test('le schema est bien lu', () => {
    expect(modelsWithSubjectFields()).toContain('memberLevel');
  });

  test('tout modele dont un membre est le sujet est exporte', () => {
    expect(modelsWithSubjectFields().filter((model) => !exported.has(model))).toEqual([]);
  });
});
