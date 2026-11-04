import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou des pseudos cliquables vers la fiche membre.
 *
 * La fiche membre est celle de la section Membres, sanctions comprises : un rôle à qui le
 * centre de gestion ferme « Membres » ne doit pas la rouvrir depuis une autre page. Comme
 * pour `channelsManagementGuard.test.ts`, faute de harnais de rendu, la règle se lit dans
 * la source.
 *
 *  - `MemberCaseState` porte seul le chargement de la fiche et consulte
 *    `canViewFeature('members')` : une page ne peut pas l'oublier. Le store `memberCaseModal`
 *    en est l'instance partagée ; les pages qui règlent la fiche à leur façon (raison
 *    préremplie, onglet propre) en créent la leur. Aucune autre page n'appelle
 *    `fetchMemberCase` pour ouvrir une fiche.
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
  'pages/Suggestions.svelte',
  'pages/Leveling.svelte',
  'pages/Economy.svelte',
  'pages/CustomFormResponses.svelte',
  'pages/Seasons.svelte',
  'pages/BanAppeals.svelte',
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

/** Pages qui gardent leur propre fiche, réglée à leur façon, sur une instance de MemberCaseState. */
const OWN_CASE_PAGES = [
  'pages/Logs.svelte',
  'pages/Tickets.svelte',
  'pages/Sanctions.svelte',
  'pages/StaffManagement.svelte',
];

/** Seuls endroits autorisés à charger un dossier membre eux-mêmes. */
const CASE_LOADERS = new Set([
  'lib/memberCase.svelte.ts',
  // La fiche se relit après une action ou une note.
  'lib/components/MemberCaseModal.svelte',
  // La page membre complète, protégée par la route `/members`.
  'lib/components/members/MemberProfile.svelte',
  // Résumé à côté d'un ticket, chargé seulement avec l'accès à « Membres ».
  'lib/components/tickets/TicketMemberPanel.svelte',
]);

function sources(dir: string): string[] {
  return readdirSync(join(SRC, dir)).flatMap((name) => {
    const relative = `${dir}/${name}`;
    if (statSync(join(SRC, relative)).isDirectory()) return name === 'paraglide' || name === 'demo' ? [] : sources(relative);
    return /\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts') ? [relative] : [];
  });
}

describe('MemberCaseState', () => {
  const state = read('lib/memberCase.svelte.ts');

  test("l'ouverture est refusée sans accès à « Membres »", () => {
    expect(state).toContain("canViewFeature('members')");
    expect(state).toMatch(/show\([^)]*\)[^{]*\{\s*if \(!this\.canOpen/);
  });

  test("la fiche ne réclame plus d'actions à la page", () => {
    expect(read('lib/components/MemberCaseModal.svelte')).not.toMatch(/^\s*onAction\?:/m);
  });

  test('le store partagé en est une instance', () => {
    expect(read('lib/stores/memberCaseModal.svelte.ts')).toContain('new MemberCaseState(');
  });

  test('aucune autre page ne charge un dossier membre elle-même', () => {
    const offenders = [...sources('pages'), ...sources('lib')]
      .filter((file) => !CASE_LOADERS.has(file) && !file.startsWith('lib/api/'))
      .filter((file) => read(file).includes('fetchMemberCase('));
    expect(offenders).toEqual([]);
  });

  test("la fiche est montée une fois pour tout le dashboard", () => {
    expect(read('App.svelte')).toContain('MemberCaseModalHost.svelte');
  });
});

describe.each(OWN_CASE_PAGES)('%s', (page) => {
  const source = read(page);

  test('ouvre sa fiche par une instance de MemberCaseState', () => {
    expect(source).toContain('new MemberCaseState(');
    expect(source).toMatch(/<MemberCaseModal[\s\S]*?open=\{\w+\.open\}/);
  });

  test("ne propose le clic qu'avec l'accès à « Membres »", () => {
    expect(source).toMatch(/\w+\.canOpen/);
  });

  test("ne garde pas d'actions de modération que la fiche ignore", () => {
    // La fiche exécute elle-même avertissement, exclusion, expulsion et bannissement.
    expect(source).not.toContain('executeMemberAction');
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
