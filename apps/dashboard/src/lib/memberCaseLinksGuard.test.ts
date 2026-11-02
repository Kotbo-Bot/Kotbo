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
 *    `memberCaseModal.canOpen`, et ne contournent pas la règle par un lien ou une
 *    navigation directe vers `/members/<id>`.
 *  - Voir un membre n'est pas le modérer : la page membre ne propose « Modérer » et
 *    « Modifier la note » qu'avec `canModerateFeature('members')`. La fiche, elle, masque
 *    déjà ses actions sans ce droit.
 */
const SRC = join(import.meta.dir, '..');
const read = (relative: string) => readFileSync(join(SRC, relative), 'utf-8');

const PAGES = [
  'pages/Invitations.svelte',
  'lib/components/invitations/InviteDetailsModal.svelte',
  'pages/Reputation.svelte',
  'pages/Marketplace.svelte',
  'pages/Giveaways.svelte',
  'pages/Planning.svelte',
  'pages/Analytics.svelte',
  'pages/DoubleAccounts.svelte',
  'pages/Backups.svelte',
  'lib/components/channels/ChannelDetailsModal.svelte',
  'lib/components/tickets/TicketPerformance.svelte',
];

/** Lien ou navigation directe vers la page d'un membre. */
const MEMBER_PAGE_LINK = /(?:goto\(|href=\{)`\/members\//;

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
    expect(source).not.toMatch(MEMBER_PAGE_LINK);
  });
});

describe('TicketMemberPanel', () => {
  const source = read('lib/components/tickets/TicketMemberPanel.svelte');

  test("ne charge le dossier et n'offre ses liens qu'avec l'accès à « Membres »", () => {
    expect(source).toContain('memberCaseModal.canOpen');
    expect(source).toMatch(/\{#if memberCaseModal\.canOpen\}[\s\S]*?href=\{`\/members\//);
  });
});

describe('MemberProfile', () => {
  const source = read('lib/components/members/MemberProfile.svelte');

  test("ne propose « Modérer » et « Modifier la note » qu'avec le droit de modération", () => {
    expect(source).toContain("canModerateFeature('members')");

    const moderate = source.indexOf('m.mp_moderate()');
    expect(moderate).toBeGreaterThan(-1);
    expect(source.lastIndexOf('{#if canModerateMembers}', moderate)).toBeGreaterThan(source.lastIndexOf('{/if}', moderate));

    expect(source).toMatch(/\{#snippet editNoteAction\(\)\}[^\n]*m\.mp_edit_note\(\)/);
    expect(source).toContain('actions={canModerateMembers ? editNoteAction : undefined}');
  });
});
