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
 *  - `MemberName` est le pseudo cliquable seul, pour les listes qui affichent l'avatar à
 *    part : il porte la même règle, et les pages listées dans `MEMBER_NAME_PAGES` s'en servent.
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
  'pages/EventControl.svelte',
];

/** Pages qui ouvrent la fiche par le pseudo seul, via `MemberName`. */
const MEMBER_NAME_PAGES = [
  'pages/MessageSearch.svelte',
  'pages/security/AntiRaid.svelte',
  'lib/components/aegis/AegisReviewQueue.svelte',
  'lib/components/tickets/TicketBlacklist.svelte',
  'lib/components/economy/RpgTowerPanel.svelte',
  'lib/components/economy/RpgGuildsPanel.svelte',
];

/** Vues d'Analytics qui ouvrent la fiche par le gestionnaire `onOpenMember` de la page. */
const ANALYTICS_VIEWS = () => sources('lib/components/analytics').filter((file) => read(file).includes('onOpenMember'));

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

  test("le clic d'un UserDisplay n'existe qu'avec l'accès à « Membres »", () => {
    expect(state).toMatch(/opener\([^)]*\)[^{]*\{\s*return this\.canOpen \?/);
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
    expect(source).toMatch(/memberCaseModal\.(?:show|opener)\(/);
  });

  test("ne propose le clic qu'avec l'accès à « Membres »", () => {
    // `opener` ne rend un gestionnaire qu'avec cet accès.
    expect(source).toMatch(/memberCaseModal\.(?:canOpen|opener\()/);
  });

  test('ne navigue pas directement vers une page membre', () => {
    expect(source).not.toMatch(MEMBER_PAGE_LINK);
  });
});

describe('pseudos désactivés sans accès à « Membres »', () => {
  test("aucun ne s'éclaire au survol", () => {
    // `[^>]` seul s'arrêterait au `>` de `() =>`.
    const disabledByAccess = /<button\b(?:=>|[^>])*?disabled=\{!\w+\.canOpen\}(?:=>|[^>])*>[\s\S]*?<\/button>/g;
    const offenders = [...sources('pages'), ...sources('lib')]
      .filter((file) => file.endsWith('.svelte'))
      .flatMap((file) => (read(file).match(disabledByAccess) ?? [])
        .filter((button) => /(?<![\w:-])(?:group-)?hover:/.test(button))
        .map(() => file));
    expect(offenders).toEqual([]);
  });
});

describe('MemberName', () => {
  const source = read('lib/components/MemberName.svelte');

  test('ouvre la fiche membre par le store', () => {
    expect(source).toContain('memberCaseModal.show(');
  });

  test("ne propose le clic qu'avec l'accès à « Membres »", () => {
    expect(source).toMatch(/\{#if memberCaseModal\.canOpen\}[\s\S]*?<button/);
  });
});

describe.each(MEMBER_NAME_PAGES)('%s', (page) => {
  const source = read(page);

  test('affiche le pseudo par MemberName', () => {
    expect(source).toContain('<MemberName');
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

describe('EventControl', () => {
  test('ouvre la fiche membre plutôt que le profil public', () => {
    expect(read('pages/EventControl.svelte')).not.toMatch(/goto\(`\/profile\//);
  });
});

describe('Analytics', () => {
  test("ne transmet le clic vers la fiche qu'avec l'accès à « Membres »", () => {
    const source = read('pages/Analytics.svelte');
    expect(source).toContain('memberCaseModal.canOpen ? openMemberDetails : undefined');
    expect(source).not.toContain('onOpenMember={openMemberDetails}');
  });

  test('le graphe des interactions ouvre la fiche sous le pseudo du membre', () => {
    // Le nom passé à la fiche titre ses confirmations : jamais un texte d'attente.
    const source = read('pages/Analytics.svelte');
    expect(source).toMatch(/<GlobalInteractionGraph[\s\S]*?onSelectNode=\{openMember\}/);
    expect(source).not.toContain('m.an_loading_short()');
  });
});

describe('GlobalInteractionGraph', () => {
  const source = read('lib/components/charts/GlobalInteractionGraph.svelte');

  test("n'offre « Consulter l'activité complète » qu'avec un gestionnaire", () => {
    expect(source).not.toMatch(/onSelectNode = /);
    expect(source).toMatch(/\{#if onSelectNode\}\s*<button[\s\S]*?onSelectNode\(selectedNode!\.id, selectedNode!\.label\)/);
  });
});

describe.each(ANALYTICS_VIEWS())('%s', (view) => {
  const source = read(view);

  test('le clic vers la fiche est facultatif', () => {
    // Ni prop obligatoire, ni gestionnaire vide par défaut : son absence doit se voir.
    expect(source).not.toMatch(/onOpenMember: \(/);
    expect(source).not.toMatch(/onOpenMember = /);
  });

  test('un pseudo est inerte sans gestionnaire', () => {
    const buttons = source.match(/<button\b[^>]*?onclick=\{\(\) => (?:onOpenMember|openMember)\b[^>]*>/g) ?? [];
    for (const button of buttons) expect(button).toContain('disabled={!onOpenMember}');
  });

  test("un pseudo inerte ne s'éclaire pas au survol", () => {
    // `[^>]` seul s'arrêterait au `>` de `() =>`.
    const buttons = source.match(/<button\b(?:=>|[^>])*?disabled=\{!onOpenMember\}(?:=>|[^>])*>[\s\S]*?<\/button>/g) ?? [];
    for (const button of buttons) {
      expect(button).not.toMatch(/(?<![\w:-])hover:/);
      expect(button).not.toMatch(/(?<!group-enabled:)group-hover:/);
      const classes = button.match(/^<button\b(?:=>|[^>])*?class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
      for (const name of classes) {
        expect(source).not.toMatch(new RegExp(`\\.${name}:hover(?!:not\\(:disabled\\))`));
      }
    }
  });

  test("une liste ne devient cliquable qu'avec le gestionnaire", () => {
    const selects = source.match(/onselect=\{[^\n]*?(?:onOpenMember|openMember)\(/g) ?? [];
    for (const select of selects) expect(select).toMatch(/^onselect=\{onOpenMember \?/);
  });
});

describe('MemberCaseModal', () => {
  const source = read('lib/components/MemberCaseModal.svelte');

  test('relit le dossier par un seul chemin, qui écarte celui d\'un autre membre', () => {
    // Un clic dans le graphe pendant une action change le membre affiché : son dossier ne
    // doit pas recevoir celui du précédent.
    expect(source.match(/fetchMemberCase\(/g)).toHaveLength(1);
    expect(source).toMatch(/async function reloadCase\(id: string\)[\s\S]*?if \(updatedCase && userId === id\)/);
  });

  test('une action vise le membre de la confirmation', () => {
    // La confirmation est une attente : le membre affiché peut changer pendant qu'elle est ouverte.
    expect(source).toMatch(/async function executeModerationAction[\s\S]*?const memberId = userId;[\s\S]*?runMemberCaseAction\(memberId,/);
  });

  test('statistiques et messages ignorent une réponse dépassée', () => {
    for (const fn of ['loadMemberAnalytics', 'loadMemberMessages', 'loadMemberMessageChannels']) {
      expect(source).toMatch(new RegExp(`async function ${fn}\\(\\) \\{[\\s\\S]*?const currentId = \\+\\+\\w+;[\\s\\S]*?if \\(currentId !== \\w+\\) return;`));
    }
  });

  test('la recherche de messages attend la fin de la frappe', () => {
    expect(source).toMatch(/const delay = _q === lastMessageQuery \? 0 : \d+;/);
    expect(source).toMatch(/setTimeout\(\(\) => void loadMemberMessages\(\), delay\)[\s\S]*?return \(\) => clearTimeout\(timer\);/);
  });

  test('les salons du membre précédent ne restent pas affichés', () => {
    expect(source).toMatch(/if \(open\) \{[\s\S]*?messagesChannels = \[\];/);
  });

  test('une confirmation de sanction nomme le membre par son profil', () => {
    // `userName` vient de la page qui ouvre la fiche : parfois un simple identifiant.
    expect(source).not.toMatch(/mcm_confirm_\w+_title\(\{ name: userName \}\)/);
    expect(source.match(/mcm_confirm_\w+_title\(\{ name: displayName \}\)/g)).toHaveLength(4);
  });

  test("l'échec de l'édition d'un rapport se voit", () => {
    const update = source.slice(source.indexOf('async function handleUpdateReport'), source.indexOf('const sanctions = $derived'));
    expect(update).toContain('toast.error(');
    expect(update).not.toContain('console.error');
  });
});
