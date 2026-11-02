import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou des pseudos cliquables vers la fiche membre.
 *
 * La fiche membre est celle de la section Membres, sanctions comprises : un rôle à qui le
 * centre de gestion ferme « Membres » ne doit pas la rouvrir depuis une autre page. Comme
 * pour `channelsManagementGuard.test.ts`, faute de harnais de rendu, la règle se lit dans
 * la source.
 *
 *  - Le store `memberCaseModal` est le seul point d'ouverture, et c'est lui qui consulte
 *    `canViewFeature('members')` : une page ne peut pas l'oublier.
 *  - Les pages listées ici ouvrent la fiche par ce store, n'offrent le clic que si
 *    `memberCaseModal.canOpen`, et ne contournent pas la règle en naviguant directement
 *    vers `/members/<id>`.
 */
const SRC = join(import.meta.dir, '..');
const read = (relative: string) => readFileSync(join(SRC, relative), 'utf-8');

const PAGES = [
  'pages/Invitations.svelte',
  'lib/components/invitations/InviteDetailsModal.svelte',
  'pages/Reputation.svelte',
];

describe('memberCaseModal', () => {
  const store = read('lib/stores/memberCaseModal.svelte.ts');

  test("l'ouverture est refusée sans accès à « Membres »", () => {
    expect(store).toContain("canViewFeature('members')");
    expect(store).toMatch(/show\([^)]*\)[^{]*\{\s*if \(!this\.canOpen/);
  });

  test("la fiche est montée une fois pour tout le dashboard", () => {
    expect(read('App.svelte')).toContain('MemberCaseModalHost.svelte');
  });
});

describe.each(PAGES)('%s', (page) => {
  const source = read(page);

  test('ouvre la fiche membre par le store', () => {
    expect(source).toContain('memberCaseModal.show(');
  });

  test("ne propose le clic qu'avec l'accès à « Membres »", () => {
    expect(source).toContain('memberCaseModal.canOpen');
  });

  test('ne navigue pas directement vers une page membre', () => {
    expect(source).not.toMatch(/goto\(`\/members\//);
  });
});
